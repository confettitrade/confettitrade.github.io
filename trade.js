/* ==========================================================================
   confetti_  —  trade.js
   Drives trade.html: Hyperliquid price feeds (allMids every 2 s, candles,
   24h stats), the lightweight-charts candlestick chart, contract reads from
   a plain RPC, direct ethers v6 wallet transactions (approve, deposit,
   withdraw, request / execute / cancel open and close, register a referral
   code), the positions / history / refer / status tabs and the wallet
   plumbing (chain switch, account changes, revert reasons).
   Fills are two-step: requestOpen / requestClose file a request at the
   oracle price p0; a fill keeper executes it a few seconds later at the
   oracle price then (p1). The page shows the request as "filling…" with a
   countdown, watches for the keeper, and after the keeper window offers an
   executeOpen / executeClose from the user's own wallet (the fallback fill:
   the worse of p0 and p1 for the trader). After expiry it offers a cancel.
   No build step. Config comes from config.json (falls back to
   config.example.json). Contract ABI fragments are written by hand from
   contracts/src/interfaces/IExchange.sol and IReferrals.sol.
   ========================================================================== */
(function () {
  'use strict';

  var CHAIN_ID = 999;
  var CHAIN_HEX = '0x3e7';
  var MIDS_EVERY_MS = 2000;
  var CTX_EVERY_MS = 30000;
  var CANDLES_EVERY_MS = 60000;
  var CHAIN_EVERY_MS = 10000;
  var INSTRUMENTS_EVERY_MS = 300000;
  var CANDLE_COUNT = 300;
  /* While a request is pending the page polls it every second and redraws the countdown
     four times a second; outcomes are read from the logs for up to this many tries. */
  var PENDING_POLL_MS = 1000;
  var COUNTDOWN_MS = 250;
  var OUTCOME_TRIES = 12;
  /* Blocks scanned back first for OpenRequested when pendingOf says a request exists that the
     page does not know (another tab, a reload): about ten minutes of 1 s blocks. When margin is
     still unaccounted for after that, the scan widens to deployBlock (an unfilled request
     outlives the keeper window: with the keeper down it sits in pendingOf until someone cancels
     it, however old it is). */
  var PENDING_SCAN_BLOCKS = 600;
  var THEME_KEY = 'confetti.theme';
  var LS = {
    market: 'confetti.trade.market', side: 'confetti.trade.side', lev: 'confetti.trade.lev.', tab: 'confetti.trade.tab',
    ref: 'confetti.ref', pending: 'confetti.trade.pending.', autoFill: 'confetti.trade.autofill'
  };
  var TZ_OFFSET_S = new Date().getTimezoneOffset() * 60;
  var ZERO = '0x0000000000000000000000000000000000000000';
  /* Referral codes: 3..16 of [a-z0-9_] (Referrals.sol). The link is confetti.trade/?ref=CODE. */
  var REF_RE = /^[a-z0-9_]{3,16}$/;
  var SITE_URL = 'https://confetti.trade/';

  /* The live deployment, pinned. config.json may restate these, but a config whose addresses
     differ is refused (console error + status line) and these are used, so a hijacked config
     cannot redirect a deposit. The RPC and info hosts are pinned the same way; the pages' CSP
     allows exactly these hosts. */
  var CONTRACTS = {
    exchange: '0x257d667a52b282ac0b4c001fd437522bf6b9cbe2',
    usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
    oracle: '0x7a5eff5e2288e53ed78de6cdc7f08c68ed4400cc',
    confetti: '0x665c84fbf77629c8ba6bfe76d9fedd2d9a7b2b75',
    tokenomics: '0xb9dc9c1271732067aed0068d81b118a638764c0a',
    staking: '0x318535af817913fd33cd4088f2c56fc5ddcab50d',
    referrals: '0x0879fe6298a6b987173b29693af4ade6d63c19da',
    priceSource: '0xFaF573187824D176fc74d1de91a072eb6ffa8494'
  };
  var RPC_HOSTS = ['rpc.hyperliquid.xyz', 'hyperliquid.drpc.org', 'rpc.purroofgroup.com'];
  var INFO_HOSTS = ['api.hyperliquid.xyz'];
  var DEFAULT_RPC = 'https://rpc.hyperliquid.xyz/evm';
  var DEFAULT_INFO = 'https://api.hyperliquid.xyz/info';
  /* One-time acceptance of terms.html, kept in localStorage; the order button waits for it. */
  var TERMS_KEY = 'confetti.terms';

  /* Fixed protocol constants (IExchange header). Config may restate them but cannot change the contract. */
  var MIN_MARGIN = 10;
  /* Bust move = the smaller of 95% of 1/leverage and 1/leverage - BUST_GAP_BPS (ImpactLib):
     5 bps at 1000x, 15 at 500x, 35 at 250x; the 95% rule binds at 100x and below. */
  var BUST_BUFFER_PCT = 95;
  var BUST_GAP_BPS = 5;
  /* Fee rate on wins, losses and liquidations. The owner can set it from 0 to 5% (never above).
     The rate (like the market's deadband and payout cap) is stamped on each position at open,
     so an open position's preview uses its own stamped terms (positions() returns them); the
     order form uses the live feeBps() once refreshHouse has read it, and the 5% cap until then. */
  var DEFAULT_FEE_RATE = 0.05;

  /* ---- tiny helpers ------------------------------------------------------- */

  function $(id) { return document.getElementById(id); }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = v ? v.trim() : '';
    return v || fallback;
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtUsd(n, signed) {
    if (n == null || !isFinite(n)) return '—';
    var abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n < 0) return '-$' + abs;
    return (signed && n > 0 ? '+' : '') + '$' + abs;
  }

  function fmtUsdCompact(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return '$' + Math.round(n).toLocaleString('en-US');
    return fmtUsd(n);
  }

  /* Five significant figures, like Hyperliquid quotes: 0.085187, 1.9107, 82766.00.
     Hyperliquid prices carry at most (6 - szDecimals) decimals; the on-chain mid is the
     average of bid and ask, so one more decimal can appear. Cap there when sz is known. */
  function pricePrecision(p, szDecimals) {
    if (!(p > 0)) return 4;
    var cap = szDecimals == null ? 7 : Math.max(2, 7 - szDecimals);
    return clamp(4 - Math.floor(Math.log10(p)), 2, cap);
  }

  function fmtPrice(p, szDecimals) {
    if (p == null || !isFinite(p) || p <= 0) return '—';
    return p.toFixed(pricePrecision(p, szDecimals));
  }

  function fmtPct(x, signed) {
    if (x == null || !isFinite(x)) return '';
    return (signed && x > 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
  }

  function fmtInt(n) { return isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—'; }

  function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }

  function fmtTime(ts) {
    if (!ts) return '…';
    var d = new Date(ts * 1000);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtClock(ts) {
    if (!ts) return '…';
    return new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function usd6ToNum(x) { return Number(x) / 1e6; }
  function px18ToNum(x) { return Number(x) / 1e18; }
  function tokenToNum(x) { return Number(x) / 1e18; }

  function numToUsd6(v) {
    /* round half-up to the micro-USDC the contract works in */
    var s = (Math.round(v * 1e6) / 1e6).toFixed(6);
    return window.ethers.parseUnits(s, 6);
  }

  function isAddr(a) { return !!(window.ethers && a && window.ethers.isAddress(a) && a.toLowerCase() !== ZERO); }

  /* ---- config ------------------------------------------------------------ */

  var cfg = null;

  function loadConfig() {
    function get(url) {
      return fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error(url + ' ' + r.status);
        return r.json();
      });
    }
    return get('config.json').catch(function () { return get('config.example.json'); });
  }

  function hostOf(url) {
    try { return new URL(String(url)).hostname.toLowerCase(); } catch (e) { return ''; }
  }

  function hostAllowed(url, hosts) {
    var h = hostOf(url);
    return !!h && hosts.indexOf(h) !== -1 && /^https:/i.test(String(url));
  }

  /* Pin the loaded config to the constants above: every contract address, the chain id and the
     RPC / info hosts. Returns the fields that disagreed (empty for a clean config); the pinned
     values are in force either way, so the deposit target never comes from the network. A zero
     address (config.example.json) counts as unset, not as a disagreement. */
  function pinConfig(c) {
    var bad = [];
    c.contracts = c.contracts || {};
    Object.keys(CONTRACTS).forEach(function (k) {
      var v = c.contracts[k];
      var s = v == null ? '' : String(v).toLowerCase();
      if (s && s !== ZERO && s !== CONTRACTS[k].toLowerCase()) bad.push('contracts.' + k + ' ' + v);
      c.contracts[k] = CONTRACTS[k];
    });
    if (c.chainId != null && Number(c.chainId) !== CHAIN_ID) bad.push('chainId ' + c.chainId);
    c.chainId = CHAIN_ID;
    c.chainIdHex = CHAIN_HEX;
    if (c.rpcUrl && !hostAllowed(c.rpcUrl, RPC_HOSTS)) { bad.push('rpcUrl ' + c.rpcUrl); c.rpcUrl = DEFAULT_RPC; }
    if (!c.rpcUrl) c.rpcUrl = DEFAULT_RPC;
    if (c.logRpcUrl && !hostAllowed(c.logRpcUrl, RPC_HOSTS)) { bad.push('logRpcUrl ' + c.logRpcUrl); c.logRpcUrl = null; }
    if (c.hyperliquidInfoUrl && !hostAllowed(c.hyperliquidInfoUrl, INFO_HOSTS)) { bad.push('hyperliquidInfoUrl ' + c.hyperliquidInfoUrl); c.hyperliquidInfoUrl = DEFAULT_INFO; }
    return bad;
  }

  function hasExchange() { return !!(cfg && cfg.contracts && isAddr(cfg.contracts.exchange)); }

  function explorer(kind, value) {
    var base = (cfg && cfg.explorerUrl) || 'https://hyperevmscan.io';
    return base.replace(/\/$/, '') + '/' + kind + '/' + value;
  }

  /* ---- ABI fragments (hand-written from the Solidity interfaces) ---------- */

  var EXCHANGE_ABI = [
    /* collateral */
    'function deposit(uint256 amountUsdc)',
    'function depositFor(address beneficiary, uint256 amountUsdc)',
    'function withdraw(uint256 amountUsdc)',
    /* trading: request, then execute (keeper first, anyone after the grace window) or cancel (after expiry) */
    'function requestOpen(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, address referrer) returns (uint256 requestId)',
    'function executeOpen(uint256 requestId) returns (uint256 positionId)',
    'function cancelOpen(uint256 requestId)',
    'function requestClose(uint256 positionId)',
    'function executeClose(uint256 positionId) returns (uint256 payoutUsdc, uint256 queuedUsdc)',
    'function cancelClose(uint256 positionId)',
    'function liquidate(uint256 positionId) returns (uint256 bountyUsdc)',
    'function harvest(uint256 maxEntries) returns (uint256 entriesPaid, uint256 paidUsdc)',
    'function pushFees() returns (uint256 toStakersUsdc, uint256 toRecipientUsdc)',
    /* views */
    'function balanceOf(address user) view returns (uint256 availableUsdc)',
    'function marginInUse(address user) view returns (uint256 usdc)',
    'function pendingOf(address user) view returns (uint256 usdc)',
    'function positions(uint256 positionId) view returns (tuple(address owner, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 entryPx18, uint64 openedAt, uint16 deadbandBps, uint16 payoutCapX, uint16 feeBps))',
    'function positionIdsOf(address user) view returns (uint256[])',
    'function openRequest(uint256 requestId) view returns (tuple(address trader, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint64 requestedAt, uint256 px0, address referrer))',
    'function closeRequest(uint256 positionId) view returns (tuple(uint64 requestedAt, uint256 px0))',
    'function bustPrice(uint256 positionId) view returns (uint256 px18)',
    'function previewClose(uint256 positionId) view returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc)',
    'function execPrice(uint32 instrumentId, bool isLong, bool isOpen) view returns (uint256 px18)',
    'function nextRequestId() view returns (uint256)',
    'function nextPositionId() view returns (uint256)',
    'function instrument(uint32 instrumentId) view returns (tuple(uint32 hlAssetIndex, uint8 szDecimals, uint8 tier, uint32 maxLeverage, uint16 deadbandBps, uint16 clampBps, uint16 baseRateBps, uint64 rateMultiplier, uint128 referenceNotionalUsd, uint128 positionMultiplierE6, uint128 longOiCapUsd, uint128 shortOiCapUsd, uint128 maxNotionalUsd, uint16 payoutCapX, bool opensPaused, bool retired, uint256 frozenPx18))',
    'function instrumentCount() view returns (uint32)',
    'function openInterest(uint32 instrumentId) view returns (uint256 longUsd, uint256 shortUsd)',
    'function lpBalance() view returns (uint256 usdc)',
    'function feePool() view returns (uint256 usdc)',
    'function queueLength() view returns (uint256)',
    'function queueHead() view returns (uint256)',
    'function queueEntry(uint256 index) view returns (address recipient, uint256 owedUsdc)',
    'function queuedTotal() view returns (uint256 usdc)',
    'function globalOpensPaused() view returns (bool)',
    'function breakerTripped() view returns (bool)',
    'function breakerBps() view returns (uint16)',
    'function breakerFloorUsdc() view returns (uint128)',
    'function feeBps() view returns (uint16)',
    'function stakerFeeShareBps() view returns (uint16)',
    'function minDelay() view returns (uint32)',
    'function grace() view returns (uint32)',
    'function expiry() view returns (uint32)',
    'function maxJumpBps() view returns (uint16)',
    'function isKeeper(address account) view returns (bool)',
    'function usdc() view returns (address)',
    'function oracle() view returns (address)',
    'function confetti() view returns (address)',
    'function tokenomics() view returns (address)',
    'function staking() view returns (address)',
    'function referrals() view returns (address)',
    'function owner() view returns (address)',
    'function pauseGuardian() view returns (address)',
    'function marketKeeper() view returns (address)',
    'function feeRecipient() view returns (address)',
    /* events */
    'event Deposited(address indexed user, address indexed payer, uint256 amountUsdc)',
    'event Withdrawn(address indexed user, uint256 amountUsdc)',
    'event OpenRequested(uint256 indexed requestId, address indexed trader, uint32 indexed instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 px0, address referrer)',
    'event OpenRequestCancelled(uint256 indexed requestId, address indexed trader, bytes4 reason)',
    'event PositionOpened(uint256 indexed positionId, address indexed owner, uint32 indexed instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 entryPx18, uint256 requestId)',
    'event CloseRequested(uint256 indexed positionId, address indexed trader, uint256 px0)',
    'event CloseRequestCancelled(uint256 indexed positionId, bytes4 reason)',
    'event PositionClosed(uint256 indexed positionId, address indexed owner, uint256 exitPx18, int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc, uint256 queuedUsdc, uint256 confettiMinted)',
    'event PositionLiquidated(uint256 indexed positionId, address indexed owner, address indexed liquidator, uint256 exitPx18, uint128 marginUsdc, uint256 bountyUsdc, uint256 feeUsdc, uint256 confettiMinted)',
    'event QueueAppended(uint256 indexed index, address indexed recipient, uint256 amountUsdc)',
    'event QueuePaid(uint256 indexed index, address indexed recipient, uint256 paidUsdc, uint256 remainingUsdc)',
    'event FeesPushed(uint256 toStakersUsdc, uint256 toRecipientUsdc)',
    'event StakerOverflowSwept(uint256 amountUsdc)',
    'event TeamMinted(address indexed to, uint256 amount)',
    'event InstrumentAdded(uint32 indexed instrumentId, uint32 hlAssetIndex, uint8 szDecimals, uint8 tier, uint32 maxLeverage)',
    'event InstrumentParamsSet(uint32 indexed instrumentId, uint16 deadbandBps, uint16 clampBps, uint16 baseRateBps, uint64 rateMultiplier, uint128 referenceNotionalUsd, uint128 positionMultiplierE6)',
    'event OiCapsSet(uint32 indexed instrumentId, uint128 longOiCapUsd, uint128 shortOiCapUsd)',
    'event MaxLeverageSet(uint32 indexed instrumentId, uint32 maxLeverage)',
    'event PositionCapsSet(uint32 indexed instrumentId, uint128 maxNotionalUsd, uint16 payoutCapX)',
    'event PayoutCapped(uint256 indexed positionId, uint256 cappedGainUsdc, uint256 forfeitedUsdc)',
    'event LpBreakerTripped(uint256 netOutflowUsdc, uint256 thresholdUsdc, uint256 windowStartLpUsdc)',
    'event BreakerCleared(address indexed by)',
    'event BreakerBpsSet(uint16 breakerBps)',
    'event BreakerFloorSet(uint128 floorUsdc)',
    'event FeeBpsSet(uint16 feeBps)',
    'event StakerFeeShareSet(uint16 stakerFeeShareBps)',
    'event DelaysSet(uint32 minDelay, uint32 grace, uint32 expiry)',
    'event MaxJumpBpsSet(uint16 maxJumpBps)',
    'event KeeperSet(address indexed keeper, bool allowed)',
    'event KeepersSet(address indexed pauseGuardian, address indexed marketKeeper)',
    'event FeeRecipientSet(address indexed feeRecipient)',
    'event MarketOpensPausedSet(uint32 indexed instrumentId, bool paused)',
    'event GlobalOpensPausedSet(bool paused)',
    'event InstrumentRetired(uint32 indexed instrumentId, uint256 frozenPx18)',
    /* errors: Exchange (the open rules are arg-less; their selectors also appear as the
       `reason` of OpenRequestCancelled when an execution refunds a request) */
    'error Unauthorized()',
    'error ZeroAddress()',
    'error ZeroAmount()',
    'error UnknownInstrument(uint32 instrumentId)',
    'error MarketRetired()',
    'error OpensPausedGlobally()',
    'error OpensPausedForMarket()',
    'error OpensPausedByBreaker()',
    'error MarginBelowMinimum()',
    'error LeverageOutOfRange()',
    'error PositionTooLarge()',
    'error OiCapExceeded()',
    'error InsufficientBalance(uint256 availableUsdc, uint256 requestedUsdc)',
    'error UnknownPosition(uint256 positionId)',
    'error NotPositionOwner(uint256 positionId, address caller)',
    'error NotLiquidatable(uint256 positionId, uint256 px18, uint256 bustPx18)',
    'error InvalidTier(uint8 tier)',
    'error ParamOutOfBounds(uint8 param, uint256 value)',
    'error QueueEmpty()',
    'error QueueNotEmpty()',
    'error NothingToPush()',
    'error BreakerNotTripped()',
    'error FeedAlive(uint32 instrumentId)',
    'error UnknownRequest()',
    'error TooEarly()',
    'error KeeperWindow()',
    'error RequestExpired()',
    'error RequestNotExpired()',
    'error CloseAlreadyPending()',
    'error PriceJumped()',
    'error EntryBusted()',
    /* errors: PriceOracle, bubble up through request / execute */
    'error FeedUnavailable(uint32 instrumentId)',
    'error ZeroPrice(uint32 instrumentId)',
    'error ClampOutOfBounds(uint16 clampBps)',
    /* errors: OpenZeppelin, bubble up through deposit/withdraw */
    'error OwnableUnauthorizedAccount(address account)',
    'error OwnableInvalidOwner(address owner)',
    'error ReentrancyGuardReentrantCall()',
    'error SafeERC20FailedOperation(address token)',
    'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
    'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
    'error ERC20InvalidReceiver(address receiver)',
    'error ERC20InvalidSender(address sender)'
  ];

  /* Referrals.sol: created by the Exchange; its address comes from exchange.referrals(). */
  var REFERRALS_ABI = [
    'function registerCode(string code)',
    'function codeToReferrer(string code) view returns (address)',
    'function codeOf(address account) view returns (string)',
    'function referrerOf(address trader) view returns (address)',
    'function referrerLocked(address trader) view returns (bool)',
    'function referralEarned(address referrer) view returns (uint256)',
    'function referralShareBps() view returns (uint16)',
    'function exchange() view returns (address)',
    'event ReferralCodeRegistered(string code, address indexed owner)',
    'event ReferrerSet(address indexed trader, address indexed referrer)',
    'event ReferralPaid(address indexed referrer, address indexed trader, uint256 amountUsdc)',
    'event ReferralShareSet(uint16 shareBps)',
    'error NotExchange()',
    'error InvalidCode(string code)',
    'error CodeTaken(string code)',
    'error AlreadyRegistered(address account)',
    'error ShareOutOfBounds(uint16 shareBps)'
  ];

  var ERC20_ABI = [
    'function approve(address spender, uint256 value) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
    'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)'
  ];

  var exIface = null; /* ethers.Interface for EXCHANGE_ABI */
  var refIface = null; /* ethers.Interface for REFERRALS_ABI */

  /* ---- state --------------------------------------------------------------- */

  var state = {
    markets: [],          /* config markets, enriched: inst (on-chain), instrumentId */
    bySym: {},
    byCoin: {},
    byInstId: {},
    market: null,         /* selected market */
    mids: {},             /* coin -> number */
    ctx: {},              /* coin -> { vol24h, prevDayPx, markPx } */
    midsFailures: 0,
    instrumentsLoaded: false,
    busy: false
  };

  var form = { side: 'long', margin: NaN, lev: 100 };

  var wallet = { eth: null, provider: null, signer: null, account: null, chainId: null, subscribed: false };

  /* pending: margin held by the account's open requests (pendingOf); closeReqs: per position id,
     the pending close request { requestedAt, px0 } or nothing. */
  var acct = { loaded: false, available: 0, marginInUse: 0, pending: 0, positions: [], closeReqs: {}, walletUsdc: 0, allowance: 0 };

  var house = {
    addrs: {}, lp: null, feePool: null, queued: null, queueLen: null, queueHead: null,
    globalPaused: false, breakerTripped: false, instCount: null, block: null, blockAt: 0, oi: {},
    /* latest block timestamp and when it was read, for the request countdowns (chainNow) */
    chainTs: null, chainTsAt: 0,
    /* per instrument id: the on-chain HyperCore oracle price (execPrice), refreshed with the
       chain poll; this is what every fill and liquidation settles on */
    oraclePxById: {},
    feeRate: null,
    /* request windows in seconds (minDelay / grace / expiry), the jump guard, the fee shares */
    minDelay: 5, grace: 3, expiry: 60, maxJumpBps: null, stakerShareBps: null, referralShareBps: null
  };

  /* ---- house market-activity bots ----------------------------------------------------
     config.json "houseBots": the addresses of the house-run accounts (disclosed in docs.html). They look
     like any other trader on screen and are left out of every public number: the open-interest
     chips here and any volume, 24h stat, leaderboard or points ranking (ConfettiHouseBots.filter takes a
     list of rows and drops theirs). The order form's headroom check keeps the contract's real open
     interest, because the cap counts them. */
  var hbots = { idx: {}, n: 0, oi: {}, loaded: false, busy: false, at: 0 };
  var HBOT_EVERY_MS = 30000;

  function initHouseBots(list) {
    hbots.idx = {}; hbots.n = 0;
    (Array.isArray(list) ? list : []).slice(0, 20).forEach(function (a, i) {
      if (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !hbots.idx[a.toLowerCase()]) { hbots.idx[a.toLowerCase()] = i + 1; hbots.n++; }
    });
  }
  function isHouseBot(a) { return !!(hbots && typeof a === 'string' && hbots.idx[a.toLowerCase()]); }
  function excludeHouseBots(rows, addrOf) { return hbots.n ? rows.filter(function (r) { return !isHouseBot(addrOf(r)); }) : rows; }
  window.ConfettiHouseBots = { isBot: isHouseBot, filter: excludeHouseBots, count: function () { return hbots.n; } };

  /* Open interest as shown to the public: the contract's, minus the house bots' own positions.
     Until their share has been read the chips show a dash rather than a number that includes them. */
  function publicOi(sym, instId) {
    var oi = house.oi[sym];
    if (!oi || !hbots.n) return oi || null;
    if (!hbots.loaded) return null;
    var b = hbots.oi[instId];
    return { long: Math.max(0, oi.long - (b ? b.long : 0)), short: Math.max(0, oi.short - (b ? b.short : 0)) };
  }
  function loadHouseBotOi() {
    if (!hbots.n || hbots.busy || !read.exchange || Date.now() - hbots.at < HBOT_EVERY_MS) return Promise.resolve();
    hbots.busy = true; hbots.at = Date.now();
    var ex = read.exchange, next = {}, ok = true;
    return Object.keys(hbots.idx).reduce(function (chain, a) {
      return chain.then(function () {
        return ex.positionIdsOf(a).then(function (ids) {
          return Array.from(ids).reduce(function (q, id) {
            return q.then(function () {
              return ex.positions(id).then(function (p) {
                if (!p || p.owner === ZERO) return;
                var k = Number(p.instrumentId);
                var o = next[k] || (next[k] = { long: 0, short: 0 });
                o[p.isLong ? 'long' : 'short'] += usd6ToNum(p.marginUsdc) * Number(p.leverage);
              });
            });
          }, Promise.resolve());
        }).catch(function () { ok = false; });
      });
    }, Promise.resolve()).then(function () {
      if (ok) { hbots.oi = next; hbots.loaded = true; }
      hbots.busy = false;
      if (ok) renderMarketHeader();
    });
  }

  /* Open requests this page is watching, by request id (string): the OpenRequest fields plus
     the block it was filed in (for the outcome lookup) and what the page is doing about it. */
  var pend = { opens: {}, timer: null, tick: null, inFlight: false, scanning: false, scan: { account: null, from: Infinity } };

  /* Referral state for the connected account: the stored ?ref code, its resolved address, the
     account's own code / earnings and whether its referrer is already locked on chain. */
  var ref = { code: lsGet('confetti.ref') || '', addr: null, locked: null, referrer: null, myCode: '', earned: null, loaded: false };

  var read = { provider: null, logProvider: null, exchange: null, referrals: null };

  /* The terms tick for this visit (also read back from localStorage when storage works). */
  var termsOk = false;

  /* ---- Hyperliquid info API ---------------------------------------------- */

  function postInfo(body, timeoutMs) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 6000) : null;
    var url = (cfg && cfg.hyperliquidInfoUrl) || 'https://api.hyperliquid.xyz/info';
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('info ' + res.status);
      return res.json();
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  var midsInFlight = false;

  function tickMids(force) {
    if (midsInFlight || (document.hidden && !force)) return;
    midsInFlight = true;
    postInfo({ type: 'allMids' }, 5000).then(function (mids) {
      state.midsFailures = 0;
      setLive(true);
      if (!mids || typeof mids !== 'object') return;
      state.markets.forEach(function (m) {
        var v = Number(mids[m.coin]);
        if (isFinite(v) && v > 0) state.mids[m.coin] = v;
      });
      onPrices();
    }).catch(function () {
      state.midsFailures += 1;
      if (state.midsFailures >= 2) setLive(false);
    }).then(function () { midsInFlight = false; });
  }

  function setLive(ok) {
    var chip = $('chipLive');
    if (!chip) return;
    chip.classList.toggle('is-stale', !ok);
    setText('chipLiveText', ok ? 'live' : 'stale');
  }

  var ctxInFlight = false;

  function tickCtx(force) {
    if (ctxInFlight || (document.hidden && !force)) return;
    ctxInFlight = true;
    postInfo({ type: 'metaAndAssetCtxs' }, 8000).then(function (res) {
      if (!Array.isArray(res) || res.length < 2) return;
      var universe = (res[0] && res[0].universe) || [];
      var ctxs = res[1] || [];
      universe.forEach(function (u, i) {
        var c = ctxs[i];
        if (!c || !state.byCoin[u.name]) return;
        state.ctx[u.name] = {
          vol24h: Number(c.dayNtlVlm),
          prevDayPx: Number(c.prevDayPx),
          markPx: Number(c.markPx),
          midPx: Number(c.midPx),
          /* the same validator oracle the chain settles on, as a fallback estimate */
          oraclePx: Number(c.oraclePx)
        };
      });
      renderMarketHeader();
      renderMarketMenuPrices();
    }).catch(function () { /* stats are decoration; keep the last values */ })
      .then(function () { ctxInFlight = false; });
  }

  /* ---- chart --------------------------------------------------------------- */

  var chart = { api: null, series: null, coin: null, candles: [], loading: false, precision: 4 };

  function chartTheme() {
    return {
      raised: cssVar('--raised', '#faf6ed'),
      ink: cssVar('--ink', '#2a2520'),
      muted: cssVar('--ink-muted', '#5f564b'),
      faint: cssVar('--ink-faint', '#7a7060'),
      rule: cssVar('--rule', '#d4cbba'),
      ruleStrong: cssVar('--rule-strong', '#b8ad92'),
      pos: cssVar('--pos', '#2e7a4c'),
      neg: cssVar('--neg', '#b44855'),
      page: cssVar('--page', '#f4ecd8'),
      mono: cssVar('--font-mono', 'monospace')
    };
  }

  function chartOptions() {
    var t = chartTheme();
    var LW = window.LightweightCharts;
    return {
      autoSize: true,
      layout: { background: { type: 'solid', color: t.raised }, textColor: t.muted, fontFamily: t.mono, fontSize: 11 },
      grid: { vertLines: { color: t.rule, style: 1 }, horzLines: { color: t.rule, style: 1 } },
      rightPriceScale: { borderColor: t.ruleStrong, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: t.ruleStrong, timeVisible: true, secondsVisible: false, rightOffset: 3, barSpacing: 7 },
      /* let a phone scroll the page over the chart; horizontal drag and pinch still pan/zoom */
      handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      crosshair: {
        mode: LW && LW.CrosshairMode ? LW.CrosshairMode.Normal : 0,
        vertLine: { color: t.faint, labelBackgroundColor: t.ink, style: 1 },
        horzLine: { color: t.faint, labelBackgroundColor: t.ink, style: 1 }
      },
      localization: { priceFormatter: function (p) { return Number(p).toFixed(chart.precision); } }
    };
  }

  function seriesOptions() {
    var t = chartTheme();
    return {
      upColor: t.pos, downColor: t.neg,
      borderUpColor: t.pos, borderDownColor: t.neg,
      wickUpColor: t.pos, wickDownColor: t.neg,
      priceLineColor: t.ink,
      priceFormat: { type: 'price', precision: chart.precision, minMove: Math.pow(10, -chart.precision) }
    };
  }

  function initChart() {
    var host = $('chart');
    if (!host || !window.LightweightCharts) {
      chartNote('chart library unavailable', true);
      return;
    }
    chart.api = window.LightweightCharts.createChart(host, chartOptions());
    chart.series = chart.api.addCandlestickSeries(seriesOptions());
  }

  function rethemeChart() {
    if (!chart.api) return;
    chart.api.applyOptions(chartOptions());
    chart.series.applyOptions(seriesOptions());
  }

  function chartNote(text, show) {
    var n = $('chartNote');
    if (!n) return;
    n.textContent = text;
    if (show) n.removeAttribute('hidden'); else n.setAttribute('hidden', '');
  }

  function toBar(k) {
    return { time: Math.floor(k.t / 1000) - TZ_OFFSET_S, open: k.o, high: k.h, low: k.l, close: k.c };
  }

  function loadCandles() {
    var m = state.market;
    if (!m || chart.loading || !chart.series) return;
    chart.loading = true;
    var coin = m.coin;
    var end = Date.now();
    var start = end - (CANDLE_COUNT + 2) * 60000;
    postInfo({ type: 'candleSnapshot', req: { coin: coin, interval: '1m', startTime: start, endTime: end } }, 8000)
      .then(function (rows) {
        if (!state.market || state.market.coin !== coin) return;
        if (!Array.isArray(rows)) throw new Error('bad candles');
        var parsed = rows.map(function (r) {
          return { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) };
        }).filter(function (k) {
          return isFinite(k.t) && isFinite(k.o) && isFinite(k.h) && isFinite(k.l) && isFinite(k.c) && k.c > 0;
        }).slice(-CANDLE_COUNT);
        if (parsed.length === 0) throw new Error('no candles');
        var reset = chart.coin !== coin;
        chart.coin = coin;
        chart.candles = parsed;
        var last = parsed[parsed.length - 1].c;
        var precision = pricePrecision(last, m.szDecimals);
        if (precision !== chart.precision || reset) {
          chart.precision = precision;
          chart.series.applyOptions(seriesOptions());
        }
        chart.series.setData(parsed.map(toBar));
        if (reset) chart.api.timeScale().scrollToRealTime();
        chartNote('', false);
        if (!state.mids[coin]) { state.mids[coin] = last; onPrices(); }
      })
      .catch(function () {
        if (!state.market || state.market.coin !== coin) return;
        if (chart.coin !== coin) {
          chart.coin = coin;
          chart.candles = [];
          chart.series.setData([]);
        }
        chartNote('candles unavailable · retrying', true);
      })
      .then(function () { chart.loading = false; });
  }

  /* Fold a fresh mid into the last candle, or open a new minute. */
  function updateChartFromMid(px) {
    if (!chart.series || !state.market || chart.coin !== state.market.coin || chart.candles.length === 0) return;
    var minute = Math.floor(Date.now() / 60000) * 60000;
    var last = chart.candles[chart.candles.length - 1];
    if (minute > last.t) {
      var bar = { t: minute, o: last.c, h: Math.max(last.c, px), l: Math.min(last.c, px), c: px };
      chart.candles.push(bar);
      if (chart.candles.length > CANDLE_COUNT) chart.candles.shift();
      chart.series.update(toBar(bar));
    } else {
      last.c = px;
      if (px > last.h) last.h = px;
      if (px < last.l) last.l = px;
      chart.series.update(toBar(last));
    }
  }

  /* ---- markets --------------------------------------------------------------- */

  function tierLetter(m) { return m.inst ? ['A', 'B', 'C'][m.inst.tier] || '?' : String(m.tier || '?'); }
  function tierClass(m) { return 'badge badge-' + tierLetter(m).toLowerCase(); }
  function maxLev(m) { return m.inst ? m.inst.maxLeverage : Number(m.maxLeverage) || 1; }
  function marketPrice(m) { return m ? state.mids[m.coin] : NaN; }

  function buildMarkets() {
    state.markets = (cfg.markets || []).map(function (m) {
      return {
        symbol: m.symbol, coin: m.coin || m.symbol, hlAssetIndex: Number(m.hlAssetIndex),
        szDecimals: Number(m.szDecimals), tier: m.tier, maxLeverage: Number(m.maxLeverage),
        launch: !!m.launch, instrumentId: null, inst: null
      };
    });
    state.bySym = {}; state.byCoin = {};
    state.markets.forEach(function (m) { state.bySym[m.symbol] = m; state.byCoin[m.coin] = m; });
  }

  function initialMarketSymbol() {
    var fromHash = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    if (fromHash && state.bySym[fromHash]) return fromHash;
    var saved = lsGet(LS.market);
    if (saved && state.bySym[saved]) return saved;
    return state.markets.length ? state.markets[0].symbol : null;
  }

  function selectMarket(sym) {
    var m = state.bySym[sym];
    if (!m) return;
    var changed = state.market !== m;
    state.market = m;
    lsSet(LS.market, sym);
    try { history.replaceState(null, '', '#' + encodeURIComponent(sym)); } catch (e) { /* ignore */ }

    var savedLev = Number(lsGet(LS.lev + sym));
    form.lev = clamp(isFinite(savedLev) && savedLev >= 1 ? Math.round(savedLev) : defaultLeverage(m), 1, maxLev(m));

    renderMarketHeader();
    renderLeverage();
    renderForm();
    renderAction();
    renderStatus();
    closeMarketMenu();
    if (changed || !chart.coin) {
      if (chart.series && chart.coin !== m.coin) {
        chart.candles = [];
        chart.series.setData([]);
        chart.coin = null;
      }
      setText('chartMeta', m.coin + ' · 1m');
      loadCandles();
      refreshMarketChain();
    }
  }

  function defaultLeverage(m) {
    var max = maxLev(m);
    if (max >= 1000) return 100;
    if (max >= 250) return 50;
    return 10;
  }

  function renderMarketHeader() {
    var m = state.market;
    if (!m) return;
    setText('marketSym', m.symbol + '-USD');
    var badge = $('marketTier');
    if (badge) {
      badge.className = tierClass(m);
      badge.textContent = tierLetter(m);
      badge.title = 'Tier ' + tierLetter(m) + ' · up to x' + maxLev(m);
    }
    var px = marketPrice(m);
    setText('marketPrice', fmtPrice(px, m.szDecimals));
    var c = state.ctx[m.coin];
    var chg = $('marketChange');
    if (chg) {
      var pct = c && c.prevDayPx > 0 && isFinite(px) ? px / c.prevDayPx - 1 : NaN;
      chg.textContent = isFinite(pct) ? fmtPct(pct, true) : '';
      chg.className = 'market-change ' + (pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'muted');
    }
    setText('chipVol', c && isFinite(c.vol24h) ? fmtUsdCompact(c.vol24h) : '—');
    var oi = publicOi(m.symbol, m.instrumentId);
    setText('chipLongOi', oi ? fmtUsdCompact(oi.long) : (hasExchange() ? '—' : 'n/a'));
    setText('chipShortOi', oi ? fmtUsdCompact(oi.short) : (hasExchange() ? '—' : 'n/a'));
    var pill = $('pricePill');
    if (pill) {
      var last = chart.candles.length ? chart.candles[chart.candles.length - 1] : null;
      pill.textContent = m.coin + ' ' + fmtPrice(px, m.szDecimals);
      pill.classList.toggle('pill-pos', !!last && last.c >= last.o);
      pill.classList.toggle('pill-neg', !!last && last.c < last.o);
    }
    document.title = (isFinite(px) ? fmtPrice(px, m.szDecimals) + ' ' : '') + m.symbol + ' — confetti_';
  }

  /* Market menu */

  function buildMarketMenu() {
    var list = $('marketList');
    if (!list) return;
    list.textContent = '';
    var filter = ($('marketFilter') && $('marketFilter').value || '').trim().toLowerCase();
    /* leverage is per coin now (each row says up to x{max}); the tier sets the caps */
    var groups = [['A', 'Tier A'], ['B', 'Tier B'], ['C', 'Tier C']];
    groups.forEach(function (g) {
      var rows = state.markets.filter(function (m) {
        return tierLetter(m) === g[0] && (!filter || m.symbol.toLowerCase().indexOf(filter) !== -1);
      });
      if (!rows.length) return;
      list.appendChild(el('div', 'label market-group', g[1]));
      rows.forEach(function (m) {
        var row = el('button', 'market-row');
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.setAttribute('data-sym', m.symbol);
        row.setAttribute('aria-selected', state.market === m ? 'true' : 'false');
        var onChain = !hasExchange() || !state.instrumentsLoaded || !!m.inst;
        if (!onChain) row.classList.add('is-soon');
        var sym = el('span', 'sym');
        sym.appendChild(el('span', null, m.symbol));
        var b = el('span', tierClass(m), tierLetter(m));
        sym.appendChild(b);
        if (!onChain) sym.appendChild(el('span', 'market-tag', 'soon'));
        else if (m.inst && m.inst.retired) sym.appendChild(el('span', 'market-tag', 'retired'));
        else if (m.inst && m.inst.opensPaused) sym.appendChild(el('span', 'market-tag', 'paused'));
        row.appendChild(sym);
        row.appendChild(el('span', 'px', fmtPrice(marketPrice(m), m.szDecimals)));
        row.appendChild(el('span', 'chg', ''));
        row.appendChild(el('span', 'lev', 'up to x' + maxLev(m)));
        row.addEventListener('click', function () { selectMarket(m.symbol); });
        list.appendChild(row);
      });
    });
    renderMarketMenuPrices();
  }

  function renderMarketMenuPrices() {
    var menu = $('marketMenu');
    if (!menu || menu.hasAttribute('hidden')) return;
    var rows = menu.querySelectorAll('.market-row');
    for (var i = 0; i < rows.length; i++) {
      var m = state.bySym[rows[i].getAttribute('data-sym')];
      if (!m) continue;
      var px = marketPrice(m);
      rows[i].querySelector('.px').textContent = fmtPrice(px, m.szDecimals);
      var c = state.ctx[m.coin];
      var pct = c && c.prevDayPx > 0 && isFinite(px) ? px / c.prevDayPx - 1 : NaN;
      var chg = rows[i].querySelector('.chg');
      chg.textContent = isFinite(pct) ? fmtPct(pct, true) : '';
      chg.className = 'chg ' + (pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'faint');
    }
  }

  function openMarketMenu() {
    var menu = $('marketMenu');
    if (!menu) return;
    buildMarketMenu();
    menu.removeAttribute('hidden');
    $('marketBtn').setAttribute('aria-expanded', 'true');
    var f = $('marketFilter');
    if (f && window.matchMedia && !window.matchMedia('(hover: none)').matches) f.focus();
  }

  function closeMarketMenu() {
    var menu = $('marketMenu');
    if (!menu || menu.hasAttribute('hidden')) return;
    menu.setAttribute('hidden', '');
    $('marketBtn').setAttribute('aria-expanded', 'false');
  }

  function initMarketMenu() {
    var btn = $('marketBtn');
    var menu = $('marketMenu');
    var filter = $('marketFilter');
    if (!btn || !menu) return;
    btn.addEventListener('click', function () {
      if (menu.hasAttribute('hidden')) openMarketMenu(); else closeMarketMenu();
    });
    if (filter) filter.addEventListener('input', buildMarketMenu);
    document.addEventListener('click', function (ev) {
      if (menu.hasAttribute('hidden')) return;
      if (!menu.contains(ev.target) && !btn.contains(ev.target)) closeMarketMenu();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeMarketMenu();
    });
    window.addEventListener('hashchange', function () {
      var sym = decodeURIComponent((location.hash || '').replace(/^#/, ''));
      if (sym && state.bySym[sym] && state.market !== state.bySym[sym]) selectMarket(sym);
    });
  }

  /* ---- settlement maths (ImpactLib port, float, for estimates) --------------- */

  function curveOf(inst) {
    var d = (cfg && cfg.impactDefaults) || {};
    if (inst) {
      return {
        deadbandBps: inst.deadbandBps, baseRate: inst.baseRate, rateMultiplier: inst.rateMultiplier,
        referenceNotional: inst.referenceNotional, positionMultiplier: inst.positionMultiplier
      };
    }
    return {
      deadbandBps: 1, baseRate: (Number(d.baseRateBps) || 1000) / 1e4, rateMultiplier: Number(d.rateMultiplier) || 15000,
      referenceNotional: Number(d.referenceNotionalUsd) || 20000, positionMultiplier: Number(d.positionMultiplier) || 130000000
    };
  }

  /* scale = (1 - baseRate) / (1 + 1/(move * rateMultiplier) + referenceNotional / (move * positionMultiplier)) */
  function impactScale(move, c) {
    if (!(move > 0)) return 0;
    var rateTerm = 1 / (move * c.rateMultiplier);
    var sizeTerm = c.referenceNotional / (move * c.positionMultiplier);
    return (1 - c.baseRate) / (1 + rateTerm + sizeTerm);
  }

  /* Live fee rate (feeBps / 1e4) once read from the exchange, the 5% cap before that. */
  function feeRate() { return house.feeRate != null ? house.feeRate : DEFAULT_FEE_RATE; }

  /* "5%", "2.5%": the fee rate for UI text. */
  function feePctText() { return (feeRate() * 100).toFixed(2).replace(/\.?0+$/, '') + '%'; }

  /* What close() would settle to at price px. Returns { pnl, fee, payout, flat } in USD.
     A position carries the deadband, payout cap and fee rate stamped on it at open
     (pos.deadbandBps / payoutCapX / feeBps) and settles on those; the market's live values
     are only the fallback for a position object that lacks them. The impact curve is live. */
  function estimateClose(pos, inst, px, queueEmpty) {
    var out = { pnl: 0, fee: 0, payout: pos.margin, flat: true };
    if (!(px > 0) || !(pos.entry > 0)) return out;
    var rate = pos.feeBps >= 0 ? pos.feeBps / 1e4 : feeRate();
    var notional = pos.margin * pos.leverage;
    var isWin = pos.isLong ? px > pos.entry : px < pos.entry;
    if (!isWin) {
      var diff = Math.abs(pos.entry - px);
      var loss = Math.min(pos.margin, notional * diff / pos.entry);
      if (loss <= 0) return out;
      var lfee = queueEmpty === false ? 0 : loss * rate;
      return { pnl: -loss, fee: lfee, payout: pos.margin - loss, flat: false };
    }
    var c = curveOf(inst);
    var band = pos.deadbandBps > 0 ? pos.deadbandBps : c.deadbandBps;
    var exit = pos.isLong ? px * (1 - band / 1e4) : px * (1 + band / 1e4);
    if (pos.isLong ? exit <= pos.entry : exit >= pos.entry) return out;
    var move = Math.abs(exit - pos.entry) / pos.entry;
    var gain = notional * move;
    var adjusted = gain * impactScale(move, c);
    /* payout cap (DESIGN 3b): the contract caps the adjusted gain before taking the fee */
    var capX = pos.payoutCapX > 0 ? pos.payoutCapX : (inst ? inst.payoutCapX : 0);
    if (capX > 0) adjusted = Math.min(adjusted, pos.margin * capX);
    var fee = adjusted * rate;
    return { pnl: adjusted - fee, fee: fee, payout: pos.margin + adjusted - fee, flat: false };
  }

  /* The price a fill settles on: the HyperCore oracle price (every open, close and liquidation
     uses it; the book mid on the chart is display only). The on-chain read when the page has
     one, else the same oracle from the Hyperliquid stats feed, else the mid as a rough stand-in. */
  function oraclePriceFor(m) {
    if (!m) return NaN;
    if (m.instrumentId != null) {
      var opx = house.oraclePxById[m.instrumentId];
      if (opx != null && isFinite(opx) && opx > 0) return opx;
    }
    var c = state.ctx[m.coin];
    if (c && isFinite(c.oraclePx) && c.oraclePx > 0) return c.oraclePx;
    return marketPrice(m);
  }

  /* Entry a request filed now would fill at if the oracle does not move (a keeper fills at the
     oracle print a few seconds later; the fallback fill takes the worse of request and fill). */
  function openPriceFor(m) { return oraclePriceFor(m); }

  /* Price a close of the position would settle on now. */
  function closePriceFor(pos) { return oraclePriceFor(positionMarket(pos)); }

  /* Seconds on the chain's clock right now: the latest block timestamp plus the time since it
     was read. The request windows are measured on this clock. */
  function chainNow() {
    if (house.chainTs == null) return Date.now() / 1000;
    return house.chainTs + (Date.now() - house.chainTsAt) / 1000;
  }

  /* The bust move in units of 1 / (lev x 10000), as ImpactLib.bustPrice works it: the smaller
     of 9500 (95% of 1/lev) and 10000 - BUST_GAP_BPS x lev (1/lev minus the gap). */
  function bustMoveUnits(lev) {
    var gap = BUST_GAP_BPS * lev;
    return Math.min(BUST_BUFFER_PCT * 100, gap < 10000 ? 10000 - gap : 0);
  }

  /* The bust move as a percentage of price: 0.05% at 1000x, 9.5% at 10x. */
  function bustMovePct(lev) { return bustMoveUnits(lev) / (lev * 100); }

  /* Bust price, float version of ImpactLib.bustPrice: entry * (den -/+ move) / den. */
  function bustPriceNum(entry, isLong, lev) {
    if (!(entry > 0) || !(lev >= 1)) return NaN;
    var den = lev * 10000;
    var move = bustMoveUnits(lev);
    return isLong ? entry * (den - move) / den : entry * (den + move) / den;
  }

  /* Exact version on the 1e18 entry, same rounding as the contract (long ceil, short floor). */
  function bustPrice18(entryPx18, isLong, lev) {
    var den = BigInt(lev) * 10000n;
    var move = BigInt(bustMoveUnits(lev));
    if (isLong) {
      var num = entryPx18 * (den - move);
      return (num + den - 1n) / den;
    }
    return entryPx18 * (den + move) / den;
  }

  /* ---- order form ------------------------------------------------------------- */

  function levFromSlider(v, max) { return clamp(Math.round(Math.pow(max, v / 1000)), 1, max); }
  function sliderFromLev(l, max) { return max > 1 ? Math.round(1000 * Math.log(l) / Math.log(max)) : 0; }

  function renderLeverage() {
    var m = state.market;
    var max = m ? maxLev(m) : 1000;
    form.lev = clamp(Math.round(form.lev) || 1, 1, max);
    var slider = $('levSlider');
    var input = $('levInput');
    if (slider) slider.value = String(sliderFromLev(form.lev, max));
    if (input) { input.max = String(max); if (document.activeElement !== input) input.value = String(form.lev); }
    setText('levWild', 'Wild x' + max);
  }

  function renderForm() {
    var m = state.market;
    var px = openPriceFor(m);
    var notional = isFinite(form.margin) && form.margin > 0 ? form.margin * form.lev : NaN;
    setText('orderValue', isFinite(notional) ? fmtUsd(notional) : '—');
    setText('bustPrice', fmtPrice(bustPriceNum(px, form.side === 'long', form.lev), m ? m.szDecimals : null));
    /* DESIGN 3b: the payout cap is shown before the user opens. */
    var capX = m && m.inst ? m.inst.payoutCapX : 0;
    setText('maxProfit', capX > 0 && isFinite(form.margin) && form.margin > 0 ? fmtUsd(form.margin * capX * (1 - feeRate())) + ' (x' + capX + ')' : '—');
    /* What a winner keeps and loses: the impact haircut's kept share of a raw gain (on a 0.1%
       and a 1% move, the live curve) and the payout cap; the house's balance sits beside them. */
    var c = curveOf(m && m.inst ? m.inst : null);
    var keptLo = impactScale(0.001, c), keptHi = impactScale(0.01, c);
    setText('keptShare', m ? Math.round(keptLo * 100) + '% to ' + Math.round(keptHi * 100) + '% of a gain' : '—');
    setText('payoutCap', capX > 0 ? 'x' + capX + ' margin, rest forfeited' : '—');
    renderHouseLine();
  }

  /* House balance beside Max Profit: what the house can pay from right now (lpBalance) and what
     queued wins are still owed (queuedTotal). Both come with the house status read every 10 s. */
  function renderHouseLine() {
    var cell = $('houseLp');
    if (!cell) return;
    if (house.lp == null) { cell.textContent = '—'; return; }
    cell.textContent = fmtUsd(house.lp) + (house.queued > 0 ? ' · ' + fmtUsd(house.queued) + ' queued' : '');
  }

  /* The one-time terms acceptance: the line shows until ticked, the tick is remembered and the
     order button stays disabled without it. */
  /* (2026-10-16, the owner: "get rid of the agree checkbox before connect wallet is active. just make the link automatically
     active") no tick needed: Connect and the order button are active from the start; terms.html stays linked in the footer. */
  function termsAccepted() { return true; }

  function initTerms() {
    var gate = $('termsGate');
    var chk = $('termsChk');
    termsOk = lsGet(TERMS_KEY) === '1';
    if (!gate || !chk) return;
    function render() { if (termsAccepted()) gate.setAttribute('hidden', ''); else gate.removeAttribute('hidden'); }
    chk.checked = termsAccepted();
    chk.addEventListener('change', function () {
      if (!chk.checked) return;
      termsOk = true;
      lsSet(TERMS_KEY, '1');
      render();
      renderAction();
    });
    render();
  }

  function renderSide() {
    var seg = $('sideSeg');
    if (!seg) return;
    var items = seg.querySelectorAll('[data-side]');
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute('aria-pressed', items[i].getAttribute('data-side') === form.side ? 'true' : 'false');
    }
  }

  /* Validation problems for the open form, or null when the order can go. */
  function orderProblem() {
    var m = state.market;
    if (!m || !m.inst) return 'Market is not listed on chain yet.';
    if (m.inst.retired) return 'Market retired: closes only.';
    if (house.globalPaused) return 'Opens are paused on every market.';
    if (house.breakerTripped) return 'Opens are paused: the LP loss breaker is tripped.';
    if (m.inst.opensPaused) return 'Opens are paused on this market.';
    if (!isFinite(form.margin) || form.margin < MIN_MARGIN) return 'Minimum margin is ' + MIN_MARGIN + ' USDC.';
    if (form.margin > acct.available + 1e-9) return 'Margin exceeds your available balance.';
    if (form.lev < 1 || form.lev > m.inst.maxLeverage) return 'Leverage must be between x1 and x' + m.inst.maxLeverage + '.';
    if (m.inst.maxNotional > 0 && form.margin * form.lev > m.inst.maxNotional + 1e-6) return 'Exceeds the per-position cap of ' + fmtUsdCompact(m.inst.maxNotional) + ' notional.';
    var oi = house.oi[m.symbol];
    if (oi) {
      var cap = form.side === 'long' ? m.inst.longCap : m.inst.shortCap;
      var used = form.side === 'long' ? oi.long : oi.short;
      var headroom = Math.max(0, cap - used);
      if (form.margin * form.lev > headroom + 1e-6) return 'Exceeds ' + form.side + ' OI headroom (' + fmtUsdCompact(headroom) + ').';
    }
    return null;
  }

  function renderAction() {
    var btn = $('actionBtn');
    var hint = $('actionHint');
    if (!btn) return;
    var m = state.market;
    var sym = m ? m.symbol : '';
    var label, cls = 'btn btn-lg btn-block', disabled = false, note = '', err = false;

    if (!window.ethers) {
      label = 'Wallet library unavailable'; cls += ' btn-accent'; disabled = true; note = 'ethers.js failed to load.'; err = true;
    } else if (!wallet.account) {
      label = 'Connect wallet'; cls += ' btn-accent';
      note = wallet.eth || getInjected() ? '' : 'No wallet detected. Use a wallet browser or extension.';
    } else if (wallet.chainId !== CHAIN_ID) {
      label = 'Switch to HyperEVM'; cls += ' btn-accent'; note = 'Wallet is on chain ' + (wallet.chainId || '?') + '.';
    } else if (!hasExchange()) {
      label = 'Exchange not configured'; cls += ' btn-accent'; disabled = true; note = 'Set contracts.exchange in config.json.'; err = true;
    } else if (!acct.loaded) {
      label = 'Loading account…'; cls += ' btn-accent'; disabled = true;
    } else if (acct.available < MIN_MARGIN) {
      label = 'Deposit to trade'; cls += ' btn-primary';
      note = 'Available ' + fmtUsd(acct.available) + ' · minimum margin ' + MIN_MARGIN + ' USDC.';
    } else {
      label = (form.side === 'long' ? 'Buy ' : 'Sell ') + sym;
      cls += form.side === 'long' ? ' btn-long' : ' btn-short';
      var problem = orderProblem();
      if (problem) { disabled = true; note = problem; err = true; }
      else {
        var px = openPriceFor(m);
        var bust = bustPriceNum(px, form.side === 'long', form.lev);
        note = 'Busts on a ' + bustMovePct(form.lev).toFixed(3) + '% move' + (isFinite(bust) ? ' (' + fmtPrice(bust, m.szDecimals) + ')' : '') + '. Fills in about ' + (house.minDelay + 1) + ' s.';
      }
    }
    if (state.busy) { disabled = true; note = 'Confirm in your wallet…'; err = false; }
    if (!termsAccepted()) disabled = true;
    btn.className = cls;
    btn.textContent = label;
    btn.disabled = disabled;
    if (hint) { hint.textContent = note; hint.classList.toggle('is-err', err); }
    var closeAll = $('closeAllBtn');
    if (closeAll) closeAll.disabled = state.busy || !acct.positions.length;
  }

  function initForm() {
    var seg = $('sideSeg');
    var marginInput = $('marginInput');
    var slider = $('levSlider');
    var levInput = $('levInput');
    var formEl = $('orderForm');

    form.side = lsGet(LS.side) === 'short' ? 'short' : 'long';
    renderSide();

    if (seg) {
      seg.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-side]') : null;
        if (!b) return;
        form.side = b.getAttribute('data-side') === 'short' ? 'short' : 'long';
        lsSet(LS.side, form.side);
        renderSide(); renderForm(); renderAction();
      });
    }
    if (marginInput) {
      marginInput.addEventListener('input', function () {
        var v = Number(marginInput.value);
        form.margin = isFinite(v) && v > 0 ? v : NaN;
        renderForm(); renderAction();
      });
    }
    var quick = document.querySelectorAll('#orderForm .quick [data-mult]');
    for (var i = 0; i < quick.length; i++) {
      quick[i].addEventListener('click', function (ev) {
        var mult = ev.currentTarget.getAttribute('data-mult');
        var base = isFinite(form.margin) ? form.margin : MIN_MARGIN;
        var next = mult === 'max' ? acct.available : base * Number(mult);
        next = Math.floor(next * 100) / 100;
        if (acct.loaded) next = Math.min(next, Math.floor(acct.available * 100) / 100);
        next = Math.max(MIN_MARGIN, next);
        form.margin = next;
        if (marginInput) marginInput.value = String(next);
        renderForm(); renderAction();
      });
    }
    if (slider) {
      slider.addEventListener('input', function () {
        form.lev = levFromSlider(Number(slider.value), state.market ? maxLev(state.market) : 1000);
        if (levInput) levInput.value = String(form.lev);
        if (state.market) lsSet(LS.lev + state.market.symbol, String(form.lev));
        renderForm(); renderAction();
      });
    }
    if (levInput) {
      levInput.addEventListener('input', function () {
        var v = Math.round(Number(levInput.value));
        if (!isFinite(v) || v < 1) return;
        form.lev = clamp(v, 1, state.market ? maxLev(state.market) : 1000);
        if (slider) slider.value = String(sliderFromLev(form.lev, state.market ? maxLev(state.market) : 1000));
        if (state.market) lsSet(LS.lev + state.market.symbol, String(form.lev));
        renderForm(); renderAction();
      });
      levInput.addEventListener('blur', function () { renderLeverage(); });
    }
    if (formEl) {
      formEl.addEventListener('submit', function (ev) {
        ev.preventDefault();
        onAction();
      });
    }
  }

  function onAction() {
    if (state.busy) return;
    if (!window.ethers) return;
    if (!wallet.account) { connect(); return; }
    if (wallet.chainId !== CHAIN_ID) { switchChain().then(function () { return onChainChanged(); }).catch(function (e) { toast(describeError(e), 'err'); }); return; }
    if (!hasExchange()) return;
    if (acct.available < MIN_MARGIN) { openDeposit(); return; }
    if (orderProblem()) { renderAction(); return; }
    submitOpen();
  }

  /* ---- read provider and contract reads -------------------------------------- */

  function makeProvider(url) {
    var E = window.ethers;
    return new E.JsonRpcProvider(url, { chainId: CHAIN_ID, name: 'hyperevm' }, {
      staticNetwork: true,
      batchMaxCount: Number(cfg.rpcBatchMaxCount) >= 1 ? Number(cfg.rpcBatchMaxCount) : 1,
      polling: false
    });
  }

  function initRead() {
    if (!window.ethers || !cfg.rpcUrl) return;
    var E = window.ethers;
    exIface = new E.Interface(EXCHANGE_ABI);
    refIface = new E.Interface(REFERRALS_ABI);
    read.provider = makeProvider(cfg.rpcUrl);
    read.logProvider = cfg.logRpcUrl && cfg.logRpcUrl !== cfg.rpcUrl ? makeProvider(cfg.logRpcUrl) : read.provider;
    if (hasExchange()) read.exchange = new E.Contract(cfg.contracts.exchange, EXCHANGE_ABI, read.provider);
    var refAddr = cfg.contracts && cfg.contracts.referrals;
    if (isAddr(refAddr)) read.referrals = new E.Contract(refAddr, REFERRALS_ABI, read.provider);
  }

  function normInst(r, id) {
    return {
      id: id,
      hlAssetIndex: Number(r.hlAssetIndex), szDecimals: Number(r.szDecimals), tier: Number(r.tier),
      maxLeverage: Number(r.maxLeverage), deadbandBps: Number(r.deadbandBps), clampBps: Number(r.clampBps),
      baseRate: Number(r.baseRateBps) / 1e4, rateMultiplier: Number(r.rateMultiplier),
      referenceNotional: usd6ToNum(r.referenceNotionalUsd), positionMultiplier: Number(r.positionMultiplierE6) / 1e6,
      longCap: usd6ToNum(r.longOiCapUsd), shortCap: usd6ToNum(r.shortOiCapUsd),
      maxNotional: usd6ToNum(r.maxNotionalUsd), payoutCapX: Number(r.payoutCapX),
      opensPaused: !!r.opensPaused, retired: !!r.retired, frozenPx: px18ToNum(r.frozenPx18)
    };
  }

  var instrumentsInFlight = false;

  function loadInstruments() {
    if (!read.exchange || instrumentsInFlight) return Promise.resolve();
    instrumentsInFlight = true;
    var ex = read.exchange;
    return ex.instrumentCount().then(function (n) {
      n = Number(n);
      house.instCount = n;
      var ids = [];
      for (var i = 0; i < n; i++) ids.push(i);
      return Promise.all(ids.map(function (i) { return ex.instrument(i).then(function (r) { return normInst(r, i); }); }));
    }).then(function (insts) {
      state.byInstId = {};
      state.markets.forEach(function (m) { m.inst = null; m.instrumentId = null; });
      insts.forEach(function (inst) {
        state.byInstId[inst.id] = inst;
        var m = state.markets.filter(function (x) { return x.hlAssetIndex === inst.hlAssetIndex; })[0];
        if (m) { m.inst = inst; m.instrumentId = inst.id; inst.market = m; }
      });
      state.instrumentsLoaded = true;
      renderMarketHeader(); renderLeverage(); renderForm(); renderAction(); renderStatus(); renderPositions();
      if (!$('marketMenu').hasAttribute('hidden')) buildMarketMenu();
    }).catch(function (e) {
      toast('Could not read markets from the exchange: ' + describeError(e), 'err');
    }).then(function () { instrumentsInFlight = false; });
  }

  /* Latest block: number for the status tab, timestamp for the request countdowns. */
  function noteBlock(blk) {
    if (!blk) return;
    house.block = Number(blk.number); house.blockAt = Date.now();
    house.chainTs = Number(blk.timestamp); house.chainTsAt = Date.now();
  }

  function refreshHouse() {
    var ex = read.exchange;
    if (!ex) {
      return read.provider ? read.provider.getBlock('latest').then(function (b) { noteBlock(b); renderStatus(); }).catch(function () {}) : Promise.resolve();
    }
    var none = function () { return null; };
    return Promise.all([
      ex.lpBalance(), ex.feePool(), ex.queuedTotal(), ex.queueLength(), ex.queueHead(), ex.globalOpensPaused(), read.provider.getBlock('latest'),
      ex.breakerTripped().catch(function () { return false; }),
      ex.feeBps().catch(none),
      ex.minDelay().catch(none), ex.grace().catch(none), ex.expiry().catch(none),
      ex.maxJumpBps().catch(none), ex.stakerFeeShareBps().catch(none)
    ]).then(function (r) {
      house.lp = usd6ToNum(r[0]); house.feePool = usd6ToNum(r[1]); house.queued = usd6ToNum(r[2]);
      house.queueLen = Number(r[3]); house.queueHead = Number(r[4]); house.globalPaused = !!r[5];
      noteBlock(r[6]); house.breakerTripped = !!r[7];
      if (r[8] != null) house.feeRate = Number(r[8]) / 1e4;
      if (r[9] != null) house.minDelay = Number(r[9]);
      if (r[10] != null) house.grace = Number(r[10]);
      if (r[11] != null) house.expiry = Number(r[11]);
      if (r[12] != null) house.maxJumpBps = Number(r[12]);
      if (r[13] != null) house.stakerShareBps = Number(r[13]);
      renderStatus(); renderAction();
    }).catch(function () { /* transient RPC trouble: keep the last values */ });
  }

  function loadHouseAddresses() {
    var ex = read.exchange;
    if (!ex) return Promise.resolve();
    var names = ['usdc', 'oracle', 'confetti', 'tokenomics', 'staking', 'referrals', 'owner', 'feeRecipient', 'pauseGuardian', 'marketKeeper'];
    return Promise.all(names.map(function (n) { return ex[n]().catch(function () { return null; }); })).then(function (vals) {
      names.forEach(function (n, i) { if (vals[i]) house.addrs[n] = vals[i]; });
      if (isAddr(house.addrs.referrals) && (!read.referrals || read.referrals.target.toLowerCase() !== house.addrs.referrals.toLowerCase())) {
        read.referrals = new window.ethers.Contract(house.addrs.referrals, REFERRALS_ABI, read.provider);
      }
      renderStatus();
    });
  }

  /* The settlement price of a market right now (the oracle; a retired market's frozen price).
     Resolves to null when the feed is dead. */
  function readOraclePx(id) {
    return read.exchange.execPrice(id, true, true).then(function (px) { return px18ToNum(px); }).catch(function () { return null; });
  }

  function refreshMarketChain() {
    var m = state.market;
    var ex = read.exchange;
    if (!m || !ex || m.instrumentId == null) return Promise.resolve();
    var id = m.instrumentId;
    return Promise.all([ex.openInterest(id), ex.instrument(id), readOraclePx(id)]).then(function (r) {
      house.oi[m.symbol] = { long: usd6ToNum(r[0][0]), short: usd6ToNum(r[0][1]) };
      var inst = normInst(r[1], id);
      inst.market = m;
      m.inst = inst;
      state.byInstId[id] = inst;
      house.oraclePxById[id] = r[2];
      loadHouseBotOi();
      renderMarketHeader(); renderLeverage(); renderForm(); renderAction(); renderStatus(); renderAccount(); renderPositions();
    }).catch(function () { /* keep the last values */ });
  }

  function usdcAddress() { return house.addrs.usdc || (cfg.contracts && cfg.contracts.usdc); }

  function refreshAccount() {
    if (!wallet.account || !read.exchange) return Promise.resolve();
    var ex = read.exchange;
    var a = wallet.account;
    var none = function () { return null; };
    return Promise.all([ex.balanceOf(a), ex.marginInUse(a), ex.positionIdsOf(a), ex.pendingOf(a).catch(function () { return 0n; })]).then(function (r) {
      var ids = Array.from(r[2]).map(function (x) { return BigInt(x); });
      /* each position with the contract's own previewClose (exactly what a keeper fill would
         pay now) and its pending close request, if any */
      return Promise.all(ids.map(function (id) {
        return Promise.all([ex.positions(id), ex.previewClose(id).catch(none), ex.closeRequest(id).catch(none)]);
      })).then(function (rows) {
        if (wallet.account !== a) return;
        var positions = [];
        var closeReqs = {};
        rows.forEach(function (row, i) {
          var p = row[0], pv = row[1], cr = row[2];
          if (!p || p.owner === ZERO) return;
          positions.push({
            id: ids[i], instrumentId: Number(p.instrumentId), isLong: !!p.isLong,
            margin: usd6ToNum(p.marginUsdc), leverage: Number(p.leverage),
            entry: px18ToNum(p.entryPx18), entryPx18: BigInt(p.entryPx18), openedAt: Number(p.openedAt),
            /* settlement terms stamped at open (DESIGN 5); the close settles on these */
            deadbandBps: Number(p.deadbandBps), payoutCapX: Number(p.payoutCapX), feeBps: Number(p.feeBps),
            preview: pv ? { pnl: usd6ToNum(pv.pnlUsdc), fee: usd6ToNum(pv.feeUsdc), payout: usd6ToNum(pv.payoutUsdc) } : null
          });
          if (cr && Number(cr.requestedAt) > 0) {
            var known = acct.closeReqs[String(ids[i])];
            closeReqs[String(ids[i])] = { requestedAt: Number(cr.requestedAt), px0: px18ToNum(cr.px0), block: known ? known.block : null, busy: !!(known && known.busy) };
          }
        });
        positions.sort(function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });
        /* the settlement price of every market with a position, for the PnL estimate */
        var instIds = [];
        positions.forEach(function (p) { if (instIds.indexOf(p.instrumentId) < 0) instIds.push(p.instrumentId); });
        return Promise.all(instIds.map(readOraclePx)).then(function (opx) {
          if (wallet.account !== a) return;
          instIds.forEach(function (id, i) { if (opx[i] != null) house.oraclePxById[id] = opx[i]; });
          acct.available = usd6ToNum(r[0]);
          acct.marginInUse = usd6ToNum(r[1]);
          acct.pending = usd6ToNum(r[3]);
          acct.positions = positions;
          acct.closeReqs = closeReqs;
          acct.loaded = true;
          renderAccount(); renderPositions(); renderAction(); renderStatus();
          return discoverPendingOpens();
        });
      });
    }).catch(function (e) {
      if (!acct.loaded) toast('Could not read your account: ' + describeError(e), 'err');
    });
  }

  function refreshWalletUsdc() {
    var E = window.ethers;
    var addr = usdcAddress();
    if (!wallet.account || !read.provider || !isAddr(addr)) return Promise.resolve();
    var usdc = new E.Contract(addr, ERC20_ABI, read.provider);
    var spender = hasExchange() ? cfg.contracts.exchange : null;
    return Promise.all([
      usdc.balanceOf(wallet.account),
      spender ? usdc.allowance(wallet.account, spender) : Promise.resolve(0n)
    ]).then(function (r) {
      acct.walletUsdc = usd6ToNum(r[0]);
      acct.allowance = usd6ToNum(r[1]);
      renderDepositModal();
    }).catch(function () {});
  }

  /* ---- account and positions rendering ---------------------------------------- */

  function positionMarket(pos) {
    var inst = state.byInstId[pos.instrumentId];
    return inst && inst.market ? inst.market : null;
  }

  /* What a close would pay now: the local estimate at the on-chain oracle price when the page
     has read one (what a keeper fill settles on); otherwise the contract's own previewClose
     from the last account read; the stats-feed oracle or the mid as a last resort. */
  function positionEstimate(pos) {
    var inst = state.byInstId[pos.instrumentId];
    var queueEmpty = house.queueLen == null ? true : house.queueHead === house.queueLen;
    var opx = house.oraclePxById[pos.instrumentId];
    var retired = inst && inst.retired;
    if (retired) return estimateClose(pos, inst, inst.frozenPx, queueEmpty);
    if (opx != null && isFinite(opx) && opx > 0) return estimateClose(pos, inst, opx, queueEmpty);
    if (pos.preview) {
      var pv = pos.preview;
      return { pnl: pv.pnl, fee: pv.fee, payout: pv.payout, flat: pv.pnl === 0 && pv.fee === 0 };
    }
    return estimateClose(pos, inst, closePriceFor(pos), queueEmpty);
  }

  function openPnl() {
    var sum = 0, any = false;
    acct.positions.forEach(function (p) {
      var e = positionEstimate(p);
      if (e && !e.flat) { sum += e.pnl; any = true; }
      else if (e) any = true;
    });
    return any ? sum : (acct.positions.length ? NaN : 0);
  }

  function renderAccount() {
    if (!wallet.account || !hasExchange() || !acct.loaded) {
      ['eqEquity', 'eqAvailable', 'eqMargin', 'eqPnl'].forEach(function (id) { setText(id, '—'); });
      var pe = $('eqPnl'); if (pe) pe.className = 'kv-val';
      return;
    }
    var pnl = openPnl();
    setText('eqAvailable', fmtUsd(acct.available));
    setText('eqMargin', fmtUsd(acct.marginInUse + acct.pending));
    var marginEl = $('eqMargin');
    if (marginEl) marginEl.title = acct.pending > 0 ? fmtUsd(acct.pending) + ' of it in requests still filling' : '';
    setText('eqEquity', fmtUsd(acct.available + acct.marginInUse + acct.pending + (isFinite(pnl) ? pnl : 0)));
    var pnlEl = $('eqPnl');
    if (pnlEl) {
      pnlEl.textContent = fmtUsd(pnl, true);
      pnlEl.className = 'kv-val ' + (pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '');
    }
  }

  function sideLev(isLong, lev) { return (isLong ? 'long' : 'short') + ' ' + lev + 'x'; }

  function clearLines(host) {
    var lines = host.querySelectorAll('.pos-line');
    for (var i = 0; i < lines.length; i++) host.removeChild(lines[i]);
  }

  /* Fill the live PnL span of one position line. Only this span depends on the price. */
  function fillPositionPnl(line, p) {
    var m = positionMarket(p);
    var px = closePriceFor(p);
    var est = positionEstimate(p);
    var span = line.querySelector('[data-role="pnl"]');
    if (!span) return;
    var known = isFinite(px) || !!p.preview;
    span.textContent = known ? fmtUsd(est.pnl, true) : '—';
    span.className = est.pnl > 0 ? 'pos' : est.pnl < 0 ? 'neg' : '';
    span.title = known && !est.flat
      ? (isFinite(px) ? 'exit ' + fmtPrice(px, m ? m.szDecimals : null) + ' · ' : '') + 'payout ' + fmtUsd(est.payout) + (est.fee ? ' · fee ' + fmtUsd(est.fee) : '')
      : '';
  }

  /* The three request windows, measured on the chain clock from the request timestamp:
       wait     before minDelay, and the keeper-only grace window after it: nobody but a keeper
                can fill; the page shows a countdown to the end of the keeper window
       fallback after minDelay + grace until expiry: anyone may fill, at the worse of the
                request-time and fill-time oracle prints, and the trader cannot cancel. That is
                an option held by the public against the trader (whoever fills picks the print),
                so the page asks the wallet to fill at once (autoFill) and offers a Fill button
       expired  after expiry: only a cancel (refund) is possible; the page offers it */
  function requestPhase(requestedAt) {
    var e = chainNow() - requestedAt;
    if (e < house.minDelay + house.grace) return { phase: 'wait', left: house.minDelay + house.grace - e };
    if (e <= house.expiry) return { phase: 'fallback', left: house.expiry - e };
    return { phase: 'expired', left: 0 };
  }

  /* Status text and button for a pending request, by phase. */
  function requestStatusText(ph, verb) {
    if (ph.phase === 'wait') return verb + '… ' + Math.max(1, Math.ceil(ph.left)) + 's';
    if (ph.phase === 'fallback') return 'anyone can fill · ' + Math.max(0, Math.floor(ph.left)) + 's';
    return 'expired';
  }

  function requestButtonText(ph) { return ph.phase === 'expired' ? 'Cancel' : ph.phase === 'fallback' ? 'Fill now' : ''; }

  function requestButtonTitle(ph) {
    if (ph.phase === 'fallback') return 'the keeper missed: until expiry anyone may fill this at the worse of the request-time and current oracle prints, and you cannot cancel; filling it yourself now ends that';
    if (ph.phase === 'expired') return 'the request expired: cancel it to get the margin back';
    return '';
  }

  /* The trader's standing consent to the automatic fallback fill (on unless switched off). */
  function autoFillEnabled() {
    var v = lsGet(LS.autoFill);
    return v == null ? true : v === '1';
  }

  /* The contract error name behind a failed transaction, or null. */
  function revertName(err) {
    try {
      var data = revertData(err);
      if (data && exIface) { var p = exIface.parseError(data); if (p) return p.name; }
    } catch (e) { /* not ours */ }
    try { if (err && err.revert && err.revert.name) return err.revert.name; } catch (e) { /* ignore */ }
    return null;
  }

  /* The moment a request enters the fallback window, ask the wallet to fill it: from then on
     anyone may fill it at the trader-worse of p0 and the print of their choosing until expiry
     (52 s by default), and the trader cannot cancel; the trader's own worst-of fill ends that
     option. One prompt per request (a rejected prompt leaves the Fill now button); one second
     into the window so the transaction cannot land inside the keeper window; one wallet
     transaction at a time. Runs on the countdown tick while anything is pending. */
  function autoFill() {
    if (state.busy || !autoFillEnabled() || !wallet.account || !wallet.signer || wallet.chainId !== CHAIN_ID) return;
    var from = house.minDelay + house.grace + 1;
    var now = chainNow();
    var opens = pendingOpenList();
    for (var i = 0; i < opens.length; i++) {
      var r = opens[i];
      if (r.busy || r.prompted || r.requestedAt == null) continue;
      var e = now - r.requestedAt;
      if (e >= from && e <= house.expiry) { r.prompted = true; executeOpenNow(r); return; }
    }
    var pids = Object.keys(acct.closeReqs);
    for (var j = 0; j < pids.length; j++) {
      var cr = acct.closeReqs[pids[j]];
      if (cr.busy || cr.prompted || cr.requestedAt == null) continue;
      var e2 = now - cr.requestedAt;
      if (e2 < from || e2 > house.expiry) continue;
      var p = null;
      for (var k = 0; k < acct.positions.length; k++) {
        if (String(acct.positions[k].id) === pids[j]) { p = acct.positions[k]; break; }
      }
      if (!p) continue;
      cr.prompted = true;
      executeCloseNow(p);
      return;
    }
  }

  /* One .pos-line per pending open request: sym, #r id, side+lev, margin, p0, status, [button]. */
  function pendingOpenLine(r) {
    var inst = state.byInstId[r.instrumentId];
    var m = inst && inst.market ? inst.market : null;
    var sz = m ? m.szDecimals : null;
    var line = el('div', 'pos-line is-pending');
    line.setAttribute('data-req', r.id);
    line.appendChild(el('span', 'sym', m ? m.symbol : '#' + r.instrumentId));
    line.appendChild(el('span', 'faint xs', '#r' + r.id));
    line.appendChild(el('span', r.isLong ? 'pos' : 'neg', sideLev(r.isLong, r.leverage)));
    var margin = el('span', null, fmtUsd(r.margin));
    margin.title = 'margin · size ' + fmtUsd(r.margin * r.leverage);
    line.appendChild(margin);
    var px = el('span', null, fmtPrice(r.px0, sz));
    px.title = 'oracle price when you asked';
    line.appendChild(px);
    var status = el('span', 'faint');
    status.setAttribute('data-role', 'status');
    line.appendChild(status);
    line.appendChild(el('span', 'grow'));
    var btn = el('button', 'btn btn-sm btn-ghost');
    btn.type = 'button';
    btn.setAttribute('data-role', 'action');
    btn.addEventListener('click', function () {
      var ph = requestPhase(r.requestedAt);
      if (ph.phase === 'fallback') executeOpenNow(r);
      else if (ph.phase === 'expired') cancelOpenNow(r);
    });
    line.appendChild(btn);
    fillRequestStatus(line, r.requestedAt, 'filling');
    return line;
  }

  /* Fill the status span and the action button of a pending line from its phase. */
  function fillRequestStatus(line, requestedAt, verb) {
    var ph = requestPhase(requestedAt);
    var status = line.querySelector('[data-role="status"]');
    var btn = line.querySelector('[data-role="action"]');
    if (status) {
      status.textContent = requestStatusText(ph, verb);
      status.className = ph.phase === 'wait' ? 'faint' : 'neg';
    }
    if (btn) {
      var label = requestButtonText(ph);
      btn.textContent = label;
      btn.title = requestButtonTitle(ph);
      btn.disabled = state.busy || !label;
      if (label) btn.removeAttribute('hidden'); else btn.setAttribute('hidden', '');
    }
  }

  /* One .pos-line per open position: sym, side+lev, margin, entry, bust, pnl, [Close]. With a
     close request pending the Close button gives way to the request status and its button. */
  function positionLine(p) {
    var m = positionMarket(p);
    var sz = m ? m.szDecimals : null;
    var line = el('div', 'pos-line');
    line.setAttribute('data-id', String(p.id));
    line.appendChild(el('span', 'sym', m ? m.symbol : '#' + p.instrumentId));
    line.appendChild(el('span', 'faint xs', '#' + p.id));
    line.appendChild(el('span', p.isLong ? 'pos' : 'neg', sideLev(p.isLong, p.leverage)));
    var margin = el('span', null, fmtUsd(p.margin));
    margin.title = 'margin · size ' + fmtUsd(p.margin * p.leverage);
    line.appendChild(margin);
    var entry = el('span', null, fmtPrice(p.entry, sz));
    entry.setAttribute('data-role', 'entry'); entry.title = 'entry';
    line.appendChild(entry);
    var bust = el('span', 'neg', fmtPrice(px18ToNum(bustPrice18(p.entryPx18, p.isLong, p.leverage)), sz));
    bust.setAttribute('data-role', 'bust'); bust.title = 'bust';
    line.appendChild(bust);
    var pnl = el('span');
    pnl.setAttribute('data-role', 'pnl');
    line.appendChild(pnl);
    line.appendChild(el('span', 'grow'));
    var cr = acct.closeReqs[String(p.id)];
    if (cr) {
      line.classList.add('is-pending');
      var status = el('span', 'faint');
      status.setAttribute('data-role', 'status');
      line.appendChild(status);
      var act = el('button', 'btn btn-sm btn-ghost');
      act.type = 'button';
      act.setAttribute('data-role', 'action');
      act.addEventListener('click', function () {
        var ph = requestPhase(cr.requestedAt);
        if (ph.phase === 'fallback') executeCloseNow(p);
        else if (ph.phase === 'expired') cancelCloseNow(p);
      });
      line.appendChild(act);
      fillRequestStatus(line, cr.requestedAt, 'closing');
    } else {
      var btn = el('button', 'btn btn-sm btn-ghost', 'Close');
      btn.type = 'button';
      btn.setAttribute('data-id', String(p.id));
      btn.disabled = state.busy;
      btn.addEventListener('click', function () { submitClose(p); });
      line.appendChild(btn);
    }
    fillPositionPnl(line, p);
    return line;
  }

  function pendingOpenList() {
    return Object.keys(pend.opens).map(function (k) { return pend.opens[k]; }).sort(function (a, b) { return Number(a.id) - Number(b.id); });
  }

  function renderPositions() {
    var host = $('posLines');
    var empty = $('posEmpty');
    if (!host) return;
    var opens = pendingOpenList();
    var n = acct.positions.length + opens.length;
    setText('posCount', n ? ' ' + n : '');
    clearLines(host);
    if (!wallet.account) { empty.textContent = 'Connect a wallet to see your positions.'; empty.removeAttribute('hidden'); return; }
    if (!hasExchange()) { empty.textContent = 'Exchange address not configured.'; empty.removeAttribute('hidden'); return; }
    if (!acct.loaded) { empty.textContent = 'Loading…'; empty.removeAttribute('hidden'); return; }
    if (!n) { empty.textContent = 'No open positions.'; empty.removeAttribute('hidden'); return; }
    empty.setAttribute('hidden', '');
    var frag = document.createDocumentFragment();
    opens.forEach(function (r) { frag.appendChild(pendingOpenLine(r)); });
    acct.positions.forEach(function (p) { frag.appendChild(positionLine(p)); });
    host.appendChild(frag);
    watchPending();
  }

  /* Cheap per-tick update of the price-dependent span without rebuilding lines. */
  function updatePositionPrices() {
    var host = $('posLines');
    if (!host || !acct.positions.length) return;
    acct.positions.forEach(function (p) {
      var line = host.querySelector('.pos-line[data-id="' + String(p.id) + '"]');
      if (line) fillPositionPnl(line, p);
    });
  }

  /* Countdown tick: the status text and button of every pending line, four times a second,
     then the automatic fallback fill when a request has just left the keeper window. */
  function updatePendingLines() {
    var host = $('posLines');
    if (!host) return;
    pendingOpenList().forEach(function (r) {
      var line = host.querySelector('.pos-line[data-req="' + r.id + '"]');
      if (line) fillRequestStatus(line, r.requestedAt, 'filling');
    });
    Object.keys(acct.closeReqs).forEach(function (pid) {
      var line = host.querySelector('.pos-line[data-id="' + pid + '"]');
      if (line) fillRequestStatus(line, acct.closeReqs[pid].requestedAt, 'closing');
    });
    autoFill();
  }

  function onPrices() {
    var m = state.market;
    if (m) {
      var px = state.mids[m.coin];
      if (isFinite(px)) updateChartFromMid(px);
    }
    renderMarketHeader();
    renderForm();
    renderMarketMenuPrices();
    updatePositionPrices();
    renderAccount();
    if (!wallet.account || acct.positions.length === 0) renderAction();
  }

  /* ---- wallet ------------------------------------------------------------------ */

  var announced = [];

  function listenForProviders() {
    window.addEventListener('eip6963:announceProvider', function (ev) {
      if (ev && ev.detail && ev.detail.provider) announced.push(ev.detail);
    });
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) { /* ignore */ }
  }

  function getInjected() {
    var eth = window.ethereum;
    if (eth) {
      if (Array.isArray(eth.providers) && eth.providers.length) {
        var mm = eth.providers.filter(function (p) { return p.isMetaMask; })[0];
        return mm || eth.providers[0];
      }
      return eth;
    }
    return announced.length ? announced[0].provider : null;
  }

  function connect() {
    var E = window.ethers;
    var eth = getInjected();
    if (!eth) { toast('No wallet found. Open this page in a wallet browser or install a wallet extension.', 'err'); return Promise.resolve(); }
    wallet.eth = eth;
    return eth.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
      if (!accounts || !accounts.length) throw new Error('No account returned by the wallet.');
      wallet.account = E.getAddress(accounts[0]);
      return eth.request({ method: 'eth_chainId' });
    }).then(function (hex) {
      wallet.chainId = parseInt(hex, 16);
      subscribeWallet(eth);
      return onChainChanged();
    }).then(function () {
      if (wallet.chainId !== CHAIN_ID) return switchChain().then(function () { return onChainChanged(); }).catch(function (e) { toast(describeError(e), 'err'); });
    }).catch(function (e) {
      toast(describeError(e), 'err');
      renderWallet(); renderAction();
    });
  }

  /* Reconnect silently when the wallet already authorised this site. */
  function tryAutoConnect() {
    var E = window.ethers;
    var eth = getInjected();
    if (!eth || !E) return;
    eth.request({ method: 'eth_accounts' }).then(function (accounts) {
      if (!accounts || !accounts.length) return;
      wallet.eth = eth;
      wallet.account = E.getAddress(accounts[0]);
      return eth.request({ method: 'eth_chainId' }).then(function (hex) {
        wallet.chainId = parseInt(hex, 16);
        subscribeWallet(eth);
        return onChainChanged();
      });
    }).catch(function () { /* stay disconnected */ });
  }

  function subscribeWallet(eth) {
    if (wallet.subscribed || typeof eth.on !== 'function') return;
    wallet.subscribed = true;
    eth.on('accountsChanged', function (accounts) {
      if (!accounts || !accounts.length) { disconnect(); return; }
      var next = window.ethers.getAddress(accounts[0]);
      if (next === wallet.account) return;
      wallet.account = next;
      resetAccount();
      toast('Account changed to ' + shortAddr(next));
      onChainChanged();
    });
    eth.on('chainChanged', function (hex) {
      wallet.chainId = parseInt(hex, 16);
      onChainChanged();
    });
    eth.on('disconnect', function () { disconnect(); });
  }

  function onChainChanged() {
    var E = window.ethers;
    if (wallet.eth && wallet.account) {
      wallet.provider = new E.BrowserProvider(wallet.eth);
      return wallet.provider.getSigner().then(function (s) {
        wallet.signer = s;
      }).catch(function () { wallet.signer = null; }).then(function () {
        renderWallet(); renderAction(); renderStatus(); renderPositions(); renderRefer();
        if (wallet.chainId !== CHAIN_ID) toast('Wallet is on chain ' + wallet.chainId + '. Switch to HyperEVM (999) to trade.', 'err');
        restorePendingOpens();
        return Promise.all([refreshAccount(), refreshWalletUsdc(), loadHistory(true), loadReferral()]);
      });
    }
    renderWallet(); renderAction(); renderStatus();
    return Promise.resolve();
  }

  function switchChain() {
    var eth = wallet.eth || getInjected();
    if (!eth) return Promise.reject(new Error('No wallet.'));
    return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] }).catch(function (err) {
      var code = err && (err.code != null ? err.code : (err.data && err.data.originalError && err.data.originalError.code));
      var msg = String((err && err.message) || '');
      var unknownChain = code === 4902 || code === -32603 || /4902|unrecognized|not added|unknown chain/i.test(msg);
      if (!unknownChain) throw err;
      return eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_HEX,
          chainName: cfg.chainName || 'HyperEVM',
          rpcUrls: [cfg.rpcUrl],
          nativeCurrency: cfg.nativeCurrency || { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
          blockExplorerUrls: cfg.explorerUrl ? [cfg.explorerUrl] : []
        }]
      });
    }).then(function () {
      return eth.request({ method: 'eth_chainId' });
    }).then(function (hex) {
      wallet.chainId = parseInt(hex, 16);
      if (wallet.chainId !== CHAIN_ID) throw new Error('Wallet is still on chain ' + wallet.chainId + '.');
    });
  }

  function resetAccount() {
    acct.loaded = false; acct.available = 0; acct.marginInUse = 0; acct.pending = 0; acct.positions = []; acct.closeReqs = {}; acct.walletUsdc = 0; acct.allowance = 0;
    pend.opens = {};
    ref.addr = null; ref.locked = null; ref.referrer = null; ref.myCode = ''; ref.earned = null; ref.loaded = false;
    hist = freshHistory();
    renderAccount(); renderPositions(); renderHistory(); renderRefer();
  }

  function disconnect() {
    wallet.account = null; wallet.signer = null; wallet.provider = null; wallet.chainId = null;
    resetAccount();
    renderWallet(); renderAction(); renderStatus();
    toast('Disconnected from this page. Your wallet may still list the site as connected.');
  }

  function renderWallet() {
    var btn = $('connectBtn');
    if (!btn) return;
    if (wallet.account) {
      btn.textContent = shortAddr(wallet.account);
      btn.title = wallet.account + ' · click to disconnect';
      btn.classList.toggle('btn-accent', wallet.chainId !== CHAIN_ID);
    } else {
      btn.textContent = 'Connect';
      btn.title = '';
      btn.classList.add('btn-accent');
    }
  }

  /* ---- error decoding ------------------------------------------------------------ */

  function walkError(err, fn) {
    var e = err, n = 0;
    while (e && n++ < 8) {
      if (fn(e)) return true;
      e = (e.info && e.info.error) || e.error || e.cause || null;
    }
    return false;
  }

  function isUserRejection(err) {
    return walkError(err, function (e) {
      return e.code === 4001 || e.code === 'ACTION_REJECTED' || /user (rejected|denied|cancel)/i.test(String(e.message || ''));
    });
  }

  function revertData(err) {
    var data = null;
    walkError(err, function (e) {
      var d = e.data;
      if (d && typeof d === 'object' && typeof d.data === 'string') d = d.data;
      if (typeof d === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(d)) { data = d; return true; }
      return false;
    });
    return data;
  }

  var FRIENDLY = {
    Unauthorized: function () { return 'Not authorised for this action.'; },
    ZeroAddress: function () { return 'Zero address.'; },
    ZeroAmount: function () { return 'Amount must be more than zero.'; },
    UnknownInstrument: function (a) { return 'Unknown market #' + a[0] + '.'; },
    MarketRetired: function () { return 'Market retired: closes only.'; },
    OpensPausedGlobally: function () { return 'Opens are paused on every market.'; },
    OpensPausedForMarket: function () { return 'Opens are paused on this market.'; },
    MarginBelowMinimum: function () { return 'Margin is below the minimum ' + MIN_MARGIN + ' USDC.'; },
    LeverageOutOfRange: function () { return 'Leverage is over this market\'s cap.'; },
    OiCapExceeded: function () { return 'No OI headroom on this side.'; },
    PositionTooLarge: function () { return 'Over the per-position notional cap.'; },
    OpensPausedByBreaker: function () { return 'Opens are paused: the LP loss breaker is tripped.'; },
    BreakerNotTripped: function () { return 'The LP breaker is not tripped.'; },
    FeedAlive: function (a) { return 'Market #' + a[0] + ' still has a live price feed; retire it normally.'; },
    InsufficientBalance: function (a) { return 'Insufficient exchange balance: available ' + fmtUsd(usd6ToNum(a[0])) + ', needed ' + fmtUsd(usd6ToNum(a[1])) + '.'; },
    UnknownPosition: function (a) { return 'Position #' + a[0] + ' does not exist (already closed or liquidated).'; },
    NotPositionOwner: function (a) { return 'Position #' + a[0] + ' is not owned by this wallet.'; },
    NotLiquidatable: function (a) { return 'Position #' + a[0] + ' is not at its bust price (' + fmtPrice(px18ToNum(a[1])) + ' vs ' + fmtPrice(px18ToNum(a[2])) + ').'; },
    InvalidTier: function (a) { return 'Invalid tier ' + a[0] + '.'; },
    ParamOutOfBounds: function (a) { return 'Parameter out of bounds (' + a[1] + ').'; },
    QueueEmpty: function () { return 'The payout queue is empty.'; },
    QueueNotEmpty: function () { return 'Not allowed while the payout queue is active.'; },
    NothingToPush: function () { return 'Nothing to push right now.'; },
    UnknownRequest: function () { return 'No such request: it was already filled, refunded or cancelled.'; },
    TooEarly: function () { return 'Too early: the fill window has not opened yet.'; },
    KeeperWindow: function () { return 'Keeper window: wait a few seconds, then fill.'; },
    RequestExpired: function () { return 'The request expired: cancel it for the refund.'; },
    RequestNotExpired: function () { return 'The request has not expired yet.'; },
    CloseAlreadyPending: function () { return 'A close is already pending on this position.'; },
    PriceJumped: function () { return 'The oracle jumped too far since the request.'; },
    EntryBusted: function () { return 'The fill would already be past its bust price; the request is refunded.'; },
    FeedUnavailable: function (a) { return 'Price feed unavailable for market #' + a[0] + '. Try again in a moment.'; },
    ZeroPrice: function (a) { return 'Price feed returned zero for market #' + a[0] + '.'; },
    ClampOutOfBounds: function (a) { return 'Clamp ' + a[0] + ' bps is out of bounds.'; },
    InvalidCode: function () { return 'Codes are 3 to 16 characters: a-z, 0-9, underscore.'; },
    CodeTaken: function (a) { return 'Code "' + a[0] + '" is taken.'; },
    AlreadyRegistered: function () { return 'This wallet already has a code.'; },
    NotExchange: function () { return 'Exchange only.'; },
    OwnableUnauthorizedAccount: function () { return 'Owner only.'; },
    ReentrancyGuardReentrantCall: function () { return 'Reentrant call blocked.'; },
    SafeERC20FailedOperation: function () { return 'USDC transfer failed.'; },
    ERC20InsufficientAllowance: function (a) { return 'USDC allowance too low: approved ' + fmtUsd(usd6ToNum(a[1])) + ', needed ' + fmtUsd(usd6ToNum(a[2])) + '.'; },
    ERC20InsufficientBalance: function (a) { return 'Wallet USDC too low: balance ' + fmtUsd(usd6ToNum(a[1])) + ', needed ' + fmtUsd(usd6ToNum(a[2])) + '.'; }
  };

  function friendly(name, args) {
    var f = FRIENDLY[name];
    try { if (f) return f(args || []); } catch (e) { /* fall through */ }
    var list = [];
    try { list = Array.from(args || []).map(function (x) { return String(x); }); } catch (e) { /* ignore */ }
    return 'Reverted: ' + name + '(' + list.join(', ') + ')';
  }

  /* Short text for the `reason` selector of a refund or cancel event. */
  var REASONS = {
    RequestExpired: 'expired', PriceJumped: 'price jumped', EntryBusted: 'fill past bust', MarketRetired: 'market retired',
    OpensPausedGlobally: 'opens paused', OpensPausedForMarket: 'opens paused', OpensPausedByBreaker: 'breaker tripped',
    LeverageOutOfRange: 'leverage over the cap', PositionTooLarge: 'over the position cap', OiCapExceeded: 'no OI headroom',
    MarginBelowMinimum: 'margin below minimum', UnknownPosition: 'liquidated first'
  };

  function reasonText(selector) {
    var name = null;
    try { var f = exIface && exIface.getError(selector); if (f) name = f.name; } catch (e) { /* unknown selector */ }
    if (!name) return String(selector || '').slice(0, 10);
    return REASONS[name] || name;
  }

  function decodeRevert(data) {
    var E = window.ethers;
    if (exIface) {
      try { var p = exIface.parseError(data); if (p) return friendly(p.name, p.args); } catch (e) { /* not ours */ }
    }
    if (refIface) {
      try { var q = refIface.parseError(data); if (q) return friendly(q.name, q.args); } catch (e) { /* not ours */ }
    }
    try {
      if (data.slice(0, 10) === '0x08c379a0') {
        return 'Reverted: ' + E.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
      }
      if (data.slice(0, 10) === '0x4e487b71') {
        return 'Reverted: panic 0x' + E.AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + data.slice(10))[0].toString(16);
      }
    } catch (e) { /* ignore */ }
    return 'Reverted with data ' + data.slice(0, 10) + '…';
  }

  function describeError(err) {
    if (!err) return 'Unknown error.';
    if (typeof err === 'string') return err;
    if (isUserRejection(err)) return 'Rejected in wallet.';
    var data = revertData(err);
    if (data) return decodeRevert(data);
    if (err.revert && err.revert.name) return friendly(err.revert.name, err.revert.args);
    var text = null;
    walkError(err, function (e) {
      if (e.reason && typeof e.reason === 'string') { text = e.reason; return true; }
      if (e.shortMessage) { text = e.shortMessage; return true; }
      return false;
    });
    if (!text) text = String(err.message || err);
    text = text.replace(/\s*\(.*action=.*$/s, '').replace(/^execution reverted:?\s*/i, 'Reverted: ');
    if (/insufficient funds/i.test(text)) return 'Not enough HYPE for gas.';
    return text.length > 220 ? text.slice(0, 220) + '…' : text;
  }

  /* ---- transactions -------------------------------------------------------------- */

  function requireSigner() {
    if (!window.ethers) throw new Error('ethers.js not loaded.');
    if (!wallet.account || !wallet.signer) throw new Error('Connect a wallet first.');
    if (wallet.chainId !== CHAIN_ID) throw new Error('Switch the wallet to HyperEVM (999) first.');
    if (!hasExchange()) throw new Error('Exchange address not configured.');
  }

  function exchangeWrite() { return new window.ethers.Contract(cfg.contracts.exchange, EXCHANGE_ABI, wallet.signer); }
  function usdcWrite() { return new window.ethers.Contract(usdcAddress(), ERC20_ABI, wallet.signer); }

  function setBusy(on) {
    state.busy = !!on;
    renderAction();
    var closes = document.querySelectorAll('#posLines .btn');
    for (var i = 0; i < closes.length; i++) closes[i].disabled = state.busy;
    ['depositSubmit', 'withdrawSubmit'].forEach(function (id) { var b = $(id); if (b) b.disabled = state.busy; });
  }

  function txLink(hash) { return { href: explorer('tx', hash), label: shortAddr(hash) }; }

  /* Dry-run with eth_call for a decoded revert reason, send, then wait for one confirmation. */
  function sendTx(desc, method, args) {
    return method.staticCall.apply(method, args).then(function () {
      return method.apply(null, args);
    }).then(function (tx) {
      var pending = toast(desc + ' sent, waiting for confirmation…', 'pending', txLink(tx.hash), 0);
      return tx.wait().then(function (rc) {
        dismissToast(pending);
        if (!rc || rc.status !== 1) throw new Error(desc + ' reverted on chain.');
        return rc;
      }, function (e) { dismissToast(pending); throw e; });
    });
  }

  function receiptEvents(rc, name) {
    var out = [];
    (rc.logs || []).forEach(function (log) {
      try {
        var p = exIface.parseLog({ topics: Array.from(log.topics), data: log.data });
        if (p && p.name === name) out.push(p);
      } catch (e) { /* other contract's log */ }
    });
    return out;
  }

  function afterTx() {
    return Promise.all([refreshAccount(), refreshWalletUsdc(), refreshHouse(), refreshMarketChain(), loadReferral()]).then(function () {
      return loadHistory(true);
    });
  }

  /* The referrer to pass with requestOpen: the stored ?ref code's address until the account's
     referrer is locked on chain (its first executed open); zero otherwise. Never self. */
  function referrerArg() {
    if (ref.locked || !isAddr(ref.addr)) return ZERO;
    if (wallet.account && ref.addr.toLowerCase() === wallet.account.toLowerCase()) return ZERO;
    return ref.addr;
  }

  /* Step one of an open: file the request. The margin leaves the available balance and the
     request shows under Positions as "filling…"; a keeper fills it a few seconds later. */
  function submitOpen() {
    var m = state.market;
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return; }
    if (!m || m.instrumentId == null) return;
    var margin6 = numToUsd6(form.margin);
    var isLong = form.side === 'long';
    var lev = form.lev;
    var desc = (isLong ? 'Buy ' : 'Sell ') + m.symbol + ' x' + lev;
    setBusy(true);
    var ex = exchangeWrite();
    sendTx(desc, ex.requestOpen, [m.instrumentId, isLong, margin6, lev, referrerArg()]).then(function (rc) {
      var ev = receiptEvents(rc, 'OpenRequested')[0];
      if (ev) {
        var a = ev.args;
        trackOpenRequest({
          id: String(a.requestId), instrumentId: Number(a.instrumentId), isLong: !!a.isLong,
          margin: usd6ToNum(a.marginUsdc), leverage: Number(a.leverage), px0: px18ToNum(a.px0),
          requestedAt: null, block: Number(rc.blockNumber)
        });
        toast('Asked: ' + (isLong ? 'long ' : 'short ') + m.symbol + ' x' + lev + ', margin ' + fmtUsd(form.margin) + '. Filling in about ' + (house.minDelay + 1) + ' s.', 'ok', txLink(rc.hash));
      } else {
        toast(desc + ' confirmed.', 'ok', txLink(rc.hash));
      }
      return afterTx();
    }).catch(function (e) {
      toast(desc + ' failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* The fallback fill from the user's own wallet (after the keeper window, before expiry). */
  function executeOpenNow(r) {
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return; }
    var inst = state.byInstId[r.instrumentId];
    var desc = 'Fill #r' + r.id + (inst && inst.market ? ' ' + inst.market.symbol : '');
    setBusy(true);
    r.busy = true; /* the poll leaves it alone while the wallet transaction is out */
    var ex = exchangeWrite();
    sendTx(desc, ex.executeOpen, [BigInt(r.id)]).then(function (rc) {
      reportOpenOutcome(r, rc.logs || [], rc.hash);
      untrackOpenRequest(r.id);
      return afterTx();
    }).catch(function (e) {
      r.busy = false;
      var name = revertName(e);
      /* the page clock ran a hair ahead of the chain: the next tick asks again */
      if (name === 'KeeperWindow' || name === 'TooEarly') { r.prompted = false; return; }
      /* someone else filled or refunded it first: the poll reports what happened */
      if (name === 'UnknownRequest') return;
      toast(desc + ' failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* Refund of an expired open request. */
  function cancelOpenNow(r) {
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return; }
    var desc = 'Cancel #r' + r.id;
    setBusy(true);
    r.busy = true;
    var ex = exchangeWrite();
    sendTx(desc, ex.cancelOpen, [BigInt(r.id)]).then(function (rc) {
      toast('Refunded #r' + r.id + ': ' + fmtUsd(r.margin) + ' back to available.', 'ok', txLink(rc.hash));
      untrackOpenRequest(r.id);
      return afterTx();
    }).catch(function (e) {
      r.busy = false;
      toast(desc + ' failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* Step one of a close: file the request; the position line shows "closing…". */
  function submitClose(pos) {
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(false); }
    var m = positionMarket(pos);
    var desc = 'Close #' + pos.id + (m ? ' ' + m.symbol : '');
    setBusy(true);
    var ex = exchangeWrite();
    return sendTx(desc, ex.requestClose, [pos.id]).then(function (rc) {
      var ev = receiptEvents(rc, 'CloseRequested')[0];
      acct.closeReqs[String(pos.id)] = {
        requestedAt: chainNow(), px0: ev ? px18ToNum(ev.args.px0) : NaN, block: Number(rc.blockNumber)
      };
      toast('Closing #' + pos.id + (m ? ' ' + m.symbol : '') + ' in about ' + (house.minDelay + 1) + ' s.', 'ok', txLink(rc.hash));
      renderPositions();
      return afterTx().then(function () { return true; });
    }).catch(function (e) {
      toast(desc + ' failed: ' + describeError(e), 'err');
      return false;
    }).then(function (ok) { setBusy(false); return ok; });
  }

  /* The fallback close fill from the user's own wallet. */
  function executeCloseNow(pos) {
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return; }
    var m = positionMarket(pos);
    var desc = 'Fill close #' + pos.id + (m ? ' ' + m.symbol : '');
    var cr = acct.closeReqs[String(pos.id)];
    setBusy(true);
    if (cr) cr.busy = true;
    var ex = exchangeWrite();
    sendTx(desc, ex.executeClose, [pos.id]).then(function (rc) {
      reportCloseOutcome(pos.id, rc.logs || [], rc.hash);
      delete acct.closeReqs[String(pos.id)];
      return afterTx();
    }).catch(function (e) {
      if (cr) cr.busy = false;
      var name = revertName(e);
      if (name === 'KeeperWindow' || name === 'TooEarly') { if (cr) cr.prompted = false; return; }
      if (name === 'UnknownRequest') return; /* closed, liquidated or cancelled first: the poll reports it */
      toast(desc + ' failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* Drop an expired close request; the position stays open. */
  function cancelCloseNow(pos) {
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return; }
    var desc = 'Cancel close #' + pos.id;
    var cr = acct.closeReqs[String(pos.id)];
    setBusy(true);
    if (cr) cr.busy = true;
    var ex = exchangeWrite();
    sendTx(desc, ex.cancelClose, [pos.id]).then(function (rc) {
      toast('Close request on #' + pos.id + ' cancelled; the position stays open.', 'ok', txLink(rc.hash));
      delete acct.closeReqs[String(pos.id)];
      return afterTx();
    }).catch(function (e) {
      if (cr) cr.busy = false;
      toast(desc + ' failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  function closeAll() {
    if (state.busy || !acct.positions.length) return;
    var list = acct.positions.filter(function (p) { return !acct.closeReqs[String(p.id)]; });
    if (!list.length) return;
    (function next(i) {
      if (i >= list.length) return;
      submitClose(list[i]).then(function (ok) { if (ok) next(i + 1); else toast('Close all stopped at #' + list[i].id + '.', 'err'); });
    })(0);
  }

  /* ---- pending requests: tracking, watching, outcomes --------------------------- */

  function pendingKey() { return wallet.account ? LS.pending + wallet.account.toLowerCase() : null; }

  function savePendingIds() {
    var k = pendingKey();
    if (k) lsSet(k, JSON.stringify(Object.keys(pend.opens)));
  }

  function trackOpenRequest(r) {
    pend.opens[r.id] = r;
    savePendingIds();
    if (r.requestedAt == null) {
      /* the request's own timestamp from chain, so the countdown runs on the chain clock */
      read.exchange.openRequest(BigInt(r.id)).then(function (q) {
        if (q && q.trader !== ZERO) r.requestedAt = Number(q.requestedAt);
        else r.requestedAt = chainNow();
      }).catch(function () { r.requestedAt = chainNow(); }).then(function () { renderPositions(); });
      r.requestedAt = chainNow();
    }
    renderPositions();
  }

  function untrackOpenRequest(id) {
    delete pend.opens[id];
    savePendingIds();
    renderPositions();
  }

  /* After a reload: the request ids this account was watching, verified on chain. */
  function restorePendingOpens() {
    var k = pendingKey();
    if (!k || !read.exchange) return;
    var ids = [];
    try { ids = JSON.parse(lsGet(k) || '[]'); } catch (e) { ids = []; }
    if (!Array.isArray(ids)) return;
    ids.forEach(function (id) { if (!pend.opens[id]) loadOpenRequest(String(id)); });
  }

  /* Read one open request from chain into the watch list (nothing when it is gone). */
  function loadOpenRequest(id, block) {
    return read.exchange.openRequest(BigInt(id)).then(function (q) {
      if (!q || q.trader === ZERO || !wallet.account || q.trader.toLowerCase() !== wallet.account.toLowerCase()) return false;
      pend.opens[id] = {
        id: id, instrumentId: Number(q.instrumentId), isLong: !!q.isLong, margin: usd6ToNum(q.marginUsdc),
        leverage: Number(q.leverage), px0: px18ToNum(q.px0), requestedAt: Number(q.requestedAt), block: block || null
      };
      savePendingIds();
      renderPositions();
      return true;
    }).catch(function () { return false; });
  }

  /* Margin the page already attributes to open requests it is watching. */
  function trackedPending() {
    var known = 0;
    pendingOpenList().forEach(function (r) { known += r.margin; });
    return known;
  }

  /* pendingOf says margin sits in requests the page does not know (another tab, a reload with
     cleared storage): find them in the OpenRequested logs (topic-filtered by trader, so one
     small answer). The recent window first; when that still leaves pendingOf uncovered, the
     whole range from deployBlock in one call, or walking back in chunks (halved when a chunk
     is refused too) when the node rejects the range, until the pending margin is accounted
     for. Without this an expired request older than the window had no Cancel button and its
     margin sat under "Margin in Use" with no way back but a manual cancelOpen. One walk at a
     time; the deepest block reached is remembered per account so the poll does not re-walk. */
  function discoverPendingOpens() {
    if (!wallet.account || !read.exchange || !read.logProvider || !exIface || pend.scanning) return Promise.resolve();
    if (acct.pending <= trackedPending() + 1e-6) return Promise.resolve();
    var E = window.ethers;
    var prov = read.logProvider;
    var account = wallet.account;
    var deploy = Math.max(0, Number(cfg.deployBlock) || 0);
    var topics = [exIface.getEvent('OpenRequested').topicHash, null, E.zeroPadValue(account, 32)];
    function covered() { return wallet.account !== account || acct.pending <= trackedPending() + 1e-6; }
    function scan(from, to) {
      return prov.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: to, topics: topics }).then(function (logs) {
        if (wallet.account !== account) return;
        return Promise.all(logs.map(function (log) {
          var p;
          try { p = exIface.parseLog({ topics: Array.from(log.topics), data: log.data }); } catch (e) { p = null; }
          if (!p) return null;
          var id = String(p.args.requestId);
          return pend.opens[id] ? null : loadOpenRequest(id, Number(log.blockNumber));
        }));
      });
    }
    pend.scanning = true;
    return prov.getBlockNumber().then(function (latest) {
      latest = Number(latest);
      var recent = Math.max(deploy, latest - PENDING_SCAN_BLOCKS);
      return scan(recent, latest).then(function () {
        if (covered() || recent <= deploy) return;
        if (pend.scan.account !== account) pend.scan = { account: account, from: recent };
        var top = Math.min(recent, pend.scan.from) - 1;
        if (top < deploy) return;
        return scan(deploy, top).then(function () { pend.scan.from = deploy; }, function () {
          var chunk = Math.max(1000, Number(cfg.logChunkBlocks) || 20000);
          function step() {
            if (top < deploy || covered()) return;
            var from = Math.max(deploy, top - chunk + 1);
            return scan(from, top).then(function () { pend.scan.from = from; top = from - 1; return step(); }, function (e) {
              if (chunk <= 1000) throw e;
              chunk = Math.max(1000, Math.floor(chunk / 2));
              return step();
            });
          }
          return step();
        });
      });
    }).catch(function () { /* the scan is best effort */ }).then(function () { pend.scanning = false; });
  }

  function hasPending() { return pendingOpenList().length > 0 || Object.keys(acct.closeReqs).length > 0; }

  /* Poll the pending requests every second until each resolves, and tick the countdowns. */
  function watchPending() {
    if (!hasPending()) {
      if (pend.timer) { clearInterval(pend.timer); pend.timer = null; }
      if (pend.tick) { clearInterval(pend.tick); pend.tick = null; }
      return;
    }
    if (!pend.timer) pend.timer = setInterval(tickPending, PENDING_POLL_MS);
    if (!pend.tick) pend.tick = setInterval(updatePendingLines, COUNTDOWN_MS);
  }

  function tickPending() {
    if (pend.inFlight || !read.exchange || !wallet.account) return;
    var ex = read.exchange;
    var account = wallet.account;
    pend.inFlight = true;
    var opens = pendingOpenList();
    var closes = Object.keys(acct.closeReqs);
    var reads = [read.provider.getBlock('latest').then(noteBlock).catch(function () {})];
    opens.forEach(function (r) {
      if (r.busy) return;
      reads.push(ex.openRequest(BigInt(r.id)).then(function (q) {
        if (wallet.account !== account || !pend.opens[r.id] || r.busy) return;
        if (q && q.trader !== ZERO) { r.requestedAt = Number(q.requestedAt); return; }
        /* gone: filled or refunded by the keeper (or anyone). Say which. */
        delete pend.opens[r.id];
        savePendingIds();
        return resolveOpenOutcome(r, 0);
      }).catch(function () {}));
    });
    closes.forEach(function (pid) {
      var cr = acct.closeReqs[pid];
      if (cr.busy) return;
      reads.push(ex.closeRequest(BigInt(pid)).then(function (q) {
        if (wallet.account !== account || !acct.closeReqs[pid] || cr.busy) return;
        if (q && Number(q.requestedAt) > 0) { cr.requestedAt = Number(q.requestedAt); return; }
        delete acct.closeReqs[pid];
        return resolveCloseOutcome(pid, cr, 0);
      }).catch(function () {}));
    });
    Promise.all(reads).then(function () {
      pend.inFlight = false;
      if (wallet.account === account) { renderPositions(); updatePendingLines(); }
    });
  }

  function topicId(x) { return window.ethers.toBeHex(BigInt(x), 32); }

  function parsedLogs(logs) {
    var out = [];
    (logs || []).forEach(function (log) {
      try {
        var p = exIface.parseLog({ topics: Array.from(log.topics), data: log.data });
        if (p) out.push({ name: p.name, args: p.args, tx: log.transactionHash });
      } catch (e) { /* another contract's log */ }
    });
    return out;
  }

  /* What happened to an open request that disappeared: PositionOpened with its id, or
     OpenRequestCancelled. Looked up in the logs from the request's block; retried a few
     times because the log node can lag the read node by a block or two. */
  function resolveOpenOutcome(r, attempt) {
    var E = window.ethers;
    var prov = read.logProvider;
    var from = r.block != null ? r.block : Math.max(0, (house.block || 0) - PENDING_SCAN_BLOCKS);
    var account = wallet.account;
    return Promise.all([
      prov.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: 'latest', topics: [exIface.getEvent('PositionOpened').topicHash, null, E.zeroPadValue(account, 32)] }),
      prov.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: 'latest', topics: [exIface.getEvent('OpenRequestCancelled').topicHash, topicId(r.id)] })
    ]).then(function (res) {
      var hits = parsedLogs(res[0]).filter(function (p) { return String(p.args.requestId) === r.id; }).concat(parsedLogs(res[1]));
      if (!hits.length) throw new Error('not yet');
      var raw = res[0].concat(res[1]);
      reportOpenOutcome(r, raw, hits[0].tx);
    }).catch(function () {
      if (attempt + 1 < OUTCOME_TRIES) return new Promise(function (ok) { setTimeout(ok, PENDING_POLL_MS); }).then(function () { return resolveOpenOutcome(r, attempt + 1); });
      toast('Request #r' + r.id + ' is done; see History.', null);
    }).then(function () { return afterTx(); });
  }

  /* Toast for the logs of an open request's end: a fill or a refund. */
  function reportOpenOutcome(r, logs, txHash) {
    var inst = state.byInstId[r.instrumentId];
    var sym = inst && inst.market ? inst.market.symbol : '#' + r.instrumentId;
    var sz = inst && inst.market ? inst.market.szDecimals : null;
    var hits = parsedLogs(logs);
    var opened = hits.filter(function (p) { return p.name === 'PositionOpened' && String(p.args.requestId) === r.id; })[0];
    var refunded = hits.filter(function (p) { return p.name === 'OpenRequestCancelled' && String(p.args.requestId) === r.id; })[0];
    var link = txHash ? txLink(txHash) : null;
    if (opened) {
      toast('Filled #' + String(opened.args.positionId) + ': ' + (r.isLong ? 'long ' : 'short ') + sym + ' x' + r.leverage + ', entry ' + fmtPrice(px18ToNum(opened.args.entryPx18), sz) + '.', 'ok', link);
    } else if (refunded) {
      toast('Refunded #r' + r.id + ' (' + reasonText(refunded.args.reason) + '): ' + fmtUsd(r.margin) + ' back to available.', 'err', link);
    } else {
      toast('Request #r' + r.id + ' done.', null, link);
    }
  }

  /* What happened to a close request that disappeared: the position closed, was liquidated,
     or the request was cancelled after expiry (the position stays). */
  function resolveCloseOutcome(pid, cr, attempt) {
    var prov = read.logProvider;
    var from = cr && cr.block != null ? cr.block : Math.max(0, (house.block || 0) - PENDING_SCAN_BLOCKS);
    var t = function (n) { return exIface.getEvent(n).topicHash; };
    return prov.getLogs({
      address: cfg.contracts.exchange, fromBlock: from, toBlock: 'latest',
      topics: [[t('PositionClosed'), t('PositionLiquidated'), t('CloseRequestCancelled')], topicId(pid)]
    }).then(function (logs) {
      var hits = parsedLogs(logs);
      if (!hits.length) throw new Error('not yet');
      reportCloseOutcome(pid, logs, hits[hits.length - 1].tx);
    }).catch(function () {
      if (attempt + 1 < OUTCOME_TRIES) return new Promise(function (ok) { setTimeout(ok, PENDING_POLL_MS); }).then(function () { return resolveCloseOutcome(pid, cr, attempt + 1); });
      toast('Close of #' + pid + ' is done; see History.', null);
    }).then(function () { return afterTx(); });
  }

  function reportCloseOutcome(pid, logs, txHash) {
    var hits = parsedLogs(logs).filter(function (p) { return String(p.args.positionId) === String(pid); });
    var closed = hits.filter(function (p) { return p.name === 'PositionClosed'; })[0];
    var liq = hits.filter(function (p) { return p.name === 'PositionLiquidated'; })[0];
    var cancelled = hits.filter(function (p) { return p.name === 'CloseRequestCancelled'; })[0];
    var link = txHash ? txLink(txHash) : null;
    if (closed) {
      var a = closed.args;
      var pnl = usd6ToNum(a.pnlUsdc);
      var msg = 'Closed #' + pid + ' at ' + fmtPrice(px18ToNum(a.exitPx18)) + ': PnL ' + fmtUsd(pnl, true) + ', paid ' + fmtUsd(usd6ToNum(a.payoutUsdc));
      if (a.queuedUsdc > 0n) msg += ', queued ' + fmtUsd(usd6ToNum(a.queuedUsdc));
      if (a.confettiMinted > 0n) msg += ', ' + fmtInt(tokenToNum(a.confettiMinted)) + ' CONFETTI minted';
      toast(msg + '.', pnl >= 0 ? 'ok' : 'err', link);
    } else if (liq) {
      toast('Liquidated #' + pid + ' at ' + fmtPrice(px18ToNum(liq.args.exitPx18)) + ': margin ' + fmtUsd(usd6ToNum(liq.args.marginUsdc)) + ' gone' + (liq.args.confettiMinted > 0n ? ', ' + fmtInt(tokenToNum(liq.args.confettiMinted)) + ' CONFETTI minted' : '') + '.', 'err', link);
    } else if (cancelled) {
      toast('Close request on #' + pid + ' ' + reasonText(cancelled.args.reason) + '; the position stays open.', 'err', link);
    } else {
      toast('Close of #' + pid + ' done.', null, link);
    }
  }

  function submitDeposit(amount) {
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(); }
    if (!isAddr(usdcAddress())) { toast('USDC address unknown.', 'err'); return Promise.resolve(); }
    var amount6 = numToUsd6(amount);
    var usdc = usdcWrite();
    var ex = exchangeWrite();
    var spender = cfg.contracts.exchange;
    setBusy(true);
    return usdc.allowance(wallet.account, spender).then(function (allowance) {
      if (allowance >= amount6) return null;
      return sendTx('Approve ' + fmtUsd(amount) + ' USDC', usdc.approve, [spender, amount6]);
    }).then(function () {
      return sendTx('Deposit ' + fmtUsd(amount), ex.deposit, [amount6]);
    }).then(function (rc) {
      toast('Deposited ' + fmtUsd(amount) + ' into your exchange balance.', 'ok', txLink(rc.hash));
      closeDialog('depositModal');
      return afterTx();
    }).catch(function (e) {
      toast('Deposit failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  function submitWithdraw(amount) {
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(); }
    var amount6 = numToUsd6(amount);
    var ex = exchangeWrite();
    setBusy(true);
    return sendTx('Withdraw ' + fmtUsd(amount), ex.withdraw, [amount6]).then(function (rc) {
      toast('Withdrew ' + fmtUsd(amount) + ' to your wallet.', 'ok', txLink(rc.hash));
      closeDialog('withdrawModal');
      return afterTx();
    }).catch(function (e) {
      toast('Withdraw failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* ---- dialogs ------------------------------------------------------------------- */

  function openDialog(id) {
    var d = $(id);
    if (!d) return;
    if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); }
    else d.setAttribute('open', '');
  }

  function closeDialog(id) {
    var d = $(id);
    if (!d) return;
    if (typeof d.close === 'function' && d.open) d.close(); else d.removeAttribute('open');
  }

  function openDeposit() {
    if (!wallet.account) { connect(); return; }
    if (wallet.chainId !== CHAIN_ID) { toast('Switch the wallet to HyperEVM first.', 'err'); return; }
    if (!hasExchange()) { toast('Exchange address not configured.', 'err'); return; }
    renderDepositModal();
    openDialog('depositModal');
    refreshWalletUsdc();
    var inp = $('depositAmount'); if (inp) { inp.value = ''; inp.focus(); }
  }

  function openWithdraw() {
    if (!wallet.account) { connect(); return; }
    if (wallet.chainId !== CHAIN_ID) { toast('Switch the wallet to HyperEVM first.', 'err'); return; }
    if (!hasExchange()) { toast('Exchange address not configured.', 'err'); return; }
    renderWithdrawModal();
    openDialog('withdrawModal');
    var inp = $('withdrawAmount'); if (inp) { inp.value = ''; inp.focus(); }
  }

  function renderDepositModal() {
    setText('depWallet', wallet.account ? fmtUsd(acct.walletUsdc) : '—');
    setText('depAvailable', acct.loaded ? fmtUsd(acct.available) : '—');
    setText('depAllowance', wallet.account ? fmtUsd(acct.allowance) : '—');
  }

  function renderWithdrawModal() {
    setText('wdAvailable', acct.loaded ? fmtUsd(acct.available) : '—');
    setText('wdMargin', acct.loaded ? fmtUsd(acct.marginInUse) : '—');
  }

  function initDialogs() {
    ['depositModal', 'withdrawModal'].forEach(function (id) {
      var d = $(id);
      if (!d) return;
      var closers = d.querySelectorAll('[data-close]');
      for (var i = 0; i < closers.length; i++) closers[i].addEventListener('click', function () { closeDialog(id); });
      d.addEventListener('click', function (ev) { if (ev.target === d) closeDialog(id); });
    });
    var depForm = $('depositForm');
    if (depForm) {
      depForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (state.busy) return;
        var v = Number($('depositAmount').value);
        var hint = $('depositHint');
        if (!isFinite(v) || v <= 0) { hint.textContent = 'Enter an amount.'; hint.classList.add('is-err'); return; }
        if (v > acct.walletUsdc + 1e-9) { hint.textContent = 'More than the wallet holds (' + fmtUsd(acct.walletUsdc) + ').'; hint.classList.add('is-err'); return; }
        hint.classList.remove('is-err');
        hint.textContent = acct.allowance >= v ? 'Allowance covers it: one transaction.' : 'Two transactions: approve exactly ' + fmtUsd(v) + ', then deposit.';
        submitDeposit(v);
      });
      $('depMax').addEventListener('click', function () {
        $('depositAmount').value = String(Math.floor(acct.walletUsdc * 100) / 100);
      });
    }
    var wdForm = $('withdrawForm');
    if (wdForm) {
      wdForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (state.busy) return;
        var v = Number($('withdrawAmount').value);
        var hint = $('withdrawHint');
        if (!isFinite(v) || v <= 0) { hint.textContent = 'Enter an amount.'; hint.classList.add('is-err'); return; }
        if (v > acct.available + 1e-9) { hint.textContent = 'More than your available balance (' + fmtUsd(acct.available) + ').'; hint.classList.add('is-err'); return; }
        hint.classList.remove('is-err');
        submitWithdraw(v);
      });
      $('wdMax').addEventListener('click', function () {
        $('withdrawAmount').value = String(Math.floor(acct.available * 1e6) / 1e6);
      });
    }
  }

  /* ---- confetti's own 24h volume (the owner 2026-10-17: "second box"): the notional of every position opened on the
     exchange in the last 24 hours (margin x leverage, every market, the house bots included), from the PositionOpened
     logs. The 24 h boundary block is found from block timestamps; later refreshes only read the new blocks. ---- */
  var CONF_VOL_EVERY_MS = 60000;
  var cvol = { entries: [], scannedTo: null, busy: false };

  function confVolBoundary(prov, latest) {
    return prov.getBlock(latest).then(function (top) {
      var topTs = Number(top.timestamp), target = topTs - 86400;
      var floor = Number(cfg.deployBlock) || 0;
      function refine(b, k) {
        b = Math.max(floor, b);
        return prov.getBlock(b).then(function (blk) {
          var late = Number(blk.timestamp) - target;                     /* seconds this block is after the boundary */
          var rate = (topTs - Number(blk.timestamp)) / Math.max(1, latest - b) || 1; /* seconds per block */
          var nb = Math.max(floor, Math.round(b - late / rate));
          if (k <= 0 || Math.abs(nb - b) < 30) return nb;
          return refine(nb, k - 1);
        });
      }
      return refine(latest - 88000, 3);
    });
  }

  function refreshConfVol() {
    if (cvol.busy || document.hidden || !read.logProvider || !exIface || !hasExchange()) return;
    var prov = read.logProvider;
    var topic = exIface.getEvent('PositionOpened').topicHash;
    var chunk = Math.max(1000, Number(cfg.logChunkBlocks) || 20000);
    cvol.busy = true;
    prov.getBlockNumber().then(function (latest) {
      return confVolBoundary(prov, latest).then(function (from24) {
        var start = cvol.scannedTo != null ? Math.max(cvol.scannedTo + 1, from24) : from24;
        function step(from) {
          if (from > latest) return Promise.resolve();
          var to = Math.min(latest, from + chunk - 1);
          return prov.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: to, topics: [topic] }).then(function (logs) {
            logs.forEach(function (log) {
              var p = null;
              try { p = exIface.parseLog({ topics: Array.from(log.topics), data: log.data }); } catch (e) { p = null; }
              if (p) cvol.entries.push({ b: Number(log.blockNumber), n: usd6ToNum(p.args.marginUsdc) * Number(p.args.leverage) });
            });
            return step(to + 1);
          });
        }
        return step(start).then(function () {
          cvol.scannedTo = latest;
          cvol.entries = cvol.entries.filter(function (e) { return e.b >= from24; });
          var sum = cvol.entries.reduce(function (s, e) { return s + (isFinite(e.n) ? e.n : 0); }, 0);
          setText('chipConfVol', fmtUsdCompact(sum));
        });
      });
    }).catch(function () { /* keep the last number; the next minute tries again */ }).then(function () { cvol.busy = false; });
  }

  /* ---- history (Exchange events via eth_getLogs) ------------------------------------ */

  function freshHistory() {
    return { rows: [], seen: {}, openedMarket: {}, openedSide: {}, scannedFrom: null, scannedTo: null, loading: false, done: false, chunked: false, blockTs: {} };
  }

  var hist = freshHistory();

  function fetchLogs(prov, from, to) {
    var E = window.ethers;
    var user = E.zeroPadValue(wallet.account, 32);
    var t = function (n) { return exIface.getEvent(n).topicHash; };
    var addr = cfg.contracts.exchange;
    var q1 = { address: addr, fromBlock: from, toBlock: to, topics: [[t('Deposited'), t('Withdrawn')], user] };
    /* the account is the second indexed field of each of these (owner / recipient / trader) */
    var q2 = { address: addr, fromBlock: from, toBlock: to, topics: [[t('PositionOpened'), t('PositionClosed'), t('PositionLiquidated'), t('QueueAppended'), t('QueuePaid'), t('OpenRequestCancelled')], null, user] };
    return Promise.all([prov.getLogs(q1), prov.getLogs(q2)]).then(function (r) { return r[0].concat(r[1]); });
  }

  function addLogs(logs) {
    logs.forEach(function (log) {
      var key = log.transactionHash + ':' + log.index;
      if (hist.seen[key]) return;
      var p;
      try { p = exIface.parseLog({ topics: Array.from(log.topics), data: log.data }); } catch (e) { p = null; }
      if (!p) return;
      hist.seen[key] = true;
      if (p.name === 'PositionOpened') {
        hist.openedMarket[String(p.args.positionId)] = Number(p.args.instrumentId);
        hist.openedSide[String(p.args.positionId)] = sideLev(p.args.isLong, p.args.leverage);
      }
      hist.rows.push({ name: p.name, args: p.args, block: Number(log.blockNumber), index: Number(log.index), tx: log.transactionHash });
    });
    hist.rows.sort(function (a, b) { return b.block - a.block || b.index - a.index; });
  }

  function loadHistory(reset) {
    if (!wallet.account || !read.exchange || !read.logProvider) { renderHistory(); return Promise.resolve(); }
    if (reset) hist = freshHistory();
    if (hist.loading || hist.done) { renderHistory(); return Promise.resolve(); }
    hist.loading = true;
    renderHistory();
    var prov = read.logProvider;
    var deploy = Math.max(0, Number(cfg.deployBlock) || 0);
    var account = wallet.account;
    var p;
    if (hist.scannedTo == null) {
      /* head of the log node itself, so a lagging node never sees a future toBlock */
      p = prov.getBlockNumber().then(function (latest) {
        latest = Number(latest);
        hist.scannedTo = latest;
        return fetchLogs(prov, deploy, latest).then(function (logs) {
          addLogs(logs); hist.scannedFrom = deploy; hist.done = true;
        }, function () {
          hist.chunked = true;
          return scanChunks(prov, latest, deploy);
        });
      });
    } else {
      p = scanChunks(prov, hist.scannedFrom - 1, deploy);
    }
    return p.catch(function (e) {
      toast('History: ' + describeError(e), 'err');
    }).then(function () {
      if (wallet.account !== account) return;
      hist.loading = false;
      renderHistory();
      resolveTimestamps();
    });
  }

  function scanChunks(prov, top, deploy) {
    var chunk = Math.max(1000, Number(cfg.logChunkBlocks) || 20000);
    var n = Math.max(1, Number(cfg.logChunksPerLoad) || 10);
    var i = 0;
    function step() {
      if (i++ >= n || top < deploy) { if (top < deploy) hist.done = true; return Promise.resolve(); }
      var from = Math.max(deploy, top - chunk + 1);
      return fetchLogs(prov, from, top).then(function (logs) {
        addLogs(logs);
        hist.scannedFrom = from;
        top = from - 1;
        if (from <= deploy) { hist.done = true; return; }
        renderHistory();
        return step();
      });
    }
    return step();
  }

  /* Structured fields for one history line. amount is already signed; signed=false shows it plain. */
  function describeRow(r) {
    var a = r.args;
    var d = { label: r.name.toLowerCase(), market: null, id: null, side: null, amount: null, signed: true, details: '' };
    function sym(instId) { var inst = state.byInstId[instId]; return inst && inst.market ? inst.market.symbol : '#' + instId; }
    function pid() { d.id = String(a.positionId); var mi = hist.openedMarket[d.id]; d.market = mi != null ? sym(mi) : null; d.side = hist.openedSide[d.id] || null; }
    switch (r.name) {
      case 'Deposited':
        d.label = 'deposit';
        d.amount = usd6ToNum(a.amountUsdc);
        if (a.payer.toLowerCase() !== wallet.account.toLowerCase()) d.details = 'from ' + shortAddr(a.payer);
        break;
      case 'Withdrawn':
        d.label = 'withdraw';
        d.amount = -usd6ToNum(a.amountUsdc);
        break;
      case 'PositionOpened':
        d.label = 'opened';
        d.id = String(a.positionId);
        d.market = sym(Number(a.instrumentId));
        d.side = sideLev(a.isLong, a.leverage);
        d.amount = usd6ToNum(a.marginUsdc); d.signed = false;
        d.details = 'margin ' + fmtUsd(usd6ToNum(a.marginUsdc)) + ' · entry ' + fmtPrice(px18ToNum(a.entryPx18));
        break;
      case 'PositionClosed':
        d.label = 'closed';
        pid();
        d.amount = usd6ToNum(a.pnlUsdc);
        d.details = 'exit ' + fmtPrice(px18ToNum(a.exitPx18)) + ' · paid ' + fmtUsd(usd6ToNum(a.payoutUsdc));
        if (a.queuedUsdc > 0n) d.details += ' · queued ' + fmtUsd(usd6ToNum(a.queuedUsdc));
        if (a.feeUsdc > 0n) d.details += ' · fee ' + fmtUsd(usd6ToNum(a.feeUsdc));
        if (a.confettiMinted > 0n) d.details += ' · ' + fmtInt(tokenToNum(a.confettiMinted)) + ' CONFETTI';
        break;
      case 'PositionLiquidated':
        d.label = 'liquidated';
        pid();
        d.amount = -usd6ToNum(a.marginUsdc);
        d.details = 'exit ' + fmtPrice(px18ToNum(a.exitPx18)) + ' · bounty ' + fmtUsd(usd6ToNum(a.bountyUsdc)) + ' to ' + shortAddr(a.liquidator);
        if (a.confettiMinted > 0n) d.details += ' · ' + fmtInt(tokenToNum(a.confettiMinted)) + ' CONFETTI';
        break;
      case 'QueueAppended':
        d.label = 'queued';
        d.amount = usd6ToNum(a.amountUsdc); d.signed = false;
        d.details = 'entry #' + a.index + ' · owed';
        break;
      case 'QueuePaid':
        d.label = 'queue paid';
        d.amount = usd6ToNum(a.paidUsdc);
        d.details = 'entry #' + a.index + ' · ' + fmtUsd(usd6ToNum(a.remainingUsdc)) + ' remaining';
        break;
      case 'OpenRequestCancelled':
        d.label = 'refunded';
        d.id = 'r' + String(a.requestId);
        d.details = reasonText(a.reason);
        break;
    }
    return d;
  }

  function blockTitle(block) {
    var ts = hist.blockTs[block];
    return (ts ? fmtTime(ts) + ' · ' : '') + 'block ' + fmtInt(block);
  }

  /* One .pos-line per event: time, event, market, side+lev, signed amount, tx. */
  function historyLine(r) {
    var d = describeRow(r);
    var line = el('div', 'pos-line');
    if (d.details) line.title = d.details;
    var time = el('span', 'faint', fmtClock(hist.blockTs[r.block]));
    time.setAttribute('data-block', String(r.block));
    time.title = blockTitle(r.block);
    line.appendChild(time);
    line.appendChild(el('span', null, d.label));
    if (d.market) line.appendChild(el('span', 'sym', d.market));
    if (d.id) line.appendChild(el('span', 'faint xs', '#' + d.id));
    if (d.side) line.appendChild(el('span', d.side.charAt(0) === 'l' ? 'pos' : 'neg', d.side));
    if (d.amount != null) {
      var cls = d.signed ? (d.amount > 0 ? 'pos' : d.amount < 0 ? 'neg' : '') : '';
      line.appendChild(el('span', cls || null, fmtUsd(d.amount, d.signed)));
    } else if (d.details) {
      line.appendChild(el('span', 'faint', d.details));
    }
    line.appendChild(el('span', 'grow'));
    var a = el('a', 'faint', shortAddr(r.tx));
    a.href = explorer('tx', r.tx); a.target = '_blank'; a.rel = 'noopener'; a.title = r.tx;
    line.appendChild(a);
    return line;
  }

  function renderHistory() {
    var host = $('histLines');
    var empty = $('histEmpty');
    var more = $('histMoreBtn');
    var range = $('histRange');
    if (!host) return;
    clearLines(host);
    if (!wallet.account) { empty.textContent = 'Connect a wallet to load your history.'; empty.removeAttribute('hidden'); }
    else if (!hasExchange()) { empty.textContent = 'Exchange address not configured.'; empty.removeAttribute('hidden'); }
    else if (!hist.rows.length) { empty.textContent = hist.loading ? 'Scanning events…' : 'No events found in the scanned range.'; empty.removeAttribute('hidden'); }
    else empty.setAttribute('hidden', '');

    var foot = host.querySelector('.hist-foot');
    var frag = document.createDocumentFragment();
    hist.rows.forEach(function (r) { frag.appendChild(historyLine(r)); });
    if (foot) host.insertBefore(frag, foot); else host.appendChild(frag);

    if (more) {
      more.disabled = hist.loading || hist.done || !wallet.account || !hasExchange();
      more.textContent = hist.loading ? 'Loading…' : (hist.done ? 'All loaded' : 'Load older');
    }
    if (range) {
      if (hist.scannedTo == null) range.textContent = '';
      else {
        var txt = 'scanned blocks ' + fmtInt(hist.scannedFrom) + ' to ' + fmtInt(hist.scannedTo) + (hist.chunked ? ' (chunked)' : '');
        if (!(Number(cfg.deployBlock) > 0)) txt += ' · set deployBlock in config.json to bound the scan';
        range.textContent = txt;
      }
    }
  }

  var tsInFlight = 0;

  function resolveTimestamps() {
    if (!read.provider) return;
    var pending = {};
    hist.rows.forEach(function (r) { if (!hist.blockTs[r.block]) pending[r.block] = true; });
    var blocks = Object.keys(pending).map(Number).sort(function (a, b) { return b - a; });
    (function next() {
      if (!blocks.length || tsInFlight >= 3) return;
      var b = blocks.shift();
      tsInFlight++;
      read.provider.getBlock(b).then(function (blk) {
        if (blk) {
          hist.blockTs[b] = Number(blk.timestamp);
          var cells = document.querySelectorAll('#histLines [data-block="' + b + '"]');
          for (var i = 0; i < cells.length; i++) { cells[i].textContent = fmtClock(hist.blockTs[b]); cells[i].title = blockTitle(b); }
        }
      }).catch(function () {}).then(function () { tsInFlight--; next(); });
      next();
    })();
  }

  /* ---- status tab ------------------------------------------------------------------ */

  function addrCell(id, addr) {
    var cell = $(id);
    if (!cell) return;
    cell.textContent = '';
    if (!isAddr(addr)) { cell.textContent = addr && addr !== ZERO ? String(addr) : 'not set'; return; }
    var a = el('a', null, shortAddr(addr));
    a.href = explorer('address', addr); a.target = '_blank'; a.rel = 'noopener'; a.title = addr;
    cell.appendChild(a);
  }

  function renderStatus() {
    if (!cfg) return;
    setText('stChain', (cfg.chainName || 'HyperEVM') + ' · ' + CHAIN_ID);
    setText('stBlock', house.block != null ? fmtInt(house.block) + (house.blockAt ? ' · ' + Math.round((Date.now() - house.blockAt) / 1000) + 's ago' : '') : '—');
    var rpc = $('stRpc'); if (rpc) { rpc.textContent = cfg.rpcUrl || '—'; rpc.title = cfg.rpcUrl || ''; }
    setText('stWallet', wallet.account ? shortAddr(wallet.account) : 'not connected');
    setText('stWalletChain', wallet.account ? (wallet.chainId === CHAIN_ID ? 'HyperEVM · 999' : String(wallet.chainId) + ' (wrong chain)') : '—');

    setText('stLp', house.lp != null ? fmtUsd(house.lp) : '—');
    setText('stFeePool', house.feePool != null ? fmtUsd(house.feePool) : '—');
    setText('stQueued', house.queued != null ? fmtUsd(house.queued) : '—');
    setText('stQueueLen', house.queueLen != null ? fmtInt(house.queueLen - house.queueHead) + ' live · ' + fmtInt(house.queueLen) + ' ever' : '—');
    renderHouseLine();
    setText('stPaused', read.exchange ? (house.globalPaused ? 'yes' : 'no') : '—');
    setText('stBreaker', read.exchange ? (house.breakerTripped ? 'tripped · opens paused' : 'armed') : '—');
    setText('stFee', read.exchange && house.feeRate != null ? feePctText() : '—');
    setText('stWindows', read.exchange ? house.minDelay + ' s wait · ' + house.grace + ' s keeper · ' + house.expiry + ' s expiry' : '—');
    setText('stJump', read.exchange && house.maxJumpBps != null ? (house.maxJumpBps / 100).toFixed(house.maxJumpBps % 100 ? 2 : 0) + '%' : '—');
    setText('stStakerShare', read.exchange && house.stakerShareBps != null ? (house.stakerShareBps / 100).toFixed(0) + '%' : '—');
    setText('stRefShare', read.exchange && house.referralShareBps != null ? (house.referralShareBps / 100).toFixed(0) + '%' : '—');
    setText('finePrint', 'Fills at the oracle price, a few seconds after you click. Wins pay the impact haircut plus a ' + feePctText() + ' fee.');
    setText('stInstCount', house.instCount != null ? String(house.instCount) : '—');

    addrCell('stExchange', cfg.contracts && cfg.contracts.exchange);
    addrCell('stUsdc', usdcAddress());
    addrCell('stOracle', house.addrs.oracle || (cfg.contracts && cfg.contracts.oracle));
    addrCell('stConfetti', house.addrs.confetti || (cfg.contracts && cfg.contracts.confetti));
    addrCell('stTokenomics', house.addrs.tokenomics || (cfg.contracts && cfg.contracts.tokenomics));
    addrCell('stStaking', house.addrs.staking || (cfg.contracts && cfg.contracts.staking));
    addrCell('stReferrals', house.addrs.referrals || (cfg.contracts && cfg.contracts.referrals));
    addrCell('stOwner', house.addrs.owner);
    addrCell('stFeeRecipient', house.addrs.feeRecipient);

    var m = state.market;
    var inst = m && m.inst;
    if (inst) {
      setText('stInst', '#' + inst.id + ' · HL ' + inst.hlAssetIndex + ' · sz ' + inst.szDecimals + ' · tier ' + tierLetter(m) + (inst.retired ? ' · retired' : inst.opensPaused ? ' · paused' : ''));
      setText('stMaxLev', 'x' + inst.maxLeverage);
      setText('stBand', inst.deadbandBps + ' bps');
      setText('stCurve', (inst.baseRate * 100).toFixed(0) + '% · ' + fmtInt(inst.rateMultiplier) + ' · $' + fmtInt(inst.referenceNotional) + ' · ' + fmtInt(inst.positionMultiplier));
      setText('stCaps', fmtUsdCompact(inst.longCap) + ' / ' + fmtUsdCompact(inst.shortCap));
      setText('stPosCap', fmtUsdCompact(inst.maxNotional) + ' · x' + inst.payoutCapX);
      var opx = house.oraclePxById[inst.id];
      setText('stOraclePx', inst.retired ? fmtPrice(inst.frozenPx, m.szDecimals) + ' (frozen)' : (opx != null ? fmtPrice(opx, m.szDecimals) : '—'));
    } else {
      setText('stInst', m ? (hasExchange() ? (state.instrumentsLoaded ? 'not on chain yet' : 'loading…') : 'HL ' + m.hlAssetIndex + ' · tier ' + m.tier) : '—');
      setText('stMaxLev', m && !hasExchange() ? 'x' + maxLev(m) : '—');
      setText('stBand', '—'); setText('stCurve', '—'); setText('stCaps', '—'); setText('stPosCap', '—'); setText('stOraclePx', '—');
    }
  }

  /* ---- referrals ------------------------------------------------------------------------ */

  /* ?ref=CODE on any page is kept in localStorage until the account's referrer is locked. */
  function captureRef() {
    var code = null;
    try { code = new URLSearchParams(location.search).get('ref'); } catch (e) { code = null; }
    if (!code) return;
    code = String(code).trim().toLowerCase();
    if (REF_RE.test(code)) { lsSet(LS.ref, code); ref.code = code; }
  }

  function referralsRead() { return read.referrals; }

  /* The account's referral state: own code and earnings, locked referrer, and the stored
     code's address for the next requestOpen. */
  function loadReferral() {
    var rc = referralsRead();
    if (!rc || !wallet.account) { renderRefer(); return Promise.resolve(); }
    var a = wallet.account;
    var none = function () { return null; };
    return Promise.all([
      rc.codeOf(a).catch(none), rc.referralEarned(a).catch(none), rc.referrerOf(a).catch(none), rc.referrerLocked(a).catch(none),
      rc.referralShareBps().catch(none),
      ref.code ? rc.codeToReferrer(ref.code).catch(none) : Promise.resolve(null)
    ]).then(function (r) {
      if (wallet.account !== a) return;
      ref.myCode = r[0] || '';
      ref.earned = r[1] == null ? null : usd6ToNum(r[1]);
      ref.referrer = isAddr(r[2]) ? r[2] : null;
      ref.locked = r[3] == null ? null : !!r[3];
      if (r[4] != null) house.referralShareBps = Number(r[4]);
      ref.addr = isAddr(r[5]) ? r[5] : null;
      ref.loaded = true;
      renderRefer(); renderStatus();
    });
  }

  function refLink(code) { return SITE_URL + '?ref=' + code; }

  function renderRefer() {
    var formEl = $('referForm');
    var hint = $('referHint');
    var linkEl = $('rfLink');
    var copy = $('rfCopy');
    var share = house.referralShareBps != null ? (house.referralShareBps / 100).toFixed(0) + '%' : '15%';
    setText('rfShare', share + ' of their fees');
    if (!wallet.account) {
      setText('rfCode', '—'); setText('rfEarned', '—'); setText('rfBy', ref.code ? ref.code + ' (saved)' : '—');
      if (linkEl) linkEl.textContent = '—';
      if (copy) copy.setAttribute('hidden', '');
      if (formEl) formEl.setAttribute('hidden', '');
      if (hint) hint.textContent = 'Connect a wallet to get a code.';
      return;
    }
    if (!referralsRead()) {
      setText('rfCode', '—'); setText('rfEarned', '—'); setText('rfBy', '—');
      if (linkEl) linkEl.textContent = '—';
      if (copy) copy.setAttribute('hidden', '');
      if (formEl) formEl.setAttribute('hidden', '');
      if (hint) hint.textContent = hasExchange() ? 'Loading…' : 'Exchange address not configured.';
      return;
    }
    var has = !!ref.myCode;
    setText('rfCode', has ? ref.myCode : (ref.loaded ? 'none yet' : '…'));
    if (linkEl) {
      linkEl.textContent = '';
      if (has) {
        var a = el('a', null, refLink(ref.myCode).replace(/^https:\/\//, ''));
        a.href = refLink(ref.myCode); a.target = '_blank'; a.rel = 'noopener';
        linkEl.appendChild(a);
      } else linkEl.textContent = '—';
    }
    if (copy) { if (has) copy.removeAttribute('hidden'); else copy.setAttribute('hidden', ''); }
    setText('rfEarned', ref.earned != null ? fmtUsd(ref.earned) : '—');
    var by = '—';
    if (ref.referrer) by = shortAddr(ref.referrer);
    else if (ref.locked) by = 'none';
    else if (ref.code) by = ref.addr ? ref.code + ' · set on your first fill' : ref.code + ' (unknown code)';
    setText('rfBy', by);
    if (formEl) { if (has || !ref.loaded) formEl.setAttribute('hidden', ''); else formEl.removeAttribute('hidden'); }
    if (hint && !has) hint.textContent = ref.loaded ? '3 to 16 characters: a-z, 0-9, underscore. One per wallet, for good.' : 'Loading…';
  }

  function submitRegister(code) {
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(); }
    var addr = house.addrs.referrals || (cfg.contracts && cfg.contracts.referrals);
    if (!isAddr(addr)) { toast('Referrals address unknown.', 'err'); return Promise.resolve(); }
    var rc = new window.ethers.Contract(addr, REFERRALS_ABI, wallet.signer);
    setBusy(true);
    return sendTx('Register ' + code, rc.registerCode, [code]).then(function (r) {
      toast('Code ' + code + ' is yours: ' + refLink(code), 'ok', txLink(r.hash));
      return loadReferral();
    }).catch(function (e) {
      toast('Register failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  function initRefer() {
    var formEl = $('referForm');
    var input = $('referCode');
    var hint = $('referHint');
    if (formEl) {
      formEl.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (state.busy) return;
        var code = String(input.value || '').trim().toLowerCase();
        if (!REF_RE.test(code)) { hint.textContent = '3 to 16 characters: a-z, 0-9, underscore.'; hint.classList.add('is-err'); return; }
        hint.classList.remove('is-err');
        var rc = referralsRead();
        var check = rc ? rc.codeToReferrer(code).catch(function () { return ZERO; }) : Promise.resolve(ZERO);
        check.then(function (owner) {
          if (isAddr(owner)) { hint.textContent = 'Code "' + code + '" is taken.'; hint.classList.add('is-err'); return; }
          return submitRegister(code);
        });
      });
    }
    var copy = $('rfCopy');
    if (copy) {
      copy.addEventListener('click', function () {
        if (!ref.myCode) return;
        var link = refLink(ref.myCode);
        var done = function () { toast('Copied ' + link); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { toast(link); });
        else toast(link);
      });
    }
  }

  /* ---- tabs, toasts, theme ------------------------------------------------------------ */

  function initTabs() {
    var tabs = document.querySelectorAll('.trade-bottom .tab[data-tab]');
    function show(name) {
      for (var i = 0; i < tabs.length; i++) {
        var on = tabs[i].getAttribute('data-tab') === name;
        tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
        var panel = $(tabs[i].getAttribute('aria-controls'));
        if (panel) { if (on) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', ''); }
      }
      lsSet(LS.tab, name);
      if (name === 'history' && wallet.account && !hist.rows.length && !hist.loading && !hist.done) loadHistory(false);
    }
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (ev) { show(ev.currentTarget.getAttribute('data-tab')); });
    }
    var saved = lsGet(LS.tab);
    show(saved === 'history' || saved === 'status' || saved === 'refer' ? saved : 'positions');
    var more = $('histMoreBtn');
    if (more) more.addEventListener('click', function () { loadHistory(false); });
    var closeAllBtn = $('closeAllBtn');
    if (closeAllBtn) closeAllBtn.addEventListener('click', closeAll);
    var auto = $('autoFillChk');
    if (auto) {
      auto.checked = autoFillEnabled();
      auto.addEventListener('change', function () { lsSet(LS.autoFill, auto.checked ? '1' : '0'); });
    }
  }

  function toast(text, kind, link, ttlMs) {
    var host = $('toasts');
    if (!host) return null;
    var t = el('div', 'toast' + (kind ? ' toast-' + kind : ''));
    t.appendChild(document.createTextNode(text));
    if (link && link.href) {
      t.appendChild(document.createTextNode(' '));
      var a = el('a', null, link.label || 'view');
      a.href = link.href; a.target = '_blank'; a.rel = 'noopener';
      t.appendChild(a);
    }
    t.addEventListener('click', function (ev) { if (ev.target.tagName !== 'A') dismissToast(t); });
    host.appendChild(t);
    var ttl = ttlMs == null ? (kind === 'err' ? 12000 : 7000) : ttlMs;
    if (ttl > 0) setTimeout(function () { dismissToast(t); }, ttl);
    return t;
  }

  function dismissToast(t) { if (t && t.parentNode) t.parentNode.removeChild(t); }

  /* The Send control in the points bar (points.js) goes through this page's own wallet: the same connect, chain
     switch and provider as the header Connect button. Other pages have no trade.js and use the injected wallet. */
  window.ConfettiWallet = {
    account: function () { return wallet.account; },
    connect: function () { return connect(); },
    ensureChain: function () {
      return wallet.chainId === CHAIN_ID ? Promise.resolve() : switchChain().then(function () { return onChainChanged(); });
    },
    request: function (payload) { return (wallet.eth || getInjected()).request(payload); }
  };

  function initTheme() {
    var btn = $('themeToggle');
    var root = document.documentElement;
    var meta = document.querySelector('meta[name="theme-color"]');
    function apply(night, persist) {
      if (night) root.setAttribute('data-theme', 'night'); else root.removeAttribute('data-theme');
      if (btn) { btn.setAttribute('aria-pressed', night ? 'true' : 'false'); btn.textContent = night ? 'Paper' : 'Night'; }
      if (meta) meta.setAttribute('content', cssVar('--page', '#f4ecd8'));
      if (persist) lsSet(THEME_KEY, night ? 'night' : 'paper');
      rethemeChart();
    }
    apply(root.getAttribute('data-theme') === 'night', false);
    if (btn) btn.addEventListener('click', function () { apply(root.getAttribute('data-theme') !== 'night', true); });
  }

  function initHeader() {
    var links = document.querySelectorAll('.nav a[data-soon]');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function (ev) {
        ev.preventDefault();
        toast(ev.currentTarget.getAttribute('data-soon') + ' is coming in v2.');
      });
    }
    $('connectBtn').addEventListener('click', function () {
      if (wallet.account) disconnect(); else connect();
    });
    $('depositBtn').addEventListener('click', openDeposit);
    $('withdrawBtn').addEventListener('click', openWithdraw);
  }

  /* ---- polling and init --------------------------------------------------------------- */

  function tickChain() {
    if (document.hidden) return;
    refreshHouse();
    refreshMarketChain();
    refreshAccount();
  }

  function onVisibility() {
    if (document.hidden) return;
    tickMids(true);
    tickCtx(true);
    loadCandles();
    tickChain();
  }

  function start() {
    captureRef();
    buildMarkets();
    initTheme();
    initHeader();
    initMarketMenu();
    initForm();
    initTerms();
    initTabs();
    initDialogs();
    initRefer();
    initChart();
    listenForProviders();

    if (!window.ethers) {
      toast('ethers.js did not load: prices work, wallet features are off.', 'err', null, 0);
    } else {
      initRead();
    }

    var sym = initialMarketSymbol();
    if (sym) selectMarket(sym);
    renderWallet();
    renderAction();
    renderStatus();
    renderPositions();
    renderHistory();
    renderRefer();

    tickMids(true);
    tickCtx(true);
    setInterval(function () { tickMids(false); }, MIDS_EVERY_MS);
    setInterval(function () { tickCtx(false); }, CTX_EVERY_MS);
    setInterval(function () { if (!document.hidden) loadCandles(); }, CANDLES_EVERY_MS);
    document.addEventListener('visibilitychange', onVisibility);

    if (read.provider) {
      var boot = read.exchange ? loadHouseAddresses().then(loadInstruments) : Promise.resolve();
      boot.then(function () {
        refreshHouse();
        refreshMarketChain();
        if (!hasExchange()) toast('No exchange address in config: showing live prices only.', null, null, 9000);
        refreshConfVol();
        setInterval(refreshConfVol, CONF_VOL_EVERY_MS);
        setInterval(tickChain, CHAIN_EVERY_MS);
        setInterval(function () { if (!document.hidden) loadInstruments(); }, INSTRUMENTS_EVERY_MS);
        setTimeout(tryAutoConnect, 50);
      });
    }
  }

  function init() {
    loadConfig().then(function (c) {
      cfg = c || {};
      cfg.contracts = cfg.contracts || {};
      initHouseBots(cfg.houseBots);
      var bad = pinConfig(cfg);
      start();
      if (bad.length) {
        console.error('config.json does not match the pinned contracts; using the pinned values. Differences: ' + bad.join(', '));
        toast('config.json does not match this site\'s pinned contracts (' + bad.join(', ') + '). Using the pinned addresses.', 'err', null, 0);
      }
    }).catch(function (e) {
      cfg = { contracts: {}, markets: [] };
      pinConfig(cfg);
      start();
      toast('Could not load config.json: ' + (e && e.message ? e.message : e) + '. Serve the site over http and copy config.example.json to config.json.', 'err', null, 0);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
