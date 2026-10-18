// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {IExchange} from "./interfaces/IExchange.sol";

/// @title Staking
/// @notice Stake CONFETTI, earn USDC (DESIGN section 7). No lockup, instant stake and unstake.
/// @dev Reward accounting is a per-share accumulator scaled by 1e30: every notification adds
///      `reward * 1e30 / totalStaked` to `accRewardPerShareE30`, and a staker's unsettled
///      reward is `staked * (acc - snapshot) / 1e30`. Stakes are 18-dec and rewards 6-dec, so
///      the 1e30 scale leaves twelve digits of headroom below one micro-USDC.
///      Whatever a notification cannot split, because nobody is staked or because whole
///      units are left over by the division, waits in `carryUsdc` and rides along with the
///      next one. Sub-unit remainders live inside the accumulator, so the contract never
///      promises more USDC than it holds.
///      USDC stays here until `claim`, which hands it to the Exchange with `depositFor` so the
///      dividend shows up in the staker's exchange balance rather than their wallet.
///      Ownership is two-step (`Ownable2Step`), like the Exchange.
contract Staking is IStaking, Ownable2Step {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------- constants

    /// @notice Scale of `accRewardPerShareE30`.
    uint256 public constant ACC_SCALE = 1e30;

    // ------------------------------------------------------------------ state

    /// @inheritdoc IStaking
    address public immutable confetti;

    /// @inheritdoc IStaking
    address public immutable usdc;

    /// @inheritdoc IStaking
    address public exchange;

    /// @inheritdoc IStaking
    address public tokenomics;

    /// @inheritdoc IStaking
    uint256 public totalStaked;

    /// @inheritdoc IStaking
    uint256 public accRewardPerShareE30;

    /// @inheritdoc IStaking
    uint256 public carryUsdc;

    /// @inheritdoc IStaking
    uint256 public totalRewardsUsdc;

    mapping(address => uint256) private _staked;
    /// @dev Value of `accRewardPerShareE30` the last time the user was settled.
    mapping(address => uint256) private _snapshotE30;
    /// @dev Settled but unclaimed USDC.
    mapping(address => uint256) private _pendingUsdc;

    // ------------------------------------------------------------ constructor

    /// @param initialOwner Account that may wire the rewarders.
    /// @param confetti_ CONFETTI token.
    /// @param usdc_ USDC token (6 decimals).
    constructor(address initialOwner, address confetti_, address usdc_) Ownable(initialOwner) {
        if (confetti_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        confetti = confetti_;
        usdc = usdc_;
    }

    // ---------------------------------------------------------------- actions

    /// @inheritdoc IStaking
    function wire(address exchange_, address tokenomics_) external onlyOwner {
        if (exchange != address(0)) revert AlreadyWired();
        if (exchange_ == address(0) || tokenomics_ == address(0)) revert ZeroAddress();
        exchange = exchange_;
        tokenomics = tokenomics_;
        emit Wired(exchange_, tokenomics_);
    }

    /// @inheritdoc IStaking
    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _settle(msg.sender);
        _staked[msg.sender] += amount;
        totalStaked += amount;
        IERC20(confetti).safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @inheritdoc IStaking
    function unstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 have = _staked[msg.sender];
        if (amount > have) revert InsufficientStake(have, amount);
        _settle(msg.sender);
        _staked[msg.sender] = have - amount;
        totalStaked -= amount;
        IERC20(confetti).safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @inheritdoc IStaking
    function claim() external returns (uint256 usdcOut) {
        _settle(msg.sender);
        usdcOut = _pendingUsdc[msg.sender];
        if (usdcOut == 0) return 0;
        _pendingUsdc[msg.sender] = 0;
        emit Claimed(msg.sender, usdcOut);

        address exchange_ = exchange;
        IERC20(usdc).forceApprove(exchange_, usdcOut);
        IExchange(exchange_).depositFor(msg.sender, usdcOut);
    }

    /// @inheritdoc IStaking
    function notifyReward(uint256 usdcIn) external {
        if (msg.sender != exchange && msg.sender != tokenomics) revert NotRewarder();
        if (usdcIn == 0) revert ZeroAmount();

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcIn);
        totalRewardsUsdc += usdcIn;

        uint256 pool = usdcIn + carryUsdc;
        uint256 supply = totalStaked;
        if (supply == 0) {
            carryUsdc = pool;
        } else {
            uint256 scaled = pool * ACC_SCALE;
            uint256 perShare = scaled / supply;
            accRewardPerShareE30 += perShare;
            // Whole USDC units the accumulator could not absorb wait for the next round.
            // The remainder is below `supply` in scaled units, so this is non-zero only
            // when more than 1e30 wei of CONFETTI is staked; sub-unit dust is already
            // committed to stakers through the accumulator and is never reserved twice.
            // forge-lint: disable-next-line(divide-before-multiply)
            carryUsdc = (scaled - perShare * supply) / ACC_SCALE;
        }
        emit RewardNotified(msg.sender, usdcIn, accRewardPerShareE30);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IStaking
    function stakedOf(address user) external view returns (uint256) {
        return _staked[user];
    }

    /// @inheritdoc IStaking
    function earned(address user) external view returns (uint256) {
        return _pendingUsdc[user] + _unsettled(user);
    }

    // -------------------------------------------------------------- internals

    /// @dev Move the user's unsettled reward into `_pendingUsdc` and refresh their snapshot.
    function _settle(address user) internal {
        uint256 owed = _unsettled(user);
        if (owed != 0) _pendingUsdc[user] += owed;
        _snapshotE30[user] = accRewardPerShareE30;
    }

    /// @dev Reward earned since the user's last settlement.
    function _unsettled(address user) internal view returns (uint256) {
        uint256 s = _staked[user];
        if (s == 0) return 0;
        return s * (accRewardPerShareE30 - _snapshotE30[user]) / ACC_SCALE;
    }
}
