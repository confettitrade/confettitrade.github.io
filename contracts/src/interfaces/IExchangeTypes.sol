// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IExchangeTypes
/// @notice The structs, events and errors of the Confetti exchange, shared by the combined ABI
///         (`IExchange`) and by both halves of the implementation (`ExchangeBase`).
interface IExchangeTypes {
    // ---------------------------------------------------------------- structs

    /// @notice Per-market configuration and state.
    /// @param hlAssetIndex Hyperliquid perp asset index read by the oracle.
    /// @param szDecimals Asset size decimals (price scaling, see IPriceOracle).
    /// @param tier 0 = A, 1 = B, 2 = C; sets the OI cap ceiling only.
    /// @param maxLeverage Highest leverage an open request may ask for, 1..1000.
    /// @param deadbandBps Exit price is moved this many bps against the trader on wins.
    /// @param clampBps Half-width, in bps, of the band `IPriceOracle.price` clamps the book
    ///        mid to around the oracle price. Display only.
    /// @param baseRateBps Impact curve base rate (10% = 1000), bounded to [500, 2000].
    /// @param rateMultiplier Impact curve `rateMultiplier` (dimensionless, default 15_000).
    /// @param referenceNotionalUsd Impact curve `referenceNotional` in USDC 6-dec.
    /// @param positionMultiplierE6 Impact curve `positionMultiplier` scaled by 1e6.
    /// @param longOiCapUsd Static ceiling on open long notional, USDC 6-dec. 0 = closed.
    /// @param shortOiCapUsd Static ceiling on open short notional, USDC 6-dec. 0 = closed.
    /// @param maxNotionalUsd Static ceiling on one position's notional, USDC 6-dec (at most $1M).
    /// @param payoutCapX Max profit on one position as a multiple of its margin, 10..50.
    /// @param posX10 House-sized position cap: notional at most free cash * posX10 / 10.
    /// @param sideX10 House-sized side cap: side OI at most free cash * sideX10 / 10.
    /// @param stressBps The market's stress move, bps; sets its term of the book exposure.
    /// @param entryDeadbandBps The entry spread: a fill is moved this many bps against the
    ///        trader when the open executes (0..50). The bust price is measured from the raw
    ///        print, so the spread never moves the liquidation point.
    /// @param borrowRateX10 Borrow rate stamped on new positions, in tenths of a bps of
    ///        notional per hour (0..50), charged on the time held beyond `borrowFreeHours`.
    /// @param opensPaused Guardian pause: no new positions, closes still work.
    /// @param retired Irreversible: price frozen at `lastPx18`, closes only.
    /// @param lastPx18 The last price a fill or liquidation settled on; once retired, the
    ///        frozen settlement price.
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
        uint16 posX10;
        uint16 sideX10;
        uint16 stressBps;
        uint16 entryDeadbandBps;
        uint16 borrowRateX10;
        bool opensPaused;
        bool retired;
        uint256 lastPx18;
    }

    /// @notice One open position. Deleted on close or liquidation.
    /// @dev The settlement terms are stamped when the open executed; a close, a preview or a
    ///      liquidation settles on them, never on live values. The impact curve stays live.
    /// @param owner Account that opened it and may close it.
    /// @param instrumentId Market it trades.
    /// @param isLong Direction.
    /// @param marginUsdc Collateral locked at open, USDC 6-dec.
    /// @param leverage Fixed at open. Notional = marginUsdc * leverage.
    /// @param maxProfitUsdc The most this position can win, stamped at open:
    ///        min(margin * payoutCapX, free house cash * maxWinBps / 10000).
    /// @param entryPx18 Entry price: the fill moved by the entry spread against the trader.
    /// @param openedAt Block timestamp the open executed.
    /// @param deadbandBps The market's `deadbandBps` at open (the exit deadband on a win).
    /// @param payoutCapX The market's `payoutCapX` at open (display; `maxProfitUsdc` binds).
    /// @param winFeeBps The exchange's `winFeeBps` at open: the fee on a win's adjusted gain.
    /// @param lossFeeBps The exchange's `lossFeeBps` at open: the fee carved from a loss or a
    ///        liquidated margin (0 while the queue is active).
    /// @param entryDeadbandBps The market's entry spread at open; `bustPrice` undoes it.
    /// @param borrowRateX10 The market's borrow rate at open, tenths of a bps per hour.
    /// @param borrowFreeHours The exchange's `borrowFreeHours` at open.
    struct Position {
        address owner;
        uint32 instrumentId;
        bool isLong;
        uint128 marginUsdc;
        uint32 leverage;
        uint96 maxProfitUsdc;
        uint256 entryPx18;
        uint64 openedAt;
        uint16 deadbandBps;
        uint16 payoutCapX;
        uint16 winFeeBps;
        uint16 lossFeeBps;
        uint16 entryDeadbandBps;
        uint16 borrowRateX10;
        uint16 borrowFreeHours;
    }

    /// @notice A pending open. Deleted when executed or cancelled; zero `trader` = none.
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

    /// @notice A pending close, keyed by its position. Zero `requestedAt` = none.
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
        MaxJumpBps,
        PosX10,
        SideX10,
        StressBps,
        RhoBps,
        MaxWinBps,
        MinMarginUsdc,
        EntryDeadbandBps,
        WinFeeBps,
        LossFeeBps,
        BorrowRateX10,
        BorrowFreeHours
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
    /// @param reason Selector of the rule that failed.
    event OpenRequestCancelled(uint256 indexed requestId, address indexed trader, bytes4 reason);

    /// @param entryPx18 The entry after the spread.
    /// @param keeperFill True when a fill keeper executed inside the grace window (at p1).
    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        uint32 indexed instrumentId,
        bool isLong,
        uint128 marginUsdc,
        uint32 leverage,
        uint256 entryPx18,
        uint256 requestId,
        bool keeperFill
    );

    event CloseRequested(uint256 indexed positionId, address indexed trader, uint256 px0);

    /// @notice A close request ended without a close: cancelled after expiry (`RequestExpired`)
    ///         or voided by a liquidation (`UnknownPosition`).
    event CloseRequestCancelled(uint256 indexed positionId, bytes4 reason);

    /// @param pnlUsdc Signed realised PnL after deadband, impact and fee (negative = loss).
    /// @param feeUsdc Fee carved (referrer share plus pool).
    /// @param payoutUsdc Credited to the owner's available balance now (after the borrow).
    /// @param queuedUsdc Profit the house could not pay, appended to the FIFO queue (0 for a
    ///        house wallet: see `HouseWinForfeited`).
    /// @param borrowUsdc Borrow charged for the time held, kept by the house.
    /// @param keeperFill True when a fill keeper executed inside the grace window (at p1).
    event PositionClosed(
        uint256 indexed positionId,
        address indexed owner,
        uint256 exitPx18,
        int256 pnlUsdc,
        uint256 feeUsdc,
        uint256 payoutUsdc,
        uint256 queuedUsdc,
        uint256 borrowUsdc,
        bool keeperFill
    );

    /// @notice A house wallet's impact-adjusted gain exceeded the free house cash (or the queue
    ///         was active); the excess is forfeited before the fee is carved, so a house wallet
    ///         never queues and never pays a fee on money the house did not have.
    event HouseWinForfeited(uint256 indexed positionId, uint256 forfeitedUsdc);
    /// @notice `wallet` was listed (`isHouse`) or unlisted as a house wallet.
    event HouseWalletSet(address indexed wallet, bool isHouse);

    /// @param bountyUsdc 0.5% of margin credited to the liquidator's available balance.
    /// @param feeUsdc `feeBps` of margin carved (0 while the queue is active).
    event PositionLiquidated(
        uint256 indexed positionId,
        address indexed owner,
        address indexed liquidator,
        uint256 exitPx18,
        uint128 marginUsdc,
        uint256 bountyUsdc,
        uint256 feeUsdc
    );

    event QueueAppended(uint256 indexed index, address indexed recipient, uint256 amountUsdc);

    /// @param remainingUsdc Still owed on this entry after the payment (0 = entry retired).
    event QueuePaid(uint256 indexed index, address indexed recipient, uint256 paidUsdc, uint256 remainingUsdc);

    event FeesPushed(uint256 toStakersUsdc, uint256 toRecipientUsdc);

    /// @notice House cash came in from the owner.
    /// @param lpAfterUsdc LP cash after the deposit.
    event HouseDeposited(uint256 amountUsdc, uint256 lpAfterUsdc);
    /// @notice House cash left for the owner.
    /// @param lpAfterUsdc LP cash after the withdrawal.
    event HouseWithdrawn(uint256 amountUsdc, uint256 lpAfterUsdc);

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
    event HouseSizingSet(uint32 indexed instrumentId, uint16 posX10, uint16 sideX10, uint16 stressBps);
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
    event MaxWinBpsSet(uint16 maxWinBps);
    event RhoBpsSet(uint16 rhoBps);
    event MinMarginSet(uint64 minMarginUsdc);
    event MarketFeesSet(uint32 indexed instrumentId, uint16 entryDeadbandBps, uint16 borrowRateX10);
    event BorrowFreeHoursSet(uint16 hours_);

    /// @notice A winning close hit its stamped maximum profit.
    /// @param cappedGainUsdc The impact-adjusted gain after capping (= `maxProfitUsdc`).
    /// @param forfeitedUsdc The part of the adjusted gain above the cap, kept by the house.
    event PayoutCapped(uint256 indexed positionId, uint256 cappedGainUsdc, uint256 forfeitedUsdc);

    /// @notice The hourly house loss breaker tripped: opens are paused on every market until the
    ///         window ends or the owner calls `clearBreaker`.
    event LpBreakerTripped(uint256 netOutflowUsdc, uint256 thresholdUsdc, uint256 windowStartLpUsdc);
    event BreakerCleared(address indexed by);
    event BreakerBpsSet(uint16 breakerBps);
    event BreakerFloorSet(uint128 floorUsdc);
    /// @notice The fee rates stamped on new positions changed: `winFeeBps` on a win's adjusted
    ///         gain (0..1000), `lossFeeBps` carved from a loss or a liquidated margin (0..500).
    event FeeBpsSet(uint16 winFeeBps, uint16 lossFeeBps);

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
    /// @notice margin * leverage is above the market's `maxNotionalUsd` or the house-sized
    ///         position cap.
    error PositionTooLarge();
    /// @notice margin * leverage does not fit the side's static or house-sized headroom.
    error OiCapExceeded();
    /// @notice The open would push the book exposure past free house cash * rhoBps / 10000.
    error HouseExposureExceeded();
    error InsufficientBalance(uint256 availableUsdc, uint256 requestedUsdc);
    error UnknownPosition(uint256 positionId);
    error NotPositionOwner(uint256 positionId, address caller);
    error NotLiquidatable(uint256 positionId, uint256 px18, uint256 bustPx18);
    error InvalidTier(uint8 tier);
    error ParamOutOfBounds(Param param, uint256 value);
    error QueueEmpty();
    error NothingToPush();
    error BreakerNotTripped();
    /// @notice `retireDead` was called while the oracle still answers for the market.
    error FeedAlive(uint32 instrumentId);
    /// @notice `retireDead` found no settlement price recorded for the market.
    error NoLastPrice(uint32 instrumentId);
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
    /// @notice Cancel reason: the fallback fill sits at or past its own bust price at p1.
    error EntryBusted();
    /// @notice The extension was called directly instead of through the core.
    error DirectCall();
    /// @notice The extension was built with different immutables than the core.
    error ExtensionMismatch();
}
