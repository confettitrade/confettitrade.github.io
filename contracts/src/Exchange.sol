// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IExchange} from "./interfaces/IExchange.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IConfetti} from "./interfaces/IConfetti.sol";
import {ITokenomics} from "./interfaces/ITokenomics.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {IReferrals} from "./interfaces/IReferrals.sol";
import {ImpactLib} from "./lib/ImpactLib.sol";
import {Referrals} from "./Referrals.sol";

/// @title Exchange
/// @notice Synthetic perpetuals on meme coins against a self-funded LP (DESIGN sections 5, 6, 8).
/// @dev Cash model. The contract holds every USDC; its balance always equals
///        sum(available balances) + sum(open margins) + sum(pending request margins) + lpUsdc.
///      The fee pool and the payout queue are claims on `lpUsdc`, not separate cash:
///        1. the FIFO queue is paid first (`harvest`), and while it is non-empty every new win
///           is queued and no loss fee is carved;
///        2. with an empty queue a win is paid from LP cash on the spot, any shortfall queued;
///        3. the fee pool is paid last (`pushFees`), only when the queue is empty and LP cash
///           covers the whole pool;
///        4. Tokenomics may sweep LP cash above the staker cap (`sweepLpToStakers`).
///      Tokenomics tally: a win records -(adjusted gain) whether paid or queued; a loss records
///      +(loss - loss fee), i.e. the LP's net gain, so `trackedLpUsd` always equals
///      lpUsdc - feePool - queuedTotal (minus sweeps). The CONFETTI mint basis is the same
///      net figure on closes and the whole margin on liquidations.
///      Fees: one rate `feeBps` (at most 5%, owner-set, starts at 5%) on a win's adjusted
///      gain, a losing close's loss and a liquidated margin; losses and liquidations carve no
///      fee while the queue is active. Every carved fee is routed by `_takeFee`: a referred
///      trader's referrer gets `IReferrals.referralShareBps` of it, credited to their available
///      balance from LP cash at once (queued behind the FIFO queue when the LP cannot pay, the
///      only case being a win that just drained it), and the rest is a pool claim. `pushFees`
///      pays `stakerFeeShareBps` of the pool to stakers (0 at launch) and the rest to the fee
///      recipient. Every CONFETTI mint to a trader mints TEAM_MINT_BPS (10%) on top to the fee
///      recipient; Tokenomics' `totalMinted` counts the trader mints only.
///      Pricing: oracle only. `_execPrice` is the HyperCore oracle price (or the frozen price
///      of a retired market); the book mid never settles anything. A dead or zero feed reverts.
///      Delayed fills (`requestOpen` / `executeOpen`, `requestClose` / `executeClose`): a
///      request records p0 and its timestamp; `_fillMode` enforces the windows (`minDelay`,
///      keeper-only `grace`, open-to-anyone until `expiry`) and `_fill` picks p1 in the keeper
///      window and the trader-worse of p0 and p1 afterwards, so no choice of execution time
///      can beat the keeper's fill. An open re-runs `_openCheck` and the jump guard at
///      execution and refunds instead of reverting when a rule fails (the rule's selector
///      travels in the event); the margin waits in `_pending` meanwhile. A close request is
///      keyed by its position and deleted with it, so a liquidation voids it and never waits.
///      Settlement terms are stamped at execution: the market's deadband and payout cap and
///      the exchange's fee rate are copied into the position, and `executeClose`,
///      `previewClose` and `liquidate` settle on those copies, so `setInstrumentParams`,
///      `setPositionCaps` and `setFeeBps` only reach positions opened after the call. The
///      impact curve stays live (bounded, with the curve floor enforced by `_checkParams`).
///      Anti-manipulation controls (DESIGN 3b): a per-position notional cap and payout cap per
///      market, and an LP loss breaker that pauses opens everywhere when net LP outflow in a
///      one-hour window exceeds the larger of `breakerBps` of the LP cash at the window start
///      and `breakerFloorUsdc`. The window is anchored at the first settlement after the
///      previous one expired (a fixed window, not a sliding one); the breaker counts a win's
///      full adjusted gain when it settles, whether paid or queued, so `harvest` does not
///      count it again. A tripped breaker is cleared only by the guardian or the owner; closes,
///      liquidations and withdrawals keep working.
///      Immutable, no proxy. Owner is two-step (`Ownable2Step`). The referral registry is a
///      separate contract (`Referrals`) this one creates in its constructor and alone may write.
contract Exchange is IExchange, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    // -------------------------------------------------------------- constants

    uint256 public constant MIN_MARGIN_USDC = 10e6;
    /// @dev Fee rate cap (5%); the owner can lower the live rate, never raise it past this.
    uint16 public constant MAX_FEE_BPS = uint16(ImpactLib.MAX_FEE_BPS);
    /// @dev Team allocation: every CONFETTI mint to a trader mints this share on top to the
    ///      fee recipient (10%, so the team ends up with 1/11 of supply). Fixed, no setter.
    uint256 public constant TEAM_MINT_BPS = 1000;

    /// @dev Owner bounds and defaults (DESIGN section 8), stated in IExchange on each setter.
    uint32 private constant MAX_LEVERAGE = 1000;
    uint16 private constant MIN_DEADBAND_BPS = 1;
    uint16 private constant MAX_DEADBAND_BPS = 50;
    uint16 private constant MIN_CLAMP_BPS = 5;
    uint16 private constant MAX_CLAMP_BPS = 100;
    uint16 private constant MIN_BASE_RATE_BPS = 500;
    uint16 private constant MAX_BASE_RATE_BPS = 2000;
    uint128 private constant MAX_POSITION_NOTIONAL_USD = 100_000e6;
    uint16 private constant MIN_PAYOUT_CAP_X = 10;
    uint16 private constant MAX_PAYOUT_CAP_X = 200;
    uint16 private constant MIN_BREAKER_BPS = 200;
    uint16 private constant MAX_BREAKER_BPS = 5000;
    uint16 private constant DEFAULT_BREAKER_BPS = 1000;
    uint64 private constant BREAKER_WINDOW = 1 hours;
    /// @dev The breaker never trips below this net hourly outflow, so a young LP (it starts
    ///      at zero) does not pause opens on every net-winning hour. 0 restores the bare share.
    uint128 private constant MAX_BREAKER_FLOOR_USDC = 100_000e6;
    uint128 private constant DEFAULT_BREAKER_FLOOR_USDC = 5_000e6;
    /// @dev Request windows (seconds) and the jump guard (bps of p0).
    uint32 private constant DEFAULT_MIN_DELAY = 5;
    uint32 private constant DEFAULT_GRACE = 3;
    uint32 private constant DEFAULT_EXPIRY = 60;
    uint16 private constant DEFAULT_MAX_JUMP_BPS = 1000;
    uint32 private constant MIN_MIN_DELAY = 2;
    uint32 private constant MAX_MIN_DELAY = 30;
    uint32 private constant MIN_GRACE = 1;
    uint32 private constant MAX_GRACE = 10;
    uint32 private constant MIN_EXPIRY = 20;
    uint32 private constant MAX_EXPIRY = 300;
    uint16 private constant MIN_MAX_JUMP_BPS = 10;

    /// @dev OI cap ceilings per tier (DESIGN section 4 launches at $250K / $100K / $25K).
    uint128 private constant TIER_A_MAX_OI_CAP_USD = 2_000_000e6;
    uint128 private constant TIER_B_MAX_OI_CAP_USD = 500_000e6;
    uint128 private constant TIER_C_MAX_OI_CAP_USD = 100_000e6;

    /// @dev Impact-curve parameter bounds (DESIGN section 8 "within bounds"), see `_checkParams`.
    uint64 private constant MIN_RATE_MULTIPLIER = 1_000;
    uint64 private constant MAX_RATE_MULTIPLIER = 1_000_000;
    uint128 private constant MIN_REFERENCE_NOTIONAL_USD = 1_000e6;
    uint128 private constant MAX_REFERENCE_NOTIONAL_USD = 1_000_000e6;
    uint128 private constant MIN_POSITION_MULTIPLIER_E6 = 1e12;
    uint256 private constant MIN_SCALE_ONE_PCT_E18 = 0.5e18;
    uint256 private constant MAX_SCALE_ONE_PCT_E18 = 0.95e18;
    uint256 private constant BPS = 10_000;

    // ---------------------------------------------------------------- storage

    struct QueueEntry {
        address recipient;
        uint256 owedUsdc;
    }

    /// @dev Scratch record for one close, kept in memory to stay within the stack limit. The
    ///      caller fills `exitPx18`; `_settleClose` fills the rest.
    struct Settlement {
        uint256 exitPx18;
        int256 pnlUsdc;
        uint256 feeUsdc;
        uint256 payoutUsdc;
        uint256 queuedUsdc;
        uint256 confettiMinted;
    }

    IERC20 private immutable _usdc;
    IPriceOracle private immutable _oracle;
    IConfetti private immutable _confetti;
    ITokenomics private immutable _tokenomics;
    IStaking private immutable _staking;
    IReferrals private immutable _referrals;

    address private _pauseGuardian;
    address private _marketKeeper;
    address private _feeRecipient;
    bool private _globalOpensPaused;

    Instrument[] private _instruments;
    mapping(uint32 => uint256) private _longOiUsd;
    mapping(uint32 => uint256) private _shortOiUsd;

    mapping(address => uint256) private _available;
    mapping(address => uint256) private _marginInUse;
    mapping(address => uint256) private _pending;
    mapping(address => EnumerableSet.UintSet) private _positionIds;
    mapping(uint256 => Position) private _positions;
    uint256 private _nextPositionId = 1;

    mapping(uint256 => OpenRequest) private _openRequests;
    /// @dev Keyed by position id.
    mapping(uint256 => CloseRequest) private _closeRequests;
    uint256 private _nextRequestId = 1;
    mapping(address => bool) private _keepers;

    uint256 private _lpUsdc;
    uint256 private _feePoolUsdc;
    QueueEntry[] private _queue;
    uint256 private _queueHead;
    uint256 private _queuedTotal;

    /// @dev LP loss breaker (DESIGN 3b item 3), fee rates and the request windows, packed.
    uint16 private _breakerBps;
    bool private _breakerTripped;
    uint128 private _breakerFloorUsdc;
    /// @dev Fee rate stamped on new positions, 0..MAX_FEE_BPS. Settlement reads the stamp.
    uint16 private _feeBps;
    uint16 private _stakerFeeShareBps;
    uint16 private _maxJumpBps;
    uint32 private _minDelay;
    uint32 private _grace;
    uint32 private _expiry;
    uint64 private _windowStart;
    uint256 private _windowStartLp;
    int256 private _windowNetOutflow;

    // -------------------------------------------------------------- modifiers

    modifier onlyGuardianOrOwner() {
        if (msg.sender != _pauseGuardian && msg.sender != owner()) revert Unauthorized();
        _;
    }

    modifier onlyKeeperOrOwner() {
        if (msg.sender != _marketKeeper && msg.sender != owner()) revert Unauthorized();
        _;
    }

    // ------------------------------------------------------------ constructor

    /// @param usdc_ USDC token (6 decimals).
    /// @param oracle_ Price oracle; this contract must be its registrar before markets are added.
    /// @param confetti_ CONFETTI token; this contract must be wired as its minter.
    /// @param tokenomics_ Tokenomics; this contract must be wired as its exchange.
    /// @param staking_ Staking; receives fee and overflow rewards.
    /// @param owner_ Initial owner.
    /// @param feeRecipient_ Receives the non-staker share of pushed fees and the team share of
    ///        every CONFETTI mint.
    constructor(
        IERC20 usdc_,
        IPriceOracle oracle_,
        IConfetti confetti_,
        ITokenomics tokenomics_,
        IStaking staking_,
        address owner_,
        address feeRecipient_
    ) Ownable(owner_) {
        if (
            address(usdc_) == address(0) || address(oracle_) == address(0) || address(confetti_) == address(0)
                || address(tokenomics_) == address(0) || address(staking_) == address(0) || feeRecipient_ == address(0)
        ) revert ZeroAddress();
        _usdc = usdc_;
        _oracle = oracle_;
        _confetti = confetti_;
        _tokenomics = tokenomics_;
        _staking = staking_;
        _referrals = new Referrals(address(this));
        _feeRecipient = feeRecipient_;
        _breakerBps = DEFAULT_BREAKER_BPS;
        _breakerFloorUsdc = DEFAULT_BREAKER_FLOOR_USDC;
        _feeBps = MAX_FEE_BPS;
        _minDelay = DEFAULT_MIN_DELAY;
        _grace = DEFAULT_GRACE;
        _expiry = DEFAULT_EXPIRY;
        _maxJumpBps = DEFAULT_MAX_JUMP_BPS;
        emit FeeRecipientSet(feeRecipient_);
        emit BreakerBpsSet(DEFAULT_BREAKER_BPS);
        emit BreakerFloorSet(DEFAULT_BREAKER_FLOOR_USDC);
        emit FeeBpsSet(MAX_FEE_BPS);
        emit StakerFeeShareSet(0);
        emit DelaysSet(DEFAULT_MIN_DELAY, DEFAULT_GRACE, DEFAULT_EXPIRY);
        emit MaxJumpBpsSet(DEFAULT_MAX_JUMP_BPS);
    }

    // ------------------------------------------------------------- collateral

    /// @inheritdoc IExchange
    function deposit(uint256 amountUsdc) external nonReentrant {
        _deposit(msg.sender, amountUsdc);
    }

    /// @inheritdoc IExchange
    function depositFor(address beneficiary, uint256 amountUsdc) external nonReentrant {
        if (beneficiary == address(0)) revert ZeroAddress();
        _deposit(beneficiary, amountUsdc);
    }

    /// @inheritdoc IExchange
    function withdraw(uint256 amountUsdc) external nonReentrant {
        if (amountUsdc == 0) revert ZeroAmount();
        uint256 available = _available[msg.sender];
        if (available < amountUsdc) revert InsufficientBalance(available, amountUsdc);
        _available[msg.sender] = available - amountUsdc;
        _usdc.safeTransfer(msg.sender, amountUsdc);
        emit Withdrawn(msg.sender, amountUsdc);
    }

    // ---------------------------------------------------------------- trading

    /// @inheritdoc IExchange
    function requestOpen(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, address referrer)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        Instrument storage inst = _instrument(instrumentId);
        if (marginUsdc < MIN_MARGIN_USDC) revert MarginBelowMinimum();
        bytes4 rule = _openCheck(instrumentId, inst, isLong, leverage, uint256(marginUsdc) * leverage);
        if (rule != 0) _revertWith(rule);
        uint256 available = _available[msg.sender];
        if (available < marginUsdc) revert InsufficientBalance(available, marginUsdc);
        uint256 px0 = _execPrice(instrumentId, inst);
        if (referrer == msg.sender) referrer = address(0);

        requestId = _nextRequestId++;
        _openRequests[requestId] = OpenRequest({
            trader: msg.sender,
            instrumentId: instrumentId,
            isLong: isLong,
            marginUsdc: marginUsdc,
            leverage: leverage,
            requestedAt: uint64(block.timestamp),
            px0: px0,
            referrer: referrer
        });
        _available[msg.sender] = available - marginUsdc;
        _pending[msg.sender] += marginUsdc;
        emit OpenRequested(requestId, msg.sender, instrumentId, isLong, marginUsdc, leverage, px0, referrer);
    }

    /// @inheritdoc IExchange
    function executeOpen(uint256 requestId) external nonReentrant returns (uint256 positionId) {
        OpenRequest memory r = _openRequests[requestId];
        if (r.trader == address(0)) revert UnknownRequest();
        bool keeperFill = _fillMode(r.requestedAt);
        Instrument storage inst = _instruments[r.instrumentId];

        // Every open-time rule again, then the jump guard, then the born-busted guard; a
        // failure refunds instead of reverting so the margin never waits on a rule that may
        // not clear before expiry.
        bytes4 rule = _openCheck(r.instrumentId, inst, r.isLong, r.leverage, uint256(r.marginUsdc) * r.leverage);
        uint256 entryPx18;
        if (rule == 0) {
            uint256 px1 = _execPrice(r.instrumentId, inst);
            uint256 diff = px1 > r.px0 ? px1 - r.px0 : r.px0 - px1;
            entryPx18 = _fill(keeperFill, r.px0, px1, r.isLong);
            if (diff * BPS > r.px0 * _maxJumpBps) {
                rule = PriceJumped.selector;
            } else if (ImpactLib.isBusted(px1, ImpactLib.bustPrice(entryPx18, r.isLong, r.leverage), r.isLong)) {
                // A fallback fill books p0 while the live p1 may already sit past that entry's
                // bust price (5 bps at 1000x, far inside the jump guard): the position would be
                // liquidated in this very block, so refund instead. A keeper fill has entry ==
                // p1 and can never trip this.
                rule = EntryBusted.selector;
            }
        }
        if (rule != 0) {
            _refundOpen(requestId, r, rule);
            return 0;
        }

        delete _openRequests[requestId];
        _pending[r.trader] -= r.marginUsdc;
        positionId = _createPosition(r, inst, entryPx18);
        _referrals.lockReferrer(r.trader, r.referrer);
        emit PositionOpened(
            positionId, r.trader, r.instrumentId, r.isLong, r.marginUsdc, r.leverage, entryPx18, requestId
        );
    }

    /// @inheritdoc IExchange
    function cancelOpen(uint256 requestId) external nonReentrant {
        OpenRequest memory r = _openRequests[requestId];
        if (r.trader == address(0)) revert UnknownRequest();
        if (!_expired(r.requestedAt)) revert RequestNotExpired();
        _refundOpen(requestId, r, RequestExpired.selector);
    }

    /// @inheritdoc IExchange
    function requestClose(uint256 positionId) external nonReentrant {
        Position memory pos = _position(positionId);
        if (pos.owner != msg.sender) revert NotPositionOwner(positionId, msg.sender);
        if (_closeRequests[positionId].requestedAt != 0) revert CloseAlreadyPending();
        uint256 px0 = _execPrice(pos.instrumentId, _instruments[pos.instrumentId]);
        _closeRequests[positionId] = CloseRequest({requestedAt: uint64(block.timestamp), px0: px0});
        emit CloseRequested(positionId, msg.sender, px0);
    }

    /// @inheritdoc IExchange
    function executeClose(uint256 positionId) external nonReentrant returns (uint256 payoutUsdc, uint256 queuedUsdc) {
        CloseRequest memory r = _closeRequests[positionId];
        if (r.requestedAt == 0) revert UnknownRequest();
        bool keeperFill = _fillMode(r.requestedAt);
        // The request is deleted with its position, so the position exists.
        Position memory pos = _positions[positionId];
        Instrument storage inst = _instruments[pos.instrumentId];
        Settlement memory s;
        s.exitPx18 = _fill(keeperFill, r.px0, _execPrice(pos.instrumentId, inst), !pos.isLong);
        _settleClose(positionId, pos, inst, s);
        return (s.payoutUsdc, s.queuedUsdc);
    }

    /// @inheritdoc IExchange
    function cancelClose(uint256 positionId) external nonReentrant {
        uint64 requestedAt = _closeRequests[positionId].requestedAt;
        if (requestedAt == 0) revert UnknownRequest();
        if (!_expired(requestedAt)) revert RequestNotExpired();
        delete _closeRequests[positionId];
        emit CloseRequestCancelled(positionId, RequestExpired.selector);
    }

    /// @inheritdoc IExchange
    function liquidate(uint256 positionId) external nonReentrant returns (uint256 bountyUsdc) {
        Position memory pos = _position(positionId);
        Instrument storage inst = _instruments[pos.instrumentId];

        uint256 exitPx18 = _execPrice(pos.instrumentId, inst);
        uint256 bustPx18 = ImpactLib.bustPrice(pos.entryPx18, pos.isLong, pos.leverage);
        if (!ImpactLib.isBusted(exitPx18, bustPx18, pos.isLong)) {
            revert NotLiquidatable(positionId, exitPx18, bustPx18);
        }
        // A pending close never holds a liquidation up; it is voided with the position.
        if (_closeRequests[positionId].requestedAt != 0) {
            emit CloseRequestCancelled(positionId, UnknownPosition.selector);
        }
        _removePosition(positionId, pos);

        uint256 margin = pos.marginUsdc;
        (uint256 bounty, uint256 fee, uint256 lpGain) = ImpactLib.splitLiquidation(margin, _lossFeeBps(pos.feeBps));
        _recordLpFlow(-int256(lpGain));
        _available[msg.sender] += bounty;
        _lpUsdc += margin - bounty;
        _takeFee(pos.owner, fee);

        uint256 minted = _tokenomics.recordLoss(margin);
        _tokenomics.recordLpDelta(int256(lpGain));
        _mintConfetti(pos.owner, minted);

        emit PositionLiquidated(positionId, pos.owner, msg.sender, exitPx18, pos.marginUsdc, bounty, fee, minted);
        return bounty;
    }

    /// @inheritdoc IExchange
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

    /// @inheritdoc IExchange
    function pushFees() external nonReentrant returns (uint256 toStakersUsdc, uint256 toRecipientUsdc) {
        uint256 pool = _feePoolUsdc;
        if (!_queueIsEmpty() || pool == 0 || _lpUsdc < pool) revert NothingToPush();

        toStakersUsdc = pool * _stakerFeeShareBps / BPS;
        toRecipientUsdc = pool - toStakersUsdc;
        _feePoolUsdc = 0;
        _lpUsdc -= pool;
        _available[_feeRecipient] += toRecipientUsdc;
        // A zero share, or a dust pool whose share rounds to zero: Staking rejects a zero reward.
        if (toStakersUsdc != 0) _notifyStakers(toStakersUsdc);

        emit FeesPushed(toStakersUsdc, toRecipientUsdc);
    }

    /// @inheritdoc IExchange
    function sweepLpToStakers(uint256 amountUsdc) external nonReentrant {
        if (msg.sender != address(_tokenomics)) revert Unauthorized();
        if (amountUsdc == 0) revert ZeroAmount();
        if (!_queueIsEmpty()) revert QueueNotEmpty();
        uint256 cash = _lpUsdc;
        if (amountUsdc > cash) revert InsufficientBalance(cash, amountUsdc);

        _lpUsdc = cash - amountUsdc;
        _notifyStakers(amountUsdc);
        emit StakerOverflowSwept(amountUsdc);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IExchange
    function balanceOf(address user) external view returns (uint256) {
        return _available[user];
    }

    /// @inheritdoc IExchange
    function marginInUse(address user) external view returns (uint256) {
        return _marginInUse[user];
    }

    /// @inheritdoc IExchange
    function pendingOf(address user) external view returns (uint256) {
        return _pending[user];
    }

    /// @inheritdoc IExchange
    function positions(uint256 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    /// @inheritdoc IExchange
    function positionIdsOf(address user) external view returns (uint256[] memory) {
        return _positionIds[user].values();
    }

    /// @inheritdoc IExchange
    function openRequest(uint256 requestId) external view returns (OpenRequest memory) {
        return _openRequests[requestId];
    }

    /// @inheritdoc IExchange
    function closeRequest(uint256 positionId) external view returns (CloseRequest memory) {
        return _closeRequests[positionId];
    }

    /// @inheritdoc IExchange
    function bustPrice(uint256 positionId) external view returns (uint256) {
        Position memory pos = _position(positionId);
        return ImpactLib.bustPrice(pos.entryPx18, pos.isLong, pos.leverage);
    }

    /// @inheritdoc IExchange
    function previewClose(uint256 positionId)
        external
        view
        returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc)
    {
        Position memory pos = _position(positionId);
        Instrument storage inst = _instruments[pos.instrumentId];
        (bool isWin, uint256 amount,) = _quote(pos, inst, _execPrice(pos.instrumentId, inst));
        uint256 margin = pos.marginUsdc;
        if (amount == 0) return (0, 0, margin);
        if (isWin) {
            feeUsdc = ImpactLib.winFee(amount, pos.feeBps);
            uint256 profit = amount - feeUsdc;
            return (int256(profit), feeUsdc, margin + profit);
        }
        (feeUsdc,) = ImpactLib.splitLoss(amount, _lossFeeBps(pos.feeBps));
        return (-int256(amount), feeUsdc, margin - amount);
    }

    /// @inheritdoc IExchange
    function execPrice(uint32 instrumentId, bool, bool) external view returns (uint256) {
        return _execPrice(instrumentId, _instrument(instrumentId));
    }

    /// @inheritdoc IExchange
    function nextRequestId() external view returns (uint256) {
        return _nextRequestId;
    }

    /// @inheritdoc IExchange
    function nextPositionId() external view returns (uint256) {
        return _nextPositionId;
    }

    /// @inheritdoc IExchange
    function instrument(uint32 instrumentId) external view returns (Instrument memory) {
        return _instrument(instrumentId);
    }

    /// @inheritdoc IExchange
    function instrumentCount() external view returns (uint32) {
        return uint32(_instruments.length);
    }

    /// @inheritdoc IExchange
    function openInterest(uint32 instrumentId) external view returns (uint256 longUsd, uint256 shortUsd) {
        return (_longOiUsd[instrumentId], _shortOiUsd[instrumentId]);
    }

    /// @inheritdoc IExchange
    function lpBalance() external view returns (uint256) {
        return _lpUsdc;
    }

    /// @inheritdoc IExchange
    function feePool() external view returns (uint256) {
        return _feePoolUsdc;
    }

    /// @inheritdoc IExchange
    function queueLength() external view returns (uint256) {
        return _queue.length;
    }

    /// @inheritdoc IExchange
    function queueHead() external view returns (uint256) {
        return _queueHead;
    }

    /// @inheritdoc IExchange
    function queueEntry(uint256 index) external view returns (address recipient, uint256 owedUsdc) {
        QueueEntry storage entry = _queue[index];
        return (entry.recipient, entry.owedUsdc);
    }

    /// @inheritdoc IExchange
    function queuedTotal() external view returns (uint256) {
        return _queuedTotal;
    }

    /// @inheritdoc IExchange
    function globalOpensPaused() external view returns (bool) {
        return _globalOpensPaused;
    }

    /// @inheritdoc IExchange
    function breakerBps() external view returns (uint16) {
        return _breakerBps;
    }

    /// @inheritdoc IExchange
    function feeBps() external view returns (uint16) {
        return _feeBps;
    }

    /// @inheritdoc IExchange
    function stakerFeeShareBps() external view returns (uint16) {
        return _stakerFeeShareBps;
    }

    /// @inheritdoc IExchange
    function minDelay() external view returns (uint32) {
        return _minDelay;
    }

    /// @inheritdoc IExchange
    function grace() external view returns (uint32) {
        return _grace;
    }

    /// @inheritdoc IExchange
    function expiry() external view returns (uint32) {
        return _expiry;
    }

    /// @inheritdoc IExchange
    function maxJumpBps() external view returns (uint16) {
        return _maxJumpBps;
    }

    /// @inheritdoc IExchange
    function isKeeper(address account) external view returns (bool) {
        return _keepers[account];
    }

    /// @inheritdoc IExchange
    function breakerFloorUsdc() external view returns (uint128) {
        return _breakerFloorUsdc;
    }

    /// @inheritdoc IExchange
    function breakerTripped() external view returns (bool) {
        return _breakerTripped;
    }

    /// @inheritdoc IExchange
    function breakerWindow() external view returns (uint64, uint256, int256) {
        return (_windowStart, _windowStartLp, _windowNetOutflow);
    }

    /// @inheritdoc IExchange
    function usdc() external view returns (address) {
        return address(_usdc);
    }

    /// @inheritdoc IExchange
    function oracle() external view returns (address) {
        return address(_oracle);
    }

    /// @inheritdoc IExchange
    function confetti() external view returns (address) {
        return address(_confetti);
    }

    /// @inheritdoc IExchange
    function tokenomics() external view returns (address) {
        return address(_tokenomics);
    }

    /// @inheritdoc IExchange
    function staking() external view returns (address) {
        return address(_staking);
    }

    /// @inheritdoc IExchange
    function referrals() external view returns (address) {
        return address(_referrals);
    }

    /// @inheritdoc IExchange
    function owner() public view override(IExchange, Ownable) returns (address) {
        return Ownable.owner();
    }

    /// @inheritdoc IExchange
    function pauseGuardian() external view returns (address) {
        return _pauseGuardian;
    }

    /// @inheritdoc IExchange
    function marketKeeper() external view returns (address) {
        return _marketKeeper;
    }

    /// @inheritdoc IExchange
    function feeRecipient() external view returns (address) {
        return _feeRecipient;
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc IExchange
    function addInstrument(Instrument calldata spec) external onlyOwner returns (uint32 instrumentId) {
        if (spec.tier > 2) revert InvalidTier(spec.tier);
        _checkLeverage(spec.maxLeverage);
        _checkParams(
            spec.deadbandBps,
            spec.clampBps,
            spec.baseRateBps,
            spec.rateMultiplier,
            spec.referenceNotionalUsd,
            spec.positionMultiplierE6
        );
        _checkOiCaps(spec.tier, spec.longOiCapUsd, spec.shortOiCapUsd);
        _checkPositionCaps(spec.maxNotionalUsd, spec.payoutCapX);

        instrumentId = uint32(_instruments.length);
        Instrument storage inst = _instruments.push();
        inst.hlAssetIndex = spec.hlAssetIndex;
        inst.szDecimals = spec.szDecimals;
        inst.tier = spec.tier;
        inst.maxLeverage = spec.maxLeverage;
        inst.deadbandBps = spec.deadbandBps;
        inst.clampBps = spec.clampBps;
        inst.baseRateBps = spec.baseRateBps;
        inst.rateMultiplier = spec.rateMultiplier;
        inst.referenceNotionalUsd = spec.referenceNotionalUsd;
        inst.positionMultiplierE6 = spec.positionMultiplierE6;
        inst.longOiCapUsd = spec.longOiCapUsd;
        inst.shortOiCapUsd = spec.shortOiCapUsd;
        inst.maxNotionalUsd = spec.maxNotionalUsd;
        inst.payoutCapX = spec.payoutCapX;
        _oracle.setInstrument(instrumentId, spec.hlAssetIndex, spec.szDecimals, spec.clampBps);

        emit InstrumentAdded(instrumentId, spec.hlAssetIndex, spec.szDecimals, spec.tier, spec.maxLeverage);
    }

    /// @inheritdoc IExchange
    function setInstrumentParams(
        uint32 instrumentId,
        uint16 deadbandBps,
        uint16 clampBps,
        uint16 baseRateBps,
        uint64 rateMultiplier,
        uint128 referenceNotionalUsd,
        uint128 positionMultiplierE6
    ) external onlyOwner {
        Instrument storage inst = _instrument(instrumentId);
        _checkParams(deadbandBps, clampBps, baseRateBps, rateMultiplier, referenceNotionalUsd, positionMultiplierE6);

        bool clampChanged = inst.clampBps != clampBps;
        inst.deadbandBps = deadbandBps;
        inst.clampBps = clampBps;
        inst.baseRateBps = baseRateBps;
        inst.rateMultiplier = rateMultiplier;
        inst.referenceNotionalUsd = referenceNotionalUsd;
        inst.positionMultiplierE6 = positionMultiplierE6;
        if (clampChanged) _oracle.setInstrument(instrumentId, inst.hlAssetIndex, inst.szDecimals, clampBps);

        emit InstrumentParamsSet(
            instrumentId, deadbandBps, clampBps, baseRateBps, rateMultiplier, referenceNotionalUsd, positionMultiplierE6
        );
    }

    /// @inheritdoc IExchange
    function setMaxLeverage(uint32 instrumentId, uint32 maxLeverage) external onlyOwner {
        _checkLeverage(maxLeverage);
        _instrument(instrumentId).maxLeverage = maxLeverage;
        emit MaxLeverageSet(instrumentId, maxLeverage);
    }

    /// @inheritdoc IExchange
    function setOiCaps(uint32 instrumentId, uint128 longOiCapUsd, uint128 shortOiCapUsd) external onlyKeeperOrOwner {
        Instrument storage inst = _instrument(instrumentId);
        _checkOiCaps(inst.tier, longOiCapUsd, shortOiCapUsd);
        inst.longOiCapUsd = longOiCapUsd;
        inst.shortOiCapUsd = shortOiCapUsd;
        emit OiCapsSet(instrumentId, longOiCapUsd, shortOiCapUsd);
    }

    /// @inheritdoc IExchange
    function setMarketOpensPaused(uint32 instrumentId, bool paused) external {
        _checkPauseAuthority(paused);
        _instrument(instrumentId).opensPaused = paused;
        emit MarketOpensPausedSet(instrumentId, paused);
    }

    /// @inheritdoc IExchange
    function setGlobalOpensPaused(bool paused) external {
        _checkPauseAuthority(paused);
        _globalOpensPaused = paused;
        emit GlobalOpensPausedSet(paused);
    }

    /// @inheritdoc IExchange
    function retire(uint32 instrumentId) external onlyGuardianOrOwner {
        Instrument storage inst = _instrument(instrumentId);
        if (inst.retired) revert MarketRetired();
        uint256 frozenPx18 = _oracle.oraclePrice(instrumentId);
        inst.retired = true;
        inst.frozenPx18 = frozenPx18;
        emit InstrumentRetired(instrumentId, frozenPx18);
    }

    /// @inheritdoc IExchange
    function retireAtPrice(uint32 instrumentId, uint256 px18) external onlyOwner {
        Instrument storage inst = _instrument(instrumentId);
        if (inst.retired) revert MarketRetired();
        if (px18 == 0) revert ZeroAmount();
        try _oracle.oraclePrice(instrumentId) returns (uint256) {
            revert FeedAlive(instrumentId);
        } catch {}
        inst.retired = true;
        inst.frozenPx18 = px18;
        emit InstrumentRetired(instrumentId, px18);
    }

    /// @inheritdoc IExchange
    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        if (newFeeRecipient == address(0)) revert ZeroAddress();
        _feeRecipient = newFeeRecipient;
        emit FeeRecipientSet(newFeeRecipient);
    }

    /// @inheritdoc IExchange
    function setKeepers(address newPauseGuardian, address newMarketKeeper) external onlyOwner {
        _pauseGuardian = newPauseGuardian;
        _marketKeeper = newMarketKeeper;
        emit KeepersSet(newPauseGuardian, newMarketKeeper);
    }

    /// @inheritdoc IExchange
    function setKeeper(address keeper, bool allowed) external onlyOwner {
        _keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /// @inheritdoc IExchange
    function setDelays(uint32 newMinDelay, uint32 newGrace, uint32 newExpiry) external onlyOwner {
        if (newMinDelay < MIN_MIN_DELAY || newMinDelay > MAX_MIN_DELAY) {
            revert ParamOutOfBounds(Param.MinDelay, newMinDelay);
        }
        if (newGrace < MIN_GRACE || newGrace > MAX_GRACE) revert ParamOutOfBounds(Param.Grace, newGrace);
        if (newExpiry < MIN_EXPIRY || newExpiry > MAX_EXPIRY || newMinDelay + newGrace >= newExpiry) {
            revert ParamOutOfBounds(Param.Expiry, newExpiry);
        }
        _minDelay = newMinDelay;
        _grace = newGrace;
        _expiry = newExpiry;
        emit DelaysSet(newMinDelay, newGrace, newExpiry);
    }

    /// @inheritdoc IExchange
    function setMaxJumpBps(uint16 newMaxJumpBps) external onlyOwner {
        if (newMaxJumpBps < MIN_MAX_JUMP_BPS || newMaxJumpBps > BPS) {
            revert ParamOutOfBounds(Param.MaxJumpBps, newMaxJumpBps);
        }
        _maxJumpBps = newMaxJumpBps;
        emit MaxJumpBpsSet(newMaxJumpBps);
    }

    /// @inheritdoc IExchange
    function setPositionCaps(uint32 instrumentId, uint128 maxNotionalUsd, uint16 payoutCapX) external onlyOwner {
        Instrument storage inst = _instrument(instrumentId);
        _checkPositionCaps(maxNotionalUsd, payoutCapX);
        inst.maxNotionalUsd = maxNotionalUsd;
        inst.payoutCapX = payoutCapX;
        emit PositionCapsSet(instrumentId, maxNotionalUsd, payoutCapX);
    }

    /// @inheritdoc IExchange
    function setBreakerBps(uint16 newBreakerBps) external onlyOwner {
        if (newBreakerBps < MIN_BREAKER_BPS || newBreakerBps > MAX_BREAKER_BPS) {
            revert ParamOutOfBounds(Param.BreakerBps, newBreakerBps);
        }
        _breakerBps = newBreakerBps;
        emit BreakerBpsSet(newBreakerBps);
    }

    /// @inheritdoc IExchange
    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert ParamOutOfBounds(Param.FeeBps, newFeeBps);
        _feeBps = newFeeBps;
        emit FeeBpsSet(newFeeBps);
    }

    /// @inheritdoc IExchange
    function setStakerFeeShare(uint16 newShareBps) external onlyOwner {
        if (newShareBps > BPS) revert ParamOutOfBounds(Param.StakerFeeShareBps, newShareBps);
        _stakerFeeShareBps = newShareBps;
        emit StakerFeeShareSet(newShareBps);
    }

    /// @inheritdoc IExchange
    function setReferralShare(uint16 newShareBps) external onlyOwner {
        _referrals.setShareBps(newShareBps);
    }

    /// @inheritdoc IExchange
    function setBreakerFloor(uint128 newFloorUsdc) external onlyOwner {
        if (newFloorUsdc > MAX_BREAKER_FLOOR_USDC) revert ParamOutOfBounds(Param.BreakerFloorUsdc, newFloorUsdc);
        _breakerFloorUsdc = newFloorUsdc;
        emit BreakerFloorSet(newFloorUsdc);
    }

    /// @inheritdoc IExchange
    function clearBreaker() external onlyGuardianOrOwner {
        if (!_breakerTripped) revert BreakerNotTripped();
        _breakerTripped = false;
        _startWindow();
        emit BreakerCleared(msg.sender);
    }

    // ----------------------------------------------------- internal: requests

    /// @dev The open-time rules as the selector of the first one that fails (0 = all clear), so
    ///      `requestOpen` can revert with it and `executeOpen` can refund with it instead.
    function _openCheck(uint32 instrumentId, Instrument storage inst, bool isLong, uint32 leverage, uint256 notional)
        private
        view
        returns (bytes4)
    {
        if (inst.retired) return MarketRetired.selector;
        if (_globalOpensPaused) return OpensPausedGlobally.selector;
        if (_breakerTripped) return OpensPausedByBreaker.selector;
        if (inst.opensPaused) return OpensPausedForMarket.selector;
        if (leverage == 0 || leverage > inst.maxLeverage) return LeverageOutOfRange.selector;
        if (notional > inst.maxNotionalUsd) return PositionTooLarge.selector;
        if (notional > _headroom(instrumentId, isLong, inst)) return OiCapExceeded.selector;
        return 0;
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
    ///      touch it.
    function _createPosition(OpenRequest memory r, Instrument storage inst, uint256 entryPx18)
        private
        returns (uint256 positionId)
    {
        positionId = _nextPositionId++;
        _positions[positionId] = Position({
            owner: r.trader,
            instrumentId: r.instrumentId,
            isLong: r.isLong,
            marginUsdc: r.marginUsdc,
            leverage: r.leverage,
            entryPx18: entryPx18,
            openedAt: uint64(block.timestamp),
            deadbandBps: inst.deadbandBps,
            payoutCapX: inst.payoutCapX,
            feeBps: _feeBps
        });
        _positionIds[r.trader].add(positionId);
        _marginInUse[r.trader] += r.marginUsdc;
        uint256 notional = uint256(r.marginUsdc) * r.leverage;
        if (r.isLong) _longOiUsd[r.instrumentId] += notional;
        else _shortOiUsd[r.instrumentId] += notional;
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
    ///      `_settleWin`, a loss through `_settleLoss`; the outcome lands in `s`.
    function _settleClose(uint256 positionId, Position memory pos, Instrument storage inst, Settlement memory s)
        private
    {
        (bool isWin, uint256 amount, uint256 forfeited) = _quote(pos, inst, s.exitPx18);
        _removePosition(positionId, pos);
        if (amount == 0) {
            _available[pos.owner] += pos.marginUsdc;
            s.payoutUsdc = pos.marginUsdc;
        } else if (isWin) {
            _settleWin(pos, amount, s);
            if (forfeited > 0) emit PayoutCapped(positionId, amount, forfeited);
        } else {
            _settleLoss(pos, amount, s);
        }
        emit PositionClosed(
            positionId, pos.owner, s.exitPx18, s.pnlUsdc, s.feeUsdc, s.payoutUsdc, s.queuedUsdc, s.confettiMinted
        );
    }

    /// @dev Signed outcome of closing `pos` at `exitPx18`: (true, adjusted gain) for a win after
    ///      deadband, impact and the payout cap, (false, capped loss) for a loss. `amount == 0`
    ///      means flat. `forfeitedUsdc` is the part of a winning gain above
    ///      `payoutCapX * margin`, which stays in the LP (DESIGN 3b). The deadband and the cap
    ///      are the position's stamps; only the impact curve is read live from `inst`.
    function _quote(Position memory pos, Instrument storage inst, uint256 exitPx18)
        private
        view
        returns (bool isWin, uint256 amount, uint256 forfeitedUsdc)
    {
        uint256 notional = uint256(pos.marginUsdc) * pos.leverage;
        isWin = pos.isLong ? exitPx18 > pos.entryPx18 : exitPx18 < pos.entryPx18;
        if (isWin) {
            uint256 adjustedExit = ImpactLib.deadbandExit(exitPx18, pos.isLong, pos.deadbandBps);
            (uint256 gain, uint256 moveE18) = ImpactLib.rawGain(notional, pos.entryPx18, adjustedExit, pos.isLong);
            amount = ImpactLib.adjustedGain(gain, moveE18, _curve(inst));
            uint256 cap = uint256(pos.marginUsdc) * pos.payoutCapX;
            if (amount > cap) {
                forfeitedUsdc = amount - cap;
                amount = cap;
            }
        } else {
            amount = ImpactLib.cappedLoss(notional, pos.marginUsdc, pos.entryPx18, exitPx18, pos.isLong);
        }
    }

    /// @dev Winning close: profit paid from LP cash or queued, margin returned, then the fee
    ///      routed (the referrer share queues behind the trader when the LP ran dry). The
    ///      breaker counts the whole adjusted gain, paid or queued.
    function _settleWin(Position memory pos, uint256 adjusted, Settlement memory s) private {
        _recordLpFlow(int256(adjusted));
        uint256 fee = ImpactLib.winFee(adjusted, pos.feeBps);
        uint256 profit = adjusted - fee;

        uint256 paidNow;
        if (_queueIsEmpty()) {
            uint256 cash = _lpUsdc;
            paidNow = profit < cash ? profit : cash;
            _lpUsdc = cash - paidNow;
        }
        uint256 queued = profit - paidNow;
        if (queued > 0) _enqueue(pos.owner, queued);

        _available[pos.owner] += pos.marginUsdc + paidNow;
        _takeFee(pos.owner, fee);
        _tokenomics.recordLpDelta(-int256(adjusted));

        s.pnlUsdc = int256(profit);
        s.feeUsdc = fee;
        s.payoutUsdc = pos.marginUsdc + paidNow;
        s.queuedUsdc = queued;
    }

    /// @dev Losing close: margin minus loss returned, loss to the LP (fee carved while the queue
    ///      is empty), CONFETTI minted on the LP's net gain.
    function _settleLoss(Position memory pos, uint256 loss, Settlement memory s) private {
        (uint256 fee, uint256 lpGain) = ImpactLib.splitLoss(loss, _lossFeeBps(pos.feeBps));
        _recordLpFlow(-int256(lpGain));
        _available[pos.owner] += pos.marginUsdc - loss;
        _lpUsdc += loss;
        _takeFee(pos.owner, fee);

        uint256 minted = _tokenomics.recordLoss(lpGain);
        _tokenomics.recordLpDelta(int256(lpGain));
        _mintConfetti(pos.owner, minted);

        s.pnlUsdc = -int256(loss);
        s.feeUsdc = fee;
        s.payoutUsdc = pos.marginUsdc - loss;
        s.confettiMinted = minted;
    }

    /// @dev Route a carved fee: the referrer's share (Referrals tallies it) leaves LP cash for
    ///      the referrer's available balance at once, or joins the FIFO queue when the queue is
    ///      active or the cash is short; the rest is a pool claim on LP cash. Losses and
    ///      liquidations only carve a fee while the queue is empty and have just added at least
    ///      the fee to LP cash, so there the share is always paid on the spot.
    function _takeFee(address trader, uint256 fee) private {
        if (fee == 0) return;
        (address referrer, uint256 share) = _referrals.onFee(trader, fee);
        _feePoolUsdc += fee - share;
        if (share == 0) return;
        uint256 paidNow;
        if (_queueIsEmpty()) {
            uint256 cash = _lpUsdc;
            paidNow = share < cash ? share : cash;
            _lpUsdc = cash - paidNow;
        }
        _available[referrer] += paidNow;
        if (share > paidNow) _enqueue(referrer, share - paidNow);
    }

    /// @dev Loss and liquidation fee rate of a position: its stamped rate while the queue is
    ///      empty, 0 while it is active so losses refill the queue in full.
    function _lossFeeBps(uint16 positionFeeBps) private view returns (uint256) {
        return _queueIsEmpty() ? positionFeeBps : 0;
    }

    /// @dev Mint `minted` CONFETTI to the trader plus the fixed team share to the fee recipient.
    function _mintConfetti(address trader, uint256 minted) private {
        if (minted == 0) return;
        _confetti.mint(trader, minted);
        uint256 team = minted * TEAM_MINT_BPS / BPS;
        if (team != 0) {
            address to = _feeRecipient;
            _confetti.mint(to, team);
            emit TeamMinted(to, team);
        }
    }

    function _enqueue(address recipient, uint256 amountUsdc) private {
        uint256 index = _queue.length;
        _queue.push(QueueEntry({recipient: recipient, owedUsdc: amountUsdc}));
        _queuedTotal += amountUsdc;
        emit QueueAppended(index, recipient, amountUsdc);
    }

    /// @dev Approve and hand `amountUsdc` to Staking, which pulls it with transferFrom.
    function _notifyStakers(uint256 amountUsdc) private {
        _usdc.forceApprove(address(_staking), amountUsdc);
        _staking.notifyReward(amountUsdc);
    }

    /// @dev LP breaker bookkeeping, called before the settlement touches `_lpUsdc` so a window
    ///      that opens here samples the LP cash as it was before this settlement. `outflowUsdc`
    ///      is positive for what the LP owes on a win, negative for what it keeps on a loss or
    ///      liquidation. Trips once the window's net outflow exceeds
    ///      max(`windowStartLp * breakerBps / 10000`, `breakerFloorUsdc`); without the floor a
    ///      zero LP at the window start would trip on any net-positive hour.
    function _recordLpFlow(int256 outflowUsdc) private {
        if (block.timestamp - _windowStart >= BREAKER_WINDOW) _startWindow();
        int256 net = _windowNetOutflow + outflowUsdc;
        _windowNetOutflow = net;
        if (_breakerTripped || net <= 0) return;
        uint256 startLp = _windowStartLp;
        uint256 threshold = startLp * _breakerBps / BPS;
        if (threshold < _breakerFloorUsdc) threshold = _breakerFloorUsdc;
        if (uint256(net) > threshold) {
            _breakerTripped = true;
            emit LpBreakerTripped(uint256(net), threshold, startLp);
        }
    }

    function _startWindow() private {
        _windowStart = uint64(block.timestamp);
        _windowStartLp = _lpUsdc;
        _windowNetOutflow = 0;
    }

    /// @dev Unbook a position together with any close request on it.
    function _removePosition(uint256 positionId, Position memory pos) private {
        uint256 notional = uint256(pos.marginUsdc) * pos.leverage;
        if (pos.isLong) _longOiUsd[pos.instrumentId] -= notional;
        else _shortOiUsd[pos.instrumentId] -= notional;
        _marginInUse[pos.owner] -= pos.marginUsdc;
        _positionIds[pos.owner].remove(positionId);
        delete _positions[positionId];
        delete _closeRequests[positionId];
    }

    // ------------------------------------------------------- internal: lookups

    function _instrument(uint32 instrumentId) private view returns (Instrument storage) {
        if (instrumentId >= _instruments.length) revert UnknownInstrument(instrumentId);
        return _instruments[instrumentId];
    }

    function _position(uint256 positionId) private view returns (Position memory pos) {
        pos = _positions[positionId];
        if (pos.owner == address(0)) revert UnknownPosition(positionId);
    }

    /// @dev The settlement price: the frozen price of a retired market, else the HyperCore
    ///      oracle price. The oracle reverts `FeedUnavailable` / `ZeroPrice` for a dead feed.
    function _execPrice(uint32 instrumentId, Instrument storage inst) private view returns (uint256) {
        if (inst.retired) return inst.frozenPx18;
        return _oracle.oraclePrice(instrumentId);
    }

    function _headroom(uint32 instrumentId, bool isLong, Instrument storage inst) private view returns (uint256) {
        uint256 cap = isLong ? inst.longOiCapUsd : inst.shortOiCapUsd;
        uint256 used = isLong ? _longOiUsd[instrumentId] : _shortOiUsd[instrumentId];
        return cap > used ? cap - used : 0;
    }

    function _curve(Instrument storage inst) private view returns (ImpactLib.Curve memory) {
        return ImpactLib.Curve({
            baseRateBps: inst.baseRateBps,
            rateMultiplier: inst.rateMultiplier,
            referenceNotionalUsd: inst.referenceNotionalUsd,
            positionMultiplierE6: inst.positionMultiplierE6
        });
    }

    function _queueIsEmpty() private view returns (bool) {
        return _queueHead == _queue.length;
    }

    // -------------------------------------------------------- internal: admin

    /// @dev Pausing is guardian-or-owner; resuming is owner-only (DESIGN section 8).
    function _checkPauseAuthority(bool paused) private view {
        bool allowed = msg.sender == owner() || (paused && msg.sender == _pauseGuardian);
        if (!allowed) revert Unauthorized();
    }

    function _checkLeverage(uint32 maxLeverage) private pure {
        if (maxLeverage == 0 || maxLeverage > MAX_LEVERAGE) revert ParamOutOfBounds(Param.MaxLeverage, maxLeverage);
    }

    /// @dev OI cap ceiling per tier; the keeper (a hot key) cannot lift a market past it.
    function _maxOiCapForTier(uint8 tier) private pure returns (uint128) {
        if (tier == 0) return TIER_A_MAX_OI_CAP_USD;
        if (tier == 1) return TIER_B_MAX_OI_CAP_USD;
        return TIER_C_MAX_OI_CAP_USD;
    }

    function _checkOiCaps(uint8 tier, uint128 longOiCapUsd, uint128 shortOiCapUsd) private pure {
        uint128 ceiling = _maxOiCapForTier(tier);
        if (longOiCapUsd > ceiling) revert ParamOutOfBounds(Param.LongOiCapUsd, longOiCapUsd);
        if (shortOiCapUsd > ceiling) revert ParamOutOfBounds(Param.ShortOiCapUsd, shortOiCapUsd);
    }

    /// @dev Per-position caps (DESIGN section 8): notional at most $100K, payout 10x..200x.
    function _checkPositionCaps(uint128 maxNotionalUsd, uint16 payoutCapX) private pure {
        if (maxNotionalUsd == 0 || maxNotionalUsd > MAX_POSITION_NOTIONAL_USD) {
            revert ParamOutOfBounds(Param.MaxNotionalUsd, maxNotionalUsd);
        }
        if (payoutCapX < MIN_PAYOUT_CAP_X || payoutCapX > MAX_PAYOUT_CAP_X) {
            revert ParamOutOfBounds(Param.PayoutCapX, payoutCapX);
        }
    }

    /// @dev Bounds from DESIGN section 8 as stated in IExchange.setInstrumentParams. Besides
    ///      the per-parameter ranges, the curve as a whole must keep between 50% and 95% of a
    ///      raw gain at a 1% move, so no in-range combination can zero every winning close.
    function _checkParams(
        uint16 deadbandBps,
        uint16 clampBps,
        uint16 baseRateBps,
        uint64 rateMultiplier,
        uint128 referenceNotionalUsd,
        uint128 positionMultiplierE6
    ) private pure {
        if (deadbandBps < MIN_DEADBAND_BPS || deadbandBps > MAX_DEADBAND_BPS) {
            revert ParamOutOfBounds(Param.DeadbandBps, deadbandBps);
        }
        if (clampBps < MIN_CLAMP_BPS || clampBps > MAX_CLAMP_BPS) revert ParamOutOfBounds(Param.ClampBps, clampBps);
        if (baseRateBps < MIN_BASE_RATE_BPS || baseRateBps > MAX_BASE_RATE_BPS) {
            revert ParamOutOfBounds(Param.BaseRateBps, baseRateBps);
        }
        if (rateMultiplier < MIN_RATE_MULTIPLIER || rateMultiplier > MAX_RATE_MULTIPLIER) {
            revert ParamOutOfBounds(Param.RateMultiplier, rateMultiplier);
        }
        if (referenceNotionalUsd < MIN_REFERENCE_NOTIONAL_USD || referenceNotionalUsd > MAX_REFERENCE_NOTIONAL_USD) {
            revert ParamOutOfBounds(Param.ReferenceNotionalUsd, referenceNotionalUsd);
        }
        if (positionMultiplierE6 < MIN_POSITION_MULTIPLIER_E6) {
            revert ParamOutOfBounds(Param.PositionMultiplierE6, positionMultiplierE6);
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
            revert ParamOutOfBounds(Param.ImpactScaleOnePct, scale);
        }
    }

    function _deposit(address beneficiary, uint256 amountUsdc) private {
        if (amountUsdc == 0) revert ZeroAmount();
        _usdc.safeTransferFrom(msg.sender, address(this), amountUsdc);
        _available[beneficiary] += amountUsdc;
        emit Deposited(beneficiary, msg.sender, amountUsdc);
    }
}
