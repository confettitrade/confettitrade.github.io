// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Exchange} from "../src/Exchange.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {PrecompilePriceSource} from "../src/PrecompilePriceSource.sol";
import {ImpactLib} from "../src/lib/ImpactLib.sol";
import {IExchange} from "../src/interfaces/IExchange.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {IConfetti} from "../src/interfaces/IConfetti.sol";
import {ITokenomics} from "../src/interfaces/ITokenomics.sol";
import {IStaking} from "../src/interfaces/IStaking.sol";
import {IReferrals} from "../src/interfaces/IReferrals.sol";
import {Referrals} from "../src/Referrals.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPriceSource} from "./mocks/MockPriceSource.sol";
import {StubTokenomics} from "./mocks/StubTokenomics.sol";
import {StubStaking} from "./mocks/StubStaking.sol";

/// @dev Minimal CONFETTI stand-in: the Exchange only ever calls `mint`.
contract StubConfetti {
    error NotExchange();

    address public exchange;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    uint256 public mintCalls;

    function setExchange(address exchange_) external {
        exchange = exchange_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != exchange) revert NotExchange();
        balanceOf[to] += amount;
        totalSupply += amount;
        mintCalls += 1;
    }
}

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
        assertEq(ImpactLib.MAX_FEE_BPS, 500);
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

/*//////////////////////////////////////////////////////////////////////////
                                  Exchange
//////////////////////////////////////////////////////////////////////////*/

contract ExchangeTest is Test {
    MockUSDC usdc;
    MockPriceSource source;
    PriceOracle oracle;
    StubConfetti confetti;
    StubTokenomics tokenomics;
    StubStaking staking;
    Exchange ex;
    Referrals refs;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address feeRecipient = makeAddr("feeRecipient");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address liquidator = makeAddr("liquidator");
    address stranger = makeAddr("stranger");

    // Instruments: 0 = tier A (DOGE-like, HL index 12), 1 = tier B (174), 2 = tier C (176).
    uint32 constant TIER_A = 0;
    uint32 constant TIER_B = 1;
    uint32 constant TIER_C = 2;
    uint32 constant ASSET_A = 12;
    uint32 constant ASSET_B = 174;
    uint32 constant ASSET_C = 176;

    /// @dev Raw quote with szDecimals 0: 1_000_000 -> $1.000000 -> 1e18.
    uint64 constant RAW_ONE = 1_000_000;
    uint256 constant ONE = 1e18;
    uint128 constant MARGIN = 100e6;
    uint32 constant LEV = 10; // notional $1000

    /// @dev The default request windows: keeper only in [5, 8), anyone in [8, 60], cancel after.
    uint256 constant DELAY = 5;
    uint256 constant GRACE = 3;
    uint256 constant EXPIRY = 60;

    /// @dev keccak of the TeamMinted signature, to prove the event is absent from a log list.
    bytes32 constant TEAM_MINTED_TOPIC = keccak256("TeamMinted(address,uint256)");
    bytes32 constant POSITION_CLOSED_TOPIC =
        keccak256("PositionClosed(uint256,address,uint256,int256,uint256,uint256,uint256,uint256)");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        source = new MockPriceSource();
        oracle = new PriceOracle(source, address(this));
        confetti = new StubConfetti();
        tokenomics = new StubTokenomics();
        staking = new StubStaking(address(usdc));
        ex = new Exchange(
            usdc,
            oracle,
            IConfetti(address(confetti)),
            ITokenomics(address(tokenomics)),
            IStaking(address(staking)),
            owner,
            feeRecipient
        );
        refs = Referrals(ex.referrals());
        oracle.setRegistrar(address(ex));
        confetti.setExchange(address(ex));
        tokenomics.setExchange(address(ex));
        staking.wire(address(ex), address(tokenomics));

        vm.startPrank(owner);
        ex.setKeepers(guardian, keeper);
        ex.setKeeper(keeper, true);
        ex.addInstrument(_spec(0, ASSET_A, 1, 10, 250_000e6));
        ex.addInstrument(_spec(1, ASSET_B, 3, 25, 100_000e6));
        ex.addInstrument(_spec(2, ASSET_C, 10, 50, 25_000e6));
        vm.stopPrank();

        _setPx(ASSET_A, RAW_ONE);
        _setPx(ASSET_B, RAW_ONE);
        _setPx(ASSET_C, RAW_ONE);

        _fund(alice, 1000e6);
        _fund(bob, 1000e6);
        _fund(carol, 1000e6);
        _fund(dave, 1000e6);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Fixture spec: the tier's old leverage ladder (1000 / 250 / 50) as the per-coin cap.
    function _spec(uint8 tier, uint32 asset, uint16 deadband, uint16 clamp, uint128 cap)
        internal
        pure
        returns (IExchange.Instrument memory)
    {
        return IExchange.Instrument({
            hlAssetIndex: asset,
            szDecimals: 0,
            tier: tier,
            maxLeverage: tier == 0 ? 1000 : (tier == 1 ? 250 : 50),
            deadbandBps: deadband,
            clampBps: clamp,
            baseRateBps: 1000,
            rateMultiplier: 15_000,
            referenceNotionalUsd: 20_000e6,
            positionMultiplierE6: 130_000_000e6,
            longOiCapUsd: cap,
            shortOiCapUsd: cap,
            maxNotionalUsd: 100_000e6, // the owner bound; the launch table uses $25K / $10K / $2.5K
            payoutCapX: 50,
            opensPaused: true, // must be ignored
            retired: true, // must be ignored
            frozenPx18: 123 // must be ignored
        });
    }

    function _launchCurve() internal pure returns (ImpactLib.Curve memory) {
        return ImpactLib.Curve({
            baseRateBps: 1000,
            rateMultiplier: 15_000,
            referenceNotionalUsd: 20_000e6,
            positionMultiplierE6: 130_000_000e6
        });
    }

    function _setPx(uint32 asset, uint64 raw) internal {
        source.setQuote(asset, raw, raw, raw);
    }

    /// @dev Book (bid = ask = mark) and oracle set apart, raw units of $1e-6 (szDecimals 0).
    function _setQuotes(uint32 asset, uint64 book, uint64 oraclePx) internal {
        source.setQuote(asset, book, book, book, oraclePx);
    }

    function _fund(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(ex), type(uint256).max);
        ex.deposit(amount);
        vm.stopPrank();
    }

    /// @dev Move into the keeper window of a request filed right now.
    function _tick() internal {
        vm.warp(vm.getBlockTimestamp() + DELAY);
    }

    function _requestOpen(address user, uint32 id, bool isLong, uint128 margin, uint32 lev)
        internal
        returns (uint256 requestId)
    {
        vm.prank(user);
        return ex.requestOpen(id, isLong, margin, lev, address(0));
    }

    /// @dev The keeper fills a request filed right now in its first eligible second.
    function _executeOpen(uint256 requestId) internal returns (uint256 positionId) {
        _tick();
        vm.prank(keeper);
        positionId = ex.executeOpen(requestId);
        assertGt(positionId, 0, "open request refunded");
    }

    /// @dev Request as `user`, keeper fills. The LP breaker can trip in scenarios that lower
    ///      its $5K floor (DESIGN 3b, see the breaker tests); the guardian clears it first so
    ///      a scenario can keep opening positions.
    function _open(address user, uint32 id, bool isLong, uint128 margin, uint32 lev) internal returns (uint256) {
        if (ex.breakerTripped()) {
            vm.prank(guardian);
            ex.clearBreaker();
        }
        return _executeOpen(_requestOpen(user, id, isLong, margin, lev));
    }

    function _requestClose(address user, uint256 id) internal {
        vm.prank(user);
        ex.requestClose(id);
    }

    function _executeClose(uint256 id) internal returns (uint256 payout, uint256 queued) {
        _tick();
        vm.prank(keeper);
        return ex.executeClose(id);
    }

    function _close(address user, uint256 id) internal returns (uint256 payout, uint256 queued) {
        _requestClose(user, id);
        return _executeClose(id);
    }

    /// @dev The exchange's USDC balance must always equal every claim on it: available
    ///      balances, open margins, pending request margins and the LP cash.
    function _assertSolvent() internal view {
        address[7] memory users = [alice, bob, carol, dave, liquidator, feeRecipient, stranger];
        uint256 claims = ex.lpBalance();
        for (uint256 i = 0; i < users.length; i++) {
            claims += ex.balanceOf(users[i]) + ex.marginInUse(users[i]) + ex.pendingOf(users[i]);
        }
        assertEq(usdc.balanceOf(address(ex)), claims, "insolvent");
    }

    /// @dev Tokenomics' tally should match LP cash minus the claims on it (no sweeps yet).
    function _assertTallyMatches() internal view {
        int256 expected = int256(ex.lpBalance()) - int256(ex.feePool()) - int256(ex.queuedTotal());
        assertEq(tokenomics.trackedLpUsd(), expected, "tally");
    }

    /// @dev Number of TeamMinted events in `logs` emitted by the exchange.
    function _teamMintedCount(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(ex) || logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == TEAM_MINTED_TOPIC) n++;
        }
    }

    /// @dev Seed the LP with cash by having `user` lose a whole $100 margin on a 10% drop. At
    ///      the default 5% rate: LP cash $100, fee pool $5, tally $95, 9,500 CONFETTI to `user`
    ///      and 950 to the fee recipient.
    function _seedLpWithFullLoss(address user) internal returns (uint256 lossUsdc) {
        _setPx(ASSET_A, RAW_ONE);
        uint256 id = _open(user, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        _close(user, id);
        _setPx(ASSET_A, RAW_ONE);
        return MARGIN;
    }

    /// @dev Grow the LP by $20K: `user` loses a whole $20K margin at 5x on a 20% drop (the
    ///      $100K notional is the per-position cap). At the default 5% rate: LP cash +$20K, fee
    ///      pool +$1K, net LP gain $19K. `user` must hold the margin.
    function _lose20K(address user) internal {
        _setPx(ASSET_A, RAW_ONE);
        uint256 id = _open(user, TIER_A, true, 20_000e6, 5);
        _setPx(ASSET_A, 800_000);
        _close(user, id);
        _setPx(ASSET_A, RAW_ONE);
    }

    /// @dev `previewClose` must say exactly what the keeper's close pays: requests the close of
    ///      `id` as `user`, lets the keeper fill it, checks the returned payout and the
    ///      `PositionClosed` event (price, pnl, fee, payout) against the preview taken just
    ///      before, and returns the settled figures.
    function _closeMatchesPreview(address user, uint256 id, uint256 expectedExitPx18)
        internal
        returns (int256 pnl, uint256 fee, uint256 paid)
    {
        uint256 payout;
        (pnl, fee, payout) = ex.previewClose(id);
        _requestClose(user, id);
        _tick();
        vm.recordLogs();
        vm.prank(keeper);
        uint256 queued;
        (paid, queued) = ex.executeClose(id);
        assertEq(paid, payout, "close paid != preview");
        assertEq(queued, 0, "queued");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(ex) || logs[i].topics[0] != POSITION_CLOSED_TOPIC) continue;
            (uint256 exitPx18, int256 ePnl, uint256 eFee, uint256 ePayout,,) =
                abi.decode(logs[i].data, (uint256, int256, uint256, uint256, uint256, uint256));
            assertEq(exitPx18, expectedExitPx18, "exit price");
            assertEq(ePnl, pnl, "event pnl != preview");
            assertEq(eFee, fee, "event fee != preview");
            assertEq(ePayout, payout, "event payout != preview");
            return (pnl, fee, paid);
        }
        revert("PositionClosed not emitted");
    }

    function _oob(IExchange.Param p, uint256 v) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IExchange.ParamOutOfBounds.selector, p, v);
    }

    // ------------------------------------------------------------- collateral

    function test_deposit_and_withdraw() public {
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(usdc.balanceOf(address(ex)), 4000e6);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit IExchange.Withdrawn(alice, 400e6);
        ex.withdraw(400e6);
        assertEq(ex.balanceOf(alice), 600e6);
        assertEq(usdc.balanceOf(alice), 400e6);

        usdc.mint(alice, 50e6);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit IExchange.Deposited(alice, alice, 50e6);
        ex.deposit(50e6);
        assertEq(ex.balanceOf(alice), 650e6);
        _assertSolvent();
    }

    function test_deposit_withdraw_rejectInvalidAmounts() public {
        vm.startPrank(alice);
        vm.expectRevert(IExchange.ZeroAmount.selector);
        ex.deposit(0);
        vm.expectRevert(IExchange.ZeroAmount.selector);
        ex.withdraw(0);
        vm.expectRevert(abi.encodeWithSelector(IExchange.InsufficientBalance.selector, 1000e6, 1000e6 + 1));
        ex.withdraw(1000e6 + 1);
        vm.stopPrank();
    }

    function test_depositFor_creditsBeneficiary_pullsFromPayer() public {
        usdc.mint(bob, 25e6);
        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit IExchange.Deposited(alice, bob, 25e6);
        ex.depositFor(alice, 25e6);
        assertEq(ex.balanceOf(alice), 1025e6);
        assertEq(ex.balanceOf(bob), 1000e6);
        assertEq(usdc.balanceOf(bob), 0);

        vm.prank(bob);
        vm.expectRevert(IExchange.ZeroAddress.selector);
        ex.depositFor(address(0), 1);
        _assertSolvent();
    }

    function test_stakingClaim_landsInExchangeBalance() public {
        usdc.mint(address(staking), 5e6);
        staking.setEarned(alice, 5e6);
        vm.prank(alice);
        assertEq(staking.claim(), 5e6);
        assertEq(ex.balanceOf(alice), 1005e6);
        assertEq(usdc.balanceOf(address(staking)), 0);
        _assertSolvent();
    }

    // --------------------------------------------------------- open requests

    function test_requestOpen_recordsRequest_movesMarginToPending() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit IExchange.OpenRequested(1, alice, TIER_A, true, MARGIN, LEV, ONE, address(0));
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        assertEq(req, 1);
        assertEq(ex.nextRequestId(), 2);
        assertEq(ex.nextPositionId(), 1); // nothing opened yet

        IExchange.OpenRequest memory r = ex.openRequest(req);
        assertEq(r.trader, alice);
        assertEq(r.instrumentId, TIER_A);
        assertTrue(r.isLong);
        assertEq(r.marginUsdc, MARGIN);
        assertEq(r.leverage, LEV);
        assertEq(r.requestedAt, t0);
        assertEq(r.px0, ONE);
        assertEq(r.referrer, address(0));

        // The margin is neither available nor in use: it waits in `pendingOf`.
        assertEq(ex.balanceOf(alice), 900e6);
        assertEq(ex.pendingOf(alice), MARGIN);
        assertEq(ex.marginInUse(alice), 0);
        (uint256 longOi,) = ex.openInterest(TIER_A);
        assertEq(longOi, 0);
        assertEq(ex.positionIdsOf(alice).length, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchange.InsufficientBalance.selector, 900e6, 900e6 + 1));
        ex.withdraw(900e6 + 1);
        _assertSolvent();
    }

    function test_executeOpen_storesPositionAndUpdatesAccounting() public {
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        uint256 t0 = vm.getBlockTimestamp();
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IExchange.PositionOpened(1, alice, TIER_A, true, MARGIN, LEV, ONE, req);
        uint256 id = ex.executeOpen(req);
        assertEq(id, 1);
        assertEq(ex.nextPositionId(), 2);

        IExchange.Position memory p = ex.positions(id);
        assertEq(p.owner, alice);
        assertEq(p.instrumentId, TIER_A);
        assertTrue(p.isLong);
        assertEq(p.marginUsdc, MARGIN);
        assertEq(p.leverage, LEV);
        assertEq(p.entryPx18, ONE);
        assertEq(p.openedAt, t0 + DELAY); // the execution block, not the request
        // The settlement terms are stamped at execution (DESIGN 5): the market's 1 bps deadband
        // and 50x payout cap, and the exchange's 5% fee rate.
        assertEq(p.deadbandBps, 1);
        assertEq(p.payoutCapX, 50);
        assertEq(p.feeBps, 500);

        assertEq(ex.balanceOf(alice), 900e6);
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.marginInUse(alice), MARGIN);
        assertEq(ex.openRequest(req).trader, address(0)); // consumed
        (uint256 longOi, uint256 shortOi) = ex.openInterest(TIER_A);
        assertEq(longOi, 1000e6);
        assertEq(shortOi, 0);
        uint256[] memory ids = ex.positionIdsOf(alice);
        assertEq(ids.length, 1);
        assertEq(ids[0], 1);
        assertEq(ex.bustPrice(id), 0.905e18);
        // The first executed open fixed alice's referrer (none).
        assertTrue(refs.referrerLocked(alice));
        assertEq(refs.referrerOf(alice), address(0));
        _assertSolvent();
    }

    function test_requestOpen_minMargin() public {
        vm.prank(alice);
        vm.expectRevert(IExchange.MarginBelowMinimum.selector);
        ex.requestOpen(TIER_A, true, 10e6 - 1, 1, address(0));
        _open(alice, TIER_A, true, 10e6, 1);
    }

    function test_requestOpen_perCoinLeverageCaps() public {
        vm.startPrank(alice);
        vm.expectRevert(IExchange.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_A, true, MARGIN, 1001, address(0));
        vm.expectRevert(IExchange.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_A, true, MARGIN, 0, address(0));
        vm.expectRevert(IExchange.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_B, true, MARGIN, 251, address(0));
        vm.expectRevert(IExchange.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_C, true, MARGIN, 51, address(0));
        vm.stopPrank();
        // The caps themselves are allowed (margin sized so notional stays under the OI cap).
        _open(alice, TIER_A, true, 100e6, 1000);
        _open(alice, TIER_B, true, 100e6, 250);
        _open(alice, TIER_C, true, 100e6, 50);
        assertEq(ex.instrument(TIER_A).maxLeverage, 1000);
        assertEq(ex.instrument(TIER_B).maxLeverage, 250);
        assertEq(ex.instrument(TIER_C).maxLeverage, 50);
    }

    function test_open_oiCapsPerSide() public {
        // Tier A cap is $250K per side. Two 100x$1000 = $100K longs fit, the third does not.
        _open(alice, TIER_A, true, 100e6, 1000);
        _open(bob, TIER_A, true, 100e6, 1000);
        vm.prank(carol);
        vm.expectRevert(IExchange.OiCapExceeded.selector);
        ex.requestOpen(TIER_A, true, 100e6, 1000, address(0));
        // A $50K long fits exactly; the short side is independent.
        _open(carol, TIER_A, true, 50e6, 1000);
        _open(dave, TIER_A, false, 100e6, 1000);
        (uint256 longOi, uint256 shortOi) = ex.openInterest(TIER_A);
        assertEq(longOi, 250_000e6);
        assertEq(shortOi, 100_000e6);
        vm.prank(dave);
        vm.expectRevert(IExchange.OiCapExceeded.selector);
        ex.requestOpen(TIER_A, true, 10e6, 1, address(0));

        // Closing frees headroom.
        _close(alice, 1);
        _open(dave, TIER_A, true, 100e6, 1000);

        // Keeper lowering the cap below current OI blocks opens without touching positions.
        vm.prank(keeper);
        ex.setOiCaps(TIER_A, 1000e6, 1000e6);
        vm.prank(dave);
        vm.expectRevert(IExchange.OiCapExceeded.selector);
        ex.requestOpen(TIER_A, true, 10e6, 1, address(0));
        _assertSolvent();
    }

    function test_requestOpen_insufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchange.InsufficientBalance.selector, 1000e6, 1000e6 + 1));
        ex.requestOpen(TIER_A, true, 1000e6 + 1, 1, address(0));
        // Pending margin counts as spent: a second $600 request on $400 of available fails.
        _requestOpen(alice, TIER_A, true, 600e6, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchange.InsufficientBalance.selector, 400e6, 600e6));
        ex.requestOpen(TIER_A, true, 600e6, 1, address(0));
    }

    function test_requestOpen_unknownInstrument() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownInstrument.selector, uint32(9)));
        ex.requestOpen(9, true, MARGIN, 1, address(0));
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownInstrument.selector, uint32(9)));
        ex.instrument(9);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownInstrument.selector, uint32(9)));
        ex.execPrice(9, true, true);
    }

    function test_requestOpen_oracleFeedDownBlocks_bookFeedDownDoesNot() public {
        // Pricing is oracle only: a dead oracle feed stops requests, a dead book changes nothing.
        source.setOracleReverts(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        source.setOracleReverts(false);
        source.setReverts(true, false); // BBO down
        assertEq(ex.execPrice(TIER_A, true, true), ONE);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(id).entryPx18, ONE);
        source.setReverts(false, false);
    }

    function test_open_notionalCapPerPosition() public {
        // DESIGN 3b/4: one position may not take the whole side cap. The fixture allows the
        // $100K owner bound; set the launch table's $25K and probe both sides of it.
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchange.PositionCapsSet(TIER_A, 25_000e6, 50);
        ex.setPositionCaps(TIER_A, 25_000e6, 50);
        IExchange.Instrument memory inst = ex.instrument(TIER_A);
        assertEq(inst.maxNotionalUsd, 25_000e6);
        assertEq(inst.payoutCapX, 50);

        vm.prank(alice);
        vm.expectRevert(IExchange.PositionTooLarge.selector);
        ex.requestOpen(TIER_A, true, 26e6, 1000, address(0));
        vm.prank(alice);
        vm.expectRevert(IExchange.PositionTooLarge.selector);
        ex.requestOpen(TIER_A, false, 250e6, 1000, address(0));
        _open(alice, TIER_A, true, 25e6, 1000); // exactly the cap is allowed
        (uint256 longOi,) = ex.openInterest(TIER_A);
        assertEq(longOi, 25_000e6);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setPositionCaps(TIER_A, 25_000e6, 50);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchange.Param.MaxNotionalUsd, 0));
        ex.setPositionCaps(TIER_A, 0, 50);
        vm.expectRevert(_oob(IExchange.Param.MaxNotionalUsd, 100_000e6 + 1));
        ex.setPositionCaps(TIER_A, 100_000e6 + 1, 50);
        vm.expectRevert(_oob(IExchange.Param.PayoutCapX, 9));
        ex.setPositionCaps(TIER_A, 25_000e6, 9);
        vm.expectRevert(_oob(IExchange.Param.PayoutCapX, 201));
        ex.setPositionCaps(TIER_A, 25_000e6, 201);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownInstrument.selector, uint32(9)));
        ex.setPositionCaps(9, 25_000e6, 50);
        ex.setPositionCaps(TIER_A, 100_000e6, 10); // the edges are accepted
        ex.setPositionCaps(TIER_A, 25_000e6, 200);
        // addInstrument applies the same bounds.
        IExchange.Instrument memory spec = _spec(0, 165, 1, 10, 250_000e6);
        spec.maxNotionalUsd = 0;
        vm.expectRevert(_oob(IExchange.Param.MaxNotionalUsd, 0));
        ex.addInstrument(spec);
        spec.maxNotionalUsd = 25_000e6;
        spec.payoutCapX = 201;
        vm.expectRevert(_oob(IExchange.Param.PayoutCapX, 201));
        ex.addInstrument(spec);
        vm.stopPrank();
    }

    // ------------------------------------------------------- request windows

    /// @dev The three windows, measured from the request: nobody before 5 s, keepers only in
    ///      [5, 8), anyone in [8, 60], cancel only after 60 s.
    function test_windows_openRequest_minDelay_keeperFirst_thenAnyone_thenCancelOnly() public {
        uint256 t0 = vm.getBlockTimestamp();
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);

        // Before minDelay nobody can execute, the keeper included.
        vm.warp(t0 + DELAY - 1);
        vm.prank(keeper);
        vm.expectRevert(IExchange.TooEarly.selector);
        ex.executeOpen(req);
        // In the keeper window only a fill keeper may: not a stranger, not the requester, not
        // the owner or the market keeper by virtue of their roles.
        vm.warp(t0 + DELAY);
        vm.prank(stranger);
        vm.expectRevert(IExchange.KeeperWindow.selector);
        ex.executeOpen(req);
        vm.prank(alice);
        vm.expectRevert(IExchange.KeeperWindow.selector);
        ex.executeOpen(req);
        vm.prank(owner);
        vm.expectRevert(IExchange.KeeperWindow.selector);
        ex.executeOpen(req);
        vm.warp(t0 + DELAY + GRACE - 1);
        vm.prank(stranger);
        vm.expectRevert(IExchange.KeeperWindow.selector);
        ex.executeOpen(req);
        // Nobody can cancel before expiry, the requester least of all.
        vm.prank(alice);
        vm.expectRevert(IExchange.RequestNotExpired.selector);
        ex.cancelOpen(req);
        // From minDelay + grace anyone executes, up to and including the expiry second.
        vm.warp(t0 + DELAY + GRACE);
        vm.prank(stranger);
        assertEq(ex.executeOpen(req), 1);

        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        t0 = vm.getBlockTimestamp();
        vm.warp(t0 + EXPIRY);
        vm.prank(alice);
        vm.expectRevert(IExchange.RequestNotExpired.selector);
        ex.cancelOpen(req);
        vm.prank(alice); // the requester may self-execute in the fallback window
        assertEq(ex.executeOpen(req), 2);

        // Past expiry: execution reverts for everyone, anyone cancels and the margin returns.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        t0 = vm.getBlockTimestamp();
        assertEq(ex.balanceOf(alice), 700e6);
        assertEq(ex.pendingOf(alice), MARGIN);
        vm.warp(t0 + EXPIRY + 1);
        vm.prank(keeper);
        vm.expectRevert(IExchange.RequestExpired.selector);
        ex.executeOpen(req);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.RequestExpired.selector);
        ex.cancelOpen(req);
        assertEq(ex.balanceOf(alice), 800e6);
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.openRequest(req).trader, address(0));
        assertEq(ex.positionIdsOf(alice).length, 2);
        // Gone for good.
        vm.prank(stranger);
        vm.expectRevert(IExchange.UnknownRequest.selector);
        ex.cancelOpen(req);
        vm.prank(keeper);
        vm.expectRevert(IExchange.UnknownRequest.selector);
        ex.executeOpen(req);
        vm.expectRevert(IExchange.UnknownRequest.selector);
        ex.executeOpen(99);
        _assertSolvent();
    }

    /// @dev Same windows for a close request; a cancelled close leaves the position open and
    ///      can be requested again.
    function test_windows_closeRequest_sameRules_cancelLeavesPositionOpen() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotPositionOwner.selector, id, bob));
        ex.requestClose(id);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit IExchange.CloseRequested(id, alice, ONE);
        ex.requestClose(id);
        IExchange.CloseRequest memory r = ex.closeRequest(id);
        assertEq(r.requestedAt, t0);
        assertEq(r.px0, ONE);

        vm.warp(t0 + DELAY - 1);
        vm.prank(keeper);
        vm.expectRevert(IExchange.TooEarly.selector);
        ex.executeClose(id);
        vm.warp(t0 + DELAY);
        vm.prank(alice);
        vm.expectRevert(IExchange.KeeperWindow.selector);
        ex.executeClose(id);
        vm.prank(alice);
        vm.expectRevert(IExchange.RequestNotExpired.selector);
        ex.cancelClose(id);
        vm.warp(t0 + EXPIRY + 1);
        vm.prank(keeper);
        vm.expectRevert(IExchange.RequestExpired.selector);
        ex.executeClose(id);
        vm.prank(stranger);
        vm.expectEmit(true, false, false, true);
        emit IExchange.CloseRequestCancelled(id, IExchange.RequestExpired.selector);
        ex.cancelClose(id);
        assertEq(ex.closeRequest(id).requestedAt, 0);
        assertEq(ex.positions(id).owner, alice); // still open
        assertEq(ex.marginInUse(alice), MARGIN);
        vm.expectRevert(IExchange.UnknownRequest.selector);
        ex.executeClose(id);
        vm.expectRevert(IExchange.UnknownRequest.selector);
        ex.cancelClose(id);

        // Requested again, the fallback window lets the requester close it.
        _requestClose(alice, id);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(alice);
        (uint256 paid,) = ex.executeClose(id);
        assertEq(paid, MARGIN);
        assertEq(ex.positions(id).owner, address(0));
        _assertSolvent();
    }

    function test_requestClose_onePendingPerPosition_andGoneAfterClose() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _requestClose(alice, id);
        vm.prank(alice);
        vm.expectRevert(IExchange.CloseAlreadyPending.selector);
        ex.requestClose(id);
        _executeClose(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownPosition.selector, id));
        ex.requestClose(id);
        vm.expectRevert(IExchange.UnknownRequest.selector);
        ex.executeClose(id);
    }

    // ------------------------------------------------------------ fill price

    /// @dev Keeper window: the fill is the live print p1, better or worse. Fallback window: the
    ///      trader-worse of p0 and p1, so a later, better print never reaches the trader and a
    ///      later, worse one does.
    function test_fill_open_keeperTakesLivePrint_fallbackTakesWorseOfRequestAndLive() public {
        // Keeper, long: requested at 1.000, executed at 0.990 -> 0.990 (the live print).
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 990_000);
        uint256 id = _executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 0.99e18);

        // Fallback, long: requested at 1.000, executed at 0.990 -> max = 1.000 (no gift) ...
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 990_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, ONE);
        // ... and executed at 1.010 -> max = 1.010 (the later, worse print).
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(alice); // self-executing changes nothing
        id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 1.01e18);

        // Short mirror: requested at 1.000, executed at 1.010 -> min = 1.000; at 0.990 -> 0.990.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(bob, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, ONE);
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(bob, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 990_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 0.99e18);
        // Keeper, short: the live 1.010 print, though better for the short, is the fill.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(bob, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        id = _executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 1.01e18);
        _assertSolvent();
    }

    function test_fill_close_fallbackTakesWorseOfRequestAndLive_exactNumbers() public {
        _seedLpWithFullLoss(bob); // LP cash so the wins are paid in full

        // Long at 1.000. Close requested at 1.010 (p0); the oracle prints 1.030 by the fallback
        // window: the fill is min(1.010, 1.030) = 1.010, the 1% vector (deadband exit 1.009899,
        // adjusted 8.714963, fee 5% = 0.435748, profit 8.279215). The later, better print is
        // not the trader's.
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 1_030_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(id, alice, 1.01e18, 8_279_215, 435_748, 108_279_215, 0, 0);
        (uint256 paid,) = ex.executeClose(id);
        assertEq(paid, 108_279_215);

        // The same request with the print at 1.005 by then fills at 1.005: exactly what the
        // preview says at 1.005, and less than the 1.010 the trader asked at.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_005_000);
        (int256 pnlAt1005,, uint256 payoutAt1005) = ex.previewClose(id);
        assertGt(pnlAt1005, 0);
        assertLt(pnlAt1005, 8_279_215);
        _setPx(ASSET_A, 1_010_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 1_005_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        (paid,) = ex.executeClose(id);
        assertEq(paid, payoutAt1005);

        // Keeper window: the live print, even when better. Requested at 1.010, filled at 1.030.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 1_030_000);
        (int256 pnlAt1030,,) = ex.previewClose(id);
        assertGt(pnlAt1030, 8_279_215);
        _tick();
        vm.recordLogs();
        vm.prank(keeper);
        ex.executeClose(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(ex) || logs[i].topics[0] != POSITION_CLOSED_TOPIC) continue;
            (uint256 exitPx18, int256 pnl,,,,) =
                abi.decode(logs[i].data, (uint256, int256, uint256, uint256, uint256, uint256));
            assertEq(exitPx18, 1.03e18);
            assertEq(pnl, pnlAt1030);
            seen = true;
        }
        assertTrue(seen);

        // Short mirror: at 1.000, requested at 0.990, the print at 0.980 by the fallback: fill
        // max(0.990, 0.980) = 0.990, the short 1% vector (exit rounded up 0.990099, adjusted
        // 8.716762, fee 0.435838, profit 8.280924); at 0.995 by then: 0.995, the worse print.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 990_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 980_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(id, alice, 0.99e18, 8_280_924, 435_838, 108_280_924, 0, 0);
        ex.executeClose(id);
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        (,, uint256 payoutAt995) = ex.previewClose(id);
        _setPx(ASSET_A, 990_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 995_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        (paid,) = ex.executeClose(id);
        assertEq(paid, payoutAt995);
        assertLt(paid, 108_280_924);
        _assertSolvent();
        _assertTallyMatches();
    }

    // ------------------------------------------------ re-checks at execution

    /// @dev Every open-time rule runs again when the request executes; a rule that fails by
    ///      then refunds the request (event with the rule) instead of reverting.
    function test_executeOpen_refundsWhenARuleFailsAtExecution() public {
        // Market paused by the guardian between request and execution.
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(guardian);
        ex.setMarketOpensPaused(TIER_A, true);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.OpensPausedForMarket.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.openRequest(req).trader, address(0));
        assertEq(ex.positionIdsOf(alice).length, 0);
        assertEq(ex.nextPositionId(), 1);
        vm.prank(keeper);
        vm.expectRevert(IExchange.UnknownRequest.selector);
        ex.executeOpen(req);
        vm.prank(owner);
        ex.setMarketOpensPaused(TIER_A, false);

        // Global pause.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(guardian);
        ex.setGlobalOpensPaused(true);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.OpensPausedGlobally.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(owner);
        ex.setGlobalOpensPaused(false);

        // Per-position cap shrunk under the request's $1000 notional.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(owner);
        ex.setPositionCaps(TIER_A, 500e6, 50);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.PositionTooLarge.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(owner);
        ex.setPositionCaps(TIER_A, 100_000e6, 50);

        // OI cap moved under it by the market keeper.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(keeper);
        ex.setOiCaps(TIER_A, 500e6, 500e6);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.OiCapExceeded.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(keeper);
        ex.setOiCaps(TIER_A, 250_000e6, 250_000e6);

        // Leverage cap lowered under the request's 10x.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(owner);
        ex.setMaxLeverage(TIER_A, 5);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.LeverageOutOfRange.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(owner);
        ex.setMaxLeverage(TIER_A, 1000);

        // Breaker tripped by a win in between (floor lowered so a $44.71 win trips it).
        vm.prank(owner);
        ex.setBreakerFloor(0);
        uint256 wid = _open(bob, TIER_A, true, MARGIN, LEV);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_050_000);
        _close(bob, wid);
        assertTrue(ex.breakerTripped());
        _setPx(ASSET_A, RAW_ONE);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.OpensPausedByBreaker.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(guardian);
        ex.clearBreaker();

        // Market retired in between.
        req = _requestOpen(alice, TIER_B, true, MARGIN, LEV);
        vm.prank(guardian);
        ex.retire(TIER_B);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.MarketRetired.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(alice);
        vm.expectRevert(IExchange.MarketRetired.selector);
        ex.requestOpen(TIER_B, true, MARGIN, LEV, address(0));

        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.positionIdsOf(alice).length, 0);
        _assertSolvent();
        _assertTallyMatches();
    }

    /// @dev The jump guard: an oracle move of more than `maxJumpBps` (10%) between request and
    ///      execution refunds the open; exactly 10% fills. The owner tunes it within 10..10000.
    function test_executeOpen_jumpGuard_refundsBrokenPrints_ownerSetsIt() public {
        assertEq(ex.maxJumpBps(), 1000);
        // 10.1% up: |1.101 - 1.000| x 10000 = 1010 bps > 1000 -> refund.
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_101_000);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.PriceJumped.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        // 10.1% down likewise.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 899_000);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.PriceJumped.selector);
        assertEq(ex.executeOpen(req), 0);
        // Exactly 10% (1000 bps, not over): fills at the live 1.100.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_100_000);
        uint256 id = _executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 1.1e18);

        // Owner only, 10..10000, announced; a tighter guard (5%) refunds a 5.01% move.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setMaxJumpBps(500);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchange.Param.MaxJumpBps, 9));
        ex.setMaxJumpBps(9);
        vm.expectRevert(_oob(IExchange.Param.MaxJumpBps, 10_001));
        ex.setMaxJumpBps(10_001);
        ex.setMaxJumpBps(10_000);
        ex.setMaxJumpBps(10);
        vm.expectEmit(false, false, false, true);
        emit IExchange.MaxJumpBpsSet(500);
        ex.setMaxJumpBps(500);
        vm.stopPrank();
        assertEq(ex.maxJumpBps(), 500);
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_050_100);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.PriceJumped.selector);
        assertEq(ex.executeOpen(req), 0);
        // A close is never jump-guarded: the position opened at 1.100 closes after a 20% drop.
        _setPx(ASSET_A, 1_100_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 880_000);
        (uint256 paid,) = _executeClose(id);
        assertEq(paid, 0); // -20% at 10x: the whole margin
        _assertSolvent();
    }

    /// @dev The born-busted guard. A fallback fill is the trader-worse of p0 and p1, so p1 can
    ///      already sit past the bust price of a position booked at p0 (5 bps at 1000x, 200x
    ///      inside the 10% jump guard); without the guard the executor liquidates it in the
    ///      same transaction for the bounty and the trader loses the whole margin on a position
    ///      that was never live. Such a request is refunded with `EntryBusted`. One tick short
    ///      of bust still fills at p0, a favourable move still fills at p1 (worse-of kept), and
    ///      a keeper fill at p1 is untouched.
    function test_executeOpen_fallbackFillBornBusted_refundsInsteadOfOpening() public {
        // Long 1000x asked at 1.000; the oracle is 0.998 (-20 bps) when a stranger executes
        // in the fallback window: refund, no position, no bounty for anyone.
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 998_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.EntryBusted.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.marginInUse(alice), 0);
        assertEq(ex.positionIdsOf(alice).length, 0);
        // Short mirror at +20 bps.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, false, MARGIN, 1000);
        _setPx(ASSET_A, 1_002_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.EntryBusted.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        // Exactly at bust (-5 bps) refunds too: the position would be liquidatable at once.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 999_500);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.EntryBusted.selector);
        assertEq(ex.executeOpen(req), 0);
        // The keeper itself one second late (elapsed == minDelay + grace) gets the worse-of
        // fill and the same guard.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 998_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.OpenRequestCancelled(req, alice, IExchange.EntryBusted.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);

        // One tick short of bust (-4.99 bps): fills at p0 = 1.000 and is not liquidatable.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 999_501);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        uint256 id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, ONE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotLiquidatable.selector, id, 999_501e12, 0.9995e18));
        ex.liquidate(id);
        // A favourable move still fills at the later, worse-for-nobody p1 (worse-of kept).
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(bob, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 1_002_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 1.002e18);
        // The keeper window is unaffected: the same -20 bps print fills at p1 = 0.998 and the
        // position is not liquidatable there.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(carol, TIER_A, true, 20e6, 1000);
        _setPx(ASSET_A, 998_000);
        id = _executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 0.998e18);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotLiquidatable.selector, id, 0.998e18, 0.997501e18));
        ex.liquidate(id);
        _assertSolvent();
    }

    /// @dev The settlement terms are stamped when the open executes, not when it is requested.
    function test_executeOpen_stampsTermsAtExecution_notAtRequest() public {
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.startPrank(owner);
        ex.setFeeBps(100);
        ex.setInstrumentParams(TIER_A, 7, 10, 1000, 15_000, 20_000e6, 130_000_000e6);
        ex.setPositionCaps(TIER_A, 100_000e6, 20);
        vm.stopPrank();
        uint256 id = _executeOpen(req);
        IExchange.Position memory p = ex.positions(id);
        assertEq(p.feeBps, 100);
        assertEq(p.deadbandBps, 7);
        assertEq(p.payoutCapX, 20);
    }

    /// @dev A dead oracle at execution time reverts (nothing is refunded); the request waits for
    ///      the feed or for expiry.
    function test_executeOpen_feedDeadAtExecution_requestStaysPending() public {
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        source.setOracleReverts(true);
        _tick();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.executeOpen(req);
        assertEq(ex.openRequest(req).trader, alice);
        assertEq(ex.pendingOf(alice), MARGIN);
        // Cancelling after expiry needs no feed.
        vm.warp(vm.getBlockTimestamp() + EXPIRY);
        vm.prank(stranger);
        ex.cancelOpen(req);
        assertEq(ex.pendingOf(alice), 0);
        source.setOracleReverts(false);
        _assertSolvent();
    }

    // ---------------------------------------- pending close vs liquidation

    /// @dev A pending close never holds up a liquidation; the liquidation voids it and the
    ///      close path then has nothing to act on.
    function test_pendingClose_liquidationWins_closeRequestVoided() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _requestClose(alice, id);
        _setPx(ASSET_A, 905_000); // at bust
        vm.prank(liquidator);
        vm.expectEmit(true, false, false, true);
        emit IExchange.CloseRequestCancelled(id, IExchange.UnknownPosition.selector);
        vm.expectEmit(true, true, true, true);
        emit IExchange.PositionLiquidated(id, alice, liquidator, 0.905e18, MARGIN, 500_000, 5_000_000, 10_000e18);
        assertEq(ex.liquidate(id), 500_000);
        assertEq(ex.closeRequest(id).requestedAt, 0);
        assertEq(ex.positions(id).owner, address(0));

        // The keeper's late executeClose and anyone's cancelClose find nothing and change nothing.
        _tick();
        vm.prank(keeper);
        vm.expectRevert(IExchange.UnknownRequest.selector);
        ex.executeClose(id);
        vm.warp(vm.getBlockTimestamp() + EXPIRY);
        vm.expectRevert(IExchange.UnknownRequest.selector);
        ex.cancelClose(id);
        assertEq(ex.balanceOf(alice), 900e6);
        assertEq(ex.marginInUse(alice), 0);
        assertEq(ex.balanceOf(liquidator), 500_000);
        _assertSolvent();
        _assertTallyMatches();

        // Without a pending close the liquidation emits no cancellation.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(bob, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 1_095_000);
        vm.recordLogs();
        vm.prank(liquidator);
        ex.liquidate(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("CloseRequestCancelled(uint256,bytes4)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != topic, "spurious cancellation");
        }
    }

    // ------------------------------------------------------------ pricing

    /// @dev Oracle only: the book mid, pushed either way, settles nothing. Opens, previews,
    ///      closes and the view all read the oracle price.
    function test_pricing_oracleOnly_bookNeverSettles() public {
        _seedLpWithFullLoss(bob);
        // Book 1% under the oracle: every flag of execPrice is the oracle.
        _setQuotes(ASSET_A, 990_000, RAW_ONE);
        assertEq(oracle.rawMid(TIER_A), 0.99e18);
        assertEq(ex.execPrice(TIER_A, true, true), ONE);
        assertEq(ex.execPrice(TIER_A, false, true), ONE);
        assertEq(ex.execPrice(TIER_A, true, false), ONE);
        assertEq(ex.execPrice(TIER_A, false, false), ONE);
        uint256 lid = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 sid = _open(alice, TIER_A, false, MARGIN, LEV);
        assertEq(ex.positions(lid).entryPx18, ONE);
        assertEq(ex.positions(sid).entryPx18, ONE);

        // Book pushed 1% over, oracle unmoved: the long (and the short) are flat; the clamped
        // display price (1.001 with the 10 bps band) is not the settlement price either.
        _setQuotes(ASSET_A, 1_010_000, RAW_ONE);
        assertEq(oracle.price(TIER_A), 1.001e18);
        assertEq(ex.execPrice(TIER_A, true, false), ONE);
        (int256 pnl, uint256 fee, uint256 payout) = _closeMatchesPreview(alice, lid, ONE);
        assertEq(pnl, 0);
        assertEq(fee, 0);
        assertEq(payout, MARGIN);
        _setQuotes(ASSET_A, 990_000, RAW_ONE);
        (pnl,, payout) = _closeMatchesPreview(alice, sid, ONE);
        assertEq(pnl, 0);
        assertEq(payout, MARGIN);

        // The oracle moving is what pays. Long at 1.000; book 1.010, oracle 1.002 -> exit
        // 1.002; after the 1 bps deadband 1.0018998; raw gain = 1000 x 0.0018998 = 1.899800;
        // scale(move 0.18998%) = 0.806399...; adjusted 1.531998; fee 5% = 0.076599; profit
        // 1.455399.
        _setPx(ASSET_A, RAW_ONE);
        lid = _open(alice, TIER_A, true, MARGIN, LEV);
        _setQuotes(ASSET_A, 1_010_000, 1_002_000);
        (pnl, fee, payout) = _closeMatchesPreview(alice, lid, 1.002e18);
        assertEq(pnl, 1_455_399);
        assertEq(fee, 76_599);
        assertEq(payout, 101_455_399);
        // Short mirror: at 1.000; book 0.990, oracle 0.998 -> exit 0.998; deadband (rounded
        // up) 0.9980998; raw gain 1.900200; scale 0.806417...; adjusted 1.532354; fee
        // 0.076617; profit 1.455737.
        _setPx(ASSET_A, RAW_ONE);
        sid = _open(alice, TIER_A, false, MARGIN, LEV);
        _setQuotes(ASSET_A, 990_000, 998_000);
        (pnl, fee, payout) = _closeMatchesPreview(alice, sid, 0.998e18);
        assertEq(pnl, 1_455_737);
        assertEq(fee, 76_617);
        assertEq(payout, 101_455_737);
        _assertSolvent();
        _assertTallyMatches();
    }

    /// @dev A dead or zero oracle blocks every settlement path and the view; a dead book changes
    ///      nothing; a request filed before an outage waits it out; `retire` freezes the oracle
    ///      price, not the clamped mid.
    function test_feeds_oracleDeadBlocks_bookDeadDoesNot_retireFreezesOracle() public {
        _seedLpWithFullLoss(bob);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);

        source.setOracleReverts(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.requestClose(id);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.liquidate(id);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.previewClose(id);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.execPrice(TIER_A, true, false);
        source.setOracleReverts(false);

        // A close requested before an outage cannot execute during it and stays pending.
        _requestClose(alice, id);
        source.setOracleReverts(true);
        _tick();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.executeClose(id);
        assertGt(ex.closeRequest(id).requestedAt, 0);
        source.setOracleReverts(false);

        // A zero oracle quote: ZeroPrice. A zero or dead book: nothing changes.
        _setQuotes(ASSET_A, RAW_ONE, 0);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, TIER_A));
        ex.execPrice(TIER_A, false, true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, TIER_A));
        ex.requestOpen(TIER_A, false, MARGIN, LEV, address(0));
        source.setQuote(ASSET_A, 0, 0, RAW_ONE, RAW_ONE);
        assertEq(ex.execPrice(TIER_A, true, true), ONE);
        source.setReverts(true, false);
        assertEq(ex.execPrice(TIER_A, true, true), ONE);
        vm.prank(keeper);
        (uint256 paid,) = ex.executeClose(id); // the pending close settles, flat, on the oracle
        assertEq(paid, MARGIN);
        source.setReverts(false, false);

        // `retire` freezes the ORACLE price: book 1.020, oracle 1.010 (clamped mid 1.011) ->
        // 1.010. Afterwards the frozen price serves every side, feeds dead or not.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setQuotes(ASSET_A, 1_020_000, 1_010_000);
        assertEq(oracle.price(TIER_A), 1.01101e18); // 1.010 x (1 + 10 bps)
        vm.prank(guardian);
        vm.expectEmit(true, false, false, true);
        emit IExchange.InstrumentRetired(TIER_A, 1.01e18);
        ex.retire(TIER_A);
        source.setReverts(true, true);
        assertEq(ex.execPrice(TIER_A, true, true), 1.01e18);
        assertEq(ex.execPrice(TIER_A, false, false), 1.01e18);
        // alice's long settles at 1.01: the 1% vector (8.714963 - fee 0.435748 = 8.279215).
        (int256 pnl,, uint256 payout) = _closeMatchesPreview(alice, id, 1.01e18);
        assertEq(pnl, 8_279_215);
        assertEq(payout, 108_279_215);
        _assertSolvent();
        _assertTallyMatches();
    }

    // ------------------------------------------------------------ close: wins

    function test_close_longWin_onePercent_exactNumbers() public {
        // LP has $100 of cash ($95 net of the $5 fee claim) from a seeded loss, so the profit
        // is paid in full.
        _seedLpWithFullLoss(bob);
        uint256 lpBefore = ex.lpBalance();
        uint256 poolBefore = ex.feePool();
        int256 trackedBefore = tokenomics.trackedLpUsd();
        uint256 supplyBefore = confetti.totalSupply();
        assertEq(confetti.balanceOf(feeRecipient), 950e18); // team share of bob's 9,500 only

        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        // exit after 1 bps deadband = 1.009899; rawGain = 1000 * 0.009899 = 9.899000
        // scale(move 0.9899%) = 0.880388...; adjusted = 8.714963;
        // fee = 5% x 8.714963 = 0.43574815 -> 0.435748; profit = 8.714963 - 0.435748 = 8.279215.
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(id);
        assertEq(pnl, 8_279_215);
        assertEq(fee, 435_748);
        assertEq(payout, 108_279_215);

        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(id, alice, 1.01e18, 8_279_215, 435_748, 108_279_215, 0, 0);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, 108_279_215);
        assertEq(queued, 0);

        assertEq(ex.balanceOf(alice), 1000e6 + 8_279_215);
        assertEq(ex.lpBalance(), lpBefore - 8_279_215);
        assertEq(ex.feePool(), poolBefore + 435_748);
        // The tally and the breaker carry the whole adjusted gain, fee included.
        assertEq(tokenomics.trackedLpUsd(), trackedBefore - 8_714_963);
        assertEq(tokenomics.lastDeltaUsdc(), -8_714_963);
        // A win mints nothing, to the trader or to the team.
        assertEq(confetti.balanceOf(alice), 0);
        assertEq(confetti.balanceOf(feeRecipient), 950e18);
        assertEq(confetti.totalSupply(), supplyBefore);
        assertEq(ex.positions(id).owner, address(0));
        assertEq(ex.positionIdsOf(alice).length, 0);
        assertEq(ex.marginInUse(alice), 0);
        assertEq(ex.closeRequest(id).requestedAt, 0);
        // About 88% of the raw gain survives the impact curve at a 1% move.
        assertApproxEqRel(uint256(8_714_963), uint256(9_899_000) * 88 / 100, 0.01e18);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_close_longWin_tenthPercent_exactNumbers() public {
        _seedLpWithFullLoss(bob);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_001_000);
        // exit after deadband = 1.0008999; rawGain = 0.899900; scale = 0.722867...;
        // adjusted = 0.650508; fee = 5% x 0.650508 = 0.0325254 -> 0.032525;
        // profit = 0.650508 - 0.032525 = 0.617983.
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, 100_617_983);
        assertEq(queued, 0);
        assertEq(ex.feePool(), 5_000_000 + 32_525); // seed fee 5% x 100 = 5, plus this win's
        // Pure 0.1% move keeps ~74%; after the deadband eats 1 bps of it, ~72%.
        assertApproxEqRel(uint256(650_508), uint256(899_900) * 7229 / 10_000, 0.001e18);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_close_shortWin_exactNumbers() public {
        _seedLpWithFullLoss(bob);
        uint256 id = _open(alice, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 990_000);
        // exit after deadband (rounded up) = 0.990099; rawGain = 9.901000; adjusted = 8.716762;
        // fee = 5% x 8.716762 = 0.4358381 -> 0.435838; profit = 8.716762 - 0.435838 = 8.280924.
        (int256 pnl, uint256 fee,) = ex.previewClose(id);
        assertEq(pnl, 8_280_924);
        assertEq(fee, 435_838);
        (uint256 paid,) = _close(alice, id);
        assertEq(paid, 108_280_924);
        assertEq(tokenomics.lastDeltaUsdc(), -8_716_762);
        _assertSolvent();
    }

    function test_close_deadbandKillsTinyGain() public {
        _seedLpWithFullLoss(bob);
        uint256 lpBefore = ex.lpBalance();
        uint256 poolBefore = ex.feePool();
        uint256 deltas = tokenomics.deltaCalls();
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_000_050); // +0.5 bps, inside the 1 bps deadband
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(id);
        assertEq(pnl, 0);
        assertEq(fee, 0);
        assertEq(payout, MARGIN);
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, MARGIN);
        assertEq(queued, 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(ex.lpBalance(), lpBefore);
        assertEq(ex.feePool(), poolBefore);
        assertEq(tokenomics.deltaCalls(), deltas);
        assertEq(confetti.balanceOf(alice), 0);
    }

    function test_close_flatPriceReturnsMargin() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, MARGIN);
        assertEq(queued, 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(tokenomics.deltaCalls(), 0);
        assertEq(tokenomics.lossCalls(), 0);
    }

    function test_close_winCappedAtPayoutCapX_excessStaysInLp() public {
        // DESIGN 3b: $100 at 1000x ($100K notional) and a 10% move. The curve keeps about
        // $8,970 of the $9,989 raw gain (after the 1 bps deadband), far above the 50x cap of
        // $5,000; the cap applies before the win fee and the excess never leaves the LP.
        uint256 id = _open(alice, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 1_100_000);
        uint256 exit = ImpactLib.deadbandExit(1.1e18, true, 1);
        (uint256 gain, uint256 move) = ImpactLib.rawGain(100_000e6, ONE, exit, true);
        uint256 uncapped = ImpactLib.adjustedGain(gain, move, _launchCurve());
        assertGt(uncapped, 8_900e6);
        assertLt(uncapped, 9_000e6);
        uint256 cap = 50 * uint256(MARGIN);
        uint256 fee = ImpactLib.winFee(cap, ex.feeBps());
        uint256 profit = cap - fee;
        // fee = 5% x 5,000 = 250; profit = 5,000 - 250 = 4,750.
        assertEq(fee, 250e6);
        assertEq(profit, 4_750e6);

        (int256 pnl, uint256 pfee, uint256 payout) = ex.previewClose(id);
        assertEq(pnl, int256(profit));
        assertEq(pfee, fee);
        assertEq(payout, MARGIN + profit);

        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchange.PayoutCapped(id, cap, uncapped - cap);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(id, alice, 1.1e18, int256(profit), fee, MARGIN, profit, 0);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, MARGIN); // the LP is empty: margin now, the capped profit queued
        assertEq(queued, profit);
        assertEq(ex.feePool(), fee);
        assertEq(ex.queuedTotal(), profit);
        assertEq(tokenomics.lastDeltaUsdc(), -int256(cap)); // the LP's liability is the capped gain
        _assertSolvent();
        _assertTallyMatches();

        // At the 200x bound the same move pays the whole adjusted gain.
        vm.prank(owner);
        ex.setPositionCaps(TIER_A, 100_000e6, 200);
        _setPx(ASSET_A, RAW_ONE);
        id = _open(bob, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 1_100_000);
        (pnl,,) = ex.previewClose(id);
        assertEq(pnl, int256(uncapped - ImpactLib.winFee(uncapped, ex.feeBps())));
        // A win under the cap is untouched: 1% at 10x is 0.087x margin (adjusted 8.714963,
        // less the 5% fee of 0.435748 = 8.279215, as in the exact-numbers test).
        _setPx(ASSET_A, RAW_ONE);
        id = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        (pnl,,) = ex.previewClose(id);
        assertEq(pnl, 8_279_215);
    }

    // ---------------------------------------------------------- close: losses

    function test_close_longLoss_exactNumbers() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        // loss = 1000 * 0.005 = 5.000000; fee = 5% x 5 = 0.250000 (queue empty);
        // mint basis = 5 - 0.25 = 4.75; 100 CONFETTI per $1 -> 475 CONFETTI to alice, and the
        // team share 10% x 475 = 47.5 CONFETTI to the fee recipient on top.
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(id);
        assertEq(pnl, -5_000_000);
        assertEq(fee, 250_000);
        assertEq(payout, 95_000_000);

        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchange.TeamMinted(feeRecipient, 47.5e18);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(id, alice, 0.995e18, -5_000_000, 250_000, 95_000_000, 0, 475e18);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, 95_000_000);
        assertEq(queued, 0);

        assertEq(ex.balanceOf(alice), 995e6);
        assertEq(ex.lpBalance(), 5_000_000);
        assertEq(ex.feePool(), 250_000);
        assertEq(confetti.balanceOf(alice), 475e18);
        assertEq(confetti.balanceOf(feeRecipient), 47.5e18);
        assertEq(confetti.totalSupply(), 522.5e18); // 475 + 47.5
        assertEq(tokenomics.totalMinted(), 475e18); // the tally counts the trader's mint only
        assertEq(tokenomics.lastLossBasisUsdc(), 4_750_000);
        assertEq(tokenomics.lastDeltaUsdc(), 4_750_000);
        assertEq(tokenomics.trackedLpUsd(), 4_750_000);
        // recordLoss must run before recordLpDelta so the rate reflects the LP before the loss.
        assertLt(tokenomics.lastLossSequence(), tokenomics.lastDeltaSequence());
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_close_shortLoss() public {
        uint256 id = _open(alice, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 1_005_000);
        (uint256 paid,) = _close(alice, id);
        // Same $5 loss as the long: basis 5 - 5% x 5 = 4.75 -> 475 CONFETTI, team 47.5.
        assertEq(paid, 95_000_000);
        assertEq(confetti.balanceOf(alice), 475e18);
        assertEq(confetti.balanceOf(feeRecipient), 47.5e18);
        _assertSolvent();
    }

    function test_close_lossCappedAtMargin() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 800_000); // -20% at 10x would be -$200; capped at the $100 margin
        (uint256 paid,) = _close(alice, id);
        // loss capped at 100; fee = 5% x 100 = 5; basis 95 -> 9,500 CONFETTI, team 950.
        assertEq(paid, 0);
        assertEq(ex.balanceOf(alice), 900e6);
        assertEq(ex.lpBalance(), 100e6);
        assertEq(ex.feePool(), 5e6);
        assertEq(confetti.balanceOf(alice), 9500e18);
        assertEq(confetti.balanceOf(feeRecipient), 950e18);
        assertEq(tokenomics.trackedLpUsd(), 95e6);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_close_onlyOwner_andUnknown() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotPositionOwner.selector, id, bob));
        ex.requestClose(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownPosition.selector, 42));
        ex.requestClose(42);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownPosition.selector, 42));
        ex.previewClose(42);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownPosition.selector, 42));
        ex.bustPrice(42);
        // Closing twice fails: the position is gone.
        _close(alice, id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownPosition.selector, id));
        ex.requestClose(id);
    }

    // ------------------------------------------------------------ liquidation

    function test_liquidate_longAtBustPrice_withBounty() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        assertEq(ex.bustPrice(id), 0.905e18);

        // One wei above bust: not liquidatable.
        _setPx(ASSET_A, 905_001);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotLiquidatable.selector, id, 905_001e12, 0.905e18));
        ex.liquidate(id);

        // bounty = 0.5% x 100 = 0.5; fee = 5% x 100 = 5; LP gain = 100 - 0.5 - 5 = 94.5.
        // Mint on the full margin: 100 x 100 = 10,000 CONFETTI, team 10% x 10,000 = 1,000.
        _setPx(ASSET_A, 905_000);
        vm.prank(liquidator);
        vm.expectEmit(true, false, false, true);
        emit IExchange.TeamMinted(feeRecipient, 1_000e18);
        vm.expectEmit(true, true, true, true);
        emit IExchange.PositionLiquidated(id, alice, liquidator, 0.905e18, MARGIN, 500_000, 5_000_000, 10_000e18);
        uint256 bounty = ex.liquidate(id);
        assertEq(bounty, 500_000);

        assertEq(ex.balanceOf(liquidator), 500_000);
        assertEq(ex.balanceOf(alice), 900e6);
        assertEq(ex.marginInUse(alice), 0);
        assertEq(ex.lpBalance(), 99_500_000); // margin minus bounty; the fee is a claim on it
        assertEq(ex.feePool(), 5_000_000);
        assertEq(confetti.balanceOf(alice), 10_000e18); // minted on the full margin
        assertEq(confetti.balanceOf(feeRecipient), 1_000e18);
        assertEq(confetti.balanceOf(liquidator), 0);
        assertEq(tokenomics.lastLossBasisUsdc(), 100e6);
        assertEq(tokenomics.lastDeltaUsdc(), 94_500_000);
        assertLt(tokenomics.lastLossSequence(), tokenomics.lastDeltaSequence());
        assertEq(ex.positions(id).owner, address(0));
        (uint256 longOi,) = ex.openInterest(TIER_A);
        assertEq(longOi, 0);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_liquidate_short() public {
        uint256 id = _open(alice, TIER_A, false, MARGIN, LEV);
        assertEq(ex.bustPrice(id), 1.095e18);
        _setPx(ASSET_A, 1_094_999);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotLiquidatable.selector, id, 1_094_999e12, 1.095e18));
        ex.liquidate(id);
        _setPx(ASSET_A, 1_095_000);
        vm.prank(liquidator);
        assertEq(ex.liquidate(id), 500_000);
        _assertSolvent();
    }

    function test_liquidate_thousandX_fiveBpsMove() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, 1000);
        assertEq(ex.bustPrice(id), 0.9995e18);
        _setPx(ASSET_A, 999_501); // -4.99 bps: one tick short of bust
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotLiquidatable.selector, id, 999_501e12, 0.9995e18));
        ex.liquidate(id);
        _setPx(ASSET_A, 999_500); // -5 bps busts a 1000x long
        vm.prank(liquidator);
        ex.liquidate(id);
        assertEq(ex.lpBalance(), 99_500_000);
    }

    function test_liquidate_whileQueueActive_noFee() public {
        _queueOneWin(); // alice is owed; queue non-empty, LP empty
        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchange.PositionLiquidated(id, bob, liquidator, 0.9e18, MARGIN, 500_000, 0, 10_000e18);
        ex.liquidate(id);
        assertEq(ex.feePool(), 2_235_395); // only alice's win fee, no liquidation fee
        assertEq(ex.lpBalance(), 99_500_000);
        assertEq(tokenomics.lastDeltaUsdc(), 99_500_000); // 100 - 0.5 bounty, nothing carved
        assertEq(confetti.balanceOf(bob), 10_000e18);
        assertEq(confetti.balanceOf(feeRecipient), 1_000e18); // the team share is not fee-gated
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_liquidate_unknownPosition() public {
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownPosition.selector, 5));
        ex.liquidate(5);
    }

    /// @dev Oracle only: a book pushed past bust never liquidates, the oracle at bust always
    ///      does, whatever the book shows.
    function test_liquidate_oracleOnly_pushedBookNeverLiquidates_oracleAtBustDoes() public {
        // 1000x long at 1.000: bust = 1.000 x (1 - 5 bps) = 0.9995 (the gap rule, not 0.95 / L).
        uint256 id = _open(alice, TIER_A, true, MARGIN, 1000);
        assertEq(ex.bustPrice(id), 0.9995e18);
        _setQuotes(ASSET_A, 900_000, RAW_ONE); // book 10% under, oracle unmoved
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotLiquidatable.selector, id, ONE, 0.9995e18));
        ex.liquidate(id);
        // Oracle exactly on bust with the book 10% over: liquidates at the oracle. Same split as
        // any liquidation: bounty 0.5, fee 5, mint 10,000.
        _setQuotes(ASSET_A, 1_100_000, 999_500);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchange.PositionLiquidated(id, alice, liquidator, 0.9995e18, MARGIN, 500_000, 5_000_000, 10_000e18);
        assertEq(ex.liquidate(id), 500_000);
        assertEq(ex.lpBalance(), 99_500_000);

        // Short mirror: bust 1.0005; book 10% over and oracle flat holds; oracle at bust busts.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, false, MARGIN, 1000);
        assertEq(ex.bustPrice(id), 1.0005e18);
        _setQuotes(ASSET_A, 1_100_000, RAW_ONE);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotLiquidatable.selector, id, ONE, 1.0005e18));
        ex.liquidate(id);
        _setQuotes(ASSET_A, 900_000, 1_000_500);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchange.PositionLiquidated(id, alice, liquidator, 1.0005e18, MARGIN, 500_000, 5_000_000, 10_000e18);
        assertEq(ex.liquidate(id), 500_000);
        _assertSolvent();
        _assertTallyMatches();
    }

    // ------------------------------------------------------------------ queue

    /// @dev alice wins on a 5% move of $1000 with an empty LP: adjusted gain 44.707911;
    ///      fee = 5% x 44.707911 = 2.23539555 -> 2.235395; profit = 44.707911 - 2.235395 =
    ///      42.472516, all queued; margin back now.
    function _queueOneWin() internal returns (uint256 queued) {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_050_000);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.QueueAppended(0, alice, 42_472_516);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(id, alice, 1.05e18, 42_472_516, 2_235_395, MARGIN, 42_472_516, 0);
        (uint256 paid, uint256 q) = ex.executeClose(id);
        assertEq(paid, MARGIN);
        assertEq(q, 42_472_516);
        _setPx(ASSET_A, RAW_ONE);
        return q;
    }

    function test_win_queuedWhenLpEmpty() public {
        _queueOneWin();
        assertEq(ex.balanceOf(alice), 1000e6); // margin returned immediately
        assertEq(ex.queueLength(), 1);
        assertEq(ex.queueHead(), 0);
        assertEq(ex.queuedTotal(), 42_472_516);
        (address recipient, uint256 owed) = ex.queueEntry(0);
        assertEq(recipient, alice);
        assertEq(owed, 42_472_516);
        assertEq(ex.feePool(), 2_235_395);
        assertEq(ex.lpBalance(), 0);
        assertEq(confetti.totalSupply(), 0); // a queued win mints nothing, team share included
        assertEq(tokenomics.trackedLpUsd(), -44_707_911); // adjusted gain, fee included
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_win_partialPayThenQueueRemainder() public {
        // LP holds $5 of cash from bob's small loss; alice's $42.47 profit (5% move, as in
        // _queueOneWin) is paid $5 now, the rest queued: 42.472516 - 5 = 37.472516.
        uint256 lid = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _close(bob, lid);
        assertEq(ex.lpBalance(), 5_000_000);
        _setPx(ASSET_A, RAW_ONE);

        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_050_000);
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, MARGIN + 5_000_000);
        assertEq(queued, 42_472_516 - 5_000_000);
        assertEq(ex.lpBalance(), 0);
        assertEq(ex.queuedTotal(), 37_472_516);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_win_queuedWhileQueueActiveEvenIfLpHasCash() public {
        _queueOneWin();
        // carol's loss puts $50 in the LP but the queue is still owed, so bob's win is queued too.
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 950_000);
        _close(carol, cid);
        assertEq(ex.lpBalance(), 50e6);
        _setPx(ASSET_A, RAW_ONE);

        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_020_000);
        // 2% move: adjusted 17.711913; fee = 5% x 17.711913 = 0.88559565 -> 0.885595;
        // profit = 17.711913 - 0.885595 = 16.826318, queued behind alice despite the $50.
        _requestClose(bob, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.QueueAppended(1, bob, 16_826_318);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, MARGIN);
        assertEq(queued, 16_826_318);
        assertEq(ex.lpBalance(), 50e6);
        assertEq(ex.queueLength(), 2);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_loss_whileQueueActive_noFee_fullBasisMint() public {
        _queueOneWin();
        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        (uint256 paid,) = _close(bob, id);
        assertEq(paid, 95_000_000);
        assertEq(ex.feePool(), 2_235_395); // alice's win fee only: no loss fee carved
        assertEq(ex.lpBalance(), 5_000_000);
        assertEq(tokenomics.lastLossBasisUsdc(), 5_000_000); // full loss is the mint basis
        assertEq(confetti.balanceOf(bob), 500e18); // 5 x 100
        assertEq(confetti.balanceOf(feeRecipient), 50e18); // team 10% x 500
        _assertSolvent();
        _assertTallyMatches();
    }

    /// @dev `previewClose` carves the loss fee exactly as the close would at that moment: none
    ///      while the queue is owed, the stamped rate once it is drained. A preview that ignored
    ///      the queue would quote $0.25 here while the close takes nothing, or quote nothing
    ///      once the queue is empty while the close takes $0.25.
    function test_previewClose_lossFee_followsQueueState_matchesClose() public {
        _queueOneWin(); // alice is owed 42.472516; the LP is empty
        uint256 bid = _open(bob, TIER_A, true, MARGIN, LEV);
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);

        // Queue active: no fee in the preview, none in the close, full-loss mint basis.
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(bid);
        assertEq(pnl, -5_000_000);
        assertEq(fee, 0);
        assertEq(payout, 95_000_000);
        _requestClose(bob, bid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(bid, bob, 0.995e18, -5_000_000, 0, 95_000_000, 0, 500e18);
        (uint256 paid,) = ex.executeClose(bid);
        assertEq(paid, 95_000_000);
        assertEq(ex.feePool(), 2_235_395); // alice's win fee only
        (, fee,) = ex.previewClose(did);
        assertEq(fee, 0);

        // carol's $50 loss on another market refills the LP (no fee either) and a harvest
        // drains the queue; the same open position now previews and closes with the 5% fee.
        uint256 cid = _open(carol, TIER_B, true, MARGIN, LEV);
        _setPx(ASSET_B, 950_000);
        _close(carol, cid);
        assertEq(ex.lpBalance(), 55_000_000);
        ex.harvest(1);
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.lpBalance(), 55_000_000 - 42_472_516);
        (pnl, fee, payout) = ex.previewClose(did);
        assertEq(pnl, -5_000_000);
        assertEq(fee, 250_000);
        assertEq(payout, 95_000_000);
        _requestClose(dave, did);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(did, dave, 0.995e18, -5_000_000, 250_000, 95_000_000, 0, 475e18);
        (paid,) = ex.executeClose(did);
        assertEq(paid, 95_000_000);
        assertEq(ex.feePool(), 2_235_395 + 250_000);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_harvest_fifoOrderAndPartialPayments() public {
        // Two queued winners (profits after the 5% fee): alice $42.472516 (5% move),
        // bob $16.826318 (2% move).
        _queueOneWin();
        uint256 bid = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_020_000);
        _close(bob, bid);
        _setPx(ASSET_A, RAW_ONE);
        assertEq(ex.queuedTotal(), 42_472_516 + 16_826_318);

        // carol loses $50 (queue active: no fee).
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 950_000);
        _close(carol, cid);
        _setPx(ASSET_A, RAW_ONE);
        assertEq(ex.lpBalance(), 50e6);

        // harvest(1): alice is paid in full and retired; bob untouched. LP 50 - 42.472516 =
        // 7.527484.
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchange.QueuePaid(0, alice, 42_472_516, 0);
        (uint256 n, uint256 paid) = ex.harvest(1);
        assertEq(n, 1);
        assertEq(paid, 42_472_516);
        assertEq(ex.balanceOf(alice), 1000e6 + 42_472_516);
        assertEq(ex.queueHead(), 1);
        assertEq(ex.lpBalance(), 7_527_484);

        // harvest(5): bob gets the remaining $7.527484 and is still owed 16.826318 - 7.527484 =
        // 9.298834; the entry stays at the head and the LP empties.
        vm.expectEmit(true, true, false, true);
        emit IExchange.QueuePaid(1, bob, 7_527_484, 9_298_834);
        (n, paid) = ex.harvest(5);
        assertEq(n, 1);
        assertEq(paid, 7_527_484);
        assertEq(ex.queueHead(), 1);
        (, uint256 owed) = ex.queueEntry(1);
        assertEq(owed, 9_298_834);
        assertEq(ex.queuedTotal(), 9_298_834);
        assertEq(ex.lpBalance(), 0);

        // Nothing to pay with: no revert, nothing happens.
        (n, paid) = ex.harvest(5);
        assertEq(n, 0);
        assertEq(paid, 0);

        // dave loses $50 (bob is still owed, so no fee); the rest of bob's entry is paid and
        // the queue empties: LP 50 - 9.298834 = 40.701166.
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 950_000);
        _close(dave, did);
        (n, paid) = ex.harvest(5);
        assertEq(n, 1);
        assertEq(paid, 9_298_834);
        assertEq(ex.balanceOf(bob), 1000e6 + 16_826_318);
        assertEq(ex.queueHead(), ex.queueLength());
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.lpBalance(), 40_701_166);
        _assertSolvent();
        _assertTallyMatches();

        vm.expectRevert(IExchange.QueueEmpty.selector);
        ex.harvest(1);
    }

    function test_harvest_emptyQueueReverts() public {
        vm.expectRevert(IExchange.QueueEmpty.selector);
        ex.harvest(10);
    }

    // ------------------------------------------------------------------- fees

    /// @dev Decision 3: the staker share starts at 0, so a push hands the whole pool to the fee
    ///      recipient and never calls Staking; the owner may set any share up to 100%.
    function test_pushFees_defaultAllToRecipient_stakerShareSettable() public {
        assertEq(ex.stakerFeeShareBps(), 0);
        _seedLpWithFullLoss(bob); // LP $100, pool 5% x 100 = $5
        uint256 lpBefore = ex.lpBalance();
        int256 trackedBefore = tokenomics.trackedLpUsd();

        vm.prank(stranger);
        vm.expectEmit(false, false, false, true);
        emit IExchange.FeesPushed(0, 5_000_000);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 5_000_000);
        assertEq(ex.feePool(), 0);
        assertEq(ex.lpBalance(), lpBefore - 5_000_000);
        assertEq(ex.balanceOf(feeRecipient), 5_000_000);
        assertEq(staking.notifyCalls(), 0);
        assertEq(usdc.balanceOf(address(staking)), 0);
        assertEq(tokenomics.trackedLpUsd(), trackedBefore); // fees were already out of the tally
        _assertSolvent();
        _assertTallyMatches();

        // Owner only, at most 100%, announced.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setStakerFeeShare(4000);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchange.Param.StakerFeeShareBps, 10_001));
        ex.setStakerFeeShare(10_001);
        vm.expectEmit(false, false, false, true);
        emit IExchange.StakerFeeShareSet(4000);
        ex.setStakerFeeShare(4000);
        vm.stopPrank();
        assertEq(ex.stakerFeeShareBps(), 4000);

        // At 40%: stakers = 40% x 5 = 2 (2 of the 5 fee points); recipient = 5 - 2 = 3.
        _seedLpWithFullLoss(carol);
        vm.expectEmit(false, false, false, true);
        emit IExchange.FeesPushed(2_000_000, 3_000_000);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 2_000_000);
        assertEq(toRecipient, 3_000_000);
        assertEq(ex.balanceOf(feeRecipient), 8_000_000);
        assertEq(usdc.balanceOf(address(staking)), 2_000_000);
        assertEq(staking.notifyCalls(), 1);
        assertEq(staking.lastNotifier(), address(ex));
        assertEq(staking.lastNotifiedUsdc(), 2_000_000);
        assertEq(usdc.allowance(address(ex), address(staking)), 0);

        // Rounding favours the recipient. A 25-tick drop on $10 at 1x loses 250 units
        // (0.000250 USDC); fee = 5% x 250 = 12.5 -> 12; stakers 40% x 12 = 4.8 -> 4,
        // recipient 12 - 4 = 8.
        uint256 id = _open(alice, TIER_A, true, 10e6, 1);
        _setPx(ASSET_A, 999_975);
        _close(alice, id);
        assertEq(ex.feePool(), 12);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 4);
        assertEq(toRecipient, 8);

        // 100%: everything to stakers.
        vm.prank(owner);
        ex.setStakerFeeShare(10_000);
        _seedLpWithFullLoss(dave);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 5_000_000);
        assertEq(toRecipient, 0);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_pushFees_dustPool_allToRecipient_skipsZeroStakerReward() public {
        vm.prank(owner);
        ex.setStakerFeeShare(4000);
        // $10 at 1x loses 10 units per raw tick: 2 ticks -> loss 20, fee 5% x 20 = 1.
        uint256 id = _open(alice, TIER_A, true, 10e6, 1);
        _setPx(ASSET_A, 999_998);
        _close(alice, id);
        assertEq(ex.feePool(), 1);
        // Pool 1: stakers 40% x 1 = 0.4 -> 0, recipient 1; Staking (which rejects a zero
        // reward) is never called.
        vm.expectEmit(false, false, false, true);
        emit IExchange.FeesPushed(0, 1);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 1);
        assertEq(staking.notifyCalls(), 0);
        assertEq(usdc.balanceOf(address(staking)), 0);
        assertEq(usdc.allowance(address(ex), address(staking)), 0);
        assertEq(ex.balanceOf(feeRecipient), 1);
        assertEq(ex.feePool(), 0);
        assertEq(ex.lpBalance(), 20 - 1);
        _assertSolvent();
        _assertTallyMatches();

        // Pool 2: 4 ticks -> loss 40, fee 2; stakers 40% x 2 = 0.8 -> 0, recipient 2.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, 10e6, 1);
        _setPx(ASSET_A, 999_996);
        _close(alice, id);
        assertEq(ex.feePool(), 2);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 2);
        assertEq(staking.notifyCalls(), 0);
        assertEq(ex.balanceOf(feeRecipient), 1 + 2);

        // Pool 7: 14 ticks -> loss 140, fee 7; stakers 40% x 7 = 2.8 -> 2, recipient 7 - 2 = 5.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, 10e6, 1);
        _setPx(ASSET_A, 999_986);
        _close(alice, id);
        assertEq(ex.feePool(), 7);
        vm.expectEmit(false, false, false, true);
        emit IExchange.FeesPushed(2, 5);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 2);
        assertEq(toRecipient, 5);
        assertEq(staking.notifyCalls(), 1);
        assertEq(staking.lastNotifiedUsdc(), 2);
        assertEq(usdc.balanceOf(address(staking)), 2);
        assertEq(ex.balanceOf(feeRecipient), 1 + 2 + 5);
        assertEq(ex.lpBalance(), (20 - 1) + (40 - 2) + (140 - 7));
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_pushFees_gatedByQueueAndLpCash() public {
        vm.prank(owner);
        ex.setStakerFeeShare(4000);
        vm.expectRevert(IExchange.NothingToPush.selector); // empty pool
        ex.pushFees();

        _queueOneWin(); // pool 2.235395 but queue active
        vm.expectRevert(IExchange.NothingToPush.selector);
        ex.pushFees();

        // bob loses $50: LP $50, queue still owed $42.47 -> still gated.
        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 950_000);
        _close(bob, id);
        vm.expectRevert(IExchange.NothingToPush.selector);
        ex.pushFees();

        // Harvest clears the queue; LP 50 - 42.472516 = $7.527484 covers the $2.235395 pool.
        // stakers = 40% x 2.235395 = 0.894158; recipient = 2.235395 - 0.894158 = 1.341237.
        ex.harvest(10);
        assertEq(ex.lpBalance(), 7_527_484);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 894_158);
        assertEq(toRecipient, 1_341_237);
        assertEq(ex.lpBalance(), 7_527_484 - 2_235_395);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_pushFees_revertsWhenLpCannotCoverPool() public {
        // bob's loss builds a $5 pool; alice's win then drains LP cash below the pool.
        _seedLpWithFullLoss(bob); // LP 100, pool 5
        uint256 id = _open(alice, TIER_A, true, 900e6, 10); // $9000 notional
        _setPx(ASSET_A, 1_020_000);
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, 900e6 + 100e6); // every dollar of LP cash goes to alice
        assertGt(queued, 0);
        assertEq(ex.lpBalance(), 0);
        ex.harvest(10); // nothing to pay with, but keeps the queue non-empty
        vm.expectRevert(IExchange.NothingToPush.selector);
        ex.pushFees();

        // Refill the LP and clear the queue, then a push works.
        _setPx(ASSET_A, RAW_ONE);
        _seedLpWithFullLoss(carol);
        _seedLpWithFullLoss(dave);
        ex.harvest(10);
        assertEq(ex.queuedTotal(), 0);
        assertGe(ex.lpBalance(), ex.feePool());
        (uint256 a, uint256 b) = ex.pushFees();
        assertGt(a + b, 0);
        _assertSolvent();
        _assertTallyMatches();
    }

    // ------------------------------------------------------ fee rate setter

    function test_setFeeBps_ownerOnly_boundedAtFivePercent_emits() public {
        // Starts at the 5% cap; the constructor announces it.
        assertEq(ex.feeBps(), 500);
        assertEq(ex.MAX_FEE_BPS(), 500);
        vm.expectEmit(false, false, false, true);
        emit IExchange.FeeBpsSet(500);
        new Exchange(
            usdc,
            oracle,
            IConfetti(address(confetti)),
            ITokenomics(address(tokenomics)),
            IStaking(address(staking)),
            owner,
            feeRecipient
        );

        // Owner only: the guardian, the keeper and strangers are refused.
        address[3] memory notOwner = [stranger, guardian, keeper];
        for (uint256 i = 0; i < notOwner.length; i++) {
            vm.prank(notOwner[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, notOwner[i]));
            ex.setFeeBps(100);
        }

        // Never above 5%.
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchange.Param.FeeBps, 501));
        ex.setFeeBps(501);
        vm.expectRevert(_oob(IExchange.Param.FeeBps, type(uint16).max));
        ex.setFeeBps(type(uint16).max);
        assertEq(ex.feeBps(), 500);

        // Anything in 0..500 is accepted and announced, including back up to the cap.
        vm.expectEmit(false, false, false, true);
        emit IExchange.FeeBpsSet(100);
        ex.setFeeBps(100);
        assertEq(ex.feeBps(), 100);
        vm.expectEmit(false, false, false, true);
        emit IExchange.FeeBpsSet(0);
        ex.setFeeBps(0);
        assertEq(ex.feeBps(), 0);
        vm.expectEmit(false, false, false, true);
        emit IExchange.FeeBpsSet(500);
        ex.setFeeBps(500);
        assertEq(ex.feeBps(), 500);
        vm.stopPrank();
    }

    function test_setFeeBps_lowerRate_appliesToNextWinLossAndLiquidation() public {
        vm.prank(owner);
        ex.setFeeBps(100); // 1%

        // Loss: bob loses his whole $100. fee = 1% x 100 = 1; basis 99 -> 9,900 CONFETTI,
        // team 10% x 9,900 = 990.
        uint256 bid = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        (, uint256 fee,) = ex.previewClose(bid);
        assertEq(fee, 1_000_000);
        _requestClose(bob, bid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(bid, bob, 0.9e18, -100e6, 1_000_000, 0, 0, 9_900e18);
        ex.executeClose(bid);
        assertEq(ex.feePool(), 1_000_000);
        assertEq(tokenomics.lastLossBasisUsdc(), 99e6);
        assertEq(tokenomics.trackedLpUsd(), 99e6);
        assertEq(confetti.balanceOf(feeRecipient), 990e18);
        _setPx(ASSET_A, RAW_ONE);

        // Win: alice's 1% move, adjusted 8.714963; fee = 1% x 8.714963 = 0.08714963 ->
        // 0.087149; profit = 8.714963 - 0.087149 = 8.627814, paid from the $100 of LP cash.
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        _requestClose(alice, aid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(aid, alice, 1.01e18, 8_627_814, 87_149, 108_627_814, 0, 0);
        ex.executeClose(aid);
        assertEq(ex.feePool(), 1_000_000 + 87_149);
        _setPx(ASSET_A, RAW_ONE);

        // Liquidation: dave's $100 margin. bounty 0.5% x 100 = 0.5; fee = 1% x 100 = 1;
        // LP gain = 100 - 0.5 - 1 = 98.5.
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchange.PositionLiquidated(did, dave, liquidator, 0.9e18, MARGIN, 500_000, 1_000_000, 10_000e18);
        ex.liquidate(did);
        assertEq(ex.feePool(), 1_000_000 + 87_149 + 1_000_000);
        assertEq(tokenomics.lastDeltaUsdc(), 98_500_000);
        _setPx(ASSET_A, RAW_ONE);

        // Raised back to 5%, the next loss carves 5% again: 5% x 5 = 0.25 on carol's $5.
        vm.prank(owner);
        ex.setFeeBps(500);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        (, fee,) = ex.previewClose(cid);
        assertEq(fee, 250_000);
        _close(carol, cid);
        assertEq(ex.feePool(), 2_087_149 + 250_000);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_setFeeBps_zero_noFeeAnywhere_nothingToPush() public {
        vm.prank(owner);
        ex.setFeeBps(0);

        // Loss: bob's whole $100 is the LP gain and the mint basis: 10,000 CONFETTI, team 1,000.
        _seedLpWithFullLoss(bob);
        assertEq(ex.feePool(), 0);
        assertEq(ex.lpBalance(), 100e6);
        assertEq(tokenomics.trackedLpUsd(), 100e6);
        assertEq(confetti.balanceOf(bob), 10_000e18);
        assertEq(confetti.balanceOf(feeRecipient), 1_000e18);

        // Win: the whole adjusted gain 8.714963 is profit.
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(aid);
        assertEq(pnl, 8_714_963);
        assertEq(fee, 0);
        assertEq(payout, 108_714_963);
        (uint256 paid,) = _close(alice, aid);
        assertEq(paid, 108_714_963);
        _setPx(ASSET_A, RAW_ONE);

        // Liquidation: the bounty is unaffected; no fee, so the LP gain is 100 - 0.5 = 99.5.
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchange.PositionLiquidated(did, dave, liquidator, 0.9e18, MARGIN, 500_000, 0, 10_000e18);
        ex.liquidate(did);
        assertEq(tokenomics.lastDeltaUsdc(), 99_500_000);
        _setPx(ASSET_A, RAW_ONE);

        // The pool never filled: there is nothing to push.
        assertEq(ex.feePool(), 0);
        vm.expectRevert(IExchange.NothingToPush.selector);
        ex.pushFees();
        _assertSolvent();
        _assertTallyMatches();

        // Raised back to 5%: carol's $5 loss carves 0.25, which pushes wholly to the recipient
        // at the default zero staker share.
        vm.prank(owner);
        ex.setFeeBps(500);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _close(carol, cid);
        assertEq(ex.feePool(), 250_000);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 250_000);
        _assertSolvent();
        _assertTallyMatches();
    }

    // ------------------------------------------------- terms stamped at open

    /// @dev DESIGN 5: the owner lowers the payout cap after alice opened. Her close still pays
    ///      the 50x she opened at; bob, who opens after the change, gets the new 10x. The
    ///      preview agrees with the close in both cases.
    function test_stamp_payoutCapLoweredAfterOpen_closeKeepsOpenTimeCap() public {
        // $100 at 1000x and a 10% move: the curve keeps 8,970.297561 of the 9,989 raw gain
        // (after the 1 bps deadband); capped at 50 x 100 = 5,000; fee 5% = 250; profit 4,750.
        uint256 aid = _open(alice, TIER_A, true, MARGIN, 1000);
        assertEq(ex.positions(aid).payoutCapX, 50);
        vm.prank(owner);
        ex.setPositionCaps(TIER_A, 100_000e6, 10);
        assertEq(ex.instrument(TIER_A).payoutCapX, 10);
        assertEq(ex.positions(aid).payoutCapX, 50); // the stamp is untouched
        _setPx(ASSET_A, 1_100_000);

        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(aid);
        assertEq(pnl, 4_750e6);
        assertEq(fee, 250e6);
        assertEq(payout, MARGIN + 4_750e6);
        _requestClose(alice, aid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchange.PayoutCapped(aid, 5_000e6, 3_970_297_561);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(aid, alice, 1.1e18, 4_750e6, 250e6, MARGIN, 4_750e6, 0);
        (uint256 paid, uint256 queued) = ex.executeClose(aid);
        assertEq(paid, MARGIN); // the LP is empty: margin now, the capped profit queued
        assertEq(queued, 4_750e6);
        assertEq(tokenomics.lastDeltaUsdc(), -5_000e6);

        // Bob opens after the change: capped at 10 x 100 = 1,000; fee 50; profit 950.
        _setPx(ASSET_A, RAW_ONE);
        uint256 bid = _open(bob, TIER_A, true, MARGIN, 1000);
        assertEq(ex.positions(bid).payoutCapX, 10);
        _setPx(ASSET_A, 1_100_000);
        (pnl, fee, payout) = ex.previewClose(bid);
        assertEq(pnl, 950e6);
        assertEq(fee, 50e6);
        assertEq(payout, MARGIN + 950e6);
        _requestClose(bob, bid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchange.PayoutCapped(bid, 1_000e6, 7_970_297_561);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(bid, bob, 1.1e18, 950e6, 50e6, MARGIN, 950e6, 0);
        (paid, queued) = ex.executeClose(bid);
        assertEq(paid, MARGIN);
        assertEq(queued, 950e6);
        assertEq(ex.queuedTotal(), 4_750e6 + 950e6);
        assertEq(ex.feePool(), 250e6 + 50e6);
        _assertSolvent();
        _assertTallyMatches();
    }

    /// @dev DESIGN 5: the owner widens the deadband after alice opened. Her win settles on the
    ///      1 bps she opened at; carol, who opens after the change, settles on 50 bps.
    function test_stamp_deadbandRaisedAfterOpen_closeKeepsOpenTimeDeadband() public {
        _seedLpWithFullLoss(bob); // LP cash so both wins are paid in full
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(aid).deadbandBps, 1);
        // Same curve, deadband 1 -> 50 bps (the owner bound).
        vm.prank(owner);
        ex.setInstrumentParams(TIER_A, 50, 10, 1000, 15_000, 20_000e6, 130_000_000e6);
        assertEq(ex.instrument(TIER_A).deadbandBps, 50);
        assertEq(ex.positions(aid).deadbandBps, 1); // the stamp is untouched
        _setPx(ASSET_A, 1_010_000);

        // 1 bps: exit 1.009899, adjusted 8.714963, fee 0.435748, profit 8.279215 (the
        // exact-numbers test). On 50 bps the same move would pay 4.051752 (carol, below).
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(aid);
        assertEq(pnl, 8_279_215);
        assertEq(fee, 435_748);
        assertEq(payout, 108_279_215);
        _requestClose(alice, aid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(aid, alice, 1.01e18, 8_279_215, 435_748, 108_279_215, 0, 0);
        (uint256 paid, uint256 queued) = ex.executeClose(aid);
        assertEq(paid, 108_279_215);
        assertEq(queued, 0);

        // Carol opens after the change: exit = 1.01 x 0.995 = 1.00495; rawGain = 1000 x 0.00495
        // = 4.950000; scale(0.495%) = 0.9 / (1 + 1/(0.00495 x 15000) + 20000/(0.00495 x 130e6))
        // = 0.9 / 1.044548 = 0.861616...; adjusted = 4.265002; fee = 5% x 4.265002 = 0.2132501
        // -> 0.213250; profit = 4.265002 - 0.213250 = 4.051752.
        _setPx(ASSET_A, RAW_ONE);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(cid).deadbandBps, 50);
        _setPx(ASSET_A, 1_010_000);
        (pnl, fee, payout) = ex.previewClose(cid);
        assertEq(pnl, 4_051_752);
        assertEq(fee, 213_250);
        assertEq(payout, 104_051_752);
        _requestClose(carol, cid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(cid, carol, 1.01e18, 4_051_752, 213_250, 104_051_752, 0, 0);
        (paid, queued) = ex.executeClose(cid);
        assertEq(paid, 104_051_752);
        assertEq(queued, 0);
        _assertSolvent();
        _assertTallyMatches();
    }

    /// @dev DESIGN 5: the owner lowers the fee to 1% after three positions opened at 5%. The
    ///      win, the loss and the liquidation all carve 5%, and previewClose agrees; dave, who
    ///      opens after the change, pays 1%.
    function test_stamp_feeChangedAfterOpen_closeLossAndLiquidationKeepOpenTimeRate() public {
        _seedLpWithFullLoss(bob); // LP $100, pool $5
        uint256 win = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 loss = _open(carol, TIER_A, true, MARGIN, LEV);
        uint256 liq = _open(bob, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(win).feeBps, 500);
        vm.prank(owner);
        ex.setFeeBps(100);
        assertEq(ex.feeBps(), 100);
        assertEq(ex.positions(win).feeBps, 500); // the stamps are untouched
        assertEq(ex.positions(loss).feeBps, 500);
        assertEq(ex.positions(liq).feeBps, 500);

        // Win at 5%: adjusted 8.714963, fee 0.435748 (1% would be 0.087149), profit 8.279215.
        _setPx(ASSET_A, 1_010_000);
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(win);
        assertEq(pnl, 8_279_215);
        assertEq(fee, 435_748);
        assertEq(payout, 108_279_215);
        _requestClose(alice, win);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(win, alice, 1.01e18, 8_279_215, 435_748, 108_279_215, 0, 0);
        (uint256 paid,) = ex.executeClose(win);
        assertEq(paid, 108_279_215);
        assertEq(ex.feePool(), 5_000_000 + 435_748);

        // Loss at 5%: carol loses $5; fee 0.25 (1% would be 0.05); basis 4.75 -> 475 CONFETTI.
        _setPx(ASSET_A, 995_000);
        (pnl, fee, payout) = ex.previewClose(loss);
        assertEq(pnl, -5e6);
        assertEq(fee, 250_000);
        assertEq(payout, 95e6);
        _requestClose(carol, loss);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(loss, carol, 0.995e18, -5e6, 250_000, 95e6, 0, 475e18);
        ex.executeClose(loss);
        assertEq(ex.feePool(), 5_000_000 + 435_748 + 250_000);
        assertEq(tokenomics.lastLossBasisUsdc(), 4_750_000);
        assertEq(confetti.balanceOf(carol), 475e18);

        // Liquidation at 5%: bounty 0.5; fee 5 (1% would be 1); LP gain 100 - 0.5 - 5 = 94.5.
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchange.PositionLiquidated(liq, bob, liquidator, 0.9e18, MARGIN, 500_000, 5_000_000, 10_000e18);
        ex.liquidate(liq);
        assertEq(ex.feePool(), 5_000_000 + 435_748 + 250_000 + 5_000_000);
        assertEq(tokenomics.lastDeltaUsdc(), 94_500_000);

        // Dave opens after the change: 1% on the same 1% win, fee 0.087149, profit 8.627814.
        _setPx(ASSET_A, RAW_ONE);
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(did).feeBps, 100);
        _setPx(ASSET_A, 1_010_000);
        (pnl, fee, payout) = ex.previewClose(did);
        assertEq(pnl, 8_627_814);
        assertEq(fee, 87_149);
        assertEq(payout, 108_627_814);
        _requestClose(dave, did);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchange.PositionClosed(did, dave, 1.01e18, 8_627_814, 87_149, 108_627_814, 0, 0);
        (paid,) = ex.executeClose(did);
        assertEq(paid, 108_627_814);
        assertEq(ex.feePool(), 10_685_748 + 87_149);
        _assertSolvent();
        _assertTallyMatches();
    }

    /// @dev A stamped rate is still gated by the queue: a liquidation while the queue is
    ///      active carves nothing, whatever the position was opened at.
    function test_stamp_liquidationWhileQueueActive_stillCarvesNoFee() public {
        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV); // stamped at 5%
        _queueOneWin(); // alice is owed; queue non-empty, LP empty
        assertEq(ex.positions(id).feeBps, 500);
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchange.PositionLiquidated(id, bob, liquidator, 0.9e18, MARGIN, 500_000, 0, 10_000e18);
        ex.liquidate(id);
        assertEq(ex.feePool(), 2_235_395); // only alice's win fee
        _assertSolvent();
        _assertTallyMatches();
    }

    /// @dev Only the three stamped terms are frozen. The impact curve is still read live, as
    ///      before (bounded by `_checkParams`, which keeps at least 50% of a 1% win).
    function test_stamp_impactCurveStaysLive() public {
        _seedLpWithFullLoss(bob);
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(owner);
        ex.setInstrumentParams(TIER_A, 1, 10, 1500, 15_000, 20_000e6, 130_000_000e6); // base rate 10% -> 15%
        _setPx(ASSET_A, 1_010_000);
        // Same 1 bps exit 1.009899 and raw gain 9.899000; scale = 0.85 / 1.022051 = 0.831481...;
        // adjusted = 8.230798; fee = 5% = 0.411539; profit = 7.819259 (8.279215 on the old curve).
        (int256 pnl, uint256 fee,) = ex.previewClose(aid);
        assertEq(pnl, 7_819_259);
        assertEq(fee, 411_539);
        (uint256 paid,) = _close(alice, aid);
        assertEq(paid, 107_819_259);
    }

    // ------------------------------------------------------------- team mint

    function test_teamMint_lossAndLiquidation_tenPercentToFeeRecipient() public {
        assertEq(ex.TEAM_MINT_BPS(), 1000);

        // Losing close: alice's $5 loss mints 4.75 x 100 = 475; the team gets 47.5 on top.
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchange.TeamMinted(feeRecipient, 47.5e18);
        ex.executeClose(id);
        assertEq(confetti.balanceOf(alice), 475e18);
        assertEq(confetti.balanceOf(feeRecipient), 47.5e18);
        _setPx(ASSET_A, RAW_ONE);

        // Liquidation: bob's $100 margin mints 10,000; the team gets 1,000 on top. The
        // liquidator gets USDC only.
        id = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, false, false, true);
        emit IExchange.TeamMinted(feeRecipient, 1_000e18);
        ex.liquidate(id);
        assertEq(confetti.balanceOf(bob), 10_000e18);
        assertEq(confetti.balanceOf(feeRecipient), 1_047.5e18);
        assertEq(confetti.balanceOf(liquidator), 0);
        _setPx(ASSET_A, RAW_ONE);

        // Supply is the trader mints x 1.1; Tokenomics' tally counts the trader mints only.
        assertEq(tokenomics.totalMinted(), 10_475e18);
        assertEq(confetti.totalSupply(), 11_522.5e18);

        // A new fee recipient gets the team share from the next mint on; the old one keeps
        // what it has.
        vm.prank(owner);
        ex.setFeeRecipient(dave);
        id = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _requestClose(carol, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchange.TeamMinted(dave, 47.5e18);
        ex.executeClose(id);
        assertEq(confetti.balanceOf(dave), 47.5e18);
        assertEq(confetti.balanceOf(feeRecipient), 1_047.5e18);
        _setPx(ASSET_A, RAW_ONE);

        // A win (paid from the LP here) mints nothing, so there is no team share either.
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        uint256 supplyBefore = confetti.totalSupply();
        uint256 callsBefore = confetti.mintCalls();
        _requestClose(alice, id);
        _tick();
        vm.recordLogs();
        vm.prank(keeper);
        (uint256 paid,) = ex.executeClose(id);
        assertGt(paid, MARGIN);
        assertEq(_teamMintedCount(vm.getRecordedLogs()), 0);
        assertEq(confetti.totalSupply(), supplyBefore);
        assertEq(confetti.mintCalls(), callsBefore);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_teamMint_zeroOrDustMint_mintsNoTeamShare() public {
        // Tokenomics returns 0 (a rate decayed to nothing): nothing is minted to anyone and no
        // TeamMinted is emitted, though the loss itself is still recorded.
        tokenomics.setRateE18(0);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _requestClose(alice, id);
        _tick();
        vm.recordLogs();
        vm.prank(keeper);
        ex.executeClose(id);
        assertEq(_teamMintedCount(vm.getRecordedLogs()), 0);
        assertEq(confetti.mintCalls(), 0);
        assertEq(confetti.totalSupply(), 0);
        assertEq(tokenomics.lastLossBasisUsdc(), 4_750_000);
        _setPx(ASSET_A, RAW_ONE);

        // A trader mint under 10 wei rounds the team share to 0: at 2 wei per $1 the mint is
        // 4.75 x 2 = 9.5 -> 9 wei and the team share 10% x 9 = 0.9 -> 0, so the trader is
        // minted 9 and there is no team mint and no event.
        tokenomics.setRateE18(2);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _requestClose(alice, id);
        _tick();
        vm.recordLogs();
        vm.prank(keeper);
        ex.executeClose(id);
        assertEq(_teamMintedCount(vm.getRecordedLogs()), 0);
        assertEq(confetti.balanceOf(alice), 9);
        assertEq(confetti.balanceOf(feeRecipient), 0);
        assertEq(confetti.mintCalls(), 1);
        _setPx(ASSET_A, RAW_ONE);

        // The floor is per mint: at 3 wei per $1 the mint is 14.25 -> 14, the team 1.4 -> 1.
        tokenomics.setRateE18(3);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchange.TeamMinted(feeRecipient, 1);
        ex.executeClose(id);
        assertEq(confetti.balanceOf(alice), 9 + 14);
        assertEq(confetti.balanceOf(feeRecipient), 1);
        assertEq(confetti.mintCalls(), 3);
        _setPx(ASSET_A, RAW_ONE);

        // A liquidation that mints 0 mints nothing either.
        tokenomics.setRateE18(0);
        id = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        vm.recordLogs();
        vm.prank(liquidator);
        ex.liquidate(id);
        assertEq(_teamMintedCount(vm.getRecordedLogs()), 0);
        assertEq(confetti.balanceOf(bob), 0);
        assertEq(confetti.mintCalls(), 3);
        _assertSolvent();
        _assertTallyMatches();
    }

    // ---------------------------------------------------------- staker sweep

    function test_sweepLpToStakers_onlyTokenomics_andBounds() public {
        _seedLpWithFullLoss(bob);
        vm.prank(stranger);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.sweepLpToStakers(1);
        vm.prank(owner);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.sweepLpToStakers(1);

        vm.expectRevert(IExchange.ZeroAmount.selector);
        tokenomics.sweep(0);
        vm.expectRevert(abi.encodeWithSelector(IExchange.InsufficientBalance.selector, 100e6, 100e6 + 1));
        tokenomics.sweep(100e6 + 1);

        vm.expectEmit(false, false, false, true);
        emit IExchange.StakerOverflowSwept(30e6);
        tokenomics.sweep(30e6);
        assertEq(ex.lpBalance(), 70e6);
        assertEq(usdc.balanceOf(address(staking)), 30e6);
        assertEq(staking.lastNotifier(), address(ex));
        _assertSolvent();
    }

    function test_sweepLpToStakers_revertsWhileQueueActive() public {
        _queueOneWin();
        _seedLpWithFullLoss(bob); // LP has cash but the queue is owed
        vm.expectRevert(IExchange.QueueNotEmpty.selector);
        tokenomics.sweep(1e6);
    }

    function test_pushStakerFees_sweepsOverflowAboveCap() public {
        // Three full losses: LP $300 cash, fees 3 x 5% x 100 = $15, tally 300 - 15 = $285.
        // Cap at $200 -> sweep 285 - 200 = $85.
        _seedLpWithFullLoss(bob);
        _seedLpWithFullLoss(carol);
        _seedLpWithFullLoss(dave);
        assertEq(ex.lpBalance(), 300e6);
        assertEq(tokenomics.trackedLpUsd(), 285e6);
        tokenomics.setParams(100e6, 15_000_000e6, 200e6);
        uint256 swept = tokenomics.pushStakerFees();
        assertEq(swept, 85e6);
        assertEq(ex.lpBalance(), 215e6);
        assertEq(tokenomics.trackedLpUsd(), 200e6);
        assertEq(usdc.balanceOf(address(staking)), 85e6);
        // Fees still push afterwards: $215 of LP cash covers the $15 pool, leaving $200. At the
        // default zero staker share the whole pool goes to the recipient.
        (uint256 a, uint256 b) = ex.pushFees();
        assertEq(a, 0);
        assertEq(b, 15e6);
        assertEq(ex.lpBalance(), 200e6);
        _assertSolvent();
    }

    // --------------------------------------------------------- pause / retire

    function test_pause_market_guardianPausesOwnerResumes() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);

        vm.prank(guardian);
        vm.expectEmit(true, false, false, true);
        emit IExchange.MarketOpensPausedSet(TIER_A, true);
        ex.setMarketOpensPaused(TIER_A, true);
        assertTrue(ex.instrument(TIER_A).opensPaused);

        vm.prank(bob);
        vm.expectRevert(IExchange.OpensPausedForMarket.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        _open(bob, TIER_B, true, MARGIN, LEV); // other markets unaffected

        // Closes and liquidations still work while paused.
        _setPx(ASSET_A, 1_010_000);
        _close(alice, id);
        uint256 id2 = _open(bob, TIER_B, false, MARGIN, LEV);
        vm.prank(guardian);
        ex.setMarketOpensPaused(TIER_B, true);
        _setPx(ASSET_B, 1_095_000);
        vm.prank(liquidator);
        ex.liquidate(id2);

        vm.prank(guardian);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.setMarketOpensPaused(TIER_A, false);
        vm.prank(stranger);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.setMarketOpensPaused(TIER_A, true);
        vm.prank(owner);
        ex.setMarketOpensPaused(TIER_A, false);
        _setPx(ASSET_A, RAW_ONE);
        _open(bob, TIER_A, true, MARGIN, LEV);
    }

    function test_pause_global() public {
        vm.prank(guardian);
        vm.expectEmit(false, false, false, true);
        emit IExchange.GlobalOpensPausedSet(true);
        ex.setGlobalOpensPaused(true);
        assertTrue(ex.globalOpensPaused());
        vm.prank(alice);
        vm.expectRevert(IExchange.OpensPausedGlobally.selector);
        ex.requestOpen(TIER_C, true, MARGIN, 2, address(0));

        vm.prank(guardian);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.setGlobalOpensPaused(false);
        vm.prank(owner);
        ex.setGlobalOpensPaused(false);
        assertFalse(ex.globalOpensPaused());
        _open(alice, TIER_C, true, MARGIN, 2);
        // The owner may also pause.
        vm.prank(owner);
        ex.setGlobalOpensPaused(true);
        assertTrue(ex.globalOpensPaused());
    }

    function test_retire_freezesPrice_closesOnly_irreversible() public {
        _seedLpWithFullLoss(bob);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);

        vm.prank(stranger);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.retire(TIER_A);

        vm.prank(guardian);
        vm.expectEmit(true, false, false, true);
        emit IExchange.InstrumentRetired(TIER_A, 1.01e18);
        ex.retire(TIER_A);
        IExchange.Instrument memory inst = ex.instrument(TIER_A);
        assertTrue(inst.retired);
        assertEq(inst.frozenPx18, 1.01e18);

        vm.prank(owner);
        vm.expectRevert(IExchange.MarketRetired.selector);
        ex.retire(TIER_A);
        vm.prank(bob);
        vm.expectRevert(IExchange.MarketRetired.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));

        // The live feed moves (and even dies); settlement still uses the frozen 1.01, and a
        // close request needs no feed.
        _setPx(ASSET_A, 2_000_000);
        source.setReverts(true, true);
        // Same 1% win as the exact-numbers test: 8.714963 - 5% fee 0.435748 = 8.279215.
        (int256 pnl,,) = ex.previewClose(id);
        assertEq(pnl, 8_279_215);
        (uint256 paid,) = _close(alice, id);
        assertEq(paid, 108_279_215);
        _assertSolvent();
    }

    function test_retire_allowsLiquidationAtFrozenPrice() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        vm.prank(owner);
        ex.retire(TIER_A);
        _setPx(ASSET_A, RAW_ONE); // feed recovers upward, but the frozen 0.90 still busts
        vm.prank(liquidator);
        assertEq(ex.liquidate(id), 500_000);
    }

    function test_retireAtPrice_ownerEscapeHatch_onlyWhileFeedDead() public {
        _seedLpWithFullLoss(bob);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        source.setReverts(true, true);

        // A dead feed blocks close requests, liquidations and the guardian's retire alike.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.requestClose(id);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.liquidate(id);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.retire(TIER_A);
        assertEq(ex.marginInUse(alice), MARGIN);

        // Only the owner may state a price, and only while the oracle feed is dead: a dead
        // book alone leaves the market live.
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        ex.retireAtPrice(TIER_A, 1.01e18);
        source.setReverts(true, false);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchange.FeedAlive.selector, TIER_A));
        ex.retireAtPrice(TIER_A, 1.01e18);
        source.setReverts(false, false);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchange.FeedAlive.selector, TIER_A));
        ex.retireAtPrice(TIER_A, 1.01e18);
        assertFalse(ex.instrument(TIER_A).retired);

        // A zero quote (a delisted perp) counts as dead too; a zero price is refused.
        source.setQuote(ASSET_A, 0, 0, 0);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, TIER_A));
        ex.retire(TIER_A);
        vm.prank(owner);
        vm.expectRevert(IExchange.ZeroAmount.selector);
        ex.retireAtPrice(TIER_A, 0);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchange.InstrumentRetired(TIER_A, 1.01e18);
        ex.retireAtPrice(TIER_A, 1.01e18);
        IExchange.Instrument memory inst = ex.instrument(TIER_A);
        assertTrue(inst.retired);
        assertEq(inst.frozenPx18, 1.01e18);
        vm.prank(owner);
        vm.expectRevert(IExchange.MarketRetired.selector);
        ex.retireAtPrice(TIER_A, 1e18);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownInstrument.selector, uint32(9)));
        ex.retireAtPrice(9, 1e18);

        // alice settles at the stated price exactly as after a guardian retire at 1.01
        // (margin + 8.714963 - 5% fee 0.435748).
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, 108_279_215);
        assertEq(queued, 0);
        assertEq(ex.marginInUse(alice), 0);
        _assertSolvent();
        _assertTallyMatches();
    }

    // ---------------------------------------------------------------- breaker

    function test_breaker_tripsOnNetOutflow_pausesOpens_guardianClears() public {
        assertEq(ex.breakerBps(), 1000);
        assertFalse(ex.breakerTripped());
        vm.prank(owner);
        ex.setBreakerFloor(0); // exercise the bare share on small numbers

        // bob's $100 loss opens the first window (at the settlement block): LP was 0, net
        // outflow is -(100 - 5% x 100) = -95 (the fee is carved before the LP gain is counted).
        vm.warp(1_700_000_000);
        _seedLpWithFullLoss(bob);
        (uint64 start, uint256 startLp, int256 net) = ex.breakerWindow();
        assertEq(start, vm.getBlockTimestamp());
        assertEq(startLp, 0);
        assertEq(net, -95e6);

        // An hour later the next settlement opens a new window on the $100 of LP cash.
        vm.warp(start + 1 hours);
        uint256 a = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 c = _open(carol, TIER_A, true, MARGIN, LEV);
        uint256 d = _open(dave, TIER_B, true, MARGIN, LEV);
        uint256 b = _open(bob, TIER_C, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        _close(alice, a); // adjusted gain 8.714963, under the $10 threshold
        (start, startLp, net) = ex.breakerWindow();
        assertEq(start, vm.getBlockTimestamp());
        assertEq(startLp, 100e6);
        assertEq(net, 8_714_963);
        assertFalse(ex.breakerTripped());

        // A second win takes the window past 10% of $100: the breaker trips.
        _requestClose(carol, c);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchange.LpBreakerTripped(17_429_926, 10e6, 100e6);
        ex.executeClose(c);
        assertTrue(ex.breakerTripped());

        // Opens are blocked on every market; closes, liquidations and withdrawals are not.
        vm.prank(dave);
        vm.expectRevert(IExchange.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_B, true, MARGIN, LEV, address(0));
        vm.prank(dave);
        vm.expectRevert(IExchange.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_C, false, 10e6, 1, address(0));
        (uint256 paid,) = _close(dave, d); // flat
        assertEq(paid, MARGIN);
        _setPx(ASSET_C, 900_000);
        vm.prank(liquidator);
        ex.liquidate(b);
        (,, net) = ex.breakerWindow();
        // The liquidation's LP gain (100 - 0.5 bounty - 5% x 100 fee = 94.5) nets against the wins.
        assertEq(net, 17_429_926 - 94_500_000);
        vm.prank(alice);
        ex.withdraw(100e6);

        // Only the guardian or the owner clears it; clearing starts a fresh window.
        vm.prank(stranger);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.clearBreaker();
        vm.prank(keeper);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.clearBreaker();
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(guardian);
        vm.expectEmit(true, false, false, true);
        emit IExchange.BreakerCleared(guardian);
        ex.clearBreaker();
        assertFalse(ex.breakerTripped());
        (start, startLp, net) = ex.breakerWindow();
        assertEq(start, vm.getBlockTimestamp());
        assertEq(startLp, ex.lpBalance());
        assertEq(net, 0);
        vm.prank(guardian);
        vm.expectRevert(IExchange.BreakerNotTripped.selector);
        ex.clearBreaker();
        _setPx(ASSET_A, RAW_ONE);
        _open(dave, TIER_A, true, MARGIN, LEV);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_breaker_emptyLpTripsOnFirstNetWin_lossesOffset_ownerSetsShare() public {
        vm.prank(owner);
        ex.setBreakerFloor(0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setBreakerBps(2000);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchange.Param.BreakerBps, 199));
        ex.setBreakerBps(199);
        vm.expectRevert(_oob(IExchange.Param.BreakerBps, 5001));
        ex.setBreakerBps(5001);
        vm.expectEmit(false, false, false, true);
        emit IExchange.BreakerBpsSet(5000);
        ex.setBreakerBps(5000);
        vm.stopPrank();
        assertEq(ex.breakerBps(), 5000);

        // With an empty LP the threshold is zero, so the first queued win trips the breaker
        // whatever the share: there is nothing to bleed, but the queue is growing.
        uint256 wid = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_050_000);
        _requestClose(alice, wid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchange.LpBreakerTripped(44_707_911, 0, 0);
        ex.executeClose(wid);
        _setPx(ASSET_A, RAW_ONE);
        assertTrue(ex.breakerTripped());
        vm.prank(bob);
        vm.expectRevert(IExchange.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        vm.prank(owner);
        ex.clearBreaker(); // the owner may clear it too

        // Losses offset wins inside a window: $100 in (no fee while the queue is owed), then
        // $44.71 out leaves the window net negative, so nothing trips.
        _seedLpWithFullLoss(bob);
        uint256 id = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_050_000);
        _close(carol, id);
        assertFalse(ex.breakerTripped());
        (,, int256 net) = ex.breakerWindow();
        assertEq(net, -100e6 + 44_707_911);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_breaker_floor_youngLpDoesNotPauseOnSmallWins_boundsAndAuth() public {
        assertEq(ex.breakerFloorUsdc(), 5_000e6);

        // Empty LP, default $5K floor: a $44.71 queued win does not pause opens.
        uint256 wid = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_050_000);
        _close(alice, wid);
        _setPx(ASSET_A, RAW_ONE);
        assertFalse(ex.breakerTripped());
        (, uint256 startLp, int256 net) = ex.breakerWindow();
        assertEq(startLp, 0);
        assertEq(net, 44_707_911);
        _open(bob, TIER_A, true, MARGIN, LEV);

        // Lowering the floor below the window's outflow trips on the next win.
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit IExchange.BreakerFloorSet(50e6);
        ex.setBreakerFloor(50e6);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_050_000);
        _requestClose(carol, cid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchange.LpBreakerTripped(89_415_822, 50e6, 0);
        ex.executeClose(cid);
        assertTrue(ex.breakerTripped());

        // Owner only, capped at $100K.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setBreakerFloor(0);
        vm.prank(owner);
        vm.expectRevert(_oob(IExchange.Param.BreakerFloorUsdc, 100_000e6 + 1));
        ex.setBreakerFloor(100_000e6 + 1);
        _assertSolvent();
        _assertTallyMatches();
    }

    /// @dev Threshold = max(share, floor) with cash in the LP. At $20K the 10% share is $2K,
    ///      under the $5K floor, so the floor rules: a $3,031 net-winning hour (over the share)
    ///      does not pause opens, and the hour trips once its net outflow passes $5K.
    function test_breaker_floor_nonEmptyLp_floorRulesWhileShareIsSmaller() public {
        vm.warp(1_700_000_000);
        _fund(bob, 20_000e6);
        _lose20K(bob);
        assertEq(ex.lpBalance(), 20_000e6);
        assertEq(ex.feePool(), 1_000e6);

        // An hour later the next settlement opens a window on the $20K of LP cash.
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        uint256 a = _open(alice, TIER_A, true, 1000e6, 100); // $100K notional
        uint256 c = _open(carol, TIER_A, true, 1000e6, 100);
        _setPx(ASSET_A, 1_034_000);
        // exit after deadband = 1.0338966; rawGain = 100000 x 0.0338966 = 3389.660000;
        // scale = 0.894182...; adjusted = 3030.976119: over the $2K share, under the $5K floor.
        _close(alice, a);
        (uint64 start, uint256 startLp, int256 net) = ex.breakerWindow();
        assertEq(start, vm.getBlockTimestamp());
        assertEq(startLp, 20_000e6);
        assertEq(net, 3_030_976_119);
        assertFalse(ex.breakerTripped());
        _requestOpen(dave, TIER_A, true, MARGIN, LEV); // opens still allowed

        // carol's 2.8% win (adjusted 2491.057489) takes the hour to 5522.033608, past the floor.
        _setPx(ASSET_A, 1_028_000);
        _requestClose(carol, c);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchange.LpBreakerTripped(5_522_033_608, 5_000e6, 20_000e6);
        ex.executeClose(c);
        assertTrue(ex.breakerTripped());
        vm.prank(dave);
        vm.expectRevert(IExchange.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        _assertSolvent();
        _assertTallyMatches();
    }

    /// @dev With $100K in the LP the 10% share ($10K) is above the floor and rules: a $7,170
    ///      net-winning hour (over the floor) does not pause opens; the hour trips past $10K.
    function test_breaker_share_nonEmptyLp_shareRulesWhenAboveFloor() public {
        vm.warp(1_700_000_000);
        _fund(bob, 100_000e6);
        for (uint256 i = 0; i < 5; i++) {
            _lose20K(bob);
        }
        assertEq(ex.lpBalance(), 100_000e6);
        assertEq(ex.feePool(), 5_000e6);

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        uint256 a = _open(alice, TIER_A, true, 1000e6, 100);
        uint256 c = _open(carol, TIER_A, true, 1000e6, 100);
        _setPx(ASSET_A, 1_080_000);
        // exit after deadband = 1.0798920; rawGain = 7989.200000; scale = 0.897522...;
        // adjusted = 7170.488473: over the $5K floor, under the $10K share.
        _close(alice, a);
        (uint64 start, uint256 startLp, int256 net) = ex.breakerWindow();
        assertEq(start, vm.getBlockTimestamp());
        assertEq(startLp, 100_000e6);
        assertEq(net, 7_170_488_473);
        assertFalse(ex.breakerTripped());
        _requestOpen(dave, TIER_A, true, MARGIN, LEV);

        // carol's 3.4% win (adjusted 3030.976119) takes the hour to 10201.464592, past the share.
        _setPx(ASSET_A, 1_034_000);
        _requestClose(carol, c);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchange.LpBreakerTripped(10_201_464_592, 10_000e6, 100_000e6);
        ex.executeClose(c);
        assertTrue(ex.breakerTripped());
        vm.prank(dave);
        vm.expectRevert(IExchange.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        _assertSolvent();
        _assertTallyMatches();
    }

    // ------------------------------------------------------------------ admin

    function test_addInstrument_storesSpecAndMirrorsOracle() public {
        IExchange.Instrument memory inst = ex.instrument(TIER_B);
        assertEq(inst.hlAssetIndex, ASSET_B);
        assertEq(inst.tier, 1);
        assertEq(inst.maxLeverage, 250);
        assertEq(inst.deadbandBps, 3);
        assertEq(inst.clampBps, 25);
        assertEq(inst.longOiCapUsd, 100_000e6);
        assertEq(inst.shortOiCapUsd, 100_000e6);
        assertFalse(inst.opensPaused); // forced off despite the spec saying true
        assertFalse(inst.retired);
        assertEq(inst.frozenPx18, 0);
        assertEq(ex.instrumentCount(), 3);
        (uint32 idx, uint8 sz, uint16 clamp) = oracle.instrumentConfig(TIER_B);
        assertEq(idx, ASSET_B);
        assertEq(sz, 0);
        assertEq(clamp, 25);

        // Max leverage is the spec's own number, not the tier's: a tier A market at 500x.
        IExchange.Instrument memory spec = _spec(0, 165, 1, 10, 250_000e6);
        spec.maxLeverage = 500;
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchange.InstrumentAdded(3, 165, 0, 0, 500);
        uint32 id = ex.addInstrument(spec);
        assertEq(id, 3);
        assertEq(ex.instrumentCount(), 4);
        assertEq(ex.instrument(3).maxLeverage, 500);
    }

    function test_addInstrument_onlyOwner_invalidTier_bounds() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.addInstrument(_spec(0, 165, 1, 10, 1e6));

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchange.InvalidTier.selector, uint8(3)));
        ex.addInstrument(_spec(3, 165, 1, 10, 1e6));
        vm.expectRevert(_oob(IExchange.Param.DeadbandBps, 0));
        ex.addInstrument(_spec(0, 165, 0, 10, 1e6));
        vm.expectRevert(_oob(IExchange.Param.DeadbandBps, 51));
        ex.addInstrument(_spec(0, 165, 51, 10, 1e6));
        vm.expectRevert(_oob(IExchange.Param.ClampBps, 4));
        ex.addInstrument(_spec(0, 165, 1, 4, 1e6));
        vm.expectRevert(_oob(IExchange.Param.ClampBps, 101));
        ex.addInstrument(_spec(0, 165, 1, 101, 1e6));

        IExchange.Instrument memory spec = _spec(0, 165, 1, 10, 1e6);
        spec.maxLeverage = 0;
        vm.expectRevert(_oob(IExchange.Param.MaxLeverage, 0));
        ex.addInstrument(spec);
        spec.maxLeverage = 1001;
        vm.expectRevert(_oob(IExchange.Param.MaxLeverage, 1001));
        ex.addInstrument(spec);
        spec.maxLeverage = 1000;
        spec.baseRateBps = 499;
        vm.expectRevert(_oob(IExchange.Param.BaseRateBps, 499));
        ex.addInstrument(spec);
        spec.baseRateBps = 2001;
        vm.expectRevert(_oob(IExchange.Param.BaseRateBps, 2001));
        ex.addInstrument(spec);
        spec.baseRateBps = 500;
        spec.rateMultiplier = 999;
        vm.expectRevert(_oob(IExchange.Param.RateMultiplier, 999));
        ex.addInstrument(spec);
        spec.rateMultiplier = 1_000_001;
        vm.expectRevert(_oob(IExchange.Param.RateMultiplier, 1_000_001));
        ex.addInstrument(spec);
        spec.rateMultiplier = 1_000;
        spec.referenceNotionalUsd = 999e6;
        vm.expectRevert(_oob(IExchange.Param.ReferenceNotionalUsd, 999e6));
        ex.addInstrument(spec);
        spec.referenceNotionalUsd = 1_000_001e6;
        vm.expectRevert(_oob(IExchange.Param.ReferenceNotionalUsd, 1_000_001e6));
        ex.addInstrument(spec);
        spec.referenceNotionalUsd = 1_000_000e6;
        spec.positionMultiplierE6 = 1e12 - 1;
        vm.expectRevert(_oob(IExchange.Param.PositionMultiplierE6, 1e12 - 1));
        ex.addInstrument(spec);
        // Each value in range, but together the curve would keep under 1% of a 1% gain: a
        // silent confiscation of every win, so the curve as a whole is rejected.
        spec.positionMultiplierE6 = 1e12;
        uint256 scale = ImpactLib.impactScaleE18(
            1e16,
            ImpactLib.Curve({
                baseRateBps: spec.baseRateBps,
                rateMultiplier: spec.rateMultiplier,
                referenceNotionalUsd: spec.referenceNotionalUsd,
                positionMultiplierE6: spec.positionMultiplierE6
            })
        );
        assertLt(scale, 0.01e18);
        vm.expectRevert(_oob(IExchange.Param.ImpactScaleOnePct, scale));
        ex.addInstrument(spec);
        spec.referenceNotionalUsd = 1_000e6;
        ex.addInstrument(spec); // the edge values are accepted: this curve keeps ~79% at 1%
        vm.stopPrank();
    }

    function test_setInstrumentParams_boundsAndOracleMirror() public {
        uint128 pm = 130_000_000e6;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setInstrumentParams(TIER_A, 2, 20, 1500, 10_000, 10_000e6, pm);

        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchange.Param.ClampBps, 200));
        ex.setInstrumentParams(TIER_A, 2, 200, 1500, 10_000, 10_000e6, pm);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownInstrument.selector, uint32(9)));
        ex.setInstrumentParams(9, 2, 20, 1500, 10_000, 10_000e6, pm);
        // In-range values whose curve keeps under 1% of a win are rejected (DESIGN 8 "within
        // bounds" means the owner cannot zero every winner); the fixture curve is left intact.
        uint256 scale = ImpactLib.impactScaleE18(
            1e16,
            ImpactLib.Curve({
                baseRateBps: 1500, rateMultiplier: 10_000, referenceNotionalUsd: 1_000_000e6, positionMultiplierE6: 1e12
            })
        );
        vm.expectRevert(_oob(IExchange.Param.ImpactScaleOnePct, scale));
        ex.setInstrumentParams(TIER_A, 2, 20, 1500, 10_000, 1_000_000e6, 1e12);
        assertEq(ex.instrument(TIER_A).positionMultiplierE6, pm);

        vm.expectEmit(true, false, false, true);
        emit IExchange.InstrumentParamsSet(TIER_A, 2, 20, 1500, 10_000, 10_000e6, pm);
        ex.setInstrumentParams(TIER_A, 2, 20, 1500, 10_000, 10_000e6, pm);
        vm.stopPrank();

        IExchange.Instrument memory inst = ex.instrument(TIER_A);
        assertEq(inst.deadbandBps, 2);
        assertEq(inst.clampBps, 20);
        assertEq(inst.baseRateBps, 1500);
        assertEq(inst.rateMultiplier, 10_000);
        assertEq(inst.referenceNotionalUsd, 10_000e6);
        assertEq(inst.positionMultiplierE6, pm);
        assertEq(inst.maxLeverage, 1000); // untouched
        assertEq(inst.maxNotionalUsd, 100_000e6); // untouched
        assertEq(inst.payoutCapX, 50); // untouched
        (,, uint16 clamp) = oracle.instrumentConfig(TIER_A);
        assertEq(clamp, 20);
        // The wider clamp is mirrored and shapes the oracle's display price only: a 2% BBO
        // deviation clamps to 20 bps there, while settlement reads the unmoved oracle.
        source.setQuote(ASSET_A, 1_020_000, 1_020_000, RAW_ONE);
        assertEq(oracle.price(TIER_A), 1.002e18);
        assertEq(ex.execPrice(TIER_A, true, true), ONE);
    }

    /// @dev Decision 2: leverage is per coin. The owner moves it within 1..1000 at any time;
    ///      requests follow the new cap, open positions keep their leverage.
    function test_setMaxLeverage_perCoin_boundsOwnerEvent_openPositionsKeepTheirs() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, 1000);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setMaxLeverage(TIER_A, 500);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchange.Param.MaxLeverage, 0));
        ex.setMaxLeverage(TIER_A, 0);
        vm.expectRevert(_oob(IExchange.Param.MaxLeverage, 1001));
        ex.setMaxLeverage(TIER_A, 1001);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownInstrument.selector, uint32(9)));
        ex.setMaxLeverage(9, 10);
        vm.expectEmit(true, false, false, true);
        emit IExchange.MaxLeverageSet(TIER_A, 500);
        ex.setMaxLeverage(TIER_A, 500);
        ex.setMaxLeverage(TIER_C, 1000); // a tier C coin may go to 1000x
        ex.setMaxLeverage(TIER_B, 1); // and any coin down to 1x
        vm.stopPrank();
        assertEq(ex.instrument(TIER_A).maxLeverage, 500);
        assertEq(ex.instrument(TIER_C).maxLeverage, 1000);
        assertEq(ex.instrument(TIER_B).maxLeverage, 1);

        vm.prank(bob);
        vm.expectRevert(IExchange.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_A, true, MARGIN, 501, address(0));
        _open(bob, TIER_A, true, MARGIN, 500);
        _open(bob, TIER_C, true, 10e6, 1000);
        vm.prank(bob);
        vm.expectRevert(IExchange.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_B, true, MARGIN, 2, address(0));
        _open(bob, TIER_B, true, MARGIN, 1);

        // alice's 1000x position is untouched and still settles at 1000x: a 10 bps drop busts.
        assertEq(ex.positions(id).leverage, 1000);
        _setPx(ASSET_A, 999_000);
        vm.prank(liquidator);
        ex.liquidate(id);
        _assertSolvent();
    }

    function test_setDelays_boundsOwnerEvent_pendingRequestsFollowNewValues() public {
        assertEq(ex.minDelay(), 5);
        assertEq(ex.grace(), 3);
        assertEq(ex.expiry(), 60);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setDelays(2, 1, 20);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchange.Param.MinDelay, 1));
        ex.setDelays(1, 1, 20);
        vm.expectRevert(_oob(IExchange.Param.MinDelay, 31));
        ex.setDelays(31, 1, 60);
        vm.expectRevert(_oob(IExchange.Param.Grace, 0));
        ex.setDelays(5, 0, 60);
        vm.expectRevert(_oob(IExchange.Param.Grace, 11));
        ex.setDelays(5, 11, 60);
        vm.expectRevert(_oob(IExchange.Param.Expiry, 19));
        ex.setDelays(5, 3, 19);
        vm.expectRevert(_oob(IExchange.Param.Expiry, 301));
        ex.setDelays(5, 3, 301);
        // The fallback window must exist: minDelay + grace < expiry.
        vm.expectRevert(_oob(IExchange.Param.Expiry, 40));
        ex.setDelays(30, 10, 40);
        ex.setDelays(30, 10, 41);
        ex.setDelays(30, 10, 300);
        vm.expectEmit(false, false, false, true);
        emit IExchange.DelaysSet(2, 1, 20);
        ex.setDelays(2, 1, 20);
        vm.stopPrank();
        assertEq(ex.minDelay(), 2);
        assertEq(ex.grace(), 1);
        assertEq(ex.expiry(), 20);

        // A request filed under these values: keeper at 2 s, anyone at 3 s, cancel after 20 s.
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 1);
        vm.prank(keeper);
        vm.expectRevert(IExchange.TooEarly.selector);
        ex.executeOpen(req);
        vm.warp(t0 + 2);
        vm.prank(stranger);
        vm.expectRevert(IExchange.KeeperWindow.selector);
        ex.executeOpen(req);
        vm.warp(t0 + 3);
        vm.prank(stranger);
        assertGt(ex.executeOpen(req), 0);
        // A pending request follows a later change: filed at 2/1/20, widened to 5/3/60 before
        // execution, the keeper is early at 2 s and in its window at 5 s.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        t0 = vm.getBlockTimestamp();
        vm.prank(owner);
        ex.setDelays(5, 3, 60);
        vm.warp(t0 + 2);
        vm.prank(keeper);
        vm.expectRevert(IExchange.TooEarly.selector);
        ex.executeOpen(req);
        vm.warp(t0 + 5);
        vm.prank(keeper);
        assertGt(ex.executeOpen(req), 0);
    }

    function test_setKeeper_ownerOnly_event_isKeeper() public {
        assertTrue(ex.isKeeper(keeper));
        assertFalse(ex.isKeeper(owner));
        assertFalse(ex.isKeeper(guardian));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setKeeper(stranger, true);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        ex.setKeeper(stranger, true);
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchange.KeeperSet(dave, true);
        ex.setKeeper(dave, true);
        vm.expectEmit(true, false, false, true);
        emit IExchange.KeeperSet(keeper, false);
        ex.setKeeper(keeper, false);
        vm.stopPrank();
        assertTrue(ex.isKeeper(dave));
        assertFalse(ex.isKeeper(keeper));

        // A removed keeper is a stranger in the grace window; the new one fills.
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _tick();
        vm.prank(keeper);
        vm.expectRevert(IExchange.KeeperWindow.selector);
        ex.executeOpen(req);
        vm.prank(dave);
        assertGt(ex.executeOpen(req), 0);
    }

    function test_setOiCaps_keeperOrOwner() public {
        vm.prank(stranger);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.setOiCaps(TIER_A, 1, 2);
        vm.prank(guardian);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.setOiCaps(TIER_A, 1, 2);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchange.OiCapsSet(TIER_A, 1, 2);
        ex.setOiCaps(TIER_A, 1, 2);
        vm.prank(owner);
        ex.setOiCaps(TIER_A, 3, 4);
        IExchange.Instrument memory inst = ex.instrument(TIER_A);
        assertEq(inst.longOiCapUsd, 3);
        assertEq(inst.shortOiCapUsd, 4);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IExchange.UnknownInstrument.selector, uint32(9)));
        ex.setOiCaps(9, 1, 2);
    }

    function test_setOiCaps_boundedByTierCeiling() public {
        // The keeper is a hot key: it may move a market's caps, never past the tier ceiling
        // ($2M / $500K / $100K per side), so a stolen key cannot lift the size limit.
        vm.startPrank(keeper);
        ex.setOiCaps(TIER_A, 2_000_000e6, 2_000_000e6);
        vm.expectRevert(_oob(IExchange.Param.LongOiCapUsd, 2_000_000e6 + 1));
        ex.setOiCaps(TIER_A, 2_000_000e6 + 1, 1);
        vm.expectRevert(_oob(IExchange.Param.ShortOiCapUsd, type(uint128).max));
        ex.setOiCaps(TIER_A, 1, type(uint128).max);
        ex.setOiCaps(TIER_B, 500_000e6, 500_000e6);
        vm.expectRevert(_oob(IExchange.Param.LongOiCapUsd, 500_000e6 + 1));
        ex.setOiCaps(TIER_B, 500_000e6 + 1, 0);
        ex.setOiCaps(TIER_C, 100_000e6, 100_000e6);
        vm.expectRevert(_oob(IExchange.Param.ShortOiCapUsd, 100_000e6 + 1));
        ex.setOiCaps(TIER_C, 0, 100_000e6 + 1);
        vm.stopPrank();
        assertEq(ex.instrument(TIER_A).longOiCapUsd, 2_000_000e6);

        // The owner is bound the same way, in setOiCaps and in addInstrument.
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchange.Param.LongOiCapUsd, 2_000_000e6 + 1));
        ex.setOiCaps(TIER_A, 2_000_000e6 + 1, 1);
        vm.expectRevert(_oob(IExchange.Param.LongOiCapUsd, 100_000e6 + 1));
        ex.addInstrument(_spec(2, 165, 10, 50, 100_000e6 + 1));
        vm.stopPrank();
    }

    function test_setFeeRecipient_and_setKeepers() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setFeeRecipient(stranger);
        vm.startPrank(owner);
        vm.expectRevert(IExchange.ZeroAddress.selector);
        ex.setFeeRecipient(address(0));
        vm.expectEmit(true, false, false, true);
        emit IExchange.FeeRecipientSet(dave);
        ex.setFeeRecipient(dave);
        assertEq(ex.feeRecipient(), dave);

        vm.expectEmit(true, true, false, true);
        emit IExchange.KeepersSet(address(0), address(0));
        ex.setKeepers(address(0), address(0)); // zero disables the roles
        vm.stopPrank();
        assertEq(ex.pauseGuardian(), address(0));
        assertEq(ex.marketKeeper(), address(0));
        vm.prank(guardian);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.setGlobalOpensPaused(true);
        vm.prank(keeper);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.setOiCaps(TIER_A, 1, 1);
        assertTrue(ex.isKeeper(keeper)); // the fill keeper set is separate
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setKeepers(stranger, stranger);
    }

    function test_ownership_isTwoStep() public {
        assertEq(ex.owner(), owner);
        vm.prank(owner);
        ex.transferOwnership(dave);
        assertEq(ex.owner(), owner);
        assertEq(ex.pendingOwner(), dave);
        vm.prank(dave);
        ex.acceptOwnership();
        assertEq(ex.owner(), dave);
        // The old owner holds no role any more: neither the pause path nor onlyOwner admin.
        vm.prank(owner);
        vm.expectRevert(IExchange.Unauthorized.selector);
        ex.setGlobalOpensPaused(true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        ex.setFeeRecipient(owner);
        vm.prank(dave);
        ex.setGlobalOpensPaused(true);
        assertTrue(ex.globalOpensPaused());
    }

    function test_constructor_wiringAndZeroChecks() public {
        assertEq(ex.usdc(), address(usdc));
        assertEq(ex.oracle(), address(oracle));
        assertEq(ex.confetti(), address(confetti));
        assertEq(ex.tokenomics(), address(tokenomics));
        assertEq(ex.staking(), address(staking));
        assertEq(ex.feeRecipient(), feeRecipient);
        assertEq(ex.pauseGuardian(), guardian);
        assertEq(ex.marketKeeper(), keeper);
        assertEq(ex.MIN_MARGIN_USDC(), 10e6);
        assertEq(ex.breakerBps(), 1000);
        assertFalse(ex.breakerTripped());
        // The referral registry is created by and owned by the exchange.
        assertTrue(address(refs) != address(0));
        assertEq(refs.exchange(), address(ex));
        assertEq(refs.referralShareBps(), 1500);

        vm.expectRevert(IExchange.ZeroAddress.selector);
        new Exchange(
            usdc,
            oracle,
            IConfetti(address(confetti)),
            ITokenomics(address(tokenomics)),
            IStaking(address(staking)),
            owner,
            address(0)
        );
        vm.expectRevert(IExchange.ZeroAddress.selector);
        new Exchange(
            usdc,
            IPriceOracle(address(0)),
            IConfetti(address(confetti)),
            ITokenomics(address(tokenomics)),
            IStaking(address(staking)),
            owner,
            feeRecipient
        );
    }

    /// @dev A fresh deployment announces every default it sets, in constructor order, and the
    ///      breaker floor's $100K bound is inclusive.
    function test_constructor_emitsDefaults_andBreakerFloorAcceptsItsMax() public {
        vm.expectEmit(true, false, false, true);
        emit IExchange.FeeRecipientSet(feeRecipient);
        vm.expectEmit(false, false, false, true);
        emit IExchange.BreakerBpsSet(1000);
        vm.expectEmit(false, false, false, true);
        emit IExchange.BreakerFloorSet(5_000e6);
        vm.expectEmit(false, false, false, true);
        emit IExchange.FeeBpsSet(500);
        vm.expectEmit(false, false, false, true);
        emit IExchange.StakerFeeShareSet(0);
        vm.expectEmit(false, false, false, true);
        emit IExchange.DelaysSet(5, 3, 60);
        vm.expectEmit(false, false, false, true);
        emit IExchange.MaxJumpBpsSet(1000);
        Exchange fresh = new Exchange(
            usdc,
            oracle,
            IConfetti(address(confetti)),
            ITokenomics(address(tokenomics)),
            IStaking(address(staking)),
            owner,
            feeRecipient
        );
        assertEq(fresh.breakerBps(), 1000);
        assertEq(fresh.breakerFloorUsdc(), 5_000e6);
        assertEq(fresh.feeBps(), 500);
        assertEq(fresh.stakerFeeShareBps(), 0);
        assertEq(fresh.minDelay(), 5);
        assertEq(fresh.grace(), 3);
        assertEq(fresh.expiry(), 60);
        assertEq(fresh.maxJumpBps(), 1000);
        assertEq(fresh.feeRecipient(), feeRecipient);
        assertEq(fresh.nextRequestId(), 1);
        assertFalse(fresh.isKeeper(keeper));

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit IExchange.BreakerFloorSet(100_000e6);
        ex.setBreakerFloor(100_000e6);
        assertEq(ex.breakerFloorUsdc(), 100_000e6);
    }

    // -------------------------------------------------------------- referrals

    /// @dev Decision 4: the referrer is fixed by the trader's FIRST EXECUTED open, from that
    ///      request's `referrer`; a refunded request fixes nothing, a self-referral is none,
    ///      and later requests cannot change it.
    function test_referral_lockedAtFirstExecutedOpen_notAtRequest_neverSelf_immutable() public {
        // A refunded request locks nothing.
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, bob);
        assertEq(ex.openRequest(req).referrer, bob);
        vm.prank(guardian);
        ex.setMarketOpensPaused(TIER_A, true);
        _tick();
        vm.prank(keeper);
        assertEq(ex.executeOpen(req), 0);
        assertFalse(refs.referrerLocked(alice));
        assertEq(refs.referrerOf(alice), address(0));
        vm.prank(owner);
        ex.setMarketOpensPaused(TIER_A, false);

        // The first executed open locks the referrer named on that request.
        vm.prank(alice);
        req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferrerSet(alice, carol);
        ex.executeOpen(req);
        assertTrue(refs.referrerLocked(alice));
        assertEq(refs.referrerOf(alice), carol);

        // Later requests, with another referrer or none, change nothing.
        vm.prank(alice);
        req = ex.requestOpen(TIER_A, true, MARGIN, LEV, dave);
        _executeOpen(req);
        assertEq(refs.referrerOf(alice), carol);
        _open(alice, TIER_A, true, MARGIN, LEV);
        assertEq(refs.referrerOf(alice), carol);

        // A self-referral is stored as none and still locks: bob stays unreferred for good.
        vm.prank(bob);
        req = ex.requestOpen(TIER_A, true, MARGIN, LEV, bob);
        assertEq(ex.openRequest(req).referrer, address(0));
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferrerSet(bob, address(0));
        ex.executeOpen(req);
        assertTrue(refs.referrerLocked(bob));
        vm.prank(bob);
        req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        _executeOpen(req);
        assertEq(refs.referrerOf(bob), address(0));
        assertEq(refs.referralEarned(carol), 0); // nothing paid yet: no fee has been carved
    }

    /// @dev 15% of each fee kind a referred trader pays goes to the referrer at once; the pool
    ///      gets the other 85%. The LP's net figures (tally, breaker, mint basis) are unchanged.
    function test_referral_fifteenPercentOfEachFeeKind_creditedNow_poolGetsRest() public {
        _seedLpWithFullLoss(bob); // LP 100, pool 5 (bob is unreferred), tally 95
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        uint256 id = _executeOpen(req);
        assertEq(ex.balanceOf(carol), 1000e6);

        // Win: fee 0.435748; share 15% = 0.0653622 -> 0.065362 to carol now; pool +0.370386.
        // The LP pays the profit 8.279215 and the share: 100 - 8.279215 - 0.065362 = 91.655423.
        _setPx(ASSET_A, 1_010_000);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferralPaid(carol, alice, 65_362);
        vm.expectEmit(true, true, false, true, address(ex));
        emit IExchange.PositionClosed(id, alice, 1.01e18, 8_279_215, 435_748, 108_279_215, 0, 0);
        ex.executeClose(id);
        assertEq(ex.balanceOf(carol), 1000e6 + 65_362);
        assertEq(ex.feePool(), 5_000_000 + 370_386);
        assertEq(ex.lpBalance(), 91_655_423);
        assertEq(refs.referralEarned(carol), 65_362);
        assertEq(tokenomics.trackedLpUsd(), 95e6 - 8_714_963); // the whole adjusted gain, as before
        _assertSolvent();
        _assertTallyMatches();

        // Loss: alice loses $5; fee 0.25; share 0.0375 to carol; pool +0.2125; the mint basis
        // is still 5 - 0.25 = 4.75 -> 475 CONFETTI, team 47.5.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferralPaid(carol, alice, 37_500);
        vm.expectEmit(true, true, false, true, address(ex));
        emit IExchange.PositionClosed(id, alice, 0.995e18, -5_000_000, 250_000, 95_000_000, 0, 475e18);
        ex.executeClose(id);
        assertEq(ex.balanceOf(carol), 1000e6 + 65_362 + 37_500);
        assertEq(ex.feePool(), 5_370_386 + 212_500);
        assertEq(ex.lpBalance(), 91_655_423 + 5_000_000 - 37_500);
        assertEq(confetti.balanceOf(alice), 475e18);
        assertEq(tokenomics.lastLossBasisUsdc(), 4_750_000);
        assertEq(tokenomics.lastDeltaUsdc(), 4_750_000);
        _assertSolvent();
        _assertTallyMatches();

        // Liquidation: alice's $100 margin; fee 5; share 0.75 to carol; pool +4.25; bounty 0.5;
        // LP cash +100 - 0.5 - 0.75 = +98.75; the LP's net gain is still 100 - 0.5 - 5 = 94.5.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        uint256 lpBefore = ex.lpBalance();
        vm.prank(liquidator);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferralPaid(carol, alice, 750_000);
        vm.expectEmit(true, true, true, true, address(ex));
        emit IExchange.PositionLiquidated(id, alice, liquidator, 0.9e18, MARGIN, 500_000, 5_000_000, 10_000e18);
        ex.liquidate(id);
        assertEq(ex.balanceOf(carol), 1000e6 + 65_362 + 37_500 + 750_000);
        assertEq(ex.feePool(), 5_582_886 + 4_250_000);
        assertEq(ex.lpBalance(), lpBefore + 98_750_000);
        assertEq(tokenomics.lastDeltaUsdc(), 94_500_000);
        assertEq(refs.referralEarned(carol), 852_862);
        _assertSolvent();
        _assertTallyMatches();

        // A share that rounds to zero pays nothing and nothing is emitted: $10 at 1x, a 2-tick
        // drop, loss 20 units, fee 1, share 15% x 1 = 0.15 -> 0; the pool keeps the unit.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, 10e6, 1);
        _setPx(ASSET_A, 999_998);
        uint256 poolBefore = ex.feePool();
        uint256 carolBefore = ex.balanceOf(carol);
        _close(alice, id);
        assertEq(ex.feePool(), poolBefore + 1);
        assertEq(ex.balanceOf(carol), carolBefore);
        assertEq(refs.referralEarned(carol), 852_862);

        // An unreferred trader's fees go wholly to the pool.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        poolBefore = ex.feePool();
        _close(bob, id);
        assertEq(ex.feePool(), poolBefore + 250_000);
        assertEq(ex.balanceOf(carol), carolBefore);
        _assertSolvent();
        _assertTallyMatches();
    }

    /// @dev The one case the LP cannot pay the share on the spot: a win that drains it. The
    ///      share then joins the FIFO queue behind the trader, and a loss while the queue is
    ///      owed carves no fee, so no share.
    function test_referral_shareQueuedBehindTraderWhenLpDry_noneWhileQueueActive() public {
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        uint256 id = _executeOpen(req);
        // The 5% vector into an empty LP: profit 42.472516 queued at index 0 for alice, then
        // the share 15% x 2.235395 = 0.33530925 -> 0.335309 queued at index 1 for carol; the
        // pool keeps 2.235395 - 0.335309 = 1.900086.
        _setPx(ASSET_A, 1_050_000);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(ex));
        emit IExchange.QueueAppended(0, alice, 42_472_516);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferralPaid(carol, alice, 335_309);
        vm.expectEmit(true, true, false, true, address(ex));
        emit IExchange.QueueAppended(1, carol, 335_309);
        ex.executeClose(id);
        assertEq(ex.balanceOf(carol), 1000e6);
        assertEq(ex.queuedTotal(), 42_472_516 + 335_309);
        assertEq(ex.feePool(), 1_900_086);
        assertEq(ex.lpBalance(), 0);
        assertEq(refs.referralEarned(carol), 335_309); // counted when owed
        assertEq(tokenomics.trackedLpUsd(), -44_707_911);
        _assertSolvent();
        _assertTallyMatches();

        // Queue owed: alice's $5 loss carves nothing, so carol gets nothing.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _close(alice, id);
        assertEq(ex.feePool(), 1_900_086);
        assertEq(refs.referralEarned(carol), 335_309);
        assertEq(ex.lpBalance(), 5_000_000);

        // bob's $100 loss refills the LP (still no fee); a harvest pays alice, then carol.
        _seedLpWithFullLoss(bob);
        assertEq(ex.lpBalance(), 105_000_000);
        (uint256 n, uint256 paid) = ex.harvest(10);
        assertEq(n, 2);
        assertEq(paid, 42_472_516 + 335_309);
        assertEq(ex.balanceOf(alice), 1000e6 - 5_000_000 + 42_472_516);
        assertEq(ex.balanceOf(carol), 1000e6 + 335_309);
        assertEq(ex.queuedTotal(), 0);
        _assertSolvent();
        _assertTallyMatches();
    }

    function test_setReferralShare_ownerOnly_bounds_zeroPaysNothing() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ex.setReferralShare(1000);
        vm.prank(stranger);
        vm.expectRevert(IReferrals.NotExchange.selector);
        refs.setShareBps(1000);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IReferrals.ShareOutOfBounds.selector, uint16(5001)));
        ex.setReferralShare(5001);
        ex.setReferralShare(5000);
        assertEq(refs.referralShareBps(), 5000);
        vm.expectEmit(false, false, false, true, address(refs));
        emit IReferrals.ReferralShareSet(0);
        ex.setReferralShare(0);
        vm.stopPrank();

        // At 0% a referred trader's fee goes wholly to the pool.
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        uint256 id = _executeOpen(req);
        _setPx(ASSET_A, 995_000);
        _close(alice, id);
        assertEq(ex.feePool(), 250_000);
        assertEq(ex.balanceOf(carol), 1000e6);
        assertEq(refs.referralEarned(carol), 0);
        // Raised to 50%: the next $5 loss pays carol 0.125 of the 0.25 fee.
        vm.prank(owner);
        ex.setReferralShare(5000);
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _close(alice, id);
        assertEq(ex.feePool(), 250_000 + 125_000);
        assertEq(ex.balanceOf(carol), 1000e6 + 125_000);
        _assertSolvent();
        _assertTallyMatches();
    }

    // ------------------------------------------------------------ end to end

    function test_fullCycle_multipleTraders_staysSolvent() public {
        // A mix of wins, losses, a liquidation and a queue round trip on two markets, with a
        // referred trader and a request left pending throughout.
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, 200e6, 50, dave);
        uint256 a = _executeOpen(req);
        uint256 b = _open(bob, TIER_A, false, 150e6, 20);
        uint256 c = _open(carol, TIER_B, true, 300e6, 100);
        uint256 pending = _requestOpen(dave, TIER_A, true, 50e6, 10);
        _setPx(ASSET_A, 1_004_000); // alice +0.4% at 50x wins; bob short loses
        _setPx(ASSET_B, 990_000); // carol -1% at 100x: busted
        _close(bob, b);
        _close(alice, a);
        vm.prank(liquidator);
        ex.liquidate(c);
        _assertSolvent();
        _assertTallyMatches();
        assertGt(confetti.balanceOf(bob), 0);
        assertGt(confetti.balanceOf(carol), 0);
        assertEq(confetti.balanceOf(alice), 0);
        assertGt(refs.referralEarned(dave), 0);
        // Team share: 10% of each trader mint. The stub mints basis x 1e14, a multiple of 10,
        // so the floor is exact and supply is the tally's trader mints x 1.1.
        assertEq(confetti.balanceOf(feeRecipient), (confetti.balanceOf(bob) + confetti.balanceOf(carol)) / 10);
        assertEq(confetti.totalSupply(), tokenomics.totalMinted() * 11 / 10);

        if (ex.queuedTotal() > 0) ex.harvest(10);
        if (ex.queuedTotal() == 0 && ex.feePool() > 0 && ex.lpBalance() >= ex.feePool()) ex.pushFees();
        _assertSolvent();
        _assertTallyMatches();

        // The pending request expires and is refunded by a stranger.
        vm.warp(vm.getBlockTimestamp() + EXPIRY + 1);
        vm.prank(stranger);
        ex.cancelOpen(pending);
        assertEq(ex.pendingOf(dave), 0);

        // Everyone withdraws what they can; the LP cash is all that remains.
        address[5] memory users = [alice, bob, carol, dave, liquidator];
        for (uint256 i = 0; i < users.length; i++) {
            uint256 bal = ex.balanceOf(users[i]);
            if (bal == 0) continue;
            vm.prank(users[i]);
            ex.withdraw(bal);
        }
        uint256 devBal = ex.balanceOf(feeRecipient);
        if (devBal > 0) {
            vm.prank(feeRecipient);
            ex.withdraw(devBal);
        }
        // No positions, no balances: the LP cash is the only USDC left in the contract.
        assertEq(usdc.balanceOf(address(ex)), ex.lpBalance());
        _assertSolvent();
    }
}
