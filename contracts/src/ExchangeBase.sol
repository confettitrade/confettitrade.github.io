// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IExchangeTypes} from "./interfaces/IExchangeTypes.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {IReferrals} from "./interfaces/IReferrals.sol";
import {IMarketRules} from "./interfaces/IMarketRules.sol";
import {ImpactLib} from "./lib/ImpactLib.sol";

/// @title ExchangeBase
/// @notice Everything the trading core (`Exchange`) and the admin extension (`ExchangeExt`)
///         share: the constants, the whole storage layout, the modifiers and the internal
///         helpers. Both children inherit this contract and nothing else that has storage, so
///         their layouts are identical by construction and the core can delegatecall the
///         extension on its own storage.
/// @dev Cash model. The core holds every USDC; its balance always equals
///        sum(available balances) + sum(open margins) + sum(pending request margins) + lpUsdc.
///      The fee pool and the payout queue are claims on `lpUsdc`, not separate cash:
///        1. the FIFO queue is paid first (`harvest`), and while it is non-empty every new win
///           is queued and no loss fee is carved;
///        2. with an empty queue a win is paid from house cash on the spot, any shortfall queued;
///        3. the fee pool is paid last (`pushFees`), only when the queue is empty and the cash
///           covers the whole pool.
///      House money (v4): `depositHouse` adds to `lpUsdc`; `withdrawHouse` takes from it down
///      to what is owed (queue + fee pool). No seed, no notice, no sweep to stakers, no mint.
///      Free cash: `_freeCash()` = lpUsdc - queuedTotal - feePool, floored at 0. It sizes every
///      open (house-sized caps and the exposure cap), stamps each position's maximum profit and
///      bounds `withdrawHouse`.
///      Book exposure: `_exposureTerm[id]` = max(long OI, short OI) * stressBps *
///      (10000 - baseRateBps) / 1e8 per market, `_bookExposureUsdc` their sum, kept current on
///      every open, close, liquidation and on a stress or base-rate change.
///      Fees: `winFeeBps` (at most 10%) on a win's adjusted gain; `lossFeeBps` (at most 5%)
///      carved from a losing close's loss and a liquidated margin, none while the queue is
///      active. `_takeFee` routes a referred trader's referrer share at once and pools the
///      rest. The entry spread and the borrow fee are the house's own take and go to house
///      cash directly; neither enters the fee pool or the breaker.
///      Breaker: `_recordLpFlow` tallies net house outflow per fixed one-hour window against
///      max(`windowStartLp * breakerBps / 10000`, `breakerFloorUsdc`), where the base is the
///      free cash at the window start. A trip blocks opens until the window ends or the owner
///      clears it; closes, liquidations, harvest and withdrawals keep working.
///      Settlement prices are oracle only (`_execPrice`); a retired market settles at its
///      frozen `lastPx18`, which is also the last fill or liquidation price while live, so a
///      dead market can only be retired at a price the venue already settled on.
abstract contract ExchangeBase is IExchangeTypes, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    // -------------------------------------------------------------- constants

    uint16 internal constant MAX_WIN_FEE_BPS = uint16(ImpactLib.MAX_WIN_FEE_BPS);
    uint16 internal constant MAX_LOSS_FEE_BPS = uint16(ImpactLib.MAX_LOSS_FEE_BPS);
    uint16 internal constant DEFAULT_WIN_FEE_BPS = 500;
    uint16 internal constant DEFAULT_LOSS_FEE_BPS = 500;
    uint16 internal constant MAX_BORROW_FREE_HOURS = 24;
    uint16 internal constant DEFAULT_BORROW_FREE_HOURS = 1;
    uint16 internal constant MIN_BREAKER_BPS = 200;
    /// @dev 10000 means off: the window is kept but nothing trips.
    uint16 internal constant MAX_BREAKER_BPS = 10000;
    uint16 internal constant DEFAULT_BREAKER_BPS = 2500;
    uint64 internal constant BREAKER_WINDOW = 1 hours;
    uint128 internal constant MAX_BREAKER_FLOOR_USDC = 10_000e6;
    uint128 internal constant DEFAULT_BREAKER_FLOOR_USDC = 0;
    uint32 internal constant DEFAULT_MIN_DELAY = 5;
    uint32 internal constant DEFAULT_GRACE = 3;
    uint32 internal constant DEFAULT_EXPIRY = 60;
    uint16 internal constant DEFAULT_MAX_JUMP_BPS = 1000;
    uint16 internal constant MIN_MAX_JUMP_BPS = 10;
    uint64 internal constant MIN_MIN_MARGIN_USDC = 1e6;
    uint64 internal constant MAX_MIN_MARGIN_USDC = 10e6;
    uint64 internal constant DEFAULT_MIN_MARGIN_USDC = 5e6;
    uint16 internal constant MIN_RHO_BPS = 500;
    uint16 internal constant DEFAULT_RHO_BPS = 2000;
    uint16 internal constant MIN_MAX_WIN_BPS = 500;
    uint16 internal constant MAX_MAX_WIN_BPS = 5000;
    uint16 internal constant DEFAULT_MAX_WIN_BPS = 2500;
    uint256 internal constant BPS = 10_000;

    // ---------------------------------------------------------------- storage

    struct QueueEntry {
        address recipient;
        uint256 owedUsdc;
    }

    /// @dev Scratch record for one close, kept in memory to stay within the stack limit.
    struct Settlement {
        uint256 exitPx18;
        int256 pnlUsdc;
        uint256 feeUsdc;
        uint256 payoutUsdc;
        uint256 queuedUsdc;
        uint256 borrowUsdc;
    }

    /// @dev Immutables are part of each child's bytecode, so the core and the extension are
    ///      built with the same three and the core checks the match at construction.
    IERC20 internal immutable _usdc;
    IPriceOracle internal immutable _oracle;
    IStaking internal immutable _staking;
    /// @dev The extension's own address, zero in the core: a call that finds `address(this)`
    ///      equal to it did not come through the core's delegatecall and is refused.
    address internal immutable _self;

    /// @dev Written once by the core's constructor (it creates all three), never again. Storage
    ///      rather than immutables so the extension, which runs on the core's storage, can read
    ///      them.
    IReferrals internal _referrals;
    IMarketRules internal _rules;
    address internal _router;
    /// @dev The extension the core delegatecalls. Set once by the core's constructor.
    address internal _ext;

    address internal _pauseGuardian;
    address internal _marketKeeper;
    address internal _feeRecipient;
    bool internal _globalOpensPaused;

    Instrument[] internal _instruments;
    mapping(uint32 => uint256) internal _longOiUsd;
    mapping(uint32 => uint256) internal _shortOiUsd;
    /// @dev Per-market exposure term and their sum (see the contract notes).
    mapping(uint32 => uint256) internal _exposureTerm;
    uint256 internal _bookExposureUsdc;

    mapping(address => uint256) internal _available;
    mapping(address => uint256) internal _marginInUse;
    mapping(address => uint256) internal _pending;
    mapping(address => EnumerableSet.UintSet) internal _positionIds;
    mapping(uint256 => Position) internal _positions;
    uint256 internal _nextPositionId = 1;

    /// @dev The house's own trading wallets: wins above spot cash are forfeited, never queued,
    ///      and their fees pay no referrer.
    mapping(address => bool) internal _houseWallets;

    mapping(uint256 => OpenRequest) internal _openRequests;
    /// @dev Keyed by position id.
    mapping(uint256 => CloseRequest) internal _closeRequests;
    uint256 internal _nextRequestId = 1;
    mapping(address => bool) internal _keepers;

    uint256 internal _lpUsdc;
    uint256 internal _feePoolUsdc;
    QueueEntry[] internal _queue;
    uint256 internal _queueHead;
    uint256 internal _queuedTotal;

    /// @dev Breaker, fee rates, request windows and the v4 sizing knobs, packed.
    uint16 internal _breakerBps;
    bool internal _breakerTripped;
    uint128 internal _breakerFloorUsdc;
    uint16 internal _winFeeBps;
    uint16 internal _lossFeeBps;
    uint16 internal _stakerFeeShareBps;
    uint16 internal _maxJumpBps;
    uint32 internal _minDelay;
    uint32 internal _grace;
    uint32 internal _expiry;
    uint64 internal _minMarginUsdc;
    uint16 internal _rhoBps;
    uint16 internal _maxWinBps;
    uint16 internal _borrowFreeHours;
    uint64 internal _windowStart;
    uint256 internal _windowStartLp;
    int256 internal _windowNetOutflow;

    /// @dev Sum over open positions of their stamped `maxProfitUsdc`.
    uint256 internal _openMaxPayoutUsdc;
    /// @dev The stakers' part of `_feePoolUsdc` that a push kept back because nobody was
    ///      actively staked; it goes wholly to stakers on the next push that finds some.
    uint256 internal _stakerHeldUsdc;

    // -------------------------------------------------------------- modifiers

    modifier onlyKeeperOrOwner() {
        _checkDelegated();
        if (msg.sender != _marketKeeper && msg.sender != owner()) revert Unauthorized();
        _;
    }

    // ------------------------------------------------------------ constructor

    /// @param guarded True for the extension: its own address is recorded so direct calls can
    ///        be refused. False for the core.
    constructor(IERC20 usdc_, IPriceOracle oracle_, IStaking staking_, address owner_, bool guarded)
        Ownable(owner_)
    {
        if (address(usdc_) == address(0) || address(oracle_) == address(0) || address(staking_) == address(0)) {
            revert ZeroAddress();
        }
        _usdc = usdc_;
        _oracle = oracle_;
        _staking = staking_;
        _self = guarded ? address(this) : address(0);
    }

    // -------------------------------------------------------- internal: guard

    /// @dev Refuse a call that reached the extension directly: its storage is nobody's.
    function _checkDelegated() internal view {
        if (address(this) == _self) revert DirectCall();
    }

    /// @dev Every owner-only function of the extension passes here, so the direct-call guard
    ///      costs no bytes per function.
    function _checkOwner() internal view override {
        _checkDelegated();
        super._checkOwner();
    }

    /// @dev Pausing is guardian-or-owner; resuming is owner-only.
    function _checkPauseAuthority(bool paused) internal view {
        _checkDelegated();
        bool allowed = msg.sender == owner() || (paused && msg.sender == _pauseGuardian);
        if (!allowed) revert Unauthorized();
    }

    // ----------------------------------------------------------- internal: cash

    /// @dev House cash nobody is owed: lp - queue - fee pool, floored at 0.
    function _freeCash() internal view returns (uint256) {
        uint256 owed = _queuedTotal + _feePoolUsdc;
        uint256 cash = _lpUsdc;
        return cash > owed ? cash - owed : 0;
    }

    function _queueIsEmpty() internal view returns (bool) {
        return _queueHead == _queue.length;
    }

    /// @dev Pay up to `owedUsdc` from house cash while the queue is empty (nothing while it is
    ///      active); the caller queues the rest.
    function _payFromLp(uint256 owedUsdc) internal returns (uint256 paidNow) {
        if (_queueIsEmpty()) {
            uint256 cash = _lpUsdc;
            paidNow = owedUsdc < cash ? owedUsdc : cash;
            _lpUsdc = cash - paidNow;
        }
    }

    function _enqueue(address recipient, uint256 amountUsdc) internal {
        uint256 index = _queue.length;
        _queue.push(QueueEntry({recipient: recipient, owedUsdc: amountUsdc}));
        _queuedTotal += amountUsdc;
        emit QueueAppended(index, recipient, amountUsdc);
    }

    /// @dev Route a carved fee: the referrer's share leaves house cash for the referrer's
    ///      available balance at once, or joins the FIFO queue when the queue is active or the
    ///      cash is short; the rest is a pool claim on house cash. A house wallet's fee pays no
    ///      referrer.
    function _takeFee(address trader, uint256 fee) internal {
        if (fee == 0) return;
        if (_houseWallets[trader]) {
            _feePoolUsdc += fee;
            return;
        }
        (address referrer, uint256 share) = _referrals.onFee(trader, fee);
        _feePoolUsdc += fee - share;
        if (share == 0) return;
        uint256 paidNow = _payFromLp(share);
        _available[referrer] += paidNow;
        if (share > paidNow) _enqueue(referrer, share - paidNow);
    }

    /// @dev Loss and liquidation fee rate of a position: its stamped rate while the queue is
    ///      empty, 0 while it is active so losses refill the queue in full.
    function _lossFeeNow(uint16 positionFeeBps) internal view returns (uint256) {
        return _queueIsEmpty() ? positionFeeBps : 0;
    }

    /// @dev The fee push shared by `pushFees` and `withdrawHouse`: `stakerFeeShareBps` of the
    ///      pool (plus anything held back earlier) to Staking, the rest to the fee recipient.
    ///      Returns `pushed == false` instead of reverting when there is nothing to move: the
    ///      queue is active, the pool is empty or not covered, or only the earmark is left.
    function _pushFees() internal returns (uint256 toStakersUsdc, uint256 toRecipientUsdc, bool pushed) {
        uint256 pool = _feePoolUsdc;
        if (!_queueIsEmpty() || pool == 0 || _lpUsdc < pool) return (0, 0, false);

        // `held` is part of `pool`: only this function lowers either, together.
        uint256 held = _stakerHeldUsdc;
        toStakersUsdc = held + (pool - held) * _stakerFeeShareBps / BPS;
        toRecipientUsdc = pool - toStakersUsdc;
        // Nobody staked at all (active or warming): the stakers' part stays in the pool,
        // earmarked, and rides whole with the next push that finds stake. Nothing new since the
        // last push: nothing to do.
        if (toStakersUsdc != 0 && _staking.totalStake() == 0) {
            if (pool == held) return (0, 0, false);
            held = toStakersUsdc;
            toStakersUsdc = 0;
        } else {
            held = 0;
        }
        _stakerHeldUsdc = held;
        _feePoolUsdc = held;
        // The fee pool is outside the breaker's base: only house cash moves.
        _lpUsdc -= pool - held;
        _available[_feeRecipient] += toRecipientUsdc;
        // A zero share, or a dust pool whose share rounds to zero: Staking rejects a zero reward.
        if (toStakersUsdc != 0) {
            _usdc.forceApprove(address(_staking), toStakersUsdc);
            _staking.notifyReward(toStakersUsdc);
        }
        emit FeesPushed(toStakersUsdc, toRecipientUsdc);
        return (toStakersUsdc, toRecipientUsdc, true);
    }

    // -------------------------------------------------------- internal: breaker

    /// @dev Breaker bookkeeping, called before the settlement touches `_lpUsdc` so a window
    ///      that opens here samples the cash as it was before this settlement. `outflowUsdc`
    ///      is positive for what the house owes on a win, negative for what it keeps on a loss
    ///      or liquidation. Trips once the window's net outflow exceeds
    ///      max(`windowStartLp * breakerBps / 10000`, `breakerFloorUsdc`). At `breakerBps ==
    ///      10000` the breaker is off: the window is still kept but nothing trips.
    function _recordLpFlow(int256 outflowUsdc) internal {
        if (block.timestamp - _windowStart >= BREAKER_WINDOW) _startWindow();
        int256 net = _windowNetOutflow + outflowUsdc;
        _windowNetOutflow = net;
        if (_breakerTripped || net <= 0 || _breakerBps == BPS) return;
        uint256 startLp = _windowStartLp;
        uint256 threshold = startLp * _breakerBps / BPS;
        if (threshold < _breakerFloorUsdc) threshold = _breakerFloorUsdc;
        if (uint256(net) > threshold) {
            _breakerTripped = true;
            emit LpBreakerTripped(uint256(net), threshold, startLp);
        }
    }

    /// @dev A new window: the base is the free cash (house cash without the fee pool and the
    ///      queue), and a trip from the previous window ends here.
    function _startWindow() internal {
        _windowStart = uint64(block.timestamp);
        _windowStartLp = _freeCash();
        _windowNetOutflow = 0;
        _breakerTripped = false;
    }

    /// @dev True while a trip still blocks opens: it happened in the current window.
    function _breakerBlocks() internal view returns (bool) {
        return _breakerTripped && block.timestamp - _windowStart < BREAKER_WINDOW;
    }

    /// @dev House cash leaves outside a settlement (`withdrawHouse`). While the window is live
    ///      the cash-out first uses up the hour's credit (gains booked as negative outflow,
    ///      which have just left) and lowers the base only by the rest (floor 0), so the rest
    ///      of the hour is measured against cash that is still there.
    function _lpOut(uint256 amountUsdc) internal {
        _lpUsdc -= amountUsdc;
        int256 net = _windowNetOutflow;
        if (net < 0 && block.timestamp - _windowStart < BREAKER_WINDOW) {
            uint256 fromCredit = uint256(-net);
            if (fromCredit > amountUsdc) fromCredit = amountUsdc;
            _windowNetOutflow = net + int256(fromCredit);
            amountUsdc -= fromCredit;
        }
        uint256 startLp = _windowStartLp;
        _windowStartLp = startLp > amountUsdc ? startLp - amountUsdc : 0;
    }

    // ------------------------------------------------------- internal: sizing

    /// @dev One market's exposure term for a given long and short OI.
    function _termFor(Instrument storage inst, uint256 longOi, uint256 shortOi) internal view returns (uint256) {
        uint256 oi = longOi > shortOi ? longOi : shortOi;
        return oi * inst.stressBps * (BPS - inst.baseRateBps) / 1e8;
    }

    /// @dev Replace a market's term in the book exposure with its current value.
    function _refreshExposure(uint32 instrumentId, Instrument storage inst) internal {
        uint256 term = _termFor(inst, _longOiUsd[instrumentId], _shortOiUsd[instrumentId]);
        _bookExposureUsdc = _bookExposureUsdc - _exposureTerm[instrumentId] + term;
        _exposureTerm[instrumentId] = term;
    }

    /// @dev The open-time rules as the selector of the first one that fails (0 = all clear):
    ///      the pauses and the static caps first, then the house-sized caps on free cash and
    ///      the book exposure after the open.
    function _openCheck(uint32 instrumentId, Instrument storage inst, bool isLong, uint32 leverage, uint256 notional)
        internal
        view
        returns (bytes4)
    {
        if (inst.retired) return MarketRetired.selector;
        if (_globalOpensPaused) return OpensPausedGlobally.selector;
        if (_breakerBlocks()) return OpensPausedByBreaker.selector;
        if (inst.opensPaused) return OpensPausedForMarket.selector;
        if (leverage == 0 || leverage > inst.maxLeverage) return LeverageOutOfRange.selector;
        if (notional > inst.maxNotionalUsd) return PositionTooLarge.selector;
        uint256 longOi = _longOiUsd[instrumentId];
        uint256 shortOi = _shortOiUsd[instrumentId];
        uint256 sideOi = isLong ? longOi : shortOi;
        if (sideOi + notional > (isLong ? inst.longOiCapUsd : inst.shortOiCapUsd)) return OiCapExceeded.selector;
        uint256 free = _freeCash();
        if (notional > free * inst.posX10 / 10) return PositionTooLarge.selector;
        if (sideOi + notional > free * inst.sideX10 / 10) return OiCapExceeded.selector;
        if (isLong) longOi += notional;
        else shortOi += notional;
        uint256 after_ = _bookExposureUsdc - _exposureTerm[instrumentId] + _termFor(inst, longOi, shortOi);
        if (after_ > free * _rhoBps / BPS) return HouseExposureExceeded.selector;
        return 0;
    }

    /// @dev Unbook a position together with any close request on it.
    function _removePosition(uint256 positionId, Position memory pos) internal {
        uint256 notional = uint256(pos.marginUsdc) * pos.leverage;
        if (pos.isLong) _longOiUsd[pos.instrumentId] -= notional;
        else _shortOiUsd[pos.instrumentId] -= notional;
        _refreshExposure(pos.instrumentId, _instruments[pos.instrumentId]);
        _marginInUse[pos.owner] -= pos.marginUsdc;
        _openMaxPayoutUsdc -= pos.maxProfitUsdc;
        _positionIds[pos.owner].remove(positionId);
        delete _positions[positionId];
        delete _closeRequests[positionId];
    }

    // ------------------------------------------------------- internal: lookups

    function _instrument(uint32 instrumentId) internal view returns (Instrument storage) {
        if (instrumentId >= _instruments.length) revert UnknownInstrument(instrumentId);
        return _instruments[instrumentId];
    }

    function _position(uint256 positionId) internal view returns (Position memory pos) {
        pos = _positions[positionId];
        if (pos.owner == address(0)) revert UnknownPosition(positionId);
    }

    /// @dev The settlement price: the frozen price of a retired market, else the HyperCore
    ///      oracle price. The oracle reverts `FeedUnavailable` / `ZeroPrice` for a dead feed.
    function _execPrice(uint32 instrumentId, Instrument storage inst) internal view returns (uint256) {
        if (inst.retired) return inst.lastPx18;
        return _oracle.oraclePrice(instrumentId);
    }

    function _curve(Instrument storage inst) internal view returns (ImpactLib.Curve memory) {
        return ImpactLib.Curve({
            baseRateBps: inst.baseRateBps,
            rateMultiplier: inst.rateMultiplier,
            referenceNotionalUsd: inst.referenceNotionalUsd,
            positionMultiplierE6: inst.positionMultiplierE6
        });
    }

    /// @dev Borrow `pos` owes right now (see `ImpactLib.borrowFee`).
    function _borrowOwed(Position memory pos) internal view returns (uint256) {
        return ImpactLib.borrowFee(
            uint256(pos.marginUsdc) * pos.leverage, pos.borrowRateX10, block.timestamp - pos.openedAt, pos.borrowFreeHours
        );
    }

    /// @dev Bust price of `pos`, measured from the raw print its entry was spread from.
    function _bustPrice(Position memory pos) internal pure returns (uint256) {
        return ImpactLib.bustPrice(
            ImpactLib.rawEntry(pos.entryPx18, pos.isLong, pos.entryDeadbandBps), pos.isLong, pos.leverage
        );
    }

    /// @dev Signed outcome of closing `pos` at `exitPx18` (see `IMarketRules.quote`).
    function _quote(Position memory pos, Instrument storage inst, uint256 exitPx18)
        internal
        view
        returns (bool isWin, uint256 amount, uint256 forfeitedUsdc)
    {
        return _rules.quote(pos, _curve(inst), exitPx18);
    }
}
