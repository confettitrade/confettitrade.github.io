// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IExchange
/// @notice External surface of the Confetti exchange: synthetic perps (up to 1000x) on meme
///         coins, traded against a self-funded LP (DESIGN sections 5 to 8).
/// @dev Units used throughout:
///        - USDC amounts are 6-decimal integers ("Usdc" / "Usd" suffix, $1 = 1e6).
///        - Prices are 1e18 fixed point ("Px18" suffix).
///        - bps = 1/10000.
///        - CONFETTI amounts are 18-decimal.
///      Pricing (oracle only): every settlement price is the HyperCore ORACLE price
///      (`IPriceOracle.oraclePrice`, a validator median of external venues that a push on
///      Hyperliquid's own book does not move). The book mid is display only and never settles
///      anything. `execPrice` returns the price the exchange would use right now; a dead or zero
///      oracle feed reverts (`FeedUnavailable` / `ZeroPrice`) and makes the market untradeable
///      until it recovers or the market is retired.
///      Delayed fills: there is no instant open or close. A trader files a request
///      (`requestOpen` / `requestClose`), which records the oracle price at that moment (p0)
///      and the timestamp; the fill happens later, in one of three windows measured from the
///      request time, with p1 the oracle price at execution:
///        - before `minDelay` (default 5 s): nobody can execute (the oracle updates every ~3 s,
///          so the request-time print is never the fill);
///        - [minDelay, minDelay + grace) (grace default 3 s): only a fill keeper (`isKeeper`)
///          may execute, at p1. The keeper bot executes in the first eligible block, so the
///          trader never chooses the print. Fill keepers are trusted to do exactly that: which
///          of the grace-window prints the fill lands on (or declining, so the request falls
///          to the worse-of window) is the whole of their discretion, worth about one oracle
///          step per leg; shrink `grace` with `setDelays` before adding a third-party keeper;
///        - [minDelay + grace, expiry] (expiry default 60 s): anyone may execute, at whichever
///          of p0 and p1 is worse for the trader (long entry / short exit: the higher; short
///          entry / long exit: the lower). Waiting can never help the trader, so a trader
///          executing their own request gains nothing;
///        - after `expiry`: anyone may cancel. The requester can never cancel early (no free
///          option). Margin of a pending open request sits in `pendingOf`, neither available nor
///          in use, until the request executes or is cancelled.
///      An open request re-checks every open-time rule at execution (retired, pauses, breaker,
///      leverage, position cap, OI headroom), the jump guard (|p1 - p0| over `maxJumpBps` of
///      p0, a broken-print guard) and the born-busted guard (a fallback fill at p0 whose bust
///      price the live p1 has already crossed, `EntryBusted`); a failure cancels and refunds
///      the request, with the rule's error selector in `OpenRequestCancelled.reason`. The
///      settlement terms (deadband,
///      payout cap, fee rate) are stamped at execution. Open requests have ids; a close request
///      is keyed by its position, so a position has at most one pending close. A close is never
///      jump-guarded (it can only reduce the house's exposure; the payout cap bounds what it
///      pays) and never blocks a liquidation; a liquidation voids the pending close
///      (`CloseRequestCancelled`), after which `executeClose` and `cancelClose` revert
///      `UnknownRequest` and change nothing. Liquidation is instant and permissionless once the
///      oracle price is at or past bust.
///      Fees: one rate `feeBps` (starts at the 500 bps cap; the owner may set 0..500) is
///      stamped on each position at execution and applies to the adjusted gain of a win, to the
///      loss of a losing close and to the margin of a liquidation; loss and liquidation fees
///      are only carved while the queue is empty. A referred trader's fee first pays the
///      referrer's share (`IReferrals.referralShareBps`, 15% at launch) and the rest is pooled.
///      `pushFees` sends `stakerFeeShareBps` of the pool (owner-set, 0 at launch) to Staking
///      and the rest to the fee recipient. Every CONFETTI mint to a trader mints 10% on top to
///      the fee recipient (`TeamMinted`).
///      Fixed protocol constants (not configurable, documented here so every implementer
///      agrees): minimum margin 10e6; liquidation bounty 50 bps of margin; bust move
///      min(0.95 / leverage, 1 / leverage - 5 bps), i.e. 5 bps at 1000x, 35 at 250x and 95% of
///      1 / leverage at 100x and below (the gap covers the ~3 s oracle print cadence); max
///      leverage of any market 1000.
///      Tier codes: 0 = A, 1 = B, 2 = C. The tier only sets the OI cap ceiling; leverage is
///      per market (`Instrument.maxLeverage`, `setMaxLeverage`).
///      Custody: all USDC sits in the Exchange. Payouts (returned margin, profit, queue
///      payments, bounties, referral shares) credit the recipient's available balance;
///      `withdraw` moves USDC out.
interface IExchange {
    // ---------------------------------------------------------------- structs

    /// @notice Per-market configuration and state.
    /// @param hlAssetIndex Hyperliquid perp asset index read by the oracle.
    /// @param szDecimals Asset size decimals (price scaling, see IPriceOracle).
    /// @param tier 0 = A, 1 = B, 2 = C; sets the OI cap ceiling only.
    /// @param maxLeverage Highest leverage an open request may ask for, 1..1000 (from the
    ///        `addInstrument` spec, `setMaxLeverage` later; open positions keep theirs).
    /// @param deadbandBps Exit price is moved this many bps against the trader on wins.
    /// @param clampBps Half-width, in bps, of the band `IPriceOracle.price` clamps the book
    ///        mid to around the oracle price. Mirrored into the oracle for that display-only
    ///        view; it plays no part in any fill, liquidation or retire price.
    /// @param baseRateBps Impact curve base rate (10% = 1000), bounded to [500, 2000].
    /// @param rateMultiplier Impact curve `rateMultiplier` (dimensionless, default 15_000).
    /// @param referenceNotionalUsd Impact curve `referenceNotional` in USDC 6-dec ($20,000 = 20_000e6).
    /// @param positionMultiplierE6 Impact curve `positionMultiplier` scaled by 1e6.
    /// @param longOiCapUsd Max open long notional, USDC 6-dec. 0 = closed for new longs.
    /// @param shortOiCapUsd Max open short notional, USDC 6-dec. 0 = closed for new shorts.
    /// @param maxNotionalUsd Max notional of one position, USDC 6-dec (DESIGN 3b/4; at most $100K).
    /// @param payoutCapX Max profit on one position as a multiple of its margin (DESIGN 3b;
    ///        10..200, default 50). The excess is forfeited to the LP.
    /// @param opensPaused Guardian pause: no new positions, closes still work.
    /// @param retired Irreversible: price frozen at `frozenPx18`, closes only.
    /// @param frozenPx18 Settlement price once retired, else 0.
    struct Instrument {
        uint32 hlAssetIndex;
        uint8 szDecimals;
        uint8 tier;
        uint32 maxLeverage;
        uint16 deadbandBps;
        uint16 clampBps;
        uint16 baseRateBps;
        uint64 rateMultiplier;
        uint128 referenceNotionalUsd;
        uint128 positionMultiplierE6;
        uint128 longOiCapUsd;
        uint128 shortOiCapUsd;
        uint128 maxNotionalUsd;
        uint16 payoutCapX;
        bool opensPaused;
        bool retired;
        uint256 frozenPx18;
    }

    /// @notice One open position. Deleted on close or liquidation.
    /// @dev The last three fields are the settlement terms stamped when the open executed. A
    ///      close, a preview or a liquidation settles on them, never on the market's or the
    ///      exchange's live values, so an owner change after the open cannot clip what the
    ///      position pays. The impact curve stays live (it is bounded, and the curve floor holds).
    /// @param owner Account that opened it and may close it.
    /// @param instrumentId Market it trades.
    /// @param isLong Direction.
    /// @param marginUsdc Collateral locked at open, USDC 6-dec.
    /// @param leverage Fixed at open. Notional = marginUsdc * leverage.
    /// @param entryPx18 Fill price of the open request (see the contract notes).
    /// @param openedAt Block timestamp the open executed.
    /// @param deadbandBps The market's `deadbandBps` at open; a win settles with this deadband.
    /// @param payoutCapX The market's `payoutCapX` at open; a win is capped at this many times
    ///        the margin.
    /// @param feeBps The exchange's `feeBps` at open; the win, loss and liquidation fee rate of
    ///        this position (loss and liquidation fees are still 0 while the queue is active).
    struct Position {
        address owner;
        uint32 instrumentId;
        bool isLong;
        uint128 marginUsdc;
        uint32 leverage;
        uint256 entryPx18;
        uint64 openedAt;
        uint16 deadbandBps;
        uint16 payoutCapX;
        uint16 feeBps;
    }

    /// @notice A pending open. Deleted when executed or cancelled; zero `trader` = none.
    /// @param trader Requester; receives the position or the refund.
    /// @param instrumentId Market.
    /// @param isLong Direction.
    /// @param marginUsdc Margin moved out of the trader's available balance (`pendingOf`).
    /// @param leverage Requested leverage.
    /// @param requestedAt Block timestamp of the request; the windows count from it.
    /// @param px0 Oracle price at the request.
    /// @param referrer Referrer to lock in if this is the trader's first executed open (zero =
    ///        none; a self-referral is stored as zero).
    struct OpenRequest {
        address trader;
        uint32 instrumentId;
        bool isLong;
        uint128 marginUsdc;
        uint32 leverage;
        uint64 requestedAt;
        uint256 px0;
        address referrer;
    }

    /// @notice A pending close, keyed by its position. Deleted when executed or cancelled, and
    ///         with the position when that is liquidated; zero `requestedAt` = none.
    /// @param requestedAt Block timestamp of the request.
    /// @param px0 Oracle price at the request.
    struct CloseRequest {
        uint64 requestedAt;
        uint256 px0;
    }

    /// @notice Which owner parameter a `ParamOutOfBounds` revert refers to.
    enum Param {
        DeadbandBps,
        ClampBps,
        BaseRateBps,
        RateMultiplier,
        ReferenceNotionalUsd,
        PositionMultiplierE6,
        ImpactScaleOnePct,
        LongOiCapUsd,
        ShortOiCapUsd,
        MaxNotionalUsd,
        PayoutCapX,
        MaxLeverage,
        BreakerBps,
        BreakerFloorUsdc,
        FeeBps,
        StakerFeeShareBps,
        MinDelay,
        Grace,
        Expiry,
        MaxJumpBps
    }

    // ----------------------------------------------------------------- events

    /// @param payer Account the USDC was pulled from (differs from `user` on `depositFor`).
    event Deposited(address indexed user, address indexed payer, uint256 amountUsdc);
    event Withdrawn(address indexed user, uint256 amountUsdc);

    event OpenRequested(
        uint256 indexed requestId,
        address indexed trader,
        uint32 indexed instrumentId,
        bool isLong,
        uint128 marginUsdc,
        uint32 leverage,
        uint256 px0,
        address referrer
    );

    /// @notice An open request was refunded: cancelled after expiry, or rejected at execution.
    /// @param reason Selector of the rule that failed (`RequestExpired`, a pause or cap error,
    ///        `PriceJumped`, `EntryBusted`).
    event OpenRequestCancelled(uint256 indexed requestId, address indexed trader, bytes4 reason);

    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        uint32 indexed instrumentId,
        bool isLong,
        uint128 marginUsdc,
        uint32 leverage,
        uint256 entryPx18,
        uint256 requestId
    );

    event CloseRequested(uint256 indexed positionId, address indexed trader, uint256 px0);

    /// @notice A close request ended without a close: cancelled after expiry (`RequestExpired`)
    ///         or voided by a liquidation (`UnknownPosition`).
    event CloseRequestCancelled(uint256 indexed positionId, bytes4 reason);

    /// @param pnlUsdc Signed realised PnL after deadband, impact and fee (negative = loss).
    /// @param feeUsdc Fee carved (referrer share plus pool; win fee, or loss fee from LP gain).
    /// @param payoutUsdc Credited to the owner's available balance now.
    /// @param queuedUsdc Profit the LP could not pay, appended to the FIFO queue.
    /// @param confettiMinted CONFETTI minted to the owner (losses only, else 0); the 10% team
    ///        share minted to the fee recipient on top is reported by `TeamMinted`.
    event PositionClosed(
        uint256 indexed positionId,
        address indexed owner,
        uint256 exitPx18,
        int256 pnlUsdc,
        uint256 feeUsdc,
        uint256 payoutUsdc,
        uint256 queuedUsdc,
        uint256 confettiMinted
    );

    /// @param bountyUsdc 0.5% of margin credited to the liquidator's available balance.
    /// @param feeUsdc `feeBps` of margin carved (referrer share plus pool; 0 while the queue is active).
    event PositionLiquidated(
        uint256 indexed positionId,
        address indexed owner,
        address indexed liquidator,
        uint256 exitPx18,
        uint128 marginUsdc,
        uint256 bountyUsdc,
        uint256 feeUsdc,
        uint256 confettiMinted
    );

    event QueueAppended(uint256 indexed index, address indexed recipient, uint256 amountUsdc);

    /// @param remainingUsdc Still owed on this entry after the payment (0 = entry retired).
    event QueuePaid(uint256 indexed index, address indexed recipient, uint256 paidUsdc, uint256 remainingUsdc);

    event FeesPushed(uint256 toStakersUsdc, uint256 toRecipientUsdc);
    event StakerOverflowSwept(uint256 amountUsdc);

    /// @notice A market was added; the rest of its spec is readable through `instrument`.
    event InstrumentAdded(
        uint32 indexed instrumentId, uint32 hlAssetIndex, uint8 szDecimals, uint8 tier, uint32 maxLeverage
    );
    event InstrumentParamsSet(
        uint32 indexed instrumentId,
        uint16 deadbandBps,
        uint16 clampBps,
        uint16 baseRateBps,
        uint64 rateMultiplier,
        uint128 referenceNotionalUsd,
        uint128 positionMultiplierE6
    );
    event OiCapsSet(uint32 indexed instrumentId, uint128 longOiCapUsd, uint128 shortOiCapUsd);
    event MaxLeverageSet(uint32 indexed instrumentId, uint32 maxLeverage);
    event MarketOpensPausedSet(uint32 indexed instrumentId, bool paused);
    event GlobalOpensPausedSet(bool paused);
    event InstrumentRetired(uint32 indexed instrumentId, uint256 frozenPx18);
    event FeeRecipientSet(address indexed feeRecipient);
    event KeepersSet(address indexed pauseGuardian, address indexed marketKeeper);
    /// @notice A fill keeper was added (`allowed`) or removed.
    event KeeperSet(address indexed keeper, bool allowed);
    event DelaysSet(uint32 minDelay, uint32 grace, uint32 expiry);
    event MaxJumpBpsSet(uint16 maxJumpBps);
    event StakerFeeShareSet(uint16 stakerFeeShareBps);
    event PositionCapsSet(uint32 indexed instrumentId, uint128 maxNotionalUsd, uint16 payoutCapX);

    /// @notice A winning close hit the payout cap (DESIGN 3b).
    /// @param cappedGainUsdc The impact-adjusted gain after capping (= payoutCapX * margin).
    /// @param forfeitedUsdc The part of the adjusted gain above the cap, kept by the LP.
    event PayoutCapped(uint256 indexed positionId, uint256 cappedGainUsdc, uint256 forfeitedUsdc);

    /// @notice The rolling-hour LP loss breaker tripped: opens are paused on every market
    ///         until the guardian or owner calls `clearBreaker`.
    /// @param netOutflowUsdc Net LP outflow (wins minus losses) in the current window.
    /// @param thresholdUsdc `windowStartLpUsdc * breakerBps / 10000`.
    event LpBreakerTripped(uint256 netOutflowUsdc, uint256 thresholdUsdc, uint256 windowStartLpUsdc);
    event BreakerCleared(address indexed by);
    event BreakerBpsSet(uint16 breakerBps);
    event BreakerFloorSet(uint128 floorUsdc);
    /// @notice The live fee rate on wins, losses and liquidations changed (0..500 bps).
    event FeeBpsSet(uint16 feeBps);
    /// @notice The team share of a CONFETTI mint (TEAM_MINT_BPS of the trader's mint) went to `to`.
    event TeamMinted(address indexed to, uint256 amount);

    // ----------------------------------------------------------------- errors

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error UnknownInstrument(uint32 instrumentId);
    /// @notice The market is retired (an open request, or a second retire).
    error MarketRetired();
    error OpensPausedGlobally();
    error OpensPausedForMarket();
    error OpensPausedByBreaker();
    error MarginBelowMinimum();
    /// @notice Leverage is 0 or above the market's `maxLeverage`.
    error LeverageOutOfRange();
    /// @notice margin * leverage is above the market's `maxNotionalUsd`.
    error PositionTooLarge();
    /// @notice margin * leverage does not fit the side's OI headroom.
    error OiCapExceeded();
    error InsufficientBalance(uint256 availableUsdc, uint256 requestedUsdc);
    error UnknownPosition(uint256 positionId);
    error NotPositionOwner(uint256 positionId, address caller);
    error NotLiquidatable(uint256 positionId, uint256 px18, uint256 bustPx18);
    error InvalidTier(uint8 tier);
    error ParamOutOfBounds(Param param, uint256 value);
    error QueueEmpty();
    error QueueNotEmpty();
    error NothingToPush();
    error BreakerNotTripped();
    /// @notice `retireAtPrice` was called while the oracle still answers for the market.
    error FeedAlive(uint32 instrumentId);
    /// @notice No open request with this id, or no close request on this position.
    error UnknownRequest();
    /// @notice Less than `minDelay` has passed since the request.
    error TooEarly();
    /// @notice Inside the keeper window and the caller is not a fill keeper.
    error KeeperWindow();
    /// @notice More than `expiry` has passed: the request can only be cancelled.
    error RequestExpired();
    /// @notice `expiry` has not passed yet: the request cannot be cancelled.
    error RequestNotExpired();
    /// @notice The position already has a pending close request.
    error CloseAlreadyPending();
    /// @notice Cancel reason: the oracle moved more than `maxJumpBps` between request and
    ///         execution (a broken-print guard).
    error PriceJumped();
    /// @notice Cancel reason: the fill (the trader-worse of p0 and p1 in the fallback window)
    ///         sits at or past its own bust price at the live oracle price p1, so the position
    ///         would be liquidated in the same block. Only a fallback fill can trip this; a
    ///         keeper fill at p1 cannot.
    error EntryBusted();

    // ------------------------------------------------------------- collateral

    /// @notice Pull `amountUsdc` from the caller (needs prior approval) into their available balance.
    /// @param amountUsdc USDC 6-dec.
    function deposit(uint256 amountUsdc) external;

    /// @notice Pull `amountUsdc` from the caller and credit `beneficiary`'s available balance.
    /// @dev Used by Staking.claim to deliver dividends into the staker's exchange balance.
    /// @param beneficiary Account credited.
    /// @param amountUsdc USDC 6-dec.
    function depositFor(address beneficiary, uint256 amountUsdc) external;

    /// @notice Send `amountUsdc` of the caller's available balance back to their wallet.
    /// @param amountUsdc USDC 6-dec.
    function withdraw(uint256 amountUsdc) external;

    // ---------------------------------------------------------------- trading

    /// @notice File an open request: the margin moves from the caller's available balance into
    ///         `pendingOf` and the current oracle price is recorded as p0.
    /// @dev Reverts unless: instrument exists, not retired, opens not paused (global, market or
    ///      LP breaker), marginUsdc >= 10e6, 1 <= leverage <= the market's `maxLeverage`,
    ///      margin * leverage is at most the market's `maxNotionalUsd` and fits the side's OI
    ///      headroom, the caller's available balance covers the margin, and the oracle is live.
    ///      Pending requests reserve no OI, so the same rules are re-checked at execution.
    /// @param instrumentId Market.
    /// @param isLong Direction.
    /// @param marginUsdc Collateral, USDC 6-dec.
    /// @param leverage Whole-number leverage.
    /// @param referrer Referrer to lock in if this becomes the caller's first executed open
    ///        (zero = none; the caller's own address counts as zero). Ignored once a referrer
    ///        is locked.
    /// @return requestId Id of the request.
    function requestOpen(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, address referrer)
        external
        returns (uint256 requestId);

    /// @notice Execute an open request in its window (see the contract notes): keeper only
    ///         during the grace window, at p1; anyone afterwards until expiry, at the worse of
    ///         p0 and p1 for the trader (a long at max, a short at min).
    /// @dev Reverts `UnknownRequest`, `TooEarly`, `KeeperWindow` or `RequestExpired` on timing,
    ///      and `FeedUnavailable` / `ZeroPrice` from the oracle (the request stays pending).
    ///      Re-checks the open rules and the jump guard; if any fails the request is cancelled
    ///      and refunded (`OpenRequestCancelled` with the rule's selector as `reason`) and 0 is
    ///      returned. Otherwise the position is created with the live deadband, payout cap and
    ///      fee rate stamped, the trader's referrer is locked if not yet, and `PositionOpened`
    ///      fires.
    /// @param requestId Open request.
    /// @return positionId Id of the new position, or 0 when the request was refunded.
    function executeOpen(uint256 requestId) external returns (uint256 positionId);

    /// @notice Cancel an expired open request and refund its margin. Anyone, only after
    ///         `expiry` has passed (`RequestNotExpired` otherwise).
    /// @param requestId Open request.
    function cancelOpen(uint256 requestId) external;

    /// @notice File a close request for the caller's position: records the oracle price as p0.
    /// @dev Reverts `NotPositionOwner`, `UnknownPosition` or `CloseAlreadyPending`, and the
    ///      oracle's errors when the feed is dead (a retired market needs no feed).
    /// @param positionId Position to close in full; it keys the request.
    function requestClose(uint256 positionId) external;

    /// @notice Execute the close request of `positionId` in its window, with the same
    ///         keeper-first rule as `executeOpen`; the fallback fill is the worse of p0 and p1
    ///         for the trader (a long at min, a short at max). Then the stamped deadband, the
    ///         impact haircut, the stamped payout cap and fee apply (DESIGN section 6).
    /// @dev Margin minus any loss is credited now. Profit is credited now if the LP has the
    ///      cash, otherwise appended to the FIFO queue. Losses mint CONFETTI to the owner, plus
    ///      the 10% team share to the fee recipient. Reverts `UnknownRequest` when no close is
    ///      pending on the position (it was liquidated, closed, or never requested).
    /// @param positionId Position with a pending close.
    /// @return payoutUsdc Credited to the owner's available balance now.
    /// @return queuedUsdc Profit placed in the queue (0 when paid in full).
    function executeClose(uint256 positionId) external returns (uint256 payoutUsdc, uint256 queuedUsdc);

    /// @notice Cancel an expired close request. Anyone, only after `expiry` (`RequestNotExpired`
    ///         otherwise; `UnknownRequest` when none is pending). The position stays open.
    /// @param positionId Position with a pending close.
    function cancelClose(uint256 positionId) external;

    /// @notice Liquidate any position whose oracle price is at or beyond its bust price (a long
    ///         at or under, a short at or over). Instant and permissionless; a pending close
    ///         request does not block it and is voided.
    /// @dev Whole margin is forfeited: 0.5% to the caller, the position's `feeBps` of it carved
    ///      (none while the queue is active; referrer share first, rest to the pool), rest to
    ///      the LP. CONFETTI mints to the owner on the full margin, plus the 10% team share to
    ///      the fee recipient.
    /// @param positionId Position to liquidate.
    /// @return bountyUsdc Credited to the caller's available balance.
    function liquidate(uint256 positionId) external returns (uint256 bountyUsdc);

    /// @notice Pay queued profits from LP cash, oldest first. Permissionless.
    /// @dev Pays the head entry as far as the LP can (partial payments allowed), retires it
    ///      when fully paid, then moves on. Stops after `maxEntries` entries or when LP cash is 0.
    /// @param maxEntries Upper bound on entries touched (gas bound).
    /// @return entriesPaid Entries that received any payment.
    /// @return paidUsdc Total credited.
    function harvest(uint256 maxEntries) external returns (uint256 entriesPaid, uint256 paidUsdc);

    /// @notice Distribute the fee pool: `stakerFeeShareBps` to CONFETTI stakers, the rest to the
    ///         fee recipient.
    /// @dev Only while the queue is empty and the LP cash covers the pool; otherwise reverts.
    ///      The staker share (rounded down) goes through `IStaking.notifyReward` (approve, then
    ///      notify); a share that rounds to 0 (or a zero share setting) goes wholly to the
    ///      recipient and skips the notify.
    /// @return toStakersUsdc Amount handed to Staking.
    /// @return toRecipientUsdc Amount credited to the fee recipient's available balance.
    function pushFees() external returns (uint256 toStakersUsdc, uint256 toRecipientUsdc);

    /// @notice Move LP cash above the staker cap to Staking. Tokenomics only.
    /// @dev Called from `ITokenomics.pushStakerFees` after it has debited `trackedLpUsd`.
    ///      Reverts if the queue is not empty or `amountUsdc` exceeds LP cash.
    /// @param amountUsdc USDC 6-dec to hand to Staking via `notifyReward`.
    function sweepLpToStakers(uint256 amountUsdc) external;

    // ------------------------------------------------------------------ views

    /// @notice Available (not in a position or a pending request) USDC balance of `user`.
    function balanceOf(address user) external view returns (uint256 availableUsdc);

    /// @notice Sum of margin locked in `user`'s open positions.
    function marginInUse(address user) external view returns (uint256 usdc);

    /// @notice Sum of margin held by `user`'s pending open requests.
    function pendingOf(address user) external view returns (uint256 usdc);

    /// @notice Position by id. Zero `owner` means it does not exist.
    function positions(uint256 positionId) external view returns (Position memory);

    /// @notice Ids of `user`'s open positions, unordered.
    function positionIdsOf(address user) external view returns (uint256[] memory);

    /// @notice Pending open request by id. Zero `trader` means none.
    function openRequest(uint256 requestId) external view returns (OpenRequest memory);

    /// @notice Pending close request of a position. Zero `requestedAt` means none.
    function closeRequest(uint256 positionId) external view returns (CloseRequest memory);

    /// @notice Price at which the position is liquidatable.
    /// @dev move = min(0.95 / leverage, 1 / leverage - 5 bps); long: entry * (1 - move); short:
    ///      entry * (1 + move). 5 bps at 1000x, 15 at 500x, 35 at 250x, 0.95 / leverage at 100x
    ///      and below.
    function bustPrice(uint256 positionId) external view returns (uint256 px18);

    /// @notice What a close would settle to at the current oracle price (the keeper-window fill
    ///         of a close requested now), on the position's stamped deadband, payout cap and
    ///         fee rate. A fallback fill at a worse p0 settles lower.
    /// @return pnlUsdc Signed PnL after deadband, impact and fee.
    /// @return feeUsdc Fee that would be carved.
    /// @return payoutUsdc Margin +/- PnL (assumes the LP pays in full).
    function previewClose(uint256 positionId)
        external
        view
        returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc);

    /// @notice The price the exchange would settle on right now: the HyperCore oracle price, or
    ///         the frozen price of a retired market.
    /// @dev The side flags are accepted for ABI continuity and ignored: with oracle-only pricing
    ///      every side and direction settles on the same print. Reverts `FeedUnavailable` /
    ///      `ZeroPrice` (from the oracle) when the feed is dead, and `UnknownInstrument`.
    /// @param instrumentId Market.
    /// @param isLong Ignored.
    /// @param isOpen Ignored.
    /// @return px18 Oracle price, 1e18 fixed point.
    function execPrice(uint32 instrumentId, bool isLong, bool isOpen) external view returns (uint256 px18);

    /// @notice Id the next open request will use (ids 1..this-1 have been issued; a pending one
    ///         has a non-zero `openRequest(id).trader`).
    function nextRequestId() external view returns (uint256);

    /// @notice Id the next executed open will use.
    function nextPositionId() external view returns (uint256);

    /// @notice Instrument by id. Reverts `UnknownInstrument` for unknown ids.
    function instrument(uint32 instrumentId) external view returns (Instrument memory);

    /// @notice Number of instruments; ids are 0..count-1.
    function instrumentCount() external view returns (uint32);

    /// @notice Open notional per side, USDC 6-dec.
    function openInterest(uint32 instrumentId) external view returns (uint256 longUsd, uint256 shortUsd);

    /// @notice USDC the LP can pay from right now.
    function lpBalance() external view returns (uint256 usdc);

    /// @notice Undistributed fees.
    function feePool() external view returns (uint256 usdc);

    /// @notice Total entries ever appended to the queue (head..length-1 are live).
    function queueLength() external view returns (uint256);

    /// @notice Index of the oldest unpaid entry; equals `queueLength` when the queue is empty.
    function queueHead() external view returns (uint256);

    /// @notice One queue entry.
    function queueEntry(uint256 index) external view returns (address recipient, uint256 owedUsdc);

    /// @notice Sum still owed across live queue entries.
    function queuedTotal() external view returns (uint256 usdc);

    /// @notice True when the guardian has paused opens for every market.
    function globalOpensPaused() external view returns (bool);

    /// @notice LP breaker share: opens pause when net LP outflow in the current one-hour window
    ///         exceeds this many bps of the LP cash at the window start (DESIGN 3b, 2%..50%).
    function breakerBps() external view returns (uint16);

    /// @notice True while the LP breaker is tripped (opens blocked on every market).
    function breakerTripped() external view returns (bool);

    /// @notice Minimum net hourly LP outflow that can trip the breaker, USDC 6-dec. The
    ///         threshold is max(windowStartLp * breakerBps / 10000, this).
    function breakerFloorUsdc() external view returns (uint128);

    /// @notice Fee rate stamped on positions opened from now on, in bps (at most 500). An open
    ///         position keeps the rate it was opened at (`Position.feeBps`).
    function feeBps() external view returns (uint16);

    /// @notice Share of each fee push that goes to stakers, in bps (0 at launch).
    function stakerFeeShareBps() external view returns (uint16);

    /// @notice Seconds after a request before anyone may execute it (2..30, default 5).
    function minDelay() external view returns (uint32);

    /// @notice Length of the keeper-only window that starts at `minDelay` (1..10, default 3).
    function grace() external view returns (uint32);

    /// @notice Seconds after a request until it can only be cancelled (20..300, default 60).
    function expiry() external view returns (uint32);

    /// @notice Largest oracle move between request and execution an open request survives, in
    ///         bps of p0 (default 1000 = 10%); a larger move cancels and refunds it.
    function maxJumpBps() external view returns (uint16);

    /// @notice True when `account` may execute requests in the keeper window.
    function isKeeper(address account) external view returns (bool);

    /// @notice The current breaker window.
    /// @return windowStart Timestamp the window opened (0 before the first settlement).
    /// @return windowStartLpUsdc LP cash when the window opened.
    /// @return netOutflowUsdc Signed net LP outflow since then: wins (adjusted gain, paid or
    ///         queued) minus the LP's net gain on losses and liquidations.
    function breakerWindow()
        external
        view
        returns (uint64 windowStart, uint256 windowStartLpUsdc, int256 netOutflowUsdc);

    /// @notice USDC token (6 decimals).
    function usdc() external view returns (address);

    /// @notice Price oracle (IPriceOracle).
    function oracle() external view returns (address);

    /// @notice CONFETTI token (IConfetti).
    function confetti() external view returns (address);

    /// @notice Tokenomics (ITokenomics).
    function tokenomics() external view returns (address);

    /// @notice Staking (IStaking).
    function staking() external view returns (address);

    /// @notice Referral registry and tally (IReferrals), created and owned by this contract.
    function referrals() external view returns (address);

    /// @notice Owner (a Safe behind a 48h timelock in production).
    function owner() external view returns (address);

    /// @notice Address that may pause opens and retire markets.
    function pauseGuardian() external view returns (address);

    /// @notice Address that may move OI caps.
    function marketKeeper() external view returns (address);

    /// @notice Receives the non-staker share of pushed fees and the 10% team share of every
    ///         CONFETTI mint.
    function feeRecipient() external view returns (address);

    // ------------------------------------------------------------------ admin

    /// @notice Add a market. Owner only. Ids are assigned sequentially and never reused.
    /// @dev Honoured fields: hlAssetIndex, szDecimals, tier, maxLeverage, deadbandBps, clampBps,
    ///      baseRateBps, rateMultiplier, referenceNotionalUsd, positionMultiplierE6,
    ///      longOiCapUsd, shortOiCapUsd, maxNotionalUsd, payoutCapX; opensPaused, retired and
    ///      frozenPx18 are forced to their zero values. Mirrors the mapping into the oracle.
    ///      Same bounds as `setInstrumentParams`, `setMaxLeverage`, `setOiCaps` and
    ///      `setPositionCaps`.
    /// @param spec Instrument fields.
    /// @return instrumentId Id assigned.
    function addInstrument(Instrument calldata spec) external returns (uint32 instrumentId);

    /// @notice Tune an existing market's curve within bounds. Owner only. The new deadband
    ///         applies to positions opened from now on (open ones keep theirs); the curve
    ///         applies to every settlement from now on; the clamp only shapes the oracle's
    ///         display price.
    /// @dev Bounds (DESIGN section 8): deadbandBps 1..50 (the 0.5 bps floor rounds up to 1
    ///      whole bps), clampBps 5..100, baseRateBps 500..2000, rateMultiplier
    ///      1_000..1_000_000, referenceNotionalUsd 1_000e6..1_000_000e6, positionMultiplierE6
    ///      >= 1e12, and the resulting curve must keep between 50% and 95% of a raw gain at a
    ///      1% move (`ParamOutOfBounds(ImpactScaleOnePct, scale)` otherwise), so no setting
    ///      can silently zero every win. A clamp change is mirrored into the oracle. Reverts
    ///      `ParamOutOfBounds(param, value)` otherwise.
    function setInstrumentParams(
        uint32 instrumentId,
        uint16 deadbandBps,
        uint16 clampBps,
        uint16 baseRateBps,
        uint64 rateMultiplier,
        uint128 referenceNotionalUsd,
        uint128 positionMultiplierE6
    ) external;

    /// @notice Set a market's max leverage, 1..1000. Owner only. Applies to open requests
    ///         executed from now on (a pending request over the new cap is refunded at
    ///         execution); open positions keep theirs.
    function setMaxLeverage(uint32 instrumentId, uint32 maxLeverage) external;

    /// @notice Set per-side OI caps. Market keeper or owner.
    /// @dev Each cap is bounded by the tier's ceiling ($2M tier A, $500K tier B, $100K tier C)
    ///      so a compromised keeper key cannot lift the size limit of a market.
    /// @param instrumentId Market.
    /// @param longOiCapUsd Max long notional, USDC 6-dec.
    /// @param shortOiCapUsd Max short notional, USDC 6-dec.
    function setOiCaps(uint32 instrumentId, uint128 longOiCapUsd, uint128 shortOiCapUsd) external;

    /// @notice Set a market's per-position caps. Owner only. Both apply to positions opened
    ///         from now on; an open position keeps the payout cap it was opened with.
    /// @param instrumentId Market.
    /// @param maxNotionalUsd Max notional of one position, USDC 6-dec, in (0, 100_000e6].
    /// @param payoutCapX Max profit as a multiple of margin, 10..200.
    function setPositionCaps(uint32 instrumentId, uint128 maxNotionalUsd, uint16 payoutCapX) external;

    /// @notice Set the LP breaker share. Owner only. Bounds 200..5000 bps.
    function setBreakerBps(uint16 newBreakerBps) external;

    /// @notice Set the breaker floor. Owner only. Bounds 0..100,000 USDC (0 = share only).
    function setBreakerFloor(uint128 newFloorUsdc) external;

    /// @notice Set the fee rate for positions opened from now on. Owner only. Bounds 0..500
    ///         bps (never above 5%). Open positions keep the rate they were opened at.
    function setFeeBps(uint16 newFeeBps) external;

    /// @notice Set the stakers' share of each fee push. Owner only. Bounds 0..10000 bps.
    function setStakerFeeShare(uint16 newShareBps) external;

    /// @notice Set the referrer's share of a referred trader's fees. Owner only. Bounds
    ///         0..5000 bps (forwarded to `IReferrals.setShareBps`).
    function setReferralShare(uint16 newShareBps) external;

    /// @notice Set the request windows, in seconds. Owner only. Bounds: minDelay 2..30, grace
    ///         1..10, expiry 20..300, and minDelay + grace < expiry. Pending requests follow
    ///         the new values.
    function setDelays(uint32 newMinDelay, uint32 newGrace, uint32 newExpiry) external;

    /// @notice Add or remove a fill keeper. Owner only.
    function setKeeper(address keeper, bool allowed) external;

    /// @notice Set the jump guard, in bps of p0. Owner only. Bounds 10..10000.
    function setMaxJumpBps(uint16 newMaxJumpBps) external;

    /// @notice Clear a tripped LP breaker and start a fresh window. Guardian or owner.
    function clearBreaker() external;

    /// @notice Pause or resume opens on one market.
    /// @dev `paused = true`: guardian or owner. `paused = false`: owner only.
    function setMarketOpensPaused(uint32 instrumentId, bool paused) external;

    /// @notice Pause or resume opens on every market.
    /// @dev `paused = true`: guardian or owner. `paused = false`: owner only.
    function setGlobalOpensPaused(bool paused) external;

    /// @notice Retire a market: freeze its price at the current oracle price, allow closes and
    ///         liquidations only. Guardian or owner. Irreversible. Needs a live feed.
    /// @param instrumentId Market.
    function retire(uint32 instrumentId) external;

    /// @notice Retire a market whose feed is dead for good (e.g. Hyperliquid delisted the
    ///         perp) at a stated price, so open margins are not locked forever. Owner only
    ///         (a Safe behind a 48h timelock in production). Irreversible.
    /// @dev Reverts `FeedAlive` while the oracle still answers for the market, so it can never
    ///      override a live price; reverts `ZeroAmount` for a zero price.
    /// @param instrumentId Market.
    /// @param px18 Settlement price to freeze, 1e18 fixed point.
    function retireAtPrice(uint32 instrumentId, uint256 px18) external;

    /// @notice Set the dev fee recipient. Owner only. Later fee pushes and team mints go to it.
    /// @param newFeeRecipient Non-zero address.
    function setFeeRecipient(address newFeeRecipient) external;

    /// @notice Set the pause guardian and market keeper. Owner only.
    /// @param newPauseGuardian May be the zero address to disable the role.
    /// @param newMarketKeeper May be the zero address to disable the role.
    function setKeepers(address newPauseGuardian, address newMarketKeeper) external;
}
