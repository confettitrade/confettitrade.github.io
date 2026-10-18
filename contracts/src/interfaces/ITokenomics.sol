// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ITokenomics
/// @notice CONFETTI mint curve and LP accounting (DESIGN section 7).
/// @dev Units: USD amounts are USDC 6-dec integers ("Usd" suffix). Rates are 1e18 fixed
///      point CONFETTI per $1: `flatRate = 100` is stored as `100e18`, and a loss of
///      `basisUsdc` mints `basisUsdc * rateE18 / 1e6` CONFETTI (18-dec).
///      Curve: while `trackedLpUsd < flatThresholdUsd` (including negative) the rate is
///      `flatRateE18`. Past it, `tailProgressUsd` is a one-way high-water mark of cumulative LP
///      gain above the threshold and the rate is `flatRateE18 * S^2 / (S + tailProgress)^2`
///      with `S = tailDecayScaleUsd`.
///      Call order from the Exchange on a losing settlement: `recordLoss(basis)` first (rate
///      reflects the LP state before this loss), then `recordLpDelta(+loss)`. Wins and fee
///      payouts call `recordLpDelta` with a negative delta when the LP pays (or queues) them.
///      The contract holds no USDC; `pushStakerFees` asks the Exchange to move the cash.
interface ITokenomics {
    // ----------------------------------------------------------------- events

    event ExchangeSet(address indexed exchange);
    event LossRecorded(uint256 basisUsdc, uint256 rateE18, uint256 mintAmount);
    event LpDeltaRecorded(int256 deltaUsdc, int256 trackedLpUsdAfter, uint256 tailProgressUsdAfter);
    event StakerFeesPushed(uint256 amountUsdc, int256 trackedLpUsdAfter);
    event ParamsSet(uint256 flatThresholdUsd, uint256 tailDecayScaleUsd, uint256 stakerCapUsd);

    // ----------------------------------------------------------------- errors

    error NotExchange();
    error Unauthorized();
    error AlreadyWired();
    error ZeroAddress();
    error NothingToSweep();
    error ParamOutOfBounds(string name, uint256 value);

    // ---------------------------------------------------------------- wiring

    /// @notice One-time: set the Exchange that may record losses and LP deltas. Owner only.
    /// @param exchange Exchange address.
    function setExchange(address exchange) external;

    // ------------------------------------------------------------- recording

    /// @notice Compute the CONFETTI to mint for a loss at the current rate and tally it. Exchange only.
    /// @dev Does not touch `trackedLpUsd`; the Exchange follows with `recordLpDelta`.
    /// @param lossUsdc Mint basis, USDC 6-dec (loss net of the loss fee when the queue is empty).
    /// @return mintAmount CONFETTI 18-dec; the Exchange mints it to the loser.
    function recordLoss(uint256 lossUsdc) external returns (uint256 mintAmount);

    /// @notice Apply a signed change to the LP tally. Exchange only.
    /// @dev Positive on losses in, negative on wins and fees out. Advances `tailProgressUsd`
    ///      by the part of a positive delta that lands above `flatThresholdUsd`.
    /// @param deltaUsdc Signed USDC 6-dec.
    function recordLpDelta(int256 deltaUsdc) external;

    /// @notice Sweep every dollar of `trackedLpUsd` above `stakerCapUsd` to stakers. Permissionless.
    /// @dev Amount = min(trackedLpUsd - stakerCapUsd, exchange.lpBalance()); reverts
    ///      `NothingToSweep` when that is zero or the queue is active. Debits `trackedLpUsd`,
    ///      never `tailProgressUsd`, then calls `IExchange.sweepLpToStakers(amount)`.
    /// @return sweptUsdc Amount moved.
    function pushStakerFees() external returns (uint256 sweptUsdc);

    // ------------------------------------------------------------------ admin

    /// @notice Set the curve parameters within bounds. Owner only.
    /// @dev Bounds: flatThresholdUsd <= stakerCapUsd, tailDecayScaleUsd > 0. flatRateE18 is
    ///      fixed at deploy.
    function setParams(uint256 flatThresholdUsd, uint256 tailDecayScaleUsd, uint256 stakerCapUsd) external;

    // ------------------------------------------------------------------ views

    /// @notice Running LP profit and loss, USDC 6-dec, may be negative while the queue is owed.
    function trackedLpUsd() external view returns (int256);

    /// @notice One-way high-water mark of LP gain past the flat threshold, USDC 6-dec.
    function tailProgressUsd() external view returns (uint256);

    /// @notice CONFETTI per $1 at this moment, 1e18 fixed point.
    function currentRateE18() external view returns (uint256);

    /// @notice Curve parameters.
    /// @return flatThresholdUsd Flat region ends here (default 250_000e6).
    /// @return tailDecayScaleUsd S in the tail formula (default 15_000_000e6).
    /// @return stakerCapUsd LP above this is sweepable to stakers (default 500_000e6).
    /// @return flatRateE18 Flat-region rate (default 100e18).
    function params()
        external
        view
        returns (uint256 flatThresholdUsd, uint256 tailDecayScaleUsd, uint256 stakerCapUsd, uint256 flatRateE18);

    /// @notice max(0, trackedLpUsd - stakerCapUsd), before the LP-cash bound.
    function stakerOverflowUsd() external view returns (uint256);

    /// @notice CONFETTI minted through `recordLoss` so far, 18-dec.
    function totalMinted() external view returns (uint256);

    /// @notice The Exchange, zero until wired.
    function exchange() external view returns (address);
}
