// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Confetti} from "../src/Confetti.sol";
import {Tokenomics} from "../src/Tokenomics.sol";
import {Staking} from "../src/Staking.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {PrecompilePriceSource} from "../src/PrecompilePriceSource.sol";
import {Exchange} from "../src/Exchange.sol";
import {Referrals} from "../src/Referrals.sol";
import {ImpactLib} from "../src/lib/ImpactLib.sol";
import {IExchange} from "../src/interfaces/IExchange.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";

/// @title LaunchMarkets
/// @notice The launch market table from DESIGN section 4: tier A plus TRUMP and kPEPE, with the
///         per-coin max leverage, the per-tier deadband, clamp, OI caps and per-position caps,
///         and the impact curve every market starts with.
/// @dev Hyperliquid asset indices and szDecimals were read from the public perp meta on
///      12 Oct 2026. Instrument ids are assigned in table order (DOGE = 0 ... kPEPE = 9).
library LaunchMarkets {
    struct Market {
        string name;
        uint32 hlAssetIndex;
        uint8 szDecimals;
        uint8 tier;
        uint32 maxLeverage;
        /// @dev Per-coin deadband, or 0 for the tier's default (`deadbandBps(tier)`).
        uint16 deadbandBps;
    }

    /// @notice Impact curve shared by every launch market (DESIGN section 4).
    uint16 internal constant BASE_RATE_BPS = 1000;
    uint64 internal constant RATE_MULTIPLIER = 15_000;
    uint128 internal constant REFERENCE_NOTIONAL_USD = 20_000e6;

    /// @notice Payout cap for every launch market: profit at most 50x margin (DESIGN 3b).
    uint16 internal constant PAYOUT_CAP_X = 50;

    /// @notice Number of launch markets.
    uint256 internal constant COUNT = 10;

    /// @notice The launch table, in instrument-id order: name, asset index, szDecimals, tier,
    ///         max leverage (per coin: 1000x on tier A, 250x on TRUMP and kPEPE), deadband
    ///         override (0 = the tier's). MELANIA, WIF and PEOPLE open with 3 bps instead of
    ///         tier A's 1: on ops/data/oracle_lag2.csv their oracle still carries about 1 bps
    ///         (2-5 bps in the tails) of the book's lead five seconds after a request, which a
    ///         1 bps deadband does not absorb; the other tier A coins catch up within the delay.
    function all() internal pure returns (Market[] memory m) {
        m = new Market[](COUNT);
        m[0] = Market("DOGE", 12, 0, 0, 1000, 0);
        m[1] = Market("FARTCOIN", 165, 1, 0, 1000, 0);
        m[2] = Market("VIRTUAL", 162, 1, 0, 1000, 0);
        m[3] = Market("WIF", 98, 0, 0, 1000, 3);
        m[4] = Market("MELANIA", 175, 1, 0, 1000, 3);
        m[5] = Market("kFLOKI", 119, 0, 0, 1000, 0);
        m[6] = Market("PENGU", 163, 0, 0, 1000, 0);
        m[7] = Market("PEOPLE", 100, 0, 0, 1000, 3);
        m[8] = Market("TRUMP", 174, 1, 1, 250, 0);
        m[9] = Market("kPEPE", 15, 0, 1, 250, 0);
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

    /// @notice Clamp half-width per tier: 5 / 25 / 50 bps. Pricing is oracle only, so the clamp
    ///         only shapes `PriceOracle.price`, the display-only clamped mid; it is kept at or
    ///         under each tier's bust move (5 bps at 1000x, 35 at 250x; the Exchange's clamp
    ///         floor is 5) so that view can never show a book push past bust.
    function clampBps(uint8 tier) internal pure returns (uint16) {
        if (tier == 0) return 5;
        if (tier == 1) return 25;
        return 50;
    }

    /// @notice Starting OI cap per side per tier: $250K / $100K / $25K.
    function oiCapUsd(uint8 tier) internal pure returns (uint128) {
        if (tier == 0) return 250_000e6;
        if (tier == 1) return 100_000e6;
        return 25_000e6;
    }

    /// @notice Max notional per position per tier: $25K / $10K / $2.5K (DESIGN section 4).
    function maxNotionalUsd(uint8 tier) internal pure returns (uint128) {
        if (tier == 0) return 25_000e6;
        if (tier == 1) return 10_000e6;
        return 2_500e6;
    }

    /// @notice Build the `addInstrument` spec for a market.
    /// @dev `opensPaused`, `retired` and `frozenPx18` are forced by the Exchange, so they are
    ///      left at zero here. `maxLeverage` is the coin's own cap from the table.
    function spec(Market memory m, uint128 positionMultiplierE6) internal pure returns (IExchange.Instrument memory) {
        return IExchange.Instrument({
            hlAssetIndex: m.hlAssetIndex,
            szDecimals: m.szDecimals,
            tier: m.tier,
            maxLeverage: m.maxLeverage,
            deadbandBps: marketDeadbandBps(m),
            clampBps: clampBps(m.tier),
            baseRateBps: BASE_RATE_BPS,
            rateMultiplier: RATE_MULTIPLIER,
            referenceNotionalUsd: REFERENCE_NOTIONAL_USD,
            positionMultiplierE6: positionMultiplierE6,
            longOiCapUsd: oiCapUsd(m.tier),
            shortOiCapUsd: oiCapUsd(m.tier),
            maxNotionalUsd: maxNotionalUsd(m.tier),
            payoutCapX: PAYOUT_CAP_X,
            opensPaused: false,
            retired: false,
            frozenPx18: 0
        });
    }
}

/// @title ConfettiDeployer
/// @notice The deployment steps, shared by the `Deploy` script and the integration and fork
///         tests so that what is tested is what gets deployed.
/// @dev Order (every contract takes `deployer` as its first owner so the deployer can wire it):
///        1. price source (given, or a fresh PrecompilePriceSource)
///        2. Confetti, Tokenomics, Staking, PriceOracle, Exchange (which creates its own
///           Referrals in its constructor: no wiring, owned by the Exchange for good)
///        3. oracle.setRegistrar(exchange); confetti.wire; tokenomics.setExchange; staking.wire;
///           exchange.setKeepers; exchange.setKeeper(keeper, true) (the fill keeper)
///        4. launch markets, each with a live, non-zero launch price
///        5. transferOwnership(owner) on all five (two-step: `owner` must accept each).
///      Holds no cheatcodes, so it works under a broadcast and inside a test alike.
///      Reuse (the `reuse*` config fields): a contract named there is not created, only wired
///      in step 3 like a fresh one. Step 3 is one-shot on every contract (`RegistrarAlreadySet`,
///      `AlreadyWired`), so a reused contract must still be unwired and owned by `deployer`,
///      and a reused Exchange must have no instruments yet (step 4 asserts the ids). The path
///      therefore runs once per set of contracts; a second run reverts on the oracle first.
abstract contract ConfettiDeployer {
    /// @param usdc USDC token (6 decimals).
    /// @param owner Final owner of every contract (the deployer EOA at launch; changes take
    ///        effect immediately).
    /// @param guardian Pause guardian (zero disables the role).
    /// @param keeper Market keeper and fill keeper (zero disables both roles).
    /// @param feeRecipient Receives the non-staker share of pushed fees (all of it at launch)
    ///        plus the 10% team mint.
    /// @param priceSource Existing IPriceSource, or zero to deploy a PrecompilePriceSource.
    /// @param launchPrices18 Launch price per market in table order (1e18), or empty to read
    ///        them from the price source.
    /// @param flatThresholdUsd Tokenomics flat-region end, USDC 6-dec.
    /// @param tailDecayScaleUsd Tokenomics S, USDC 6-dec.
    /// @param stakerCapUsd Tokenomics staker cap, USDC 6-dec.
    /// @param flatRateE18 Tokenomics flat rate, 1e18 CONFETTI per $1.
    struct Config {
        address usdc;
        address owner;
        address guardian;
        address keeper;
        address feeRecipient;
        address priceSource;
        uint256[] launchPrices18;
        uint256 flatThresholdUsd;
        uint256 tailDecayScaleUsd;
        uint256 stakerCapUsd;
        uint256 flatRateE18;
        // Already-deployed, not-yet-wired contracts to reuse (zero deploys a fresh one). Lets a
        // deploy that stopped after some creates finish without redeploying them. Each must be
        // owned by the deployer and unwired: wiring is one-shot, so naming a wired contract
        // reverts (`RegistrarAlreadySet` / `AlreadyWired`), see the contract NatSpec.
        address reuseConfetti;
        address reuseTokenomics;
        address reuseStaking;
        address reuseOracle;
        address reuseExchange;
    }

    /// @notice Everything `_deploy` produced.
    struct Deployment {
        IPriceSource source;
        PriceOracle oracle;
        Confetti confetti;
        Tokenomics tokenomics;
        Staking staking;
        Exchange exchange;
        Referrals referrals;
        uint256[] launchPrices18;
    }

    /// @notice LAUNCH_PRICES was given but does not have one entry per launch market.
    error LaunchPriceCountMismatch(uint256 given, uint256 expected);
    /// @notice A launch price is zero: the feed is dead or the env entry is wrong.
    error LaunchPriceZero(uint32 hlAssetIndex);
    /// @notice The impact curve does not keep about 88% at a 1% move and 74% at a 0.1% move.
    error CurveOffTarget(uint32 hlAssetIndex, uint256 scaleOnePctE18, uint256 scaleTenthPctE18);

    /// @notice Position multiplier (x1e6) used for every launch market, see `_positionMultiplierE6`.
    uint128 public constant LAUNCH_POSITION_MULTIPLIER_E6 = 130_000_000e6;

    /// @notice Tokenomics defaults (DESIGN section 7), mirrored from Tokenomics.DEFAULT_*.
    uint256 public constant DEFAULT_FLAT_THRESHOLD_USD = 250_000e6;
    uint256 public constant DEFAULT_TAIL_DECAY_SCALE_USD = 15_000_000e6;
    uint256 public constant DEFAULT_STAKER_CAP_USD = 500_000e6;
    uint256 public constant DEFAULT_FLAT_RATE_E18 = 100e18;

    /// @dev Deploy, wire, add the launch markets and hand ownership to `cfg.owner`.
    function _deploy(Config memory cfg, address deployer) internal returns (Deployment memory d) {
        d.source = cfg.priceSource == address(0)
            ? IPriceSource(address(new PrecompilePriceSource()))
            : IPriceSource(cfg.priceSource);

        d.confetti = cfg.reuseConfetti != address(0) ? Confetti(cfg.reuseConfetti) : new Confetti(deployer);
        d.tokenomics = cfg.reuseTokenomics != address(0)
            ? Tokenomics(cfg.reuseTokenomics)
            : new Tokenomics(deployer, cfg.flatThresholdUsd, cfg.tailDecayScaleUsd, cfg.stakerCapUsd, cfg.flatRateE18);
        d.staking = cfg.reuseStaking != address(0)
            ? Staking(cfg.reuseStaking)
            : new Staking(deployer, address(d.confetti), cfg.usdc);
        d.oracle = cfg.reuseOracle != address(0) ? PriceOracle(cfg.reuseOracle) : new PriceOracle(d.source, deployer);
        d.exchange = cfg.reuseExchange != address(0)
            ? Exchange(cfg.reuseExchange)
            : new Exchange(IERC20(cfg.usdc), d.oracle, d.confetti, d.tokenomics, d.staking, deployer, cfg.feeRecipient);
        d.referrals = Referrals(d.exchange.referrals());

        d.oracle.setRegistrar(address(d.exchange));
        d.confetti.wire(address(d.exchange), address(d.staking));
        d.tokenomics.setExchange(address(d.exchange));
        d.staking.wire(address(d.exchange), address(d.tokenomics));
        d.exchange.setKeepers(cfg.guardian, cfg.keeper);
        if (cfg.keeper != address(0)) d.exchange.setKeeper(cfg.keeper, true);

        d.launchPrices18 = _addLaunchMarkets(d, cfg.launchPrices18);
        _handOver(d, deployer, cfg.owner);
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
        for (uint256 i = 0; i < markets.length; i++) {
            LaunchMarkets.Market memory m = markets[i];
            uint256 px18 = given.length != 0 ? given[i] : _readLaunchPrice18(d.source, m);
            if (px18 == 0) revert LaunchPriceZero(m.hlAssetIndex);
            prices18[i] = px18;

            IExchange.Instrument memory spec = LaunchMarkets.spec(m, _positionMultiplierE6(px18));
            _checkCurve(m.hlAssetIndex, spec);
            uint32 id = d.exchange.addInstrument(spec);
            assert(id == i);
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
    ///      about 88% of the raw gain and a 0.1% move about 74%. In the section 6 curve,
    ///        scale = (1 - base) / (1 + 1 / (move * rateMultiplier)
    ///                               + referenceNotional / (move * positionMultiplier)),
    ///      the size term holds the reference notional in dollars and no position size or
    ///      asset price, so the multiplier that meets both targets is the same for every market:
    ///      130,000,000 gives 88.06% and 73.74% (`_checkCurve` verifies this on each market).
    ///      The launch price is still required so a dead feed stops the deploy, but it does
    ///      not change the number. If a later curve adds a price term, this is the one place
    ///      to compute it.
    function _positionMultiplierE6(uint256 launchPx18) internal pure returns (uint128) {
        require(launchPx18 != 0, "launch price is zero");
        return LAUNCH_POSITION_MULTIPLIER_E6;
    }

    /// @dev Reject a curve that misses the published targets (same bounds as the unit tests).
    function _checkCurve(uint32 hlAssetIndex, IExchange.Instrument memory spec) internal pure {
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

    /// @dev Start the two-step handover on all five contracts. No-op when the deployer keeps
    ///      ownership. `owner` must call `acceptOwnership()` on each.
    function _handOver(Deployment memory d, address deployer, address owner) internal {
        if (owner == deployer) return;
        d.confetti.transferOwnership(owner);
        d.tokenomics.transferOwnership(owner);
        d.staking.transferOwnership(owner);
        d.oracle.transferOwnership(owner);
        d.exchange.transferOwnership(owner);
    }
}

/// @title Deploy
/// @notice Env-driven mainnet deploy of the whole Confetti system.
/// @dev Required env: USDC, OWNER, GUARDIAN, KEEPER, FEE_RECIPIENT.
///      Optional env: PRICE_SOURCE (reuse an IPriceSource; default deploys PrecompilePriceSource),
///      LAUNCH_PRICES (comma-separated 1e18 prices in LaunchMarkets order; when empty, `run`
///      reads them from the BBO precompile through `eth_call` on the RPC, see
///      `launchPricesFromRpc`, whether or not PRICE_SOURCE is set),
///      FLAT_THRESHOLD_USD, TAIL_DECAY_SCALE_USD, STAKER_CAP_USD, FLAT_RATE_E18 (Tokenomics
///      parameters; defaults from DESIGN section 7),
///      REUSE_CONFETTI, REUSE_TOKENOMICS, REUSE_STAKING, REUSE_ORACLE, REUSE_EXCHANGE (finish a
///      deploy that stopped after some creates: the named contracts are wired, not created;
///      they must be unwired and owned by the broadcaster, or the run reverts, see
///      `ConfettiDeployer`).
///      Run:
///        forge script script/Deploy.s.sol --rpc-url $RPC --account deployer --broadcast
///          --disable-block-gas-limit
///      `--disable-block-gas-limit` is required: the local simulation inherits the 3M gas limit
///      of a HyperEVM small block and the Exchange deployment alone needs more. For the same
///      reason the deployer address must have HyperEVM big blocks enabled (HyperCore
///      `evmUserModify` with `usingBigBlocks`) before broadcasting, or the Exchange create will
///      not fit a block. The broadcaster is the deployer and first owner; OWNER then accepts
///      ownership on each of the five contracts. Never put a private key in this file or in
///      the env of a shared shell.
contract Deploy is Script, ConfettiDeployer {
    /// @dev HyperCore BBO precompile, read over RPC for launch prices (see `launchPricesFromRpc`).
    address public constant BBO_PRECOMPILE = 0x000000000000000000000000000000000000080e;

    function run() external returns (Deployment memory d) {
        Config memory cfg = configFromEnv();
        if (cfg.launchPrices18.length == 0) {
            cfg.launchPrices18 = launchPricesFromRpc();
        }

        vm.startBroadcast();
        (, address deployer,) = Vm(address(vm)).readCallers();
        d = _deploy(cfg, deployer);
        vm.stopBroadcast();

        _report(cfg, d, deployer);
    }

    /// @notice Read the deploy configuration from the environment.
    function configFromEnv() public view returns (Config memory cfg) {
        cfg.usdc = vm.envAddress("USDC");
        cfg.owner = vm.envAddress("OWNER");
        cfg.guardian = vm.envAddress("GUARDIAN");
        cfg.keeper = vm.envAddress("KEEPER");
        cfg.feeRecipient = vm.envAddress("FEE_RECIPIENT");
        cfg.priceSource = vm.envOr("PRICE_SOURCE", address(0));
        cfg.launchPrices18 = vm.envOr("LAUNCH_PRICES", ",", new uint256[](0));
        cfg.flatThresholdUsd = vm.envOr("FLAT_THRESHOLD_USD", DEFAULT_FLAT_THRESHOLD_USD);
        cfg.tailDecayScaleUsd = vm.envOr("TAIL_DECAY_SCALE_USD", DEFAULT_TAIL_DECAY_SCALE_USD);
        cfg.stakerCapUsd = vm.envOr("STAKER_CAP_USD", DEFAULT_STAKER_CAP_USD);
        cfg.flatRateE18 = vm.envOr("FLAT_RATE_E18", DEFAULT_FLAT_RATE_E18);
        cfg.reuseConfetti = vm.envOr("REUSE_CONFETTI", address(0));
        cfg.reuseTokenomics = vm.envOr("REUSE_TOKENOMICS", address(0));
        cfg.reuseStaking = vm.envOr("REUSE_STAKING", address(0));
        cfg.reuseOracle = vm.envOr("REUSE_ORACLE", address(0));
        cfg.reuseExchange = vm.envOr("REUSE_EXCHANGE", address(0));
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

    /// @dev `eth_call` against the script's RPC. vm.rpc decodes the hex result into raw bytes,
    ///      exactly what the precompile would have returned.
    function _ethCall(address to, bytes memory data) internal returns (bytes memory) {
        string memory params =
            string.concat('[{"to":"', vm.toString(to), '","data":"', vm.toString(data), '"},"latest"]');
        return vm.rpc("eth_call", params);
    }

    function _report(Config memory cfg, Deployment memory d, address deployer) internal view {
        console.log("== Confetti deployment ==");
        console.log("deployer            ", deployer);
        console.log("USDC                ", cfg.usdc);
        console.log("PriceSource         ", address(d.source));
        console.log("PriceOracle         ", address(d.oracle));
        console.log("Confetti            ", address(d.confetti));
        console.log("Tokenomics          ", address(d.tokenomics));
        console.log("Staking             ", address(d.staking));
        console.log("Exchange            ", address(d.exchange));
        console.log("Referrals           ", address(d.referrals));
        console.log("fee recipient       ", cfg.feeRecipient);
        console.log("pause guardian      ", cfg.guardian);
        console.log("market + fill keeper", cfg.keeper);
        console.log("delays (s)          ", d.exchange.minDelay(), d.exchange.grace(), d.exchange.expiry());

        LaunchMarkets.Market[] memory markets = LaunchMarkets.all();
        console.log("== launch markets: id name hlIndex tier maxLeverage launchPrice(1e18) ==");
        for (uint256 i = 0; i < markets.length; i++) {
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
                    vm.toString(uint256(d.exchange.instrument(uint32(i)).maxLeverage)),
                    " ",
                    vm.toString(d.launchPrices18[i])
                )
            );
        }

        if (cfg.owner != deployer) {
            console.log("== ownership ==");
            console.log("pending owner       ", cfg.owner);
            console.log("OWNER must call acceptOwnership() on Confetti, Tokenomics, Staking, PriceOracle and Exchange.");
        } else {
            console.log("owner               ", cfg.owner);
        }
    }
}
