// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IStaking
/// @notice Stake FETTI, earn USDC: the stakers' share of the exchange's fee pushes.
/// @dev No lockup. A new stake warms up for `minStakeDuration` (owner-set, between
///      `MIN_STAKE_DURATION` and `MAX_STAKE_DURATION`); it waits outside `totalStaked` and joins
///      it on the first touch of the account after its warm-up (`stake`, `unstake`, `claim`, or
///      anyone's `activate(user)`). The warm-up end is stamped on the bucket when the stake is
///      made; a top-up moves it to the amount-weighted average of the old end and a fresh one,
///      and a later change of `minStakeDuration` never reaches a bucket already warming.
///      `unstake` draws on warming stake first. Each reward is split between active and
///      warming stake by their totals, over two 1e30-scaled accumulators; a warming stake's
///      accrual is paid at its activation and the unstaked fraction of it is forfeited. Any
///      reward that cannot be split (no stake at all, division remainders, forfeits) is held in
///      `carryUsdc` and folded into the next notification.
///      Custody: Staking holds the reward USDC. `notifyReward` pulls it from any caller with
///      `transferFrom` (the Exchange's fee push in practice; anyone may add to the pot).
///      `claim` sends the USDC to the caller's wallet. The token is the existing FETTI (v3's);
///      a v3 staker moves by unstaking on v3 Staking and calling `stake` here.
interface IStaking {
    // ----------------------------------------------------------------- events

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 usdc);
    event RewardNotified(address indexed from, uint256 usdc, uint256 accRewardPerShareE30After);
    /// @notice `amount` of `user`'s warming stake finished its warm-up and now earns.
    event Activated(address indexed user, uint256 amount);
    /// @notice The owner set the warm-up for new stakes.
    event MinStakeDurationSet(uint64 duration);

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientStake(uint256 staked, uint256 requested);
    error DurationOutOfBounds(uint64 duration);

    // ---------------------------------------------------------------- actions

    /// @notice Set the warm-up for stakes made from now on. Owner only, `MIN_STAKE_DURATION` to
    ///         `MAX_STAKE_DURATION`. Buckets already warming keep their stamped end.
    function setMinStakeDuration(uint64 newDuration) external;

    /// @notice Stake `amount` FETTI (needs prior approval). It lands in the caller's warming
    ///         stake, shares rewards from now on, and what it accrues is paid at its activation.
    ///         Settles first.
    /// @param amount 18-dec.
    function stake(uint256 amount) external;

    /// @notice Unstake `amount` FETTI back to the wallet, warming stake first, then active.
    ///         Settles pending rewards (and a finished warm-up) first. Warming stake taken out
    ///         forfeits the same fraction of its accrued reward to the next notification.
    /// @param amount 18-dec.
    function unstake(uint256 amount) external;

    /// @notice Settle `user` and activate their warming stake if its warm-up is over.
    ///         Anyone may call it for anyone; it moves no tokens.
    function activate(address user) external;

    /// @notice Send the caller's earned USDC to their wallet.
    /// @return usdc Amount sent, 6-dec (0 is allowed and is a no-op).
    function claim() external returns (uint256 usdc);

    /// @notice Pull `usdc` from the caller (plus `carryUsdc`) and split it between active and
    ///         warming stake in proportion to their totals (all to warming while none is
    ///         active); nothing is split (all carried) while nothing is staked. Anyone may call it.
    /// @param usdc 6-dec amount; the caller must have approved it.
    function notifyReward(uint256 usdc) external;

    // ------------------------------------------------------------------ views

    /// @notice FETTI held here for `user` (active + warming), 18-dec.
    function stakedOf(address user) external view returns (uint256);

    /// @notice `user`'s active (earning) stake, 18-dec.
    function activeStakeOf(address user) external view returns (uint256);

    /// @notice `user`'s warming stake and when it can be activated (0 when none).
    function warmingOf(address user) external view returns (uint256 amount, uint64 activatesAt);

    /// @notice Total active stake, 18-dec (the active accumulator's denominator).
    function totalStaked() external view returns (uint256);

    /// @notice Total warming stake, 18-dec.
    function totalWarming() external view returns (uint256);

    /// @notice Active plus warming stake, 18-dec: every FETTI held here.
    function totalStake() external view returns (uint256);

    /// @notice Warm-up stamped on new stakes.
    function minStakeDuration() external view returns (uint64);

    /// @notice Lower bound of `minStakeDuration`: 1 hour.
    function MIN_STAKE_DURATION() external view returns (uint64);

    /// @notice Upper bound of `minStakeDuration`: 30 days.
    function MAX_STAKE_DURATION() external view returns (uint64);

    /// @notice USDC `user` could claim right now, 6-dec (a finished warm-up's accrual included).
    function earned(address user) external view returns (uint256 usdc);

    /// @notice USDC accrued on `user`'s warming stake, paid at its activation, 6-dec.
    function warmingRewardOf(address user) external view returns (uint256 usdc);

    /// @notice Cumulative reward per active staked token, scaled by 1e30.
    function accRewardPerShareE30() external view returns (uint256);

    /// @notice Cumulative reward per warming staked token, scaled by 1e30.
    function accWarmingRewardPerShareE30() external view returns (uint256);

    /// @notice Reward USDC waiting for the next notification, 6-dec.
    function carryUsdc() external view returns (uint256);

    /// @notice Total USDC ever notified, 6-dec.
    function totalRewardsUsdc() external view returns (uint256);

    function confetti() external view returns (address);
    function usdc() external view returns (address);
}
