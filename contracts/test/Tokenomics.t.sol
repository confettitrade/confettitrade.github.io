// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Tokenomics} from "../src/Tokenomics.sol";
import {Staking} from "../src/Staking.sol";
import {Confetti} from "../src/Confetti.sol";
import {ITokenomics} from "../src/interfaces/ITokenomics.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {StubExchange} from "./mocks/StubExchange.sol";

contract TokenomicsTest is Test {
    uint256 internal constant THRESHOLD = 250_000e6;
    uint256 internal constant S = 15_000_000e6;
    uint256 internal constant CAP = 500_000e6;
    uint256 internal constant FLAT_RATE = 100e18;

    Tokenomics internal tok;
    MockUSDC internal usdc;
    StubExchange internal ex;

    address internal owner = address(this);
    address internal alice = makeAddr("alice");

    function setUp() public {
        usdc = new MockUSDC();
        ex = new StubExchange(IERC20(address(usdc)));
        tok = new Tokenomics(owner, THRESHOLD, S, CAP, FLAT_RATE);
        tok.setExchange(address(ex));
    }

    function _delta(int256 d) internal {
        vm.prank(address(ex));
        tok.recordLpDelta(d);
    }

    function _loss(uint256 basis) internal returns (uint256) {
        vm.prank(address(ex));
        return tok.recordLoss(basis);
    }

    // ------------------------------------------------------------- defaults

    function test_defaultsAndParams() public view {
        (uint256 t, uint256 s, uint256 c, uint256 r) = tok.params();
        assertEq(t, THRESHOLD);
        assertEq(s, S);
        assertEq(c, CAP);
        assertEq(r, FLAT_RATE);
        assertEq(tok.DEFAULT_FLAT_THRESHOLD_USD(), THRESHOLD);
        assertEq(tok.DEFAULT_TAIL_DECAY_SCALE_USD(), S);
        assertEq(tok.DEFAULT_STAKER_CAP_USD(), CAP);
        assertEq(tok.DEFAULT_FLAT_RATE_E18(), FLAT_RATE);
        assertEq(tok.trackedLpUsd(), 0);
        assertEq(tok.tailProgressUsd(), 0);
        assertEq(tok.totalMinted(), 0);
        assertEq(tok.exchange(), address(ex));
        assertEq(tok.currentRateE18(), FLAT_RATE);
    }

    function test_constructor_rejectsBadFlatRate() public {
        vm.expectRevert(abi.encodeWithSelector(ITokenomics.ParamOutOfBounds.selector, "flatRateE18", 0));
        new Tokenomics(owner, THRESHOLD, S, CAP, 0);
        uint256 tooHigh = tok.MAX_FLAT_RATE_E18() + 1;
        vm.expectRevert(abi.encodeWithSelector(ITokenomics.ParamOutOfBounds.selector, "flatRateE18", tooHigh));
        new Tokenomics(owner, THRESHOLD, S, CAP, tooHigh);
    }

    // ---------------------------------------------------------------- curve

    function test_rate_flatRegionWhileBelowThreshold() public {
        _delta(int256(THRESHOLD) - 1);
        assertEq(tok.currentRateE18(), FLAT_RATE);
        assertEq(tok.tailProgressUsd(), 0);
    }

    function test_rate_flatRegionWithNegativeTrackedLp() public {
        _delta(-50_000e6);
        assertEq(tok.trackedLpUsd(), -50_000e6);
        assertEq(tok.currentRateE18(), FLAT_RATE);
        assertEq(tok.tailProgressUsd(), 0);
        // Climbing back to zero is still below the threshold: no tail progress.
        _delta(50_000e6);
        assertEq(tok.tailProgressUsd(), 0);
        assertEq(tok.currentRateE18(), FLAT_RATE);
    }

    function test_rate_atTailProgressZero() public {
        // Exactly at the threshold: tail region, but zero progress -> still the flat rate.
        _delta(int256(THRESHOLD));
        assertEq(tok.tailProgressUsd(), 0);
        assertEq(tok.currentRateE18(), FLAT_RATE);
    }

    function test_rate_atTailProgressS() public {
        _delta(int256(THRESHOLD + S));
        assertEq(tok.tailProgressUsd(), S);
        // flat * (S / 2S)^2 = flat / 4
        assertEq(tok.currentRateE18(), 25e18);
    }

    function test_rate_atTailProgressTwoS() public {
        _delta(int256(THRESHOLD + 2 * S));
        assertEq(tok.tailProgressUsd(), 2 * S);
        // flat * (S / 3S)^2 = flat / 9, floored
        assertEq(tok.currentRateE18(), 11_111_111_111_111_111_111);
    }

    function test_rate_atTailProgressHalfS() public {
        _delta(int256(THRESHOLD + S / 2));
        // flat * (2/3)^2 = 44.44.. CONFETTI per $1
        assertEq(tok.currentRateE18(), 44_444_444_444_444_444_444);
    }

    function test_tailProgress_countsOnlyTheSliceAboveThreshold() public {
        _delta(300_000e6);
        assertEq(tok.trackedLpUsd(), 300_000e6);
        assertEq(tok.tailProgressUsd(), 50_000e6);
    }

    function test_tailProgress_neverDecreases() public {
        _delta(300_000e6);
        assertEq(tok.tailProgressUsd(), 50_000e6);

        _delta(-100_000e6);
        assertEq(tok.trackedLpUsd(), 200_000e6);
        assertEq(tok.tailProgressUsd(), 50_000e6);

        _delta(-300_000e6);
        assertEq(tok.trackedLpUsd(), -100_000e6);
        assertEq(tok.tailProgressUsd(), 50_000e6);
    }

    function test_tailProgress_resumesFromThresholdAfterDip() public {
        _delta(300_000e6); // progress 50K
        _delta(-100_000e6); // tracked 200K, flat region again
        assertEq(tok.currentRateE18(), FLAT_RATE);

        _delta(150_000e6); // tracked 350K: only the 100K above the threshold counts
        assertEq(tok.tailProgressUsd(), 150_000e6);
    }

    function test_tailProgress_consecutiveGainsAboveThresholdAccumulate() public {
        _delta(400_000e6); // progress 150K
        _delta(100_000e6); // progress 250K
        assertEq(tok.tailProgressUsd(), 250_000e6);
        assertEq(tok.trackedLpUsd(), 500_000e6);
    }

    function test_rate_backInFlatRegionIgnoresTailProgress() public {
        _delta(int256(THRESHOLD + S)); // rate 25
        assertEq(tok.currentRateE18(), 25e18);
        _delta(-int256(S + 1)); // tracked = threshold - 1: flat again
        assertEq(tok.currentRateE18(), FLAT_RATE);
        _delta(1); // back at the threshold: progress S still applies
        assertEq(tok.currentRateE18(), 25e18);
    }

    function test_recordLpDelta_emits() public {
        vm.expectEmit(false, false, false, true);
        emit ITokenomics.LpDeltaRecorded(300_000e6, 300_000e6, 50_000e6);
        _delta(300_000e6);
    }

    // -------------------------------------------------------------- minting

    function test_recordLoss_flatRegionAmount() public {
        // $100 at 100 CONFETTI per $1
        uint256 minted = _loss(100e6);
        assertEq(minted, 10_000e18);
        assertEq(tok.totalMinted(), 10_000e18);
    }

    function test_recordLoss_smallestBasis() public {
        // 1 micro-USDC at the flat rate = 1e-4 CONFETTI
        assertEq(_loss(1), 1e14);
        assertEq(_loss(0), 0);
    }

    function test_recordLoss_tailAmounts() public {
        _delta(int256(THRESHOLD + S));
        assertEq(_loss(100e6), 2_500e18);

        _delta(int256(S));
        assertEq(_loss(100e6), 1_111_111_111_111_111_111_100);
        assertEq(tok.totalMinted(), 2_500e18 + 1_111_111_111_111_111_111_100);
    }

    function test_recordLoss_usesRateBeforeTheLossIsApplied() public {
        // The Exchange calls recordLoss first, then recordLpDelta. The loss that pushes the
        // LP past the threshold is still minted at the flat rate.
        _delta(int256(THRESHOLD) - 1);
        uint256 basis = 1_000_000e6;
        assertEq(_loss(basis), basis * FLAT_RATE / 1e6);
        _delta(int256(basis));
        assertLt(tok.currentRateE18(), FLAT_RATE);
    }

    function test_recordLoss_emits() public {
        vm.expectEmit(false, false, false, true);
        emit ITokenomics.LossRecorded(50e6, FLAT_RATE, 5_000e18);
        _loss(50e6);
    }

    function test_recordLoss_doesNotTouchTally() public {
        _loss(1_000e6);
        assertEq(tok.trackedLpUsd(), 0);
        assertEq(tok.tailProgressUsd(), 0);
    }

    // ---------------------------------------------------------------- access

    function test_recording_revertsForNonExchange() public {
        vm.prank(alice);
        vm.expectRevert(ITokenomics.NotExchange.selector);
        tok.recordLoss(1e6);

        vm.prank(alice);
        vm.expectRevert(ITokenomics.NotExchange.selector);
        tok.recordLpDelta(1e6);

        // The owner is not the exchange either.
        vm.expectRevert(ITokenomics.NotExchange.selector);
        tok.recordLoss(1e6);
    }

    function test_setExchange_onceAndNonZero() public {
        vm.expectRevert(ITokenomics.AlreadyWired.selector);
        tok.setExchange(alice);

        Tokenomics fresh = new Tokenomics(owner, THRESHOLD, S, CAP, FLAT_RATE);
        vm.expectRevert(ITokenomics.ZeroAddress.selector);
        fresh.setExchange(address(0));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fresh.setExchange(alice);

        vm.expectEmit(true, false, false, true);
        emit ITokenomics.ExchangeSet(address(ex));
        fresh.setExchange(address(ex));
        assertEq(fresh.exchange(), address(ex));
    }

    function test_recording_revertsBeforeWiring() public {
        Tokenomics fresh = new Tokenomics(owner, THRESHOLD, S, CAP, FLAT_RATE);
        vm.prank(address(ex));
        vm.expectRevert(ITokenomics.NotExchange.selector);
        fresh.recordLpDelta(1);
    }

    // ---------------------------------------------------------------- params

    function test_setParams_withinBounds() public {
        vm.expectEmit(false, false, false, true);
        emit ITokenomics.ParamsSet(100_000e6, 10_000_000e6, 400_000e6);
        tok.setParams(100_000e6, 10_000_000e6, 400_000e6);
        (uint256 t, uint256 s, uint256 c, uint256 r) = tok.params();
        assertEq(t, 100_000e6);
        assertEq(s, 10_000_000e6);
        assertEq(c, 400_000e6);
        assertEq(r, FLAT_RATE); // flat rate is immutable
    }

    function test_setParams_rejectsThresholdAboveCap() public {
        vm.expectRevert(abi.encodeWithSelector(ITokenomics.ParamOutOfBounds.selector, "flatThresholdUsd", CAP + 1));
        tok.setParams(CAP + 1, S, CAP);
    }

    function test_setParams_rejectsZeroOrHugeScale() public {
        vm.expectRevert(abi.encodeWithSelector(ITokenomics.ParamOutOfBounds.selector, "tailDecayScaleUsd", 0));
        tok.setParams(THRESHOLD, 0, CAP);
        uint256 huge = tok.MAX_PARAM_USD() + 1;
        vm.expectRevert(abi.encodeWithSelector(ITokenomics.ParamOutOfBounds.selector, "tailDecayScaleUsd", huge));
        tok.setParams(THRESHOLD, huge, CAP);
    }

    function test_setParams_rejectsHugeCap() public {
        uint256 huge = tok.MAX_PARAM_USD() + 1;
        vm.expectRevert(abi.encodeWithSelector(ITokenomics.ParamOutOfBounds.selector, "stakerCapUsd", huge));
        tok.setParams(THRESHOLD, S, huge);
    }

    function test_setParams_revertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        tok.setParams(THRESHOLD, S, CAP);
    }

    function test_setParams_changesCurveImmediately() public {
        _delta(int256(THRESHOLD + S)); // progress S, rate 25
        tok.setParams(THRESHOLD, 3 * S, CAP);
        // flat * (3S / 4S)^2 = 56.25
        assertEq(tok.currentRateE18(), 56_250_000_000_000_000_000);
    }

    // ------------------------------------------------------- staker overflow

    function test_stakerOverflowUsd_view() public {
        assertEq(tok.stakerOverflowUsd(), 0);
        _delta(int256(CAP));
        assertEq(tok.stakerOverflowUsd(), 0);
        _delta(123e6);
        assertEq(tok.stakerOverflowUsd(), 123e6);
    }

    function test_pushStakerFees_nothingBelowOrAtCap() public {
        vm.expectRevert(ITokenomics.NothingToSweep.selector);
        tok.pushStakerFees();
        _delta(int256(CAP));
        ex.setLp(1_000_000e6, 0);
        vm.expectRevert(ITokenomics.NothingToSweep.selector);
        tok.pushStakerFees();
    }

    function test_pushStakerFees_sweepsOverflowAndKeepsTailProgress() public {
        _delta(600_000e6); // tracked 600K, progress 350K
        ex.setLp(1_000_000e6, 0);

        vm.expectEmit(false, false, false, true);
        emit ITokenomics.StakerFeesPushed(100_000e6, 500_000e6);
        uint256 swept = tok.pushStakerFees();

        assertEq(swept, 100_000e6);
        assertEq(tok.trackedLpUsd(), 500_000e6);
        assertEq(tok.tailProgressUsd(), 350_000e6);
        assertEq(ex.lastSweptUsdc(), 100_000e6);
        assertEq(ex.sweepCalls(), 1);
        assertEq(ex.lpBalance(), 900_000e6);

        // Nothing left above the cap now.
        vm.expectRevert(ITokenomics.NothingToSweep.selector);
        tok.pushStakerFees();
    }

    function test_pushStakerFees_boundedByLpCash() public {
        _delta(600_000e6);
        ex.setLp(30_000e6, 0);
        assertEq(tok.pushStakerFees(), 30_000e6);
        assertEq(tok.trackedLpUsd(), 570_000e6);
        assertEq(ex.lpBalance(), 0);

        // The remaining overflow waits for more cash.
        vm.expectRevert(ITokenomics.NothingToSweep.selector);
        tok.pushStakerFees();
        ex.setLp(500_000e6, 0);
        assertEq(tok.pushStakerFees(), 70_000e6);
        assertEq(tok.trackedLpUsd(), 500_000e6);
    }

    function test_pushStakerFees_revertsWhileQueueActive() public {
        _delta(600_000e6);
        ex.setLp(1_000_000e6, 1);
        vm.expectRevert(ITokenomics.NothingToSweep.selector);
        tok.pushStakerFees();
        assertEq(tok.trackedLpUsd(), 600_000e6);
    }

    function test_pushStakerFees_revertsWithNoLpCash() public {
        _delta(600_000e6);
        ex.setLp(0, 0);
        vm.expectRevert(ITokenomics.NothingToSweep.selector);
        tok.pushStakerFees();
    }

    function test_pushStakerFees_anyoneCanCall() public {
        _delta(600_000e6);
        ex.setLp(1_000_000e6, 0);
        vm.prank(alice);
        assertEq(tok.pushStakerFees(), 100_000e6);
    }

    function test_lossesAfterSweepKeepAdvancingTail() public {
        _delta(600_000e6); // progress 350K
        ex.setLp(1_000_000e6, 0);
        tok.pushStakerFees(); // tracked 500K
        _delta(100_000e6); // tracked 600K, progress 450K
        assertEq(tok.tailProgressUsd(), 450_000e6);
        // flat * (15M / 15.45M)^2
        assertEq(tok.currentRateE18(), FLAT_RATE * S * S / ((S + 450_000e6) * (S + 450_000e6)));
    }

    function test_pushStakerFees_endToEndLandsInStaking() public {
        Confetti confetti = new Confetti(owner);
        Staking staking = new Staking(owner, address(confetti), address(usdc));
        confetti.wire(address(ex), address(staking));
        staking.wire(address(ex), address(tok));
        ex.setStaking(address(staking));

        // Alice stakes 10 CONFETTI.
        vm.prank(address(ex));
        confetti.mint(alice, 10e18);
        vm.startPrank(alice);
        confetti.approve(address(staking), 10e18);
        staking.stake(10e18);
        vm.stopPrank();

        // The LP tally sits $100K above the cap and the stub has the cash.
        _delta(600_000e6);
        usdc.mint(address(ex), 1_000_000e6);
        ex.setLp(1_000_000e6, 0);

        assertEq(tok.pushStakerFees(), 100_000e6);
        assertEq(usdc.balanceOf(address(staking)), 100_000e6);
        assertEq(staking.earned(alice), 100_000e6);

        vm.prank(alice);
        assertEq(staking.claim(), 100_000e6);
        assertEq(ex.balanceOf(alice), 100_000e6);
    }
}
