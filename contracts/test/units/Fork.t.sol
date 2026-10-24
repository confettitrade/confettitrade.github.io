// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {ConfettiDeployer, LaunchMarkets} from "../../script/Deploy.s.sol";
import {PrecompilePriceSource} from "../../src/PrecompilePriceSource.sol";
import {ImpactLib} from "../../src/lib/ImpactLib.sol";
import {IExchange} from "../../src/interfaces/IExchange.sol";
import {IExchangeTypes} from "../../src/interfaces/IExchangeTypes.sol";

/// @dev The live v3 contracts the fork test reads (nothing on them changes).
interface ILiveFetti {
    function exchange() external view returns (address);
    function staking() external view returns (address);
    function transfersEnabled() external view returns (bool);
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface ILiveV3Staking {
    function confetti() external view returns (address);
    function stakedOf(address) external view returns (uint256);
    function earned(address) external view returns (uint256);
    function totalStaked() external view returns (uint256);
    function totalWarming() external view returns (uint256);
    function claim() external returns (uint256);
    function unstake(uint256) external;
}

interface ILiveV3Exchange {
    function balanceOf(address) external view returns (uint256);
}

/// @dev Probe: in isolated mode a top-level create is its own transaction and gets at most the
///      block gas limit, so on a HyperEVM small block this records about 3M instead of ~1e9.
contract GasProbe {
    uint256 public immutable gasAtCreation;

    constructor() {
        gasAtCreation = gasleft();
    }
}

/// @title ForkTest
/// @notice HyperEVM mainnet fork: deploys the whole v4 system with the real
///         PrecompilePriceSource, checks the launch table against HyperCore's own asset registry,
///         reads DOGE and FARTCOIN, checks that settlement reads the oracle price on the live
///         quotes, and trades tiny positions against house money through the request / execute
///         path with deal()'d USDC. A v4 section deploys on the live FETTI and moves a real v3
///         stake (live v3 Staking state) to v4 Staking, and checks the v3 referral registry is carried.
/// @dev Forge executes the EVM locally and the HyperCore precompiles have no bytecode, so a
///      forked staticcall to them would return nothing. The fixture therefore fetches each
///      precompile's real return data with `eth_call` through `vm.rpc` and pins it with
///      `vm.mockCall`; the production ABI decoding and scaling then run unchanged against
///      live mainnet values.
///      Skipped (no RPC call at all) unless FORK_URL is set:
///        FORK_URL=https://rpc.hyperliquid.xyz/evm forge test --match-contract ForkTest --no-isolate -vv
///      FORK_URL is tried first, the fallback RPC second. FETTI / V3_REFERRALS / V3_STAKER override
///      the live v3 addresses. `--no-isolate` (or `--disable-block-gas-limit`) is needed
///      because the forked HyperEVM small block reports a 3M gas limit, isolated calls are
///      capped at it, and the Exchange deployment alone needs more; the fixture detects that.
contract ForkTest is Test, ConfettiDeployer {
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant BBO_PRECOMPILE = 0x000000000000000000000000000000000000080e;
    address constant ORACLE_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    address constant MARK_PRECOMPILE = 0x0000000000000000000000000000000000000806;
    address constant PERP_ASSET_INFO_PRECOMPILE = 0x000000000000000000000000000000000000080a;
    string constant FALLBACK_RPC = "https://rpc.purroofgroup.com";
    uint32 constant DOGE = 0;
    uint32 constant FARTCOIN = 1;
    uint32 constant DOGE_ASSET = 12;
    uint256 constant HOUSE = 10_000e6;
    /// @dev The live price source v3 uses, the live FETTI (v4 keeps it) with its v3 Staking and
    ///      only minter (the v3 Exchange), the referral registry (site/config.json), and wallets
    ///      that held a live v3 stake: the owner wallet (2,593 FETTI at block 48,945,940; it left v3
    ///      by block 48,978,911), HOUSE BOT 01 (5,551 FETTI at block 48,978,911) and HOUSE BOT 02.
    ///      The test moves the first one still staked.
    address constant LIVE_PRICE_SOURCE = 0xFaF573187824D176fc74d1de91a072eb6ffa8494;
    address constant LIVE_FETTI = 0x995B36d7e33680fc6Fa1Db6fA4dc8e475B5233A2;
    address constant LIVE_V3_STAKING = 0x167549bB697F96Ee19e0fFBFa5aB5f6487F10051;
    address constant LIVE_V3_EXCHANGE = 0x723943c8FDd71e0E670B18d15BE737222F3A0810;
    address constant LIVE_V3_REFERRALS = 0xdF0C59514877F38A7B59bD7DB1422217aB25714B;
    address constant LIVE_OWNER_WALLET = 0x362100AEA1DF22cA7de4B156D04a19D50DC8b530;
    address constant LIVE_HOUSE_BOT_01 = 0x5089C25c62cF9b07d54de71b429fD954c9EF16EC;
    address constant LIVE_HOUSE_BOT_02 = 0xE8C7D21b7092329AB2248C7B347b01C66a19a9F2;

    /// @dev Return shape of the perp asset info precompile (0x80a).
    struct PerpAssetInfo {
        string coin;
        uint32 marginTableId;
        uint8 szDecimals;
        uint8 maxLeverage;
        bool onlyIsolated;
    }

    bool forked;
    Deployment d;
    IExchange ex;
    address trader = makeAddr("trader");
    address keeper = makeAddr("keeper");
    address stranger = makeAddr("stranger");
    address feeRecipient = makeAddr("feeRecipient");
    /// @dev The live DOGE BBO as pinned in setUp, so a test can push the book and restore it.
    uint64 liveDogeBid;
    uint64 liveDogeAsk;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        _selectFork(url);
        assertEq(block.chainid, 999, "not HyperEVM");
        require(
            new GasProbe().gasAtCreation() > 5_000_000,
            "ForkTest: creates are capped at the forked block's 3M gas limit; rerun with --no-isolate"
        );
        _pinPrecompiles();

        d = _deploy(_cfg(), address(this));
        ex = IExchange(address(d.exchange));
        _launch(d);
        (liveDogeBid, liveDogeAsk) = PrecompilePriceSource(address(d.source)).bbo(DOGE_ASSET);
        forked = true;
    }

    modifier onlyFork() {
        vm.skip(!forked);
        _;
    }

    // --------------------------------------------------------------- tests

    function test_fork_launchTableMatchesHyperCore() public onlyFork {
        LaunchMarkets.Market[] memory ms = LaunchMarkets.all();
        assertEq(ex.instrumentCount(), uint32(ms.length));
        assertEq(d.launchPrices18.length, ms.length);
        assertTrue(ex.isKeeper(keeper));
        assertEq(d.referrals.exchange(), address(d.exchange));
        for (uint256 i = 0; i < ms.length; i++) {
            uint32 id = uint32(i);
            PerpAssetInfo memory info =
                abi.decode(_ethCall(PERP_ASSET_INFO_PRECOMPILE, abi.encode(ms[i].hlAssetIndex)), (PerpAssetInfo));
            assertEq(info.coin, ms[i].name, "asset index points at another coin");
            assertEq(info.szDecimals, ms[i].szDecimals, ms[i].name);

            IExchangeTypes.Instrument memory inst = ex.instrument(id);
            assertEq(inst.hlAssetIndex, ms[i].hlAssetIndex);
            assertEq(inst.szDecimals, ms[i].szDecimals);
            assertEq(inst.maxLeverage, ms[i].maxLeverage, ms[i].name);

            uint256 px = d.oracle.price(id);
            assertGt(px, 0);
            assertEq(d.launchPrices18[i], d.oracle.rawMid(id), "launch price != feed mid");
            emit log_named_decimal_uint(ms[i].name, px, 18);
        }
    }

    function test_fork_dogeAndFartcoinPlausible_clampHolds() public onlyFork {
        uint256 doge = d.oracle.price(DOGE);
        assertGt(doge, 0.01e18, "DOGE under $0.01");
        assertLt(doge, 10e18, "DOGE over $10");
        uint256 fartcoin = d.oracle.price(FARTCOIN);
        assertGt(fartcoin, 0.01e18, "FARTCOIN under $0.01");
        assertLt(fartcoin, 100e18, "FARTCOIN over $100");

        // The raw decode is sane and the oracle scales it by 10^(12 + szDecimals).
        PrecompilePriceSource src = PrecompilePriceSource(address(d.source));
        (uint64 bid, uint64 ask) = src.bbo(DOGE_ASSET);
        assertGt(bid, 0);
        assertLe(bid, ask);
        assertEq(d.oracle.rawMid(DOGE), (uint256(bid) + uint256(ask)) * 1e12 / 2);
        assertEq(d.oracle.oraclePrice(DOGE), uint256(src.oraclePx(DOGE_ASSET)) * 1e12);
        assertEq(d.oracle.markPrice(DOGE), uint256(src.mark(DOGE_ASSET)) * 1e12);
        // The three HyperCore prices agree to well within 1% on a live market.
        assertApproxEqRel(d.oracle.oraclePrice(DOGE), d.oracle.rawMid(DOGE), 0.01e18, "oracle vs mid");
        assertApproxEqRel(d.oracle.markPrice(DOGE), d.oracle.rawMid(DOGE), 0.01e18, "mark vs mid");
        (uint64 fBid, uint64 fAsk) = src.bbo(165);
        assertEq(d.oracle.rawMid(FARTCOIN), (uint256(fBid) + uint256(fAsk)) * 1e13 / 2);

        _assertClampHolds(DOGE);
        _assertClampHolds(FARTCOIN);
    }

    function test_fork_execPriceIsTheOracleOnLiveQuotes() public onlyFork {
        LaunchMarkets.Market[] memory ms = LaunchMarkets.all();
        for (uint256 i = 0; i < ms.length; i++) {
            uint32 id = uint32(i);
            uint256 ref = d.oracle.oraclePrice(id);
            // Every side and direction settles on the oracle print, never on the book.
            assertEq(ex.execPrice(id, true, true), ref, ms[i].name);
            assertEq(ex.execPrice(id, false, true), ref, ms[i].name);
            assertEq(ex.execPrice(id, true, false), ref, ms[i].name);
            assertEq(ex.execPrice(id, false, false), ref, ms[i].name);
        }
        if (d.oracle.rawMid(DOGE) != d.oracle.oraclePrice(DOGE)) {
            assertTrue(ex.execPrice(DOGE, true, true) != d.oracle.rawMid(DOGE), "settled on the mid");
        }
    }

    function test_fork_requestExecuteRoundTrip_withRealUsdcAndHouseMoney() public onlyFork {
        uint256 fettiSupply0 = ILiveFetti(address(d.fetti)).totalSupply();
        _depositHouse(HOUSE);
        deal(USDC, trader, 100e6);
        vm.startPrank(trader);
        IERC20(USDC).approve(address(ex), 100e6);
        ex.deposit(100e6);
        vm.stopPrank();
        assertEq(ex.balanceOf(trader), 100e6);

        _keeperFillsThenFallbackClosePaysOnlyTheSpread();
        _pushedBookPaysNothing();
        uint256 bounty = _pushedBookCannotLiquidate();

        // v4 has no FETTI mint: trading leaves the live supply where it was.
        assertEq(ILiveFetti(address(d.fetti)).totalSupply(), fettiSupply0);

        // The cash model holds on the real token and the trader can leave.
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.pendingOf(trader), 0);
        assertEq(ex.marginInUse(trader), 0);
        uint256 traderLeft = ex.balanceOf(trader);
        assertEq(IERC20(USDC).balanceOf(address(ex)), HOUSE + 100e6);
        assertEq(traderLeft + ex.lpBalance() + bounty, HOUSE + 100e6);
        vm.prank(trader);
        ex.withdraw(traderLeft);
        assertEq(IERC20(USDC).balanceOf(trader), traderLeft);
        assertEq(IERC20(USDC).balanceOf(address(ex)), HOUSE + 100e6 - traderLeft);
    }

    /// @dev A 10x long requested at the live oracle print, filled by the keeper 5 s later at
    ///      the (pinned, so unchanged) print plus the 1 bps entry spread, then closed by a
    ///      stranger in the fallback window at the same print: the trader pays the spread only.
    function _keeperFillsThenFallbackClosePaysOnlyTheSpread() internal {
        uint256 ref = d.oracle.oraclePrice(DOGE);
        vm.prank(trader);
        uint256 req = ex.requestOpen(DOGE, true, 10e6, 10, address(0));
        assertEq(ex.openRequest(req).px0, ref);
        assertEq(ex.balanceOf(trader), 90e6);
        assertEq(ex.pendingOf(trader), 10e6);
        // Nobody before 5 s, only the keeper at 5 s.
        vm.warp(vm.getBlockTimestamp() + 4);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.TooEarly.selector);
        ex.executeOpen(req);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(stranger);
        vm.expectRevert(IExchangeTypes.KeeperWindow.selector);
        ex.executeOpen(req);
        vm.prank(keeper);
        uint256 id = ex.executeOpen(req);
        assertGt(id, 0);
        uint16 spread = ex.instrument(DOGE).entryDeadbandBps;
        assertEq(ex.positions(id).entryPx18, ImpactLib.spreadEntry(ref, true, spread));
        assertEq(ex.marginInUse(trader), 10e6);

        vm.prank(trader);
        ex.requestClose(id);
        vm.warp(vm.getBlockTimestamp() + 8); // past the keeper window: anyone fills
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(id);
        // $100 notional, 1 bps spread: about one cent lost, no borrow yet; the 5% loss fee on it
        // comes from the house's side, not the payout.
        assertLe(pnl, 0);
        assertGe(pnl, -20_000);
        assertEq(fee, uint256(-pnl) * 500 / 10_000);
        assertEq(payout, uint256(int256(10e6) + pnl));
        vm.prank(stranger);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, payout);
        assertEq(queued, 0);
        assertEq(ex.balanceOf(trader), 90e6 + paid);
    }

    /// @dev The BBO pushed 5% over the oracle price: the close settles on the oracle, nothing
    ///      for the push. The preview is the same before and after the push.
    function _pushedBookPaysNothing() internal {
        uint256 ref = d.oracle.oraclePrice(DOGE);
        vm.prank(trader);
        uint256 req = ex.requestOpen(DOGE, true, 10e6, 10, address(0));
        vm.warp(vm.getBlockTimestamp() + 5);
        vm.prank(keeper);
        uint256 id = ex.executeOpen(req);
        (int256 pnlBefore,, uint256 payoutBefore) = ex.previewClose(id);
        _mockDogeBbo(105);
        assertGt(d.oracle.rawMid(DOGE), ref);
        assertEq(ex.execPrice(DOGE, true, false), ref);
        _assertClampHolds(DOGE);
        (int256 pnl,, uint256 payout) = ex.previewClose(id);
        assertEq(pnl, pnlBefore);
        assertEq(payout, payoutBefore);
        assertLe(payout, 10e6);
        vm.prank(trader);
        ex.requestClose(id);
        vm.warp(vm.getBlockTimestamp() + 5);
        vm.prank(keeper);
        (uint256 paid,) = ex.executeClose(id);
        assertEq(paid, payout);
        _mockDogeBbo(100);
    }

    /// @dev A pushed book cannot liquidate. 50x long: the BBO 3% under the oracle changes
    ///      nothing, the settlement price is the oracle. The oracle itself 3% down busts it,
    ///      pending close or not. Returns the bounty, credited to this contract.
    function _pushedBookCannotLiquidate() internal returns (uint256 bounty) {
        uint256 ref = d.oracle.oraclePrice(DOGE);
        vm.prank(trader);
        uint256 req = ex.requestOpen(DOGE, true, 10e6, 50, address(0));
        vm.warp(vm.getBlockTimestamp() + 5);
        vm.prank(keeper);
        uint256 id = ex.executeOpen(req);
        uint256 bust = ex.bustPrice(id);
        _mockDogeBbo(97);
        assertLt(d.oracle.rawMid(DOGE), bust);
        assertEq(ex.execPrice(DOGE, true, true), ref);
        assertGt(ref, bust);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, id, ref, bust));
        ex.liquidate(id);
        vm.prank(trader);
        ex.requestClose(id);
        uint64 oraclePx = PrecompilePriceSource(address(d.source)).oraclePx(DOGE_ASSET);
        vm.mockCall(ORACLE_PRECOMPILE, abi.encode(DOGE_ASSET), abi.encode(uint64(uint256(oraclePx) * 97 / 100)));
        assertLe(ex.execPrice(DOGE, true, true), bust);
        bounty = ex.liquidate(id);
        assertEq(bounty, 10e6 * 50 / 10_000); // 0.5% of the $10 margin
        assertEq(ex.balanceOf(address(this)), bounty);
        assertEq(ex.closeRequest(id).requestedAt, 0);
        vm.warp(vm.getBlockTimestamp() + 5);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.UnknownRequest.selector);
        ex.executeClose(id);
        _mockDogeBbo(100);
        vm.mockCall(ORACLE_PRECOMPILE, abi.encode(DOGE_ASSET), abi.encode(oraclePx));
    }

    // ------------------------------------------------------------------- v4

    /// @dev The deploy can reuse the live PrecompilePriceSource (PRICE_SOURCE): no new source
    ///      is created, the oracle reads it, and every launch market prices through it.
    function test_fork_v4_reusesTheLivePriceSource() public onlyFork {
        assertGt(LIVE_PRICE_SOURCE.code.length, 0, "live source missing on this fork");
        Config memory cfg = _cfg();
        cfg.priceSource = LIVE_PRICE_SOURCE;
        Deployment memory v4 = _deploy(cfg, address(this));
        IExchange e = IExchange(address(v4.exchange));
        assertEq(address(v4.source), LIVE_PRICE_SOURCE);
        assertEq(v4.oracle.source(), LIVE_PRICE_SOURCE);
        assertEq(e.instrumentCount(), uint32(LaunchMarkets.COUNT));
        assertEq(e.sessionRouter(), address(v4.router));
        assertEq(address(v4.router.exchange()), address(v4.exchange));
        assertEq(e.marketRules(), address(v4.rules));
        assertEq(address(v4.depositFactory.exchange()), address(v4.exchange));
        assertEq(address(v4.depositFactory.usdc()), USDC);
        for (uint32 id = 0; id < LaunchMarkets.COUNT; id++) {
            assertEq(e.execPrice(id, true, true), v4.oracle.oraclePrice(id));
            assertEq(v4.launchPrices18[id], v4.oracle.rawMid(id), "launch price != live mid");
        }
    }

    /// @dev House money and a session-key round trip on real USDC and real HYPE: the owner
    ///      deposits house money, the key's trade is the trader's, and once nothing is owed
    ///      the owner withdraws the house money at once, no notice.
    function test_fork_v4_houseMoneyAndSessionRoundTrip_realUsdc() public onlyFork {
        uint256 keyPk = uint256(keccak256("sessionKey"));
        address key = vm.addr(keyPk);
        _depositHouse(500e6);
        assertEq(ex.lpBalance(), 500e6);
        assertEq(ex.houseFreeUsdc(), 500e6);

        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 digest = d.router.authorizationDigest(trader, key, expiry, 20e6, address(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyPk, MessageHashUtils.toEthSignedMessageHash(digest));
        deal(USDC, trader, 50e6);
        vm.deal(trader, 1 ether);
        vm.startPrank(trader);
        IERC20(USDC).approve(address(ex), 50e6);
        ex.deposit(50e6);
        d.router.authorize{value: 0.01 ether}(key, expiry, 20e6, address(0), abi.encodePacked(r, s, v));
        vm.stopPrank();
        assertEq(key.balance, 0.01 ether);
        vm.prank(key);
        uint256 req = d.router.requestOpen(DOGE, true, 10e6, 10);
        assertEq(ex.openRequest(req).trader, trader);
        vm.warp(vm.getBlockTimestamp() + 5);
        vm.prank(keeper);
        uint256 id = ex.executeOpen(req);
        assertEq(ex.positions(id).owner, trader);

        vm.prank(key);
        d.router.requestClose(id);
        vm.warp(vm.getBlockTimestamp() + 5);
        vm.prank(keeper);
        (uint256 paid,) = ex.executeClose(id);
        assertLe(paid, 10e6); // pinned oracle: the spread only
        assertEq(ex.balanceOf(trader), 40e6 + paid);
        assertEq(ex.balanceOf(key), 0);

        // Nothing queued; the loss fee (5% of the spread) is the fee pool's. withdrawHouse pushes
        // the pool first (the stakers' share stays earmarked while nothing is staked), then
        // everything not owed leaves at once.
        assertEq(ex.queuedTotal(), 0);
        uint256 loss = 10e6 - paid;
        assertEq(ex.feePool(), loss * 500 / 10_000);
        uint256 lp = ex.lpBalance();
        assertEq(lp, 500e6 + loss);
        uint256 free = ex.houseFreeUsdc();
        assertEq(free, lp - ex.feePool());
        ex.withdrawHouse(free);
        assertEq(IERC20(USDC).balanceOf(address(this)), free);
        assertEq(ex.lpBalance(), ex.feePool()); // only the stakers' earmark is left
        assertEq(
            IERC20(USDC).balanceOf(address(ex)), ex.balanceOf(trader) + ex.balanceOf(feeRecipient) + ex.lpBalance()
        );
    }

    /// @dev v4 runs on the live FETTI: it is the token v3 Staking stakes, its only minter is the
    ///      v3 Exchange (v4 holds no role on it), and a real v3 stake moves to v4 Staking (v3
    ///      claim, v3 unstake, approve, v4 stake) and earns the stakers' share of v4 fees there,
    ///      paid to the wallet. The FETTI supply never moves; the v4 registry carries v3's.
    function test_fork_v4_realV3StakeMovesToV4Staking_andEarnsV4Fees() public onlyFork {
        ILiveFetti fetti = ILiveFetti(address(d.fetti));
        ILiveV3Staking v3s = ILiveV3Staking(LIVE_V3_STAKING);
        assertEq(keccak256(bytes(fetti.symbol())), keccak256("FETTI"));
        assertEq(d.staking.confetti(), address(fetti));
        assertEq(v3s.confetti(), address(fetti), "not the token v3 Staking stakes");
        assertEq(fetti.staking(), LIVE_V3_STAKING);
        assertEq(fetti.exchange(), LIVE_V3_EXCHANGE, "FETTI's minter is not the v3 Exchange");
        assertTrue(fetti.transfersEnabled(), "FETTI transfers are off: v4 Staking could not hold it");
        assertEq(d.referrals.v3Referrals(), vm.envOr("V3_REFERRALS", LIVE_V3_REFERRALS));

        address staker = vm.envOr("V3_STAKER", address(0));
        if (staker == address(0)) {
            address[3] memory known = [LIVE_OWNER_WALLET, LIVE_HOUSE_BOT_01, LIVE_HOUSE_BOT_02];
            for (uint256 i = 0; i < known.length && staker == address(0); i++) {
                if (v3s.stakedOf(known[i]) > 0) staker = known[i];
            }
        }
        uint256 stake = v3s.stakedOf(staker);
        assertGt(stake, 0, "no live v3 stake on this fork (owner wallet, HOUSE BOT 01 / 02; set V3_STAKER)");
        uint256 supply0 = fetti.totalSupply();
        uint256 v3Total0 = v3s.totalStaked() + v3s.totalWarming();
        uint256 wallet0 = fetti.balanceOf(staker);
        uint256 v3Earned = v3s.earned(staker);
        uint256 v3Balance0 = ILiveV3Exchange(LIVE_V3_EXCHANGE).balanceOf(staker);

        // The move: claim and unstake on v3, approve and stake on v4.
        vm.startPrank(staker);
        assertEq(v3s.claim(), v3Earned);
        v3s.unstake(stake);
        fetti.approve(address(d.staking), stake);
        d.staking.stake(stake);
        vm.stopPrank();
        assertEq(ILiveV3Exchange(LIVE_V3_EXCHANGE).balanceOf(staker), v3Balance0 + v3Earned, "v3 claim");
        assertEq(v3s.stakedOf(staker), 0);
        assertEq(v3s.totalStaked() + v3s.totalWarming(), v3Total0 - stake);
        assertEq(d.staking.stakedOf(staker), stake);
        assertEq(fetti.balanceOf(address(d.staking)), stake);
        assertEq(fetti.balanceOf(staker), wallet0);

        // v4 fees: a liquidation carves the loss fee; the push pays the stakers' share.
        _depositHouse(HOUSE);
        deal(USDC, trader, 100e6);
        vm.startPrank(trader);
        IERC20(USDC).approve(address(ex), 100e6);
        ex.deposit(100e6);
        vm.stopPrank();
        _pushedBookCannotLiquidate();
        uint256 pool = ex.feePool();
        assertGt(pool, 0);
        (uint256 toStakers,) = ex.pushFees();
        assertEq(toStakers, pool * DEFAULT_STAKER_FEE_SHARE_BPS / 10_000);

        // After the warm-up the stake is active and the whole share is the staker's (the only
        // v4 staker), at most one unit of accumulator dust short; the claim pays the wallet.
        vm.warp(vm.getBlockTimestamp() + d.staking.minStakeDuration());
        uint256 owed = d.staking.earned(staker);
        assertApproxEqAbs(owed, toStakers, 1);
        uint256 usdc0 = IERC20(USDC).balanceOf(staker);
        vm.prank(staker);
        assertEq(d.staking.claim(), owed);
        assertEq(IERC20(USDC).balanceOf(staker), usdc0 + owed);
        assertEq(d.staking.activeStakeOf(staker), stake);

        // Unstake on v4 returns the same FETTI; nothing in v4 minted or burned any.
        vm.prank(staker);
        d.staking.unstake(stake);
        assertEq(fetti.balanceOf(staker), wallet0 + stake);
        assertEq(fetti.totalSupply(), supply0, "FETTI supply moved");
    }

    /// @dev The owner's launch steps after the deploy: unpause markets.
    function _launch(Deployment memory dep) internal {
        IExchange e = IExchange(address(dep.exchange));
        for (uint32 i = 0; i < e.instrumentCount(); i++) {
            e.setMarketOpensPaused(i, false);
        }
    }

    function _depositHouse(uint256 amount) internal {
        deal(USDC, address(this), amount);
        IERC20(USDC).approve(address(ex), amount);
        ex.depositHouse(amount);
    }

    /// @dev The fork deployment: a fresh PrecompilePriceSource and launch prices read from
    ///      HyperCore (a test that reuses the live source sets `priceSource` itself).
    function _cfg() internal returns (Config memory cfg) {
        cfg.usdc = USDC;
        cfg.owner = address(this);
        cfg.guardian = makeAddr("guardian");
        cfg.marketKeeper = makeAddr("marketKeeper");
        cfg.keeper = keeper;
        cfg.feeRecipient = feeRecipient;
        cfg.priceSource = address(0); // deploy the real PrecompilePriceSource
        cfg.launchPrices18 = new uint256[](0); // read them from HyperCore
        cfg.stakerFeeShareBps = DEFAULT_STAKER_FEE_SHARE_BPS;
        cfg.stakingWarmupS = DEFAULT_STAKING_WARMUP_S;
        cfg.winFeeBps = DEFAULT_WIN_FEE_BPS;
        cfg.lossFeeBps = DEFAULT_LOSS_FEE_BPS;
        cfg.rhoBps = DEFAULT_RHO_BPS;
        cfg.maxWinBps = DEFAULT_MAX_WIN_BPS;
        cfg.fetti = vm.envOr("FETTI", LIVE_FETTI);
        cfg.v3Referrals = vm.envOr("V3_REFERRALS", LIVE_V3_REFERRALS);
    }

    /// @dev Re-pin the DOGE BBO precompile at `pct`% of its live bid and ask (100 restores it).
    function _mockDogeBbo(uint256 pct) internal {
        vm.mockCall(
            BBO_PRECOMPILE,
            abi.encode(DOGE_ASSET),
            abi.encode(uint64(uint256(liveDogeBid) * pct / 100), uint64(uint256(liveDogeAsk) * pct / 100))
        );
    }

    // ------------------------------------------------------------- helpers

    /// @dev The oracle's clamped `price` (the display price) still holds its band.
    function _assertClampHolds(uint32 id) internal view {
        (,, uint16 clamp) = d.oracle.instrumentConfig(id);
        assertEq(clamp, LaunchMarkets.clampBps(ex.instrument(id).tier));
        uint256 ref = d.oracle.oraclePrice(id);
        uint256 mid = d.oracle.rawMid(id);
        uint256 px = d.oracle.price(id);
        uint256 lo = ref * (10_000 - clamp) / 10_000;
        uint256 hi = ref * (10_000 + clamp) / 10_000;
        assertGe(px, lo, "price under the clamp floor");
        assertLe(px, hi, "price over the clamp ceiling");
        if (mid >= lo && mid <= hi) assertEq(px, mid, "in-band mid was altered");
        else assertTrue(px == lo || px == hi, "out-of-band mid not pinned to the edge");
    }

    /// @dev Create the fork from FORK_URL, falling back to the second RPC. Each URL gets a few
    ///      attempts because the public endpoints are load balanced and a lagging node can
    ///      refuse the latest block.
    function _selectFork(string memory url) internal {
        if (_tryFork(url)) return;
        if (_tryFork(FALLBACK_RPC)) return;
        revert("ForkTest: no RPC reachable");
    }

    function _tryFork(string memory url) internal returns (bool) {
        for (uint256 attempt = 0; attempt < 3; attempt++) {
            try vm.createSelectFork(url) returns (uint256) {
                return true;
            } catch {}
        }
        return false;
    }

    /// @dev Pin the BBO, oracle and mark precompiles for every launch market to their live values.
    function _pinPrecompiles() internal {
        LaunchMarkets.Market[] memory ms = LaunchMarkets.all();
        for (uint256 i = 0; i < ms.length; i++) {
            bytes memory input = abi.encode(ms[i].hlAssetIndex);
            vm.mockCall(BBO_PRECOMPILE, input, _ethCall(BBO_PRECOMPILE, input));
            vm.mockCall(ORACLE_PRECOMPILE, input, _ethCall(ORACLE_PRECOMPILE, input));
            vm.mockCall(MARK_PRECOMPILE, input, _ethCall(MARK_PRECOMPILE, input));
        }
    }

    /// @dev `eth_call` against the fork's RPC. vm.rpc decodes the hex result into raw bytes,
    ///      exactly what the precompile would have returned.
    function _ethCall(address to, bytes memory data) internal returns (bytes memory) {
        string memory params =
            string.concat('[{"to":"', vm.toString(to), '","data":"', vm.toString(data), '"},"latest"]');
        return vm.rpc("eth_call", params);
    }
}
