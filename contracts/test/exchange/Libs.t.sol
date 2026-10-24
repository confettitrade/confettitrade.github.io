// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PriceOracle} from "../../src/PriceOracle.sol";
import {PrecompilePriceSource} from "../../src/PrecompilePriceSource.sol";
import {ImpactLib} from "../../src/lib/ImpactLib.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {MockPriceSource} from "../mocks/MockPriceSource.sol";

/*//////////////////////////////////////////////////////////////////////////
                                 ImpactLib
//////////////////////////////////////////////////////////////////////////*/

contract ImpactLibTest is Test {
    uint256 constant ONE = 1e18;

    function _launchCurve() internal pure returns (ImpactLib.Curve memory) {
        return ImpactLib.Curve({
            baseRateBps: 1000,
            rateMultiplier: 15_000,
            referenceNotionalUsd: 20_000e6,
            positionMultiplierE6: 130_000_000e6
        });
    }

    function test_impactScale_onePercentMove_keepsAbout88Percent() public pure {
        // 0.9 / (1 + 1/(0.01*15000) + 20000/(0.01*130e6)) = 0.9 / 1.022051 = 0.88058
        uint256 scale = ImpactLib.impactScaleE18(ONE / 100, _launchCurve());
        assertEq(scale, 880582037129954841);
        assertGt(scale, 0.875e18);
        assertLt(scale, 0.885e18);
    }

    function test_impactScale_tenthPercentMove_keepsAbout74Percent() public pure {
        // 0.9 / (1 + 1/15 + 20000/130000) = 0.9 / 1.220513 = 0.73739
        uint256 scale = ImpactLib.impactScaleE18(ONE / 1000, _launchCurve());
        assertEq(scale, 737394957983193276);
        assertGt(scale, 0.73e18);
        assertLt(scale, 0.745e18);
    }

    function test_impactScale_zeroMoveIsZero_andLargeMoveApproachesBase() public pure {
        assertEq(ImpactLib.impactScaleE18(0, _launchCurve()), 0);
        // A 100% move: both denominator terms are tiny, scale -> 1 - baseRate.
        uint256 scale = ImpactLib.impactScaleE18(ONE, _launchCurve());
        assertGt(scale, 0.899e18);
        assertLt(scale, 0.9e18);
    }

    function test_deadbandExit_roundsAgainstTrader() public pure {
        // 1.01 * 0.9999 for a long; 0.99 * 1.0001 for a short.
        assertEq(ImpactLib.deadbandExit(1.01e18, true, 1), 1009899000000000000);
        assertEq(ImpactLib.deadbandExit(0.99e18, false, 1), 990099000000000000);
        // Rounding: long floors, short ceils (price 1 wei: 1 * 9999 / 10000 -> 0, 1 * 10001 / 10000 -> 2).
        assertEq(ImpactLib.deadbandExit(1, true, 1), 0);
        assertEq(ImpactLib.deadbandExit(1, false, 1), 2);
        assertEq(ImpactLib.deadbandExit(3, false, 1), 4); // 3.0003 -> 4
    }

    function test_rawGain_andCappedLoss() public pure {
        (uint256 gain, uint256 move) = ImpactLib.rawGain(1000e6, ONE, 1.009899e18, true);
        assertEq(gain, 9_899_000);
        assertEq(move, 9899000000000000);
        (gain, move) = ImpactLib.rawGain(1000e6, ONE, ONE, true);
        assertEq(gain, 0);
        assertEq(move, 0);
        (gain,) = ImpactLib.rawGain(1000e6, ONE, 0.99e18, true); // wrong side for a long
        assertEq(gain, 0);

        assertEq(ImpactLib.cappedLoss(1000e6, 100e6, ONE, 0.995e18, true), 5_000_000);
        assertEq(ImpactLib.cappedLoss(1000e6, 100e6, ONE, 0.8e18, true), 100e6); // capped
        assertEq(ImpactLib.cappedLoss(1000e6, 100e6, ONE, 1.005e18, false), 5_000_000);
        assertEq(ImpactLib.cappedLoss(1000e6, 100e6, ONE, 1.1e18, true), 0); // wrong side
        // Loss rounds up: 7 * 1 / 3 = 2.33 -> 3.
        assertEq(ImpactLib.cappedLoss(7, 100, 3, 2, true), 3);
    }

    function test_bustPrice_longAndShort() public pure {
        assertEq(ImpactLib.bustPrice(ONE, true, 10), 0.905e18);
        assertEq(ImpactLib.bustPrice(ONE, false, 10), 1.095e18);
        // The 5 bps gap binds above 100x: 1000x busts at 5 bps (0.95 / 1000 would be 9.5),
        // 500x at 15 (not 19), 250x at 35 (not 38); at 100x both rules give 95 bps.
        assertEq(ImpactLib.bustPrice(ONE, true, 1000), 0.9995e18);
        assertEq(ImpactLib.bustPrice(ONE, false, 1000), 1.0005e18);
        assertEq(ImpactLib.bustPrice(ONE, true, 500), 0.9985e18);
        assertEq(ImpactLib.bustPrice(ONE, false, 500), 1.0015e18);
        assertEq(ImpactLib.bustPrice(ONE, true, 250), 0.9965e18);
        assertEq(ImpactLib.bustPrice(ONE, false, 250), 1.0035e18);
        assertEq(ImpactLib.bustPrice(ONE, true, 100), 0.9905e18);
        assertEq(ImpactLib.bustPrice(ONE, false, 100), 1.0095e18);
        // 7x: long ceils (0.864285714285714285... -> ...286), short floors (1.135714285714285714...).
        assertEq(ImpactLib.bustPrice(ONE, true, 7), 864285714285714286);
        assertEq(ImpactLib.bustPrice(ONE, false, 7), 1135714285714285714);
        assertTrue(ImpactLib.isBusted(0.905e18, 0.905e18, true));
        assertFalse(ImpactLib.isBusted(0.905e18 + 1, 0.905e18, true));
        assertTrue(ImpactLib.isBusted(1.095e18, 1.095e18, false));
        assertFalse(ImpactLib.isBusted(1.095e18 - 1, 1.095e18, false));
    }

    function test_feesAndSplits() public pure {
        // v4 ceilings: 10% on a win, 5% on a loss or a liquidated margin, 5 bps/h borrow.
        assertEq(ImpactLib.MAX_WIN_FEE_BPS, 1000);
        assertEq(ImpactLib.MAX_LOSS_FEE_BPS, 500);
        assertEq(ImpactLib.MAX_BORROW_RATE_X10, 50);
        // The v4 default win fee: 7.5% x 8.714963 = 0.65362222 -> 0.653622.
        assertEq(ImpactLib.winFee(8_714_963, 750), 653_622);
        // fee = 5% x 8.714963 = 0.43574815 -> 0.435748 (rounded down).
        assertEq(ImpactLib.winFee(8_714_963, 500), 435_748);
        // The rate is a parameter: 2% x 8.714963 = 0.17429926 -> 0.174299; 0 takes nothing.
        assertEq(ImpactLib.winFee(8_714_963, 200), 174_299);
        assertEq(ImpactLib.winFee(8_714_963, 0), 0);
        // 5% x 0.000019 = 0.00000095 -> 0: dust rounds to the trader.
        assertEq(ImpactLib.winFee(19, 500), 0);
        // fee = 5% x 5.000000 = 0.250000; the LP keeps 4.750000.
        (uint256 fee, uint256 lp) = ImpactLib.splitLoss(5_000_000, 500);
        assertEq(fee, 250_000);
        assertEq(lp, 4_750_000);
        // Rate 0 (the queue is active): no fee, the LP keeps the whole loss.
        (fee, lp) = ImpactLib.splitLoss(5_000_000, 0);
        assertEq(fee, 0);
        assertEq(lp, 5_000_000);
        // bounty = 0.5% x 100 = 0.5; fee = 5% x 100 = 5; LP = 100 - 0.5 - 5 = 94.5.
        (uint256 bounty, uint256 lfee, uint256 toLp) = ImpactLib.splitLiquidation(100e6, 500);
        assertEq(bounty, 500_000);
        assertEq(lfee, 5_000_000);
        assertEq(toLp, 94_500_000);
        (bounty, lfee, toLp) = ImpactLib.splitLiquidation(100e6, 0);
        assertEq(bounty, 500_000);
        assertEq(lfee, 0);
        assertEq(toLp, 99_500_000);
    }

    /// @dev The entry spread moves the fill against the trader (long up, rounded up; short
    ///      down, rounded down) and `rawEntry` undoes it, rounding toward the bust side.
    function test_spreadEntry_rawEntry_roundTrip_andRounding() public pure {
        assertEq(ImpactLib.spreadEntry(ONE, true, 10), 1.001e18);
        assertEq(ImpactLib.spreadEntry(ONE, false, 10), 0.999e18);
        assertEq(ImpactLib.spreadEntry(ONE, true, 0), ONE);
        assertEq(ImpactLib.spreadEntry(ONE, false, 0), ONE);
        // 3 x 1.0001 = 3.0003 -> 4 for a long; 3 x 0.9999 = 2.9997 -> 2 for a short.
        assertEq(ImpactLib.spreadEntry(3, true, 1), 4);
        assertEq(ImpactLib.spreadEntry(3, false, 1), 2);

        assertEq(ImpactLib.rawEntry(1.001e18, true, 10), ONE);
        assertEq(ImpactLib.rawEntry(0.999e18, false, 10), ONE);
        assertEq(ImpactLib.rawEntry(123, true, 0), 123);
        assertEq(ImpactLib.rawEntry(123, false, 0), 123);
        // 4 / 1.0001 = 3.9996 -> 3 (a long's raw print down); 2 / 0.9999 = 2.0002 -> 3 (up).
        assertEq(ImpactLib.rawEntry(4, true, 1), 3);
        assertEq(ImpactLib.rawEntry(2, false, 1), 3);

        // The spread never moves the bust: at the 50 bps ceiling the raw print comes back
        // exactly and a 10x long still busts at 0.905, a short at 1.095.
        uint256 longEntry = ImpactLib.spreadEntry(ONE, true, 50);
        uint256 shortEntry = ImpactLib.spreadEntry(ONE, false, 50);
        assertEq(longEntry, 1.005e18);
        assertEq(shortEntry, 0.995e18);
        assertEq(ImpactLib.bustPrice(ImpactLib.rawEntry(longEntry, true, 50), true, 10), 0.905e18);
        assertEq(ImpactLib.bustPrice(ImpactLib.rawEntry(shortEntry, false, 50), false, 10), 1.095e18);
    }

    /// @dev Borrow: `rateX10` tenths of a bps of notional per WHOLE hour held beyond the free
    ///      hours; the free hours and any part hour cost nothing.
    function test_borrowFee_wholeHoursBeyondFree() public pure {
        // $1000 notional at 0.5 bps/h = 0.05 per hour.
        assertEq(ImpactLib.borrowFee(1000e6, 5, 0, 1), 0);
        assertEq(ImpactLib.borrowFee(1000e6, 5, 1 hours, 1), 0); // the free hour
        assertEq(ImpactLib.borrowFee(1000e6, 5, 2 hours - 1, 1), 0); // first part hour beyond
        assertEq(ImpactLib.borrowFee(1000e6, 5, 2 hours, 1), 50_000);
        assertEq(ImpactLib.borrowFee(1000e6, 5, 3 hours - 1, 1), 50_000);
        assertEq(ImpactLib.borrowFee(1000e6, 5, 3 hours, 1), 100_000);
        // No free hours: the first whole hour is charged.
        assertEq(ImpactLib.borrowFee(1000e6, 5, 1 hours - 1, 0), 0);
        assertEq(ImpactLib.borrowFee(1000e6, 5, 1 hours, 0), 50_000);
        // 24 free hours (the ceiling): nothing until hour 25.
        assertEq(ImpactLib.borrowFee(1000e6, 5, 25 hours - 1, 24), 0);
        assertEq(ImpactLib.borrowFee(1000e6, 5, 25 hours, 24), 50_000);
        // Rate 0 never charges; the 5 bps/h ceiling is 0.5 per hour on $1000.
        assertEq(ImpactLib.borrowFee(1000e6, 0, 1000 hours, 0), 0);
        assertEq(ImpactLib.borrowFee(1000e6, 50, 1 hours, 0), 500_000);
        // Rounds down: $1 at 0.1 bps/h for one hour = 0.00001 = 10 units; $0.01 -> 0.1 -> 0.
        assertEq(ImpactLib.borrowFee(1e6, 1, 1 hours, 0), 10);
        assertEq(ImpactLib.borrowFee(1e4, 1, 1 hours, 0), 0);
    }
}

/*//////////////////////////////////////////////////////////////////////////
                                PriceOracle
//////////////////////////////////////////////////////////////////////////*/

contract PriceOracleTest is Test {
    MockPriceSource source;
    PriceOracle oracle;
    address registrar = makeAddr("registrar");
    address stranger = makeAddr("stranger");

    uint32 constant DOGE = 0; // instrument id
    uint32 constant BTC = 1;

    function setUp() public {
        source = new MockPriceSource();
        oracle = new PriceOracle(source, address(this));
        oracle.setRegistrar(registrar);
        oracle.setInstrument(DOGE, 12, 0, 10);
        oracle.setInstrument(BTC, 0, 5, 10);
    }

    function test_constructor_rejectsZeroSourceAndZeroOwner() public {
        vm.expectRevert(IPriceOracle.ZeroAddress.selector);
        new PriceOracle(MockPriceSource(address(0)), address(this));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PriceOracle(source, address(0));
        assertEq(oracle.owner(), address(this));
    }

    function test_midScaling_matchesMainnetSamples() public {
        // DESIGN section 3: DOGE (szDecimals 0) 85187/85191 -> $0.085189, oracle 85195, mark
        // 85178; BTC (szDecimals 5) 827660/827670 -> $82,766.5.
        source.setQuote(12, 85187, 85191, 85178, 85195);
        source.setQuote(0, 827660, 827670, 827665);
        assertEq(oracle.rawMid(DOGE), 85189000000000000);
        assertEq(oracle.oraclePrice(DOGE), 85195000000000000);
        assertEq(oracle.markPrice(DOGE), 85178000000000000);
        assertEq(oracle.price(DOGE), 85189000000000000);
        assertEq(oracle.rawMid(BTC), 82766500000000000000000);
        assertEq(oracle.oraclePrice(BTC), 82766500000000000000000);
        assertEq(oracle.price(BTC), 82766500000000000000000);
    }

    function test_price_clampsAboveAndBelowOracle() public {
        // BBO 2% above the oracle price with a 10 bps clamp -> oracle * 1.001.
        source.setQuote(12, 1_020_000, 1_020_000, 1_000_000);
        assertEq(oracle.rawMid(DOGE), 1.02e18);
        assertEq(oracle.price(DOGE), 1.001e18);
        // BBO 2% below -> oracle * 0.999.
        source.setQuote(12, 980_000, 980_000, 1_000_000);
        assertEq(oracle.price(DOGE), 0.999e18);
        // Inside the band the mid passes through unchanged.
        source.setQuote(12, 1_000_400, 1_000_600, 1_000_000);
        assertEq(oracle.price(DOGE), 1.0005e18);
        // Exactly on the edge is not clamped.
        source.setQuote(12, 1_001_000, 1_001_000, 1_000_000);
        assertEq(oracle.price(DOGE), 1.001e18);
    }

    function test_price_clampFollowsOracleNotMark() public {
        // DESIGN section 3: a push on Hyperliquid's own book drags mark along with it (mark is
        // partly book-derived); the oracle price, a validator median of external venues, does
        // not move. The band must follow the oracle price, so the push pays at most 10 bps.
        source.setQuote(12, 1_100_000, 1_100_000, 1_100_000, 1_000_000);
        assertEq(oracle.rawMid(DOGE), 1.1e18);
        assertEq(oracle.markPrice(DOGE), 1.1e18);
        assertEq(oracle.oraclePrice(DOGE), 1e18);
        assertEq(oracle.price(DOGE), 1.001e18);
        // The other way round: the external price moves and mark lags; the band moves with it.
        source.setQuote(12, 1_100_000, 1_100_000, 1_000_000, 1_100_000);
        assertEq(oracle.price(DOGE), 1.1e18);
        // A dead or zero mark feed never touches execution; it only breaks the mark view.
        source.setMarkReverts(true);
        assertEq(oracle.price(DOGE), 1.1e18);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, DOGE));
        oracle.markPrice(DOGE);
        source.setMarkReverts(false);
        source.setMark(12, 0);
        assertEq(oracle.price(DOGE), 1.1e18);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, DOGE));
        oracle.markPrice(DOGE);
        // A dead oracle feed does block execution.
        source.setOracleReverts(true);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, DOGE));
        oracle.price(DOGE);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, DOGE));
        oracle.oraclePrice(DOGE);
        assertEq(oracle.rawMid(DOGE), 1.1e18);
    }

    function test_price_revertsWhenFeedDown() public {
        source.setQuote(12, 1_000_000, 1_000_000, 1_000_000);
        source.setReverts(true, false);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, DOGE));
        oracle.price(DOGE);
        source.setReverts(false, true);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, DOGE));
        oracle.price(DOGE);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, DOGE));
        oracle.oraclePrice(DOGE);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, DOGE));
        oracle.markPrice(DOGE);
        source.setReverts(false, false);
        assertEq(oracle.price(DOGE), 1e18);
    }

    function test_price_revertsOnZero() public {
        source.setQuote(12, 0, 1_000_000, 1_000_000);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, DOGE));
        oracle.price(DOGE);
        source.setQuote(12, 1_000_000, 1_000_000, 0);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, DOGE));
        oracle.price(DOGE);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, DOGE));
        oracle.oraclePrice(DOGE);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, DOGE));
        oracle.markPrice(DOGE);
        assertEq(oracle.rawMid(DOGE), 1e18); // the mid alone is fine
    }

    function test_unknownInstrumentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.UnknownInstrument.selector, uint32(7)));
        oracle.price(7);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.UnknownInstrument.selector, uint32(7)));
        oracle.instrumentConfig(7);
    }

    function test_setInstrument_accessAndBounds() public {
        vm.prank(stranger);
        vm.expectRevert(IPriceOracle.Unauthorized.selector);
        oracle.setInstrument(2, 15, 0, 25);

        vm.prank(registrar);
        vm.expectEmit(true, false, false, true);
        emit IPriceOracle.InstrumentSet(2, 15, 0, 25);
        oracle.setInstrument(2, 15, 0, 25);
        (uint32 idx, uint8 sz, uint16 clamp) = oracle.instrumentConfig(2);
        assertEq(idx, 15);
        assertEq(sz, 0);
        assertEq(clamp, 25);

        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ClampOutOfBounds.selector, uint16(4)));
        oracle.setInstrument(2, 15, 0, 4);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ClampOutOfBounds.selector, uint16(101)));
        oracle.setInstrument(2, 15, 0, 101);
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.SzDecimalsOutOfBounds.selector, uint8(7)));
        oracle.setInstrument(2, 15, 7, 10);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oracle.setRegistrar(stranger);
        assertEq(oracle.registrar(), registrar);
        assertEq(oracle.source(), address(source));
    }

    function test_setInstrument_locksAssetAndDecimals_registrarSetOnce() public {
        // DESIGN section 8: the owner cannot change an existing market's asset. Neither the
        // owner nor the registrar can repoint instrument 0 (DOGE) at another index or change
        // its decimals; only the clamp width may move.
        source.setQuote(12, 1_000_000, 1_000_000, 1_000_000);
        source.setQuote(174, 2_000_000, 2_000_000, 2_000_000);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.AssetMappingLocked.selector, DOGE));
        oracle.setInstrument(DOGE, 174, 0, 10);
        vm.prank(registrar);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.AssetMappingLocked.selector, DOGE));
        oracle.setInstrument(DOGE, 174, 0, 10);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.AssetMappingLocked.selector, DOGE));
        oracle.setInstrument(DOGE, 12, 3, 10);
        assertEq(oracle.price(DOGE), 1e18);

        vm.prank(registrar);
        vm.expectEmit(true, false, false, true);
        emit IPriceOracle.InstrumentSet(DOGE, 12, 0, 50);
        oracle.setInstrument(DOGE, 12, 0, 50);
        (uint32 idx, uint8 sz, uint16 clamp) = oracle.instrumentConfig(DOGE);
        assertEq(idx, 12);
        assertEq(sz, 0);
        assertEq(clamp, 50);

        // The registrar (the immutable Exchange) is wired once.
        vm.expectRevert(IPriceOracle.RegistrarAlreadySet.selector);
        oracle.setRegistrar(stranger);
        assertEq(oracle.registrar(), registrar);
        PriceOracle fresh = new PriceOracle(source, address(this));
        vm.expectRevert(IPriceOracle.ZeroAddress.selector);
        fresh.setRegistrar(address(0));
        fresh.setRegistrar(registrar);
        assertEq(fresh.registrar(), registrar);
    }
}

/*//////////////////////////////////////////////////////////////////////////
                          PrecompilePriceSource
//////////////////////////////////////////////////////////////////////////*/

contract PrecompilePriceSourceTest is Test {
    PrecompilePriceSource src;
    address constant BBO = 0x000000000000000000000000000000000000080e;
    address constant ORACLE = 0x0000000000000000000000000000000000000807;
    address constant MARK = 0x0000000000000000000000000000000000000806;

    function setUp() public {
        src = new PrecompilePriceSource();
    }

    function test_precompileAddresses_matchDesign() public view {
        assertEq(src.BBO_PRECOMPILE(), BBO);
        assertEq(src.ORACLE_PRECOMPILE(), ORACLE);
        assertEq(src.MARK_PRECOMPILE(), MARK);
    }

    function test_bbo_decodesPrecompileReturn() public {
        vm.mockCall(BBO, abi.encode(uint32(12)), abi.encode(uint64(85187), uint64(85191)));
        (uint64 bid, uint64 ask) = src.bbo(12);
        assertEq(bid, 85187);
        assertEq(ask, 85191);
    }

    function test_oraclePx_decodesPrecompileReturn() public {
        vm.mockCall(ORACLE, abi.encode(uint32(12)), abi.encode(uint64(85195)));
        assertEq(src.oraclePx(12), 85195);
    }

    function test_mark_decodesPrecompileReturn() public {
        vm.mockCall(MARK, abi.encode(uint32(12)), abi.encode(uint64(85189)));
        assertEq(src.mark(12), 85189);
    }

    function test_revertsWhenPrecompileFails() public {
        vm.mockCallRevert(BBO, abi.encode(uint32(999)), "");
        vm.expectRevert(abi.encodeWithSelector(PrecompilePriceSource.PrecompileCallFailed.selector, BBO, uint32(999)));
        src.bbo(999);
        vm.mockCallRevert(ORACLE, abi.encode(uint32(999)), "");
        vm.expectRevert(
            abi.encodeWithSelector(PrecompilePriceSource.PrecompileCallFailed.selector, ORACLE, uint32(999))
        );
        src.oraclePx(999);
        vm.mockCallRevert(MARK, abi.encode(uint32(999)), "");
        vm.expectRevert(abi.encodeWithSelector(PrecompilePriceSource.PrecompileCallFailed.selector, MARK, uint32(999)));
        src.mark(999);
    }

    function test_revertsOnShortReturn() public {
        vm.mockCall(BBO, abi.encode(uint32(5)), abi.encode(uint64(1)));
        vm.expectRevert(abi.encodeWithSelector(PrecompilePriceSource.PrecompileCallFailed.selector, BBO, uint32(5)));
        src.bbo(5);
    }
}
