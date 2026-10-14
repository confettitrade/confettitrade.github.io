// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IStaking} from "../../src/interfaces/IStaking.sol";
import {IExchange} from "../../src/interfaces/IExchange.sol";

/// @title StubStaking
/// @notice Test double for Staking used by the Exchange unit tests. `notifyReward` enforces the
///         real access rule and pull semantics (transferFrom from the caller) and records what it
///         received; `claim` delivers a test-set amount through `IExchange.depositFor` so the
///         Staking -> Exchange leg can be exercised. Staking itself is a no-op.
contract StubStaking is IStaking {
    using SafeERC20 for IERC20;

    address public immutable usdc;
    address public exchange;
    address public tokenomics;

    uint256 public totalRewardsUsdc;
    uint256 public notifyCalls;
    address public lastNotifier;
    uint256 public lastNotifiedUsdc;

    mapping(address => uint256) private _earned;

    constructor(address usdc_) {
        usdc = usdc_;
    }

    /// @inheritdoc IStaking
    function wire(address exchange_, address tokenomics_) external {
        if (exchange != address(0)) revert AlreadyWired();
        if (exchange_ == address(0) || tokenomics_ == address(0)) revert ZeroAddress();
        exchange = exchange_;
        tokenomics = tokenomics_;
        emit Wired(exchange_, tokenomics_);
    }

    /// @inheritdoc IStaking
    function notifyReward(uint256 usdcIn) external {
        if (msg.sender != exchange && msg.sender != tokenomics) revert NotRewarder();
        if (usdcIn == 0) revert ZeroAmount();
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcIn);
        totalRewardsUsdc += usdcIn;
        notifyCalls += 1;
        lastNotifier = msg.sender;
        lastNotifiedUsdc = usdcIn;
        emit RewardNotified(msg.sender, usdcIn, 0);
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
        IERC20(usdc).forceApprove(exchange, usdcOut);
        IExchange(exchange).depositFor(msg.sender, usdcOut);
        emit Claimed(msg.sender, usdcOut);
    }

    /// @inheritdoc IStaking
    function stake(uint256) external pure {}

    /// @inheritdoc IStaking
    function unstake(uint256) external pure {}

    /// @inheritdoc IStaking
    function stakedOf(address) external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IStaking
    function totalStaked() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IStaking
    function earned(address user) external view returns (uint256) {
        return _earned[user];
    }

    /// @inheritdoc IStaking
    function accRewardPerShareE30() external pure returns (uint256) {
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
