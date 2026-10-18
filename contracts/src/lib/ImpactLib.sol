// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ImpactLib
/// @notice Pure settlement arithmetic for the Confetti exchange (DESIGN sections 5 and 6):
///         deadband, impact scale, fees, bust price and the loss split.
/// @dev Units: prices are 1e18 fixed point, USDC amounts are 6-decimal integers, bps = 1/10000.
///      Rounding policy: every division rounds in the LP's favour by at most one unit of the
///      result (1 wei of price or 1e-6 USDC):
///        - the deadband exit rounds against the trader (down for longs, up for shorts);
///        - a winning gain, the impact scale and the adjusted gain round down;
///        - the impact denominator terms round up (a larger denominator means a smaller scale);
///        - a loss rounds up before it is capped at the margin;
///        - the bust price rounds toward liquidation (up for longs, down for shorts);
///        - fees and the bounty round down. On a loss that leaves one more unit in the LP; on
///          a win it leaves one more unit with the trader, which does not change what the LP
///          pays (the LP pays the adjusted gain in both cases).
library ImpactLib {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @notice Highest fee rate on wins, losses and liquidations: 5%. The Exchange owner may set
    ///         any rate from 0 to this; it starts at the cap.
    uint256 internal constant MAX_FEE_BPS = 500;
    /// @notice Liquidation bounty: 0.5% of the forfeited margin.
    uint256 internal constant BOUNTY_BPS = 50;
    /// @notice Bust buffer: a position busts when the adverse move reaches 95% of 1/leverage ...
    uint256 internal constant BUST_BUFFER_PCT = 95;
    /// @notice ... or 1/leverage less this many bps of price, whichever comes first. The oracle
    ///         prints ~3 s apart and the first print past bust overshoots it by 3-5 bps whatever
    ///         the leverage, while the LP's take on a liquidation is the margin, not the mark
    ///         loss; a buffer that is a fraction of 1/leverage (0.5 bps at 1000x) cannot cover
    ///         that, an absolute gap can. Binds above 100x: 1000x busts at 5 bps (not 9.5), 500x
    ///         at 15 (not 19), 250x at 35 (not 38); 100x and below keep the 95% rule.
    uint256 internal constant BUST_GAP_BPS = 5;

    /// @notice Impact-curve parameters of one market.
    /// @param baseRateBps Base haircut, 10% = 1000.
    /// @param rateMultiplier Dimensionless, default 15_000.
    /// @param referenceNotionalUsd USDC 6-dec, default 20_000e6.
    /// @param positionMultiplierE6 Position multiplier scaled by 1e6.
    struct Curve {
        uint16 baseRateBps;
        uint64 rateMultiplier;
        uint128 referenceNotionalUsd;
        uint128 positionMultiplierE6;
    }

    // ------------------------------------------------------------------ price

    /// @notice Move the exit price `deadbandBps` against the trader.
    /// @dev Longs settle lower (rounded down), shorts settle higher (rounded up).
    function deadbandExit(uint256 exitPx18, bool isLong, uint16 deadbandBps) internal pure returns (uint256) {
        if (isLong) return exitPx18 * (BPS - deadbandBps) / BPS;
        return Math.mulDiv(exitPx18, BPS + deadbandBps, BPS, Math.Rounding.Ceil);
    }

    /// @notice Bust price of a position (DESIGN section 5).
    /// @dev The bust move is min(0.95 / leverage, 1 / leverage - BUST_GAP_BPS), worked in units
    ///      of 1 / (leverage * BPS) so both terms are integers: 9500 for the first, BPS minus
    ///      BUST_GAP_BPS * leverage for the second (positive for every leverage up to 1000).
    ///      long: entry * (1 - move) rounded up; short: entry * (1 + move) rounded down. Both
    ///      roundings make liquidation land one wei earlier, never later.
    function bustPrice(uint256 entryPx18, bool isLong, uint32 leverage) internal pure returns (uint256) {
        uint256 den = uint256(leverage) * BPS;
        uint256 pct = BUST_BUFFER_PCT * 100;
        uint256 gap = BUST_GAP_BPS * uint256(leverage);
        uint256 gapped = gap < BPS ? BPS - gap : 0;
        uint256 move = pct < gapped ? pct : gapped;
        if (isLong) return Math.mulDiv(entryPx18, den - move, den, Math.Rounding.Ceil);
        return Math.mulDiv(entryPx18, den + move, den);
    }

    /// @notice True when `px18` is at or beyond the bust price.
    function isBusted(uint256 px18, uint256 bustPx18, bool isLong) internal pure returns (bool) {
        return isLong ? px18 <= bustPx18 : px18 >= bustPx18;
    }

    // ------------------------------------------------------------------- wins

    /// @notice Raw gain of a winning position after the deadband has been applied.
    /// @param notionalUsdc margin * leverage, USDC 6-dec.
    /// @param entryPx18 Entry price.
    /// @param exitPx18 Deadband-adjusted exit price.
    /// @param isLong Direction.
    /// @return gainUsdc notional * |exit - entry| / entry rounded down; 0 when the adjusted
    ///         exit is not on the winning side of entry.
    /// @return moveE18 |exit - entry| / entry in 1e18 fixed point, rounded down.
    function rawGain(uint256 notionalUsdc, uint256 entryPx18, uint256 exitPx18, bool isLong)
        internal
        pure
        returns (uint256 gainUsdc, uint256 moveE18)
    {
        if (isLong ? exitPx18 <= entryPx18 : exitPx18 >= entryPx18) return (0, 0);
        uint256 diff = isLong ? exitPx18 - entryPx18 : entryPx18 - exitPx18;
        gainUsdc = Math.mulDiv(notionalUsdc, diff, entryPx18);
        moveE18 = Math.mulDiv(diff, ONE, entryPx18);
    }

    /// @notice Fraction of a raw gain the trader keeps before the win fee, 1e18 fixed point.
    /// @dev scale = (1 - baseRate) / (1 + 1 / (move * rateMultiplier)
    ///                                 + referenceNotional / (move * positionMultiplier))
    ///      where referenceNotional is in whole dollars (USDC 6-dec / 1e6) and positionMultiplier
    ///      = positionMultiplierE6 / 1e6, so the two 1e6 factors cancel. Returns 0 for a zero move.
    function impactScaleE18(uint256 moveE18, Curve memory c) internal pure returns (uint256) {
        if (moveE18 == 0) return 0;
        uint256 rateTerm = Math.mulDiv(ONE, ONE, moveE18 * c.rateMultiplier, Math.Rounding.Ceil);
        uint256 sizeTerm =
            Math.mulDiv(c.referenceNotionalUsd, 1e36, moveE18 * c.positionMultiplierE6, Math.Rounding.Ceil);
        uint256 denominator = ONE + rateTerm + sizeTerm;
        uint256 numerator = ONE - uint256(c.baseRateBps) * 1e14;
        return Math.mulDiv(numerator, ONE, denominator);
    }

    /// @notice Impact-adjusted gain: raw gain scaled by `impactScaleE18`, rounded down.
    function adjustedGain(uint256 gainUsdc, uint256 moveE18, Curve memory c) internal pure returns (uint256) {
        if (gainUsdc == 0) return 0;
        return Math.mulDiv(gainUsdc, impactScaleE18(moveE18, c), ONE);
    }

    /// @notice Win fee at `feeBps` on an adjusted gain, rounded down.
    function winFee(uint256 adjustedUsdc, uint256 feeBps) internal pure returns (uint256) {
        return adjustedUsdc * feeBps / BPS;
    }

    // ----------------------------------------------------------------- losses

    /// @notice Loss of a losing position, capped at its margin.
    /// @dev notional * |exit - entry| / entry rounded up, then min(margin, that). Returns 0 when
    ///      the exit is not on the losing side of entry. No deadband on losses.
    function cappedLoss(uint256 notionalUsdc, uint256 marginUsdc, uint256 entryPx18, uint256 exitPx18, bool isLong)
        internal
        pure
        returns (uint256)
    {
        if (isLong ? exitPx18 >= entryPx18 : exitPx18 <= entryPx18) return 0;
        uint256 diff = isLong ? entryPx18 - exitPx18 : exitPx18 - entryPx18;
        uint256 raw = Math.mulDiv(notionalUsdc, diff, entryPx18, Math.Rounding.Ceil);
        return raw < marginUsdc ? raw : marginUsdc;
    }

    /// @notice Split a loss between the fee pool and the LP (DESIGN section 6, losing close).
    /// @param lossUsdc The capped loss.
    /// @param feeBps Fee rate; the caller passes 0 while the queue is active (no fee carved).
    /// @return feeUsdc `feeBps` of the loss, rounded down.
    /// @return lpGainUsdc What the LP keeps; also the CONFETTI mint basis.
    function splitLoss(uint256 lossUsdc, uint256 feeBps) internal pure returns (uint256 feeUsdc, uint256 lpGainUsdc) {
        feeUsdc = lossUsdc * feeBps / BPS;
        lpGainUsdc = lossUsdc - feeUsdc;
    }

    /// @notice Split a liquidated margin (DESIGN section 5): bounty, fee, remainder to the LP.
    /// @param marginUsdc Whole margin, forfeited.
    /// @param feeBps Fee rate; the caller passes 0 while the queue is active.
    /// @return bountyUsdc 0.5% of margin to the liquidator, rounded down.
    /// @return feeUsdc `feeBps` of margin to the fee pool, rounded down.
    /// @return lpGainUsdc margin - bounty - fee.
    function splitLiquidation(uint256 marginUsdc, uint256 feeBps)
        internal
        pure
        returns (uint256 bountyUsdc, uint256 feeUsdc, uint256 lpGainUsdc)
    {
        bountyUsdc = marginUsdc * BOUNTY_BPS / BPS;
        feeUsdc = marginUsdc * feeBps / BPS;
        lpGainUsdc = marginUsdc - bountyUsdc - feeUsdc;
    }
}
