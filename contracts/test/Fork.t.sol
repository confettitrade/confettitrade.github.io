// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ConfettiDeployer, LaunchMarkets} from "../script/Deploy.s.sol";
import {PrecompilePriceSource} from "../src/PrecompilePriceSource.sol";
import {ImpactLib} from "../src/lib/ImpactLib.sol";
import {IExchange} from "../src/interfaces/IExchange.sol";

/// @dev Probe: in isolated mode a top-level create is its own transaction and gets at most the
///      block gas limit, so on a HyperEVM small block this records about 3M instead of ~1e9.
contract GasProbe {
    uint256 public immutable gasAtCreation;

    constructor() {
        gasAtCreation = gasleft();
    }
}

/// @title ForkTest
/// @notice HyperEVM mainnet fork: deploys the whole system with the real PrecompilePriceSource,
///         checks the launch table against HyperCore's own asset registry, reads DOGE and
///         FARTCOIN, checks that settlement reads the oracle price on the live quotes, and
///         trades a tiny position through the request / execute path with deal()'d USDC.
/// @dev Forge executes the EVM locally and the HyperCore precompiles have no bytecode, so a
///      forked staticcall to them would return nothing. The fixture therefore fetches each
///      precompile's real return data with `eth_call` through `vm.rpc` and pins it with
///      `vm.mockCall`; the production ABI decoding and scaling then run unchanged against
///      live mainnet values.
///      Skipped unless FORK=true:
///        FORK=true forge test --match-contract ForkTest --no-isolate -vv
///      Uses FORK_URL, else the public RPC, else the fallback RPC; an existing --fork-url is
///      reused as is. `--no-isolate` (or `--disable-block-gas-limit`) is needed because the
///      forked HyperEVM small block reports a 3M gas limit, isolated calls are capped at it,
///      and the Exchange deployment alone needs more; the fixture detects that and says so.
contract ForkTest is Test, ConfettiDeployer {
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant BBO_PRECOMPILE = 0x000000000000000000000000000000000000080e;
    address constant ORACLE_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    address constant MARK_PRECOMPILE = 0x0000000000000000000000000000000000000806;
    address constant PERP_ASSET_INFO_PRECOMPILE = 0x000000000000000000000000000000000000080a;
    string constant PRIMARY_RPC = "https://rpc.hyperliquid.xyz/evm";
    string constant FALLBACK_RPC = "https://rpc.purroofgroup.com";
    uint32 constant DOGE = 0;
    uint32 constant FARTCOIN = 1;
    uint32 constant DOGE_ASSET = 12;

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
    address trader = makeAddr("trader");
    address keeper = makeAddr("keeper");
    address stranger = makeAddr("stranger");
    address feeRecipient = makeAddr("feeRecipient");
    /// @dev The live DOGE BBO as pinned in setUp, so a test can push the book and restore it.
    uint64 liveDogeBid;
    uint64 liveDogeAsk;

    function setUp() public {
        if (!vm.envOr("FORK", false)) return;
        _selectFork();
        assertEq(block.chainid, 999, "not HyperEVM");
        require(
            new GasProbe().gasAtCreation() > 5_000_000,
            "ForkTest: creates are capped at the forked block's 3M gas limit; rerun with --no-isolate"
        );
        _pinPrecompiles();

        Config memory cfg;
        cfg.usdc = USDC;
        cfg.owner = address(this);
        cfg.guardian = makeAddr("guardian");
        cfg.keeper = keeper;
        cfg.feeRecipient = feeRecipient;
        cfg.priceSource = address(0); // deploy the real PrecompilePriceSource
        cfg.launchPrices18 = new uint256[](0); // read them from HyperCore
        cfg.flatThresholdUsd = DEFAULT_FLAT_THRESHOLD_USD;
        cfg.tailDecayScaleUsd = DEFAULT_TAIL_DECAY_SCALE_USD;
        cfg.stakerCapUsd = DEFAULT_STAKER_CAP_USD;
        cfg.flatRateE18 = DEFAULT_FLAT_RATE_E18;
        d = _deploy(cfg, address(this));
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
        assertEq(d.exchange.instrumentCount(), uint32(ms.length));
        assertEq(d.launchPrices18.length, ms.length);
        assertTrue(d.exchange.isKeeper(keeper));
        assertEq(d.referrals.exchange(), address(d.exchange));
        for (uint256 i = 0; i < ms.length; i++) {
            uint32 id = uint32(i);
            PerpAssetInfo memory info =
                abi.decode(_ethCall(PERP_ASSET_INFO_PRECOMPILE, abi.encode(ms[i].hlAssetIndex)), (PerpAssetInfo));
            assertEq(info.coin, ms[i].name, "asset index points at another coin");
            assertEq(info.szDecimals, ms[i].szDecimals, ms[i].name);

            IExchange.Instrument memory inst = d.exchange.instrument(id);
            assertEq(inst.hlAssetIndex, ms[i].hlAssetIndex);
            assertEq(inst.szDecimals, ms[i].szDecimals);
            assertEq(inst.maxLeverage, ms[i].maxLeverage, ms[i].name);
            assertEq(inst.maxLeverage, ms[i].tier == 0 ? 1000 : 250);

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
        emit log_named_decimal_uint("DOGE", doge, 18);
        emit log_named_decimal_uint("FARTCOIN", fartcoin, 18);
    }

    function test_fork_execPriceIsTheOracleOnLiveQuotes() public onlyFork {
        LaunchMarkets.Market[] memory ms = LaunchMarkets.all();
        for (uint256 i = 0; i < ms.length; i++) {
            uint32 id = uint32(i);
            uint256 ref = d.oracle.oraclePrice(id);
            // Every side and direction settles on the oracle print, never on the book.
            assertEq(d.exchange.execPrice(id, true, true), ref, ms[i].name);
            assertEq(d.exchange.execPrice(id, false, true), ref, ms[i].name);
            assertEq(d.exchange.execPrice(id, true, false), ref, ms[i].name);
            assertEq(d.exchange.execPrice(id, false, false), ref, ms[i].name);
            emit log_named_decimal_uint(string.concat(ms[i].name, " mid"), d.oracle.rawMid(id), 18);
            emit log_named_decimal_uint(string.concat(ms[i].name, " oracle"), ref, 18);
        }
        // The launch books sit a few bps under the oracle (the measured basis): with a live gap
        // the settlement price is still the oracle, not the clamped mid.
        if (d.oracle.rawMid(DOGE) != d.oracle.oraclePrice(DOGE)) {
            assertTrue(d.exchange.execPrice(DOGE, true, true) != d.oracle.rawMid(DOGE), "settled on the mid");
        }
    }

    function test_fork_requestExecuteRoundTrip_withRealUsdc() public onlyFork {
        deal(USDC, trader, 100e6);
        assertEq(IERC20(USDC).balanceOf(trader), 100e6);
        vm.startPrank(trader);
        IERC20(USDC).approve(address(d.exchange), 100e6);
        d.exchange.deposit(100e6);
        vm.stopPrank();
        assertEq(d.exchange.balanceOf(trader), 100e6);

        _keeperFillsThenFallbackCloseIsFlat();
        _pushedBookPaysNothing();
        uint256 bounty = _pushedBookCannotLiquidate();

        // Only the liquidation minted: on its whole $10 margin, 100 CONFETTI per $1, plus the
        // 10% team share.
        assertEq(d.confetti.balanceOf(trader), 1_000e18);
        assertEq(d.confetti.balanceOf(feeRecipient), 100e18);
        assertEq(d.tokenomics.totalMinted(), 1_000e18);
        // Liquidation: 10 - 0.05 bounty - 0.5 fee = 9.45 to the LP net.
        assertEq(d.tokenomics.trackedLpUsd(), 9_450_000);

        // The cash model holds on the real token and the trader can leave.
        assertEq(IERC20(USDC).balanceOf(address(d.exchange)), 100e6);
        assertEq(d.exchange.pendingOf(trader), 0);
        uint256 traderLeft = d.exchange.balanceOf(trader);
        assertEq(traderLeft + d.exchange.lpBalance() + bounty, 100e6);
        vm.prank(trader);
        d.exchange.withdraw(traderLeft);
        assertEq(IERC20(USDC).balanceOf(trader), traderLeft);
        assertEq(IERC20(USDC).balanceOf(address(d.exchange)), 100e6 - traderLeft);
    }

    /// @dev A 10x long requested at the live oracle print, filled by the keeper 5 s later at
    ///      the (pinned, so unchanged) oracle print, then closed by a stranger in the fallback
    ///      window at the worse of the two identical prints: flat, margin back, no fee.
    function _keeperFillsThenFallbackCloseIsFlat() internal {
        uint256 ref = d.oracle.oraclePrice(DOGE);
        vm.prank(trader);
        uint256 req = d.exchange.requestOpen(DOGE, true, 10e6, 10, address(0));
        assertEq(d.exchange.openRequest(req).px0, ref);
        assertEq(d.exchange.balanceOf(trader), 90e6);
        assertEq(d.exchange.pendingOf(trader), 10e6);
        assertEq(d.exchange.marginInUse(trader), 0);
        // Nobody before 5 s, only the keeper at 5 s.
        vm.warp(vm.getBlockTimestamp() + 4);
        vm.prank(keeper);
        vm.expectRevert(IExchange.TooEarly.selector);
        d.exchange.executeOpen(req);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(stranger);
        vm.expectRevert(IExchange.KeeperWindow.selector);
        d.exchange.executeOpen(req);
        vm.prank(keeper);
        uint256 id = d.exchange.executeOpen(req);
        assertGt(id, 0);
        assertEq(d.exchange.positions(id).entryPx18, ref);
        assertEq(d.exchange.pendingOf(trader), 0);
        assertEq(d.exchange.marginInUse(trader), 10e6);

        vm.prank(trader);
        d.exchange.requestClose(id);
        vm.warp(vm.getBlockTimestamp() + 8); // past the keeper window: anyone fills
        (int256 pnl, uint256 fee, uint256 payout) = d.exchange.previewClose(id);
        assertEq(pnl, 0);
        assertEq(fee, 0);
        assertEq(payout, 10e6);
        vm.prank(stranger);
        (uint256 paid, uint256 queued) = d.exchange.executeClose(id);
        assertEq(paid, 10e6);
        assertEq(queued, 0);
        assertEq(d.exchange.balanceOf(trader), 100e6);
    }

    /// @dev The Paper vector in the long's favour: the BBO pushed 5% over the oracle price. The
    ///      close settles on the oracle, nothing for the push: flat. Mark is left where it was:
    ///      it plays no part.
    function _pushedBookPaysNothing() internal {
        uint256 ref = d.oracle.oraclePrice(DOGE);
        vm.prank(trader);
        uint256 req = d.exchange.requestOpen(DOGE, true, 10e6, 10, address(0));
        vm.warp(vm.getBlockTimestamp() + 5);
        vm.prank(keeper);
        uint256 id = d.exchange.executeOpen(req);
        _mockDogeBbo(105);
        assertGt(d.oracle.rawMid(DOGE), ref);
        assertEq(d.exchange.execPrice(DOGE, true, false), ref);
        _assertClampHolds(DOGE);
        (int256 pnl,, uint256 payout) = d.exchange.previewClose(id);
        assertEq(pnl, 0);
        assertEq(payout, 10e6);
        vm.prank(trader);
        d.exchange.requestClose(id);
        vm.warp(vm.getBlockTimestamp() + 5);
        vm.prank(keeper);
        (uint256 paid,) = d.exchange.executeClose(id);
        assertEq(paid, 10e6);
        _mockDogeBbo(100);
    }

    /// @dev A pushed book cannot liquidate. 50x long, bust 190 bps under entry: the BBO 3%
    ///      under the oracle changes nothing, the settlement price is the oracle at entry. The
    ///      oracle itself 3% down busts it, pending close or not. Returns the bounty, credited
    ///      to this contract.
    function _pushedBookCannotLiquidate() internal returns (uint256 bounty) {
        uint256 ref = d.oracle.oraclePrice(DOGE);
        vm.prank(trader);
        uint256 req = d.exchange.requestOpen(DOGE, true, 10e6, 50, address(0));
        vm.warp(vm.getBlockTimestamp() + 5);
        vm.prank(keeper);
        uint256 id = d.exchange.executeOpen(req);
        uint256 bust = d.exchange.bustPrice(id);
        _mockDogeBbo(97);
        assertLt(d.oracle.rawMid(DOGE), bust);
        assertEq(d.exchange.execPrice(DOGE, true, true), ref);
        assertGt(ref, bust);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotLiquidatable.selector, id, ref, bust));
        d.exchange.liquidate(id);
        // A close requested now does not stand in the way of the liquidation that follows.
        vm.prank(trader);
        d.exchange.requestClose(id);
        uint64 oraclePx = PrecompilePriceSource(address(d.source)).oraclePx(DOGE_ASSET);
        vm.mockCall(ORACLE_PRECOMPILE, abi.encode(DOGE_ASSET), abi.encode(uint64(uint256(oraclePx) * 97 / 100)));
        assertLe(d.exchange.execPrice(DOGE, true, true), bust);
        bounty = d.exchange.liquidate(id);
        assertEq(bounty, 50_000); // 0.5% of the $10 margin
        assertEq(d.exchange.balanceOf(address(this)), bounty);
        assertEq(d.exchange.closeRequest(id).requestedAt, 0);
        vm.warp(vm.getBlockTimestamp() + 5);
        vm.prank(keeper);
        vm.expectRevert(IExchange.UnknownRequest.selector);
        d.exchange.executeClose(id);
        _mockDogeBbo(100);
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
        assertEq(clamp, LaunchMarkets.clampBps(d.exchange.instrument(id).tier));
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

    /// @dev Reuse an existing fork (--fork-url), else create one from FORK_URL / the public
    ///      RPC, falling back to the second RPC. Each URL gets a few attempts because the public
    ///      endpoints are load balanced and a lagging node can refuse the latest block.
    function _selectFork() internal {
        try vm.activeFork() returns (uint256) {
            return;
        } catch {}
        if (_tryFork(vm.envOr("FORK_URL", PRIMARY_RPC))) return;
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
