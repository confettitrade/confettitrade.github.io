// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IExchangeTypes} from "./IExchangeTypes.sol";
import {ImpactLib} from "../lib/ImpactLib.sol";

/// @title IMarketRules
/// @notice Stateless module of the Exchange: the settlement quote of a close and the owner
///         bounds on market parameters. Split out of the Exchange only to keep it under the
///         24,576-byte runtime limit; the Exchange creates it in its constructor and calls it
///         for every close, preview and market-parameter change.
/// @dev Pure functions. A bounds check reverts with the Exchange's own errors
///      (`IExchange.ParamOutOfBounds`), which the Exchange bubbles unchanged.
interface IMarketRules {
    /// @notice Signed outcome of closing `pos` at `exitPx18`: (true, adjusted gain) for a win
    ///         after the position's deadband, the impact curve `c` and the position's stamped
    ///         maximum profit; (false, loss capped at the margin) for a loss. `amount == 0`
    ///         means flat.
    /// @return isWin Direction of the outcome.
    /// @return amount Adjusted gain (win) or capped loss, USDC 6-dec.
    /// @return forfeitedUsdc Part of a winning gain above `pos.maxProfitUsdc`, kept by the house.
    function quote(IExchangeTypes.Position calldata pos, ImpactLib.Curve calldata c, uint256 exitPx18)
        external
        pure
        returns (bool isWin, uint256 amount, uint256 forfeitedUsdc);

    /// @notice Bounds of `IExchange.setDelays`: minDelay 2..30, grace 1..10, expiry 20..300 and
    ///         minDelay + grace < expiry.
    function checkDelays(uint32 minDelay, uint32 grace, uint32 expiry) external pure;

    /// @notice Every bound of `IExchange.addInstrument`: tier 0..2 (`IExchange.InvalidTier`),
    ///         then `checkLeverage`, `checkParams`, `checkOiCaps`, `checkPositionCaps` and
    ///         `checkHouseSizing` on the spec's fields, in that order.
    function checkInstrument(IExchangeTypes.Instrument calldata spec) external pure;
    /// @notice Bounds of `IExchange.setInstrumentParams` (and the same fields of a new market).
    function checkParams(
        uint16 deadbandBps,
        uint16 clampBps,
        uint16 baseRateBps,
        uint64 rateMultiplier,
        uint128 referenceNotionalUsd,
        uint128 positionMultiplierE6
    ) external pure;

    /// @notice Per-side OI caps within the tier's ceiling.
    function checkOiCaps(uint8 tier, uint128 longOiCapUsd, uint128 shortOiCapUsd) external pure;

    /// @notice Per-position notional cap (0, $1M] and payout cap 10..50.
    function checkPositionCaps(uint128 maxNotionalUsd, uint16 payoutCapX) external pure;

    /// @notice House-sized multipliers posX10 10..200, sideX10 10..500 and stress move 10..5000 bps.
    function checkHouseSizing(uint16 posX10, uint16 sideX10, uint16 stressBps) external pure;

    /// @notice Entry spread 0..50 bps and borrow rate 0..50 tenths of a bps per hour.
    function checkMarketFees(uint16 entryDeadbandBps, uint16 borrowRateX10) external pure;

    /// @notice Max leverage 1..1000.
    function checkLeverage(uint32 maxLeverage) external pure;
}
