// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IStaking} from "../../src/interfaces/IStaking.sol";

/// @title StubStaking
/// @notice Test double for Staking used by the Exchange unit tests. `notifyReward` keeps the real
///         pull semantics (transferFrom from the caller, any caller) and records what it received;
///         `claim` pays a test-set amount to the caller's wallet. Staking itself is a no-op.
contract StubStaking is IStaking {
    using SafeERC20 for IERC20;

    address public immutable usdc;

    uint256 public totalRewardsUsdc;
    uint256 public notifyCalls;
    address public lastNotifier;
    uint256 public lastNotifiedUsdc;

    /// @notice Active (earning) stake reported to the Exchange. Starts at 1 (an active staker
    ///         exists) so rewards flow; set 0 for the warm-up case.
    uint256 public totalStaked = 1;

    mapping(address => uint256) private _earned;

    constructor(address usdc_) {
        usdc = usdc_;
    }

    /// @inheritdoc IStaking
    function notifyReward(uint256 usdcIn) external {
        if (usdcIn == 0) revert ZeroAmount();
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcIn);
        totalRewardsUsdc += usdcIn;
        notifyCalls += 1;
        lastNotifier = msg.sender;
        lastNotifiedUsdc = usdcIn;
        emit RewardNotified(msg.sender, usdcIn, 0);
    }

    /// @notice Test helper: set what `totalStaked` reports.
    function setTotalStaked(uint256 totalStaked_) external {
        totalStaked = totalStaked_;
    }

    /// @notice Test helper: set what `claim` will deliver for `user`. The stub must hold the USDC.
    function setEarned(address user, uint256 usdcAmount) external {
        _earned[user] = usdcAmount;
    }

    /// @inheritdoc IStaking
    function claim() external returns (uint256 usdcOut) {
        usdcOut = _earned[msg.sender];
        if (usdcOut == 0) return 0;
        _earned[msg.sender] = 0;
        emit Claimed(msg.sender, usdcOut);
        IERC20(usdc).safeTransfer(msg.sender, usdcOut);
    }

    /// @inheritdoc IStaking
    function stake(uint256) external pure {}

    /// @inheritdoc IStaking
    function unstake(uint256) external pure {}

    /// @inheritdoc IStaking
    function activate(address) external pure {}

    /// @inheritdoc IStaking
    function setMinStakeDuration(uint64) external pure {}

    /// @inheritdoc IStaking
    function stakedOf(address) external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IStaking
    function activeStakeOf(address) external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IStaking
    function warmingOf(address) external pure returns (uint256, uint64) {
        return (0, 0);
    }

    /// @inheritdoc IStaking
    function totalWarming() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IStaking
    function totalStake() external view returns (uint256) {
        return totalStaked;
    }

    /// @inheritdoc IStaking
    function minStakeDuration() external pure returns (uint64) {
        return 1 hours;
    }

    /// @inheritdoc IStaking
    function MIN_STAKE_DURATION() external pure returns (uint64) {
        return 1 hours;
    }

    /// @inheritdoc IStaking
    function MAX_STAKE_DURATION() external pure returns (uint64) {
        return 30 days;
    }

    /// @inheritdoc IStaking
    function earned(address user) external view returns (uint256) {
        return _earned[user];
    }

    /// @inheritdoc IStaking
    function warmingRewardOf(address) external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IStaking
    function accRewardPerShareE30() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IStaking
    function accWarmingRewardPerShareE30() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IStaking
    function carryUsdc() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IStaking
    function confetti() external pure returns (address) {
        return address(0);
    }
}
