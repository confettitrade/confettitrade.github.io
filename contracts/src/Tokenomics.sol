// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ITokenomics} from "./interfaces/ITokenomics.sol";
import {IExchange} from "./interfaces/IExchange.sol";

/// @title Tokenomics
/// @notice CONFETTI mint curve and LP tally (DESIGN section 7).
/// @dev Units: every "Usd" value is a USDC 6-dec integer; rates are 1e18 fixed point
///      CONFETTI per $1. A mint basis of `b` USDC at rate `r` mints `b * r / 1e6` CONFETTI.
///
///      The curve has two regions, chosen by where `trackedLpUsd` sits right now:
///        - flat:  trackedLpUsd < flatThresholdUsd (negative included) -> rate = flatRateE18
///        - tail:  otherwise -> rate = flatRateE18 * S^2 / (S + tailProgressUsd)^2
///      `tailProgressUsd` only ever grows: each positive LP delta adds the slice of it that
///      lands above the threshold. Wins, fee payouts and staker sweeps pull `trackedLpUsd`
///      down but never touch `tailProgressUsd`, so once the tail has decayed it stays decayed.
///
///      The contract holds no USDC. `pushStakerFees` debits the tally and asks the Exchange
///      to hand the cash to Staking through `IExchange.sweepLpToStakers`.
///      `recordLoss` does not mint: `IConfetti.mint` is Exchange-only, so the Exchange mints
///      the returned amount to the loser itself.
///      Ownership is two-step (`Ownable2Step`), like the Exchange.
contract Tokenomics is ITokenomics, Ownable2Step {
    // -------------------------------------------------------------- constants

    /// @notice Default flat-region end (DESIGN section 7): $250K.
    uint256 public constant DEFAULT_FLAT_THRESHOLD_USD = 250_000e6;

    /// @notice Default tail decay scale S: $15M.
    uint256 public constant DEFAULT_TAIL_DECAY_SCALE_USD = 15_000_000e6;

    /// @notice Default staker cap: $500K.
    uint256 public constant DEFAULT_STAKER_CAP_USD = 500_000e6;

    /// @notice Default flat rate: 100 CONFETTI per $1.
    uint256 public constant DEFAULT_FLAT_RATE_E18 = 100e18;

    /// @notice Upper bound for every USD parameter ($1e18), keeps the curve math far from overflow.
    uint256 public constant MAX_PARAM_USD = 1e24;

    /// @notice Upper bound for the flat rate: one million CONFETTI per $1.
    uint256 public constant MAX_FLAT_RATE_E18 = 1_000_000e18;

    uint256 private constant USDC_UNIT = 1e6;

    // ------------------------------------------------------------------ state

    /// @notice Flat-region rate, fixed at deploy. 1e18 fixed point CONFETTI per $1.
    uint256 public immutable flatRateE18;

    /// @inheritdoc ITokenomics
    address public exchange;

    /// @notice Flat region ends here. USDC 6-dec.
    uint256 public flatThresholdUsd;

    /// @notice S in the tail formula. USDC 6-dec.
    uint256 public tailDecayScaleUsd;

    /// @notice LP above this is sweepable to stakers. USDC 6-dec.
    uint256 public stakerCapUsd;

    /// @inheritdoc ITokenomics
    int256 public trackedLpUsd;

    /// @inheritdoc ITokenomics
    uint256 public tailProgressUsd;

    /// @inheritdoc ITokenomics
    uint256 public totalMinted;

    // -------------------------------------------------------------- modifiers

    modifier onlyExchange() {
        if (msg.sender != exchange) revert NotExchange();
        _;
    }

    // ------------------------------------------------------------ constructor

    /// @param initialOwner Account that may wire the Exchange and tune parameters.
    /// @param flatThresholdUsd_ Flat region end, USDC 6-dec (DEFAULT_FLAT_THRESHOLD_USD).
    /// @param tailDecayScaleUsd_ S, USDC 6-dec (DEFAULT_TAIL_DECAY_SCALE_USD).
    /// @param stakerCapUsd_ Staker cap, USDC 6-dec (DEFAULT_STAKER_CAP_USD).
    /// @param flatRateE18_ Flat rate, 1e18 fixed point (DEFAULT_FLAT_RATE_E18). Fixed for life.
    constructor(
        address initialOwner,
        uint256 flatThresholdUsd_,
        uint256 tailDecayScaleUsd_,
        uint256 stakerCapUsd_,
        uint256 flatRateE18_
    ) Ownable(initialOwner) {
        if (flatRateE18_ == 0 || flatRateE18_ > MAX_FLAT_RATE_E18) {
            revert ParamOutOfBounds("flatRateE18", flatRateE18_);
        }
        flatRateE18 = flatRateE18_;
        _setParams(flatThresholdUsd_, tailDecayScaleUsd_, stakerCapUsd_);
    }

    // ---------------------------------------------------------------- wiring

    /// @inheritdoc ITokenomics
    function setExchange(address exchange_) external onlyOwner {
        if (exchange != address(0)) revert AlreadyWired();
        if (exchange_ == address(0)) revert ZeroAddress();
        exchange = exchange_;
        emit ExchangeSet(exchange_);
    }

    // ------------------------------------------------------------- recording

    /// @inheritdoc ITokenomics
    function recordLoss(uint256 lossUsdc) external onlyExchange returns (uint256 mintAmount) {
        uint256 rate = currentRateE18();
        mintAmount = lossUsdc * rate / USDC_UNIT;
        totalMinted += mintAmount;
        emit LossRecorded(lossUsdc, rate, mintAmount);
    }

    /// @inheritdoc ITokenomics
    function recordLpDelta(int256 deltaUsdc) external onlyExchange {
        int256 before = trackedLpUsd;
        int256 after_ = before + deltaUsdc;
        trackedLpUsd = after_;

        if (deltaUsdc > 0) {
            // Only the slice of the gain that sits above both the threshold and the
            // previous level counts as tail progress.
            // Safe: the threshold is bounded by MAX_PARAM_USD, far below 2^255.
            // forge-lint: disable-next-line(unsafe-typecast)
            int256 threshold = int256(flatThresholdUsd);
            int256 floor_ = before > threshold ? before : threshold;
            // Safe: the difference is positive by the guard.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (after_ > floor_) tailProgressUsd += uint256(after_ - floor_);
        }

        emit LpDeltaRecorded(deltaUsdc, after_, tailProgressUsd);
    }

    /// @inheritdoc ITokenomics
    function pushStakerFees() external returns (uint256 sweptUsdc) {
        int256 tracked = trackedLpUsd;
        // Safe: the cap is bounded by MAX_PARAM_USD.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 cap = int256(stakerCapUsd);
        if (tracked <= cap) revert NothingToSweep();

        IExchange ex = IExchange(exchange);
        if (ex.queuedTotal() != 0) revert NothingToSweep();

        // Safe: positive by the guard above.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 overflow = uint256(tracked - cap);
        uint256 cash = ex.lpBalance();
        sweptUsdc = overflow < cash ? overflow : cash;
        if (sweptUsdc == 0) revert NothingToSweep();

        // Safe: sweptUsdc <= overflow, which fits an int256.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 after_ = tracked - int256(sweptUsdc);
        trackedLpUsd = after_;
        emit StakerFeesPushed(sweptUsdc, after_);

        ex.sweepLpToStakers(sweptUsdc);
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc ITokenomics
    function setParams(uint256 flatThresholdUsd_, uint256 tailDecayScaleUsd_, uint256 stakerCapUsd_)
        external
        onlyOwner
    {
        _setParams(flatThresholdUsd_, tailDecayScaleUsd_, stakerCapUsd_);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ITokenomics
    function currentRateE18() public view returns (uint256) {
        uint256 rate = flatRateE18;
        // Safe: the threshold is bounded by MAX_PARAM_USD.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (trackedLpUsd < int256(flatThresholdUsd)) return rate;

        uint256 s = tailDecayScaleUsd;
        uint256 reach = s + tailProgressUsd;
        // rate * (S / (S + progress))^2, kept as one division for precision.
        return rate * s * s / (reach * reach);
    }

    /// @inheritdoc ITokenomics
    function params() external view returns (uint256, uint256, uint256, uint256) {
        return (flatThresholdUsd, tailDecayScaleUsd, stakerCapUsd, flatRateE18);
    }

    /// @inheritdoc ITokenomics
    function stakerOverflowUsd() external view returns (uint256) {
        int256 tracked = trackedLpUsd;
        // Safe: the cap is bounded by MAX_PARAM_USD, and the difference is only taken when positive.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 cap = int256(stakerCapUsd);
        // forge-lint: disable-next-line(unsafe-typecast)
        return tracked > cap ? uint256(tracked - cap) : 0;
    }

    // -------------------------------------------------------------- internals

    /// @dev Shared bounds check for the constructor and `setParams`.
    function _setParams(uint256 flatThresholdUsd_, uint256 tailDecayScaleUsd_, uint256 stakerCapUsd_) internal {
        if (stakerCapUsd_ > MAX_PARAM_USD) revert ParamOutOfBounds("stakerCapUsd", stakerCapUsd_);
        if (flatThresholdUsd_ > stakerCapUsd_) revert ParamOutOfBounds("flatThresholdUsd", flatThresholdUsd_);
        if (tailDecayScaleUsd_ == 0 || tailDecayScaleUsd_ > MAX_PARAM_USD) {
            revert ParamOutOfBounds("tailDecayScaleUsd", tailDecayScaleUsd_);
        }
        flatThresholdUsd = flatThresholdUsd_;
        tailDecayScaleUsd = tailDecayScaleUsd_;
        stakerCapUsd = stakerCapUsd_;
        emit ParamsSet(flatThresholdUsd_, tailDecayScaleUsd_, stakerCapUsd_);
    }
}
