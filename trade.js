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

  /* The demo: a pretend funded account, no wallet, no chain. ?demo=1 (the account), ?demo=tour (and the
     tour), ?demo=pending (an open request counting down in the ticket) or ?demo=idle (the account with
     nothing in flight). Built for screenshots on 127.0.0.1; public on every host since 2026-10-25 (the
     owner: a visitor should try the page before buying eyes for it), reached from the 'Try the demo' link
     under Connect wallet. Without the query DEMO is null, and every demo branch below starts by checking
     it, so nothing of the demo runs, loads or is stored on a real visit. In the demo nothing is ever sent:
     the bar under the header says so and links back to the real page. */
  var DEMO = (function () {
    try {
      var v = new URLSearchParams(location.search).get('demo');
      return v === '1' || v === 'tour' || v === 'pending' || v === 'idle' ? v : null;
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
  /* While a request is pending the page polls it every 400 ms (a fill is noticed within half a block,
     not a second after: the owner, 2026-10-25, a friend's close "took 6 seconds") and redraws the
     countdown four times a second; outcomes are read from the logs for up to this many tries (12 s). */
  var PENDING_POLL_MS = 400;
  var COUNTDOWN_MS = 250;
  var OUTCOME_TRIES = 30;
  /* Blocks scanned back first for OpenRequested when pendingOf says a request exists that the
     page does not know (another tab, a reload): about ten minutes of 1 s blocks. When margin is
     still unaccounted for after that, the scan widens to deployBlock (an unfilled request
     outlives the keeper window: with the keeper down it sits in pendingOf until someone cancels
     it, however old it is). */
  var PENDING_SCAN_BLOCKS = 600;
  var THEME_KEY = 'confetti.theme';

  /* Phones (<= 640 px): one flag for every phone-only behaviour, so desktop stays as it is.
     phoneFx: the phone feedback layer (price tint, buzz, highlight, burst), off under reduced motion. */
  var PHONE_MQ = (function () { try { return window.matchMedia('(max-width: 640px)'); } catch (e) { return null; } })();
  var REDUCED_MQ = (function () { try { return window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return null; } })();
  function isPhone() { return !!(PHONE_MQ && PHONE_MQ.matches); }
  function phoneFx() { return isPhone() && !(REDUCED_MQ && REDUCED_MQ.matches); }
  function onPhoneChange(fn) {
    if (!PHONE_MQ) return;
    if (PHONE_MQ.addEventListener) PHONE_MQ.addEventListener('change', fn);
    else if (PHONE_MQ.addListener) PHONE_MQ.addListener(fn);
  }
  /* Desktop (>= 901 px, the width where the chart and the ticket sit side by side): one flag for every
     desktop-only behaviour (the strip, the tables, the receipt), so phones and tablets stay as they are. */
  var DESK_MQ = (function () { try { return window.matchMedia('(min-width: 901px)'); } catch (e) { return null; } })();
  function isDesk() { return !!(DESK_MQ && DESK_MQ.matches); }
  /* Your positions on a desktop: the cards (traders, 2026-10-25: they liked the boxes, not the lines); the table of
     desk piece C stays in the code behind this switch. History, Portfolio and $FETTI keep their tables. */
  var POS_VIEW_KEY = 'confetti.trade.posview';
  function posTable() { return isDesk() && lsGet(POS_VIEW_KEY) === 'rows'; }
  function initPosView() {
    var box = $('posView'); if (!box) return;
    var paint = function () {
      var rows = lsGet(POS_VIEW_KEY) === 'rows';
      Array.prototype.forEach.call(box.querySelectorAll('[data-view]'), function (b) { b.setAttribute('aria-pressed', (b.getAttribute('data-view') === 'rows') === rows ? 'true' : 'false'); });
    };
    Array.prototype.forEach.call(box.querySelectorAll('[data-view]'), function (b) {
      b.addEventListener('click', function () {
        lsSet(POS_VIEW_KEY, b.getAttribute('data-view'));
        paint();
        ui.posSig = ''; // the cards or rows are rebuilt from the same positions
        renderPositions();
      });
    });
    paint();
  }
  function onDeskChange(fn) {
    if (!DESK_MQ) return;
    if (DESK_MQ.addEventListener) DESK_MQ.addEventListener('change', fn);
    else if (DESK_MQ.addListener) DESK_MQ.addListener(fn);
  }
  /* A short buzz on phones that support it (iOS ignores it; the visual feedback carries it there). */
  function buzz(pattern) {
    if (!phoneFx()) return;
    try { if ('vibrate' in navigator) navigator.vibrate(pattern); } catch (e) { /* not allowed here */ }
  }
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
    exchange: '0x533d0bc51bafeb1519f1bac93d48c175b1496063',
    exchangeExt: '0xd23f1c74a64a5fb6f6a68da854d33d736918cbb0',
    usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
    oracle: '0x1fa6c831868527c65c33e14fd2456855458e03ba',
    confetti: '0x995b36d7e33680fc6fa1db6fa4dc8e475b5233a2',
    staking: '0x2bf4976eb70cdcc03871ab60977fc4292587ce9a',
    referrals: '0x1dcdbe02568169a777ad6d2b3c5edcf5058780da',
    priceSource: '0xFaF573187824D176fc74d1de91a072eb6ffa8494',
    marketRules: '0xe1e48bf50b8af7d44e7f1ed3422598e381aab72d',
    sessionRouter: '0x5477ab941a551874596aeeb16d3bcf79a120351d',
    depositFactory: '0xe5bb8b4703787f428aaa6a3755add72b9c82fb75',
    v2Exchange: '0x257d667a52b282ac0b4c001fd437522bf6b9cbe2',
    v3Exchange: '0x723943c8fdd71e0e670b18d15be737222f3a0810',
    v3Staking: '0x167549bb697f96ee19e0ffbfa5ab5f6487f10051',
    v3Referrals: '0xdf0c59514877f38a7b59bd7db1422217ab25714b'
  };
  /* ---- END PINNED CONTRACTS ---- */
  var USDC = CONTRACTS.usdc;
  var CHECKED = ['usdc', 'oracle', 'staking', 'referrals', 'sessionRouter', 'marketRules', 'extension'];
  /* the CHECKED addresses this page sends transactions to (usdc has its own refusal: usdcBad) */
  var TX_TARGETS = { referrals: 'Refer', sessionRouter: 'One-click' };
  var RPC_HOSTS = ['rpc.hyperliquid.xyz', 'hyperliquid.drpc.org', 'rpc.purroofgroup.com'];
  var INFO_HOSTS = ['api.hyperliquid.xyz'];
  var DEFAULT_RPC = 'https://rpc.hyperliquid.xyz/evm';
  var DEFAULT_INFO = 'https://api.hyperliquid.xyz/info';
  /* One-time acceptance of terms.html, kept in localStorage; the order button waits for it. */
  var TERMS_KEY = 'confetti.terms';

  /* Fixed protocol constants (ImpactLib). Config may restate them but cannot change the contract. */
  /* Bust move = the smaller of 95% of 1/leverage and 1/leverage - BUST_GAP_BPS (ImpactLib):
     5 bps at 1000x, 15 at 500x, 35 at 250x; the 95% rule binds at 100x and below. */
  var BUST_BUFFER_PCT = 95;
  var BUST_GAP_BPS = 5;
  /* Owner settings (minMarginUsdc, winFeeBps, lossFeeBps, borrowFreeHours, maxWinBps) are read
     from the exchange by refreshHouse; until the first read the page uses config.json's restated
     values (minMarginUsdc, winFeeBps, lossFeeBps, borrowFreeHours, maxWinBps). The win / loss fee,
     the deadband, the entry spread, the borrow rate and the maximum profit are stamped on each
     position at open, so an open position's preview uses its own stamped terms (positions()). */

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

  /* "$412.3K": the House LP figure on a phone's market strip (the House page has it to the cent). */
  function fmtUsdK(n) {
    if (n == null || !isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return fmtUsdShort(n);
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

  /* "about 8,928,571 PEPE": a position's coin amount in the units its symbol names. Hyperliquid quotes the
     k-markets (kPEPE, kFLOKI, kSHIB, kBONK, ...) per 1,000 coins, so notional / price counts thousands: times
     1,000 to count the coins the label names. */
  function coinsPerUnit(sym) {
    var m = sym && state.bySym ? state.bySym[sym] : null;
    return m && /^k[A-Z]/.test(m.coin || '') ? 1000 : 1;
  }
  function fmtCoinQty(notional, px, sym) {
    return isFinite(notional) && px > 0 ? fmtQty(notional / px * coinsPerUnit(sym)) + ' ' + sym : '';
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

  /* The phone history rows' "when": the clock today ('10:10'), the day before it otherwise
     ('19 Oct 11:20'), since a phone has no hover for the date. */
  function fmtWhen(ts) {
    if (!ts) return '…';
    var d = new Date(ts * 1000), now = new Date();
    var today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return (today ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ') + fmtClock(ts);
  }

  function usd6ToNum(x) { return Number(x) / 1e6; }
  function px18ToNum(x) { return Number(x) / 1e18; }

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
    'function positions(uint256 positionId) view returns (tuple(address owner, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint96 maxProfitUsdc, uint256 entryPx18, uint64 openedAt, uint16 deadbandBps, uint16 payoutCapX, uint16 winFeeBps, uint16 lossFeeBps, uint16 entryDeadbandBps, uint16 borrowRateX10, uint16 borrowFreeHours))',
    'function positionIdsOf(address user) view returns (uint256[])',
    'function openRequest(uint256 requestId) view returns (tuple(address trader, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint64 requestedAt, uint256 px0, address referrer))',
    'function closeRequest(uint256 positionId) view returns (tuple(uint64 requestedAt, uint256 px0))',
    'function bustPrice(uint256 positionId) view returns (uint256 px18)',
    'function previewClose(uint256 positionId) view returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc)',
    'function borrowOwed(uint256 positionId) view returns (uint256 usdc)',
    'function execPrice(uint32 instrumentId, bool isLong, bool isOpen) view returns (uint256 px18)',
    'function nextRequestId() view returns (uint256)',
    'function nextPositionId() view returns (uint256)',
    'function instrument(uint32 instrumentId) view returns (tuple(uint32 hlAssetIndex, uint8 szDecimals, uint8 tier, uint32 maxLeverage, uint16 deadbandBps, uint16 clampBps, uint16 baseRateBps, uint64 rateMultiplier, uint128 referenceNotionalUsd, uint128 positionMultiplierE6, uint128 longOiCapUsd, uint128 shortOiCapUsd, uint128 maxNotionalUsd, uint16 payoutCapX, uint16 posX10, uint16 sideX10, uint16 stressBps, uint16 entryDeadbandBps, uint16 borrowRateX10, bool opensPaused, bool retired, uint256 lastPx18))',
    'function instrumentCount() view returns (uint32)',
    'function openInterest(uint32 instrumentId) view returns (uint256 longUsd, uint256 shortUsd)',
    'function maxPositionUsd(uint32 instrumentId, bool isLong) view returns (uint256 usd)',
    'function lpBalance() view returns (uint256 usdc)',
    'function feePool() view returns (uint256 usdc)',
    'function houseFreeUsdc() view returns (uint256 usdc)',
    'function queueLength() view returns (uint256)',
    'function queueHead() view returns (uint256)',
    'function queueEntry(uint256 index) view returns (address recipient, uint256 owedUsdc)',
    'function queuedTotal() view returns (uint256 usdc)',
    'function globalOpensPaused() view returns (bool)',
    'function breakerTripped() view returns (bool)',
    'function breakerBps() view returns (uint16)',
    'function winFeeBps() view returns (uint16)',
    'function lossFeeBps() view returns (uint16)',
    'function borrowFreeHours() view returns (uint16)',
    'function minMarginUsdc() view returns (uint64)',
    'function maxWinBps() view returns (uint16)',
    'function stakerFeeShareBps() view returns (uint16)',
    'function minDelay() view returns (uint32)',
    'function grace() view returns (uint32)',
    'function expiry() view returns (uint32)',
    'function maxJumpBps() view returns (uint16)',
    'function isKeeper(address account) view returns (bool)',
    'function usdc() view returns (address)',
    'function oracle() view returns (address)',
    'function staking() view returns (address)',
    'function referrals() view returns (address)',
    'function extension() view returns (address)',
    'function owner() view returns (address)',
    'function pauseGuardian() view returns (address)',
    'function marketKeeper() view returns (address)',
    'function feeRecipient() view returns (address)',
    'function sessionRouter() view returns (address)',
    'function marketRules() view returns (address)',
    /* events */
    'event Deposited(address indexed user, address indexed payer, uint256 amountUsdc)',
    'event Withdrawn(address indexed user, uint256 amountUsdc)',
    'event OpenRequested(uint256 indexed requestId, address indexed trader, uint32 indexed instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 px0, address referrer)',
    'event OpenRequestCancelled(uint256 indexed requestId, address indexed trader, bytes4 reason)',
    'event PositionOpened(uint256 indexed positionId, address indexed owner, uint32 indexed instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 entryPx18, uint256 requestId, bool keeperFill)',
    'event CloseRequested(uint256 indexed positionId, address indexed trader, uint256 px0)',
    'event CloseRequestCancelled(uint256 indexed positionId, bytes4 reason)',
    'event PositionClosed(uint256 indexed positionId, address indexed owner, uint256 exitPx18, int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc, uint256 queuedUsdc, uint256 borrowUsdc, bool keeperFill)',
    'event PositionLiquidated(uint256 indexed positionId, address indexed owner, address indexed liquidator, uint256 exitPx18, uint128 marginUsdc, uint256 bountyUsdc, uint256 feeUsdc)',
    'event QueueAppended(uint256 indexed index, address indexed recipient, uint256 amountUsdc)',
    'event QueuePaid(uint256 indexed index, address indexed recipient, uint256 paidUsdc, uint256 remainingUsdc)',
    'event FeesPushed(uint256 toStakersUsdc, uint256 toRecipientUsdc)',
    'event HouseDeposited(uint256 amountUsdc, uint256 lpAfterUsdc)',
    'event HouseWithdrawn(uint256 amountUsdc, uint256 lpAfterUsdc)',
    'event HouseWinForfeited(uint256 indexed positionId, uint256 forfeitedUsdc)',
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
    'event FeeBpsSet(uint16 winFeeBps, uint16 lossFeeBps)',
    'event MarketFeesSet(uint32 indexed instrumentId, uint16 entryDeadbandBps, uint16 borrowRateX10)',
    'event BorrowFreeHoursSet(uint16 hours_)',
    'event MinMarginSet(uint64 minMarginUsdc)',
    'event HouseSizingSet(uint32 indexed instrumentId, uint16 posX10, uint16 sideX10, uint16 stressBps)',
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
    'error HouseExposureExceeded()',
    'error NoLastPrice(uint32 instrumentId)',
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

  /* The v2 Exchange (config contracts.v2Exchange): the three balances behind the banner's
     link to v2.html. Checked by ops/check_site_abi.js against ops/abi/ExchangeV2.json, not the v3 build. */
  var V2_EXCHANGE_ABI = [
    'function balanceOf(address user) view returns (uint256 availableUsdc)',
    'function marginInUse(address user) view returns (uint256 usdc)',
    'function pendingOf(address user) view returns (uint256 usdc)'
  ];

  /* The v3 Exchange (config contracts.v3Exchange, a v4 config): the same three balances behind the
     banner's link to v3.html. Checked by ops/check_site_abi.js against ops/abi/ExchangeV3.json. */
  var V3_EXCHANGE_ABI = [
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
    awayDone: {}, posInView: false, owedSig: '', owedAt: 0,
    /* phones: the positions label row in view, all rows shown, the last close */
    phHeadInView: true, phMore: false, phClosed: null,
    /* the Position sheet: what it shows ({ mode: 'pos', pid } or { mode: 'all', ids, resolve }); per
       position, the figures frozen at the Close tap and the close's result (the row and the sheet
       say it); a trade.html#pos=<id> deep link waiting for the account */
    phSheet: null, phFrozen: {}, phResult: {}, phDeepLink: null
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
    /* owner settings read from the exchange (null until read; see the constants above) */
    winFeeBps: null, lossFeeBps: null, minMargin: null, borrowFreeHours: null, maxWinBps: null, free: null,
    /* per instrument id: { long, short } maxPositionUsd() in USD, read with the chain poll */
    maxPos: {},
    /* why this page sends nothing (v4 gate), or null; see sendGate() */
    gate: null,
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

  var read = { provider: null, logProvider: null, exchange: null, referrals: null, router: null, factory: null, v2: null, v3: null };

  /* The v2 / v3 banners: each shown for the connected account while that Exchange still holds its
     balance, margin or a pending open request (a pending close keeps its position's margin in use). */
  var oldLinks = { v2: { account: null, at: 0, show: false, total: 0 }, v3: { account: null, at: 0, show: false, total: 0 } };

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
      try { limTick(); } catch (e) { /* never stops the prices */ }
      try { checkLimits(); } catch (e) { /* never stops the prices */ }
      try { tpslTick(); checkTpSl(); } catch (e) { /* never stops the prices */ }
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

  /* the axis labels: 12 px on phones and on the desktop (the trader reads them all day), 11 on the tablet as before */
  function chartFontSize() { return isPhone() ? 12 : 11; }

  function chartOptions() {
    var t = chartTheme();
    var LW = window.LightweightCharts;
    return {
      autoSize: true,
      layout: { background: { type: 'solid', color: t.raised }, textColor: t.muted, fontFamily: t.mono, fontSize: chartFontSize() },
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
    initChartReset();
    var refont = function () { if (chart.api) chart.api.applyOptions({ layout: { fontSize: chartFontSize() } }); };
    onPhoneChange(refont);
    onDeskChange(refont);
  }

  /* RESET (the owner, 2026-10-22: "chart reset at the bottom of the chart ... like a little circle"): the circle under
     the candles shows once the chart is scrolled away from the latest bar, zoomed, or its price axis was dragged off
     auto; one tap puts it back: latest candles, the default bar width, the price scale on auto. */
  function initChartReset() {
    var b = $('chartReset'), box = $('chartBox');
    if (!b || !box || !chart.api) return;
    var ts = chart.api.timeScale();
    var want = chartOptions().timeScale;
    function off() {
      if (!chart.candles.length) return false;
      var r = ts.getVisibleLogicalRange();
      if (!r) return false;
      var atEnd = r.to >= chart.candles.length - 1 + (want.rightOffset || 0) - 1;
      var spacing = (ts.options() || {}).barSpacing;
      var zoomed = isFinite(spacing) && Math.abs(spacing - want.barSpacing) > 0.05;
      var ps = chart.api.priceScale('right').options() || {};
      return !atEnd || zoomed || ps.autoScale === false;
    }
    function show() { if (off()) b.removeAttribute('hidden'); else b.setAttribute('hidden', ''); }
    ts.subscribeVisibleLogicalRangeChange(show);
    ['pointerup', 'wheel', 'touchend'].forEach(function (ev) { box.addEventListener(ev, function () { setTimeout(show, 60); }, { passive: true }); });
    b.addEventListener('click', function () {
      ts.applyOptions({ barSpacing: want.barSpacing, rightOffset: want.rightOffset });
      ts.scrollToPosition(want.rightOffset, false);
      chart.api.priceScale('right').applyOptions({ autoScale: true });
      show();
      setTimeout(show, 400);
    });
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

  /* CONTINUOUS CANDLES (the owner, 2026-10-23: "the most paramount thing right now is fixing the chart design"):
     each loaded bar opens at the previous bar's close, as updateChartFromMid already opens a live bar, so a quiet
     minute is a short body joined to its neighbours instead of a lone tick floating at its own first trade. High and
     low widen to take the new open: no price the bar traded at is hidden. */
  function joinCandles(bars) {
    for (var i = 1; i < bars.length; i++) {
      var k = bars[i], o = bars[i - 1].c;
      k.o = o;
      if (o > k.h) k.h = o;
      if (o < k.l) k.l = o;
    }
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
      var bust = px18ToNum(posBust18(p));
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

  /* The hash as a coin symbol ('#WIF'). '#pos=<id>' is Portfolio's deep link to a position
     (piece 12): readDeepLink takes it first, and it is never read as a symbol. */
  function hashSymbol() {
    var h = location.hash || '';
    if (/^#pos=/.test(h)) return '';
    return decodeURIComponent(h.replace(/^#/, ''));
  }

  /* trade.html#pos=<id>: keep the id; the Position sheet opens once the account is in
     (renderPhRows), and a gone id does nothing. */
  function readDeepLink() {
    var dl = /^#pos=(\d+)$/.exec(location.hash || '');
    if (dl) ui.phDeepLink = dl[1];
    return !!dl;
  }

  function initialMarketSymbol() {
    var fromHash = hashSymbol();
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
    /* the limit price was the old market's number: clear it; Limit mode reseeds from this market's price */
    if (changed) { lim.px = NaN; var lp = $('dkLimitPx'); if (lp) { lp.value = ''; var np = marketPrice(m); if (lim.type === 'limit' && isFinite(np) && np > 0) { lp.value = String(Number(np.toPrecision(6))); lim.px = Number(lp.value); } } }
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
    var symBtn = $('marketBtn');
    if (symBtn) symBtn.classList.toggle('is-long-sym', String(m.symbol).length > 5);
    setText('marketTier', 'up to ' + maxLev(m) + 'x');
    var tag = $('marketTag');
    if (tag) { var tt = marketTagText(m); tag.textContent = tt; tag.hidden = !tt; }
    var px = marketPrice(m);
    setText('marketPrice', fmtPrice(px, m.szDecimals));
    var pxEl = $('marketPrice');
    if (pxEl) pxEl.classList.toggle('is-long', fmtPrice(px, m.szDecimals).length > 8);
    /* a k-market's price is for 1,000 coins (Hyperliquid's kPEPE): say so on hover; amounts count single coins */
    if (pxEl) { var kt = coinsPerUnit(m.symbol) > 1 ? 'Price of 1,000 ' + m.symbol + ' (Hyperliquid ' + m.coin + ')' : ''; if (pxEl.title !== kt) pxEl.title = kt; }
    tickTint(m.symbol, px);
    var c = state.ctx[m.coin];
    var pct = c && c.prevDayPx > 0 && isFinite(px) ? px / c.prevDayPx - 1 : NaN;
    var chg = $('marketChange');
    if (chg) {
      var ct = isFinite(pct) ? fmtPct(pct, true) : '';
      if (chg.getAttribute('data-v') !== ct) {
        /* desktop reads '+1.85%'; phones read the arrow instead of the sign ('▲ 1.85%') */
        chg.setAttribute('data-v', ct);
        chg.textContent = '';
        if (ct) {
          var sign = ct.charAt(0) === '+' || ct.charAt(0) === '-' ? ct.charAt(0) : '';
          if (pct > 0 || pct < 0) chg.appendChild(el('span', 'ph-only chg-arrow', pct > 0 ? '\u25B2 ' : '\u25BC '));
          if (sign) chg.appendChild(el('span', 'chg-sign', sign));
          chg.appendChild(document.createTextNode(ct.slice(sign.length)));
        }
      }
      chg.className = 'market-change ' + (pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'muted');
    }
    setText('chipVol', c && isFinite(c.vol24h) ? fmtUsdCompact(c.vol24h) : '—');
    var oi = publicOi(m.symbol, m.instrumentId);
    setText('chipLongOi', oi ? fmtUsdCompact(oi.long) : (hasExchange() ? '—' : 'n/a'));
    setText('chipShortOi', oi ? fmtUsdCompact(oi.short) : (hasExchange() ? '—' : 'n/a'));
    /* desktop at 1,440-1,599 px the strip has no room for "Traded here 24h"; its number rides in the Open bets title */
    var oiChip = isDesk() && $('chipLongOi') ? $('chipLongOi').closest('.chip') : null;
    if (oiChip) {
      if (!oiChip.hasAttribute('data-title')) oiChip.setAttribute('data-title', oiChip.title);
      var cv = $('chipConfVol') ? $('chipConfVol').textContent : '';
      var oiTitle = oiChip.getAttribute('data-title') + (cv && cv !== '—' ? ' · traded here 24h ' + cv : '');
      if (oiChip.title !== oiTitle) oiChip.title = oiTitle;
    }
    setText('sheetTitle', m.symbol + ' · ' + fmtPrice(px, m.szDecimals));
    renderPhTicketHead(m, px, pct);
    document.title = (isFinite(px) ? fmtPrice(px, m.szDecimals) + ' ' : '') + m.symbol + ' — confetti_';
  }

  /* Phones: the price tints up or down for 400 ms when it ticks (text only), then fades back. */
  var tick = { sym: null, px: null, timer: null };
  function tickTint(sym, px) {
    var prev = tick.sym === sym ? tick.px : null;
    tick.sym = sym; tick.px = isFinite(px) ? px : null;
    if (prev == null || !isFinite(px) || px === prev || !phoneFx()) return;
    var n = $('marketPrice');
    if (!n) return;
    n.classList.remove('tick-up', 'tick-down');
    n.classList.add(px > prev ? 'tick-up' : 'tick-down');
    if (tick.timer) clearTimeout(tick.timer);
    tick.timer = setTimeout(function () { n.classList.remove('tick-up', 'tick-down'); tick.timer = null; }, 400);
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
    var firsts = ['BTC', 'ETH', 'SOL']; // the majors first (the owner, 2026-10-25: 'put sol up under eth')
    function rank(m) { var i = firsts.indexOf(m.symbol); return i < 0 ? firsts.length : i; }
    live.sort(function (a, b) { return rank(a) - rank(b) || state.markets.indexOf(a) - state.markets.indexOf(b); });
    var caps = [];
    live.forEach(function (m) { if (caps.indexOf(maxLev(m)) < 0) caps.push(maxLev(m)); });
    caps.sort(function (a, b) { return b - a; });
    /* desktop (piece B): numbers in columns, with a head row: coin, price, 24h, leverage */
    var dk = isDesk();
    if (dk && live.length) {
      var head = el('div', 'market-cols');
      ['Coin', 'Price', '24h', 'Leverage'].forEach(function (t) { head.appendChild(el('span', null, t)); });
      list.appendChild(head);
    }
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
        if (dk) row.appendChild(el('span', 'cap', 'up to ' + maxLev(m) + 'x'));
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
      chg.textContent = isFinite(pct) ? fmtPct(pct, true) : isDesk() ? '—' : '';
      chg.className = 'chg ' + (pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'faint');
    }
  }

  function openMarketMenu() {
    var menu = $('marketMenu');
    if (!menu) return;
    buildMarketMenu();
    menu.removeAttribute('hidden');
    if (isDesk()) renderMarketMenuPrices();   /* desktop (piece B): the 24h column at once (buildMarketMenu ran while the menu was still hidden) */
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
      /* phones: the ticket sheet opens straight on its coin page (piece 14); a pick there closes the sheet */
      if (isPhone()) { closeMarketMenu(); if (!ui.sheet) openSheet(); if (!cp.on) openPhCoinPage('strip', btn); return; }
      if (menu.hasAttribute('hidden')) openMarketMenu(); else closeMarketMenu();
    });
    if (filter) filter.addEventListener('input', buildMarketMenu);
    /* keys (piece B): ArrowDown / ArrowUp walk the rows (aria-selected moves), Enter picks the row through its own
       click handler (so the tour hears it), Escape stays the document's closer below */
    menu.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Enter') return;
      var rows = Array.prototype.slice.call(menu.querySelectorAll('.market-row'));
      if (!rows.length) return;
      var i = -1;
      rows.forEach(function (r, k) { if (r.getAttribute('aria-selected') === 'true') i = k; });
      if (ev.key === 'Enter') {
        if (ev.target !== filter && ev.target.classList && ev.target.classList.contains('market-row')) return;   /* a focused row's own Enter is its click */
        ev.preventDefault();
        (rows[i] || rows[0]).click();
        return;
      }
      ev.preventDefault();
      var next = i < 0 ? 0 : clamp(i + (ev.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1);
      rows.forEach(function (r, k) { r.setAttribute('aria-selected', k === next ? 'true' : 'false'); });
      if (rows[next].scrollIntoView) rows[next].scrollIntoView({ block: 'nearest' });
    });
    document.addEventListener('click', function (ev) {
      if (menu.hasAttribute('hidden')) return;
      if (!menu.contains(ev.target) && !btn.contains(ev.target)) closeMarketMenu();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeMarketMenu();
    });
    window.addEventListener('hashchange', function () {
      /* a #pos=<id> reaching an open page (Portfolio in another tab): that position, not a coin */
      if (readDeepLink()) { renderPhRows(); return; }
      var sym = hashSymbol();
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

  /* A setting read from the exchange, else config.json's restated value, else null. */
  function liveOr(v, key) {
    if (v != null) return v;
    var c = cfg && cfg[key] != null ? Number(cfg[key]) : NaN;
    return isFinite(c) ? c : null;
  }

  /* Win fee rate (winFeeBps / 1e4) and loss fee rate (lossFeeBps / 1e4) for new positions. */
  function feeRate() { var b = liveOr(house.winFeeBps, 'winFeeBps'); return b != null ? b / 1e4 : 0; }
  function lossFeeRate() { var b = liveOr(house.lossFeeBps, 'lossFeeBps'); return b != null ? b / 1e4 : 0; }

  /* Smallest margin a request takes, USD (minMarginUsdc). */
  function minMargin() { var v = liveOr(house.minMargin, 'minMarginUsdc'); return v != null && v > 0 ? v : 1; }

  /* Whole hours a new position holds before the borrow starts (borrowFreeHours). */
  function freeHours() { return liveOr(house.borrowFreeHours, 'borrowFreeHours'); }

  /* "5%", "0.5%": a rate for UI text; a dash before anything is known. */
  function pctText(rate) { return rate == null || !isFinite(rate) ? '—' : (rate * 100).toFixed(2).replace(/\.?0+$/, '') + '%'; }
  function feePctText() { return liveOr(house.winFeeBps, 'winFeeBps') == null ? '—' : pctText(feeRate()); }

  /* A market's borrow rate as a percent of the position per hour: borrowRateX10 is tenths of a bps. */
  function borrowPctText(inst) { return inst && inst.borrowRateX10 != null ? pctText(inst.borrowRateX10 / 1e5) : '—'; }

  /* The most one new position on inst could win with this margin (USD), as executeOpen stamps
     it: the smaller of margin x payoutCapX and maxWinBps of the house's free cash. NaN when a
     part is unknown. */
  function maxProfitFor(margin, inst) {
    if (!inst || !(margin > 0)) return NaN;
    var cap = inst.payoutCapX > 0 ? margin * inst.payoutCapX : Infinity;
    var bps = liveOr(house.maxWinBps, 'maxWinBps');
    var byHouse = house.free != null && bps != null ? house.free * bps / 1e4 : Infinity;
    var m = Math.min(cap, byHouse);
    return isFinite(m) ? m : NaN;
  }

  /* Borrow a position owes after heldS seconds (ImpactLib.borrowFee): rateX10 tenths of a bps of
     notional per whole hour held beyond its free hours; a part hour is free. */
  function borrowFor(pos, heldS) {
    var rate = pos.borrowRateX10 > 0 ? pos.borrowRateX10 : 0;
    var free = (pos.borrowFreeHours >= 0 ? pos.borrowFreeHours : 0) * 3600;
    if (!rate || !(heldS >= free + 3600)) return 0;
    return Math.floor((pos.margin * pos.leverage * 1e6) * rate * Math.floor((heldS - free) / 3600) / 1e5) / 1e6;
  }

  /* What close() would settle to at price px. Returns { pnl, fee, payout, borrow, flat } in USD.
     A position carries its terms stamped at open (deadbandBps, winFeeBps, lossFeeBps,
     maxProfit, borrowRateX10, borrowFreeHours) and settles on those; a pretend position (the
     ticket) uses the live settings. The impact curve is live. On a win the fee is winFeeBps of
     the gain left after the impact haircut; on a loss the trader pays the loss and nothing more
     (a loss fee is carved from the house's side). The borrow comes off the payout. */
  function estimateClose(pos, inst, px, queueEmpty) {
    var borrow = pos.openedAt > 0 ? borrowFor(pos, Math.max(0, chainNow() - pos.openedAt)) : 0;
    function done(r) {
      r.borrow = Math.min(borrow, Math.max(0, r.payout));
      r.payout -= r.borrow;
      return r;
    }
    var out = { pnl: 0, fee: 0, payout: pos.margin, flat: true };
    if (!(px > 0) || !(pos.entry > 0)) return done(out);
    var rate = pos.winFeeBps >= 0 ? pos.winFeeBps / 1e4 : feeRate();
    var notional = pos.margin * pos.leverage;
    var isWin = pos.isLong ? px > pos.entry : px < pos.entry;
    if (!isWin) {
      var diff = Math.abs(pos.entry - px);
      var loss = Math.min(pos.margin, notional * diff / pos.entry);
      if (loss <= 0) return done(out);
      var lrate = pos.lossFeeBps >= 0 ? pos.lossFeeBps / 1e4 : lossFeeRate();
      var lfee = queueEmpty === false ? 0 : loss * lrate;
      return done({ pnl: -loss, fee: lfee, payout: pos.margin - loss, flat: false });
    }
    var c = curveOf(inst);
    var band = pos.deadbandBps > 0 ? pos.deadbandBps : c.deadbandBps;
    var exit = pos.isLong ? px * (1 - band / 1e4) : px * (1 + band / 1e4);
    if (pos.isLong ? exit <= pos.entry : exit >= pos.entry) return done(out);
    var move = Math.abs(exit - pos.entry) / pos.entry;
    var gain = notional * move;
    var adjusted = gain * impactScale(move, c);
    /* the maximum profit stamped at open caps the adjusted gain before the fee */
    var cap = pos.maxProfit >= 0 ? pos.maxProfit : maxProfitFor(pos.margin, inst);
    if (cap >= 0) adjusted = Math.min(adjusted, cap);
    var fee = adjusted * rate;
    return done({ pnl: adjusted - fee, fee: fee, payout: pos.margin + adjusted - fee, flat: false });
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

  /* ImpactLib.rawEntry: the fill before the entry spread a position's entry carries (long down,
     short up, the contract's rounding). The bust is measured from it. */
  function rawEntry18(entryPx18, isLong, spreadBps) {
    var s = BigInt(spreadBps || 0);
    if (s === 0n) return entryPx18;
    if (isLong) return entryPx18 * 10000n / (10000n + s);
    var den = 10000n - s;
    return (entryPx18 * 10000n + den - 1n) / den;
  }

  /* A position's liquidation price, as bustPrice(positionId) works it. */
  function posBust18(p) { return bustPrice18(rawEntry18(p.entryPx18, p.isLong, p.entryDeadbandBps), p.isLong, p.leverage); }

  /* The entry a fill at px books on inst: moved by the market's entry spread against the trader. */
  function spreadEntry(px, isLong, inst) {
    var s = inst && inst.entryDeadbandBps > 0 ? inst.entryDeadbandBps : 0;
    return isLong ? px * (1 + s / 1e4) : px * (1 - s / 1e4);
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
    vals.sort(function (a, b) { return a - b; });
    var sig = vals.join(',');
    if (host.getAttribute('data-sig') !== sig) {
      host.textContent = '';
      /* phones (piece 13): the ladder is two rows in the same slot. Base: the chips under 100x and
         'Higher ›'; high: '‹', 100x and up, the standard chips above the coin's cap shown disabled
         (a tap says the cap), and Custom. A coin capped under 100x has no high row: Custom sits in
         the base row. The ph-only chips are display:none above 640 px, so the desktop row is as before. */
      var hasHigh = max >= CONFIRM_LEV;
      vals.forEach(function (v) {
        if (hasHigh && v >= CONFIRM_LEV && !host.querySelector('.lev-back')) {
          var back = el('button', 'pick ph-only lev-back lev-high', '‹');
          back.type = 'button'; back.setAttribute('data-lev', 'back'); back.setAttribute('aria-label', 'Lower leverage');
          host.appendChild(back);
        }
        var b = el('button', 'pick' + (v >= CONFIRM_LEV ? ' lev-high' : ' lev-base'), v + 'x');
        b.type = 'button';
        b.setAttribute('data-lev', String(v));
        host.appendChild(b);
        if (hasHigh && v < CONFIRM_LEV && (vals[vals.indexOf(v) + 1] == null || vals[vals.indexOf(v) + 1] >= CONFIRM_LEV)) {
          var hi = el('button', 'pick ph-only lev-higher lev-base', 'Higher ›');
          hi.type = 'button'; hi.setAttribute('data-lev', 'higher'); hi.setAttribute('aria-label', 'Higher leverage, 100x and up');
          host.appendChild(hi);
        }
      });
      if (hasHigh) {
        LEV_CHIPS.filter(function (v) { return v > max; }).forEach(function (v) {
          var o = el('button', 'pick ph-only lev-high lev-over', v + 'x');
          o.type = 'button'; o.setAttribute('data-lev', 'over'); o.setAttribute('aria-disabled', 'true');
          o.setAttribute('title', 'Not on this coin');
          host.appendChild(o);
        });
      }
      var c = el('button', 'pick pick-custom' + (hasHigh ? ' lev-high' : ' lev-base'), 'Custom');
      c.type = 'button';
      c.setAttribute('data-lev', 'custom');
      host.appendChild(c);
      host.setAttribute('data-sig', sig);
      host.classList.toggle('has-high', hasHigh);
      ui.phLevHigh = hasHigh && form.lev >= CONFIRM_LEV;
    }
    var custom = form.levCustom || vals.indexOf(form.lev) < 0;
    Array.prototype.forEach.call(host.querySelectorAll('[data-lev]'), function (b) {
      var v = b.getAttribute('data-lev');
      if (v === 'back' || v === 'higher' || v === 'over') return;
      b.setAttribute('aria-pressed', (v === 'custom' ? custom : !custom && Number(v) === form.lev) ? 'true' : 'false');
    });
    /* phones: which row shows (a new coin opens on the row its saved leverage lives on; Higher / ‹ and the keypad move it) */
    host.classList.toggle('is-high', !!ui.phLevHigh && host.classList.contains('has-high'));
    var box = $('levCustom');
    if (box) box.hidden = !custom && !isDesk();
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
      if (v === 'custom' || v === 'typed') return;   /* the phone's keypad chips (piece 14) keep their own state */
      var on = v === 'max' ? form.maxed : !form.maxed && Number(v) === form.margin;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (isPhone()) renderPhTypedChip();
  }

  /* A position as if opened now at px with the ticket's amount, side and leverage: what the money
     lines and the check before a big trade are priced on. Its entry carries the market's entry
     spread; -1 terms mean the live settings (fees, maximum profit). */
  function pretendPos(px, margin) {
    var m = state.market, isLong = form.side === 'long';
    return {
      entry: spreadEntry(px, isLong, m && m.inst), margin: margin, leverage: form.lev, isLong: isLong,
      winFeeBps: -1, lossFeeBps: -1, deadbandBps: 0, maxProfit: -1, openedAt: 0
    };
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
    var px = lim.type === 'limit' && lim.px > 0 ? lim.px : openPriceFor(m);   // a limit prices its own receipt
    var margin = isFinite(form.margin) && form.margin > 0 ? form.margin : NaN;
    var notional = isFinite(margin) ? margin * form.lev : NaN;
    var isLong = form.side === 'long';
    setText('liqLong', fmtPrice(bustPriceNum(px, true, form.lev), sz));
    setText('liqShort', fmtPrice(bustPriceNum(px, false, form.lev), sz));
    setText('levNote', form.lev + 'x: a ' + fmtMove(bustMovePct(form.lev)) + '% move against you liquidates your ' + (isFinite(margin) ? fmtUsdShort(margin) : 'amount') + '.');
    setText('orderValue', isFinite(notional) ? fmtUsd(notional) + (px > 0 ? ' (about ' + fmtCoinQty(notional, px, sym) + ')' : '') : '—');
    setText('moveKey', 'If ' + (sym || 'the price') + ' moves 1% your way');
    var win = isFinite(notional) && px > 0 ? estimateClose(pretendPos(px, margin), inst, px * (isLong ? 1.01 : 0.99), true) : null;
    setText('moveWin', win && !win.flat ? fmtUsd(win.pnl, true) : '—');
    setText('opensNear', lim.type === 'limit' && lim.px > 0 ? 'Opens when ' + sym + ' reaches ' + fmtPrice(px, sz) + '; the fill lands at the oracle a few seconds after'
      : 'Opens near ' + (px > 0 ? fmtPrice(px, sz) + ' (oracle price)' : 'the oracle price') + ' in about ' + fillSecs() + ' s');
    /* the win cap line (in Details) shows only when a 20% move would reach it */
    var capUsd = ticketCap(inst, margin);
    var big = isFinite(capUsd) && px > 0 ? estimateClose(pretendPos(px, margin), inst, px * (isLong ? 1.2 : 0.8), true) : null;
    var capped = !!big && big.pnl >= capUsd * 0.999;
    var capLine = $('capLine');
    if (capLine) {
      capLine.hidden = !capped;
      if (capped) capLine.textContent = 'At this amount and leverage, wins above ' + fmtUsd(capUsd) + ' are capped.';
    }
    var q = $('queueLine');
    if (q) q.hidden = !(house.queued > 0);
    setText('maxProfit', isFinite(capUsd) ? 'Win cap ' + fmtUsd(capUsd) + ' after fee, set when it opens.' : 'Win cap: —');
    var c = curveOf(inst);
    setText('keptShare', 'Small wins are trimmed: you keep about ' + Math.round(impactScale(0.001, c) * 100) + '% of a 0.1% move, ' + Math.round(impactScale(0.01, c) * 100) + '% of a 1% move.');
    setText('feeLine', 'Fee: ' + feePctText() + ' of winnings, after the trim. Nothing on a loss beyond the loss.');
    var fh = freeHours();
    setText('borrowLine', inst && inst.borrowRateX10 > 0
      ? 'Borrow: ' + borrowPctText(inst) + ' of the position per hour after the first ' + (fh == null ? '—' : fh === 1 ? 'hour' : fh + ' hours') + ', taken at close.'
      : 'Borrow: none.');
    if (inst && inst.entryDeadbandBps > 0 && !(lim.type === 'limit' && lim.px > 0)) setText('opensNear', 'Opens near ' + (px > 0 ? fmtPrice(px, sz) + ' (oracle price)' : 'the oracle price') + ' plus a ' + pctText(inst.entryDeadbandBps / 1e4) + ' spread, in about ' + fillSecs() + ' s');
    var mp = inst ? house.maxPos[inst.id] : null;
    var room = mp ? (isLong ? mp.long : mp.short) : null;
    setText('posCapLine', room != null ? 'Biggest ' + sym + ' ' + (isLong ? 'long' : 'short') + ' right now ' + fmtUsd(room) : 'Biggest position: —');
    /* phones (piece 13): the same numbers in the receipt rows */
    if (isPhone()) renderPhReceipt({ m: m, sz: sz, sym: sym, inst: inst, px: px, margin: margin, notional: notional, isLong: isLong, win: win, capUsd: capUsd, capped: capped });
    /* desktop (piece B): the same numbers in the desktop receipt, right above OPEN */
    else if (isDesk()) renderDkReceipt({ sz: sz, sym: sym, inst: inst, px: px, margin: margin, notional: notional, isLong: isLong, win: win });
  }

  /* Text into an element only when it changed: renderForm runs on every price tick. No layout read. */
  function dkSet(id, text) { var n = $(id); if (n && n.textContent !== text) n.textContent = text; }

  /* The desktop receipt (piece B), from renderForm's own locals (c: sz, sym, inst, px, margin, notional, isLong,
     win), in the phone receipt's words: You risk, Position, Liquidation · a X% drop, If DOGE rises 1%, Opens near,
     Costs. The notices (paused, HYPE) stay in #ticketNotice above OPEN; the check before a big trade reuses it. */
  function dkReceiptRows(c) {
    var lev = form.lev;
    var qty = fmtCoinQty(c.notional, c.px, c.sym);
    var costs = [];
    if (c.inst && c.inst.entryDeadbandBps > 0) costs.push(pctText(c.inst.entryDeadbandBps / 1e4) + ' spread');
    costs.push(feePctText() + ' of wins');
    return {
      risk: isFinite(c.margin) ? fmtUsd(c.margin) : '—',
      size: isFinite(c.notional) ? fmtUsdShort(c.notional) + (qty ? ' · ' + qty : '') : '—',
      liq: 'Liquidation ' + fmtPrice(bustPriceNum(c.px, c.isLong, lev), c.sz) + ' · a ' + fmtMove(bustMovePct(lev)) + '% ' + (c.isLong ? 'drop' : 'rise'),
      moveK: 'If ' + (c.sym || 'the price') + (c.isLong ? ' rises' : ' falls') + ' 1%',
      moveV: c.win && !c.win.flat ? fmtUsd(c.win.pnl, true) : '—',
      movePos: !!(c.win && !c.win.flat && c.win.pnl > 0),
      opens: lim.type === 'limit' && lim.px > 0 ? 'Opens when ' + (state.market ? state.market.symbol : 'the price') + ' reaches ' + fmtPrice(c.px, c.sz) + '; the fill lands at the oracle a few seconds after'
        : 'Opens near ' + (c.px > 0 ? fmtPrice(c.px, c.sz) : 'the market price') + ' in about ' + fillSecs() + ' s',
      costs: 'Costs ' + costs.join(' · ')
    };
  }

  function renderDkReceipt(c) {
    var r = dkReceiptRows(c);
    dkSet('dkRcRisk', r.risk);
    dkSet('dkRcSize', r.size);
    dkSet('dkRcLiq', r.liq);
    dkSet('dkRcMoveK', r.moveK);
    dkSet('dkRcMoveV', r.moveV);
    var mv = $('dkRcMoveV');
    if (mv) mv.classList.toggle('pos', r.movePos);
    dkSet('dkRcOpens', r.opens);
    dkSet('dkRcCosts', r.costs);
  }

  /* The receipt rows as a block of their own, for the check before a big trade (desktop). */
  function dkReceiptNode(r, loseText) {
    var box = el('div', 'dk-rc dk-rc-check');
    var a = el('div', 'dk-rc-a');
    var c1 = el('div', 'dk-rc-cell'); c1.appendChild(el('span', 'dk-rc-k', 'You risk')); c1.appendChild(el('b', 'dk-rc-risk', r.risk));
    var c2 = el('div', 'dk-rc-cell is-right'); c2.appendChild(el('span', 'dk-rc-k', 'Position')); c2.appendChild(el('b', 'dk-rc-size', r.size));
    a.appendChild(c1); a.appendChild(c2); box.appendChild(a);
    var b = el('div', 'dk-rc-b is-loss'); b.appendChild(el('span', null, r.liq + (loseText ? ': ' + loseText : ''))); box.appendChild(b);
    var cc = el('div', 'dk-rc-c'); cc.appendChild(el('span', null, r.moveK)); cc.appendChild(el('b', r.movePos ? 'pos' : null, r.moveV)); box.appendChild(cc);
    box.appendChild(el('div', 'dk-rc-d', r.opens));
    box.appendChild(el('div', 'dk-rc-e', r.costs));
    return box;
  }

  /* The most the ticket's trade could win after the fee (USD), as it would be stamped now; NaN
     when unknown. */
  function ticketCap(inst, margin) {
    var mp = maxProfitFor(margin, inst);
    return isFinite(mp) ? mp * (1 - feeRate()) : NaN;
  }

  /* The win cap in dollars for the ticket's amount when a 20% move would reach it, else NaN: the
     line in Details and the check before a big trade. */
  function ticketCapUsd() {
    var m = state.market;
    var inst = m && m.inst ? m.inst : null;
    var px = openPriceFor(m);
    var margin = isFinite(form.margin) && form.margin > 0 ? form.margin : NaN;
    var capUsd = ticketCap(inst, margin);
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
    /* phones (piece 13): the picked leverage chip fills in the side's colour */
    var f = $('orderForm');
    if (f) f.classList.toggle('is-short', form.side === 'short');
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
    if (house.gate) return house.gate;
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
    if (house.gate || house.globalPaused || house.breakerTripped) return null;
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
    var mm = minMargin();
    if (form.margin < mm) return 'Minimum is ' + fmtUsd(mm) + '.';
    if (form.margin > acct.available + 1e-9) return 'That is more than your balance (' + fmtUsd(acct.available) + ').';
    if (form.lev < 1 || form.lev > m.inst.maxLeverage) return 'Leverage on ' + m.symbol + ' goes up to ' + m.inst.maxLeverage + 'x.';
    /* maxPositionUsd(id, isLong): every open-time limit in one number (static caps, side and book
       limits sized to the house's free cash), read with the chain poll */
    var mp = house.maxPos[m.inst.id];
    var room = mp ? (form.side === 'long' ? mp.long : mp.short) : null;
    if (room != null && form.margin * form.lev > room + 1e-6) {
      return room < 1 ? m.symbol + ' ' + (form.side === 'long' ? 'longs' : 'shorts') + ' are full right now.'
        : 'Too big right now: up to ' + fmtUsd(room) + ' on ' + m.symbol + ' ' + (form.side === 'long' ? 'longs' : 'shorts') + '. Lower the amount or leverage.';
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
    var td = $('tryDemo'); if (td) td.hidden = !!(wallet.account || DEMO || !window.ethers);
    var m = state.market;
    var sym = m ? m.symbol : '';
    var label = 'OPEN POSITION', cls = 'btn btn-lg btn-block btn-go', disabled = false, note = '', err = false;
    var notice = null, alt = null, setup = true, problem = null, swapState = false;
    var block = marketBlock();
    if (block) {
      disabled = true; notice = block; alt = altMarket();
    } else if (!window.ethers) {
      label = 'Wallet unavailable'; disabled = true; note = 'The wallet library did not load. Reload the page.'; err = true;
    } else if (!wallet.account) {
      label = 'Connect wallet';
      note = wallet.eth || getInjected() ? 'Trades are in USDC on HyperEVM; HYPE swaps for it here in one tap. Nothing is signed.' : 'No wallet in this browser: tap to open Confetti in your wallet app.';
    } else if (wallet.chainId !== CHAIN_ID) {
      label = 'Switch to HyperEVM'; note = 'Your wallet is on ' + chainName(wallet.chainId) + '. Confetti runs on HyperEVM.';
    } else if (!hasExchange()) {
      label = 'Trading is off'; disabled = true; note = 'This copy of the site has no exchange address.'; err = true;
    } else if (!acct.loaded) {
      label = 'Loading your account…'; disabled = true;
    } else if (acct.available < minMargin()) {
      /* the owner, 2026-10-25: "make it obvious that people need to convert their hyperliquid to usdc": a wallet
         with HYPE and no USDC gets a button that names the step (it opens Add USDC on the one-tap swap) */
      if (depSwapFirst() && $('depSwap')) {
        swapState = true; label = 'Swap HYPE for USDC';
        note = 'Trades are in USDC, not HYPE. One tap swaps your ' + (Number(ui.hypeWei) / 1e18).toFixed(2) + ' HYPE, then you deposit it.';
      } else {
        label = 'Add USDC';
        note = acct.walletUsdc >= 1 ? 'You have ' + fmtUsd(acct.walletUsdc) + ' USDC in your wallet. Add it to start.'
          : acct.available > 0 ? 'Your balance is ' + fmtUsd(acct.available) + '. Trades start at ' + fmtUsd(minMargin()) + '.'
          : depSwapSmall() ? 'Trades are in USDC. The HYPE in this wallet buys about ' + fmtUsd(swHypeWorth(ui.hypeWei)) + ', under the ' + fmtUsdShort(minMargin()) + ' minimum: add USDC, or a little more HYPE.'
          : onrampOn() ? 'Trades are in USDC on HyperEVM. Nothing in this wallet yet: Add USDC pays with Apple Pay.'
          : 'Trades are in USDC on HyperEVM. Add at least ' + fmtUsdShort(minMargin()) + ' to start.';
      }
    } else if (!(form.margin > 0)) {
      label = 'Enter an amount'; disabled = true;
    } else {
      setup = false;
      cls += form.side === 'long' ? ' go-long' : ' go-short';
      problem = orderProblem();
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
    /* phones (piece 13): OPEN says the trade, an armed OPEN says 'Tap again', the problem goes to row D */
    var ph = isPhone() ? phActionView({ label: label, cls: cls, disabled: disabled, note: note, err: err, setup: setup }) : null;
    if (ph) { label = ph.label; cls = ph.cls; note = ph.note; err = ph.err; }
    /* desktop (piece B): OPEN says the trade (OPEN LONG · $25 × 50x); the hint keeps what happens next, or the problem */
    else if (!setup && isDesk() && isFinite(form.margin) && form.margin > 0) {
      label = 'OPEN ' + (form.side === 'long' ? 'LONG' : 'SHORT') + ' · ' + fmtUsdShort(form.margin) + ' × ' + form.lev + 'x';
      cls += ' dk-trade';
      if (!err) note = String(note || '').replace(/^(BUY \/ LONG|SELL \/ SHORT) .*? at \d+x\.\s*/, '');
    }
    var tkd = $('tkDeposit'); if (tkd) { var tkdText = swapState ? 'Swap HYPE for USDC' : 'Deposit USDC'; if (tkd.textContent !== tkdText) tkd.textContent = tkdText; }
    btn.className = cls;
    btn.textContent = label;
    btn.disabled = disabled;
    if (hint) { hint.textContent = tk.phase ? '' : note; hint.classList.toggle('is-err', err && !tk.phase); }
    renderTicketNotice(notice, alt);
    if (ph) { ui.phTk = { problem: problem, notice: notice, alt: alt, setup: setup }; renderPhRowD(); }
    renderUsdcBanner();
    renderTicketProgress(false);
    var closeAll = $('closeAllBtn');
    if (closeAll) closeAll.disabled = state.busy;
  }

  /* Phones and tablets: the ticket is a sheet behind BUY / SELL, so a HYPE holder with no USDC saw $0.00 and
     nothing naming USDC. This banner says it on the first screen, with the swap one tap away. Never on desktop
     (the ticket is in view), never for a funded wallet or one holding USDC; it goes once the swap lands. */
  function renderUsdcBanner() {
    var b = $('usdcBanner'); if (!b) return;
    var on = !!(isSheetMode() && wallet.account && wallet.chainId === CHAIN_ID && hasExchange() && acct.loaded && acct.available < minMargin() && depSwapFirst());
    b.hidden = !on;
    if (on) setText('usdcBannerHype', (Number(ui.hypeWei) / 1e18).toFixed(2));
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
    form.margin = isFinite(saved) && saved >= minMargin() ? Math.floor(saved * 100) / 100 : minMargin();
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
        /* phones: $… opens the in-sheet keypad; the typed chip reopens it with its value (piece 14) */
        if (v === 'custom' || v === 'typed') { if (isPhone()) openPhKeypad('amt', v === 'typed'); return; }
        var next = minMargin();
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
        /* phones (piece 13): Higher › and ‹ swap the ladder's row; a chip above the cap only says the cap */
        if (v === 'higher' || v === 'back') { ui.phLevHigh = v === 'higher'; buzz(8); renderLevChips(state.market ? maxLev(state.market) : 1000); return; }
        if (v === 'over') return;
        /* phones: Custom opens the in-sheet keypad in leverage mode (piece 14); desktop opens the slider and box */
        if (v === 'custom') { if (isPhone()) { openPhKeypad('lev', false); return; } form.levCustom = true; renderLeverage(); }
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
      /* the phone's More page opens it for its lines (piece 13) without touching the remembered choice */
      details.addEventListener('toggle', function () { if (!more.setting && !more.on) lsSet(LS.details, details.open ? '1' : '0'); });
    }
    /* desktop (piece B): Details ▾ in the receipt's costs row opens the same Details (its summary is hidden at
       901 px and up); the lines open under the button area and fit the ticket */
    var dkMore = $('dkDetailsBtn');
    if (details && dkMore) {
      var dkSync = function () {
        dkMore.setAttribute('aria-expanded', details.open ? 'true' : 'false');
        setText('dkDetailsCaret', details.open ? '▴' : '▾');
      };
      dkMore.addEventListener('click', function () { details.open = !details.open; dkSync(); dkFitTicket(); });
      details.addEventListener('toggle', dkSync);
      dkSync();
    }
    /* desktop (piece B): crossing 901 px redraws the leverage row (the typed box shows at 901 and up), the
       receipt and the button's words */
    onDeskChange(function () { renderLeverage(); renderForm(); renderAction(); });
    var x = $('sheetClose');
    if (x) x.addEventListener('click', closeSheet);
    var scrim = $('sheetScrim');
    if (scrim) scrim.addEventListener('click', closeSheet);
    var chip = $('posChip');
    if (chip) chip.addEventListener('click', showPositions);
    var dpg = $('dkPosGo');
    if (dpg) dpg.addEventListener('click', function () {
      /* the newest position that has a card (one mid-close shows as a result card, not a position card) */
      var top = acct.positions.slice().sort(function (a, b) { return a.id < b.id ? 1 : -1; }).filter(function (p) { return !!posCardEl(String(p.id)); })[0];
      if (top) showNewPosition(String(top.id)); else showPositions();
    });
    var bs = $('barStatus');
    if (bs) bs.addEventListener('click', function () {
      if (tk.phase === 'opened') { var id = tk.posId; tkReset(); showNewPosition(id); }
      else if (tk.phase) openSheet(); else showPositions();
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && ui.sheet && !tour.on) closeSheet(); });
    /* every "If a fill is slow, ask my wallet to finish it" box is the same setting */
    document.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t && t.hasAttribute && t.hasAttribute('data-autofill')) { lsSet(LS.autoFill, t.checked ? '1' : '0'); syncAutoFill(); }
    });
    syncAutoFill();
    watchPosPanel();
    initDkFit();
  }

  /* cf_FIX: the desktop ticket fits a short screen (1366 x 768, a laptop with the points bar, the owed row, a v2 / v3
     banner). Measured, never guessed: when its content is taller than its room, it tightens first (dk-tight: the
     side pair 44 px, the amount 36 px, the notice's button beside its words, 4 px gaps); if Details still does not
     fit, Details opens beside the ticket over the chart's right edge (dk-det-fly), so OPEN never moves and the
     ticket never scrolls. A ResizeObserver on the ticket and its content and a resize listener run it; the
     classes come off and on in one pass, so nothing paints in between. */
  function dkFitTicket() {
    var t = $('ticket'), d = $('detailsBox');
    if (!t) return;
    t.classList.remove('dk-tight'); t.classList.remove('dk-det-fly');
    if (!isDesk()) return;
    if (t.scrollHeight > t.clientHeight) t.classList.add('dk-tight');
    if (d && d.open && t.scrollHeight > t.clientHeight) { t.classList.add('dk-det-fly'); dkFlyAt(); }
  }
  function dkFlyAt() {
    var t = $('ticket'), btn = $('dkDetailsBtn'), d = $('detailsBox'), ch = $('chartBox');
    if (!t || !btn || !d) return;
    /* its foot level with the Details button, or with the chart's foot when that is higher and the lines still fit
       under the ticket's top, so it never covers the positions table's Close buttons */
    var foot = btn.getBoundingClientRect().bottom + 4, cb = ch ? ch.getBoundingClientRect().bottom : foot;
    if (cb < foot && cb - d.offsetHeight >= t.getBoundingClientRect().top) foot = cb;
    var v = Math.max(16, Math.round(innerHeight - foot)) + 'px';
    if (t.style.getPropertyValue('--dk-fly-bottom') !== v) t.style.setProperty('--dk-fly-bottom', v);
  }
  function initDkFit() {
    var t = $('ticket');
    if (!t) return;
    var queued = false;
    var later = function () { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; dkFitTicket(); }); };
    if (window.ResizeObserver) { var ro = new ResizeObserver(later); ro.observe(t); if (t.firstElementChild) ro.observe(t.firstElementChild); }
    window.addEventListener('resize', later);
    window.addEventListener('scroll', function () { if (t.classList.contains('dk-det-fly')) dkFlyAt(); }, { passive: true });
    document.addEventListener('keydown', function (ev) {
      var d = $('detailsBox');
      if (ev.key === 'Escape' && d && d.open && t.classList.contains('dk-det-fly')) { d.open = false; dkFitTicket(); }
    });
    onDeskChange(function () { dkBannerRoom(); later(); });
    window.addEventListener('resize', dkBannerRoom);
    later();
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
    if (acct.available < minMargin()) { openDeposit(); return; }
    if (!(form.margin > 0) || orderProblem()) { renderAction(); return; }
    if (lim.type === 'limit' && lim.firing === null && isDesk()) {
      /* the big-trade check happens here, at placement: nobody is watching when a limit fires */
      if ((form.lev >= CONFIRM_LEV || form.maxed) && lsGet(LS.noConfirm) !== '1') { confirmOpen().then(function (yes) { if (yes && !state.busy && !tk.phase && !orderProblem()) placeLimit(); }); return; }
      placeLimit(); return;
    }
    if ((form.lev >= CONFIRM_LEV || form.maxed) && lsGet(LS.noConfirm) !== '1') {
      if (isPhone()) {
        /* phones (piece 13): the first tap arms OPEN; the second tap has just passed every guard above
           again and goes on to submitOpen; a tap within 500 ms of arming is the same tap */
        if (!arm.on) { phArm(); return; }
        if (Date.now() - arm.at < ARM_GUARD_MS) return;
        phDisarm(true);
        submitOpen();
        return;
      }
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
    /* desktop (piece B): the same check as the ticket's receipt, and OK says the trade */
    var node = null, ok = 'OPEN POSITION';
    if (isDesk()) {
      var notional = form.margin * form.lev;
      node = dkReceiptNode(dkReceiptRows({ sz: sz, sym: m.symbol, inst: m.inst, px: px, margin: form.margin, notional: notional, isLong: isLong, win: win }), 'you lose ' + fmtUsdShort(form.margin));
      if (isFinite(cap)) node.appendChild(el('div', 'dk-rc-f', 'Wins above ' + fmtUsd(cap) + ' are capped.'));
      ok = 'OPEN ' + (isLong ? 'LONG' : 'SHORT') + ' · ' + fmtUsdShort(form.margin) + ' × ' + form.lev + 'x';
    }
    return askConfirm({
      title: (isLong ? 'BUY / LONG ' : 'SELL / SHORT ') + m.symbol,
      lines: lines, node: node,
      ok: ok, okClass: (isLong ? 'go-long' : 'go-short') + (node ? ' dk-trade' : ''), back: 'Back', skipKey: LS.noConfirm
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
      /* desktop (piece B): a prebuilt receipt in place of the lines */
      if (o.node) body.appendChild(o.node);
      else (o.lines || []).forEach(function (l) {
        var t = typeof l === 'string' ? { text: l } : l;
        body.appendChild(el('p', t.cls || null, t.text));
      });
    }
    d.classList.toggle('is-dk-check', !!o.node);
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
    var ph = $('waPhantom'), mm = $('waMetaMask'), cb = $('waCoinbase'), okx = $('waOkx');
    if (ph) ph.href = 'https://phantom.app/ul/browse/' + encodeURIComponent(page) + '?ref=' + encodeURIComponent(/^https:$/.test(location.protocol) ? location.origin : SITE_URL.replace(/\/$/, ''));
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
    var tkt = $('ticket');
    if (tkt) { tkt.style.transform = ''; tkt.style.transition = ''; }
    document.body.classList.add('sheet-open');
    var s = $('sheetScrim');
    if (s) s.hidden = false;
    renderTicketProgress(false);
  }

  function closeSheet() {
    if (!ui.sheet && !document.body.classList.contains('sheet-open')) return;
    ui.sheet = false;
    phTicketReset();
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
    var p = (typeof sel === 'string' && document.querySelector(sel)) || (isPhone() && $('phPosHead')) || $('posPanel');
    if (p && p.scrollIntoView) p.scrollIntoView({ block: typeof sel === 'string' ? 'center' : 'start', behavior: 'smooth' });
  }
  /* A 600 ms ring on a row or card (never under reduced motion). */
  function flashFresh(n) {
    if (!n || reducedMotion()) return;
    n.classList.remove('is-fresh'); void n.offsetWidth; n.classList.add('is-fresh');
  }
  /* Land on a position: the phone's rows head (the newest row sits right under it), else its card or row,
     then ring it. View position used to scroll to a card that is display:none on phones. */
  function showNewPosition(pid) {
    closeSheet();
    var t = isPhone() ? $('phPosHead') : (pid && posCardEl(pid)) || $('posPanel');
    if (t && t.scrollIntoView) t.scrollIntoView({ block: isPhone() ? 'start' : 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    flashFresh(isPhone() ? (pid && phRowFor(pid)) : (pid && posCardEl(pid)));
  }

  /* ---- phones (<= 640 px): builds 6, 8 and 10 of the phone spec ---------------------------------
     Everything below runs only while isPhone() is true; above 640 px the markup it fills is ph-only
     (display: none) and the page works as before. */

  function reducedMotion() { return !!(REDUCED_MQ && REDUCED_MQ.matches); }

  /* Build 6: drag a sheet down by its grab handle or its head to dismiss it: past 80 px, or a flick
     faster than 0.5 px/ms; short of that it springs back. Pointer events, so a finger and a mouse
     alike; the zones are touch-action: none, so the in-app browser's own pull gestures stay out.
     A tap on a button in the head (the 44 px close) stays a tap. */
  function sheetDrag(panel, zones, close) {
    if (!panel) return;
    var st = null;
    function down(ev) {
      if (!isPhone() || st || (ev.button != null && ev.button !== 0)) return;
      var t = ev.target;
      if (t && t.closest && t.closest('button, a, input, select, textarea, label')) return;
      st = { id: ev.pointerId, zone: ev.currentTarget, y0: ev.clientY, dy: 0, v: 0, lastY: ev.clientY, lastT: ev.timeStamp };
      try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
      panel.classList.add('is-dragging');
      panel.style.transition = 'none';
    }
    function move(ev) {
      if (!st || ev.pointerId !== st.id) return;
      var dt = ev.timeStamp - st.lastT;
      if (dt > 0) st.v = (ev.clientY - st.lastY) / dt;
      st.lastY = ev.clientY; st.lastT = ev.timeStamp;
      st.dy = Math.max(0, ev.clientY - st.y0);
      panel.style.transform = st.dy ? 'translateY(' + st.dy + 'px)' : '';
      if (ev.cancelable) ev.preventDefault();
    }
    function up(ev) {
      if (!st || ev.pointerId !== st.id) return;
      var s = st;
      st = null;
      try { s.zone.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
      var v = ev.timeStamp - s.lastT > 100 ? 0 : s.v;
      var go = ev.type === 'pointerup' && (s.dy > 80 || (v > 0.5 && s.dy > 8));
      panel.classList.remove('is-dragging');
      if (go) {
        panel.style.setProperty('--drag-y', s.dy + 'px');
        panel.style.transition = '';
        close(s.dy);
        return;
      }
      /* spring back */
      panel.style.transition = reducedMotion() ? 'none' : 'transform var(--t-sheet-out, 200ms) var(--ease-out, ease-out)';
      panel.style.transform = '';
      setTimeout(function () { if (!st) panel.style.transition = ''; }, 240);
    }
    zones.forEach(function (z) {
      if (!z) return;
      z.addEventListener('pointerdown', down);
      z.addEventListener('pointermove', move);
      z.addEventListener('pointerup', up);
      z.addEventListener('pointercancel', up);
    });
  }

  /* A sheet-modal slides out (200 ms) before it closes; at once under reduced motion or above 640 px. */
  function sheetOut(d, done) {
    if (!d || !d.open) { if (done) done(); return; }
    if (!isPhone() || reducedMotion() || !d.classList.contains('sheet-modal')) { d.style.transform = ''; done(); return; }
    if (d._phOut) return;
    d._phOut = true;
    d.style.transform = '';
    d.classList.add('is-out');
    setTimeout(function () {
      d._phOut = false;
      d.classList.remove('is-out');
      d.style.removeProperty('--drag-y');
      done();
    }, 200);
  }

  function initPhoneSheets() {
    /* the ticket: its head (with the grab handle) drags it down */
    var tkt = $('ticket');
    if (tkt) sheetDrag(tkt, [tkt.querySelector('.sheet-head')], function () { tkt.style.transform = ''; closeSheet(); });
    /* every sheet-modal: the grab handle and the head */
    Array.prototype.forEach.call(document.querySelectorAll('dialog.sheet-modal'), function (d) {
      sheetDrag(d, [d.querySelector('.sheet-grab'), d.querySelector('.panel-head')], function () { closeDialog(d.id); });
      /* Esc: the same slide out on a phone */
      d.addEventListener('cancel', function (ev) { if (isPhone() && !reducedMotion()) { ev.preventDefault(); closeDialog(d.id); } });
    });
    /* leaving the phone layout (a rotate, a resize) closes the phone-only sheets */
    onPhoneChange(function () {
      if (isPhone()) return;
      ['phMenuSheet', 'phAcctSheet', 'phPosSheet'].forEach(function (id) { var d = $(id); if (d && d.open) d.close(); });
      if (tkt) tkt.style.transform = '';
    });
  }

  /* ---- Piece 14: the in-sheet keypad and the coin page (phones, <= 640 px) ----------------------
     The keypad draws inside the ticket sheet for the amount ($…) and a custom leverage (Custom). Every
     key writes the real marginInput / levInput and dispatches 'input', so form.margin, form.lev,
     orderProblem and renderAction are today's code paths. 'Use keyboard' shows the real input and
     focuses it. The coin page is a page inside the same sheet (the sheet keeps its height): Recent
     (the last five coins traded here, try/catch storage) nearest the thumb, All coins above it in
     today's order, a 16 px search pinned under the list that is never auto-focused. The market
     strip's coin button opens the sheet straight on this page, and a pick from there closes the
     sheet (the chart was wanted, not the ticket); a pick from the ticket's pill returns to the ticket.
     Above 640 px none of this runs: the markup is ph-only and desktop keeps its dropdown and inputs. */

  var kp = { on: false, mode: 'amt', buf: '', timer: null };
  var cp = { on: false, from: null, opener: null };
  var RECENT_KEY = 'confetti.trade.recent';
  var MAX_LEV_FALLBACK = 1000;

  function phTicketEl() { return document.querySelector('#ticket .ticket'); }

  /* The sheet head's coin pill and quote (renderMarketHeader fills them) */
  function renderPhTicketHead(m, px, pct) {
    if (!isPhone()) return;
    setText('phTkSym', m.symbol);
    setText('phTkPx', fmtPrice(px, m.szDecimals));
    var c = $('phTkChg');
    if (c) {
      var ct = isFinite(pct) ? fmtPct(Math.abs(pct)) : '';
      c.textContent = ct ? (pct > 0 ? '▲ ' : pct < 0 ? '▼ ' : '') + ct : '';
      c.className = 'ph-tk-chg ' + (pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'muted');
    }
  }

  /* ---- the keypad ---- */

  function kpMax() { return state.market ? maxLev(state.market) : MAX_LEV_FALLBACK; }

  function openPhKeypad(mode, keep) {
    if (!isPhone()) return;
    var t = phTicketEl();
    if (!t) return;
    kp.on = true; kp.mode = mode === 'lev' ? 'lev' : 'amt';
    if (kp.mode === 'amt') kp.buf = keep && isFinite(form.margin) && form.margin > 0 ? String(form.margin) : '';
    else kp.buf = keep ? String(form.lev) : '';
    t.classList.remove('is-kbd-amt', 'is-kbd-lev');
    t.classList.add('is-keypad');
    var host = $('phKeypad');
    if (host) {
      host.hidden = false;
      host.classList.toggle('is-lev', kp.mode === 'lev');
      host.setAttribute('aria-label', kp.mode === 'lev' ? 'Leverage keypad' : 'Amount keypad');
      var dot = host.querySelector('.ph-key-dot');
      if (dot) dot.disabled = kp.mode === 'lev';
    }
    renderPhKeypad();
    /* the keypad sits where the controls were; keep it in view in a sheet that had to scroll */
    if (host && host.scrollIntoView) { try { host.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }
  }

  function closePhKeypad() {
    if (!kp.on) return;
    kp.on = false;
    if (kp.timer) { clearTimeout(kp.timer); kp.timer = null; }
    var t = phTicketEl();
    if (t) t.classList.remove('is-keypad');
    var host = $('phKeypad');
    if (host) host.hidden = true;
    if (kp.mode === 'lev') {
      /* a typed leverage that is one of the chips lights that chip, not Custom (the desktop box keeps Custom open);
         the ladder shows the row the leverage lives on */
      form.levCustom = LEV_CHIPS.indexOf(form.lev) < 0 && form.lev !== kpMax();
      ui.phLevHigh = form.lev >= CONFIRM_LEV;
      renderLeverage();
    }
    renderAmountChips();
  }

  /* 'Use keyboard': the real input shows in the controls' place and takes focus (VoiceOver reads it) */
  function kpUseKeyboard() {
    var mode = kp.mode;
    closePhKeypad();
    var t = phTicketEl();
    if (t) t.classList.add(mode === 'lev' ? 'is-kbd-lev' : 'is-kbd-amt');
    if (mode === 'lev') { form.levCustom = true; renderLeverage(); }
    var inp = $(mode === 'lev' ? 'levInput' : 'marginInput');
    if (inp) { try { inp.focus(); inp.select(); } catch (e) { /* focus is a convenience */ } }
  }

  function kpKey(k) {
    var b = kp.buf;
    if (k === 'back') b = b.slice(0, -1);
    else if (k === '.') {
      if (kp.mode !== 'amt' || b.indexOf('.') >= 0) return;
      b = (b || '0') + '.';
    } else {
      if (kp.mode === 'amt') {
        var parts = b.split('.');
        if (parts.length > 1 && parts[1].length >= 2) return;   /* cents, no finer */
        if (parts.length === 1 && parts[0].length >= 7) return;  /* $9,999,999 is plenty */
        if (b === '0') b = '';
      } else {
        if (b === '0') b = '';
        var next = Number(b + k);
        if (next > kpMax()) { kpFlashLimit(); return; }        /* over the coin's cap: the limit line says so */
        if (b.length >= 4) return;
      }
      b += k;
    }
    kp.buf = b;
    buzz(8);
    kpWrite();
    renderPhKeypad();
  }

  /* Write the buffer into the real input and let today's handler take it from there. */
  function kpWrite() {
    if (kp.mode === 'amt') {
      var inp = $('marginInput');
      if (!inp) return;
      var v = kp.buf.replace(/\.$/, '');
      inp.value = v;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      var li = $('levInput');
      if (!li) return;
      var n = Math.round(Number(kp.buf));
      if (kp.buf === '' || !isFinite(n) || n < 1) return;      /* nothing typed yet: the leverage stays */
      li.value = String(n);
      li.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function kpFlashLimit() {
    var l = $('phKpLim');
    if (!l) return;
    l.classList.add('is-over');
    if (kp.timer) clearTimeout(kp.timer);
    kp.timer = setTimeout(function () { l.classList.remove('is-over'); kp.timer = null; }, 1200);
  }

  function renderPhKeypad() {
    if (!kp.on) return;
    var val = $('phKpVal'), lim = $('phKpLim');
    if (kp.mode === 'amt') {
      if (val) val.textContent = '$ ' + (kp.buf || '0');
      var mm = minMargin();
      var over = isFinite(form.margin) && (form.margin < mm || (acct.loaded && form.margin > acct.available + 1e-9));
      if (lim) {
        lim.textContent = 'Min ' + fmtUsdShort(mm) + (wallet.account && acct.loaded ? ' · Balance ' + fmtUsd(acct.available) : '');
        lim.classList.toggle('is-over', !!over && kp.buf !== '');
      }
    } else {
      if (val) val.textContent = (kp.buf || '—') + 'x';
      if (lim) lim.textContent = '1x to ' + kpMax() + 'x' + (state.market ? ' on ' + state.market.symbol : '');
    }
  }

  /* The typed amount as its own chip ($37.50, lit) while the amount is not $10, $25, $50 or Max. */
  function renderPhTypedChip() {
    var host = $('amtChips');
    if (!host) return;
    var chip = host.querySelector('[data-amt="typed"]');
    if (!chip) return;
    var std = [10, 25, 50];
    var typed = isFinite(form.margin) && form.margin > 0 && !form.maxed && std.indexOf(form.margin) < 0;
    chip.hidden = !typed;
    host.classList.toggle('has-typed', typed);
    if (typed) { chip.textContent = fmtUsdShort(form.margin); chip.setAttribute('aria-pressed', 'true'); }
    else chip.setAttribute('aria-pressed', 'false');
  }

  /* ---- the coin page ---- */

  function recentCoins() {
    try {
      var a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(a) ? a.filter(function (s) { return typeof s === 'string' && !!state.bySym[s]; }).slice(0, 5) : [];
    } catch (e) { return []; }
  }

  /* A coin traded here (its open request sent): first in Recent, five kept. Storage may refuse; then there is no Recent group. */
  function noteRecent(sym) {
    if (!isPhone() || !sym) return;
    try {
      var a = recentCoins().filter(function (s) { return s !== sym; });
      a.unshift(sym);
      localStorage.setItem(RECENT_KEY, JSON.stringify(a.slice(0, 5)));
    } catch (e) { /* no storage: no Recent group */ }
  }

  function phCoinRow(m) {
    var row = el('button', 'ph-cp-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('data-sym', m.symbol);
    row.setAttribute('aria-selected', state.market === m ? 'true' : 'false');
    var sym = el('span', 'ph-cp-sym');
    sym.appendChild(el('span', null, m.symbol));
    var tt = marketTagText(m);
    if (tt) sym.appendChild(el('span', 'market-tag', tt));
    row.appendChild(sym);
    row.appendChild(el('span', 'ph-cp-px', fmtPrice(marketPrice(m), m.szDecimals)));
    var chg = el('span', 'ph-cp-chg');
    var c = state.ctx[m.coin], px = marketPrice(m);
    var pct = c && c.prevDayPx > 0 && isFinite(px) ? px / c.prevDayPx - 1 : NaN;
    if (isFinite(pct)) { chg.textContent = (pct > 0 ? '▲ ' : pct < 0 ? '▼ ' : '') + fmtPct(Math.abs(pct)); chg.className += pct > 0 ? ' pos' : pct < 0 ? ' neg' : ' muted'; }
    row.appendChild(chg);
    row.appendChild(el('span', 'ph-cp-cap', 'up to ' + maxLev(m) + 'x'));
    return row;
  }

  function buildPhCoinList() {
    var list = $('phCoinList');
    if (!list) return;
    var filter = ($('phCoinFind') && $('phCoinFind').value || '').trim().toLowerCase();
    list.textContent = '';
    var live = [], soon = [];
    state.markets.forEach(function (m) {
      if (filter && m.symbol.toLowerCase().indexOf(filter) === -1) return;
      (marketOnChain(m) ? live : soon).push(m);
    });
    /* today's order: BTC and ETH first, then the config order */
    var firsts = ['BTC', 'ETH', 'SOL']; // the majors first (the owner, 2026-10-25: 'put sol up under eth')
    function rank(m) { var i = firsts.indexOf(m.symbol); return i < 0 ? firsts.length : i; }
    live.sort(function (a, b) { return rank(a) - rank(b) || state.markets.indexOf(a) - state.markets.indexOf(b); });
    var recent = recentCoins().map(function (s) { return state.bySym[s]; }).filter(function (m) { return m && live.indexOf(m) >= 0; });
    function group(title, cls, items) {
      var g = el('div', 'ph-cp-group' + (cls ? ' ' + cls : ''));
      g.appendChild(el('div', 'ph-cp-label', title));
      items.forEach(function (m) { g.appendChild(phCoinRow(m)); });
      list.appendChild(g);
    }
    if (live.length) group('All coins', 'is-all', live);
    if (soon.length) list.appendChild(el('div', 'ph-cp-soon', 'Coming soon: ' + soon.map(function (m) { return m.symbol; }).join(', ')));
    if (recent.length) group('Recent', 'is-recent', recent);
    if (!live.length && !soon.length) list.appendChild(el('div', 'ph-cp-soon', 'No coin by that name.'));
  }

  /* The sheet keeps its height while a page is open: the page fills the box the ticket had. */
  function phPageOpen(cls) {
    var tkt = $('ticket'), t = phTicketEl();
    if (!tkt || !t) return;
    if (!t.classList.contains('is-page')) tkt.style.height = tkt.offsetHeight + 'px';
    tkt.classList.add('ph-page');
    t.classList.add('is-page', cls);
    var back = $('phPageBack'), title = $('phPageTitle');
    if (back) back.hidden = false;
    if (title) title.hidden = false;
  }

  function phPageClose(cls) {
    var tkt = $('ticket'), t = phTicketEl();
    if (!tkt || !t) return;
    t.classList.remove('is-page', cls);
    tkt.classList.remove('ph-page');
    tkt.style.height = '';
    var back = $('phPageBack'), title = $('phPageTitle');
    if (back) back.hidden = true;
    if (title) title.hidden = true;
    phFitSize();   /* the receipt is on screen again: its position line fitted to what it says now (a coin picked on the page) */
  }

  function openPhCoinPage(from, opener) {
    if (!isPhone()) return;
    var page = $('phCoinPage');
    if (!page) return;
    cp.on = true; cp.from = from || 'ticket'; cp.opener = opener || null;
    var f = $('phCoinFind');
    if (f) f.value = '';
    buildPhCoinList();
    setText('phPageTitle', 'Pick a coin');
    phPageOpen('is-coins');
    page.hidden = false;
    if (opener) opener.setAttribute('aria-expanded', 'true');
    var list = $('phCoinList');
    if (list) {
      list.scrollTop = list.scrollHeight;     /* Recent, nearest the thumb */
      try { list.focus({ preventScroll: true }); } catch (e) { /* focus is a convenience */ }
    }
  }

  function closePhCoinPage(refocus) {
    if (!cp.on) return;
    cp.on = false;
    var page = $('phCoinPage');
    if (page) page.hidden = true;
    phPageClose('is-coins');
    if (cp.opener) {
      cp.opener.setAttribute('aria-expanded', 'false');
      if (refocus) { try { cp.opener.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    }
    cp.opener = null;
  }

  /* A coin picked on the page: the ticket keeps its side and amount; the leverage is the one saved for
     that coin, capped at its max (selectMarket), and a cap that bit is said in plain words. */
  function pickPhCoin(sym) {
    var m = state.bySym[sym];
    if (!m) return;
    var was = form.lev, from = cp.from;
    selectMarket(sym);
    tourEvent('market');
    closePhCoinPage(from !== 'strip');
    if (from === 'strip') closeSheet();
    else if (was > maxLev(m)) phTicketNote(m.symbol + ' goes up to ' + maxLev(m) + 'x, so leverage is ' + form.lev + 'x.');
  }

  /* A short note about the ticket (the coin cap bit, a chip above the cap). Piece 13 puts it in the
     receipt's notice row; until then it is a quiet toast. */
  function phTicketNote(text) {
    if (!text) return;
    if (typeof phRowDNote === 'function') { phRowDNote(text); return; }
    toast(text, null, null, 4000);
  }

  /* Leaving the ticket (the sheet closes, the width changes): no page, no keypad, the inputs hidden again. */
  function phTicketReset() {
    closePhKeypad();
    closePhCoinPage(false);
    if (typeof closePhMore === 'function') closePhMore(false);
    if (typeof phDisarm === 'function') phDisarm(true);
    var t = phTicketEl();
    if (t) t.classList.remove('is-kbd-amt', 'is-kbd-lev');
  }

  function initPhTicket() {
    var pill = $('phCoinPill');
    if (pill) pill.addEventListener('click', function () { if (cp.on) closePhCoinPage(true); else openPhCoinPage('ticket', pill); });
    var back = $('phPageBack');
    if (back) back.addEventListener('click', function () { if (cp.on) closePhCoinPage(true); else if (typeof closePhMore === 'function') closePhMore(true); });
    var list = $('phCoinList');
    if (list) list.addEventListener('click', function (ev) {
      var row = ev.target && ev.target.closest ? ev.target.closest('.ph-cp-row[data-sym]') : null;
      if (row) pickPhCoin(row.getAttribute('data-sym'));
    });
    var find = $('phCoinFind');
    if (find) {
      find.addEventListener('input', buildPhCoinList);
      find.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); find.blur(); } });
    }
    var keys = $('phKeypad');
    if (keys) keys.addEventListener('click', function (ev) {
      var k = ev.target && ev.target.closest ? ev.target.closest('[data-key]') : null;
      if (k && !k.disabled) kpKey(k.getAttribute('data-key'));
    });
    var done = $('phKpDone');
    if (done) done.addEventListener('click', function () { closePhKeypad(); tourEvent(kp.mode === 'lev' ? 'lev' : 'amount'); });
    var kbd = $('phKpKbd');
    if (kbd) kbd.addEventListener('click', kpUseKeyboard);
    /* the live price on the coin page while it is open */
    onPhoneChange(function () { if (!isPhone()) phTicketReset(); });
  }

  /* ---- Piece 13: the one-screen ticket (phones, <= 640 px) --------------------------------------
     The facts first, read-only, at the top of the sheet: row A what you risk and the position, row B
     the liquidation and the move to it, row C the 1% outcome, row D the open price and timing (the
     notices take this slot, so the height never changes), row E the costs and More. The controls
     under them, in the thumb's half: the side toggle with both liquidations, the amount chips, the
     leverage ladder (base 5 / 10 / 20 / 50 / Higher; high 100 / 250 / 500 / 1000 / Custom, following
     the coin's real cap), OPEN that says the trade. Every number is renderForm's, with the targets
     moved; the maths is untouched. The arm rule is today's (CONFIRM_LEV, form.maxed, LS.noConfirm):
     on phones the first tap arms OPEN instead of opening confirmModal, the second tap goes back
     through onAction's guards and only then to submitOpen, with a 500 ms double-tap guard; the arm
     lapses after 5 s or on any change. More is a page inside the sheet that shows the real Details
     lines, the account numbers and the settings. Desktop keeps the form, Details and the modal. */

  var arm = { on: false, at: 0, key: '', timer: null };
  var ARM_MS = 5000, ARM_GUARD_MS = 500;
  var phNote = { text: '', timer: null };
  var more = { on: false, wasOpen: false, opener: null };

  function phSideWord() { return form.side === 'long' ? 'LONG' : 'SHORT'; }

  /* The receipt rows, from renderForm's own numbers (ctx: m, sz, sym, inst, px, margin, notional, isLong, win, capUsd, capped) */
  function renderPhReceipt(c) {
    var lev = form.lev;
    setText('phRcRisk', isFinite(c.margin) ? fmtUsd(c.margin) : '—');
    var qty = fmtCoinQty(c.notional, c.px, c.sym);
    setText('phRcSizeUsd', isFinite(c.notional) ? fmtUsdShort(c.notional) : '—');
    setText('phRcSizeSep', qty ? ' · ' : '');
    setText('phRcSizeQty', qty);
    phFitSize();
    var liq = bustPriceNum(c.px, c.isLong, lev);
    var liqText = 'Liquidation ' + fmtPrice(liq, c.sz) + ' · a ' + fmtMove(bustMovePct(lev)) + '% ' + (c.isLong ? 'drop' : 'rise');
    if (arm.on && isFinite(c.margin)) liqText += ': you lose ' + fmtUsdShort(c.margin);
    var b = $('phRcLiq');
    if (b) {
      b.textContent = liqText; b.classList.toggle('is-armed', arm.on);
      /* armed, the row says what is lost too; where that wraps (360 and 375 wide), one step down to 14 px keeps it one
         line, so the sheet does not grow and scroll at 360 x 640 (cf_FIX). Read only while armed. */
      b.classList.remove('is-tight');
      if (arm.on && b.offsetHeight > 30) b.classList.add('is-tight');
    }
    setText('phRcMoveK', 'If ' + (c.sym || 'the price') + (c.isLong ? ' rises' : ' falls') + ' 1%');
    var mv = $('phRcMoveV');
    if (mv) { mv.textContent = c.win && !c.win.flat ? fmtUsd(c.win.pnl, true) : '—'; mv.className = c.win && !c.win.flat && c.win.pnl > 0 ? 'pos' : ''; }
    var costs = [];
    if (c.inst && c.inst.entryDeadbandBps > 0) costs.push(pctText(c.inst.entryDeadbandBps / 1e4) + ' spread');
    costs.push(feePctText() + ' of wins');
    setText('phRcCosts', 'Costs ' + costs.join(' · '));
    /* the amount row's label and the balance beside it */
    setText('phAmtNow', isFinite(c.margin) ? fmtUsdShort(c.margin) : '—');
    setText('phAmtBal', wallet.account && acct.loaded ? fmtUsd(acct.available) : '—');
    /* the More page's open line (the spread named there, not in row D) */
    var near = c.px > 0 ? fmtPrice(c.px, c.sz) : 'the market price';
    setText('phMoreOpens', 'Opens near ' + near + (c.inst && c.inst.entryDeadbandBps > 0 ? ' plus a ' + pctText(c.inst.entryDeadbandBps / 1e4) + ' spread' : '') + ', in about ' + fillSecs() + ' s.');
    ui.phRc = { near: near, capUsd: c.capUsd, capped: c.capped };
    renderPhRowD();
  }

  /* The position line (row A) never clips. The cell is 170 px wide at 375 and 162 at 360, and Soehne
     Mono is 9 px a character at 15 px, so '$1,000 · 12,513 DOGE' (180 px) clipped to '$1,000 · 12,513 D…'
     (the tower's live check). Measured, not guessed, since the width differs by phone: 15 px on one line
     when it fits; else one step down to 14 px (the lead's line is 168 px: it fits at 375 and 390); else
     the coin amount on its own line under the dollar figure, the figure whole and first (paper.css keeps
     the row at 50 px, so You risk and every row below stay put). Cached by text, width and font state;
     fitted again once the fonts are in (initPhTicket13). Each line keeps the ellipsis as the last resort. */
  var phFit = { key: '', cls: '' };
  function phFitSize() {
    var el = $('phRcSize'), cell = el && el.parentNode, row = cell && cell.parentNode;
    if (!el || !cell || !row) return;
    var w = cell.getBoundingClientRect().width;
    if (!(w > 0)) { phFit.key = ''; return; }   /* not laid out (a page is over it): fitted when the page closes (phPageClose) */
    var key = el.textContent + '|' + Math.round(w) + '|' + (document.fonts ? document.fonts.status : '');
    var cls = phFit.cls;
    if (key !== phFit.key) {
      el.classList.remove('is-tight'); el.classList.remove('is-wrap');
      cls = '';
      if (phTextWidth(el) > w) {
        el.classList.add('is-tight');
        cls = phTextWidth(el) > w ? 'is-wrap' : 'is-tight';
        el.classList.remove('is-tight');
      }
      phFit.key = key; phFit.cls = cls;
    }
    el.classList.toggle('is-tight', cls === 'is-tight');
    el.classList.toggle('is-wrap', cls === 'is-wrap');
    cell.classList.toggle('is-wrap', cls === 'is-wrap');
    row.classList.toggle('is-wrap', cls === 'is-wrap');
  }

  /* the laid-out width of an element's text, to the fraction (scrollWidth rounds, and a half pixel over shows the ellipsis) */
  function phTextWidth(el) {
    var r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect().width;
  }

  /* Row D, one slot, by priority: the trade's problem, a market or gas notice (with 'Trade BTC instead'
     when there is one), the armed trade's win cap, a short note (a chip above the cap, the coin cap
     that bit), the paying-earlier-winners line, the win cap that binds, else the open price and timing. */
  function renderPhRowD() {
    var d = $('phRcD');
    if (!d || !isPhone()) return;
    var a = ui.phTk || {}, rc = ui.phRc || {};
    var text = '', cls = '', alt = null;
    if (a.problem && !a.setup) { text = a.problem; cls = 'is-err'; }
    else if (a.notice) { text = a.notice; cls = 'is-warn'; alt = a.alt; }
    else if (arm.on && isFinite(rc.capUsd) && rc.capped) { text = 'Wins above ' + fmtUsd(rc.capUsd) + ' are capped.'; cls = 'is-warn'; }
    else if (phNote.text) { text = phNote.text; cls = 'is-note'; }
    else if (house.queued > 0) { text = 'The house is paying earlier winners first. A win right now may be paid later.'; cls = 'is-warn'; }
    else if (rc.capped && isFinite(rc.capUsd)) { text = 'Wins above ' + fmtUsd(rc.capUsd) + ' are capped at this amount and leverage.'; cls = 'is-warn'; }
    else { text = 'Opens near ' + (rc.near || 'the market price') + ' in about ' + fillSecs() + ' s'; cls = 'is-default'; }
    var key = text + '|' + cls + '|' + (alt ? alt.symbol : '');
    if (d.getAttribute('data-key') === key) return;
    d.setAttribute('data-key', key);
    d.className = 'ph-rc-d ' + cls;
    d.textContent = '';
    d.appendChild(document.createTextNode(text));
    if (alt) {
      var b = el('button', 'ph-rc-alt', 'Trade ' + alt.symbol + ' instead');
      b.type = 'button';
      b.addEventListener('click', function () { selectMarket(alt.symbol); });
      d.appendChild(document.createTextNode(' '));
      d.appendChild(b);
    }
  }

  /* A short note in row D for a few seconds (a chip above the coin's cap, a cap that bit on a coin change). */
  function phRowDNote(text) {
    phNote.text = text || '';
    if (phNote.timer) { clearTimeout(phNote.timer); phNote.timer = null; }
    if (phNote.text) phNote.timer = setTimeout(function () { phNote.text = ''; phNote.timer = null; renderPhRowD(); }, 3500);
    renderPhRowD();
  }

  /* What OPEN says on a phone: the trade in words, or 'Tap again' while armed; setup labels stay. A
     problem leaves the hint to row D. An armed button whose trade changed is disarmed here. */
  function phActionView(v) {
    var out = { label: v.label, cls: v.cls, note: v.note, err: v.err };
    if (arm.on && armKey() !== arm.key) phDisarm(true);
    if (!v.setup) {
      if (arm.on && !v.disabled) {
        out.label = 'Tap again to open · ' + (form.maxed ? fmtUsdShort(form.margin) + ' at ' : '') + form.lev + 'x';
        out.cls += ' is-armed';
      } else if (isFinite(form.margin) && form.margin > 0) {
        out.label = 'OPEN ' + phSideWord() + ' · ' + fmtUsdShort(form.margin) + ' × ' + form.lev + 'x';
      }
      if (v.err) { out.note = ''; out.err = false; }   /* the problem is in row D */
      /* the button says the trade, so the hint keeps only what happens next */
      else out.note = String(out.note || '').replace(/^(BUY \/ LONG|SELL \/ SHORT) .*? at \d+x\.\s*/, '');
    }
    if (v.disabled && arm.on) phDisarm(true);
    return out;
  }

  function armKey() { return [state.market ? state.market.symbol : '', form.side, form.margin, form.lev, form.maxed ? 1 : 0].join('|'); }

  function phArm() {
    arm.on = true; arm.at = Date.now(); arm.key = armKey();
    if (arm.timer) clearTimeout(arm.timer);
    arm.timer = setTimeout(function () { phDisarm(false); }, ARM_MS);
    buzz([8]);
    setText('phArmLive', 'Tap again to open at ' + form.lev + 'x.');
    renderForm(); renderAction();
  }

  /* quiet: called from inside renderAction, so it must not re-enter it */
  function phDisarm(quiet) {
    if (!arm.on) return;
    arm.on = false;
    if (arm.timer) { clearTimeout(arm.timer); arm.timer = null; }
    setText('phArmLive', '');
    if (!quiet) { renderForm(); renderAction(); }
    else renderForm();
  }

  /* The More page: the real Details lines (the element stays in the DOM for desktop), the open line,
     the account numbers, the auto-finish box, the big-trade "don't ask" (LS.noConfirm) and the session row. */
  function openPhMore(opener) {
    if (!isPhone() || more.on) return;
    more.on = true; more.opener = opener || null;
    var d = $('detailsBox');
    if (d) { more.wasOpen = d.open; more.setting = true; d.open = true; more.setting = false; }
    var chk = $('phNoConfirm');
    if (chk) chk.checked = lsGet(LS.noConfirm) === '1';
    var box = $('phMore'), top = $('phMoreTop');
    if (box) box.hidden = false;
    if (top) top.hidden = false;
    setText('phPageTitle', 'About this trade');
    phPageOpen('is-more');
    if (opener) opener.setAttribute('aria-expanded', 'true');
    var f = $('orderForm');
    if (f) f.scrollTop = 0;
  }

  function closePhMore(refocus) {
    if (!more.on) return;
    more.on = false;
    var d = $('detailsBox');
    if (d) { more.setting = true; d.open = more.wasOpen; more.setting = false; }
    var box = $('phMore'), top = $('phMoreTop');
    if (box) box.hidden = true;
    if (top) top.hidden = true;
    phPageClose('is-more');
    if (more.opener) {
      more.opener.setAttribute('aria-expanded', 'false');
      if (refocus) { try { more.opener.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    }
    more.opener = null;
  }

  /* The account numbers and the owed line on the More page (renderAccount's words, copied) */
  function renderPhMoreAcct(owedText) {
    var box = $('phMore');
    if (!box) return;
    var copy = function (c, id) { var n = box.querySelector(c), s = $(id); if (n && s) { if (n.textContent !== s.textContent) n.textContent = s.textContent; n.className = c.slice(1) + (s.className ? ' ' + s.className : ''); } };
    copy('.js-more-bal', 'eqAvailable');
    copy('.js-more-margin', 'eqMargin');
    copy('.js-more-pnl', 'eqPnl');
    var o = box.querySelector('.js-more-owed');
    if (o) { o.hidden = !owedText; if (owedText && o.textContent !== owedText) o.textContent = owedText; }
  }

  function initPhTicket13() {
    var mb = $('phMoreBtn');
    if (mb) mb.addEventListener('click', function () { if (more.on) closePhMore(true); else openPhMore(mb); });
    /* the position line is fitted against the fonts on screen: once they are in, fit it again */
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (isPhone()) renderForm(); }, function () { /* none */ });
    var chk = $('phNoConfirm');
    if (chk) chk.addEventListener('change', function () { lsSet(LS.noConfirm, chk.checked ? '1' : '0'); });
    /* a tap on a leverage chip above the coin's cap: the reason in row D */
    var chips = $('levChips');
    if (chips) chips.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('.lev-over') : null;
      if (!b || !state.market) return;
      ev.stopPropagation();
      phRowDNote(state.market.symbol + ' goes up to ' + maxLev(state.market) + 'x.');
    }, true);
  }

  /* ---- Build 8: the compact header's account button and its Menu and Account sheets ---- */

  /* "$50.00"; past $10,000 "$12.3K", so the header row fits a 360 px phone */
  function fmtUsdHead(n) { return Math.abs(n) >= 1e4 ? fmtUsdK(n) : fmtUsd(n); }

  function renderPhAcct() {
    var b = $('phAcct');
    if (!b) return;
    var c = $('connectBtn');
    var mode, txt;
    if (!wallet.account) { mode = 'out'; txt = c ? c.textContent : 'Connect'; }
    else if (wallet.chainId !== CHAIN_ID) { mode = 'warn'; txt = c ? c.textContent : shortAddr(wallet.account); }
    else if (hasExchange() && acct.loaded) { mode = 'in'; txt = fmtUsdHead(acct.available); }
    else { mode = 'in'; txt = shortAddr(wallet.account); }
    var t = $('phAcctTxt');
    if (t && t.textContent !== txt) t.textContent = txt;
    b.classList.toggle('is-out', mode === 'out');
    b.classList.toggle('is-warn', mode === 'warn');
    /* an address is wider than a balance: the points pill drops its second word so the wordmark stays whole (cf_FIX) */
    b.classList.toggle('is-addr', !!wallet.account && mode !== 'out' && txt === shortAddr(wallet.account));
    var owed = !!(wallet.account && acct.loaded && acct.owed > 0);
    b.classList.toggle('has-owed', owed);
    var label = mode === 'out' ? txt : mode === 'warn' ? 'Account ' + txt + ': wrong network' : 'Account: balance ' + txt + (owed ? ', ' + fmtUsd(acct.owed) + ' owed to you' : '');
    if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
    b.setAttribute('aria-haspopup', mode === 'out' ? 'false' : 'dialog');
  }

  /* The Account sheet: the ticket strip's three numbers, the owed line, Deposit / Withdraw, the address. */
  function renderPhAccount(owedText) {
    var d = $('phAcctSheet');
    if (!d) return;
    var q = function (c) { return d.querySelector(c); };
    var copy = function (c, id) { var n = q(c), s = $(id); if (n && s) { n.textContent = s.textContent; n.className = c.slice(1) + (s.className ? ' ' + s.className : ''); } };
    copy('.js-ph-bal', 'eqAvailable');
    copy('.js-ph-margin', 'eqMargin');
    copy('.js-ph-pnl', 'eqPnl');
    var o = q('.js-ph-owed');
    if (o) { o.hidden = !owedText; if (owedText && o.textContent !== owedText) o.textContent = owedText; }
    var a = q('.js-ph-addr');
    if (a) { a.textContent = wallet.account ? shortAddr(wallet.account) : '—'; a.title = wallet.account || ''; }
    var ex = q('.js-ph-explorer');
    if (ex && wallet.account) ex.href = explorer('address', wallet.account);
    renderPhAcct();
  }

  function openPhSheet(id, opener) {
    var d = $(id);
    if (!d || !isPhone()) return;
    d._opener = opener || null;
    if (opener) opener.setAttribute('aria-expanded', 'true');
    openDialog(id);
  }

  function initPhoneHeader() {
    var ab = $('phAcct'), cb = $('connectBtn');
    if (ab) ab.addEventListener('click', function () {
      if (!wallet.account) { if (cb) cb.click(); return; }
      renderAccount();
      openPhSheet('phAcctSheet', ab);
    });
    /* every Connect / Connecting / wrong-network label the header button gets reaches the phone's */
    if (cb && typeof MutationObserver === 'function') new MutationObserver(renderPhAcct).observe(cb, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    var d = $('phAcctSheet');
    if (d) {
      var on = function (c, fn) { var n = d.querySelector(c); if (n) n.addEventListener('click', fn); };
      var thenClose = function (fn) { return function () { closeDialog('phAcctSheet'); fn(); }; };
      on('.js-ph-dep', thenClose(openDeposit));
      on('.js-ph-wd', thenClose(function () { tourEvent('withdraw'); openWithdraw(); }));
      on('.js-ph-copy', function () { if (wallet.account) copyText(wallet.account, function () { toast('Copied ' + shortAddr(wallet.account) + '.'); }); });
      on('.js-ph-disc', thenClose(function () { if (DEMO) { toast('Demo account: nothing here is real and nothing is sent.'); return; } disconnect(); }));
    }
    ['phMenuSheet', 'phAcctSheet', 'phPosSheet'].forEach(function (id) {
      var s = $(id);
      if (s) s.addEventListener('close', function () {
        if (s._opener) { s._opener.setAttribute('aria-expanded', 'false'); try { s._opener.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
        s._opener = null;
      });
    });
    /* the page you are on: its row just closes the sheet */
    var ms = $('phMenuSheet');
    if (ms) ms.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[aria-current="page"]') : null;
      if (a) { ev.preventDefault(); closeDialog('phMenuSheet'); }
    });
    renderPhAcct();
  }

  /* ---- Build 10: Your positions as 64 px rows, and the live P&L strip on the bar ---- */

  var PH_ROWS_MAX = 3;

  function phBusy(pid) { return !!(acct.closeReqs[pid] || ui.closing[pid] || ui.settling[pid] || ui.checking[pid] || ui.retrying[pid]); }

  /* The position cards in newest-first order, as the cards are */
  function phList() {
    if (!wallet.account || !acct.loaded) return [];
    return acct.positions.slice().sort(function (a, b) { return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; }).map(function (p) {
      var px = closePriceFor(p);
      var room = liqRoom(p, px);
      var full = bustMovePct(p.leverage) / 100;
      return { p: p, pid: String(p.id), px: px, room: room, est: positionEstimate(p), share: isFinite(room.away) && full > 0 ? clamp(room.away / full, 0, 1) : NaN };
    });
  }

  function phNearest(list) {
    var best = null;
    list.forEach(function (it) { if (!phBusy(it.pid) && isFinite(it.room.away) && (!best || it.room.away < best.room.away)) best = it; });
    return best;
  }

  function fmtAway(away) { return (away * 100).toFixed(away >= 0.01 ? 1 : 2) + '%'; }

  /* A row is one button: it opens the Position sheet (piece 11), which holds the details and Close. */
  function phRowEl(it) {
    var b = el('button', 'ph-row');
    b.type = 'button';
    b.setAttribute('data-pid', it.pid);
    b.setAttribute('aria-haspopup', 'dialog');
    var who = el('span', 'ph-row-who');
    var m = positionMarket(it.p);
    who.appendChild(el('span', 'ph-side', it.p.isLong ? 'LONG' : 'SHORT'));
    who.appendChild(el('span', 'ph-sym', m ? m.symbol : 'Market ' + it.p.instrumentId));
    who.appendChild(el('span', 'ph-lev', it.p.leverage + 'x'));
    b.appendChild(who);
    var money = el('span', 'ph-money');
    var n = el('span', 'ph-pnl-n', '—'); n.setAttribute('data-role', 'pnl');
    var pc = el('span', 'ph-pct'); pc.setAttribute('data-role', 'pct');
    money.appendChild(n); money.appendChild(pc);
    b.appendChild(money);
    var liq = el('span', 'ph-row-liq'); liq.setAttribute('data-role', 'liqrow');
    var bar = el('span', 'ph-bar'); bar.setAttribute('aria-hidden', 'true'); bar.appendChild(el('i'));
    liq.appendChild(bar);
    var away = el('span', 'ph-away'); away.setAttribute('data-role', 'away');
    liq.appendChild(away);
    b.appendChild(liq);
    /* the row is the only way to Close on a phone and it read as a P&L line: it says so (the sheet it opens
       still asks, so the word never closes anything on its own) */
    var go = el('span', 'ph-row-go'); go.setAttribute('data-role', 'go');
    go.appendChild(document.createTextNode('Close'));
    var ch = el('i', 'ph-row-chev', '›'); ch.setAttribute('aria-hidden', 'true'); go.appendChild(ch);
    b.appendChild(go);
    var note = el('span', 'ph-row-note'); note.setAttribute('data-role', 'note'); note.hidden = true;
    b.appendChild(note);
    /* the 3 px line under the status sentence that fills over fillSecs while a close is in flight */
    var prog = el('span', 'ph-row-prog'); prog.setAttribute('data-role', 'prog'); prog.setAttribute('aria-hidden', 'true'); prog.hidden = true;
    prog.appendChild(el('i'));
    b.appendChild(prog);
    b.classList.add(it.p.isLong ? 'is-long' : 'is-short');
    return b;
  }

  function fillPhRow(row, it, nearest, many) {
    var p = it.p, m = positionMarket(p), sz = m ? m.szDecimals : null;
    var est = it.est, known = isFinite(it.px) || !!p.preview;
    var cls = est && est.pnl > 0 ? ' pos' : est && est.pnl < 0 ? ' neg' : '';
    var n = setRole(row, 'pnl', known ? fmtUsd(est.pnl, true) : '—');
    if (n) n.className = 'ph-pnl-n' + (known ? cls : '');
    var pc = setRole(row, 'pct', known ? fmtPct1(est.pnl / p.margin) : '');
    if (pc) pc.className = 'ph-pct' + (known ? cls : '');
    var busy = phBusy(it.pid);
    var goEl = row.querySelector('[data-role="go"]'); if (goEl) goEl.hidden = busy;
    var liqRow = row.querySelector('[data-role="liqrow"]'), note = row.querySelector('[data-role="note"]'), prog = row.querySelector('[data-role="prog"]');
    var st = busy ? closeStatus(it.pid, p) || { text: 'Closing…', tone: '', share: 0 } : null;
    if (st) {
      /* the status slot: one sentence, the 3 px line that fills over fillSecs, and the action the
         sheet offers when one is needed (the row opens the sheet) */
      if (note) {
        var k = st.text + '|' + (st.btn || '') + '|' + st.tone;
        if (note.getAttribute('data-k') !== k) {
          note.setAttribute('data-k', k);
          note.textContent = '';
          note.appendChild(document.createTextNode(st.text + (st.btn ? ' ' : '')));
          if (st.btn) note.appendChild(el('b', 'ph-row-act', st.btn));
          note.className = 'ph-row-note' + (st.tone ? ' is-' + st.tone : '');
        }
        note.hidden = false;
      }
      if (prog) {
        prog.hidden = false;
        prog.className = 'ph-row-prog' + (st.tone ? ' is-' + st.tone : '');
        if (prog.firstChild) prog.firstChild.style.width = Math.round((isFinite(st.share) ? st.share : 1) * 100) + '%';
      }
      if (liqRow) liqRow.hidden = true;
    } else {
      if (note) note.hidden = true;
      if (prog) prog.hidden = true;
      if (liqRow) liqRow.hidden = false;
      var bar = row.querySelector('.ph-bar'), fill = bar && bar.firstChild;
      var tone = it.room.cls === 'is-red' ? 'is-red' : it.room.cls === 'is-amber' ? 'is-amber' : '';
      if (bar) bar.className = 'ph-bar' + (tone ? ' ' + tone : '');
      if (fill) fill.style.width = isFinite(it.share) ? (it.share * 100).toFixed(1) + '%' : '0%';
      var a = setRole(row, 'away', isFinite(it.room.away) ? fmtAway(it.room.away) + ' away' + (many && nearest === it ? ' · nearest' : '') : 'Liquidation —');
      if (a) a.className = 'ph-away' + (tone ? ' ' + tone : '');
    }
    row.classList.toggle('is-near', !busy && it.room.cls === 'is-red');
    row.setAttribute('aria-expanded', phSheetFor(it.pid) ? 'true' : 'false');
    /* every money fact the sheet has, for a screen reader; the sheet itself is one tap away */
    var label = sideWord(p.isLong) + ' ' + (m ? m.symbol : 'market ' + p.instrumentId) + ' ' + p.leverage + 'x. ' +
      (known ? 'P&L ' + fmtUsd(est.pnl, true) + ', ' + fmtPct1(est.pnl / p.margin) + '. ' : '') +
      'Entry ' + fmtPrice(p.entry, sz) + ', now ' + (isFinite(it.px) ? fmtPrice(it.px, sz) : 'unknown') +
      ', liquidation ' + fmtPrice(it.room.liq, sz) + (isFinite(it.room.away) ? ', ' + fmtAway(it.room.away) + ' away' : '') +
      '. Put in ' + fmtUsd(p.margin) + ', size ' + fmtUsd(p.margin * p.leverage) + '.' + (st ? ' ' + st.text : ' Tap to see it or close it.');
    if (row.getAttribute('aria-label') !== label) row.setAttribute('aria-label', label);
  }

  function renderPhRows() {
    var host = $('phRows'), head = $('phPosHead');
    if (!host || !head) return;
    var list = phList();
    var n = list.length;
    head.hidden = !wallet.account || !hasExchange() || !acct.loaded || (!n && !pendingOpenList().length);
    var sum = $('phPosSum');
    if (sum) {
      var pnl = openPnl();
      var key = n + '|' + (isFinite(pnl) ? fmtUsd(pnl, true) : '-');
      if (sum.getAttribute('data-k') !== key) {
        sum.setAttribute('data-k', key);
        sum.textContent = '';
        if (!n) sum.textContent = 'Your positions';
        else {
          sum.appendChild(document.createTextNode('Open ' + n + ' · P&L '));
          var b = el('b', isFinite(pnl) ? (pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '') : '', isFinite(pnl) ? fmtUsd(pnl, true) : '—');
          sum.appendChild(b);
        }
      }
    }
    /* Close all whenever two or more can be closed (closeAll skips the ones already closing) */
    var closable = list.filter(function (it) { return !phBusy(it.pid); }).length;
    var ca = $('phCloseAll');
    if (ca) { ca.hidden = closable < 2; ca.disabled = state.busy; }
    /* a position past the first three whose close needs a tap (Finish now, Try again) shows them all */
    if (n > PH_ROWS_MAX && !ui.phMore && list.slice(PH_ROWS_MAX).some(function (it) { var st = closeStatus(it.pid, it.p); return !!(st && st.btn); })) ui.phMore = true;
    var many = n > PH_ROWS_MAX && !ui.phMore;
    var shown = many ? list.slice(0, PH_ROWS_MAX) : list;
    var rest = n - shown.length;
    var sig = shown.map(function (it) { return it.pid; }).join(',') + '|' + rest;
    if (host.getAttribute('data-sig') !== sig) {
      host.setAttribute('data-sig', sig);
      host.textContent = '';
      shown.forEach(function (it) {
        var row = phRowEl(it); host.appendChild(row);
        if (isPhone() && fx.fresh[it.pid]) { delete fx.fresh[it.pid]; if (!reducedMotion()) row.classList.add('is-fresh'); }
      });
      if (rest > 0) {
        var more = el('button', 'ph-row is-more');
        more.type = 'button';
        more.setAttribute('data-more', '1');
        host.appendChild(more);
      }
    }
    var nearest = phNearest(list);
    shown.forEach(function (it) {
      var row = host.querySelector('.ph-row[data-pid="' + it.pid + '"]');
      if (row) fillPhRow(row, it, nearest, n > 2);
    });
    var mr = host.querySelector('[data-more]');
    if (mr) {
      var hid = nearest && shown.indexOf(nearest) < 0;
      var t = 'Show ' + rest + ' more' + (hid ? ' · nearest liquidation ' + fmtAway(nearest.room.away) : '');
      if (mr.textContent !== t) mr.textContent = t;
    }
    /* a result neither a row nor the sheet needs any more */
    Object.keys(ui.phResult).forEach(function (pid) { if (!posById(pid) && !(ui.phSheet && ui.phSheet.pid === pid)) delete ui.phResult[pid]; });
    renderPhSheet();
    /* trade.html#pos=<id> (Portfolio's rows, piece 12): that position's sheet once the account is
       in; when the id is gone, nothing happens */
    if (ui.phDeepLink && wallet.account && acct.loaded) {
      var dl = ui.phDeepLink, dp = posById(dl);
      ui.phDeepLink = null;
      if (isPhone() && dp) {
        /* the chart behind the sheet shows that position's coin (selectMarket swaps the hash for the symbol) */
        var dm = positionMarket(dp);
        if (dm && (!state.market || state.market.symbol !== dm.symbol)) selectMarket(dm.symbol);
        openPhPosSheet(dl, phRowFor(dl));
      }
    }
    renderPhPnl();
  }

  function onPhRowTap(ev) {
    var row = ev.target && ev.target.closest ? ev.target.closest('.ph-row') : null;
    if (!row) return;
    if (row.hasAttribute('data-more')) { ui.phMore = true; renderPhRows(); return; }
    openPhPosSheet(row.getAttribute('data-pid'), row);
  }

  /* The live P&L strip: on the bar whenever the "Open 2 · P&L" row is out of view, so total P&L is
     on screen exactly once. It takes the ticket's one-line progress (#barStatus) into its middle. */
  function renderPhPnl() {
    var s = $('phPnl');
    if (!s) return;
    var list = phList();
    var n = list.length;
    var show = isPhone() && n > 0 && !ui.phHeadInView && !ui.sheet;
    var bar = $('mobileBar');
    s.hidden = !show;
    if (bar) bar.classList.toggle('has-ph-pnl', show);
    document.body.classList.toggle('ph-pnl-on', show);
    if (!show) return;
    var pnl = openPnl();
    var v = $('phPnlV');
    if (v) {
      var t = isFinite(pnl) ? fmtUsd(pnl, true) : '—';
      if (v.textContent !== t) v.textContent = t;
      v.className = 'ph-pnl-v' + (pnl > 0 ? ' pos' : pnl < 0 ? ' neg' : '');
    }
    var closing = list.filter(function (it) { return phBusy(it.pid); }).length;
    var bs = $('barStatus');
    var mid, done = false;
    if (ui.phClosed && Date.now() < ui.phClosed.until) { mid = ui.phClosed.text; done = true; }
    else if (bs && !bs.hidden && bs.textContent) mid = bs.textContent;
    else if (closing) mid = 'Closing ' + closing + '…';
    else mid = n + ' open';
    var md = $('phPnlMid');
    if (md) { if (md.textContent !== mid) md.textContent = mid; md.className = 'ph-pnl-mid' + (done ? ' is-done' : ''); }
    s.classList.toggle('is-closing', !!closing && !done);
    var nearest = phNearest(list);
    var lq = $('phPnlLiq');
    if (lq) lq.hidden = done || !nearest;
    if (nearest && !done) {
      var tone = nearest.room.cls === 'is-red' ? 'is-red' : nearest.room.cls === 'is-amber' ? 'is-amber' : '';
      var pb = $('phPnlBar');
      if (pb) { pb.className = 'ph-bar' + (tone ? ' ' + tone : ''); if (pb.firstChild) pb.firstChild.style.width = isFinite(nearest.share) ? (nearest.share * 100).toFixed(1) + '%' : '0%'; }
      var aw = $('phPnlAway');
      if (aw) { var at = fmtAway(nearest.room.away); if (aw.textContent !== at) aw.textContent = at; aw.className = 'ph-away' + (tone ? ' ' + tone : ''); }
    }
    var label = 'P&L ' + (isFinite(pnl) ? fmtUsd(pnl, true) : 'unknown') + ', ' + mid + (nearest && !done ? ', nearest liquidation ' + fmtAway(nearest.room.away) + ' away' : '') + '. Show your positions.';
    if (s.getAttribute('aria-label') !== label) s.setAttribute('aria-label', label);
  }

  function onPhPnlTap() {
    if (tk.phase === 'opened') { var id = tk.posId; tkReset(); showNewPosition(id); return; }
    if (tk.phase && !ui.phClosed) { openSheet(); return; }
    var h = $('phPosHead');
    if (h && h.scrollIntoView) h.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    var nearest = phNearest(phList());
    var row = nearest ? document.querySelector('#phRows .ph-row[data-pid="' + nearest.pid + '"]') : null;
    if (row && !reducedMotion()) { row.classList.remove('is-flash'); void row.offsetWidth; row.classList.add('is-flash'); setTimeout(function () { row.classList.remove('is-flash'); }, 260); }
  }

  function initPhonePositions() {
    var rows = $('phRows');
    if (rows) rows.addEventListener('click', onPhRowTap);
    var ca = $('phCloseAll');
    if (ca) ca.addEventListener('click', closeAll);
    initPhPosSheet();
    var s = $('phPnl');
    if (s) s.addEventListener('click', onPhPnlTap);
    var h = $('phPosHead');
    if (h && typeof IntersectionObserver === 'function') {
      new IntersectionObserver(function (entries) {
        ui.phHeadInView = entries.some(function (e) { return e.isIntersecting; });
        renderPhPnl();
      }, { rootMargin: '-48px 0px 0px 0px' }).observe(h);
    }
    onPhoneChange(function () { renderPhRows(); });
  }

  /* ---- Piece 11: the Position sheet. A row's details and the close check in one: the money
     coming back sits over the Close button, and Close all uses the same sheet with the count and
     the total. Close calls submitClose unchanged: the sheet is the phone's in-app check (desktop
     CLOSE POSITION is as before). While a close is in flight the button pair gives way to the
     status slot, the figures stay as they were at the tap, and the settle step shows the real
     payout. The rows carry the same status sentence. ---- */

  function phRowFor(pid) { return document.querySelector('#phRows .ph-row[data-pid="' + String(pid) + '"]'); }

  /* The sheet when it is open on this position, else null. */
  function phSheetFor(pid) {
    var d = $('phPosSheet');
    return d && d.open && ui.phSheet && ui.phSheet.mode === 'pos' && ui.phSheet.pid === String(pid) ? d : null;
  }

  /* One sentence for a close in flight, with its tone ('' is the close blue; warn, bad, done,
     plain), the button the trader may need (Finish now, Try again), the note under it and how far
     the fill countdown has run (0..1). The row's second line and the sheet's status slot say what
     the card's progress steps say. null while the position is idle. */
  function closeStatus(pid, p) {
    pid = String(pid);
    var cr = acct.closeReqs[pid], res = ui.phResult[pid];
    if (res) {
      if (res.liq || !posById(pid)) return resultStatus(res);
      return { text: 'Closed. Adding ' + fmtUsd(res.paid) + ' to your balance…', tone: 'done', share: 1 };
    }
    if (ui.retrying[pid] && !ui.closing[pid]) return { text: 'Getting ready to close again…', tone: '', share: 0 };
    if (cr) {
      var v = progressView('close', cr, p ? p.margin : 0);
      var on = (v.steps || []).filter(function (s) { return /is-on/.test(s[1]); })[0];
      var left = cr.requestedAt != null ? cr.requestedAt + fillSecs() - chainNow() : fillSecs();
      var text = on ? on[0] : 'Closing…', note = v.note || '';
      /* the slow state reads as one sentence ('Still closing. Your wallet will ask you to finish
         it.'); the money rule stays as the note under it */
      if (v.cls === 'is-late' && /^Your wallet will ask/.test(note)) {
        var cut = note.indexOf('. ');
        if (cut > 0) { text += ' ' + note.slice(0, cut + 1); note = note.slice(cut + 2); }
      }
      return {
        text: text, tone: v.cls === 'is-bad' ? 'bad' : v.cls === 'is-late' ? 'warn' : '',
        btn: v.btn || '', note: note, share: clamp(1 - left / fillSecs(), 0, 1)
      };
    }
    if (ui.closing[pid]) return { text: state.viaSession ? 'Sending…' : 'Confirm in your wallet…', tone: '', share: 0 };
    if (ui.checking[pid]) return { text: 'Checking the result…', tone: '', share: 1 };
    if (ui.settling[pid]) return { text: 'Closed. Adding it to your balance…', tone: 'done', share: 1 };
    return null;
  }

  /* The end of a close, in the chain's own figures. */
  function resultStatus(res) {
    if (res.liq) return { text: 'Liquidated at ' + res.exit + '. You lost the ' + fmtUsdShort(res.lost) + ' you put in. Nothing more is owed.', tone: 'bad', share: 1, final: true };
    return { text: 'Closed. ' + fmtUsd(res.paid) + ' is back in your balance.', tone: res.pnl > 0 ? 'done' : 'plain', share: 1, final: true };
  }

  function openPhPosSheet(pid, opener) {
    pid = String(pid);
    if (!isPhone() || !$('phPosSheet') || (!posById(pid) && !ui.phResult[pid])) return;
    ui.phSheet = { mode: 'pos', pid: pid, p: posById(pid) };
    openPhSheet('phPosSheet', opener);
    renderPhRows();
  }

  /* Close all's check on a phone: the same sheet with the count and the total. Resolves like
     askConfirm: true on Close all, false on Keep open, the cross, a swipe down, Esc or the scrim. */
  function askPhCloseAll(list) {
    return new Promise(function (resolve) {
      ui.phSheet = { mode: 'all', ids: list.map(function (p) { return String(p.id); }), resolve: resolve };
      openPhSheet('phPosSheet', $('phCloseAll'));
      renderPhRows();
    });
  }

  function phq(d, c) { return d.querySelector(c); }
  function phShow(d, c, on) { var n = phq(d, c); if (n) n.hidden = !on; return n; }
  function phText(d, c, t) { var n = phq(d, c); if (n && n.textContent !== t) n.textContent = t; return n; }
  function phCls(d, c, k) { var n = phq(d, c); if (n && n.className !== k) n.className = k; return n; }

  /* Every render pass (prices, the countdown tick) redraws the open sheet in place. */
  function renderPhSheet() {
    var d = $('phPosSheet'), s = ui.phSheet;
    if (!d || !s || !d.open) return;
    if (s.mode === 'all') { renderPhSheetAll(d, s); return; }
    var pid = s.pid, p = posById(pid), res = ui.phResult[pid];
    if (p) s.p = p; else p = s.p;
    if (!p || (!posById(pid) && !res)) { closeDialog('phPosSheet'); return; }
    var m = positionMarket(p), sz = m ? m.szDecimals : null;
    var st = closeStatus(pid, p);
    if (!st) delete ui.phFrozen[pid];
    var fz = ui.phFrozen[pid];
    var px = fz ? fz.px : closePriceFor(p);
    var est = fz ? fz.est : positionEstimate(p);
    var room = fz ? fz.room : liqRoom(p, px);
    var known = isFinite(px) || !!p.preview;
    var fin = !!(st && st.final);
    /* head: side tag, coin, leverage */
    phCls(d, '.js-ps-who', 'ph-ps-who js-ps-who ' + (p.isLong ? 'is-long' : 'is-short'));
    phText(d, '.js-ps-side', p.isLong ? 'LONG' : 'SHORT');
    phShow(d, '.js-ps-side', true);
    phText(d, '.js-ps-sym', m ? m.symbol : 'Market ' + p.instrumentId);
    phText(d, '.js-ps-lev', p.leverage + 'x');
    phShow(d, '.js-ps-lev', true);
    /* P&L: live; as it was at the tap while the close is in flight; the real figure once closed */
    var pnl = fin ? (res.liq ? -res.lost : res.pnl) : est.pnl;
    var have = known || fin;
    var tone = have ? (pnl > 0 ? ' pos' : pnl < 0 ? ' neg' : '') : '';
    phShow(d, '.js-ps-pnlrow', true);
    phText(d, '.js-ps-pnl', have ? fmtUsd(pnl, true) : '—');
    phCls(d, '.js-ps-pnl', 'ph-ps-pnl-n js-ps-pnl' + tone);
    phText(d, '.js-ps-pct', have ? fmtPct1(pnl / p.margin) : '');
    phCls(d, '.js-ps-pct', 'ph-ps-pct js-ps-pct' + tone);
    /* the liquidation bar and the distance, in the row's colours; gone once the position has closed */
    phShow(d, '.js-ps-liqblock', !fin);
    if (!fin) {
      var full = bustMovePct(p.leverage) / 100;
      var share = isFinite(room.away) && full > 0 ? clamp(room.away / full, 0, 1) : NaN;
      var lt = room.cls === 'is-red' ? 'is-red' : room.cls === 'is-amber' ? 'is-amber' : '';
      var bar = phq(d, '.js-ps-bar');
      if (bar) { bar.className = 'ph-bar js-ps-bar' + (lt ? ' ' + lt : ''); if (bar.firstChild) bar.firstChild.style.width = isFinite(share) ? (share * 100).toFixed(1) + '%' : '0%'; }
      phText(d, '.js-ps-liq', fmtPrice(room.liq, sz));
      phText(d, '.js-ps-away', isFinite(room.away) ? fmtAway(room.away) + ' away' : '');
      phCls(d, '.js-ps-away', 'ph-away js-ps-away' + (lt ? ' ' + lt : ''));
    }
    /* Entry, Now (the close price once closed), Put in, Size: today's card rows */
    phShow(d, '.js-ps-grid', true);
    phShow(d, '.js-ps-list', false);
    phText(d, '.js-ps-entry', fmtPrice(p.entry, sz));
    phText(d, '.js-ps-nowk', fin ? (res.liq ? 'Liquidated at' : 'Closed at') : 'Now');
    phText(d, '.js-ps-now', fin ? res.exit : isFinite(px) ? fmtPrice(px, sz) : '—');
    phText(d, '.js-ps-margin', fmtUsd(p.margin));
    phText(d, '.js-ps-size', fmtUsd(p.margin * p.leverage));
    /* the money coming back: the estimate until the close lands, then the real amount */
    phShow(d, '.js-ps-back', !(fin && res.liq));
    phText(d, '.js-ps-backk', fin ? 'Back in your balance' : 'You get back about');
    phText(d, '.js-ps-est', fin ? fmtUsd(res.paid) : known ? fmtUsd(est.payout) : '—');
    /* the one muted line */
    var note = !st ? 'Closes at the price a few seconds after you tap, about ' + fillSecs() + ' s.' + (sessionLive() ? '' : ' Your wallet asks next.')
      : fin ? '' : 'The figures are from the moment you tapped.';
    phText(d, '.js-ps-note', note);
    phShow(d, '.js-ps-note', !!note);
    /* Keep open and Close, or the status slot in their place */
    phShow(d, '.js-ps-pair', !st);
    phShow(d, '.js-ps-status', !!st);
    phShow(d, '.js-ps-tpsl', !st && !!posById(pid));
    if (!st) {
      try { tpslPhSheet(d, pid, p); } catch (e) { /* never blocks the sheet */ }
      phText(d, '.js-ps-keep', 'Keep open');
      var cb = phq(d, '.js-ps-close');
      if (cb) {
        var lbl = 'Close' + (known ? ' · about ' + fmtUsdHead(est.payout) : '');
        if (cb.textContent !== lbl) cb.textContent = lbl;
        cb.disabled = state.busy;
      }
      return;
    }
    renderPhStatus(d, st, fin);
  }

  /* The status slot: the sentence, the 3 px line, the note, and Finish now / Try again or Done. */
  function renderPhStatus(d, st, fin) {
    phCls(d, '.js-ps-status', 'ph-ps-status js-ps-status' + (st.tone ? ' is-' + st.tone : ''));
    phText(d, '.js-ps-line', st.text);
    var pr = phq(d, '.js-ps-prog');
    if (pr && pr.firstChild) pr.firstChild.style.width = Math.round((isFinite(st.share) ? st.share : 1) * 100) + '%';
    phShow(d, '.js-ps-sub', !!st.note);
    if (st.note) phText(d, '.js-ps-sub', st.note);
    var act = phq(d, '.js-ps-act');
    if (act) { act.hidden = !st.btn; if (st.btn && act.textContent !== st.btn) act.textContent = st.btn; act.disabled = state.busy; }
    phShow(d, '.js-ps-done', fin);
    phShow(d, '.js-ps-actrow', !!st.btn || fin);
  }

  /* Close all: the count, each position with its P&L, the total coming back, one check. */
  function renderPhSheetAll(d, s) {
    var list = s.ids.map(posById).filter(function (p) { return p && !phBusy(String(p.id)); });
    if (!list.length) { closeDialog('phPosSheet'); return; }
    var back = 0, pnl = 0, margin = 0, any = false;
    list.forEach(function (p) {
      var e = positionEstimate(p);
      if (e && isFinite(e.payout)) { back += e.payout; pnl += e.pnl; any = true; }
      margin += p.margin;
    });
    phCls(d, '.js-ps-who', 'ph-ps-who js-ps-who');
    phShow(d, '.js-ps-side', false);
    phShow(d, '.js-ps-lev', false);
    phText(d, '.js-ps-sym', 'Close ' + list.length + ' position' + (list.length === 1 ? '' : 's') + '?');
    var tone = any ? (pnl > 0 ? ' pos' : pnl < 0 ? ' neg' : '') : '';
    phShow(d, '.js-ps-pnlrow', true);
    phText(d, '.js-ps-pnl', any ? fmtUsd(pnl, true) : '—');
    phCls(d, '.js-ps-pnl', 'ph-ps-pnl-n js-ps-pnl' + tone);
    phText(d, '.js-ps-pct', any && margin > 0 ? fmtPct1(pnl / margin) : '');
    phCls(d, '.js-ps-pct', 'ph-ps-pct js-ps-pct' + tone);
    phShow(d, '.js-ps-liqblock', false);
    phShow(d, '.js-ps-grid', false);
    var host = phShow(d, '.js-ps-list', true);
    if (host) {
      var sig = list.map(function (p) { return String(p.id); }).join(',');
      if (host.getAttribute('data-sig') !== sig) {
        host.setAttribute('data-sig', sig);
        host.textContent = '';
        list.forEach(function (p) {
          var m = positionMarket(p);
          var r = el('div', 'ph-ps-item ' + (p.isLong ? 'is-long' : 'is-short'));
          r.setAttribute('data-pid', String(p.id));
          r.appendChild(el('span', 'ph-side', p.isLong ? 'LONG' : 'SHORT'));
          r.appendChild(el('span', 'ph-sym', m ? m.symbol : 'Market ' + p.instrumentId));
          r.appendChild(el('span', 'ph-lev', p.leverage + 'x'));
          r.appendChild(el('b', '', '—'));
          host.appendChild(r);
        });
      }
      list.forEach(function (p) {
        var r = host.querySelector('[data-pid="' + String(p.id) + '"]'), b = r && r.querySelector('b');
        var e = positionEstimate(p);
        if (b) { var t = e && isFinite(e.pnl) ? fmtUsd(e.pnl, true) : '—'; if (b.textContent !== t) b.textContent = t; b.className = e && e.pnl > 0 ? 'pos' : e && e.pnl < 0 ? 'neg' : ''; }
      });
    }
    phShow(d, '.js-ps-back', true);
    phText(d, '.js-ps-backk', 'You get back about');
    phText(d, '.js-ps-est', any ? fmtUsd(back) : '—');
    phText(d, '.js-ps-note', 'Each one closes at the price a few seconds after you tap, about ' + fillSecs() + ' s.' + (sessionLive() ? '' : ' Your wallet asks once for each.'));
    phShow(d, '.js-ps-note', true);
    phShow(d, '.js-ps-pair', true);
    phShow(d, '.js-ps-status', false);
    phText(d, '.js-ps-keep', 'Keep open');
    var cb = phq(d, '.js-ps-close');
    if (cb) {
      var lbl = 'Close all' + (any ? ' · about ' + fmtUsdHead(back) : '');
      if (cb.textContent !== lbl) cb.textContent = lbl;
      cb.disabled = state.busy;
    }
  }

  /* Close (one position: submitClose, with the figures frozen at the tap) or Close all (the check
     resolves and closeAll runs as on desktop). */
  function onPhSheetGo() {
    var s = ui.phSheet;
    if (!s) return;
    if (s.mode === 'all') {
      var r = s.resolve;
      s.resolve = null;
      ui.phSheet = null;
      closeDialog('phPosSheet');
      if (r) r(true);
      return;
    }
    var pid = s.pid, p = posById(pid);
    if (!p || state.busy || closeStatus(pid, p)) return;
    var px = closePriceFor(p);
    ui.phFrozen[pid] = { px: px, est: positionEstimate(p), room: liqRoom(p, px) };
    tourEvent('close');
    submitClose(p).then(function (ok) {
      /* refused or not sent: the live figures again */
      if (!ok && !acct.closeReqs[pid]) { delete ui.phFrozen[pid]; renderPhRows(); }
    });
  }

  /* Finish now (late) or Try again (expired): at once, the trader already chose to close. */
  function onPhSheetAct() {
    var s = ui.phSheet;
    if (!s || s.mode !== 'pos') return;
    var p = posById(s.pid);
    if (p) closeReqAction(p);
  }

  function initPhPosSheet() {
    var d = $('phPosSheet');
    if (!d) return;
    var on = function (c, fn) { var n = d.querySelector(c); if (n) n.addEventListener('click', fn); };
    on('.js-ps-close', onPhSheetGo);
    on('.js-ps-act', onPhSheetAct);
    d.addEventListener('close', function () {
      var s = ui.phSheet;
      ui.phSheet = null;
      if (s && s.resolve) s.resolve(false);
      renderPhRows();
    });
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
    if (isAddr(cfg.contracts && cfg.contracts.v3Exchange)) read.v3 = new E.Contract(cfg.contracts.v3Exchange, V3_EXCHANGE_ABI, read.provider);
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
      entryDeadbandBps: Number(r.entryDeadbandBps), borrowRateX10: Number(r.borrowRateX10),
      opensPaused: !!r.opensPaused, retired: !!r.retired, frozenPx: px18ToNum(r.lastPx18)
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
      ex.winFeeBps().catch(none),
      ex.minDelay().catch(none), ex.grace().catch(none), ex.expiry().catch(none),
      ex.maxJumpBps().catch(none), ex.stakerFeeShareBps().catch(none), ex.breakerBps().catch(none),
      ex.lossFeeBps().catch(none), ex.minMarginUsdc().catch(none), ex.borrowFreeHours().catch(none),
      ex.maxWinBps().catch(none), ex.houseFreeUsdc().catch(none)
    ]).then(function (r) {
      house.lp = usd6ToNum(r[0]); house.feePool = usd6ToNum(r[1]); house.queued = usd6ToNum(r[2]);
      var houseChip = $('chipHouseLp');
      if (houseChip) houseChip.textContent = fmtUsdShort(house.lp);
      setText('chipHouseLpPh', fmtUsdK(house.lp));
      var houseLink = $('chipHouse');
      if (houseLink) houseLink.classList.add('is-loaded');
      house.queueLen = Number(r[3]); house.queueHead = Number(r[4]); house.globalPaused = !!r[5];
      noteBlock(r[6]); house.breakerTripped = !!r[7];
      if (r[8] != null) house.winFeeBps = Number(r[8]);
      if (r[9] != null) house.minDelay = Number(r[9]);
      if (r[10] != null) house.grace = Number(r[10]);
      if (r[11] != null) house.expiry = Number(r[11]);
      if (r[12] != null) house.maxJumpBps = Number(r[12]);
      if (r[13] != null) house.stakerShareBps = Number(r[13]);
      if (r[14] != null) house.breakerBps = Number(r[14]);
      if (r[15] != null) house.lossFeeBps = Number(r[15]);
      if (r[16] != null) house.minMargin = usd6ToNum(r[16]);
      if (r[17] != null) house.borrowFreeHours = Number(r[17]);
      if (r[18] != null) house.maxWinBps = Number(r[18]);
      if (r[19] != null) house.free = usd6ToNum(r[19]);
      renderStatus(); renderForm(); renderAction();
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
        var key = n === 'extension' ? 'exchangeExt' : n;
        var pin = cfg.contracts[key], theirs = house.addrs[n];
        if (n === 'extension' && !(isAddr(theirs) && isAddr(pin) && pin.toLowerCase() === theirs.toLowerCase())) {
          console.error('exchange.extension() ' + (theirs || 'unreadable') + ' is not the pinned exchangeExt ' + (pin || 'none') + '; nothing is sent.');
          setGate('Contracts not ready.');
          return;
        }
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
    var none = function () { return null; };
    return Promise.all([ex.openInterest(id), ex.instrument(id), readOraclePx(id), ex.maxPositionUsd(id, true).catch(none), ex.maxPositionUsd(id, false).catch(none)]).then(function (r) {
      house.oi[m.symbol] = { long: usd6ToNum(r[0][0]), short: usd6ToNum(r[0][1]) };
      var inst = normInst(r[1], id);
      inst.market = m;
      m.inst = inst;
      state.byInstId[id] = inst;
      house.oraclePxById[id] = r[2];
      /* maxPositionUsd(id, isLong): the biggest open the exchange takes right now, every limit in one number */
      if (r[3] != null && r[4] != null) house.maxPos[id] = { long: usd6ToNum(r[3]), short: usd6ToNum(r[4]) };
      loadHouseBotOi();
      renderMarketHeader(); renderLeverage(); renderForm(); renderAction(); renderStatus(); renderAccount(); renderPositions();
    }).catch(function () { /* keep the last values */ });
  }

  function usdcAddress() { return house.addrs.usdc || (cfg.contracts && cfg.contracts.usdc); }

  /* Three reads on each of the v2 / v3 Exchanges, at most every V2_EVERY_MS per account, for the banners. */
  function refreshOldLinks() {
    if (DEMO) return Promise.resolve();
    return Promise.all(Object.keys(oldLinks).map(function (k) {
      var l = oldLinks[k], a = wallet.account, ex = read[k];
      if (!a || !ex) { l.show = false; renderOldLinks(); return null; }
      if (l.account === a && Date.now() - l.at < V2_EVERY_MS) return null;
      if (l.account !== a) l.show = false;
      l.account = a; l.at = Date.now();
      return Promise.all([ex.balanceOf(a), ex.marginInUse(a), ex.pendingOf(a)]).then(function (r) {
        if (wallet.account !== a) return;
        l.show = r[0] > 0n || r[1] > 0n || r[2] > 0n;
        l.total = usd6ToNum(r[0]) + usd6ToNum(r[1]) + usd6ToNum(r[2]);
        renderOldLinks();
      }, function () { l.at = 0; });
    }));
  }

  /* A banner each, only while that exchange still holds this account's money: "You have $X on
     v2. [Move it]" (v2.html), the same for v3 (v3.html). */
  function renderOldLinks() {
    Object.keys(oldLinks).forEach(function (k) {
      var l = oldLinks[k], b = $(k + 'Banner');
      var on = !!(l.show && wallet.account && wallet.account === l.account);
      if (b) b.hidden = !on;
      if (on) setText(k + 'Amt', l.total > 0 ? fmtUsd(l.total) : 'money');
    });
    dkBannerRoom();
  }

  /* cf_FIX: the v2 / v3 banners push the grid down on desktop; their height (with the 8 px under each) goes into
     --dk-banner-h, which the ticket's sticky top and max-height and the chart's height take off (trade.html), as
     the owed row's 40 px does. 0 when none shows, and on phones and tablets. */
  function dkBannerRoom() {
    var h = 0;
    if (isDesk()) ['v2Banner', 'v3Banner'].forEach(function (id) {
      var b = $(id);
      if (b && !b.hidden && b.offsetHeight) { var cs = getComputedStyle(b); h += b.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0); }
    });
    var v = Math.round(h) + 'px';
    if (document.body.style.getPropertyValue('--dk-banner-h') !== v) document.body.style.setProperty('--dk-banner-h', v);
  }

  function refreshAccount() {
    if (DEMO) { demoRefresh(); return Promise.resolve(); }
    refreshOldLinks();
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
            /* settlement terms stamped at open; the close settles on these */
            deadbandBps: Number(p.deadbandBps), payoutCapX: Number(p.payoutCapX), maxProfit: usd6ToNum(p.maxProfitUsdc),
            winFeeBps: Number(p.winFeeBps), lossFeeBps: Number(p.lossFeeBps), entryDeadbandBps: Number(p.entryDeadbandBps),
            borrowRateX10: Number(p.borrowRateX10), borrowFreeHours: Number(p.borrowFreeHours),
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
          lines.push(what + ' was liquidated at ' + fmtPrice(px18ToNum(h.args.exitPx18), sym ? inst.market.szDecimals : null) + '. You lost the ' + fmtUsd(usd6ToNum(h.args.marginUsdc)) + ' you put in. Nothing more is owed.');
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
    /* desktop: the same three numbers in the top strip (#dkAcct) and the owed sentence under it (#dkOwed) */
    var dk = $('dkAcct');
    if (dk) dk.hidden = !wallet.account;
    if (!wallet.account || !hasExchange() || !acct.loaded) {
      ['eqAvailable', 'eqMargin', 'eqPnl', 'dkBal', 'dkMargin', 'dkPnl'].forEach(function (id) { setText(id, '—'); });
      var pe = $('eqPnl'); if (pe) pe.className = '';
      var dpe = $('dkPnl'); if (dpe) dpe.className = 'dk-acct-v';
      renderDkOwed('');
      renderMiniAccount('—', '');
      renderPhAccount('');
      renderPhMoreAcct('');
      renderPosChip();
      return;
    }
    var pnl = openPnl();
    var balText = fmtUsd(acct.available), inText = fmtUsd(acct.marginInUse + acct.pending), pnlText = fmtUsd(pnl, true);
    var inTitle = acct.pending > 0 ? fmtUsd(acct.pending) + ' of it in trades still opening' : '';
    var pnlCls = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
    setText('eqAvailable', balText);
    setText('eqMargin', inText);
    var marginEl = $('eqMargin');
    if (marginEl) marginEl.title = inTitle;
    var pnlEl = $('eqPnl');
    if (pnlEl) {
      pnlEl.textContent = pnlText;
      pnlEl.className = pnlCls;
    }
    setText('dkBal', balText);
    setText('dkMargin', inText);
    var nOpen = acct.positions.length + pendingOpenList().length, dko = $('dkOpenN');
    if (dko) { dko.hidden = !nOpen; dko.textContent = nOpen + ' open'; }
    var dkm = $('dkMargin');
    if (dkm) dkm.title = inTitle;
    var dkp = $('dkPnl');
    if (dkp) {
      if (dkp.textContent !== pnlText) dkp.textContent = pnlText;
      dkp.className = 'dk-acct-v' + (pnlCls ? ' ' + pnlCls : '');
    }
    var owedText = acct.owed > 0 ? 'Owed to you: ' + fmtUsd(acct.owed) + (acct.owedAt ? ' · #' + acct.owedAt + ' in line' : '') + ' · paid automatically' : '';
    var owed = $('acctOwed');
    if (owed) {
      owed.hidden = !owedText;
      if (owedText) owed.textContent = owedText;
    }
    renderDkOwed(owedText);
    renderMiniAccount(fmtUsd(acct.available), owedText);
    renderPhAccount(owedText);
    renderPhMoreAcct(owedText);
    renderPosChip();
  }

  /* Desktop: "Owed to you: $X · #N in line · paid automatically" as a row under the strip. body.dk-owing lets the
     desktop layout (paper.css, desk piece A) give the row its 40 px in the ticket's and the chart's sums. */
  function renderDkOwed(owedText) {
    var row = $('dkOwed');
    if (!row) return;
    row.hidden = !owedText;
    if (owedText && row.textContent !== owedText) row.textContent = owedText;
    document.body.classList.toggle('dk-owing', !!owedText);
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
    renderPhPnl();
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
    var liq = px18ToNum(posBust18(p));
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
    /* desktop (>= 901): the table row splits the P&L into $ and % and the liquidation into price,
       bar and distance, each in its own cell; the card keeps the one string */
    var dk = card.classList.contains('dk-row');
    var sign = est.pnl > 0 ? ' pos' : est.pnl < 0 ? ' neg' : '';
    var pnl = card.querySelector('[data-role="pnl"]');
    if (pnl) {
      var t = !known ? '—' : dk ? fmtUsd(est.pnl, true) : fmtUsd(est.pnl, true) + ' (' + fmtPct1(est.pnl / p.margin) + ')';
      if (pnl.textContent !== t) pnl.textContent = t;
      pnl.className = (dk ? 'dk-cell dk-num dk-pnl' : 'pc-pnl') + sign;
      pnl.title = known ? 'If you close now: about ' + fmtUsd(est.payout) + ' back' + (est.pnl > 0 && est.fee ? ', after a ' + fmtUsd(est.fee) + ' fee' : '') + (est.borrow > 0 ? ', borrow ' + fmtUsd(est.borrow) : '') : '';
    }
    if (dk) {
      var pct = setRole(card, 'pct', known ? fmtPct1(est.pnl / p.margin) : '');
      if (pct) pct.className = 'dk-cell dk-num dk-pct' + sign;
    }
    setRole(card, 'now', isFinite(px) ? fmtPrice(px, sz) : '—');
    var room = liqRoom(p, px);
    var away = isFinite(room.away) ? (room.away * 100).toFixed(room.away >= 0.01 ? 1 : 2) + '%' : '';
    if (dk) {
      setRole(card, 'liq', fmtPrice(room.liq, sz));
      setRole(card, 'away', away);
      var lc = card.querySelector('.dk-liq');
      if (lc) {
        lc.className = 'dk-cell dk-liq' + (room.cls ? ' ' + room.cls : '');
        var fill = lc.querySelector('.dk-bar i');
        var full = bustMovePct(p.leverage) / 100;
        if (fill) fill.style.width = (away && full > 0 ? clamp(room.away / full, 0, 1) * 100 : 0).toFixed(1) + '%';
      }
    } else {
      var liqEl = setRole(card, 'liq', fmtPrice(room.liq, sz) + (away ? ' (' + away + ' away)' : ''));
      if (liqEl) liqEl.className = 'pc-v' + (room.cls ? ' ' + room.cls : '');
    }
    card.classList.toggle('is-near', room.cls === 'is-red');
    var estEl = setRole(card, 'est', dk ? (known ? 'Close · about ' + fmtUsd(est.payout) : 'Close') : known ? 'you get back about ' + fmtUsd(est.payout) : '');
    if (dk && estEl && pnl && estEl.title !== pnl.title) estEl.title = pnl.title;
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
    if (req.requestedAt == null) return { steps: [sent, [verb + '…', 'is-on'], [end, '']] };
    var ph = requestPhase(req.requestedAt);
    if (ph.phase === 'wait' && !ph.expiring && !ph.soon) {
      var left = req.requestedAt + fillSecs() - chainNow();
      return { steps: [sent, [verb + '… ' + (left > 0.5 ? 'about ' + Math.ceil(left) + ' s' : 'any second now'), 'is-on'], [end, '']] };
    }
    if (ph.phase === 'fallback' || ph.phase === 'wait') {
      var note;
      if (req.busy) note = 'Asking your wallet to finish it…';
      else if (ph.expiring) note = close ? "Almost out of time. If it doesn't close, it stays open and you can try again." : "Almost out of time. If it doesn't fill, your money comes back.";
      else note = (autoFillEnabled() && !req.prompted ? 'Your wallet will ask you to finish it' + (ph.soon ? ' in a moment. ' : '. ') : '') + 'You get the less favourable of the price when you tapped and the price now.';
      return {
        cls: 'is-late', late: ph.phase === 'fallback' || !!ph.soon,
        steps: [sent, ['Still ' + verb.toLowerCase() + '.', 'is-on is-warn'], [end, '']],
        note: note, btn: ph.phase === 'fallback' && !req.busy ? 'Finish now' : '', btnCls: 'btn-primary'
      };
    }
    if (close) {
      return {
        cls: 'is-bad', steps: [sent, ["Didn't close. Your position is still open.", 'is-on is-bad'], [end, 'is-skip']],
        btn: req.busy ? '' : 'Try again', btnCls: 'go-close', note: req.busy ? 'Closing again…' : ''
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
    if (posTable()) {
      /* desktop: one 40 px row, "Opening Long DOGE 20x · $10", the sentence and its button */
      card.classList.add('dk-row', 'dk-wide');
      card.appendChild(dkWho(r.isLong, reqSym(r), r.leverage, 'Opening', ' · ' + fmtUsdShort(r.margin)));
      card.appendChild(dkStatusEl(function () { openReqAction(r); }));
      updateOpenProg(card, r);
      return card;
    }
    card.appendChild(makeProg('Opening ' + sideWord(r.isLong) + ' ' + reqSym(r) + ' ' + r.leverage + 'x · ' + fmtUsdShort(r.margin), function () { openReqAction(r); }));
    updateOpenProg(card, r);
    return card;
  }

  function updateOpenProg(card, r) {
    var dkBox = card.querySelector('.dk-status');
    if (dkBox) { dkSetStatus(dkBox, progressView('open', r, r.margin)); return; }
    var box = card.querySelector('.prog');
    if (box) setProg(box, progressView('open', r, r.margin));
  }

  /* ---- desktop (>= 901 px): positions as a table (piece C) ----
     Each position is a 40 px row of nine cells on the --dk-pos-cols grid; a request, a close being
     checked and a result are one wide row. The roles (pnl, now, liq, act, est) are the card's, so
     fillPositionPnl and fillCardAction serve both. (isDesk / onDeskChange are piece A's, beside isPhone.) */

  function dkCell(cls, text, role) {
    var c = el('div', 'dk-cell' + (cls ? ' ' + cls : ''), text);
    if (role) c.setAttribute('data-role', role);
    return c;
  }

  /* The first cell: the side tag, the coin, the leverage (and a word before, a note after). */
  function dkWho(isLong, sym, lev, pre, post) {
    var who = dkCell('dk-who');
    if (pre) who.appendChild(el('span', 'dk-pre', pre));
    who.appendChild(el('span', 'pc-side', isLong ? 'LONG' : 'SHORT'));
    who.appendChild(el('span', 'pc-sym', sym));
    who.appendChild(el('span', 'pc-lev', lev + 'x' + (post || '')));
    return who;
  }

  /* The Close cell while something is happening: the sentence (the card's step that is on),
     the note under it, and the one button (Finish now, Try again, Get $X back). */
  function dkStatusEl(onBtn) {
    var box = el('div', 'dk-status');
    var txt = el('div', 'dk-say-wrap');
    var say = el('span', 'dk-say'); say.setAttribute('data-role', 'say');
    var note = el('span', 'dk-note'); note.setAttribute('data-role', 'dknote');
    txt.appendChild(say); txt.appendChild(note);
    box.appendChild(txt);
    var b = el('button', 'btn btn-sm');
    b.type = 'button'; b.hidden = true; b.setAttribute('data-role', 'b1');
    if (onBtn) b.addEventListener('click', onBtn);
    box.appendChild(b);
    return box;
  }

  /* v: progressView's shape (steps, cls, note, btn, btnCls, btnFree), as setProg reads it */
  function dkSetStatus(box, v) {
    var steps = v.steps || [], on = null;
    for (var i = 0; i < steps.length; i++) if (/\bis-on\b/.test(steps[i][1] || '')) { on = steps[i]; break; }
    if (!on) for (var j = steps.length - 1; j >= 0; j--) if (steps[j][0] && /\bis-done\b/.test(steps[j][1] || '')) { on = steps[j]; break; }
    var cls = 'dk-status' + (v.cls ? ' ' + v.cls : '');
    if (box.className !== cls) box.className = cls;
    var say = setRole(box, 'say', on ? on[0] : '');
    if (say) say.className = 'dk-say' + (on && /is-bad/.test(on[1]) ? ' is-bad' : on && /is-warn/.test(on[1]) ? ' is-warn' : '');
    var note = setRole(box, 'dknote', v.note || '');
    if (note) note.title = v.note || '';
    var b1 = box.querySelector('[data-role="b1"]');
    if (b1) {
      if (b1.textContent !== (v.btn || '')) b1.textContent = v.btn || '';
      b1.hidden = !v.btn;
      b1.className = 'btn btn-sm' + (v.btnCls ? ' ' + v.btnCls : '');
      b1.disabled = !v.btnFree && state.busy;
    }
  }

  /* One open position as a table row: POSITION · SIZE · PUT IN · ENTRY · NOW · LIQUIDATION · P&L ·
     % · CLOSE. pos-card, is-long / is-short, data-id and .close-btn stay for the tour and the
     close path. */
  function dkPositionRow(p) {
    var m = positionMarket(p);
    var sz = m ? m.szDecimals : null;
    var row = el('div', 'pos-card dk-row ' + (p.isLong ? 'is-long' : 'is-short'));
    row.setAttribute('data-id', String(p.id));
    if (fx.fresh[String(p.id)]) { delete fx.fresh[String(p.id)]; if (!isPhone() && !reducedMotion()) row.classList.add('is-fresh'); }
    /* the size and the amount put in ride in the title too: a narrow window drops their columns */
    row.title = 'Position #' + p.id + ' · size ' + fmtUsd(p.margin * p.leverage) + ' · put in ' + fmtUsd(p.margin);
    row.appendChild(dkWho(p.isLong, m ? m.symbol : 'Market ' + p.instrumentId, p.leverage));
    row.appendChild(dkCell('dk-num', fmtUsd(p.margin * p.leverage), 'size'));
    row.appendChild(dkCell('dk-num', fmtUsd(p.margin), 'margin'));
    row.appendChild(dkCell('dk-num', fmtPrice(p.entry, sz), 'entry'));
    row.appendChild(dkCell('dk-num', '—', 'now'));
    var liq = dkCell('dk-liq');
    var lp = el('span', 'dk-liq-px', '—'); lp.setAttribute('data-role', 'liq');
    liq.appendChild(lp);
    var bar = el('span', 'dk-bar'); bar.setAttribute('aria-hidden', 'true');
    bar.appendChild(el('i'));
    liq.appendChild(bar);
    var aw = el('span', 'dk-away'); aw.setAttribute('data-role', 'away');
    liq.appendChild(aw);
    liq.appendChild(el('span', 'dk-away-w', 'away'));
    row.appendChild(liq);
    row.appendChild(dkCell('dk-num dk-pnl', '—', 'pnl'));
    row.appendChild(dkCell('dk-num dk-pct', '', 'pct'));
    row.appendChild(dkCell('dk-act', null, 'act'));
    fillCardAction(row, p);
    fillPositionPnl(row, p);
    return row;
  }

  /* The head's "Open 2 · In trades $20.00 · P&L -$4.62" and the column head, from the same locals
     as the account strip (acct.marginInUse + acct.pending, openPnl()). */
  function renderDkPosHead() {
    var dk = posTable();
    var ready = !!(wallet.account && hasExchange() && acct.loaded);
    var n = ready ? acct.positions.length + pendingOpenList().length : 0;
    var sum = $('dkPosSum');
    var head = document.querySelector('#posPanel .pos-head');
    if (head) head.classList.toggle('is-dk', dk && ready);
    if (sum) {
      sum.hidden = !(dk && ready);
      if (dk && ready) {
        setText('dkPosN', String(n));
        var money = $('dkPosMoney');
        if (money) money.hidden = !acct.positions.length;
        if (acct.positions.length) {
          var pnl = openPnl();
          setText('dkPosMargin', fmtUsd(acct.marginInUse + acct.pending));
          var pe = $('dkPosPnl');
          if (pe) {
            var t = fmtUsd(pnl, true);
            if (pe.textContent !== t) pe.textContent = t;
            pe.className = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
          }
        }
      }
    }
    var ch = $('dkPosHead');
    if (ch) ch.hidden = !(dk && ready && acct.positions.length > 0);
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
    if (posTable()) return dkPositionRow(p);
    var m = positionMarket(p);
    var sz = m ? m.szDecimals : null;
    var card = el('div', 'pos-card ' + (p.isLong ? 'is-long' : 'is-short'));
    card.setAttribute('data-id', String(p.id));
    if (fx.fresh[String(p.id)]) { delete fx.fresh[String(p.id)]; if (!isPhone() && !reducedMotion()) card.classList.add('is-fresh'); }
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
    var dk = card.classList.contains('dk-row');
    if (act.getAttribute('data-mode') !== mode) {
      act.setAttribute('data-mode', mode);
      act.textContent = '';
      if (dk) {
        /* desktop: "Close · about $4.44" (the est role is the button's label), or the sentence */
        if (mode === 'idle') {
          var db = el('button', 'btn btn-sm close-btn', 'Close');
          db.type = 'button';
          db.setAttribute('data-role', 'est');
          db.addEventListener('click', function () { tourEvent('close'); submitClose(posById(pid) || p); });
          act.appendChild(db);
        } else act.appendChild(dkStatusEl(function () { closeReqAction(posById(pid) || p); }));
      } else if (mode === 'idle') {
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
    var box = act.querySelector(dk ? '.dk-status' : '.prog');
    if (!box) return;
    var put = dk ? dkSetStatus : setProg;
    if (mode === 'wallet') put(box, { steps: [[state.viaSession ? 'Sending…' : 'Confirm in your wallet…', 'is-on'], ['Closing', ''], ['Closed', '']] });
    else if (mode === 'retrying') put(box, { steps: [['Getting ready to close again…', 'is-on'], ['Closing again', ''], ['Closed', '']], note: 'Closing again. ' + (sessionLive() ? '' : 'Your wallet asks twice.') });
    else if (mode === 'checking') put(box, CHECKING_VIEW);
    else if (mode === 'settling') put(box, { cls: 'is-done', steps: [['Sent', 'is-done'], ['Closed', 'is-done'], ['Adding it to your balance…', 'is-on']] });
    else put(box, progressView('close', cr, p.margin));
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
    if (posTable()) return dkRecentRow(card, r);
    var title = el('div', 'rc-title', r.title);
    /* phones (ph-only, so the desktop card is as before): the money on the title line, and one
       short line under it in place of the first line */
    if (r.money) title.appendChild(el('span', 'rc-money ph-only' + (r.moneyCls ? ' ' + r.moneyCls : ''), r.money));
    card.appendChild(title);
    if (r.ph) { card.classList.add('has-ph'); card.appendChild(el('div', 'rc-line rc-ph ph-only', r.ph)); }
    (r.lines || []).forEach(function (l, i) { card.appendChild(el('div', 'rc-line' + (i === 0 && r.ph ? ' rc-main' : ''), l)); });
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

  /* desktop: the result as one row: the title, its lines joined with " · " (the whole text in the
     title), then the buttons and OK */
  function dkRecentRow(card, r) {
    card.classList.add('dk-row', 'dk-wide');
    card.appendChild(el('div', 'rc-title', r.title));
    var text = (r.lines || []).join(' · ');
    var line = el('div', 'rc-line', text);
    line.title = text;
    card.appendChild(line);
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
    if (posTable()) {
      card.classList.add('dk-row', 'dk-wide');
      var known = p && p !== true;
      if (known) { var m = positionMarket(p); card.appendChild(dkWho(p.isLong, m ? m.symbol : 'Market ' + p.instrumentId, p.leverage, 'Closing')); }
      else card.appendChild(dkCell('dk-who', 'Closing your position'));
      var st = dkStatusEl();
      dkSetStatus(st, CHECKING_VIEW);
      card.appendChild(st);
      return card;
    }
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
    if (!host || !empty) { renderPhRows(); return; }
    var opens = pendingOpenList();
    var n = acct.positions.length + opens.length;
    setText('posCount', n ? ' (' + n + ')' : '');
    host.classList.toggle('dk-table', posTable());
    var closing = Object.keys(ui.checking).length;
    var layout = $('tradeLayout');
    if (layout) layout.classList.toggle('has-pos', !!wallet.account && (n > 0 || closing > 0 || ui.recent.length > 0));
    var closable = acct.positions.filter(function (p) { var k = String(p.id); return !acct.closeReqs[k] && !ui.closing[k] && !ui.settling[k]; }).length;
    var ca = $('closeAllBtn');
    if (ca) { ca.hidden = closable < 2; ca.disabled = state.busy; }
    var sig = posSigOf();
    if (sig === ui.posSig) { updateCards(); renderPosChip(); renderPhRows(); if (wallet.account) watchPending(); return; }
    ui.posSig = sig;
    clearCards(host);
    renderPosChip();
    renderDkPosHead();
    if (!wallet.account) {
      empty.textContent = 'Connect a wallet to see your positions. ';
      /* the demo link a phone visitor sees without a tap (the ticket's own link sits inside the BUY sheet) */
      if (!DEMO && window.ethers) { var td = el('a', 'empty-demo', 'No wallet yet? Try the demo.'); td.id = 'posTryDemo'; td.href = 'trade.html?demo=1'; empty.appendChild(td); }
      empty.hidden = false; return;
    }
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
      else { frag.appendChild(positionCard(it.p)); try { frag.appendChild(tpslSub(it.p)); } catch (e) { /* the rule line never blocks the card */ } }
    });
    host.appendChild(frag);
    renderPhRows();
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
    renderDkPosHead();
    renderPhRows();
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
      noteLate(cr, 'Closing your ' + (p ? posLabel(p) : 'position'), [posCardEl(pid), phRowFor(pid), phSheetFor(pid)]);
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
    var id = tk.posId;
    tkReset();
    if (ui.sheet && !tour.on) showNewPosition(id);
  }

  function ticketView() {
    var title = 'Opening ' + sideWord(tk.isLong) + ' ' + tk.sym + ' ' + tk.lev + 'x · ' + fmtUsdShort(tk.margin);
    if (tk.phase === 'wallet') {
      return {
        title: title, steps: [[state.viaSession ? 'Sending…' : 'Confirm in your wallet…', 'is-on'], ['Opening', ''], ['Open', '']],
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
      /* the owner, 2026-10-25: a first-timer did not know where the position went or how to close it */
      var where = isPhone() ? 'It is the top row of the page. Tap the row to close it.'
        : isSheetMode() ? 'It is the first card at the top of the page. CLOSE POSITION is on the card.'
        : posTable() ? 'It is the top row of Your positions, under the chart. Close is on the row.'
        : 'It is the top card in Your positions, under the chart. CLOSE POSITION is on the card.';
      return {
        cls: 'is-done', title: 'Opened ' + sideWord(tk.isLong) + ' ' + tk.sym + ' ' + tk.lev + 'x · ' + fmtUsdShort(tk.margin),
        steps: [['Sent', 'is-done'], ['Filled', 'is-done'], ['Open at ' + fmtPrice(tk.entry, szOf(tk.sym)), 'is-done']],
        note: where, btn: 'View position', btnFree: true, btn2: 'New trade'
      };
    }
    if (tk.phase === 'refunded') return { cls: 'is-bad', title: title, steps: [['Sent', 'is-done'], [tk.msg, 'is-on is-bad'], ['Open', 'is-skip']], btn: 'OK', btnFree: true };
    if (tk.phase === 'unknown') return { title: title, steps: [['Sent', 'is-done'], [tk.msg, 'is-on'], ['Open', '']], btn: 'OK', btnFree: true };
    return { cls: 'is-bad', title: title, steps: [[tk.msg || 'That did not go through.', 'is-on is-bad'], ['Opening', 'is-skip'], ['Open', 'is-skip']], btn: 'OK', btnFree: true };
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
    if (tk.phase === 'opened') { var id = tk.posId; tkReset(); showNewPosition(id); return; }
    tkReset();
  }

  /* Phones: the ticket's progress in one line over the bar while the sheet is closed. */
  function renderBarStatus(v) {
    var s = $('barStatus');
    if (!s) return;
    if (!v || ui.sheet) { s.hidden = true; renderPhPnl(); return; }
    var on = (v.steps || []).filter(function (x) { return /is-on/.test(x[1]); })[0];
    var text = v.cls === 'is-done' ? v.steps[2][0] : (on ? on[0] : v.title);
    s.hidden = false;
    s.textContent = v.cls === 'is-done' ? 'Opened ' + sideWord(tk.isLong) + ' ' + tk.sym + ' · tap to see it' : tk.sym + ' ' + sideWord(tk.isLong) + ': ' + text;
    s.className = 'mbar-status' + (v.cls ? ' ' + v.cls : '');
    renderPhPnl();
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
          /* the official RPC in the wallet's add-network prompt (a third-party host there reads as a scam signal);
             cfg.rpcUrl stays the page's own read endpoint */
          rpcUrls: [DEFAULT_RPC],
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
    toast(describeError(e) + ' To add HyperEVM by hand: chain id 999, RPC ' + DEFAULT_RPC + ', currency HYPE, explorer ' + ((cfg && cfg.explorerUrl) || 'https://hyperevmscan.io') + '.', 'err', null, 20000);
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
    if (typeof swOnWallet === 'function') swOnWallet();
    if (typeof limLoad === 'function') try { limLoad(); } catch (e) { /* ignore */ }
    if (typeof tpslLoad === 'function') try { tpslLoad(); } catch (e) { /* ignore */ }
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
    renderPhAcct();
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
    MarginBelowMinimum: function () { return 'Minimum is ' + fmtUsd(minMargin()) + '.'; },
    LeverageOutOfRange: function () { return 'That leverage is over this market\'s limit.'; },
    OiCapExceeded: function () { return 'This market is full on that side right now. Lower the amount or leverage.'; },
    PositionTooLarge: function () { return 'Too big right now. Lower the amount or leverage.'; },
    HouseExposureExceeded: function () { return 'The house is full right now. Lower the amount or leverage.'; },
    NoLastPrice: function () { return 'That market has no last price.'; },
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
    NothingToPush: function () { return 'Nothing to push right now.'; },
    UnknownRequest: function () { return 'Already done: it was filled, refunded or cancelled.'; },
    TooEarly: function () { return 'Almost: try again in a second.'; },
    KeeperWindow: function () { return 'Almost: try again in a second.'; },
    RequestExpired: function () { return 'It ran out of time. Get your money back from its card.'; },
    RequestNotExpired: function () { return 'Not out of time yet: give it a few more seconds.'; },
    CloseAlreadyPending: function () { return 'This position is already closing.'; },
    PriceJumped: function () { return 'The price moved too fast to fill. Your money is back in your balance.'; },
    EntryBusted: function () { return 'The price passed your liquidation price before the fill. Your money is back in your balance.'; },
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
    OpensPausedByBreaker: 'trading paused', LeverageOutOfRange: 'leverage over the limit', PositionTooLarge: 'too big right now',
    OiCapExceeded: 'the market is full on that side', HouseExposureExceeded: 'the house is full', MarginBelowMinimum: 'under the minimum', UnknownPosition: 'liquidated first'
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
    if (house.gate) throw new Error(house.gate);
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
      var guess = isFinite(form.margin) && form.margin >= minMargin() ? form.margin : acct.available;
      cap.value = String(Math.max(Math.ceil(minMargin()), Math.floor(guess) || Math.ceil(minMargin())));
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
    if (!sessionLive() || house.usdcBad || house.gate) return false;
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
    if (sessionLive() && !house.usdcBad && !house.gate && hasExchange()) return true;
    try { requireSigner(); return true; } catch (e) { toast(e.message, 'err'); return false; }
  }

  /* Step one of an open: file the request. OPEN POSITION turns into the progress card at once
     (Confirm in your wallet, then Sent and the countdown to the fill), never back to the button
     in between; the request also shows under Your positions as a card. A keeper fills it a few
     seconds later. busy is released as soon as the request is mined, not after the reads. */
  function submitOpen(onFiled) {
    var m = state.market;
    if (!tradeReady()) return;
    if (!m || m.instrumentId == null) return;
    var margin = form.margin;
    var margin6 = numToUsd6(margin);
    var isLong = form.side === 'long';
    var lev = form.lev;
    var desc = sideWord(isLong) + ' ' + m.symbol + ' ' + lev + 'x';
    var maxed = form.maxed;
    /* the ticket's take profit / stop loss, checked before anything is sent; parked under the request id once it is */
    var want = tpslTicketWant(m, isLong, lev);
    if (want.why) { toast(want.why, 'err'); tpslTicketCheck(); return; }
    var released = false;
    function release() { if (!released) { released = true; setBusy(false); } }
    /* a limit order asks whether its request reached the chain (true once the receipt is read; a sent request
       whose event the page could not read counts as filed, since the position will show) */
    var told = false;
    function tell(ok) { if (onFiled && !told) { told = true; try { onFiled(ok); } catch (e) { /* never blocks the ticket */ } } }
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
        if (want.tp != null || want.sl != null) { try { tpslPark(id, want, m, isLong, lev); } catch (e) { /* ignore */ } }
        /* the next visit starts from this amount; a Max amount (the whole balance) is not kept,
           so a later all-in trade still goes through Max and its check */
        if (!maxed) lsSet(LS.amount, String(margin));
        noteRecent(m.symbol);
        tourEvent('submit');
        tell(true);
      } else {
        tkSet('error', { msg: 'Sent, but the page could not read the request. Your positions show the result.' });
        tell(true);
      }
      release();
      return afterTx();
    }).catch(function (e) {
      tkSet('error', { msg: describeError(e) });
      tell(false);
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
    /* on a phone the Position sheet is the check, with the count and the total (piece 11) */
    (isPhone() && $('phPosSheet') ? askPhCloseAll(list) : askConfirm({
      title: 'Close ' + list.length + ' position' + (list.length === 1 ? '' : 's') + '?',
      lines: [
        'You get back about ' + fmtUsd(back) + '.',
        'Each one closes at the market price in about ' + fillSecs() + ' s.' + (sessionLive() ? '' : ' Your wallet asks once for each.')
      ],
      ok: 'Close all', okClass: 'go-close', back: 'Keep open'
    })).then(function (yes) {
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
      freshPosition(String(opened.args.positionId));
      try { tpslAdopt(r.id, String(opened.args.positionId)); } catch (e) { /* the rule never blocks the result */ }
      resultToast(shows, 'Opened ' + sideWord(r.isLong) + ' ' + sym + ' ' + r.leverage + 'x at ' + fmtPrice(entry, sz) + '.', 'ok', link);
      tourEvent('opened');
    } else if (refunded) {
      var why = refundWhy(refunded.args.reason, sym, r.isLong);
      try { tpslDropPending(r.id); } catch (e) { /* ignore */ }
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
     anything owed, the borrow, Withdraw and Share), liquidated (stays until OK), or a close that did
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
      if (a.borrowUsdc > 0n) lines.push('Borrow: ' + fmtUsd(usd6ToNum(a.borrowUsdc)) + '.');
      var win = pnl > 0 && !!window.ConfettiShare;
      var openShare = function () { window.ConfettiShare.open(shareTrade(pid, a, closed.block, pos)); };
      var buttons = [{ label: 'Withdraw', act: 'withdraw', fn: function () { tourEvent('withdraw'); openWithdraw(); } }];
      if (win) buttons.push({ label: 'Share', fn: openShare });
      ui.phClosed = { text: 'Closed ' + (m ? m.symbol : label) + ' · ' + fmtUsd(pnl, true) + ' · ' + fmtUsd(paid) + ' back', until: Date.now() + 6000 };
      setTimeout(renderPhPnl, 6100);
      /* the row and the Position sheet show the real figures (piece 11) */
      ui.phResult[pid] = { pnl: pnl, paid: paid, exit: exit, liq: false };
      addRecent({
        key: 'c' + pid, pid: pid, cls: pnl >= 0 ? 'is-win' : 'is-loss', title: 'Closed ' + label, lines: lines, buttons: buttons, ttl: 60000,
        money: fmtUsd(pnl, true), moneyCls: pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '', ph: 'Closed at ' + exit + ' · ' + fmtUsd(paid) + ' is back in your balance'
      });
      /* the result card says all of it (with Share); a toast only when that card is out of sight */
      var tst = resultToast([recentEl('c' + pid), phSheetFor(pid)], 'Closed ' + label + ': ' + fmtUsd(pnl, true) + '. ' + fmtUsd(paid) + ' is back in your balance.', pnl >= 0 ? 'ok' : 'err', link, win ? 30000 : null);
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
      /* the win's burst: in the sheet when it is open on this position (it sits above everything else) */
      if (pnl > 0) setTimeout(function () { var sh = phSheetFor(pid); fxBurst(sh ? sh.querySelector('.js-ps-line') : recentEl('c' + pid), sh); }, 0);
      tourEvent('closed');
    } else if (liq) {
      var lost = usd6ToNum(liq.args.marginUsdc);
      var lpx = fmtPrice(px18ToNum(liq.args.exitPx18), sz);
      ui.phResult[pid] = { liq: true, lost: lost, exit: lpx };
      var llines = ['Your ' + label + ' was liquidated at ' + lpx + '. You lost the ' + fmtUsdShort(lost) + ' you put in. Nothing more is owed.'];
      addRecent({ key: 'l' + pid, pid: pid, cls: 'is-loss', title: 'Liquidated', lines: llines, money: fmtUsd(-lost, true), moneyCls: 'neg' });
      resultToast([recentEl('l' + pid), phSheetFor(pid)], 'Your ' + label + ' was liquidated. You lost the ' + fmtUsdShort(lost) + ' you put in. Nothing more is owed.', 'err', link);
    } else if (cancelled) {
      delete ui.settling[pid];
      toast('Your ' + label + " close didn't go through (" + reasonText(cancelled.args.reason) + '). The position is still open.', 'err', link);
    } else {
      toast('Your ' + label + ' close is done.', null, link);
    }
    renderPositions();
  }

  /* ---- phones: the feedback layer (all of it behind phoneFx) ---- */
  var fx = { fresh: {} };

  /* A pending open became a position: buzz, and its card flashes once (600 ms) when it shows. */
  function freshPosition(pid) {
    buzz([20, 40, 20]);                                            // phone-gated in buzz itself
    var t = isPhone() ? phRowFor(pid) : posCardEl(pid);
    if (t) flashFresh(t); else fx.fresh[pid] = true;              // not drawn yet: the next render rings it
  }

  /* A small confetti burst (900 ms) from a card, for a closed win. host: where the burst lives
     (the body; an open sheet, which sits above the page). */
  function fxBurst(anchor, host) {
    if (!phoneFx() || !document.body) return;
    var r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    var x = r && r.width ? r.left + r.width / 2 : window.innerWidth / 2;
    var y = r && r.height ? r.top + Math.min(r.height / 2, 40) : window.innerHeight / 2;
    var box = el('div', 'fx-burst');
    box.setAttribute('aria-hidden', 'true');
    box.style.left = Math.round(x) + 'px';
    box.style.top = Math.round(y) + 'px';
    var cols = ['var(--pos)', 'var(--neg)', 'var(--warn)', 'var(--close)', 'var(--ink)'];
    for (var i = 0; i < 18; i++) {
      var a = (i / 18) * Math.PI * 2 + Math.random() * 0.35;
      var d = 46 + Math.random() * 54;
      var s = el('i');
      s.style.setProperty('--dx', Math.round(Math.cos(a) * d) + 'px');
      s.style.setProperty('--dy', Math.round(Math.sin(a) * d - 24) + 'px');
      s.style.setProperty('--rot', Math.round(Math.random() * 540 - 270) + 'deg');
      s.style.background = cols[i % cols.length];
      box.appendChild(s);
    }
    (host || document.body).appendChild(box);
    buzz(20);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 950);
  }

  /* An 8 ms tick when a chip (amount, leverage) is tapped. */
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.pick') : null;
    if (t && !t.disabled) buzz(8);
  }, true);

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
    d.style.transform = ''; d.style.transition = '';
    if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); }
    else d.setAttribute('open', '');
  }

  function closeDialog(id) {
    var d = $(id);
    if (!d) return;
    sheetOut(d, function () { if (typeof d.close === 'function' && d.open) d.close(); else d.removeAttribute('open'); });
  }

  /* Add USDC: where is it (this wallet, or Hyperliquid), then the steps for that place. The HYPE
     line comes first when the wallet has too little for gas. */
  function openDeposit() {
    if (!wallet.account) { connect(); return; }
    if (wallet.chainId !== CHAIN_ID) { toast('Switch your wallet to HyperEVM first.', 'err'); return; }
    if (!hasExchange()) { toast('Trading is off on this copy of the site.', 'err'); return; }
    var hint = $('depositHint');
    if (hint) hint.classList.remove('is-err');
    var empty = acct.walletUsdc < 1 && !depSwapShow() && !depSwapSmall() && (ui.hypeWei == null || ui.hypeWei < DEP_SWAP_RESERVE_WEI);
    setDepWhere(empty && onrampOn() ? 'card' : acct.walletUsdc >= 1 || !read.factory || depSwapShow() ? 'wallet' : 'hl');   // nothing in the wallet: Apple Pay; HYPE: the one-tap swap; else HyperCore
    renderOnramp();
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
    var w = $('depFromWallet'), h = $('depFromHl'), c = $('depFromCard');
    if (w) w.hidden = where !== 'wallet';
    if (h) h.hidden = where !== 'hl';
    if (c) c.hidden = where !== 'card';
    if (where === 'card') renderOnramp();
  }

  /* ---- Pay with Apple Pay (the owner, 2026-10-25: "can we start accepting apple pay"; "moonpay and stripe") ----
     The site never takes the money: MoonPay's hosted widget does, in a new tab (Apple Pay refuses an iframe), and
     sends the coin to the trader's own wallet on HyperEVM. It buys HYPE, not USDC: a wallet with USDC and no HYPE
     cannot pay the gas to deposit, while HYPE becomes USDC with the one-tap swap in this sheet, which keeps 0.03
     for gas. One purchase, no bridge. Shown only when config.json carries the MoonPay publishable key; a live key
     needs the signed URL (ops/onramp/sign.py on the droplet, cfg.onramp.signUrl), a test key does not. Stripe's
     on-ramp does not deliver to HyperEVM (checked 2026-10-25), so it is not here. */
  function onrampCfg() { return (cfg && cfg.onramp) || {}; }
  function onrampOn() { var o = onrampCfg(); return !!(!DEMO && o.moonpayKey && /^pk_(live|test)_/.test(o.moonpayKey)); }   // never in the demo (a pretend wallet)
  var onramp = { amount: 50, busy: false };
  function onrampUrl(amount) {
    var o = onrampCfg();
    var q = [['apiKey', o.moonpayKey], ['currencyCode', o.asset || 'hype_hyperevm'], ['baseCurrencyCode', 'usd'], ['baseCurrencyAmount', String(amount)],
      ['walletAddress', wallet.account], ['paymentMethod', 'apple_pay'], ['theme', 'dark'], ['redirectURL', location.origin + '/trade.html'],
      ['externalCustomerId', wallet.account.toLowerCase()]];
    return (o.widgetUrl || 'https://buy.moonpay.com') + '/?' + q.map(function (kv) { return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]); }).join('&');
  }
  function renderOnramp() {
    var box = $('depFromCard'); if (!box) return;
    var seg = $('depWhereCard'); if (seg) seg.hidden = !onrampOn();
    setText('orWallet', wallet.account ? shortAddr(wallet.account) : '—');
    Array.prototype.forEach.call(box.querySelectorAll('[data-or-amt]'), function (b) { b.setAttribute('aria-pressed', Number(b.getAttribute('data-or-amt')) === onramp.amount ? 'true' : 'false'); });
    var go = $('orGo'); if (go) { go.textContent = onramp.busy ? 'Opening MoonPay…' : 'Pay ' + fmtUsdShort(onramp.amount) + ' with Apple Pay'; go.disabled = !!(onramp.busy || !wallet.account); }
  }
  function onrampGo() {
    if (!onrampOn() || !wallet.account || onramp.busy) return;
    var o = onrampCfg(), url = onrampUrl(onramp.amount);
    /* the tab opens on the tap (a popup blocker needs the gesture); the signed URL lands in it a moment later */
    var win = window.open('about:blank', '_blank');
    onramp.busy = true; renderOnramp();
    var p = /^pk_live_/.test(o.moonpayKey) && o.signUrl
      ? fetch(o.signUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url }) }).then(function (r) { return r.json(); }).then(function (j) { if (!j || !j.signature) throw new Error('no signature'); return url + '&signature=' + encodeURIComponent(j.signature); })
      : Promise.resolve(url);
    p.then(function (u) {
      if (win) win.location.href = u; else location.href = u;
      setText('orHint', 'MoonPay opened in a new tab. When it says the HYPE is sent, come back here: this sheet turns it into USDC in one tap.');
    }).catch(function () {
      if (win) win.close();
      setText('orHint', 'MoonPay could not be opened right now. Try again in a moment.');
    }).then(function () { onramp.busy = false; renderOnramp(); });
  }
  function initOnramp() {
    var box = $('depFromCard'); if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('[data-or-amt]'), function (b) { b.addEventListener('click', function () { onramp.amount = Number(b.getAttribute('data-or-amt')); renderOnramp(); }); });
    var go = $('orGo'); if (go) go.addEventListener('click', onrampGo);
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
    try { renderDepSwap(); } catch (e) { /* the swap block never blocks the deposit */ }
  }

  /* ---- One tap from HYPE to USDC inside Add USDC (the owner, 2026-10-25: 'a one-tap HYPE to USDC swap on
     the deposit path', so a visitor who arrives with HYPE and no USDC is not sent away to find a DEX). A
     wallet with under the minimum trade in USDC and some HYPE sees what the whole stack buys, less 0.03 HYPE
     kept for gas (the approve, the deposit, a trade or two), and one button that swaps it on the V3 pool: the
     Swap card's own quote, tolerance and send (swV3Quote / swMinOut / swSend). After the swap the sheet
     fills the amount with the new USDC, so the next tap is the deposit. A custom amount is the card's job. */
  var DEP_SWAP_RESERVE_WEI = 30000000000000000n;
  var depSwap = { quote: null, busy: false, seq: 0, hypeWei: null };
  function depSwapShow() {
    if (!(wallet.account && !DEMO && window.ethers && swReady() && swRoute('HYPE', 'USDC') && ui.hypeWei != null && acct.walletUsdc < minMargin())) return false;
    var worth = swHypeWorth(ui.hypeWei);
    if (isFinite(worth)) return worth + acct.walletUsdc >= minMargin();          // what the HYPE buys covers a first trade
    return ui.hypeWei > DEP_SWAP_RESERVE_WEI * 2n;                               // the price is not known yet (asked on connect)
  }
  /* The ticket's 'Swap HYPE for USDC' and the phone banner are for an account that was never funded: a trader
     whose money sits in open trades gets the usual words. */
  function depSwapFirst() {
    return depSwapShow() && !acct.positions.length && !(acct.marginInUse > 0) && !(acct.pending > 0);
  }
  /* A HYPE stack too small for the minimum trade, said in words instead of a dead-end button. */
  function depSwapSmall() {
    var worth = swHypeWorth(ui.hypeWei);
    return !!(wallet.account && !DEMO && isFinite(worth) && worth > 0.5 && worth + acct.walletUsdc < minMargin());
  }
  function renderDepSwap() {
    var box = $('depSwap'); if (!box) return;
    var show = depSwapShow();
    box.hidden = !show;
    if (!show) { depSwap.quote = null; depSwap.hypeWei = null; return; }
    if (depSwap.busy || (depSwap.hypeWei === ui.hypeWei && depSwap.quote && Date.now() - (depSwap.quote.at || 0) < SW_QUOTE_FRESH_MS)) { depSwapRenderGo(); return; }   // same stack, a quote still fresh
    var T = swTokens(), route = swRoute('HYPE', 'USDC'), amountIn = ui.hypeWei - DEP_SWAP_RESERVE_WEI;
    depSwap.hypeWei = ui.hypeWei; depSwap.quote = null; depSwapRenderGo();
    setText('depSwapText', 'Trades are in USDC, not HYPE. This wallet has ' + (Number(ui.hypeWei) / 1e18).toFixed(2) + ' HYPE and '
      + (acct.walletUsdc >= 0.01 ? fmtUsd(acct.walletUsdc) + ' USDC, under the ' + fmtUsdShort(minMargin()) + ' minimum.' : 'no USDC.'));
    setText('depSwapHint', 'Getting a quote…');
    var seq = ++depSwap.seq;
    swV3Quote(route, T.HYPE.addr, amountIn).then(function (r) {
      if (seq !== depSwap.seq) return;
      var minOut = r.out > 0n ? swMinOut(r.out, 1, r.impact) : null;
      if (minOut == null) { setText('depSwapHint', 'That much moves the pool too far for one tap. Use the Swap card with a smaller amount.'); depSwapRenderGo(); return; }
      swNoteHypeUsd(amountIn, r.out);
      var buys = Number(window.ethers.formatUnits(r.out, 6));
      if (buys + acct.walletUsdc < minMargin()) {
        /* the gate uses the same price, so this is rare: a stack that just dipped under the minimum */
        depSwap.quote = null;
        setText('depSwapHint', 'That buys about ' + fmtUsd(buys) + ': under the ' + fmtUsdShort(minMargin()) + ' minimum for a trade. Add USDC, or a little more HYPE.');
        depSwapRenderGo(); renderAction(); return;
      }
      depSwap.quote = { route: route, amountIn: amountIn, out: r.out, minOut: minOut, impact: r.impact, at: Date.now(), slip: 1 };
      setText('depSwapHint', swFmt(amountIn, 18) + ' HYPE buys about ' + fmtUsd(buys) + ' on HyperSwap; 0.03 HYPE stays for gas. One confirm in your wallet, then deposit it.');
      depSwapRenderGo();
    }).catch(function () {
      if (seq !== depSwap.seq) return;
      setText('depSwapHint', 'No quote right now. Try again in a moment.'); depSwapRenderGo();
    });
  }
  function depSwapRenderGo() {
    var b = $('depSwapGo'); if (!b) return;
    var q = depSwap.quote;
    b.textContent = depSwap.busy ? 'Swapping…' : q ? 'Swap ' + swFmt(q.amountIn, 18) + ' HYPE for ' + fmtUsd(Number(window.ethers.formatUnits(q.out, 6))) : 'Swap HYPE for USDC';
    b.disabled = !!(depSwap.busy || !q || state.busy);
  }
  function depSwapGo() {
    if (!depSwap.quote || depSwap.busy) return;
    var T = swTokens(), q0 = depSwap.quote, q = null, desc = '', prevHype = ui.hypeWei;
    depSwap.busy = true; depSwapRenderGo(); setText('depSwapHint', 'Check your wallet.');
    swWalletReady('depSwapHint').then(function (ok) {
      if (!ok) throw SW_STOP;
      return swFresh(q0, T.HYPE, T.USDC);
    }).then(function (fq) {
      if (fq.fresh) {
        /* the fresh quote goes on the button first; a worse one waits for a second tap on the new number */
        depSwap.quote = fq; swNoteHypeUsd(fq.amountIn, fq.out);
        var buys = Number(window.ethers.formatUnits(fq.out, 6));
        setText('depSwapHint', swFmt(fq.amountIn, 18) + ' HYPE buys about ' + fmtUsd(buys) + ' on HyperSwap; 0.03 HYPE stays for gas. One confirm in your wallet, then deposit it.');
        if (fq.worse) { depSwap.busy = false; depSwapRenderGo(); setText('depSwapHint', 'The price moved: the button shows the new amount. Tap it again to swap at that.'); throw SW_STOP; }
      }
      q = fq; desc = 'Swap ' + swFmt(q.amountIn, 18) + ' HYPE for USDC';
      setText('depSwapHint', 'Confirm the swap in your wallet.');
      return swSend(q, T.HYPE, T.USDC, desc);
    }).then(function (rc) {
      toast(desc + ': done.', 'ok', txLink(rc.hash));
      depSwap.quote = null; depSwap.hypeWei = null;
      return swAfterLanded(prevHype);
    }).then(function () {
      var inp = $('depositAmount'), hint = $('depositHint');
      if (inp && acct.walletUsdc > 0) inp.value = String(Math.floor(acct.walletUsdc * 100) / 100);
      if (hint) hint.classList.remove('is-err');
      renderDepositSubmit();
      if (hint) hint.textContent = 'Swapped. Now deposit it' + (acct.allowance + 1e-9 >= acct.walletUsdc ? ': one step.' : ': approve USDC, then deposit.');
      if (typeof swRefreshBalances === 'function') swRefreshBalances();
    }).catch(function (e) {
      if (e === SW_STOP) return;
      setText('depSwapHint', 'The swap did not go through: ' + swError(e));
      if (depSwap.quote === q0) depSwap.quote.at = 0;   // the next tap asks the pool again
    }).then(function () { depSwap.busy = false; renderDepSwap(); });
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
      hint.textContent = depSwapShow() && acct.walletUsdc <= 0 ? 'Swap first. The deposit is the next tap.'
        : isFinite(v) && v > 0 && acct.allowance + 1e-9 >= v ? 'One step: deposit.' : 'The first time takes two steps: approve USDC, then deposit it.';
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
    ['depositModal', 'withdrawModal', 'sessionModal', 'confirmModal', 'walletAppModal', 'acctModal', 'phMenuSheet', 'phAcctSheet', 'phPosSheet'].forEach(function (id) {
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
      var dsg = $('depSwapGo'); if (dsg) dsg.addEventListener('click', depSwapGo);
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
        if (!isFinite(cap) || cap < minMargin()) { hint.textContent = 'Cap per trade: at least ' + minMargin() + ' USDC.'; hint.classList.add('is-err'); return; }
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
    switch (r.name) {
      case 'Deposited':
        d.label = 'Deposit';
        d.amount = usd6ToNum(a.amountUsdc);
        if (a.payer.toLowerCase() !== wallet.account.toLowerCase()) d.details = 'from ' + shortAddr(a.payer);
        break;
      case 'Withdrawn':
        d.label = 'Withdrawal';
        d.amount = -usd6ToNum(a.amountUsdc);
        d.flow = true;   /* money moved to the wallet, not a loss: no pink (cf_FIX) */
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
        if (a.feeUsdc > 0n && a.pnlUsdc > 0n) d.details += ' · fee ' + fmtUsd(usd6ToNum(a.feeUsdc));
        if (a.borrowUsdc > 0n) d.details += ' · borrow ' + fmtUsd(usd6ToNum(a.borrowUsdc));
        if (a.queuedUsdc > 0n) d.details += ' · ' + fmtUsd(usd6ToNum(a.queuedUsdc)) + ' owed';
        break;
      case 'PositionLiquidated':
        d.label = 'Liquidated';
        pid();
        d.amount = -usd6ToNum(a.marginUsdc);
        d.details = 'at ' + fmtPrice(px18ToNum(a.exitPx18), szFor());
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

  /* Phones: the outcome first (piece 12). Line 1 is what happened and to which position, with the
     money on the right (coloured for P&L); line 2 the price, what came back and when; a liquidation
     adds its one plain sentence. The whole row is the transaction's explorer link; a win keeps
     Share. Portfolio's rows are the same component in the same words (tabs.js phHistoryLine).
     Every field today's line shows is here or in the row's title. */
  function phHistoryLine(r) {
    var a = r.args, d = describeRow(r);
    var mi = d.id ? hist.openedMarket[d.id] : (r.name === 'PositionOpened' ? Number(a.instrumentId) : null);
    var inst = mi != null ? state.byInstId[mi] : null, sz = inst && inst.market ? inst.market.szDecimals : null;
    var parts = [], sentence = null, cls = '';
    switch (r.name) {
      case 'Deposited': if (d.details) parts.push(d.details); break;
      case 'PositionOpened': parts.push('at ' + fmtPrice(px18ToNum(a.entryPx18), sz)); break;
      case 'PositionClosed':
        var en = hist.openedEntry[d.id];
        parts.push((en ? fmtPrice(en, sz) + ' → ' : 'at ') + fmtPrice(px18ToNum(a.exitPx18), sz));
        parts.push(fmtUsd(usd6ToNum(a.payoutUsdc)) + ' back');
        if (a.feeUsdc > 0n && a.pnlUsdc > 0n) parts.push('fee ' + fmtUsd(usd6ToNum(a.feeUsdc)));
        if (a.borrowUsdc > 0n) parts.push('borrow ' + fmtUsd(usd6ToNum(a.borrowUsdc)));
        if (a.queuedUsdc > 0n) parts.push(fmtUsd(usd6ToNum(a.queuedUsdc)) + ' owed');
        cls = d.amount > 0 ? ' is-win' : d.amount < 0 ? ' is-loss' : '';
        break;
      case 'PositionLiquidated':
        parts.push('at ' + fmtPrice(px18ToNum(a.exitPx18), sz));
        sentence = 'You lost the ' + fmtUsdShort(usd6ToNum(a.marginUsdc)) + ' you put in. Nothing more is owed.';
        cls = ' is-liq';
        break;
      case 'QueueAppended': parts.push('paid automatically'); break;
      case 'QueuePaid': if (d.details) parts.push(d.details); break;
      case 'OpenRequestCancelled': if (d.details) parts.push(d.details); break;
    }
    var line = el('div', 'pos-line hist-line ph-hist' + cls);
    if (d.id) line.title = (d.id.charAt(0) === 'r' ? 'Request #' : 'Position #') + d.id.replace(/^r/, '');
    var link = !!(r.tx && !DEMO);
    var main = el(link ? 'a' : 'span', 'ph-hist-main');
    if (link) { main.href = explorer('tx', r.tx); main.target = '_blank'; main.rel = 'noopener'; main.title = r.tx; }
    var top = el('span', 'ph-hist-top');
    var w = el('span', 'ph-hist-what', d.label + ' ');
    if (d.market) { w.appendChild(el('b', null, d.market)); if (d.side) w.appendChild(document.createTextNode(' ' + d.side)); }
    top.appendChild(w);
    if (d.amount != null) top.appendChild(el('b', 'ph-hist-money' + (d.signed && !d.flow ? (d.amount > 0 ? ' pos' : d.amount < 0 ? ' neg' : '') : ''), fmtUsd(d.amount, d.signed)));
    main.appendChild(top);
    var sub = el('span', 'ph-hist-sub');
    if (parts.length) sub.appendChild(document.createTextNode(parts.join(' · ') + ' · '));
    var time = el('span', 'ph-hist-time', fmtWhen(hist.blockTs[r.block]));
    time.setAttribute('data-block', String(r.block));
    time.title = blockTitle(r.block);
    sub.appendChild(time);
    main.appendChild(sub);
    if (sentence) main.appendChild(el('span', 'ph-hist-say', sentence));
    line.appendChild(main);
    if (r.name === 'PositionClosed' && d.amount > 0 && window.ConfettiShare) {
      var share = el('button', 'ph-hist-share', 'Share');
      share.type = 'button'; share.title = 'Share your win';
      share.addEventListener('click', function (ev) { ev.preventDefault(); window.ConfettiShare.open(shareTrade(r.args.positionId, r.args, r.block, null)); });
      line.appendChild(share);
    }
    return line;
  }

  /* One line per event, wrapping on a phone: time, what, coin, side and leverage, amount,
     details, view (the transaction). Ids stay in the hover text. */
  function historyLine(r) {
    if (isPhone()) return phHistoryLine(r);
    if (isDesk()) return dkHistoryLine(r);
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
      var cls = d.signed && !d.flow ? (d.amount > 0 ? 'pos' : d.amount < 0 ? 'neg' : '') : '';
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

  /* Desktop (>= 901): seven cells in a fixed order, empty when there is nothing, so a Deposit
     row lines up under an Opened row: time (the day when not today), what, position, amount,
     details, share, view. The same fields as historyLine, from describeRow. */
  function dkHistoryLine(r) {
    var d = describeRow(r);
    var line = el('div', 'pos-line hist-line dk-row');
    if (d.id) line.title = (d.id.charAt(0) === 'r' ? 'Request #' : 'Position #') + d.id.replace(/^r/, '');
    var time = el('div', 'dk-cell dk-time', fmtWhen(hist.blockTs[r.block]));
    time.setAttribute('data-block', String(r.block));
    time.title = blockTitle(r.block);
    line.appendChild(time);
    line.appendChild(el('div', 'dk-cell dk-what', d.label));
    var pos = el('div', 'dk-cell dk-pos');
    if (d.market) pos.appendChild(el('span', 'sym', d.market));
    if (d.side) pos.appendChild(el('span', /^Long/.test(d.side) ? 'pos' : 'neg', d.side));
    line.appendChild(pos);
    var amt = el('div', 'dk-cell dk-num');
    if (d.amount != null) {
      var cls = d.signed && !d.flow ? (d.amount > 0 ? 'pos' : d.amount < 0 ? 'neg' : '') : '';
      amt.textContent = fmtUsd(d.amount, d.signed);
      if (cls) amt.classList.add(cls);
    }
    line.appendChild(amt);
    var det = el('div', 'dk-cell dk-detail', d.details || '');
    if (d.details) det.title = d.details;
    line.appendChild(det);
    var sc = el('div', 'dk-cell dk-link');
    if (r.name === 'PositionClosed' && d.amount > 0 && window.ConfettiShare) {
      var share = el('a', 'faint', 'share');
      share.href = '#'; share.setAttribute('role', 'button'); share.title = 'Share your win';
      share.addEventListener('click', function (ev) {
        ev.preventDefault();
        window.ConfettiShare.open(shareTrade(r.args.positionId, r.args, r.block, null));
      });
      sc.appendChild(share);
    }
    line.appendChild(sc);
    var vc = el('div', 'dk-cell dk-link');
    if (r.tx && !DEMO) {
      var a = el('a', 'faint', 'view');
      a.href = explorer('tx', r.tx); a.target = '_blank'; a.rel = 'noopener'; a.title = r.tx;
      vc.appendChild(a);
    }
    line.appendChild(vc);
    return line;
  }

  function renderHistory() {
    var host = $('histLines');
    var empty = $('histEmpty');
    var more = $('histMoreBtn');
    if (!host) return;
    clearLines(host);
    host.classList.toggle('dk-table', isDesk());
    var hh = $('dkHistHead');
    if (hh) hh.hidden = !(isDesk() && wallet.account && hasExchange() && hist.rows.length);
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
          for (var i = 0; i < cells.length; i++) { cells[i].textContent = cells[i].classList.contains('ph-hist-time') || cells[i].classList.contains('dk-time') ? fmtWhen(hist.blockTs[b]) : fmtClock(hist.blockTs[b]); cells[i].title = blockTitle(b); }
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
    renderOldLinks();

    setText('stPaused', read.exchange ? (house.globalPaused || house.breakerTripped ? 'yes' : 'no') : '—');
    setText('stBreaker', read.exchange ? (house.breakerTripped ? 'tripped · opens paused' : house.breakerBps != null && house.breakerBps >= 10000 ? 'off' : 'armed') : '—');
    setText('stFee', read.exchange && house.winFeeBps != null ? pctText(house.winFeeBps / 1e4) : '—');
    setText('stLossFee', read.exchange && house.lossFeeBps != null ? pctText(house.lossFeeBps / 1e4) : '—');
    setText('stFreeHours', read.exchange && house.borrowFreeHours != null ? String(house.borrowFreeHours) : '—');
    setText('stMinMargin', read.exchange && house.minMargin != null ? fmtUsd(house.minMargin) : '—');
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
    addrCell('stExchangeExt', house.addrs.extension || (cfg.contracts && cfg.contracts.exchangeExt));
    addrCell('stUsdc', usdcAddress());
    addrCell('stOracle', house.addrs.oracle || (cfg.contracts && cfg.contracts.oracle));
    addrCell('stConfetti', cfg.contracts && cfg.contracts.confetti);
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
      var mp = house.maxPos[inst.id];
      setText('stPosCap', mp ? fmtUsdCompact(mp.long) + ' / ' + fmtUsdCompact(mp.short) : '—');
      setText('stMarketFees', pctText(inst.entryDeadbandBps / 1e4) + ' · ' + borrowPctText(inst));
      var opx = house.oraclePxById[inst.id];
      setText('stOraclePx', inst.retired ? fmtPrice(inst.frozenPx, m.szDecimals) + ' (frozen)' : (opx != null ? fmtPrice(opx, m.szDecimals) : '—'));
    } else {
      setText('stInst', m ? (hasExchange() ? (state.instrumentsLoaded ? 'not on chain yet' : 'loading…') : 'HL ' + m.hlAssetIndex + ' · tier ' + m.tier) : '—');
      setText('stMaxLev', m && !hasExchange() ? maxLev(m) + 'x' : '—');
      setText('stCaps', '—'); setText('stPosCap', '—'); setText('stMarketFees', '—'); setText('stOraclePx', '—');
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
    /* Your positions is its own panel now (always in view); the tabs are History, Orders and Refer */
    var saved = lsGet(LS.tab);
    show(saved === 'refer' || saved === 'orders' ? saved : 'history');
    var more = $('histMoreBtn');
    if (more) more.addEventListener('click', function () { loadHistory(false); });
    var closeAllBtn = $('closeAllBtn');
    if (closeAllBtn) closeAllBtn.addEventListener('click', closeAll);
    /* crossing 901 px: the positions and History redraw as tables (desktop) or cards and lines */
    onDeskChange(function () { ui.posSig = null; renderPositions(); renderHistory(); });
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
    var tkDep = $('tkDeposit'); if (tkDep) tkDep.addEventListener('click', openDeposit);
    /* phones: the Points panel (the rules, the leaderboard) opens on a tap of its head; a first-timer scrolling past
       the chart met a wall of rules */
    document.addEventListener('click', function (ev) {
      var pp = $('pointsPanel'); if (!pp || !isPhone() || !pp.firstElementChild) return;
      if (ev.target === pp.firstElementChild || pp.firstElementChild.contains(ev.target)) { if (ev.target.closest && ev.target.closest('a, button')) return; pp.classList.toggle('is-open'); }
    });
    var ub = $('usdcBannerGo'); if (ub) ub.addEventListener('click', openDeposit);
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
      if (isPhone() && $('phMenuSheet')) { openPhSheet('phMenuSheet', nt); return; }
      var open = !hd.classList.contains('nav-open');
      hd.classList.toggle('nav-open', open);
      nt.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    var tb = $('tourBtn');
    if (tb) tb.addEventListener('click', function () { startTour(0); });
    /* the strip carries Balance · In trades · P&L and the owed row: the ticket's own strip may hide on desktop */
    if ($('dkAcct') && $('dkOwed')) document.body.classList.add('dk-ready');
    initPhoneHeader();
    initPhonePositions();
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
        return 'Leverage multiplies your result. At ' + form.lev + 'x' + pays + '. A ' + fmtMove(bustMovePct(form.lev)) + '% move against you hits the liquidation price and you lose your ' + amt + '. Higher leverage, smaller move.';
      } },
    { id: 'preview', sheet: true, title: 'Your trade in dollars',
      target: function () { return isDesk() ? $('dkReceipt') : $('previewBox'); },
      text: function () { return (isDesk() ? 'What you risk, how big the position is, the liquidation price, ' : 'How big the position is, ') + 'what a 1% move pays you, and the price it opens near. Each direction button shows its liquidation price.'; } },
    /* desktop (cf_FIX): the button says the trade ("OPEN LONG · $5 × 20x"), positions are table rows with a Close
       button that says the money, and Withdraw sits in the header: the steps say so */
    { id: 'open', on: 'submit', sheet: true, title: function () { return isDesk() ? 'OPEN' : 'OPEN POSITION'; },
      target: function () { return tk.phase ? $('ticketProgress') : $('actionBtn'); },
      text: function () {
        if (!wallet.account) return 'Connect your wallet to keep going. This button walks you through it: Connect wallet, Switch to HyperEVM, Add USDC. Trades are in USDC on HyperEVM; if you hold HYPE, the same button swaps it in one tap. Then it says OPEN POSITION.';
        var b = $('actionBtn');
        var ready = b && !b.disabled && /^OPEN\b/i.test(b.textContent);
        if (ready && isDesk()) return tapWord() + ' ' + b.textContent.trim() + ': the button says your trade. Your wallet shows it and asks you to confirm.';
        return ready ? tapWord() + ' OPEN POSITION. Your wallet shows the trade and asks you to confirm.'
          : 'Until you are set up, this button walks you through it: Connect wallet, Switch to HyperEVM, Add USDC. Trades are in USDC on HyperEVM; if you hold HYPE, the same button swaps it in one tap. Then it says OPEN POSITION.';
      } },
    { id: 'fill', on: 'opened', sheet: true, title: 'About 6 seconds',
      target: function () { return tk.phase ? $('ticketProgress') : null; },
      text: function () {
        return tk.phase ? 'Your order is sent. It fills at the market price in about ' + fillSecs() + ' seconds. Watch it here: Sent, Opening, Open.'
          : 'When you open a trade, the button turns into this progress card: Sent, then Opening (about ' + fillSecs() + ' s), then Open at the price you got.';
      } },
    { id: 'card', sheet: false, title: 'Your position',
      target: function () { return isPhone() ? document.querySelector('#phRows .ph-row[data-pid]') || firstCard() : firstCard(); },
      text: function () {
        if (isPhone()) return 'Every open position gets a row at the top of the page: profit or loss in $ and %, and a bar for how far the price is from liquidation. It turns amber, then red, as the price gets close. Tap a row for the entry price, the price now, the liquidation price, about what you get back, and Close.';
        if (isDesk()) return 'Every open position is a row in the table under the chart: its size, what you put in, the price you got in at, the price now, the liquidation price and how far away it is, and profit or loss in $ and %. The liquidation turns amber, then red, as the price gets close.';
        return 'Every open position gets a card' + (isSheetMode() ? ' at the top of the page' : ' under the chart') + ': profit or loss in $ and %, the price you got in at, the price now, and the liquidation price. It turns amber, then red, as the price gets close.';
      } },
    /* moves on when the close's result is in (reportCloseOutcome), not on the tap, so the card's
       Closing steps and its "Closed … back in your balance" stay in view */
    { id: 'close', on: 'closed', sheet: false, title: function () { return isDesk() ? 'Close' : 'CLOSE POSITION'; },
      target: function () {
        var c = firstCard();
        /* phones: the row; its sheet holds Close (the sheet sits above the tour while it is open) */
        if (isPhone()) { var pid = c ? c.getAttribute('data-id') : null; return (pid && phRowFor(pid)) || document.querySelector('#phRows .ph-row[data-pid]') || c; }
        return c ? c.querySelector('.close-btn') || c.querySelector('[data-role="act"]') : null;
      },
      text: function () {
        if (isPhone()) return tapWord() + ' the row any time to take your money out: the sheet shows about what you get back, right over the Close button. It closes at the market price in about ' + fillSecs() + ' s, and the sheet shows the result.';
        if (isDesk()) return tapWord() + ' Close any time to take your money out. The button says about what you get back. It closes at the market price in about ' + fillSecs() + ' s, right here in the row.';
        return tapWord() + ' CLOSE POSITION any time to take your money out. Under it: about what you get back. It closes at the market price in about ' + fillSecs() + ' s, right here on the card.';
      } },
    /* the result card's own Withdraw when there is one; else the account line's (on a phone the
       copy at the top of Your positions): the sheet stays shut */
    { id: 'withdraw', on: 'withdraw', sheet: false, title: 'Withdraw',
      target: function () {
        if (!wallet.account) return null;
        var r = document.querySelector('#posLines .result-card [data-act="withdraw"]');
        if (r) return r;
        if (isPhone() && $('phAcct')) return $('phAcct');
        if (isDesk() && $('withdrawBtn') && !$('withdrawBtn').hidden) return $('withdrawBtn');   /* the ticket's strip is hidden on desktop */
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
    setRole(tour.card, 'title', typeof s.title === 'function' ? s.title() : s.title);
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

  /* Every config market marked launch is "on chain" with the launch terms (5% win fee, 5% loss
     fee from the house's side, the published impact curve); the rest are Coming soon. */
  /* A demo knob from the URL (127.0.0.1 only, DEMO set): ?demo=idle&launch=ANIME&bal=20&hype=low&queued=1&paused=WIF */
  function demoOpt(name) {
    if (!DEMO) return '';
    try { return new URLSearchParams(location.search).get(name) || ''; } catch (e) { return ''; }
  }

  function demoInsts() {
    var tiers = (cfg && cfg.tiers) || {};
    /* &launch=ANIME,PURR: coming-soon coins put on chain in the demo (a 50x cap on the ticket) */
    var extra = demoOpt('launch').split(',');
    state.byInstId = {};
    state.markets.forEach(function (m, i) {
      m.inst = null; m.instrumentId = null;
      if (!m.launch && extra.indexOf(m.symbol) < 0) return;
      var t = tiers[m.tier] || {};
      var inst = {
        id: i, hlAssetIndex: m.hlAssetIndex, szDecimals: m.szDecimals, tier: Number(t.code) || 0,
        maxLeverage: m.maxLeverage || 1, deadbandBps: Number(t.deadbandBps) || 1, clampBps: Number(t.clampBps) || 5,
        baseRate: 0.1, rateMultiplier: 15000, referenceNotional: 20000, positionMultiplier: 130000000,
        longCap: 1000000, shortCap: 1000000, maxNotional: 1000000, payoutCapX: 200, entryDeadbandBps: 1, borrowRateX10: 5,
        opensPaused: false, retired: false, frozenPx: 0, market: m
      };
      m.inst = inst; m.instrumentId = i; state.byInstId[i] = inst;
      house.oi[m.symbol] = { long: 1950, short: 640 };
      house.maxPos[i] = { long: 2500, short: 2500 };
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
    house.feePool = 0; house.queued = 0; house.queueLen = 2; house.queueHead = 2; house.winFeeBps = 500; house.lossFeeBps = 500; house.minMargin = 5; house.borrowFreeHours = 1; house.maxWinBps = 2500; house.free = 10000;
    house.instCount = Object.keys(state.byInstId).length; house.breakerBps = 10000;
    house.block = demo.block; house.blockAt = Date.now();
    wallet.account = window.ethers.getAddress('0xde00000000000000000000000000000000000001');
    wallet.chainId = CHAIN_ID;
    acct.walletUsdc = 120; acct.allowance = 0;
    ui.hypeWei = 50000000000000000n;
    /* demo knobs: &hype=low (the gas note), &queued=1 (the paying-earlier-winners line), &paused=WIF (a paused coin) */
    if (demoOpt('hype') === 'low') ui.hypeWei = 1000000000000000n;
    if (Number(demoOpt('queued')) > 0) house.queued = Number(demoOpt('queued'));
    demoOpt('paused').split(',').forEach(function (s) { var pm = state.bySym[s]; if (pm && pm.inst) pm.inst.opensPaused = true; });
    ref.loaded = true; ref.locked = true;
    /* F32: the desktop strip's house line and 24h chip, as the chain path fills them (phones keep their skeleton) */
    house.lp = 412300; setText('chipHouseLp', fmtUsdShort(house.lp)); setText('chipHouseLpPh', fmtUsdK(house.lp));
    var hl = $('chipHouse'); if (hl) hl.classList.add('is-loaded');   // the phone chip shows its value once loaded
    if (isDesk()) refreshConfVol();
    if (state.market) selectMarket(state.market.symbol);
    renderWallet(); renderAccount(); renderPositions(); renderAction(); renderStatus(); renderRefer(); renderSession(); buildMarketMenu();
    var bar = $('demoBar'); if (bar) bar.hidden = false; else toast('Demo: a pretend account on this computer. Nothing is sent.', null, null, 6000);
    document.documentElement.setAttribute('data-demo', '1');
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
      deadbandBps: m.inst.deadbandBps, payoutCapX: m.inst.payoutCapX, maxProfit: 10 * m.inst.payoutCapX, winFeeBps: 500, lossFeeBps: 500,
      entryDeadbandBps: m.inst.entryDeadbandBps, borrowRateX10: m.inst.borrowRateX10, borrowFreeHours: 1, preview: null
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
    /* &bal=20: the balance (a low-balance ticket) */
    if (demoOpt('bal') !== '' && isFinite(Number(demoOpt('bal')))) acct.available = Number(demoOpt('bal'));
    var wpid = String(p2.id);
    /* ?demo=idle: both positions open and nothing in flight (the Position sheet, Close all) */
    if (DEMO !== 'idle') {
      acct.closeReqs[wpid] = { requestedAt: chainNow() - 1, px0: pw, block: demo.block, busy: false };
      if (demoOpt('hold') === '1') demo.hold['c' + wpid] = true;    // held for the 'Finish now' screenshots only; the public demo's close lands
    }
    hist = freshHistory();
    var now = Math.floor(Date.now() / 1000);
    var me = wallet.account;
    var usd = function (v) { return v < 0 ? -numToUsd6(-v) : numToUsd6(v); };
    /* three past outcomes (a win, a loss, a liquidation; ids under the live ones, prices relative
       to the demo prices) so History shows every row it can take */
    var e61 = toPx18(pd * 0.96), x61 = toPx18(pd * 0.9995), w61 = 500 * (0.9995 / 0.96 - 1);
    var e62 = toPx18(pw * 0.998), x62 = toPx18(pw * 1.002), l62 = 500 * (0.998 - 1.002) / 0.998;
    var e63 = toPx18(pd * 1.03), x63 = toPx18(pd * 1.03 * 0.981);
    [[demoLog('Deposited', [me, me, numToUsd6(70)], demoHash()), 10800],
     [demoLog('PositionOpened', [61n, me, doge.instrumentId, true, numToUsd6(10), 50, e61, 31n, true], demoHash()), 10200],
     [demoLog('PositionClosed', [61n, me, x61, usd(w61), usd(w61 * 0.05), usd(10 + w61 * 0.95), 0n, 0n, true], demoHash()), 9000],
     [demoLog('PositionOpened', [62n, me, wif.instrumentId, false, numToUsd6(10), 50, e62, 32n, true], demoHash()), 7200],
     [demoLog('PositionClosed', [62n, me, x62, usd(l62), usd(-l62 * 0.05), usd(10 + l62 * 1.05), 0n, 0n, true], demoHash()), 6600],
     [demoLog('PositionOpened', [63n, me, doge.instrumentId, true, numToUsd6(10), 50, e63, 33n, true], demoHash()), 5400],
     [demoLog('PositionLiquidated', [63n, me, me, x63, numToUsd6(10), numToUsd6(0.05), 0n], demoHash()), 4800],
     [demoLog('PositionOpened', [p1.id, me, p1.instrumentId, true, numToUsd6(10), 20, p1.entryPx18, 41n, true], demoHash()), 900],
     [demoLog('PositionOpened', [p2.id, me, p2.instrumentId, false, numToUsd6(10), 50, p2.entryPx18, 42n, true], demoHash()), 600]
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
    var log = demoLog('PositionOpened', [p.id, wallet.account, r.instrumentId, r.isLong, numToUsd6(r.margin), r.leverage, p.entryPx18, BigInt(r.id), true], hash);
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
    var log = demoLog('PositionClosed', [BigInt(pid), wallet.account, toPx18(px), BigInt(Math.round(est.pnl * 1e6)), BigInt(Math.round(est.fee * 1e6)), BigInt(Math.round(est.payout * 1e6)), 0n, BigInt(Math.round(est.borrow * 1e6)), true], hash);
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
    /* the wallet's own HYPE and USDC, while the page is offering to swap them or the sheet is open (HYPE that arrives
       or leaves between connects used to go unnoticed: the banner stayed, Max filled the old number) */
    if ((dm && dm.open) || depSwapShow() || depSwapSmall()) { refreshWalletUsdc(); if (typeof swRefreshBalances === 'function') swRefreshBalances(); }
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
    /* Portfolio's #pos=<id> is read before anything reads the hash as a coin (initialMarketSymbol
       below; selectMarket then replaces the hash with the symbol) */
    readDeepLink();
    captureRef();
    buildMarkets();
    initTheme();
    initHeader();
    initMarketMenu();
    initForm();
    initTerms();
    initTabs();
    initDialogs();
    initPhoneSheets();
    initPhTicket();
    initPhTicket13();
    /* crossing 640 px (a rotate, a resize) redraws History in the other layout (piece 12) */
    onPhoneChange(renderHistory);
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
    /* a hidden tab skips the price poll, except while a limit order waits: it still has to fire (the browser
       slows a hidden tab's timer to about once a minute after five minutes, so a fire there is late by up to
       a minute, never missed) */
    setInterval(function () { tickMids(lim.orders.length > 0); }, MIDS_EVERY_MS);
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

  /* The v4 gate: a placeholder build (config "v4Placeholder": true) or a build without the
     exchange extension pinned sends nothing; loadHouseAddresses also closes it when
     exchange.extension() is not the pin. */
  function initGate() {
    if (DEMO) return;
    if (cfg.v4Placeholder === true) setGate('Not live yet.');
    else if (!isAddr(CONTRACTS.exchangeExt)) setGate('Contracts not ready.');
  }

  function setGate(msg) {
    if (house.gate) return;
    house.gate = msg;
    console.error('transactions are off: ' + msg);
    toast(msg + ' Nothing can be sent from this page.', 'err', null, 0);
    try { renderAction(); } catch (e) { /* before start(): start renders it */ }
  }


  /* ---- Swap --------------------------------------------------------------------------------------
     The owner, 2026-10-25: "i want to offer a swapping service on the site too", "right on the side".
     HYPE <-> USDC on HyperSwap V3 (the 0.3 % pool: 7,718 HYPE + $370K on 2026-10-25; the V2 pool holds
     $1), HYPE <-> FETTI on HyperSwap V2 (FETTI's only pool). USDC <-> FETTI is two swaps through HYPE,
     said so on the card. Quotes: V3 from the pool's own state (slot0 + liquidity, exact inside the
     current tick, the router refuses anything worse than min received); V2 from the router. Sent from
     the connected wallet (approve first for a token). The designers own the shell (LEAD_NOTE: SWAP
     design); this binds to the sw* ids and fills every value. */

  var SWAP_V2_ABI = [
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
    /* HyperSwap's router takes a referrer address before the deadline (its bytecode holds only these selectors,
       b4822be3 / 52aa4c22, checked 2026-10-25); the plain Uniswap signatures reverted before the wallet opened */
    'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline) payable',
    'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline)',
  ];
  var SWAP_V3_ROUTER_ABI = [
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
    'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
    'function refundETH() payable',
    'function multicall(bytes[] data) payable returns (bytes[] results)',
  ];
  var SWAP_V3_POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function liquidity() view returns (uint128)',
    'function token0() view returns (address)',
  ];
  var Q96 = 79228162514264337593543950336n;
  var SWAP_V3_USDC_FEE = 3000;   // the pool's fee tier, in hundredths of a bip
  var sw = { pay: 'HYPE', get: 'USDC', slip: 1, quote: null, busy: false, step: null, timer: null, seq: 0, bal: {} };
  var SW_GAS_KEEP = 10000000000000000n;    // 0.01 HYPE stays in the wallet for network fees
  var SW_QUOTE_FRESH_MS = 15000;           // an older quote is asked again right before the wallet opens
  var SW_STOP = { stop: true };            // a step that already said why it stopped

  /* The typed amount in base units, or null. Cut to the token's decimals (a seventh USDC decimal, or 1e-7 from
     Number(), threw inside the quote timer and froze the card on its last quote). */
  function swParse(text, dec) {
    var s = String(text == null ? '' : text).trim().replace(/,/g, '');
    if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
    var parts = s.split('.'), frac = (parts[1] || '').slice(0, dec);
    try { var v = window.ethers.parseUnits((parts[0] || '0') + (frac ? '.' + frac : ''), dec); return v > 0n ? v : null; } catch (e) { return null; }
  }

  /* The wallet steps before a swap, as the trade button takes them: connected, on HyperEVM (switched for the
     trader: the card used to toast "switch first" and stop), able to sign (an auto-connect that made no signer
     was a silent no-op). Resolves true when ready, false once it has said why. */
  function swWalletReady(hintId) {
    if (!wallet.account) { connect(); return Promise.resolve(false); }
    var p = Promise.resolve();
    if (wallet.chainId !== CHAIN_ID) p = switchChain().then(function () { return onChainChanged(); });
    return p.then(function () {
      if (wallet.signer) return true;
      return Promise.resolve(onChainChanged()).then(function () { return !!wallet.signer; });
    }).then(function (ok) {
      if (!ok) setText(hintId, 'Your wallet did not let the page sign. Disconnect it at the top of the page and connect again.');
      return ok;
    }, function (e) {
      switchFailed(e);
      setText(hintId, 'Your wallet stayed on ' + chainName(wallet.chainId) + '. Switch it to HyperEVM, then tap Swap again.');
      return false;
    });
  }

  /* The HYPE price in USDC, learned from every HYPE -> USDC quote (and asked once on connect): it decides whether
     a wallet's HYPE is worth offering the one-tap swap for. */
  function swNoteHypeUsd(amountIn, out) {
    var E = window.ethers, h = Number(E.formatEther(amountIn)), u = Number(E.formatUnits(out, 6));
    if (h > 0 && u > 0) sw.hypeUsd = u / h;
  }
  function swLearnHypeUsd() {
    var route = swRoute('HYPE', 'USDC'); if (!route || !swReady() || sw.hypeUsd) return;
    swV3Quote(route, swTokens().HYPE.addr, 1000000000000000000n).then(function (r) { swNoteHypeUsd(1000000000000000000n, r.out); renderAction(); try { renderDepSwap(); } catch (e) { /* the sheet may be closed */ } }).catch(function () { /* next quote */ });
  }
  /* What the wallet's HYPE buys, less the gas it keeps, in USDC; NaN until the price is known. */
  function swHypeWorth(wei) {
    if (wei == null || !sw.hypeUsd) return NaN;
    var spend = wei > DEP_SWAP_RESERVE_WEI ? wei - DEP_SWAP_RESERVE_WEI : 0n;
    return Number(window.ethers.formatEther(spend)) * sw.hypeUsd;
  }

  /* After a swap lands the public RPC can serve the old balance for a few seconds: read again until the HYPE
     stack moved (or six tries), so the banner, the ticket and the sheet do not keep offering HYPE that is gone. */
  function swAfterLanded(prevHype) {
    var tries = 0;
    function again() {
      return refreshWalletUsdc().then(function () {
        tries += 1;
        if ((prevHype != null && ui.hypeWei !== prevHype) || tries >= 6) { if (typeof swRefreshBalances === 'function') swRefreshBalances(); return; }
        return new Promise(function (r) { setTimeout(r, 1500); }).then(again);
      });
    }
    return again();
  }

  /* The card's boxes from a quote (the first quote, or a re-quote right before the wallet opens). */
  function swShowQuote(q) {
    var T = swTokens(), E = window.ethers, amt = Number(E.formatUnits(q.amountIn, T[sw.pay].dec));
    var outEl = $('swGet'); if (outEl) outEl.value = q.out > 0n ? swFmt(q.out, T[sw.get].dec) : '';
    var unit = amt > 0 ? Number(E.formatUnits(q.out, T[sw.get].dec)) / amt : 0;
    setText('swQuote', '1 ' + sw.pay + ' = ' + String(Number(unit.toPrecision(5))) + ' ' + sw.get + ' · moves the pool ' + q.impact.toFixed(q.impact < 0.1 ? 2 : 1) + '% · ' + (q.route.kind === 'v3' ? 'HyperSwap V3' : 'HyperSwap V2'));
    setText('swTerms', 'min received ' + swFmt(q.minOut, T[sw.get].dec) + ' ' + sw.get);
  }

  /* A quote older than SW_QUOTE_FRESH_MS is asked again right before the wallet opens, so min received comes from
     the pool as it is now (a quote typed, then a connect and a network switch, reverted on "Too little received"). */
  function swFresh(q, payT, getT) {
    if (Date.now() - (q.at || 0) < SW_QUOTE_FRESH_MS) return Promise.resolve(q);
    /* the fresh quote is shown before anything is sent; a worse one stops here (fq.worse) so the trader taps
       again on the number they can see, never signs for less than the screen said */
    var pr = q.route.kind === 'v3' ? swV3Quote(q.route, payT.addr, q.amountIn) : swV2Quote(payT.addr, getT.addr, q.amountIn);
    return pr.then(function (r) {
      var minOut = r.out > 0n ? swMinOut(r.out, q.slip != null ? q.slip : sw.slip, r.impact) : null;
      if (minOut == null) throw new Error('Too big for this pool right now: try a smaller amount.');
      var fq = { route: q.route, amountIn: q.amountIn, out: r.out, minOut: minOut, impact: r.impact, at: Date.now(), slip: q.slip, fresh: true };
      fq.worse = q.minOut != null && minOut < q.minOut;
      return fq;
    });
  }

  /* A swap's failure in a trader's words (the router's own reasons are terse). */
  function swError(e) {
    var raw = String((e && (e.shortMessage || e.reason || e.message)) || '');
    if (/too little received|INSUFFICIENT_OUTPUT_AMOUNT/i.test(raw)) return 'the price moved before you confirmed. Tap Swap again for a fresh quote.';
    if (/too old|deadline|EXPIRED/i.test(raw)) return 'it waited too long in your wallet. Tap Swap again.';
    if (/insufficient funds/i.test(raw)) return 'not enough HYPE for this amount plus the network fee. Max keeps 0.01 HYPE for fees.';
    if (/\bSTF\b|transfer.?from failed/i.test(raw)) return 'the token transfer was refused: check the amount and the approval, then try again.';
    return describeError(e);
  }

  function swapCfg() { return (cfg && cfg.swap) || {}; }
  function swTokens() {
    return {
      HYPE: { sym: 'HYPE', dec: 18, native: true, addr: swapCfg().whype },
      USDC: { sym: 'USDC', dec: 6, addr: cfg.contracts.usdc },
      FETTI: { sym: 'FETTI', dec: 18, addr: cfg.contracts.confetti },
    };
  }
  function swReady() { return !!(window.ethers && read.provider && isAddr(swapCfg().router) && isAddr(swapCfg().whype)); }
  /* The venue for a pair: V3 for HYPE/USDC, V2 for HYPE/FETTI, none for USDC/FETTI (two steps). */
  function swRoute(a, b) {
    var set = [a, b].sort().join('/');
    // the 0.3 % WHYPE/USDC pool on HyperSwap V3 (the SwapRouter is verified on hyperevmscan; factory 0xB1c0...02E3)
    if (set === 'HYPE/USDC' && isAddr(swapCfg().v3Router) && isAddr(swapCfg().v3UsdcPool)) return { kind: 'v3', pool: swapCfg().v3UsdcPool, fee: SWAP_V3_USDC_FEE };
    if (set === 'FETTI/HYPE') return { kind: 'v2' };
    return null;
  }
  function swFmt(units, dec) {
    var n = Number(window.ethers.formatUnits(units, dec));
    return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Number(n.toPrecision(6)));
  }

  /* The least the trader accepts, in the token they get (base units, BigInt). slipPct is the slippage they
     picked (0.5 / 1 / 3); impactPct is how far this size moves the pool (0.4 = 0.4 %). Returns a BigInt, or
     null to refuse the swap (the card then says it is too big for the pool). The rule: a trade that moves
     the pool lands a little worse than the single-tick quote, so the tolerance is the pick plus a tenth of
     the impact; over 8 % impact the card refuses (the owner's own FETTI pool is thin; a size like that is
     the market maker's business, not a tap on a card). */
  function swMinOut(out, slipPct, impactPct) {
    if (impactPct > 8) return null;
    var pct = slipPct + impactPct / 10;
    return out - (out * BigInt(Math.round(pct * 100))) / 10000n;
  }

  /* A V3 quote from the pool's state: exact while the trade stays inside the current tick's liquidity
     (the whole $370K pool sits in wide ranges; a trade that crosses a tick gets a little less, and the
     router refuses anything under min received). Returns { out, impact } in base units / percent. */
  function swV3Quote(route, tokenIn, amountIn) {
    var E = window.ethers;
    var pool = new E.Contract(route.pool, SWAP_V3_POOL_ABI, read.provider);
    return Promise.all([pool.slot0(), pool.liquidity(), pool.token0()]).then(function (r) {
      var sqrtP = BigInt(r[0][0]), L = BigInt(r[1]);
      var zeroForOne = String(r[2]).toLowerCase() === tokenIn.toLowerCase();
      var inFee = amountIn - (amountIn * BigInt(route.fee)) / 1000000n;
      var out, spotOutPerIn;
      if (zeroForOne) {
        // token0 in: the price falls. sqrtP' = L*sqrtP / (L + in*sqrtP/Q96); out1 = L*(sqrtP - sqrtP')/Q96
        var sqrtNext = (L * sqrtP * Q96) / (L * Q96 + inFee * sqrtP);
        out = (L * (sqrtP - sqrtNext)) / Q96;
        spotOutPerIn = Number(sqrtP) / Number(Q96); spotOutPerIn = spotOutPerIn * spotOutPerIn;
      } else {
        // token1 in: the price rises. sqrtP' = sqrtP + in*Q96/L; out0 = L*(sqrtP' - sqrtP)*Q96/(sqrtP*sqrtP')
        var sqrtUp = sqrtP + (inFee * Q96) / L;
        out = (L * (sqrtUp - sqrtP) * Q96) / (sqrtP * sqrtUp);
        var p = Number(sqrtP) / Number(Q96); spotOutPerIn = 1 / (p * p);
      }
      var got = Number(out) / Number(inFee);
      var impact = spotOutPerIn > 0 ? Math.max(0, (1 - got / spotOutPerIn) * 100) : 0;
      return { out: out, impact: impact };
    });
  }
  function swV2Quote(tokenIn, tokenOut, amountIn) {
    var E = window.ethers, router = new E.Contract(swapCfg().router, SWAP_V2_ABI, read.provider);
    var path = [tokenIn, tokenOut], small = amountIn / 1000n || 1n;
    return Promise.all([router.getAmountsOut(amountIn, path), router.getAmountsOut(small, path)]).then(function (r) {
      var out = r[0][r[0].length - 1], outSmall = r[1][r[1].length - 1];
      var impact = Number(outSmall) > 0 ? Math.max(0, (1 - (Number(out) / Number(amountIn)) / (Number(outSmall) / Number(small))) * 100) : 0;
      return { out: out, impact: impact };
    });
  }

  function swQuoteNow() {
    var inp = $('swPay'), outEl = $('swGet');
    var amt = Number(inp.value);
    sw.quote = null;
    if (!swReady() || !(amt > 0) || sw.pay === sw.get) { outEl.value = ''; setText('swQuote', 'Type an amount for a quote.'); setText('swTerms', 'min received —'); swRenderGo(); return; }
    var route = swRoute(sw.pay, sw.get);
    if (!route) { outEl.value = ''; setText('swQuote', 'USDC and FETTI trade through HYPE: swap to HYPE first, then to ' + sw.get + '.'); setText('swTerms', 'min received —'); swRenderGo(); return; }
    var T = swTokens(), E = window.ethers;
    var amountIn = swParse(inp.value, T[sw.pay].dec);
    if (amountIn == null) { outEl.value = ''; setText('swQuote', 'Type an amount for a quote.'); setText('swTerms', 'min received —'); swRenderGo(); return; }
    /* the whole HYPE balance typed by hand left nothing for gas, and the wallet's error read like no HYPE at all */
    var bal = sw.bal[sw.pay];
    if (bal != null) {
      var room = T[sw.pay].native ? (bal > SW_GAS_KEEP ? bal - SW_GAS_KEEP : 0n) : bal;
      if (amountIn > room) {
        outEl.value = '';
        setText('swQuote', T[sw.pay].native ? 'Keep about 0.01 HYPE for network fees: Max fills the most you can swap.' : 'That is more ' + sw.pay + ' than this wallet has.');
        setText('swTerms', 'min received —'); swRenderGo(); return;
      }
    }
    var seq = ++sw.seq;
    var q = route.kind === 'v3' ? swV3Quote(route, T[sw.pay].addr, amountIn) : swV2Quote(T[sw.pay].addr, T[sw.get].addr, amountIn);
    q.then(function (r) {
      if (seq !== sw.seq) return;
      var out = r.out, impact = r.impact;
      var minOut = out > 0n ? swMinOut(out, sw.slip, impact) : null;
      outEl.value = out > 0n ? swFmt(out, T[sw.get].dec) : '';
      var unit = Number(E.formatUnits(out, T[sw.get].dec)) / amt;
      setText('swQuote', '1 ' + sw.pay + ' = ' + String(Number(unit.toPrecision(5))) + ' ' + sw.get + ' · moves the pool ' + impact.toFixed(impact < 0.1 ? 2 : 1) + '% · ' + (route.kind === 'v3' ? 'HyperSwap V3' : 'HyperSwap V2'));
      if (minOut == null) { setText('swTerms', 'Too big for this pool right now: try a smaller amount.'); swRenderGo(); return; }
      sw.quote = { route: route, amountIn: amountIn, out: out, minOut: minOut, impact: impact, at: Date.now(), slip: sw.slip };
      if (sw.pay === 'HYPE' && sw.get === 'USDC') swNoteHypeUsd(amountIn, out);
      setText('swTerms', 'min received ' + swFmt(minOut, T[sw.get].dec) + ' ' + sw.get);
      swRenderGo();
    }).catch(function () {
      if (seq !== sw.seq) return;
      outEl.value = ''; setText('swQuote', 'No quote right now. Try again in a moment.'); setText('swTerms', 'min received —'); swRenderGo();
    });
  }

  function swRefreshBalances() {
    var T = swTokens();
    if (!wallet.account || !read.provider) { sw.bal = {}; swRenderBalances(); return; }
    swLearnHypeUsd();
    var E = window.ethers;
    ['HYPE', 'USDC', 'FETTI'].forEach(function (k) {
      var t = T[k];
      var p = t.native ? read.provider.getBalance(wallet.account) : new E.Contract(t.addr, ERC20_ABI, read.provider).balanceOf(wallet.account);
      p.then(function (b) { sw.bal[k] = b; swRenderBalances(); }).catch(function () { /* unreadable: keeps the dash */ });
    });
  }
  function swRenderBalances() {
    var T = swTokens();
    setText('swPayBal', sw.bal[sw.pay] != null ? swFmt(sw.bal[sw.pay], T[sw.pay].dec) : '—');
    setText('swGetBal', sw.bal[sw.get] != null ? swFmt(sw.bal[sw.get], T[sw.get].dec) : '—');
  }
  function swRenderGo() {
    var b = $('swGo'); if (!b) return;
    var label = !wallet.account ? 'Connect wallet'
      : sw.busy ? (sw.step === 'approve' ? 'Approving ' + sw.pay + '…' : sw.step === 'swap' ? 'Swapping…' : 'Check your wallet…')
      : !sw.quote ? 'Swap'
      : 'Swap ' + sw.pay + ' for ' + sw.get;
    b.textContent = label;
    b.disabled = !!(wallet.account && (sw.busy || !sw.quote));
  }

  function swSend(q, pay, get, desc) {
    /* 20 minutes: min received protects the price; a 2-minute deadline failed a wallet confirm that took longer */
    var E = window.ethers, deadline = Math.floor(Date.now() / 1000) + 1200;
    if (q.route.kind === 'v2') {
      var v2 = new E.Contract(swapCfg().router, SWAP_V2_ABI, wallet.signer);
      var path = [pay.addr, get.addr];
      if (pay.native) return sendTx(desc, v2.swapExactETHForTokensSupportingFeeOnTransferTokens, [q.minOut, path, wallet.account, E.ZeroAddress, deadline, { value: q.amountIn }]);
      return sendTx(desc, v2.swapExactTokensForETHSupportingFeeOnTransferTokens, [q.amountIn, q.minOut, path, wallet.account, E.ZeroAddress, deadline]);
    }
    var v3 = new E.Contract(swapCfg().v3Router, SWAP_V3_ROUTER_ABI, wallet.signer);
    var params = {
      tokenIn: pay.addr, tokenOut: get.addr, fee: q.route.fee,
      // HYPE out: the router keeps the WHYPE and unwraps it to the wallet in the same call
      recipient: get.native ? swapCfg().v3Router : wallet.account,
      deadline: deadline, amountIn: q.amountIn, amountOutMinimum: q.minOut, sqrtPriceLimitX96: 0n,
    };
    var calls = [v3.interface.encodeFunctionData('exactInputSingle', [params])];
    if (get.native) calls.push(v3.interface.encodeFunctionData('unwrapWETH9', [q.minOut, wallet.account]));
    if (pay.native) calls.push(v3.interface.encodeFunctionData('refundETH', []));
    return sendTx(desc, v3.multicall, [calls, pay.native ? { value: q.amountIn } : {}]);
  }

  function swGo() {
    if (sw.busy) return;
    if (!wallet.account) { connect(); return; }
    if (!sw.quote) return;
    var T = swTokens(), E = window.ethers, q0 = sw.quote, pay = T[sw.pay], get = T[sw.get], q = null, desc = '';
    var spender = q0.route.kind === 'v3' ? swapCfg().v3Router : swapCfg().router;
    sw.busy = true; sw.step = null; swRenderGo(); setText('swHint', '');
    var prevHype = ui.hypeWei;
    function take(fq) {
      if (fq.fresh) { sw.quote = fq; swShowQuote(fq); if (sw.pay === 'HYPE' && sw.get === 'USDC') swNoteHypeUsd(fq.amountIn, fq.out); }
      if (fq.worse) { setText('swHint', 'The price moved: the new amount is shown. Tap Swap again to swap at it.'); throw SW_STOP; }
      q = fq; desc = 'Swap ' + swFmt(q.amountIn, pay.dec) + ' ' + pay.sym + ' for ' + get.sym;
    }
    swWalletReady('swHint').then(function (ok) {
      if (!ok) throw SW_STOP;
      return swFresh(q0, pay, get);
    }).then(function (fq) {
      take(fq);
      if (pay.native) return null;
      var tok = new E.Contract(pay.addr, ERC20_ABI, wallet.signer);
      return tok.allowance(wallet.account, spender).then(function (allowance) {
        if (allowance >= q.amountIn) return null;
        sw.step = 'approve'; swRenderGo();
        return sendTx('Approve ' + pay.sym, tok.approve, [spender, q.amountIn]).then(function () {
          return swFresh(q, pay, get).then(take);      // the approval took its time: the quote is checked again
        });
      });
    }).then(function () {
      sw.step = 'swap'; swRenderGo();
      return swSend(q, pay, get, desc);
    }).then(function (rc) {
      toast(desc + ': done.' + (get.sym === 'USDC' ? ' Deposit USDC puts it on the exchange.' : ''), 'ok', txLink(rc.hash));
      $('swPay').value = ''; sw.quote = null; $('swGet').value = '';
      setText('swQuote', 'Type an amount for a quote.'); setText('swTerms', 'min received —');
      swAfterLanded(prevHype);
    }).catch(function (e) {
      if (e === SW_STOP) return;
      setText('swHint', 'The swap did not go through: ' + swError(e));
      if (sw.quote === q0) sw.quote.at = 0;       // the next tap asks the pool again
    }).then(function () { sw.busy = false; sw.step = null; swRenderGo(); });
  }

  function initSwap() {
    var card = $('swapCard'); if (!card) return;
    // the config and the read provider arrive after init: readiness is checked per quote, not here
    var payT = $('swPayToken'), getT = $('swGetToken');
    function onTokens() {
      sw.pay = payT.value; sw.get = getT.value;
      if (sw.pay === sw.get) { sw.get = sw.pay === 'USDC' ? 'HYPE' : 'USDC'; getT.value = sw.get; }
      swRenderBalances(); swQuoteNow();
    }
    payT.addEventListener('change', onTokens);
    getT.addEventListener('change', onTokens);
    $('swFlip').addEventListener('click', function () {
      var a = sw.pay; payT.value = sw.get; getT.value = a; onTokens();
    });
    $('swPay').addEventListener('input', function () {
      clearTimeout(sw.timer); sw.timer = setTimeout(swQuoteNow, 300);
    });
    $('swMax').addEventListener('click', function () {
      var T = swTokens(), b = sw.bal[sw.pay]; if (b == null) return;
      // HYPE: keep 0.01 for gas
      if (T[sw.pay].native) b = b > 10000000000000000n ? b - 10000000000000000n : 0n;
      $('swPay').value = window.ethers.formatUnits(b, T[sw.pay].dec); swQuoteNow();
    });
    Array.prototype.forEach.call($('swSlip').querySelectorAll('[data-slip]'), function (b) {
      b.addEventListener('click', function () {
        sw.slip = Number(b.getAttribute('data-slip'));
        Array.prototype.forEach.call($('swSlip').querySelectorAll('[data-slip]'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        swQuoteNow();
      });
    });
    $('swGo').addEventListener('click', swGo);
    swRenderGo();
  }
  function swOnWallet() { try { swRefreshBalances(); swRenderGo(); } catch (e) { /* never blocks the page */ } }


  /* ---- Limit orders (the owner, 2026-10-25: "add limit orders to confetti") --------------------------------
     The Exchange has no order type but market (its session router is immutable, so a contract-side order book
     would need a redeploy); this is the client-side kind: the order lives in this browser (per wallet), the page
     watches the prices it already streams, and when the price reaches the limit it files the same open request
     the BUY / SELL buttons file (the one-click session key, else the wallet), which the keeper fills a few seconds
     later at the oracle. So an order fires only while this page is open: the hint under the price says so, and
     the Orders tab lists what is waiting. Desktop only for now (the controls show from 901 px).

     Reviewed 2026-10-25 (four lenses, three refuters a claim). Since then: the ticket's own checks run on the
     order's numbers before anything is sent; the order is stamped claimed and leaves the list only once the chain
     has the request, a refusal holds it five minutes and its row says why; storage is the one list across tabs
     (another tab's write reloads it here, a claim stamp keeps two tabs from sending the same order); the
     placement guard uses the trigger's own band; a duplicate is refused; the price clears on a market switch;
     the rows tick with the price; a browser that keeps no storage says so; below 901 px the ticket stays on
     Market. */
  var lim = { type: 'market', px: NaN, orders: [], firing: null, unsaved: false, forKey: null };
  var LIM_EXPIRY_MS = 24 * 3600 * 1000;
  var LIM_CLAIM_MS = 60000;        // a claimed order is on its way from some tab for this long
  var LIM_HOLD_MS = 5 * 60000;     // a refused order waits this long before it tries again
  function limKey() { return wallet.account && !DEMO ? 'confetti.trade.limits.' + wallet.account.toLowerCase() : 'confetti.trade.limits.demo'; }
  function limLoad() {
    var k = limKey(), raw = lsGet(k);
    if (raw == null && lim.unsaved && lim.forKey === k) { renderLimits(); return; }   // storage blocked: this tab's list stays
    lim.forKey = k;
    try { lim.orders = JSON.parse(raw || '[]') || []; } catch (e) { lim.orders = []; }
    renderLimits();
  }
  function limSave() {
    var s = JSON.stringify(lim.orders); lsSet(limKey(), s);
    /* a browser that keeps no site data said "placed" and lost the order on the next wallet event */
    if (lim.orders.length && lsGet(limKey()) !== s && !lim.unsaved) { lim.unsaved = true; lim.forKey = limKey(); toast('This browser is not saving orders: the limit lives only until this tab closes.', 'err'); }
    renderLimits();
  }
  /* The trigger rule (the owner's pick, 2026-10-25: early): a buy limit fires when the price is within LIM_TOL
     above it, a sell limit within LIM_TOL below, so the fill, which lands at the oracle 2-3 s later, settles near
     the limit instead of a hair past it. 0.001 = 0.1 %. */
  var LIM_TOL = 0.001;
  function limitCrossed(o, px) {
    return o.isLong ? px <= o.limitPx * (1 + LIM_TOL) : px >= o.limitPx * (1 - LIM_TOL);
  }
  function limitLabel() {
    var b = $('actionBtn'); if (!b || lim.type !== 'limit' || state.busy || tk.phase) return;
    var t = b.textContent || '';
    if (/^OPEN /.test(t)) b.textContent = t.replace(/^OPEN /, 'LIMIT ') + (lim.px > 0 ? ' @ ' + fmtPrice(lim.px, state.market ? state.market.szDecimals : 4) : '');
    var h = $('actionHint'); if (h && !h.classList.contains('is-err')) h.textContent = 'Stored in this browser. Fires while this page is open.';
  }
  function setOrderType(type) {
    lim.type = type;
    var box = $('dkOrderType'); if (box) Array.prototype.forEach.call(box.querySelectorAll('[data-otype]'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-otype') === type ? 'true' : 'false'); });
    var row = $('dkLimitBox'); if (row) row.hidden = type !== 'limit';
    if (type === 'limit') {
      var inp = $('dkLimitPx'), now = marketPrice(state.market);
      if (inp && !(Number(inp.value) > 0) && isFinite(now) && now > 0) { inp.value = String(Number(now.toPrecision(6))); lim.px = Number(inp.value); }
      if (inp) inp.focus();
    }
    renderForm(); renderAction();
  }
  function placeLimit() {
    var m = state.market; if (!m) return;
    var px = Number(lim.px), now = marketPrice(m), isLong = form.side === 'long';
    if (!(px > 0)) { toast('Type a limit price.', 'err'); return; }
    /* the trigger fires inside LIM_TOL of the price, so a limit inside that band is a market order with a
       two-toast delay: refuse it with the same words */
    if (isFinite(now) && now > 0 && limitCrossed({ isLong: isLong, limitPx: px }, now)) {
      toast((isLong ? 'A buy limit at or above the price' : 'A sell limit at or below the price') + ' would fill right now: use Market, or set the price ' + (isLong ? 'lower' : 'higher') + '.', 'err');
      return;
    }
    /* a double-click, or Enter twice in the price box, placed the same limit twice */
    var dup = lim.orders.some(function (x) { return x.sym === m.symbol && x.isLong === isLong && x.limitPx === px && x.margin === form.margin && x.lev === form.lev; });
    if (dup) { toast('That limit is already placed: see Orders.', 'err'); return; }
    var o = { id: 'L' + Date.now().toString(36), sym: m.symbol, coin: m.coin, isLong: isLong, margin: form.margin, lev: form.lev, maxed: !!form.maxed, limitPx: px, szDec: m.szDecimals, at: Date.now(), expires: Date.now() + LIM_EXPIRY_MS };
    lim.orders.push(o); limSave();
    toast('Limit placed: ' + sideWord(isLong) + ' ' + m.symbol + ' ' + form.lev + 'x · ' + fmtUsd(form.margin) + ' at ' + fmtPrice(px, m.szDecimals) + '. It fires from this page while it is open.', 'ok');
    var b = $('actionBtn'); if (b) { b.disabled = true; setTimeout(renderAction, 600); }
    var tab = $('tabOrders'); if (tab) tab.click();
  }
  /* The price digits of an order's market (the ticket's rule); 0 is a value: DOGE, WIF, PEPE, PUMP and most
     of the book have 0 size decimals. Orders saved before szDec existed fall back to the market's. */
  function limDec(o) {
    if (o.szDec != null) return o.szDec;
    var m = state.bySym[o.sym]; return m && m.szDecimals != null ? m.szDecimals : 4;
  }
  function cancelLimit(id) {
    lim.orders = lim.orders.filter(function (o) { return o.id !== id; }); limSave();
  }
  /* The ticket's own checks (balance, min margin, the leverage cap, a paused market, room on the book), asked
     with the order's numbers instead of the form's. */
  function limitProblem(o, m) {
    var keep = { market: state.market, side: form.side, margin: form.margin, lev: form.lev };
    state.market = m; form.side = o.isLong ? 'long' : 'short'; form.margin = o.margin; form.lev = o.lev;
    var why = '';
    try { why = orderProblem() || ''; } finally { state.market = keep.market; form.side = keep.side; form.margin = keep.margin; form.lev = keep.lev; }
    return why;
  }
  /* A refused order stays placed, waits LIM_HOLD_MS, and its row says why (once, in a toast). */
  function limHold(o, why) {
    var cur = lim.orders.filter(function (x) { return x.id === o.id; })[0] || o;
    cur.hold = why; cur.until = Date.now() + LIM_HOLD_MS; delete cur.claimed; limSave();
    toast('Limit for ' + o.sym + ' is held: ' + why + ' It stays placed; Cancel it in Orders if you did not want it.');
  }
  /* Why a row is not firing, in a few words (blank while it simply waits for its price). */
  function limStatus(o) {
    if (!wallet.account) return 'waiting for a wallet';
    if (!sessionLive() && wallet.chainId !== CHAIN_ID) return 'waiting: wallet on another network';
    if (o.claimed) return 'opening';
    if (o.until > Date.now()) return 'held: ' + o.hold;
    if (acct.loaded && acct.available < o.margin) return 'waiting: balance short';
    return '';
  }
  function checkLimits() {
    if (!lim.orders.length) return;
    var now = Date.now();
    var gone = lim.orders.filter(function (o) { return o.expires < now; });    // the sweep runs whatever the ticket shows
    if (gone.length) { lim.orders = lim.orders.filter(function (o) { return o.expires >= now; }); limSave(); gone.forEach(function (o) { toast('Limit expired: ' + sideWord(o.isLong) + ' ' + o.sym + ' at ' + fmtPrice(o.limitPx, limDec(o)) + '.'); }); }
    /* a refunded (or opened / error) card used to block every limit until OK was pressed; only a request on its
       way to the chain does now */
    if (lim.firing || state.busy || tk.phase === 'wallet' || tk.phase === 'req') return;
    for (var i = 0; i < lim.orders.length; i++) {
      var o = lim.orders[i], px = state.mids[o.coin];
      if (o.claimed) {
        if (now - o.claimed < LIM_CLAIM_MS) continue;                                  // some tab is sending it
        /* a claim this old means the tab that sent it went away mid-request: the outcome is unknown, so the
           order waits for the user rather than opening a second position */
        delete o.claimed; o.hold = 'another tab was sending it. Check Your positions, then Cancel it or place it again.'; o.until = o.expires; limSave();
        continue;
      }
      if (o.until > now) continue;                                                     // held after a refusal
      if (o.hold) { delete o.hold; delete o.until; limSave(); }
      if (px > 0 && limitCrossed(o, px) && fireLimit(o, px)) return;                   // a refused order lets the next one try
    }
  }
  /* A crossed order: the ticket's checks, a fresh read of storage (another tab may have fired or cancelled it),
     the claim stamp, then the same open request the button files. Returns true once a request is on its way. */
  function fireLimit(o, px) {
    if (!wallet.account || !hasExchange() || !acct.loaded) return false;      // waits, connected or not
    if (!sessionLive() && wallet.chainId !== CHAIN_ID) return false;          // waits too; the row says so
    if (Date.now() - (o.tried || 0) < 15000) return false;                    // one attempt per 15 s per order
    o.tried = Date.now();
    if (!tradeReady()) return false;
    var m = state.bySym[o.sym]; if (!m || m.instrumentId == null) return false;
    var why = limitProblem(o, m);
    if (why) { limHold(o, why); return false; }
    var fresh = []; try { fresh = JSON.parse(lsGet(limKey()) || '[]') || []; } catch (e) { fresh = []; }
    var mine = fresh.filter(function (x) { return x.id === o.id; })[0];
    if (lsGet(limKey()) != null && (!mine || (mine.claimed && Date.now() - mine.claimed < LIM_CLAIM_MS))) { limLoad(); return false; }   // gone, or another tab has it
    lim.firing = o.id;
    if (state.market !== m) selectMarket(o.sym);
    setSide(o.isLong ? 'long' : 'short');
    form.margin = o.margin; form.maxed = !!o.maxed; form.lev = o.lev;         // form.lev direct: no clamp, no LS.lev write
    var mi = $('marginInput'); if (mi) mi.value = String(o.margin);          // the box says what the button says
    renderAmountChips(); renderLeverage(); renderForm(); renderAction();
    o.claimed = Date.now(); limSave();                                        // claimed, not gone: other tabs skip it
    toast('Limit hit: ' + sideWord(o.isLong) + ' ' + o.sym + ' at ' + fmtPrice(px, m.szDecimals) + ' — opening.', 'ok');
    submitOpen(function (filed) {
      if (filed) { lim.orders = lim.orders.filter(function (x) { return x.id !== o.id; }); limSave(); }
      else limHold(o, 'the request was not sent.');
    });
    if (!state.busy) limHold(o, 'the wallet cannot trade right now.');       // submitOpen returned before sending
    setOrderType('market');     // the ticket is back on Market: the next click is not a second limit at a stale price
    lim.px = NaN; var lp = $('dkLimitPx'); if (lp) lp.value = '';
    setTimeout(function () { lim.firing = null; }, 3000);
    return true;
  }
  function renderLimits() {
    var host = $('limLines'), empty = $('limEmpty'), tab = $('tabOrders'); if (!host || !empty) return;
    Array.prototype.forEach.call(host.querySelectorAll('.lim-line'), function (n) { n.remove(); });
    empty.hidden = lim.orders.length > 0;
    empty.textContent = !(wallet.account || DEMO) ? 'Connect a wallet to see your limit orders.'
      : !isDesk() ? 'Limit orders are on the desktop site for now.'
      : 'No limit orders. Pick Limit in the ticket, set a price, and place one.';
    if (tab) tab.textContent = 'Orders' + (lim.orders.length ? ' (' + lim.orders.length + ')' : '');
    lim.orders.forEach(function (o) {
      var line = el('div', 'lim-line'); line.setAttribute('data-id', o.id);
      var side = el('span', 'lim-side ' + (o.isLong ? 'is-long' : 'is-short'), sideWord(o.isLong).toUpperCase());
      var what = el('span', 'grow'); what.appendChild(el('b', '', o.sym + ' ' + o.lev + 'x')); what.appendChild(document.createTextNode(' · ' + fmtUsd(o.margin) + ' at '));
      what.appendChild(el('b', '', fmtPrice(o.limitPx, limDec(o))));
      var now = state.mids[o.coin];
      what.appendChild(el('span', 'lim-now', now > 0 ? ' · now ' + fmtPrice(now, limDec(o)) : ''));
      what.appendChild(el('span', 'xs faint lim-why', limStatus(o) ? ' · ' + limStatus(o) : ''));
      var when = el('span', 'xs faint', 'expires ' + fmtWhen(Math.floor(o.expires / 1000)));
      var cancel = el('button', 'btn btn-sm', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', function () { cancelLimit(o.id); });
      line.appendChild(side); line.appendChild(what); line.appendChild(when); line.appendChild(cancel);
      host.insertBefore(line, empty.nextSibling);
    });
  }
  /* The rows' live bits (the now price, why a row waits) on every price tick: text only, so a Cancel under the
     cursor survives. */
  function limTick() {
    lim.orders.forEach(function (o) {
      var line = document.querySelector('#limLines .lim-line[data-id="' + o.id + '"]'); if (!line) return;
      var now = state.mids[o.coin], n = line.querySelector('.lim-now'), w = line.querySelector('.lim-why');
      if (n && now > 0) n.textContent = ' · now ' + fmtPrice(now, limDec(o));
      if (w) w.textContent = limStatus(o) ? ' · ' + limStatus(o) : '';
    });
  }
  function initLimits() {
    var box = $('dkOrderType'); if (!box) return;
    document.documentElement.setAttribute('data-limits', '1');
    Array.prototype.forEach.call(box.querySelectorAll('[data-otype]'), function (b) { b.addEventListener('click', function () { setOrderType(b.getAttribute('data-otype')); }); });
    var inp = $('dkLimitPx');
    if (inp) {
      inp.addEventListener('input', function () { lim.px = Number(inp.value); renderForm(); renderAction(); });
      inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } });   // a trade needs the button, as in the amount box
    }
    var _renderAction = renderAction;
    renderAction = function () { _renderAction(); limitLabel(); };
    /* a second tab of the same wallet kept its own copy of the list and fired (or brought back) orders the first
       tab had fired or cancelled; storage is the one list, so another tab's write reloads it here */
    window.addEventListener('storage', function (ev) { if (ev.key === limKey()) limLoad(); });
    onDeskChange(function () { if (!isDesk() && lim.type === 'limit') setOrderType('market'); renderLimits(); });   // the picker is gone below 901 px: so is Limit mode
    limLoad();
  }

  /* ---- Take profit / Stop loss (the owner, 2026-10-26: "set it up the best way") -------------------------------
     v4's Exchange takes a close only from the trader's wallet or the SessionRouter fixed at deploy, so a TP/SL is
     not an on-chain order. It is a rule this browser keeps per position (storage, as the limit orders) and fires
     as the same close request the Close button sends, through the session key when one-click is on. It works
     while this page is open; the ticket, the rows and the phone sheet say so. A rule typed before the open is
     parked under the request id and adopted when PositionOpened names the position. */
  var tpsl = { rules: {}, pending: {}, firing: null, forKey: null, unsaved: false, editing: {} };
  var TPSL_CLAIM_MS = 60000;       // a claimed rule is closing from some tab for this long
  var TPSL_HOLD_MS = 5 * 60000;    // a refused close waits this long before it tries again
  function tpslKey() { return wallet.account && !DEMO ? 'confetti.trade.tpsl.' + wallet.account.toLowerCase() : 'confetti.trade.tpsl.demo'; }
  function tpslLoad() {
    var k = tpslKey(), raw = lsGet(k);
    if (raw == null && tpsl.unsaved && tpsl.forKey === k) { tpslRedraw(); return; }   // storage blocked: this tab's rules stay
    tpsl.forKey = k;
    var d = null; try { d = JSON.parse(raw || 'null'); } catch (e) { d = null; }
    tpsl.rules = (d && d.rules) || {}; tpsl.pending = (d && d.pending) || {};
    tpslRedraw();
  }
  function tpslSave() {
    var s = JSON.stringify({ rules: tpsl.rules, pending: tpsl.pending }); lsSet(tpslKey(), s);
    if ((Object.keys(tpsl.rules).length || Object.keys(tpsl.pending).length) && lsGet(tpslKey()) !== s && !tpsl.unsaved) {
      tpsl.unsaved = true; tpsl.forKey = tpslKey();
      toast('This browser is not saving site data: the take profit / stop loss lives only until this tab closes.', 'err');
    }
    tpslRedraw();
  }
  function tpslNum(v) { v = String(v == null ? '' : v).trim(); if (v === '') return null; var n = Number(v); return isFinite(n) ? n : NaN; }
  function tpslDec(pos) { var m = positionMarket(pos); return m && m.szDecimals != null ? m.szDecimals : 4; }
  /* The checks: a take profit on the winning side of the price, a stop on the losing side and short of the
     liquidation price (a stop past it could never fire: the position is liquidated first). entry is the
     position's price (the price itself for the ticket). Returns the sentence that refuses, or ''. */
  function tpslProblem(isLong, lev, entry, px, tp, sl, sz) {
    var side = sideWord(isLong).toLowerCase(), bust = bustPriceNum(entry, isLong, lev);
    if (tp != null && !(tp > 0)) return 'Type a take profit price, or leave it empty.';
    if (sl != null && !(sl > 0)) return 'Type a stop loss price, or leave it empty.';
    if (tp == null && sl == null) return 'Type a take profit or a stop loss price.';
    if (tp != null && px > 0 && (isLong ? tp <= px : tp >= px)) return 'A take profit for a ' + side + ' goes ' + (isLong ? 'above' : 'below') + ' the price, now ' + fmtPrice(px, sz) + '.';
    if (sl != null && px > 0 && (isLong ? sl >= px : sl <= px)) return 'A stop loss for a ' + side + ' goes ' + (isLong ? 'below' : 'above') + ' the price, now ' + fmtPrice(px, sz) + '.';
    if (sl != null && bust > 0 && (isLong ? sl <= bust : sl >= bust)) return 'That stop is past the liquidation price, ' + fmtPrice(bust, sz) + ': the position would be liquidated first. Set it ' + (isLong ? 'higher' : 'lower') + '.';
    return '';
  }
  /* The ticket's two boxes (desktop): what they ask for the next open, and why it is refused. */
  function tpslTicketWant(m, isLong, lev) {
    var ti = $('dkTpPx'), si = $('dkSlPx');
    if (!ti || !si || !isDesk() || !m) return { tp: null, sl: null, why: '' };
    var tp = tpslNum(ti.value), sl = tpslNum(si.value);
    if (tp == null && sl == null) return { tp: null, sl: null, why: '' };
    var px = marketPrice(m);
    return { tp: tp, sl: sl, why: tpslProblem(isLong, lev, px, px, tp, sl, m.szDecimals) };
  }
  function tpslTicketCheck() {
    var m = state.market, ti = $('dkTpPx'), si = $('dkSlPx'), h = $('dkTpSlHint'); if (!m || !ti || !si) return;
    var w = tpslTicketWant(m, form.side === 'long', form.lev);
    ti.classList.toggle('is-bad', !!w.why && tpslNum(ti.value) != null && /take profit/i.test(w.why));
    si.classList.toggle('is-bad', !!w.why && tpslNum(si.value) != null && /stop/i.test(w.why));
    if (h) h.textContent = w.why || ((w.tp != null || w.sl != null) ? 'Set for the next open. Closes from this page while it is open.' : 'Optional. Closes the position for you from this page while it is open.');
  }
  function tpslPark(reqId, want, m, isLong, lev) {
    tpsl.pending[reqId] = { tp: want.tp, sl: want.sl, sym: m.symbol, isLong: isLong, lev: lev, at: Date.now() }; tpslSave();
    var ti = $('dkTpPx'), si = $('dkSlPx'); if (ti) ti.value = ''; if (si) si.value = ''; tpslTicketCheck();
  }
  function tpslAdopt(reqId, pid) {
    var w = tpsl.pending[reqId]; if (!w) return;
    delete tpsl.pending[reqId];
    tpsl.rules[pid] = { tp: w.tp, sl: w.sl, at: Date.now() }; tpslSave();
    toast('Take profit / stop loss set on your ' + sideWord(w.isLong) + ' ' + w.sym + '. It closes from this page while it is open.');
  }
  function tpslDropPending(reqId) { if (tpsl.pending[reqId]) { delete tpsl.pending[reqId]; tpslSave(); } }
  function tpslSet(pid, tp, sl) {
    var p = posById(pid); if (!p) return 'That position is gone.';
    var px = closePriceFor(p); if (!(px > 0)) px = marketPrice(positionMarket(p));
    var why = tpslProblem(p.isLong, p.leverage, p.entry, px, tp, sl, tpslDec(p)); if (why) return why;
    tpsl.rules[pid] = { tp: tp, sl: sl, at: Date.now() }; tpslSave();
    return '';
  }
  function tpslClear(pid) { if (tpsl.rules[pid]) { delete tpsl.rules[pid]; tpslSave(); } }
  /* The trigger rule: 'tp' when the take profit fires, 'sl' for the stop loss, '' to wait. The close lands at the
     oracle 2-3 s after it fires, so the stop fires LIM_TOL (0.1 %) before its level, as the limit orders do (the
     owner's pick, 2026-10-25: early), so the loss stays inside the stop; the take profit waits for the touch. */
  function tpslCrossed(rule, pos, px) {
    if (rule.tp != null && rule.tp > 0 && (pos.isLong ? px >= rule.tp : px <= rule.tp)) return 'tp';
    if (rule.sl != null && rule.sl > 0 && (pos.isLong ? px <= rule.sl * (1 + LIM_TOL) : px >= rule.sl * (1 - LIM_TOL))) return 'sl';
    return '';
  }
  function tpslStatus(pid) {
    var r = tpsl.rules[pid]; if (!r) return '';
    if (r.claimed) return 'closing';
    if (r.until > Date.now()) return 'held: ' + r.hold;
    if (!wallet.account) return 'waiting for a wallet';
    if (!sessionLive()) return 'your wallet asks to confirm the close';
    return '';
  }
  function checkTpSl() {
    var pids = Object.keys(tpsl.rules); if (!pids.length) return;
    var now = Date.now();
    /* rules of positions that are gone (closed by hand, liquidated, another tab) leave quietly */
    if (wallet.account && acct.loaded) {
      var changed = false;
      pids.forEach(function (pid) { if (!posById(pid) && !acct.closeReqs[pid] && !ui.closing[pid] && !ui.checking[pid] && !ui.settling[pid]) { delete tpsl.rules[pid]; changed = true; } });
      if (changed) { tpslSave(); pids = Object.keys(tpsl.rules); }
    }
    if (tpsl.firing || state.busy || tk.phase === 'wallet' || tk.phase === 'req') return;
    for (var i = 0; i < pids.length; i++) {
      var pid = pids[i], r = tpsl.rules[pid], p = posById(pid); if (!p) continue;
      if (acct.closeReqs[pid] || ui.closing[pid] || ui.checking[pid] || ui.settling[pid]) continue;
      if (r.claimed) {
        if (now - r.claimed < TPSL_CLAIM_MS) continue;                                  // some tab is closing it
        /* a claim this old means the tab that sent it went away mid-request: the outcome is unknown */
        delete r.claimed; r.hold = 'another tab was closing it. Check the position, then set it again.'; r.until = now + TPSL_HOLD_MS; tpslSave();
        continue;
      }
      if (r.until > now) continue;                                                      // held after a refusal
      if (r.hold) { delete r.hold; delete r.until; tpslSave(); }
      var px = closePriceFor(p); if (!(px > 0)) px = marketPrice(positionMarket(p));
      var which = px > 0 ? tpslCrossed(r, p, px) : '';
      if (which && fireTpSl(pid, p, r, which, px)) return;                              // one close at a time
    }
  }
  /* A crossed rule: a fresh read of storage (another tab may have fired or removed it), the claim stamp, then the
     same close the button sends. Returns true once a request is on its way. */
  function fireTpSl(pid, p, r, which, px) {
    if (!wallet.account || !hasExchange() || !acct.loaded) return false;
    if (!sessionLive() && wallet.chainId !== CHAIN_ID) return false;
    if (Date.now() - (r.tried || 0) < 15000) return false;                     // one attempt per 15 s per position
    r.tried = Date.now();
    if (!tradeReady()) return false;
    var fresh = null; try { fresh = JSON.parse(lsGet(tpslKey()) || 'null'); } catch (e) { fresh = null; }
    var mine = fresh && fresh.rules ? fresh.rules[pid] : null;
    if (lsGet(tpslKey()) != null && (!mine || (mine.claimed && Date.now() - mine.claimed < TPSL_CLAIM_MS))) { tpslLoad(); return false; }
    tpsl.firing = pid; r.claimed = Date.now(); tpslSave();
    toast((which === 'tp' ? 'Take profit hit: ' : 'Stop loss hit: ') + 'closing your ' + posLabel(p) + ' at ' + fmtPrice(px, tpslDec(p)) + '.', 'ok');
    submitClose(p).then(function (ok) {
      var cur = tpsl.rules[pid];
      if (ok) { delete tpsl.rules[pid]; tpslSave(); }
      else if (cur) { delete cur.claimed; cur.hold = 'the close was not sent. It tries again in a few minutes; Close it by hand if you want it now.'; cur.until = Date.now() + TPSL_HOLD_MS; tpslSave(); }
    });
    setTimeout(function () { tpsl.firing = null; }, 3000);
    return true;
  }
  /* The line under a position card or row: the levels and a status, Edit / Remove, or the one button to set them;
     the inline editor while editing. */
  function tpslSub(p) { var sub = el('div', 'tpsl-sub'); sub.setAttribute('data-for', String(p.id)); tpslFill(sub, p); return sub; }
  function tpslSubFor(pid) { return document.querySelector('#posLines .tpsl-sub[data-for="' + pid + '"]'); }
  function tpslWhy(pid) { return tpslStatus(pid) ? '· ' + tpslStatus(pid) : '· closes from this page while it is open'; }
  function tpslFill(sub, p) {
    var pid = String(p.id), r = tpsl.rules[pid], sz = tpslDec(p);
    sub.textContent = '';
    if (tpsl.editing[pid]) { sub.appendChild(tpslEditor(pid, p)); return; }
    if (r) {
      if (r.tp != null) { sub.appendChild(el('span', '', 'Take profit ')); sub.appendChild(el('b', '', fmtPrice(r.tp, sz))); }
      if (r.sl != null) { sub.appendChild(el('span', '', (r.tp != null ? '· ' : '') + 'Stop loss ')); sub.appendChild(el('b', '', fmtPrice(r.sl, sz))); }
      sub.appendChild(el('span', 'tpsl-why', tpslWhy(pid)));
      var e = el('button', 'btn btn-sm', 'Edit'); e.type = 'button'; e.addEventListener('click', function () { tpsl.editing[pid] = true; tpslRefresh(pid); });
      var c = el('button', 'btn btn-sm', 'Remove'); c.type = 'button'; c.addEventListener('click', function () { tpslClear(pid); toast('Take profit / stop loss removed from your ' + posLabel(p) + '.'); });
      sub.appendChild(e); sub.appendChild(c);
    } else {
      var s = el('button', 'btn btn-sm', 'Take profit / stop loss'); s.type = 'button';
      s.addEventListener('click', function () { tpsl.editing[pid] = true; tpslRefresh(pid); });
      sub.appendChild(s);
    }
  }
  function tpslEditor(pid, p) {
    var r = tpsl.rules[pid] || {}, box = el('div', 'tpsl-edit');
    function field(label, val) {
      var l = el('label', '', label + ' '), i = el('input', 'input');
      i.type = 'number'; i.min = '0'; i.step = 'any'; i.inputMode = 'decimal'; i.placeholder = '—';
      if (val != null) i.value = String(val);
      l.appendChild(i); box.appendChild(l); return i;
    }
    var ti = field('Take profit', r.tp), si = field('Stop loss', r.sl);
    var save = el('button', 'btn btn-sm', 'Save'); save.type = 'button';
    var back = el('button', 'btn btn-sm', 'Cancel'); back.type = 'button';
    var why = el('span', 'tpsl-why', 'Closes from this page while it is open.' + (sessionLive() ? '' : ' Your wallet asks to confirm the close.'));
    save.addEventListener('click', function () {
      var w = tpslSet(pid, tpslNum(ti.value), tpslNum(si.value));
      ti.classList.toggle('is-bad', !!w && /take profit/i.test(w)); si.classList.toggle('is-bad', !!w && /stop/i.test(w));
      if (w) { why.textContent = w; return; }
      delete tpsl.editing[pid]; tpslRefresh(pid); toast('Set on your ' + posLabel(p) + '. It closes from this page while it is open.', 'ok');
    });
    back.addEventListener('click', function () { delete tpsl.editing[pid]; tpslRefresh(pid); });
    [ti, si].forEach(function (i) { i.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); save.click(); } }); });
    box.appendChild(save); box.appendChild(back); box.appendChild(why);
    setTimeout(function () { ti.focus(); }, 0);
    return box;
  }
  function tpslRefresh(pid) { var sub = tpslSubFor(pid), p = posById(pid); if (sub && p) tpslFill(sub, p); }
  function tpslRedraw() {
    Array.prototype.forEach.call(document.querySelectorAll('#posLines .tpsl-sub'), function (sub) {
      var pid = sub.getAttribute('data-for'), p = posById(pid); if (p && !tpsl.editing[pid]) tpslFill(sub, p);
    });
    try { renderPhSheet(); } catch (e) { /* ignore */ }
  }
  /* The status words on every price tick: text only, so an Edit under the cursor survives. */
  function tpslTick() {
    Array.prototype.forEach.call(document.querySelectorAll('#posLines .tpsl-sub'), function (sub) {
      var pid = sub.getAttribute('data-for'); if (!tpsl.rules[pid] || tpsl.editing[pid]) return;
      var w = sub.querySelector('.tpsl-why'); if (w) w.textContent = tpslWhy(pid);
    });
  }
  /* The phone's Position sheet: the two boxes and Save, under the figures. */
  function tpslPhSheet(d, pid, p) {
    var r = tpsl.rules[pid] || {}, ti = phq(d, '.js-ps-tp'), si = phq(d, '.js-ps-sl'), note = phq(d, '.js-ps-tpnote');
    if (d._tpslPid !== pid) {
      d._tpslPid = pid;
      if (ti) { ti.value = r.tp != null ? String(r.tp) : ''; ti.classList.remove('is-bad'); }
      if (si) { si.value = r.sl != null ? String(r.sl) : ''; si.classList.remove('is-bad'); }
    }
    if (note && !note._said) note.textContent = (r.tp != null || r.sl != null)
      ? 'Set. ' + (tpslStatus(pid) ? 'Status: ' + tpslStatus(pid) + '.' : 'Closes while this page is open on your phone.')
      : 'Optional. Closes it for you while this page is open on your phone.';
  }
  function onPhTpSave() {
    var d = $('phPosSheet'), s = ui.phSheet; if (!d || !s || s.mode === 'all') return;
    var pid = s.pid, p = posById(pid); if (!p) return;
    var ti = phq(d, '.js-ps-tp'), si = phq(d, '.js-ps-sl'), note = phq(d, '.js-ps-tpnote');
    var tp = tpslNum(ti ? ti.value : ''), sl = tpslNum(si ? si.value : '');
    function say(t, ms) { if (!note) return; note._said = true; note.textContent = t; setTimeout(function () { note._said = false; try { renderPhSheet(); } catch (e) { /* ignore */ } }, ms); }
    if (tp == null && sl == null) { tpslClear(pid); say('Removed.', 1500); return; }
    var w = tpslSet(pid, tp, sl);
    if (ti) ti.classList.toggle('is-bad', !!w && /take profit/i.test(w));
    if (si) si.classList.toggle('is-bad', !!w && /stop/i.test(w));
    say(w || 'Saved. Closes while this page is open on your phone.', w ? 5000 : 1500);
  }
  function initTpSl() {
    var box = $('dkTpSlBox'), ti = $('dkTpPx'), si = $('dkSlPx');
    if (box) { document.documentElement.setAttribute('data-tpsl', '1'); box.hidden = false; }
    [ti, si].forEach(function (i) {
      if (!i) return;
      i.disabled = false;
      i.addEventListener('input', tpslTicketCheck);
      i.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); i.blur(); } });   // a trade needs the button
    });
    var d = $('phPosSheet'), sb = d ? d.querySelector('.js-ps-tpsave') : null; if (sb) sb.addEventListener('click', onPhTpSave);
    var _renderAction = renderAction;
    renderAction = function () { _renderAction(); try { tpslTicketCheck(); } catch (e) { /* ignore */ } };
    window.addEventListener('storage', function (ev) { if (ev.key === tpslKey()) tpslLoad(); });
    tpslLoad();
  }

  function init() {
    try { initSwap(); } catch (e) { /* the swap card never blocks the page */ }
    try { initOnramp(); } catch (e) { /* the on-ramp never blocks the page */ }
    try { initPosView(); } catch (e) { /* the view switch never blocks the page */ }
    try { initLimits(); } catch (e) { /* limit orders never block the page */ }
    try { initTpSl(); } catch (e) { /* take profit / stop loss never blocks the page */ }
    loadConfig().then(function (c) {
      cfg = c || {};
      cfg.contracts = cfg.contracts || {};
      initHouseBots(cfg.houseBots);
      var bad = pinConfig(cfg);
      initGate();
      start();
      if (bad.length) {
        console.error('config.json does not match the pinned contracts; using the pinned values. Differences: ' + bad.join(', '));
        toast('config.json does not match this site\'s pinned contracts (' + bad.join(', ') + '). Using the pinned addresses.', 'err', null, 0);
      }
    }).catch(function (e) {
      cfg = { contracts: {}, markets: [] };
      pinConfig(cfg);
      initGate();
      start();
      toast('Could not load config.json: ' + (e && e.message ? e.message : e) + '. Serve the site over http and copy config.example.json to config.json.', 'err', null, 0);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
