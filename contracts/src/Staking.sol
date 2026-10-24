// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IStaking} from "./interfaces/IStaking.sol";

/// @title Staking
/// @notice Stake FETTI (the existing token: the one v3 Staking stakes and the FETTI / WHYPE pool
///         trades), earn USDC from the v4 exchange's fee pushes. No lockup: unstake at any time.
///         See IStaking for the warm-up and reward rules. It never mints or burns FETTI.
/// @dev Reward accounting is a per-share accumulator scaled by 1e30: every notification adds
///      `reward * 1e30 / supply` to an accumulator, and a staker's unsettled reward is
///      `stake * (acc - snapshot) / 1e30`. Stakes are 18-dec and rewards 6-dec, so the 1e30
///      scale leaves twelve digits of headroom below one micro-USDC.
///      A stake first lands in the staker's warming bucket, outside `totalStaked` (the active
///      supply), with its activation time stamped (`_activatesAt`). The next touch of the
///      account after that time moves it into the active stake. A top-up moves the stamp to
///      the amount-weighted average of the old stamp and now + `minStakeDuration`, so neither
///      a top-up nor an owner change of the duration restarts or lengthens a running warm-up
///      more than its own share. `unstake` takes from the warming bucket first.
///      A notification is split between active and warming stake in proportion to their
///      supplies. The warming part goes to `accWarmingRewardPerShareE30`, which a warming
///      bucket collects only when it activates; unstaking warming stake forfeits the same
///      fraction of what that bucket has accrued into `carryUsdc`, for everyone on the next
///      notification. Whatever a notification cannot split waits in `carryUsdc`. Sub-unit
///      remainders live inside the accumulators, so the contract never promises more USDC
///      than it holds. USDC stays here until `claim`, which sends it to the wallet.
///      Ownership is two-step (`Ownable2Step`); the owner only sets the warm-up.
contract Staking is IStaking, Ownable2Step {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------- constants

    /// @notice Scale of `accRewardPerShareE30`.
    uint256 public constant ACC_SCALE = 1e30;

    /// @inheritdoc IStaking
    uint64 public constant MIN_STAKE_DURATION = 1 hours;

    /// @inheritdoc IStaking
    uint64 public constant MAX_STAKE_DURATION = 30 days;

    // ------------------------------------------------------------------ state

    /// @inheritdoc IStaking
    address public immutable confetti;

    /// @inheritdoc IStaking
    address public immutable usdc;

    /// @inheritdoc IStaking
    uint256 public totalStaked;

    /// @inheritdoc IStaking
    uint256 public totalWarming;

    /// @inheritdoc IStaking
    uint256 public accRewardPerShareE30;

    /// @inheritdoc IStaking
    uint256 public accWarmingRewardPerShareE30;

    /// @inheritdoc IStaking
    uint256 public carryUsdc;

    /// @inheritdoc IStaking
    uint256 public totalRewardsUsdc;

    /// @inheritdoc IStaking
    uint64 public minStakeDuration;

    /// @dev Active (earning) stake.
    mapping(address => uint256) private _staked;
    /// @dev Warming stake and the time it activates.
    mapping(address => uint256) private _warming;
    mapping(address => uint64) private _activatesAt;
    /// @dev Value of `accRewardPerShareE30` the last time the user was settled.
    mapping(address => uint256) private _snapshotE30;
    /// @dev Value of `accWarmingRewardPerShareE30` the last time the user was settled.
    mapping(address => uint256) private _warmSnapshotE30;
    /// @dev Settled but unclaimed USDC.
    mapping(address => uint256) private _pendingUsdc;
    /// @dev USDC accrued on the warming bucket, paid into `_pendingUsdc` at its activation.
    mapping(address => uint256) private _warmingRewardUsdc;

    // ------------------------------------------------------------ constructor

    /// @param initialOwner Account that may set the warm-up.
    /// @param confetti_ The FETTI token (the existing one; v4 deploys no token).
    /// @param usdc_ USDC token (6 decimals).
    /// @param minStakeDuration_ Warm-up before a new stake is active, within the bounds.
    constructor(address initialOwner, address confetti_, address usdc_, uint64 minStakeDuration_)
        Ownable(initialOwner)
    {
        if (confetti_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        _checkDuration(minStakeDuration_);
        confetti = confetti_;
        usdc = usdc_;
        minStakeDuration = minStakeDuration_;
        emit MinStakeDurationSet(minStakeDuration_);
    }

    // ---------------------------------------------------------------- actions

    /// @inheritdoc IStaking
    function setMinStakeDuration(uint64 newDuration) external onlyOwner {
        _checkDuration(newDuration);
        minStakeDuration = newDuration;
        emit MinStakeDurationSet(newDuration);
    }

    /// @inheritdoc IStaking
    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _book(msg.sender, amount);
        IERC20(confetti).safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @inheritdoc IStaking
    function unstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _settle(msg.sender);
        uint256 warming = _warming[msg.sender];
        uint256 active = _staked[msg.sender];
        if (amount > warming + active) revert InsufficientStake(warming + active, amount);
        uint256 fromWarming = amount < warming ? amount : warming;
        if (fromWarming != 0) {
            // The forfeited fraction of the bucket's accrual goes back to everyone.
            uint256 accrued = _warmingRewardUsdc[msg.sender];
            if (accrued != 0) {
                uint256 forfeit = accrued * fromWarming / warming;
                _warmingRewardUsdc[msg.sender] = accrued - forfeit;
                carryUsdc += forfeit;
            }
            _warming[msg.sender] = warming - fromWarming;
            totalWarming -= fromWarming;
        }
        uint256 fromActive = amount - fromWarming;
        if (fromActive != 0) {
            _staked[msg.sender] = active - fromActive;
            totalStaked -= fromActive;
        }
        IERC20(confetti).safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @inheritdoc IStaking
    function activate(address user) external {
        _settle(user);
    }

    /// @inheritdoc IStaking
    function claim() external returns (uint256 usdcOut) {
        _settle(msg.sender);
        usdcOut = _pendingUsdc[msg.sender];
        if (usdcOut == 0) return 0;
        _pendingUsdc[msg.sender] = 0;
        emit Claimed(msg.sender, usdcOut);
        IERC20(usdc).safeTransfer(msg.sender, usdcOut);
    }

    /// @inheritdoc IStaking
    function notifyReward(uint256 usdcIn) external {
        if (usdcIn == 0) revert ZeroAmount();

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcIn);
        totalRewardsUsdc += usdcIn;

        uint256 pool = usdcIn + carryUsdc;
        uint256 active = totalStaked;
        uint256 warming = totalWarming;
        if (active + warming == 0) {
            carryUsdc = pool;
        } else {
            // Warming stake earns its share too, paid when it activates (or partly forfeited
            // back to everyone on an early unstake), so rewards flow even before anyone's
            // warm-up has been settled into the active bucket.
            uint256 toWarming = pool * warming / (active + warming);
            uint256 left;
            if (active != 0) {
                uint256 perShare;
                (perShare, left) = _spread(pool - toWarming, active);
                accRewardPerShareE30 += perShare;
            }
            if (toWarming != 0) {
                (uint256 perWarm, uint256 leftWarm) = _spread(toWarming, warming);
                accWarmingRewardPerShareE30 += perWarm;
                left += leftWarm;
            }
            carryUsdc = left;
        }
        emit RewardNotified(msg.sender, usdcIn, accRewardPerShareE30);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IStaking
    function stakedOf(address user) external view returns (uint256) {
        return _staked[user] + _warming[user];
    }

    /// @inheritdoc IStaking
    function activeStakeOf(address user) external view returns (uint256) {
        return _staked[user];
    }

    /// @inheritdoc IStaking
    function warmingOf(address user) external view returns (uint256 amount, uint64 activatesAt) {
        amount = _warming[user];
        if (amount != 0) activatesAt = _activatesAt[user];
    }

    /// @inheritdoc IStaking
    function totalStake() external view returns (uint256) {
        return totalStaked + totalWarming;
    }

    /// @inheritdoc IStaking
    function warmingRewardOf(address user) public view returns (uint256) {
        return _warmingRewardUsdc[user] + _unsettledWarming(user);
    }

    /// @inheritdoc IStaking
    function earned(address user) external view returns (uint256 usdc_) {
        usdc_ = _pendingUsdc[user] + _unsettled(user);
        if (_warmingDue(user)) usdc_ += warmingRewardOf(user);
    }

    // -------------------------------------------------------------- internals

    /// @dev Settle `user`, then add `amount` to their warming bucket with the activation time
    ///      moved to the amount-weighted average of the old stamp and a fresh warm-up.
    function _book(address user, uint256 amount) private {
        _settle(user);
        uint256 warming = _warming[user];
        uint64 fresh = uint64(block.timestamp) + minStakeDuration;
        if (warming == 0) {
            _activatesAt[user] = fresh;
        } else {
            uint256 weighted = (uint256(_activatesAt[user]) * warming + uint256(fresh) * amount) / (warming + amount);
            _activatesAt[user] = uint64(weighted);
        }
        _warming[user] = warming + amount;
        totalWarming += amount;
    }

    /// @dev Move the user's unsettled rewards into `_pendingUsdc` (active) and
    ///      `_warmingRewardUsdc` (warming), refresh both snapshots, then activate a warming
    ///      bucket whose warm-up is over and pay out what it accrued. The order matters: the
    ///      rewards are settled on the old buckets, and the activated amount starts from the
    ///      current active accumulator, so nothing is counted twice.
    function _settle(address user) private {
        uint256 owed = _unsettled(user);
        if (owed != 0) _pendingUsdc[user] += owed;
        _snapshotE30[user] = accRewardPerShareE30;

        uint256 warmOwed = _unsettledWarming(user);
        if (warmOwed != 0) _warmingRewardUsdc[user] += warmOwed;
        _warmSnapshotE30[user] = accWarmingRewardPerShareE30;

        if (_warmingDue(user)) {
            uint256 warming = _warming[user];
            _warming[user] = 0;
            _staked[user] += warming;
            totalWarming -= warming;
            totalStaked += warming;
            uint256 vested = _warmingRewardUsdc[user];
            if (vested != 0) {
                _warmingRewardUsdc[user] = 0;
                _pendingUsdc[user] += vested;
            }
            emit Activated(user, warming);
        }
    }

    /// @dev True when `user` has a warming bucket whose warm-up is over.
    function _warmingDue(address user) private view returns (bool) {
        return _warming[user] != 0 && block.timestamp >= _activatesAt[user];
    }

    /// @dev Reward earned on the active stake since the user's last settlement.
    function _unsettled(address user) private view returns (uint256) {
        uint256 s = _staked[user];
        if (s == 0) return 0;
        return s * (accRewardPerShareE30 - _snapshotE30[user]) / ACC_SCALE;
    }

    /// @dev Reward accrued on the warming bucket since the user's last settlement.
    function _unsettledWarming(address user) private view returns (uint256) {
        uint256 w = _warming[user];
        if (w == 0) return 0;
        return w * (accWarmingRewardPerShareE30 - _warmSnapshotE30[user]) / ACC_SCALE;
    }

    /// @dev Per-share increment for spreading `amount` over `supply`, and the whole USDC units
    ///      the accumulator could not absorb.
    function _spread(uint256 amount, uint256 supply) private pure returns (uint256 perShare, uint256 left) {
        uint256 scaled = amount * ACC_SCALE;
        perShare = scaled / supply;
        // forge-lint: disable-next-line(divide-before-multiply)
        left = (scaled - perShare * supply) / ACC_SCALE;
    }

    function _checkDuration(uint64 duration) private pure {
        if (duration < MIN_STAKE_DURATION || duration > MAX_STAKE_DURATION) revert DurationOutOfBounds(duration);
    }
}
