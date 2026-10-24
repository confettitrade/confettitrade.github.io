// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Staking} from "../../src/Staking.sol";
import {MockFetti} from "../../test/mocks/MockFetti.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";
import {MockUSDC} from "../../test/mocks/MockUSDC.sol";

/// @title StakingTest
/// @notice Staking v4: rewards pulled from any payer by `notifyReward`, `claim` pays the
///         wallet, the warm-up is stamped per bucket (a top-up moves it to the amount-weighted
///         average), `minStakeDuration` bounded 1 h..30 d. The token is the existing FETTI.
contract StakingTest is Test {
    Staking internal staking;
    MockFetti internal confetti;
    MockUSDC internal usdc;

    address internal owner = address(this);
    uint64 internal constant WARMUP = 7 days;
    /// @dev Two unrelated reward payers: the Exchange's fee push and anyone topping up the pot.
    address internal feePusher = makeAddr("feePusher");
    address internal donor = makeAddr("donor");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        usdc = new MockUSDC();
        confetti = new MockFetti();
        staking = new Staking(owner, address(confetti), address(usdc), WARMUP);

        _fund(alice, 1_000e18);
        _fund(bob, 1_000e18);
        _fund(carol, 1_000e18);
    }

    /// @dev Give `user` FETTI (from outside: a v3 mint or a pool buy). Approves Staking.
    function _fund(address user, uint256 amount) internal {
        confetti.mint(user, amount);
        vm.startPrank(user);
        confetti.approve(address(staking), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev A stake lands in the warming bucket (it does not earn yet).
    function _stake(address user, uint256 amount) internal {
        vm.prank(user);
        staking.stake(amount);
    }

    /// @dev Stake, wait out the 7-day warm-up and activate, so the stake earns from now on.
    function _stakeActive(address user, uint256 amount) internal {
        _stake(user, amount);
        vm.warp(vm.getBlockTimestamp() + WARMUP);
        staking.activate(user);
    }

    function _unstake(address user, uint256 amount) internal {
        vm.prank(user);
        staking.unstake(amount);
    }

    function _claim(address user) internal returns (uint256) {
        vm.prank(user);
        return staking.claim();
    }

    function _rewardFrom(address payer, uint256 amount) internal {
        usdc.mint(payer, amount);
        vm.startPrank(payer);
        usdc.approve(address(staking), amount);
        staking.notifyReward(amount);
        vm.stopPrank();
    }

    function _rewardFromExchange(uint256 amount) internal {
        _rewardFrom(feePusher, amount);
    }

    function _rewardFromDonor(uint256 amount) internal {
        _rewardFrom(donor, amount);
    }

    // ---------------------------------------------------------------- setup

    function test_constructorAndViews() public view {
        assertEq(staking.confetti(), address(confetti));
        assertEq(staking.usdc(), address(usdc));
        assertEq(staking.owner(), owner);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.totalWarming(), 0);
        assertEq(staking.totalStake(), 0);
        assertEq(staking.accRewardPerShareE30(), 0);
        assertEq(staking.carryUsdc(), 0);
        assertEq(staking.totalRewardsUsdc(), 0);
        assertEq(staking.ACC_SCALE(), 1e30);
        assertEq(staking.minStakeDuration(), WARMUP);
        assertEq(staking.MIN_STAKE_DURATION(), 1 hours);
        assertEq(staking.MAX_STAKE_DURATION(), 30 days);
    }

    function test_constructor_rejectsZeroAddressesAndOutOfBoundsWarmup() public {
        vm.expectRevert(IStaking.ZeroAddress.selector);
        new Staking(owner, address(0), address(usdc), WARMUP);
        vm.expectRevert(IStaking.ZeroAddress.selector);
        new Staking(owner, address(confetti), address(0), WARMUP);
        // 1 hour is the floor and 30 days the ceiling, both inclusive; 0 is refused.
        vm.expectRevert(abi.encodeWithSelector(IStaking.DurationOutOfBounds.selector, uint64(0)));
        new Staking(owner, address(confetti), address(usdc), 0);
        vm.expectRevert(abi.encodeWithSelector(IStaking.DurationOutOfBounds.selector, uint64(1 hours - 1)));
        new Staking(owner, address(confetti), address(usdc), 1 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(IStaking.DurationOutOfBounds.selector, uint64(30 days + 1)));
        new Staking(owner, address(confetti), address(usdc), 30 days + 1);
        assertEq(new Staking(owner, address(confetti), address(usdc), 1 hours).minStakeDuration(), 1 hours);
        assertEq(new Staking(owner, address(confetti), address(usdc), 30 days).minStakeDuration(), 30 days);
    }

    // ---------------------------------------------------------- stake/unstake

    function test_stake_movesTokensIntoWarmingAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit IStaking.Staked(alice, 100e18);
        _stake(alice, 100e18);

        // Held for alice, but warming: not in the earning supply until activated.
        assertEq(staking.stakedOf(alice), 100e18);
        assertEq(staking.activeStakeOf(alice), 0);
        (uint256 warming, uint64 activatesAt) = staking.warmingOf(alice);
        assertEq(warming, 100e18);
        assertEq(activatesAt, vm.getBlockTimestamp() + WARMUP);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.totalWarming(), 100e18);
        assertEq(confetti.balanceOf(alice), 900e18);
        assertEq(confetti.balanceOf(address(staking)), 100e18);
    }

    function test_stake_zeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(IStaking.ZeroAmount.selector);
        staking.stake(0);
    }

    function test_unstake_returnsTokensAndEmits() public {
        _stake(alice, 100e18);
        vm.expectEmit(true, false, false, true);
        emit IStaking.Unstaked(alice, 40e18);
        _unstake(alice, 40e18);

        assertEq(staking.stakedOf(alice), 60e18);
        assertEq(staking.totalWarming(), 60e18);
        assertEq(confetti.balanceOf(alice), 940e18);
    }

    function test_unstake_zeroReverts() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(IStaking.ZeroAmount.selector);
        staking.unstake(0);
    }

    function test_unstake_tooMuchReverts() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStaking.InsufficientStake.selector, 100e18, 100e18 + 1));
        staking.unstake(100e18 + 1);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IStaking.InsufficientStake.selector, 0, 1));
        staking.unstake(1);
    }

    // --------------------------------------------------------- notifyReward

    /// @dev Any payer may notify: a trader, the owner, a stranger. The USDC is pulled from the
    ///      caller, so a caller without allowance is refused and nothing is booked.
    function test_notifyReward_fromAnyPayer() public {
        _stakeActive(alice, 1e18);
        _rewardFrom(alice, 10e6);
        _rewardFrom(owner, 20e6);
        _rewardFrom(makeAddr("stranger"), 30e6);
        assertEq(staking.totalRewardsUsdc(), 60e6);
        assertEq(usdc.balanceOf(address(staking)), 60e6);
        assertEq(staking.earned(alice), 60e6);

        address broke = makeAddr("broke");
        usdc.mint(broke, 5e6);
        vm.prank(broke);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(staking), 0, 5e6)
        );
        staking.notifyReward(5e6);
        assertEq(staking.totalRewardsUsdc(), 60e6);
        assertEq(usdc.balanceOf(broke), 5e6);
    }

    function test_notifyReward_zeroReverts() public {
        vm.prank(donor);
        vm.expectRevert(IStaking.ZeroAmount.selector);
        staking.notifyReward(0);
    }

    function test_notifyReward_fromTwoPayersAccumulates() public {
        _stakeActive(alice, 1e18);

        usdc.mint(feePusher, 100e6);
        vm.prank(feePusher);
        usdc.approve(address(staking), 100e6);
        vm.expectEmit(true, false, false, true);
        emit IStaking.RewardNotified(feePusher, 100e6, 1e20);
        vm.prank(feePusher);
        staking.notifyReward(100e6);
        // 100e6 * 1e30 / 1e18
        assertEq(staking.accRewardPerShareE30(), 1e20);

        _rewardFromDonor(50e6);
        assertEq(staking.accRewardPerShareE30(), 15e19);
        assertEq(staking.totalRewardsUsdc(), 150e6);
        assertEq(usdc.balanceOf(address(staking)), 150e6);
        assertEq(usdc.balanceOf(feePusher) + usdc.balanceOf(donor), 0);
        assertEq(staking.earned(alice), 150e6);
    }

    function test_notifyReward_withNoStakersGoesToCarry() public {
        _rewardFromExchange(100e6);
        assertEq(staking.carryUsdc(), 100e6);
        assertEq(staking.accRewardPerShareE30(), 0);
        assertEq(staking.totalRewardsUsdc(), 100e6);

        // The first staker after that inherits the carry on the next notification.
        _stakeActive(alice, 10e18);
        assertEq(staking.earned(alice), 0);
        _rewardFromExchange(20e6);
        assertEq(staking.carryUsdc(), 0);
        assertEq(staking.earned(alice), 120e6);
    }

    /// @dev With nothing active yet, a reward goes to the warming stake instead of waiting in
    ///      the carry: it is paid when the warm-up ends (no `activate` needed, the staker's own
    ///      claim settles it), and an early unstake forfeits its part back to everyone.
    function test_notifyReward_warmingOnly_earnsPaidAtActivation() public {
        _stake(alice, 30e18);
        _stake(bob, 10e18);
        assertEq(staking.totalStaked(), 0);
        _rewardFromExchange(100e6);
        assertEq(staking.carryUsdc(), 0);
        assertEq(staking.warmingRewardOf(alice), 75e6);
        assertEq(staking.warmingRewardOf(bob), 25e6);
        assertEq(staking.earned(alice), 0);

        vm.prank(bob);
        staking.unstake(10e18);
        assertEq(staking.carryUsdc(), 25e6);

        vm.warp(vm.getBlockTimestamp() + WARMUP);
        assertEq(staking.earned(alice), 75e6);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        assertEq(staking.claim(), 75e6);
        assertEq(usdc.balanceOf(alice) - before, 75e6);
        assertEq(staking.totalStaked(), 30e18);

        // Bob's forfeit rides with the next reward to the stake that is there.
        _rewardFromExchange(5e6);
        assertEq(staking.carryUsdc(), 0);
        assertEq(staking.earned(alice), 30e6);
    }

    function test_notifyReward_subUnitRemainderStaysInAccumulator() public {
        _stakeActive(alice, 1e18);
        _stakeActive(bob, 1e18);
        _stakeActive(carol, 1e18);

        // 10 micro-USDC over 3e18 shares: per-share floor(1e31 / 3e18) = 3333333333333.
        // The scaled remainder (1e18) is far below one unit, so nothing is carried; each
        // staker can claim 3 now and the tenth unit sits inside the accumulator fractions.
        _rewardFromExchange(10);
        assertEq(staking.accRewardPerShareE30(), 3_333_333_333_333);
        assertEq(staking.carryUsdc(), 0);
        assertEq(staking.earned(alice), 3);
        assertEq(staking.earned(bob), 3);
        assertEq(staking.earned(carol), 3);
        assertEq(usdc.balanceOf(address(staking)), 10);

        // Claims never exceed what the contract holds.
        assertEq(_claim(alice) + _claim(bob) + _claim(carol), 9);
        assertEq(usdc.balanceOf(address(staking)), 1);
    }

    function test_notifyReward_wholeUnitCarryExact() public {
        // With 3e30 wei staked a 1e30 accumulator cannot express fractions of a unit, so
        // the division leaves whole units behind: 10 over 3e30 -> 3 per 1e30 share, carry 1.
        _fund(alice, 1e30);
        _fund(bob, 1e30);
        _fund(carol, 1e30);
        _stakeActive(alice, 1e30);
        _stakeActive(bob, 1e30);
        _stakeActive(carol, 1e30);

        _rewardFromExchange(10);
        assertEq(staking.accRewardPerShareE30(), 3);
        assertEq(staking.carryUsdc(), 1);
        assertEq(staking.earned(alice), 3);
        assertEq(staking.earned(bob), 3);
        assertEq(staking.earned(carol), 3);

        // The next round folds the carried unit in: (2 + 1) over 3e30 = 1 each, no carry.
        _rewardFromExchange(2);
        assertEq(staking.accRewardPerShareE30(), 4);
        assertEq(staking.carryUsdc(), 0);
        assertEq(staking.earned(alice), 4);
        assertEq(staking.earned(bob), 4);
        assertEq(staking.earned(carol), 4);
        assertEq(_claim(alice) + _claim(bob) + _claim(carol), 12);
        assertEq(usdc.balanceOf(address(staking)), 0);
    }

    // ---------------------------------------------------------------- claim

    function test_claim_paysTheWallet() public {
        _stakeActive(alice, 100e18);
        _rewardFromExchange(250e6);
        assertEq(staking.earned(alice), 250e6);

        vm.expectEmit(true, false, false, true);
        emit IStaking.Claimed(alice, 250e6);
        assertEq(_claim(alice), 250e6);

        assertEq(usdc.balanceOf(alice), 250e6);
        assertEq(usdc.balanceOf(address(staking)), 0);
        assertEq(staking.earned(alice), 0);
        assertEq(staking.stakedOf(alice), 100e18); // stake untouched
        assertEq(confetti.balanceOf(alice), 900e18);
    }

    function test_claim_zeroIsNoOp() public {
        assertEq(_claim(alice), 0);
        _stake(alice, 1e18);
        assertEq(_claim(alice), 0);
        assertEq(usdc.balanceOf(alice), 0);
    }

    function test_claim_twiceDoesNotDoublePay() public {
        _stakeActive(alice, 1e18);
        _rewardFromExchange(5e6);
        assertEq(_claim(alice), 5e6);
        assertEq(_claim(alice), 0);
        assertEq(usdc.balanceOf(alice), 5e6);
    }

    // ------------------------------------------------------- distribution

    function test_rewards_proRata() public {
        _stakeActive(alice, 100e18);
        _stakeActive(bob, 300e18);
        _rewardFromExchange(400e6);
        assertEq(staking.earned(alice), 100e6);
        assertEq(staking.earned(bob), 300e6);
        assertEq(staking.earned(carol), 0);
    }

    function test_rewards_lateStakerMissesEarlierRounds() public {
        _stakeActive(alice, 100e18);
        _rewardFromExchange(100e6);
        _stakeActive(bob, 100e18);
        assertEq(staking.earned(bob), 0);
        _rewardFromExchange(100e6);
        assertEq(staking.earned(alice), 150e6);
        assertEq(staking.earned(bob), 50e6);
    }

    function test_rewards_unstakeKeepsEarnedAndStopsAccrual() public {
        _stakeActive(alice, 100e18);
        _stakeActive(bob, 100e18);
        _rewardFromExchange(100e6);
        _unstake(alice, 100e18);
        assertEq(staking.earned(alice), 50e6);

        _rewardFromExchange(100e6);
        assertEq(staking.earned(alice), 50e6);
        assertEq(staking.earned(bob), 150e6);
        assertEq(_claim(alice), 50e6);
    }

    function test_rewards_restakeAfterClaim() public {
        _stakeActive(alice, 100e18);
        _rewardFromExchange(100e6);
        _claim(alice);
        _stakeActive(alice, 100e18); // settle inside stake must not re-credit the old reward
        assertEq(staking.earned(alice), 0);
        _rewardFromExchange(100e6);
        assertEq(staking.earned(alice), 100e6);
    }

    function test_rewards_threeUsersAcrossRounds_exact() public {
        _stakeActive(alice, 100e18);
        _stakeActive(bob, 300e18);
        _rewardFromExchange(400e6); // acc = 1e18: alice 100, bob 300

        _stakeActive(carol, 100e18); // total 500e18
        _rewardFromDonor(1_000e6); // +2e18: alice 200, bob 600, carol 200

        _unstake(bob, 200e18); // bob 100e18 left, total 300e18
        _rewardFromExchange(300e6); // +1e18: 100 each

        assertEq(staking.accRewardPerShareE30(), 4e18);
        assertEq(staking.earned(alice), 400e6);
        assertEq(staking.earned(bob), 1_000e6);
        assertEq(staking.earned(carol), 300e6);
        assertEq(staking.carryUsdc(), 0);

        assertEq(_claim(alice), 400e6);
        assertEq(_claim(bob), 1_000e6);
        assertEq(_claim(carol), 300e6);
        assertEq(usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(carol), 1_700e6);
        assertEq(staking.totalRewardsUsdc(), 1_700e6);
        assertEq(usdc.balanceOf(address(staking)), 0);
    }

    function test_rewards_conservationWithUnevenNumbers() public {
        _stakeActive(alice, 7e18);
        _stakeActive(bob, 11e18);
        _stakeActive(carol, 13e18);
        _rewardFromExchange(999_999);
        _unstake(alice, 3e18);
        _rewardFromDonor(123_457);
        _stakeActive(carol, 5e18);
        _rewardFromExchange(1);

        uint256 claimed = _claim(alice) + _claim(bob) + _claim(carol);
        uint256 total = 999_999 + 123_457 + 1;
        uint256 left = usdc.balanceOf(address(staking));
        assertEq(claimed + left, total);
        assertEq(staking.totalRewardsUsdc(), total);
        // Everything still in the contract is either the carry or sub-unit rounding across
        // three stakers and three settlements: at most one unit per staker per settle.
        assertLe(left - staking.carryUsdc(), 9);
    }

    /// @dev Whatever the stake and reward sizes, every claim must succeed and the contract
    ///      must keep at least the carry: the accumulator never promises USDC it lacks.
    function testFuzz_claimsNeverExceedHoldings(
        uint96 stakeA,
        uint96 stakeB,
        uint96 stakeC,
        uint64 reward1,
        uint64 reward2,
        uint64 reward3
    ) public {
        stakeA = uint96(bound(stakeA, 1, 1_000e18));
        stakeB = uint96(bound(stakeB, 1, 1_000e18));
        stakeC = uint96(bound(stakeC, 1, 1_000e18));
        reward1 = uint64(bound(reward1, 1, 1_000_000e6));
        reward2 = uint64(bound(reward2, 1, 1_000_000e6));
        reward3 = uint64(bound(reward3, 1, 1_000_000e6));

        _stakeActive(alice, stakeA);
        _rewardFromExchange(reward1);
        _stakeActive(bob, stakeB);
        _rewardFromDonor(reward2);
        _unstake(alice, stakeA / 2 + 1);
        _stakeActive(carol, stakeC);
        _rewardFromExchange(reward3);

        uint256 total = uint256(reward1) + reward2 + reward3;
        uint256 claimed = _claim(alice) + _claim(bob) + _claim(carol);
        uint256 left = usdc.balanceOf(address(staking));
        assertEq(claimed + left, total);
        assertGe(left, staking.carryUsdc());
        // Rounding loss is bounded by one unit per settlement of a non-empty stake.
        assertLe(left - staking.carryUsdc(), 6);
    }

    // -------------------------------------------------------------- warm-up

    /// @dev A new stake shares rewards from the start but is paid only once 7 days have passed
    ///      and the account is touched; a stranger may touch it with `activate`.
    function test_warmup_newStakeAccruesButIsPaidOnlyAtActivation() public {
        _stakeActive(alice, 100e18);
        _stake(bob, 100e18);
        // 100 USDC split by active 100e18 : warming 100e18: 100e6 x 100 / 200 = 50e6 to the
        // warming side (all bob's, unpaid), 50e6 to alice.
        _rewardFromExchange(100e6);
        assertEq(staking.earned(alice), 50e6);
        assertEq(staking.earned(bob), 0);
        assertEq(staking.warmingRewardOf(bob), 50e6);

        // One second short of the warm-up, activate changes nothing.
        vm.warp(vm.getBlockTimestamp() + WARMUP - 1);
        staking.activate(bob);
        assertEq(staking.activeStakeOf(bob), 0);
        assertEq(staking.totalStaked(), 100e18);
        assertEq(staking.earned(bob), 0);

        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectEmit(true, false, false, true);
        emit IStaking.Activated(bob, 100e18);
        vm.prank(carol);
        staking.activate(bob);
        assertEq(staking.activeStakeOf(bob), 100e18);
        assertEq(staking.totalStaked(), 200e18);
        assertEq(staking.totalWarming(), 0);
        (uint256 warming, uint64 activatesAt) = staking.warmingOf(bob);
        assertEq(warming, 0);
        assertEq(activatesAt, 0);
        assertEq(staking.earned(bob), 50e6);
        assertEq(staking.warmingRewardOf(bob), 0);

        // 200 USDC over 200e18 active, nobody warming: 100 each; both end at 50 + 100 = 150.
        _rewardFromExchange(200e6);
        assertEq(staking.earned(alice), 150e6);
        assertEq(staking.earned(bob), 150e6);
    }

    /// @dev Audit L3: stake right before a push, unstake right after. The grab earns nothing:
    ///      bob's 1,000 warming took 500e6 x 1,000 / 1,100 = 454,545,454 (floor) of the push
    ///      and forfeits it all to the carry, alice got 500e6 - 454,545,454 = 45,454,546. The
    ///      next reward of 1 USDC carries the forfeit to alice, the only stake: she ends at
    ///      45,454,546 + 1,000,000 + 454,545,454 = 501,000,000, both rewards whole.
    function test_warmup_stakeAroundAPushGrabsNothing() public {
        _stakeActive(alice, 100e18);
        _stake(bob, 1_000e18);
        _rewardFromDonor(500e6);
        assertEq(staking.warmingRewardOf(bob), 454_545_454);
        _unstake(bob, 1_000e18);
        assertEq(staking.warmingRewardOf(bob), 0);
        assertEq(staking.earned(bob), 0);
        assertEq(_claim(bob), 0);
        assertEq(confetti.balanceOf(bob), 1_000e18);
        assertEq(staking.earned(alice), 45_454_546);
        assertEq(staking.carryUsdc(), 454_545_454);

        _rewardFromExchange(1e6);
        assertEq(staking.earned(alice), 501_000_000);
        assertEq(staking.carryUsdc(), 0);
    }

    /// @dev Unstaking part of a warming stake forfeits the same fraction of its accrual: bob's
    ///      100 warming accrues 50 of a 100 push (as above); taking out 40 of 100 forfeits
    ///      50 x 40 / 100 = 20 to the carry and keeps 30, paid at his activation.
    function test_warmup_partialUnstakeForfeitsItsFraction() public {
        _stakeActive(alice, 100e18);
        uint256 t0 = vm.getBlockTimestamp();
        _stake(bob, 100e18);
        _rewardFromExchange(100e6);
        _unstake(bob, 40e18);
        assertEq(staking.warmingRewardOf(bob), 30e6);
        assertEq(staking.carryUsdc(), 20e6);
        vm.warp(t0 + WARMUP);
        staking.activate(bob);
        assertEq(staking.earned(bob), 30e6);
        assertEq(staking.earned(alice), 50e6);
    }

    /// @dev A warm-up that has run out but was never touched keeps accruing on the warming
    ///      side, and that is claimable at once: 100 split 50 / 50 between alice (active) and
    ///      bob (mature, warming). bob's claim activates him; the next 100 is split 50 / 50
    ///      over the active stake.
    function test_warmup_matureButUntouchedStakeIsPaidOnTouch() public {
        _stakeActive(alice, 100e18);
        _stake(bob, 100e18);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _rewardFromExchange(100e6);
        assertEq(staking.earned(alice), 50e6);
        assertEq(staking.earned(bob), 50e6);
        assertEq(_claim(bob), 50e6);
        assertEq(staking.activeStakeOf(bob), 100e18);
        _rewardFromExchange(100e6);
        assertEq(staking.earned(bob), 50e6);
        assertEq(staking.earned(alice), 100e6);
    }

    /// @dev A top-up moves the bucket's end to the amount-weighted average of the old end and a
    ///      fresh warm-up: 50 ending t0 + 7 d, plus 50 at t0 + 6 d (fresh end t0 + 13 d) ->
    ///      (7 d x 50 + 13 d x 50) / 100 = t0 + 10 d. Not a restart, not the old date.
    function test_warmup_topUpMovesToTheWeightedAverage() public {
        uint256 t0 = vm.getBlockTimestamp();
        _stake(bob, 50e18);
        (, uint64 first) = staking.warmingOf(bob);
        assertEq(first, t0 + WARMUP);
        vm.warp(t0 + 6 days);
        _stake(bob, 50e18);
        (uint256 warming, uint64 activatesAt) = staking.warmingOf(bob);
        assertEq(warming, 100e18);
        assertEq(activatesAt, t0 + 10 days);

        vm.warp(t0 + WARMUP); // the first 50's original date: not enough any more
        staking.activate(bob);
        assertEq(staking.activeStakeOf(bob), 0);
        vm.warp(t0 + 10 days - 1);
        staking.activate(bob);
        assertEq(staking.activeStakeOf(bob), 0);
        vm.warp(t0 + 10 days);
        staking.activate(bob);
        assertEq(staking.activeStakeOf(bob), 100e18);
    }

    /// @dev Uneven weights: 90 ending t0 + 7 d, then 10 at t0 + 1 d (fresh end t0 + 8 d) ->
    ///      (7 d x 90 + 8 d x 10) / 100 = t0 + 7.1 d. A small top-up barely moves the date.
    function test_warmup_topUpWeightsByAmount() public {
        uint256 t0 = vm.getBlockTimestamp();
        _stake(bob, 90e18);
        vm.warp(t0 + 1 days);
        _stake(bob, 10e18);
        (, uint64 activatesAt) = staking.warmingOf(bob);
        assertEq(activatesAt, t0 + (7 days * 90 + 8 days * 10) / 100);
    }

    /// @dev Fuzz: the averaged end always lies between the old end and the fresh end.
    function testFuzz_warmup_topUpEndBetweenOldAndFresh(uint96 a, uint96 b, uint32 gap) public {
        a = uint96(bound(a, 1, 1_000e18));
        b = uint96(bound(b, 1, 1_000e18));
        uint256 dt = bound(gap, 0, WARMUP - 1);
        _fund(bob, 2_000e18);
        uint256 t0 = vm.getBlockTimestamp();
        _stake(bob, a);
        vm.warp(t0 + dt);
        _stake(bob, b);
        (uint256 warming, uint64 end) = staking.warmingOf(bob);
        assertEq(warming, uint256(a) + b);
        assertGe(end, t0 + WARMUP);
        assertLe(end, t0 + dt + WARMUP);
    }

    /// @dev A bucket whose warm-up is over activates on the next stake, before the new amount
    ///      starts its own warm-up.
    function test_warmup_matureBucketActivatesBeforeATopUp() public {
        _stake(bob, 50e18);
        vm.warp(vm.getBlockTimestamp() + WARMUP);
        vm.expectEmit(true, false, false, true);
        emit IStaking.Activated(bob, 50e18);
        _stake(bob, 30e18);
        assertEq(staking.activeStakeOf(bob), 50e18);
        (uint256 warming,) = staking.warmingOf(bob);
        assertEq(warming, 30e18);
        assertEq(staking.stakedOf(bob), 80e18);
    }

    /// @dev Unstake takes the warming stake first, so the earning stake stays as large as it
    ///      can: active 100 + warming 40, unstake 60 -> warming 0, active 100 - (60 - 40) = 80.
    function test_unstake_drawsWarmingFirst() public {
        _stakeActive(alice, 100e18);
        _stake(alice, 40e18);
        _unstake(alice, 60e18);
        assertEq(staking.activeStakeOf(alice), 80e18);
        (uint256 warming,) = staking.warmingOf(alice);
        assertEq(warming, 0);
        assertEq(staking.totalStaked(), 80e18);
        assertEq(staking.totalWarming(), 0);
        assertEq(confetti.balanceOf(alice), 1_000e18 - 80e18);
    }

    // ------------------------------------------------------- FETTI gating

    function test_confettiCannotLeaveViaStakingToThirdParty() public {
        // Staking only ever sends tokens back to the unstaking caller.
        _stake(alice, 100e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IStaking.InsufficientStake.selector, 0, 1e18));
        staking.unstake(1e18);
        assertEq(confetti.balanceOf(address(staking)), 100e18);
    }

    // ------------------------------------------------------------ totalStake

    function test_totalStake_isActivePlusWarming() public {
        _stakeActive(alice, 100e18);
        _stake(bob, 40e18);
        assertEq(staking.totalStaked(), 100e18);
        assertEq(staking.totalWarming(), 40e18);
        assertEq(staking.totalStake(), 140e18);
        assertEq(staking.totalStake(), confetti.balanceOf(address(staking)));
        _unstake(alice, 30e18);
        assertEq(staking.totalStake(), 110e18);
        assertEq(staking.totalStake(), confetti.balanceOf(address(staking)));
    }

    // ------------------------------------------------------- minStakeDuration

    /// @dev Bounded 1 h..30 d inclusive, owner only, applies to stakes made afterwards; a
    ///      bucket already warming keeps its stamped end.
    function test_setMinStakeDuration_boundedOwnerOnly_andOnlyForNewStakes() public {
        vm.expectRevert(abi.encodeWithSelector(IStaking.DurationOutOfBounds.selector, uint64(30 days + 1)));
        staking.setMinStakeDuration(30 days + 1);
        vm.expectRevert(abi.encodeWithSelector(IStaking.DurationOutOfBounds.selector, uint64(1 hours - 1)));
        staking.setMinStakeDuration(1 hours - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        staking.setMinStakeDuration(1 days);

        uint256 t0 = vm.getBlockTimestamp();
        _stake(alice, 100e18); // stamped t0 + 7 d

        vm.expectEmit(false, false, false, true);
        emit IStaking.MinStakeDurationSet(1 hours);
        staking.setMinStakeDuration(1 hours);
        assertEq(staking.minStakeDuration(), 1 hours);
        staking.setMinStakeDuration(30 days);
        assertEq(staking.minStakeDuration(), 30 days);
        staking.setMinStakeDuration(1 hours);

        _stake(bob, 100e18);
        (, uint64 bobEnd) = staking.warmingOf(bob);
        assertEq(bobEnd, t0 + 1 hours);
        (, uint64 aliceEnd) = staking.warmingOf(alice);
        assertEq(aliceEnd, t0 + WARMUP);

        vm.warp(t0 + 1 hours);
        staking.activate(alice);
        staking.activate(bob);
        assertEq(staking.activeStakeOf(alice), 0);
        assertEq(staking.activeStakeOf(bob), 100e18);
    }
}
