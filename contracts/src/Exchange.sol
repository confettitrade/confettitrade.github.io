// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {ExchangeBase} from "./ExchangeBase.sol";
import {ExchangeExt} from "./ExchangeExt.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {IReferrals} from "./interfaces/IReferrals.sol";
import {IExchange} from "./interfaces/IExchange.sol";
import {ImpactLib} from "./lib/ImpactLib.sol";
import {Referrals} from "./Referrals.sol";
import {MarketRules} from "./MarketRules.sol";
import {SessionRouter} from "./SessionRouter.sol";

/// @title Exchange
/// @notice The trading core of Confetti v4: the thirteen entry points money moves through
///         (deposits and withdrawals, the request / execute / cancel pairs for opens and
///         closes, liquidation, the queue harvest and the fee push). Everything else, the
///         owner's setters, the house money functions and every view, lives in `ExchangeExt`
///         and is reached through this contract's fallback, which delegatecalls the extension
///         on this contract's storage. See `ExchangeBase` for the model and `IExchange` for the
///         combined ABI.
/// @dev Immutable, no proxy. The extension address is an immutable of this contract: there is
///      no way to point it elsewhere, so neither half can be upgraded. The extension is built
///      with the same USDC, oracle and Staking immutables, checked here at construction.
///      Delayed fills: a request records p0 and its timestamp; `_fillMode` enforces the windows
///      (`minDelay`, keeper-only `grace`, open-to-anyone until `expiry`) and `_fill` picks p1 in
///      the keeper window and the trader-worse of p0 and p1 afterwards, so no choice of
///      execution time can beat the keeper's fill. An open re-runs `_openCheck` and the guards
///      at execution and refunds instead of reverting when a rule fails. The settlement terms
///      (deadband, payout cap, fee rate, maximum profit) are stamped at execution.
///      Session trading: `_router`, created here, may file open and close requests for the
///      trader it appends to the calldata (ERC-2771 layout); nothing else is callable on a
///      trader's behalf.
contract Exchange is ExchangeBase {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    /// @param usdc_ USDC token (6 decimals).
    /// @param oracle_ Price oracle; this contract must be its registrar before markets are added.
    /// @param staking_ Staking; receives the stakers' share of fee pushes.
    /// @param ext_ The admin extension, deployed first with the same three addresses.
    /// @param v3Referrals_ The v3 referral registry whose codes and locks carry over (zero: none).
    /// @param owner_ Initial owner.
    /// @param feeRecipient_ Receives the non-staker share of pushed fees.
    constructor(
        IERC20 usdc_,
        IPriceOracle oracle_,
        IStaking staking_,
        ExchangeExt ext_,
        IReferrals v3Referrals_,
        address owner_,
        address feeRecipient_
    ) ExchangeBase(usdc_, oracle_, staking_, owner_, false) {
        if (address(ext_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        (address u, address o, address s) = ext_.extensionImmutables();
        if (u != address(usdc_) || o != address(oracle_) || s != address(staking_)) revert ExtensionMismatch();
        _ext = address(ext_);
        _referrals = IReferrals(address(new Referrals(address(this), v3Referrals_)));
        _rules = new MarketRules();
        _router = address(new SessionRouter(IExchange(address(this))));
        _feeRecipient = feeRecipient_;
        _breakerBps = DEFAULT_BREAKER_BPS;
        _breakerFloorUsdc = DEFAULT_BREAKER_FLOOR_USDC;
        _winFeeBps = DEFAULT_WIN_FEE_BPS;
        _lossFeeBps = DEFAULT_LOSS_FEE_BPS;
        _borrowFreeHours = DEFAULT_BORROW_FREE_HOURS;
        _minDelay = DEFAULT_MIN_DELAY;
        _grace = DEFAULT_GRACE;
        _expiry = DEFAULT_EXPIRY;
        _maxJumpBps = DEFAULT_MAX_JUMP_BPS;
        _minMarginUsdc = DEFAULT_MIN_MARGIN_USDC;
        _rhoBps = DEFAULT_RHO_BPS;
        _maxWinBps = DEFAULT_MAX_WIN_BPS;
        emit FeeRecipientSet(feeRecipient_);
        emit BreakerBpsSet(DEFAULT_BREAKER_BPS);
        emit BreakerFloorSet(DEFAULT_BREAKER_FLOOR_USDC);
        emit FeeBpsSet(DEFAULT_WIN_FEE_BPS, DEFAULT_LOSS_FEE_BPS);
        emit BorrowFreeHoursSet(DEFAULT_BORROW_FREE_HOURS);
        emit StakerFeeShareSet(0);
        emit DelaysSet(DEFAULT_MIN_DELAY, DEFAULT_GRACE, DEFAULT_EXPIRY);
        emit MaxJumpBpsSet(DEFAULT_MAX_JUMP_BPS);
        emit MinMarginSet(DEFAULT_MIN_MARGIN_USDC);
        emit RhoBpsSet(DEFAULT_RHO_BPS);
        emit MaxWinBpsSet(DEFAULT_MAX_WIN_BPS);
    }

    // --------------------------------------------------------------- fallback

    /// @dev Every selector this contract does not answer itself goes to the extension, on this
    ///      storage, and its return data or revert comes back unchanged.
    fallback() external {
        address ext = _ext;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), ext, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    // ------------------------------------------------------------- collateral

    function deposit(uint256 amountUsdc) external nonReentrant {
        _deposit(msg.sender, amountUsdc);
    }

    function depositFor(address beneficiary, uint256 amountUsdc) external nonReentrant {
        if (beneficiary == address(0)) revert ZeroAddress();
        _deposit(beneficiary, amountUsdc);
    }

    function withdraw(uint256 amountUsdc) external nonReentrant {
        if (amountUsdc == 0) revert ZeroAmount();
        uint256 available = _available[msg.sender];
        if (available < amountUsdc) revert InsufficientBalance(available, amountUsdc);
        _available[msg.sender] = available - amountUsdc;
        _usdc.safeTransfer(msg.sender, amountUsdc);
        emit Withdrawn(msg.sender, amountUsdc);
    }

    // ---------------------------------------------------------------- trading

    function requestOpen(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, address referrer)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        address trader = _trader();
        Instrument storage inst = _instrument(instrumentId);
        if (marginUsdc < _minMarginUsdc) revert MarginBelowMinimum();
        bytes4 rule = _openCheck(instrumentId, inst, isLong, leverage, uint256(marginUsdc) * leverage);
        if (rule != 0) _revertWith(rule);
        uint256 available = _available[trader];
        if (available < marginUsdc) revert InsufficientBalance(available, marginUsdc);
        uint256 px0 = _execPrice(instrumentId, inst);
        if (referrer == trader) referrer = address(0);

        requestId = _nextRequestId++;
        _openRequests[requestId] = OpenRequest({
            trader: trader,
            instrumentId: instrumentId,
            isLong: isLong,
            marginUsdc: marginUsdc,
            leverage: leverage,
            requestedAt: uint64(block.timestamp),
            px0: px0,
            referrer: referrer
        });
        _available[trader] = available - marginUsdc;
        _pending[trader] += marginUsdc;
        emit OpenRequested(requestId, trader, instrumentId, isLong, marginUsdc, leverage, px0, referrer);
    }

    function executeOpen(uint256 requestId) external nonReentrant returns (uint256 positionId) {
        OpenRequest memory r = _openRequests[requestId];
        if (r.trader == address(0)) revert UnknownRequest();
        bool keeperFill = _fillMode(r.requestedAt);
        Instrument storage inst = _instruments[r.instrumentId];

        // Every open-time rule again, then the jump guard, then the born-busted guard; a
        // failure refunds instead of reverting so the margin never waits on a rule that may
        // not clear before expiry.
        bytes4 rule = _openCheck(r.instrumentId, inst, r.isLong, r.leverage, uint256(r.marginUsdc) * r.leverage);
        uint256 fillPx18;
        if (rule == 0) {
            uint256 px1 = _execPrice(r.instrumentId, inst);
            uint256 diff = px1 > r.px0 ? px1 - r.px0 : r.px0 - px1;
            fillPx18 = _fill(keeperFill, r.px0, px1, r.isLong);
            if (diff * BPS > r.px0 * _maxJumpBps) {
                rule = PriceJumped.selector;
            } else if (ImpactLib.isBusted(px1, ImpactLib.bustPrice(fillPx18, r.isLong, r.leverage), r.isLong)) {
                // A fallback fill books p0 while the live p1 may already sit past that entry's
                // bust price: the position would be liquidated in this very block, so refund.
                rule = EntryBusted.selector;
            } else {
                inst.lastPx18 = px1;
            }
        }
        if (rule != 0) {
            _refundOpen(requestId, r, rule);
            return 0;
        }

        delete _openRequests[requestId];
        _pending[r.trader] -= r.marginUsdc;
        uint256 entryPx18 = ImpactLib.spreadEntry(fillPx18, r.isLong, inst.entryDeadbandBps);
        positionId = _createPosition(r, inst, entryPx18);
        if (!_houseWallets[r.trader]) _referrals.lockReferrer(r.trader, r.referrer);
        emit PositionOpened(
            positionId, r.trader, r.instrumentId, r.isLong, r.marginUsdc, r.leverage, entryPx18, requestId, keeperFill
        );
    }

    function cancelOpen(uint256 requestId) external nonReentrant {
        OpenRequest memory r = _openRequests[requestId];
        if (r.trader == address(0)) revert UnknownRequest();
        if (!_expired(r.requestedAt)) revert RequestNotExpired();
        _refundOpen(requestId, r, RequestExpired.selector);
    }

    function requestClose(uint256 positionId) external nonReentrant {
        address trader = _trader();
        Position memory pos = _position(positionId);
        if (pos.owner != trader) revert NotPositionOwner(positionId, trader);
        if (_closeRequests[positionId].requestedAt != 0) revert CloseAlreadyPending();
        uint256 px0 = _execPrice(pos.instrumentId, _instruments[pos.instrumentId]);
        _closeRequests[positionId] = CloseRequest({requestedAt: uint64(block.timestamp), px0: px0});
        emit CloseRequested(positionId, trader, px0);
    }

    function executeClose(uint256 positionId) external nonReentrant returns (uint256 payoutUsdc, uint256 queuedUsdc) {
        CloseRequest memory r = _closeRequests[positionId];
        if (r.requestedAt == 0) revert UnknownRequest();
        bool keeperFill = _fillMode(r.requestedAt);
        // The request is deleted with its position, so the position exists.
        Position memory pos = _positions[positionId];
        Instrument storage inst = _instruments[pos.instrumentId];
        Settlement memory s;
        uint256 px1 = _execPrice(pos.instrumentId, inst);
        if (!inst.retired) inst.lastPx18 = px1;
        s.exitPx18 = _fill(keeperFill, r.px0, px1, !pos.isLong);
        _settleClose(positionId, pos, inst, s, keeperFill);
        return (s.payoutUsdc, s.queuedUsdc);
    }

    function cancelClose(uint256 positionId) external nonReentrant {
        uint64 requestedAt = _closeRequests[positionId].requestedAt;
        if (requestedAt == 0) revert UnknownRequest();
        if (!_expired(requestedAt)) revert RequestNotExpired();
        delete _closeRequests[positionId];
        emit CloseRequestCancelled(positionId, RequestExpired.selector);
    }

    function liquidate(uint256 positionId) external nonReentrant returns (uint256 bountyUsdc) {
        Position memory pos = _position(positionId);
        Instrument storage inst = _instruments[pos.instrumentId];

        uint256 exitPx18 = _execPrice(pos.instrumentId, inst);
        uint256 bustPx18 = _bustPrice(pos);
        if (!ImpactLib.isBusted(exitPx18, bustPx18, pos.isLong)) {
            revert NotLiquidatable(positionId, exitPx18, bustPx18);
        }
        if (!inst.retired) inst.lastPx18 = exitPx18;
        // A pending close never holds a liquidation up; it is voided with the position.
        if (_closeRequests[positionId].requestedAt != 0) {
            emit CloseRequestCancelled(positionId, UnknownPosition.selector);
        }
        _removePosition(positionId, pos);

        uint256 margin = pos.marginUsdc;
        (uint256 bounty, uint256 fee, uint256 lpGain) = ImpactLib.splitLiquidation(margin, _lossFeeNow(pos.lossFeeBps));
        _recordLpFlow(-int256(lpGain));
        _available[msg.sender] += bounty;
        _lpUsdc += margin - bounty;
        _takeFee(pos.owner, fee);

        emit PositionLiquidated(positionId, pos.owner, msg.sender, exitPx18, pos.marginUsdc, bounty, fee);
        return bounty;
    }

    function harvest(uint256 maxEntries) external nonReentrant returns (uint256 entriesPaid, uint256 paidUsdc) {
        uint256 head = _queueHead;
        uint256 length = _queue.length;
        if (head == length) revert QueueEmpty();
        uint256 cash = _lpUsdc;

        while (entriesPaid < maxEntries && head < length && cash > 0) {
            QueueEntry storage entry = _queue[head];
            uint256 owed = entry.owedUsdc;
            uint256 pay = owed < cash ? owed : cash;
            uint256 remaining = owed - pay;
            entry.owedUsdc = remaining;
            cash -= pay;
            paidUsdc += pay;
            _available[entry.recipient] += pay;
            emit QueuePaid(head, entry.recipient, pay, remaining);
            unchecked {
                ++entriesPaid;
            }
            if (remaining == 0) {
                unchecked {
                    ++head;
                }
            }
        }

        _lpUsdc = cash;
        _queueHead = head;
        _queuedTotal -= paidUsdc;
    }

    function pushFees() external nonReentrant returns (uint256 toStakersUsdc, uint256 toRecipientUsdc) {
        bool pushed;
        (toStakersUsdc, toRecipientUsdc, pushed) = _pushFees();
        if (!pushed) revert NothingToPush();
    }

    // ----------------------------------------------------- internal: requests

    /// @dev The account an open or close request is filed for: the caller, or, when the caller
    ///      is the session router, the trader the router appended as the last 20 bytes of the
    ///      calldata (the ERC-2771 trusted-forwarder layout).
    function _trader() private view returns (address trader) {
        trader = msg.sender;
        if (trader == _router) {
            assembly ("memory-safe") {
                trader := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        }
    }

    /// @dev Which window a request is in: reverts before `minDelay` and after `expiry`, admits
    ///      only a fill keeper during the grace window (returning true: fill at p1), anyone
    ///      afterwards (false: fill at the trader-worse of p0 and p1).
    function _fillMode(uint64 requestedAt) private view returns (bool keeperFill) {
        uint256 elapsed = block.timestamp - requestedAt;
        if (elapsed < _minDelay) revert TooEarly();
        if (elapsed > _expiry) revert RequestExpired();
        if (elapsed < uint256(_minDelay) + _grace) {
            if (!_keepers[msg.sender]) revert KeeperWindow();
            return true;
        }
    }

    function _expired(uint64 requestedAt) private view returns (bool) {
        return block.timestamp - requestedAt > _expiry;
    }

    /// @dev The fill: p1 for a keeper, else the higher of p0 and p1 when `takeMax` (a long
    ///      entry, a short exit) and the lower otherwise.
    function _fill(bool keeperFill, uint256 px0, uint256 px1, bool takeMax) private pure returns (uint256) {
        if (keeperFill) return px1;
        return (px1 > px0) == takeMax ? px1 : px0;
    }

    /// @dev Stamp the settlement terms and book the position; a later setting change cannot
    ///      touch it. The maximum profit is the smaller of the payout cap and `maxWinBps` of
    ///      the free cash right now.
    function _createPosition(OpenRequest memory r, Instrument storage inst, uint256 entryPx18)
        private
        returns (uint256 positionId)
    {
        uint256 maxProfit = uint256(r.marginUsdc) * inst.payoutCapX;
        uint256 byHouse = _freeCash() * _maxWinBps / BPS;
        if (byHouse < maxProfit) maxProfit = byHouse;
        if (maxProfit > type(uint96).max) maxProfit = type(uint96).max;

        positionId = _nextPositionId++;
        _positions[positionId] = Position({
            owner: r.trader,
            instrumentId: r.instrumentId,
            isLong: r.isLong,
            marginUsdc: r.marginUsdc,
            leverage: r.leverage,
            maxProfitUsdc: uint96(maxProfit),
            entryPx18: entryPx18,
            openedAt: uint64(block.timestamp),
            deadbandBps: inst.deadbandBps,
            payoutCapX: inst.payoutCapX,
            winFeeBps: _winFeeBps,
            lossFeeBps: _lossFeeBps,
            entryDeadbandBps: inst.entryDeadbandBps,
            borrowRateX10: inst.borrowRateX10,
            borrowFreeHours: _borrowFreeHours
        });
        _positionIds[r.trader].add(positionId);
        _marginInUse[r.trader] += r.marginUsdc;
        _openMaxPayoutUsdc += maxProfit;
        uint256 notional = uint256(r.marginUsdc) * r.leverage;
        if (r.isLong) _longOiUsd[r.instrumentId] += notional;
        else _shortOiUsd[r.instrumentId] += notional;
        _refreshExposure(r.instrumentId, inst);
    }

    function _refundOpen(uint256 requestId, OpenRequest memory r, bytes4 reason) private {
        delete _openRequests[requestId];
        _pending[r.trader] -= r.marginUsdc;
        _available[r.trader] += r.marginUsdc;
        emit OpenRequestCancelled(requestId, r.trader, reason);
    }

    /// @dev Revert with a bare error selector.
    function _revertWith(bytes4 selector) private pure {
        assembly ("memory-safe") {
            mstore(0, selector)
            revert(0, 4)
        }
    }

    // ----------------------------------------------------- internal: settling

    /// @dev Settle a close at `s.exitPx18`: flat returns the margin, a win pays through
    ///      `_settleWin`, a loss through `_settleLoss`; then the borrow is taken from what is
    ///      paid now and kept by the house. The outcome lands in `s`.
    function _settleClose(
        uint256 positionId,
        Position memory pos,
        Instrument storage inst,
        Settlement memory s,
        bool keeperFill
    ) private {
        (bool isWin, uint256 amount, uint256 forfeited) = _quote(pos, inst, s.exitPx18);
        _removePosition(positionId, pos);
        if (amount == 0) {
            s.payoutUsdc = pos.marginUsdc;
        } else if (isWin) {
            _settleWin(positionId, pos, amount, s);
            if (forfeited > 0) emit PayoutCapped(positionId, amount, forfeited);
        } else {
            _settleLoss(pos, amount, s);
        }
        uint256 borrow = _borrowOwed(pos);
        if (borrow > s.payoutUsdc) borrow = s.payoutUsdc;
        if (borrow != 0) {
            s.payoutUsdc -= borrow;
            s.borrowUsdc = borrow;
            _lpUsdc += borrow;
        }
        _available[pos.owner] += s.payoutUsdc;
        emit PositionClosed(
            positionId,
            pos.owner,
            s.exitPx18,
            s.pnlUsdc,
            s.feeUsdc,
            s.payoutUsdc,
            s.queuedUsdc,
            s.borrowUsdc,
            keeperFill
        );
    }

    /// @dev Winning close: profit paid from house cash or queued, margin returned, then the fee
    ///      routed (the referrer share queues behind the trader when the cash ran dry). The
    ///      breaker counts the whole adjusted gain, paid or queued. A house wallet's gain is
    ///      first cut to the free cash (0 while the queue is active) and the rest forfeited
    ///      before the fee is carved, so its win never queues, never leaves the house below
    ///      what it owes, and pays no fee on money the house did not have.
    function _settleWin(uint256 positionId, Position memory pos, uint256 adjusted, Settlement memory s) private {
        if (_houseWallets[pos.owner]) {
            uint256 room = _queueIsEmpty() ? _freeCash() : 0;
            if (adjusted > room) {
                emit HouseWinForfeited(positionId, adjusted - room);
                adjusted = room;
            }
        }
        uint256 fee = ImpactLib.winFee(adjusted, pos.winFeeBps);
        uint256 profit = adjusted - fee;

        // Before the cash moves, so a window that opens here samples it as it was.
        _recordLpFlow(int256(adjusted));
        // Paid from house cash now (nothing while the queue is active); the rest queues.
        uint256 paidNow = _payFromLp(profit);
        uint256 queued = profit - paidNow;
        if (queued > 0) _enqueue(pos.owner, queued);

        _takeFee(pos.owner, fee);

        s.pnlUsdc = int256(profit);
        s.feeUsdc = fee;
        s.payoutUsdc = pos.marginUsdc + paidNow;
        s.queuedUsdc = queued;
    }

    /// @dev Losing close: margin minus loss returned, loss to the house (fee carved while the
    ///      queue is empty).
    function _settleLoss(Position memory pos, uint256 loss, Settlement memory s) private {
        (uint256 fee, uint256 lpGain) = ImpactLib.splitLoss(loss, _lossFeeNow(pos.lossFeeBps));
        _recordLpFlow(-int256(lpGain));
        _lpUsdc += loss;
        _takeFee(pos.owner, fee);

        s.pnlUsdc = -int256(loss);
        s.feeUsdc = fee;
        s.payoutUsdc = pos.marginUsdc - loss;
    }

    function _deposit(address beneficiary, uint256 amountUsdc) private {
        if (amountUsdc == 0) revert ZeroAmount();
        _usdc.safeTransferFrom(msg.sender, address(this), amountUsdc);
        _available[beneficiary] += amountUsdc;
        emit Deposited(beneficiary, msg.sender, amountUsdc);
    }
}
