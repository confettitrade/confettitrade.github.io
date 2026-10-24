// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IExchangeTypes} from "./IExchangeTypes.sol";

/// @title IExchange
/// @notice External surface of the Confetti exchange (v4): synthetic perps (up to 1000x) on
///         meme coins, traded against house cash the owner adds and withdraws at will.
/// @dev This is the combined ABI of the trading core (`Exchange`) and its admin extension
///      (`ExchangeExt`). Every function here is called on the core address: the core answers the
///      trading entry points itself and forwards everything else to the extension by
///      delegatecall, so the two share one storage and one address. Neither is upgradeable.
///      Units used throughout:
///        - USDC amounts are 6-decimal integers ("Usdc" / "Usd" suffix, $1 = 1e6).
///        - Prices are 1e18 fixed point ("Px18" suffix).
///        - bps = 1/10000.
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
///        - before `minDelay` (default 5 s): nobody can execute;
///        - [minDelay, minDelay + grace) (grace default 3 s): only a fill keeper (`isKeeper`)
///          may execute, at p1;
///        - [minDelay + grace, expiry] (expiry default 60 s): anyone may execute, at whichever
///          of p0 and p1 is worse for the trader;
///        - after `expiry`: anyone may cancel. The requester can never cancel early. Margin of
///          a pending open request sits in `pendingOf` until the request executes or is
///          cancelled.
///      An open request re-checks every open-time rule at execution (retired, pauses, breaker,
///      leverage, the static caps, the house-sized caps), the jump guard (`PriceJumped`) and
///      the born-busted guard (`EntryBusted`); a failure cancels and refunds the request, with
///      the rule's error selector in `OpenRequestCancelled.reason`. The settlement terms
///      (deadband, payout cap, fee rate, maximum profit) are stamped at execution.
///      House money (v4): `depositHouse` and `withdrawHouse` are owner-only and work at any
///      time, for any amount; the only cash a withdrawal cannot take is what is already owed:
///      queued wins and fees already earned (`houseFreeUsdc`). Nothing is reserved for open
///      positions; a win the house cash cannot cover waits in the FIFO queue and every later
///      win queues behind it until losses or deposits refill the house (`harvest`).
///      House-sized limits (v4): with free = lpUsdc - feePool - queuedTotal, an open must fit
///      notional <= free * posX10 / 10, side OI + notional <= free * sideX10 / 10 and, across
///      every market, book exposure <= free * rhoBps / 10000 where a market's exposure is
///      max(long OI, short OI) * stressBps * (10000 - baseRateBps) / 1e8. The static caps
///      (`maxNotionalUsd`, the OI caps) stay as ceilings. Each position's maximum profit is
///      stamped at fill: min(margin * payoutCapX, free * maxWinBps / 10000).
///      Fees: two rates are stamped on each position at execution: `winFeeBps` (at most 1000)
///      on the adjusted gain of a win, and `lossFeeBps` (at most 500) carved from the loss of
///      a losing close or the margin of a liquidation, only while the queue is empty. A
///      referred trader's fee first pays the referrer's share and the rest is pooled.
///      `pushFees` sends `stakerFeeShareBps` of the pool to Staking and the rest to the fee
///      recipient. FETTI is never minted by the exchange: stakers are paid from fees only.
///      Entry spread: a fill is moved `entryDeadbandBps` against the trader when the open
///      executes; the bust price is measured from the raw print. Borrow: `borrowRateX10`
///      tenths of a bps of notional per whole hour held beyond `borrowFreeHours`,
///      taken from the payout at close and kept by the house.
///      House wallets (`setHouseWallet`): the house's own trading wallets. A win is cut to the
///      free house cash (0 while the queue is active) and the rest forfeited before the fee,
///      never queued; their fees pay no referrer.
///      Fixed protocol constants: liquidation bounty 50 bps of margin; bust move
///      min(0.95 / leverage, 1 / leverage - 5 bps); max leverage of any market 1000.
///      Custody: all USDC sits in the Exchange. Payouts credit the recipient's available
///      balance; `withdraw` moves USDC out.
///      Session trading: the `sessionRouter`, created by the core's constructor, is a trusted
///      forwarder for `requestOpen` and `requestClose` only (ERC-2771 layout).
interface IExchange is IExchangeTypes {
    // ------------------------------------------------------------- collateral

    /// @notice Pull `amountUsdc` from the caller (needs prior approval) into their available balance.
    function deposit(uint256 amountUsdc) external;

    /// @notice Pull `amountUsdc` from the caller and credit `beneficiary`'s available balance.
    function depositFor(address beneficiary, uint256 amountUsdc) external;

    /// @notice Send `amountUsdc` of the caller's available balance back to their wallet.
    function withdraw(uint256 amountUsdc) external;

    // ---------------------------------------------------------------- trading

    /// @notice File an open request: the margin moves from the caller's available balance into
    ///         `pendingOf` and the current oracle price is recorded as p0.
    /// @dev Reverts unless: the instrument exists, is not retired, opens are not paused (global,
    ///      market or breaker), marginUsdc >= `minMarginUsdc`, 1 <= leverage <= `maxLeverage`,
    ///      the notional fits the static and the house-sized caps, the caller's available
    ///      balance covers the margin, and the oracle is live. The same rules are re-checked at
    ///      execution.
    /// @param referrer Referrer to lock in if this becomes the caller's first executed open
    ///        (zero = none; the caller's own address counts as zero). Ignored once locked.
    function requestOpen(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, address referrer)
        external
        returns (uint256 requestId);

    /// @notice Execute an open request in its window: keeper only during the grace window, at
    ///         p1; anyone afterwards until expiry, at the worse of p0 and p1 for the trader.
    /// @dev Re-checks the open rules and the guards; a failure cancels and refunds the request
    ///      (`OpenRequestCancelled`) and returns 0. Otherwise the position is created with the
    ///      live deadband, payout cap, fee rate and maximum profit stamped.
    function executeOpen(uint256 requestId) external returns (uint256 positionId);

    /// @notice Cancel an expired open request and refund its margin. Anyone, only after
    ///         `expiry` has passed (`RequestNotExpired` otherwise).
    function cancelOpen(uint256 requestId) external;

    /// @notice File a close request for the caller's position: records the oracle price as p0.
    function requestClose(uint256 positionId) external;

    /// @notice Execute the close request of `positionId` in its window, with the same
    ///         keeper-first rule as `executeOpen`. Then the stamped deadband, the impact
    ///         haircut, the stamped maximum profit and fee apply.
    /// @dev Margin minus any loss is credited now. Profit is credited now if the house has the
    ///      cash, otherwise appended to the FIFO queue.
    /// @return payoutUsdc Credited to the owner's available balance now.
    /// @return queuedUsdc Profit placed in the queue (0 when paid in full).
    function executeClose(uint256 positionId) external returns (uint256 payoutUsdc, uint256 queuedUsdc);

    /// @notice Cancel an expired close request. Anyone, only after `expiry`.
    function cancelClose(uint256 positionId) external;

    /// @notice Liquidate any position whose oracle price is at or beyond its bust price.
    ///         Instant and permissionless; a pending close request is voided.
    /// @dev Whole margin is forfeited: 0.5% to the caller, the position's `feeBps` of it carved
    ///      (none while the queue is active), rest to the house.
    function liquidate(uint256 positionId) external returns (uint256 bountyUsdc);

    /// @notice Pay queued profits from house cash, oldest first. Permissionless.
    function harvest(uint256 maxEntries) external returns (uint256 entriesPaid, uint256 paidUsdc);

    /// @notice Distribute the fee pool: `stakerFeeShareBps` to FETTI stakers, the rest to the
    ///         fee recipient. Only while the queue is empty and house cash covers the pool.
    /// @dev While `IStaking.totalStake()` (active plus warming) is 0 the stakers' part stays in
    ///      the pool, earmarked, and rides whole with the next push that finds stake; `NothingToPush` when
    ///      only that earmarked part is left.
    function pushFees() external returns (uint256 toStakersUsdc, uint256 toRecipientUsdc);

    // ------------------------------------------------------------ house money

    /// @notice Move `amountUsdc` from the owner (needs approval) into house cash. Owner only, any
    ///         time. Mints nothing, credits nobody. If anything is queued, the next `harvest`
    ///         pays the queue out of it first.
    function depositHouse(uint256 amountUsdc) external;

    /// @notice Take `amountUsdc` of house cash out to the owner. Owner only, any time, no notice.
    /// @dev First pushes earned fees when it can (queue empty, cash covers a non-zero pool), then
    ///      reverts `InsufficientBalance(free, amount)` unless amount <= `houseFreeUsdc()`. The
    ///      breaker base drops by the amount; it never counts as trading outflow.
    function withdrawHouse(uint256 amountUsdc) external;

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
    function bustPrice(uint256 positionId) external view returns (uint256 px18);

    /// @notice What a close would settle to at the current oracle price, on the position's
    ///         stamped terms. A fallback fill at a worse p0 settles lower.
    function previewClose(uint256 positionId)
        external
        view
        returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc);

    /// @notice The price the exchange would settle on right now: the oracle price, or the
    ///         frozen price of a retired market. The side flags are ignored (ABI continuity).
    function execPrice(uint32 instrumentId, bool isLong, bool isOpen) external view returns (uint256 px18);

    /// @notice Id the next open request will use.
    function nextRequestId() external view returns (uint256);

    /// @notice Id the next executed open will use.
    function nextPositionId() external view returns (uint256);

    /// @notice Instrument by id. Reverts `UnknownInstrument` for unknown ids.
    function instrument(uint32 instrumentId) external view returns (Instrument memory);

    /// @notice Number of instruments; ids are 0..count-1.
    function instrumentCount() external view returns (uint32);

    /// @notice Open notional per side, USDC 6-dec.
    function openInterest(uint32 instrumentId) external view returns (uint256 longUsd, uint256 shortUsd);

    /// @notice House cash, USDC 6-dec: what wins, the queue and the fee pool are paid from.
    function lpBalance() external view returns (uint256 usdc);

    /// @notice Undistributed fees (a claim on `lpBalance`).
    function feePool() external view returns (uint256 usdc);

    /// @notice House cash not owed to anyone: lpBalance - queuedTotal - feePool, floored at 0.
    ///         What `withdrawHouse` can take and what the house-sized limits are sized from.
    function houseFreeUsdc() external view returns (uint256 usdc);

    /// @notice Book exposure across every market: the sum of max(long OI, short OI) *
    ///         stressBps * (10000 - baseRateBps) / 1e8, USDC 6-dec. An open must keep it at or
    ///         under `houseFreeUsdc() * rhoBps / 10000`.
    function houseExposureUsdc() external view returns (uint256 usdc);

    /// @notice The largest notional one open on `instrumentId`, `isLong` could carry right now:
    ///         the smallest of the static position cap, the side headroom (static and
    ///         house-sized), the house-sized position cap and the exposure room. 0 while opens
    ///         are blocked for any reason.
    function maxPositionUsd(uint32 instrumentId, bool isLong) external view returns (uint256 usd);

    /// @notice Sum over open positions of their stamped `maxProfitUsdc`: the most the house
    ///         could owe if every open position closed at its cap.
    function openMaxPayoutUsdc() external view returns (uint256);

    /// @notice The session router, the one trusted forwarder of `requestOpen` / `requestClose`.
    function sessionRouter() external view returns (address);

    /// @notice The stateless `IMarketRules` module.
    function marketRules() external view returns (address);

    /// @notice The admin extension the core delegates to. Immutable.
    function extension() external view returns (address);

    /// @notice Total entries ever appended to the queue (head..length-1 are live).
    function queueLength() external view returns (uint256);

    /// @notice Index of the oldest unpaid entry; equals `queueLength` when the queue is empty.
    function queueHead() external view returns (uint256);

    /// @notice One queue entry.
    function queueEntry(uint256 index) external view returns (address recipient, uint256 owedUsdc);

    /// @notice Sum still owed across live queue entries.
    function queuedTotal() external view returns (uint256 usdc);

    /// @notice True when opens are paused for every market.
    function globalOpensPaused() external view returns (bool);

    /// @notice Breaker share: opens pause when net house outflow in the current one-hour window
    ///         exceeds this many bps of the free cash at the window start (200..10000; 10000 =
    ///         off).
    function breakerBps() external view returns (uint16);

    /// @notice True while the breaker blocks opens: it tripped in the current window.
    function breakerTripped() external view returns (bool);

    /// @notice Minimum net hourly outflow that can trip the breaker, USDC 6-dec.
    function breakerFloorUsdc() external view returns (uint128);

    /// @notice Fee on a win's adjusted gain stamped on positions opened from now on, bps.
    function winFeeBps() external view returns (uint16);

    /// @notice Fee carved from a loss or a liquidated margin, stamped on positions opened from
    ///         now on, bps.
    function lossFeeBps() external view returns (uint16);

    /// @notice Hours a position is held before its borrow rate starts, stamped at open.
    function borrowFreeHours() external view returns (uint16);

    /// @notice True when `wallet` is listed as a house wallet.
    function isHouseWallet(address wallet) external view returns (bool);

    /// @notice Borrow a position would owe if closed right now, USDC 6-dec.
    function borrowOwed(uint256 positionId) external view returns (uint256 usdc);

    /// @notice Share of each fee push that goes to stakers, bps.
    function stakerFeeShareBps() external view returns (uint16);

    /// @notice Smallest margin an open request may carry, USDC 6-dec (1e6..10e6).
    function minMarginUsdc() external view returns (uint64);

    /// @notice Book exposure allowed as bps of free house cash (500..10000).
    function rhoBps() external view returns (uint16);

    /// @notice A position's maximum profit as bps of free house cash at its open (500..5000).
    function maxWinBps() external view returns (uint16);

    /// @notice Seconds after a request before anyone may execute it (2..30, default 5).
    function minDelay() external view returns (uint32);

    /// @notice Length of the keeper-only window that starts at `minDelay` (1..10, default 3).
    function grace() external view returns (uint32);

    /// @notice Seconds after a request until it can only be cancelled (20..300, default 60).
    function expiry() external view returns (uint32);

    /// @notice Largest oracle move between request and execution an open request survives, in
    ///         bps of p0 (default 1000 = 10%).
    function maxJumpBps() external view returns (uint16);

    /// @notice True when `account` may execute requests in the keeper window.
    function isKeeper(address account) external view returns (bool);

    /// @notice The current breaker window.
    /// @return windowStart Timestamp the window opened (0 before the first settlement).
    /// @return windowStartLpUsdc Free house cash when the window opened, plus deposits and
    ///         minus withdrawals since.
    /// @return netOutflowUsdc Signed net house outflow since then.
    function breakerWindow()
        external
        view
        returns (uint64 windowStart, uint256 windowStartLpUsdc, int256 netOutflowUsdc);

    /// @notice USDC token (6 decimals).
    function usdc() external view returns (address);

    /// @notice Price oracle (IPriceOracle).
    function oracle() external view returns (address);

    /// @notice Staking (IStaking).
    function staking() external view returns (address);

    /// @notice Referral registry and tally (IReferrals), created and owned by this contract.
    function referrals() external view returns (address);

    /// @notice Owner (the owner wallet in production).
    function owner() external view returns (address);

    /// @notice Address that may pause opens.
    function pauseGuardian() external view returns (address);

    /// @notice Address that may move OI caps and house sizing.
    function marketKeeper() external view returns (address);

    /// @notice Receives the non-staker share of pushed fees.
    function feeRecipient() external view returns (address);

    // ------------------------------------------------------------------ admin

    /// @notice Add a market. Owner only. Ids are assigned sequentially and never reused.
    /// @dev Honoured fields: hlAssetIndex, szDecimals, tier, maxLeverage, deadbandBps, clampBps,
    ///      baseRateBps, rateMultiplier, referenceNotionalUsd, positionMultiplierE6,
    ///      longOiCapUsd, shortOiCapUsd, maxNotionalUsd, payoutCapX, posX10, sideX10, stressBps,
    ///      entryDeadbandBps, borrowRateX10; opensPaused, retired and lastPx18 are forced to
    ///      zero. Mirrors the mapping into the oracle.
    function addInstrument(Instrument calldata spec) external returns (uint32 instrumentId);

    /// @notice Tune an existing market's curve within bounds. Owner only. The new deadband
    ///         applies to positions opened from now on; the curve to every settlement from now
    ///         on; a base rate change recomputes the market's exposure term.
    /// @dev Bounds: deadbandBps 1..50, clampBps 5..100, baseRateBps 500..2000, rateMultiplier
    ///      1_000..1_000_000, referenceNotionalUsd 1_000e6..1_000_000e6, positionMultiplierE6
    ///      >= 1e12, and the curve must keep between 50% and 95% of a raw gain at a 1% move.
    function setInstrumentParams(
        uint32 instrumentId,
        uint16 deadbandBps,
        uint16 clampBps,
        uint16 baseRateBps,
        uint64 rateMultiplier,
        uint128 referenceNotionalUsd,
        uint128 positionMultiplierE6
    ) external;

    /// @notice Set a market's max leverage, 1..1000. Owner only.
    function setMaxLeverage(uint32 instrumentId, uint32 maxLeverage) external;

    /// @notice Set per-side static OI caps. Market keeper or owner. Each cap is bounded by the
    ///         tier's ceiling ($10M / $2.5M / $500K).
    function setOiCaps(uint32 instrumentId, uint128 longOiCapUsd, uint128 shortOiCapUsd) external;

    /// @notice Set a market's house-sized multipliers and stress move. Market keeper or owner.
    /// @dev Bounds: posX10 1..200, sideX10 1..500, stressBps 10..5000. A stress change
    ///      recomputes the market's exposure term at once.
    function setHouseSizing(uint32 instrumentId, uint16 posX10, uint16 sideX10, uint16 stressBps) external;

    /// @notice Set a market's static per-position caps. Owner only.
    /// @param maxNotionalUsd Max notional of one position, USDC 6-dec, in (0, 1_000_000e6].
    /// @param payoutCapX Max profit as a multiple of margin, 10..50.
    function setPositionCaps(uint32 instrumentId, uint128 maxNotionalUsd, uint16 payoutCapX) external;

    /// @notice Set the book exposure allowance, bps of free house cash. Owner only. 500..10000.
    function setRhoBps(uint16 newRhoBps) external;

    /// @notice Set the maximum profit of new positions, bps of free house cash. Owner only.
    ///         500..5000.
    function setMaxWinBps(uint16 newMaxWinBps) external;

    /// @notice Set the smallest margin of an open request, USDC 6-dec. Owner only. 1e6..10e6.
    function setMinMargin(uint64 newMinMarginUsdc) external;

    /// @notice Set the breaker share. Owner only. 200..10000 bps; 10000 means off.
    function setBreakerBps(uint16 newBreakerBps) external;

    /// @notice Set the breaker floor. Owner only. 0..10,000 USDC (0 = share only).
    function setBreakerFloor(uint128 newFloorUsdc) external;

    /// @notice Set the fee rates for positions opened from now on. Owner only. winFeeBps
    ///         0..1000, lossFeeBps 0..500.
    function setFeeBps(uint16 newWinFeeBps, uint16 newLossFeeBps) external;

    /// @notice Set a market's entry spread (0..50 bps) and borrow rate (0..50 tenths of a bps
    ///         per hour) for positions opened from now on. Owner only.
    function setMarketFees(uint32 instrumentId, uint16 entryDeadbandBps, uint16 borrowRateX10) external;

    /// @notice Set the borrow-free hours stamped on new positions. Owner only. 0..24.
    function setBorrowFreeHours(uint16 newFreeHours) external;

    /// @notice List or unlist a house wallet. Owner only.
    function setHouseWallet(address wallet, bool isHouse) external;

    /// @notice Set the stakers' share of each fee push. Owner only. 0..10000 bps.
    function setStakerFeeShare(uint16 newShareBps) external;

    /// @notice Set the referrer's share of a referred trader's fees. Owner only. 0..5000 bps.
    function setReferralShare(uint16 newShareBps) external;

    /// @notice Set the request windows, in seconds. Owner only. minDelay 2..30, grace 1..10,
    ///         expiry 20..300, minDelay + grace < expiry.
    function setDelays(uint32 newMinDelay, uint32 newGrace, uint32 newExpiry) external;

    /// @notice Add or remove a fill keeper. Owner only.
    function setKeeper(address keeper, bool allowed) external;

    /// @notice Set the jump guard, in bps of p0. Owner only. 10..10000.
    function setMaxJumpBps(uint16 newMaxJumpBps) external;

    /// @notice Clear a tripped breaker before its window ends and start a fresh window. Owner
    ///         only.
    function clearBreaker() external;

    /// @notice Pause or resume opens on one market. Pausing: guardian or owner. Resuming: owner.
    function setMarketOpensPaused(uint32 instrumentId, bool paused) external;

    /// @notice Pause or resume opens on every market. Pausing: guardian or owner. Resuming: owner.
    function setGlobalOpensPaused(bool paused) external;

    /// @notice Retire a market at the current oracle price: closes and liquidations only. Owner
    ///         only. Irreversible. Needs a live feed.
    function retire(uint32 instrumentId) external;

    /// @notice Retire a market whose feed is dead for good at its last settlement price
    ///         (`Instrument.lastPx18`), so open margins are not locked forever. Owner only.
    ///         Irreversible. Reverts `FeedAlive` while the oracle still answers, `NoLastPrice`
    ///         when nothing ever settled on the market.
    function retireDead(uint32 instrumentId) external;

    /// @notice Set the fee recipient. Owner only. Non-zero.
    function setFeeRecipient(address newFeeRecipient) external;

    /// @notice Set the pause guardian and market keeper. Owner only. Zero disables a role.
    function setKeepers(address newPauseGuardian, address newMarketKeeper) external;
}
