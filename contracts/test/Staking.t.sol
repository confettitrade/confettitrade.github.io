// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Staking} from "../src/Staking.sol";
import {Confetti} from "../src/Confetti.sol";
import {IStaking} from "../src/interfaces/IStaking.sol";
import {IConfetti} from "../src/interfaces/IConfetti.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {StubExchange} from "./mocks/StubExchange.sol";

contract StakingTest is Test {
    Staking internal staking;
    Confetti internal confetti;
    MockUSDC internal usdc;
    StubExchange internal ex;

    address internal owner = address(this);
    address internal tokenomics = makeAddr("tokenomics");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        usdc = new MockUSDC();
        confetti = new Confetti(owner);
        staking = new Staking(owner, address(confetti), address(usdc));
        ex = new StubExchange(IERC20(address(usdc)));

        // The test contract mints CONFETTI (stands in for the Exchange on the token side);
        // the stub is the Exchange on the staking side so claims land somewhere checkable.
        confetti.wire(owner, address(staking));
        staking.wire(address(ex), tokenomics);
        ex.setStaking(address(staking));

        _fund(alice, 1_000e18);
        _fund(bob, 1_000e18);
        _fund(carol, 1_000e18);
    }

    function _fund(address user, uint256 amount) internal {
        confetti.mint(user, amount);
        vm.prank(user);
        confetti.approve(address(staking), type(uint256).max);
    }

    function _stake(address user, uint256 amount) internal {
        vm.prank(user);
        staking.stake(amount);
    }

    function _unstake(address user, uint256 amount) internal {
        vm.prank(user);
        staking.unstake(amount);
    }

    function _claim(address user) internal returns (uint256) {
        vm.prank(user);
        return staking.claim();
    }

    /// @dev Reward arriving from the Exchange.
    function _rewardFromExchange(uint256 amount) internal {
        usdc.mint(address(ex), amount);
        ex.notifyStaking(amount);
    }

    /// @dev Reward arriving from Tokenomics (an EOA here; it approves and notifies itself).
    function _rewardFromTokenomics(uint256 amount) internal {
        usdc.mint(tokenomics, amount);
        vm.startPrank(tokenomics);
        usdc.approve(address(staking), amount);
        staking.notifyReward(amount);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- setup

    function test_constructorAndViews() public view {
        assertEq(staking.confetti(), address(confetti));
        assertEq(staking.usdc(), address(usdc));
        assertEq(staking.exchange(), address(ex));
        assertEq(staking.tokenomics(), tokenomics);
        assertEq(staking.owner(), owner);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.accRewardPerShareE30(), 0);
        assertEq(staking.carryUsdc(), 0);
        assertEq(staking.totalRewardsUsdc(), 0);
        assertEq(staking.ACC_SCALE(), 1e30);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(IStaking.ZeroAddress.selector);
        new Staking(owner, address(0), address(usdc));
        vm.expectRevert(IStaking.ZeroAddress.selector);
        new Staking(owner, address(confetti), address(0));
    }

    function test_wire_onceNonZeroOwnerOnly() public {
        vm.expectRevert(IStaking.AlreadyWired.selector);
        staking.wire(address(ex), tokenomics);

        Staking fresh = new Staking(owner, address(confetti), address(usdc));
        vm.expectRevert(IStaking.ZeroAddress.selector);
        fresh.wire(address(0), tokenomics);
        vm.expectRevert(IStaking.ZeroAddress.selector);
        fresh.wire(address(ex), address(0));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fresh.wire(address(ex), tokenomics);

        vm.expectEmit(true, true, false, true);
        emit IStaking.Wired(address(ex), tokenomics);
        fresh.wire(address(ex), tokenomics);
    }

    // ---------------------------------------------------------- stake/unstake

    function test_stake_movesTokensAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit IStaking.Staked(alice, 100e18);
        _stake(alice, 100e18);

        assertEq(staking.stakedOf(alice), 100e18);
        assertEq(staking.totalStaked(), 100e18);
        assertEq(confetti.balanceOf(alice), 900e18);
        assertEq(confetti.balanceOf(address(staking)), 100e18);
    }

    function test_stake_worksWhileTransfersDisabled() public {
        assertFalse(confetti.transfersEnabled());
        _stake(alice, 100e18);
        _unstake(alice, 100e18);
        assertEq(confetti.balanceOf(alice), 1_000e18);
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
        assertEq(staking.totalStaked(), 60e18);
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

    function test_notifyReward_onlyRewarders() public {
        usdc.mint(alice, 10e6);
        vm.startPrank(alice);
        usdc.approve(address(staking), 10e6);
        vm.expectRevert(IStaking.NotRewarder.selector);
        staking.notifyReward(10e6);
        vm.stopPrank();

        // Owner is not a rewarder either.
        usdc.mint(owner, 10e6);
        usdc.approve(address(staking), 10e6);
        vm.expectRevert(IStaking.NotRewarder.selector);
        staking.notifyReward(10e6);
    }

    function test_notifyReward_zeroReverts() public {
        vm.prank(tokenomics);
        vm.expectRevert(IStaking.ZeroAmount.selector);
        staking.notifyReward(0);
    }

    function test_notifyReward_fromExchangeAndTokenomics() public {
        _stake(alice, 1e18);

        usdc.mint(address(ex), 100e6);
        vm.expectEmit(true, false, false, true);
        emit IStaking.RewardNotified(address(ex), 100e6, 1e20);
        ex.notifyStaking(100e6);
        // 100e6 * 1e30 / 1e18
        assertEq(staking.accRewardPerShareE30(), 1e20);

        _rewardFromTokenomics(50e6);
        assertEq(staking.accRewardPerShareE30(), 15e19);
        assertEq(staking.totalRewardsUsdc(), 150e6);
        assertEq(usdc.balanceOf(address(staking)), 150e6);
        assertEq(staking.earned(alice), 150e6);
    }

    function test_notifyReward_withNoStakersGoesToCarry() public {
        _rewardFromExchange(100e6);
        assertEq(staking.carryUsdc(), 100e6);
        assertEq(staking.accRewardPerShareE30(), 0);
        assertEq(staking.totalRewardsUsdc(), 100e6);

        // The first staker after that inherits the carry on the next notification.
        _stake(alice, 10e18);
        assertEq(staking.earned(alice), 0);
        _rewardFromExchange(20e6);
        assertEq(staking.carryUsdc(), 0);
        assertEq(staking.earned(alice), 120e6);
    }

    function test_notifyReward_subUnitRemainderStaysInAccumulator() public {
        _stake(alice, 1e18);
        _stake(bob, 1e18);
        _stake(carol, 1e18);

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
        _stake(alice, 1e30);
        _stake(bob, 1e30);
        _stake(carol, 1e30);

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

    function test_claim_creditsExchangeBalance() public {
        _stake(alice, 100e18);
        _rewardFromExchange(250e6);
        assertEq(staking.earned(alice), 250e6);

        vm.expectEmit(true, false, false, true);
        emit IStaking.Claimed(alice, 250e6);
        assertEq(_claim(alice), 250e6);

        assertEq(ex.balanceOf(alice), 250e6);
        assertEq(usdc.balanceOf(address(ex)), 250e6);
        assertEq(usdc.balanceOf(address(staking)), 0);
        assertEq(usdc.balanceOf(alice), 0); // nothing went to the wallet
        assertEq(staking.earned(alice), 0);
        assertEq(staking.stakedOf(alice), 100e18); // stake untouched
    }

    function test_claim_zeroIsNoOp() public {
        assertEq(_claim(alice), 0);
        _stake(alice, 1e18);
        assertEq(_claim(alice), 0);
        assertEq(ex.balanceOf(alice), 0);
    }

    function test_claim_twiceDoesNotDoublePay() public {
        _stake(alice, 1e18);
        _rewardFromExchange(5e6);
        assertEq(_claim(alice), 5e6);
        assertEq(_claim(alice), 0);
        assertEq(ex.balanceOf(alice), 5e6);
    }

    // ------------------------------------------------------- distribution

    function test_rewards_proRata() public {
        _stake(alice, 100e18);
        _stake(bob, 300e18);
        _rewardFromExchange(400e6);
        assertEq(staking.earned(alice), 100e6);
        assertEq(staking.earned(bob), 300e6);
        assertEq(staking.earned(carol), 0);
    }

    function test_rewards_lateStakerMissesEarlierRounds() public {
        _stake(alice, 100e18);
        _rewardFromExchange(100e6);
        _stake(bob, 100e18);
        assertEq(staking.earned(bob), 0);
        _rewardFromExchange(100e6);
        assertEq(staking.earned(alice), 150e6);
        assertEq(staking.earned(bob), 50e6);
    }

    function test_rewards_unstakeKeepsEarnedAndStopsAccrual() public {
        _stake(alice, 100e18);
        _stake(bob, 100e18);
        _rewardFromExchange(100e6);
        _unstake(alice, 100e18);
        assertEq(staking.earned(alice), 50e6);

        _rewardFromExchange(100e6);
        assertEq(staking.earned(alice), 50e6);
        assertEq(staking.earned(bob), 150e6);
        assertEq(_claim(alice), 50e6);
    }

    function test_rewards_restakeAfterClaim() public {
        _stake(alice, 100e18);
        _rewardFromExchange(100e6);
        _claim(alice);
        _stake(alice, 100e18); // settle inside stake must not re-credit the old reward
        assertEq(staking.earned(alice), 0);
        _rewardFromExchange(100e6);
        assertEq(staking.earned(alice), 100e6);
    }

    function test_rewards_threeUsersAcrossRounds_exact() public {
        _stake(alice, 100e18);
        _stake(bob, 300e18);
        _rewardFromExchange(400e6); // acc = 1e18: alice 100, bob 300

        _stake(carol, 100e18); // total 500e18
        _rewardFromTokenomics(1_000e6); // +2e18: alice 200, bob 600, carol 200

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
        assertEq(ex.balanceOf(alice) + ex.balanceOf(bob) + ex.balanceOf(carol), 1_700e6);
        assertEq(staking.totalRewardsUsdc(), 1_700e6);
        assertEq(usdc.balanceOf(address(staking)), 0);
    }

    function test_rewards_conservationWithUnevenNumbers() public {
        _stake(alice, 7e18);
        _stake(bob, 11e18);
        _stake(carol, 13e18);
        _rewardFromExchange(999_999);
        _unstake(alice, 3e18);
        _rewardFromTokenomics(123_457);
        _stake(carol, 5e18);
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

        _stake(alice, stakeA);
        _rewardFromExchange(reward1);
        _stake(bob, stakeB);
        _rewardFromTokenomics(reward2);
        _unstake(alice, stakeA / 2 + 1);
        _stake(carol, stakeC);
        _rewardFromExchange(reward3);

        uint256 total = uint256(reward1) + reward2 + reward3;
        uint256 claimed = _claim(alice) + _claim(bob) + _claim(carol);
        uint256 left = usdc.balanceOf(address(staking));
        assertEq(claimed + left, total);
        assertGe(left, staking.carryUsdc());
        // Rounding loss is bounded by one unit per settlement of a non-empty stake.
        assertLe(left - staking.carryUsdc(), 6);
    }

    // ---------------------------------------------------- CONFETTI gating

    function test_confettiCannotLeaveViaStakingToThirdParty() public {
        // Staking only ever sends tokens back to the unstaking caller.
        _stake(alice, 100e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IStaking.InsufficientStake.selector, 0, 1e18));
        staking.unstake(1e18);
        vm.prank(alice);
        vm.expectRevert(IConfetti.TransfersDisabled.selector);
        confetti.transfer(bob, 1e18);
    }
}
