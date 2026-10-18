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
   One-click trading (v3): with a live SessionRouter session the browser's
   session key files requests, cancels and fallback fills with no wallet
   popup; anything it may not do (or a dead session) goes to the wallet.
   Deposits from Hyperliquid (v3): the Deposit dialog shows the trader's
   DepositProxyFactory address and sweeps it.
   The ticket (intuitive1): BUY / LONG or SELL / SHORT, an amount, a
   leverage chip, three money lines and OPEN POSITION. After a click that
   button turns into a progress card (Sent, Opening at the oracle price,
   Open) and every open position is a card with CLOSE POSITION. On a phone
   the two direction buttons sit in a bar pinned to the bottom and the
   ticket opens as a sheet. A first-trade tour rings each real button.
   No build step. Config comes from config.json (falls back to
   config.example.json). Contract ABI fragments are written by hand from
   contracts/src and cross-checked against contracts/out
   (ops/check_site_abi.js).
   ========================================================================== */
(function () {
  'use strict';

  /* Local demo for screenshots: a pretend funded account, no wallet, no chain. Only on localhost or
     127.0.0.1 with ?demo=1 (the account), ?demo=tour (and the tour) or ?demo=pending (an open
     request counting down in the ticket). On any other host (confetti.trade) DEMO is null, and
     every demo branch below starts by checking it, so nothing of the demo runs, loads or is stored. */
  var DEMO = (function () {
    try {
      var h = String(location.hostname || '');
      if (h !== 'localhost' && h !== '127.0.0.1') return null;
      var v = new URLSearchParams(location.search).get('demo');
      return v === '1' || v === 'tour' || v === 'pending' ? v : null;
    } catch (e) { return null; }
  })();

  var CHAIN_ID = 999;
  var CHAIN_HEX = '0x3e7';
  var MIDS_EVERY_MS = 2000;
  var CTX_EVERY_MS = 30000;
  var CANDLES_EVERY_MS = 60000;
  var CHAIN_EVERY_MS = 10000;
  var INSTRUMENTS_EVERY_MS = 300000;
  var V2_EVERY_MS = 30000;
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
    ref: 'confetti.ref', pending: 'confetti.trade.pending.', autoFill: 'confetti.trade.autofill',
    session: 'confetti.trade.session.', sweep: 'confetti.trade.sweep.',
    tf: 'confetti.trade.tf', ind: 'confetti.trade.ind', lines: 'confetti.trade.lines.',
    /* intuitive1: the last amount, the Details toggle, the tour (per wallet, or 'visitor'), the
       big-trade check's "don't ask again", and the last block seen per account */
    amount: 'confetti.trade.amount', details: 'confetti.trade.details', tour: 'confetti.trade.tour.',
    noConfirm: 'confetti.trade.noconfirm', seen: 'confetti.trade.seen.'
  };
  var TZ_OFFSET_S = new Date().getTimezoneOffset() * 60;
  var ZERO = '0x0000000000000000000000000000000000000000';
  /* Referral codes: 3..16 of [a-z0-9_] (Referrals.sol). The link is confetti.trade/?ref=CODE. */
  var REF_RE = /^[a-z0-9_]{3,16}$/;
  var SITE_URL = 'https://confetti.trade/';

  /* The deployment, pinned. config.json may restate these, but a config whose addresses differ is
     refused (console error + status line) and these are used, so a hijacked config cannot
     redirect a deposit; an empty pin is off (config.json cannot fill it in). ops/write_config.py
     rewrites the block between the markers from the deploy broadcast when it writes
     site/config.json, and ops/check_site_pins.js checks that the two agree. Once the exchange is
     readable its own getters (CHECKED) are compared with the pins: one that disagrees is reported
     and never becomes a transaction target. USDC is Circle's native token on HyperEVM: an exchange
     on any other token gets no deposit. The RPC and info hosts are pinned the same way; the
     pages' CSP allows exactly these hosts. */
  /* ---- BEGIN PINNED CONTRACTS (ops/write_config.py) ---- */
  var CONTRACTS = {
    exchange: '0x723943c8fdd71e0e670b18d15be737222f3a0810',
    usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
    oracle: '0x6c68f03d3b17ceed7955c13a3373cc186cdf9d1f',
    confetti: '0x995b36d7e33680fc6fa1db6fa4dc8e475b5233a2',
    tokenomics: '0xcfd4d15d4c7b4a60e8a008e23cc9fa5eba1784be',
    staking: '0x167549bb697f96ee19e0ffbfa5ab5f6487f10051',
    referrals: '0xdf0c59514877f38a7b59bd7db1422217ab25714b',
    priceSource: '0xFaF573187824D176fc74d1de91a072eb6ffa8494',
    marketRules: '0x51cbb4d222d50536785013e2afc27b5a13d53a45',
    sessionRouter: '0x42e2e55d7ea4cb4956e2f702bda59e15d8ce05fd',
    depositFactory: '0xc6b54a4aac8180ca51bbbd394e4fb6a79f60dc97',
    v2Exchange: '0x257d667a52b282ac0b4c001fd437522bf6b9cbe2'
  };
  /* ---- END PINNED CONTRACTS ---- */
  var USDC = CONTRACTS.usdc;
  var CHECKED = ['usdc', 'oracle', 'confetti', 'tokenomics', 'staking', 'referrals', 'sessionRouter', 'marketRules'];
  /* the CHECKED addresses this page sends transactions to (usdc has its own refusal: usdcBad) */
  var TX_TARGETS = { referrals: 'Refer', sessionRouter: 'One-click' };
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

  /* One-click trading (SessionRouter). The wallet sends this much HYPE with authorize; the router
     forwards it to the session key for gas. Below SESSION_MIN_GAS the key is treated as dry and the
     wallet signs again. A session never outlives MAX_SESSION (30 days, the router's limit). */
  var SESSION_GAS_HYPE = '0.01';
  var SESSION_MIN_GAS = 1000000000000000n; /* 0.001 HYPE: a few requests at a few gwei */
  var SESSION_MAX_S = 30 * 86400;
  /* Router errors that mean "this session cannot act": the call goes to the wallet instead. */
  var SESSION_ERRORS = { NoSession: true, SessionExpired: true, MarginAboveSessionCap: true };

  /* HyperCore deposits (DepositProxy): read precompiles and the proxy's own thresholds. Core USDC
     has 8 decimals, perp withdrawable 6. The proxy keeps 0.05 USDC on Core spot for the bridge
     fee and bridges only 1 USDC or more above it; perp moves to spot from 1 USDC. */
  var SPOT_BALANCE_PRECOMPILE = '0x0000000000000000000000000000000000000801';
  var WITHDRAWABLE_PRECOMPILE = '0x0000000000000000000000000000000000000803';
  var CORE_FEE_RESERVE_WEI = 5000000n;
  var MIN_BRIDGE_WEI = 100000000n;
  var MIN_PERP_USD = 1000000n;

  /* Under this much HYPE in the wallet the page says so before a transaction fails for gas. */
  var HYPE_LOW_WEI = 5000000000000000n; /* 0.005 HYPE */
  var HYPE_NOTE = 'You need a little HYPE on HyperEVM to pay network fees (about 0.01).';
  /* The leverage chips; a market shows the ones up to its cap, then Custom. */
  var LEV_CHIPS = [5, 10, 20, 50, 100, 250, 500, 1000];
  /* A big trade (this leverage and up, or Max) gets one check before the wallet. */
  var CONFIRM_LEV = 100;
  /* "Taking longer than usual" goes on screen this long before the fallback window opens, so the
     wallet prompt (autoFill) can go out the moment it opens and still have its reason in view. */
  var LATE_SHOW_MS = 1500;
  /* Wallet chain ids people arrive on, named in "Your wallet is on Ethereum". */
  var CHAIN_NAMES = {
    1: 'Ethereum', 10: 'Optimism', 56: 'BNB Chain', 100: 'Gnosis', 137: 'Polygon', 324: 'zkSync', 998: 'HyperEVM testnet',
    8453: 'Base', 42161: 'Arbitrum', 43114: 'Avalanche', 59144: 'Linea', 81457: 'Blast', 11155111: 'Sepolia'
  };

  /* ---- tiny helpers ------------------------------------------------------- */

  function $(id) { return document.getElementById(id); }

  // On phones the timeframe picker floats over the chart (trade.html, .chart-bar at <=600px). The price scale's width
  // depends on the coin's decimals, so hand it to the CSS as --scale-w and the picker sits just left of it.
  function placeChartBar() {
    var bar = $('chartBar');
    if (!bar || !chart.api || !window.requestAnimationFrame) return;
    requestAnimationFrame(function () {
      var w = 0;
      try { w = chart.api.priceScale('right').width(); } catch (e) { return; }
      if (w) bar.style.setProperty('--scale-w', w + 'px');
    });
  }

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

  /* "$10" for whole dollars, "$12.50" otherwise: the amount as people say it. */
  function fmtUsdShort(n) {
    if (n == null || !isFinite(n)) return '—';
    return Math.abs(n - Math.round(n)) < 0.005 && n >= 0 ? '$' + Math.round(n).toLocaleString('en-US') : fmtUsd(n);
  }

  /* "+3.6%": P&L as a share of the amount put in. */
  function fmtPct1(x) {
    if (x == null || !isFinite(x)) return '';
    return (x > 0 ? '+' : x < 0 ? '-' : '') + Math.abs(x * 100).toFixed(1) + '%';
  }

  /* A move already in percent, trimmed: 4.75, 0.95, 9.5, 0.05. */
  function fmtMove(p) { return isFinite(p) ? String(Number(p.toFixed(p >= 1 ? 2 : 3))) : '—'; }

  /* A coin quantity for "about 1,000 DOGE". */
  function fmtQty(q) {
    if (!isFinite(q) || q <= 0) return '—';
    if (q >= 1000) return fmtInt(q);
    return String(Number(q.toPrecision(q >= 1 ? 4 : 3)));
  }

  function sideWord(isLong) { return isLong ? 'Long' : 'Short'; }

  function chainName(id) { return CHAIN_NAMES[id] || (id ? 'network ' + id : 'another network'); }

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
     values are in force either way, so a transaction target never comes from the network. A zero
     address (config.example.json) counts as unset, not as a disagreement; an address under a name
     with no pin is a disagreement. */
  function pinConfig(c) {
    var bad = [];
    var src = c.contracts && typeof c.contracts === 'object' ? c.contracts : {};
    Object.keys(src).forEach(function (k) {
      var s = src[k] == null ? '' : String(src[k]);
      var pin = Object.prototype.hasOwnProperty.call(CONTRACTS, k) ? CONTRACTS[k] : '';
      if (s && s.toLowerCase() !== ZERO && s.toLowerCase() !== pin.toLowerCase()) bad.push('contracts.' + k + ' ' + s);
    });
    c.contracts = {};
    Object.keys(CONTRACTS).forEach(function (k) { if (CONTRACTS[k]) c.contracts[k] = CONTRACTS[k]; });
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
    /* v3: the session router (trusted forwarder) and the market-rules module; revert on v2 */
    'function sessionRouter() view returns (address)',
    'function marketRules() view returns (address)',
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
    'error MigrationPending()',
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

  /* SessionRouter.sol (v3): created by the Exchange; its address comes from exchange.sessionRouter(). */
  var ROUTER_ABI = [
    'function authorize(address sessionKey, uint64 expiry, uint128 maxMarginPerTrade, address referrer, bytes keySig) payable',
    'function authorizationDigest(address trader, address sessionKey, uint64 expiry, uint128 maxMarginPerTrade, address referrer) view returns (bytes32)',
    'function revoke()',
    'function requestOpen(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage) returns (uint256 requestId)',
    'function requestClose(uint256 positionId)',
    'function cancelOpen(uint256 requestId)',
    'function cancelClose(uint256 positionId)',
    'function sessionOf(address trader) view returns (tuple(address key, uint64 expiry, uint128 maxMarginPerTrade, address referrer))',
    'function traderOf(address sessionKey) view returns (address)',
    'function MAX_SESSION() view returns (uint64)',
    'function exchange() view returns (address)',
    'event SessionAuthorized(address indexed trader, address indexed sessionKey, uint64 expiry, uint128 maxMarginPerTrade, address referrer, uint256 gasFundedWei)',
    'event SessionRevoked(address indexed trader, address indexed sessionKey)',
    'error ZeroAddress()',
    'error BadExpiry(uint64 expiry)',
    'error ZeroMarginCap()',
    'error KeyInUse(address sessionKey)',
    'error GasForwardFailed()',
    'error BadKeySignature()',
    'error NoSession()',
    'error SessionExpired(uint64 expiry)',
    'error MarginAboveSessionCap(uint128 marginUsdc, uint128 maxMarginPerTrade)',
    'error NotYours()'
  ];

  /* DepositProxyFactory.sol (v3): config contracts.depositFactory, used only if it names this exchange. */
  var FACTORY_ABI = [
    'function proxyOf(address trader) view returns (address)',
    'function sweep(address trader) returns (uint256 depositedUsdc, uint64 bridgedWei, uint64 perpToSpotWei)',
    'function exchange() view returns (address)',
    'function usdc() view returns (address)',
    'event ProxyDeployed(address indexed trader, address indexed proxy)',
    'error ZeroAddress()'
  ];

  /* DepositProxy.sol: the Swept event in a sweep receipt and the errors a sweep can bubble. */
  var PROXY_ABI = [
    'event Swept(uint256 depositedUsdc, uint64 bridgedWei, uint64 perpToSpotWei)',
    'error NotTrader()'
  ];

  /* The v2 Exchange (config contracts.v2Exchange): the three balances behind the Status tab's
     link to v2.html. Checked by ops/check_site_abi.js against ops/abi/ExchangeV2.json, not the v3 build. */
  var V2_EXCHANGE_ABI = [
    'function balanceOf(address user) view returns (uint256 availableUsdc)',
    'function marginInUse(address user) view returns (uint256 usdc)',
    'function pendingOf(address user) view returns (uint256 usdc)'
  ];

  var exIface = null; /* ethers.Interface for EXCHANGE_ABI */
  var refIface = null; /* ethers.Interface for REFERRALS_ABI */
  var routerIface = null; /* ROUTER_ABI */
  var proxyIface = null; /* PROXY_ABI */

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

  /* The ticket. margin starts at $10 (or the last amount used); touched: the user edited it;
     maxed: the amount came from Max (that trade gets the check); levCustom: Custom is open. */
  var form = { side: 'long', margin: 10, lev: 20, touched: false, maxed: false, levCustom: false };

  /* Page furniture: sheet, the ticket sheet is open (phones); closing, position ids waiting on the
     wallet for their close; checking, ids whose close request is gone from chain and whose result
     is being looked up in the logs (the position as last read, so its card can say so even once
     the position is gone); settling, ids whose close is known to have filled (their card says so
     until the next read drops them); retrying, ids whose expired close is being cleared and filed
     again; reported, ids whose end (closed or liquidated) has been reported, so a second report
     from another path stays quiet; recent, result cards (closed, liquidated, away); hypeWei, the
     wallet's HYPE; posSig, the shape of the last positions render; awayDone, per account: the
     "while you were away" scan is 'running', 'done' or 'failed' (LS.seen moves only after 'done');
     owedSig / owedAt, the queue state and time of the last "owed to you" read. */
  var ui = {
    sheet: false, closing: {}, checking: {}, settling: {}, retrying: {}, reported: {}, recent: [], hypeWei: null, posSig: '',
    awayDone: {}, posInView: false, owedSig: '', owedAt: 0
  };

  /* The ticket's progress card: what OPEN POSITION turned into after the click. phase: null (the
     form), 'wallet' (waiting on the wallet or the one-click key), 'req' (filed as reqId: its own
     phase says opening, late or expired), 'opened' (entry), 'refunded', 'error' or 'unknown' (msg:
     the request is gone and the logs never said how). */
  var tk = { phase: null, reqId: null, isLong: true, sym: '', lev: 0, margin: 0, entry: NaN, posId: null, msg: '', timer: null };

  var wallet = { eth: null, provider: null, signer: null, account: null, chainId: null, subscribed: false };

  /* pending: margin held by the account's open requests (pendingOf); closeReqs: per position id,
     the pending close request { requestedAt, px0 } or nothing. */
  var acct = { loaded: false, available: 0, marginInUse: 0, pending: 0, positions: [], closeReqs: {}, walletUsdc: 0, allowance: 0 };

  var house = {
    addrs: {}, unpinned: {}, lp: null, feePool: null, queued: null, queueLen: null, queueHead: null,
    globalPaused: false, breakerTripped: false, breakerBps: null, instCount: null, block: null, blockAt: 0, oi: {},
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
    if (DEMO) return Promise.resolve();
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

  var read = { provider: null, logProvider: null, exchange: null, referrals: null, router: null, factory: null, v2: null };

  /* The Status tab's v2 link: shown for the connected account while the v2 Exchange still holds its
     balance, margin or a pending open request (a pending close keeps its position's margin in use). */
  var v2link = { account: null, at: 0, show: false, total: 0 };

  /* One-click session of the connected account. key: ethers.Wallet from localStorage (or null);
     onchain: router.sessionOf(account) { key, expiry, cap } once read; gasWei: the key's HYPE. */
  var sess = { key: null, onchain: null, gasWei: null, loaded: false };

  /* Deposit from Hyperliquid: the account's proxy and what waits on it. spotFreeWei: Core spot USDC
     (total - hold, 8 dec), perp6: Core perp withdrawable, evm6: HyperEVM USDC on the proxy; null when
     unreadable. */
  var hl = { account: null, proxy: null, spotFreeWei: null, perp6: null, evm6: null };

  /* The fill keeper's last-fill age (keeper.js), shown in the Status tab; read every 30 s. */
  var keeper = null;
  var keeperAt = 0;
  var KEEPER_EVERY_MS = 30000;

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

  /* The live dot says nothing while prices flow; it shows words only when they stop. */
  function setLive(ok) {
    var chip = $('chipLive');
    if (!chip) return;
    chip.classList.toggle('is-stale', !ok);
    chip.title = ok ? 'Live prices' : 'Prices stopped updating. Retrying.';
    var t = $('chipLiveText');
    if (t) { t.textContent = ok ? 'live' : 'prices stale'; t.className = ok ? 'sr-only' : ''; }
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

  /* Timeframes: Hyperliquid candleSnapshot intervals and each bucket's length. */
  var TF_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

  /* Indicators in menu order. Line colours: the night palette's confetti colours (share.js). */
  var INDS = [
    { key: 'vol', label: 'Volume', short: 'Vol' },
    { key: 'ema9', label: 'EMA 9', short: 'EMA 9', color: '#facc15' },
    { key: 'ema21', label: 'EMA 21', short: 'EMA 21', color: '#788cff' },
    { key: 'vwap', label: 'VWAP', short: 'VWAP', color: '#ff8cc8' },
    { key: 'bb', label: 'Bollinger 20 2', short: 'BB', color: null }
  ];
  var USER_LINE_HIT_PX = 6;

  /* candles: { t, o, h, l, c, v } oldest first; byTime: bar time -> index; on: indicator keys shown;
     ind: key -> its series; vals: key -> values per candle (null before enough history); pos: the
     connected wallet's entry / bust price lines; lines: the drawn { price, line }; arm: the next click draws. */
  var chart = {
    api: null, series: null, coin: null, tf: '1m', candles: [], byTime: {}, loading: false, seq: 0, precision: 4,
    on: {}, ind: {}, vals: {}, hover: false, pos: [], posSig: '', lines: [], linesCoin: null, arm: false
  };

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
      accent: cssVar('--accent', '#8b2020'),
      page: cssVar('--page', '#f4ecd8'),
      mono: cssVar('--font-mono', 'monospace')
    };
  }

  function rgba(hex, a) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    return 'rgba(' + (n >> 16) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')';
  }

  function indDef(k) { return INDS.filter(function (d) { return d.key === k; })[0] || null; }
  function indColor(d) { return d.color || chartTheme().muted; }

  /* With volume on, the candles keep off the bottom fifth where the bars stand. */
  function priceMargins() { return { top: 0.12, bottom: chart.on.vol ? 0.24 : 0.08 }; }

  function chartOptions() {
    var t = chartTheme();
    var LW = window.LightweightCharts;
    return {
      autoSize: true,
      layout: { background: { type: 'solid', color: t.raised }, textColor: t.muted, fontFamily: t.mono, fontSize: 11 },
      grid: { vertLines: { color: t.rule, style: 1 }, horzLines: { color: t.rule, style: 1 } },
      rightPriceScale: { borderColor: t.ruleStrong, scaleMargins: priceMargins() },
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

  function priceFormat() { return { type: 'price', precision: chart.precision, minMove: Math.pow(10, -chart.precision) }; }

  function seriesOptions() {
    var t = chartTheme();
    return {
      upColor: t.pos, downColor: t.neg,
      borderUpColor: t.pos, borderDownColor: t.neg,
      wickUpColor: t.pos, wickDownColor: t.neg,
      priceLineColor: t.ink,
      priceFormat: priceFormat()
    };
  }

  function initChart() {
    var host = $('chart');
    var tf = lsGet(LS.tf);
    if (TF_MS[tf]) chart.tf = tf;
    String(lsGet(LS.ind) || '').split(',').forEach(function (k) { if (indDef(k)) chart.on[k] = true; });
    initChartTools();
    renderTf();
    if (!host || !window.LightweightCharts) {
      chartNote('chart library unavailable', true);
      return;
    }
    chart.api = window.LightweightCharts.createChart(host, chartOptions());
    chart.series = chart.api.addCandlestickSeries(seriesOptions());
    INDS.forEach(function (d) { if (chart.on[d.key]) addInd(d.key); });
    chart.api.subscribeCrosshairMove(onCrosshair);
    chart.api.subscribeClick(onChartClick);
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

  function barTime(t) { return Math.floor(t / 1000) - TZ_OFFSET_S; }

  function toBar(k) {
    return { time: barTime(k.t), open: k.o, high: k.h, low: k.l, close: k.c };
  }

  function indexCandles() {
    chart.byTime = {};
    chart.candles.forEach(function (k, i) { chart.byTime[barTime(k.t)] = i; });
  }

  /* force: a market or timeframe switch, which supersedes a load in flight; the 60 s refresh does not. */
  function loadCandles(force) {
    var m = state.market;
    if (!m || !chart.series || (chart.loading && !force)) return;
    chart.loading = true;
    var seq = ++chart.seq, coin = m.coin, tf = chart.tf;
    var end = Date.now();
    var start = end - (CANDLE_COUNT + 2) * TF_MS[tf];
    postInfo({ type: 'candleSnapshot', req: { coin: coin, interval: tf, startTime: start, endTime: end } }, 8000)
      .then(function (rows) {
        if (seq !== chart.seq) return;
        if (!Array.isArray(rows)) throw new Error('bad candles');
        var parsed = rows.map(function (r) {
          return { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) || 0 };
        }).filter(function (k) {
          return isFinite(k.t) && isFinite(k.o) && isFinite(k.h) && isFinite(k.l) && isFinite(k.c) && k.c > 0;
        }).slice(-CANDLE_COUNT);
        if (parsed.length === 0) throw new Error('no candles');
        var reset = chart.coin !== coin;
        chart.coin = coin;
        chart.candles = parsed;
        indexCandles();
        var last = parsed[parsed.length - 1].c;
        var precision = pricePrecision(last, m.szDecimals);
        if (precision !== chart.precision || reset) {
          chart.precision = precision;
          chart.series.applyOptions(seriesOptions());
          INDS.forEach(function (d) {
            if (d.key !== 'vol' && chart.ind[d.key]) chart.ind[d.key].forEach(function (s) { s.applyOptions({ priceFormat: priceFormat() }); });
          });
        }
        chart.series.setData(parsed.map(toBar));
        fillInds(true);
        if (reset) chart.api.timeScale().scrollToRealTime();
        chartNote('', false);
        if (!chart.hover) renderLegend(-1);
        placeChartBar();
        if (!state.mids[coin]) { state.mids[coin] = last; onPrices(); }
      })
      .catch(function () {
        if (seq !== chart.seq) return;
        if (chart.coin !== coin) {
          chart.coin = coin;
          chart.candles = [];
          chart.byTime = {};
          chart.series.setData([]);
          fillInds(true);
          renderLegend(-1);
        }
        chartNote('candles unavailable · retrying', true);
      })
      .then(function () { if (seq === chart.seq) chart.loading = false; });
  }

  /* Empty the chart for a new market or timeframe; the next load fills it. */
  function clearCandles() {
    chart.coin = null;
    chart.candles = [];
    chart.byTime = {};
    if (!chart.series) return;
    chart.series.setData([]);
    fillInds(true);
    renderLegend(-1);
  }

  /* Fold a fresh mid into the open bucket of the shown timeframe, or open the next one. */
  function updateChartFromMid(px) {
    if (!chart.series || !state.market || chart.coin !== state.market.coin || chart.candles.length === 0) return;
    var ms = TF_MS[chart.tf];
    var bucket = Math.floor(Date.now() / ms) * ms;
    var last = chart.candles[chart.candles.length - 1];
    if (bucket > last.t) {
      var bar = { t: bucket, o: last.c, h: Math.max(last.c, px), l: Math.min(last.c, px), c: px, v: 0 };
      chart.candles.push(bar);
      if (chart.candles.length > CANDLE_COUNT) chart.candles.shift();
      indexCandles();
      chart.series.update(toBar(bar));
    } else {
      last.c = px;
      if (px > last.h) last.h = px;
      if (px < last.l) last.l = px;
      chart.series.update(toBar(last));
    }
    fillInds(false);
    if (!chart.hover) renderLegend(-1);
  }

  /* ---- chart indicators ---- */

  function emaVals(cs, n) {
    var out = new Array(cs.length).fill(null), k = 2 / (n + 1), e = 0;
    for (var i = 0; i < cs.length; i++) {
      if (i < n) { e += cs[i].c; if (i === n - 1) { e /= n; out[i] = e; } continue; }
      e = cs[i].c * k + e * (1 - k);
      out[i] = e;
    }
    return out;
  }

  /* VWAP over the loaded range (the session is what the chart holds). */
  function vwapVals(cs) {
    var pv = 0, vol = 0;
    return cs.map(function (k) {
      pv += (k.h + k.l + k.c) / 3 * k.v; vol += k.v;
      return vol > 0 ? pv / vol : null;
    });
  }

  /* Bollinger 20 / 2: [upper, middle, lower] per candle. */
  function bbVals(cs) {
    var n = 20;
    return cs.map(function (k, i) {
      if (i < n - 1) return null;
      var sum = 0, sq = 0;
      for (var j = i - n + 1; j <= i; j++) { sum += cs[j].c; sq += cs[j].c * cs[j].c; }
      var mean = sum / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
      return [mean + 2 * sd, mean, mean - 2 * sd];
    });
  }

  function computeInd(k) {
    var cs = chart.candles;
    if (k === 'vol') return cs.map(function (c) { return c.v; });
    if (k === 'ema9') return emaVals(cs, 9);
    if (k === 'ema21') return emaVals(cs, 21);
    if (k === 'vwap') return vwapVals(cs);
    return bbVals(cs);
  }

  /* The points of series j of indicator k at candle i, or null. */
  function indPoint(k, j, i) {
    var v = chart.vals[k][i], c = chart.candles[i], time = barTime(c.t);
    if (v == null) return null;
    if (k === 'vol') {
      var t = chartTheme();
      return { time: time, value: v, color: rgba(c.c >= c.o ? t.pos : t.neg, 0.4) };
    }
    return { time: time, value: k === 'bb' ? v[j] : v };
  }

  /* full: setData from every candle; else update the last bar only (a live tick). */
  function fillInds(full) {
    INDS.forEach(function (d) {
      var k = d.key, list = chart.ind[k];
      if (!list) return;
      chart.vals[k] = computeInd(k);
      var n = chart.candles.length;
      list.forEach(function (s, j) {
        if (full) {
          var pts = [];
          for (var i = 0; i < n; i++) { var p = indPoint(k, j, i); if (p) pts.push(p); }
          s.setData(pts);
        } else if (n) {
          var last = indPoint(k, j, n - 1);
          if (last) s.update(last);
        }
      });
    });
  }

  function lineOpts(color, style) {
    return {
      color: color, lineWidth: 1, lineStyle: style || 0, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, priceFormat: priceFormat()
    };
  }

  function addInd(k) {
    var api = chart.api, d = indDef(k), c = indColor(d);
    if (k === 'vol') {
      var v = api.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      chart.ind.vol = [v];
      api.priceScale('right').applyOptions({ scaleMargins: priceMargins() });
    } else if (k === 'bb') {
      chart.ind.bb = [api.addLineSeries(lineOpts(c)), api.addLineSeries(lineOpts(c, 2)), api.addLineSeries(lineOpts(c))];
    } else {
      chart.ind[k] = [api.addLineSeries(lineOpts(c))];
    }
  }

  function removeInd(k) {
    (chart.ind[k] || []).forEach(function (s) { chart.api.removeSeries(s); });
    delete chart.ind[k];
    delete chart.vals[k];
    if (k === 'vol') chart.api.priceScale('right').applyOptions({ scaleMargins: priceMargins() });
  }

  function toggleInd(k) {
    if (chart.on[k]) delete chart.on[k]; else chart.on[k] = true;
    lsSet(LS.ind, INDS.filter(function (d) { return chart.on[d.key]; }).map(function (d) { return d.key; }).join(','));
    if (chart.api) {
      if (chart.on[k]) { addInd(k); fillInds(true); } else removeInd(k);
    }
    renderIndMenu();
    renderLegend(-1);
  }

  /* ---- chart legend: the hovered candle (else the live one) and each indicator's value ---- */

  function fmtChartPx(v) { return v == null || !isFinite(v) ? '—' : Number(v).toFixed(chart.precision); }

  function fmtVol(v) {
    if (!isFinite(v)) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
    return v.toFixed(v >= 10 ? 0 : 2);
  }

  function onCrosshair(param) {
    var i = param && param.point && param.time != null ? chart.byTime[param.time] : undefined;
    chart.hover = i != null;
    renderLegend(chart.hover ? i : -1);
  }

  /* i: candle index, -1 for the last one. */
  function renderLegend(i) {
    var host = $('chartLegend');
    if (!host) return;
    host.textContent = '';
    var n = chart.candles.length;
    if (!n) return;
    if (i < 0 || i >= n) i = n - 1;
    var k = chart.candles[i], prev = i > 0 ? chart.candles[i - 1].c : k.o;
    var chg = prev > 0 ? k.c / prev - 1 : NaN;
    var cls = k.c >= k.o ? 'pos' : 'neg';
    var row = el('div', 'chart-legend-row');
    [['O', k.o], ['H', k.h], ['L', k.l], ['C', k.c]].forEach(function (p) {
      var s = el('span', null, p[0] + ' ');
      s.appendChild(el('b', cls, fmtChartPx(p[1])));
      row.appendChild(s);
    });
    row.appendChild(el('b', chg >= 0 ? 'pos' : 'neg', isFinite(chg) ? fmtPct(chg, true) : '—'));
    host.appendChild(row);
    var shown = INDS.filter(function (d) { return chart.on[d.key] && chart.vals[d.key]; });
    if (!shown.length) return;
    var irow = el('div', 'chart-legend-row');
    shown.forEach(function (d) {
      var v = chart.vals[d.key][i];
      var s = el('span', null, d.short + ' ');
      var b = el('b', null, v == null ? '—' : d.key === 'vol' ? fmtVol(v) : d.key === 'bb' ? v.map(fmtChartPx).join(' / ') : fmtChartPx(v));
      if (d.key !== 'vol') b.style.color = indColor(d);
      s.appendChild(b);
      irow.appendChild(s);
    });
    host.appendChild(irow);
  }

  /* ---- chart price lines: the wallet's positions on the shown market, and drawn lines ---- */

  function syncPositionLines() {
    if (!chart.series) return;
    var m = state.market;
    var mine = m && wallet.account && m.instrumentId != null
      ? acct.positions.filter(function (p) { return p.instrumentId === m.instrumentId; }) : [];
    var sig = mine.map(function (p) { return String(p.id) + ':' + String(p.entryPx18) + ':' + p.leverage + ':' + p.isLong; }).join(',');
    if (sig === chart.posSig) return;
    chart.posSig = sig;
    chart.pos.forEach(function (l) { chart.series.removePriceLine(l); });
    chart.pos = [];
    var t = chartTheme();
    mine.forEach(function (p) {
      var tag = mine.length > 1 ? ' ' + sideWord(p.isLong).toLowerCase() + ' ' + p.leverage + 'x' : '';
      chart.pos.push(chart.series.createPriceLine({ price: p.entry, color: t.ink, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'entry' + tag }));
      var bust = px18ToNum(bustPrice18(p.entryPx18, p.isLong, p.leverage));
      if (bust > 0) chart.pos.push(chart.series.createPriceLine({ price: bust, color: t.accent, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: 'liq.' + tag }));
    });
  }

  function userLineOpts(price) {
    /* the axis label carries the price; no title beside it */
    return { price: price, color: chartTheme().muted, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' };
  }

  /* The shown market's drawn lines from localStorage (prices, per coin). */
  function loadUserLines() {
    if (!chart.series || !state.market) return;
    var coin = state.market.coin;
    if (chart.linesCoin === coin) return;
    chart.lines.forEach(function (u) { chart.series.removePriceLine(u.line); });
    chart.lines = [];
    chart.linesCoin = coin;
    var saved = [];
    try { saved = JSON.parse(lsGet(LS.lines + coin) || '[]'); } catch (e) { saved = []; }
    (Array.isArray(saved) ? saved : []).forEach(function (p) {
      p = Number(p);
      if (isFinite(p) && p > 0) chart.lines.push({ price: p, line: chart.series.createPriceLine(userLineOpts(p)) });
    });
    renderLineTools();
  }

  function saveUserLines() {
    if (chart.linesCoin) lsSet(LS.lines + chart.linesCoin, JSON.stringify(chart.lines.map(function (u) { return u.price; })));
    renderLineTools();
  }

  function addUserLine(price) {
    price = Number(price.toFixed(chart.precision));
    if (!(price > 0)) return;
    chart.lines.push({ price: price, line: chart.series.createPriceLine(userLineOpts(price)) });
    saveUserLines();
  }

  function clearUserLines() {
    chart.lines.forEach(function (u) { chart.series.removePriceLine(u.line); });
    chart.lines = [];
    saveUserLines();
  }

  function armLine(on) {
    chart.arm = !!on && !!chart.series;
    renderLineTools();
  }

  /* Armed: the click draws a line at its price. Else a click on a drawn line removes it. */
  function onChartClick(param) {
    if (!param || !param.point || !chart.series) return;
    var y = param.point.y;
    if (chart.arm) {
      var px = chart.series.coordinateToPrice(y);
      armLine(false);
      if (px != null && isFinite(px)) addUserLine(Number(px));
      return;
    }
    var best = -1, bestD = USER_LINE_HIT_PX + 1;
    chart.lines.forEach(function (u, i) {
      var cy = chart.series.priceToCoordinate(u.price);
      var d = cy == null ? Infinity : Math.abs(cy - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return;
    chart.series.removePriceLine(chart.lines[best].line);
    chart.lines.splice(best, 1);
    saveUserLines();
  }

  /* ---- chart header: timeframe buttons, indicators menu, line tool ---- */

  function initChartTools() {
    var tfs = $('chartTf');
    if (tfs) tfs.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tf]');
      if (b) setTf(b.getAttribute('data-tf'));
    });
    /* phones: one 44 px picker instead of six small buttons */
    var tfSel = $('tfSelect');
    if (tfSel) tfSel.addEventListener('change', function () { setTf(tfSel.value); });
    var menu = $('indMenu'), btn = $('indBtn');
    if (menu && btn) {
      INDS.forEach(function (d) {
        var item = el('button', 'chart-menu-item');
        item.type = 'button';
        item.setAttribute('role', 'menuitemcheckbox');
        item.setAttribute('data-ind', d.key);
        var box = el('span', 'chart-menu-box');
        box.style.color = d.key === 'vol' ? chartTheme().pos : indColor(d);
        item.appendChild(box);
        item.appendChild(el('span', null, d.label));
        item.addEventListener('click', function () { toggleInd(d.key); });
        menu.appendChild(item);
      });
      btn.addEventListener('click', function (e) { e.stopPropagation(); showIndMenu(menu.hidden); });
      document.addEventListener('click', function (e) { if (!menu.hidden && !menu.contains(e.target)) showIndMenu(false); });
      renderIndMenu();
    }
    var line = $('lineBtn');
    if (line) line.addEventListener('click', function () { armLine(!chart.arm); });
    var clear = $('lineClear');
    if (clear) clear.addEventListener('click', function () { armLine(false); clearUserLines(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (chart.arm) armLine(false);
      if (menu && !menu.hidden) showIndMenu(false);
    });
  }

  function showIndMenu(open) {
    var menu = $('indMenu'), btn = $('indBtn');
    if (!menu || !btn) return;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function renderIndMenu() {
    var menu = $('indMenu');
    if (!menu) return;
    Array.prototype.forEach.call(menu.querySelectorAll('[data-ind]'), function (b) {
      b.setAttribute('aria-checked', chart.on[b.getAttribute('data-ind')] ? 'true' : 'false');
    });
    var n = INDS.filter(function (d) { return chart.on[d.key]; }).length;
    setText('indBtn', n ? 'Indicators ' + n : 'Indicators');
  }

  function renderLineTools() {
    var line = $('lineBtn'), clear = $('lineClear'), box = $('chartBox');
    if (line) line.setAttribute('aria-pressed', chart.arm ? 'true' : 'false');
    if (clear) clear.hidden = chart.lines.length === 0;
    if (box) box.classList.toggle('is-arming', chart.arm);
  }

  function setTf(tf) {
    if (!TF_MS[tf] || tf === chart.tf) return;
    chart.tf = tf;
    lsSet(LS.tf, tf);
    renderTf();
    clearCandles();
    loadCandles(true);
  }

  function renderTf() {
    var tfs = $('chartTf');
    if (tfs) Array.prototype.forEach.call(tfs.querySelectorAll('[data-tf]'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-tf') === chart.tf ? 'true' : 'false');
    });
    var tfSel = $('tfSelect');
    if (tfSel && tfSel.value !== chart.tf) tfSel.value = chart.tf;
  }

  /* ---- markets --------------------------------------------------------------- */

  function tierLetter(m) { return m.inst ? ['A', 'B', 'C'][m.inst.tier] || '?' : String(m.tier || '?'); }
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
    form.levCustom = false;

    renderMarketHeader();
    renderLeverage();
    renderForm();
    renderAction();
    renderStatus();
    closeMarketMenu();
    if (changed || !chart.coin) {
      if (chart.coin !== m.coin) clearCandles();
      renderTf();
      loadUserLines();
      syncPositionLines();
      loadCandles(true);
      refreshMarketChain();
    }
  }

  /* A first visit opens at 20x (or the market's cap when lower); after that the user's own
     choice is remembered per market (LS.lev). */
  function defaultLeverage(m) { return Math.min(20, maxLev(m)); }

  /* On chain and open: a market the page may offer. Before the instruments are read, every market counts. */
  function marketOnChain(m) { return !hasExchange() || !state.instrumentsLoaded || !!m.inst; }

  /* The word beside the coin when it takes no new trades. */
  function marketTagText(m) {
    if (!m) return '';
    if (!marketOnChain(m)) return 'soon';
    if (m.inst && m.inst.retired) return 'closed';
    if ((m.inst && m.inst.opensPaused) || house.globalPaused || house.breakerTripped) return 'paused';
    return '';
  }

  function renderMarketHeader() {
    var m = state.market;
    if (!m) return;
    setText('marketSym', m.symbol);
    setText('marketTier', 'up to ' + maxLev(m) + 'x');
    var tag = $('marketTag');
    if (tag) { var tt = marketTagText(m); tag.textContent = tt; tag.hidden = !tt; }
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
    setText('sheetTitle', m.symbol + ' · ' + fmtPrice(px, m.szDecimals));
    document.title = (isFinite(px) ? fmtPrice(px, m.szDecimals) + ' ' : '') + m.symbol + ' — confetti_';
  }

  /* Market menu: grouped by how far leverage goes (Up to 1000x, Up to 250x ...), BTC and ETH first.
     Markets not on chain yet are one greyed "Coming soon" line that cannot be picked. */

  function buildMarketMenu() {
    var list = $('marketList');
    if (!list) return;
    list.textContent = '';
    var filter = ($('marketFilter') && $('marketFilter').value || '').trim().toLowerCase();
    var live = [], soon = [];
    state.markets.forEach(function (m) {
      if (filter && m.symbol.toLowerCase().indexOf(filter) === -1) return;
      (marketOnChain(m) ? live : soon).push(m);
    });
    var firsts = ['BTC', 'ETH'];
    function rank(m) { var i = firsts.indexOf(m.symbol); return i < 0 ? firsts.length : i; }
    live.sort(function (a, b) { return rank(a) - rank(b) || state.markets.indexOf(a) - state.markets.indexOf(b); });
    var caps = [];
    live.forEach(function (m) { if (caps.indexOf(maxLev(m)) < 0) caps.push(maxLev(m)); });
    caps.sort(function (a, b) { return b - a; });
    caps.forEach(function (cap) {
      list.appendChild(el('div', 'label market-group', 'Up to ' + cap + 'x'));
      live.filter(function (m) { return maxLev(m) === cap; }).forEach(function (m) {
        var row = el('button', 'market-row');
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.setAttribute('data-sym', m.symbol);
        row.setAttribute('aria-selected', state.market === m ? 'true' : 'false');
        var sym = el('span', 'sym');
        sym.appendChild(el('span', null, m.symbol));
        var tt = marketTagText(m);
        if (tt) sym.appendChild(el('span', 'market-tag', tt));
        row.appendChild(sym);
        row.appendChild(el('span', 'px', fmtPrice(marketPrice(m), m.szDecimals)));
        row.appendChild(el('span', 'chg', ''));
        row.addEventListener('click', function () { selectMarket(m.symbol); tourEvent('market'); });
        list.appendChild(row);
      });
    });
    if (soon.length) list.appendChild(el('div', 'market-soon', 'Coming soon: ' + soon.map(function (m) { return m.symbol; }).join(', ')));
    if (!live.length && !soon.length) list.appendChild(el('div', 'market-soon', 'No coin by that name.'));
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
    setText('levWild', max + 'x max');
    setText('levNow', form.lev + 'x');
    renderLevChips(max);
  }

  /* The leverage chips up to the market's cap, then Custom (the slider and the box). The chip equal
     to the leverage is lit; a leverage between chips lights Custom and keeps it open. */
  function renderLevChips(max) {
    var host = $('levChips');
    if (!host) return;
    var vals = LEV_CHIPS.filter(function (v) { return v <= max; });
    if (vals.indexOf(max) < 0) vals.push(max);
    var sig = vals.join(',');
    if (host.getAttribute('data-sig') !== sig) {
      host.textContent = '';
      vals.forEach(function (v) {
        var b = el('button', 'pick', v + 'x');
        b.type = 'button';
        b.setAttribute('data-lev', String(v));
        host.appendChild(b);
      });
      var c = el('button', 'pick pick-custom', 'Custom');
      c.type = 'button';
      c.setAttribute('data-lev', 'custom');
      host.appendChild(c);
      host.setAttribute('data-sig', sig);
    }
    var custom = form.levCustom || vals.indexOf(form.lev) < 0;
    Array.prototype.forEach.call(host.querySelectorAll('[data-lev]'), function (b) {
      var v = b.getAttribute('data-lev');
      b.setAttribute('aria-pressed', (v === 'custom' ? custom : !custom && Number(v) === form.lev) ? 'true' : 'false');
    });
    var box = $('levCustom');
    if (box) box.hidden = !custom;
  }

  function setLev(v) {
    var max = state.market ? maxLev(state.market) : 1000;
    form.lev = clamp(Math.round(v) || 1, 1, max);
    if (state.market) lsSet(LS.lev + state.market.symbol, String(form.lev));
    renderLeverage(); renderForm(); renderAction();
  }

  /* The amount chips: $10 $25 $50 lit when the box says so, Max while the amount came from it. */
  function renderAmountChips() {
    var host = $('amtChips');
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('[data-amt]'), function (b) {
      var v = b.getAttribute('data-amt');
      var on = v === 'max' ? form.maxed : !form.maxed && Number(v) === form.margin;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /* A position as if opened now at px with the ticket's amount, side and leverage: what the money
     lines and the check before a big trade are priced on. Zero terms fall back to the market's. */
  function pretendPos(px, margin) {
    return { entry: px, margin: margin, leverage: form.lev, isLong: form.side === 'long', feeBps: -1, deadbandBps: 0, payoutCapX: 0 };
  }

  /* Seconds from a request to its expected fill: the keeper's wait plus a block. */
  function fillSecs() { return house.minDelay + 1; }

  /* The ticket in money: the liquidation price on each direction button, what the leverage means,
     the position size, what a 1% move pays, the price it opens near. Details holds the win cap, the
     trim on small wins, the fee and the biggest position. No house balance anywhere. */
  function renderForm() {
    var m = state.market;
    var sz = m ? m.szDecimals : null;
    var sym = m ? m.symbol : '';
    var inst = m && m.inst ? m.inst : null;
    var px = openPriceFor(m);
    var margin = isFinite(form.margin) && form.margin > 0 ? form.margin : NaN;
    var notional = isFinite(margin) ? margin * form.lev : NaN;
    var isLong = form.side === 'long';
    setText('liqLong', fmtPrice(bustPriceNum(px, true, form.lev), sz));
    setText('liqShort', fmtPrice(bustPriceNum(px, false, form.lev), sz));
    setText('levNote', form.lev + 'x: a ' + fmtMove(bustMovePct(form.lev)) + '% move against you liquidates your ' + (isFinite(margin) ? fmtUsdShort(margin) : 'amount') + '.');
    setText('orderValue', isFinite(notional) ? fmtUsd(notional) + (px > 0 ? ' (about ' + fmtQty(notional / px) + ' ' + sym + ')' : '') : '—');
    setText('moveKey', 'If ' + (sym || 'the price') + ' moves 1% your way');
    var win = isFinite(notional) && px > 0 ? estimateClose(pretendPos(px, margin), inst, px * (isLong ? 1.01 : 0.99), true) : null;
    setText('moveWin', win && !win.flat ? fmtUsd(win.pnl, true) : '—');
    setText('opensNear', 'Opens near ' + (px > 0 ? fmtPrice(px, sz) + ' (oracle price)' : 'the oracle price') + ' in about ' + fillSecs() + ' s');
    /* the win cap line (in Details) shows only when a 20% move would reach it */
    var capX = inst ? inst.payoutCapX : 0;
    var capUsd = capX > 0 && isFinite(margin) ? margin * capX * (1 - feeRate()) : NaN;
    var big = isFinite(capUsd) && px > 0 ? estimateClose(pretendPos(px, margin), inst, px * (isLong ? 1.2 : 0.8), true) : null;
    var capLine = $('capLine');
    if (capLine) {
      var capped = !!big && big.pnl >= capUsd * 0.999;
      capLine.hidden = !capped;
      if (capped) capLine.textContent = 'At this amount and leverage, wins above ' + fmtUsd(capUsd) + ' are capped.';
    }
    var q = $('queueLine');
    if (q) q.hidden = !(house.queued > 0);
    setText('maxProfit', isFinite(capUsd)
      ? 'Win cap ' + fmtUsd(capUsd) + ' (' + capX + 'x your ' + fmtUsdShort(margin) + ', after fee)'
      : 'Win cap: ' + (capX > 0 ? capX + 'x your amount, after fee' : '—'));
    var c = curveOf(inst);
    setText('keptShare', 'Small wins are trimmed: you keep about ' + Math.round(impactScale(0.001, c) * 100) + '% of a 0.1% move, ' + Math.round(impactScale(0.01, c) * 100) + '% of a 1% move.');
    setText('feeLine', 'Fee: ' + feePctText() + ' of winnings');
    setText('posCapLine', inst && inst.maxNotional > 0 ? 'Biggest ' + sym + ' position $' + fmtInt(inst.maxNotional) : 'Biggest position: —');
  }

  /* The win cap in dollars for the ticket's amount when a 20% move would reach it, else NaN: the
     line in Details and the check before a big trade. */
  function ticketCapUsd() {
    var m = state.market;
    var inst = m && m.inst ? m.inst : null;
    var px = openPriceFor(m);
    var margin = isFinite(form.margin) && form.margin > 0 ? form.margin : NaN;
    var capX = inst ? inst.payoutCapX : 0;
    var capUsd = capX > 0 && isFinite(margin) ? margin * capX * (1 - feeRate()) : NaN;
    if (!isFinite(capUsd) || !(px > 0)) return NaN;
    var big = estimateClose(pretendPos(px, margin), inst, px * (form.side === 'long' ? 1.2 : 0.8), true);
    return big && big.pnl >= capUsd * 0.999 ? capUsd : NaN;
  }

  /* The one-time terms acceptance: the line shows until ticked, the tick is remembered and the
     order button stays disabled without it. */
  /* No tick needed: Connect and the order button are active from the start; terms.html stays linked in the footer. */
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

  /* BUY / LONG and SELL / SHORT pick the side; the picked one is pressed (filled). */
  function renderSide() {
    var pair = $('sidePair');
    if (!pair) return;
    var items = pair.querySelectorAll('[data-side]');
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute('aria-pressed', items[i].getAttribute('data-side') === form.side ? 'true' : 'false');
    }
  }

  function setSide(side) {
    form.side = side === 'short' ? 'short' : 'long';
    lsSet(LS.side, form.side);
    renderSide(); renderForm(); renderAction();
  }

  /* Why this market takes no new trades, or null. Checked before any wallet step, so a visitor
     reads it before connecting. Before the instruments are read nothing is blocked. */
  function marketBlock() {
    var m = state.market;
    if (!m) return 'Pick a coin to trade.';
    if (!m.inst) return hasExchange() && state.instrumentsLoaded ? m.symbol + ' is coming soon.' : null;
    if (m.inst.retired) return m.symbol + ' is closed for new trades. You can still close.';
    if (house.globalPaused || house.breakerTripped) return 'New trades are paused for now. You can still close.';
    if (m.inst.opensPaused) return 'New trades on ' + m.symbol + ' are paused for now. You can still close.';
    return null;
  }

  /* An open market to offer instead: BTC, then ETH, then the first open one. Null while every
     market is paused (the global pause and the loss breaker). */
  function altMarket() {
    if (house.globalPaused || house.breakerTripped) return null;
    var pick = null;
    ['BTC', 'ETH'].concat(state.markets.map(function (m) { return m.symbol; })).some(function (s) {
      var m = state.bySym[s];
      if (m && m !== state.market && m.inst && !m.inst.opensPaused && !m.inst.retired) { pick = m; return true; }
      return false;
    });
    return pick;
  }

  /* Problems with the trade itself, in plain words, or null when it can go. */
  function orderProblem() {
    var m = state.market;
    var block = marketBlock();
    if (block) return block;
    if (!m || !m.inst) return 'Loading the market…';
    if (!isFinite(form.margin) || form.margin <= 0) return 'Enter an amount.';
    if (form.margin < MIN_MARGIN) return 'Minimum is $' + MIN_MARGIN + '.';
    if (form.margin > acct.available + 1e-9) return 'That is more than your balance (' + fmtUsd(acct.available) + ').';
    if (form.lev < 1 || form.lev > m.inst.maxLeverage) return 'Leverage on ' + m.symbol + ' goes up to ' + m.inst.maxLeverage + 'x.';
    if (m.inst.maxNotional > 0 && form.margin * form.lev > m.inst.maxNotional + 1e-6) return 'Too big: the largest ' + m.symbol + ' position is $' + fmtInt(m.inst.maxNotional) + '.';
    var oi = house.oi[m.symbol];
    if (oi) {
      var cap = form.side === 'long' ? m.inst.longCap : m.inst.shortCap;
      var used = form.side === 'long' ? oi.long : oi.short;
      var headroom = Math.max(0, cap - used);
      if (form.margin * form.lev > headroom + 1e-6) {
        return m.symbol + ' ' + (form.side === 'long' ? 'longs' : 'shorts') + ' are full right now. Up to ' + fmtUsdCompact(headroom) + ' more fits: lower the amount or leverage.';
      }
    }
    return null;
  }

  /* Not enough HYPE in the wallet for gas (a live one-click key pays its own). */
  function hypeLow() { return !!wallet.account && ui.hypeWei != null && ui.hypeWei < HYPE_LOW_WEI && !sessionLive(); }

  /* The one button under the ticket: the next setup step (Connect wallet, Switch to HyperEVM, Add
     USDC, Enter an amount) until the account can trade, then OPEN POSITION in the side's colour. A
     market that takes no new trades says so first, before any wallet step. While a request is out
     the button gives way to the progress card (renderTicketProgress). */
  function renderAction() {
    var btn = $('actionBtn');
    var hint = $('actionHint');
    if (!btn) return;
    var m = state.market;
    var sym = m ? m.symbol : '';
    var label = 'OPEN POSITION', cls = 'btn btn-lg btn-block btn-go', disabled = false, note = '', err = false;
    var notice = null, alt = null, setup = true;
    var block = marketBlock();
    if (block) {
      disabled = true; notice = block; alt = altMarket();
    } else if (!window.ethers) {
      label = 'Wallet unavailable'; disabled = true; note = 'The wallet library did not load. Reload the page.'; err = true;
    } else if (!wallet.account) {
      label = 'Connect wallet';
      note = wallet.eth || getInjected() ? 'Your wallet asks to connect, then to switch to HyperEVM if it is elsewhere. Nothing is signed.' : 'No wallet in this browser: tap to open Confetti in your wallet app.';
    } else if (wallet.chainId !== CHAIN_ID) {
      label = 'Switch to HyperEVM'; note = 'Your wallet is on ' + chainName(wallet.chainId) + '. Confetti runs on HyperEVM.';
    } else if (!hasExchange()) {
      label = 'Trading is off'; disabled = true; note = 'This copy of the site has no exchange address.'; err = true;
    } else if (!acct.loaded) {
      label = 'Loading your account…'; disabled = true;
    } else if (acct.available < MIN_MARGIN) {
      label = 'Add USDC';
      note = acct.walletUsdc >= 1 ? 'You have ' + fmtUsd(acct.walletUsdc) + ' USDC in your wallet. Add it to start.'
        : acct.available > 0 ? 'Your balance is ' + fmtUsd(acct.available) + '. Trades start at $' + MIN_MARGIN + '.'
        : 'Add at least $' + MIN_MARGIN + ' to start.';
    } else if (!(form.margin > 0)) {
      label = 'Enter an amount'; disabled = true;
    } else {
      setup = false;
      cls += form.side === 'long' ? ' go-long' : ' go-short';
      var problem = orderProblem();
      if (problem) { disabled = true; note = problem; err = true; }
      else {
        note = (form.side === 'long' ? 'BUY / LONG ' : 'SELL / SHORT ') + sym + ' · ' + fmtUsdShort(form.margin) + ' at ' + form.lev + 'x.';
        if (sessionLive()) {
          if (!sessionRefOk(referrerArg())) note += ' Your first fill sets your referrer: your wallet signs this one.';
          else if (numToUsd6(form.margin) > sess.onchain.cap6) note += ' Over your one-click cap: your wallet signs this one.';
          else note += ' No wallet popup.';
        } else note += ' Your wallet asks you to confirm.';
      }
    }
    if (!notice && wallet.account && wallet.chainId === CHAIN_ID && hypeLow()) notice = HYPE_NOTE;
    if (setup) cls += ' go-setup';
    if (state.busy && !tk.phase) { disabled = true; note = state.viaSession ? 'Sending…' : 'Confirm in your wallet…'; err = false; }
    if (!termsAccepted()) disabled = true;
    btn.className = cls;
    btn.textContent = label;
    btn.disabled = disabled;
    if (hint) { hint.textContent = tk.phase ? '' : note; hint.classList.toggle('is-err', err && !tk.phase); }
    renderTicketNotice(notice, alt);
    renderTicketProgress(false);
    var closeAll = $('closeAllBtn');
    if (closeAll) closeAll.disabled = state.busy;
  }

  /* The line above the button: a paused or coming-soon market (with an open one to switch to), or
     too little HYPE for gas. Rebuilt only when its words change. */
  function renderTicketNotice(text, alt) {
    var n = $('ticketNotice');
    if (!n) return;
    var key = (text || '') + '|' + (alt ? alt.symbol : '');
    if (n.getAttribute('data-key') === key) return;
    n.setAttribute('data-key', key);
    n.textContent = '';
    n.hidden = !text;
    if (!text) return;
    n.appendChild(document.createTextNode(text));
    if (alt) {
      var b = el('button', 'btn btn-sm btn-block', 'Trade ' + alt.symbol + ' instead');
      b.type = 'button';
      b.addEventListener('click', function () { selectMarket(alt.symbol); });
      n.appendChild(b);
    }
  }

  function initForm() {
    var pair = $('sidePair');
    var marginInput = $('marginInput');
    var slider = $('levSlider');
    var levInput = $('levInput');
    var formEl = $('orderForm');

    form.side = lsGet(LS.side) === 'short' ? 'short' : 'long';
    /* the amount box starts ready: $10, or the last amount used */
    var saved = Number(lsGet(LS.amount));
    form.margin = isFinite(saved) && saved >= MIN_MARGIN ? Math.floor(saved * 100) / 100 : MIN_MARGIN;
    if (marginInput) marginInput.value = String(form.margin);
    renderSide();
    renderAmountChips();

    if (pair) {
      pair.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-side]') : null;
        if (!b || b.disabled) return;
        setSide(b.getAttribute('data-side'));
        tourEvent('side');
      });
    }
    /* phones: the pinned bar picks the side and opens the ticket sheet */
    var bar = $('mbarPair');
    if (bar) {
      bar.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-open-side]') : null;
        if (!b) return;
        setSide(b.getAttribute('data-open-side'));
        openSheet();
        tourEvent('side');
      });
    }
    if (marginInput) {
      marginInput.addEventListener('input', function () {
        var v = Number(marginInput.value);
        form.margin = marginInput.value !== '' && isFinite(v) && v > 0 ? v : NaN;
        form.touched = true; form.maxed = false;
        renderAmountChips(); renderForm(); renderAction();
      });
      marginInput.addEventListener('change', function () { tourEvent('amount'); });
    }
    /* Enter in the amount or leverage box only commits the number: a trade needs the button */
    [marginInput, levInput].forEach(function (inp) {
      if (inp) inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } });
    });
    var amt = $('amtChips');
    if (amt) {
      amt.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-amt]') : null;
        if (!b) return;
        var v = b.getAttribute('data-amt');
        var next = MIN_MARGIN;
        form.maxed = false;
        if (v === 'max') {
          /* Max is the whole balance; that trade gets the check first */
          var all = acct.loaded ? Math.floor(acct.available * 100) / 100 : NaN;
          if (all > 0) { next = all; form.maxed = true; }
          else if (wallet.account && acct.loaded) toast('Your balance is ' + fmtUsd(acct.available) + '. Add USDC to trade.');
        } else next = Number(v);
        form.margin = next; form.touched = true;
        if (marginInput) marginInput.value = String(next);
        renderAmountChips(); renderForm(); renderAction();
        tourEvent('amount');
      });
    }
    var chips = $('levChips');
    if (chips) {
      chips.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-lev]') : null;
        if (!b) return;
        var v = b.getAttribute('data-lev');
        if (v === 'custom') { form.levCustom = true; renderLeverage(); }
        else { form.levCustom = false; setLev(Number(v)); }
        tourEvent('lev');
      });
    }
    if (slider) {
      /* the slider leaves its own thumb alone while dragging; everything else follows */
      slider.addEventListener('input', function () {
        var max = state.market ? maxLev(state.market) : 1000;
        form.levCustom = true;
        form.lev = levFromSlider(Number(slider.value), max);
        if (levInput) levInput.value = String(form.lev);
        if (state.market) lsSet(LS.lev + state.market.symbol, String(form.lev));
        setText('levNow', form.lev + 'x');
        renderLevChips(max); renderForm(); renderAction();
      });
      slider.addEventListener('change', function () { tourEvent('lev'); });
    }
    if (levInput) {
      levInput.addEventListener('input', function () {
        var v = Math.round(Number(levInput.value));
        if (!isFinite(v) || v < 1) return;
        var max = state.market ? maxLev(state.market) : 1000;
        form.levCustom = true;
        form.lev = clamp(v, 1, max);
        if (slider) slider.value = String(sliderFromLev(form.lev, max));
        if (state.market) lsSet(LS.lev + state.market.symbol, String(form.lev));
        setText('levNow', form.lev + 'x');
        renderLevChips(max); renderForm(); renderAction();
      });
      levInput.addEventListener('blur', function () { renderLeverage(); });
    }
    if (formEl) {
      formEl.addEventListener('submit', function (ev) {
        ev.preventDefault();
        onAction();
      });
    }
    /* Details starts closed and remembers being opened */
    var details = $('detailsBox');
    if (details) {
      details.open = lsGet(LS.details) === '1';
      details.addEventListener('toggle', function () { lsSet(LS.details, details.open ? '1' : '0'); });
    }
    var x = $('sheetClose');
    if (x) x.addEventListener('click', closeSheet);
    var scrim = $('sheetScrim');
    if (scrim) scrim.addEventListener('click', closeSheet);
    var chip = $('posChip');
    if (chip) chip.addEventListener('click', showPositions);
    var bs = $('barStatus');
    if (bs) bs.addEventListener('click', function () { if (tk.phase) openSheet(); else showPositions(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && ui.sheet && !tour.on) closeSheet(); });
    /* every "If a fill is slow, ask my wallet to finish it" box is the same setting */
    document.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t && t.hasAttribute && t.hasAttribute('data-autofill')) { lsSet(LS.autoFill, t.checked ? '1' : '0'); syncAutoFill(); }
    });
    syncAutoFill();
    watchPosPanel();
  }

  function syncAutoFill() {
    var on = autoFillEnabled();
    Array.prototype.forEach.call(document.querySelectorAll('input[data-autofill]'), function (c) { c.checked = on; });
  }

  function onAction() {
    if (state.busy || tk.phase) return;
    if (marketBlock()) { renderAction(); return; }
    if (!window.ethers) return;
    if (!wallet.account) { if (wallet.eth || getInjected()) connect(); else openWalletApps(); return; }
    if (wallet.chainId !== CHAIN_ID) { switchChain().then(function () { return onChainChanged(); }).catch(switchFailed); return; }
    if (!hasExchange() || !acct.loaded) return;
    if (acct.available < MIN_MARGIN) { openDeposit(); return; }
    if (!(form.margin > 0) || orderProblem()) { renderAction(); return; }
    if ((form.lev >= CONFIRM_LEV || form.maxed) && lsGet(LS.noConfirm) !== '1') {
      confirmOpen().then(function (yes) { if (yes && !state.busy && !tk.phase && !orderProblem()) submitOpen(); });
      return;
    }
    submitOpen();
  }

  /* The check before a big trade (100x and up, or Max): the trade in one short read, then the
     wallet. "Don't ask again" is remembered (LS.noConfirm). */
  function confirmOpen() {
    var m = state.market;
    var sz = m.szDecimals;
    var isLong = form.side === 'long';
    var px = openPriceFor(m);
    var liq = bustPriceNum(px, isLong, form.lev);
    var win = px > 0 ? estimateClose(pretendPos(px, form.margin), m.inst, px * (isLong ? 1.01 : 0.99), true) : null;
    var lines = [
      fmtUsdShort(form.margin) + ' at ' + form.lev + 'x = a ' + fmtUsd(form.margin * form.lev) + ' position.',
      'Opens near ' + fmtPrice(px, sz) + ' in about ' + fillSecs() + ' s.',
      { text: 'Liquidated at ' + fmtPrice(liq, sz) + ' (' + (isLong ? '-' : '+') + fmtMove(bustMovePct(form.lev)) + '%): you lose ' + fmtUsdShort(form.margin) + '.', cls: 'neg' },
      { text: 'If ' + m.symbol + (isLong ? ' rises' : ' falls') + ' 1%: ' + (win ? fmtUsd(win.pnl, true) : '—') + '.', cls: 'pos' }
    ];
    var cap = ticketCapUsd();
    if (isFinite(cap)) lines.push('Wins above ' + fmtUsd(cap) + ' are capped.');
    return askConfirm({
      title: (isLong ? 'BUY / LONG ' : 'SELL / SHORT ') + m.symbol,
      lines: lines,
      ok: 'OPEN POSITION', okClass: isLong ? 'go-long' : 'go-short', back: 'Back', skipKey: LS.noConfirm
    });
  }

  /* One dialog for every check (a big trade, Close all, disconnect). Resolves true on the OK
     button, false on Back, the cross, Esc or a click outside. */
  var confirmDone = null;
  function askConfirm(o) {
    var d = $('confirmModal');
    if (!d) return Promise.resolve(true);
    if (confirmDone) confirmDone(false);
    setText('confirmTitle', o.title || 'Are you sure?');
    var body = $('confirmBody');
    if (body) {
      body.textContent = '';
      (o.lines || []).forEach(function (l) {
        var t = typeof l === 'string' ? { text: l } : l;
        body.appendChild(el('p', t.cls || null, t.text));
      });
    }
    var skipRow = $('confirmSkipRow'), skip = $('confirmSkip');
    if (skipRow) skipRow.hidden = !o.skipKey;
    if (skip) skip.checked = false;
    var ok = $('confirmOk');
    if (ok) { ok.textContent = o.ok || 'Confirm'; ok.className = 'btn btn-lg btn-go ' + (o.okClass || 'btn-primary'); }
    setText('confirmBack', o.back || 'Back');
    return new Promise(function (resolve) {
      confirmDone = function (yes) {
        confirmDone = null;
        if (yes && o.skipKey && skip && skip.checked) lsSet(o.skipKey, '1');
        closeDialog('confirmModal');
        resolve(!!yes);
      };
      openDialog('confirmModal');
    });
  }

  /* No wallet in this browser (mostly a phone browser): links that open this page in a wallet app. */
  function openWalletApps() {
    var page = (/^https:$/.test(location.protocol) ? location.origin + location.pathname : SITE_URL + 'trade.html') + (location.hash || '');
    var bare = page.replace(/^https:\/\//, '');
    var mm = $('waMetaMask'), cb = $('waCoinbase'), okx = $('waOkx');
    if (mm) mm.href = 'https://metamask.app.link/dapp/' + bare;
    if (cb) cb.href = 'https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent(page);
    if (okx) okx.href = 'okx://wallet/dapp/url?dappUrl=' + encodeURIComponent(page);
    var copy = $('waCopy');
    if (copy) copy.setAttribute('data-link', page);
    openDialog('walletAppModal');
  }

  /* ---- phones: the ticket as a bottom sheet ---------------------------------------- */

  function isSheetMode() { return !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches); }

  function openSheet() {
    if (!isSheetMode()) return;
    ui.sheet = true;
    document.body.classList.add('sheet-open');
    var s = $('sheetScrim');
    if (s) s.hidden = false;
    renderTicketProgress(false);
  }

  function closeSheet() {
    if (!ui.sheet && !document.body.classList.contains('sheet-open')) return;
    ui.sheet = false;
    document.body.classList.remove('sheet-open');
    var s = $('sheetScrim');
    if (s) s.hidden = true;
    renderTicketProgress(false);
  }

  /* The chip over the bar only shows while the positions panel is out of view. */
  function watchPosPanel() {
    var p = $('posPanel');
    if (!p || typeof IntersectionObserver !== 'function') return;
    new IntersectionObserver(function (entries) {
      ui.posInView = entries.some(function (e) { return e.isIntersecting; });
      renderPosChip();
    }, { threshold: 0.15 }).observe(p);
  }

  /* The positions panel in view, the sheet out of the way; with a selector, that card (the one
     just opened) instead of the top of the panel. */
  function showPositions(sel) {
    closeSheet();
    var p = (typeof sel === 'string' && document.querySelector(sel)) || $('posPanel');
    if (p && p.scrollIntoView) p.scrollIntoView({ block: typeof sel === 'string' ? 'center' : 'start', behavior: 'smooth' });
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
    routerIface = new E.Interface(ROUTER_ABI);
    proxyIface = new E.Interface(PROXY_ABI);
    read.provider = makeProvider(cfg.rpcUrl);
    read.logProvider = cfg.logRpcUrl && cfg.logRpcUrl !== cfg.rpcUrl ? makeProvider(cfg.logRpcUrl) : read.provider;
    if (hasExchange()) read.exchange = new E.Contract(cfg.contracts.exchange, EXCHANGE_ABI, read.provider);
    var refAddr = cfg.contracts && cfg.contracts.referrals;
    if (isAddr(refAddr)) read.referrals = new E.Contract(refAddr, REFERRALS_ABI, read.provider);
    if (isAddr(cfg.contracts && cfg.contracts.v2Exchange)) read.v2 = new E.Contract(cfg.contracts.v2Exchange, V2_EXCHANGE_ABI, read.provider);
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
    if (DEMO) return Promise.resolve();
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
    if (DEMO) return Promise.resolve();
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
      ex.maxJumpBps().catch(none), ex.stakerFeeShareBps().catch(none), ex.breakerBps().catch(none)
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
      if (r[14] != null) house.breakerBps = Number(r[14]);
      renderStatus(); renderAction();
    }).catch(function () { /* transient RPC trouble: keep the last values */ });
  }

  /* The exchange's own addresses, checked against the pins. One that disagrees is reported
     (console error; a status line when transactions to it go off) and never becomes a transaction
     target: Refer goes off for referrals, one-click for the router; reads follow the exchange's
     referrals. The router is used only when its pin and exchange.sessionRouter() agree (v2 has
     none: the call reverts and one-click stays off). An exchange that does not settle in native
     USDC gets no deposit (requireSigner refuses). */
  function loadHouseAddresses() {
    if (DEMO) return Promise.resolve();
    var ex = read.exchange;
    if (!ex) return Promise.resolve();
    var E = window.ethers;
    var names = CHECKED.concat(['owner', 'feeRecipient', 'pauseGuardian', 'marketKeeper']);
    return Promise.all(names.map(function (n) { return ex[n]().catch(function () { return null; }); })).then(function (vals) {
      names.forEach(function (n, i) { if (vals[i]) house.addrs[n] = vals[i]; });
      var off = [];
      CHECKED.forEach(function (n) {
        var pin = cfg.contracts[n], theirs = house.addrs[n];
        if (n === 'usdc' || !isAddr(theirs) || (isAddr(pin) && pin.toLowerCase() === theirs.toLowerCase())) return;
        house.unpinned[n] = true;
        console.error('exchange.' + n + '() ' + theirs + ' is not the pinned ' + (pin || 'none') + (TX_TARGETS[n] ? '; ' + TX_TARGETS[n] + ' is off.' : '.'));
        if (TX_TARGETS[n]) off.push(TX_TARGETS[n]);
      });
      if (off.length) toast('The exchange does not match this site\'s pinned contracts. ' + off.join(' and ') + ' off.', 'err', null, 0);
      if (isAddr(house.addrs.usdc) && house.addrs.usdc.toLowerCase() !== USDC.toLowerCase()) {
        house.usdcBad = true;
        console.error('exchange.usdc() ' + house.addrs.usdc + ' is not native USDC ' + USDC + '; deposits and trades are off.');
        toast('This exchange does not settle in native USDC. Deposits and trades are off.', 'err', null, 0);
      }
      if (isAddr(house.addrs.referrals) && (!read.referrals || read.referrals.target.toLowerCase() !== house.addrs.referrals.toLowerCase())) {
        read.referrals = new E.Contract(house.addrs.referrals, REFERRALS_ABI, read.provider);
      }
      if (isAddr(cfg.contracts.sessionRouter) && isAddr(house.addrs.sessionRouter) && !house.unpinned.sessionRouter) {
        read.router = new E.Contract(cfg.contracts.sessionRouter, ROUTER_ABI, read.provider);
      }
      renderStatus();
      return loadFactory();
    });
  }

  /* The deposit factory from config, kept only if it deposits into this exchange in native USDC. */
  function loadFactory() {
    if (DEMO) return Promise.resolve();
    var a = cfg.contracts.depositFactory;
    if (!isAddr(a) || !read.exchange) return Promise.resolve();
    var f = new window.ethers.Contract(a, FACTORY_ABI, read.provider);
    return Promise.all([f.exchange(), f.usdc()]).then(function (r) {
      if (String(r[0]).toLowerCase() === cfg.contracts.exchange.toLowerCase() && String(r[1]).toLowerCase() === USDC.toLowerCase()) {
        read.factory = f;
      } else {
        console.error('config.json contracts.depositFactory ' + a + ' deposits into ' + r[0] + ', not this exchange; Hyperliquid deposits are off.');
      }
    }).catch(function () { /* unreadable: the Hyperliquid section stays a dash */ }).then(function () {
      renderStatus(); renderDepositModal();
    });
  }

  /* The settlement price of a market right now (the oracle; a retired market's frozen price).
     Resolves to null when the feed is dead. */
  function readOraclePx(id) {
    return read.exchange.execPrice(id, true, true).then(function (px) { return px18ToNum(px); }).catch(function () { return null; });
  }

  function refreshMarketChain() {
    if (DEMO) return Promise.resolve();
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

  /* Three reads on the v2 Exchange, at most every V2_EVERY_MS per account, for the Status tab's v2 link. */
  function refreshV2Link() {
    if (DEMO) return Promise.resolve();
    var a = wallet.account;
    if (!a || !read.v2) { v2link.show = false; renderV2Link(); return Promise.resolve(); }
    if (v2link.account === a && Date.now() - v2link.at < V2_EVERY_MS) return Promise.resolve();
    if (v2link.account !== a) v2link.show = false;
    v2link.account = a; v2link.at = Date.now();
    var ex = read.v2;
    return Promise.all([ex.balanceOf(a), ex.marginInUse(a), ex.pendingOf(a)]).then(function (r) {
      if (wallet.account !== a) return;
      v2link.show = r[0] > 0n || r[1] > 0n || r[2] > 0n;
      v2link.total = usd6ToNum(r[0]) + usd6ToNum(r[1]) + usd6ToNum(r[2]);
      renderV2Link();
    }, function () { v2link.at = 0; });
  }

  /* A banner, only while the old exchange still holds this account's money: "You have $X on the
     old exchange. [Move it]" (v2.html). */
  function renderV2Link() {
    var b = $('v2Banner');
    var on = !!(v2link.show && wallet.account && wallet.account === v2link.account);
    if (b) b.hidden = !on;
    if (on) setText('v2Amt', v2link.total > 0 ? fmtUsd(v2link.total) : 'money');
  }

  function refreshAccount() {
    if (DEMO) { demoRefresh(); return Promise.resolve(); }
    refreshV2Link();
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
          var known = acct.closeReqs[String(ids[i])];
          if (cr && Number(cr.requestedAt) > 0) {
            /* what the page is doing about it carries over: the wallet prompt asked once, the late text shown */
            closeReqs[String(ids[i])] = {
              requestedAt: Number(cr.requestedAt), px0: px18ToNum(cr.px0), block: known ? known.block : null, busy: !!(known && known.busy),
              prompted: !!(known && known.prompted), lateSeen: known ? known.lateSeen || 0 : 0, lateToast: !!(known && known.lateToast),
              localAt: known ? known.localAt : 0
            };
          } else if (known && known.localAt && Date.now() - known.localAt < 15000) {
            /* a close this page filed a moment ago that this read (sent earlier) cannot see yet */
            closeReqs[String(ids[i])] = known;
          }
        });
        positions.sort(function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });
        /* the settlement price of every market with a position, for the PnL estimate */
        var instIds = [];
        positions.forEach(function (p) { if (instIds.indexOf(p.instrumentId) < 0) instIds.push(p.instrumentId); });
        return Promise.all(instIds.map(readOraclePx)).then(function (opx) {
          if (wallet.account !== a) return;
          instIds.forEach(function (id, i) { if (opx[i] != null) house.oraclePxById[id] = opx[i]; });
          var before = acct.loaded && acct.owner === a ? acct.positions : null;
          var have = {};
          positions.forEach(function (p) { have[String(p.id)] = true; });
          /* A close request this page was following whose position is gone from this read: the
             keeper filled it (or it was liquidated) between two reads, before the poll saw the
             request go. Look the end up from the request's block, so the result card still comes. */
          if (before) {
            Object.keys(acct.closeReqs).forEach(function (pid) {
              if (have[pid] || closeReqs[pid] || ui.checking[pid] || ui.reported[pid]) return;
              var old = acct.closeReqs[pid];
              var gone = null;
              before.forEach(function (p) { if (String(p.id) === pid) gone = p; });
              ui.checking[pid] = gone || true;
              resolveCloseOutcome(pid, old, 0);
            });
          }
          acct.available = usd6ToNum(r[0]);
          acct.marginInUse = usd6ToNum(r[1]);
          acct.pending = usd6ToNum(r[3]);
          acct.positions = positions;
          acct.closeReqs = closeReqs;
          acct.loaded = true;
          acct.owner = a;
          Object.keys(ui.settling).forEach(function (k) { if (!have[k]) delete ui.settling[k]; });
          if (before) noticeVanished(before, positions, a);
          /* the last block seen moves on only once "while you were away" has read up to now */
          if (house.block && ui.awayDone[a] === 'done') lsSet(LS.seen + a.toLowerCase(), String(house.block));
          renderAccount(); renderPositions(); renderAction(); renderStatus();
          refreshOwed();
          return discoverPendingOpens();
        });
      });
    }).catch(function (e) {
      if (!acct.loaded) toast('Could not read your account: ' + describeError(e), 'err');
    });
  }

  /* The wallet's own USDC and allowance (the Add USDC dialog) and its HYPE (gas: under 0.005 the
     ticket and the dialog say so before a transaction fails). */
  function refreshWalletUsdc() {
    if (DEMO) { renderDepositModal(); return Promise.resolve(); }
    var E = window.ethers;
    var addr = usdcAddress();
    if (!wallet.account || !read.provider || !isAddr(addr)) return Promise.resolve();
    var usdc = new E.Contract(addr, ERC20_ABI, read.provider);
    var spender = hasExchange() ? cfg.contracts.exchange : null;
    var a = wallet.account;
    return Promise.all([
      usdc.balanceOf(a),
      spender ? usdc.allowance(a, spender) : Promise.resolve(0n),
      read.provider.getBalance(a).catch(function () { return null; })
    ]).then(function (r) {
      if (wallet.account !== a) return;
      acct.walletUsdc = usd6ToNum(r[0]);
      acct.allowance = usd6ToNum(r[1]);
      ui.hypeWei = r[2] == null ? null : BigInt(r[2]);
      renderDepositModal(); renderAction();
    }).catch(function () {});
  }

  /* Wins owed to this account: the payout queue read the way the House page reads it (live entries
     from queueHead, at most OWED_SCAN), summed for this account, with its first entry's place in
     line. Only while the queue has live entries, at most once every OWED_EVERY_MS, and only when
     the account or the queue (head, length, total) changed since the last read: the public RPC
     takes one request per entry and rate-limits, and the trade flow's own reads come first. */
  var OWED_SCAN = 20, OWED_EVERY_MS = 60000;
  function refreshOwed() {
    var a = wallet.account;
    if (DEMO || !a || !read.exchange || house.queueLen == null || !(house.queueLen > house.queueHead)) {
      ui.owedSig = '';
      if (acct.owed) { acct.owed = 0; acct.owedAt = 0; renderAccount(); }
      return Promise.resolve();
    }
    var sig = [a, house.queueHead, house.queueLen, house.queued].join('|');
    if (sig === ui.owedSig || Date.now() - ui.owedAt < OWED_EVERY_MS) return Promise.resolve();
    ui.owedSig = sig; ui.owedAt = Date.now();
    var ex = read.exchange, idx = [];
    for (var i = house.queueHead; i < Math.min(house.queueLen, house.queueHead + OWED_SCAN); i++) idx.push(i);
    return Promise.all(idx.map(function (i) {
      return ex.queueEntry(i).then(function (q) { return { i: i, to: String(q[0]).toLowerCase(), owed: usd6ToNum(q[1]) }; });
    })).then(function (rows) {
      if (wallet.account !== a) return;
      var sum = 0, first = 0;
      rows.forEach(function (r) { if (r.to === a.toLowerCase() && r.owed > 0) { sum += r.owed; if (!first) first = r.i - house.queueHead + 1; } });
      acct.owed = sum; acct.owedAt = first;
      renderAccount();
    }).catch(function () { ui.owedSig = ''; /* the next read after OWED_EVERY_MS tries again */ });
  }

  /* Positions that were there last read and are gone now, whose end this page has not reported
     and is not already looking up: liquidated, closed from somewhere else, or closed from here by
     a path that missed it. Each is looked up in the logs (which say which) and gets its result
     card, instead of a card that silently disappears. */
  function noticeVanished(before, now, account) {
    var have = {};
    now.forEach(function (p) { have[String(p.id)] = true; });
    before.forEach(function (p) {
      var pid = String(p.id);
      if (have[pid] || ui.checking[pid] || ui.reported[pid]) return;
      ui.reported[pid] = 'looking';
      lookupVanished(p, account);
    });
  }

  /* The log node can lag the read node: a few tries, then a plain card ("no longer open"). */
  function lookupVanished(p, account, attempt) {
    var prov = read.logProvider;
    if (!prov || !exIface) return;
    attempt = attempt || 0;
    var pid = String(p.id);
    var t = function (n) { return exIface.getEvent(n).topicHash; };
    var from = Math.max(Number(cfg.deployBlock) || 0, (house.block || 0) - 5000);
    function giveUp() {
      if (ui.reported[pid] !== 'looking') return;
      ui.reported[pid] = true;
      addRecent({ key: 'c' + pid, pid: pid, title: posLabel(p) + ' is no longer open', lines: ['History shows how it ended.'], ttl: 60000 });
    }
    prov.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: 'latest', topics: [[t('PositionLiquidated'), t('PositionClosed')], topicId(pid)] }).then(function (logs) {
      if (wallet.account !== account) return;
      var hits = parsedLogs(logs).filter(function (h) { return String(h.args.positionId) === pid; });
      if (!hits.length) throw new Error('not yet');
      if (ui.reported[pid] === 'looking') delete ui.reported[pid];
      reportCloseOutcome(pid, logs, hits[hits.length - 1].tx, p);
    }).catch(function () {
      if (wallet.account !== account) return;
      if (attempt + 1 < 4) setTimeout(function () { lookupVanished(p, account, attempt + 1); }, 2000);
      else giveUp();
    });
  }

  /* While you were away: liquidations and owed wins paid since the last block this browser saw for
     the account (LS.seen), once per account per visit, one card. The log node refuses ranges over
     100,000 blocks, so the walk goes in cfg.logChunkBlocks chunks (halved when a chunk is refused),
     at most AWAY_MAX_BLOCKS back. LS.seen moves on (refreshAccount) only after the walk is done. */
  var AWAY_MAX_BLOCKS = 200000;
  function scanAway(account) {
    if (DEMO || !account || ui.awayDone[account] || !read.logProvider || !exIface || !hasExchange()) return;
    var last = Number(lsGet(LS.seen + account.toLowerCase()));
    if (!(last > 0)) { ui.awayDone[account] = 'done'; return; }
    ui.awayDone[account] = 'running';
    var E = window.ethers;
    var prov = read.logProvider;
    var t = function (n) { return exIface.getEvent(n).topicHash; };
    var topics = [[t('PositionLiquidated'), t('QueuePaid')], null, E.zeroPadValue(account, 32)];
    var found = [];
    var chunk = Math.max(1000, Number(cfg.logChunkBlocks) || 20000);
    function walk(from, latest) {
      if (from > latest || wallet.account !== account) return Promise.resolve();
      var to = Math.min(latest, from + chunk - 1);
      return prov.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: to, topics: topics }).then(function (logs) {
        found = found.concat(logs || []);
        return walk(to + 1, latest);
      }, function (e) {
        if (chunk <= 1000) throw e;
        chunk = Math.max(1000, Math.floor(chunk / 2));
        return walk(from, latest);
      });
    }
    prov.getBlockNumber().then(function (latest) {
      latest = Number(latest);
      if (latest <= last) return false;
      return walk(Math.max(last + 1, latest - AWAY_MAX_BLOCKS), latest).then(function () { return true; });
    }).then(function (scanned) {
      if (wallet.account !== account) { ui.awayDone[account] = 'failed'; return; }
      ui.awayDone[account] = 'done';
      if (!scanned) return;
      var lines = [], lost = false;
      parsedLogs(found).forEach(function (h) {
        if (h.name === 'PositionLiquidated') {
          var pid = String(h.args.positionId);
          ui.reported[pid] = true;
          lost = true;
          var mi = hist.openedMarket[pid];
          var inst = mi != null ? state.byInstId[mi] : null;
          var side = hist.openedSide[pid];
          var sym = inst && inst.market ? inst.market.symbol : null;
          var what = sym ? 'Your ' + sym + (side ? ' ' + String(side).toLowerCase() : '') : 'A position';
          lines.push(what + ' was liquidated at ' + fmtPrice(px18ToNum(h.args.exitPx18), sym ? inst.market.szDecimals : null) + '. Its ' + fmtUsd(usd6ToNum(h.args.marginUsdc)) + ' is gone.');
        } else if (h.name === 'QueuePaid') {
          lines.push('An owed win of ' + fmtUsd(usd6ToNum(h.args.paidUsdc)) + ' was paid into your balance.');
        }
      });
      if (lines.length) addRecent({ key: 'away', cls: lost ? 'is-loss' : 'is-win', title: 'While you were away', lines: lines.slice(0, 6) });
    }).catch(function () {
      /* best effort; History has the full list. LS.seen stays put, so the next visit tries again */
      ui.awayDone[account] = 'failed';
    });
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

  /* The account line at the top of the ticket: Balance · In trades · P&L, with + Deposit and
     Withdraw. Hidden until a wallet is connected. */
  function renderAccount() {
    var strip = $('acctStrip');
    if (strip) strip.hidden = !wallet.account;
    var mini = $('acctMini');
    if (mini) mini.hidden = !wallet.account;
    if (!wallet.account || !hasExchange() || !acct.loaded) {
      ['eqAvailable', 'eqMargin', 'eqPnl'].forEach(function (id) { setText(id, '—'); });
      var pe = $('eqPnl'); if (pe) pe.className = '';
      renderMiniAccount('—', '');
      renderPosChip();
      return;
    }
    var pnl = openPnl();
    setText('eqAvailable', fmtUsd(acct.available));
    setText('eqMargin', fmtUsd(acct.marginInUse + acct.pending));
    var marginEl = $('eqMargin');
    if (marginEl) marginEl.title = acct.pending > 0 ? fmtUsd(acct.pending) + ' of it in trades still opening' : '';
    var pnlEl = $('eqPnl');
    if (pnlEl) {
      pnlEl.textContent = fmtUsd(pnl, true);
      pnlEl.className = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
    }
    var owedText = acct.owed > 0 ? 'Owed to you: ' + fmtUsd(acct.owed) + (acct.owedAt ? ' · #' + acct.owedAt + ' in line' : '') + ' · paid automatically' : '';
    var owed = $('acctOwed');
    if (owed) {
      owed.hidden = !owedText;
      if (owedText) owed.textContent = owedText;
    }
    renderMiniAccount(fmtUsd(acct.available), owedText);
    renderPosChip();
  }

  /* Phones: "Balance $X · [+ Deposit] [Withdraw]" at the top of Your positions (the ticket's strip
     sits in the sheet, which opens only from BUY / LONG or SELL / SHORT). Filled through classes. */
  function renderMiniAccount(bal, owedText) {
    var mini = $('acctMini');
    if (!mini) return;
    var b = mini.querySelector('.js-bal');
    if (b && b.textContent !== bal) b.textContent = bal;
    var o = mini.querySelector('.js-owed');
    if (o) { o.hidden = !owedText; if (owedText && o.textContent !== owedText) o.textContent = owedText; }
  }

  /* Phones: "Your positions (2) · +$0.36" over the bar; a tap scrolls to the cards. */
  function renderPosChip() {
    var chip = $('posChip');
    if (!chip) return;
    var n = wallet.account && acct.loaded ? acct.positions.length + pendingOpenList().length : 0;
    chip.hidden = !n || ui.posInView;
    if (!n) return;
    var pnl = openPnl();
    chip.textContent = 'Your positions (' + n + ')' + (acct.positions.length && isFinite(pnl) ? ' · P&L ' + fmtUsd(pnl, true) : '');
  }

  function sideLev(isLong, lev) { return (isLong ? 'Long' : 'Short') + ' ' + lev + 'x'; }

  /* "DOGE Long 20x" */
  function posLabel(p) {
    var m = positionMarket(p);
    return (m ? m.symbol : 'Market ' + p.instrumentId) + ' ' + sideLev(p.isLong, p.leverage);
  }

  function reqSym(r) {
    var inst = state.byInstId[r.instrumentId];
    return inst && inst.market ? inst.market.symbol : 'Market ' + r.instrumentId;
  }

  function posById(pid) {
    pid = String(pid);
    for (var i = 0; i < acct.positions.length; i++) if (String(acct.positions[i].id) === pid) return acct.positions[i];
    return null;
  }

  function szOf(sym) { var m = state.bySym[sym]; return m ? m.szDecimals : null; }

  function clearLines(host) {
    var lines = host.querySelectorAll('.pos-line');
    for (var i = 0; i < lines.length; i++) host.removeChild(lines[i]);
  }

  /* Set the text of the [data-role] element under host (only when it changed); returns it. */
  function setRole(host, role, text) {
    var n = host.querySelector('[data-role="' + role + '"]');
    if (n && n.textContent !== text) n.textContent = text;
    return n;
  }

  /* A position's liquidation price, how far the price now is from it, and its colour: amber
     under half of the full liquidation move, red under a fifth. */
  function liqRoom(p, px) {
    var liq = px18ToNum(bustPrice18(p.entryPx18, p.isLong, p.leverage));
    var out = { liq: liq, away: NaN, cls: '' };
    if (!(px > 0) || !(liq > 0)) return out;
    out.away = Math.max(0, p.isLong ? (px - liq) / px : (liq - px) / px);
    var share = out.away / (bustMovePct(p.leverage) / 100);
    out.cls = share < 0.2 ? 'is-red' : share < 0.5 ? 'is-amber' : '';
    return out;
  }

  /* The live parts of a position card: P&L in $ and %, the price now (the oracle, what a close
     settles on), the liquidation line and what a close gives back. */
  function fillPositionPnl(card, p) {
    var m = positionMarket(p);
    var sz = m ? m.szDecimals : null;
    var px = closePriceFor(p);
    var est = positionEstimate(p);
    var known = isFinite(px) || !!p.preview;
    var pnl = card.querySelector('[data-role="pnl"]');
    if (pnl) {
      var t = known ? fmtUsd(est.pnl, true) + ' (' + fmtPct1(est.pnl / p.margin) + ')' : '—';
      if (pnl.textContent !== t) pnl.textContent = t;
      pnl.className = 'pc-pnl' + (est.pnl > 0 ? ' pos' : est.pnl < 0 ? ' neg' : '');
      pnl.title = known ? 'If you close now: about ' + fmtUsd(est.payout) + ' back' + (est.fee ? ', after a ' + fmtUsd(est.fee) + ' fee' : '') : '';
    }
    setRole(card, 'now', isFinite(px) ? fmtPrice(px, sz) : '—');
    var room = liqRoom(p, px);
    var liqEl = setRole(card, 'liq', fmtPrice(room.liq, sz) + (isFinite(room.away) ? ' (' + (room.away * 100).toFixed(room.away >= 0.01 ? 1 : 2) + '% away)' : ''));
    if (liqEl) liqEl.className = 'pc-v' + (room.cls ? ' ' + room.cls : '');
    card.classList.toggle('is-near', room.cls === 'is-red');
    setRole(card, 'est', known ? 'you get back about ' + fmtUsd(est.payout) : '');
  }

  /* The three request windows, measured on the chain clock from the request timestamp:
       wait     before minDelay, and the keeper-only grace window after it: nobody but a keeper
                can fill; the page counts down to the expected fill (minDelay + 1 s) and then
                says "any second now" until the keeper window ends
       fallback from minDelay + grace + CANCEL_PAD_S until expiry - FILL_END_S: anyone may fill, at the worse
                of the request-time and fill-time oracle prints, and the trader cannot cancel.
                That is an option held by the public against the trader (whoever fills picks the
                print), so the page shows "Taking longer than usual" with Finish now and, with the
                trader's standing consent, asks the wallet to fill (autoFill) once that text is
                on screen. A fill past expiry reverts RequestExpired, so the page stops offering it
                FILL_END_S before, for inclusion, and shows the gap as waiting ('expiring').
                Tight settings never lose the window: start = min(that, expiry - 1),
                end = min(expiry, max(start + 1, expiry - FILL_END_S))
       expired  after expiry + CANCEL_PAD_S: only a cancel (refund) is possible; the page offers it
                as "Get $X back" (an open) or "Try again" (a close: cancel, then a new request) */
  var FILL_END_S = 2, CANCEL_PAD_S = 1;
  function fillFrom() { return Math.min(house.minDelay + house.grace + CANCEL_PAD_S, house.expiry - 1); }
  function fillEnd() { return Math.min(house.expiry, Math.max(fillFrom() + 1, house.expiry - FILL_END_S)); }
  /* soon: the last LATE_SHOW_MS of the keeper window (never before the expected fill). The card
     already says "Taking longer than usual" then, so when the window opens the wallet prompt
     (autoFill) goes out at once and still has a reason on screen. */
  function requestPhase(requestedAt) {
    var e = chainNow() - requestedAt, from = fillFrom(), end = fillEnd(), to = house.expiry + CANCEL_PAD_S;
    if (e < from) return { phase: 'wait', left: from - e, soon: e >= Math.max(from - LATE_SHOW_MS / 1000, fillSecs()) };
    if (e <= end) return { phase: 'fallback', left: end - e };
    if (e <= to) return { phase: 'wait', left: to - e, expiring: true };
    return { phase: 'expired', left: 0 };
  }

  /* What a progress card says for a request (open or close) by its phase. money: the amount the
     card speaks of. req.busy: a fill or cancel transaction for it is out. */
  function progressView(kind, req, money) {
    var close = kind === 'close';
    var verb = close ? 'Closing' : 'Opening';
    var end = close ? 'Closed' : 'Open';
    var sent = ['Sent', 'is-done'];
    if (req.requestedAt == null) return { steps: [sent, [verb + ' at the oracle price…', 'is-on'], [end, '']] };
    var ph = requestPhase(req.requestedAt);
    if (ph.phase === 'wait' && !ph.expiring && !ph.soon) {
      var left = req.requestedAt + fillSecs() - chainNow();
      return { steps: [sent, [verb + ' at the oracle price… ' + (left > 0.5 ? Math.ceil(left) + 's' : 'any second now'), 'is-on'], [end, '']] };
    }
    if (ph.phase === 'fallback' || ph.phase === 'wait') {
      var note;
      if (req.busy) note = 'Asking your wallet to finish it…';
      else if (ph.expiring) note = close ? 'Almost out of time. If it does not close, your position stays open and you can try again.' : 'Almost out of time. If it does not fill, your money comes back.';
      else note = (autoFillEnabled() && !req.prompted ? 'Your wallet will ask you to finish it' + (ph.soon ? ' in a moment. ' : '. ') : '') + 'You get the worse of the price when you asked and the price now.';
      return {
        cls: 'is-late', late: ph.phase === 'fallback' || !!ph.soon,
        steps: [sent, ['Taking longer than usual.', 'is-on is-warn'], [end, '']],
        note: note, btn: ph.phase === 'fallback' && !req.busy ? 'Finish now' : '', btnCls: 'btn-primary'
      };
    }
    if (close) {
      return {
        cls: 'is-bad', steps: [sent, ["Close didn't go through. Your position is still open.", 'is-on is-bad'], [end, 'is-skip']],
        btn: req.busy ? '' : 'Try again', btnCls: 'go-close', note: req.busy ? 'Clearing the old request, then closing again…' : ''
      };
    }
    return {
      cls: 'is-bad', steps: [sent, ["Didn't fill. Your " + fmtUsdShort(money) + ' is safe.', 'is-on is-bad'], [end, 'is-skip']],
      btn: req.busy ? '' : 'Get ' + fmtUsdShort(money) + ' back', btnCls: 'btn-primary', note: req.busy ? 'Getting it back…' : ''
    };
  }

  /* The trader's standing consent to the automatic fallback fill (on unless switched off). */
  function autoFillEnabled() {
    var v = lsGet(LS.autoFill);
    return v == null ? true : v === '1';
  }

  /* A custom error from any contract the page talks to (exchange, referrals, router, proxy), or null. */
  function parseAnyError(data) {
    var ifaces = [exIface, refIface, routerIface, proxyIface];
    for (var i = 0; i < ifaces.length; i++) {
      if (!ifaces[i]) continue;
      try { var p = ifaces[i].parseError(data); if (p) return p; } catch (e) { /* not this one */ }
    }
    return null;
  }

  /* The contract error name behind a failed transaction, or null. */
  function revertName(err) {
    var data = revertData(err);
    var p = data ? parseAnyError(data) : null;
    if (p) return p.name;
    try { if (err && err.revert && err.revert.name) return err.revert.name; } catch (e) { /* ignore */ }
    return null;
  }

  /* A request is about to go late (requestPhase soon) or is late: its card says so; when no card
     for it is on screen, a toast says it too, so the wallet never pops up without a reason in
     view. autoFill asks only after this has run. cards: the elements that show this request. */
  function noteLate(req, what, cards) {
    if (req.lateToast) return;
    req.lateToast = true;
    req.lateSeen = Date.now();
    if ((cards || []).some(inView)) return;
    toast(what + ' is taking longer than usual. ' + (autoFillEnabled() ? 'Your wallet will ask you to finish it.' : 'Tap Finish now to finish it.'), 'warn');
  }

  /* An element the user can see right now: laid out, on screen, not in the folded-away sheet. */
  function inView(n) {
    if (!n || !n.getBoundingClientRect) return false;
    var r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && getComputedStyle(n).visibility !== 'hidden';
  }

  /* The elements that show an open request: the ticket's progress card when it follows it, and
     its card under Your positions. */
  function openReqEls(r) {
    var out = [];
    if (tk.phase && tk.reqId === r.id) out.push($('ticketProgress'));
    var host = $('posLines');
    if (host) out.push(host.querySelector('.pos-card[data-req="' + r.id + '"]'));
    return out;
  }

  function posCardEl(pid) {
    var host = $('posLines');
    return host ? host.querySelector('.pos-card[data-id="' + String(pid) + '"]') : null;
  }

  /* A trade's result toast is left out when a card on screen already says it, or while the ticket
     sheet is up (the cards show it when it closes). */
  function resultToast(cards, text, kind, link, ttl) {
    if (ui.sheet || (cards || []).some(inView)) return null;
    return toast(text, kind, link, ttl);
  }

  /* The moment a request enters the fallback window, ask the wallet to fill it: from then on
     anyone may fill it at the trader-worse of p0 and the print of their choosing until expiry
     (52 s by default), and the trader cannot cancel; the trader's own worst-of fill ends that
     option. One prompt per request (a rejected prompt leaves the Finish now button); only once
     noteLate has put "Taking longer than usual" on screen, which it does LATE_SHOW_MS before the
     window opens (requestPhase soon), so the prompt is not held back. The window itself starts a
     second after the keeper window (CANCEL_PAD_S), so the transaction cannot land inside it. One
     wallet transaction at a time. Runs on the countdown tick while anything is pending. */
  function autoFill() {
    if (DEMO) return;
    if (state.busy || !autoFillEnabled() || !wallet.account) return;
    if (!sessionLive() && (!wallet.signer || wallet.chainId !== CHAIN_ID)) return;
    var from = fillFrom(), end = fillEnd();
    var now = chainNow();
    var shown = function (q) { return !!q.lateSeen; };
    var opens = pendingOpenList();
    for (var i = 0; i < opens.length; i++) {
      var r = opens[i];
      if (r.busy || r.prompted || r.requestedAt == null || !shown(r)) continue;
      var e = now - r.requestedAt;
      if (e >= from && e <= end) { r.prompted = true; executeOpenNow(r); return; }
    }
    var pids = Object.keys(acct.closeReqs);
    for (var j = 0; j < pids.length; j++) {
      var cr = acct.closeReqs[pids[j]];
      if (cr.busy || cr.prompted || cr.requestedAt == null || !shown(cr)) continue;
      var e2 = now - cr.requestedAt;
      if (e2 < from || e2 > end) continue;
      var p = posById(pids[j]);
      if (!p) continue;
      cr.prompted = true;
      executeCloseNow(p);
      return;
    }
  }

  /* ---- progress cards: the ticket's, a request still opening, a position closing ---- */

  /* A card with a title, three steps, a note, up to two buttons and, on a late request, the "ask
     my wallet" setting. The buttons call onBtn / onBtn2, which read the state at click time. */
  function makeProg(title, onBtn, onBtn2) {
    var box = el('div', 'prog');
    var t = el('div', 'prog-title', title);
    t.setAttribute('data-role', 'title');
    box.appendChild(t);
    var ol = el('ol', 'prog-steps');
    for (var i = 0; i < 3; i++) ol.appendChild(el('li'));
    box.appendChild(ol);
    var note = el('div', 'prog-note');
    note.setAttribute('data-role', 'note');
    box.appendChild(note);
    var row = el('div', 'prog-btns');
    var b1 = el('button', 'btn');
    b1.type = 'button'; b1.hidden = true; b1.setAttribute('data-role', 'b1');
    if (onBtn) b1.addEventListener('click', onBtn);
    row.appendChild(b1);
    var b2 = el('button', 'btn btn-ghost');
    b2.type = 'button'; b2.hidden = true; b2.setAttribute('data-role', 'b2');
    if (onBtn2) b2.addEventListener('click', onBtn2);
    row.appendChild(b2);
    box.appendChild(row);
    var auto = el('label', 'prog-auto');
    auto.setAttribute('data-role', 'auto');
    auto.hidden = true;
    var chk = el('input');
    chk.type = 'checkbox';
    chk.setAttribute('data-autofill', '');
    chk.checked = autoFillEnabled();
    auto.appendChild(chk);
    auto.appendChild(document.createTextNode('If a fill is slow, ask my wallet to finish it (recommended)'));
    box.appendChild(auto);
    return box;
  }

  /* v: { title, cls, steps: [[text, cls] x3], note, btn, btnCls, btnFree, btn2, late } */
  function setProg(box, v) {
    box.className = 'prog' + (v.cls ? ' ' + v.cls : '');
    if (v.title != null) setRole(box, 'title', v.title);
    var lis = box.querySelectorAll('.prog-steps li');
    for (var i = 0; i < lis.length; i++) {
      var s = (v.steps && v.steps[i]) || ['', ''];
      if (lis[i].textContent !== s[0]) lis[i].textContent = s[0];
      if (lis[i].className !== (s[1] || '')) lis[i].className = s[1] || '';
    }
    setRole(box, 'note', v.note || '');
    var b1 = box.querySelector('[data-role="b1"]');
    if (b1) {
      if (b1.textContent !== (v.btn || '')) b1.textContent = v.btn || '';
      b1.hidden = !v.btn;
      b1.className = 'btn' + (v.btnCls ? ' ' + v.btnCls : '');
      b1.disabled = !v.btnFree && state.busy;
    }
    var b2 = box.querySelector('[data-role="b2"]');
    if (b2) { if (b2.textContent !== (v.btn2 || '')) b2.textContent = v.btn2 || ''; b2.hidden = !v.btn2; }
    var auto = box.querySelector('[data-role="auto"]');
    if (auto) auto.hidden = !v.late;
  }

  /* A request still opening: a card with the steps; its button appears only when there is
     something to do (Finish now when late, Get $X back when expired). */
  function pendingOpenCard(r) {
    var card = el('div', 'pos-card is-pending ' + (r.isLong ? 'is-long' : 'is-short'));
    card.setAttribute('data-req', r.id);
    card.title = 'Request #r' + r.id;
    card.appendChild(makeProg('Opening ' + sideWord(r.isLong) + ' ' + reqSym(r) + ' ' + r.leverage + 'x · ' + fmtUsdShort(r.margin), function () { openReqAction(r); }));
    updateOpenProg(card, r);
    return card;
  }

  function updateOpenProg(card, r) {
    var box = card.querySelector('.prog');
    if (box) setProg(box, progressView('open', r, r.margin));
  }

  /* Finish now (late) or Get $X back (expired) on an open request, by its phase at click time. */
  function openReqAction(r) {
    if (!pend.opens[r.id] || r.busy || r.requestedAt == null) return;
    var ph = requestPhase(r.requestedAt);
    if (ph.phase === 'fallback') executeOpenNow(r);
    else if (ph.phase === 'expired') cancelOpenNow(r);
  }

  /* One card per open position: side, coin, leverage, P&L in $ and %, entry, now, liquidation
     (amber, then red, as it nears), amount put in and size; CLOSE POSITION across the bottom with
     about what it gives back. With a close on its way the button becomes the progress card. */
  function positionCard(p) {
    var m = positionMarket(p);
    var sz = m ? m.szDecimals : null;
    var card = el('div', 'pos-card ' + (p.isLong ? 'is-long' : 'is-short'));
    card.setAttribute('data-id', String(p.id));
    card.title = 'Position #' + p.id;
    var head = el('div', 'pc-head');
    var who = el('div', 'pc-who');
    who.appendChild(el('span', 'pc-side', p.isLong ? 'LONG' : 'SHORT'));
    who.appendChild(el('span', 'pc-sym', m ? m.symbol : 'Market ' + p.instrumentId));
    who.appendChild(el('span', 'pc-lev', p.leverage + 'x'));
    head.appendChild(who);
    var pnl = el('span', 'pc-pnl', '—');
    pnl.setAttribute('data-role', 'pnl');
    head.appendChild(pnl);
    card.appendChild(head);
    var rows = el('div', 'pc-rows');
    rows.appendChild(pcCell('Entry', fmtPrice(p.entry, sz)));
    rows.appendChild(pcCell('Now', '—', 'now'));
    rows.appendChild(pcCell('Liquidation', '—', 'liq', true));
    rows.appendChild(pcCell('Put in', fmtUsd(p.margin)));
    rows.appendChild(pcCell('Size', fmtUsd(p.margin * p.leverage)));
    card.appendChild(rows);
    var act = el('div', 'pc-act');
    act.setAttribute('data-role', 'act');
    card.appendChild(act);
    fillCardAction(card, p);
    fillPositionPnl(card, p);
    return card;
  }

  function pcCell(k, v, role, wide) {
    var c = el('div', 'pc-cell' + (wide ? ' is-wide' : ''));
    c.appendChild(el('span', 'pc-k', k));
    var s = el('span', 'pc-v', v);
    if (role) s.setAttribute('data-role', role);
    c.appendChild(s);
    return c;
  }

  /* The bottom of a position card: CLOSE POSITION and its estimate; "Confirm in your wallet…"
     while the wallet is up; the close's progress once it is filed. Rebuilt only when that mode
     changes, so a button is never swapped out under a finger. */
  function fillCardAction(card, p) {
    var act = card.querySelector('[data-role="act"]');
    if (!act) return;
    var pid = String(p.id);
    var cr = acct.closeReqs[pid];
    /* retrying: Try again is clearing the expired request, then files a new one (closing takes
       over the moment the wallet is asked); checking: the request is gone from chain and the
       result is being read from the logs; settling: the logs say it closed */
    var mode = ui.retrying[pid] && !ui.closing[pid] ? 'retrying' : cr ? 'req' : ui.closing[pid] ? 'wallet'
      : ui.checking[pid] ? 'checking' : ui.settling[pid] ? 'settling' : 'idle';
    if (act.getAttribute('data-mode') !== mode) {
      act.setAttribute('data-mode', mode);
      act.textContent = '';
      if (mode === 'idle') {
        var b = el('button', 'btn btn-block close-btn', 'CLOSE POSITION');
        b.type = 'button';
        b.addEventListener('click', function () { tourEvent('close'); submitClose(posById(pid) || p); });
        act.appendChild(b);
        var est = el('div', 'pc-est');
        est.setAttribute('data-role', 'est');
        act.appendChild(est);
      } else {
        act.appendChild(makeProg('Closing ' + posLabel(p), function () { closeReqAction(posById(pid) || p); }));
      }
    }
    if (mode === 'idle') {
      var cb = act.querySelector('.close-btn');
      if (cb) cb.disabled = state.busy;
      return;
    }
    var box = act.querySelector('.prog');
    if (!box) return;
    if (mode === 'wallet') setProg(box, { steps: [[state.viaSession ? 'Sending…' : 'Confirm in your wallet…', 'is-on'], ['Closing at the oracle price', ''], ['Closed', '']] });
    else if (mode === 'retrying') setProg(box, { steps: [['Clearing the old request…', 'is-on'], ['Closing again at the oracle price', ''], ['Closed', '']], note: 'Clearing the old request, then closing again. ' + (sessionLive() ? '' : 'Your wallet asks twice.') });
    else if (mode === 'checking') setProg(box, CHECKING_VIEW);
    else if (mode === 'settling') setProg(box, { cls: 'is-done', steps: [['Sent', 'is-done'], ['Closed at the oracle price', 'is-done'], ['Adding it to your balance…', 'is-on']] });
    else setProg(box, progressView('close', cr, p.margin));
  }

  /* A close whose request is gone from chain, while the logs are read for how it ended. */
  var CHECKING_VIEW = { steps: [['Sent', 'is-done'], ['Checking the result…', 'is-on'], ['Closed', '']] };

  /* Finish now (late) or Try again (expired) on a close, by its phase at click time. */
  function closeReqAction(p) {
    var cr = acct.closeReqs[String(p.id)];
    if (!cr || cr.busy) return;
    var ph = requestPhase(cr.requestedAt);
    if (ph.phase === 'fallback') executeCloseNow(p);
    else if (ph.phase === 'expired') retryClose(p);
  }

  /* ---- results that stay where the position was: closed (about a minute), liquidated and
     "while you were away" (until OK) ---- */

  function addRecent(r) {
    r.key = r.key || String(Date.now());
    ui.recent = ui.recent.filter(function (x) { return x.key !== r.key; });
    ui.recent.unshift(r);
    if (ui.recent.length > 4) ui.recent.length = 4;
    if (r.ttl) setTimeout(function () { dropRecent(r.key); }, r.ttl);
    renderPositions();
  }

  function dropRecent(key) {
    var n = ui.recent.length;
    ui.recent = ui.recent.filter(function (x) { return x.key !== key; });
    if (ui.recent.length !== n) renderPositions();
  }

  function recentCard(r) {
    var card = el('div', 'result-card' + (r.cls ? ' ' + r.cls : ''));
    card.setAttribute('data-recent', r.key);
    card.appendChild(el('div', 'rc-title', r.title));
    (r.lines || []).forEach(function (l) { card.appendChild(el('div', 'rc-line', l)); });
    var row = el('div', 'rc-btns');
    (r.buttons || []).forEach(function (b) {
      var x = el('button', 'btn btn-sm', b.label);
      x.type = 'button';
      if (b.act) x.setAttribute('data-act', b.act);
      x.addEventListener('click', b.fn);
      row.appendChild(x);
    });
    var ok = el('button', 'btn btn-sm btn-ghost', 'OK');
    ok.type = 'button';
    ok.addEventListener('click', function () { dropRecent(r.key); });
    row.appendChild(ok);
    card.appendChild(row);
    return card;
  }

  function pendingOpenList() {
    return Object.keys(pend.opens).map(function (k) { return pend.opens[k]; }).sort(function (a, b) { return Number(a.id) - Number(b.id); });
  }

  /* What Your positions shows, top to bottom: result cards that belong to no position ("while you
     were away"), requests still opening, then the positions newest first. A position's result card
     (closed, liquidated) takes that position's place, before and after the position leaves the
     list, and a close whose result is being read keeps a card there once the position is gone. */
  function posItems() {
    var items = [], slots = [], seen = {};
    ui.recent.forEach(function (r) { if (r.pid == null) items.push({ kind: 'recent', r: r, key: 'r' + r.key }); });
    pendingOpenList().slice().reverse().forEach(function (r) { items.push({ kind: 'open', r: r, key: 'o' + r.id }); });
    ui.recent.forEach(function (r) {
      if (r.pid == null || seen[r.pid]) return;
      seen[r.pid] = true;
      slots.push({ id: BigInt(r.pid), item: { kind: 'recent', r: r, key: 'r' + r.key } });
    });
    acct.positions.forEach(function (p) {
      var pid = String(p.id);
      if (seen[pid]) return;
      seen[pid] = true;
      slots.push({ id: BigInt(p.id), item: { kind: 'pos', p: p, key: 'p' + pid + ':' + String(p.entryPx18) } });
    });
    Object.keys(ui.checking).forEach(function (pid) {
      if (seen[pid]) return;
      seen[pid] = true;
      slots.push({ id: BigInt(pid), item: { kind: 'checking', pid: pid, p: ui.checking[pid], key: 'k' + pid } });
    });
    slots.sort(function (a, b) { return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; });
    slots.forEach(function (s) { items.push(s.item); });
    return items;
  }

  /* The shape of the positions list (which cards, in which order); the cards are rebuilt only
     when it changes and updated in place otherwise. */
  function posSigOf() {
    var parts = [wallet.account || '-', acct.loaded ? 'L' : '-', hasExchange() ? 'X' : '-'];
    posItems().forEach(function (it) { parts.push(it.key); });
    return parts.join('|');
  }

  /* The card of a close being checked once its position has left the list. */
  function checkingCard(pid, p) {
    var card = el('div', 'pos-card is-pending' + (p && p !== true ? (p.isLong ? ' is-long' : ' is-short') : ''));
    card.setAttribute('data-check', pid);
    card.title = 'Position #' + pid;
    var box = makeProg('Closing ' + (p && p !== true ? posLabel(p) : 'your position'));
    setProg(box, CHECKING_VIEW);
    card.appendChild(box);
    return card;
  }

  function clearCards(host) {
    Array.prototype.slice.call(host.children).forEach(function (c) { if (c.id !== 'posEmpty') host.removeChild(c); });
  }

  /* Your positions: result cards, requests still opening, then one card per position. On a phone
     the panel moves above the chart while there is anything in it (.has-pos). */
  function renderPositions() {
    syncPositionLines();
    var host = $('posLines');
    var empty = $('posEmpty');
    if (!host || !empty) return;
    var opens = pendingOpenList();
    var n = acct.positions.length + opens.length;
    setText('posCount', n ? ' (' + n + ')' : '');
    var closing = Object.keys(ui.checking).length;
    var layout = $('tradeLayout');
    if (layout) layout.classList.toggle('has-pos', !!wallet.account && (n > 0 || closing > 0 || ui.recent.length > 0));
    var closable = acct.positions.filter(function (p) { var k = String(p.id); return !acct.closeReqs[k] && !ui.closing[k] && !ui.settling[k]; }).length;
    var ca = $('closeAllBtn');
    if (ca) { ca.hidden = closable < 2; ca.disabled = state.busy; }
    var sig = posSigOf();
    if (sig === ui.posSig) { updateCards(); renderPosChip(); if (wallet.account) watchPending(); return; }
    ui.posSig = sig;
    clearCards(host);
    renderPosChip();
    if (!wallet.account) { empty.textContent = 'Connect a wallet to see your positions.'; empty.hidden = false; return; }
    if (!hasExchange()) { empty.textContent = 'Trading is off on this copy of the site.'; empty.hidden = false; return; }
    if (!acct.loaded) { empty.textContent = 'Loading your positions…'; empty.hidden = false; return; }
    var items = posItems();
    empty.textContent = 'No open positions. Pick BUY / LONG or SELL / SHORT to open one.';
    empty.hidden = items.some(function (it) { return it.kind !== 'recent'; });
    var frag = document.createDocumentFragment();
    items.forEach(function (it) {
      if (it.kind === 'recent') frag.appendChild(recentCard(it.r));
      else if (it.kind === 'open') frag.appendChild(pendingOpenCard(it.r));
      else if (it.kind === 'checking') frag.appendChild(checkingCard(it.pid, it.p));
      else frag.appendChild(positionCard(it.p));
    });
    host.appendChild(frag);
    watchPending();
  }

  /* The cheap pass: prices, countdowns and buttons of the cards already there, in place. */
  function updateCards() {
    var host = $('posLines');
    if (!host) return;
    acct.positions.forEach(function (p) {
      var card = host.querySelector('.pos-card[data-id="' + String(p.id) + '"]');
      if (card) { fillCardAction(card, p); fillPositionPnl(card, p); }
    });
    pendingOpenList().forEach(function (r) {
      var card = host.querySelector('.pos-card[data-req="' + r.id + '"]');
      if (card) updateOpenProg(card, r);
    });
  }

  function updatePositionPrices() { updateCards(); }

  /* Countdown tick, four times a second while anything is pending: a request that just went late
     gets its toast, the cards and the ticket's progress card move on, then the wallet is asked to
     finish a late request when the trader agreed to that. */
  function updatePendingLines() {
    pendingOpenList().forEach(function (r) {
      if (r.requestedAt == null) return;
      var ph = requestPhase(r.requestedAt);
      if (ph.phase === 'fallback' || ph.soon) noteLate(r, 'Your ' + reqSym(r) + ' ' + sideWord(r.isLong).toLowerCase(), openReqEls(r));
    });
    Object.keys(acct.closeReqs).forEach(function (pid) {
      var cr = acct.closeReqs[pid];
      if (cr.requestedAt == null) return;
      var ph = requestPhase(cr.requestedAt);
      if (ph.phase !== 'fallback' && !ph.soon) return;
      var p = posById(pid);
      noteLate(cr, 'Closing your ' + (p ? posLabel(p) : 'position'), [posCardEl(pid)]);
    });
    updateCards();
    renderTicketProgress(false);
    autoFill();
  }

  /* ---- the ticket's progress card (tk) ---- */

  function tkSet(phase, fields) {
    tk.phase = phase;
    if (fields) Object.keys(fields).forEach(function (k) { tk[k] = fields[k]; });
    if (tk.timer) { clearTimeout(tk.timer); tk.timer = null; }
    if (phase === 'opened') tk.timer = setTimeout(tkDoneOpened, 10000);
    if (phase === 'error' || phase === 'unknown') tk.timer = setTimeout(function () { if (tk.phase === phase) tkReset(); }, 9000);
    renderTicketProgress(true);
    renderAction();
  }

  function tkReset() {
    tk.phase = null; tk.reqId = null; tk.msg = '';
    if (tk.timer) { clearTimeout(tk.timer); tk.timer = null; }
    renderTicketProgress(true);
    renderAction();
  }

  /* Ten seconds of "Open at": then the form again; on a phone the sheet closes onto the new card. */
  function tkDoneOpened() {
    if (tk.phase !== 'opened') return;
    tkReset();
    if (ui.sheet && !tour.on) showPositions();
  }

  function ticketView() {
    var title = 'Opening ' + sideWord(tk.isLong) + ' ' + tk.sym + ' ' + tk.lev + 'x · ' + fmtUsdShort(tk.margin);
    if (tk.phase === 'wallet') {
      return {
        title: title, steps: [[state.viaSession ? 'Sending…' : 'Confirm in your wallet…', 'is-on'], ['Opening at the oracle price', ''], ['Open', '']],
        note: state.viaSession ? 'One-click is on: no wallet popup.' : 'Your wallet shows the trade. Nothing is sent until you confirm.'
      };
    }
    if (tk.phase === 'req') {
      var r = pend.opens[tk.reqId];
      if (!r) return { title: title, steps: [['Sent', 'is-done'], ['Checking the result…', 'is-on'], ['Open', '']] };
      var v = progressView('open', r, r.margin);
      v.title = title;
      return v;
    }
    if (tk.phase === 'opened') {
      return {
        cls: 'is-done', title: 'Opened ' + sideWord(tk.isLong) + ' ' + tk.sym + ' ' + tk.lev + 'x · ' + fmtUsdShort(tk.margin),
        steps: [['Sent', 'is-done'], ['Filled at the oracle price', 'is-done'], ['Open at ' + fmtPrice(tk.entry, szOf(tk.sym)), 'is-done']],
        btn: 'View position', btnFree: true, btn2: 'New trade'
      };
    }
    if (tk.phase === 'refunded') return { cls: 'is-bad', title: title, steps: [['Sent', 'is-done'], [tk.msg, 'is-on is-bad'], ['Open', 'is-skip']], btn: 'OK', btnFree: true };
    if (tk.phase === 'unknown') return { title: title, steps: [['Sent', 'is-done'], [tk.msg, 'is-on'], ['Open', '']], btn: 'OK', btnFree: true };
    return { cls: 'is-bad', title: title, steps: [[tk.msg || 'That did not go through.', 'is-on is-bad'], ['Opening at the oracle price', 'is-skip'], ['Open', 'is-skip']], btn: 'OK', btnFree: true };
  }

  /* The progress card where OPEN POSITION was. rebuild: a new phase (fresh buttons). */
  function renderTicketProgress(rebuild) {
    var host = $('ticketProgress');
    var btn = $('actionBtn');
    if (!host) return;
    /* phones: while a request is out the form folds away (trade.html), so the card sits right
       under the direction buttons and its late / expired buttons stay on screen */
    var tc = document.querySelector('.ticket');
    if (tc) tc.classList.toggle('is-going', !!tk.phase);
    if (!tk.phase) {
      if (!host.hidden) { host.hidden = true; host.textContent = ''; }
      if (btn) btn.hidden = false;
      renderBarStatus(null);
      return;
    }
    if (btn) btn.hidden = true;
    host.hidden = false;
    var box = host.querySelector('.prog');
    if (rebuild || !box) {
      host.textContent = '';
      box = makeProg('', ticketBtn, function () { tkReset(); });
      host.appendChild(box);
    }
    var v = ticketView();
    var was = box.className;
    setProg(box, v);
    renderBarStatus(v);
    /* a new phase or a new state (late, expired) in the sheet: keep the card in sight */
    if ((rebuild || box.className !== was) && ui.sheet && host.scrollIntoView) host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function ticketBtn() {
    if (tk.phase === 'req') { var r = pend.opens[tk.reqId]; if (r) openReqAction(r); return; }
    if (tk.phase === 'opened') { var id = tk.posId; tkReset(); showPositions(id ? '.pos-card[data-id="' + id + '"]' : null); return; }
    tkReset();
  }

  /* Phones: the ticket's progress in one line over the bar while the sheet is closed. */
  function renderBarStatus(v) {
    var s = $('barStatus');
    if (!s) return;
    if (!v || ui.sheet) { s.hidden = true; return; }
    var on = (v.steps || []).filter(function (x) { return /is-on/.test(x[1]); })[0];
    var text = v.cls === 'is-done' ? v.steps[2][0] : (on ? on[0] : v.title);
    s.hidden = false;
    s.textContent = tk.sym + ' ' + sideWord(tk.isLong) + ': ' + text;
    s.className = 'mbar-status' + (v.cls ? ' ' + v.cls : '');
  }

  function onPrices() {
    if (DEMO) demoOracle();
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

  /* Wallets announce themselves (EIP-6963). With more than one, Connect asks which and remembers it for the silent reconnect. */
  var WALLET_KEY = 'confetti.wallet';
  function walletPref() { try { return localStorage.getItem(WALLET_KEY) || ''; } catch (e) { return ''; } }
  function setWalletPref(v) { try { localStorage.setItem(WALLET_KEY, v); } catch (e) { /* storage blocked */ } }
  function walletList() {
    var seen = {};
    return announced.filter(function (d) {
      var k = d && d.info ? (d.info.rdns || d.info.uuid || d.info.name) : '';
      if (!k || seen[k]) return false;
      seen[k] = 1; return true;
    });
  }
  function getInjected() {
    var list = walletList(), pref = walletPref();
    if (pref) {
      var hit = list.filter(function (d) { return d.info && d.info.rdns === pref; })[0];
      if (hit) return hit.provider;
    }
    if (list.length === 1) return list[0].provider;
    var eth = window.ethereum;
    if (eth) {
      if (Array.isArray(eth.providers) && eth.providers.length) return eth.providers[0];
      return eth;
    }
    return list.length ? list[0].provider : null;
  }
  function chooseWallet() {
    var list = walletList();
    if (list.length < 2) return Promise.resolve(getInjected());
    return new Promise(function (resolve) {
      var dlg = document.createElement('dialog');
      dlg.setAttribute('aria-label', 'Choose a wallet');
      dlg.style.cssText = 'padding:0;border:1px solid var(--ink,#2a2520);background:var(--raised,#fbf6ea);color:var(--ink,#2a2520);width:min(360px,calc(100vw - 32px));box-shadow:8px 8px 0 var(--sunken,#e8dfc8)';
      var head = document.createElement('div');
      head.textContent = 'Choose a wallet';
      head.style.cssText = 'padding:12px 14px;border-bottom:1px solid var(--rule,#d8cdb4);font-weight:600';
      dlg.appendChild(head);
      var body = document.createElement('div');
      body.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px 14px';
      var done = false;
      function finish(p) { if (done) return; done = true; try { dlg.close(); } catch (e) {} dlg.remove(); resolve(p); }
      list.forEach(function (d) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'btn';
        b.style.cssText = 'display:flex;align-items:center;gap:10px;justify-content:flex-start;width:100%';
        if (d.info.icon && /^data:image\//.test(d.info.icon)) {
          var img = document.createElement('img'); img.src = d.info.icon; img.alt = ''; img.width = 22; img.height = 22;
          b.appendChild(img);
        }
        var name = document.createElement('span'); name.textContent = d.info.name || d.info.rdns || 'Wallet';
        b.appendChild(name);
        b.addEventListener('click', function () { setWalletPref(d.info.rdns || ''); finish(d.provider); });
        body.appendChild(b);
      });
      var cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'btn btn-ghost'; cancel.textContent = 'Cancel';
      cancel.addEventListener('click', function () { finish(null); });
      body.appendChild(cancel);
      dlg.appendChild(body);
      dlg.addEventListener('cancel', function () { finish(null); });
      document.body.appendChild(dlg);
      try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); }
    });
  }

  function connect() {
    return chooseWallet().then(function (eth) {
      if (eth) return connectWith(eth);
      if (!walletList().length && !window.ethereum) openWalletApps();
    });
  }

  function connectWith(eth) {
    var E = window.ethers;
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
      if (wallet.chainId !== CHAIN_ID) return switchChain().then(function () { return onChainChanged(); }).catch(switchFailed);
    }).catch(function (e) {
      toast(describeError(e), 'err');
      renderWallet(); renderAction();
    });
  }

  /* Reconnect silently when the wallet already authorised this site. */
  function tryAutoConnect() {
    var E = window.ethers;
    var eth = getInjected();
    if (!eth || !E) { tour.autoTried = true; return; }
    eth.request({ method: 'eth_accounts' }).then(function (accounts) {
      if (!accounts || !accounts.length) return;
      wallet.eth = eth;
      wallet.account = E.getAddress(accounts[0]);
      return eth.request({ method: 'eth_chainId' }).then(function (hex) {
        wallet.chainId = parseInt(hex, 16);
        subscribeWallet(eth);
        return onChainChanged();
      });
    }).catch(function () { /* stay disconnected */ }).then(function () { tour.autoTried = true; });
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
        if (wallet.chainId !== CHAIN_ID) toast('Your wallet is on ' + chainName(wallet.chainId) + '. Confetti runs on HyperEVM: tap Switch to HyperEVM.', 'err');
        restorePendingOpens();
        /* read the last block seen before refreshAccount moves it on */
        scanAway(wallet.account);
        maybeStartTour();
        return Promise.all([refreshAccount(), refreshWalletUsdc(), loadHistory(true), loadReferral(), refreshSession()]);
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
      if (wallet.chainId !== CHAIN_ID) throw new Error('Your wallet is still on ' + chainName(wallet.chainId) + '.');
    });
  }

  /* A switch the wallet refused or could not make: say so, with the network to add by hand. */
  function switchFailed(e) {
    if (isUserRejection(e)) { toast('Your wallet stayed on ' + chainName(wallet.chainId) + '. Switch to HyperEVM to trade.', 'err'); return; }
    toast(describeError(e) + ' To add HyperEVM by hand: chain id 999, RPC ' + ((cfg && cfg.rpcUrl) || DEFAULT_RPC) + ', currency HYPE, explorer ' + ((cfg && cfg.explorerUrl) || 'https://hyperevmscan.io') + '.', 'err', null, 20000);
  }

  function resetAccount() {
    acct.loaded = false; acct.available = 0; acct.marginInUse = 0; acct.pending = 0; acct.positions = []; acct.closeReqs = {}; acct.walletUsdc = 0; acct.allowance = 0;
    acct.owner = null; acct.owed = 0; acct.owedAt = 0;
    syncPositionLines();
    pend.opens = {};
    ui.closing = {}; ui.checking = {}; ui.settling = {}; ui.retrying = {}; ui.recent = []; ui.hypeWei = null; ui.posSig = '';
    ui.owedSig = ''; ui.owedAt = 0;
    if (tk.phase) tkReset();
    ref.addr = null; ref.locked = null; ref.referrer = null; ref.myCode = ''; ref.earned = null; ref.loaded = false;
    sess.key = null; sess.onchain = null; sess.gasWei = null; sess.loaded = false;
    hl.account = null; hl.proxy = null; hl.spotFreeWei = null; hl.perp6 = null; hl.evm6 = null;
    hist = freshHistory();
    renderAccount(); renderPositions(); renderHistory(); renderRefer(); renderSession(); renderDepositModal();
  }

  function disconnect() {
    wallet.account = null; wallet.signer = null; wallet.provider = null; wallet.chainId = null;
    resetAccount();
    renderWallet(); renderAction(); renderStatus();
    toast('Disconnected from this page. Your wallet may still list the site as connected.');
  }

  /* The header: Connect, or the address (a tap opens Copy / explorer / Disconnect); Deposit and
     Withdraw only once a wallet is connected. */
  function renderWallet() {
    var btn = $('connectBtn');
    if (!btn) return;
    if (wallet.account) {
      btn.textContent = shortAddr(wallet.account);
      btn.title = wallet.account;
      btn.classList.toggle('btn-accent', wallet.chainId !== CHAIN_ID);
    } else {
      btn.textContent = 'Connect';
      btn.title = '';
      btn.classList.add('btn-accent');
    }
    /* .btn uppercases; an address stays as written (0xde00…, not 0XDE00…) */
    btn.style.textTransform = wallet.account ? 'none' : '';
    ['depositBtn', 'withdrawBtn'].forEach(function (id) { var b = $(id); if (b) b.hidden = !wallet.account; });
    var strip = $('acctStrip');
    if (strip) strip.hidden = !wallet.account;
    var mini = $('acctMini');
    if (mini) mini.hidden = !wallet.account;
  }

  /* Your address: copy it, see it on the explorer, or disconnect (no longer one tap away). */
  function openAccountMenu() {
    if (!wallet.account) return;
    setText('acctTitle', shortAddr(wallet.account));
    var ex = $('amExplorer');
    if (ex) ex.href = explorer('address', wallet.account);
    openDialog('acctModal');
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

  /* What a revert means, in the words a trader would use. Admin-only errors keep their short
     technical text (nobody trading meets them). KeeperWindow and TooEarly never reach the
     trader: the fill paths retry on them. */
  var FRIENDLY = {
    Unauthorized: function () { return 'Not allowed from this wallet.'; },
    ZeroAddress: function () { return 'Zero address.'; },
    ZeroAmount: function () { return 'Enter an amount above zero.'; },
    UnknownInstrument: function () { return 'That market is not on Confetti yet.'; },
    MarketRetired: function () { return 'This market is closed for new trades. You can still close.'; },
    OpensPausedGlobally: function () { return 'New trades are paused for now. You can still close.'; },
    OpensPausedForMarket: function () { return 'New trades on this market are paused for now. You can still close.'; },
    MarginBelowMinimum: function () { return 'Minimum is $' + MIN_MARGIN + '.'; },
    LeverageOutOfRange: function () { return 'That leverage is over this market\'s limit.'; },
    OiCapExceeded: function () { return 'This market is full on that side right now. Lower the amount or leverage.'; },
    PositionTooLarge: function () { return 'Too big for this market. Lower the amount or leverage.'; },
    OpensPausedByBreaker: function () { return 'New trades are paused for now. You can still close.'; },
    BreakerNotTripped: function () { return 'The loss breaker is not tripped.'; },
    FeedAlive: function (a) { return 'Market #' + a[0] + ' still has a live price feed; retire it normally.'; },
    InsufficientBalance: function (a) { return 'Not enough balance: you have ' + fmtUsd(usd6ToNum(a[0])) + ', this needs ' + fmtUsd(usd6ToNum(a[1])) + '.'; },
    UnknownPosition: function () { return 'That position is already closed or liquidated.'; },
    NotPositionOwner: function () { return 'That position belongs to another wallet.'; },
    NotLiquidatable: function () { return 'That position is not at its liquidation price.'; },
    InvalidTier: function (a) { return 'Invalid tier ' + a[0] + '.'; },
    ParamOutOfBounds: function (a) { return 'Parameter out of bounds (' + a[1] + ').'; },
    QueueEmpty: function () { return 'No wins are owed right now.'; },
    QueueNotEmpty: function () { return 'Not allowed while wins are owed.'; },
    NothingToPush: function () { return 'Nothing to push right now.'; },
    UnknownRequest: function () { return 'Already done: it was filled, refunded or cancelled.'; },
    TooEarly: function () { return 'Almost: try again in a second.'; },
    KeeperWindow: function () { return 'Almost: try again in a second.'; },
    RequestExpired: function () { return 'It ran out of time. Get your money back from its card.'; },
    RequestNotExpired: function () { return 'Not out of time yet: give it a few more seconds.'; },
    CloseAlreadyPending: function () { return 'This position is already closing.'; },
    PriceJumped: function () { return 'The price moved too fast to fill. Your money is back in your balance.'; },
    EntryBusted: function () { return 'The price passed your liquidation price before the fill. Your money is back in your balance.'; },
    MigrationPending: function () { return 'New trades start after the move to the new exchange.'; },
    FeedUnavailable: function () { return 'The price feed is down for a moment. Try again shortly.'; },
    ZeroPrice: function () { return 'The price feed is down for a moment. Try again shortly.'; },
    ClampOutOfBounds: function (a) { return 'Clamp ' + a[0] + ' bps is out of bounds.'; },
    InvalidCode: function () { return 'Codes are 3 to 16 characters: a-z, 0-9, underscore.'; },
    CodeTaken: function (a) { return 'Code "' + a[0] + '" is taken.'; },
    AlreadyRegistered: function () { return 'This wallet already has a code.'; },
    NotExchange: function () { return 'Exchange only.'; },
    OwnableUnauthorizedAccount: function () { return 'Owner only.'; },
    ReentrancyGuardReentrantCall: function () { return 'That didn\'t go through. Your balance is unchanged.'; },
    SafeERC20FailedOperation: function () { return 'The USDC transfer failed. Your balance is unchanged.'; },
    ERC20InsufficientAllowance: function (a) { return 'USDC not approved for that much: approved ' + fmtUsd(usd6ToNum(a[1])) + ', needed ' + fmtUsd(usd6ToNum(a[2])) + '.'; },
    ERC20InsufficientBalance: function (a) { return 'Your wallet has ' + fmtUsd(usd6ToNum(a[1])) + ' USDC; this needs ' + fmtUsd(usd6ToNum(a[2])) + '.'; },
    BadExpiry: function () { return 'Session length out of range (up to 30 days).'; },
    ZeroMarginCap: function () { return 'Set a cap per trade.'; },
    KeyInUse: function () { return 'That session key serves another wallet.'; },
    GasForwardFailed: function () { return 'Could not send gas to the session key.'; },
    BadKeySignature: function () { return 'The session key\'s signature did not match.'; },
    NoSession: function () { return 'No one-click session.'; },
    SessionExpired: function () { return 'The one-click session expired.'; },
    MarginAboveSessionCap: function (a) { return 'Amount ' + fmtUsd(usd6ToNum(a[0])) + ' is above the one-click cap ' + fmtUsd(usd6ToNum(a[1])) + '.'; },
    NotYours: function () { return 'Not your request.'; },
    NotTrader: function () { return 'Only the trader may do that.'; }
  };

  function friendly(name, args) {
    var f = FRIENDLY[name];
    try { if (f) return f(args || []); } catch (e) { /* fall through */ }
    var list = [];
    try { list = Array.from(args || []).map(function (x) { return String(x); }); } catch (e) { /* ignore */ }
    console.warn('revert ' + name + '(' + list.join(', ') + ')');
    return 'That didn\'t go through. Your balance is unchanged.';
  }

  /* Short text for the `reason` selector of a refund or cancel event ("Didn't open: ..."). */
  var REASONS = {
    RequestExpired: 'it ran out of time', PriceJumped: 'the price moved too fast', EntryBusted: 'the price passed your liquidation price',
    MarketRetired: 'the market closed', OpensPausedGlobally: 'trading paused', OpensPausedForMarket: 'trading paused',
    OpensPausedByBreaker: 'trading paused', LeverageOutOfRange: 'leverage over the limit', PositionTooLarge: 'too big for this market',
    OiCapExceeded: 'the market is full on that side', MarginBelowMinimum: 'under the $' + MIN_MARGIN + ' minimum', UnknownPosition: 'liquidated first'
  };

  function reasonText(selector) {
    var name = null;
    try { var f = exIface && exIface.getError(selector); if (f) name = f.name; } catch (e) { /* unknown selector */ }
    if (!name) return 'for a reason the page could not read';
    return REASONS[name] || name;
  }

  function decodeRevert(data) {
    var E = window.ethers;
    var p = parseAnyError(data);
    if (p) return friendly(p.name, p.args);
    try {
      if (data.slice(0, 10) === '0x08c379a0') {
        return 'That didn\'t go through: ' + E.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
      }
    } catch (e) { /* ignore */ }
    console.warn('revert data ' + data);
    return 'That didn\'t go through. Your balance is unchanged.';
  }

  function describeError(err) {
    if (!err) return 'Something went wrong.';
    if (typeof err === 'string') return err;
    if (isUserRejection(err)) return 'You cancelled in your wallet. Nothing was sent.';
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
    text = text.replace(/\s*\(.*action=.*$/s, '').replace(/^execution reverted:?\s*/i, 'That didn\'t go through: ');
    if (/insufficient funds/i.test(text)) return HYPE_NOTE;
    return text.length > 220 ? text.slice(0, 220) + '…' : text;
  }

  /* ---- transactions -------------------------------------------------------------- */

  function requireSigner() {
    if (!window.ethers) throw new Error('ethers.js not loaded.');
    if (!wallet.account || !wallet.signer) throw new Error('Connect a wallet first.');
    if (wallet.chainId !== CHAIN_ID) throw new Error('Switch the wallet to HyperEVM (999) first.');
    if (!hasExchange()) throw new Error('Exchange address not configured.');
    if (house.usdcBad) throw new Error('This exchange does not settle in native USDC.');
  }

  function exchangeWrite() { return new window.ethers.Contract(cfg.contracts.exchange, EXCHANGE_ABI, wallet.signer); }
  function usdcWrite() { return new window.ethers.Contract(USDC, ERC20_ABI, wallet.signer); }

  /* One wallet transaction at a time: while one is out the other buttons that send wait. */
  function setBusy(on) {
    state.busy = !!on;
    if (!on) state.viaSession = false;
    renderAction();
    updateCards();
    var ca = $('closeAllBtn');
    if (ca) ca.disabled = state.busy;
    ['depositSubmit', 'withdrawSubmit', 'sessionSubmit'].forEach(function (id) { var b = $(id); if (b) b.disabled = state.busy; });
    renderSession(); renderDepositModal();
  }

  function txLink(hash) { return DEMO ? null : { href: explorer('tx', hash), label: 'view' }; }

  /* Dry-run with eth_call for a decoded revert reason, send, then wait for one confirmation.
     quiet: no "waiting for confirmation" toast (trades: their progress card says it). */
  function sendTx(desc, method, args, quiet) {
    if (DEMO) return Promise.reject(new Error('Demo: nothing is sent.'));
    return method.staticCall.apply(method, args).then(function () {
      return method.apply(null, args);
    }).then(function (tx) {
      var pending = quiet ? null : toast(desc + ': sent, waiting for the chain…', 'pending', txLink(tx.hash), 0);
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
    if (DEMO) { demoRefresh(); return Promise.resolve(); }
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

  /* ---- one-click (SessionRouter session key) ------------------------------------------
     The key is a plain private key in localStorage under the account; the router binds it to
     the account with authorize (wallet, once, with SESSION_GAS_HYPE for the key's gas). The key
     can only file and cancel the account's requests and fill them after the keeper window; it
     can never deposit, withdraw, transfer or register a code (SessionRouter). */

  function sessionStoreKey() { return wallet.account ? LS.session + wallet.account.toLowerCase() : null; }

  /* The account's key from localStorage as an ethers.Wallet on the read provider (cached by key). */
  function loadSessionKey() {
    var k = sessionStoreKey();
    var pk = k ? lsGet(k) : null;
    if (!pk || !window.ethers || !read.provider) { sess.key = null; return; }
    if (sess.key && sess.key.privateKey === pk) return;
    try { sess.key = new window.ethers.Wallet(pk, read.provider); } catch (e) { sess.key = null; }
  }

  function dropSessionKey() {
    var k = sessionStoreKey();
    if (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
    sess.key = null; sess.gasWei = null;
  }

  function fmtHype(wei) { return wei == null ? '—' : (Number(wei) / 1e18).toFixed(4); }

  /* Live: the router's session for this account is this browser's key, it has more than a minute
     left on the chain clock, and the key holds gas. */
  function sessionLive() {
    var s = sess.onchain;
    return !!(read.router && sess.key && s && s.key.toLowerCase() === sess.key.address.toLowerCase() &&
      s.expiry > chainNow() + 60 && sess.gasWei != null && sess.gasWei >= SESSION_MIN_GAS);
  }

  function refreshSession() {
    if (DEMO) { renderSession(); return Promise.resolve(); }
    if (!read.router || !wallet.account) { sess.onchain = null; sess.loaded = false; renderSession(); return Promise.resolve(); }
    var a = wallet.account;
    loadSessionKey();
    var key = sess.key;
    return Promise.all([
      read.router.sessionOf(a),
      key ? read.provider.getBalance(key.address) : Promise.resolve(null)
    ]).then(function (r) {
      if (wallet.account !== a) return;
      var s = r[0];
      sess.onchain = s && s.key !== ZERO ? { key: s.key, expiry: Number(s.expiry), cap6: BigInt(s.maxMarginPerTrade), referrer: s.referrer } : null;
      sess.gasWei = r[1] == null ? null : BigInt(r[1]);
      sess.loaded = true;
      renderSession(); renderAction();
    }).catch(function () { /* transient RPC trouble: keep the last values */ });
  }

  function renderSession() {
    var row = $('sessionRow');
    if (row) row.hidden = !(read.router && wallet.account);
    var btn = $('sessionBtn'), rv = $('sessionRevoke'), st = $('sessionState');
    if (!btn || !st) return;
    var s = sess.onchain;
    var mine = !!(s && sess.key && s.key.toLowerCase() === sess.key.address.toLowerCase());
    var live = sessionLive();
    var text = '—', title = '';
    if (read.router && wallet.account) {
      if (live) { text = 'on · ' + fmtUsd(usd6ToNum(s.cap6)) + ' a trade · until ' + fmtTime(s.expiry); title = 'session key ' + sess.key.address + ' · gas ' + fmtHype(sess.gasWei) + ' HYPE'; }
      else if (mine && s.expiry <= chainNow() + 60) text = 'expired';
      else if (mine) text = 'out of gas';
      else if (s) text = 'on in another browser';
      else text = sess.loaded ? 'off' : '…';
    }
    st.textContent = text; st.title = title;
    btn.disabled = state.busy || !read.router;
    if (live) btn.setAttribute('hidden', ''); else btn.removeAttribute('hidden');
    if (rv) {
      rv.disabled = state.busy;
      if (read.router && wallet.account && (s || sess.key)) rv.removeAttribute('hidden'); else rv.setAttribute('hidden', '');
    }
  }

  function openSession() {
    if (!read.router) return;
    if (!wallet.account) { connect(); return; }
    if (wallet.chainId !== CHAIN_ID) { toast('Switch the wallet to HyperEVM first.', 'err'); return; }
    var cap = $('sessionCap');
    if (cap && !cap.value) {
      var guess = isFinite(form.margin) && form.margin >= MIN_MARGIN ? form.margin : acct.available;
      cap.value = String(Math.max(MIN_MARGIN, Math.floor(guess) || MIN_MARGIN));
    }
    var hint = $('sessionHint'); if (hint) { hint.textContent = ''; hint.classList.remove('is-err'); }
    openDialog('sessionModal');
  }

  /* authorize(key, expiry, cap, referrer, keySig) from the wallet with SESSION_GAS_HYPE. This
     browser's key is reused (its leftover gas comes along) unless the router binds it to another
     account; a new key is written to localStorage before the transaction, so the gas it receives
     is never lost with the page. The referrer is the one a wallet open would pass (referrerArg);
     the key signs the router's authorizationDigest (EIP-191 over the 32 bytes) to prove the
     wallet holds it. */
  function submitAuthorize(capUsd, days) {
    if (DEMO) { toast('Demo: nothing is sent.'); return Promise.resolve(); }
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(); }
    if (!read.router) return Promise.resolve();
    var E = window.ethers;
    var a = wallet.account;
    var router = new E.Contract(read.router.target, ROUTER_ABI, wallet.signer);
    setBusy(true);
    loadSessionKey();
    var reuse = sess.key ? read.router.traderOf(sess.key.address).then(function (t) { return t === ZERO || t.toLowerCase() === a.toLowerCase(); }) : Promise.resolve(false);
    var expiry, cap6, referrer;
    return Promise.all([reuse, loadReferral().catch(function () { /* keep the last referral state */ })]).then(function (r) {
      var ok = r[0];
      if (!ok) {
        var fresh = E.Wallet.createRandom();
        lsSet(sessionStoreKey(), fresh.privateKey);
        if (lsGet(sessionStoreKey()) !== fresh.privateKey) throw new Error('This browser keeps no local storage; one-click needs it.');
        loadSessionKey();
      }
      expiry = Math.floor(chainNow()) + Math.min(days * 86400, SESSION_MAX_S - 600);
      cap6 = numToUsd6(capUsd);
      referrer = referrerArg();
      return read.router.authorizationDigest(a, sess.key.address, expiry, cap6, referrer);
    }).then(function (digest) {
      return sess.key.signMessage(E.getBytes(digest));
    }).then(function (keySig) {
      return sendTx('One-click', router.authorize, [sess.key.address, expiry, cap6, referrer, keySig, { value: E.parseEther(SESSION_GAS_HYPE) }]);
    }).then(function (rc) {
      toast('One-click on: up to ' + fmtUsd(capUsd) + ' a trade, ' + days + (days === 1 ? ' day.' : ' days.'), 'ok', txLink(rc.hash));
      closeDialog('sessionModal');
      return refreshSession();
    }).catch(function (e) {
      toast('One-click failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* revoke() from the wallet when the router holds a session, then the key's leftover HYPE back
     to the wallet (signed by the key), then the key leaves localStorage. */
  function submitRevoke() {
    if (DEMO) { toast('Demo: nothing is sent.'); return Promise.resolve(); }
    if (!wallet.account || !read.router) return Promise.resolve();
    var a = wallet.account;
    setBusy(true);
    var p = Promise.resolve();
    if (sess.onchain) {
      p = Promise.resolve().then(function () {
        requireSigner();
        var router = new window.ethers.Contract(read.router.target, ROUTER_ABI, wallet.signer);
        return sendTx('Revoke', router.revoke, []);
      }).then(function (rc) { toast('One-click off.', 'ok', txLink(rc.hash)); });
    }
    return p.then(function () { return returnSessionGas(a); }).then(function () {
      if (wallet.account === a) dropSessionKey();
      return refreshSession();
    }).catch(function (e) {
      toast('Revoke failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* What is left of the key's HYPE, less a 21,000-gas transfer at twice the fee, back to `to`. */
  function returnSessionGas(to) {
    loadSessionKey();
    var key = sess.key;
    if (!key) return Promise.resolve();
    return Promise.all([read.provider.getBalance(key.address), read.provider.getFeeData()]).then(function (r) {
      var bal = BigInt(r[0]), fee = r[1];
      var eip1559 = fee.maxFeePerGas != null;
      var price = (eip1559 ? fee.maxFeePerGas : fee.gasPrice) * 2n;
      var cost = 21000n * price;
      if (bal <= cost) return null;
      var tx = { to: to, value: bal - cost, gasLimit: 21000n };
      if (eip1559) { tx.maxFeePerGas = price; tx.maxPriorityFeePerGas = fee.maxPriorityFeePerGas || 0n; } else tx.gasPrice = price;
      return key.sendTransaction(tx).then(function (t) { return t.wait(); }).then(function (rc) {
        toast('Returned ' + fmtHype(bal - cost) + ' HYPE from the session key.', 'ok', txLink(rc.hash));
      });
    });
  }

  /* The session key carries a trading call when the session is live and the call is one it may
     make: requestOpen within the per-trade cap whose referrer the session already holds (the
     router passes the session's stored referrer, and the first fill locks it for good; once the
     account's referrer is locked any stored one is ignored), requestClose and the two cancels
     through the router, and the two fallback fills straight on the exchange (anyone may fill
     after the keeper window). An open whose non-zero referrer differs from the session's (not
     yet locked) goes to the wallet. */
  function sessionCarries(kind, args) {
    if (!sessionLive() || house.usdcBad) return false;
    if (kind === 'requestOpen') return sessionRefOk(args[4]) && BigInt(args[2]) <= sess.onchain.cap6;
    return true;
  }

  /* The session may file an open with `referrer` (the one the page would pass): fine unless the
     page has a non-zero referrer that differs from the session's stored one and the account's
     referrer is not locked yet. A zero `referrer` defers to the stored one: the wallet signed it
     into the session, and it outranks "no ref in this page load". */
  function sessionRefOk(referrer) {
    var s = sess.onchain;
    if (!s) return false;
    if (ref.locked === true || referrer === ZERO) return true;
    return String(s.referrer || ZERO).toLowerCase() === String(referrer).toLowerCase();
  }

  function isGasShortfall(err) {
    return walkError(err, function (e) { return e.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(String(e.message || '')); });
  }

  function walletTrade(desc, kind, args) {
    return Promise.resolve().then(function () {
      requireSigner();
      return sendTx(desc, exchangeWrite()[kind], args, true);
    });
  }

  /* Send a trading call (an Exchange function name and its wallet arguments): through the
     session key when it carries the call, else from the wallet. A session the router refuses
     before anything is sent (no session, expired, over the cap) or a key out of gas falls back to
     the wallet once; an on-chain revert never does (the call already ran). Trades send quietly:
     the progress card where the user clicked says what is happening, not a toast. */
  function sendTrade(desc, kind, args) {
    if (DEMO) return demoTx(kind, args);
    if (!sessionCarries(kind, args)) return walletTrade(desc, kind, args);
    var E = window.ethers;
    var target = kind === 'executeOpen' || kind === 'executeClose'
      ? new E.Contract(cfg.contracts.exchange, EXCHANGE_ABI, sess.key)
      : new E.Contract(read.router.target, ROUTER_ABI, sess.key);
    var sargs = kind === 'requestOpen' ? args.slice(0, 4) : args;
    state.viaSession = true; renderAction(); updateCards();
    return sendTx(desc, target[kind], sargs, true).catch(function (e) {
      if (!SESSION_ERRORS[revertName(e)] && !isGasShortfall(e)) throw e;
      state.viaSession = false; renderAction(); updateCards();
      return refreshSession().then(function () { return walletTrade(desc, kind, args); });
    });
  }

  /* A trading action may start: a live session, or a wallet that can sign. */
  function tradeReady() {
    if (DEMO) return true;
    if (sessionLive() && !house.usdcBad && hasExchange()) return true;
    try { requireSigner(); return true; } catch (e) { toast(e.message, 'err'); return false; }
  }

  /* Step one of an open: file the request. OPEN POSITION turns into the progress card at once
     (Confirm in your wallet, then Sent and the countdown to the fill), never back to the button
     in between; the request also shows under Your positions as a card. A keeper fills it a few
     seconds later. busy is released as soon as the request is mined, not after the reads. */
  function submitOpen() {
    var m = state.market;
    if (!tradeReady()) return;
    if (!m || m.instrumentId == null) return;
    var margin = form.margin;
    var margin6 = numToUsd6(margin);
    var isLong = form.side === 'long';
    var lev = form.lev;
    var desc = sideWord(isLong) + ' ' + m.symbol + ' ' + lev + 'x';
    var maxed = form.maxed;
    var released = false;
    function release() { if (!released) { released = true; setBusy(false); } }
    setBusy(true);
    tkSet('wallet', { reqId: null, isLong: isLong, sym: m.symbol, lev: lev, margin: margin });
    sendTrade(desc, 'requestOpen', [m.instrumentId, isLong, margin6, lev, referrerArg()]).then(function (rc) {
      var ev = receiptEvents(rc, 'OpenRequested')[0];
      if (ev) {
        var a = ev.args;
        var id = String(a.requestId);
        trackOpenRequest({
          id: id, instrumentId: Number(a.instrumentId), isLong: !!a.isLong,
          margin: usd6ToNum(a.marginUsdc), leverage: Number(a.leverage), px0: px18ToNum(a.px0),
          requestedAt: null, block: Number(rc.blockNumber), localAt: Date.now()
        });
        tkSet('req', { reqId: id });
        /* the next visit starts from this amount; a Max amount (the whole balance) is not kept,
           so a later all-in trade still goes through Max and its check */
        if (!maxed) lsSet(LS.amount, String(margin));
        tourEvent('submit');
      } else {
        tkSet('error', { msg: 'Sent, but the page could not read the request. Your positions show the result.' });
      }
      release();
      return afterTx();
    }).catch(function (e) {
      tkSet('error', { msg: describeError(e) });
    }).then(release);
  }

  /* The fallback fill (after the keeper window, before expiry): the session key, else the wallet. */
  function executeOpenNow(r) {
    if (!tradeReady()) return;
    var desc = 'Finish ' + reqSym(r) + ' ' + sideWord(r.isLong).toLowerCase();
    setBusy(true);
    r.busy = true; /* the poll leaves it alone while the transaction is out */
    updatePendingLines();
    sendTrade(desc, 'executeOpen', [BigInt(r.id)]).then(function (rc) {
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
      toast('Could not finish your ' + reqSym(r) + ' order: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* Refund of an expired open request: "Get $X back". */
  function cancelOpenNow(r) {
    if (!tradeReady()) return;
    var desc = 'Get ' + fmtUsdShort(r.margin) + ' back';
    setBusy(true);
    r.busy = true;
    updatePendingLines();
    sendTrade(desc, 'cancelOpen', [BigInt(r.id)]).then(function (rc) {
      var mine = tk.phase && tk.reqId === r.id;
      if (mine) tkSet('refunded', { msg: "Didn't fill. Your " + fmtUsdShort(r.margin) + ' is back in your balance.' });
      resultToast(mine ? [$('ticketProgress')] : [], 'Your ' + fmtUsd(r.margin) + ' is back in your balance.', 'ok', txLink(rc.hash));
      untrackOpenRequest(r.id);
      return afterTx();
    }).catch(function (e) {
      r.busy = false;
      toast('Could not get it back yet: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* Step one of a close: file the request. The card's CLOSE POSITION turns into its progress
     (Confirm in your wallet, Closing at the oracle price, Closed); the result card follows. */
  function submitClose(pos) {
    if (state.busy) return Promise.resolve(false);
    if (!tradeReady()) return Promise.resolve(false);
    var pid = String(pos.id);
    if (acct.closeReqs[pid] || ui.closing[pid]) return Promise.resolve(false);
    var desc = 'Close ' + posLabel(pos);
    var released = false;
    function release() { if (!released) { released = true; delete ui.closing[pid]; setBusy(false); renderPositions(); } }
    ui.closing[pid] = true;
    setBusy(true);
    renderPositions();
    return sendTrade(desc, 'requestClose', [pos.id]).then(function (rc) {
      var ev = receiptEvents(rc, 'CloseRequested')[0];
      acct.closeReqs[pid] = {
        requestedAt: chainNow(), px0: ev ? px18ToNum(ev.args.px0) : NaN, block: Number(rc.blockNumber), localAt: Date.now()
      };
      release();
      return afterTx().then(function () { return true; });
    }).catch(function (e) {
      toast('Your ' + posLabel(pos) + ' is still open: ' + describeError(e), 'err');
      return false;
    }).then(function (ok) { release(); return ok; });
  }

  /* The fallback close fill: the session key, else the wallet. */
  function executeCloseNow(pos) {
    if (!tradeReady()) return;
    var desc = 'Finish closing ' + posLabel(pos);
    var cr = acct.closeReqs[String(pos.id)];
    setBusy(true);
    if (cr) cr.busy = true;
    updatePendingLines();
    sendTrade(desc, 'executeClose', [pos.id]).then(function (rc) {
      ui.settling[String(pos.id)] = true;
      reportCloseOutcome(pos.id, rc.logs || [], rc.hash, pos);
      delete acct.closeReqs[String(pos.id)];
      return afterTx();
    }).catch(function (e) {
      if (cr) cr.busy = false;
      var name = revertName(e);
      if (name === 'KeeperWindow' || name === 'TooEarly') { if (cr) cr.prompted = false; return; }
      if (name === 'UnknownRequest') return; /* closed, liquidated or cancelled first: the poll reports it */
      toast('Could not finish closing your ' + posLabel(pos) + ': ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* Drop an expired close request; the position stays open. Resolves true when it was dropped.
     light: only the account is read again before resolving (Try again closes straight after and
     its close runs the full read). */
  function cancelCloseNow(pos, light) {
    if (!tradeReady()) return Promise.resolve(false);
    var desc = 'Clear the close of ' + posLabel(pos);
    var cr = acct.closeReqs[String(pos.id)];
    setBusy(true);
    if (cr) cr.busy = true;
    updatePendingLines();
    return sendTrade(desc, 'cancelClose', [pos.id]).then(function (rc) {
      delete acct.closeReqs[String(pos.id)];
      return (light ? refreshAccount() : afterTx()).then(function () { return true; }, function () { return true; });
    }).catch(function (e) {
      if (cr) cr.busy = false;
      toast('Could not clear the old close yet: ' + describeError(e), 'err');
      return false;
    }).then(function (ok) { setBusy(false); return ok; });
  }

  /* "Close didn't go through. [Try again]": clear the expired request, then close again. The card
     says so the whole time ("Clearing the old request, then closing again…"), then follows the new
     close; nothing flashes back to an idle button in between. */
  function retryClose(pos) {
    var pid = String(pos.id);
    if (ui.retrying[pid] || state.busy) return;
    ui.retrying[pid] = true;
    renderPositions();
    cancelCloseNow(pos, true).then(function (ok) {
      var now = ok ? posById(pid) : null;
      var go = now ? submitClose(now) : Promise.resolve(false);
      delete ui.retrying[pid];
      renderPositions();
      return go.then(function (sent) { if (ok && !sent) return afterTx(); });
    });
  }

  /* Close all, after one check: "Close 3 positions? You get back about $38.40." Then one close
     at a time, in order; the first that does not go through stops the rest. */
  function closeAll() {
    if (state.busy) return;
    var list = acct.positions.filter(function (p) { var k = String(p.id); return !acct.closeReqs[k] && !ui.closing[k] && !ui.settling[k]; });
    if (!list.length) return;
    var back = 0;
    list.forEach(function (p) { var e = positionEstimate(p); if (e && isFinite(e.payout)) back += e.payout; });
    askConfirm({
      title: 'Close ' + list.length + ' position' + (list.length === 1 ? '' : 's') + '?',
      lines: [
        'You get back about ' + fmtUsd(back) + '.',
        'Each one closes at the oracle price in about ' + fillSecs() + ' s.' + (sessionLive() ? '' : ' Your wallet asks once for each.')
      ],
      ok: 'Close all', okClass: 'go-close', back: 'Keep open'
    }).then(function (yes) {
      /* a fill or a refund may have taken the wallet while the check was up */
      if (!yes || state.busy) return;
      (function next(i) {
        if (i >= list.length) return;
        var p = posById(list[i].id);
        if (!p) { next(i + 1); return; }
        submitClose(p).then(function (ok) { if (ok) next(i + 1); else if (i + 1 < list.length) toast('Close all stopped at ' + posLabel(p) + '. The rest are still open.', 'err'); });
      })(0);
    });
  }

  /* ---- pending requests: tracking, watching, outcomes --------------------------- */

  function pendingKey() { return wallet.account && !DEMO ? LS.pending + wallet.account.toLowerCase() : null; }

  function savePendingIds() {
    var k = pendingKey();
    if (k) lsSet(k, JSON.stringify(Object.keys(pend.opens)));
  }

  function trackOpenRequest(r) {
    pend.opens[r.id] = r;
    savePendingIds();
    if (r.requestedAt == null && DEMO) r.requestedAt = chainNow();
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
    if (DEMO) return;
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
    if (DEMO) return Promise.resolve();
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

  /* A request that reads as empty is taken for gone only once the read node has passed the block
     it was mined in, and not in the first seconds after this page filed it: the receipt comes from
     the wallet's RPC, and the read node can be a block or two behind it, when an empty read means
     "not there yet", not "filled". */
  var GONE_AFTER_MS = 4000;
  function readPast(q, latest) {
    if (q.block != null && !(latest > q.block)) return false;
    if (q.localAt && Date.now() - q.localAt < GONE_AFTER_MS) return false;
    return true;
  }

  function tickPending() {
    if (DEMO) { demoTickPending(); return; }
    if (pend.inFlight || !read.exchange || !wallet.account) return;
    var ex = read.exchange;
    var account = wallet.account;
    pend.inFlight = true;
    /* the latest block first, then the requests: an empty read counts only past their block */
    read.provider.getBlock('latest').then(function (b) { noteBlock(b); return b ? Number(b.number) : null; }, function () { return null; }).then(function (latest) {
      if (latest == null) latest = house.block;
      var reads = [];
      pendingOpenList().forEach(function (r) {
        if (r.busy) return;
        reads.push(ex.openRequest(BigInt(r.id)).then(function (q) {
          if (wallet.account !== account || !pend.opens[r.id] || r.busy) return;
          if (q && q.trader !== ZERO) { r.requestedAt = Number(q.requestedAt); return; }
          if (!readPast(r, latest)) return;
          /* gone: filled or refunded by the keeper (or anyone). Say which. */
          delete pend.opens[r.id];
          savePendingIds();
          return resolveOpenOutcome(r, 0);
        }).catch(function () {}));
      });
      Object.keys(acct.closeReqs).forEach(function (pid) {
        var cr = acct.closeReqs[pid];
        if (cr.busy) return;
        reads.push(ex.closeRequest(BigInt(pid)).then(function (q) {
          if (wallet.account !== account || acct.closeReqs[pid] !== cr || cr.busy) return;
          if (q && Number(q.requestedAt) > 0) { cr.requestedAt = Number(q.requestedAt); return; }
          if (!readPast(cr, latest)) return;
          /* gone from chain: the card says "Checking the result…" until the logs say how it ended
             (settling, "Adding it to your balance…", only once they say it closed) */
          ui.checking[pid] = posById(pid) || true;
          delete acct.closeReqs[pid];
          return resolveCloseOutcome(pid, cr, 0);
        }).catch(function () {}));
      });
      return Promise.all(reads);
    }).then(function () {
      pend.inFlight = false;
      if (wallet.account === account) { renderPositions(); updatePendingLines(); }
    }, function () { pend.inFlight = false; });
  }

  function topicId(x) { return window.ethers.toBeHex(BigInt(x), 32); }

  function parsedLogs(logs) {
    var out = [];
    (logs || []).forEach(function (log) {
      try {
        var p = exIface.parseLog({ topics: Array.from(log.topics), data: log.data });
        if (p) out.push({ name: p.name, args: p.args, tx: log.transactionHash, block: log.blockNumber != null ? Number(log.blockNumber) : null });
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
      /* the logs never answered: the card says so where the button was (not a silent reset) */
      if (tk.phase && tk.reqId === r.id) tkSet('unknown', { msg: 'No longer pending. Your positions and History show how it went.' });
      else toast('Your ' + reqSym(r) + ' order is no longer pending. Your positions and History show how it went.', null);
    }).then(function () { return afterTx(); });
  }

  /* An open request's end: a fill (the ticket's card says "Open at", the position's card
     appears) or a refund (the card says why and that the money is back). */
  function reportOpenOutcome(r, logs, txHash) {
    var sym = reqSym(r);
    var sz = szOf(sym);
    var hits = parsedLogs(logs);
    var opened = hits.filter(function (p) { return p.name === 'PositionOpened' && String(p.args.requestId) === r.id; })[0];
    var refunded = hits.filter(function (p) { return p.name === 'OpenRequestCancelled' && String(p.args.requestId) === r.id; })[0];
    var link = txHash ? txLink(txHash) : null;
    var mine = !!tk.phase && tk.reqId === r.id;
    var shows = mine ? [$('ticketProgress'), $('barStatus')] : [];
    if (opened) {
      var entry = px18ToNum(opened.args.entryPx18);
      if (mine) tkSet('opened', { entry: entry, posId: String(opened.args.positionId) });
      resultToast(shows, 'Opened ' + sideWord(r.isLong) + ' ' + sym + ' ' + r.leverage + 'x at ' + fmtPrice(entry, sz) + '.', 'ok', link);
      tourEvent('opened');
    } else if (refunded) {
      var why = refundWhy(refunded.args.reason, sym, r.isLong);
      if (mine) tkSet('refunded', { msg: "Didn't open: " + why + '. Your ' + fmtUsdShort(r.margin) + ' is back in your balance.' });
      resultToast(shows, "Didn't open: " + why + '. ' + fmtUsd(r.margin) + ' is back in your balance.', 'err', link);
    } else {
      toast('Your ' + sym + ' order is done.', null, link);
      if (tk.reqId === r.id) tkReset();
    }
  }

  /* Why a request was refunded, said about this coin and side. */
  function refundWhy(selector, sym, isLong) {
    var name = null;
    try { var f = exIface && exIface.getError(selector); if (f) name = f.name; } catch (e) { /* unknown selector */ }
    if (name === 'OiCapExceeded') return sym + ' ' + (isLong ? 'longs' : 'shorts') + ' are full right now';
    return reasonText(selector);
  }

  /* What happened to a close request that disappeared: the position closed, was liquidated,
     or the request was cancelled after expiry (the position stays). */
  function resolveCloseOutcome(pid, cr, attempt) {
    var prov = read.logProvider;
    var from = cr && cr.block != null ? cr.block : Math.max(0, (house.block || 0) - PENDING_SCAN_BLOCKS);
    var t = function (n) { return exIface.getEvent(n).topicHash; };
    var pos = posById(pid);
    return prov.getLogs({
      address: cfg.contracts.exchange, fromBlock: from, toBlock: 'latest',
      topics: [[t('PositionClosed'), t('PositionLiquidated'), t('CloseRequestCancelled')], topicId(pid)]
    }).then(function (logs) {
      var hits = parsedLogs(logs);
      if (!hits.length) throw new Error('not yet');
      reportCloseOutcome(pid, logs, hits[hits.length - 1].tx, pos);
    }).catch(function () {
      if (attempt + 1 < OUTCOME_TRIES) return new Promise(function (ok) { setTimeout(ok, PENDING_POLL_MS); }).then(function () { return resolveCloseOutcome(pid, cr, attempt + 1); });
      /* the logs never answered: the next account read shows where the position stands */
      delete ui.checking[String(pid)];
      delete ui.settling[String(pid)];
      renderPositions();
      if (!ui.reported[String(pid)]) toast('Your close request is no longer pending. Your positions and History show the result.', null);
    }).then(function () { return afterTx(); });
  }

  /* A close's end, as a card where the position was (and a toast): closed (P&L, what came back,
     anything owed, FETTI, Withdraw and Share), liquidated (stays until OK), or a close that did
     not go through (the position stays open). pos: the position as last read, when known. */
  function reportCloseOutcome(pid, logs, txHash, pos) {
    pid = String(pid);
    pos = pos || posById(pid);
    var hits = parsedLogs(logs).filter(function (p) { return String(p.args.positionId) === pid; });
    var closed = hits.filter(function (p) { return p.name === 'PositionClosed'; })[0];
    var liq = hits.filter(function (p) { return p.name === 'PositionLiquidated'; })[0];
    var cancelled = hits.filter(function (p) { return p.name === 'CloseRequestCancelled'; })[0];
    var link = txHash ? txLink(txHash) : null;
    var label = pos ? posLabel(pos) : 'position';
    var m = pos ? positionMarket(pos) : null;
    var sz = m ? m.szDecimals : null;
    /* reported once: the poll, the account read, the vanished lookup and a fill's own receipt
       can each get here; the second report stays quiet */
    var again = ui.reported[pid] === true && (closed || liq);
    delete ui.checking[pid];
    if (again) { renderPositions(); return; }
    if (closed || liq) ui.reported[pid] = true;
    if (closed) {
      ui.settling[pid] = true;
      var a = closed.args;
      var pnl = usd6ToNum(a.pnlUsdc);
      var paid = usd6ToNum(a.payoutUsdc);
      var exit = fmtPrice(px18ToNum(a.exitPx18), sz);
      var lines = ['Closed at ' + exit + ' · ' + fmtUsd(pnl, true) + ' · ' + fmtUsd(paid) + ' is back in your balance'];
      if (a.queuedUsdc > 0n) lines.push(fmtUsd(usd6ToNum(a.queuedUsdc)) + ' more is owed to you, paid automatically.');
      if (a.confettiMinted > 0n) lines.push('You got ' + fmtInt(tokenToNum(a.confettiMinted)) + ' FETTI' + (pnl < 0 ? ' for the loss.' : '.'));
      var win = pnl > 0 && !!window.ConfettiShare;
      var openShare = function () { window.ConfettiShare.open(shareTrade(pid, a, closed.block, pos)); };
      var buttons = [{ label: 'Withdraw', act: 'withdraw', fn: function () { tourEvent('withdraw'); openWithdraw(); } }];
      if (win) buttons.push({ label: 'Share', fn: openShare });
      addRecent({ key: 'c' + pid, pid: pid, cls: pnl >= 0 ? 'is-win' : 'is-loss', title: 'Closed ' + label, lines: lines, buttons: buttons, ttl: 60000 });
      /* the result card says all of it (with Share); a toast only when that card is out of sight */
      var tst = resultToast([recentEl('c' + pid)], 'Closed ' + label + ': ' + fmtUsd(pnl, true) + '. ' + fmtUsd(paid) + ' is back in your balance.', pnl >= 0 ? 'ok' : 'err', link, win ? 30000 : null);
      if (win && tst) {
        var share = el('button', 'btn btn-sm', 'Share your win');
        share.type = 'button';
        share.addEventListener('click', function (ev) {
          ev.stopPropagation();
          dismissToast(tst);
          openShare();
        });
        tst.appendChild(document.createTextNode(' '));
        tst.appendChild(share);
      }
      tourEvent('closed');
    } else if (liq) {
      var lost = usd6ToNum(liq.args.marginUsdc);
      var llines = ['Your ' + label + ' was liquidated at ' + fmtPrice(px18ToNum(liq.args.exitPx18), sz) + '. Your ' + fmtUsdShort(lost) + ' is gone.'];
      if (liq.args.confettiMinted > 0n) llines.push('You got ' + fmtInt(tokenToNum(liq.args.confettiMinted)) + ' FETTI for the loss.');
      addRecent({ key: 'l' + pid, pid: pid, cls: 'is-loss', title: 'Liquidated', lines: llines });
      resultToast([recentEl('l' + pid)], 'Your ' + label + ' was liquidated. Your ' + fmtUsdShort(lost) + ' is gone.', 'err', link);
    } else if (cancelled) {
      delete ui.settling[pid];
      toast('Your ' + label + " close didn't go through (" + reasonText(cancelled.args.reason) + '). The position is still open.', 'err', link);
    } else {
      toast('Your ' + label + ' close is done.', null, link);
    }
    renderPositions();
  }

  /* A result card on the page, by its key. */
  function recentEl(key) {
    var host = $('posLines');
    return host ? host.querySelector('[data-recent="' + key + '"]') : null;
  }

  /* ---- share a winning close (share.js) ----------------------------------------------------------- */

  /* A block's timestamp; one retry (the public RPC rate-limits), then null: the card goes without its chart */
  function blockTime(block) {
    if (DEMO || block == null) return Promise.resolve(Math.floor(Date.now() / 1000));
    if (hist.blockTs[block]) return Promise.resolve(hist.blockTs[block]);
    function get() {
      return read.provider.getBlock(block).then(function (b) {
        if (!b) throw new Error('block ' + block + ' not found');
        hist.blockTs[block] = Number(b.timestamp);
        return hist.blockTs[block];
      });
    }
    return get().catch(function () {
      return new Promise(function (ok) { setTimeout(ok, 1500); }).then(get);
    }).catch(function () { return null; });
  }

  /* PositionOpened of pid: from the loaded history, else the logs up to the close (one query, then chunks back) */
  function openedLog(pid, toBlock) {
    var row = hist.rows.filter(function (r) { return r.name === 'PositionOpened' && String(r.args.positionId) === pid; })[0];
    if (row) return Promise.resolve({ args: row.args, block: row.block });
    var prov = read.logProvider;
    var deploy = Math.max(0, Number(cfg.deployBlock) || 0);
    var chunk = Math.max(1000, Number(cfg.logChunkBlocks) || 20000);
    var n = Math.max(1, Number(cfg.logChunksPerLoad) || 10);
    var topics = [exIface.getEvent('PositionOpened').topicHash, topicId(pid)];
    function first(logs) { var p = parsedLogs(logs)[0]; return p ? { args: p.args, block: p.block } : null; }
    function back(top, i) {
      if (top < deploy || i >= n) return Promise.reject(new Error('Open of #' + pid + ' not found.'));
      var from = Math.max(deploy, top - chunk + 1);
      return prov.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: top, topics: topics }).then(function (logs) {
        return first(logs) || back(from - 1, i + 1);
      });
    }
    var top = toBlock != null ? toBlock : 'latest';
    return prov.getLogs({ address: cfg.contracts.exchange, fromBlock: deploy, toBlock: top, topics: topics }).then(function (logs) {
      var o = first(logs);
      if (!o) throw new Error('Open of #' + pid + ' not found.');
      return o;
    }, function () {
      return (toBlock != null ? Promise.resolve(toBlock) : prov.getBlockNumber().then(Number)).then(function (b) { return back(b, 0); });
    });
  }

  /* What the card needs for one winning close: a = PositionClosed args, closeBlock its block,
     pos the position as last read (or null: the open comes from its PositionOpened log). */
  function shareTrade(pid, a, closeBlock, pos) {
    pid = String(pid);
    var open = pos
      ? Promise.resolve({ instrumentId: pos.instrumentId, isLong: pos.isLong, margin: pos.margin, leverage: pos.leverage, entry: pos.entry, ts: pos.openedAt })
      : openedLog(pid, closeBlock).then(function (o) {
        return blockTime(o.block).then(function (ts) {
          return { instrumentId: Number(o.args.instrumentId), isLong: !!o.args.isLong, margin: usd6ToNum(o.args.marginUsdc), leverage: Number(o.args.leverage), entry: px18ToNum(o.args.entryPx18), ts: ts };
        });
      });
    return Promise.all([open, blockTime(closeBlock)]).then(function (r) {
      var o = r[0];
      var inst = state.byInstId[o.instrumentId];
      var m = inst && inst.market;
      return {
        id: pid, sym: m ? m.symbol : '#' + o.instrumentId, coin: m ? m.coin : null, szDecimals: m ? m.szDecimals : null,
        side: o.isLong ? 'long' : 'short', lev: o.leverage, margin: o.margin, entry: o.entry,
        exit: px18ToNum(a.exitPx18), pnl: usd6ToNum(a.pnlUsdc), openTs: o.ts, closeTs: r[1],
        account: wallet.account, code: ref.myCode || ''
      };
    });
  }

  /* Add USDC from this wallet: approve the exact amount when the allowance is short (step 1 of
     2), then deposit (step 2 of 2). The dialog's button names the step it is on. */
  var dep = { step: null, two: false, amount: 0 };

  function submitDeposit(amount) {
    if (DEMO) return demoDeposit(amount);
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(); }
    if (!isAddr(usdcAddress())) { toast('USDC address unknown.', 'err'); return Promise.resolve(); }
    var amount6 = numToUsd6(amount);
    var usdc = usdcWrite();
    var ex = exchangeWrite();
    var spender = cfg.contracts.exchange;
    dep.amount = amount; dep.two = false; dep.step = null;
    setBusy(true);
    return usdc.allowance(wallet.account, spender).then(function (allowance) {
      if (allowance >= amount6) return null;
      dep.two = true; dep.step = 'approve'; renderDepositSubmit();
      return sendTx('Approve USDC (1 of 2)', usdc.approve, [spender, amount6]);
    }).then(function () {
      dep.step = 'deposit'; renderDepositSubmit();
      return sendTx('Deposit ' + fmtUsd(amount) + (dep.two ? ' (2 of 2)' : ''), ex.deposit, [amount6]);
    }).then(function (rc) {
      toast('Deposited ' + fmtUsd(amount) + '. Pick BUY / LONG or SELL / SHORT.', 'ok', txLink(rc.hash));
      closeDialog('depositModal');
      return afterTx();
    }).catch(function (e) {
      toast('Deposit didn\'t go through: ' + describeError(e), 'err');
    }).then(function () { dep.step = null; setBusy(false); });
  }

  function submitWithdraw(amount) {
    if (DEMO) return demoWithdraw(amount);
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(); }
    var amount6 = numToUsd6(amount);
    var ex = exchangeWrite();
    setBusy(true);
    return sendTx('Withdraw ' + fmtUsd(amount), ex.withdraw, [amount6]).then(function (rc) {
      toast('Sent ' + fmtUsd(amount) + ' to your wallet.', 'ok', txLink(rc.hash));
      closeDialog('withdrawModal');
      return afterTx();
    }).catch(function (e) {
      toast('Withdraw didn\'t go through: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* ---- deposit from Hyperliquid (DepositProxyFactory) -------------------------------------
     The trader's proxy address is factory.proxyOf(trader), fixed before the proxy exists. USDC
     sent to it on Hyperliquid is bridged and deposited by sweep (anyone; the keeper sweeps too):
     spot -> HyperEVM in one sweep, the deposit in the next, perp first moves to spot. */

  function sweepStoreKey() { return wallet.account ? LS.sweep + wallet.account.toLowerCase() : null; }

  function lastSweep() {
    var k = sweepStoreKey();
    try { return k ? JSON.parse(lsGet(k) || 'null') : null; } catch (e) { return null; }
  }

  /* What one sweep did, from its return values or its Swept event: USDC deposited (6 dec), Core
     spot USDC sent to HyperEVM and Core perp USDC moved to spot (both 8 dec). */
  function sweepText(s) {
    var parts = [];
    if (s.dep > 0) parts.push(fmtUsd(s.dep / 1e6) + ' added to your balance');
    if (s.bridged > 0) parts.push(fmtUsd(s.bridged / 1e8) + ' on its way from Hyperliquid');
    if (s.perp > 0) parts.push(fmtUsd(s.perp / 1e8) + ' moved from perp to spot');
    return parts.length ? parts.join(' · ') : 'nothing to move yet';
  }

  /* The proxy and what waits on it: Core spot (precompile 0x801, total - hold), Core perp
     withdrawable (0x803) and HyperEVM USDC on the proxy. A read that fails leaves its field null. */
  function refreshProxy() {
    if (DEMO) { renderDepositModal(); return Promise.resolve(); }
    var a = wallet.account;
    if (!read.factory || !a) { hl.account = null; hl.proxy = null; renderDepositModal(); return Promise.resolve(); }
    var E = window.ethers;
    var coder = E.AbiCoder.defaultAbiCoder();
    var none = function () { return null; };
    var addr = hl.account === a && hl.proxy ? Promise.resolve(hl.proxy) : read.factory.proxyOf(a);
    return addr.then(function (proxy) {
      if (wallet.account !== a) return;
      if (hl.account !== a) { hl.spotFreeWei = null; hl.perp6 = null; hl.evm6 = null; }
      hl.account = a; hl.proxy = proxy;
      return Promise.all([
        read.provider.call({ to: SPOT_BALANCE_PRECOMPILE, data: coder.encode(['address', 'uint64'], [proxy, 0]) }).catch(none),
        read.provider.call({ to: WITHDRAWABLE_PRECOMPILE, data: coder.encode(['address'], [proxy]) }).catch(none),
        new E.Contract(USDC, ERC20_ABI, read.provider).balanceOf(proxy).catch(none)
      ]).then(function (r) {
        if (wallet.account !== a) return;
        var spot = typeof r[0] === 'string' && r[0].length === 2 + 192 ? coder.decode(['uint64', 'uint64', 'uint64'], r[0]) : null;
        var perp = typeof r[1] === 'string' && r[1].length === 2 + 64 ? coder.decode(['uint64'], r[1]) : null;
        hl.spotFreeWei = spot ? (BigInt(spot[0]) > BigInt(spot[1]) ? BigInt(spot[0]) - BigInt(spot[1]) : 0n) : null;
        hl.perp6 = perp ? BigInt(perp[0]) : null;
        hl.evm6 = r[2] == null ? null : BigInt(r[2]);
      });
    }).catch(function () { /* unreadable: the dialog shows the last sweep */ }).then(renderDepositModal);
  }

  /* factory.sweep(trader) from the wallet, after an eth_call that says it would move something. */
  function submitSweep() {
    if (DEMO) { toast('Demo: nothing is sent.'); return Promise.resolve(); }
    var a = wallet.account;
    if (!read.factory || !a) return Promise.resolve();
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(); }
    var f = new window.ethers.Contract(read.factory.target, FACTORY_ABI, wallet.signer);
    setBusy(true);
    return f.sweep.staticCall(a).then(function (r) {
      if (BigInt(r[0]) === 0n && BigInt(r[1]) === 0n && BigInt(r[2]) === 0n) { toast('Nothing has arrived from Hyperliquid yet.'); return null; }
      return sendTx('Add to my balance', f.sweep, [a]);
    }).then(function (rc) {
      if (!rc) return null;
      var s = { at: Math.floor(Date.now() / 1000), dep: 0, bridged: 0, perp: 0 };
      (rc.logs || []).forEach(function (log) {
        try {
          var p = proxyIface.parseLog({ topics: Array.from(log.topics), data: log.data });
          if (p && p.name === 'Swept') { s.dep = Number(p.args.depositedUsdc); s.bridged = Number(p.args.bridgedWei); s.perp = Number(p.args.perpToSpotWei); }
        } catch (e) { /* another contract's log */ }
      });
      if (wallet.account === a) lsSet(sweepStoreKey(), JSON.stringify(s));
      var moving = (s.bridged || 0) / 1e8 + (s.perp || 0) / 1e8;
      toast(moving > 0
        ? fmtUsd(moving) + ' is on its way. It finishes by itself, or press Add to my balance again in a few seconds.'
        : sweepText(s) + '.', 'ok', txLink(rc.hash));
      return afterTx();
    }).catch(function (e) {
      toast('Add to my balance did not go through: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); return refreshProxy(); });
  }

  function renderHyperliquid() {
    var addrEl = $('hlProxy');
    if (!addrEl) return;
    var on = !!(read.factory && wallet.account && hl.account === wallet.account && hl.proxy);
    addrEl.textContent = on ? hl.proxy : '—';
    addrEl.title = on ? hl.proxy : '';
    var copy = $('hlCopy'); if (copy) copy.disabled = !on;
    var sweep = $('hlSweep'); if (sweep) sweep.disabled = !on || state.busy;
    var readable = on && (hl.spotFreeWei != null || hl.perp6 != null);
    setText('hlPendingKey', readable || !on ? 'Waiting' : 'Last arrived');
    var val = '—', title = '';
    if (readable) {
      var spot = hl.spotFreeWei != null && hl.spotFreeWei > CORE_FEE_RESERVE_WEI ? hl.spotFreeWei - CORE_FEE_RESERVE_WEI : 0n;
      var perp = hl.perp6 || 0n, evm = hl.evm6 || 0n;
      var total = Number(spot) / 1e8 + Number(perp) / 1e6 + Number(evm) / 1e6;
      var moves = spot >= MIN_BRIDGE_WEI || perp >= MIN_PERP_USD || evm > 0n;
      val = fmtUsd(total) + (total > 0 && !moves ? ' · under 1 USDC waits for more' : '');
      title = 'Hyperliquid spot ' + fmtUsd(Number(spot) / 1e8) + ' · perp ' + fmtUsd(Number(perp) / 1e6) + ' · HyperEVM ' + fmtUsd(Number(evm) / 1e6);
    } else if (on) {
      var s = lastSweep();
      if (s) val = fmtTime(s.at) + ' · ' + sweepText(s);
    }
    setText('hlPending', val);
    var pe = $('hlPending'); if (pe) pe.title = title;
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

  /* Add USDC: where is it (this wallet, or Hyperliquid), then the steps for that place. The HYPE
     line comes first when the wallet has too little for gas. */
  function openDeposit() {
    if (!wallet.account) { connect(); return; }
    if (wallet.chainId !== CHAIN_ID) { toast('Switch your wallet to HyperEVM first.', 'err'); return; }
    if (!hasExchange()) { toast('Trading is off on this copy of the site.', 'err'); return; }
    var hint = $('depositHint');
    if (hint) hint.classList.remove('is-err');
    setDepWhere(acct.walletUsdc >= 1 || !read.factory ? 'wallet' : 'hl');
    renderDepositModal();
    openDialog('depositModal');
    refreshWalletUsdc();
    refreshProxy();
    var inp = $('depositAmount'); if (inp) { inp.value = ''; inp.focus(); }
    renderDepositSubmit();
  }

  function setDepWhere(where) {
    var seg = $('depWhere');
    if (seg) Array.prototype.forEach.call(seg.querySelectorAll('[data-where]'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-where') === where ? 'true' : 'false'); });
    var w = $('depFromWallet'), h = $('depFromHl');
    if (w) w.hidden = where !== 'wallet';
    if (h) h.hidden = where !== 'hl';
  }

  function openWithdraw() {
    if (!wallet.account) { connect(); return; }
    if (wallet.chainId !== CHAIN_ID) { toast('Switch your wallet to HyperEVM first.', 'err'); return; }
    if (!hasExchange()) { toast('Trading is off on this copy of the site.', 'err'); return; }
    var hint = $('withdrawHint');
    if (hint) { hint.classList.remove('is-err'); hint.textContent = 'Withdraw your balance. Money in open trades comes back when you close.'; }
    renderWithdrawModal();
    openDialog('withdrawModal');
    var inp = $('withdrawAmount'); if (inp) { inp.value = ''; inp.focus(); }
    renderWithdrawSubmit();
  }

  function renderDepositModal() {
    setText('depWallet', wallet.account ? fmtUsd(acct.walletUsdc) : '—');
    setText('depAvailable', acct.loaded ? fmtUsd(acct.available) : '—');
    var hype = $('depHype');
    if (hype) hype.hidden = !(wallet.account && ui.hypeWei != null && ui.hypeWei < HYPE_LOW_WEI);
    renderDepositSubmit();
    renderHyperliquid();
  }

  /* The deposit button names its step: Approve USDC (1 of 2) when the allowance is short, then
     Deposit $50 (2 of 2); Deposit $50 when one step is enough. */
  function renderDepositSubmit() {
    var b = $('depositSubmit');
    if (!b) return;
    var inp = $('depositAmount');
    var v = inp ? Number(inp.value) : NaN;
    var amt = dep.step ? dep.amount : v;
    var label;
    if (dep.step === 'approve') label = 'Approve USDC (1 of 2)';
    else if (dep.step === 'deposit') label = 'Deposit ' + fmtUsdShort(amt) + (dep.two ? ' (2 of 2)' : '');
    else if (isFinite(v) && v > 0 && acct.allowance + 1e-9 < v) label = 'Approve USDC (1 of 2)';
    else label = isFinite(v) && v > 0 ? 'Deposit ' + fmtUsdShort(v) : 'Deposit';
    if (b.textContent !== label) b.textContent = label;
    var hint = $('depositHint');
    if (hint && !hint.classList.contains('is-err') && !dep.step) {
      hint.textContent = isFinite(v) && v > 0 && acct.allowance + 1e-9 >= v ? 'One step: deposit.' : 'The first time takes two steps: approve USDC, then deposit it.';
    }
  }

  function renderWithdrawModal() {
    setText('wdTo', wallet.account ? 'To ' + shortAddr(wallet.account) + ' on HyperEVM' : 'To your wallet on HyperEVM');
    setText('wdAvailable', acct.loaded ? fmtUsd(acct.available) : '—');
    setText('wdMargin', acct.loaded ? fmtUsd(acct.marginInUse + acct.pending) : '—');
    renderWithdrawSubmit();
  }

  function renderWithdrawSubmit() {
    var b = $('withdrawSubmit');
    if (!b) return;
    var inp = $('withdrawAmount');
    var v = inp ? Number(inp.value) : NaN;
    b.textContent = isFinite(v) && v > 0 ? 'Withdraw ' + fmtUsd(v) : 'Withdraw';
  }

  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { toast(text); });
    else toast(text);
  }

  function initDialogs() {
    ['depositModal', 'withdrawModal', 'sessionModal', 'confirmModal', 'walletAppModal', 'acctModal'].forEach(function (id) {
      var d = $(id);
      if (!d) return;
      var closers = d.querySelectorAll('[data-close]');
      for (var i = 0; i < closers.length; i++) closers[i].addEventListener('click', function () { closeDialog(id); });
      d.addEventListener('click', function (ev) { if (ev.target === d) closeDialog(id); });
    });
    /* the check: OK resolves true; any other way out (Back, the cross, Esc, outside) false */
    var cf = $('confirmForm'), cm = $('confirmModal');
    if (cf) cf.addEventListener('submit', function (ev) { ev.preventDefault(); if (confirmDone) confirmDone(true); });
    if (cm) cm.addEventListener('close', function () { if (confirmDone) confirmDone(false); });
    var depForm = $('depositForm');
    if (depForm) {
      depForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (state.busy) return;
        var v = Number($('depositAmount').value);
        var hint = $('depositHint');
        if (!isFinite(v) || v <= 0) { hint.textContent = 'Enter an amount.'; hint.classList.add('is-err'); return; }
        if (v > acct.walletUsdc + 1e-9) { hint.textContent = 'More than your wallet has (' + fmtUsd(acct.walletUsdc) + ').'; hint.classList.add('is-err'); return; }
        hint.classList.remove('is-err');
        hint.textContent = acct.allowance >= v ? 'Confirm the deposit in your wallet.' : 'Two steps in your wallet: approve exactly ' + fmtUsd(v) + ', then deposit it.';
        submitDeposit(v);
      });
      $('depMax').addEventListener('click', function () {
        $('depositAmount').value = String(Math.floor(acct.walletUsdc * 100) / 100);
        renderDepositSubmit();
      });
      $('depositAmount').addEventListener('input', function () { $('depositHint').classList.remove('is-err'); renderDepositSubmit(); });
      var where = $('depWhere');
      if (where) where.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-where]') : null;
        if (b) setDepWhere(b.getAttribute('data-where'));
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
        if (v > acct.available + 1e-9) { hint.textContent = 'More than your balance (' + fmtUsd(acct.available) + '). Money in open trades comes back when you close.'; hint.classList.add('is-err'); return; }
        hint.classList.remove('is-err');
        submitWithdraw(v);
      });
      $('wdMax').addEventListener('click', function () {
        $('withdrawAmount').value = String(Math.floor(acct.available * 1e6) / 1e6);
        renderWithdrawSubmit();
      });
      $('withdrawAmount').addEventListener('input', renderWithdrawSubmit);
    }
    var hlSweep = $('hlSweep');
    if (hlSweep) hlSweep.addEventListener('click', function () { if (!state.busy) submitSweep(); });
    var hlCopy = $('hlCopy');
    if (hlCopy) {
      hlCopy.addEventListener('click', function () {
        if (!hl.proxy) return;
        var addr = hl.proxy;
        copyText(addr, function () { toast('Copied your deposit address ' + shortAddr(addr) + '.'); });
      });
    }
    var waCopy = $('waCopy');
    if (waCopy) waCopy.addEventListener('click', function () {
      var link = waCopy.getAttribute('data-link') || SITE_URL + 'trade.html';
      copyText(link, function () { toast('Copied. Paste it into your wallet app\'s browser.'); });
    });
    var amCopy = $('amCopy');
    if (amCopy) amCopy.addEventListener('click', function () {
      if (wallet.account) copyText(wallet.account, function () { toast('Copied ' + shortAddr(wallet.account) + '.'); });
    });
    var amOut = $('amDisconnect');
    if (amOut) amOut.addEventListener('click', function () { closeDialog('acctModal'); disconnect(); });
    var sForm = $('sessionForm');
    if (sForm) {
      sForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (state.busy) return;
        var cap = Number($('sessionCap').value);
        var days = Number($('sessionDays').value) || 7;
        var hint = $('sessionHint');
        if (!isFinite(cap) || cap < MIN_MARGIN) { hint.textContent = 'Cap per trade: at least ' + MIN_MARGIN + ' USDC.'; hint.classList.add('is-err'); return; }
        hint.classList.remove('is-err');
        hint.textContent = '';
        submitAuthorize(cap, days);
      });
    }
    var sBtn = $('sessionBtn');
    if (sBtn) sBtn.addEventListener('click', function () { if (!state.busy) openSession(); });
    var sRevoke = $('sessionRevoke');
    if (sRevoke) sRevoke.addEventListener('click', function () { if (!state.busy) submitRevoke(); });
  }

  /* ---- confetti's own 24h volume: the notional of every position opened on the
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
    if (DEMO) { setText('chipConfVol', '$12,480'); return; }
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
    return { rows: [], seen: {}, openedMarket: {}, openedSide: {}, openedEntry: {}, scannedFrom: null, scannedTo: null, loading: false, done: false, chunked: false, blockTs: {} };
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
        hist.openedEntry[String(p.args.positionId)] = px18ToNum(p.args.entryPx18);
      }
      hist.rows.push({ name: p.name, args: p.args, block: Number(log.blockNumber), index: Number(log.index), tx: log.transactionHash });
    });
    hist.rows.sort(function (a, b) { return b.block - a.block || b.index - a.index; });
  }

  function loadHistory(reset) {
    if (DEMO || !wallet.account || !read.exchange || !read.logProvider) { renderHistory(); return Promise.resolve(); }
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
      toast('Could not load all of your history: ' + describeError(e), 'err');
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

  /* Structured fields for one history line, in plain words, details inline. amount is already
     signed; signed=false shows it plain. A close names its entry and exit when the open is loaded. */
  function describeRow(r) {
    var a = r.args;
    var d = { label: r.name, market: null, id: null, side: null, amount: null, signed: true, details: '' };
    function sym(instId) { var inst = state.byInstId[instId]; return inst && inst.market ? inst.market.symbol : 'Market ' + instId; }
    function pid() { d.id = String(a.positionId); var mi = hist.openedMarket[d.id]; d.market = mi != null ? sym(mi) : null; d.side = hist.openedSide[d.id] || null; }
    function szFor() { var mi = hist.openedMarket[d.id]; var inst = mi != null ? state.byInstId[mi] : null; return inst && inst.market ? inst.market.szDecimals : null; }
    var fetti = function (n) { return n > 0n ? ' · ' + fmtInt(tokenToNum(n)) + ' FETTI' : ''; };
    switch (r.name) {
      case 'Deposited':
        d.label = 'Deposit';
        d.amount = usd6ToNum(a.amountUsdc);
        if (a.payer.toLowerCase() !== wallet.account.toLowerCase()) d.details = 'from ' + shortAddr(a.payer);
        break;
      case 'Withdrawn':
        d.label = 'Withdrawal';
        d.amount = -usd6ToNum(a.amountUsdc);
        break;
      case 'PositionOpened':
        d.label = 'Opened';
        d.id = String(a.positionId);
        d.market = sym(Number(a.instrumentId));
        d.side = sideLev(a.isLong, a.leverage);
        d.amount = usd6ToNum(a.marginUsdc); d.signed = false;
        d.details = 'put in · at ' + fmtPrice(px18ToNum(a.entryPx18), szFor());
        break;
      case 'PositionClosed':
        d.label = 'Closed';
        pid();
        d.amount = usd6ToNum(a.pnlUsdc);
        var en = hist.openedEntry[d.id];
        d.details = (en ? fmtPrice(en, szFor()) + ' → ' : 'at ') + fmtPrice(px18ToNum(a.exitPx18), szFor()) + ' · ' + fmtUsd(usd6ToNum(a.payoutUsdc)) + ' back';
        if (a.feeUsdc > 0n) d.details += ' · fee ' + fmtUsd(usd6ToNum(a.feeUsdc));
        if (a.queuedUsdc > 0n) d.details += ' · ' + fmtUsd(usd6ToNum(a.queuedUsdc)) + ' owed';
        d.details += fetti(a.confettiMinted);
        break;
      case 'PositionLiquidated':
        d.label = 'Liquidated';
        pid();
        d.amount = -usd6ToNum(a.marginUsdc);
        d.details = 'at ' + fmtPrice(px18ToNum(a.exitPx18), szFor()) + fetti(a.confettiMinted);
        break;
      case 'QueueAppended':
        d.label = 'Win owed';
        d.amount = usd6ToNum(a.amountUsdc); d.signed = false;
        d.details = 'paid automatically';
        break;
      case 'QueuePaid':
        d.label = 'Owed win paid';
        d.amount = usd6ToNum(a.paidUsdc);
        if (a.remainingUsdc > 0n) d.details = fmtUsd(usd6ToNum(a.remainingUsdc)) + ' still owed';
        break;
      case 'OpenRequestCancelled':
        d.label = 'Refunded';
        d.id = 'r' + String(a.requestId);
        d.details = "didn't open: " + reasonText(a.reason);
        break;
    }
    return d;
  }

  function blockTitle(block) {
    var ts = hist.blockTs[block];
    return (ts ? fmtTime(ts) + ' · ' : '') + 'block ' + fmtInt(block);
  }

  /* One line per event, wrapping on a phone: time, what, coin, side and leverage, amount,
     details, view (the transaction). Ids stay in the hover text. */
  function historyLine(r) {
    var d = describeRow(r);
    var line = el('div', 'pos-line hist-line');
    if (d.id) line.title = (d.id.charAt(0) === 'r' ? 'Request #' : 'Position #') + d.id.replace(/^r/, '');
    var time = el('span', 'faint', fmtClock(hist.blockTs[r.block]));
    time.setAttribute('data-block', String(r.block));
    time.title = blockTitle(r.block);
    line.appendChild(time);
    line.appendChild(el('span', 'hist-what', d.label));
    if (d.market) line.appendChild(el('span', 'sym', d.market));
    if (d.side) line.appendChild(el('span', /^Long/.test(d.side) ? 'pos' : 'neg', d.side));
    if (d.amount != null) {
      var cls = d.signed ? (d.amount > 0 ? 'pos' : d.amount < 0 ? 'neg' : '') : '';
      line.appendChild(el('span', cls || null, fmtUsd(d.amount, d.signed)));
    }
    if (d.details) line.appendChild(el('span', 'faint hist-detail', d.details));
    if (r.name === 'PositionClosed' && d.amount > 0 && window.ConfettiShare) {
      var share = el('a', 'faint', 'share');
      share.href = '#'; share.setAttribute('role', 'button'); share.title = 'Share your win';
      share.addEventListener('click', function (ev) {
        ev.preventDefault();
        window.ConfettiShare.open(shareTrade(r.args.positionId, r.args, r.block, null));
      });
      line.appendChild(share);
    }
    line.appendChild(el('span', 'grow'));
    if (r.tx && !DEMO) {
      var a = el('a', 'faint', 'view');
      a.href = explorer('tx', r.tx); a.target = '_blank'; a.rel = 'noopener'; a.title = r.tx;
      line.appendChild(a);
    }
    return line;
  }

  function renderHistory() {
    var host = $('histLines');
    var empty = $('histEmpty');
    var more = $('histMoreBtn');
    if (!host) return;
    clearLines(host);
    if (!wallet.account) { empty.textContent = 'Connect a wallet to see your history.'; empty.removeAttribute('hidden'); }
    else if (!hasExchange()) { empty.textContent = 'Trading is off on this copy of the site.'; empty.removeAttribute('hidden'); }
    else if (!hist.rows.length) { empty.textContent = hist.loading ? 'Loading your history…' : 'No trades yet.'; empty.removeAttribute('hidden'); }
    else empty.setAttribute('hidden', '');

    var foot = host.querySelector('.hist-foot');
    var frag = document.createDocumentFragment();
    hist.rows.forEach(function (r) { frag.appendChild(historyLine(r)); });
    if (foot) host.insertBefore(frag, foot); else host.appendChild(frag);

    if (more) {
      more.disabled = hist.loading || hist.done || !wallet.account || !hasExchange();
      more.textContent = hist.loading ? 'Loading…' : (hist.done ? 'All loaded' : 'Load older');
      more.hidden = hist.done && !hist.loading;
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
    renderV2Link();

    setText('stPaused', read.exchange ? (house.globalPaused || house.breakerTripped ? 'yes' : 'no') : '—');
    setText('stBreaker', read.exchange ? (house.breakerTripped ? 'tripped · opens paused' : house.breakerBps != null && house.breakerBps >= 10000 ? 'off' : 'armed') : '—');
    setText('stFee', read.exchange && house.feeRate != null ? feePctText() : '—');
    setText('stStakerShare', read.exchange && house.stakerShareBps != null ? (house.stakerShareBps / 100).toFixed(0) + '%' : '—');
    setText('stRefShare', read.exchange && house.referralShareBps != null ? (house.referralShareBps / 100).toFixed(0) + '%' : '—');
    setText('stInstCount', house.instCount != null ? String(house.instCount) : '—');
    var kc = $('stKeeper');
    if (kc) {
      var kv = keeper ? keeper.view() : { text: '—', offline: false, title: '' };
      kc.textContent = kv.text; kc.title = kv.title;
      kc.className = 'kv-val' + (kv.offline ? ' neg' : '');
    }

    addrCell('stExchange', cfg.contracts && cfg.contracts.exchange);
    addrCell('stUsdc', usdcAddress());
    addrCell('stOracle', house.addrs.oracle || (cfg.contracts && cfg.contracts.oracle));
    addrCell('stConfetti', house.addrs.confetti || (cfg.contracts && cfg.contracts.confetti));
    addrCell('stTokenomics', house.addrs.tokenomics || (cfg.contracts && cfg.contracts.tokenomics));
    addrCell('stStaking', house.addrs.staking || (cfg.contracts && cfg.contracts.staking));
    addrCell('stReferrals', house.addrs.referrals || (cfg.contracts && cfg.contracts.referrals));
    addrCell('stOwner', house.addrs.owner);
    addrCell('stFeeRecipient', house.addrs.feeRecipient);
    /* v3 only: a dash on an exchange without them */
    [['stRouter', house.addrs.sessionRouter], ['stRules', house.addrs.marketRules], ['stFactory', read.factory && read.factory.target]].forEach(function (c) {
      if (read.exchange && isAddr(c[1])) addrCell(c[0], c[1]); else setText(c[0], '—');
    });

    var m = state.market;
    var inst = m && m.inst;
    if (inst) {
      setText('stInst', '#' + inst.id + ' · HL ' + inst.hlAssetIndex + ' · sz ' + inst.szDecimals + ' · tier ' + tierLetter(m) + (inst.retired ? ' · retired' : inst.opensPaused ? ' · paused' : ''));
      setText('stMaxLev', inst.maxLeverage + 'x');
      setText('stCaps', fmtUsdCompact(inst.longCap) + ' / ' + fmtUsdCompact(inst.shortCap));
      setText('stPosCap', fmtUsdCompact(inst.maxNotional) + ' · ' + inst.payoutCapX + 'x');
      var opx = house.oraclePxById[inst.id];
      setText('stOraclePx', inst.retired ? fmtPrice(inst.frozenPx, m.szDecimals) + ' (frozen)' : (opx != null ? fmtPrice(opx, m.szDecimals) : '—'));
    } else {
      setText('stInst', m ? (hasExchange() ? (state.instrumentsLoaded ? 'not on chain yet' : 'loading…') : 'HL ' + m.hlAssetIndex + ' · tier ' + m.tier) : '—');
      setText('stMaxLev', m && !hasExchange() ? maxLev(m) + 'x' : '—');
      setText('stCaps', '—'); setText('stPosCap', '—'); setText('stOraclePx', '—');
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
    if (DEMO) { renderRefer(); return Promise.resolve(); }
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
    if (DEMO) { toast('Demo: nothing is sent.'); return Promise.resolve(); }
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(); }
    var addr = house.unpinned.referrals ? null : cfg.contracts.referrals;
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
    /* Your positions is its own panel now (always in view); the tabs are History and Refer */
    var saved = lsGet(LS.tab);
    show(saved === 'refer' ? 'refer' : 'history');
    var more = $('histMoreBtn');
    if (more) more.addEventListener('click', function () { loadHistory(false); });
    var closeAllBtn = $('closeAllBtn');
    if (closeAllBtn) closeAllBtn.addEventListener('click', closeAll);
    /* the old Status tab: Contracts & status, a closed box under the page, opened from the footer */
    var link = $('statusLink'), box = $('statusBox');
    if (link && box) link.addEventListener('click', function (ev) {
      ev.preventDefault();
      box.open = true;
      renderStatus();
      if (box.scrollIntoView) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
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
    request: function (payload) {
      var eth = wallet.eth || getInjected();
      return eth ? eth.request(payload) : Promise.reject(new Error('No wallet in this browser.'));
    }
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
    $('connectBtn').addEventListener('click', function () {
      if (DEMO) { toast('Demo account: nothing here is real and nothing is sent.'); return; }
      if (wallet.account) openAccountMenu(); else connect();
    });
    $('depositBtn').addEventListener('click', openDeposit);
    $('withdrawBtn').addEventListener('click', function () { tourEvent('withdraw'); openWithdraw(); });
    var ad = $('acctDeposit');
    if (ad) ad.addEventListener('click', openDeposit);
    var aw = $('acctWithdraw');
    if (aw) aw.addEventListener('click', function () { tourEvent('withdraw'); openWithdraw(); });
    var mini = $('acctMini');
    if (mini) {
      var md = mini.querySelector('.js-dep'), mw = mini.querySelector('.js-wd');
      if (md) md.addEventListener('click', openDeposit);
      if (mw) mw.addEventListener('click', function () { tourEvent('withdraw'); openWithdraw(); });
    }
    /* phones: the nav folds into Menu */
    var nt = $('navToggle'), hd = $('siteHeader');
    if (nt && hd) nt.addEventListener('click', function () {
      var open = !hd.classList.contains('nav-open');
      hd.classList.toggle('nav-open', open);
      nt.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    var tb = $('tourBtn');
    if (tb) tb.addEventListener('click', function () { startTour(0); });
  }

  /* ---- the first-trade tour -----------------------------------------------------------------
     Coach marks on the real buttons, shown once per wallet (LS.tour) and replayable from "? How to
     trade". A visitor gets steps 1-6 and the tour waits at OPEN POSITION for a wallet; it picks up
     there when one connects. Each step rings one element and moves on when the user uses
     it (or presses Next). Esc skips, Enter is Next. The card sits above or below the ring, never on
     it; on a phone the ticket's steps open the ticket sheet first. A step whose element is not
     there yet (nothing opened) explains itself in a card in the middle of the screen. */

  /* The position the tour talks about: the one just opened when there is one, else the first. */
  function firstCard() {
    var host = $('posLines');
    if (!host) return null;
    var fresh = tk.posId ? host.querySelector('.pos-card[data-id="' + tk.posId + '"]') : null;
    return fresh || host.querySelector('.pos-card:not(.is-pending)');
  }

  /* "Tap" on a touch layout, "Click" with a mouse. */
  function tapWord() { return isSheetMode() ? 'Tap' : 'Click'; }

  var TOUR = [
    { id: 'coin', on: 'market', sheet: false, title: 'Pick a coin',
      target: function () { return $('marketBtn'); },
      text: function () { return tapWord() + ' here to choose what to trade.' + (state.market ? ' ' + state.market.symbol + ' is picked for you.' : ''); } },
    { id: 'side', on: 'side', title: 'Up or down?',
      target: function () { return isSheetMode() && !ui.sheet ? $('mbarPair') : $('sidePair'); },
      text: function () { return 'BUY / LONG if you think the price goes up. SELL / SHORT if you think it goes down. You win when it moves your way. ' + tapWord() + ' one.'; } },
    { id: 'amount', on: 'amount', sheet: true, title: 'Amount',
      target: function () { return $('amountBox'); },
      text: function () { return 'What you put in. It is also the most you can lose on this trade. Start small: $10.'; } },
    { id: 'lev', on: 'lev', sheet: true, title: 'Leverage',
      target: function () { return $('levBox'); },
      text: function () {
        var amt = isFinite(form.margin) && form.margin > 0 ? fmtUsdShort(form.margin) : 'amount';
        var w = $('moveWin');
        var pays = w && w.textContent !== '—' ? ', a 1% move your way pays about ' + w.textContent : '';
        return 'Leverage multiplies your result. At ' + form.lev + 'x' + pays + '. A ' + fmtMove(bustMovePct(form.lev)) + '% move against you hits the liquidation price and your ' + amt + ' is gone. Higher leverage, smaller move.';
      } },
    { id: 'preview', sheet: true, title: 'Your trade in dollars',
      target: function () { return $('previewBox'); },
      text: function () { return 'How big the position is, what a 1% move pays you, and the price it opens near. Each direction button shows its liquidation price.'; } },
    { id: 'open', on: 'submit', sheet: true, title: 'OPEN POSITION',
      target: function () { return tk.phase ? $('ticketProgress') : $('actionBtn'); },
      text: function () {
        if (!wallet.account) return 'Connect your wallet to keep going. This button walks you through it: Connect wallet, Switch to HyperEVM, Add USDC. Then it says OPEN POSITION.';
        var b = $('actionBtn');
        var ready = b && !b.disabled && /OPEN POSITION/i.test(b.textContent);
        return ready ? tapWord() + ' OPEN POSITION. Your wallet shows the trade and asks you to confirm.'
          : 'Until you are set up, this button walks you through it: Connect wallet, Switch to HyperEVM, Add USDC. Then it says OPEN POSITION.';
      } },
    { id: 'fill', on: 'opened', sheet: true, title: 'About 6 seconds',
      target: function () { return tk.phase ? $('ticketProgress') : null; },
      text: function () {
        return tk.phase ? 'Your order is sent. It fills at the market price in about ' + fillSecs() + ' seconds. Watch it here: Sent, Opening, Open.'
          : 'When you open a trade, the button turns into this progress card: Sent, then Opening (about ' + fillSecs() + ' s), then Open at the price you got.';
      } },
    { id: 'card', sheet: false, title: 'Your position',
      target: firstCard,
      text: function () {
        return 'Every open position gets a card' + (isSheetMode() ? ' at the top of the page' : ' under the chart') + ': profit or loss in $ and %, the price you got in at, the price now, and the liquidation price. It turns amber, then red, as the price gets close.';
      } },
    /* moves on when the close's result is in (reportCloseOutcome), not on the tap, so the card's
       Closing steps and its "Closed … back in your balance" stay in view */
    { id: 'close', on: 'closed', sheet: false, title: 'CLOSE POSITION',
      target: function () { var c = firstCard(); return c ? c.querySelector('.close-btn') || c.querySelector('[data-role="act"]') : null; },
      text: function () { return tapWord() + ' CLOSE POSITION any time to take your money out. Under it: about what you get back. It closes at the market price in about ' + fillSecs() + ' s, right here on the card.'; } },
    /* the result card's own Withdraw when there is one; else the account line's (on a phone the
       copy at the top of Your positions): the sheet stays shut */
    { id: 'withdraw', on: 'withdraw', sheet: false, title: 'Withdraw',
      target: function () {
        if (!wallet.account) return null;
        var r = document.querySelector('#posLines .result-card [data-act="withdraw"]');
        if (r) return r;
        return isSheetMode() ? document.querySelector('#acctMini .js-wd') : $('acctWithdraw');
      },
      text: function () { return 'Withdraw sends your Confetti balance back to your wallet. That is every button. Replay this from "' + (isSheetMode() ? '? Help' : '? How to trade') + '".'; } }
  ];

  /* auto: the keys (a wallet's, or 'visitor') the tour already started for on its own this visit;
     autoTried: the silent reconnect has had its answer (a visitor's tour waits for it, so a
     returning wallet is not taken for a visitor); waited: how often the visitor's start waited */
  var tour = { on: false, i: 0, auto: {}, autoTried: false, waited: 0, ring: null, dim: null, card: null, timer: null, scrolled: -1 };

  /* Stored per wallet ('1' once it ended) and for 'visitor': 'part' once a visitor reached OPEN
     POSITION (their tour picks up there when a wallet connects), 'skip' when they skipped it. */
  function tourKey() { return LS.tour + (wallet.account ? wallet.account.toLowerCase() : 'visitor'); }
  /* the OPEN POSITION step, where a visitor's tour waits for a wallet */
  var TOUR_OPEN = (function () { for (var i = 0; i < TOUR.length; i++) if (TOUR[i].id === 'open') return i; return 5; })();

  /* Seen by this wallet (a visitor's tour never counts for a wallet's first trade). */
  function tourSeen() { return lsGet(tourKey()) === '1'; }

  function maybeStartTour() {
    if (DEMO || tour.on) return;
    var v = lsGet(LS.tour + 'visitor');
    var key = tourKey();
    if (tour.auto[key] || v === 'skip') return;
    if (wallet.account ? tourSeen() : !!v) return;
    if (!wallet.account && !tour.autoTried && getInjected() && tour.waited++ < 8) { setTimeout(maybeStartTour, 1000); return; }
    if (document.querySelector('dialog[open]')) { setTimeout(maybeStartTour, 3000); return; }
    tour.auto[key] = true;
    startTour(wallet.account && v === 'part' ? TOUR_OPEN : 0);
  }

  function startTour(at) {
    if (tour.on) return;
    tour.on = true; tour.i = at > 0 ? at : 0;
    buildTour();
    showTourStep();
    tour.timer = setInterval(placeTour, 250);
    window.addEventListener('resize', placeTour);
    window.addEventListener('scroll', placeTour, true);
    document.addEventListener('keydown', tourKeys, true);
  }

  /* Skip or Done. A wallet's tour is remembered for that wallet; a visitor's Skip for this browser
     (a visitor never gets past OPEN POSITION: that step waits for a wallet). */
  function endTour() {
    if (!tour.on) return;
    tour.on = false;
    if (wallet.account) lsSet(tourKey(), '1');
    else lsSet(LS.tour + 'visitor', 'skip');
    if (tour.timer) { clearInterval(tour.timer); tour.timer = null; }
    window.removeEventListener('resize', placeTour);
    window.removeEventListener('scroll', placeTour, true);
    document.removeEventListener('keydown', tourKeys, true);
    [tour.ring, tour.dim, tour.card].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
    tour.ring = null; tour.dim = null; tour.card = null;
  }

  function buildTour() {
    tour.dim = el('div', 'coach-dim');
    tour.dim.hidden = true;
    tour.ring = el('div', 'coach-ring');
    tour.ring.hidden = true;
    var c = el('div', 'coach-card');
    c.setAttribute('role', 'dialog');
    c.setAttribute('aria-label', 'How to trade');
    c.setAttribute('aria-live', 'polite');
    [['count', 'coach-count'], ['title', 'coach-title'], ['text', 'coach-text']].forEach(function (r) {
      var n = el('div', r[1]);
      n.setAttribute('data-role', r[0]);
      c.appendChild(n);
    });
    var row = el('div', 'coach-btns');
    var skip = el('button', 'btn btn-sm btn-ghost', 'Skip tour');
    skip.type = 'button';
    skip.addEventListener('click', function () { endTour(); });
    var back = el('button', 'btn btn-sm', 'Back');
    back.type = 'button';
    back.setAttribute('data-role', 'back');
    back.addEventListener('click', function () { tourGo(tour.i - 1); });
    var next = el('button', 'btn btn-sm btn-primary', 'Next');
    next.type = 'button';
    next.setAttribute('data-role', 'next');
    next.addEventListener('click', function () { tourGo(tour.i + 1); });
    row.appendChild(skip);
    row.appendChild(el('span', 'grow'));
    row.appendChild(back);
    row.appendChild(next);
    c.appendChild(row);
    tour.card = c;
    document.body.appendChild(tour.dim);
    document.body.appendChild(tour.ring);
    document.body.appendChild(c);
  }

  /* A visitor's tour waits at OPEN POSITION for a wallet. */
  function tourWaits() { return tour.i === TOUR_OPEN && !wallet.account; }

  function tourGo(i) {
    if (!tour.on) return;
    if (i > tour.i && tourWaits()) return;
    if (i >= TOUR.length) { endTour(); return; }
    tour.i = Math.max(0, i);
    showTourStep();
  }

  function showTourStep() {
    var s = TOUR[tour.i];
    if (isSheetMode()) { if (s.sheet === true) openSheet(); else if (s.sheet === false) closeSheet(); }
    setRole(tour.card, 'count', 'Step ' + (tour.i + 1) + ' of ' + TOUR.length);
    setRole(tour.card, 'title', s.title);
    setRole(tour.card, 'text', s.text());
    var back = tour.card.querySelector('[data-role="back"]');
    if (back) back.hidden = tour.i === 0;
    setRole(tour.card, 'next', tour.i === TOUR.length - 1 ? 'Done' : 'Next');
    tour.scrolled = -1;
    placeTour();
    if (tour.i === TOUR_OPEN && !wallet.account) lsSet(LS.tour + 'visitor', lsGet(LS.tour + 'visitor') === 'skip' ? 'skip' : 'part');
    var next = tour.card.querySelector('[data-role="next"]');
    try { next.focus({ preventScroll: true }); } catch (e) { /* focus is a convenience */ }
  }

  /* Ring the step's element and put the card above or below it (whichever side fits), clamped to
     the screen. Re-run four times a second and on scroll / resize, so a sheet sliding in, a card
     appearing or a scroll keeps the ring on its element. */
  function placeTour() {
    if (!tour.on || !tour.card) return;
    var s = TOUR[tour.i];
    if (!s) return;
    setRole(tour.card, 'text', s.text());
    /* a visitor at OPEN POSITION: no Next until a wallet is connected */
    var nx = tour.card.querySelector('[data-role="next"]');
    if (nx) nx.hidden = tourWaits();
    if (document.querySelector('dialog[open]')) { tour.card.hidden = true; tour.ring.hidden = true; tour.dim.hidden = true; return; }
    var vw = window.innerWidth, vh = window.innerHeight;
    var t = s.target();
    var r = t && t.getClientRects().length ? t.getBoundingClientRect() : null;
    if (r && (r.width < 1 || r.height < 1)) r = null;
    tour.card.hidden = false;
    var cw = tour.card.offsetWidth, ch = tour.card.offsetHeight;
    if (!r) {
      tour.ring.hidden = true;
      tour.dim.hidden = false;
      tour.card.style.left = Math.max(12, Math.round((vw - cw) / 2)) + 'px';
      tour.card.style.top = Math.max(12, Math.round((vh - ch) / 2)) + 'px';
      return;
    }
    if (tour.scrolled !== tour.i && (r.top < 48 || r.bottom > vh - 8) && t.scrollIntoView) {
      tour.scrolled = tour.i;
      t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    var box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    var menu = $('marketMenu');
    var menuOpen = s.id === 'coin' && menu && !menu.hidden;
    if (menuOpen) {
      var mr = menu.getBoundingClientRect();
      box = { left: Math.min(box.left, mr.left), top: Math.min(box.top, mr.top), right: Math.max(box.right, mr.right), bottom: Math.max(box.bottom, mr.bottom) };
    }
    var pad = 6, gap = 10;
    tour.dim.hidden = true;
    tour.ring.hidden = false;
    tour.ring.style.left = Math.round(box.left - pad) + 'px';
    tour.ring.style.top = Math.round(box.top - pad) + 'px';
    tour.ring.style.width = Math.round(box.right - box.left + 2 * pad) + 'px';
    tour.ring.style.height = Math.round(box.bottom - box.top + 2 * pad) + 'px';
    /* the coin list is open: the user is choosing; the card waits */
    if (menuOpen) { tour.card.hidden = true; return; }
    var below = vh - (box.bottom + pad + gap), above = box.top - pad - gap;
    var top;
    if (below >= ch + 8) top = box.bottom + pad + gap;
    else if (above >= ch + 8) top = box.top - pad - gap - ch;
    else top = below >= above ? Math.min(vh - ch - 8, box.bottom + pad + gap) : Math.max(8, box.top - pad - gap - ch);
    var left = clamp(Math.round((box.left + box.right) / 2 - cw / 2), 12, Math.max(12, vw - cw - 12));
    tour.card.style.left = left + 'px';
    tour.card.style.top = Math.round(top) + 'px';
  }

  function tourKeys(ev) {
    if (!tour.on) return;
    /* Esc meant for a dialog (Add USDC, the checks) or the coin list closes that, not the tour */
    if (document.querySelector('dialog[open]')) return;
    var mm = $('marketMenu');
    if (ev.key === 'Escape' && mm && !mm.hidden) return;
    if (ev.key === 'Escape') { endTour(); ev.stopPropagation(); return; }
    if (ev.key !== 'Enter') return;
    var a = document.activeElement;
    if (a && tour.card && tour.card.contains(a)) return; /* the focused coach button takes it */
    if (a && /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY)$/.test(a.tagName)) return;
    ev.preventDefault();
    tourGo(tour.i + 1);
  }

  /* The page tells the tour what the user just did; the step waiting for it moves on. A fill
     lands on the position card step, wherever the tour is between OPEN POSITION and the fill. */
  function tourEvent(name) {
    if (!tour.on) return;
    var s = TOUR[tour.i];
    if (!s) return;
    var at = tour.i;
    if (name === 'opened' && (s.id === 'open' || s.id === 'fill')) {
      var card = 0;
      TOUR.forEach(function (x, k) { if (x.id === 'card') card = k; });
      setTimeout(function () { if (tour.on && tour.i === at) tourGo(card); }, 900);
      return;
    }
    if (s.on !== name) return;
    setTimeout(function () { if (tour.on && tour.i === at) tourGo(at + 1); }, 450);
  }

  /* ---- local demo (DEMO: localhost or 127.0.0.1 with ?demo=...) ------------------------------
     A pretend funded account with no wallet and no chain: balance $50, DOGE long 20x and WIF
     short 50x priced off the live Hyperliquid feed, the WIF close pending (held, so it runs
     Closing, then Taking longer than usual, then Didn't go through). Every transaction is
     simulated here (demoTx) and answers with the exchange's own event logs, so the page's real
     code reads them. None of this runs unless DEMO is set. */

  var demo = { nextReq: 900, nextPos: 70, block: 1000, hold: {}, closed: {}, n: 0 };
  var DEMO_FALLBACK_PX = { DOGE: 0.2, WIF: 1.0 };

  function toPx18(x) { return BigInt(Math.round(x * 1e12)) * 1000000n; }

  function demoHash() { demo.n += 1; return '0x' + ('de' + String(demo.n)).padStart(64, '0'); }

  function demoLog(name, values, hash) {
    var enc = exIface.encodeEventLog(name, values);
    demo.block += 1;
    return { topics: enc.topics, data: enc.data, transactionHash: hash, blockNumber: demo.block, index: 0 };
  }

  /* A demo event into History, stamped now. */
  function demoRecord(log) {
    hist.blockTs[log.blockNumber] = Math.floor(Date.now() / 1000);
    addLogs([log]);
    renderHistory();
  }

  /* Every config market marked launch is "on chain" with the live market's terms (200x win cap,
     5% fee, the published impact curve); the rest are Coming soon. */
  function demoInsts() {
    var tiers = (cfg && cfg.tiers) || {};
    state.byInstId = {};
    state.markets.forEach(function (m, i) {
      m.inst = null; m.instrumentId = null;
      if (!m.launch) return;
      var t = tiers[m.tier] || {};
      var inst = {
        id: i, hlAssetIndex: m.hlAssetIndex, szDecimals: m.szDecimals, tier: Number(t.code) || 0,
        maxLeverage: m.maxLeverage || 1, deadbandBps: Number(t.deadbandBps) || 1, clampBps: Number(t.clampBps) || 5,
        baseRate: 0.1, rateMultiplier: 15000, referenceNotional: 20000, positionMultiplier: 130000000,
        longCap: 1000000, shortCap: 1000000, maxNotional: 1000000, payoutCapX: 200,
        opensPaused: false, retired: false, frozenPx: 0, market: m
      };
      m.inst = inst; m.instrumentId = i; state.byInstId[i] = inst;
      house.oi[m.symbol] = { long: 1950, short: 640 };
    });
    state.instrumentsLoaded = true;
    hbots.loaded = true;
  }

  /* The demo settles on the live mid (the real page reads the chain's oracle). */
  function demoOracle() {
    state.markets.forEach(function (m) {
      var px = state.mids[m.coin];
      if (m.instrumentId != null && px > 0) house.oraclePxById[m.instrumentId] = px;
    });
  }

  function demoBoot() {
    if (!window.ethers || !exIface) { toast('The demo needs ethers.js, which did not load.', 'err', null, 0); return; }
    demoInsts();
    house.feePool = 0; house.queued = 0; house.queueLen = 2; house.queueHead = 2; house.feeRate = 0.05;
    house.instCount = Object.keys(state.byInstId).length; house.breakerBps = 10000;
    house.block = demo.block; house.blockAt = Date.now();
    wallet.account = window.ethers.getAddress('0xde00000000000000000000000000000000000001');
    wallet.chainId = CHAIN_ID;
    acct.walletUsdc = 120; acct.allowance = 0;
    ui.hypeWei = 50000000000000000n;
    ref.loaded = true; ref.locked = true;
    if (state.market) selectMarket(state.market.symbol);
    renderWallet(); renderAccount(); renderPositions(); renderAction(); renderStatus(); renderRefer(); renderSession(); buildMarketMenu();
    toast('Demo: a pretend account on this computer. Nothing is sent.', null, null, 6000);
    demoWhenPriced(demoSeed);
  }

  function demoWhenPriced(fn) {
    var t0 = Date.now();
    (function wait() {
      var ok = ['DOGE', 'WIF'].every(function (s) { var m = state.bySym[s]; return m && state.mids[m.coin] > 0; });
      if (ok || Date.now() - t0 > 6000) {
        ['DOGE', 'WIF'].forEach(function (s) { var m = state.bySym[s]; if (m && !(state.mids[m.coin] > 0)) state.mids[m.coin] = DEMO_FALLBACK_PX[s]; });
        demoOracle();
        fn();
        return;
      }
      setTimeout(wait, 250);
    })();
  }

  function demoPos(m, isLong, margin, lev, entry) {
    var px18 = toPx18(entry);
    return {
      id: BigInt(demo.nextPos++), instrumentId: m.instrumentId, isLong: isLong, margin: margin, leverage: lev,
      entry: px18ToNum(px18), entryPx18: px18, openedAt: Math.floor(Date.now() / 1000) - 900,
      deadbandBps: m.inst.deadbandBps, payoutCapX: m.inst.payoutCapX, feeBps: 500, preview: null
    };
  }

  function demoSeed() {
    var doge = state.bySym.DOGE, wif = state.bySym.WIF;
    if (!doge || !wif || doge.instrumentId == null || wif.instrumentId == null) return;
    var pd = state.mids[doge.coin], pw = state.mids[wif.coin];
    var p1 = demoPos(doge, true, 10, 20, pd * 0.994);   /* in profit */
    var p2 = demoPos(wif, false, 10, 50, pw * 0.989);   /* a loss, its liquidation getting close (amber) */
    acct.positions = [p1, p2];
    acct.available = 50; acct.marginInUse = 20; acct.pending = 0; acct.loaded = true; acct.owner = wallet.account;
    var wpid = String(p2.id);
    acct.closeReqs[wpid] = { requestedAt: chainNow() - 1, px0: pw, block: demo.block, busy: false };
    demo.hold['c' + wpid] = true;
    hist = freshHistory();
    var now = Math.floor(Date.now() / 1000);
    [[demoLog('Deposited', [wallet.account, wallet.account, numToUsd6(70)], demoHash()), 3600],
     [demoLog('PositionOpened', [p1.id, wallet.account, p1.instrumentId, true, numToUsd6(10), 20, p1.entryPx18, 41n], demoHash()), 900],
     [demoLog('PositionOpened', [p2.id, wallet.account, p2.instrumentId, false, numToUsd6(10), 50, p2.entryPx18, 42n], demoHash()), 600]
    ].forEach(function (x) { hist.blockTs[x[0].blockNumber] = now - x[1]; addLogs([x[0]]); });
    hist.done = true;
    if (DEMO === 'pending') {
      /* an open request the ticket follows, held: Opening, then late, then expired */
      var id = String(demo.nextReq++);
      pend.opens[id] = { id: id, instrumentId: doge.instrumentId, isLong: true, margin: 10, leverage: 20, px0: pd, requestedAt: chainNow() - 1, block: demo.block };
      demo.hold['o' + id] = true;
      acct.available -= 10; acct.pending = 10;
      tkSet('req', { reqId: id, isLong: true, sym: doge.symbol, lev: 20, margin: 10 });
      openSheet();
    }
    renderAccount(); renderPositions(); renderAction(); renderForm(); renderHistory();
    if (DEMO === 'tour') setTimeout(startTour, 600);
  }

  /* A simulated transaction: about a second "in the wallet", then the state change and the
     event logs the exchange would emit. */
  function demoTx(kind, args) {
    return new Promise(function (ok) { setTimeout(ok, 900); }).then(function () {
      var hash = demoHash();
      var logs = [];
      if (kind === 'requestOpen') {
        var inst = state.byInstId[Number(args[0])];
        var margin = usd6ToNum(args[2]);
        if (!inst || margin > acct.available + 1e-9) throw new Error('Not enough balance in the demo.');
        acct.available -= margin; acct.pending += margin;
        logs.push(demoLog('OpenRequested', [BigInt(demo.nextReq++), wallet.account, Number(args[0]), !!args[1], args[2], Number(args[3]), toPx18(oraclePriceFor(inst.market)), ZERO], hash));
      } else if (kind === 'executeOpen') {
        var r = pend.opens[String(args[0])];
        if (r) logs = demoFillOpen(r, hash);
      } else if (kind === 'cancelOpen') {
        var r2 = pend.opens[String(args[0])];
        if (r2) { acct.available += r2.margin; acct.pending = Math.max(0, acct.pending - r2.margin); }
      } else if (kind === 'requestClose') {
        var p = posById(args[0]);
        logs.push(demoLog('CloseRequested', [BigInt(args[0]), wallet.account, toPx18(p ? closePriceFor(p) : 1)], hash));
      } else if (kind === 'executeClose') {
        logs = demoFillClose(String(args[0]), hash);
      } else if (kind === 'cancelClose') {
        delete demo.hold['c' + String(args[0])];
      }
      return { hash: hash, blockNumber: demo.block, status: 1, logs: logs };
    });
  }

  function demoFillOpen(r, hash) {
    var inst = state.byInstId[r.instrumentId];
    var p = demoPos(inst.market, r.isLong, r.margin, r.leverage, oraclePriceFor(inst.market));
    acct.pending = Math.max(0, acct.pending - r.margin);
    acct.marginInUse += r.margin;
    acct.positions.push(p);
    var log = demoLog('PositionOpened', [p.id, wallet.account, r.instrumentId, r.isLong, numToUsd6(r.margin), r.leverage, p.entryPx18, BigInt(r.id)], hash);
    demoRecord(log);
    return [log];
  }

  function demoFillClose(pid, hash) {
    var p = posById(pid);
    if (!p || demo.closed[pid]) return [];
    var est = positionEstimate(p);
    var px = closePriceFor(p);
    demo.closed[pid] = true;
    acct.marginInUse = Math.max(0, acct.marginInUse - p.margin);
    acct.available += est.payout;
    var minted = est.pnl < 0 ? BigInt(Math.round(-est.pnl * 100)) * 10000000000000000n : 0n;
    var log = demoLog('PositionClosed', [BigInt(pid), wallet.account, toPx18(px), BigInt(Math.round(est.pnl * 1e6)), BigInt(Math.round(est.fee * 1e6)), BigInt(Math.round(est.payout * 1e6)), 0n, minted], hash);
    demoRecord(log);
    return [log];
  }

  /* The demo's "account read": closed positions leave, everything redraws. */
  function demoRefresh() {
    if (!DEMO) return;
    acct.positions = acct.positions.filter(function (p) { return !demo.closed[String(p.id)]; });
    Object.keys(ui.settling).forEach(function (k) { if (demo.closed[k]) delete ui.settling[k]; });
    renderAccount(); renderPositions(); renderAction(); renderForm();
  }

  /* The demo keeper: fills whatever is not held once its ~6 s are up. */
  function demoTickPending() {
    var now = chainNow();
    pendingOpenList().forEach(function (r) {
      if (r.busy || demo.hold['o' + r.id] || now - r.requestedAt < fillSecs()) return;
      var hash = demoHash();
      var logs = demoFillOpen(r, hash);
      delete pend.opens[r.id];
      reportOpenOutcome(r, logs, hash);
    });
    Object.keys(acct.closeReqs).forEach(function (pid) {
      var cr = acct.closeReqs[pid];
      if (cr.busy || demo.hold['c' + pid] || now - cr.requestedAt < fillSecs()) return;
      var hash = demoHash();
      var pos = posById(pid);
      var logs = demoFillClose(pid, hash);
      ui.settling[pid] = true;
      delete acct.closeReqs[pid];
      reportCloseOutcome(pid, logs, hash, pos);
      setTimeout(demoRefresh, 1200);
    });
    renderPositions(); renderAccount(); updatePendingLines();
  }

  function demoDeposit(amount) {
    setBusy(true);
    return new Promise(function (ok) { setTimeout(ok, 900); }).then(function () {
      acct.walletUsdc = Math.max(0, acct.walletUsdc - amount);
      acct.available += amount;
      demoRecord(demoLog('Deposited', [wallet.account, wallet.account, numToUsd6(amount)], demoHash()));
      toast('Deposited ' + fmtUsd(amount) + '. Pick BUY / LONG or SELL / SHORT.', 'ok');
      closeDialog('depositModal');
      demoRefresh();
    }).then(function () { setBusy(false); });
  }

  function demoWithdraw(amount) {
    setBusy(true);
    return new Promise(function (ok) { setTimeout(ok, 900); }).then(function () {
      acct.available = Math.max(0, acct.available - amount);
      acct.walletUsdc += amount;
      demoRecord(demoLog('Withdrawn', [wallet.account, numToUsd6(amount)], demoHash()));
      toast('Sent ' + fmtUsd(amount) + ' to your wallet.', 'ok');
      closeDialog('withdrawModal');
      demoRefresh();
    }).then(function () { setBusy(false); });
  }

  /* ---- polling and init --------------------------------------------------------------- */

  function tickChain() {
    if (DEMO) { demoRefresh(); return; }
    if (document.hidden) return;
    refreshHouse();
    refreshMarketChain();
    refreshAccount();
    refreshSession();
    var dm = $('depositModal');
    if (dm && dm.open) refreshProxy();
    if (keeper && Date.now() - keeperAt >= KEEPER_EVERY_MS) { keeperAt = Date.now(); keeper.refresh().then(renderStatus); }
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
    if (window.ConfettiShare) window.ConfettiShare.use({ postInfo: postInfo });
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
    renderSession();

    tickMids(true);
    tickCtx(true);
    setInterval(function () { tickMids(false); }, MIDS_EVERY_MS);
    setInterval(function () { tickCtx(false); }, CTX_EVERY_MS);
    setInterval(function () { if (!document.hidden) loadCandles(); }, CANDLES_EVERY_MS);
    document.addEventListener('visibilitychange', onVisibility);

    if (DEMO) {
      demoBoot();
    } else if (read.provider) {
      var boot = read.exchange ? loadHouseAddresses().then(loadInstruments) : Promise.resolve();
      boot.then(function () {
        refreshHouse();
        refreshMarketChain();
        if (read.exchange && window.ConfettiKeeper) {
          keeper = window.ConfettiKeeper.create({ provider: read.provider, logProvider: read.logProvider, exchange: read.exchange, iface: exIface });
          keeperAt = Date.now();
          keeper.refresh().then(renderStatus);
        }
        if (!hasExchange()) toast('No exchange address in config: showing live prices only.', null, null, 9000);
        refreshConfVol();
        setInterval(refreshConfVol, CONF_VOL_EVERY_MS);
        setInterval(tickChain, CHAIN_EVERY_MS);
        setInterval(function () { if (!document.hidden) loadInstruments(); }, INSTRUMENTS_EVERY_MS);
        setTimeout(tryAutoConnect, 50);
      });
    }
    /* the first-trade tour: once the silent reconnect has had its chance, for a visitor or a
       wallet that has not seen it (a wallet connecting later starts it from onChainChanged) */
    if (!DEMO) setTimeout(maybeStartTour, 2500);
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
