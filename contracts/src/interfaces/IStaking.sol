// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IStaking
/// @notice Stake CONFETTI, earn USDC dividends (DESIGN section 7).
/// @dev No lockup. Rewards use a 1e30-scaled accumulator (`accRewardPerShareE30`); any
///      reward that cannot be split (no stakers, or the division remainder) is held in
///      `carryUsdc` and folded into the next notification.
///      Custody: Staking holds the reward USDC. `notifyReward` pulls it from the caller with
///      `transferFrom`, so the caller approves first. `claim` does not send USDC to the
///      wallet; it approves the Exchange and calls `IExchange.depositFor(user, amount)` so the
///      dividend lands in the user's exchange balance.
///      Deploy order: Staking is deployed before the Exchange, so the owner wires the Exchange
///      and Tokenomics addresses once with `wire`. Only those two may call `notifyReward`.
interface IStaking {
    // ----------------------------------------------------------------- events

    event Wired(address indexed exchange, address indexed tokenomics);
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 usdc);
    event RewardNotified(address indexed from, uint256 usdc, uint256 accRewardPerShareE30After);

    // ----------------------------------------------------------------- errors

    error NotRewarder();
    error AlreadyWired();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientStake(uint256 staked, uint256 requested);

    // ---------------------------------------------------------------- actions

    /// @notice One-time: set the two addresses allowed to notify rewards. Owner only.
    /// @param exchange Exchange address.
    /// @param tokenomics Tokenomics address.
    function wire(address exchange, address tokenomics) external;

    /// @notice Stake `amount` CONFETTI (needs prior approval). Settles pending rewards first.
    /// @param amount 18-dec.
    function stake(uint256 amount) external;

    /// @notice Unstake `amount` CONFETTI back to the wallet. Settles pending rewards first.
    /// @param amount 18-dec.
    function unstake(uint256 amount) external;

    /// @notice Move the caller's earned USDC into their Exchange balance.
    /// @return usdc Amount delivered, 6-dec (0 is allowed and is a no-op).
    function claim() external returns (uint256 usdc);

    /// @notice Pull `usdc` from the caller and distribute it across current stakes. Exchange or Tokenomics only.
    /// @param usdc 6-dec amount; the caller must have approved it.
    function notifyReward(uint256 usdc) external;

    // ------------------------------------------------------------------ views

    /// @notice CONFETTI staked by `user`, 18-dec.
    function stakedOf(address user) external view returns (uint256);

    /// @notice Total CONFETTI staked, 18-dec.
    function totalStaked() external view returns (uint256);

    /// @notice USDC `user` could claim right now, 6-dec.
    function earned(address user) external view returns (uint256 usdc);

    /// @notice Cumulative reward per staked token, scaled by 1e30.
    function accRewardPerShareE30() external view returns (uint256);

    /// @notice Reward USDC waiting for the next notification (undistributable dust), 6-dec.
    function carryUsdc() external view returns (uint256);

    /// @notice Total USDC ever notified, 6-dec.
    function totalRewardsUsdc() external view returns (uint256);

    function confetti() external view returns (address);
    function usdc() external view returns (address);
    function exchange() external view returns (address);
    function tokenomics() external view returns (address);
}
