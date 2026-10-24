// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IExchangeTypes} from "./interfaces/IExchangeTypes.sol";
import {IMarketRules} from "./interfaces/IMarketRules.sol";
import {ImpactLib} from "./lib/ImpactLib.sol";

/// @title MarketRules
/// @notice The Exchange's stateless module: what a close settles to (deadband, impact curve,
///         payout cap, capped loss), the owner bounds on market parameters and the bounds on
///         the request windows (DESIGN section 8).
/// @dev The Exchange core creates this contract in its constructor; it has no state, no owner
///      and no setter, so it can never change under the Exchange. A failed bound reverts
///      `IExchangeTypes.ParamOutOfBounds(param, value)`, which the Exchange bubbles as is.
///      v4 ceilings: a position at most $1M, a side at most $10M / $2.5M / $500K by tier, a
///      payout cap at most 50x; house-sized multipliers posX10 10..200, sideX10 10..500 and a
///      stress move 10..5000 bps; an entry spread at most 50 bps and a borrow rate at most 5
///      bps per hour.
contract MarketRules is IMarketRules {
    /// @dev Owner bounds (DESIGN section 8), stated in IExchange on each setter.
    uint32 private constant MAX_LEVERAGE = 1000;
    uint16 private constant MIN_DEADBAND_BPS = 1;
    uint16 private constant MAX_DEADBAND_BPS = 50;
    uint16 private constant MIN_CLAMP_BPS = 5;
    uint16 private constant MAX_CLAMP_BPS = 100;
    uint16 private constant MIN_BASE_RATE_BPS = 500;
    uint16 private constant MAX_BASE_RATE_BPS = 2000;
    uint128 private constant MAX_POSITION_NOTIONAL_USD = 1_000_000e6;
    uint16 private constant MIN_PAYOUT_CAP_X = 10;
    uint16 private constant MAX_PAYOUT_CAP_X = 50;

    /// @dev OI cap ceilings per tier (launch caps are per market, Deploy.s.sol).
    uint128 private constant TIER_A_MAX_OI_CAP_USD = 10_000_000e6;
    uint128 private constant TIER_B_MAX_OI_CAP_USD = 2_500_000e6;
    uint128 private constant TIER_C_MAX_OI_CAP_USD = 500_000e6;

    /// @dev House-sized limit bounds (v4 M4): multiples of free cash (x10) and the stress move.
    uint16 private constant MIN_POS_X10 = 10;
    uint16 private constant MAX_POS_X10 = 200;
    uint16 private constant MIN_SIDE_X10 = 10;
    uint16 private constant MAX_SIDE_X10 = 500;
    uint16 private constant MAX_ENTRY_DEADBAND_BPS = 50;
    uint16 private constant MIN_STRESS_BPS = 10;
    uint16 private constant MAX_STRESS_BPS = 5000;

    /// @dev Impact-curve parameter bounds (DESIGN section 8 "within bounds"), see `checkParams`.
    uint64 private constant MIN_RATE_MULTIPLIER = 1_000;
    uint64 private constant MAX_RATE_MULTIPLIER = 1_000_000;
    uint128 private constant MIN_REFERENCE_NOTIONAL_USD = 1_000e6;
    uint128 private constant MAX_REFERENCE_NOTIONAL_USD = 1_000_000e6;
    uint128 private constant MIN_POSITION_MULTIPLIER_E6 = 1e12;
    uint256 private constant MIN_SCALE_ONE_PCT_E18 = 0.5e18;
    uint256 private constant MAX_SCALE_ONE_PCT_E18 = 0.95e18;

    /// @dev Request window bounds in seconds (DESIGN section 8), see `checkDelays`.
    uint32 private constant MIN_MIN_DELAY = 2;
    uint32 private constant MAX_MIN_DELAY = 30;
    uint32 private constant MIN_GRACE = 1;
    uint32 private constant MAX_GRACE = 10;
    uint32 private constant MIN_EXPIRY = 20;
    uint32 private constant MAX_EXPIRY = 300;

    /// @inheritdoc IMarketRules
    /// @dev The deadband and the maximum profit are the position's stamps; only the curve is
    ///      the market's live one, passed in by the Exchange.
    function quote(IExchangeTypes.Position calldata pos, ImpactLib.Curve calldata c, uint256 exitPx18)
        external
        pure
        returns (bool isWin, uint256 amount, uint256 forfeitedUsdc)
    {
        uint256 notional = uint256(pos.marginUsdc) * pos.leverage;
        isWin = pos.isLong ? exitPx18 > pos.entryPx18 : exitPx18 < pos.entryPx18;
        if (isWin) {
            uint256 adjustedExit = ImpactLib.deadbandExit(exitPx18, pos.isLong, pos.deadbandBps);
            (uint256 gain, uint256 moveE18) = ImpactLib.rawGain(notional, pos.entryPx18, adjustedExit, pos.isLong);
            amount = ImpactLib.adjustedGain(gain, moveE18, c);
            uint256 cap = pos.maxProfitUsdc;
            if (amount > cap) {
                forfeitedUsdc = amount - cap;
                amount = cap;
            }
        } else {
            amount = ImpactLib.cappedLoss(notional, pos.marginUsdc, pos.entryPx18, exitPx18, pos.isLong);
        }
    }

    /// @inheritdoc IMarketRules
    function checkDelays(uint32 minDelay, uint32 grace, uint32 expiry) external pure {
        if (minDelay < MIN_MIN_DELAY || minDelay > MAX_MIN_DELAY) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.MinDelay, minDelay);
        }
        if (grace < MIN_GRACE || grace > MAX_GRACE) revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.Grace, grace);
        if (expiry < MIN_EXPIRY || expiry > MAX_EXPIRY || minDelay + grace >= expiry) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.Expiry, expiry);
        }
    }

    /// @inheritdoc IMarketRules
    function checkInstrument(IExchangeTypes.Instrument calldata spec) external pure {
        if (spec.tier > 2) revert IExchangeTypes.InvalidTier(spec.tier);
        checkLeverage(spec.maxLeverage);
        checkParams(
            spec.deadbandBps,
            spec.clampBps,
            spec.baseRateBps,
            spec.rateMultiplier,
            spec.referenceNotionalUsd,
            spec.positionMultiplierE6
        );
        checkOiCaps(spec.tier, spec.longOiCapUsd, spec.shortOiCapUsd);
        checkPositionCaps(spec.maxNotionalUsd, spec.payoutCapX);
        checkHouseSizing(spec.posX10, spec.sideX10, spec.stressBps);
        checkMarketFees(spec.entryDeadbandBps, spec.borrowRateX10);
    }

    /// @inheritdoc IMarketRules
    /// @dev Besides the per-parameter ranges, the curve as a whole must keep between 50% and
    ///      95% of a raw gain at a 1% move, so no in-range combination can zero every winning
    ///      close.
    function checkParams(
        uint16 deadbandBps,
        uint16 clampBps,
        uint16 baseRateBps,
        uint64 rateMultiplier,
        uint128 referenceNotionalUsd,
        uint128 positionMultiplierE6
    ) public pure {
        if (deadbandBps < MIN_DEADBAND_BPS || deadbandBps > MAX_DEADBAND_BPS) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.DeadbandBps, deadbandBps);
        }
        if (clampBps < MIN_CLAMP_BPS || clampBps > MAX_CLAMP_BPS) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.ClampBps, clampBps);
        }
        if (baseRateBps < MIN_BASE_RATE_BPS || baseRateBps > MAX_BASE_RATE_BPS) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.BaseRateBps, baseRateBps);
        }
        if (rateMultiplier < MIN_RATE_MULTIPLIER || rateMultiplier > MAX_RATE_MULTIPLIER) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.RateMultiplier, rateMultiplier);
        }
        if (referenceNotionalUsd < MIN_REFERENCE_NOTIONAL_USD || referenceNotionalUsd > MAX_REFERENCE_NOTIONAL_USD) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.ReferenceNotionalUsd, referenceNotionalUsd);
        }
        if (positionMultiplierE6 < MIN_POSITION_MULTIPLIER_E6) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.PositionMultiplierE6, positionMultiplierE6);
        }
        uint256 scale = ImpactLib.impactScaleE18(
            1e16,
            ImpactLib.Curve({
                baseRateBps: baseRateBps,
                rateMultiplier: rateMultiplier,
                referenceNotionalUsd: referenceNotionalUsd,
                positionMultiplierE6: positionMultiplierE6
            })
        );
        if (scale < MIN_SCALE_ONE_PCT_E18 || scale > MAX_SCALE_ONE_PCT_E18) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.ImpactScaleOnePct, scale);
        }
    }

    /// @inheritdoc IMarketRules
    /// @dev The market keeper (the owner at launch) cannot lift a market past its tier's ceiling.
    function checkOiCaps(uint8 tier, uint128 longOiCapUsd, uint128 shortOiCapUsd) public pure {
        uint128 ceiling = tier == 0 ? TIER_A_MAX_OI_CAP_USD : tier == 1 ? TIER_B_MAX_OI_CAP_USD : TIER_C_MAX_OI_CAP_USD;
        if (longOiCapUsd > ceiling) revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.LongOiCapUsd, longOiCapUsd);
        if (shortOiCapUsd > ceiling) revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.ShortOiCapUsd, shortOiCapUsd);
    }

    /// @inheritdoc IMarketRules
    function checkPositionCaps(uint128 maxNotionalUsd, uint16 payoutCapX) public pure {
        if (maxNotionalUsd == 0 || maxNotionalUsd > MAX_POSITION_NOTIONAL_USD) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.MaxNotionalUsd, maxNotionalUsd);
        }
        if (payoutCapX < MIN_PAYOUT_CAP_X || payoutCapX > MAX_PAYOUT_CAP_X) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.PayoutCapX, payoutCapX);
        }
    }

    /// @inheritdoc IMarketRules
    function checkHouseSizing(uint16 posX10, uint16 sideX10, uint16 stressBps) public pure {
        if (posX10 < MIN_POS_X10 || posX10 > MAX_POS_X10) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.PosX10, posX10);
        }
        if (sideX10 < MIN_SIDE_X10 || sideX10 > MAX_SIDE_X10) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.SideX10, sideX10);
        }
        if (stressBps < MIN_STRESS_BPS || stressBps > MAX_STRESS_BPS) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.StressBps, stressBps);
        }
    }

    /// @inheritdoc IMarketRules
    function checkMarketFees(uint16 entryDeadbandBps, uint16 borrowRateX10) public pure {
        if (entryDeadbandBps > MAX_ENTRY_DEADBAND_BPS) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.EntryDeadbandBps, entryDeadbandBps);
        }
        if (borrowRateX10 > ImpactLib.MAX_BORROW_RATE_X10) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.BorrowRateX10, borrowRateX10);
        }
    }

    /// @inheritdoc IMarketRules
    function checkLeverage(uint32 maxLeverage) public pure {
        if (maxLeverage == 0 || maxLeverage > MAX_LEVERAGE) {
            revert IExchangeTypes.ParamOutOfBounds(IExchangeTypes.Param.MaxLeverage, maxLeverage);
        }
    }
}
