// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ITokenomics} from "../../src/interfaces/ITokenomics.sol";
import {IExchange} from "../../src/interfaces/IExchange.sol";

/// @title StubTokenomics
/// @notice Test double for Tokenomics used by the Exchange unit tests. Mints at a flat rate of
///         100 CONFETTI per $1 (tests may override it with `setRateE18`, e.g. to 0 to make a
///         loss mint nothing), keeps a plain running `trackedLpUsd`, and records every call
///         (with a global sequence number) so tests can assert amounts and call order.
/// @dev `pushStakerFees` mirrors the real contract closely enough to exercise
///      `IExchange.sweepLpToStakers`: min(trackedLpUsd - stakerCap, exchange.lpBalance()).
contract StubTokenomics is ITokenomics {
    uint256 public constant FLAT_RATE_E18 = 100e18;
    uint256 private constant USDC_UNIT = 1e6;

    address public exchange;
    int256 public trackedLpUsd;
    uint256 public tailProgressUsd;
    uint256 public totalMinted;
    uint256 public rateE18 = FLAT_RATE_E18;

    uint256 public flatThresholdUsd = 250_000e6;
    uint256 public tailDecayScaleUsd = 15_000_000e6;
    uint256 public stakerCapUsd = 500_000e6;

    /// @notice Call recording.
    uint256 public sequence;
    uint256 public lossCalls;
    uint256 public lastLossBasisUsdc;
    uint256 public lastLossSequence;
    uint256 public deltaCalls;
    int256 public lastDeltaUsdc;
    uint256 public lastDeltaSequence;

    modifier onlyExchange() {
        if (msg.sender != exchange) revert NotExchange();
        _;
    }

    /// @inheritdoc ITokenomics
    function setExchange(address exchange_) external {
        if (exchange_ == address(0)) revert ZeroAddress();
        exchange = exchange_;
        emit ExchangeSet(exchange_);
    }

    /// @inheritdoc ITokenomics
    function recordLoss(uint256 lossUsdc) external onlyExchange returns (uint256 mintAmount) {
        uint256 rate = rateE18;
        mintAmount = lossUsdc * rate / USDC_UNIT;
        totalMinted += mintAmount;
        lossCalls += 1;
        lastLossBasisUsdc = lossUsdc;
        lastLossSequence = ++sequence;
        emit LossRecorded(lossUsdc, rate, mintAmount);
    }

    /// @notice Test helper: override the mint rate (1e18 fixed point CONFETTI per $1).
    function setRateE18(uint256 rateE18_) external {
        rateE18 = rateE18_;
    }

    /// @inheritdoc ITokenomics
    function recordLpDelta(int256 deltaUsdc) external onlyExchange {
        trackedLpUsd += deltaUsdc;
        deltaCalls += 1;
        lastDeltaUsdc = deltaUsdc;
        lastDeltaSequence = ++sequence;
        emit LpDeltaRecorded(deltaUsdc, trackedLpUsd, tailProgressUsd);
    }

    /// @inheritdoc ITokenomics
    function pushStakerFees() external returns (uint256 sweptUsdc) {
        if (IExchange(exchange).queuedTotal() != 0) revert NothingToSweep();
        uint256 overflow = stakerOverflowUsd();
        uint256 cash = IExchange(exchange).lpBalance();
        sweptUsdc = overflow < cash ? overflow : cash;
        if (sweptUsdc == 0) revert NothingToSweep();
        trackedLpUsd -= int256(sweptUsdc);
        IExchange(exchange).sweepLpToStakers(sweptUsdc);
        emit StakerFeesPushed(sweptUsdc, trackedLpUsd);
    }

    /// @notice Test helper: forward an arbitrary sweep request to the Exchange as Tokenomics.
    function sweep(uint256 amountUsdc) external {
        IExchange(exchange).sweepLpToStakers(amountUsdc);
    }

    /// @inheritdoc ITokenomics
    function setParams(uint256 flatThresholdUsd_, uint256 tailDecayScaleUsd_, uint256 stakerCapUsd_) external {
        flatThresholdUsd = flatThresholdUsd_;
        tailDecayScaleUsd = tailDecayScaleUsd_;
        stakerCapUsd = stakerCapUsd_;
        emit ParamsSet(flatThresholdUsd_, tailDecayScaleUsd_, stakerCapUsd_);
    }

    /// @inheritdoc ITokenomics
    function currentRateE18() external view returns (uint256) {
        return rateE18;
    }

    /// @inheritdoc ITokenomics
    function params() external view returns (uint256, uint256, uint256, uint256) {
        return (flatThresholdUsd, tailDecayScaleUsd, stakerCapUsd, rateE18);
    }

    /// @inheritdoc ITokenomics
    function stakerOverflowUsd() public view returns (uint256) {
        int256 over = trackedLpUsd - int256(stakerCapUsd);
        return over > 0 ? uint256(over) : 0;
    }
}
