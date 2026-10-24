// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Staking} from "../src/Staking.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {PrecompilePriceSource} from "../src/PrecompilePriceSource.sol";
import {Exchange} from "../src/Exchange.sol";
import {ExchangeExt} from "../src/ExchangeExt.sol";
import {Referrals} from "../src/Referrals.sol";
import {MarketRules} from "../src/MarketRules.sol";
import {SessionRouter} from "../src/SessionRouter.sol";
import {DepositProxyFactory} from "../src/deposit/DepositProxyFactory.sol";
import {ImpactLib} from "../src/lib/ImpactLib.sol";
import {IExchange} from "../src/interfaces/IExchange.sol";
import {IExchangeTypes} from "../src/interfaces/IExchangeTypes.sol";
import {IReferrals} from "../src/interfaces/IReferrals.sol";
import {IStaking} from "../src/interfaces/IStaking.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";

/// @title LaunchMarkets
/// @notice The v4 launch market table: the ten meme markets plus BTC and ETH, with the per-coin
///         max leverage, the per-tier deadband and clamp, the static OI and position caps (now
///         ceilings: the house-sized caps bind first), the house-sized multipliers and stress
///         move, the entry spread and the borrow rate (PROFIT.md V4-2, V4-3, V4-5).
/// @dev Hyperliquid asset indices and szDecimals were read from the public perp meta on
///      12 Oct 2026. Instrument ids are assigned in table order (DOGE = 0 ... kPEPE = 9, BTC =
///      10, ETH = 11). Static caps: OI a side $10M on BTC, ETH and DOGE, $2M PENGU, $1M VIRTUAL,
///      $500K WIF, TRUMP and kPEPE, $150K FARTCOIN, MELANIA, kFLOKI and PEOPLE; a position at
///      most min($1M, the market's OI cap); payout cap 50x. House-sized: a position at most 5x
///      free cash, a side 10x, stress 10% on memes and 5% on BTC/ETH. Entry spread = the
///      market's deadband; borrow 0.5 bps of notional per hour after the first hour.
library LaunchMarkets {
    struct Market {
        string name;
        uint32 hlAssetIndex;
        uint8 szDecimals;
        uint8 tier;
        uint32 maxLeverage;
        /// @dev Per-coin deadband, or 0 for the tier's default (`deadbandBps(tier)`).
        uint16 deadbandBps;
        uint128 oiCapUsd;
        uint128 maxNotionalUsd;
        uint16 stressBps;
    }

    /// @notice Impact curve shared by every launch market (DESIGN section 4).
    uint16 internal constant BASE_RATE_BPS = 1000;
    uint64 internal constant RATE_MULTIPLIER = 15_000;
    uint128 internal constant REFERENCE_NOTIONAL_USD = 20_000e6;

    /// @notice Payout cap for every launch market: profit at most 50x margin (PROFIT V4-2).
    uint16 internal constant PAYOUT_CAP_X = 50;
    /// @notice House-sized multipliers (PROFIT V4-2): position 5x free cash, side 10x.
    uint16 internal constant POS_X10 = 50;
    uint16 internal constant SIDE_X10 = 100;
    /// @notice Borrow rate (PROFIT V4-5): 0.5 bps of notional per hour, in 0.1-bps units.
    uint16 internal constant BORROW_RATE_X10 = 5;

    /// @notice Number of launch markets.
    uint256 internal constant COUNT = 12;

    /// @notice The launch table, in instrument-id order: name, asset index, szDecimals, tier,
    ///         max leverage, deadband override (0 = the tier's), OI cap per side, max notional,
    ///         stress move.
    function all() internal pure returns (Market[] memory m) {
        m = new Market[](COUNT);
        m[0] = Market("DOGE", 12, 0, 0, 1000, 0, 10_000_000e6, 1_000_000e6, 1000);
        m[1] = Market("FARTCOIN", 165, 1, 0, 1000, 0, 150_000e6, 150_000e6, 1000);
        m[2] = Market("VIRTUAL", 162, 1, 0, 1000, 0, 1_000_000e6, 1_000_000e6, 1000);
        m[3] = Market("WIF", 98, 0, 0, 1000, 3, 500_000e6, 500_000e6, 1000);
        m[4] = Market("MELANIA", 175, 1, 0, 1000, 3, 150_000e6, 150_000e6, 1000);
        m[5] = Market("kFLOKI", 119, 0, 0, 1000, 0, 150_000e6, 150_000e6, 1000);
        m[6] = Market("PENGU", 163, 0, 0, 1000, 0, 2_000_000e6, 1_000_000e6, 1000);
        m[7] = Market("PEOPLE", 100, 0, 0, 1000, 3, 150_000e6, 150_000e6, 1000);
        m[8] = Market("TRUMP", 174, 1, 1, 250, 0, 500_000e6, 500_000e6, 1000);
        m[9] = Market("kPEPE", 15, 0, 1, 250, 0, 500_000e6, 500_000e6, 1000);
        m[10] = Market("BTC", 0, 5, 0, 1000, 0, 10_000_000e6, 1_000_000e6, 500);
        m[11] = Market("ETH", 1, 4, 0, 1000, 0, 10_000_000e6, 1_000_000e6, 500);
    }

    /// @notice Deadband per tier: 1 / 3 / 10 bps.
    function deadbandBps(uint8 tier) internal pure returns (uint16) {
        if (tier == 0) return 1;
        if (tier == 1) return 3;
        return 10;
    }

    /// @notice The deadband a market launches with: its own override, else its tier's.
    function marketDeadbandBps(Market memory m) internal pure returns (uint16) {
        return m.deadbandBps != 0 ? m.deadbandBps : deadbandBps(m.tier);
    }

    /// @notice Clamp half-width per tier: 5 / 25 / 50 bps (display only).
    function clampBps(uint8 tier) internal pure returns (uint16) {
        if (tier == 0) return 5;
        if (tier == 1) return 25;
        return 50;
    }

    /// @notice Build the `addInstrument` spec for a market.
    function spec(Market memory m, uint128 positionMultiplierE6) internal pure returns (IExchangeTypes.Instrument memory) {
        uint16 deadband = marketDeadbandBps(m);
        return IExchangeTypes.Instrument({
            hlAssetIndex: m.hlAssetIndex,
            szDecimals: m.szDecimals,
            tier: m.tier,
            maxLeverage: m.maxLeverage,
            deadbandBps: deadband,
            clampBps: clampBps(m.tier),
            baseRateBps: BASE_RATE_BPS,
            rateMultiplier: RATE_MULTIPLIER,
            referenceNotionalUsd: REFERENCE_NOTIONAL_USD,
            positionMultiplierE6: positionMultiplierE6,
            longOiCapUsd: m.oiCapUsd,
            shortOiCapUsd: m.oiCapUsd,
            maxNotionalUsd: m.maxNotionalUsd,
            payoutCapX: PAYOUT_CAP_X,
            posX10: POS_X10,
            sideX10: SIDE_X10,
            stressBps: m.stressBps,
            entryDeadbandBps: deadband,
            borrowRateX10: BORROW_RATE_X10,
            opensPaused: false,
            retired: false,
            lastPx18: 0
        });
    }
}

/// @title ConfettiDeployer
/// @notice The deployment steps, shared by the `Deploy` script and the integration and fork
///         tests so that what is tested is what gets deployed.
/// @dev Order (every owned contract takes `deployer` as its first owner so the deployer can
///      wire it):
///        1. price source (given, or a fresh PrecompilePriceSource)
///        2. Staking (on the existing FETTI: v4 deploys no token), PriceOracle, ExchangeExt,
///           Exchange (which creates its own Referrals, MarketRules and SessionRouter in its
///           constructor), then the Exchange's DepositProxyFactory
///        3. oracle.setRegistrar(exchange); exchange.setKeepers(guardian, marketKeeper);
///           exchange.setKeeper(keeper, true); exchange.setStakerFeeShare; exchange.setFeeBps;
///           exchange.setRhoBps / setMaxWinBps
///        4. launch markets, each with a live, non-zero launch price, each added with opens
///           paused (`setMarketOpensPaused(id, true)`)
///        5. transferOwnership(owner) on the Staking, the oracle and the Exchange only when `owner`
///           is not the deployer (two-step: `owner` must accept each). At launch the owner wallet
///           deploys, so there is no hand-over. FETTI is not touched: v4 holds no role on it.
///      Roles: none may be zero (`RoleUnset`) and the fill keeper may not be the owner
///      (`KeeperIsOwner`). The owner may also be the pause guardian, the market keeper and the
///      fee recipient (the launch wiring, as on v3).
///      Holds no cheatcodes, so it works under a broadcast and inside a test alike.
abstract contract ConfettiDeployer {
    /// @param usdc USDC token (6 decimals).
    /// @param owner Final owner of every owned contract (the owner wallet, which also deploys).
    /// @param guardian Pause guardian.
    /// @param marketKeeper May move OI caps and house sizing.
    /// @param keeper Fill keeper.
    /// @param feeRecipient Receives the non-staker share of pushed fees.
    /// @param priceSource Existing IPriceSource, or zero to deploy a PrecompilePriceSource.
    /// @param launchPrices18 Launch price per market in table order (1e18), or empty to read
    ///        them from the price source.
    /// @param stakerFeeShareBps Share of each fee push to stakers, bps (2000 at launch).
    /// @param stakingWarmupS Staking `minStakeDuration`, seconds (3600 at launch).
    /// @param winFeeBps Fee on a win's adjusted gain, bps (500 at launch).
    /// @param lossFeeBps Fee carved from losses and liquidations, bps (500 at launch).
    /// @param rhoBps Book exposure allowance, bps of free cash (2000 at launch).
    /// @param maxWinBps A position's maximum profit, bps of free cash (2500 at launch).
    /// @param fetti The existing FETTI token (the one v3 Staking stakes) v4 Staking stakes.
    /// @param v3Referrals The v3 Referrals registry whose codes carry over (zero: none).
    struct Config {
        address usdc;
        address owner;
        address guardian;
        address marketKeeper;
        address keeper;
        address feeRecipient;
        address priceSource;
        uint256[] launchPrices18;
        uint16 stakerFeeShareBps;
        uint64 stakingWarmupS;
        uint16 winFeeBps;
        uint16 lossFeeBps;
        uint16 rhoBps;
        uint16 maxWinBps;
        address fetti;
        address v3Referrals;
    }

    /// @notice Everything `_deploy` produced.
    struct Deployment {
        IPriceSource source;
        PriceOracle oracle;
        IERC20 fetti;
        Staking staking;
        ExchangeExt ext;
        Exchange exchange;
        Referrals referrals;
        MarketRules rules;
        SessionRouter router;
        DepositProxyFactory depositFactory;
        uint256[] launchPrices18;
    }

    /// @notice LAUNCH_PRICES was given but does not have one entry per launch market.
    error LaunchPriceCountMismatch(uint256 given, uint256 expected);
    /// @notice A launch price is zero: the feed is dead or the env entry is wrong.
    error LaunchPriceZero(uint32 hlAssetIndex);
    /// @notice The impact curve does not keep about 88% at a 1% move and 74% at a 0.1% move.
    error CurveOffTarget(uint32 hlAssetIndex, uint256 scaleOnePctE18, uint256 scaleTenthPctE18);
    /// @notice Owner, guardian, market keeper, fill keeper or fee recipient is the zero address.
    error RoleUnset();
    /// @notice The fill keeper is the owner: the keeper's hot key must not hold the owner's powers.
    error KeeperIsOwner();
    /// @notice FETTI is not a deployed contract (wrong address, or the wrong chain).
    error FettiNotAContract(address fetti);

    /// @notice Position multiplier (x1e6) used for every launch market, see `_positionMultiplierE6`.
    uint128 public constant LAUNCH_POSITION_MULTIPLIER_E6 = 130_000_000e6;

    /// @notice Launch defaults (PROFIT.md V4-2, V4-4; the live v3 staker share and warm-up).
    uint16 public constant DEFAULT_STAKER_FEE_SHARE_BPS = 2000;
    uint64 public constant DEFAULT_STAKING_WARMUP_S = 3600;
    uint16 public constant DEFAULT_WIN_FEE_BPS = 500;
    uint16 public constant DEFAULT_LOSS_FEE_BPS = 500;
    uint16 public constant DEFAULT_RHO_BPS = 2000;
    uint16 public constant DEFAULT_MAX_WIN_BPS = 2500;

    /// @dev Deploy, wire, add the launch markets and hand ownership to `cfg.owner`.
    function _deploy(Config memory cfg, address deployer) internal returns (Deployment memory d) {
        _checkRoles(cfg);
        d.source = cfg.priceSource == address(0)
            ? IPriceSource(address(new PrecompilePriceSource()))
            : IPriceSource(cfg.priceSource);

        if (cfg.fetti.code.length == 0) revert FettiNotAContract(cfg.fetti);
        d.fetti = IERC20(cfg.fetti);
        d.staking = new Staking(deployer, cfg.fetti, cfg.usdc, cfg.stakingWarmupS);
        d.oracle = new PriceOracle(d.source, deployer);
        d.ext = new ExchangeExt(IERC20(cfg.usdc), d.oracle, IStaking(address(d.staking)), deployer);
        d.exchange = new Exchange(
            IERC20(cfg.usdc),
            d.oracle,
            IStaking(address(d.staking)),
            d.ext,
            IReferrals(cfg.v3Referrals),
            deployer,
            cfg.feeRecipient
        );
        IExchange ex = IExchange(address(d.exchange));
        d.referrals = Referrals(ex.referrals());
        d.rules = MarketRules(ex.marketRules());
        d.router = SessionRouter(ex.sessionRouter());
        d.depositFactory = new DepositProxyFactory(ex);

        d.oracle.setRegistrar(address(d.exchange));
        ex.setKeepers(cfg.guardian, cfg.marketKeeper);
        ex.setKeeper(cfg.keeper, true);
        ex.setStakerFeeShare(cfg.stakerFeeShareBps);
        ex.setFeeBps(cfg.winFeeBps, cfg.lossFeeBps);
        ex.setRhoBps(cfg.rhoBps);
        ex.setMaxWinBps(cfg.maxWinBps);

        d.launchPrices18 = _addLaunchMarkets(d, cfg.launchPrices18);
        _handOver(d, deployer, cfg.owner);
    }

    /// @dev Every role set; the fill keeper is not the owner.
    function _checkRoles(Config memory cfg) internal pure {
        if (
            cfg.owner == address(0) || cfg.guardian == address(0) || cfg.marketKeeper == address(0)
                || cfg.keeper == address(0) || cfg.feeRecipient == address(0)
        ) revert RoleUnset();
        if (cfg.keeper == cfg.owner) revert KeeperIsOwner();
    }

    /// @dev Add every launch market. Prices come from `given` when non-empty, else from the
    ///      price source; a zero price aborts the deploy.
    function _addLaunchMarkets(Deployment memory d, uint256[] memory given)
        internal
        returns (uint256[] memory prices18)
    {
        LaunchMarkets.Market[] memory markets = LaunchMarkets.all();
        if (given.length != 0 && given.length != markets.length) {
            revert LaunchPriceCountMismatch(given.length, markets.length);
        }
        prices18 = new uint256[](markets.length);
        IExchange ex = IExchange(address(d.exchange));
        for (uint256 i = 0; i < markets.length; i++) {
            LaunchMarkets.Market memory m = markets[i];
            uint256 px18 = given.length != 0 ? given[i] : _readLaunchPrice18(d.source, m);
            if (px18 == 0) revert LaunchPriceZero(m.hlAssetIndex);
            prices18[i] = px18;

            IExchangeTypes.Instrument memory spec = LaunchMarkets.spec(m, _positionMultiplierE6(px18));
            _checkCurve(m.hlAssetIndex, spec);
            uint32 id = ex.addInstrument(spec);
            assert(id == i);
            // Launch paused: the owner unpauses each market after the pre-open check passes.
            ex.setMarketOpensPaused(id, true);
        }
    }

    /// @dev BBO mid in 1e18, the same scaling as PriceOracle: raw quotes carry
    ///      10^(6 - szDecimals) implied decimals. Returns 0 when either side is zero.
    function _readLaunchPrice18(IPriceSource source, LaunchMarkets.Market memory m) internal view returns (uint256) {
        (uint64 bid, uint64 ask) = source.bbo(m.hlAssetIndex);
        if (bid == 0 || ask == 0) return 0;
        return (uint256(bid) + uint256(ask)) * 10 ** (12 + uint256(m.szDecimals)) / 2;
    }

    /// @dev DESIGN section 4 asks for a per-market multiplier chosen so that a 1% move keeps
    ///      about 88% of the raw gain and a 0.1% move about 74%; 130,000,000 gives 88.06% and
    ///      73.74% on every market (`_checkCurve` verifies this). The launch price is still
    ///      required so a dead feed stops the deploy.
    function _positionMultiplierE6(uint256 launchPx18) internal pure returns (uint128) {
        require(launchPx18 != 0, "launch price is zero");
        return LAUNCH_POSITION_MULTIPLIER_E6;
    }

    /// @dev Reject a curve that misses the published targets (same bounds as the unit tests).
    function _checkCurve(uint32 hlAssetIndex, IExchangeTypes.Instrument memory spec) internal pure {
        ImpactLib.Curve memory c = ImpactLib.Curve({
            baseRateBps: spec.baseRateBps,
            rateMultiplier: spec.rateMultiplier,
            referenceNotionalUsd: spec.referenceNotionalUsd,
            positionMultiplierE6: spec.positionMultiplierE6
        });
        uint256 onePct = ImpactLib.impactScaleE18(1e16, c);
        uint256 tenthPct = ImpactLib.impactScaleE18(1e15, c);
        if (onePct < 0.875e18 || onePct > 0.885e18 || tenthPct < 0.73e18 || tenthPct > 0.745e18) {
            revert CurveOffTarget(hlAssetIndex, onePct, tenthPct);
        }
    }

    /// @dev Start the two-step handover on the three owned contracts. No-op when the deployer
    ///      keeps ownership. `owner` must call `acceptOwnership()` on each.
    function _handOver(Deployment memory d, address deployer, address owner) internal {
        if (owner == deployer) return;
        d.staking.transferOwnership(owner);
        d.oracle.transferOwnership(owner);
        d.exchange.transferOwnership(owner);
    }
}

/// @title Deploy
/// @notice Env-driven mainnet deploy of the whole Confetti v4 system.
/// @dev Required env: USDC, OWNER (the owner wallet; the broadcaster at launch), GUARDIAN, MARKET_KEEPER, KEEPER, FEE_RECIPIENT,
///      FETTI (the existing token), V3_REFERRALS.
///      Optional env: PRICE_SOURCE (reuse an IPriceSource; default deploys PrecompilePriceSource),
///      LAUNCH_PRICES (comma-separated 1e18 prices in LaunchMarkets order; when empty, `run`
///      reads them from the BBO precompile through `eth_call` on the RPC), STAKER_FEE_SHARE_BPS,
///      STAKING_WARMUP_S, WIN_FEE_BPS, LOSS_FEE_BPS, RHO_BPS, MAX_WIN_BPS, DEPLOYER_PK (the
///      broadcaster's key, set only inside ops/v4/20_deploy.ps1's own process from its hidden
///      prompt; without it the CLI chooses the broadcaster), DEPLOYER (revert
///      `DeployerMismatch` unless the broadcaster is this address).
///      Run (the owner's path is ops/v4/20_deploy.ps1, which wraps this):
///        forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --slow
///          --disable-block-gas-limit --verify --verifier sourcify
///      `--disable-block-gas-limit` is required: the local simulation inherits the 3M gas limit
///      of a HyperEVM small block and the Exchange deployment alone needs more. The deployer
///      address must have HyperEVM big blocks enabled (30M gas; HyperCore `evmUserModify` with
///      `usingBigBlocks`) before broadcasting. The broadcaster is the deployer and first owner;
///      when OWNER is another address it must accept ownership on Staking, PriceOracle and the
///      Exchange (at launch OWNER is the broadcaster: no hand-over). Never put a private key in
///      this file or in the env of a shared shell.
contract Deploy is Script, ConfettiDeployer {
    /// @notice The broadcaster is not the DEPLOYER the launch config names.
    error DeployerMismatch(address expected, address actual);

    /// @dev HyperCore BBO precompile, read over RPC for launch prices (see `launchPricesFromRpc`).
    address public constant BBO_PRECOMPILE = 0x000000000000000000000000000000000000080e;

    function run() external returns (Deployment memory d) {
        Config memory cfg = configFromEnv();
        if (cfg.launchPrices18.length == 0) {
            cfg.launchPrices18 = launchPricesFromRpc();
        }

        // DEPLOYER_PK: the key ops/v4/20_deploy.ps1 read hidden, passed by env so it never sits on a
        // command line. Without it the broadcaster comes from the CLI (--unlocked --sender on a
        // local fork, --account, --ledger).
        uint256 pk = vm.envOr("DEPLOYER_PK", uint256(0));
        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        (, address deployer,) = Vm(address(vm)).readCallers();
        address expected = vm.envOr("DEPLOYER", address(0));
        if (expected != address(0) && deployer != expected) revert DeployerMismatch(expected, deployer);
        d = _deploy(cfg, deployer);
        vm.stopBroadcast();

        _report(cfg, d, deployer);
    }

    /// @notice Read the deploy configuration from the environment.
    function configFromEnv() public view returns (Config memory cfg) {
        cfg.usdc = vm.envAddress("USDC");
        cfg.owner = vm.envAddress("OWNER");
        cfg.guardian = vm.envAddress("GUARDIAN");
        cfg.marketKeeper = vm.envAddress("MARKET_KEEPER");
        cfg.keeper = vm.envAddress("KEEPER");
        cfg.feeRecipient = vm.envAddress("FEE_RECIPIENT");
        cfg.priceSource = vm.envOr("PRICE_SOURCE", address(0));
        cfg.launchPrices18 = vm.envOr("LAUNCH_PRICES", ",", new uint256[](0));
        cfg.stakerFeeShareBps = uint16(vm.envOr("STAKER_FEE_SHARE_BPS", uint256(DEFAULT_STAKER_FEE_SHARE_BPS)));
        cfg.stakingWarmupS = uint64(vm.envOr("STAKING_WARMUP_S", uint256(DEFAULT_STAKING_WARMUP_S)));
        cfg.winFeeBps = uint16(vm.envOr("WIN_FEE_BPS", uint256(DEFAULT_WIN_FEE_BPS)));
        cfg.lossFeeBps = uint16(vm.envOr("LOSS_FEE_BPS", uint256(DEFAULT_LOSS_FEE_BPS)));
        cfg.rhoBps = uint16(vm.envOr("RHO_BPS", uint256(DEFAULT_RHO_BPS)));
        cfg.maxWinBps = uint16(vm.envOr("MAX_WIN_BPS", uint256(DEFAULT_MAX_WIN_BPS)));
        cfg.fetti = vm.envAddress("FETTI");
        cfg.v3Referrals = vm.envAddress("V3_REFERRALS");
    }

    /// @notice Launch prices read from the BBO precompile through `eth_call` on the RPC.
    /// @dev `forge script` simulates locally before it broadcasts, and the HyperCore precompiles
    ///      have no bytecode outside the real node, so the precompile adapter cannot be read in
    ///      that simulation. Asking the node directly gives the same mid the adapter would.
    function launchPricesFromRpc() public returns (uint256[] memory prices18) {
        LaunchMarkets.Market[] memory markets = LaunchMarkets.all();
        prices18 = new uint256[](markets.length);
        for (uint256 i = 0; i < markets.length; i++) {
            bytes memory ret = _ethCall(BBO_PRECOMPILE, abi.encode(markets[i].hlAssetIndex));
            if (ret.length < 64) revert LaunchPriceZero(markets[i].hlAssetIndex);
            (uint64 bid, uint64 ask) = abi.decode(ret, (uint64, uint64));
            if (bid == 0 || ask == 0) revert LaunchPriceZero(markets[i].hlAssetIndex);
            prices18[i] = (uint256(bid) + uint256(ask)) * 10 ** (12 + uint256(markets[i].szDecimals)) / 2;
        }
    }

    /// @dev `eth_call` against the script's RPC.
    function _ethCall(address to, bytes memory data) internal returns (bytes memory) {
        string memory params =
            string.concat('[{"to":"', vm.toString(to), '","data":"', vm.toString(data), '"},"latest"]');
        return vm.rpc("eth_call", params);
    }

    function _report(Config memory cfg, Deployment memory d, address deployer) internal view {
        IExchange ex = IExchange(address(d.exchange));
        console.log("== Confetti v4 deployment ==");
        console.log("deployer            ", deployer);
        console.log("USDC                ", cfg.usdc);
        console.log("PriceSource         ", address(d.source));
        console.log("PriceOracle         ", address(d.oracle));
        console.log("FETTI (existing)    ", address(d.fetti));
        console.log("Staking             ", address(d.staking));
        console.log("ExchangeExt         ", address(d.ext));
        console.log("Exchange            ", address(d.exchange));
        console.log("Referrals           ", address(d.referrals));
        console.log("v3 Referrals (bound)", cfg.v3Referrals);
        console.log("MarketRules         ", address(d.rules));
        console.log("SessionRouter       ", address(d.router));
        console.log("DepositProxyFactory ", address(d.depositFactory));
        console.log("fee recipient       ", cfg.feeRecipient);
        console.log("pause guardian      ", cfg.guardian);
        console.log("market keeper       ", cfg.marketKeeper);
        console.log("fill keeper         ", cfg.keeper);
        console.log("stakerFeeShareBps   ", uint256(ex.stakerFeeShareBps()));
        console.log("winFeeBps/lossFeeBps", uint256(ex.winFeeBps()), uint256(ex.lossFeeBps()));
        console.log("rhoBps/maxWinBps    ", uint256(ex.rhoBps()), uint256(ex.maxWinBps()));
        console.log("breakerBps/floor    ", uint256(ex.breakerBps()), uint256(ex.breakerFloorUsdc()));
        console.log("minMarginUsdc       ", uint256(ex.minMarginUsdc()));
        console.log("borrowFreeHours     ", uint256(ex.borrowFreeHours()));
        console.log("minStakeDuration (s)", uint256(d.staking.minStakeDuration()));
        console.log("delays (s)          ", ex.minDelay(), ex.grace(), ex.expiry());
        console.log("markets launch with opens paused; run the pre-open check, then open_markets");

        LaunchMarkets.Market[] memory markets = LaunchMarkets.all();
        console.log("== launch markets: id name hlIndex tier maxLev launchPrice(1e18) oiCap maxNotional posX10 sideX10 stress ==");
        for (uint256 i = 0; i < markets.length; i++) {
            IExchangeTypes.Instrument memory inst = ex.instrument(uint32(i));
            console.log(
                string.concat(
                    vm.toString(i),
                    " ",
                    markets[i].name,
                    " ",
                    vm.toString(uint256(markets[i].hlAssetIndex)),
                    " ",
                    vm.toString(uint256(markets[i].tier)),
                    " ",
                    vm.toString(uint256(inst.maxLeverage)),
                    " ",
                    vm.toString(d.launchPrices18[i]),
                    " ",
                    string.concat(
                        vm.toString(uint256(inst.longOiCapUsd)),
                        " ",
                        vm.toString(uint256(inst.maxNotionalUsd)),
                        " ",
                        vm.toString(uint256(inst.posX10)),
                        " ",
                        vm.toString(uint256(inst.sideX10)),
                        " ",
                        vm.toString(uint256(inst.stressBps))
                    )
                )
            );
        }

        if (cfg.owner != deployer) {
            console.log("== ownership ==");
            console.log("pending owner       ", cfg.owner);
            console.log("OWNER must call acceptOwnership() on Staking, PriceOracle and Exchange.");
        } else {
            console.log("owner               ", cfg.owner);
        }
    }
}
