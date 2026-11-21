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
  var ORACLE_EVERY_MS = 2000;   /* the settlement price of markets with an open position (the P&L cards) */
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
    noConfirm: 'confetti.trade.noconfirm', seen: 'confetti.trade.seen.',
    /* First steps (2026-11-02): '1' per wallet once its first trade is in */
    setup: 'confetti.trade.setup.',
    /* (2026-11-05, the owner: "a way to close the window ... with the tutorial") '1' per wallet (or 'visitor') once its X is hit */
    setupClosed: 'confetti.trade.setupClosed.'
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
    exchange: '0xed8ee016b5684816cfff550f202e211db1d2cdd9',
    exchangeExt: '0xf296441c94736296845bbc7832d3b96c7fccf3cf',
    usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
    oracle: '0x0158c92b46d042a6ee916573756af0e30a93a4a6',
    confetti: '0x995b36d7e33680fc6fa1db6fa4dc8e475b5233a2',
    staking: '0x2Bf4976EB70cdcC03871Ab60977Fc4292587CE9a',
    referrals: '0x7b366431e67f5964b67378c807870d9e2cc72d23',
    priceSource: '0xFaF573187824D176fc74d1de91a072eb6ffa8494',
    marketRules: '0x28e632860ef8d52f56a1950868a06c4ff1587414',
    sessionRouter: '0x3cd25cf3ac32fd4e0455094d7ee5fa2c035daba6',
    depositFactory: '0xbcafdc548c9c922cb1e132dcb8c29a06d0b940e4',
    v2Exchange: '0x257d667a52b282ac0b4c001fd437522bf6b9cbe2',
    v3Exchange: '0x723943c8fdd71e0e670b18d15be737222f3a0810',
    v3Staking: '0x167549bb697f96ee19e0ffbfa5ab5f6487f10051',
    v3Referrals: '0xdf0c59514877f38a7b59bd7db1422217ab25714b',
    codeVaultFactory: '0x99a64dbee205defe571fe427970009ee80a2fa3f',
    v4Exchange: '0x533d0bc51bafeb1519f1bac93d48c175b1496063',
    v4ExchangeExt: '0xd23f1c74a64a5fb6f6a68da854d33d736918cbb0',
    v4Staking: '0x2bf4976eb70cdcc03871ab60977fc4292587ce9a',
    v4Referrals: '0x1dcdbe02568169a777ad6d2b3c5edcf5058780da',
    v4Oracle: '0x1fa6c831868527c65c33e14fd2456855458e03ba',
    v4MarketRules: '0xe1e48bf50b8af7d44e7f1ed3422598e381aab72d',
    v4SessionRouter: '0x5477ab941a551874596aeeb16d3bcf79a120351d',
    v4DepositFactory: '0xe5bb8b4703787f428aaa6a3755add72b9c82fb75',
    v4CodeVaultFactory: '0x72955C3C315890dE44A3dF7bE6Bdc2FB8C69F27d',
    v5Exchange: '',
    v5ExchangeExt: '',
    v5Staking: '',
    v5Referrals: '',
    v5Oracle: '',
    v5MarketRules: '',
    v5SessionRouter: '',
    v5DepositFactory: '',
    v5CodeVaultFactory: '',
    triggerBook: '0xf4D5eBBeB7f4d2fC47497Df23FB38071C625b8D7'
  };
  /* ---- END PINNED CONTRACTS ---- */
  var USDC = CONTRACTS.usdc;
  var CHECKED = ['usdc', 'oracle', 'staking', 'referrals', 'sessionRouter', 'marketRules', 'extension'];
  /* the CHECKED addresses this page sends transactions to (usdc has its own refusal: usdcBad) */
  var TX_TARGETS = { referrals: 'Refer', sessionRouter: 'One-click' };
  var RPC_HOSTS = ['rpc.hyperliquid.xyz', 'hyperliquid.drpc.org', 'rpc.purroofgroup.com', 'rpc.blockfront.network'];
  var INFO_HOSTS = ['api.hyperliquid.xyz'];
  var DEFAULT_RPC = 'https://rpc.hyperliquid.xyz/evm';
  /* Blockfront (2026-11-04, CF_PNL): the owner's own Hyperliquid nodes, which the keeper and the house bots read
     through. Every read of this page goes there first and falls back to config.json's rpcUrl (then the official
     RPC) when it fails or falls behind; the WebSocket's newHeads drives the P&L cards and the fill watch block by
     block. Pinned here like the contracts; config.json "blockfront": false turns it off. Blockfront's eth_getLogs
     takes at most about 1,000 blocks a call on this plan, so the history scans keep config.json's logRpcUrl. */
  var BLOCKFRONT_RPC = 'https://rpc.blockfront.network/v1/confetti/rpc';
  var BLOCKFRONT_WS = 'wss://rpc.blockfront.network/v1/confetti/ws';
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
  var SESSION_GAS_HYPE = '0.02';
  var SESSION_WALLET_KEEP_HYPE = '0.002';
  var SESSION_MIN_GAS = 1000000000000000n; /* 0.001 HYPE: a few requests at a few gwei */
  /* the gas one request or close takes, at the network's fee now: a key under that is dry (2026-10-29: at a
     25-60 gwei base fee a 0.01 HYPE key ran dry in a few trades and every trade quietly went to the wallet) */
  var SESSION_TX_GAS = 400000n;
  /* FORCED ONE-TAP (the owner, 2026-10-29: "can we make it where people are forced to use one tap"): a trade that
     the session cannot carry (none, expired, out of gas, over its cap, another browser's key) first turns one-tap on
     or renews it with one wallet confirmation, then goes through it. The keeper's gas station keeps the keys topped
     up, so after that the wallet only shows for deposits, withdrawals and revoking. */
  var ONE_TAP_FORCED = true;
  var ONE_TAP_DAYS = 30;
  var ONE_TAP_MIN_CAP_USD = 1000;
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

  /* A v5 exchange (config.json "version" >= 5): partial closes and add margin. Below 5 every read
     and call is the v4 one, unchanged. */
  function isV5() { return !!cfg && Number(cfg.version) >= 5; }

  /* A v6 exchange (config.json "version" >= 6): v5 and take profit and stop loss on chain (the TriggerBook, V5P_SPEC
     section 18). Every v5 path stays as it is. */
  function isV6() { return !!cfg && Number(cfg.version) >= 6; }

  /* The Exchange ABI for this config: EXCHANGE_ABI; on v5 with EXCHANGE_V5_ABI's fragments in
     place of the ones of the same name (positions, closeRequest) and its new ones added; on v6 with EXCHANGE_V6_ABI too. */
  function exchangeAbi() {
    if (!isV5()) return EXCHANGE_ABI;
    var head = function (s) { return s.slice(0, s.indexOf('(')); };
    var v5 = {};
    EXCHANGE_V5_ABI.forEach(function (s) { v5[head(s)] = true; });
    return EXCHANGE_ABI.filter(function (s) { return !v5[head(s)]; }).concat(EXCHANGE_V5_ABI, EXCHANGE_V5_FAST_ABI, EXCHANGE_V5_FEE_ABI, isV6() ? EXCHANGE_V6_ABI : []);
  }
  /* The router's fragments for this config: ROUTER_ABI, and on v6 the open with levels and setTriggers. */
  function routerAbi() { return isV6() ? ROUTER_ABI.concat(ROUTER_V6_ABI) : ROUTER_ABI; }

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

  /* CodeVaultFactory.sol: extra referral codes, one small CodeVault contract per code that pays
     its owner. cfg.contracts.codeVaultFactory; without it the "More codes" block stays hidden. */
  var VAULT_FACTORY_ABI = [
    'function create(string code) returns (address)',
    'function claimAll(address[] vaults) returns (uint256)',
    'function vaultsOf(address owner) view returns (address[])',
    'function exchange() view returns (address)',
    'function referrals() view returns (address)',
    'event VaultCreated(address indexed owner, address indexed vault, string code)',
    'error ZeroAddress()',
    'error NotAVault(address vault)',
    'error CodeTaken(string code)'
  ];
  var CODE_VAULT_ABI = [
    'function code() view returns (string)',
    'function earned() view returns (uint256)',
    'function claimable() view returns (uint256)'
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

  /* The v4 Exchange once the config is v5 (contracts.v4Exchange, the run-off): the same three balances behind the
     banner's link to v4.html and Simple's note. To be checked by ops/check_site_abi.js against the v4 build. */
  var V4_EXCHANGE_ABI = [
    'function balanceOf(address user) view returns (uint256 availableUsdc)',
    'function marginInUse(address user) view returns (uint256 usdc)',
    'function pendingOf(address user) view returns (uint256 usdc)'
  ];

  /* v5 (config.json "version" >= 5): partial closes and add margin. positions() and closeRequest()
     each gain one field, appended last, so on a v5 config these two take the place of their
     EXCHANGE_ABI fragments and the rest is added (exchangeAbi); a v4 config never sees them.
     Checked by ops/check_site_abi.js against the compiled IExchange. */
  var EXCHANGE_V5_ABI = [
    'function positions(uint256 positionId) view returns (tuple(address owner, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint96 maxProfitUsdc, uint256 entryPx18, uint64 openedAt, uint16 deadbandBps, uint16 payoutCapX, uint16 winFeeBps, uint16 lossFeeBps, uint16 entryDeadbandBps, uint16 borrowRateX10, uint16 borrowFreeHours, uint64 addedMarginUsdc))',
    'function closeRequest(uint256 positionId) view returns (tuple(uint64 requestedAt, uint256 px0, uint16 bps))',
    'function addMargin(uint256 positionId, uint256 amountUsdc)',
    'function previewAddMargin(uint256 positionId, uint256 amountUsdc) view returns (uint256 collateralUsdc, uint256 bustPx18)',
    'event PositionPartiallyClosed(uint256 indexed positionId, address indexed owner, uint256 exitPx18, int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc, uint256 queuedUsdc, uint256 borrowUsdc, bool keeperFill, uint16 bps, uint128 closedMarginUsdc, uint128 marginUsdc, uint64 addedMarginUsdc, uint96 maxProfitUsdc)',
    'event MarginAdded(uint256 indexed positionId, address indexed owner, uint256 amountUsdc, uint64 addedMarginUsdc, uint256 bustPx18)',
    /* after the second review (V5P_SPEC 16.1): a liquidation on a price from before a margin add judges the position
       without that add and gives it back (MarginReturned, right after PositionLiquidated); marginMark is what such
       a price is judged on */
    'event MarginReturned(uint256 indexed positionId, address indexed owner, uint256 amountUsdc)',
    'function marginMark(uint256 positionId) view returns (uint64 addedAt, uint64 addedBeforeUsdc, uint256 bustBeforePx18)',
    'error CloseBpsOutOfRange(uint16 bps)',
    'error PositionBusted(uint256 positionId, uint256 px18, uint256 bustPx18)'
  ];

  /* The v5 overloads that take a share in bps (10000 = all of it). In no version's EXCHANGE_ABI:
     beside requestClose(uint256) ethers cannot pick an overload once a call carries overrides
     ({ gasLimit }, sendTx), so they get contract objects of their own and are always called by
     their full signature (CLOSE_BPS, PREVIEW_BPS). Checked against the compiled IExchange. */
  var EXCHANGE_V5_BPS_ABI = [
    'function requestClose(uint256 positionId, uint16 bps)',
    'function previewClose(uint256 positionId, uint16 bps) view returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc)'
  ];

  /* SessionRouter (v5): the share close a session key may file, in its own array for the same
     reason. A session key never adds margin (the router has no addMargin). */
  var ROUTER_V5_ABI = [
    'function requestClose(uint256 positionId, uint16 bps)'
  ];
  /* v5 fast pricing (V5P_SPEC, the frozen interface): a market the owner switched to it fills on the one signed
     Pyth print for the request's time + delay; the HyperCore oracle stays as the guard and as the close path when
     Pyth is not there. The page reads which markets are fast and their windows, decodes the print a fill used
     (FillPriced) and names the new refusals. Joined to exchangeAbi() on a v5 config only; a v4 config never sees
     them. Checked by ops/check_site_abi.js against the compiled IExchange. */
  var EXCHANGE_V5_FAST_ABI = [
    'function fastPricing(uint32 instrumentId) view returns (tuple(bool on, uint32 delay, uint16 maxDevBps, uint16 maxConfBps))',
    'function fastWindows() view returns (uint32 fastWindow, uint32 maxPubLag, uint32 liqMaxAge)',
    'function previewCloseAt(uint256 positionId, uint16 bps, uint256 px18) view returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc)',
    'event FillPriced(uint256 indexed key, uint32 indexed instrumentId, uint8 indexed kind, uint64 publishTime, uint256 px18, uint256 conf18)',
    'event FastPricingSet(uint32 indexed instrumentId, bool on, uint32 delay, uint16 maxDevBps, uint16 maxConfBps)',
    'event FastWindowsSet(uint32 fastWindow, uint32 maxPubLag, uint32 liqMaxAge)',
    'error NotFastMarket()',
    'error FastMarket()',
    'error FastWindowOver()',
    'error FastPriceMissed()',
    'error PriceDeviates(uint256 px18, uint256 ref18)',
    'error PriceUncertain(uint256 conf18, uint256 px18)'
  ];

  /* The keeper's three entry points of a fast market. In an array of their own, on no contract object the page
     sends from: the page never calls them. After the keepers' head start anyone may send the first two (V5P_SPEC
     12.1), but a fill needs the signed Pyth update for the request's second and Pyth gives that out with a key
     only, which a public page cannot hold; the page's own fallback is the one-argument executeOpen / executeClose
     after the fast window. Here so the ABI check pins their signatures next to the events they emit. */
  var EXCHANGE_V5_PYTH_ABI = [
    'function executeOpenPyth(uint256 requestId, bytes[] update) payable returns (uint256 positionId)',
    'function executeClosePyth(uint256 positionId, bytes[] update) payable returns (uint256 payoutUsdc, uint256 queuedUsdc)',
    'function liquidatePyth(uint256 positionId, bytes[] update) payable returns (uint256 bountyUsdc)'
  ];
  /* v5, the size fee (V5P_SPEC section 13): each side of a trade pays min(rateX10 / 10 bps of its size, capBps of
     its stake) into the fee pool. The page reads the rate per market, a position's stamp, what a waiting request
     reserved and whether the account is a house wallet (those pay none), and decodes what a fill charged. Joined
     to exchangeAbi() on a v5 config only. setTradeFee is the owner's; it is here so the ABI check pins it. */
  var EXCHANGE_V5_FEE_ABI = [
    'function tradeFee(uint32 instrumentId) view returns (uint16 rateX10, uint16 capBps)',
    'function tradeFeeOf(uint256 positionId) view returns (uint16 shareX10)',
    'function openFeeOf(uint256 requestId) view returns (uint256 feeUsdc)',
    'function isHouseWallet(address wallet) view returns (bool)',
    'function setTradeFee(uint32 instrumentId, uint16 rateX10, uint16 capBps)',
    'event TradeFeeCharged(uint256 indexed positionId, address indexed trader, uint8 indexed kind, uint256 notionalUsdc, uint256 feeUsdc)',
    'event TradeFeeSet(uint32 indexed instrumentId, uint16 rateX10, uint16 capBps)'
  ];
  var CLOSE_BPS = 'requestClose(uint256,uint16)';
  var PREVIEW_BPS = 'previewClose(uint256,uint16)';

  /* v6 (config.json "version" >= 6): take profit and stop loss on chain (V5P_SPEC section 18, the frozen interface of
     v6/tpsl-contracts 07cadb1). The Exchange gains the address of its TriggerBook and the second each market's fast
     pricing was last switched on, and liquidatePyth a refusal (TriggerFirst: a stop loss inside the liquidation price
     owns that exit). Joined to exchangeAbi() on a v6 config only; a v4 or v5 config never sees them. Checked by
     ops/check_site_abi.js against the compiled IExchange. */
  var EXCHANGE_V6_ABI = [
    'function triggerBook() view returns (address)',
    'function fastSince(uint32 instrumentId) view returns (uint64)',
    'error TriggerFirst(uint256 positionId)'
  ];
  /* The Exchange's entry the book alone may call (it settles a fire). On no contract object the page sends from: here
     so the ABI check pins its signature beside the book's. */
  var EXCHANGE_V6_SETTLE_ABI = [
    'function settleTrigger(uint256 positionId, address executor, uint8 kind, uint256 exitPx18, uint64 at, uint256 px18, uint256 conf18)'
  ];
  /* SessionRouter (v6): the open with its levels in one transaction (a session key: requestOpenWithTriggers, with the
     per-trade cap and the session's referrer, as requestOpen; any wallet for itself: openWithTriggers), and a session
     key's setTriggers, which the router forwards to the book for the trader (the book's own setTriggers has the same
     selector by design). Joined to the router's contract objects on a v6 config only. */
  var ROUTER_V6_ABI = [
    'function requestOpenWithTriggers(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint96 tpPx18, uint96 slPx18) returns (uint256 requestId)',
    'function openWithTriggers(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, address referrer, uint96 tpPx18, uint96 slPx18) returns (uint256 requestId)',
    'function setTriggers(uint256 positionId, uint96 tpPx18, uint96 slPx18)'
  ];
  /* TriggerBook.sol (ITriggerBook, v6): created by the Exchange's constructor, its address read from
     exchange.triggerBook() and pinned like the router. Levels are USDT terms at 1e18, the scale of FillPriced.px18 and
     of every price this page shows on a fast market (0 = not set). A record is (tpPx18, slPx18, armedAt): armedAt is
     the first second it may judge, the block time it was written in + the market's fast delay. triggers(id) gives the
     older and the newer record; the newer is in force from its armedAt, the older until then. The page sends
     setTriggers (the wallet; a session key goes through the router) and reads the rest; executeTriggersPyth is
     anyone's with Pyth's signed prints, which a public page cannot hold (a key), so the page never sends it: here so
     the ABI check pins it beside the events it causes. Checked by ops/check_site_abi.js against the compiled
     TriggerBook. */
  var TRIGGER_BOOK_ABI = [
    'function TRIGGER_WINDOW() view returns (uint64)',
    'function exchange() view returns (address)',
    'function oracle() view returns (address)',
    'function router() view returns (address)',
    'function setTriggers(uint256 positionId, uint96 tpPx18, uint96 slPx18)',
    'function setOpenTriggers(uint256 requestId, uint96 tpPx18, uint96 slPx18)',
    'function onOpen(uint256 requestId, uint256 positionId, address trader, uint32 delay)',
    'function executeTriggersPyth(uint32 instrumentId, uint256[] positionIds, uint64 prevAt, uint64 from, bytes[] update, bytes[] prevUpdate) payable returns (uint256 fired)',
    'function triggers(uint256 positionId) view returns (tuple(uint96 tpPx18, uint96 slPx18, uint64 armedAt) older, tuple(uint96 tpPx18, uint96 slPx18, uint64 armedAt) newer)',
    'function triggerAt(uint256 positionId, uint64 second) view returns (tuple(uint96 tpPx18, uint96 slPx18, uint64 armedAt))',
    'function stopAt(uint256 positionId, uint64 second) view returns (uint96 slPx18)',
    'function openTriggers(uint256 requestId) view returns (tuple(uint96 tpPx18, uint96 slPx18, uint64 armedAt))',
    'event TriggersSet(uint256 indexed positionId, address indexed owner, uint96 tpPx18, uint96 slPx18, uint64 armedAt)',
    'event OpenTriggersSet(uint256 indexed requestId, address indexed trader, uint96 tpPx18, uint96 slPx18)',
    'event TriggerFired(uint256 indexed positionId, address indexed owner, uint8 indexed kind, uint64 at, uint256 levelPx18, uint256 exitPx18, bool late)',
    'error Unauthorized()',
    'error UnknownPosition(uint256 positionId)',
    'error UnknownRequest()',
    'error NotPositionOwner(uint256 positionId, address caller)',
    'error NotRequestOwner(uint256 requestId, address caller)',
    'error MarketRetired()',
    'error NotFastMarket()',
    'error TooEarly()',
    'error TriggerSettling(uint64 until)',
    'error NoTrigger(uint256 positionId)',
    'error TriggerNotCrossed(uint256 px18)',
    'error TriggerNotFirst(uint256 prevPx18)',
    'error CloseFirst(uint64 closeAt)',
    'error NothingTriggered()',
    'error PriceUncertain(uint256 conf18, uint256 px18)',
    'error PriceDeviates(uint256 px18, uint256 ref18)'
  ];

  var exIface = null; /* ethers.Interface for exchangeAbi() */
  var refIface = null; /* ethers.Interface for REFERRALS_ABI */
  var vaultIface = null; /* ethers.Interface for VAULT_FACTORY_ABI */
  var routerIface = null; /* ROUTER_ABI */
  var proxyIface = null; /* PROXY_ABI */
  var bookIface = null; /* TRIGGER_BOOK_ABI (v6) */

  /* ---- state --------------------------------------------------------------- */

  var state = {
    markets: [],          /* config markets, enriched: inst (on-chain), instrumentId */
    bySym: {},
    byCoin: {},
    byInstId: {},
    market: null,         /* selected market */
    mids: {},             /* coin -> number */
    midsAt: 0,            /* Date.now() of the last mids that arrived (allMids, or the 1s feed) */
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
    phSheet: null, phFrozen: {}, phResult: {}, phDeepLink: null,
    /* v5: the share closes already reported, by transaction and position */
    partials: {}
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
    oraclePxAt: {},       /* id -> Date.now() of that read */
    oraclePx18ById: {},   /* id -> the same price as the exchange holds it, 1e18 BigInt (the exact P&L works on this) */
    /* owner settings read from the exchange (null until read; see the constants above) */
    winFeeBps: null, lossFeeBps: null, minMargin: null, borrowFreeHours: null, maxWinBps: null, free: null,
    /* per instrument id: { long, short } maxPositionUsd() in USD, read with the chain poll */
    maxPos: {},
    /* why this page sends nothing (v4 gate), or null; see sendGate() */
    gate: null,
    /* request windows in seconds (minDelay / grace / expiry), the jump guard, the fee shares */
    minDelay: 2, grace: 3, expiry: 60, maxJumpBps: null, stakerShareBps: null, referralShareBps: null,
    /* v5 fast pricing: instrument id -> { on, delay, maxDevBps, maxConfBps } as fastPricing(id) answers, and the
       global window after T = request + delay in which a fill on the Pyth print can land (fastWindows(); 5 s by
       default: the fill keepers alone for the first `grace` seconds, then anyone who holds the signed print) */
    fast: {}, fastWindow: 5, maxPubLag: 2, liqMaxAge: 2, fastAt: 0,
    /* v5 size fee: instrument id -> { rateX10, capBps } as tradeFee(id) answers; whether the connected account is a
       house wallet (isHouseWallet: those pay none), and for which account that was read */
    tradeFee: {}, isHouse: false, isHouseFor: null
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
  var pend = { opens: {}, done: {}, timer: null, tick: null, inFlight: false, scanning: false, scan: { account: null, from: Infinity }, lastPoll: 0 };

  /* Referral state for the connected account: the stored ?ref code, its resolved address, the
     account's own code / earnings and whether its referrer is already locked on chain. */
  var ref = { code: lsGet('confetti.ref') || '', addr: null, locked: null, referrer: null, myCode: '', earned: null, loaded: false, vaults: [], vaultsLoaded: false };

  var read = { provider: null, logProvider: null, sendProvider: null, exchange: null, referrals: null, router: null, factory: null, v2: null, v3: null };

  /* The v2 / v3 banners: each shown for the connected account while that Exchange still holds its
     balance, margin or a pending open request (a pending close keeps its position's margin in use). */
  var oldLinks = { v2: { account: null, at: 0, show: false, total: 0 }, v3: { account: null, at: 0, show: false, total: 0 }, v4: { account: null, at: 0, show: false, total: 0 } };

  /* One-click session of the connected account. key: ethers.Wallet from localStorage (or null);
     onchain: router.sessionOf(account) { key, expiry, cap } once read; gasWei: the key's HYPE. */
  var sess = { key: null, onchain: null, gasWei: null, feeWei: null, loaded: false, demoOn: false, nonce: null, nonceFor: null, nonceOk: false, priorityWei: null };
  /* Opens filed through one-tap that have no request on chain yet (the owner, 2026-10-31: "people hate waiting for their
     trades to go through"): list = their cards and chart lines from the tap on, queue = the session key's sends, one at a time. */
  var quick = { list: [], next: 1, last: 0, queue: Promise.resolve() };
  var QUICK_GAP_MS = 800;       // one tap is one trade: a second tap this soon is a double tap, not a second order
  var QUICK_QUEUE_MS = 45000;   // a send that never answers must not hold the next one back for ever

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
      state.midsAt = Date.now();
      setLive(true);
      if (!mids || typeof mids !== 'object') return;
      state.markets.forEach(function (m) {
        var v = Number(mids[m.coin]);
        if (isFinite(v) && v > 0) { state.mids[m.coin] = v; noteMidHist(m.coin, v, state.midsAt); }
      });
      onPrices();
      try { limTick(); } catch (e) { /* never stops the prices */ }
      try { checkLimits(); } catch (e) { /* never stops the prices */ }
      try { tpslTick(); trigBackup(); checkTpSl(); } catch (e) { /* never stops the prices */ }
    }).catch(function () {
      state.midsFailures += 1;
      if (state.midsFailures >= 2) setLive(false);
      /* no new prices: redraw anyway, so a card whose price has gone stale says "price delayed" (settlePrice) */
      try { updatePositionPrices(); renderAccount(); } catch (e) { /* never stops the poll */ }
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
          oraclePx: Number(c.oraclePx), oraclePxStr: c.oraclePx, at: Date.now()
        };
      });
      renderMarketHeader();
      renderMarketMenuPrices();
    }).catch(function () { /* stats are decoration; keep the last values */ })
      .then(function () { ctxInFlight = false; });
  }

  /* ---- chart --------------------------------------------------------------- */

  /* Timeframes: Hyperliquid candleSnapshot intervals and each bucket's length. */
  var TF_MS = { '1s': 1000, '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
  /* 1s (the owner, 2026-10-29: "can we get 1 second candles"): Hyperliquid serves no candles under a minute, so these
     are built here from its live bid/ask feed (liveFeed below): the chart starts empty and fills as you watch. */
  var LIVE_TF = { '1s': true };
  /* A gap shorter than this many bars (the feed was quiet, the tab was away) is filled with flat bars at the last close. */
  var LIVE_GAP_FILL = 120;

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
    on: {}, ind: {}, vals: {}, hover: false, pos: [], posSig: '', lines: [], linesCoin: null, arm: false,
    pick: null   /* the picked position's id: the hover box reads its P&L at the price under the cursor */
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
      timeScale: { borderColor: t.ruleStrong, timeVisible: true, secondsVisible: !!LIVE_TF[chart.tf], rightOffset: 3, barSpacing: 7 },
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
    tradeMarks.sig = '';
    syncTradeMarkers();
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
    syncLiveFeed();
    if (m && chart.series && LIVE_TF[chart.tf]) { startLiveCandles(m); return; }
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
        tradeMarks.sig = '';
        syncTradeMarkers();
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

  /* 1s: nothing to fetch. A new coin starts an empty chart at its price's precision; the feed's mids fill it. */
  function startLiveCandles(m) {
    chart.seq++;
    chart.loading = false;
    if (chart.coin === m.coin) return;
    clearCandles();
    chart.coin = m.coin;
    var px = state.mids[m.coin];
    if (isFinite(px) && px > 0) {
      chart.precision = pricePrecision(px, m.szDecimals);
      chart.series.applyOptions(seriesOptions());
    }
    chartNote('1-second candles start now and fill as you watch', true);
  }

  /* Empty the chart for a new market or timeframe; the next load fills it. */
  function clearCandles() {
    chart.coin = null;
    chart.candles = [];
    chart.byTime = {};
    if (!chart.series) return;
    chart.series.setData([]);
    syncTradeMarkers();
    fillInds(true);
    renderLegend(-1);
  }

  /* Fold a fresh mid into the open bucket of the shown timeframe, or open the next one. */
  function updateChartFromMid(px) {
    if (!chart.series || !state.market || chart.coin !== state.market.coin) return;
    var ms = TF_MS[chart.tf];
    var bucket = Math.floor(Date.now() / ms) * ms;
    if (chart.candles.length === 0) {
      if (!LIVE_TF[chart.tf] || !(px > 0)) return;
      /* the first 1 s bar */
      chart.candles.push({ t: bucket, o: px, h: px, l: px, c: px, v: 0 });
      indexCandles();
      chart.series.setData(chart.candles.map(toBar));
      chart.api.timeScale().scrollToRealTime();
      chartNote('', false);
      placeChartBar();
      fillInds(true);
      if (!chart.hover) renderLegend(-1);
      return;
    }
    var last = chart.candles[chart.candles.length - 1];
    /* 1s: a quiet second still gets its bar (flat at the last close), so the axis keeps time */
    if (LIVE_TF[chart.tf] && bucket - last.t > ms && bucket - last.t <= LIVE_GAP_FILL * ms) {
      for (var gt = last.t + ms; gt < bucket; gt += ms) {
        var flat = { t: gt, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 };
        chart.candles.push(flat);
        chart.series.update(toBar(flat));
      }
      while (chart.candles.length > CANDLE_COUNT) chart.candles.shift();
      last = chart.candles[chart.candles.length - 1];
    }
    if (bucket > last.t) {
      var bar = { t: bucket, o: last.c, h: Math.max(last.c, px), l: Math.min(last.c, px), c: px, v: 0 };
      chart.candles.push(bar);
      if (chart.candles.length > CANDLE_COUNT) chart.candles.shift();
      indexCandles();
      chart.series.update(toBar(bar));
      syncTradeMarkers();
    } else {
      last.c = px;
      if (px > last.h) last.h = px;
      if (px < last.l) last.l = px;
      chart.series.update(toBar(last));
    }
    fillInds(false);
    if (!chart.hover) renderLegend(-1);
  }

  /* ---- your trades on the chart ----
     (the owner, 2026-10-29: "buy and sell markers on the chart for our prior buys and sells"): the connected wallet's
     opens, closes and liquidations on the shown coin, from the history loaded at connect. A long's open and a short's
     close are buys (green, under the bar); a short's open and a long's close are sells (red, over the bar). Each sits on
     the bar its block's time falls in; trades older than the loaded bars, or whose block time is not read yet, wait. */
  var tradeMarks = { sig: '' };

  function syncTradeMarkers() {
    if (!chart.series) return;
    var m = state.market, out = [];
    var cs = chart.candles, ms = TF_MS[chart.tf], t = chartTheme();
    if (m && m.instrumentId != null && chart.coin === m.coin && cs.length) {
      var first = cs[0].t, last = cs[cs.length - 1].t;
      hist.rows.forEach(function (r) {
        if (r.name !== 'PositionOpened' && r.name !== 'PositionClosed' && r.name !== 'PositionLiquidated') return;
        var pid = String(r.args.positionId);
        if (hist.openedMarket[pid] !== m.instrumentId || !(pid in hist.openedLong)) return;
        var ts = hist.blockTs[r.block];
        if (!ts) return;
        var at = Math.floor(ts * 1000 / ms) * ms;
        if (at < first || at > last) return;
        var buy = r.name === 'PositionOpened' ? hist.openedLong[pid] : !hist.openedLong[pid];
        out.push({
          time: barTime(at), position: buy ? 'belowBar' : 'aboveBar', color: buy ? t.pos : t.neg,
          shape: buy ? 'arrowUp' : 'arrowDown',
          text: r.name === 'PositionLiquidated' ? 'Liq' : buy ? 'Buy' : 'Sell'
        });
      });
      out.sort(function (a, b) { return a.time - b.time; });
    }
    var sig = JSON.stringify(out);
    if (sig === tradeMarks.sig) return;
    tradeMarks.sig = sig;
    chart.series.setMarkers(out);
  }

  /* ---- the live bid/ask feed (1s only) ----
     One websocket to Hyperliquid while the 1s timeframe is shown and the tab is visible, subscribed to the shown coin's
     best bid and ask; closed otherwise. Their mid is folded into the chart every LIVE_FOLD_MS and, once a second, into
     the page's price (the 2 s allMids poll keeps running and stays the source on every other timeframe). */
  var LIVE_FOLD_MS = 250, LIVE_PRICE_MS = 1000, LIVE_PING_MS = 30000;
  var liveFeed = { ws: null, coin: null, mid: NaN, fold: null, ping: null, retry: 0, again: null, priced: 0 };

  function liveWsUrl() {
    var info = (cfg && cfg.hyperliquidInfoUrl) || 'https://api.hyperliquid.xyz/info';
    return info.replace(/^https:/, 'wss:').replace(/\/info\/?$/, '/ws');
  }

  function liveSend(msg) {
    var ws = liveFeed.ws;
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch (e) { /* closing */ } }
  }

  function liveSub(coin, on) {
    liveSend({ method: on ? 'subscribe' : 'unsubscribe', subscription: { type: 'bbo', coin: coin } });
  }

  /* Open, move or close the feed to match what is shown. */
  function syncLiveFeed() {
    var want = LIVE_TF[chart.tf] && state.market && !document.hidden ? state.market.coin : null;
    if (!want) { closeLiveFeed(); return; }
    if (liveFeed.ws && liveFeed.coin === want) return;
    if (liveFeed.ws && liveFeed.ws.readyState === 1) {
      liveSub(liveFeed.coin, false);
      liveFeed.coin = want; liveFeed.mid = NaN;
      liveSub(want, true);
      return;
    }
    if (liveFeed.ws) { liveFeed.coin = want; liveFeed.mid = NaN; return; }   /* still connecting: onopen subscribes */
    if (!liveFeed.again) openLiveFeed(want);
  }

  function openLiveFeed(coin) {
    if (typeof WebSocket !== 'function') return;
    var ws;
    try { ws = new WebSocket(liveWsUrl()); } catch (e) { return; }
    liveFeed.ws = ws; liveFeed.coin = coin; liveFeed.mid = NaN;
    ws.onopen = function () {
      if (liveFeed.ws !== ws) return;
      liveFeed.retry = 0;
      liveSub(liveFeed.coin, true);
      liveFeed.ping = setInterval(function () { liveSend({ method: 'ping' }); }, LIVE_PING_MS);
      liveFeed.fold = setInterval(foldLiveMid, LIVE_FOLD_MS);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.channel !== 'bbo' || !msg.data || msg.data.coin !== liveFeed.coin) return;
      var q = msg.data.bbo || [], bid = q[0] && Number(q[0].px), ask = q[1] && Number(q[1].px);
      if (bid > 0 && ask > 0) liveFeed.mid = (bid + ask) / 2;
    };
    ws.onclose = function () {
      if (liveFeed.ws !== ws) return;
      stopLiveTimers();
      liveFeed.ws = null;
      /* dropped while still wanted: back off 1, 2, 4 ... 30 s */
      if (LIVE_TF[chart.tf] && !document.hidden) {
        var wait = Math.min(30000, 1000 * Math.pow(2, liveFeed.retry++));
        liveFeed.again = setTimeout(function () { liveFeed.again = null; syncLiveFeed(); }, wait);
      }
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  function stopLiveTimers() {
    if (liveFeed.fold) { clearInterval(liveFeed.fold); liveFeed.fold = null; }
    if (liveFeed.ping) { clearInterval(liveFeed.ping); liveFeed.ping = null; }
  }

  function closeLiveFeed() {
    if (liveFeed.again) { clearTimeout(liveFeed.again); liveFeed.again = null; }
    stopLiveTimers();
    var ws = liveFeed.ws;
    liveFeed.ws = null; liveFeed.coin = null; liveFeed.mid = NaN;
    if (ws) { try { ws.close(); } catch (e) { /* gone */ } }
  }

  function foldLiveMid() {
    var m = state.market, px = liveFeed.mid;
    if (!m || m.coin !== liveFeed.coin || !(px > 0) || !LIVE_TF[chart.tf]) return;
    updateChartFromMid(px);
    var now = Date.now();
    if (now - liveFeed.priced >= LIVE_PRICE_MS) {
      liveFeed.priced = now;
      state.mids[m.coin] = px;
      state.midsAt = now;
      noteMidHist(m.coin, px, now);
      onPrices();
    }
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
    try { renderHoverPnl(param); } catch (e) { /* the box never stops the chart */ }
  }

  /* ---- hover P&L (the owner, 2026-10-26: "you click on your position and it highlights then you can do the
     hover"; 2026-11-10: "wherever you hover over the chart while you have an open position it shows you what your PnL
     would be at that price", "pnl and position worth"): every position on this market, read at the price under the
     cursor, with its P&L and what it is worth there (what a close would give back). Picking a card narrows it to that
     one; with several and none picked, one line each (up to four) and the total. On a phone the box follows a
     press-and-drag on the chart. ---- */
  var HOVER_ROWS = 4;
  function hoverTargets() {
    var m = state.market;
    if (!m || m.instrumentId == null || !wallet.account) return [];
    var mine = acct.positions.filter(function (p) { return p.instrumentId === m.instrumentId; });
    if (chart.pick) { var picked = mine.filter(function (p) { return String(p.id) === chart.pick; }); if (picked.length) return picked; }
    return mine;
  }
  function hoverTarget() { var t = hoverTargets(); return t.length === 1 ? t[0] : null; }
  function pickPosition(pid) {
    pid = pid == null ? null : String(pid);
    chart.pick = chart.pick === pid ? null : pid;
    Array.prototype.forEach.call(document.querySelectorAll('#posLines .pos-card'), function (c) { c.classList.toggle('is-picked', !!chart.pick && c.getAttribute('data-id') === chart.pick); });
    chart.posSig = ''; syncPositionLines();
    renderHoverPnl(null);
  }
  /* one position at price px: its P&L, what it is worth there (the close payout; 0 past liquidation) */
  function hoverAt(p, px) {
    var inst = state.byInstId[p.instrumentId];
    var queueEmpty = house.queueLen == null ? true : house.queueHead === house.queueLen;
    var est = estimateClose(p, inst, px, queueEmpty);
    var bust = px18ToNum(posBust18(p));
    var busted = bust > 0 && (p.isLong ? px <= bust : px >= bust);
    return { pnl: busted ? -posIn(p) : est.net, worth: busted ? 0 : Math.max(0, est.payout), busted: busted };
  }
  function renderHoverPnl(param) {
    var box = $('chartHoverPnl'), host = $('chartBox');
    if (!box || !host) return;
    var list = param && param.point && chart.series ? hoverTargets() : [];
    if (!list.length) { if (!box.hidden) box.hidden = true; return; }
    var px = chart.series.coordinateToPrice(param.point.y);
    if (px == null || !(px > 0)) { box.hidden = true; return; }
    px = Number(px);
    var dec = tpslDec(list[0]);
    box.textContent = '';
    if (list.length === 1) {
      var p = list[0], r = hoverAt(p, px), pct = p.margin > 0 ? r.pnl / p.margin : 0;
      box.appendChild(el('span', 'k', posLabel(p) + ' at ' + fmtPrice(px, dec)));
      box.appendChild(el('b', r.pnl >= 0 ? 'pos' : 'neg', 'P&L ' + fmtUsd(r.pnl, true) + ' (' + fmtPct(pct, true) + ')'));
      box.appendChild(el('span', 'v', r.busted ? 'Liquidated here: the ' + fmtUsd(posIn(p)) + ' put in is gone' : 'Position worth ' + fmtUsd(r.worth)));
    } else {
      var tp = 0, tw = 0, tm = 0;
      box.appendChild(el('span', 'k', list.length + ' positions at ' + fmtPrice(px, dec)));
      list.forEach(function (q, i) {
        var rq = hoverAt(q, px);
        tp += rq.pnl; tw += rq.worth; tm += q.margin;
        if (i < HOVER_ROWS) box.appendChild(el('span', 'row ' + (rq.pnl >= 0 ? 'pos' : 'neg'), posLabel(q) + '  ' + fmtUsd(rq.pnl, true) + (rq.busted ? ' · liquidated' : ' · worth ' + fmtUsd(rq.worth))));
      });
      if (list.length > HOVER_ROWS) box.appendChild(el('span', 'k', '+ ' + (list.length - HOVER_ROWS) + ' more'));
      box.appendChild(el('b', tp >= 0 ? 'pos' : 'neg', 'Total P&L ' + fmtUsd(tp, true) + ' (' + fmtPct(tm > 0 ? tp / tm : 0, true) + ')'));
      box.appendChild(el('span', 'v', 'Positions worth ' + fmtUsd(tw)));
    }
    box.hidden = false;
    var w = box.offsetWidth, h = box.offsetHeight, W = host.clientWidth, H = host.clientHeight;
    var x = param.point.x + 16, y = param.point.y - h - 10;
    if (x + w > W - 8) x = param.point.x - w - 16;
    if (x < 8) x = 8;
    if (y < 6) y = param.point.y + 16;
    if (y + h > H - 6) y = H - h - 6;
    box.style.left = Math.round(x) + 'px'; box.style.top = Math.round(y) + 'px';
  }
  function initHoverPnl() {
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && chart.pick) pickPosition(null); });
    var box = $('chartBox');
    if (box) box.addEventListener('mouseleave', function () { var b = $('chartHoverPnl'); if (b) b.hidden = true; });
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
    var going = m && wallet.account && m.instrumentId != null
      ? quick.list.concat(pendingOpenList()).filter(function (r) { return r.instrumentId === m.instrumentId && r.px0 > 0; }) : [];
    var sig = mine.map(function (p) { return String(p.id) + ':' + String(p.entryPx18) + ':' + p.leverage + ':' + p.isLong; }).join(',') + '|' + (chart.pick || '')
      + '|' + going.map(function (r) { return (r.id || r.key) + ':' + r.px0; }).join(',');
    if (sig === chart.posSig) return;
    chart.posSig = sig;
    chart.pos.forEach(function (l) { chart.series.removePriceLine(l); });
    chart.pos = [];
    var t = chartTheme();
    mine.forEach(function (p) {
      var tag = mine.length > 1 ? ' ' + sideWord(p.isLong).toLowerCase() + ' ' + p.leverage + 'x' : '';
      var picked = chart.pick && String(p.id) === chart.pick;   // the picked position's entry line is solid and heavier
      chart.pos.push(chart.series.createPriceLine({ price: p.entry, color: picked ? t.accent : t.ink, lineWidth: picked ? 2 : 1, lineStyle: picked ? 0 : 2, axisLabelVisible: true, title: 'entry' + tag }));
      var bust = px18ToNum(posBust18(p));
      if (bust > 0) chart.pos.push(chart.series.createPriceLine({ price: bust, color: t.accent, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: 'liq.' + tag }));
    });
    going.forEach(function (r) {
      chart.pos.push(chart.series.createPriceLine({ price: r.px0, color: t.muted, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'opening ' + sideWord(r.isLong).toLowerCase() + ' ' + r.leverage + 'x' }));
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
    if (chart.api) chart.api.applyOptions({ timeScale: { secondsVisible: !!LIVE_TF[tf] } });
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
        /* v5: the market's fast-price delay as config.json restates it (seconds, 1 to 10; none: not restated). The real
           page reads fastPricing(id) from the chain and never this; the demo, which has no chain, fills by it */
        fastDelay: Number(m.fastDelay) >= 1 && Number(m.fastDelay) <= 10 ? Math.round(Number(m.fastDelay)) : null,
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
    /* v5: the cut of a win or a loss starts at 0 / 0 in the contract (the size fee took its place). Until the chain
       answers, that is the stand-in, not the 5% / 5% a config carried over from v4 may still say. */
    if (isV5() && (key === 'winFeeBps' || key === 'lossFeeBps')) return 0;
    var c = cfg && cfg[key] != null ? Number(cfg[key]) : NaN;
    return isFinite(c) ? c : null;
  }

  /* Win fee rate (winFeeBps / 1e4) and loss fee rate (lossFeeBps / 1e4) for new positions. */
  function feeRate() { var b = liveOr(house.winFeeBps, 'winFeeBps'); return b != null ? b / 1e4 : 0; }
  function lossFeeRate() { var b = liveOr(house.lossFeeBps, 'lossFeeBps'); return b != null ? b / 1e4 : 0; }

  /* Smallest margin a request takes, USD (minMarginUsdc). */
  function minMargin() { var v = liveOr(house.minMargin, 'minMarginUsdc'); return v != null && v > 0 ? v : 1; }
  /* v5: the minimum is the chain's own (minMarginUsdc(), an owner setting: $4.50 at launch so that $5 typed fits its
     stake and what opening takes at every leverage). Until it has answered, the config's figure is shown where a
     figure is needed, but no order is checked against it and no smallest amount is named from it. */
  function minKnown() { return !isV5() || house.minMargin != null; }

  /* Whole hours a new position holds before the borrow starts (borrowFreeHours). */
  function freeHours() { return liveOr(house.borrowFreeHours, 'borrowFreeHours'); }

  /* "5%", "0.5%": a rate for UI text; a dash before anything is known. */
  function pctText(rate) { return rate == null || !isFinite(rate) ? '—' : (rate * 100).toFixed(2).replace(/\.?0+$/, '') + '%'; }
  function feePctText() { return liveOr(house.winFeeBps, 'winFeeBps') == null ? '—' : pctText(feeRate()); }
  /* v5, the size fee of the ticket's trade in words: "0.04% of the position" or, where the cap decides, "10% of
     your amount"; '' on a v4 config, for a house wallet and on a market without it */
  function sizeFeeText() {
    var m = state.market, f = m && m.instrumentId != null ? tradeFeeCfg(m.instrumentId) : null;
    if (!f || !(f.rateX10 > 0) || !ticketShare()) return '';
    return f.rateX10 * form.lev > f.capBps * 10 ? pctText(f.capBps / 1e4) + ' of your amount' : pctText(f.rateX10 / 1e5) + ' of the position';
  }
  /* the ticket's costs line, after the spread: v4 "5% of wins"; v5 the size fee each way, and the cut of wins only
     while the owner has one set */
  function feeCosts() {
    var out = [], sf = sizeFeeText();
    if (sf) out.push('fee ' + sf + ' each way' + (ticketFee() > 0 ? ' (' + fmtUsd(ticketFee()) + ')' : ''));
    if (!isV5() || feeRate() > 0) out.push(feePctText() + ' of wins');
    return out;
  }

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
      /* v5: the close-side size fee after the borrow, out of the payout and never more than it (tradeFee). net:
         the result against everything that went in, the open fee included; pnl stays the exchange's own figure. */
      r.tradeFee = Math.min(feeOnStake(pos.margin, posFeeX10(pos)), Math.max(0, r.payout));
      r.payout -= r.tradeFee;
      r.net = r.payout - posIn(pos);      /* (amt2) the money itself: the borrow so far is in it, and it is never worse than all that went in */
      return r;
    }
    /* the collateral (v5: margin plus added margin) caps a loss and comes back with the result */
    var coll = posColl(pos);
    var out = { pnl: 0, fee: 0, payout: coll, flat: true };
    if (!(px > 0) || !(pos.entry > 0)) return done(out);
    var rate = pos.winFeeBps >= 0 ? pos.winFeeBps / 1e4 : feeRate();
    var notional = pos.margin * pos.leverage;
    var isWin = pos.isLong ? px > pos.entry : px < pos.entry;
    if (!isWin) {
      var diff = Math.abs(pos.entry - px);
      var loss = Math.min(coll, notional * diff / pos.entry);
      if (loss <= 0) return done(out);
      var lrate = pos.lossFeeBps >= 0 ? pos.lossFeeBps / 1e4 : lossFeeRate();
      var lfee = queueEmpty === false ? 0 : loss * lrate;
      return done({ pnl: -loss, fee: lfee, payout: coll - loss, flat: false });
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
    return done({ pnl: adjusted - fee, fee: fee, payout: coll + adjusted - fee, flat: false });
  }

  /* (amt2) What a trade has made or lost as money: what a close gives back less what went in. The exchange's own pnl
     (previewClose, PositionClosed) is the result BEFORE the borrow, which it then takes off the payout, so a trade old
     enough to owe borrow read "+$5.00" over "Close · take about $14.00" with $10 in. Simple names no cost, so the
     figure it shows is the money itself (smApi: positions, autoRead, worthAt, result). Nothing back at all (the
     closing price reached) is the whole amount lost; without a payout (a late price) the figure stays as it was. */
  function netPnl(e, margin) { return e && isFinite(e.payout) && margin > 0 ? e.payout - margin : e ? e.pnl : NaN; }

  /* The price a fill settles on: the HyperCore oracle price (every open, close and liquidation
     uses it; the book mid on the chart is display only). The on-chain read when the page has
     one, else the same oracle from the Hyperliquid stats feed, else the mid as a rough stand-in. */
  function oraclePriceFor(m) { return settlePrice(m).px; }

  /* FRESH PRICES ONLY (the owner, 2026-10-29: a FARTCOIN card showed +$554 at a 10-minute-old chain read while the
     live price was already past the position's liquidation; failed chain reads had kept the last price with no age).
     The on-chain price while it is under PX_FRESH_MS old; else the live mid while that is (a fill settles on the mid
     held within a few bps of the oracle, so it is the honest stand-in); else nothing, with fresh: false, and the
     cards say "price delayed" instead of a number. */
  var PX_FRESH_MS = 15000;

  function settlePrice(m) {
    if (!m) return { px: NaN, fresh: false };
    var now = Date.now();
    if (m.instrumentId != null) {
      var opx = house.oraclePxById[m.instrumentId], at = house.oraclePxAt[m.instrumentId];
      if (opx > 0 && at && now - at < PX_FRESH_MS) return { px: opx, fresh: true };
    }
    var mid = state.mids[m.coin];
    if (mid > 0 && state.midsAt && now - state.midsAt < PX_FRESH_MS) return { px: mid, fresh: true };
    return { px: NaN, fresh: false };
  }

  /* (est1) A LIVE ESTIMATE between settlement prints (the owner, 2026-11-06: "the pnl cards seem to be going slow",
     "Yes, add estimate"). The settlement price is the oracle print, which moves every 3 s on a busy coin and only every
     10-30 s on a quiet one, while the chart moves every tick, so a card that holds the exact figure reads as stuck. Between
     prints a card now shows "≈" and the P&L at the print scaled by the market mid's move since that print
     (est = print x mid now / mid at the print), recomputed with settle.js like the exact figure; the moment the next print
     lands the "≈" goes and the exact figure is back. It keeps the print-to-mid gap (basis), so it is off only by how much
     the oracle's next print differs from the mid's move: usually a few bps, which at high leverage is a real share of the
     margin; the title always carries the exact figure at the last print. */
  var EST_MID_FRESH_MS = 5000;
  var midAtPrint = {};   /* instrument id -> the market mid when its settlement price last changed (null: none fresh) */

  function notePrintMid(id) {
    var inst = state.byInstId[id];
    var m = inst && inst.market;
    var mid = m && state.mids[m.coin];
    midAtPrint[id] = (mid > 0 && state.midsAt && Date.now() - state.midsAt < EST_MID_FRESH_MS) ? mid : null;
  }

  function liveEstimate(pos, exact) {
    if (DEMO || !exact || exact.delayed || exact.liquidated || !isFinite(exact.pnl)) return null;
    var S = window.ConfettiSettle;
    var inst = state.byInstId[pos.instrumentId];
    if (!S || !inst || inst.retired || !pos.raw || !inst.raw) return null;
    /* a fast market's figures are already at its estimated print, which carries the mid's move (fastPx18) */
    if (fastOf(pos.instrumentId)) return null;
    var m = positionMarket(pos);
    var px18 = house.oraclePx18ById[pos.instrumentId];
    var base = midAtPrint[pos.instrumentId];
    var mid = m && state.mids[m.coin];
    if (!(base > 0) || !(mid > 0) || px18 == null || !(px18 > 0n)) return null;
    if (!state.midsAt || Date.now() - state.midsAt > EST_MID_FRESH_MS) return null;
    var ratio = mid / base;
    if (!isFinite(ratio) || Math.abs(ratio - 1) < 1e-9) return null;   /* nothing moved since the print: the exact figure */
    var est18 = px18 * BigInt(Math.round(ratio * 1e9)) / 1000000000n;
    var now = house.chainTs != null ? house.chainTs : Math.floor(Date.now() / 1000);
    var queueEmpty = house.queueLen == null ? true : house.queueHead === house.queueLen;
    var v = S.value(pos.raw, inst.raw, est18, BigInt(Math.floor(now)), queueEmpty);
    /* pnl: the result against what went in (v5: less the close fee the payout carries and the open fee paid) */
    return { pnl: S.usd(v.pnl - (v.tradeFee || 0n)) - posOpenFee(pos), gross: S.usd(v.pnl), payout: S.usd(v.payout), liquidated: v.liquidated, px: S.px(est18) };
  }

  /* (SITE4) ONE PRICE SCALE IN A FAST MARKET (V5P_SPEC 17; the owner, 2026-11-18, on quoting in USDT: "do this").
     A fast market's fills, closes and liquidations settle on the converted Pyth print of their own second (Pyth's
     X/USD over Pyth's USDT/USD of that second): USDT terms, the scale of the HyperCore oracle and Hyperliquid's chart.
     The page cannot read Pyth (the print is given out with a key only), so a fast market's card prices its position
     on its best estimate of the next print: the latest print the exchange logged for that market (FillPriced, any
     trader's fill or liquidation: the price and its second), carried by Hyperliquid's mid since that second, blended
     into the HyperCore price (with the live estimate's move, est1) as that print ages:
       px = hc + (print x mid now / mid at the print's second - hc) x w(age)
       w = 1 while a fill on that print can still be landing (the fast window + 2 s: 7 s at launch), then
           0.3 + 0.7 / sqrt(1 + (age - that) / 5); let go between 30 and 60 min.
     So a position reads flat when it first shows (its own print is the anchor, at full weight whenever the keeper's
     fill lands in the window). The weight is the one that kept the card closest to the print a close would get,
     measured on the live 24 h test (80,040 market-seconds, 15 markets, 2026-11-18 22:27-23:56 UTC;
     cte_v5px/SITE4/meas): with the page's own 2 s mid, against the print 2 s later the error went from 3.26 bps rms
     (the HyperCore price alone) to 1.84, a minute later from 3.31 to 2.16, half an hour later from 3.25 to 2.41 (at
     1000x one bp is a tenth of the stake). On the 48 minutes after that window (23:56-00:44 UTC) it stayed within
     0.13 bps rms of the best fixed weight at every age and 1.0 to 1.2 bps under the HyperCore price alone. No print
     in hand, one the page cannot place (older than the mids it keeps) or one more than ANCHOR_MAX_GAP_BPS from the
     HyperCore price: the HyperCore price and its live estimate, as before. The contract's figures at the very price a card shows are read with previewCloseAt at every block
     (readAtHead). */
  var MID_KEEP_MS = 180000, ANCHOR_FADE_S = 1800, ANCHOR_END_S = 3600, ANCHOR_MAX_GAP_BPS = 100;
  var midHist = {};      /* coin -> [[Date.now(), mid], ...] over the last MID_KEEP_MS */
  var fastAnchor = {};   /* instrument id -> { px18, at (the print's second), mid (the page's mid at that second) } */

  function noteMidHist(coin, mid, at) {
    if (!coin || !(mid > 0) || !(at > 0)) return;
    var h = midHist[coin] || (midHist[coin] = []);
    var last = h.length ? h[h.length - 1] : null;
    if (last && last[0] >= at) { if (last[0] === at) last[1] = mid; return; }
    h.push([at, mid]);
    while (h.length && at - h[0][0] > MID_KEEP_MS) h.shift();
  }
  /* The page's mid at chain second sec: the sample nearest that second's start + 0.25 s (a print of second sec is
     Pyth's first of that second), within 2.5 s; null when the page holds none that near. */
  function midAtSec(coin, sec) {
    var h = midHist[coin];
    if (!h || !h.length) return null;
    var want = (sec + 0.25 - (chainNow() - Date.now() / 1000)) * 1000, best = null, bd = Infinity;
    for (var i = h.length - 1; i >= 0; i--) {
      var d = Math.abs(h[i][0] - want);
      if (d < bd) { bd = d; best = h[i][1]; }
      if (h[i][0] < want - 2500) break;
    }
    return bd <= 2500 ? best : null;
  }
  /* how much of the print's own gap to the HyperCore price the card keeps, by the print's age in seconds: all of it
     while a fill on that print can still be landing (the fast window, 5 s at launch, and 2 s for the block and the
     page), so a fresh position reads flat when it first shows */
  function anchorFullS() { return (house.fastWindow > 0 ? house.fastWindow : 5) + 2; }
  function anchorWeight(age) {
    if (!(age >= 0)) age = 0;
    if (age >= ANCHOR_END_S) return 0;
    var full = anchorFullS();
    var w = age <= full ? 1 : 0.3 + 0.7 / Math.sqrt(1 + (age - full) / 5);
    return age > ANCHOR_FADE_S ? w * (ANCHOR_END_S - age) / (ANCHOR_END_S - ANCHOR_FADE_S) : w;
  }
  /* a converted print the exchange logged (FillPriced): the market's anchor when it is newer than the one in hand
     and the page can place it (its mid at that second) */
  function noteAnchor(instId, at, px18) {
    var inst = state.byInstId[instId], m = inst && inst.market;
    if (!m || !(at > 0) || px18 == null || !(px18 > 0n)) return;
    var had = fastAnchor[instId];
    if (had && had.at >= at) return;
    var mid = midAtSec(m.coin, at);
    if (!(mid > 0)) return;
    fastAnchor[instId] = { px18: px18, at: at, mid: mid };
  }
  /* the HyperCore price with the live estimate's move since its print (est1); the price itself when that is off */
  function hcLive18(id, px18) {
    var inst = state.byInstId[id], m = inst && inst.market;
    var base = midAtPrint[id], mid = m && state.mids[m.coin];
    if (DEMO || !(base > 0) || !(mid > 0) || !state.midsAt || Date.now() - state.midsAt > EST_MID_FRESH_MS) return px18;
    var ratio = mid / base;
    if (!isFinite(ratio) || Math.abs(ratio - 1) < 1e-9) return px18;
    return px18 * BigInt(Math.round(ratio * 1e9)) / 1000000000n;
  }
  /* A live fast market's price for its cards, 1e18 BigInt (above); null for any other market or with no fresh price
     (the card then says "price delayed", as settlePrice decides). */
  function fastPx18(id) {
    var inst = state.byInstId[id], m = inst && inst.market;
    if (!inst || !m || inst.retired || !fastOf(id)) return null;
    var sp = settlePrice(m);
    if (!sp.fresh) return null;
    var hc = house.oraclePx18ById[id], at = house.oraclePxAt[id];
    /* the HyperCore price while it is fresh; else the mid settlePrice stands in with */
    var base = hc != null && hc > 0n && at && Date.now() - at < PX_FRESH_MS ? hcLive18(id, hc) : toPx18(sp.px);
    var a = fastAnchor[id], mid = state.mids[m.coin];
    if (!a || !(mid > 0) || !(a.mid > 0) || !state.midsAt || Date.now() - state.midsAt > EST_MID_FRESH_MS) return base;
    var w = anchorWeight(chainNow() - a.at);
    if (!(w > 0)) return base;
    var anc = a.px18 * BigInt(Math.round(mid / a.mid * 1e12)) / 1000000000000n;
    var gap = anc > base ? anc - base : base - anc;
    if (gap * 10000n > base * BigInt(ANCHOR_MAX_GAP_BPS)) return base;
    return base + (anc - base) * BigInt(Math.round(w * 1e6)) / 1000000n;
  }

  /* A position whose price is not fresh: its card shows "price delayed" in place of P&L, Now and the distance. */
  function priceDelayed(p) {
    var inst = state.byInstId[p.instrumentId];
    if (inst && inst.retired) return false;
    return !settlePrice(positionMarket(p)).fresh;
  }

  /* Entry a request filed now would fill at if the oracle does not move (a keeper fills at the
     oracle print a few seconds later; the fallback fill takes the worse of request and fill).
     A fast market: its estimated print (fastPx18), the price its fill is expected near. */
  function openPriceFor(m) {
    var f = m && m.instrumentId != null ? fastPx18(m.instrumentId) : null;
    return f != null ? px18ToNum(f) : oraclePriceFor(m);
  }

  /* Price a close of the position would settle on now. A fast market: its estimated print (fastPx18), the price its
     P&L, payout and distance to closing itself are worked out at; the HyperCore price is what a close past the fast
     window takes (ownClosePx), not this. */
  function closePriceFor(pos) {
    var f = pos ? fastPx18(pos.instrumentId) : null;
    return f != null ? px18ToNum(f) : livePrice(positionMarket(pos)).px;   /* display: live between oracle reads */
  }

  /* Seconds on the chain's clock right now: the latest block timestamp plus the time since it
     was read. The request windows are measured on this clock. */
  function chainNow() {
    if (chainClock.off != null && Date.now() - chainClock.at < 15000) return Date.now() / 1000 + chainClock.off;
    if (house.chainTs == null) return Date.now() / 1000;
    return house.chainTs + (Date.now() - house.chainTsAt) / 1000;
  }

  /* (CF_PNL) The chain clock, smooth. A block's timestamp is its second, floored, and its head reaches the page some
     way into that second (0.4-0.7 s through Blockfront), so a clock set to each head's timestamp ran back half a second
     at every block and the countdowns stuttered (2.7, 2.5, 3.0 s). The chain's lead over this computer's clock is the
     largest (timestamp - time seen) of the last 30 heads: a head is never seen before its second began, so the largest
     is the closest. */
  var chainClock = { off: null, at: 0, samples: [] };
  function noteChainClock(ts, seenMs) {
    chainClock.samples.push(ts - seenMs / 1000);
    if (chainClock.samples.length > 30) chainClock.samples.shift();
    chainClock.off = Math.max.apply(null, chainClock.samples);
    chainClock.at = seenMs;
  }

  /* When a fill (or a close) that lands in the block with timestamp t shows on the card, on the chain clock: t, plus
     how long into its second the block feed's answer for a block comes in (heads.seenLag, about 0.7 s). The countdowns
     count to this, so 0.0 is the moment the card changes. */
  function fillEta(requestedAt, instId) { return requestedAt + fillSecs(instId) + (headsFresh() && heads.seenLag != null ? heads.seenLag : 0); }

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

  /* Exact ImpactLib.bustPriceOf (v5) on 6-decimal amounts: the bust of coll6 of collateral backing
     notional6, its move min(0.95 x coll / notional, coll / notional - BUST_GAP_BPS) worked in units
     of 1 / (notional x 10000); with coll6 = margin it is bustPrice18 at the leverage. */
  function bustPriceOf18(entryPx18, isLong, coll6, notional6) {
    var den = notional6 * 10000n;
    var pct = BigInt(BUST_BUFFER_PCT * 100) * coll6;
    var gap = BigInt(BUST_GAP_BPS) * notional6;
    var whole = coll6 * 10000n;
    var gapped = gap < whole ? whole - gap : 0n;
    var move = pct < gapped ? pct : gapped;
    if (isLong) return (entryPx18 * (den - move) + den - 1n) / den;
    return entryPx18 * (den + move) / den;
  }

  /* A position's liquidation price, as bustPrice(positionId) works it: the chain's own figure when
     the account read took one (v5, margin added), else worked here on its collateral. */
  function posBust18(p) {
    if (p.bust18) return p.bust18;
    var raw = rawEntry18(p.entryPx18, p.isLong, p.entryDeadbandBps);
    if (!(p.added6 > 0n)) return bustPrice18(raw, p.isLong, p.leverage);
    return bustPriceOf18(raw, p.isLong, p.margin6 + p.added6, p.margin6 * BigInt(p.leverage));
  }

  /* v5: a position's collateral (its margin plus the margin added after the open: what a loss is
     capped at and a liquidation forfeits) and its effective leverage (notional / collateral, the
     opening leverage until margin is added). A v4 position has no added margin. */
  function posColl(p) { return p.margin + (p.added > 0 ? p.added : 0); }
  function posLev(p) { return p.added > 0 ? p.margin * p.leverage / posColl(p) : p.leverage; }
  /* The leverage a position shows: "20", or "13.33" once margin was added */
  function levShown(p) { return String(Math.round(posLev(p) * 100) / 100); }
  /* " · opened at 20x, 13.33x with the margin added" for a card's hover text; '' without added margin */
  function levNote(p) { return p.added > 0 ? ' · opened at ' + p.leverage + 'x, ' + levShown(p) + 'x with the margin added' : ''; }
  /* The added margin of a positions() read: v5's 16th field (addedMarginUsdc); a v4 read has 15 */
  function addedOf(p) { return p && p.length > 15 ? BigInt(p[15]) : 0n; }

  /* "50%", "33.33%": a share in bps */
  function fmtBps(bps) { return String(Number(bps) / 100) + '%'; }

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
    /* v5: with the size fee a trade opened now would carry (the stamp and the open fee on top of this stake) */
    var share = m && m.instrumentId != null ? feeShareFor(m.instrumentId, form.lev) : 0;
    return {
      entry: spreadEntry(px, isLong, m && m.inst), margin: margin, leverage: form.lev, isLong: isLong,
      winFeeBps: -1, lossFeeBps: -1, deadbandBps: 0, maxProfit: -1, openedAt: 0,
      feeX10: share, openFee: feeOnStake(margin, share)
    };
  }

  /* ---- v5: the size fee (V5P_SPEC section 13) ------------------------------------------------------------------
     Each side of a trade pays min(rateX10 / 10 bps of its size, capBps of its stake) into the fee pool. The open
     side is reserved on top of the stake when the request is filed and taken at the fill; a refund returns both. The
     close side comes out of the payout, never more than it. A liquidation has no close side. The share is fixed at
     the request and stamped on the position, so a later change of the rate never touches an open trade. Every
     amount goes through settle.js's integer maths (the contract's own). On a v4 config all of these answer 0, or
     the amount itself, and nothing changes. */
  function tradeFeeCfg(instId) {
    if (!isV5() || instId == null) return null;
    var f = house.tradeFee[instId];
    if (f) return f;
    /* until tradeFee(id) answers: config.json "tradeFee" { rateX10, capBps }, else the contract's default for a
       new market. For what the page shows only: no open is filed before the chain's own answer is in (feeKnown). */
    var c = cfg && cfg.tradeFee;
    return { rateX10: c && c.rateX10 != null ? Number(c.rateX10) : 45, capBps: c && c.capBps != null ? Number(c.capBps) : 1000 };
  }
  function feeKnown(instId) { return !isV5() || (instId != null && house.tradeFee[instId] != null); }
  /* what one side of a new trade of this account pays, in tenths of a bp of its stake (0: nothing) */
  function feeShareFor(instId, lev) {
    var f = tradeFeeCfg(instId), S = window.ConfettiSettle;
    if (!f || !S || !(lev >= 1) || house.isHouse) return 0;
    return Number(S.feeShare(f.rateX10, f.capBps, Math.round(lev)));
  }
  /* the fee on a stake at a share, in dollars, to the micro-dollar (rest: the stake that stays open in a part close) */
  function feeOnStake(margin, shareX10, rest) {
    var S = window.ConfettiSettle;
    if (!S || !(shareX10 > 0) || !(margin > 0) || !window.ethers) return 0;
    return usd6ToNum(S.sizeFee(shareX10, numToUsd6(margin), rest > 0 ? numToUsd6(rest) : 0n));
  }
  /* the stake an amount buys with the open fee on top: the most that, with its fee, still fits in the amount */
  function stakeOfAmount(amount, shareX10) {
    var S = window.ConfettiSettle;
    if (!S || !(shareX10 > 0) || !(amount > 0) || !window.ethers) return amount;
    return usd6ToNum(S.stakeFor(numToUsd6(amount), shareX10));
  }
  /* what a stake takes from the balance: the stake and its open fee */
  function amountOfStake(margin, shareX10) { return margin > 0 ? margin + feeOnStake(margin, shareX10) : margin; }
  /* the ticket's stake with the open fee it needs on top (the Pro ticket types the stake) */
  function ticketShare() { var m = state.market; return m && m.instrumentId != null ? feeShareFor(m.instrumentId, form.lev) : 0; }
  function ticketFee() { return isFinite(form.margin) && form.margin > 0 ? feeOnStake(form.margin, ticketShare()) : 0; }
  /* a position's stamp, the open fee its open stake paid (a part closed took its share of it along), and what
     went in: the stake, the margin added and that fee */
  function posFeeX10(p) { return p && p.feeX10 > 0 ? p.feeX10 : 0; }
  function posOpenFee(p) { return p && p.openFee > 0 ? p.openFee : 0; }
  function posIn(p) { return posColl(p) + posOpenFee(p); }
  /* a waiting open: the fee it reserved (the chain's openFeeOf once read, else worked from its market and leverage)
     and what it holds, which is what a refund returns */
  function reqFee(r) {
    if (!r || !isV5()) return 0;
    if (r.fee == null) r.fee = feeOnStake(r.margin, feeShareFor(r.instrumentId, r.leverage));
    if (r.id != null && !r.feeAsked && !DEMO && read.exchange) {
      r.feeAsked = true;
      read.exchange.openFeeOf(BigInt(r.id)).then(function (x) {
        /* 0 for a request that is already gone: keep the worked figure for its result card */
        var v = usd6ToNum(x);
        if (v > 0 || house.isHouse) { if (r.fee !== v) { r.fee = v; renderPositions(); } }
      }).catch(function () { r.feeAsked = false; });
    }
    return r.fee > 0 ? r.fee : 0;
  }
  function reqIn(r) { return r.margin + reqFee(r); }
  /* the share a waiting open pays, for the position its card draws */
  function reqShare(r) {
    var fee = reqFee(r);
    if (!(fee > 0) || !(r.margin > 0)) return 0;
    var now = feeShareFor(r.instrumentId, r.leverage);
    if (Math.abs(feeOnStake(r.margin, now) - fee) < 5e-7) return now;
    return Math.ceil(fee * 1e5 / r.margin - 1e-9);
  }

  /* Seconds from a request to its expected fill: the keeper's wait plus a block. */
  /* v5: the fast-pricing setting of a market (no id: the ticket's market), or null on the HyperCore rule: a v4
     config, a market with fast pricing off, a retired market (the contract ignores the setting there), or a
     setting not read yet. */
  function fastOf(instId) {
    if (!isV5()) return null;
    if (instId == null) instId = state.market ? state.market.instrumentId : null;
    if (instId == null) return null;
    var f = house.fast[instId], inst = state.byInstId[instId];
    return f && f.on && f.delay > 0 && !(inst && inst.retired) ? f : null;
  }
  /* v5: has fastPricing(id) answered for this market (no id: the ticket's)? */
  function fastKnown(instId) {
    if (instId == null) instId = state.market ? state.market.instrumentId : null;
    return instId != null && house.fast[instId] != null;
  }
  /* Seconds from the request's block to the block the keeper's fill lands in: a fast market's delay + 1 (the print
     for request + delay exists right after that second; the fill lands one block later), else minDelay + 1. */
  function fillSecs(instId) { var f = fastOf(instId); return f ? f.delay + 1 : house.minDelay + 1; }
  function secsWord(n) { return n + (n === 1 ? ' second' : ' seconds'); }
  /* "the market price 2 seconds after you tap": the price a fast market's request fills at */
  /* what a market settles on, in the page's words: a fast market's fills are the market price (a signed Pyth
     print), the others' the HyperCore oracle price */
  function pxWord(instId) { return fastOf(instId) ? 'market price' : 'oracle price'; }
  /* The clock starts at the block the request lands in, not at the tap: a wallet that takes five seconds to confirm
     adds its five seconds (review finding L5). */
  function fastWhen(f) { return 'the market price ' + secsWord(f.delay) + ' after your order reaches the chain'; }
  /* "about 3 s" for positions that all fill alike, "about 3 to 6 s" when they are on both rules */
  function fillSecsOf(list) {
    var lo = Infinity, hi = 0;
    (list || []).forEach(function (p) { var n = fillSecs(p.instrumentId); if (n < lo) lo = n; if (n > hi) hi = n; });
    if (!hi) { lo = hi = fillSecs(); }
    return 'about ' + (lo === hi ? hi : lo + ' to ' + hi) + ' s';
  }
  /* the market of a close request's position */
  function crInst(pid) { var p = posById(pid); return p ? p.instrumentId : null; }

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
    setText('moveWin', win && !win.flat ? fmtUsd(win.net, true) : '—');
    /* v5 fast market (fp): the fill is the market price `delay` seconds after the request, in about delay + 1 s */
    var fp = fastOf();
    setText('opensNear', lim.type === 'limit' && lim.px > 0 ? 'Opens when ' + sym + ' reaches ' + fmtPrice(px, sz) + (fp ? '; it then fills at the market price ' + secsWord(fp.delay) + ' later' : '; the fill lands at the oracle a few seconds after')
      : fp ? 'Opens at ' + fastWhen(fp) + (px > 0 ? ', near ' + fmtPrice(px, sz) : '') + ', in about ' + fillSecs() + ' s'
      : 'Opens near ' + (px > 0 ? fmtPrice(px, sz) + ' (oracle price)' : 'the oracle price') + ' in about ' + fillSecs() + ' s');
    setText('fillsNote', fp ? 'Every ' + (sym || 'trade') + (sym ? ' trade' : '') + ' fills at ' + fastWhen(fp) + ': one signed price for that second, the same whoever sends the fill. If it has not filled ' + secsWord(house.fastWindow) + ' after that, an open is refunded and a close fills at the Hyperliquid oracle price for ' + secsWord(FALLBACK_SECS) + '; after those only your own wallet can finish it, at that price or the price when you asked to close, whichever is worse for you. Prices on the chart come from Hyperliquid.'
      : 'Every trade fills at the oracle price a few seconds after you click. Prices on the chart come from Hyperliquid.');
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
    var sft = sizeFeeText();
    setText('feeLine', sft
      ? 'Fee: ' + sft + ' when it opens' + (ticketFee() > 0 ? ' (' + fmtUsd(ticketFee()) + ', taken on top of your amount)' : ', taken on top of your amount') + ' and the same when it closes, out of what comes back. Nothing if it does not open.' + (feeRate() > 0 ? ' Plus ' + feePctText() + ' of winnings, after the trim.' : '')
      : isV5() && !(feeRate() > 0) ? 'Fee: none on this trade.'
      : 'Fee: ' + feePctText() + ' of winnings, after the trim. Nothing on a loss beyond the loss.');
    var fh = freeHours();
    setText('borrowLine', inst && inst.borrowRateX10 > 0
      ? 'Borrow: ' + borrowPctText(inst) + ' of the position per hour after the first ' + (fh == null ? '—' : fh === 1 ? 'hour' : fh + ' hours') + ', taken at close.'
      : 'Borrow: none.');
    if (inst && inst.entryDeadbandBps > 0 && !(lim.type === 'limit' && lim.px > 0)) setText('opensNear', fp
      ? 'Opens at ' + fastWhen(fp) + (px > 0 ? ', near ' + fmtPrice(px, sz) : '') + ', plus a ' + pctText(inst.entryDeadbandBps / 1e4) + ' spread, in about ' + fillSecs() + ' s'
      : 'Opens near ' + (px > 0 ? fmtPrice(px, sz) + ' (oracle price)' : 'the oracle price') + ' plus a ' + pctText(inst.entryDeadbandBps / 1e4) + ' spread, in about ' + fillSecs() + ' s');
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
    costs = costs.concat(feeCosts());
    return {
      /* what the trade can lose: the stake and, on v5, the open fee taken with it */
      risk: isFinite(c.margin) ? fmtUsd(amountOfStake(c.margin, ticketShare())) : '—',
      size: isFinite(c.notional) ? fmtUsdShort(c.notional) + (qty ? ' · ' + qty : '') : '—',
      liq: 'Liquidation ' + fmtPrice(bustPriceNum(c.px, c.isLong, lev), c.sz) + ' · a ' + fmtMove(bustMovePct(lev)) + '% ' + (c.isLong ? 'drop' : 'rise'),
      moveK: 'If ' + (c.sym || 'the price') + (c.isLong ? ' rises' : ' falls') + ' 1%',
      moveV: c.win && !c.win.flat ? fmtUsd(c.win.net, true) : '—',
      movePos: !!(c.win && !c.win.flat && c.win.net > 0),
      opens: lim.type === 'limit' && lim.px > 0 ? 'Opens when ' + (state.market ? state.market.symbol : 'the price') + ' reaches ' + fmtPrice(c.px, c.sz) + (fastOf() ? '; it then fills at the market price ' + secsWord(fastOf().delay) + ' later' : '; the fill lands at the oracle a few seconds after')
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

  /* The owner, 2026-10-26: a trade too big for the room on its side at this leverage drops to one
     under the most leverage that fits (the room is read with the chain poll and can shrink before
     the fill), and the box over OPEN says what changed and why, with Still place trade? YES. An
     amount too big even at 1x keeps the "Too big right now" line: lowering leverage cannot fix it.
     A firing limit order keeps the leverage it was placed with. */
  function fitLeverage() {
    var m = state.market;
    if (lim.firing || !m || !m.inst || !(form.margin > 0)) return;
    var mp = house.maxPos[m.inst.id];
    var room = mp ? (form.side === 'long' ? mp.long : mp.short) : null;
    if (room == null || form.margin * form.lev <= room + 1e-6) return;
    var most = Math.min(maxLev(m), Math.floor((room + 1e-6) / form.margin));
    if (most < 1) return;
    var to = Math.max(1, most - 1);
    ui.levFit = { from: form.lev, to: to, most: most, room: room, sym: m.symbol, side: form.side, margin: form.margin };
    form.lev = to;
    form.levCustom = LEV_CHIPS.indexOf(to) < 0;
    lsSet(LS.lev + m.symbol, String(to));
    var li = $('levInput'); if (li) li.value = String(to);
    renderLeverage(); renderForm();
  }

  /* The box over OPEN after fitLeverage: the new leverage, the room that set it, and YES to place the
     trade as it now stands. It goes once the trade it describes changes (coin, side, amount, leverage)
     or is placed, and stays hidden while OPEN is off for another reason. */
  function renderLevFit(enabled) {
    var box = $('levFitBox');
    if (!box) return;
    var f = ui.levFit, m = state.market;
    if (f && (!m || f.sym !== m.symbol || f.side !== form.side || f.margin !== form.margin || f.to !== form.lev)) f = ui.levFit = null;
    var on = !!f && enabled && !tk.phase;
    var key = on ? [f.sym, f.side, f.margin, f.from, f.to, Math.floor(f.room)].join('|') : '';
    box.hidden = !on;
    if (box.getAttribute('data-key') === key) return;
    box.setAttribute('data-key', key);
    box.textContent = '';
    if (!on) return;
    var sides = f.side === 'long' ? 'longs' : 'shorts';
    var x = el('button', 'lev-fit-x', '×');
    x.type = 'button'; x.setAttribute('aria-label', 'Hide this note');
    x.addEventListener('click', function () { ui.levFit = null; renderAction(); });
    box.appendChild(x);
    box.appendChild(el('b', 'lev-fit-h', 'Leverage lowered to ' + f.to + 'x'));
    box.appendChild(el('p', null,
      fmtUsdShort(f.margin) + ' at ' + f.from + 'x is a ' + fmtUsdShort(f.margin * f.from) + ' position, and ' + f.sym + ' ' + sides +
      ' have room for ' + fmtUsdShort(f.room) + ' right now, so ' + f.most + 'x is the most this trade can take.' +
      (f.to < f.most ? ' You are one under, in case the room shrinks before it fills.' : '')));
    box.appendChild(el('p', 'lev-fit-liq', 'At ' + f.to + 'x a ' + fmtMove(bustMovePct(f.to)) + '% move against you liquidates it.'));
    var row = el('div', 'lev-fit-ask');
    row.appendChild(el('span', null, 'Still place trade?'));
    var yes = el('button', 'btn btn-go ' + (f.side === 'long' ? 'go-long' : 'go-short') + ' lev-fit-yes', 'YES');
    yes.type = 'button';
    yes.addEventListener('click', function () { onAction(true); });
    row.appendChild(yes);
    box.appendChild(row);
  }

  /* Problems with the trade itself, in plain words, or null when it can go. */
  function orderProblem() {
    var m = state.market;
    var block = marketBlock();
    if (block) return block;
    if (!m || !m.inst) return 'Loading the market…';
    if (!isFinite(form.margin) || form.margin <= 0) return 'Enter an amount.';
    if (!minKnown()) return 'Loading the market…';
    var mm = minMargin();
    if (form.margin < mm) return 'Minimum is ' + fmtUsd(mm) + '.';
    /* v5: the request takes the stake and its open fee, so both must fit; and no open is filed on a rate the chain
       has not confirmed (the stake is worked out from it) */
    if (isV5() && !feeKnown(m.instrumentId)) return 'Loading the market…';
    if (form.margin + ticketFee() > acct.available + 1e-9) return 'That is more than your balance (' + fmtUsd(acct.available) + ').';
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
      fitLeverage();
      cls += form.side === 'long' ? ' go-long' : ' go-short';
      problem = orderProblem();
      if (problem) { disabled = true; note = problem; err = true; }
      else {
        note = (form.side === 'long' ? 'BUY / LONG ' : 'SELL / SHORT ') + sym + ' · ' + fmtUsdShort(form.margin) + ' at ' + form.lev + 'x.';
        var why = ONE_TAP_FORCED && (DEMO || read.router) ? oneTapWhy(numToUsd6(form.margin)) : null;
        if (why) note += ' ' + ONE_TAP_NOTE[why];
        else if (sessionLive()) {
          if (DEMO) note += ' No wallet popup.';
          else if (!sessionRefOk(referrerArg())) note += ' Your first fill sets your referrer: your wallet signs this one.';
          else if (numToUsd6(form.margin) > sess.onchain.cap6) note += ' Over your one-click cap: your wallet signs this one.';
          else note += ' No wallet popup.';
        } else note += ' Your wallet asks you to confirm.';
      }
    }
    if (!notice && wallet.account && wallet.chainId === CHAIN_ID && hypeLow()) notice = HYPE_NOTE;
    if (setup) cls += ' go-setup';
    if (state.busy && !tk.phase) { disabled = true; note = sendWord(); err = false; }
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
    renderLevFit(!setup && !disabled && !problem);
    if (ph) { ui.phTk = { problem: problem, notice: notice, alt: alt, setup: setup }; renderPhRowD(); }
    renderUsdcBanner();
    renderTicketProgress(false);
    var closeAll = $('closeAllBtn');
    if (closeAll) closeAll.disabled = state.busy;
    try { setupRender(); } catch (e) { /* First steps never block the ticket */ }
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
          /* v5: the stake that, with its open fee on top, is the whole balance */
          var all = acct.loaded ? Math.floor(stakeOfAmount(Math.floor(acct.available * 100) / 100, ticketShare()) * 100) / 100 : NaN;
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

  /* yes: the YES in the lowered-leverage box (renderLevFit), which already asked, so the big-trade
     check and the phone's second tap are skipped */
  function onAction(yes) {
    if (state.busy || tk.phase) return;
    if (marketBlock()) { renderAction(); return; }
    if (!window.ethers) return;
    if (!wallet.account) { if (wallet.eth || getInjected()) connect(); else openWalletApps(); return; }
    if (wallet.chainId !== CHAIN_ID) { switchChain().then(function () { return onChainChanged(); }).catch(switchFailed); return; }
    if (!hasExchange() || !acct.loaded) return;
    if (acct.available < minMargin()) { openDeposit(); return; }
    if (!(form.margin > 0) || orderProblem()) { renderAction(); return; }
    ui.levFit = null;
    if (yes === true) { if (lim.type === 'limit' && lim.firing === null) placeLimit(); else submitOpen(); return; }
    if (lim.type === 'limit' && lim.firing === null) {   /* (2026-11-02) on every width: the picker is on phones too */
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
      { text: 'If ' + m.symbol + (isLong ? ' rises' : ' falls') + ' 1%: ' + (win ? fmtUsd(win.net, true) : '—') + '.', cls: 'pos' }
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
    var page = (/^https:$/.test(location.protocol) ? location.origin + location.pathname : SITE_URL + 'trade.html') + (smShown() ? '?mode=simple' : '') + (location.hash || '');   /* [simple] hook: the wallet app opens the view this phone shows */
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
    setText('phRcRisk', isFinite(c.margin) ? fmtUsd(amountOfStake(c.margin, ticketShare())) : '—');
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
    if (mv) { mv.textContent = c.win && !c.win.flat ? fmtUsd(c.win.net, true) : '—'; mv.className = c.win && !c.win.flat && c.win.net > 0 ? 'pos' : ''; }
    var costs = [];
    if (c.inst && c.inst.entryDeadbandBps > 0) costs.push(pctText(c.inst.entryDeadbandBps / 1e4) + ' spread');
    costs = costs.concat(feeCosts());
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
    else if (lim.type === 'limit' && lim.px > 0) { text = 'Opens when ' + (state.market ? state.market.symbol : 'the price') + ' reaches ' + fmtPrice(lim.px, state.market && state.market.szDecimals != null ? state.market.szDecimals : 4) + '; the fill lands a few seconds after'; cls = 'is-default'; }   /* a limit prices its own row D */
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
      var full = bustMovePct(posLev(p)) / 100;
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
    who.appendChild(el('span', 'ph-lev', levShown(it.p) + 'x'));
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

  /* (CF_PNL) Phones: an order on its way in is a row at the top, shaped as the position row it becomes (the side, the
     coin, the leverage, the P&L of the position filled at the print now), its status line counting the fill down where
     the liquidation bar will be. Newest first, above the open positions, as the cards are. */
  function phOpenings() {
    if (!wallet.account) return [];
    var out = [];
    (ui.openEnds || []).forEach(function (x) { out.push({ r: x.r, kind: 'end', key: 'e' + x.key, say: x.say }); });
    quick.list.slice().reverse().forEach(function (r) { out.push({ r: r, kind: 'quick', key: 'q' + r.key }); });
    pendingOpenList().slice().reverse().forEach(function (r) { out.push({ r: r, kind: 'open', key: 'o' + r.id }); });
    return out;
  }

  function phOpeningRowEl(o) {
    var r = o.r;
    var b = el('button', 'ph-row is-filling ' + (r.isLong ? 'is-long' : 'is-short'));
    b.type = 'button';
    b.setAttribute('data-open', o.key);
    var who = el('span', 'ph-row-who');
    who.appendChild(el('span', 'ph-side', r.isLong ? 'LONG' : 'SHORT'));
    who.appendChild(el('span', 'ph-sym', reqSym(r)));
    who.appendChild(el('span', 'ph-lev', r.leverage + 'x'));
    b.appendChild(who);
    var money = el('span', 'ph-money');
    var n = el('span', 'ph-pnl-n', '—'); n.setAttribute('data-role', 'pnl');
    var pc = el('span', 'ph-pct'); pc.setAttribute('data-role', 'pct');
    money.appendChild(n); money.appendChild(pc);
    b.appendChild(money);
    var note = el('span', 'ph-row-note'); note.setAttribute('data-role', 'note');
    b.appendChild(note);
    var prog = el('span', 'ph-row-prog'); prog.setAttribute('data-role', 'prog'); prog.setAttribute('aria-hidden', 'true');
    prog.appendChild(el('i'));
    b.appendChild(prog);
    return b;
  }

  function fillPhOpening(row, o) {
    if (o.kind === 'end') {
      /* a refund or a revert: the reason in red where the countdown was, the money untouched */
      setRole(row, 'pnl', ''); setRole(row, 'pct', '');
      var en = row.querySelector('[data-role="note"]'), ep = row.querySelector('[data-role="prog"]');
      if (en && en.textContent !== o.say) { en.textContent = o.say; en.className = 'ph-row-note is-bad'; }
      if (ep) { ep.className = 'ph-row-prog is-bad'; if (ep.firstChild) ep.firstChild.style.width = '100%'; }
      if (row.getAttribute('aria-label') !== o.say) row.setAttribute('aria-label', o.say);
      return;
    }
    var r = o.r, f = openingFigures(r), st = openingStatus(r, o.kind);
    var known = f.fresh && isFinite(f.pnl);
    var cls = known ? (f.pnl > 0 ? ' pos' : f.pnl < 0 ? ' neg' : '') : '';
    var n = setRole(row, 'pnl', !f.fresh ? 'price delayed' : known ? fmtUsd(f.pnl, true) : '—');
    if (n) n.className = 'ph-pnl-n' + cls;
    var pc = setRole(row, 'pct', known ? fmtPct1(f.pnl / reqIn(r)) : '');
    if (pc) pc.className = 'ph-pct' + cls;
    var note = row.querySelector('[data-role="note"]'), prog = row.querySelector('[data-role="prog"]');
    if (note) {
      var k = st.say + '|' + (st.btn || '') + '|' + st.tone;
      if (note.getAttribute('data-k') !== k) {
        note.setAttribute('data-k', k);
        note.textContent = '';
        note.appendChild(document.createTextNode(st.say + (st.btn ? ' ' : '')));
        if (st.btn) note.appendChild(el('b', 'ph-row-act', st.btn));
        note.className = 'ph-row-note' + (st.tone ? ' is-' + st.tone : '');
      }
    }
    if (prog) {
      prog.className = 'ph-row-prog' + (st.tone ? ' is-' + st.tone : '') + (st.sending ? ' is-sending' : '');
      if (prog.firstChild) prog.firstChild.style.width = Math.round(st.share * 100) + '%';
    }
    var label = sideWord(r.isLong) + ' ' + reqSym(r) + ' ' + r.leverage + 'x, ' + fmtUsd(reqIn(r)) + ' in, size ' + fmtUsd(r.margin * r.leverage) + '. ' + st.say + '.' +
      (isFinite(f.entry) ? ' Entry about ' + fmtPrice(f.entry, f.sz) + ', liquidation about ' + fmtPrice(f.liq, f.sz) + '.' : '') + (known ? ' P&L ' + fmtUsd(f.pnl, true) + '.' : '');
    if (row.getAttribute('aria-label') !== label) row.setAttribute('aria-label', label);
  }

  function fillPhRow(row, it, nearest, many) {
    var p = it.p, m = positionMarket(p), sz = m ? m.szDecimals : null;
    var est = it.est, delayed = !!(est && est.delayed), known = !delayed && isFinite(it.px);
    var live = known ? liveEstimate(p, est) : null;   /* (est1) between prints: the live estimate, marked "≈" */
    var shown = live || est;
    var cls = shown && shown.pnl > 0 ? ' pos' : shown && shown.pnl < 0 ? ' neg' : '';
    var pnlText = delayed ? 'price delayed' : known ? (live ? '≈ ' : '') + fmtUsd(shown.pnl, true) : '—';
    var pnlNode = row.querySelector('[data-role="pnl"]');
    if (pnlNode && pnlNode.textContent !== pnlText) tickPnl(pnlNode, p, shown);
    var n = setRole(row, 'pnl', pnlText);
    if (n) {
      n.className = 'ph-pnl-n' + (known ? cls : '');
      var fpr = fastOf(p.instrumentId);
      var tt = fpr ? 'An estimate at the price now. A close fills at ' + fastWhen(fpr) + ', so the result can differ a little.'
        : live ? 'Live estimate at the market price now; the settlement price moves only when the oracle prints. At the last print it is exactly ' + fmtUsd(est.pnl, true) + '.' : '';
      if (n.title !== tt) n.title = tt;
    }
    var pc = setRole(row, 'pct', known ? fmtPct1(shown.pnl / p.margin) : '');
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
    var label = sideWord(p.isLong) + ' ' + (m ? m.symbol : 'market ' + p.instrumentId) + ' ' + levShown(p) + 'x. ' +
      (known ? 'P&L ' + fmtUsd(est.pnl, true) + ', ' + fmtPct1(est.pnl / p.margin) + '. ' : '') +
      'Entry ' + fmtPrice(p.entry, sz) + ', now ' + (isFinite(it.px) ? fmtPrice(it.px, sz) : 'unknown') +
      ', liquidation ' + fmtPrice(it.room.liq, sz) + (isFinite(it.room.away) ? ', ' + fmtAway(it.room.away) + ' away' : '') +
      '. Put in ' + fmtUsd(posColl(p)) + ', size ' + fmtUsd(p.margin * p.leverage) + '.' + (st ? ' ' + st.text : ' Tap to see it or close it.');
    if (row.getAttribute('aria-label') !== label) row.setAttribute('aria-label', label);
  }

  function renderPhRows() {
    var host = $('phRows'), head = $('phPosHead');
    if (!host || !head) return;
    var list = phList();
    var n = list.length;
    head.hidden = !wallet.account || !hasExchange() || !acct.loaded || (!n && !openingCount());
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
    var opens = phOpenings();
    var sig = opens.map(function (o) { return o.key; }).join(',') + '|' + shown.map(function (it) { return it.pid + ':' + levShown(it.p); }).join(',') + '|' + rest;
    if (host.getAttribute('data-sig') !== sig) {
      host.setAttribute('data-sig', sig);
      host.textContent = '';
      opens.forEach(function (o) { host.appendChild(phOpeningRowEl(o)); });
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
    opens.forEach(function (o) {
      var row = host.querySelector('.ph-row[data-open="' + o.key + '"]');
      if (row) fillPhOpening(row, o);
    });
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
    if (row.hasAttribute('data-open')) {
      /* an order on its way in: its row acts only when it needs a tap (Finish now when late, Get $X back when expired);
         an ended one goes on a tap */
      var k = row.getAttribute('data-open');
      if (k.charAt(0) === 'e') { ui.openEnds = (ui.openEnds || []).filter(function (x) { return 'e' + x.key !== k; }); dropRecent(k.slice(1)); renderPhRows(); return; }
      if (k.charAt(0) === 'o' && pend.opens[k.slice(1)]) openReqAction(pend.opens[k.slice(1)]);
      return;
    }
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
      var iid = p ? p.instrumentId : crInst(pid);
      var v = progressView('close', cr, p ? p.margin : 0, iid);
      var on = (v.steps || []).filter(function (s) { return /is-on/.test(s[1]); })[0];
      var left = cr.requestedAt != null ? fillEta(cr.requestedAt, iid) - chainNow() : fillSecs(iid);
      var text = on ? on[0] : 'Closing…', note = v.note || '';
      /* the slow state reads as one sentence ('Still closing. Your wallet will ask you to finish
         it.'); the money rule stays as the note under it */
      if (v.cls === 'is-late' && /^Your wallet will ask/.test(note)) {
        var cut = note.indexOf('. ');
        if (cut > 0) { text += ' ' + note.slice(0, cut + 1); note = note.slice(cut + 2); }
      }
      return {
        text: text, tone: v.cls === 'is-bad' ? 'bad' : v.cls === 'is-late' ? 'warn' : '',
        btn: v.btn || '', own: !!v.own, note: note, share: clamp(1 - left / fillSecs(iid), 0, 1)
      };
    }
    if (ui.closing[pid]) return { text: sendWord(), tone: '', share: 0 };
    if (ui.checking[pid]) return { text: 'Checking the result…', tone: '', share: 1 };
    if (ui.settling[pid]) return { text: 'Closed. Adding it to your balance…', tone: 'done', share: 1 };
    return null;
  }

  /* The end of a close, in the chain's own figures. */
  function resultStatus(res) {
    if (res.liq) return { text: 'Liquidated at ' + res.exit + '. ' + lostWords(res.lost, res.back || 0), tone: 'bad', share: 1, final: true };
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
    /* (CF_PNL) live through the close (the owner: "updating in realtime as the trade is taking place"): the close fills at
       the oracle print of the block it lands in, so the figures at the latest print are the ones it settles to; the
       real ones replace them when it lands. Frozen only once the position is gone and its result is not read yet. */
    var fz = posById(pid) ? null : ui.phFrozen[pid];
    var est = fz ? fz.est : positionEstimate(p);
    var px = fz ? fz.px : est.px > 0 ? est.px : closePriceFor(p);
    var room = fz ? fz.room : liqRoom(p, px);
    var known = !est.delayed && isFinite(px);
    var fin = !!(st && st.final);
    /* head: side tag, coin, leverage */
    phCls(d, '.js-ps-who', 'ph-ps-who js-ps-who ' + (p.isLong ? 'is-long' : 'is-short'));
    phText(d, '.js-ps-side', p.isLong ? 'LONG' : 'SHORT');
    phShow(d, '.js-ps-side', true);
    phText(d, '.js-ps-sym', m ? m.symbol : 'Market ' + p.instrumentId);
    phText(d, '.js-ps-lev', levShown(p) + 'x');
    phShow(d, '.js-ps-lev', true);
    /* P&L: live; as it was at the tap while the close is in flight; the real figure once closed */
    var pnl = fin ? (res.liq ? -res.lost : res.pnl) : est.pnl;
    var have = known || fin;
    var tone = have ? (pnl > 0 ? ' pos' : pnl < 0 ? ' neg' : '') : '';
    phShow(d, '.js-ps-pnlrow', true);
    var spText = have ? fmtUsd(pnl, true) : est.delayed ? 'price delayed' : '—', spNode = phq(d, '.js-ps-pnl');
    if (spNode && spNode.textContent !== spText && !fin) tickPnl(spNode, p, est);
    phText(d, '.js-ps-pnl', spText);
    phCls(d, '.js-ps-pnl', 'ph-ps-pnl-n js-ps-pnl' + tone);
    phText(d, '.js-ps-pct', have ? fmtPct1(pnl / p.margin) : '');
    phCls(d, '.js-ps-pct', 'ph-ps-pct js-ps-pct' + tone);
    /* the liquidation bar and the distance, in the row's colours; gone once the position has closed */
    phShow(d, '.js-ps-liqblock', !fin);
    if (!fin) {
      var full = bustMovePct(posLev(p)) / 100;
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
    phText(d, '.js-ps-margin', fmtUsd(posColl(p)));
    phText(d, '.js-ps-size', fmtUsd(p.margin * p.leverage));
    /* the money coming back: the estimate until the close lands, then the real amount */
    phShow(d, '.js-ps-back', !(fin && res.liq));
    phText(d, '.js-ps-backk', fin ? 'Back in your balance' : 'You get back about');
    phText(d, '.js-ps-est', fin ? fmtUsd(res.paid) : known ? (est.liquidated ? '$0.00' : fmtUsd(est.payout)) : '—');
    /* the one muted line */
    var fps = fastOf(p.instrumentId);
    var note = !st ? (fps ? 'Closes at ' + fastWhen(fps, 'tap') + ', in about ' + fillSecs(p.instrumentId) + ' s.'
        : 'Closes at the oracle price of the block it fills in, about ' + fillSecs(p.instrumentId) + ' s after you tap.') + (sessionLive() ? '' : ' Your wallet asks next.')
      : fin || !fz ? '' : fps ? 'Live: it closes at ' + fastWhen(fps, 'tapped') + '.' : 'Live: it settles at the oracle price of the block the close lands in.';
    if (fin && res && res.at) note = res.at.charAt(0).toUpperCase() + res.at.slice(1) + '.';
    phText(d, '.js-ps-note', note);
    phShow(d, '.js-ps-note', !!note);
    /* Keep open and Close, or the status slot in their place */
    phShow(d, '.js-ps-pair', !st);
    phShow(d, '.js-ps-status', !!st);
    phShow(d, '.js-ps-tpsl', !st && !!posById(pid));
    try { pmSheet(d, !st && !!posById(pid)); } catch (e) { /* never blocks the sheet */ }
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
    try { pmSheet(d, false); } catch (e) { /* never blocks the sheet */ }
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
          r.appendChild(el('span', 'ph-lev', levShown(p) + 'x'));
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
    phText(d, '.js-ps-note', 'Each one closes at the price a few seconds after you tap, ' + fillSecsOf(list) + '.' + (sessionLive() ? '' : ' Your wallet asks once for each.'));
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

  /* (CF_PNL) ethers polls for a new block every pollingInterval while it waits for a receipt: at its default 4000 ms a
     request mined in a second was noticed after 4 s (measured, ethers 6.13.2 as loaded here: 4,035 ms for a receipt
     that existed at 1,000 ms), the biggest part of "fills seemed to lag". 500 ms here; the newHeads watch below
     answers even sooner. */
  var TX_POLL_MS = 500;
  /* A read that hangs this long moves to the next endpoint; that endpoint then sits out RPC_COOLDOWN_MS. */
  var RPC_TIMEOUT_MS = 4000, RPC_COOLDOWN_MS = 30000;
  /* JSON-RPC errors that mean "this node cannot serve that" (rate limit, range, capacity), not "the call reverted" */
  var RPC_CAPACITY = { '-32005': 1, '-32016': 1, '-32029': 1, '-32090': 1, '35': 1, '429': 1 };
  var rpcState = { down: {}, used: '', read: '', fails: 0 };

  function rawProvider(url) {
    var E = window.ethers;
    return new E.JsonRpcProvider(url, { chainId: CHAIN_ID, name: 'hyperevm' }, {
      staticNetwork: true,
      batchMaxCount: Number(cfg.rpcBatchMaxCount) >= 1 ? Number(cfg.rpcBatchMaxCount) : 1,
      polling: false,
      pollingInterval: TX_POLL_MS
    });
  }

  /* A provider on urls[0] whose every call moves to the next url when the one before fails (no answer, a timeout,
     or a capacity error); a revert or any other answer is the answer. A raw transaction is never sent twice on a
     timeout (the first may have gone through); only a send that never left goes on to the next url. */
  function makeProvider(url, fallbacks) {
    var urls = [url].concat(fallbacks || []).filter(function (u, i, a) { return u && a.indexOf(u) === i; });
    var p = rawProvider(urls[0]);
    if (urls.length < 2) return p;
    var backs = urls.map(function (u, i) { return i === 0 ? p : rawProvider(u); });
    var own = p._send.bind(p);
    function capacity(resp) {
      return (resp || []).some(function (r) { return r && r.error && RPC_CAPACITY[String(r.error.code)]; });
    }
    p._send = function (payload) {
      var list = Array.isArray(payload) ? payload : [payload];
      var sending = list.some(function (q) { return q && q.method === 'eth_sendRawTransaction'; });
      var now = Date.now();
      var order = urls.map(function (u, i) { return i; }).filter(function (i) { return !(rpcState.down[urls[i]] > now); });
      if (!order.length) order = urls.map(function (u, i) { return i; });
      function attempt(k) {
        var i = order[k], u = urls[i];
        var send = i === 0 ? own(payload) : backs[i]._send(payload);
        var timer = null;
        var limit = new Promise(function (ok, no) { timer = setTimeout(function () { var e = new Error('timeout'); e.rpcTimeout = true; no(e); }, RPC_TIMEOUT_MS); });
        return Promise.race([send, limit]).then(function (resp) {
          clearTimeout(timer);
          if (k + 1 < order.length && capacity(resp)) { var c = new Error('capacity'); c.rpcCapacity = true; throw c; }
          rpcState.used = u;
          if (p === read.provider) rpcState.read = u;   /* [simple] hook: the READ provider's own last good endpoint (used is also written by the log scans and the send race) */
          return resp;
        }).catch(function (e) {
          clearTimeout(timer);
          if (k + 1 >= order.length || (sending && e && e.rpcTimeout)) throw e;
          if (!(e && e.rpcCapacity)) { rpcState.down[u] = Date.now() + RPC_COOLDOWN_MS; rpcState.fails++; }
          return attempt(k + 1);
        });
      }
      return attempt(0);
    };
    return p;
  }

  /* (CF_PNL) The send path's provider: the dry run, the gas estimate and the raw transaction go to Blockfront and to
     config.json's rpcUrl at once, and the first good answer is taken. A trader far from one of them still gets the near
     one (measured from California: Blockfront 250 ms a call, drpc 55), and the same signed transaction sent twice is
     one transaction (the second node answers "already known"). A revert comes back only when every node says so. */
  function makeRaceProvider(urls) {
    urls = urls.filter(function (u, i, a) { return u && a.indexOf(u) === i; });
    var ps = urls.map(rawProvider);
    var p = ps[0];
    if (ps.length < 2) return p;
    var own = p._send.bind(p);
    function bad(resp) { return !resp || (resp || []).some(function (r) { return !r || r.error; }); }
    p._send = function (payload) {
      return new Promise(function (ok, no) {
        var left = ps.length, firstResp = null, firstErr = null, done = false;
        ps.forEach(function (q, i) {
          var send = i === 0 ? own(payload) : q._send(payload);
          var timer = null;
          var limit = new Promise(function (y, n) { timer = setTimeout(function () { n(new Error('timeout')); }, RPC_TIMEOUT_MS); });
          Promise.race([send, limit]).then(function (resp) {
            clearTimeout(timer);
            if (done) return;
            if (!bad(resp)) { done = true; rpcState.used = urls[i]; ok(resp); return; }
            if (!firstResp) firstResp = resp;
          }, function (e) { clearTimeout(timer); if (!firstErr) firstErr = e; }).then(function () {
            if (done || --left > 0) return;
            done = true;
            if (firstResp) ok(firstResp); else no(firstErr || new Error('no answer'));
          });
        });
      });
    };
    return p;
  }

  /* Blockfront first unless config.json says "blockfront": false. */
  function blockfrontOn() { return !DEMO && !(cfg && cfg.blockfront === false); }

  function initRead() {
    if (!window.ethers || !cfg.rpcUrl) return;
    var E = window.ethers;
    exIface = new E.Interface(exchangeAbi());
    refIface = new E.Interface(REFERRALS_ABI);
    vaultIface = new E.Interface(VAULT_FACTORY_ABI);
    routerIface = new E.Interface(routerAbi());
    proxyIface = new E.Interface(PROXY_ABI);
    bookIface = new E.Interface(TRIGGER_BOOK_ABI);
    read.provider = blockfrontOn() ? makeProvider(BLOCKFRONT_RPC, [cfg.rpcUrl, DEFAULT_RPC]) : makeProvider(cfg.rpcUrl, [DEFAULT_RPC]);
    read.sendProvider = blockfrontOn() ? makeRaceProvider([BLOCKFRONT_RPC, cfg.rpcUrl]) : read.provider;
    /* the history scans ask for 20,000-block ranges: config.json's logRpcUrl, then the read endpoints */
    read.logProvider = cfg.logRpcUrl && cfg.logRpcUrl !== cfg.rpcUrl ? makeProvider(cfg.logRpcUrl, [cfg.rpcUrl]) : read.provider;
    if (hasExchange()) read.exchange = new E.Contract(cfg.contracts.exchange, exchangeAbi(), read.provider);
    if (hasExchange() && isV5()) read.exchangeBps = new E.Contract(cfg.contracts.exchange, EXCHANGE_V5_BPS_ABI, read.provider);
    var refAddr = cfg.contracts && cfg.contracts.referrals;
    if (isAddr(refAddr)) read.referrals = new E.Contract(refAddr, REFERRALS_ABI, read.provider);
    if (isAddr(cfg.contracts && cfg.contracts.v2Exchange)) read.v2 = new E.Contract(cfg.contracts.v2Exchange, V2_EXCHANGE_ABI, read.provider);
    if (isAddr(cfg.contracts && cfg.contracts.v3Exchange)) read.v3 = new E.Contract(cfg.contracts.v3Exchange, V3_EXCHANGE_ABI, read.provider);
    /* only a v5 config names a v4 Exchange apart from contracts.exchange */
    if (isV5() && isAddr(cfg.contracts && cfg.contracts.v4Exchange)) read.v4 = new E.Contract(cfg.contracts.v4Exchange, V4_EXCHANGE_ABI, read.provider);
    /* the launch config (version 6) carries v4 the same way and no v5 generation (MIGRATION_ONE): v4.html is the run-off
       page, where a v4 trade's take profit and stop loss keep their browser rule */
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
      opensPaused: !!r.opensPaused, retired: !!r.retired, frozenPx: px18ToNum(r.lastPx18),
      /* the live impact curve in the contract's units, and the frozen price of a retired market (settle.js) */
      raw: window.ConfettiSettle ? window.ConfettiSettle.curve(r) : null, lastPx18: r.lastPx18 != null ? BigInt(r.lastPx18) : null
    };
  }

  var instrumentsInFlight = false;

  /* v5: which markets fill on Pyth and with what delay (fastPricing(id) for every market, fastWindows()). Read
     with the markets, then every FAST_EVERY_MS, and at once when a fallback call is refused with KeeperWindow
     (the owner can switch a market back to the HyperCore rule in one transaction; the page follows the chain's
     flag). A read that fails keeps the last answer; a market never read counts as on the HyperCore rule, whose
     times are the longer ones. Nothing here runs on a v4 config or in the demo. */
  var FAST_EVERY_MS = 60000, fastInFlight = false;
  function loadFast() {
    if (DEMO || !isV5() || !read.exchange || fastInFlight || house.instCount == null) return Promise.resolve();
    fastInFlight = true;
    var ex = read.exchange, none = function () { return null; }, ids = [];
    for (var i = 0; i < house.instCount; i++) ids.push(i);
    /* v6: the second each market's fast pricing was last switched on (a market back on Pyth: its levels judge prints
       from fastSince + delay only) */
    var since = isV6() ? ids.map(function (id) { return ex.fastSince(id).then(function (v) { if (Number(v) !== trig.since[id]) { trig.since[id] = Number(v); } }, none); }) : [];
    return Promise.all([ex.fastWindows().catch(none)].concat(ids.map(function (id) { return ex.fastPricing(id).catch(none); }), ids.map(function (id) { return ex.tradeFee(id).catch(none); }), since)).then(function (r) {
      var changed = false;
      if (r[0]) {
        var fw = Number(r[0][0]);
        if (fw > 0 && fw !== house.fastWindow) { house.fastWindow = fw; changed = true; }
        house.maxPubLag = Number(r[0][1]);
        if (Number(r[0][2]) > 0) house.liqMaxAge = Number(r[0][2]);
      }
      ids.forEach(function (id, k) {
        var f = r[k + 1];
        if (!f) return;
        var was = house.fast[id], now = { on: !!f[0], delay: Number(f[1]), maxDevBps: Number(f[2]), maxConfBps: Number(f[3]) };
        if (!was || was.on !== now.on || was.delay !== now.delay) changed = true;
        house.fast[id] = now;
      });
      /* the size fee of every market (tradeFee(id)); a read that fails keeps the last answer */
      ids.forEach(function (id, k) {
        var t = r[k + 1 + ids.length];
        if (!t) return;
        var had = house.tradeFee[id], got = { rateX10: Number(t[0]), capBps: Number(t[1]) };
        if (!had || had.rateX10 !== got.rateX10 || had.capBps !== got.capBps) changed = true;
        house.tradeFee[id] = got;
      });
      house.fastAt = Date.now();
      if (changed) { renderForm(); renderAction(); renderStatus(); renderPositions(); smEmit('account'); }
      if (isV6()) trigChanged();      /* a market off Pyth pauses its levels on chain (the browser acts on them meanwhile) */
    }).catch(function () { /* keep the last answer */ }).then(function () { fastInFlight = false; });
  }

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
      loadFast();
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
      if (r[9] != null) { house.minDelay = Number(r[9]); house.delaysAt = Date.now(); }      /* delaysAt: the chain's own wait is in */
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
        read.router = new E.Contract(cfg.contracts.sessionRouter, routerAbi(), read.provider);
      }
      renderStatus();
      return Promise.all([loadFactory(), loadVaultFactory(), loadTriggerBook()]);
    });
  }

  /* v6: the TriggerBook, used only when exchange.triggerBook() is the pinned contracts.triggerBook and the book names
     this exchange, its router and its oracle back (the Exchange's constructor binds them both ways for good). Until
     then, without a pin, or on a v4 / v5 config, take profit and stop loss stay the browser rule. A read that fails is
     tried again with the next account read (trigEnsureBook). */
  function loadTriggerBook() {
    if (DEMO || !isV6() || !read.exchange || read.book || trig.bookAsked) return Promise.resolve();
    var pin = cfg.contracts.triggerBook, E = window.ethers;
    trig.bookAsked = true;
    var same = function (x, y) { return isAddr(x) && isAddr(y) && String(x).toLowerCase() === String(y).toLowerCase(); };
    return read.exchange.triggerBook().then(function (a) {
      house.addrs.triggerBook = a;
      if (!same(a, pin)) {
        house.unpinned.triggerBook = true;
        console.error('exchange.triggerBook() ' + a + ' is not the pinned ' + (pin || 'none') + '; take profit and stop loss stay in this browser.');
        return;
      }
      var b = new E.Contract(pin, TRIGGER_BOOK_ABI, read.provider);
      return Promise.all([b.exchange(), b.router(), b.oracle()]).then(function (r) {
        if (!same(r[0], cfg.contracts.exchange) || !same(r[1], cfg.contracts.sessionRouter) || (isAddr(house.addrs.oracle) && !same(r[2], house.addrs.oracle))) {
          house.unpinned.triggerBook = true;
          console.error('the TriggerBook ' + pin + ' names exchange ' + r[0] + ', router ' + r[1] + ', oracle ' + r[2] + ', not this exchange\'s; take profit and stop loss stay in this browser.');
          return;
        }
        read.book = b;
        trigReady();
      });
    }).catch(function () { trig.bookAsked = false; /* unreadable: asked again with the next account read */ });
  }

  /* The code vault factory (pinned), kept only if it makes codes on this exchange's registry;
     until then, or without one, the "More codes" block stays hidden. */
  function loadVaultFactory() {
    if (DEMO) return Promise.resolve();
    var a = cfg.contracts.codeVaultFactory;
    if (!isAddr(a) || !read.exchange || read.vaultFactory) return Promise.resolve();
    var f = new window.ethers.Contract(a, VAULT_FACTORY_ABI, read.provider);
    var reg = (house.addrs && house.addrs.referrals) || cfg.contracts.referrals;
    return Promise.all([f.exchange(), f.referrals()]).then(function (r) {
      if (String(r[0]).toLowerCase() === cfg.contracts.exchange.toLowerCase() && isAddr(reg) && String(r[1]).toLowerCase() === reg.toLowerCase()) {
        read.vaultFactory = f;
        if (wallet.account) return loadVaults(wallet.account);
      } else {
        console.error('contracts.codeVaultFactory ' + a + ' makes codes for ' + r[0] + ', not this exchange; extra codes are off.');
      }
    }).catch(function () { /* unreadable: the block stays hidden */ });
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

  /* The settlement price of a market right now (the oracle; a retired market's frozen price), 1e18 as a BigInt.
     Resolves to null when the feed is dead. */
  function readOraclePx(id) {
    return read.exchange.execPrice(id, true, true).then(function (px) { return BigInt(px); }).catch(function () { return null; });
  }

  /* ---- the settlement price, exact (CF_PNL, 2026-11-04) ----
     The owner: "i want the pnl card to be updating in realtime as the trade is taking place", "very accurate and fast".
     Every fill, close and liquidation settles on the HyperCore oracle print the exchange reads through the price
     precompile (Exchange._execPrice -> PriceOracle.oraclePrice). Hyperliquid's validators publish that print about every
     3 s; between prints the exchange settles at the last one, whatever the book does. So a card shows the latest print,
     exactly, as soon as it exists, and nothing in between: measured over 10 minutes on 8 markets, the bbo-anchored
     price the cards showed before (the mid's move since the last 2 s oracle read) sat 0.8-4 bps off the settlement
     price at the 90th percentile and up to 29 bps at worst (at 1000x, 1 bp is a tenth of the margin); the print is off
     only in the quarter second it takes to read it.
     Sources, best first: the block feed below (Blockfront newHeads, execPrice at every block: the number the contract
     itself would use; first with a new print 70 % of the time, about 0.4 s ahead of Hyperliquid's stream), then
     Hyperliquid's activeAssetCtx stream (the same oracle a little later, plus a few prints a minute that never reach
     the EVM: used only while the block feed is quiet, and in the demo), then the 2 s poll (tickOracle). A print is taken
     only from a look newer than the one in hand, so a slow answer never puts an older price back. */
  var oracle = { at: {}, src: {}, block: {} };   /* id -> when the price in hand was observed, by which source, at which block */

  function setOraclePx(id, px18, src, seenAt, block) {
    if (id == null || px18 == null || !(px18 > 0n)) return false;
    var at = seenAt || Date.now();
    if (oracle.at[id] && at < oracle.at[id] && house.oraclePx18ById[id] != null) return false;   /* an older look */
    var moved = house.oraclePx18ById[id] !== px18;
    if (moved || midAtPrint[id] == null) notePrintMid(id);   /* (est1) the live estimate's starting point */
    house.oraclePx18ById[id] = px18;
    house.oraclePxById[id] = px18ToNum(px18);
    house.oraclePxAt[id] = Date.now();
    oracle.at[id] = at; oracle.src[id] = src; oracle.block[id] = block || null;
    if (moved) oracle.moves = (oracle.moves || 0) + 1;
    return moved;
  }

  /* The 2 s poll: only while the block feed is quiet (the feed reads the same price at every block). */
  var oracleBusy = false;
  function tickOracle() {
    if (DEMO || document.hidden || oracleBusy || !read.exchange || headsFresh()) return;
    var ids = cardInstruments();
    if (!ids.length) return;
    var account = wallet.account;
    oracleBusy = true;
    var asked = Date.now();
    Promise.all(ids.map(readOraclePx)).then(function (opx) {
      if (wallet.account !== account) return;
      var moved = false;
      ids.forEach(function (id, i) { if (opx[i] != null && setOraclePx(id, opx[i], 'poll', asked)) moved = true; });
      if (moved) drawCards();
    }).catch(function () { /* the 10 s chain poll still reads it */ }).then(function () { oracleBusy = false; });
  }

  /* The markets a card needs a price for: open positions, orders on their way in, the market on the ticket. */
  function cardInstruments() {
    var ids = [];
    function add(id) { if (id != null && ids.indexOf(id) < 0) ids.push(id); }
    if (wallet.account && acct.loaded) acct.positions.forEach(function (p) { add(p.instrumentId); });
    pendingOpenList().forEach(function (r) { add(r.instrumentId); });
    quick.list.forEach(function (r) { add(r.instrumentId); });
    if (state.market && state.market.instrumentId != null) add(state.market.instrumentId);
    /* (amt3) the coin a Simple sheet is pricing (sheetPriced), while it is: a trade opens at that coin's oracle print,
       not at the book mid, so the sheet needs the print as the cards do (it fell back to the mid: up to 15 bps off) */
    var t = Date.now();
    if (sheetSeen) Object.keys(sheetSeen).forEach(function (id) { if (t - sheetSeen[id] < SHEET_SEEN_MS) add(Number(id)); else delete sheetSeen[id]; });
    return ids;
  }
  var SHEET_SEEN_MS = 20000, sheetSeen = {};
  function sheetPriced(m) { if (m && m.instrumentId != null) sheetSeen[m.instrumentId] = Date.now(); }

  /* One redraw per frame however many prices and blocks land in it. */
  var drawPending = false;
  function drawCards() {
    if (drawPending) return;
    drawPending = true;
    var run = function () { drawPending = false; try { updatePositionPrices(); renderAccount(); } catch (e) { /* never stops the feed */ } };
    if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(run); else setTimeout(run, 16);
  }

  /* ---- Hyperliquid's oracle stream (activeAssetCtx), one socket for the coins the cards need ----
     The second source of the settlement price (the demo's only one): the validator oracle the precompile returns,
     parsed digit for digit into the precompile's integer. Built on the 2026-11-02 feed's socket (one per page, while a
     card needs it and the tab is visible, 1-30 s backoff, a ping every 30 s); that feed's bbo-anchored price is gone
     from the cards: it was not the price anything settles on. */
  var fast = { ws: null, subs: {}, retry: 0, again: null, ping: null, px: {}, at: {} };

  function fastCoins() {
    var out = {};
    cardInstruments().forEach(function (id) { var inst = state.byInstId[id]; var m = inst && inst.market; if (m && m.coin) out[m.coin] = true; });
    return out;
  }

  function fastResub() {
    var ws = fast.ws;
    if (!ws || ws.readyState !== 1) return;
    var want = fastCoins();
    var send = function (method, coin) { try { ws.send(JSON.stringify({ method: method, subscription: { type: 'activeAssetCtx', coin: coin } })); } catch (e) { /* closing */ } };
    Object.keys(want).forEach(function (c) { if (!fast.subs[c]) { fast.subs[c] = true; send('subscribe', c); } });
    Object.keys(fast.subs).forEach(function (c) { if (!want[c]) { delete fast.subs[c]; send('unsubscribe', c); } });
  }

  function fastWanted() {
    if (document.hidden || !Object.keys(fastCoins()).length) return false;
    return DEMO ? true : !!(wallet.account && acct.loaded);
  }

  /* A print from the stream: taken in the demo always, on the live page only while the block feed is quiet (the
     chain answers first most of the time, and the stream carries a few prints a minute the EVM never sees). */
  function onFastCtx(coin, ctx) {
    var m = state.byCoin[coin];
    if (!m || m.instrumentId == null || !ctx || !window.ConfettiSettle) return;
    var inst = state.byInstId[m.instrumentId];
    if (inst && inst.retired) return;
    var raw = window.ConfettiSettle.parseOracle(ctx.oraclePx, m.szDecimals);
    if (raw == null) return;
    var px18 = window.ConfettiSettle.oracle18(raw, m.szDecimals);
    fast.px[coin] = px18; fast.at[coin] = Date.now();
    if (!DEMO && headsFresh()) return;
    if (DEMO && acct.positions.some(function (p) { return p.instrumentId === m.instrumentId; })) pnlBeat(null);
    if (setOraclePx(m.instrumentId, px18, 'hl', Date.now())) drawCards();
  }

  function syncFastFeed() {
    if (!fastWanted()) { closeFastFeed(); return; }
    if (fast.ws) { fastResub(); return; }
    if (fast.again || typeof WebSocket !== 'function') return;
    var ws;
    try { ws = new WebSocket(liveWsUrl()); } catch (e) { return; }
    fast.ws = ws;
    ws.onopen = function () {
      if (fast.ws !== ws) return;
      fast.retry = 0;
      fast.subs = {};
      fastResub();
      fast.ping = setInterval(function () { try { ws.send(JSON.stringify({ method: 'ping' })); } catch (e) { /* closing */ } }, LIVE_PING_MS);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.channel !== 'activeAssetCtx' || !msg.data || !fast.subs[msg.data.coin]) return;
      onFastCtx(msg.data.coin, msg.data.ctx);
    };
    ws.onclose = function () {
      if (fast.ws !== ws) return;
      if (fast.ping) { clearInterval(fast.ping); fast.ping = null; }
      fast.ws = null; fast.subs = {};
      if (fastWanted()) {
        var wait = Math.min(30000, 1000 * Math.pow(2, fast.retry++));
        fast.again = setTimeout(function () { fast.again = null; syncFastFeed(); }, wait);
      }
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  function closeFastFeed() {
    if (fast.again) { clearTimeout(fast.again); fast.again = null; }
    if (fast.ping) { clearInterval(fast.ping); fast.ping = null; }
    var ws = fast.ws;
    fast.ws = null; fast.subs = {};
    if (ws) { try { ws.close(); } catch (e) { /* gone */ } }
  }

  /* The price a card shows for market m: the settlement price, as the exchange would take it now. */
  function livePrice(m) { return settlePrice(m); }

  /* ---- the block feed (Blockfront newHeads) ----
     One WebSocket while the tab is visible. Each new block: the chain clock (the countdowns), and one JSON-RPC batch
     read at that very block: execPrice of every market a card needs, previewClose of every open position (each card is
     held to it, block by block: heads.audit), the payout queue (the loss fee), and while a trade is in flight the
     exchange's logs in that block (request, fill, refund, close, liquidation: the cards change in the block it happens,
     with no poll and no wait on a receipt) and the receipts a send waits on. The 2 s oracle poll and the 400 ms request
     poll stand in whenever this goes quiet for HEADS_STALE_MS. */
  var HEADS_STALE_MS = 2500, HEADS_PING_MS = 25000, HEAD_READ_MS = 4000;
  var heads = {
    ws: null, retry: 0, again: null, ping: null, last: 0, block: 0, ts: 0, hash: null, busy: false, next: null,
    receipts: {}, logs: {}, rounds: 0, warned: {},
    audit: { blocks: 0, checked: 0, agree: 0, disagree: 0, last: null }
  };
  /* (CF_PNL) for a test or a curious trader in the console: how the cards stand against the contract, and the last
     60 block reads (when the head came, when its read answered, how many calls) */
  heads.trace = [];
  window.ConfettiPnlAudit = function () { return JSON.parse(JSON.stringify({ heads: { block: heads.block, rounds: heads.rounds, fresh: headsFresh(), seenLag: heads.seenLag, clockOff: chainClock.off }, audit: heads.audit, src: oracle.src, rpc: rpcState.used, trace: heads.trace }, function (k, v) { return typeof v === 'bigint' ? String(v) : v; })); };

  function headsFresh() { return !!heads.ws && heads.last > 0 && Date.now() - heads.last < HEADS_STALE_MS; }
  /* only for a connected trader (a visitor's ticket price comes from the 10 s chain read, as before): one socket and at
     most one small batch a block per trader */
  function headsWanted() { return blockfrontOn() && !document.hidden && typeof WebSocket === 'function' && !!read.exchange && !!exIface && !!wallet.account; }

  function syncHeads() {
    if (!headsWanted()) { closeHeads(); return; }
    if (heads.ws || heads.again) return;
    var ws;
    try { ws = new WebSocket(BLOCKFRONT_WS); } catch (e) { return; }
    heads.ws = ws;
    ws.onopen = function () {
      if (heads.ws !== ws) return;
      heads.retry = 0;
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
        /* (CF_PNL) and the exchange's logs, pushed as each block lands: measured on Blockfront 120 ms after its head and
           0.5 s ahead of reading them at the head; the read at the head stays as the backstop */
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_subscribe', params: ['logs', { address: cfg.contracts.exchange }] }));
      } catch (e) { /* closing */ }
      heads.ping = setInterval(function () { try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] })); } catch (e) { /* closing */ } }, HEADS_PING_MS);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.id === 3 && msg.result) { heads.logSub = msg.result; return; }
      var h = msg && msg.method === 'eth_subscription' && msg.params ? msg.params.result : null;
      if (!h) return;
      if (heads.logSub && msg.params.subscription === heads.logSub) { onPushedLog(h); return; }
      if (h.number && h.hash) onHead(h);
    };
    ws.onclose = function () {
      if (heads.ws !== ws) return;
      if (heads.ping) { clearInterval(heads.ping); heads.ping = null; }
      heads.ws = null;
      if (headsWanted()) {
        var wait = Math.min(30000, 1000 * Math.pow(2, heads.retry++));
        heads.again = setTimeout(function () { heads.again = null; syncHeads(); }, wait);
      }
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  function closeHeads() {
    if (heads.again) { clearTimeout(heads.again); heads.again = null; }
    if (heads.ping) { clearInterval(heads.ping); heads.ping = null; }
    var ws = heads.ws;
    heads.ws = null;
    if (ws) { try { ws.close(); } catch (e) { /* gone */ } }
  }

  function onHead(h) {
    var n = parseInt(h.number, 16), ts = parseInt(h.timestamp, 16);
    if (!(n > heads.block)) return;
    heads.block = n; heads.ts = ts; heads.hash = h.hash;
    noteChainClock(ts, Date.now());
    if (h.baseFeePerGas) { try { heads.baseFee = BigInt(h.baseFeePerGas); } catch (e) { /* not a number */ } }
    noteHeadTs(n, ts);
    noteBlock({ number: n, timestamp: ts });
    heads.audit.blocks++;
    var job = { n: n, hash: h.hash, ts: ts, seen: Date.now() };
    if (heads.busy) { heads.next = job; return; }
    readAtHead(job);
  }

  /* Anything whose end the cards are waiting for: an order on its way in, a request, a close, a send. */
  function inFlight() {
    return quick.list.length > 0 || pendingOpenList().length > 0 || Object.keys(acct.closeReqs).length > 0 ||
      Object.keys(ui.closing).length > 0 || Object.keys(heads.receipts).length > 0 || !!(tk.phase && tk.phase !== 'opened') || nearBust() || trigBusy();
  }

  /* (CF_PNL, weak spot 1) A position in the last fifth of its way to liquidation, or past it: its liquidation can land in
     any block, so the block feed reads the logs then too and the result card comes in the block it happens (it came
     with the next 10 s account read before). */
  function nearBust() {
    if (!wallet.account || !acct.loaded) return false;
    return acct.positions.some(function (p) {
      var px = closePriceFor(p);   /* a fast market: its estimated print, the price its card measures from */
      if (!(px > 0)) return false;
      var room = liqRoom(p, px);
      return room.cls === 'is-red' || room.away === 0;
    });
  }

  function rpcCall(to, data, tag) { return ['eth_call', [{ to: to, data: data }, tag]]; }

  function readAtHead(job) {
    var ex = cfg.contracts.exchange, tag = '0x' + job.n.toString(16);
    var calls = [], use = [];
    cardInstruments().forEach(function (id) { calls.push(rpcCall(ex, exIface.encodeFunctionData('execPrice', [id, true, true]), tag)); use.push(['px', id]); });
    var mine = wallet.account && acct.loaded ? acct.positions.slice() : [];
    /* (SITE4) a live fast market's card is held to the contract at the price it shows: previewCloseAt at its
       estimated print (the contract's own figures at a given price), not previewClose at the HyperCore price */
    mine.forEach(function (p) {
      var f = isV5() ? fastPx18(p.instrumentId) : null;
      if (f != null) { calls.push(rpcCall(ex, exIface.encodeFunctionData('previewCloseAt', [p.id, 10000, f]), tag)); use.push(['pv', p, f]); }
      else { calls.push(rpcCall(ex, exIface.encodeFunctionData('previewClose', [p.id]), tag)); use.push(['pv', p]); }
    });
    if (mine.length) {
      calls.push(rpcCall(ex, exIface.encodeFunctionData('queueLength', []), tag)); use.push(['qlen']);
      calls.push(rpcCall(ex, exIface.encodeFunctionData('queueHead', []), tag)); use.push(['qhead']);
    }
    var range = null;
    if (wallet.account && inFlight()) {
      range = logsRange(job.n);
      calls.push(['eth_getLogs', [{ address: ex, fromBlock: '0x' + range.from.toString(16), toBlock: tag }]]); use.push(['logs']);
      /* v6: the book's events in the same blocks (a level set or moved, a fire): its own query, so a node that takes one
         address a call answers both */
      if (isV6() && read.book) { calls.push(['eth_getLogs', [{ address: read.book.target, fromBlock: '0x' + range.from.toString(16), toBlock: tag }]]); use.push(['blogs']); }
    } else heads.logsFrom = null;
    Object.keys(heads.receipts).forEach(function (hash) { calls.push(['eth_getTransactionReceipt', [hash]]); use.push(['rc', hash]); });
    if (!calls.length) { heads.last = Date.now(); return; }
    heads.busy = true;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, HEAD_READ_MS);
    var account = wallet.account;
    fetch(BLOCKFRONT_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl ? ctrl.signal : undefined,
      body: JSON.stringify(calls.map(function (c, i) { return { jsonrpc: '2.0', id: i, method: c[0], params: c[1] }; }))
    }).then(function (res) { if (!res.ok) throw new Error('head read ' + res.status); return res.json(); }).then(function (out) {
      if (wallet.account !== account) return;
      var byId = [];
      (Array.isArray(out) ? out : [out]).forEach(function (x) { if (x && x.id != null) byId[x.id] = x; });
      heads.rounds++;
      heads.last = Date.now();
      heads.trace.push({ n: job.n, seen: job.seen, done: Date.now(), calls: calls.length, logs: !!range });
      if (heads.trace.length > 60) heads.trace.shift();
      /* how far into a block's second its answer lands, smoothed: what the countdowns add to reach 0 with the card */
      if (chainClock.off != null) {
        var lag = clamp(Date.now() / 1000 + chainClock.off - job.ts, 0, 3);
        heads.seenLag = heads.seenLag == null ? lag : heads.seenLag * 0.8 + lag * 0.2;
      }
      var at = { px: {}, pv: [], qlen: null, qhead: null }, logs = null, blogs = null, moved = false;
      use.forEach(function (u, i) {
        var x = byId[i];
        if (!x || x.error || x.result == null) return;
        try {
          if (u[0] === 'px') { at.px[u[1]] = BigInt(x.result); if (setOraclePx(u[1], at.px[u[1]], 'chain', job.seen, job.n)) moved = true; }
          else if (u[0] === 'pv') { var d = exIface.decodeFunctionResult(u[2] != null ? 'previewCloseAt' : 'previewClose', x.result); at.pv.push({ p: u[1], px18: u[2] != null ? u[2] : null, pnl: BigInt(d[0]), fee: BigInt(d[1]), payout: BigInt(d[2]) }); }
          else if (u[0] === 'qlen') at.qlen = Number(BigInt(x.result));
          else if (u[0] === 'qhead') at.qhead = Number(BigInt(x.result));
          else if (u[0] === 'logs') { logs = x.result; if (range) heads.logsFrom = range.to + 1; }
          else if (u[0] === 'blogs') blogs = x.result;
          else if (u[0] === 'rc') onHeadReceipt(u[1], x.result);
        } catch (e) { /* one bad answer never stops the rest */ }
      });
      if (at.qlen != null && at.qhead != null) { house.queueLen = at.qlen; house.queueHead = at.qhead; }
      at.pv.forEach(function (c) { auditCard(c, job, at); });
      if (at.pv.length) pnlBeat(job.n);
      if (blogs) { try { trigNoteLogs(blogs); } catch (e) { /* never stops the block */ } }
      if (logs) onBlockLogs(logs, job);
      if (moved || at.pv.length || logs) drawCards();
    }).catch(function () { /* the next block reads again; the polls stand in while this stays quiet */ }).then(function () {
      clearTimeout(timer);
      heads.busy = false;
      var next = heads.next; heads.next = null;
      if (next && next.n > job.n) readAtHead(next);
    });
  }

  /* Hold a card to the contract: this page's settlement of position p at block job.n (that block's price, time and
     queue) against previewClose(p) read at the same block. Equal to the 1e-6 USDC, or the card shows the contract's
     figures (p.chainPv) until the model agrees again, and the position and its market are read afresh. */
  /* (CF_PNL, weak spot 2) Between two oracle prints (3 s, and 6-24 s on a quiet coin) the P&L rightly holds still while the
     chart moves, and a still number reads as a stuck one. A dot by Your positions pulses at every block the cards were
     read and held to the contract (or, in the demo, at every oracle print): the number is still because the price that
     counts is, not because the page stopped. Hidden with no position open or while the feeds are quiet. */
  function pnlBeat(block) {
    ['pnlBeat', 'phPnlBeat'].forEach(function (id) {
      var d = $(id);
      if (!d) return;
      var on = !!(wallet.account && acct.loaded && acct.positions.length);
      if (d.hidden === on) d.hidden = !on;
      if (!on) return;
      var t = acct.positions.some(function (p) { return !!fastOf(p.instrumentId); })
        ? 'Live: every figure is at the latest price. A close fills at the market price a moment after you tap, so the result can differ a little.'
        : block ? 'Live: every figure is the exchange\'s own settlement at block ' + block.toLocaleString('en-US') + '.' : 'Live: every figure is the exchange\'s settlement at the latest oracle print.';
      if (d.title !== t) d.title = t;
      if (reducedMotion()) return;
      d.removeAttribute('data-beat');
      void d.offsetWidth;
      d.setAttribute('data-beat', '1');
    });
  }
  setInterval(function () {
    /* a beat that stops: the dot dims (and "price delayed" follows after PX_FRESH_MS) */
    var quiet = !DEMO ? !headsFresh() : !(Object.keys(fast.at).some(function (c) { return Date.now() - fast.at[c] < 5000; }));
    ['pnlBeat', 'phPnlBeat'].forEach(function (id) { var d = $(id); if (d) d.classList.toggle('is-quiet', quiet); });
  }, 1000);

  function auditCard(c, job, at) {
    var p = c.p, S = window.ConfettiSettle, inst = state.byInstId[p.instrumentId];
    /* the price the contract was asked at: a fast market's estimated print (previewCloseAt), else the block's */
    var px18 = c.px18 != null ? c.px18 : at.px[p.instrumentId];
    if (!S || !p.raw || !inst || !inst.raw || px18 == null) return;
    var qEmpty = at.qlen == null ? true : at.qlen === at.qhead;
    var mine = S.previewClose(p.raw, inst.raw, px18, BigInt(job.ts), qEmpty);
    heads.audit.checked++;
    var same = mine.pnl === c.pnl && mine.fee === c.fee && mine.payout === c.payout;
    heads.audit.last = { block: job.n, id: String(p.id), same: same };
    if (same) { heads.audit.agree++; p.chainPv = null; p.checkedAt = job.n; return; }
    heads.audit.disagree++;
    p.chainPv = { block: job.n, px18: px18, pnl: c.pnl, fee: c.fee, payout: c.payout };
    if (!heads.warned[String(p.id)]) {
      heads.warned[String(p.id)] = true;
      console.warn('P&L card #' + p.id + ' at block ' + job.n + ': page ' + mine.pnl + '/' + mine.fee + '/' + mine.payout + ', previewClose ' + c.pnl + '/' + c.fee + '/' + c.payout + '; showing the contract\'s figures and reading the position again.');
      setTimeout(function () { refreshAccount(); loadInstruments(); }, 0);
    }
  }

  /* A receipt the block feed found for a send that waits on it (sendTx races this with ethers' own wait). */
  function onHeadReceipt(hash, rc) {
    var w = heads.receipts[hash];
    if (!w || !rc) return;
    delete heads.receipts[hash];
    w({ hash: rc.transactionHash || hash, blockNumber: Number(rc.blockNumber), status: Number(rc.status), logs: rc.logs || [], viaHeads: true });
  }

  function headReceipt(hash) {
    return new Promise(function (ok) { heads.receipts[hash] = ok; });
  }

  /* ---- (CF_PNL) the trade's own events, in the block they happen ----
     The exchange's logs, read at each head while something is in flight (readAtHead): this account's request, its
     fill or refund, a close request, the close or the liquidation. Each is handled once (heads.logs), by whichever path
     sees it first (this, a send's receipt, the request poll, which stays as the stand-in); the account read that
     follows only confirms it. Before this the page learned of a fill from a receipt ethers noticed after 4 s, then a
     request poll that trusted an empty read only 4 s after that, then a log query: a 3 s fill reached the card after
     about 9. */
  var BLOCK_TS_KEEP = 64;
  heads.tsByBlock = {};

  function noteHeadTs(n, ts) {
    heads.tsByBlock[n] = ts;
    var old = n - BLOCK_TS_KEEP;
    if (heads.tsByBlock[old] != null) delete heads.tsByBlock[old];
  }

  /* A log the block feed pushed: handled at once if it is this account's (onBlockLogs dedupes it with the read at the
     head). Its block's time is the head's when that came first, else the latest head's plus the blocks between. */
  function onPushedLog(l) {
    if (l && l.topics && !l.removed) noteFastLogs([l]);
    if (l && !l.removed && termsChanged(l)) return;   /* (amt2) what a trade costs was changed: read again in that block */
    if (!wallet.account || !l || !l.topics || l.removed) return;
    var n = Number(l.blockNumber);
    var ts = heads.tsByBlock[n] != null ? heads.tsByBlock[n] : heads.ts ? heads.ts + Math.max(0, n - heads.block) : Math.floor(chainNow());
    onBlockLogs([l], { n: n, ts: ts, seen: Date.now() });
  }

  /* v5: the owner changed a market's pricing rule, the fast windows or a market's size fee (FastPricingSet,
     FastWindowsSet, TradeFeeSet): read them again at once, wallet or not, so the page's times, windows and amounts
     are the chain's within a block. */
  var fastTopics = null;
  function noteFastLogs(logs) {
    if (!isV5() || !exIface) return;
    if (!fastTopics) fastTopics = [exIface.getEvent('FastPricingSet').topicHash, exIface.getEvent('FastWindowsSet').topicHash, exIface.getEvent('TradeFeeSet').topicHash];
    if ((logs || []).some(function (l) { return l && l.topics && fastTopics.indexOf(l.topics[0]) >= 0; })) loadFast();
  }

  function onBlockLogs(logs, job) {
    if (Array.isArray(logs) && logs.length) noteFastLogs(logs);
    if (!wallet.account || !Array.isArray(logs) || !logs.length) return;
    notePrints(logs);
    var me = wallet.account.toLowerCase();
    var mine = {};
    acct.positions.forEach(function (p) { mine[String(p.id)] = p; });
    var any = false;
    var byBlock = {};
    logs.forEach(function (l) { var b = Number(l.blockNumber); (byBlock[b] = byBlock[b] || []).push(l); });
    parsedLogs(logs).forEach(function (ev) {
      var a = ev.args;
      var key = ev.tx + ':' + ev.name + ':' + String(a[0]);
      if (heads.logs[key]) return;
      var who = ev.name === 'CloseRequestCancelled' ? null : (a.trader || a.owner);
      var ours = who ? String(who).toLowerCase() === me : !!mine[String(a.positionId)];
      if (!ours) return;
      heads.logs[key] = true;
      any = true;
      var at = { n: ev.block != null ? ev.block : job.n, ts: heads.tsByBlock[ev.block] != null ? heads.tsByBlock[ev.block] : job.ts };
      var same = byBlock[at.n] || logs;
      if (ev.name === 'OpenRequested') onOpenRequested(ev, at);
      else if (ev.name === 'PositionOpened' || ev.name === 'OpenRequestCancelled') onOpenEnded(ev, same, at);
      else if (ev.name === 'CloseRequested') onCloseRequested(ev, at);
      else if (ev.name === 'PositionClosed' || ev.name === 'PositionLiquidated' || ev.name === 'CloseRequestCancelled') onCloseEnded(ev, same, mine);
    });
    if (any) renderPositions();
  }

  /* A request this account filed: the order's card starts its countdown from the request's own block. */
  function onOpenRequested(ev, at) {
    var a = ev.args, id = String(a.requestId);
    if (pend.done[id]) return;
    var q = quick.list.filter(function (x) { return x.txHash && x.txHash.toLowerCase() === String(ev.tx).toLowerCase(); })[0];
    var r = pend.opens[id];
    if (r) { r.requestedAt = at.ts; r.block = at.n; }
    else trackOpenRequest({
      id: id, instrumentId: Number(a.instrumentId), isLong: !!a.isLong, margin: usd6ToNum(a.marginUsdc), leverage: Number(a.leverage),
      px0: px18ToNum(a.px0), requestedAt: at.ts, block: at.n, localAt: Date.now()
    });
    if (q) { quick.list = quick.list.filter(function (x) { return x !== q; }); q.reqId = id; }
    if (tk.phase === 'wallet' && tk.txHash && tk.txHash.toLowerCase() === String(ev.tx).toLowerCase()) tkSet('req', { reqId: id });
  }

  /* The position as executeOpen just booked it, from its PositionOpened event: the terms the exchange stamps at the
     fill are the market's and the house's right now, so the card is exact at once; positions(id), read right after,
     replaces it (provisional until then: the maximum profit is the one stamp that may differ, and only on a win the
     size of the house's cap). */
  function provisionalPosition(ev, at, r) {
    var a = ev.args, S = window.ConfettiSettle;
    /* v5: the size-fee stamp is the share its request reserved */
    var feeX10 = r ? reqShare(r) : isV5() ? feeShareFor(Number(a.instrumentId), Number(a.leverage)) : 0;
    var inst = state.byInstId[Number(a.instrumentId)] || {};
    var margin6 = BigInt(a.marginUsdc), lev = Number(a.leverage);
    var cap = margin6 * BigInt(inst.payoutCapX || 0);
    var bps = liveOr(house.maxWinBps, 'maxWinBps');
    if (house.free != null && bps != null) { var byHouse = BigInt(Math.floor(house.free * 1e6)) * BigInt(bps) / 10000n; if (byHouse < cap) cap = byHouse; }
    var t = {
      isLong: !!a.isLong, marginUsdc: margin6, leverage: lev, maxProfitUsdc: cap, entryPx18: BigInt(a.entryPx18), openedAt: at.ts,
      deadbandBps: inst.deadbandBps || 0, winFeeBps: liveOr(house.winFeeBps, 'winFeeBps') || 0, lossFeeBps: liveOr(house.lossFeeBps, 'lossFeeBps') || 0,
      entryDeadbandBps: inst.entryDeadbandBps || 0, borrowRateX10: inst.borrowRateX10 || 0, borrowFreeHours: freeHours() || 0
    };
    return {
      id: BigInt(a.positionId), instrumentId: Number(a.instrumentId), isLong: !!a.isLong, margin: usd6ToNum(margin6), leverage: lev,
      entry: px18ToNum(t.entryPx18), entryPx18: t.entryPx18, openedAt: at.ts, deadbandBps: t.deadbandBps, payoutCapX: inst.payoutCapX || 0,
      maxProfit: usd6ToNum(cap), winFeeBps: t.winFeeBps, lossFeeBps: t.lossFeeBps, entryDeadbandBps: t.entryDeadbandBps,
      borrowRateX10: t.borrowRateX10, borrowFreeHours: t.borrowFreeHours, preview: null, provisional: true,
      feeX10: feeX10, openFee: feeOnStake(usd6ToNum(margin6), feeX10),
      raw: S ? S.position(t, feeX10) : null
    };
  }

  /* A request of this account ended: filled (the position takes the order's place in the same render) or refunded
     (the reason takes it, at once). */
  function onOpenEnded(ev, logs, at) {
    var a = ev.args, id = String(a.requestId);
    if (pend.done[id]) return;
    pend.done[id] = true;
    var r = pend.opens[id];
    if (!r && ev.name === 'PositionOpened') r = { id: id, instrumentId: Number(a.instrumentId), isLong: !!a.isLong, margin: usd6ToNum(a.marginUsdc), leverage: Number(a.leverage) };
    if (ev.name === 'PositionOpened') {
      var p = provisionalPosition(ev, at, r);
      if (!posById(p.id)) {
        acct.positions.push(p);
        acct.positions.sort(function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });
        acct.marginInUse += p.margin;
        /* the reservation leaves pending whole: the stake into the position, the open fee to the pool */
        acct.pending = Math.max(0, acct.pending - p.margin - posOpenFee(p));
      }
    } else if (r) {
      /* a refund returns what the request held: the stake and the fee reserved with it */
      acct.available += reqIn(r);
      acct.pending = Math.max(0, acct.pending - reqIn(r));
    }
    if (pend.opens[id]) { delete pend.opens[id]; savePendingIds(); }
    if (r) reportOpenOutcome(r, logs, ev.tx);
    afterTx();
  }

  /* A close request of this account: the card counts the close down from the request's own block. */
  function onCloseRequested(ev, at) {
    var a = ev.args, pid = String(a.positionId);
    if (!posById(pid)) return;
    var cr = acct.closeReqs[pid];
    if (cr) { cr.requestedAt = at.ts; cr.block = at.n; if (isFinite(px18ToNum(a.px0))) cr.px0 = px18ToNum(a.px0); }
    else acct.closeReqs[pid] = { requestedAt: at.ts, px0: px18ToNum(a.px0), block: at.n, localAt: Date.now(), bps: ui.closing[pid] > 0 && ui.closing[pid] !== true ? ui.closing[pid] : 10000 };
    watchPending();
  }

  /* A close of this account ended: closed or liquidated (the result takes the position's place in the same render),
     or a close request cancelled (the position stays open). */
  function onCloseEnded(ev, logs, mine) {
    var a = ev.args, pid = String(a.positionId);
    var pos = mine[pid] || posById(pid) || (ui.checking[pid] && ui.checking[pid] !== true ? ui.checking[pid] : null);
    delete acct.closeReqs[pid];
    if (ev.name !== 'CloseRequestCancelled' && pos) {
      acct.positions = acct.positions.filter(function (p) { return String(p.id) !== pid; });
      acct.marginInUse = Math.max(0, acct.marginInUse - pos.margin);
      if (ev.name === 'PositionClosed') acct.available += usd6ToNum(a.payoutUsdc);
    }
    reportCloseOutcome(pid, logs, ev.tx, pos);
    afterTx();
  }

  /* The logs to read at a head: every block since the last read while something is in flight (a busy read can
     skip heads; HyperEVM blocks are final, so a range by number is safe), at most 900 blocks back. */
  function logsRange(n) {
    if (heads.logsFrom == null || heads.logsFrom > n) heads.logsFrom = n;
    var from = Math.max(heads.logsFrom, n - 900);
    return { from: from, to: n };
  }


  function refreshMarketChain() {
    if (DEMO) return Promise.resolve();
    var m = state.market;
    var ex = read.exchange;
    if (!m || !ex || m.instrumentId == null) return Promise.resolve();
    var id = m.instrumentId;
    var none = function () { return null; };
    var asked = Date.now();
    return Promise.all([ex.openInterest(id), ex.instrument(id), readOraclePx(id), ex.maxPositionUsd(id, true).catch(none), ex.maxPositionUsd(id, false).catch(none)]).then(function (r) {
      house.oi[m.symbol] = { long: usd6ToNum(r[0][0]), short: usd6ToNum(r[0][1]) };
      var inst = normInst(r[1], id);
      inst.market = m;
      m.inst = inst;
      state.byInstId[id] = inst;
      if (r[2] != null) setOraclePx(id, r[2], 'read', asked);
      /* maxPositionUsd(id, isLong): the biggest open the exchange takes right now, every limit in one number */
      if (r[3] != null && r[4] != null) house.maxPos[id] = { long: usd6ToNum(r[3]), short: usd6ToNum(r[4]) };
      loadHouseBotOi();
      renderMarketHeader(); renderLeverage(); renderForm(); renderAction(); renderStatus(); renderAccount(); renderPositions();
    }).catch(function () { /* keep the last values */ });
  }

  /* (amt2) THE TERMS OF THE COIN ON SCREEN, FRESH. Every market's terms (entry spread, exit deadband, borrow, win cap,
     top leverage) are read at load and then every INSTRUMENTS_EVERY_MS (5 minutes, and not while the tab is hidden);
     only the Pro ticket's own market is read by the 10 s chain poll above. Simple prices whatever coin it shows, so
     after a spread was changed on the exchange, a page already open kept pricing that coin on the old one for up to
     5 minutes: at 1000x a 1 bp change is a tenth of the amount put in that the sheet did not show. So the coin a
     sheet is pricing has its terms read again at most every TERMS_EVERY_MS (one eth_call), and a changed answer is
     drawn at once. termsChanged: the same read the moment the block feed pushes the exchange's own change event. */
  var TERMS_EVERY_MS = 10000, termsAt = {};
  function termsFresh(m) {
    var ex = read.exchange, id = m ? m.instrumentId : null, now = Date.now();
    if (DEMO || !ex || id == null || document.hidden || termsAt[id] > now - TERMS_EVERY_MS) return;
    termsAt[id] = now;
    ex.instrument(id).then(function (r) {
      var was = state.byInstId[id], inst = normInst(r, id);
      if (!was || was.market !== m || m.instrumentId !== id) return;   /* the whole list was read meanwhile: that answer stands */
      inst.market = m; m.inst = inst; state.byInstId[id] = inst;
      if (was.entryDeadbandBps !== inst.entryDeadbandBps || was.deadbandBps !== inst.deadbandBps || was.borrowRateX10 !== inst.borrowRateX10 ||
        was.payoutCapX !== inst.payoutCapX || was.maxLeverage !== inst.maxLeverage || was.opensPaused !== inst.opensPaused) { renderLeverage(); renderForm(); renderAction(); }
    }).catch(function () { termsAt[id] = now - TERMS_EVERY_MS + 3000; });   /* a failed read tries again about 3 s later */
  }
  var TERMS_EVENTS = ['MarketFeesSet', 'InstrumentParamsSet', 'PositionCapsSet', 'MaxLeverageSet'], HOUSE_EVENTS = ['FeeBpsSet', 'BorrowFreeHoursSet'], termsTopics = null;
  function termsChanged(l) {
    if (!exIface || !l || !l.topics || !l.topics.length) return false;
    if (!termsTopics) {
      termsTopics = {};
      TERMS_EVENTS.forEach(function (n) { try { termsTopics[exIface.getEvent(n).topicHash] = 'market'; } catch (e) { /* not in this ABI */ } });
      HOUSE_EVENTS.forEach(function (n) { try { termsTopics[exIface.getEvent(n).topicHash] = 'house'; } catch (e) { /* not in this ABI */ } });
    }
    var kind = termsTopics[l.topics[0]];
    if (kind === 'house') refreshHouse();
    else if (kind === 'market' && l.topics[1]) {
      var inst = state.byInstId[Number(BigInt(l.topics[1]))];
      if (inst && inst.market) { termsAt[inst.id] = 0; termsFresh(inst.market); }
    }
    return !!kind;
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
        if (k === 'v4') smEmit('account');   /* Simple's note on Home follows */
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
    if (isDesk()) ['v2Banner', 'v3Banner', 'v4Banner'].forEach(function (id) {
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
         pay now) and its pending close request, if any; v5: with margin added, its liquidation
         price from bustPrice too */
      return Promise.all(ids.map(function (id) {
        /* v5: with the position's size-fee stamp (tradeFeeOf), row[3] */
        return Promise.all([ex.positions(id), ex.previewClose(id).catch(none), ex.closeRequest(id).catch(none), isV5() ? ex.tradeFeeOf(id).catch(none) : null]).then(function (row) {
          if (!isV5() || !row[0] || row[0].owner === ZERO || !(addedOf(row[0]) > 0n)) return row;
          return ex.bustPrice(id).then(function (b) { return row.concat([b]); }, function () { return row; });
        });
      })).then(function (rows) {
        if (wallet.account !== a) return;
        /* v5: is this account a house wallet (no size fee)? Asked once per account; a new request works its stake
           from it. Until it answers the account counts as a trader, so a request never takes more than was typed. */
        if (isV5() && house.isHouseFor !== a) {
          house.isHouseFor = a; house.isHouse = false;
          ex.isHouseWallet(a).then(function (h) { if (wallet.account === a && house.isHouse !== !!h) { house.isHouse = !!h; renderForm(); renderAction(); smEmit('account'); } }, function () { house.isHouseFor = null; });
        }
        var positions = [];
        var closeReqs = {};
        rows.forEach(function (row, i) {
          var p = row[0], pv = row[1], cr = row[2], added6 = p ? addedOf(p) : 0n;
          if (!p || p.owner === ZERO) return;
          /* v5: the stamp as the chain holds it; a read that failed keeps the last one, else what a trade opened
             now would carry */
          var was = isV5() ? posById(ids[i]) : null;
          var feeX10 = !isV5() ? 0 : row[3] != null ? Number(row[3]) : was && was.feeX10 != null ? was.feeX10 : feeShareFor(Number(p.instrumentId), Number(p.leverage));
          positions.push({
            feeX10: feeX10, openFee: feeOnStake(usd6ToNum(p.marginUsdc), feeX10),
            id: ids[i], instrumentId: Number(p.instrumentId), isLong: !!p.isLong,
            margin: usd6ToNum(p.marginUsdc), leverage: Number(p.leverage),
            /* v5: the margin and the margin added after the open, exactly; the chain's liquidation price when margin was added */
            margin6: BigInt(p.marginUsdc), added6: added6, added: usd6ToNum(added6), bust18: row[4] != null ? BigInt(row[4]) : null,
            entry: px18ToNum(p.entryPx18), entryPx18: BigInt(p.entryPx18), openedAt: Number(p.openedAt),
            /* settlement terms stamped at open; the close settles on these */
            deadbandBps: Number(p.deadbandBps), payoutCapX: Number(p.payoutCapX), maxProfit: usd6ToNum(p.maxProfitUsdc),
            winFeeBps: Number(p.winFeeBps), lossFeeBps: Number(p.lossFeeBps), entryDeadbandBps: Number(p.entryDeadbandBps),
            borrowRateX10: Number(p.borrowRateX10), borrowFreeHours: Number(p.borrowFreeHours),
            preview: pv ? { pnl: usd6ToNum(pv.pnlUsdc), fee: usd6ToNum(pv.feeUsdc), payout: usd6ToNum(pv.payoutUsdc) } : null,
            /* the same position in the contract's own units: the cards settle it with settle.js, exactly */
            raw: window.ConfettiSettle ? window.ConfettiSettle.position(p, feeX10) : null
          });
          var known = acct.closeReqs[String(ids[i])];
          if (cr && Number(cr.requestedAt) > 0) {
            /* what the page is doing about it carries over: the wallet prompt asked once, the late text shown */
            closeReqs[String(ids[i])] = {
              requestedAt: Number(cr.requestedAt), px0: px18ToNum(cr.px0), block: known ? known.block : null, busy: !!(known && known.busy),
              prompted: !!(known && known.prompted), lateSeen: known ? known.lateSeen || 0 : 0, lateToast: !!(known && known.lateToast),
              localAt: known ? known.localAt : 0,
              /* v5: the share it closes (10000: all of it) */
              bps: cr.length > 2 ? Number(cr[2]) : 10000
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
        var asked = Date.now();
        return Promise.all(instIds.map(readOraclePx)).then(function (opx) {
          if (wallet.account !== a) return;
          instIds.forEach(function (id, i) { if (opx[i] != null) setOraclePx(id, opx[i], 'read', asked); });
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
          /* v5: a share close this page was following whose request is gone while the position
             stays (filled between two reads, before the poll saw the request go): its result card
             still comes, from the logs */
          if (before) {
            Object.keys(acct.closeReqs).forEach(function (pid) {
              var old = acct.closeReqs[pid];
              if (!have[pid] || closeReqs[pid] || !(old.bps < 10000) || old.busy || ui.checking[pid]) return;
              ui.checking[pid] = positions.filter(function (p) { return String(p.id) === pid; })[0] || true;
              resolveCloseOutcome(pid, old, 0);
            });
          }
          acct.available = usd6ToNum(r[0]);
          acct.marginInUse = usd6ToNum(r[1]);
          acct.pending = usd6ToNum(r[3]);
          /* an order still going in is not on chain yet: this read's balance would offer its money a second time */
          acct.available -= quickHeld(); acct.pending += quickHeld();
          acct.positions = positions;
          acct.closeReqs = closeReqs;
          acct.loaded = true;
          acct.owner = a;
          Object.keys(ui.settling).forEach(function (k) { if (!have[k]) delete ui.settling[k]; });
          /* the block of the read before this one: a trade gone since then ended after it (lookupVanished) */
          var readBefore = acct.readBlock || 0;
          if (house.block) acct.readBlock = house.block;
          if (before) noticeVanished(before, positions, a, readBefore);
          /* the last block seen moves on only once "while you were away" has read up to now */
          if (house.block && ui.awayDone[a] === 'done') lsSet(LS.seen + a.toLowerCase(), String(house.block));
          renderAccount(); renderPositions(); renderAction(); renderStatus();
          refreshOwed();
          try { trigAccount(); } catch (e) { /* the levels' read never blocks the account */ }
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
  function noticeVanished(before, now, account, since) {
    var have = {};
    now.forEach(function (p) { have[String(p.id)] = true; });
    before.forEach(function (p) {
      var pid = String(p.id);
      if (have[pid] || ui.checking[pid] || ui.reported[pid]) return;
      ui.reported[pid] = 'looking';
      lookupVanished(p, account, 0, since);
    });
  }

  /* The log node can lag the read node: a few tries, then a plain card ("no longer open"). */
  function lookupVanished(p, account, attempt, since) {
    var prov = read.logProvider;
    if (!prov || !exIface) return;
    attempt = attempt || 0;
    var pid = String(p.id);
    var t = function (n) { return exIface.getEvent(n).topicHash; };
    var from = Math.max(Number(cfg.deployBlock) || 0, (house.block || 0) - 5000);
    /* v6: a take profit or stop loss can close a trade while this tab sleeps (a phone left for hours). since: the block
       of the last account read that still had the trade. When that is further back than the 5,000 blocks above, the
       first looks also walk from there, in the log node's chunks, at most AWAY_MAX_BLOCKS back (trigLogsFar) */
    var far = isV6() && attempt < 2 && since > 0 && since - 50 < from ? Math.max(Number(cfg.deployBlock) || 0, since - 50, (house.block || 0) - AWAY_MAX_BLOCKS) : null;
    var exTopics = [[t('PositionLiquidated'), t('PositionClosed')].concat(isV5() ? [t('TradeFeeCharged'), t('MarginReturned')] : []), topicId(pid)];
    function giveUp() {
      if (ui.reported[pid] !== 'looking') return;
      ui.reported[pid] = true;
      addRecent({ key: 'c' + pid, pid: pid, title: posLabel(p) + ' is no longer open', lines: ['History shows how it ended.'], ttl: 60000 });
    }
    Promise.all([prov.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: 'latest', topics: exTopics }), trigFireLogs(prov, from, pid), far != null ? trigLogsFar(prov, far, from - 1, pid, exTopics) : null]).then(function (both) {
      var logs = both[2] ? both[2].ex.concat(both[0]) : both[0];
      if (wallet.account !== account) return;
      trigNoteLogs(both[2] ? both[2].book.concat(both[1]) : both[1]);
      /* v5: the fee of the close comes with it; alone (the open's) it is no outcome */
      var hits = parsedLogs(logs).filter(function (h) { return h.name !== 'TradeFeeCharged' && h.name !== 'MarginReturned' && String(h.args.positionId) === pid; });
      if (!hits.length) throw new Error('not yet');
      if (ui.reported[pid] === 'looking') delete ui.reported[pid];
      reportCloseOutcome(pid, logs, hits[hits.length - 1].tx, p);
    }).catch(function () {
      if (wallet.account !== account) return;
      if (attempt + 1 < 4) setTimeout(function () { lookupVanished(p, account, attempt + 1, since); }, 2000);
      else giveUp();
    });
  }

  /* While you were away: liquidations and owed wins paid since the last block this browser saw for
     the account (LS.seen), once per account per visit, one card. The log node refuses ranges over
     100,000 blocks, so the walk goes in cfg.logChunkBlocks chunks (halved when a chunk is refused),
     at most AWAY_MAX_BLOCKS back. LS.seen moves on (refreshAccount) only after the walk is done. */
  var AWAY_MAX_BLOCKS = 200000;
  function scanAway(account, force) {      /* force: a test runs it in the demo, on a provider of its own */
    if ((DEMO && !force) || !account || ui.awayDone[account] || !read.logProvider || !exIface || !hasExchange()) return;
    var last = Number(lsGet(LS.seen + account.toLowerCase()));
    if (!(last > 0)) { ui.awayDone[account] = 'done'; return; }
    ui.awayDone[account] = 'running';
    var E = window.ethers;
    var prov = read.logProvider;
    var t = function (n) { return exIface.getEvent(n).topicHash; };
    /* v6: the trades that were open when this browser last looked (trigSnapLoad) and ended since are reported one by
       one (trigAwayReport): their closes and size fees are read too, and the book's fires. The book is read at its
       pinned address (config.json cannot change a pin); nothing is sent to it from here. */
    var snap = isV6() ? trigSnapLoad(account) : null;
    if (isV6()) trig.awaySnap = snap ? { account: account, snap: snap, told: {} } : null;
    var bookAt = snap && bookIface && isAddr(cfg.contracts.triggerBook) && !house.unpinned.triggerBook ? cfg.contracts.triggerBook : null, foundBook = [];
    var topics = [[t('PositionLiquidated'), t('QueuePaid')].concat(isV5() ? [t('MarginReturned')] : [], snap ? [t('PositionClosed'), t('TradeFeeCharged')] : []), null, E.zeroPadValue(account, 32)];
    var found = [];
    var chunk = Math.max(1000, Number(cfg.logChunkBlocks) || 20000);
    function walk(from, latest) {
      if (from > latest || wallet.account !== account) return Promise.resolve();
      var to = Math.min(latest, from + chunk - 1);
      return Promise.all([prov.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: to, topics: topics }),
        bookAt ? prov.getLogs({ address: bookAt, fromBlock: from, toBlock: to, topics: [bookIface.getEvent('TriggerFired').topicHash, null, E.zeroPadValue(account, 32)] }) : []]).then(function (both) {
        found = found.concat(both[0] || []); foundBook = foundBook.concat(both[1] || []);
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
      if (!scanned) { trigAwayGone(); return; }
      /* v6: the snapshot's trades that ended are told one by one; the card below keeps the rest */
      var told = snap ? trigAwayReport(account, found, foundBook, snap, bookAt) : {};
      trigAwayGone();
      var lines = [], lost = false, all = parsedLogs(found);
      all.forEach(function (h) {
        if (h.name === 'PositionLiquidated') {
          var pid = String(h.args.positionId);
          if (told[pid]) return;
          ui.reported[pid] = true;
          lost = true;
          var mi = hist.openedMarket[pid];
          var inst = mi != null ? state.byInstId[mi] : null;
          var side = hist.openedSide[pid];
          var sym = inst && inst.market ? inst.market.symbol : null;
          var what = sym ? 'Your ' + sym + (side ? ' ' + String(side).toLowerCase() : '') : 'A position';
          lines.push(what + ' was liquidated at ' + fmtPrice(px18ToNum(h.args.exitPx18), sym ? inst.market.szDecimals : null) + '. ' + lostWords(usd6ToNum(h.args.marginUsdc) + ((hist.fees[pid] || {}).open || 0), returnedIn(all.filter(function (x) { return x.tx === h.tx; }), pid)));
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

  /* (CF_PNL) What the position is worth right now, exactly as the exchange would settle it: settle.js on the
     position's own stamped terms and the market's live curve, at the latest settlement print, the borrow at the latest
     block's time; at or past the liquidation price, the whole margin, as liquidate() takes it. While the contract
     disagreed with that at the last block (heads.audit), the contract's own previewClose figures instead. Without a
     fresh price, no number (an old one is how a lost position read +$554). The float estimate (estimateClose) is left
     for a position read before settle.js loaded. { pnl, fee, payout, borrow, flat, liquidated, exact, px } in USD. */
  function positionEstimate(pos) {
    var inst = state.byInstId[pos.instrumentId];
    var queueEmpty = house.queueLen == null ? true : house.queueHead === house.queueLen;
    var S = window.ConfettiSettle;
    var retired = !!(inst && inst.retired);
    if (!retired && !settlePrice(positionMarket(pos)).fresh) return { pnl: NaN, fee: NaN, payout: NaN, flat: false, delayed: true };
    /* a live fast market: at its estimated print (fastPx18), on the scale its close settles on */
    var fpx = retired ? null : fastPx18(pos.instrumentId);
    var px18 = retired ? inst.lastPx18 : fpx != null ? fpx : house.oraclePx18ById[pos.instrumentId];
    if (S && pos.raw && inst && inst.raw && px18 != null && px18 > 0n) {
      /* pnl is the result against everything that went in: on v5 the exchange's own figure (gross) less the close
         fee the payout carries and the open fee already paid. The payout is what closing now puts back. */
      var c = pos.chainPv;
      if (c) {
        /* the contract's own figures: its payout is already after the close fee, which is the stamped one unless
           less than that was left */
        var cg = S.usd(c.pnl), ctf = Math.min(feeOnStake(pos.margin, posFeeX10(pos)), Math.max(0, posColl(pos) + cg));
        return { pnl: cg - ctf - posOpenFee(pos), gross: cg, tradeFee: ctf, fee: S.usd(c.fee), payout: S.usd(c.payout), borrow: 0, flat: c.pnl === 0n, liquidated: false, exact: true, chain: true, px: S.px(c.px18) };
      }
      var now = house.chainTs != null ? house.chainTs : Math.floor(Date.now() / 1000);
      var v = S.value(pos.raw, inst.raw, px18, BigInt(Math.floor(now)), queueEmpty);
      var vtf = S.usd(v.tradeFee || 0n);
      return { pnl: S.usd(v.pnl) - vtf - posOpenFee(pos), gross: S.usd(v.pnl), tradeFee: vtf, fee: S.usd(v.fee), payout: S.usd(v.payout), borrow: S.usd(v.borrow), flat: v.flat, liquidated: v.liquidated, exact: true, px: S.px(px18) };
    }
    var e = estimateClose(pos, inst, retired ? inst.frozenPx : fpx != null ? px18ToNum(fpx) : settlePrice(positionMarket(pos)).px, queueEmpty);
    e.gross = e.pnl; e.pnl = e.net;
    return e;
  }

  function openPnl() {
    var sum = 0, any = false;
    acct.positions.forEach(function (p) {
      var e = positionEstimate(p);
      if (e && e.delayed) return;
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
    var nOpen = acct.positions.length + openingCount(), dko = $('dkOpenN');
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
    var n = wallet.account && acct.loaded ? acct.positions.length + openingCount() : 0;
    chip.hidden = !n || ui.posInView;
    if (!n) return;
    var pnl = openPnl();
    chip.textContent = 'Your positions (' + n + ')' + (acct.positions.length && isFinite(pnl) ? ' · P&L ' + fmtUsd(pnl, true) : '');
  }

  function sideLev(isLong, lev) { return (isLong ? 'Long' : 'Short') + ' ' + lev + 'x'; }

  /* "DOGE Long 20x" */
  function posLabel(p) {
    var m = positionMarket(p);
    return (m ? m.symbol : 'Market ' + p.instrumentId) + ' ' + sideLev(p.isLong, levShown(p));
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
    var share = out.away / (bustMovePct(posLev(p)) / 100);
    out.cls = share < 0.2 ? 'is-red' : share < 0.5 ? 'is-amber' : '';
    return out;
  }

  /* (CF_PNL) A P&L that just moved with the settlement price shows which way for 700 ms: a soft green or red wash
     behind the number (no layout change; none under reduced motion). The figure itself is already the new one. */
  var TICK_MS = 700;
  function tickPnl(node, p, est) {
    if (!node || !est || !isFinite(est.pnl)) return;
    var before = node._pnl;
    node._pnl = est.pnl;
    if (before == null || !isFinite(before) || before === est.pnl || reducedMotion()) return;
    node.removeAttribute('data-tick');
    void node.offsetWidth;   /* restart the wash on a second move inside 700 ms */
    node.setAttribute('data-tick', est.pnl > before ? 'up' : 'down');
    clearTimeout(node._tick);
    node._tick = setTimeout(function () { node.removeAttribute('data-tick'); }, TICK_MS);
  }

  /* The live parts of a position card: P&L in $ and %, the price now (the oracle, what a close
     settles on), the liquidation line and what a close gives back. */
  function fillPositionPnl(card, p) {
    var m = positionMarket(p);
    var sz = m ? m.szDecimals : null;
    var est = positionEstimate(p);
    var live = liveEstimate(p, est);   /* (est1) null: show the exact figure */
    var px = est.px > 0 ? est.px : closePriceFor(p);
    var delayed = !!est.delayed;
    var known = !delayed && isFinite(px);
    /* desktop (>= 901): the table row splits the P&L into $ and % and the liquidation into price,
       bar and distance, each in its own cell; the card keeps the one string */
    var dk = card.classList.contains('dk-row');
    var shown = live && known ? live : est;
    var sign = shown.pnl > 0 ? ' pos' : shown.pnl < 0 ? ' neg' : '';
    var pnl = card.querySelector('[data-role="pnl"]');
    if (pnl) {
      /* v5 fast market: fills, closes and liquidations settle on a Pyth print the page does not hold, so every
         figure here (at Hyperliquid's price) is an estimate and says so */
      var fpc = fastOf(p.instrumentId);
      var lead = shown === live || fpc ? '≈ ' : '';
      var t = delayed ? 'price delayed' : !known ? '—' : dk ? lead + fmtUsd(shown.pnl, true) : lead + fmtUsd(shown.pnl, true) + ' (' + fmtPct1(shown.pnl / p.margin) + ')';
      if (pnl.textContent !== t) { tickPnl(pnl, p, shown); pnl.textContent = t; }
      pnl.className = (dk ? 'dk-cell dk-num dk-pnl' : 'pc-pnl') + (delayed ? ' is-delayed' : sign);
      pnl.title = delayed ? 'Waiting for a fresh price; the numbers come back as soon as one arrives.' : !known ? ''
        : est.liquidated ? (fpc ? 'The price has reached the liquidation price: this position can be liquidated at the next price, and then the ' + fmtUsd(p.margin) + ' put in is lost.'
          : 'The settlement price has reached the liquidation price: the ' + fmtUsd(p.margin) + ' put in is lost and nothing comes back.')
        : fpc ? 'An estimate at the price now, ' + fmtPrice(shown === live ? live.px : px, sz) + '. A close fills at ' + fastWhen(fpc) + ', so the result can differ a little. If you close now: about ' + fmtUsd(est.payout) + ' back' + (est.borrow > 0 ? ', borrow ' + fmtUsd(est.borrow) : '') + '.'
        : (shown === live ? 'Live estimate at the market price now (' + fmtPrice(live.px, sz) + '): the settlement price moves only when the oracle prints, and this is where it is heading. At the last print it is exactly ' + fmtUsd(est.pnl, true) + '. ' : '')
        + 'Exactly what the exchange settles this position to at the settlement price ' + fmtPrice(px, sz) + (p.checkedAt ? ', checked against the contract at block ' + p.checkedAt : '') + '. If you close now: ' + fmtUsd(est.payout) + ' back' + (est.pnl > 0 && est.fee ? ', after a ' + fmtUsd(est.fee) + ' fee' : '') + (est.borrow > 0 ? ', borrow ' + fmtUsd(est.borrow) : '') + '.';
    }
    if (dk) {
      var pct = setRole(card, 'pct', known ? fmtPct1(shown.pnl / p.margin) : '');
      if (pct) pct.className = 'dk-cell dk-num dk-pct' + sign;
    }
    var nowEl = setRole(card, 'now', delayed ? 'delayed' : isFinite(px) ? fmtPrice(px, sz) : '—');
    if (nowEl) nowEl.title = fastOf(p.instrumentId) ? 'The market price now, as a close would take it: the last price this market filled at, moved with Hyperliquid\'s price since, in USDT like the chart. In this market every fill, close and liquidation settles on the signed market price of its own second (Pyth), which can differ from this by a little.'
      : 'The settlement price: the Hyperliquid oracle print every fill, close and liquidation settles on. It moves when the oracle prints, about every 3 s.';
    var room = liqRoom(p, px);
    var away = isFinite(room.away) ? (room.away * 100).toFixed(room.away >= 0.01 ? 1 : 2) + '%' : '';
    if (dk) {
      setRole(card, 'liq', fmtPrice(room.liq, sz));
      setRole(card, 'away', away);
      var lc = card.querySelector('.dk-liq');
      if (lc) {
        lc.className = 'dk-cell dk-liq' + (room.cls ? ' ' + room.cls : '');
        var fill = lc.querySelector('.dk-bar i');
        var full = bustMovePct(posLev(p)) / 100;
        if (fill) fill.style.width = (away && full > 0 ? clamp(room.away / full, 0, 1) * 100 : 0).toFixed(1) + '%';
      }
    } else {
      var liqEl = setRole(card, 'liq', fmtPrice(room.liq, sz) + (away ? ' (' + away + ' away)' : ''));
      if (liqEl) liqEl.className = 'pc-v' + (room.cls ? ' ' + room.cls : '');
    }
    card.classList.toggle('is-near', room.cls === 'is-red' || !!est.liquidated);
    var estText = est.liquidated ? 'liquidation price reached: nothing comes back' : 'you get back about ' + fmtUsd(est.payout);
    var estEl = setRole(card, 'est', dk ? (known ? 'Close · about ' + fmtUsd(est.payout) : 'Close') : known ? estText : '');
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
  /* v5, a fast market (fastOf): T = request + delay. From T to T + fastWindow (5 s by default) the fill is the
     Pyth form, always at the one print for T: the fill keepers alone for the first `grace` seconds, then anyone who
     holds the signed print (V5P_SPEC 12.1). The page does not hold it (Pyth gives it out with a key only), so it
     never sends that form; and the one-argument executeOpen / executeClose revert KeeperWindow for everyone until
     the window is over. So 'wait' lasts until delay + fastWindow + CANCEL_PAD_S (7 s + 1 by default); past the
     expected fill (FAST_SLOW_S after it) the card says a fresh price is awaited ('slow': no button, no wallet
     prompt). In 'fallback' a close is Finish now: it fills at the HyperCore oracle price of the block it lands in,
     with no worse-of (12.3); an open has no fill left: executeOpen refunds it (FastPriceMissed), which the page
     offers as "Get $X back" (the stake and the open fee reserved with it). 'expired' is unchanged. */
  var FILL_END_S = 2, CANCEL_PAD_S = 1, FAST_SLOW_S = 3;
  /* v5 after the second review (V5P_SPEC 16.2), a fast market's close past its window W = request + delay +
     fastWindow: in the blocks stamped W + 1 .. W + FALLBACK_SECS anyone may send executeClose, at the oracle price
     of its block; from then until expiry only the position's owner may (the wallet itself: a session key is
     another account and is refused with FastWindowOver), at the worse for the trader of that oracle price and the
     price when the close was asked. FALLBACK_SECS is a constant of the contract, not a setting. The page's one-tap
     key sends only while its transaction can still land in those blocks (SESS_LAND_S for the block it lands in);
     past that the close is the wallet's ('own'). */
  var FALLBACK_SECS = 3, SESS_LAND_S = 1;
  function closeOwnFrom(instId) { var f = fastOf(instId); return f ? f.delay + house.fastWindow + FALLBACK_SECS : Infinity; }
  /* a close request only the owner's wallet can still finish: the chain said so (FastWindowOver to the key), or its
     three public seconds are as good as over */
  function closeOwnOnly(pid) {
    var cr = acct.closeReqs[String(pid)], p = posById(pid);
    if (!cr || !p || cr.requestedAt == null) return false;
    return !!cr.own || chainNow() - cr.requestedAt > closeOwnFrom(p.instrumentId) - SESS_LAND_S;
  }
  /* the price the exchange uses for a close that is the owner's alone: the worse for the trader of the price when
     the close was asked (closeRequest.px0) and the oracle price now; null while either is unknown */
  function ownClosePx(p) {
    /* the HyperCore price (settlePrice), not a fast market's estimated print: past its window a close is on that rule */
    var cr = p ? acct.closeReqs[String(p.id)] : null, now = p ? settlePrice(positionMarket(p)).px : NaN;
    if (!cr || !(cr.px0 > 0) || !(now > 0)) return null;
    return p.isLong ? Math.min(cr.px0, now) : Math.max(cr.px0, now);
  }
  function fillFrom(instId) {
    var f = fastOf(instId);
    var keeper = f ? f.delay + house.fastWindow : house.minDelay + house.grace;
    /* v5, a market whose rule the page has not read yet (the first seconds of a visit, or a read that failed): the
       later of the two keeper windows, so the page never sends a fallback call (or asks the wallet for one) that the
       contract would refuse with KeeperWindow. 10 is the largest fast delay the contract allows, and 60 the longest
       window, taken until fastWindows() has answered once. */
    if (isV5() && !fastKnown(instId)) keeper = Math.max(keeper, 10 + (house.fastAt ? house.fastWindow : 60));
    return Math.min(keeper + CANCEL_PAD_S, house.expiry - 1);
  }
  function fillEnd(instId) { return Math.min(house.expiry, Math.max(fillFrom(instId) + 1, house.expiry - FILL_END_S)); }
  /* soon: the last LATE_SHOW_MS of the keeper window (never before the expected fill). The card
     already says "Taking longer than usual" then, so when the window opens the wallet prompt
     (autoFill) goes out at once and still has a reason on screen. */
  function requestPhase(requestedAt, instId) {
    var e = chainNow() - requestedAt, from = fillFrom(instId), end = fillEnd(instId), to = house.expiry + CANCEL_PAD_S;
    var fast = !!fastOf(instId), secs = fillSecs(instId);
    if (e < from) return { phase: 'wait', left: from - e, fast: fast, soon: e >= Math.max(from - LATE_SHOW_MS / 1000, secs), slow: fast && e >= secs + FAST_SLOW_S };
    if (e <= end) return { phase: 'fallback', left: end - e, fast: fast, own: fast && e > closeOwnFrom(instId) - SESS_LAND_S };
    if (e <= to) return { phase: 'wait', left: to - e, expiring: true, fast: fast };
    return { phase: 'expired', left: 0, fast: fast };
  }

  /* What a progress card says for a request (open or close) by its phase. money: the amount the
     card speaks of. req.busy: a fill or cancel transaction for it is out. */
  function progressView(kind, req, money, instId) {
    var close = kind === 'close';
    /* v5: a share close names its share ("Closing 50%…", "Closed 50%") */
    var part = close && req.bps > 0 && req.bps < 10000 ? ' ' + fmtBps(req.bps) : '';
    var verb = close ? 'Closing' + part : 'Opening';
    var end = close ? 'Closed' + part : 'Open';
    var sent = ['Sent', 'is-done'];
    if (req.requestedAt == null) return { steps: [sent, [verb + '…', 'is-on'], [end, '']] };
    if (instId == null && !close && req.instrumentId != null) instId = req.instrumentId;
    var ph = requestPhase(req.requestedAt, instId);
    if (ph.phase === 'wait' && !ph.expiring && !ph.soon && !ph.slow) {
      var left = fillEta(req.requestedAt, instId) - chainNow();
      return { steps: [sent, [verb + ' · ' + (left > 0.05 ? left.toFixed(1) + ' s' : 'any moment'), 'is-on'], [end, '']], note: close ? (part ? 'You can close the rest when it fills.' : '') : 'Your price is set when it fills.' };
    }
    /* v5 fast market, the keeper's window past the expected fill: it is waiting for a price that passes the checks.
       Nothing for the trader to do, so no button and no prompt; a close about to reach its fallback takes the
       late card below (its wallet prompt is about to go out). */
    if (ph.fast && ph.phase === 'wait' && !ph.expiring && !(close && ph.soon)) {
      var wl = Math.max(1, Math.ceil(ph.left));
      return {
        cls: 'is-late', steps: [sent, ['Still ' + verb.toLowerCase() + '.', 'is-on is-warn'], [end, '']],
        note: 'Waiting for a fresh price. ' + (close ? 'If none comes in ' + wl + ' s, you can finish it at the Hyperliquid oracle price.'
          : 'If none comes in ' + wl + ' s, your ' + fmtUsdShort(money) + ' comes back.')
      };
    }
    /* v5 fast market, an open past the keeper's window: there is no fill left, only the refund */
    if (ph.fast && !close && ph.phase === 'fallback') {
      return {
        cls: 'is-bad', steps: [sent, ['No fresh price in time. Your ' + fmtUsdShort(money) + ' is safe.', 'is-on is-bad'], [end, 'is-skip']],
        btn: req.busy ? '' : 'Get ' + fmtUsdShort(money) + ' back', btnCls: 'btn-primary', note: req.busy ? 'Getting it back…' : ''
      };
    }
    if (ph.phase === 'fallback' || ph.phase === 'wait') {
      var note;
      /* a fast market's close past its window (16.2): the one-tap key finishes it in the three public seconds, at the
         oracle price; after them, or without a key, it is the wallet's, at the worse of the two prices */
      var own = !!(ph.fast && close && ph.phase === 'fallback' && (ph.own || req.own));
      var viaKey = !!(ph.fast && close && !own && (DEMO ? sess.demoOn : sessionLive()));
      if (req.busy) note = viaKey ? 'Finishing it at the Hyperliquid oracle price…' : 'Asking your wallet to finish it…';
      else if (ph.expiring) note = close ? "Almost out of time. If it doesn't close, it stays open and you can try again." : "Almost out of time. If it doesn't fill, your money comes back.";
      /* a fast market's close past its window fills at the oracle price of its block (V5P_SPEC 12.3); the HyperCore
         rule keeps the worse of the two prices */
      else if (own) note = (autoFillEnabled() && !req.prompted ? 'Your wallet will ask you to close it. ' : '') + 'Only your own wallet can finish it now. It fills at the Hyperliquid oracle price of that moment or the price when you asked to close, whichever is worse for you. Or let it run out and close again.';
      else if (viaKey) note = 'No fresh price came in time. It is finished at the Hyperliquid oracle price of this moment.';
      else if (ph.fast && close) note = (autoFillEnabled() && !req.prompted ? 'Your wallet will ask you to finish it' + (ph.soon ? ' in a moment. ' : '. ') : '') + 'If it lands within ' + FALLBACK_SECS + ' s it fills at the Hyperliquid oracle price of that moment; later, at that price or the price when you asked to close, whichever is worse for you.';
      else note = (autoFillEnabled() && !req.prompted ? 'Your wallet will ask you to finish it' + (ph.soon ? ' in a moment. ' : '. ') : '') + 'You get the less favourable of the price when you tapped and the price now.';
      return {
        cls: 'is-late', late: ph.phase === 'fallback' || !!ph.soon,
        steps: [sent, ['Still ' + verb.toLowerCase() + '.', 'is-on is-warn'], [end, '']],
        note: note, btn: ph.phase === 'fallback' && !req.busy ? (own ? 'Close now' : 'Finish now') : '', btnCls: 'btn-primary', own: own
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
    var ifaces = [exIface, refIface, routerIface, proxyIface, vaultIface, bookIface];
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
  function noteLate(req, what, cards, refund) {
    if (req.lateToast) return;
    req.lateToast = true;
    req.lateSeen = Date.now();
    if ((cards || []).some(inView)) return;
    /* refund: a fast market's open that got no price in time (v5): what is left is the money back */
    if (refund) toast(what + ' got no fresh price in time. ' + (autoFillEnabled() ? 'Your wallet will ask you to get the ' + refund + ' back.' : 'Tap Get ' + refund + ' back.'), 'warn');
    else toast(what + ' is taking longer than usual. ' + (autoFillEnabled() ? 'Your wallet will ask you to finish it.' : 'Tap Finish now to finish it.'), 'warn');
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
    if (DEMO && demoOpt('auto') !== '1') return;   /* the demo sends by itself only when asked to (&auto=1) */
    if (state.busy || !autoFillEnabled() || !wallet.account) return;
    if (!DEMO && !sessionLive() && (!wallet.signer || wallet.chainId !== CHAIN_ID)) return;
    var now = chainNow();
    var shown = function (q) { return !!q.lateSeen; };
    var opens = pendingOpenList();
    for (var i = 0; i < opens.length; i++) {
      var r = opens[i];
      if (r.busy || r.prompted || r.requestedAt == null || !shown(r)) continue;
      var e = now - r.requestedAt;
      if (e >= fillFrom(r.instrumentId) && e <= fillEnd(r.instrumentId)) { r.prompted = true; executeOpenNow(r); return; }
    }
    var pids = Object.keys(acct.closeReqs);
    for (var j = 0; j < pids.length; j++) {
      var cr = acct.closeReqs[pids[j]];
      if (cr.busy || cr.prompted || cr.requestedAt == null || !shown(cr)) continue;
      var e2 = now - cr.requestedAt;
      var p = posById(pids[j]);
      if (!p) continue;
      if (e2 < fillFrom(p.instrumentId) || e2 > fillEnd(p.instrumentId)) continue;
      /* a close that is the wallet's alone (16.2) is not sent by itself while the wallet is elsewhere: its card has the key */
      if (!DEMO && closeOwnOnly(pids[j]) && (!wallet.signer || wallet.chainId !== CHAIN_ID)) continue;
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

  /* ---- (CF_PNL) an order on its way in, drawn as the position it becomes ----
     The owner: "we were going to make it so that visually to the trader it looked instant on the card". From the tap
     the card is the position: side, coin, leverage, what was put in and the size; the entry it will fill at (the
     latest settlement print with the market's entry spread: the keeper fills at the print of the block it lands in,
     Exchange.executeOpen); the liquidation that entry gives; the P&L of that position at the print now (before the fill
     that is the spread, all it can have made or lost); and, where CLOSE POSITION will be, the fill counting down:
     Sending, then Filling · 2.4 s from the request's block to the block the keeper's fill lands in (minDelay + 1 s,
     p50 3 s over 839 keeper trades). When the fill lands the card keeps its place and its figures become the real ones;
     a refund or a revert takes its place at once and says so. Late and expired requests keep their words and buttons
     (progressView). kind: 'quick' (sent, no request on chain yet) or 'open' (a request, pend.opens). */
  function openingFigures(r) {
    var S = window.ConfettiSettle, inst = state.byInstId[r.instrumentId], m = inst && inst.market;
    var out = { px: NaN, entry: NaN, liq: NaN, pnl: NaN, payout: NaN, away: NaN, cls: '', sz: m ? m.szDecimals : null, fresh: false };
    if (!S || !inst || !m) return out;
    /* a fast market fills at its print: the estimated one (fastPx18), as the card will once it has filled */
    var fpx = fastPx18(r.instrumentId);
    var px18 = fpx != null ? fpx : house.oraclePx18ById[r.instrumentId];
    out.fresh = settlePrice(m).fresh && px18 != null;
    if (!out.fresh) return out;
    var margin6 = BigInt(numToUsd6(r.margin));
    var entry18 = S.openEntry(px18, r.isLong, inst.entryDeadbandBps || 0);
    var pos = S.position({
      isLong: r.isLong, marginUsdc: margin6, leverage: r.leverage, maxProfitUsdc: margin6 * BigInt(inst.payoutCapX || 0), entryPx18: entry18,
      openedAt: Math.floor(house.chainTs || 0), deadbandBps: inst.deadbandBps || 0, winFeeBps: liveOr(house.winFeeBps, 'winFeeBps') || 0,
      lossFeeBps: liveOr(house.lossFeeBps, 'lossFeeBps') || 0, entryDeadbandBps: inst.entryDeadbandBps || 0, borrowRateX10: inst.borrowRateX10 || 0,
      borrowFreeHours: freeHours() || 0
    }, reqShare(r));
    var qEmpty = house.queueLen == null ? true : house.queueHead === house.queueLen;
    var v = inst.raw ? S.value(pos, inst.raw, px18, BigInt(Math.floor(house.chainTs || 0)), qEmpty) : null;
    out.px = S.px(px18); out.entry = S.px(entry18);
    out.liq = S.px(S.positionBust(pos));
    /* against what the request holds: the stake and the open fee reserved with it (v5) */
    if (v) { out.pnl = S.usd(v.pnl - (v.tradeFee || 0n)) - reqFee(r); out.payout = S.usd(v.payout); }
    out.away = out.liq > 0 ? Math.max(0, r.isLong ? (out.px - out.liq) / out.px : (out.liq - out.px) / out.px) : NaN;
    return out;
  }

  /* The status where CLOSE POSITION will be: { say, share (0..1 of the countdown), tone, btn, note }. */
  function openingStatus(r, kind) {
    var at = 'fills at the ' + pxWord(r.instrumentId);
    if (kind === 'quick') return { say: r.walletPath ? 'Sent from your wallet…' : 'Sending…', share: 0, tone: '', note: at, sending: true };
    if (r.requestedAt == null) return { say: 'Filling…', share: 0, tone: '', note: at };
    var ph = requestPhase(r.requestedAt, r.instrumentId);
    if (ph.phase === 'wait' && !ph.expiring && !ph.soon && !ph.slow) {
      var left = fillEta(r.requestedAt, r.instrumentId) - chainNow();
      return {
        say: left > 0.05 ? 'Filling · ' + left.toFixed(1) + ' s' : 'Filling · any moment', share: clamp(1 - left / fillSecs(r.instrumentId), 0, 1), tone: '',
        note: at
      };
    }
    var v = progressView('open', r, reqIn(r), r.instrumentId);
    var on = (v.steps || []).filter(function (s) { return /is-on/.test(s[1]); })[0];
    return { say: on ? on[0] : 'Filling…', share: 1, tone: v.cls === 'is-bad' ? 'bad' : v.cls === 'is-late' ? 'warn' : '', btn: v.btn || '', btnCls: v.btnCls, note: v.note || '' };
  }

  function openingCard(r, kind) {
    var card = el('div', 'pos-card is-filling ' + (r.isLong ? 'is-long' : 'is-short') + (posTable() ? ' dk-row' : ''));
    card.setAttribute(kind === 'quick' ? 'data-quick' : 'data-req', kind === 'quick' ? r.key : r.id);
    if (kind === 'open') card.title = 'Request #r' + r.id;
    var act = function () { if (kind === 'open') openReqAction(r); };
    var size = fmtUsd(r.margin * r.leverage);
    if (posTable()) {
      card.appendChild(dkWho(r.isLong, reqSym(r), r.leverage));
      card.appendChild(dkCell('dk-num', size, 'size'));
      card.appendChild(dkCell('dk-num', fmtUsd(reqIn(r)), 'margin'));
      card.appendChild(dkCell('dk-num', '—', 'entry'));
      card.appendChild(dkCell('dk-num', '—', 'now'));
      var liq = dkCell('dk-liq');
      var lp = el('span', 'dk-liq-px', '—'); lp.setAttribute('data-role', 'liq');
      liq.appendChild(lp);
      var bar = el('span', 'dk-bar'); bar.setAttribute('aria-hidden', 'true'); bar.appendChild(el('i'));
      liq.appendChild(bar);
      var aw = el('span', 'dk-away'); aw.setAttribute('data-role', 'away');
      liq.appendChild(aw);
      liq.appendChild(el('span', 'dk-away-w', 'away'));
      card.appendChild(liq);
      card.appendChild(dkCell('dk-num dk-pnl', '—', 'pnl'));
      card.appendChild(dkCell('dk-num dk-pct', '', 'pct'));
      var dka = dkCell('dk-act', null, 'act');
      dka.appendChild(dkStatusEl(act));
      card.appendChild(dka);
      fillOpening(card, r, kind);
      return card;
    }
    var head = el('div', 'pc-head');
    var who = el('div', 'pc-who');
    who.appendChild(el('span', 'pc-side', r.isLong ? 'LONG' : 'SHORT'));
    who.appendChild(el('span', 'pc-sym', reqSym(r)));
    who.appendChild(el('span', 'pc-lev', r.leverage + 'x'));
    head.appendChild(who);
    var pnl = el('span', 'pc-pnl', '—'); pnl.setAttribute('data-role', 'pnl');
    head.appendChild(pnl);
    card.appendChild(head);
    var rows = el('div', 'pc-rows');
    rows.appendChild(pcCell('Entry', '—', 'entry'));
    rows.appendChild(pcCell('Now', '—', 'now'));
    rows.appendChild(pcCell('Liquidation', '—', 'liq', true));
    rows.appendChild(pcCell('Put in', fmtUsd(reqIn(r))));
    rows.appendChild(pcCell('Size', size));
    card.appendChild(rows);
    var box = el('div', 'pc-act'); box.setAttribute('data-role', 'act');
    box.appendChild(makeFillBlock(act));
    var est = el('div', 'pc-est'); est.setAttribute('data-role', 'est');
    box.appendChild(est);
    card.appendChild(box);
    fillOpening(card, r, kind);
    return card;
  }

  function fillOpening(card, r, kind) {
    var f = openingFigures(r), st = openingStatus(r, kind);
    var known = f.fresh && isFinite(f.pnl);
    var dk = card.classList.contains('dk-row');
    var pnl = card.querySelector('[data-role="pnl"]');
    if (pnl) {
      var t = !f.fresh ? 'price delayed' : !known ? '—' : dk ? fmtUsd(f.pnl, true) : fmtUsd(f.pnl, true) + ' (' + fmtPct1(f.pnl / reqIn(r)) + ')';
      if (pnl.textContent !== t) pnl.textContent = t;
      pnl.className = (dk ? 'dk-cell dk-num dk-pnl' : 'pc-pnl') + (!f.fresh ? ' is-delayed' : f.pnl > 0 ? ' pos' : f.pnl < 0 ? ' neg' : '');
      pnl.title = known ? 'Filled at the price now, the position would be worth this: the entry spread is its whole cost so far.' : '';
    }
    if (dk) { var pc = setRole(card, 'pct', known ? fmtPct1(f.pnl / reqIn(r)) : ''); if (pc) pc.className = 'dk-cell dk-num dk-pct' + (f.pnl < 0 ? ' neg' : f.pnl > 0 ? ' pos' : ''); }
    var en = setRole(card, 'entry', isFinite(f.entry) ? '≈ ' + fmtPrice(f.entry, f.sz) : '—');
    if (en) en.title = fastOf(r.instrumentId) ? 'The price now plus the entry spread. The real entry is ' + fastWhen(fastOf(r.instrumentId), 'tapped') + ', plus the spread.'
      : 'The oracle price now plus the entry spread. The real entry is the oracle price of the block the fill lands in.';
    setRole(card, 'now', isFinite(f.px) ? fmtPrice(f.px, f.sz) : '—');
    var away = isFinite(f.away) ? (f.away * 100).toFixed(f.away >= 0.01 ? 1 : 2) + '%' : '';
    if (dk) {
      setRole(card, 'liq', isFinite(f.liq) ? '≈ ' + fmtPrice(f.liq, f.sz) : '—');
      setRole(card, 'away', away);
      var lc = card.querySelector('.dk-liq .dk-bar i'), full = bustMovePct(r.leverage) / 100;
      if (lc) lc.style.width = (away && full > 0 ? clamp(f.away / full, 0, 1) * 100 : 0).toFixed(1) + '%';
      var box = card.querySelector('.dk-status');
      if (box) dkSetStatus(box, { cls: st.tone === 'bad' ? 'is-bad' : st.tone === 'warn' ? 'is-late' : '', steps: [[st.say, 'is-on' + (st.tone === 'bad' ? ' is-bad' : st.tone === 'warn' ? ' is-warn' : '')]], note: st.note, btn: st.btn, btnCls: st.btnCls });
      return;
    }
    setRole(card, 'liq', isFinite(f.liq) ? '≈ ' + fmtPrice(f.liq, f.sz) + (away ? ' (' + away + ' away)' : '') : '—');
    var fill = card.querySelector('[data-role="fill"]');
    if (fill) setFillBlock(fill, st);
    setRole(card, 'est', st.note);
  }

  /* An order from the tap until its request is on chain, and a request until it fills: both drawn as the position
     they become (openingCard). */
  function quickOpenCard(r) { return openingCard(r, 'quick'); }
  function pendingOpenCard(r) { return openingCard(r, 'open'); }
  function updateOpenProg(card, r) { fillOpening(card, r, 'open'); }

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
    row.title = 'Position #' + p.id + ' · size ' + fmtUsd(p.margin * p.leverage) + ' · put in ' + fmtUsd(posColl(p)) + levNote(p);
    if (chart.pick === String(p.id)) row.classList.add('is-picked');
    row.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('button, input, a, label')) return; pickPosition(p.id); });
    row.appendChild(dkWho(p.isLong, m ? m.symbol : 'Market ' + p.instrumentId, levShown(p)));
    row.appendChild(dkCell('dk-num', fmtUsd(p.margin * p.leverage), 'size'));
    row.appendChild(dkCell('dk-num', fmtUsd(posColl(p)), 'margin'));
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
    var n = ready ? acct.positions.length + openingCount() : 0;
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
    var ph = requestPhase(r.requestedAt, r.instrumentId);
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
    card.title = 'Position #' + p.id + levNote(p);
    if (chart.pick === String(p.id)) card.classList.add('is-picked');
    card.addEventListener('click', function (ev) { if (isPhone() || (ev.target.closest && ev.target.closest('button, input, a, label'))) return; pickPosition(p.id); });
    var head = el('div', 'pc-head');
    var who = el('div', 'pc-who');
    who.appendChild(el('span', 'pc-side', p.isLong ? 'LONG' : 'SHORT'));
    who.appendChild(el('span', 'pc-sym', m ? m.symbol : 'Market ' + p.instrumentId));
    who.appendChild(el('span', 'pc-lev', levShown(p) + 'x'));
    head.appendChild(who);
    var pnl = el('span', 'pc-pnl', '—');
    pnl.setAttribute('data-role', 'pnl');
    head.appendChild(pnl);
    card.appendChild(head);
    var rows = el('div', 'pc-rows');
    rows.appendChild(pcCell('Entry', fmtPrice(p.entry, sz)));
    rows.appendChild(pcCell('Now', '—', 'now'));
    rows.appendChild(pcCell('Liquidation', '—', 'liq', true));
    rows.appendChild(pcCell('Put in', fmtUsd(posColl(p))));
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
    /* (CF_PNL) cards: a close in flight keeps CLOSE POSITION's 52 px (the countdown where the button was, what comes
       back under it, live), so the card does not jump at the tap; only a late or expired close, which needs its
       words and buttons, takes the progress card */
    if (!dk && mode === 'req' && cr.requestedAt != null) {
      var cph = requestPhase(cr.requestedAt, p.instrumentId);
      if (!(cph.phase === 'wait' && !cph.expiring && !cph.soon && !cph.slow)) mode = 'late';
    }
    if (!dk && (mode === 'req' || mode === 'wallet' || mode === 'checking' || mode === 'settling')) {
      if (act.getAttribute('data-mode') !== 'run') {
        act.setAttribute('data-mode', 'run');
        act.textContent = '';
        act.appendChild(makeFillBlock(null));
        var ce = el('div', 'pc-est'); ce.setAttribute('data-role', 'est');
        act.appendChild(ce);
      }
      var fb = act.querySelector('.pc-fill');
      if (fb) setFillBlock(fb, closingStatus(mode, cr, p.instrumentId));
      return;
    }
    if (mode === 'late') mode = 'req';
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
        /* v5: a share close says which share (cr.bps once filed; ui.closing holds it while the wallet asks) */
        var share = cr ? cr.bps : ui.closing[pid];
        act.appendChild(makeProg('Closing ' + (share > 0 && share < 10000 ? fmtBps(share) + ' of ' : '') + posLabel(p), function () { closeReqAction(posById(pid) || p); }));
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
    if (mode === 'wallet') put(box, { steps: [[sendWord(), 'is-on'], ['Closing', ''], ['Closed', '']] });
    else if (mode === 'retrying') put(box, { steps: [['Getting ready to close again…', 'is-on'], ['Closing again', ''], ['Closed', '']], note: 'Closing again. ' + (sessionLive() ? '' : 'Your wallet asks twice.') });
    else if (mode === 'checking') put(box, CHECKING_VIEW);
    else if (mode === 'settling') put(box, { cls: 'is-done', steps: [['Sent', 'is-done'], ['Closed', 'is-done'], ['Adding it to your balance…', 'is-on']] });
    else put(box, progressView('close', cr, p.margin, p.instrumentId));
  }

  /* What a send in flight says: the wallet's confirm, the one-time one-tap turn-on, or Sending (one-tap, and the demo
     once its pretend one-tap is on, which asks no wallet) */
  function sendWord() { return state.turningOn ? 'Turn on one-tap in your wallet (once)…' : state.viaSession || (DEMO && sess.demoOn) ? 'Sending…' : 'Confirm in your wallet…'; }

  /* (CF_PNL) The countdown block (an order filling, a close settling): one sentence, the 3 px line that fills over
     the wait, and a button when one is needed. */
  function makeFillBlock(onBtn) {
    var fill = el('div', 'pc-fill'); fill.setAttribute('data-role', 'fill');
    var say = el('span', 'pc-fill-say'); say.setAttribute('data-role', 'say');
    fill.appendChild(say);
    var b1 = el('button', 'btn btn-sm'); b1.type = 'button'; b1.hidden = true; b1.setAttribute('data-role', 'b1');
    if (onBtn) b1.addEventListener('click', onBtn);
    fill.appendChild(b1);
    var track = el('i', 'pc-fill-bar'); track.setAttribute('aria-hidden', 'true'); track.appendChild(el('i'));
    fill.appendChild(track);
    return fill;
  }

  function setFillBlock(fill, st) {
    var cls = 'pc-fill' + (st.tone ? ' is-' + st.tone : '') + (st.btn ? ' has-btn' : '') + (st.sending ? ' is-sending' : '');
    if (fill.className !== cls) fill.className = cls;
    setRole(fill, 'say', st.say);
    var b1 = fill.querySelector('[data-role="b1"]');
    if (b1) { b1.hidden = !st.btn; if (st.btn && b1.textContent !== st.btn) b1.textContent = st.btn; b1.className = 'btn btn-sm' + (st.btnCls ? ' ' + st.btnCls : ''); b1.disabled = state.busy; }
    var bar = fill.querySelector('.pc-fill-bar > i');
    if (bar) bar.style.width = Math.round(clamp(st.share, 0, 1) * 100) + '%';
  }

  /* What a close in flight says, by its mode: sending, the countdown from the request's block to the block the
     keeper's fill lands in, the result being read, done. */
  function closingStatus(mode, cr, instId) {
    if (mode === 'wallet') return { say: sendWord(), share: 0, tone: '', sending: true };
    if (mode === 'checking') return { say: 'Checking the result…', share: 1, tone: '' };
    if (mode === 'settling') return { say: 'Closed · adding it to your balance…', share: 1, tone: 'done' };
    if (!cr || cr.requestedAt == null) return { say: 'Closing…', share: 0, tone: '' };
    var left = fillEta(cr.requestedAt, instId) - chainNow();
    return { say: left > 0.05 ? 'Closing · ' + left.toFixed(1) + ' s' : 'Closing · any moment', share: clamp(1 - left / fillSecs(instId), 0, 1), tone: '' };
  }

  /* A close whose request is gone from chain, while the logs are read for how it ended. */
  var CHECKING_VIEW = { steps: [['Sent', 'is-done'], ['Checking the result…', 'is-on'], ['Closed', '']] };

  /* Finish now (late) or Try again (expired) on a close, by its phase at click time. */
  function closeReqAction(p) {
    var cr = acct.closeReqs[String(p.id)];
    if (!cr || cr.busy) return;
    var ph = requestPhase(cr.requestedAt, p.instrumentId);
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
      var x = el('button', 'btn btn-sm' + (b.cls ? ' ' + b.cls : ''), b.label);
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
      var x = el('button', 'btn btn-sm' + (b.cls ? ' ' + b.cls : ''), b.label);
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

  function openingCount() { return pendingOpenList().length + quick.list.length; }
  function quickHeld() { return quick.list.reduce(function (s, r) { return s + reqIn(r); }, 0); }

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
    quick.list.slice().reverse().forEach(function (r) { items.push({ kind: 'quick', r: r, key: r.key }); });
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
      /* margin and added margin in the key: a share close or added margin redraws the card's fixed figures */
      slots.push({ id: BigInt(p.id), item: { kind: 'pos', p: p, key: 'p' + pid + ':' + String(p.entryPx18) + ':' + p.margin + ':' + (p.added || 0) } });
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
    var n = acct.positions.length + openingCount();
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
      else if (it.kind === 'quick') frag.appendChild(quickOpenCard(it.r));
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
      if (card) fillOpening(card, r, 'open');
    });
    quick.list.forEach(function (r) {
      var card = host.querySelector('.pos-card[data-quick="' + r.key + '"]');
      if (card) fillOpening(card, r, 'quick');
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
      var ph = requestPhase(r.requestedAt, r.instrumentId);
      if (ph.phase === 'fallback' || ph.soon) noteLate(r, 'Your ' + reqSym(r) + ' ' + sideWord(r.isLong).toLowerCase(), openReqEls(r), ph.fast ? fmtUsdShort(reqIn(r)) : '');
    });
    Object.keys(acct.closeReqs).forEach(function (pid) {
      var cr = acct.closeReqs[pid];
      if (cr.requestedAt == null) return;
      var p = posById(pid);
      var ph = requestPhase(cr.requestedAt, p ? p.instrumentId : null);
      if (ph.phase !== 'fallback' && !ph.soon) return;
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
    tk.phase = null; tk.reqId = null; tk.msg = ''; tk.print = null;
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
        title: title, steps: [[sendWord(), 'is-on'], ['Opening', ''], ['Open', '']],
        note: state.turningOn ? 'One confirmation turns on one-tap for ' + ONE_TAP_DAYS + ' days. After it, trades go through with no popup.'
          : state.viaSession ? 'One-click is on: no wallet popup.' : 'Your wallet shows the trade. Nothing is sent until you confirm.'
      };
    }
    if (tk.phase === 'req') {
      var r = pend.opens[tk.reqId];
      if (!r) return { title: title, steps: [['Sent', 'is-done'], ['Checking the result…', 'is-on'], ['Open', '']] };
      var v = progressView('open', r, reqIn(r), r.instrumentId);
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
        note: (tk.print ? printLine(tk.print) + ' ' : '') + where, btn: 'View position', btnFree: true, btn2: 'New trade'
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

  /* (2026-11-05, the owner: "phantom still isnt working for desktop confetti") What a refused connect means, in the
     wallet's own terms, shown as a message and inside First steps' card, with the wallet's own words at the end so the
     next report carries them. Phantom answers -32603 without opening anything when its page script fails (before
     2026-11-05 03:21 UTC: the page's script policy blocked its eval; a tab opened before then still has the old policy
     until it reloads) or when its record for this site is stuck. */
  function connectWalletName(eth) {
    var hit = walletList().filter(function (d) { return d.provider === eth; })[0];
    var n = hit && hit.info && hit.info.name ? String(hit.info.name) : (eth && eth.isPhantom ? 'Phantom' : eth && eth.isMetaMask ? 'MetaMask' : 'Your wallet');
    return n.replace(/[<>&"]/g, '').slice(0, 40) || 'Your wallet';
  }
  function connectErrCode(e) {
    var code = null;
    walkError(e, function (x) { if (x && (x.code === -32603 || x.code === -32002 || x.code === 4100)) { code = x.code; return true; } return false; });
    return code;
  }
  function connectFailText(e, eth) {
    var name = connectWalletName(eth), code = connectErrCode(e);
    var said = String((e && e.message) || '').replace(/[<>&"]/g, '').slice(0, 80);
    var tail = said ? ' (' + name + ' said: ' + said + (code != null ? ', ' + code : '') + ')' : '';
    if (isUserRejection(e)) return 'You closed the request in ' + name + '. Tap Connect wallet to try again.';
    if (code === -32002) return name + ' already has a connect request waiting. Open ' + name + ' and approve it there.';
    if (code === 4100) return name + ' is locked or has not allowed this site yet. Open ' + name + ', unlock it, then tap Connect wallet again.';
    if (code === -32603 && /phantom/i.test(name)) return 'Phantom did not open its connect window. Reload this page and try once more. Still nothing: in Phantom open Settings, Connected apps, remove confetti.trade, unlock Phantom and try again; or switch to another account in Phantom.' + tail;
    if (code === -32603) return name + ' did not open its connect window. Reload this page, make sure ' + name + ' is unlocked, then try again.' + tail;
    return name + ' did not connect: ' + describeError(e);
  }
  /* Phantom's first answer after its background has been asleep can be this same -32603: ask once more before saying anything */
  function requestAccountsOnce(eth) {
    return eth.request({ method: 'eth_requestAccounts', params: [] }).catch(function (e) {
      if (connectErrCode(e) !== -32603) throw e;
      return new Promise(function (r) { setTimeout(r, 1200); }).then(function () { return eth.request({ method: 'eth_requestAccounts', params: [] }); });
    });
  }

  /* (2026-11-06, the owner: "when i go to connect my metamask wallet, it will only connect to account 1 and not my
     acccount 3") eth_requestAccounts answers with the accounts MetaMask already allowed for this site and asks nothing,
     so once account 1 was allowed, Connect never showed MetaMask's account list again. A Connect or Switch wallet tap on
     MetaMask asks for that list (wallet_requestPermissions), then reads what was ticked: the first is the account open
     in MetaMask, and switching accounts in MetaMask moves the page (accountsChanged). Other wallets keep the plain
     request, so Phantom's connect path stays as it is. */
  function isMetaMaskWallet(eth) {
    var hit = walletList().filter(function (d) { return d.provider === eth; })[0];
    var rdns = hit && hit.info && hit.info.rdns ? String(hit.info.rdns) : '';
    if (rdns) return /^io\.metamask/.test(rdns);
    return !!(eth && eth.isMetaMask && !eth.isPhantom && !eth.isRabby && !eth.isBraveWallet && !eth.isCoinbaseWallet &&
      !eth.isOkxWallet && !eth.isOKExWallet && !eth.isTrust && !eth.isTrustWallet);
  }
  function pickAccounts(eth) {
    if (!isMetaMaskWallet(eth)) return requestAccountsOnce(eth);
    return eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }).then(function () {
      return eth.request({ method: 'eth_accounts', params: [] });
    }, function (e) {
      if (isUserRejection(e) || connectErrCode(e) === -32002) throw e;
      return requestAccountsOnce(eth);   /* a MetaMask without the account list */
    });
  }

  function connect() {
    wallet.leftByUser = false;
    setup.connectNote = null;
    return chooseWallet().then(function (eth) {
      if (eth) return connectWith(eth);
      if (!walletList().length && !window.ethereum) openWalletApps();
    });
  }

  function connectWith(eth) {
    var E = window.ethers, connected = false;
    wallet.eth = eth;
    return pickAccounts(eth).then(function (accounts) {
      if (!accounts || !accounts.length) throw new Error('No account returned by the wallet.');
      var next = E.getAddress(accounts[0]);
      if (wallet.account && next !== wallet.account) resetAccount();
      wallet.account = next;
      connected = true; setup.connectNote = null;
      if (accounts.length > 1 && isMetaMaskWallet(eth)) toast('Using ' + shortAddr(next) + ', the account open in MetaMask. Switch accounts in MetaMask and the page follows.', null, null, 9000);
      return eth.request({ method: 'eth_chainId', params: [] });
    }).then(function (hex) {
      wallet.chainId = parseInt(hex, 16);
      subscribeWallet(eth);
      return onChainChanged();
    }).then(function () {
      if (wallet.chainId === CHAIN_ID) return;
      /* While First steps runs for this wallet it picks the moment to switch: a wallet with nothing on HyperEVM brings
         its ETH over first from the chain it is on, so Connect must not pull it to HyperEVM (the 2026-11-05 walk: it
         did, and Bring ETH then had to switch it back); a wallet that does need the switch gets the same prompt the
         moment the guide says so (setupShow) */
      var st = null; try { st = setupStepNow(); } catch (e) { /* no guide */ }
      if (st) { setup.autoSwitch = wallet.account; setupRender(); return; }
      return switchChain().then(function () { return onChainChanged(); }).catch(switchFailed);
    }).catch(function (e) {
      if (!connected) {
        var msg = connectFailText(e, eth); setup.connectNote = msg;
        if (!(setup.on && setup.step === 'connect')) toast(msg, 'err', null, 15000);   /* First steps' card says it: a message would cover its button */
      }
      else toast(describeError(e), 'err');
      renderWallet(); renderAction();
      try { setupRender(); } catch (x) { /* First steps never block the ticket */ }
    });
  }

  /* Reconnect silently when the wallet already authorised this site. */
  function tryAutoConnect() {
    var E = window.ethers;
    var eth = getInjected();
    if (!eth || !E) { tour.autoTried = true; setupRender(); return; }
    eth.request({ method: 'eth_accounts', params: [] }).then(function (accounts) {
      if (!accounts || !accounts.length) return;
      wallet.eth = eth;
      wallet.account = E.getAddress(accounts[0]);
      return eth.request({ method: 'eth_chainId', params: [] }).then(function (hex) {
        wallet.chainId = parseInt(hex, 16);
        subscribeWallet(eth);
        return onChainChanged();
      });
    }).catch(function () { /* stay disconnected */ }).then(function () { tour.autoTried = true; setupRender(); });
  }

  /* (2026-11-04, the owner: MetaMask connected but First steps stayed on "Connect your wallet") A wallet approved from
     its own window, not this page's button, tells the page nothing until a reload. While no wallet is connected, ask
     every 3 s whether this site is now authorised and pick the account up as the silent reconnect does. Not after the
     page's own Disconnect: that stays until the next Connect. */
  var EXT_POLL_MS = 3000, extPoll = null, extBusy = false;
  function watchExternalConnect() {
    if (extPoll) return;
    extPoll = setInterval(function () {
      if (wallet.account || wallet.leftByUser || extBusy || document.hidden) return;
      var eth = getInjected(), E = window.ethers;
      if (!eth || !E) return;
      extBusy = true;
      eth.request({ method: 'eth_accounts', params: [] }).then(function (accounts) {
        if (wallet.account || wallet.leftByUser || !accounts || !accounts.length) return;
        wallet.eth = eth;
        wallet.account = E.getAddress(accounts[0]);
        return eth.request({ method: 'eth_chainId', params: [] }).then(function (hex) {
          wallet.chainId = parseInt(hex, 16);
          subscribeWallet(eth);
          return onChainChanged();
        });
      }).catch(function () { /* still disconnected */ }).then(function () { extBusy = false; });
    }, EXT_POLL_MS);
  }

  /* One wallet's events at a time: after Switch wallet the new one's, and anything the old one still says is ignored. */
  function subscribeWallet(eth) {
    if (wallet.subscribed === eth || typeof eth.on !== 'function') return;
    var prev = wallet.subscribed, h0 = wallet.handlers;
    if (prev && h0 && typeof prev.removeListener === 'function') {
      try { prev.removeListener('accountsChanged', h0.acc); prev.removeListener('chainChanged', h0.chain); prev.removeListener('disconnect', h0.gone); } catch (e) { /* the guard below covers it */ }
    }
    wallet.subscribed = eth;
    var h = wallet.handlers = {
      acc: function (accounts) {
        if (wallet.eth !== eth) return;
        if (!accounts || !accounts.length) { disconnect(); return; }
        var next = window.ethers.getAddress(accounts[0]);
        if (next === wallet.account) return;
        wallet.account = next;
        resetAccount();
        toast('Account changed to ' + shortAddr(next));
        onChainChanged();
      },
      chain: function (hex) {
        if (wallet.eth !== eth) return;
        wallet.chainId = parseInt(hex, 16);
        onChainChanged();
      },
      gone: function () { if (wallet.eth === eth) disconnect(); }
    };
    eth.on('accountsChanged', h.acc);
    eth.on('chainChanged', h.chain);
    eth.on('disconnect', h.gone);
  }

  /* The wallet's own name: its EIP-6963 announcement, else the flag it sets. */
  function walletName(eth) {
    eth = eth || wallet.eth; if (!eth) return 'Wallet';
    var hit = walletList().filter(function (d) { return d.provider === eth; })[0];
    if (hit && hit.info && hit.info.name) return String(hit.info.name).slice(0, 40);
    return eth.isPhantom ? 'Phantom' : eth.isRabby ? 'Rabby' : eth.isCoinbaseWallet ? 'Coinbase Wallet' : (eth.isOkxWallet || eth.isOKExWallet) ? 'OKX Wallet' : eth.isMetaMask ? 'MetaMask' : 'Wallet';
  }

  /* (2026-11-05, the owner: "it neeeds to say what wallet you are connected to and an option to close window "just
     looking." or switch wallet because im stuck on this screen now") Switch wallet: with two or more wallets in this
     browser the picker comes back (the pick is remembered); with one, its own account list where it has one
     (wallet_requestPermissions), else where to change the account. */
  function switchWallet() {
    var list = walletList(), old = wallet.eth;
    setup.connectNote = null;
    if (list.length >= 2 || !old) {
      return chooseWallet().then(function (eth) {
        if (!eth) return;
        if (eth !== old) {
          wallet.account = null; wallet.signer = null; wallet.provider = null; wallet.chainId = null;
          resetAccount();
        }
        wallet.leftByUser = false;
        return connectWith(eth);
      });
    }
    return old.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }).then(function () {
      return old.request({ method: 'eth_accounts', params: [] });
    }).then(function (accounts) {
      if (!accounts || !accounts.length) return;
      var next = window.ethers.getAddress(accounts[0]);
      if (next === wallet.account) { toast('Still ' + shortAddr(next) + '. To use another one, pick it in ' + walletName(old) + '.', null, null, 8000); return; }
      wallet.account = next; resetAccount();
      toast('Switched to ' + shortAddr(next));
      return onChainChanged();
    }).catch(function (e) {
      if (isUserRejection(e)) return;
      toast('Pick another account in ' + walletName(old) + ' itself: the page follows the account it shows.', null, null, 9000);
    });
  }

  function onChainChanged() {
    var E = window.ethers;
    if (typeof brRefreshBal === 'function') try { brRefreshBal(); } catch (e) { /* the bridge card never blocks */ }
    if (wallet.eth && wallet.account) {
      wallet.provider = new E.BrowserProvider(wallet.eth);
      /* (2026-11-06, the owner's MetaMask popup: "Account 1" asking to send while the page sat on another account; "cant
         even confirmn") getSigner() with no address signs as the wallet's first account, whichever that is at the time.
         The signer is the account the page shows, so every send names it as "from" and the wallet asks for that one. */
      return Promise.resolve(new E.JsonRpcSigner(wallet.provider, wallet.account)).then(function (s) {
        wallet.signer = s;
      }).catch(function () { wallet.signer = null; }).then(function () {
        renderWallet(); renderAction(); renderStatus(); renderPositions(); renderRefer();
        if (wallet.chainId !== CHAIN_ID && !(br.busy || br.inflight) && lsGet(setupKey()) === '1') toast('Your wallet is on ' + chainName(wallet.chainId) + '. Confetti runs on HyperEVM: tap Switch to HyperEVM.', 'err');   /* not mid-bridge: the wallet is there on purpose */
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

  /* (2026-11-05, the owner's screen recording: Connect ticked, then every "Switch to HyperEVM" tap answered 4100 "The
     requested method and/or account has not been authorized by the user") The wallet no longer counts this site as
     approved for the account it is on (Phantom checks its connected-apps record on every switch; an account change in
     the wallet or a removed connection leaves the page holding an address the wallet will not act for). Ask the wallet
     to approve the site again, then switch once more. */
  function switchChain() {
    var eth = wallet.eth || getInjected();
    if (!eth) return Promise.reject(new Error('No wallet.'));
    return switchChainOnce(eth).catch(function (err) {
      var code = null;
      walkError(err, function (x) { if (x && x.code === 4100) { code = 4100; return true; } return false; });
      if (code !== 4100) throw err;
      return eth.request({ method: 'eth_requestAccounts', params: [] }).then(function (accounts) {
        if (accounts && accounts.length) {
          var next = window.ethers.getAddress(accounts[0]);
          if (next !== wallet.account) { wallet.account = next; resetAccount(); }
        }
        return switchChainOnce(eth);
      });
    });
  }
  function switchChainOnce(eth) {
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
      return eth.request({ method: 'eth_chainId', params: [] });
    }).then(function (hex) {
      wallet.chainId = parseInt(hex, 16);
      if (wallet.chainId !== CHAIN_ID) throw new Error('Your wallet is still on ' + chainName(wallet.chainId) + '.');
    });
  }

  /* A switch the wallet refused or could not make: say so, with the network to add by hand. */
  function switchFailed(e) {
    var c4100 = false; walkError(e, function (x) { if (x && x.code === 4100) { c4100 = true; return true; } return false; });
    if (c4100) { toast('Your wallet says this site is not approved for the account it is on. Open your wallet, connect confetti.trade to this account (or switch back to the account you connected), then tap Switch to HyperEVM again.', 'err', null, 20000); return; }
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
    wallet.leftByUser = true;   /* the external-connect watch leaves the page disconnected until the next Connect */
    resetAccount();
    renderWallet(); renderAction(); renderStatus();
    toast('Disconnected from this page. Your wallet may still list the site as connected.');
  }

  /* The header: Connect, or the address (a tap opens Copy / explorer / Disconnect); Deposit and
     Withdraw only once a wallet is connected. */
  /* (2026-11-01, the owner: a "switch wallet to HyperEVM" button on the trade panel) the banner above the layout while a
     connected wallet sits on another chain; its button runs the same switch as the ticket button. */
  function renderChainBanner() {
    var b = $('chainBanner'); if (!b) return;
    var on = !!(wallet.account && wallet.chainId != null && wallet.chainId !== CHAIN_ID);
    b.hidden = !on;
    if (on) setText('chainBannerName', chainName(wallet.chainId));
  }

  function renderWallet() {
    if (typeof swOnWallet === 'function') swOnWallet();
    renderChainBanner();
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
    NotTrader: function () { return 'Only the trader may do that.'; },
    /* v5 */
    CloseBpsOutOfRange: function () { return 'Pick a share from 0.01% to 100%.'; },
    PositionBusted: function () { return 'This position is past its liquidation price.'; },
    /* v5 fast pricing */
    PriceDeviates: function () { return 'The price feed is unsettled for a moment. Try again shortly.'; },
    PriceUncertain: function () { return 'The price feed is unsettled for a moment. Try again shortly.'; },
    FastMarket: function () { return 'This market settles on its fast price only.'; },
    NotFastMarket: function () { return 'This market is not on the fast price.'; },
    FastWindowOver: function () { return 'Too late for that. An open is refunded; a close can now be finished only from your own wallet, or asked again once it has run out.'; },
    /* v6: the stop loss in force owns this exit (a liquidation past an inside stop today; review finding S1 asks the
       contracts for the same on a close filled at or past the stop by anyone but the trade's own wallet) */
    TriggerFirst: function () { return 'Your stop loss comes first here: this trade closes through its stop.'; }
  };

  function friendly(name, args) {
    var f = (errWords && errWords[name]) || FRIENDLY[name];
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
    OiCapExceeded: 'the market is full on that side', FastPriceMissed: 'no fresh price came in time', HouseExposureExceeded: 'the house is full', MarginBelowMinimum: 'under the minimum', UnknownPosition: 'liquidated first'
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

  /* v5: the errors whose words depend on what was asked. MarginBelowMinimum and LeverageOutOfRange
     are the open's rules too (FRIENDLY says them for an open); on a share close and on add margin
     they mean what these say. describeErrorAs says err with words in force for that one call. */
  var errWords = null;
  var CLOSE_SHARE_WORDS = {
    MarginBelowMinimum: function () { return 'What stays open would be under the ' + fmtUsdShort(minMargin()) + ' minimum. Close less, or close all of it.'; }
  };
  var ADD_MARGIN_WORDS = {
    LeverageOutOfRange: function () { return 'That much would take it below 1x: a position cannot hold more margin than its size.'; },
    PositionBusted: function () { return 'This position is past its liquidation price: adding margin cannot save it now.'; }
  };
  function describeErrorAs(err, words) {
    var was = errWords;
    errWords = words;
    try { return describeError(err); } finally { errWords = was; }
  }

  function describeError(err) {
    if (!err) return 'Something went wrong.';
    if (typeof err === 'string') return err;
    if (isUserRejection(err)) return 'You cancelled in your wallet. Nothing was sent.';
    var data = revertData(err);
    if (data) return decodeRevert(data);
    if (err.revert && err.revert.name) return friendly(err.revert.name, err.revert.args);
    if (/missing revert data|could not coalesce|429|rate limit/i.test(String(err.shortMessage || err.message || ''))) {
      return 'The network was busy and did not answer. Nothing was sent; try again.';
    }
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

  /* kind: the trading call it is for; the share close (CLOSE_BPS) has its own ABI (EXCHANGE_V5_BPS_ABI) */
  function exchangeWrite(kind) { return new window.ethers.Contract(cfg.contracts.exchange, kind === CLOSE_BPS ? EXCHANGE_V5_BPS_ABI : exchangeAbi(), wallet.signer); }
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
    renderSession(); renderDepositModal(); renderVaults();
  }

  function txLink(hash) { return DEMO ? null : { href: explorer('tx', hash), label: 'view' }; }

  /* Dry-run with eth_call for a decoded revert reason, send, then wait for one confirmation.
     quiet: no "waiting for confirmation" toast (trades: their progress card says it).
     hooks (CF_PNL): sent(hash) the moment the transaction is out (the order's card follows it from there), and
     overrides merged into the send (a session key's nonce and fees, so the send skips those reads). The receipt is
     whichever comes first: ethers' own wait, or the block feed finding it at a head. */
  function sendTx(desc, method, args, quiet, from, hooks) {
    if (DEMO) return Promise.reject(new Error('Demo: nothing is sent.'));
    return simulate(method, args, from).then(function (gas) {
      var a = gas ? withGas(args, gas) : args;
      if (hooks && hooks.overrides) a = withOverrides(a, hooks.overrides);
      return method.apply(null, a);
    }).then(function (tx) {
      if (hooks && hooks.sent) { try { hooks.sent(tx.hash, tx); } catch (e) { /* never blocks the send */ } }
      var pending = quiet ? null : toast(desc + ': sent, waiting for the chain…', 'pending', txLink(tx.hash), 0);
      var wait = tx.wait();
      var both = headsFresh() ? Promise.race([wait, headReceipt(tx.hash)]) : wait;
      return both.then(function (rc) {
        delete heads.receipts[tx.hash];
        dismissToast(pending);
        if (!rc || rc.status !== 1) throw new Error(desc + ' reverted on chain.');
        return rc;
      }, function (e) { delete heads.receipts[tx.hash]; dismissToast(pending); throw e; });
    });
  }

  /* args with overrides merged into the trailing overrides object (or one added). */
  function withOverrides(args, o) {
    var last = args[args.length - 1];
    var has = last && typeof last === 'object' && !Array.isArray(last) && typeof last !== 'bigint' && !(last instanceof Uint8Array);
    var merged = Object.assign({}, has ? last : {});
    Object.keys(o).forEach(function (k) { if (o[k] != null && merged[k] == null) merged[k] = o[k]; });
    return (has ? args.slice(0, -1) : args.slice()).concat([merged]);
  }

  /* The check before a send, as `from` on the page's own RPC (the wallet's RPC is a shared free one that turns away
     a fast trader and answers with no reason, which read as "missing revert data"); resolves to a gas limit with
     30 % headroom, or null when it could not estimate. Without `from` (or a read RPC) the method's own staticCall. */
  function simulate(method, args, from) {
    if (!from || !read.provider || typeof method.populateTransaction !== 'function') {
      return method.staticCall.apply(method, args).then(function () { return null; });
    }
    return method.populateTransaction.apply(method, args).then(function (tx) {
      var q = { to: tx.to, data: tx.data, from: from };
      if (tx.value) q.value = tx.value;
      /* (CF_PNL) side by side: a revert still comes back from the call with its reason */
      var sp = read.sendProvider || read.provider;
      var gas = sp.estimateGas(q).then(function (g) { return BigInt(g) * 13n / 10n; }, function () { return null; });
      return Promise.all([sp.call(q), gas]).then(function (r) { return r[1]; });
    });
  }

  /* args with a gasLimit added (merged into a trailing overrides object, if the call has one). */
  function withGas(args, gas) {
    var last = args[args.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last) && typeof last !== 'bigint' && !(last instanceof Uint8Array)) {
      var o = Object.assign({}, last);
      if (o.gasLimit == null) o.gasLimit = gas;
      return args.slice(0, -1).concat([o]);
    }
    return args.concat([{ gasLimit: gas }]);
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
    if (wallet.account && ref.vaultsFor === wallet.account && ref.vaults.some(function (v) { return v.addr.toLowerCase() === ref.addr.toLowerCase(); })) return ZERO;
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
    try { sess.key = new window.ethers.Wallet(pk, read.sendProvider || read.provider); } catch (e) { sess.key = null; }
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
    if (DEMO) return sess.demoOn;
    var s = sess.onchain;
    return !!(read.router && sess.key && s && s.key.toLowerCase() === sess.key.address.toLowerCase() &&
      s.expiry > chainNow() + 60 && sess.gasWei != null && sess.gasWei >= sessionGasNeed());
  }

  /* The gas the key must hold to send one more request at the fee now (at least SESSION_MIN_GAS). */
  function sessionGasNeed() {
    var need = sess.feeWei ? SESSION_TX_GAS * sess.feeWei : 0n;
    return need > SESSION_MIN_GAS ? need : SESSION_MIN_GAS;
  }

  /* Why the session cannot carry a trade of `margin6` right now, in the words the ticket uses; '' when it can. */
  function oneTapWhy(margin6) {
    if (DEMO) return sess.demoOn ? '' : 'first';
    var s = sess.onchain;
    var mine = !!(s && sess.key && s.key.toLowerCase() === sess.key.address.toLowerCase());
    if (!mine) return 'first';
    if (s.expiry <= chainNow() + 60) return 'expired';
    if (sess.gasWei == null || sess.gasWei < sessionGasNeed()) return 'gas';
    if (margin6 != null && BigInt(margin6) > s.cap6) return 'cap';
    return '';
  }

  var ONE_TAP_NOTE = {
    first: 'First trade here: your wallet turns on one-tap once, then no popups.',
    expired: 'One-tap expired: your wallet renews it once, then no popups.',
    gas: 'One-tap needs gas: your wallet tops it up once, then no popups.',
    cap: 'Over your one-tap limit: your wallet raises it once.'
  };

  function refreshSession() {
    if (DEMO) { renderSession(); return Promise.resolve(); }
    if (!read.router || !wallet.account) { sess.onchain = null; sess.loaded = false; renderSession(); return Promise.resolve(); }
    var a = wallet.account;
    loadSessionKey();
    var key = sess.key;
    return Promise.all([
      read.router.sessionOf(a),
      key ? read.provider.getBalance(key.address) : Promise.resolve(null),
      read.provider.getFeeData().catch(function () { return null; }),
      key ? read.provider.getTransactionCount(key.address, 'pending').catch(function () { return null; }) : Promise.resolve(null)
    ]).then(function (r) {
      if (wallet.account !== a) return;
      var fd = r[2];
      if (fd) sess.feeWei = BigInt(fd.maxFeePerGas != null ? fd.maxFeePerGas : fd.gasPrice || 0n);
      if (fd && fd.maxPriorityFeePerGas != null) sess.priorityWei = BigInt(fd.maxPriorityFeePerGas);
      if (key && r[3] != null && (sess.nonceOk || sess.nonce == null || sess.nonceFor !== key.address)) {
        var nn = Number(r[3]);
        if (sess.nonceFor !== key.address || sess.nonce == null || nn > sess.nonce) { sess.nonceFor = key.address; sess.nonce = nn; sess.nonceOk = true; }
      }
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
    setBusy(true);
    return authorizeSession(capUsd, days).then(function (rc) {
      toast('One-click on: up to ' + fmtUsd(capUsd) + ' a trade, ' + days + (days === 1 ? ' day.' : ' days.'), 'ok', txLink(rc.hash));
      closeDialog('sessionModal');
      return refreshSession();
    }).catch(function (e) {
      toast('One-click failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* Forced one-tap: turn on, renew, top up or raise the cap in one wallet confirmation, so the trade that asked
     (margin6, if an open) goes through the session key. Cap: the account's money now, at least
     ONE_TAP_MIN_CAP_USD and never under this trade; 30 days. Rejected or failed: the error goes to the trade. */
  function ensureOneTap(margin6) {
    if (DEMO) {
      state.turningOn = true; renderAction(); updateCards();
      return new Promise(function (ok) { setTimeout(ok, 1400); }).then(function () {
        sess.demoOn = true; state.turningOn = false;
        toast('One-tap on: trades go through with no popup from now on.', 'ok');
        renderSession(); renderAction();
      });
    }
    var have = (Number(acct.available) || 0) + (Number(acct.marginInUse) || 0);
    var capUsd = Math.max(ONE_TAP_MIN_CAP_USD, Math.ceil(have), margin6 != null ? Math.ceil(usd6ToNum(margin6)) : 0);
    var s = sess.onchain;
    if (s && oneTapWhy(margin6) !== 'cap' && usd6ToNum(s.cap6) > capUsd) capUsd = Math.ceil(usd6ToNum(s.cap6));   // never lowers a cap
    state.turningOn = true; renderAction(); updateCards();
    return authorizeSession(capUsd, ONE_TAP_DAYS).then(function () {
      /* a load-balanced RPC can answer from a node behind the receipt: read until it shows the new session, so the
         trade that asked goes through the key and not to the wallet a second time */
      var tries = 0;
      return (function read() {
        return refreshSession().then(function () {
          if (oneTapWhy(margin6) && ++tries < 6) return new Promise(function (ok) { setTimeout(ok, 800); }).then(read);
        });
      })();
    }).then(function () {
      toast('One-tap on: trades go through with no popup from now on.', 'ok');
    }).then(function () { state.turningOn = false; renderAction(); updateCards(); },
      function (e) { state.turningOn = false; renderAction(); updateCards(); throw e; });
  }

  /* authorize(key, expiry, cap, referrer, keySig) with SESSION_GAS_HYPE for the key's gas; resolves to the receipt. */
  function authorizeSession(capUsd, days) {
    var E = window.ethers;
    var a = wallet.account;
    var router = new E.Contract(read.router.target, ROUTER_ABI, wallet.signer);
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
      /* the key's gas: SESSION_GAS_HYPE or what the wallet can spare, keeping SESSION_WALLET_KEEP_HYPE for this
         transaction (a wallet with little HYPE still turns on; the keeper's gas station tops the key up) */
      return read.provider.getBalance(a).then(function (bal) {
        var want = E.parseEther(SESSION_GAS_HYPE), keep = E.parseEther(SESSION_WALLET_KEEP_HYPE);
        bal = BigInt(bal);
        var pack = bal > keep ? (bal - keep < want ? bal - keep : want) : 0n;
        return sendTx('One-click', router.authorize, [sess.key.address, expiry, cap6, referrer, keySig, { value: pack }], true, a);
      });
    });
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
    /* v5 (16.2): past its three public seconds a fast market's late close is the owner's alone; the key would be
       refused (FastWindowOver), so the wallet sends it */
    if (kind === 'executeClose' && closeOwnOnly(args[0])) return false;
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

  function walletTrade(desc, kind, args, hooks) {
    return Promise.resolve().then(function () {
      requireSigner();
      /* v6: an open with its levels goes to the router (openWithTriggers: the request and the levels parked on it, for
         this wallet only, one confirm) */
      if (kind === 'requestOpen' && hooks && hooks.trig) {
        if (!read.router) throw new Error('One-click is not ready on this page: open without take profit and stop loss, then set them on the card.');
        var router = new window.ethers.Contract(read.router.target, routerAbi(), wallet.signer);
        return sendTx(desc, router.openWithTriggers, args.slice(0, 5).concat([hooks.trig.tp18, hooks.trig.sl18]), true, wallet.account, hooks.sent ? { sent: hooks.sent } : null);
      }
      return sendTx(desc, exchangeWrite(kind)[kind], args, true, wallet.account, hooks && hooks.sent ? { sent: hooks.sent } : null);
    });
  }

  /* Send a trading call (an Exchange function name and its wallet arguments): through the
     session key when it carries the call, else from the wallet. A session the router refuses
     before anything is sent (no session, expired, over the cap) or a key out of gas falls back to
     the wallet once; an on-chain revert never does (the call already ran). Trades send quietly:
     the progress card where the user clicked says what is happening, not a toast. */
  function sendTrade(desc, kind, args, again, hooks) {
    var opening = kind === 'requestOpen', asks = opening || kind === 'requestClose' || kind === CLOSE_BPS;
    if (DEMO) {
      if (ONE_TAP_FORCED && asks && !sess.demoOn) return ensureOneTap(null).then(function () { return demoTx(kind, args, hooks); });
      return demoTx(kind, args, hooks);
    }
    if (!sessionCarries(kind, args)) {
      /* forced one-tap: the trader's own requests turn it on (or renew / top up / raise it) first, once */
      /* (no referrer test here: sessionRefOk says no when there is no session yet, the very case this is for, and
         turning on signs this same referrer into the session) */
      if (ONE_TAP_FORCED && asks && !again && read.router && !house.usdcBad && !house.gate) {
        return ensureOneTap(opening ? args[2] : null).then(function () { return sendTrade(desc, kind, args, true, hooks); }, function (e) {
          /* forcing one-tap never stops a trade: the trader said no, or it cannot turn on, and only then the wallet */
          if (isUserRejection(e)) throw e;
          return walletTrade(desc, kind, args, hooks);
        });
      }
      return walletTrade(desc, kind, args, hooks);
    }
    var E = window.ethers;
    var target = kind === 'executeOpen' || kind === 'executeClose'
      ? new E.Contract(cfg.contracts.exchange, exchangeAbi(), sess.key)
      : new E.Contract(read.router.target, kind === CLOSE_BPS ? ROUTER_V5_ABI : routerAbi(), sess.key);
    var sargs = kind === 'requestOpen' ? args.slice(0, 4) : args;
    /* v6: an open with its levels is the router's requestOpenWithTriggers (the cap and the session's referrer as
       requestOpen; the levels parked on the request in the same transaction) */
    var skind = kind;
    if (kind === 'requestOpen' && hooks && hooks.trig) { skind = 'requestOpenWithTriggers'; sargs = sargs.concat([hooks.trig.tp18, hooks.trig.sl18]); }
    state.viaSession = true; renderAction(); updateCards();
    var keyAddr = sess.key.address;
    return inSessionTurn(function () {
      var sh = { sent: function (hash, tx) { sessNonceSent(keyAddr, tx); if (hooks && hooks.sent) hooks.sent(hash, tx); }, overrides: sessionOverrides(keyAddr) };
      return sendTx(desc, target[skind], sargs, true, keyAddr, sh).then(function (rc) { sess.nonceOk = true; return rc; }, function (e) {
        /* mined and reverted: the nonce is spent and the next one is right; anything else: read it again next time */
        if (/reverted on chain/.test(String(e && e.message)) || (e && e.code === 'CALL_EXCEPTION' && e.receipt)) sess.nonceOk = true; else sess.nonce = null;
        throw e;
      });
    }).catch(function (e) {
      if (isNonceTrouble(e) && !(hooks && hooks.nonceRetry)) {
        /* (CF_PNL) another tab sent with this key, or a node counted a nonce differently: read it again, once */
        return sendTrade(desc, kind, args, again, Object.assign({}, hooks || {}, { nonceRetry: true }));
      }
      if (!SESSION_ERRORS[revertName(e)] && !isGasShortfall(e)) throw e;
      state.viaSession = false; renderAction(); updateCards();
      /* the key ran dry or the session ended between the check and the send: refresh, then the forced path
         (one confirmation that fixes it) or, after that once, the wallet */
      return refreshSession().then(function () { return again ? walletTrade(desc, kind, args, hooks) : sendTrade(desc, kind, args, false, hooks); });
    });
  }

  /* (CF_PNL) The session key's next nonce and its fees, known before the tap so the send goes out after the dry run
     with no more reads: the nonce from the last send (or the last 10 s session read, whichever is higher), the fees as
     ethers works them (twice the latest block's base fee plus the priority fee) from the block feed's base fee. Either
     unknown: ethers reads it, as before. */
  function sessionOverrides(addr) {
    var o = {};
    /* the cached nonce only after the send before it was mined (the session key sends one at a time) */
    if (sess.nonceFor === addr && sess.nonce != null && sess.nonceOk) o.nonce = sess.nonce;
    if (heads.baseFee != null && sess.priorityWei != null && headsFresh()) {
      o.maxPriorityFeePerGas = sess.priorityWei;
      o.maxFeePerGas = heads.baseFee * 2n + sess.priorityWei;
      o.type = 2;
    }
    return o;
  }
  function sessNonceSent(addr, tx) { if (tx && tx.nonce != null) { sess.nonceFor = addr; sess.nonce = Number(tx.nonce) + 1; sess.nonceOk = false; } }
  /* a send the node refused for its nonce (nothing went out, so sending again is safe); never "already known" */
  function isNonceTrouble(e) {
    return walkError(e, function (x) {
      if (!x) return false;
      if (x.code === 'NONCE_EXPIRED' || x.code === 'REPLACEMENT_UNDERPRICED') return true;
      return /nonce too low|nonce too high|invalid nonce|replacement transaction underpriced/i.test(String(x.message || x.shortMessage || ''));
    });
  }

  /* The session key sends one transaction at a time: the ticket stays open while an order goes in, and two sends
     together could read the same nonce. */
  function inSessionTurn(send) {
    var run = quick.queue.then(send, send);
    var settled = run.then(function () {}, function () {});
    quick.queue = Promise.race([settled, new Promise(function (ok) { setTimeout(ok, QUICK_QUEUE_MS); })]);
    return run;
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
    /* v6: on a fast market the levels go on chain with the request, in the same transaction */
    var tw = trigWant(m, want);
    var openArgs = [m.instrumentId, isLong, margin6, lev, referrerArg()];
    if (!tour.on && (DEMO ? (!ONE_TAP_FORCED || sess.demoOn) : sessionCarries('requestOpen', openArgs))) {
      quickOpen(m, isLong, margin, lev, openArgs, desc, want, maxed, onFiled);
      return;
    }
    var released = false;
    function release() { if (!released) { released = true; setBusy(false); } }
    /* a limit order asks whether its request reached the chain (true once the receipt is read; a sent request
       whose event the page could not read counts as filed, since the position will show) */
    var told = false;
    function tell(ok) { if (onFiled && !told) { told = true; try { onFiled(ok); } catch (e) { /* never blocks the ticket */ } } }
    setBusy(true);
    tkSet('wallet', { reqId: null, isLong: isLong, sym: m.symbol, lev: lev, margin: margin, txHash: null });
    /* (CF_PNL) once the wallet has sent it, the order has its card under Your positions too (the ticket's progress
       card stays where the button was); the block feed or the receipt turns it into the request */
    var wq = null;
    var sentHook = function (hash) {
      tk.txHash = hash;
      if (!wq && !pend.opens[tk.reqId]) {
        wq = { key: 'q' + quick.next++, instrumentId: m.instrumentId, isLong: isLong, margin: margin, leverage: lev, px0: 0, tapAt: Date.now(), txHash: hash, walletPath: true };
        quick.list.push(wq);
        renderPositions();
      }
    };
    var dropWq = function () { if (wq) { quick.list = quick.list.filter(function (q) { return q !== wq; }); wq = null; } };
    sendTrade(desc, 'requestOpen', [m.instrumentId, isLong, margin6, lev, referrerArg()], false, { sent: sentHook, trig: tw }).then(function (rc) {
      dropWq();
      var ev = receiptEvents(rc, 'OpenRequested')[0];
      if (ev) {
        var a = ev.args;
        var id = String(a.requestId);
        trackOpenRequest({
          id: id, instrumentId: Number(a.instrumentId), isLong: !!a.isLong,
          margin: usd6ToNum(a.marginUsdc), leverage: Number(a.leverage), px0: px18ToNum(a.px0),
          requestedAt: heads.tsByBlock[Number(rc.blockNumber)] != null ? heads.tsByBlock[Number(rc.blockNumber)] : null, block: Number(rc.blockNumber), localAt: Date.now()
        });
        if (tk.phase === 'wallet' || (tk.phase === 'req' && tk.reqId === id)) tkSet('req', { reqId: id });
        if (tw) trigParked(id, tw.tp18, tw.sl18, rc);
        else if (want.tp != null || want.sl != null) { try { tpslPark(id, want, m, isLong, lev, Number(rc.blockNumber)); } catch (e) { /* ignore */ } }
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
      var sent = !!wq;
      dropWq();
      tkSet('error', { msg: trigOpenErr(e, tw) });
      if (sent) showOpenEnd('v' + Date.now(), { isLong: isLong, instrumentId: m.instrumentId, leverage: lev, margin: margin }, "Didn't go through", 'Your ' + m.symbol + ' ' + sideWord(isLong).toLowerCase() + ' did not go through: ' + trigOpenErr(e, tw) + ' Nothing was taken.');
      tell(false);
    }).then(release);
  }

  /* An open no wallet has to confirm: the card and the chart line show at the tap, the balance drops at once, and the
     ticket stays free for the next trade. The request's own card takes over when it is on chain (submitOpen's path after
     that is the one a limit order or a reload already takes: watchPending and its toast). */
  function quickOpen(m, isLong, margin, lev, args, desc, want, maxed, onFiled) {
    if (Date.now() - quick.last < QUICK_GAP_MS) return;
    quick.last = Date.now();
    var mid = state.mids[m.coin];
    var r = { key: 'q' + quick.next++, instrumentId: m.instrumentId, isLong: isLong, margin: margin, leverage: lev, px0: isFinite(mid) ? Number(mid) : 0, tapAt: Date.now() };
    quick.list.push(r);
    /* what the request takes: the stake and, on v5, its open fee */
    var held = reqIn(r);
    acct.available -= held; acct.pending += held;
    if (!maxed) lsSet(LS.amount, String(margin));
    noteRecent(m.symbol);
    if (ui.sheet) closeSheet();
    renderAccount(); renderPositions(); renderAction();
    function drop(giveBack) {
      quick.list = quick.list.filter(function (q) { return q !== r; });
      if (giveBack) { acct.available += held; acct.pending = Math.max(0, acct.pending - held); }
      state.viaSession = false;
    }
    function tell(ok) { if (onFiled) { try { onFiled(ok); } catch (e) { /* never blocks the ticket */ } } }
    var tw = trigWant(m, want);
    sendTrade(desc, 'requestOpen', args, false, { sent: function (hash) { r.txHash = hash; renderPositions(); }, trig: tw }).then(function (rc) {
      var ev = receiptEvents(rc, 'OpenRequested')[0];
      /* on chain the money has moved: the account read coming next says so. The demo's own books already did. */
      drop(!!DEMO);
      if (ev) {
        var a = ev.args;
        var id = String(a.requestId);
        trackOpenRequest({
          id: id, instrumentId: Number(a.instrumentId), isLong: !!a.isLong,
          margin: usd6ToNum(a.marginUsdc), leverage: Number(a.leverage), px0: px18ToNum(a.px0),
          requestedAt: heads.tsByBlock[Number(rc.blockNumber)] != null ? heads.tsByBlock[Number(rc.blockNumber)] : null, block: Number(rc.blockNumber), localAt: Date.now()
        });
        if (tw) trigParked(id, tw.tp18, tw.sl18, rc);
        else if (want.tp != null || want.sl != null) { try { tpslPark(id, want, m, isLong, lev, Number(rc.blockNumber)); } catch (e) { /* ignore */ } }
      } else {
        toast('Sent, but the page could not read the request. Your positions show the result.', 'err');
      }
      tell(true);
      renderPositions();
      return afterTx();
    }).catch(function (e) {
      drop(true);
      /* (CF_PNL) said where the order was, at once: the card (the row on a phone) turns into the reason */
      var line = 'Your ' + m.symbol + ' ' + sideWord(isLong).toLowerCase() + ' did not go through: ' + trigOpenErr(e, tw) + ' Nothing was taken.';
      showOpenEnd('v' + r.key, r, "Didn't go through", line);
      resultToast([recentEl('v' + r.key), phEndRow('v' + r.key)], line, 'err');
      tell(false);
      renderAccount(); renderPositions(); renderAction();
      return refreshAccount();
    }).catch(function () { /* the next regular read repairs the balance */ });
  }

  /* (CF_PNL) The end of an order that never became a position (a refund, a revert), where its card was: a result card
     (a row on a phone) for OPEN_END_MS, then gone. */
  var OPEN_END_MS = 15000;
  function showOpenEnd(key, r, title, line) {
    addRecent({ key: key, cls: 'is-loss is-open-end', title: title + ' · ' + sideWord(r.isLong) + ' ' + reqSym(r) + ' ' + r.leverage + 'x', lines: [line], ttl: OPEN_END_MS });
    ui.openEnds = (ui.openEnds || []).filter(function (x) { return x.key !== key; });
    ui.openEnds.unshift({ key: key, r: r, say: line });
    setTimeout(function () { ui.openEnds = (ui.openEnds || []).filter(function (x) { return x.key !== key; }); renderPhRows(); }, OPEN_END_MS);
    renderPhRows();
  }
  function phEndRow(key) { return document.querySelector('#phRows .ph-row[data-open="e' + key + '"]'); }

  /* The fallback fill (after the keeper window, before expiry): the session key, else the wallet. */
  function executeOpenNow(r) {
    if (!tradeReady()) return;
    /* v5 fast market: past the keeper's window executeOpen only refunds the request (FastPriceMissed) */
    var desc = fastOf(r.instrumentId) ? 'Get ' + fmtUsdShort(reqIn(r)) + ' back' : 'Finish ' + reqSym(r) + ' ' + sideWord(r.isLong).toLowerCase();
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
      /* the page clock ran a hair ahead of the chain: the next tick asks again (v5: or the market's pricing rule
         changed under the page: read it again, so the window is the chain's) */
      if (name === 'KeeperWindow' || name === 'TooEarly') { r.prompted = false; loadFast(); return; }
      /* someone else filled or refunded it first: the poll reports what happened */
      if (name === 'UnknownRequest') return;
      toast('Could not finish your ' + reqSym(r) + ' order: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* Refund of an expired open request: "Get $X back". */
  function cancelOpenNow(r) {
    if (!tradeReady()) return;
    var desc = 'Get ' + fmtUsdShort(reqIn(r)) + ' back';
    setBusy(true);
    r.busy = true;
    updatePendingLines();
    sendTrade(desc, 'cancelOpen', [BigInt(r.id)]).then(function (rc) {
      var mine = tk.phase && tk.reqId === r.id;
      if (mine) tkSet('refunded', { msg: "Didn't fill. Your " + fmtUsdShort(reqIn(r)) + ' is back in your balance.' });
      resultToast(mine ? [$('ticketProgress')] : [], 'Your ' + fmtUsd(reqIn(r)) + ' is back in your balance.', 'ok', txLink(rc.hash));
      untrackOpenRequest(r.id);
      return afterTx();
    }).catch(function (e) {
      r.busy = false;
      toast('Could not get it back yet: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  /* Step one of a close: file the request. The card's CLOSE POSITION turns into its progress
     (Confirm in your wallet, Closing at the oracle price, Closed); the result card follows.
     bps (v5, optional): the share to close, 1..9999; none or 10000 is the whole position on
     requestClose(uint256), exactly as before; a share files requestClose(uint256,uint16). */
  function submitClose(pos, bps) {
    if (state.busy) return Promise.resolve(false);
    if (!tradeReady()) return Promise.resolve(false);
    var pid = String(pos.id);
    if (acct.closeReqs[pid] || ui.closing[pid]) return Promise.resolve(false);
    var part = bps > 0 && bps < 10000;
    var desc = 'Close ' + (part ? fmtBps(bps) + ' of ' : '') + posLabel(pos);
    var released = false;
    function release() { if (!released) { released = true; delete ui.closing[pid]; setBusy(false); renderPositions(); } }
    ui.closing[pid] = part ? bps : true;
    setBusy(true);
    renderPositions();
    return sendTrade(desc, part ? CLOSE_BPS : 'requestClose', part ? [pos.id, bps] : [pos.id]).then(function (rc) {
      var ev = receiptEvents(rc, 'CloseRequested')[0];
      var bn = Number(rc.blockNumber), seen = acct.closeReqs[pid];
      /* the block feed may have seen the request first (with its block's own time), or the close itself */
      if (seen && seen.block != null) { if (part) seen.bps = bps; }
      else if (posById(pid) && !ui.reported[pid]) acct.closeReqs[pid] = {
        requestedAt: heads.tsByBlock[bn] != null ? heads.tsByBlock[bn] : chainNow(), px0: ev ? px18ToNum(ev.args.px0) : NaN, block: bn, localAt: Date.now(), bps: part ? bps : 10000
      };
      release();
      return afterTx().then(function () { return true; });
    }).catch(function (e) {
      /* v5: one close at a time per position; a second ask is told to wait for the first */
      var waits = isV5() && revertName(e) === 'CloseAlreadyPending';
      toast(waits ? closePendingSay(pid) : 'Your ' + posLabel(pos) + ' is still open: ' + (part ? describeErrorAs(e, CLOSE_SHARE_WORDS) : describeError(e)), waits ? 'warn' : 'err');
      return false;
    }).then(function (ok) { release(); return ok; });
  }

  /* The fallback close fill: the session key, else the wallet. */
  function executeCloseNow(pos) {
    if (!tradeReady()) return;
    var cr = acct.closeReqs[String(pos.id)];
    var desc = (closeOwnOnly(pos.id) ? 'Close ' : 'Finish closing ') + posLabel(pos);
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
      if (name === 'KeeperWindow' || name === 'TooEarly') { if (cr) cr.prompted = false; loadFast(); return; }
      /* v5 (16.2): the key's send landed after the three public seconds. From here it is the owner's wallet: the card
         says so with Close now, and the wallet is asked once (autoFill) */
      if (name === 'FastWindowOver') { if (cr) { cr.own = true; cr.prompted = false; } loadFast(); updatePendingLines(); renderPositions(); return; }
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
    /* v5: Try again closes the same share the expired request was for */
    var was = acct.closeReqs[pid], bps = was ? was.bps : 10000;
    ui.retrying[pid] = true;
    renderPositions();
    cancelCloseNow(pos, true).then(function (ok) {
      var now = ok ? posById(pid) : null;
      var go = now ? submitClose(now, bps) : Promise.resolve(false);
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
        'Each one closes at the market price in ' + fillSecsOf(list) + '.' + (sessionLive() ? '' : ' Your wallet asks once for each.')
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
    if (pend.done[r.id]) return;
    var have = pend.opens[r.id];
    if (have) { if (have.block == null && r.block != null) have.block = r.block; renderPositions(); return; }
    pend.opens[r.id] = r;
    savePendingIds();
    if (r.requestedAt == null && r.block != null && heads.tsByBlock[r.block] != null) r.requestedAt = heads.tsByBlock[r.block];
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
    pendingOpenList().forEach(function (r) { known += reqIn(r); });
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
  var HEADS_RESOLVE_MS = 3000;
  function readPast(q, latest) {
    if (q.block != null && !(latest > q.block)) return false;
    if (q.localAt && Date.now() - q.localAt < GONE_AFTER_MS) return false;
    return true;
  }

  function tickPending() {
    if (DEMO) { demoTickPending(); return; }
    if (pend.inFlight || !read.exchange || !wallet.account) return;
    if (headsFresh() && Date.now() - pend.lastPoll < 2000) return;   /* the block feed reads them at every block */
    pend.lastPoll = Date.now();
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
          /* (CF_PNL) the block feed reads the fill or the refund from its block's logs and puts the position on the card
             in the same render; this poll takes over only if that has not happened within HEADS_RESOLVE_MS */
          if (headsFresh()) { if (!r.emptyAt) r.emptyAt = Date.now(); if (Date.now() - r.emptyAt < HEADS_RESOLVE_MS) return; }
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
          if (headsFresh()) { if (!cr.emptyAt) cr.emptyAt = Date.now(); if (Date.now() - cr.emptyAt < HEADS_RESOLVE_MS) return; }
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

  /* v5 fast markets: the Pyth print a fill used (FillPriced: kind 0 an open, keyed by its request id; 1 a close and
     2 a liquidation, keyed by the position id; always the last log of its transaction). Kept by transaction, so a
     position's share closes each keep their own. The result card and History say it as "price at 12:03:05, Pyth":
     the moment the price is from, which the contract fixed at the request (request time + delay), not the keeper. */
  var prints = {};
  function printKey(tx, kind, key) { return String(tx).toLowerCase() + ':' + kind + ':' + String(key); }
  function printOf(tx, kind, key) { return tx ? prints[printKey(tx, kind, key)] || null : null; }
  function printText(pr) {
    return pr ? 'price at ' + new Date(pr.at * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ', Pyth' : '';
  }
  function printLine(pr) { var t = printText(pr); return t ? t.charAt(0).toUpperCase() + t.slice(1) + '.' : ''; }
  function notePrints(logs) {
    if (!isV5() || !exIface) return;
    parsedLogs(logs).forEach(function (p) {
      if (p.name !== 'FillPriced' || !p.tx) return;
      /* (SITE4) every print, any trader's: its market's anchor for the cards (fastPx18) */
      noteAnchor(Number(p.args.instrumentId), Number(p.args.publishTime), BigInt(p.args.px18));
      var kind = Number(p.args.kind), key = String(p.args.key), k = printKey(p.tx, kind, key);
      if (prints[k]) return;
      prints[k] = { at: Number(p.args.publishTime), px: px18ToNum(p.args.px18) };
      printLanded(p.tx, kind, key, prints[k]);
    });
  }
  /* A print seen after its fill was already reported (the block feed pushes a transaction's logs one by one and
     FillPriced is the last): the card that reported the fill gets its line now. */
  function printLanded(tx, kind, key, pr) {
    var same = function (x) { return !!x && String(x).toLowerCase() === String(tx).toLowerCase(); };
    if (kind === 0) {
      if (tk.phase === 'opened' && String(tk.reqId) === key && !tk.print) { tk.print = pr; renderTicketProgress(false); }
      return;
    }
    var hit = false;
    ui.recent.forEach(function (rc) {
      var of = rc.pid != null ? rc.pid : rc.printPid;
      if (rc.printed || !same(rc.tx) || String(of) !== key) return;
      rc.printed = true; rc.lines = (rc.lines || []).concat([printLine(pr)]); hit = true;
    });
    var res = ui.phResult[key];
    if (res && same(res.tx) && !res.at) { res.at = printText(pr); hit = true; }
    if (hit) renderPositions();
  }

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
      /* v5: FillPriced of an open carries the request id in the same place (kind 0; a close's or a liquidation's
         print of a position with the same number comes back too and is left out below and in notePrints) */
      prov.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: 'latest', topics: [isV5() ? [exIface.getEvent('OpenRequestCancelled').topicHash, exIface.getEvent('FillPriced').topicHash] : exIface.getEvent('OpenRequestCancelled').topicHash, topicId(r.id)] })
    ]).then(function (res) {
      var hits = parsedLogs(res[0]).filter(function (p) { return String(p.args.requestId) === r.id; }).concat(parsedLogs(res[1]).filter(function (p) { return p.name === 'OpenRequestCancelled'; }));
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
    notePrints(logs);
    var hits = parsedLogs(logs);
    var opened = hits.filter(function (p) { return p.name === 'PositionOpened' && String(p.args.requestId) === r.id; })[0];
    var refunded = hits.filter(function (p) { return p.name === 'OpenRequestCancelled' && String(p.args.requestId) === r.id; })[0];
    var link = txHash ? txLink(txHash) : null;
    var mine = !!tk.phase && tk.reqId === r.id;
    var shows = mine ? [$('ticketProgress'), $('barStatus')] : [];
    if (opened) {
      var entry = px18ToNum(opened.args.entryPx18);
      var opr = printOf(opened.tx || txHash, 0, r.id);
      if (mine) tkSet('opened', { entry: entry, posId: String(opened.args.positionId), print: opr });
      freshPosition(String(opened.args.positionId));
      try { tpslNoteFill(r.id, String(opened.args.positionId), opened.args, heads.tsByBlock[opened.block] != null ? heads.tsByBlock[opened.block] : 0); } catch (e) { /* ignore */ }
      try { tpslAdopt(r.id, String(opened.args.positionId), opened.args); } catch (e) { /* the rule never blocks the result */ }
      try { trigAdopt(r.id, String(opened.args.positionId), heads.tsByBlock[opened.block] != null ? heads.tsByBlock[opened.block] : 0, r.instrumentId); } catch (e) { /* the read after it is the chain's word */ }
      resultToast(shows, 'Opened ' + sideWord(r.isLong) + ' ' + sym + ' ' + r.leverage + 'x at ' + fmtPrice(entry, sz) + (opr ? ' (' + printText(opr) + ')' : '') + '.', 'ok', link);
      tourEvent('opened');
    } else if (refunded) {
      var why = refundWhy(refunded.args.reason, sym, r.isLong);
      try { tpslDropPending(r.id); } catch (e) { /* ignore */ }
      delete trig.parked[String(r.id)];      /* v6: levels parked on a refunded request are never used */
      if (mine) tkSet('refunded', { msg: "Didn't open: " + why + '. Your ' + fmtUsdShort(reqIn(r)) + ' is back in your balance.' });
      /* (CF_PNL) where the order's card was, at once */
      if (r.instrumentId != null) showOpenEnd('f' + r.id, r, "Didn't open", "Didn't open: " + why + '. ' + fmtUsd(reqIn(r)) + ' is back in your balance.');
      resultToast(shows.concat([recentEl('f' + r.id), phEndRow('f' + r.id)]), "Didn't open: " + why + '. ' + fmtUsd(reqIn(r)) + ' is back in your balance.', 'err', link);
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
    return Promise.all([prov.getLogs({
      address: cfg.contracts.exchange, fromBlock: from, toBlock: 'latest',
      topics: [[t('PositionClosed'), t('PositionLiquidated'), t('CloseRequestCancelled')].concat(isV5() ? [t('PositionPartiallyClosed'), t('FillPriced'), t('TradeFeeCharged'), t('MarginReturned')] : []), topicId(pid)]
    }), trigFireLogs(prov, from, pid)]).then(function (both) {
      var logs = both[0];
      trigNoteLogs(both[1]);
      /* FillPriced is only read for its print (notePrints) and TradeFeeCharged for the fee of the fill: neither alone
         is an outcome (an open's print whose request id equals this position id matches the same filter, and so does
         the open fee of this position) */
      var hits = parsedLogs(logs).filter(function (p) { return p.name !== 'FillPriced' && p.name !== 'TradeFeeCharged' && p.name !== 'MarginReturned'; });
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

  /* v5: what a fill charged as its size fee (TradeFeeCharged of this position and kind, 0 an open and 1 a close,
     in one transaction's logs), in dollars; 0 when it charged none. */
  function chargedIn(logs, pid, kind, tx) {
    var sum = 0;
    if (!isV5()) return 0;
    parsedLogs(logs).forEach(function (p) {
      if (p.name !== 'TradeFeeCharged' || String(p.args.positionId) !== String(pid) || Number(p.args.kind) !== kind) return;
      if (tx && p.tx && String(p.tx).toLowerCase() !== String(tx).toLowerCase()) return;
      sum += usd6ToNum(p.args.feeUsdc);
    });
    return sum;
  }
  /* v5: a close's result against what went in: the exchange's pnlUsdc less the close fee this fill charged and the
     open fee the closed stake paid when it opened. closed6 / rest6: a part close's closed and remaining stake.
     Without the position (a reload in between) the open fee is taken as equal to the close fee, which it is
     whenever the payout covered it. On v4 it is pnlUsdc as before. */
  function closeNet(pid, a, logs, tx, pos, closed6, rest6) {
    var pnl = usd6ToNum(a.pnlUsdc);
    if (!isV5()) return pnl;
    var charged = chargedIn(logs, pid, 1, tx), paidIn;
    if (pos && closed6 != null) paidIn = feeOnStake(usd6ToNum(closed6 + rest6), posFeeX10(pos), usd6ToNum(rest6));
    else if (pos) paidIn = posOpenFee(pos);
    else paidIn = charged;
    return pnl - charged - paidIn;
  }

  /* A close's end, as a card where the position was (and a toast): closed (P&L, what came back,
     anything owed, the borrow, Withdraw and Share), liquidated (stays until OK), or a close that did
     not go through (the position stays open). pos: the position as last read, when known. */
  /* v5 (16.1): what a liquidation gave back of margin added too late for its price (the MarginReturned of that
     position among these parsed logs), in USD; 0 when none */
  function returnedIn(parsed, pid) {
    var s = 0;
    (parsed || []).forEach(function (p) { if (p.name === 'MarginReturned' && String(p.args.positionId) === String(pid)) s += usd6ToNum(p.args.amountUsdc); });
    return s;
  }
  /* the sentence of a liquidation: what is gone, and what came back when margin was added too late to count */
  function lostWords(lost, back) {
    return back > 0 ? 'You lost the ' + fmtUsdShort(lost) + ' that was in it. The ' + fmtUsdShort(back) + ' you added came too late for that price and is back in your balance. Nothing more is owed.'
      : 'You lost the ' + fmtUsdShort(lost) + ' you put in. Nothing more is owed.';
  }
  function reportCloseOutcome(pid, logs, txHash, pos) {
    pid = String(pid);
    pos = pos || posById(pid);
    notePrints(logs);
    var hits = parsedLogs(logs).filter(function (p) { return p.name !== 'FillPriced' && p.name !== 'TradeFeeCharged' && String(p.args.positionId) === pid; });
    var closed = hits.filter(function (p) { return p.name === 'PositionClosed'; })[0];
    var liq = hits.filter(function (p) { return p.name === 'PositionLiquidated'; })[0];
    var cancelled = hits.filter(function (p) { return p.name === 'CloseRequestCancelled'; })[0];
    /* v5: the latest share close in these logs, unless a cancel came after it */
    var part = hits.filter(function (p) { return p.name === 'PositionPartiallyClosed'; }).pop() || null;
    var lastCancel = hits.filter(function (p) { return p.name === 'CloseRequestCancelled'; }).pop();
    if (part && lastCancel && hits.indexOf(lastCancel) > hits.indexOf(part)) part = null;
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
      var pnl = closeNet(pid, a, logs, closed.tx || txHash, pos);
      var paid = usd6ToNum(a.payoutUsdc);
      var exit = fmtPrice(px18ToNum(a.exitPx18), sz);
      /* v6: closed by its take profit or stop loss on chain (TriggerFired in the same transaction): it says which and at
         what price, and the receipt says when the level was crossed and when the trade closed */
      var tf = trigFiredIn(logs, pid, sz), tfs = tf ? trigFiredLine(tf).replace(/\.$/, '') : '';
      var lines = [(tf ? tfs : 'Closed at ' + exit) + ' · ' + fmtUsd(pnl, true) + ' · ' + fmtUsd(paid) + ' is back in your balance'];
      if (a.queuedUsdc > 0n) lines.push(fmtUsd(usd6ToNum(a.queuedUsdc)) + ' more is owed to you, paid automatically.');
      if (a.borrowUsdc > 0n) lines.push('Borrow: ' + fmtUsd(usd6ToNum(a.borrowUsdc)) + '.');
      /* v5 fast market: which price it closed at */
      var ctx = closed.tx || txHash, cpr = printOf(ctx, 1, pid);
      var tfr = tf ? trigReceiptLine(tf, closed.block != null && heads.tsByBlock[closed.block] != null ? heads.tsByBlock[closed.block] : 0) : '';
      if (tfr) lines.push(tfr); else if (cpr) lines.push(printLine(cpr));
      var tsn = isV6() ? trigSeenLine(pid, tf, sz) : '';
      if (tsn) lines.push(tsn);
      var win = pnl > 0 && !!window.ConfettiShare;
      var openShare = function () { window.ConfettiShare.open(shareTrade(pid, a, closed.block, pos, pnl)); };
      var buttons = [{ label: 'Withdraw', act: 'withdraw', fn: function () { tourEvent('withdraw'); openWithdraw(); } }];
      if (win) buttons.push({ label: 'Share', fn: openShare });
      ui.phClosed = { text: 'Closed ' + (m ? m.symbol : label) + ' · ' + fmtUsd(pnl, true) + ' · ' + fmtUsd(paid) + ' back', until: Date.now() + 6000 };
      setTimeout(renderPhPnl, 6100);
      /* the row and the Position sheet show the real figures (piece 11) */
      ui.phResult[pid] = { pnl: pnl, paid: paid, exit: exit, liq: false, borrow: usd6ToNum(a.borrowUsdc), tx: ctx, at: printText(cpr), trig: tf, receipt: tfr, seen: tsn, closedAt: closed.block != null && heads.tsByBlock[closed.block] != null ? heads.tsByBlock[closed.block] : 0 };
      addRecent({
        tx: ctx, printed: !!cpr || !!tfr,
        key: 'c' + pid, pid: pid, cls: pnl >= 0 ? 'is-win' : 'is-loss', title: (tf ? (tf.kind === 0 ? 'Take profit · ' : 'Stop loss · ') : 'Closed ') + label, lines: lines, buttons: buttons, ttl: 60000,
        money: fmtUsd(pnl, true), moneyCls: pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '', ph: (tf ? tfs : 'Closed at ' + exit) + ' · ' + fmtUsd(paid) + ' is back in your balance'
      });
      /* the result card says all of it (with Share); a toast only when that card is out of sight */
      var tst = resultToast([recentEl('c' + pid), phSheetFor(pid)], (tf ? tfs + ', your ' + label : 'Closed ' + label) + ': ' + fmtUsd(pnl, true) + '. ' + fmtUsd(paid) + ' is back in your balance.', pnl >= 0 ? 'ok' : 'err', link, win ? 30000 : null);
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
      /* what was put in and is gone: the collateral and, on v5, the open fee paid at the fill */
      var lost = usd6ToNum(liq.args.marginUsdc) + posOpenFee(pos);
      var lpx = fmtPrice(px18ToNum(liq.args.exitPx18), sz);
      var ltx = liq.tx || txHash, lpr = printOf(ltx, 2, pid);
      /* v5 (16.1): margin added too late for the price that liquidated it was never at stake: it is back in the
         balance (MarginReturned), and the loss is what the position held before that add */
      var back = returnedIn(hits, pid);
      /* v6: a print past the liquidation price with a stop inside it: the stop's fire, settled as a liquidation */
      var ltf = trigFiredIn(logs, pid, sz);
      if (ltf && ltf.kind !== 2) ltf = null;
      var lsn = isV6() ? trigSeenLine(pid, ltf, sz) : '';
      ui.phResult[pid] = { liq: true, lost: lost, back: back, exit: lpx, tx: ltx, at: printText(lpr), trig: ltf, seen: lsn };
      var llines = [(ltf ? trigFiredLine(ltf) + ' ' : '') + 'Your ' + label + ' was liquidated at ' + lpx + '. ' + lostWords(lost, back)];
      if (lpr) llines.push(printLine(lpr));
      if (lsn) llines.push(lsn);
      addRecent({ tx: ltx, printed: !!lpr, key: 'l' + pid, pid: pid, cls: 'is-loss', title: 'Liquidated', lines: llines, money: fmtUsd(-lost, true), moneyCls: 'neg' });
      resultToast([recentEl('l' + pid), phSheetFor(pid)], 'Your ' + label + ' was liquidated. ' + lostWords(lost, back), 'err', link);
    } else if (part) {
      reportShareClose(pid, part, pos, label, m ? m.symbol : label, sz, link, logs);
    } else if (cancelled) {
      delete ui.settling[pid];
      toast('Your ' + label + " close didn't go through (" + reasonText(cancelled.args.reason) + '). The position is still open.', 'err', link);
    } else {
      toast('Your ' + label + ' close is done.', null, link);
    }
    renderPositions();
  }

  /* v5: a share close settled (PositionPartiallyClosed). The position stays open under its id with
     the rest, so the result is a card of its own at the top of Your positions (about a minute), the
     phone's bar and its Position sheet say it, and the position's card redraws with the rest.
     Reported once per transaction. */
  function reportShareClose(pid, part, pos, label, sym, sz, link, logs) {
    delete ui.settling[pid];
    var key = part.tx + ':' + pid;
    if (ui.partials[key]) return;
    ui.partials[key] = true;
    var a = part.args;
    var share = fmtBps(Number(a.bps));
    var pnl = closeNet(pid, a, logs, part.tx, pos, BigInt(a.closedMarginUsdc), BigInt(a.marginUsdc)), paid = usd6ToNum(a.payoutUsdc);
    var exit = fmtPrice(px18ToNum(a.exitPx18), sz);
    var rest = usd6ToNum(BigInt(a.marginUsdc) + BigInt(a.addedMarginUsdc)) + (pos ? feeOnStake(usd6ToNum(a.marginUsdc), posFeeX10(pos)) : 0);
    var lines = ['Closed ' + share + ' at ' + exit + ' · ' + fmtUsd(pnl, true) + ' · ' + fmtUsd(paid) + ' is back in your balance'];
    if (a.queuedUsdc > 0n) lines.push(fmtUsd(usd6ToNum(a.queuedUsdc)) + ' more is owed to you, paid automatically.');
    if (a.borrowUsdc > 0n) lines.push('Borrow: ' + fmtUsd(usd6ToNum(a.borrowUsdc)) + '.');
    var spr = printOf(part.tx, 1, pid);
    if (spr) lines.push(printLine(spr));
    lines.push('Still open: ' + fmtUsd(rest) + ' put in' + (pos ? ', ' + fmtUsd(usd6ToNum(a.marginUsdc) * pos.leverage) + ' size' : '') + '.');
    var said = 'Closed ' + share + ' · ' + fmtUsd(pnl, true) + ' · ' + fmtUsd(paid) + ' back';
    ui.phClosed = { text: 'Closed ' + share + ' ' + sym + ' · ' + fmtUsd(pnl, true) + ' · ' + fmtUsd(paid) + ' back', until: Date.now() + 6000 };
    setTimeout(renderPhPnl, 6100);
    pm.done = { pid: pid, text: said + '. The rest stays open.', until: Date.now() + 15000 };
    pm.last[pid] = { kind: 'part', bps: Number(a.bps), pnl: pnl, paid: paid, exit: exit, at: Date.now() };
    var rkey = 's' + key;
    addRecent({
      tx: part.tx, printPid: pid, printed: !!spr,
      key: rkey, cls: pnl >= 0 ? 'is-win' : 'is-loss', title: 'Closed ' + share + ' of ' + label, lines: lines, ttl: 60000,
      /* Close the rest: the whole position on the Close button's path, at once */
      buttons: [{ label: 'Close the rest', cls: 'go-close', fn: function () {
        var now = posById(pid);
        if (!now) return;
        if (acct.closeReqs[pid] || ui.closing[pid]) { toast(closePendingSay(pid), 'warn'); return; }
        dropRecent(rkey);
        submitClose(now);
      } }, { label: 'Withdraw', act: 'withdraw', fn: function () { openWithdraw(); } }],
      money: fmtUsd(pnl, true), moneyCls: pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '', ph: 'Closed ' + share + ' at ' + exit + ' · ' + fmtUsd(paid) + ' is back in your balance'
    });
    resultToast([recentEl(rkey), phSheetFor(pid)], 'Closed ' + share + ' of your ' + label + ': ' + fmtUsd(pnl, true) + '. ' + fmtUsd(paid) + ' is back in your balance; the rest stays open.', pnl >= 0 ? 'ok' : 'err', link);
  }

  /* v5: a position takes one close request at a time (CloseAlreadyPending): what a trader asking for more while a
     share is on its way is told. */
  function closePendingSay(pid) {
    var cr = acct.closeReqs[String(pid)], b = cr ? cr.bps : ui.closing[String(pid)];
    return 'Closing' + (b > 0 && b < 10000 ? ' ' + fmtBps(b) : '') + '… you can close the rest when it fills.';
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
  function shareTrade(pid, a, closeBlock, pos, net) {
    pid = String(pid);
    /* v5: the card says the result against what went in (net, from the close's own report or History's row) */
    var hrow = net == null && isV5() ? hist.rows.filter(function (x) { return x.name === 'PositionClosed' && String(x.args.positionId) === pid; })[0] : null;
    if (net == null && hrow) net = histNet(hrow);
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
        exit: px18ToNum(a.exitPx18), pnl: net != null ? net : usd6ToNum(a.pnlUsdc), openTs: o.ts, closeTs: r[1],
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
      if (win) win.opener = null; sm.orOpened = true;   /* [simple] hook: the checkout's tab cannot reach this page, and Simple learns that it opened */
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
     fills the amount with the new USDC, so the next tap is the deposit. (2026-11-05, the owner: "you only allow the
     user to use the max amount they can from their wallet. it needs to be a fill in amount", then "it just has to be
     that max can be a choice but people fill in the amount") The amount is a box the trader fills in; Max fills the
     most this wallet can swap (0.03 HYPE stays for gas). */
  var DEP_SWAP_RESERVE_WEI = 30000000000000000n;
  var depSwap = { quote: null, busy: false, seq: 0, hypeWei: null, amtKey: null, timer: null };
  /* a wei amount as a number for an input box, cut (never rounded up) to 6 decimals */
  function weiDown(wei) {
    var s = window.ethers.formatUnits(wei, 18), i = s.indexOf('.');
    return i < 0 ? s : s.slice(0, i + 7).replace(/\.?0+$/, '');
  }
  function depSwapMaxWei() { return ui.hypeWei != null && ui.hypeWei > DEP_SWAP_RESERVE_WEI ? ui.hypeWei - DEP_SWAP_RESERVE_WEI : 0n; }
  /* what the box asks for: the amount filled in, or why there is no swap yet */
  function depSwapWanted() {
    var inp = $('depSwapAmt'), max = depSwapMaxWei();
    var raw = inp ? String(inp.value || '').trim() : '';
    if (!raw || !(Number(raw) > 0)) return { wei: 0n, why: 'Type how much HYPE to swap, or tap Max for the most (0.03 HYPE stays for gas).' };
    var wei;
    try { wei = window.ethers.parseUnits(raw, 18); } catch (e) { return { wei: 0n, why: 'Type the amount as a number, like 0.5.' }; }
    if (wei > max) return { wei: 0n, why: 'This wallet can swap up to ' + weiDown(max) + ' HYPE: 0.03 HYPE stays for gas.' };
    return { wei: wei };
  }
  function depSwapSay(amountIn, out) {
    var buys = Number(window.ethers.formatUnits(swNet(out), 6));
    var keep = ui.hypeWei != null && ui.hypeWei > amountIn ? ui.hypeWei - amountIn : 0n;
    var under = buys + acct.walletUsdc < minMargin();
    return swFmt(amountIn, 18) + ' HYPE buys about ' + fmtUsd(buys) + ' on HyperSwap' + (swFeeBips() ? ', Confetti fee ' + (swFeeBips() / 100) + '% included' : '') + '; '
      + swFmt(keep, 18) + ' HYPE stays in the wallet' + (keep <= DEP_SWAP_RESERVE_WEI + DEP_SWAP_RESERVE_WEI / 10n ? ' for gas.' : '.')
      + (under ? ' That is under the ' + fmtUsdShort(minMargin()) + ' minimum for a trade: swap a little more, or add USDC too.' : ' One confirm in your wallet, then deposit it.');
  }
  function depSwapShow() {
    if (!(wallet.account && (!DEMO || demoOpt('swap') === '1') && window.ethers && swReady() && swRoute('HYPE', 'USDC') && ui.hypeWei != null && acct.walletUsdc < minMargin())) return false;
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
    if (!show) { depSwap.quote = null; depSwap.hypeWei = null; depSwap.amtKey = null; return; }
    var want = depSwapWanted(), amountIn = want.wei, key = String(amountIn);
    if (depSwap.busy || (depSwap.hypeWei === ui.hypeWei && depSwap.amtKey === key && (want.why || (depSwap.quote && Date.now() - (depSwap.quote.at || 0) < SW_QUOTE_FRESH_MS)))) { depSwapRenderGo(); return; }   // same stack and amount, a quote still fresh
    var T = swTokens(), route = swRoute('HYPE', 'USDC');
    depSwap.hypeWei = ui.hypeWei; depSwap.amtKey = key; depSwap.quote = null; depSwapRenderGo();
    setText('depSwapText', 'Trades are in USDC, not HYPE. This wallet has ' + (Number(ui.hypeWei) / 1e18).toFixed(2) + ' HYPE and '
      + (acct.walletUsdc >= 0.01 ? fmtUsd(acct.walletUsdc) + ' USDC, under the ' + fmtUsdShort(minMargin()) + ' minimum.' : 'no USDC.'));
    if (want.why) { setText('depSwapHint', want.why); return; }
    setText('depSwapHint', 'Getting a quote…');
    var seq = ++depSwap.seq;
    swV3Quote(route, T.HYPE.addr, amountIn).then(function (r) {
      if (seq !== depSwap.seq) return;
      var minOut = r.out > 0n ? swMinOut(r.out, 1, r.impact) : null;
      if (minOut == null) { setText('depSwapHint', 'That much moves the pool too far for one swap. Try a smaller amount.'); depSwapRenderGo(); return; }
      swNoteHypeUsd(amountIn, r.out);
      depSwap.quote = { route: route, amountIn: amountIn, out: r.out, minOut: minOut, impact: r.impact, at: Date.now(), slip: 1 };
      setText('depSwapHint', depSwapSay(amountIn, r.out));
      depSwapRenderGo();
    }).catch(function () {
      if (seq !== depSwap.seq) return;
      setText('depSwapHint', 'No quote right now. Try again in a moment.'); depSwapRenderGo();
    });
  }
  function depSwapRenderGo() {
    var b = $('depSwapGo'); if (!b) return;
    var q = depSwap.quote;
    b.textContent = depSwap.busy ? 'Swapping…' : q ? 'Swap ' + swFmt(q.amountIn, 18) + ' HYPE for ' + fmtUsd(Number(window.ethers.formatUnits(swNet(q.out), 6))) : 'Swap HYPE for USDC';
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
        setText('depSwapHint', depSwapSay(fq.amountIn, fq.out));
        if (fq.worse) { depSwap.busy = false; depSwapRenderGo(); setText('depSwapHint', 'The price moved: the button shows the new amount. Tap it again to swap at that.'); throw SW_STOP; }
      }
      q = fq; desc = 'Swap ' + swFmt(q.amountIn, 18) + ' HYPE for USDC';
      setText('depSwapHint', 'Confirm the swap in your wallet.');
      return swSend(q, T.HYPE, T.USDC, desc);
    }).then(function (rc) {
      toast(desc + ': done.', 'ok', txLink(rc.hash));
      depSwap.quote = null; depSwap.hypeWei = null; depSwap.amtKey = null;
      var dsa = $('depSwapAmt'); if (dsa) dsa.value = '';
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
      var dsa = $('depSwapAmt');
      if (dsa) dsa.addEventListener('input', function () { clearTimeout(depSwap.timer); depSwap.timer = setTimeout(renderDepSwap, 400); });
      var dsm = $('depSwapMax');
      if (dsm) dsm.addEventListener('click', function () { var i = $('depSwapAmt'), m = depSwapMaxWei(); if (i) i.value = m > 0n ? weiDown(m) : ''; renderDepSwap(); });
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
    var amSw = $('amSwitch');
    if (amSw) amSw.addEventListener('click', function () { closeDialog('acctModal'); switchWallet(); });
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
    /* v5: openedMargin (position id -> the stake it opened with, USD) and fees (position id -> { open, close:
       { tx hash -> fee } }, what TradeFeeCharged says each fill took) */
    return { rows: [], seen: {}, openedMarket: {}, openedSide: {}, openedLong: {}, openedEntry: {}, openedMargin: {}, fees: {}, back: {}, scannedFrom: null, scannedTo: null, loading: false, done: false, chunked: false, blockTs: {} };
  }

  var hist = freshHistory();

  function fetchLogs(prov, from, to) {
    var E = window.ethers;
    var user = E.zeroPadValue(wallet.account, 32);
    var t = function (n) { return exIface.getEvent(n).topicHash; };
    var addr = cfg.contracts.exchange;
    var q1 = { address: addr, fromBlock: from, toBlock: to, topics: [[t('Deposited'), t('Withdrawn')], user] };
    /* the account is the second indexed field of each of these (owner / recipient / trader) */
    var q2 = { address: addr, fromBlock: from, toBlock: to, topics: [[t('PositionOpened'), t('PositionClosed'), t('PositionLiquidated'), t('QueueAppended'), t('QueuePaid'), t('OpenRequestCancelled')].concat(isV5() ? [t('PositionPartiallyClosed'), t('MarginAdded'), t('MarginReturned'), t('TradeFeeCharged')] : []), null, user] };
    return Promise.all([prov.getLogs(q1), prov.getLogs(q2)]).then(function (r) {
      var logs = r[0].concat(r[1]);
      if (!isV5()) return logs;
      /* v5: the Pyth print each of these fills used. FillPriced is indexed by request id (an open) or position id (a
         close, a liquidation), not by account, so it is asked for by those ids, 50 at a time; a read that fails
         only leaves the rows without their "price at" words. */
      var keys = {};
      parsedLogs(r[1]).forEach(function (p) {
        if (p.name === 'PositionOpened') keys[topicId(p.args.requestId)] = true;
        else if (p.name === 'PositionClosed' || p.name === 'PositionLiquidated' || p.name === 'PositionPartiallyClosed') keys[topicId(p.args.positionId)] = true;
      });
      var ks = Object.keys(keys), jobs = [];
      for (var i = 0; i < ks.length; i += 50) jobs.push(prov.getLogs({ address: addr, fromBlock: from, toBlock: to, topics: [t('FillPriced'), ks.slice(i, i + 50)] }).then(notePrints, function () {}));
      return Promise.all(jobs).then(function () { return logs; });
    });
  }

  /* v5: "price at 12:03:05, Pyth" for a history row whose fill used a Pyth print, else '' */
  function histPrint(r) {
    if (!isV5() || !r || !r.tx) return '';
    var a = r.args;
    return printText(r.name === 'PositionOpened' ? printOf(r.tx, 0, a.requestId)
      : r.name === 'PositionClosed' || r.name === 'PositionPartiallyClosed' ? printOf(r.tx, 1, a.positionId)
      : r.name === 'PositionLiquidated' ? printOf(r.tx, 2, a.positionId) : null);
  }

  function addLogs(logs) {
    logs.forEach(function (log) {
      var key = log.transactionHash + ':' + log.index;
      if (hist.seen[key]) return;
      var p;
      try { p = exIface.parseLog({ topics: Array.from(log.topics), data: log.data }); } catch (e) { p = null; }
      if (!p) return;
      hist.seen[key] = true;
      /* v5: what a fill took as its size fee is kept against its position, not shown as a row of its own */
      if (p.name === 'TradeFeeCharged') {
        var fk = String(p.args.positionId), hf = hist.fees[fk] || (hist.fees[fk] = { open: 0, close: {} });
        if (Number(p.args.kind) === 0) hf.open = usd6ToNum(p.args.feeUsdc);
        else hf.close[String(log.transactionHash).toLowerCase()] = usd6ToNum(p.args.feeUsdc);
        return;
      }
      /* v5 (16.1): what a liquidation gave back, kept against its transaction for the liquidation's own row too */
      if (p.name === 'MarginReturned') hist.back[String(p.args.positionId) + ':' + String(log.transactionHash).toLowerCase()] = usd6ToNum(p.args.amountUsdc);
      if (p.name === 'PositionOpened') {
        hist.openedMargin[String(p.args.positionId)] = usd6ToNum(p.args.marginUsdc);
        hist.openedMarket[String(p.args.positionId)] = Number(p.args.instrumentId);
        hist.openedSide[String(p.args.positionId)] = sideLev(p.args.isLong, p.args.leverage);
        hist.openedLong[String(p.args.positionId)] = !!p.args.isLong;
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

  /* v5: the size fees of one History row. A close: what that fill charged (close) and the share of the open fee
     that the closed stake paid (open: all of it for a whole close, less what earlier part closes took along; by
     stake for a part). A liquidation: the open fee still on the position. Zeros on v4 and where none was charged.
     When the open is not loaded yet, a close takes its open share as equal to its close fee, which it is whenever
     the payout covered it. */
  function histFees(r) {
    var out = { open: 0, close: 0 };
    if (!isV5() || !r || !r.args || r.args.positionId == null) return out;
    var pid = String(r.args.positionId), hf = hist.fees[pid], a = r.args;
    if (r.name === 'PositionOpened') { out.open = hf ? hf.open : 0; return out; }
    if (r.name !== 'PositionClosed' && r.name !== 'PositionPartiallyClosed' && r.name !== 'PositionLiquidated') return out;
    out.close = hf && r.tx ? hf.close[String(r.tx).toLowerCase()] || 0 : 0;
    var m0 = hist.openedMargin[pid];
    if (!hf || !(hf.open > 0) || !(m0 > 0)) { out.open = out.close; return out; }
    if (r.name === 'PositionPartiallyClosed') { out.open = hf.open * usd6ToNum(a.closedMarginUsdc) / m0; return out; }
    var gone = 0;
    hist.rows.forEach(function (x) {
      if (x.name === 'PositionPartiallyClosed' && String(x.args.positionId) === pid && (x.block < r.block || (x.block === r.block && x.index < r.index))) gone += usd6ToNum(x.args.closedMarginUsdc);
    });
    out.open = Math.max(0, hf.open * (1 - gone / m0));
    return out;
  }
  /* a close's result against what went in (v5: the exchange's pnlUsdc less both size fees); on v4 pnlUsdc itself */
  function histNet(r) { var hf = histFees(r); return usd6ToNum(r.args.pnlUsdc) - hf.close - hf.open; }
  /* " · fee $0.80": the size fees of a row, said plainly on the Pro History ('' when none) */
  function histFeeWord(r) { var hf = histFees(r), s = hf.open + hf.close; return s > 0 ? ' · fee ' + fmtUsd(s) : ''; }

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
        /* what went in: the stake and, on v5, the open fee taken with it */
        d.amount = usd6ToNum(a.marginUsdc) + histFees(r).open; d.signed = false;
        d.details = 'put in · at ' + fmtPrice(px18ToNum(a.entryPx18), szFor()) + (histFees(r).open > 0 ? ' · fee ' + fmtUsd(histFees(r).open) + ' of it' : '');
        break;
      case 'PositionClosed':
        d.label = 'Closed';
        pid();
        d.amount = histNet(r);
        var en = hist.openedEntry[d.id];
        d.details = (en ? fmtPrice(en, szFor()) + ' → ' : 'at ') + fmtPrice(px18ToNum(a.exitPx18), szFor()) + ' · ' + fmtUsd(usd6ToNum(a.payoutUsdc)) + ' back';
        if (a.feeUsdc > 0n && a.pnlUsdc > 0n) d.details += ' · fee ' + fmtUsd(usd6ToNum(a.feeUsdc)) + ' of the win';
        d.details += histFeeWord(r);
        if (a.borrowUsdc > 0n) d.details += ' · borrow ' + fmtUsd(usd6ToNum(a.borrowUsdc));
        if (a.queuedUsdc > 0n) d.details += ' · ' + fmtUsd(usd6ToNum(a.queuedUsdc)) + ' owed';
        break;
      case 'PositionLiquidated':
        d.label = 'Liquidated';
        pid();
        /* what was put in and is gone: the collateral and, on v5, the open fee paid at the fill */
        d.amount = -(usd6ToNum(a.marginUsdc) + histFees(r).open);
        d.details = 'at ' + fmtPrice(px18ToNum(a.exitPx18), szFor());
        d.back = hist.back[String(a.positionId) + ':' + String(r.tx).toLowerCase()] || 0;
        if (d.back > 0) d.details += ' · ' + fmtUsd(d.back) + ' of late margin returned';
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
      /* v5: a share close (the position stays open) and margin added to a position */
      case 'PositionPartiallyClosed':
        d.label = 'Closed ' + fmtBps(a.bps);
        pid();
        d.amount = histNet(r);
        var pen = hist.openedEntry[d.id];
        d.details = (pen ? fmtPrice(pen, szFor()) + ' → ' : 'at ') + fmtPrice(px18ToNum(a.exitPx18), szFor()) + ' · ' + fmtUsd(usd6ToNum(a.payoutUsdc)) + ' back';
        if (a.feeUsdc > 0n && a.pnlUsdc > 0n) d.details += ' · fee ' + fmtUsd(usd6ToNum(a.feeUsdc)) + ' of the win';
        d.details += histFeeWord(r);
        if (a.borrowUsdc > 0n) d.details += ' · borrow ' + fmtUsd(usd6ToNum(a.borrowUsdc));
        if (a.queuedUsdc > 0n) d.details += ' · ' + fmtUsd(usd6ToNum(a.queuedUsdc)) + ' owed';
        d.details += ' · the rest stays open';
        break;
      case 'MarginAdded':
        d.label = 'Margin added';
        pid();
        d.amount = usd6ToNum(a.amountUsdc); d.signed = false;
        d.details = 'liquidation now ' + fmtPrice(px18ToNum(a.bustPx18), szFor());
        break;
      /* v5 (16.1): margin added too late for the price that liquidated the position, back in the balance */
      case 'MarginReturned':
        d.label = 'Margin returned';
        pid();
        d.amount = usd6ToNum(a.amountUsdc); d.signed = false;
        d.details = 'added too late for the price that liquidated it';
        break;
    }
    d.print = histPrint(r);
    if (d.print) d.details = d.details ? d.details + ' · ' + d.print : d.print;
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
      case 'PositionOpened': parts.push('at ' + fmtPrice(px18ToNum(a.entryPx18), sz)); if (d.print) parts.push(d.print); break;
      case 'PositionClosed':
        var en = hist.openedEntry[d.id];
        parts.push((en ? fmtPrice(en, sz) + ' → ' : 'at ') + fmtPrice(px18ToNum(a.exitPx18), sz));
        parts.push(fmtUsd(usd6ToNum(a.payoutUsdc)) + ' back');
        if (a.feeUsdc > 0n && a.pnlUsdc > 0n) parts.push('fee ' + fmtUsd(usd6ToNum(a.feeUsdc)) + ' of the win');
        if (histFeeWord(r)) parts.push(histFeeWord(r).slice(3));
        if (a.borrowUsdc > 0n) parts.push('borrow ' + fmtUsd(usd6ToNum(a.borrowUsdc)));
        if (a.queuedUsdc > 0n) parts.push(fmtUsd(usd6ToNum(a.queuedUsdc)) + ' owed');
        if (d.print) parts.push(d.print);
        cls = d.amount > 0 ? ' is-win' : d.amount < 0 ? ' is-loss' : '';
        break;
      case 'PositionLiquidated':
        parts.push('at ' + fmtPrice(px18ToNum(a.exitPx18), sz));
        if (d.print) parts.push(d.print);
        sentence = lostWords(-d.amount, d.back || 0);
        cls = ' is-liq';
        break;
      case 'QueueAppended': parts.push('paid automatically'); break;
      case 'QueuePaid': if (d.details) parts.push(d.details); break;
      case 'MarginReturned': parts.push(d.details); break;
      case 'OpenRequestCancelled': if (d.details) parts.push(d.details); break;
      case 'PositionPartiallyClosed': parts.push(d.details); cls = d.amount > 0 ? ' is-win' : d.amount < 0 ? ' is-loss' : ''; break;
      case 'MarginAdded': parts.push(d.details); break;
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
    syncTradeMarkers();
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
          syncTradeMarkers();
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
      setText('stInst', '#' + inst.id + ' · HL ' + inst.hlAssetIndex + ' · sz ' + inst.szDecimals + ' · tier ' + tierLetter(m) + (inst.retired ? ' · retired' : inst.opensPaused ? ' · paused' : '') + (fastOf(inst.id) ? ' · fast price (Pyth), ' + fastOf(inst.id).delay + ' s' : ''));
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
    var vaults = loadVaults(a);
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
      return vaults;
    });
  }

  /* The wallet's extra codes (CodeVaultFactory): each vault's code, what it has earned in all
     and what a claim would send now (shares still in the payout queue arrive later). */
  function loadVaults(a) {
    var f = read.vaultFactory;
    if (!f || DEMO) { ref.vaults = []; ref.vaultsLoaded = false; renderVaults(); return Promise.resolve(); }
    var none = function () { return null; };
    return f.vaultsOf(a).then(function (list) {
      return Promise.all(Array.prototype.map.call(list, function (v) {
        var c = new window.ethers.Contract(v, CODE_VAULT_ABI, read.provider);
        return Promise.all([c.code().catch(none), c.earned().catch(none), c.claimable().catch(none)]).then(function (r) {
          return { addr: v, code: r[0] || '', earned: r[1] == null ? null : usd6ToNum(r[1]), claimable: r[2] == null ? null : usd6ToNum(r[2]) };
        });
      }));
    }).then(function (rows) {
      if (wallet.account !== a) return;
      ref.vaults = rows;
      ref.vaultsFor = a;
      ref.vaultsLoaded = true;
      ref.vaultsErr = false;
      renderVaults();
    }).catch(function () {
      /* keep the last list; a wallet with none loaded yet says so */
      if (wallet.account === a) { ref.vaultsErr = true; renderVaults(); }
    });
  }

  function copyLink(link) {
    var done = function () { toast('Copied ' + link); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { toast(link); });
    else toast(link);
  }

  function vaultsToClaim() {
    return ref.vaults.filter(function (v) { return v.claimable != null && v.claimable > 0; });
  }

  function renderVaults() {
    var box = $('rfMore');
    if (!box) return;
    if (DEMO || !read.vaultFactory || !wallet.account) { box.setAttribute('hidden', ''); return; }
    box.removeAttribute('hidden');
    if (ref.vaultsFor !== wallet.account) { ref.vaults = []; ref.vaultsLoaded = false; }
    var list = $('rfVaults');
    list.textContent = '';
    var earned = 0;
    ref.vaults.forEach(function (v) {
      if (v.earned != null) earned += v.earned;
      var row = el('div', 'kv refer-vault');
      var k = el('span', 'kv-key');
      var a = el('a', null, v.code || shortAddr(v.addr));
      if (v.code) { a.href = refLink(v.code); a.target = '_blank'; a.rel = 'noopener'; }
      k.appendChild(a);
      var val = el('span', 'kv-val');
      var text = (v.earned != null ? fmtUsd(v.earned) : '—') + ' earned';
      if (v.claimable != null && v.claimable > 0) text += ' · ' + fmtUsd(v.claimable) + ' to claim';
      val.appendChild(el('span', null, text));
      if (v.code) {
        var b = el('button', 'btn btn-sm', 'Copy link');
        b.type = 'button';
        b.addEventListener('click', function () { copyLink(refLink(v.code)); });
        val.appendChild(b);
      }
      row.appendChild(k); row.appendChild(val);
      list.appendChild(row);
    });
    var n = ref.vaults.length;
    setText('rfMoreTotal', !ref.vaultsLoaded ? (ref.vaultsErr ? 'not loaded yet, retrying' : '…') : n ? n + (n === 1 ? ' code · ' : ' codes · ') + fmtUsd(earned) + ' earned' : 'none yet');
    var due = vaultsToClaim().reduce(function (s, v) { return s + v.claimable; }, 0);
    var claim = $('vaultClaim');
    if (claim) {
      if (due > 0) { claim.textContent = 'Claim ' + fmtUsd(due) + ' to this wallet'; claim.removeAttribute('hidden'); }
      else claim.setAttribute('hidden', '');
      claim.disabled = state.busy;
    }
    var sub = $('vaultSubmit');
    if (sub) sub.disabled = state.busy;
  }

  function vaultFactoryWrite() {
    return new window.ethers.Contract(read.vaultFactory.target, VAULT_FACTORY_ABI, wallet.signer);
  }

  function submitVault(code) {
    if (DEMO) { toast('Demo: nothing is sent.'); return Promise.resolve(); }
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(); }
    if (!read.vaultFactory) { toast('Extra codes are not available yet.', 'err'); return Promise.resolve(); }
    setBusy(true);
    return sendTx('Create code ' + code, vaultFactoryWrite().create, [code]).then(function (r) {
      toast('Code ' + code + ' is yours: ' + refLink(code), 'ok', txLink(r.hash));
      var input = $('vaultCode'); if (input) input.value = '';
      return loadReferral();
    }).catch(function (e) {
      toast('Create failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); renderVaults(); });
  }

  function submitVaultClaim() {
    if (DEMO) { toast('Demo: nothing is sent.'); return Promise.resolve(); }
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(); }
    var due = vaultsToClaim();
    if (!due.length) return Promise.resolve();
    var total = due.reduce(function (s, v) { return s + v.claimable; }, 0);
    setBusy(true);
    return sendTx('Claim referral earnings', vaultFactoryWrite().claimAll, [due.map(function (v) { return v.addr; })]).then(function (r) {
      toast('Sent about ' + fmtUsd(total) + ' USDC to your wallet.', 'ok', txLink(r.hash));
      return Promise.all([loadReferral(), refreshWalletUsdc()]);
    }).catch(function (e) {
      toast('Claim failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); renderVaults(); });
  }

  function refLink(code) { return SITE_URL + '?ref=' + code; }

  function renderRefer() {
    renderVaults();
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
        copyLink(refLink(ref.myCode));
      });
    }
    var vForm = $('vaultForm');
    var vInput = $('vaultCode');
    var vHint = $('vaultHint');
    if (vForm) {
      vForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (state.busy || vaultChecking) return;
        var code = String(vInput.value || '').trim().toLowerCase();
        if (!REF_RE.test(code)) { vHint.textContent = '3 to 16 characters: a-z, 0-9, underscore.'; vHint.classList.add('is-err'); return; }
        vHint.classList.remove('is-err');
        vHint.textContent = VAULT_HINT;
        var rc = referralsRead();
        var check = rc ? rc.codeToReferrer(code).catch(function () { return ZERO; }) : Promise.resolve(ZERO);
        vaultChecking = true;
        check.then(function (owner) {
          vaultChecking = false;
          if (isAddr(owner)) { vHint.textContent = 'Code "' + code + '" is taken.'; vHint.classList.add('is-err'); return; }
          return submitVault(code);
        }, function () { vaultChecking = false; });
      });
    }
    var vClaim = $('vaultClaim');
    if (vClaim) vClaim.addEventListener('click', function () { if (!state.busy) submitVaultClaim(); });
  }

  var vaultChecking = false;
  var VAULT_HINT = 'Each extra code is a small contract of its own that pays only you. Its earnings wait there until you claim them to this wallet.';

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
    var cb = $('chainBannerGo'); if (cb) cb.addEventListener('click', function () {
      if (cb.disabled) return;
      cb.disabled = true; cb.textContent = 'Confirm in your wallet…';
      switchChain().then(function () { return onChainChanged(); }).catch(switchFailed).then(function () {
        cb.disabled = false; cb.textContent = 'Switch wallet to HyperEVM'; renderChainBanner();
      });
    });
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
    if (tb) tb.addEventListener('click', function () { location.href = PRACTICE_URL; });   /* (2026-11-02) the practice run on the demo, in place of the coach-mark tour */
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
    { id: 'fill', on: 'opened', sheet: true, title: function () { return 'About ' + fillSecs() + ' seconds'; },      /* this coin's own time, as the text under it */
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
    /* (2026-11-02) the tour no longer starts by itself: First steps takes a new wallet through what it needs;
       "? How to trade" replays the tour */
    if (!tour.replayAuto) return;
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
    if (setup.on) setupEnd(false);   /* the tour has the page; First steps come back when it ends */
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
    try { setupRender(); } catch (e) { /* ignore */ }
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
    try { practiceEvent(name); } catch (e) { /* the practice run never blocks a trade */ }
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

  /* ---- FIRST STEPS (the owner, 2026-11-02: "instead of a tutorial, people were forced to go to the site and the
     site at first analyzed what the user had that was necessary to use on the site, which is USDC on Hyperliquid
     ... takes them down to possibly switching to the Hyper EVM RPC if they're not. Or next you should swap ETH
     for Hyperliquid if necessary. Then you should swap for USDC on Hyperliquid. Then you should deposit USDC onto
     exchange. Then you should open up first trade ... only that section of the site is visible and the rest of
     the site is blurry"; then "if using Phantom, ignore these warnings. And shows the warnings that might come up
     with Phantom. And how to get past them").
     The page works out the next thing this wallet needs (a wallet, HyperEVM, HYPE for gas, USDC, a deposit, the
     first trade), lights the one part of the page that does it and blurs the rest, which cannot be tapped. A step
     clears itself when the wallet shows it: there is no Next. Shown until the wallet's first trade, then never
     again for that wallet (LS.setup); a wallet with any trade in its history never sees it. The "? How to trade"
     tour no longer starts by itself; it replays from its button. */
  var setup = { connectNote: null, on: false, step: null, dims: null, ring: null, card: null, ph: null, timer: null, scrolled: null, opened: null, away: false, waitSince: 0, phSet: false, swapHome: null, ethFirst: null, autoSwitch: null, aside: false };
  var SETUP_ORDER = ['connect', 'chain', 'hype', 'swap', 'deposit', 'trade'];
  /* a wallet with nothing on HyperEVM brings its ETH over first, from the chain it is already on, and switches to
     HyperEVM once, after the HYPE lands (the owner, 2026-11-04: "shouldnt it be bridge eth then connect to hyperevm?";
     it was three switches: to HyperEVM, back to the ETH chain for the bridge, then to HyperEVM again) */
  var SETUP_ORDER_ETH = ['connect', 'hype', 'chain', 'swap', 'deposit', 'trade'];
  function setupOrder() { return setup.ethFirst && setup.ethFirst === wallet.account ? SETUP_ORDER_ETH : SETUP_ORDER; }   /* per wallet */
  var SETUP_TITLES = { connect: 'Connect your wallet', chain: 'Switch to HyperEVM', hype: 'Get HYPE on HyperEVM', swap: 'Swap HYPE for USDC', deposit: 'Deposit USDC', trade: 'Open your first trade', bridge: 'Your ETH is on its way' };
  var SETUP_WAIT_MS = 8000;   /* a slow history scan does not hold a new wallet back for ever */

  function setupKey() { return LS.setup + (wallet.account ? wallet.account.toLowerCase() : 'visitor'); }
  /* which wallet the guide is reading: name and address, with Switch wallet */
  function setupWho() {
    var w = setup.card && setup.card.querySelector('[data-role="who"]'); if (!w) return;
    w.hidden = !wallet.account;
    if (!wallet.account) return;
    var name = walletName(), addr = shortAddr(wallet.account), t = name + ' · ' + addr;
    var s = w.querySelector('.setup-who-txt');
    if (s && s.getAttribute('data-t') !== t) {   /* the address never breaks: a narrow card wraps after the name */
      s.setAttribute('data-t', t); s.title = wallet.account; s.textContent = name + ' · ';
      s.appendChild(el('span', 'setup-who-addr', addr));
    }
  }
  function setupTraded() {
    return !!(acct.positions.length || acct.marginInUse > 0 || acct.pending > 0 || hist.rows.length || pendingOpenList().length);
  }
  /* a first trade tapped and on its way: not done yet (the 2026-11-05 walk: a first open the chain refused had
     already marked the guide finished, so it never came back) */
  function setupInFlight() { return !!(typeof quick === 'object' && quick && quick.list && quick.list.length); }
  /* Phantom: the connected provider says so, the remembered pick does, or (a visitor) Phantom is the wallet in this browser. */
  function setupIsPhantom() {
    try {
      var eth = wallet.eth || getInjected();
      if (eth && (eth.isPhantom || (window.phantom && window.phantom.ethereum === eth))) return true;
      if (/phantom/i.test(walletPref())) return true;
      return !wallet.eth && !!(window.phantom && window.phantom.ethereum);
    } catch (e) { return false; }
  }
  /* Get HYPE through the site's own Swap card (the owner, 2026-11-02: "use our sites swap"): a wallet with USDC on
     HyperEVM but no gas swaps a little of it for HYPE right there, pay USDC / get HYPE filled in. The card is desktop-only
     and sits below the fold of the sticky column, so the step borrows it into a host above the layout and hands it back after. */
  function setupSwapCase() { return !!(wallet.account && acct.walletUsdc >= 0.5 && $('swapCard')); }
  function setupLendFor() { return setupSwapCase() ? 'swapCard' : brOn() ? 'bridgeCard' : ''; }
  function setupSwapShow() {
    var id = setupLendFor(), card = id ? $(id) : null;
    if (!card) { setupSwapHide(); return; }
    if (setup.swapHome && setup.swapHome.id !== id) setupSwapHide();
    if (setup.swapHome) return;
    setup.swapHome = { id: id, parent: card.parentNode, next: card.nextSibling };
    var host = $('setupSwapHost'); if (host) { host.hidden = false; host.appendChild(card); }   /* every width: the desktop column keeps it below the fold */
    card.classList.add('is-setup');
    if (id !== 'swapCard') return;
    try {
      var payT = $('swPayToken'), getT = $('swGetToken'), pay = $('swPay');
      if (payT && getT && (payT.value !== 'USDC' || getT.value !== 'HYPE')) { payT.value = 'USDC'; getT.value = 'HYPE'; payT.dispatchEvent(new Event('change')); }
      if (pay && !(Number(pay.value) > 0)) { pay.value = String(Math.min(1, Math.max(0.5, Math.floor(acct.walletUsdc * 10) / 10))); pay.dispatchEvent(new Event('input')); }
    } catch (e) { /* the card still works by hand */ }
  }
  function setupSwapHide() {
    var home = setup.swapHome, card = home ? $(home.id) : null; if (!card || !home) return;
    card.classList.remove('is-setup');
    if (home.parent && card.parentNode !== home.parent) home.parent.insertBefore(card, home.next && home.next.parentNode === home.parent ? home.next : null);
    var host = $('setupSwapHost'); if (host) host.hidden = true;
    setup.swapHome = null;
  }

  /* What this wallet needs next; null when the page is for trading; 'wait' while the wallet is being read. */
  function setupStepNow() {
    if (setupIsClosed()) return null;   /* its X: closed for this wallet (the ? How to trade tour stays on the page) */
    if (DEMO && demoOpt('setup')) return demoOpt('setup');
    if (DEMO || tour.on || !window.ethers || !hasExchange()) return null;
    if (!wallet.account) return setup.away || !tour.autoTried ? null : 'connect';   /* the silent reconnect answers first */
    if (lsGet(setupKey()) === '1') return null;
    if (br.inflight || br.busy) return 'bridge';   /* the wallet is on the ETH side on purpose: hold here until the HYPE lands */
    if (wallet.chainId !== CHAIN_ID) return setupOffChain();
    if (!acct.loaded) return 'wait';
    if (setupTraded()) { lsSet(setupKey(), '1'); return null; }
    if (setupInFlight()) return 'aside';
    if ((hist.loading && !hist.done) || ui.hypeWei == null) {
      if (!setup.waitSince) setup.waitSince = Date.now();
      if (Date.now() - setup.waitSince < SETUP_WAIT_MS) return 'wait';
    }
    var min = minMargin();
    if (acct.available >= min) return 'trade';
    var gasLow = ui.hypeWei != null && ui.hypeWei < HYPE_LOW_WEI && !sessionLive();
    if (acct.walletUsdc >= min) return gasLow ? 'hype' : 'deposit';
    if (depSwapShow()) return 'swap';
    return 'hype';
  }

  /* The wallet is not on HyperEVM: nothing there to trade with and the bridge is on the page -> bring ETH first; else switch. */
  function setupOffChain() {
    if (!brOn()) return 'chain';
    if (!acct.loaded || ui.hypeWei == null || (hist.loading && !hist.done)) {
      if (!setup.waitSince) setup.waitSince = Date.now();
      return Date.now() - setup.waitSince < SETUP_WAIT_MS ? 'wait' : 'chain';
    }
    var min = minMargin();
    var empty = !setupTraded() && ui.hypeWei < HYPE_LOW_WEI && acct.available < min && acct.walletUsdc < min && !setupSwapCase();   /* HYPE here (just bridged, say): switch */
    if (empty) setup.ethFirst = wallet.account;
    return empty ? 'hype' : 'chain';
  }

  function setupRender() {
    var step;
    try { step = setupStepNow(); } catch (e) { step = null; }
    /* the first trade is on its way: the guide steps out of the way, and comes back at step 6 if it does not go in */
    if (step === 'aside') { if (setup.on) { setup.aside = true; setupEnd(false); } return; }
    if (!step) {
      if (setup.on) setupEnd(setup.step === 'trade' && !!wallet.account && lsGet(setupKey()) === '1');
      else if (setup.aside && wallet.account && lsGet(setupKey()) === '1') toast('First trade in. The whole page is yours now.', null, null, 6000);
      setup.aside = false;
      return;
    }
    setup.aside = false;
    if (!setup.on) setupBuild();
    if (step !== setup.step) setupShow(step);
    else setupPlace();
  }

  function setupBuild() {
    setup.on = true;
    setup.dims = [0, 1, 2, 3].map(function () { var d = el('div', 'setup-dim'); document.body.appendChild(d); return d; });
    setup.ring = el('div', 'setup-ring'); setup.ring.hidden = true; document.body.appendChild(setup.ring);
    var c = el('div', 'setup-card');
    c.setAttribute('role', 'dialog'); c.setAttribute('aria-label', 'First steps'); c.setAttribute('aria-live', 'polite');
    /* (the owner, 2026-11-05: "put the x to close the tutorial window heavily visible in the blurred area of the site")
       the X is a big solid button of its own in a blurred corner (setupPlaceX), no longer a faint mark in the card */
    var x = el('button', 'setup-x');
    x.type = 'button'; x.title = 'Close (Esc)'; x.setAttribute('aria-label', 'Close First steps');
    x.innerHTML = '<span class="setup-x-mark" aria-hidden="true"></span><span class="setup-x-label">Close</span>';
    x.hidden = true;
    x.addEventListener('click', setupClose);
    document.body.appendChild(x);
    setup.x = x;
    var who = el('div', 'setup-who'); who.setAttribute('data-role', 'who'); who.hidden = true;
    who.appendChild(el('span', 'setup-who-txt'));
    var swb = el('button', 'btn btn-sm btn-ghost', 'Switch wallet'); swb.type = 'button'; swb.addEventListener('click', function () { switchWallet(); });
    who.appendChild(swb);
    c.appendChild(who);
    [['count', 'setup-count'], ['title', 'setup-title'], ['text', 'setup-text']].forEach(function (r) { var n = el('div', r[1]); n.setAttribute('data-role', r[0]); c.appendChild(n); });
    c.appendChild(el('div', 'setup-btns'));
    var ph = $('setupPhantom');
    if (ph) { c.appendChild(ph); setup.ph = ph; }
    var list = el('ol', 'setup-list');
    setupFillList(list);
    c.appendChild(list);
    c.hidden = true;
    document.body.appendChild(c);
    setup.card = c;
    setup.timer = setInterval(setupPlace, 300);
    window.addEventListener('resize', setupPlace);
    window.addEventListener('scroll', setupPlace, true);
    document.addEventListener('keydown', setupEsc);
  }

  /* The X (and Esc while no sheet is open): the guide steps away for this wallet and stays away on reload. */
  function setupClosedKey() { return LS.setupClosed + (wallet.account ? wallet.account.toLowerCase() : 'visitor'); }
  function setupIsClosed() { return setup.closed || lsGet(setupClosedKey()) === '1'; }
  function setupClose() {
    if (!setup.on) return;
    setup.closed = true;   /* this visit, whatever wallet comes next */
    lsSet(setupClosedKey(), '1');
    setupEnd(false);
    toast('First steps closed. The ? How to trade button walks you through the page any time.', null, null, 7000);
  }
  function setupEsc(ev) {
    if (ev.key === 'Escape' && setup.on && setup.card && !setup.card.hidden && !document.querySelector('dialog[open]')) setupClose();
  }

  /* finished: the first trade is in (the whole page comes back for good) */
  function setupEnd(finished) {
    if (!setup.on) return;
    setup.on = false; setup.step = null; setup.opened = null; setup.waitSince = 0;
    if (setup.timer) { clearInterval(setup.timer); setup.timer = null; }
    window.removeEventListener('resize', setupPlace);
    window.removeEventListener('scroll', setupPlace, true);
    document.removeEventListener('keydown', setupEsc);
    if (setup.ph) { setup.ph.hidden = true; document.body.appendChild(setup.ph); }
    setupSwapHide();
    (setup.dims || []).concat([setup.ring, setup.card, setup.x]).forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
    setup.dims = null; setup.ring = null; setup.card = null; setup.x = null;
    renderDepSetup(false);
    if (finished) toast('First trade in. The whole page is yours now.', null, null, 6000);
  }

  /* The X sits in a blurred corner: the first corner clear of the lit box (with its step label) and the card. */
  function setupPlaceX(box) {
    var x = setup.x; if (!x) return;
    x.hidden = false;
    var vw = window.innerWidth, vh = window.innerHeight, m = vw <= 640 ? 10 : 18;
    var w = x.offsetWidth, h = x.offsetHeight;
    var cr = setup.card && !setup.card.hidden ? setup.card.getBoundingClientRect() : null;
    function hits(l, t, r) { return r && l < r.right + 8 && l + w > r.left - 8 && t < r.bottom + 8 && t + h > r.top - 8; }
    var spots = [[vw - w - m, m], [vw - w - m, vh - h - m], [m, m], [m, vh - h - m]];
    var pick = spots[0];
    for (var i = 0; i < spots.length; i++) {
      if (!hits(spots[i][0], spots[i][1], box) && !hits(spots[i][0], spots[i][1], cr)) { pick = spots[i]; break; }
    }
    x.style.left = Math.round(pick[0]) + 'px';
    x.style.top = Math.round(pick[1]) + 'px';
  }

  function setupFillList(list) {
    var ids = setupOrder();
    if (list.getAttribute('data-order') === ids.join()) return;
    list.setAttribute('data-order', ids.join()); list.textContent = '';
    ids.forEach(function (id) { var li = el('li', '', SETUP_TITLES[id]); li.setAttribute('data-step', id); list.appendChild(li); });
  }

  function setupShow(step) {
    setup.step = step; setup.scrolled = null;
    if (step !== 'wait') setup.waitSince = 0;
    if (setup.autoSwitch && step !== 'wait') {   /* just connected off HyperEVM: the switch prompt Connect used to send */
      var autoGo = step === 'chain' && setup.autoSwitch === wallet.account;
      setup.autoSwitch = null;
      if (autoGo) switchChain().then(function () { return onChainChanged(); }).catch(switchFailed);
    }
    var lst = setup.card.querySelector('.setup-list'); if (lst) setupFillList(lst);
    var n = setupOrder().indexOf(step === 'bridge' ? 'hype' : step);
    setRole(setup.card, 'count', n < 0 ? 'Checking' : 'Step ' + (n + 1) + ' of ' + setupOrder().length);
    setRole(setup.card, 'title', step === 'wait' ? 'Checking what you have' : SETUP_TITLES[step]);
    setupButtons(step);
    setupWho();
    if (setup.ph) {
      setup.ph.hidden = step === 'wait';
      var det = setup.ph.querySelector('details');
      if (det && !setup.phSet) { det.open = setupIsPhantom(); setup.phSet = true; }
    }
    Array.prototype.forEach.call(setup.card.querySelectorAll('.setup-list li'), function (li, k) {
      li.classList.toggle('is-done', n >= 0 && k < n);
      li.classList.toggle('is-now', k === n);
    });
    setupAutoOpen();
    if (step === 'hype') { setupSwapShow(); brFollowWallet(); } else setupSwapHide();
    setupPlace();
  }

  /* The swap and the deposit live in Add USDC: open it once per step, once the wallet is on HyperEVM (a closed
     sheet leaves a button on the card that opens it again). */
  function setupAutoOpen() {
    var step = setup.step;
    if (!(step === 'swap' || step === 'deposit') || setup.opened === step) return;
    if (!wallet.account || wallet.chainId !== CHAIN_ID || document.querySelector('dialog[open]')) return;
    setup.opened = step;
    try { openDeposit(); if (step === 'swap') { var inp = $('depositAmount'); if (inp) inp.blur(); } } catch (e) { /* the card still says what to do */ }
  }

  function setupText() {
    var s = setup.step, hype = ui.hypeWei == null ? null : Number(ui.hypeWei) / 1e18, usdc = acct.walletUsdc;
    var have = 'This wallet has <b>' + (hype == null ? '—' : hype.toFixed(hype >= 1 ? 2 : 4)) + ' HYPE</b> and <b>' + fmtUsd(usdc) + ' USDC</b> on HyperEVM.';
    if (s === 'wait') return 'Reading this wallet on HyperEVM: HYPE, USDC, your Confetti balance and any past trades. One moment.';
    if (s === 'connect') return (setup.connectNote ? '<span class="setup-note">' + setup.connectNote + '</span>' : '') + 'Confetti checks what your wallet has and shows you only the next thing to do: HyperEVM, HYPE for gas, USDC, a deposit, then your first trade.' + (wallet.eth || getInjected() ? ' Nothing is signed by connecting.' : ' No wallet in this browser: the button opens Confetti in your wallet app.');
    if (s === 'chain') return 'Your wallet is on <b>' + chainName(wallet.chainId) + '</b>. Confetti runs on HyperEVM (chain 999). One tap asks your wallet to switch, or to add HyperEVM first.';
    if (s === 'hype') {
      if (setupSwapCase()) return 'You have <b>' + fmtUsd(usdc) + ' USDC</b> in this wallet but no HYPE for gas. Every send on HyperEVM needs a little (about 0.01 HYPE). Swap a little of it for HYPE right here on Confetti\'s swap: 1 USDC covers many sends. Then deposit the rest.';
      if (depSwapSmall()) return 'Trades are in USDC. The HYPE here buys about <b>' + fmtUsd(swHypeWorth(ui.hypeWei)) + '</b>, under the ' + fmtUsdShort(minMargin()) + ' minimum for a trade: add a little more HYPE, or USDC.';
      if (brOn() && wallet.chainId !== CHAIN_ID) return 'Trades are in USDC, and every send needs a little HYPE for gas. ' + have + ' Bring ETH from Arbitrum, Ethereum or Base first: your wallet stays on ' + (BR_CHAINS[wallet.chainId] ? BR_CHAINS[wallet.chainId].name : 'the ETH side') + ' to send it, and it lands on HyperEVM as HYPE in a minute or two. Then you switch to HyperEVM once' + (onrampOn() ? '. Or pay with Apple Pay' : '') + '. Already holding USDC on Hyperliquid? Send it straight to your deposit address.';
      if (brOn()) return 'Trades are in USDC, and every send needs a little HYPE for gas. ' + have + ' Bring ETH from Arbitrum, Ethereum or Base: it lands here as HYPE in a minute or two' + (onrampOn() ? '; or pay with Apple Pay' : '') + '. Already holding USDC on Hyperliquid? Send it straight to your deposit address.';
      return 'Trades are in USDC, and every send needs a little HYPE for gas. ' + have + ' Send HYPE or USDC to this wallet on HyperEVM' + (onrampOn() ? ', or pay with Apple Pay and HYPE arrives in a few minutes' : '') + '. Already holding USDC on Hyperliquid? Send it straight to your deposit address.';
    }
    if (s === 'bridge') {
      var f = br.inflight || {}, where = BR_CHAINS[f.chain] ? BR_CHAINS[f.chain].name : 'the other chain';
      if (br.busy) return 'Confirm the transaction in your wallet on ' + where + '. Nothing moves until you do.';
      if (f.state === 'slow') return 'Taking longer than usual. deBridge still has the order; it fills or the ETH comes back to the wallet it left. Keep this page open, or check the order at app.debridge.finance with your wallet address.';
      return 'Sent on ' + where + '. deBridge is filling the order: about <b>' + (f.out ? brFmtHype(f.out) : '—') + ' HYPE</b> lands in this wallet on HyperEVM in a minute or two. Switch ' + (setupOrder() === SETUP_ORDER_ETH ? 'to' : 'back to') + ' HyperEVM whenever you like; the page keeps watching.';
    }
    if (s === 'swap') return 'Trades are in USDC, not HYPE. ' + have + ' Add USDC swaps HYPE for USDC on HyperSwap: type how much, or tap Max for the most (0.03 HYPE stays for gas).';
    if (s === 'deposit') return 'You have <b>' + fmtUsd(usdc) + ' USDC</b> in this wallet' + (acct.available > 0 ? ' and <b>' + fmtUsd(acct.available) + '</b> on Confetti' : '') + '. Deposit at least ' + fmtUsdShort(minMargin()) + ' onto the exchange. The first time is two confirms: approve USDC, then deposit.';
    if (s === 'trade') {
      if (isSheetMode() && !ui.sheet) return 'Your balance is <b>' + fmtUsd(acct.available) + '</b>. Tap BUY / LONG if you think the price goes up, SELL / SHORT if it goes down, then pick an amount and leverage.';
      return 'Your balance is <b>' + fmtUsd(acct.available) + '</b>. Pick a side, an amount and leverage, then tap OPEN. Your wallet confirms the first one.';
    }
    return '';
  }
  /* the line inside Add USDC while a step runs there */
  function setupStripText() {
    var s = setup.step;
    if (s === 'swap') return 'Swap HYPE for USDC on HyperSwap: type how much, or tap Max for the most (0.03 HYPE stays for gas). One confirm in your wallet, then the sheet fills the amount for the deposit.';
    if (s === 'deposit') return 'Enter an amount (Max is fine) and tap Deposit. The first time is two confirms in your wallet: approve exactly that much USDC, then deposit it.';
    if (s === 'hype') return 'Apple Pay sends HYPE to this wallet in a few minutes; the sheet then turns it into USDC in one tap. Or send USDC from Hyperliquid to your deposit address.';
    return '';
  }

  function setupButtons(step) {
    var row = setup.card.querySelector('.setup-btns'); if (!row) return;
    row.textContent = '';
    function add(label, cls, fn) { var b = el('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.addEventListener('click', fn); row.appendChild(b); return b; }
    if (step === 'connect') {
      add('Connect wallet', 'btn-primary', function () { connect(); });
      row.appendChild(el('span', 'grow'));
      add('Just looking', 'btn-ghost btn-sm', function () { setup.away = true; setupRender(); });
    } else if (step === 'chain') {
      add('Switch to HyperEVM', 'btn-primary', function () { switchChain().then(function () { return onChainChanged(); }).catch(switchFailed); });
    } else if (step === 'bridge') {
      if (wallet.chainId !== CHAIN_ID) add('Switch to HyperEVM', '', function () { switchChain().then(function () { return onChainChanged(); }).catch(switchFailed); });
    } else if (step === 'hype') {
      var ramp = onrampOn();
      if (ramp) add('Pay with Apple Pay', 'btn-primary', function () { setup.opened = 'hype'; openDeposit(); setDepWhere('card'); });
      add('I have USDC on Hyperliquid', ramp || setupSwapCase() || brOn() ? '' : 'btn-primary', function () {   /* the lit Bring ETH card is the main way */ setup.opened = 'hype'; openDeposit(); setDepWhere('hl'); });
    } else if (step === 'swap') {
      add('Swap HYPE for USDC', 'btn-primary', function () { setup.opened = step; openDeposit(); });
    } else if (step === 'deposit') {
      add('Deposit USDC', 'btn-primary', function () { setup.opened = step; openDeposit(); });
    } else if (step === 'trade') {
      add('Practice first', 'btn-sm', function () { location.href = PRACTICE_URL; });   /* a demo trade, open to close, pretend money */
    }
    if (step !== 'connect') { row.appendChild(el('span', 'grow')); add('Just looking', 'btn-ghost btn-sm', setupClose); }   /* the X's way out, in words, on every step */
    row.hidden = !row.childNodes.length;
  }

  function setupTarget() {
    var s = setup.step;
    function vis(id) { var n = $(id); return n && !n.hidden && n.getClientRects().length ? n : null; }
    if (s === 'connect') return vis('phAcct') || vis('connectBtn');
    if (s === 'chain') return vis('chainBanner') || vis('phAcct') || vis('connectBtn');
    if (s === 'hype') return setup.swapHome ? vis(setup.swapHome.id) : null;   /* the site's own Swap card, or the Bring ETH box */
    if (s === 'trade') return isSheetMode() && !ui.sheet ? (vis('mbarPair') || vis('mobileBar') || vis('ticket')) : vis('ticket');   /* phones: the BUY / SELL bar opens the sheet */
    return null;
  }

  /* The four blurred panels around the lit box (none: one panel over everything). */
  function setupDims(box) {
    var d = setup.dims; if (!d) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    function put(n, l, t, w, h) { var on = w > 0 && h > 0; n.hidden = !on; if (on) { n.style.left = l + 'px'; n.style.top = t + 'px'; n.style.width = w + 'px'; n.style.height = h + 'px'; } }
    if (!box) { put(d[0], 0, 0, vw, vh); put(d[1], 0, 0, 0, 0); put(d[2], 0, 0, 0, 0); put(d[3], 0, 0, 0, 0); return; }
    var l = clamp(Math.round(box.left), 0, vw), t = clamp(Math.round(box.top), 0, vh), r = clamp(Math.round(box.right), 0, vw), b = clamp(Math.round(box.bottom), 0, vh);
    put(d[0], 0, 0, vw, t);
    put(d[1], 0, b, vw, vh - b);
    put(d[2], 0, t, l, b - t);
    put(d[3], r, t, vw - r, b - t);
  }

  function setupPlace() {
    if (!setup.on || !setup.card) return;
    setupAutoOpen();
    if (setup.step === 'hype') setupSwapShow();   /* the wallet's USDC may land after the step shows: the lent card follows */
    setupWho();
    var dlg = document.querySelector('dialog[open]');
    var inDep = !!(dlg && dlg.id === 'depositModal' && (setup.step === 'swap' || setup.step === 'deposit' || setup.step === 'hype'));
    renderDepSetup(inDep);
    if (dlg) { setup.card.hidden = true; setup.ring.hidden = true; if (setup.x) setup.x.hidden = true; setupDims(null); return; }   /* a sheet or picker is up: it carries the step */
    setRole(setup.card, 'text', '');
    setup.card.querySelector('[data-role="text"]').innerHTML = setupText();
    var vw = window.innerWidth, vh = window.innerHeight;
    var t = setupTarget();
    var r = t && t.getClientRects().length ? t.getBoundingClientRect() : null;
    if (r && (r.width < 1 || r.height < 1)) r = null;
    setup.card.hidden = false;
    setupFit(0);
    var cw = setup.card.offsetWidth, ch = setup.card.offsetHeight;
    if (!r) {
      setup.ring.hidden = true;
      setupDims(null);
      setup.card.style.left = Math.max(12, Math.round((vw - cw) / 2)) + 'px';
      setup.card.style.top = Math.max(12, Math.round((vh - ch) / 2)) + 'px';
      setupPlaceX(null);
      return;
    }
    if (setup.scrolled !== setup.step && (r.top < 48 || r.bottom > vh - 8) && t.scrollIntoView) {
      setup.scrolled = setup.step;
      litScrollTo(t, r);
    }
    var pad = 6, gap = 10;
    var box = { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad };
    setupDims(box);
    setup.ring.hidden = false;
    setup.ring.setAttribute('data-n', 'Step ' + (setupOrder().indexOf(setup.step === 'bridge' ? 'hype' : setup.step) + 1));
    setup.ring.classList.toggle('is-low', box.top < 26);
    setup.ring.style.left = Math.round(box.left) + 'px';
    setup.ring.style.top = Math.round(box.top) + 'px';
    setup.ring.style.width = Math.round(box.right - box.left) + 'px';
    setup.ring.style.height = Math.round(box.bottom - box.top) + 'px';
    var low = box.top < 26, lab = low ? 22 : 0;   /* the step label hangs below a ring at the top edge */
    var below = vh - (box.bottom + gap + lab), above = box.top - gap;
    /* a lit box too tall to leave room for the card (Bring ETH on a phone): the card sheds the step list, then its
       words, then the Phantom note, until it fits beside the box, so the box's own button is never under it */
    var fits = function () { return below >= ch + 8 || above >= ch + 8 || box.left - gap >= cw + 12 || vw - box.right - gap >= cw + 12; };
    for (var lv = 1; lv <= 3 && !fits(); lv++) { setupFit(lv); ch = setup.card.offsetHeight; }
    var top, left = null;
    if (below >= ch + 8) top = box.bottom + gap + lab;
    else if (above >= ch + 8) top = box.top - gap - ch;
    else if (box.left - gap >= cw + 12) { left = box.left - gap - cw; top = clamp(box.top, 8, Math.max(8, vh - ch - 8)); }      /* beside a tall target (the ticket column) */
    else if (vw - box.right - gap >= cw + 12) { left = box.right + gap; top = clamp(box.top, 8, Math.max(8, vh - ch - 8)); }
    else top = below >= above ? Math.min(vh - ch - 8, box.bottom + gap) : Math.max(8, box.top - gap - ch);
    if (left == null) left = clamp(Math.round((box.left + box.right) / 2 - cw / 2), 12, Math.max(12, vw - cw - 12));
    setup.card.style.left = Math.round(left) + 'px';
    setup.card.style.top = Math.round(top) + 'px';
    setupPlaceX({ left: box.left - 4, top: box.top - (low ? 0 : 22), right: box.right + 4, bottom: box.bottom + (low ? 22 : 4) });
  }

  function setupFit(lv) {
    var c = setup.card; if (!c) return;
    [c.querySelector('.setup-list'), c.querySelector('[data-role="text"]'), setup.ph].forEach(function (n, i) { if (n) n.style.display = lv > i ? 'none' : ''; });
  }

  /* The strip at the top of Add USDC while a step runs there; the parts of the sheet not in play go faint. */
  function renderDepSetup(on) {
    var strip = $('depSetup'), dlg = $('depositModal');
    if (!strip || !dlg) return;
    var was = dlg.getAttribute('data-setup') || '';
    var now = on ? setup.step : '';
    strip.hidden = !on;
    if (on) {
      setText('depSetupN', 'Step ' + (setupOrder().indexOf(setup.step) + 1) + ' of ' + setupOrder().length);
      setText('depSetupTitle', SETUP_TITLES[setup.step]);
      setText('depSetupText', setupStripText());
    }
    if (was === now) return;
    if (now) dlg.setAttribute('data-setup', now); else dlg.removeAttribute('data-setup');
    var form = $('depositForm');
    var seg = form ? form.querySelector('.panel-body') : null;
    if (seg) seg.classList.toggle('dep-dim', now === 'swap' || now === 'deposit');
    var fromWallet = $('depFromWallet');
    if (fromWallet) Array.prototype.forEach.call(fromWallet.children, function (c) { c.classList.toggle('dep-dim', now === 'swap' && c.id !== 'depSwap'); });
  }

  /* ---- PRACTICE RUN (the owner, 2026-11-02: "do that same flow through for setting up trades and show them all the
     parts of a trade with a demo trade from open to close. limit orders too"). On the demo (trade.html?demo=1&practice=1:
     pretend money, a fresh account, nothing sent) the same lit-section flow as First steps takes a new trader through
     every part of a trade: the coin, up or down, the amount, leverage, the receipt, take profit / stop loss, OPEN and
     the fill, the position card, CLOSE and the result; then, on a desktop, a limit order placed, waiting in Orders and
     cancelled. Each part clears itself when they do it (the page's own events, or the state); a part that only shows
     something has a Got it. Reached from "Try the demo", from Practice first on the first-trade step, and from the
     "?" button. Ends on Trade for real. The limit parts run on phones too since the picker reached the phone ticket
     (the owner, 2026-11-02: "build limit orders into phone after"); take profit / stop loss before OPEN stays desktop. */
  var PRACTICE = !!(DEMO && demoOpt('practice') === '1');
  var PRACTICE_URL = 'trade.html?demo=1&practice=1';
  var prac = { on: false, i: -1, dims: null, ring: null, card: null, timer: null, scrolled: null, placed: 0, steps: [] };

  function pracFirstCard() { return typeof firstCard === 'function' ? firstCard() : null; }
  function pracRow() {
    var c = pracFirstCard();
    if (isPhone()) { var pid = c ? c.getAttribute('data-id') : null; return (pid && phRowFor(pid)) || document.querySelector('#phRows .ph-row[data-pid]') || c; }
    return c;
  }
  function pracResult() { return document.querySelector('#posLines .result-card'); }
  function pracLimitWaits() {
    if (!(lim.px > 0) || !state.market) return false;
    var now = marketPrice(state.market);
    return !(isFinite(now) && now > 0 && limitCrossed({ isLong: form.side === 'long', limitPx: lim.px }, now));
  }

  /* id, title, text(), target(), and one of: on (the page's event that clears it), done() (state that clears it),
     btn (a Got it when it only shows something). sheet: phones open / close the ticket sheet first. desk: desktop only. */
  var PRAC_ALL = [
    { id: 'coin', title: 'Pick a coin', on: 'market', sheet: false,
      target: function () { return $('marketBtn'); },
      btn: function () { return state.market ? 'Keep ' + state.market.symbol : 'Keep it'; },
      text: function () { return 'Pretend money: nothing here is sent or real. ' + tapWord() + ' the coin to choose what to trade' + (state.market ? '; ' + state.market.symbol + ' is picked for you' : '') + '. Up to 1000x on memes.'; } },
    { id: 'side', title: 'Up or down?', on: 'side',
      target: function () { return isSheetMode() && !ui.sheet ? $('mbarPair') : $('sidePair'); },
      text: function () { return 'BUY / LONG if you think the price goes up, SELL / SHORT if you think it goes down. You win when it moves your way. ' + tapWord() + ' one.'; } },
    { id: 'amount', title: 'Amount', on: 'amount', sheet: true,
      target: function () { return $('amountBox'); },
      text: function () { return 'What you put in, and the most you can lose on this trade. ' + tapWord() + ' $10.'; } },
    { id: 'lev', title: 'Leverage', on: 'lev', sheet: true,
      target: function () { return $('levBox'); },
      text: function () {
        var amt = isFinite(form.margin) && form.margin > 0 ? fmtUsdShort(form.margin) : 'your amount';
        return 'Leverage multiplies your result: your ' + amt + ' moves like ' + fmtUsdShort((form.margin > 0 ? form.margin : 10) * form.lev) + ' at ' + form.lev + 'x. A ' + fmtMove(bustMovePct(form.lev)) + '% move against you hits the liquidation price and you lose the ' + amt + '. Higher leverage, smaller move. ' + tapWord() + ' a leverage.';
      } },
    { id: 'receipt', title: 'Your trade in dollars', btn: 'Got it', sheet: true,
      target: function () { return isDesk() ? $('dkReceipt') : isPhone() ? $('phReceipt') : $('previewBox'); },
      text: function () { return 'What you risk, how big the position is (amount × leverage), the liquidation price and how far away it is, what a 1% move pays you, the price it opens near, and the costs: the spread and the fee on a win.'; } },
    { id: 'tpsl', title: 'Take profit / Stop loss', btn: 'Skip for now', desk: true, sheet: true,
      target: function () { return $('dkTpSlBox'); },
      done: function () { var t = $('dkTpPx'), s = $('dkSlPx'); return !!((t && Number(t.value) > 0) || (s && Number(s.value) > 0)); },
      text: function () { return 'Optional. A take profit closes the trade for you at a price in your favour, a stop loss at a price against you. They live in this browser and fire while the page is open. Type one, or skip.'; } },
    { id: 'open', title: function () { return isDesk() ? 'OPEN' : 'OPEN POSITION'; }, on: 'submit', sheet: true,
      target: function () { return tk.phase ? $('ticketProgress') : $('actionBtn'); },
      text: function () { var b = $('actionBtn'); return tapWord() + ' ' + (b && /^OPEN/i.test(b.textContent) ? b.textContent.trim() : 'OPEN POSITION') + '. The button says your trade. For real money your wallet asks you to confirm; here nothing is sent.'; } },
    { id: 'fill', title: function () { return 'About ' + fillSecs() + ' seconds'; }, on: 'opened', sheet: true,
      target: function () { return $('ticketProgress'); },
      text: function () { return 'Your order is sent. It fills at the market price in about ' + fillSecs() + ' seconds: Sent, then Opening, then Open at the price you got.'; } },
    { id: 'card', title: 'Your position', btn: 'Got it', sheet: false,
      target: function () { return pracRow(); },
      text: function () {
        if (isPhone()) return 'Every open position gets a row at the top of the page: profit or loss in $ and %, and a bar for how far the price is from liquidation. It turns amber, then red, as the price gets close. ' + tapWord() + ' the row for the entry price, the price now, the liquidation price, take profit and stop loss, and Close.';
        if (isDesk()) return 'Every open position is a card under the chart: its size, what you put in, the price you got in at, the price now, the liquidation price and how far away it is, and profit or loss in $ and %. The liquidation turns amber, then red, as the price gets close.';
        return 'Every open position gets a card: profit or loss in $ and %, the price you got in at, the price now, and the liquidation price. It turns amber, then red, as the price gets close.';
      } },
    { id: 'close', title: function () { return isDesk() ? 'Close' : 'CLOSE POSITION'; }, on: 'closed', sheet: false,
      target: function () {
        var c = pracFirstCard();
        if (isPhone()) return pracRow();
        return c ? c.querySelector('.close-btn') || c.querySelector('[data-role="act"]') : null;
      },
      text: function () {
        if (isPhone()) return tapWord() + ' the row, then Close: the sheet shows about what you get back, right over the button. It closes at the market price in about ' + fillSecs() + ' s and shows the result.';
        return tapWord() + ' Close any time to take your money out. The button says about what you get back. It closes at the market price in about ' + fillSecs() + ' s, right here on the card.';
      } },
    { id: 'result', title: 'Open to close', btn: 'Next', sheet: false,
      target: function () { return pracResult(); },
      text: function () { return 'The result card: what you got back, the fee, your profit or loss. That is a whole trade. With real money, Withdraw sends your balance back to your wallet.'; } },
    { id: 'limit', title: 'Limit orders', sheet: true,
      target: function () { return $('dkOrderType'); },
      done: function () { return lim.type === 'limit'; },
      text: function () { return 'Market opens now. Limit waits for your price and opens when the market gets there. Pick Limit.'; } },
    { id: 'limitpx', title: 'Your price', sheet: true,
      target: function () { return $('dkLimitBox'); },
      done: function () { return lim.type === 'limit' && pracLimitWaits(); },
      text: function () { return 'The box starts at the market price. For a buy, set it lower; for a sell, higher. Try about 1% away: the order waits for it.'; } },
    { id: 'place', title: 'Place it', sheet: true,
      target: function () { return $('actionBtn'); },
      done: function () { return lim.orders.length > prac.placed; },
      text: function () { var b = $('actionBtn'); return tapWord() + ' ' + (b ? b.textContent.trim() : 'LIMIT') + '. The order is stored in this browser and fires from this page while it is open.'; } },
    { id: 'orders', title: 'Orders', btn: 'Leave it', sheet: false,
      target: function () { var t = $('tabOrders'); if (t && t.getAttribute('aria-selected') !== 'true') t.click(); return $('limLines'); },
      done: function () { return lim.orders.length < prac.placedNow; },
      text: function () { return 'Here it waits, with the live price beside it. When the price touches your limit it opens like a market order, and the fill lands a few seconds later. Cancel takes it back; it expires after a day.'; } },
    { id: 'done', title: 'That is every part of a trade', sheet: false,
      target: function () { return null; },
      text: function () { return 'Trade for real: the site first checks what your wallet needs (HyperEVM, HYPE for gas, USDC, a deposit) and shows you one step at a time.'; } }
  ];

  function pracSteps() { return PRAC_ALL.filter(function (s) { return !s.desk || isDesk(); }); }

  function practiceStart() {
    if (!PRACTICE || prac.on) return;
    prac.on = true; prac.i = -1; prac.steps = pracSteps();
    try { if (lim.orders.length) { lim.orders = []; limSave(); } } catch (e) { /* a fresh run: the demo's own list only */ }
    prac.dims = [0, 1, 2, 3].map(function () { var d = el('div', 'setup-dim'); document.body.appendChild(d); return d; });
    prac.ring = el('div', 'setup-ring'); prac.ring.hidden = true; document.body.appendChild(prac.ring);
    var c = el('div', 'setup-card');
    c.setAttribute('role', 'dialog'); c.setAttribute('aria-label', 'Practice run'); c.setAttribute('aria-live', 'polite');
    [['count', 'setup-count'], ['title', 'setup-title'], ['text', 'setup-text']].forEach(function (r) { var n = el('div', r[1]); n.setAttribute('data-role', r[0]); c.appendChild(n); });
    c.appendChild(el('div', 'setup-btns'));
    document.body.appendChild(c);
    prac.card = c;
    prac.timer = setInterval(practicePlace, 300);
    window.addEventListener('resize', practicePlace);
    window.addEventListener('scroll', practicePlace, true);
    var at = demoOpt('part'), k = 0;                                    /* &part=limit starts the run there (previews) */
    prac.steps.forEach(function (x, j) { if (x.id === at) k = j; });
    practiceGo(k);
  }

  function practiceEnd() {
    if (!prac.on) return;
    prac.on = false;
    if (prac.timer) { clearInterval(prac.timer); prac.timer = null; }
    window.removeEventListener('resize', practicePlace);
    window.removeEventListener('scroll', practicePlace, true);
    (prac.dims || []).concat([prac.ring, prac.card]).forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
    prac.dims = null; prac.ring = null; prac.card = null;
  }

  function practiceGo(i) {
    if (!prac.on) return;
    if (i >= prac.steps.length) { practiceEnd(); return; }
    prac.i = i; prac.scrolled = null;
    var s = prac.steps[i];
    if (s.id === 'place') prac.placed = lim.orders.length;
    if (s.id === 'orders') prac.placedNow = lim.orders.length;
    if (isSheetMode()) { if (s.sheet === true) openSheet(); else if (s.sheet === false) closeSheet(); }
    setRole(prac.card, 'count', 'Part ' + (i + 1) + ' of ' + prac.steps.length);
    setRole(prac.card, 'title', typeof s.title === 'function' ? s.title() : s.title);
    var row = prac.card.querySelector('.setup-btns'); row.textContent = '';
    function add(label, cls, fn) { var b = el('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.addEventListener('click', fn); row.appendChild(b); return b; }
    if (s.id === 'done') {
      add('Trade for real', 'btn-primary', function () { location.href = 'trade.html'; });
      add('Run it again', '', function () { location.href = PRACTICE_URL; });
    } else if (s.btn) {
      add(typeof s.btn === 'function' ? s.btn() : s.btn, 'btn-primary btn-sm', function () { practiceGo(prac.i + 1); });
    }
    row.appendChild(el('span', 'grow'));
    if (s.id !== 'done') add('Stop', 'btn-ghost btn-sm', function () { practiceEnd(); });
    row.hidden = false;
    practicePlace();
  }

  /* The page's events (the same ones the tour used) clear the part waiting for them. 'opened' lands the fill
     wherever the run is between OPEN and the fill. */
  function practiceEvent(name) {
    if (!prac.on) return;
    var s = prac.steps[prac.i]; if (!s) return;
    var at = prac.i;
    if (name === 'opened' && (s.id === 'open' || s.id === 'fill')) {
      var card = 0; prac.steps.forEach(function (x, k) { if (x.id === 'card') card = k; });
      setTimeout(function () { if (prac.on && prac.i === at) practiceGo(card); }, 900);
      return;
    }
    if (s.on !== name) return;
    setTimeout(function () { if (prac.on && prac.i === at) practiceGo(at + 1); }, 450);
  }

  function practicePlace() {
    if (!prac.on || !prac.card) return;
    var s = prac.steps[prac.i]; if (!s) return;
    if (s.done && s.done()) { practiceGo(prac.i + 1); return; }
    var dlg = document.querySelector('dialog[open]');
    if (dlg) { prac.card.hidden = true; prac.ring.hidden = true; pracDims(null); return; }   /* the position sheet or a picker carries the part */
    prac.card.querySelector('[data-role="text"]').textContent = s.text();
    var vw = window.innerWidth, vh = window.innerHeight;
    var t = s.target();
    var r = t && t.getClientRects().length ? t.getBoundingClientRect() : null;
    if (r && (r.width < 1 || r.height < 1)) r = null;
    prac.card.hidden = false;
    var cw = prac.card.offsetWidth, ch = prac.card.offsetHeight;
    if (!r) {
      prac.ring.hidden = true;
      pracDims(null);
      prac.card.style.left = Math.max(12, Math.round((vw - cw) / 2)) + 'px';
      prac.card.style.top = Math.max(12, Math.round((vh - ch) / 2)) + 'px';
      return;
    }
    if (prac.scrolled !== prac.i && (r.top < 48 || r.bottom > vh - 8) && t.scrollIntoView) {
      prac.scrolled = prac.i;
      litScrollTo(t, r);
    }
    var pad = 6, gap = 10;
    var box = { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad };
    pracDims(box);
    prac.ring.hidden = false;
    prac.ring.setAttribute('data-n', 'Part ' + (prac.i + 1));
    prac.ring.classList.toggle('is-low', box.top < 26);
    prac.ring.style.left = Math.round(box.left) + 'px';
    prac.ring.style.top = Math.round(box.top) + 'px';
    prac.ring.style.width = Math.round(box.right - box.left) + 'px';
    prac.ring.style.height = Math.round(box.bottom - box.top) + 'px';
    var low = box.top < 26, lab = low ? 22 : 0;
    var below = vh - (box.bottom + gap + lab), above = box.top - gap;
    var top, left = null;
    if (below >= ch + 8) top = box.bottom + gap + lab;
    else if (above >= ch + 8) top = box.top - gap - ch;
    else if (box.left - gap >= cw + 12) { left = box.left - gap - cw; top = clamp(box.top, 8, Math.max(8, vh - ch - 8)); }
    else if (vw - box.right - gap >= cw + 12) { left = box.right + gap; top = clamp(box.top, 8, Math.max(8, vh - ch - 8)); }
    else top = below >= above ? Math.min(vh - ch - 8, box.bottom + gap) : Math.max(8, box.top - gap - ch);
    if (left == null) left = clamp(Math.round((box.left + box.right) / 2 - cw / 2), 12, Math.max(12, vw - cw - 12));
    prac.card.style.left = Math.round(left) + 'px';
    prac.card.style.top = Math.round(top) + 'px';
  }

  /* Bring a lit element into view. An element in the sticky ticket column stays put under scrollIntoView, so one near
     the top edge is cleared by scrolling the page up instead (to 0 at most); the rest centre as before. */
  function litScrollTo(t, r) {
    if (r.top < 48 && window.scrollY > 0) { window.scrollTo({ top: Math.max(0, window.scrollY + r.top - 80), behavior: 'smooth' }); return; }
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function pracDims(box) {
    var d = prac.dims; if (!d) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    function put(n, l, t, w, h) { var on = w > 0 && h > 0; n.hidden = !on; if (on) { n.style.left = l + 'px'; n.style.top = t + 'px'; n.style.width = w + 'px'; n.style.height = h + 'px'; } }
    if (!box) { put(d[0], 0, 0, vw, vh); put(d[1], 0, 0, 0, 0); put(d[2], 0, 0, 0, 0); put(d[3], 0, 0, 0, 0); return; }
    var l = clamp(Math.round(box.left), 0, vw), t = clamp(Math.round(box.top), 0, vh), r = clamp(Math.round(box.right), 0, vw), b = clamp(Math.round(box.bottom), 0, vh);
    put(d[0], 0, 0, vw, t);
    put(d[1], 0, b, vw, vh - b);
    put(d[2], 0, t, l, b - t);
    put(d[3], r, t, vw - r, b - t);
  }

  /* ---- Bring ETH (the owner, 2026-11-02: "3% fees on eth to hype transfers", "dont make it look bad that im charging
     fees"): ETH on Arbitrum, Ethereum or Base in, native HYPE on HyperEVM out, through deBridge's DLN. The 3% is
     deBridge's affiliate fee to the fee wallet, paid in ETH on the chain the ETH leaves, inside the same order: one
     confirm there, the HYPE lands in a minute or two, and the page follows the order until it does. The fee is one
     quiet line in the quote, like every fee on the site. Nothing here is sent without the wallet's confirm. */
  var BR_API = 'https://dln.debridge.finance/v1.0';
  var BR_CHAINS = { 42161: { name: 'Arbitrum', hex: '0xa4b1' }, 1: { name: 'Ethereum', hex: '0x1' }, 8453: { name: 'Base', hex: '0x2105' } };
  var BR_DST = 100000022;          // HyperEVM inside deBridge
  var BR_QUOTE_FRESH_MS = 20000;
  var br = { chain: 42161, quote: null, busy: false, seq: 0, timer: null, inflight: null, poll: null, status: '', balWei: null };
  /* (2026-11-05, the owner: "it needs to be a fill in amount", "max can be a choice but people fill in the amount")
     the box takes any amount the trader types; when the wallet sits on the
     chain it sends from, the card shows its ETH there and a Max that leaves the network fee: 0.003 ETH on Ethereum,
     0.0003 on Arbitrum and Base */
  function brGasKeep(chain) { return chain === 1 ? 3000000000000000n : 300000000000000n; }
  function brRefreshBal() {
    var eth = wallet.eth, a = wallet.account, c = br.chain;
    if (!eth || !a || wallet.chainId !== c) { br.balWei = null; brRenderBal(); return; }
    eth.request({ method: 'eth_getBalance', params: [a, 'latest'] }).then(function (hex) {
      if (wallet.account !== a || br.chain !== c || wallet.chainId !== c) return;
      br.balWei = BigInt(hex); brRenderBal(); brRenderGo();
    }).catch(function () { /* the wallet would not say: no Max, the box still works */ });
  }
  function brRenderBal() {
    var t = $('brBal'), m = $('brMax'); if (!t || !m) return;
    var on = br.balWei != null;
    t.textContent = on ? 'In your wallet on ' + BR_CHAINS[br.chain].name + ': ' + brFmtEth(br.balWei) + ' ETH' : '';
    m.hidden = !on || br.balWei <= brGasKeep(br.chain);
  }
  /* Max: the most this wallet can send with deBridge's fee and the network fee covered: a first guess, one quote, then
     the guess moved by what that quote's total missed the room by (deBridge's fee here is a fixed amount on top, so
     one correction lands; a fiftieth of the miss and a hair stay back for a fee that moves) */
  function brMax() {
    if (br.balWei == null || br.busy || br.inflight) return;
    var room = br.balWei - brGasKeep(br.chain), inp = $('brPay');
    if (room <= 0n || !inp) return;
    var guess = room * 96n / 100n, seq = ++br.seq;
    br.quote = null; brRenderGo();
    setText('brQuote', 'Working out the most you can send…');
    brQuote(guess, wallet.account).then(function (q) {
      if (seq !== br.seq) return;
      var miss = room - q.value, amt = guess + miss - (miss < 0n ? -miss : miss) / 50n - 1000000000000n;
      if (amt <= 0n) { setText('brQuote', 'Not enough ETH here to cover the fees.'); return; }
      inp.value = weiDown(amt);
      brQuoteNow();
    }).catch(function () { if (seq === br.seq) setText('brQuote', 'No quote right now: try again in a moment.'); });
  }

  function feeCfg() {
    var f = (cfg && cfg.fees) || {};
    return { wallet: isAddr(f.wallet) ? f.wallet : '', swapBips: Math.min(100, Math.max(0, Math.round(Number(f.swapBips) || 0))), bridgePercent: Math.max(0, Number(f.bridgePercent) || 0) };
  }
  function brFeePct() { var f = feeCfg(); return f.wallet ? f.bridgePercent : 0; }
  function brOn() { return !!$('bridgeCard'); }   /* the demo quotes too; brGo needs a real wallet */
  function brFmtEth(wei) { var n = Number(window.ethers.formatUnits(wei, 18)); return String(Number(n.toPrecision(n >= 1 ? 6 : 4))); }
  function brFmtHype(wei) { var n = Number(window.ethers.formatUnits(wei, 18)); return n >= 100 ? n.toFixed(2) : String(Number(n.toPrecision(5))); }

  function brUrl(amountWei, who) {
    var f = feeCfg();
    var q = [['srcChainId', br.chain], ['srcChainTokenIn', ZERO], ['srcChainTokenInAmount', String(amountWei)], ['dstChainId', BR_DST], ['dstChainTokenOut', ZERO], ['dstChainTokenOutAmount', 'auto'], ['prependOperatingExpenses', 'true']];
    if (who) q.push(['dstChainTokenOutRecipient', who], ['senderAddress', who], ['srcChainOrderAuthorityAddress', who], ['dstChainOrderAuthorityAddress', who]);
    if (brFeePct()) q.push(['affiliateFeePercent', String(brFeePct())], ['affiliateFeeRecipient', f.wallet]);
    return BR_API + '/dln/order/create-tx?' + q.map(function (kv) { return kv[0] + '=' + encodeURIComponent(kv[1]); }).join('&');
  }
  function brFetch(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error((j && j.errorMessage) || ('deBridge answered ' + r.status)); return j; });
    });
  }
  /* The quote: what leaves the wallet (the amount plus deBridge's fixed fee), what lands, the fee line. */
  function brQuote(amountWei, who) {
    return brFetch(brUrl(amountWei, who)).then(function (j) {
      var est = j.estimation || {}, tx = j.tx || {};
      var out = BigInt((est.dstChainTokenOut && est.dstChainTokenOut.amount) || 0);
      var inAmt = BigInt((est.srcChainTokenIn && est.srcChainTokenIn.amount) || amountWei);
      var value = tx.value != null ? BigInt(tx.value) : inAmt + BigInt(j.fixFee || 0);
      var delay = j.order && j.order.approximateFulfillmentDelay;
      return { amountWei: amountWei, inAmt: inAmt, value: value, out: out, tx: tx, orderId: j.orderId, delay: delay, at: Date.now(), chain: br.chain };
    });
  }
  function brQuoteNow() {
    var inp = $('brPay'), outEl = $('brGet'); if (!inp || !outEl) return;
    br.quote = null; brRenderGo();
    var amt = Number(inp.value);
    if (!(amt > 0)) { outEl.value = ''; setText('brQuote', 'Type an amount for a quote.'); brRenderTerms(null); return; }
    var E = window.ethers, wei;
    try { wei = E.parseUnits(String(inp.value), 18); } catch (e) { outEl.value = ''; setText('brQuote', 'Type an amount for a quote.'); return; }
    var seq = ++br.seq;
    setText('brQuote', 'Getting a quote…');
    brQuote(wei, wallet.account).then(function (q) {
      if (seq !== br.seq) return;
      br.quote = q;
      outEl.value = q.out > 0n ? brFmtHype(q.out) : '';
      var rate = amt > 0 ? Number(E.formatUnits(q.out, 18)) / amt : 0;
      setText('brQuote', '1 ETH ≈ ' + String(Number(rate.toPrecision(5))) + ' HYPE · ' + BR_CHAINS[br.chain].name + ' to HyperEVM · deBridge');
      brRenderTerms(q); brRenderGo();
    }).catch(function (e) {
      if (seq !== br.seq) return;
      outEl.value = ''; setText('brQuote', 'No quote right now: ' + (e && e.message ? e.message : 'try again in a moment.')); brRenderTerms(null); brRenderGo();
    });
  }
  function brRenderTerms(q) {
    var t = $('brTerms'); if (!t) return;
    var fee = brFeePct() ? 'Confetti fee ' + brFeePct() + '%' : 'no Confetti fee';
    t.textContent = q ? fee + ' · leaves your wallet: ' + brFmtEth(q.value) + ' ETH · about ' + (q.delay ? q.delay + ' min' : '2 min') : fee + ' · deBridge fee · about 2 minutes';
  }
  function brRenderGo() {
    var b = $('brGo'); if (!b) return;
    var short = !!(br.quote && br.balWei != null && br.quote.value > br.balWei);   /* more than the wallet holds, with the fee */
    var label = !wallet.account ? 'Connect wallet'
      : br.busy ? (br.status || 'Check your wallet…')
      : br.inflight ? 'On its way…'
      : !br.quote ? 'Bring ETH'
      : short ? 'Not enough ETH on ' + BR_CHAINS[br.chain].name
      : 'Bring ' + brFmtEth(br.quote.amountWei) + ' ETH';
    b.textContent = label;
    b.disabled = !!(wallet.account && (br.busy || br.inflight || !br.quote || short));
  }
  function brSwitchTo(id) {
    var eth = wallet.eth; if (!eth) return Promise.reject(new Error('No wallet.'));
    if (wallet.chainId === id) return Promise.resolve();
    return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BR_CHAINS[id].hex }] }).then(function () {
      return eth.request({ method: 'eth_chainId', params: [] });
    }).then(function (hex) { wallet.chainId = parseInt(hex, 16); if (wallet.chainId !== id) throw new Error('The wallet is still on ' + chainName(wallet.chainId) + '.'); });
  }
  function brGo() {
    if (br.busy || br.inflight) return;
    if (!wallet.account) { connect(); return; }
    if (!br.quote) return;
    var E = window.ethers, q0 = br.quote, q = null, hash = null;
    br.busy = true; br.status = 'Switching to ' + BR_CHAINS[br.chain].name + '…'; brRenderGo(); setText('brHint', '');
    brSwitchTo(br.chain).then(function () {
      br.status = 'Getting the final quote…'; brRenderGo();
      return Date.now() - q0.at < BR_QUOTE_FRESH_MS && q0.tx && q0.tx.data && q0.chain === br.chain ? q0 : brQuote(q0.amountWei, wallet.account);
    }).then(function (fq) {
      q = fq; br.quote = fq; brRenderTerms(fq);
      if (!fq.tx || !fq.tx.data) throw new Error('deBridge gave no transaction for this amount.');
      br.status = 'Checking the account…'; brRenderGo();
      return brCheckFrom(fq);
    }).then(function (from) {
      br.status = 'Confirm in your wallet…'; brRenderGo();
      setText('brHint', 'Your wallet shows one transaction on ' + BR_CHAINS[br.chain].name + ' from ' + shortAddr(from) + ' for ' + brFmtEth(q.value) + ' ETH. Nothing is sent until you confirm.');
      var prov = new E.BrowserProvider(wallet.eth);
      return new E.JsonRpcSigner(prov, from).sendTransaction({ to: q.tx.to, data: q.tx.data, value: q.value });
    }).then(function (tx) {
      hash = tx.hash;
      br.inflight = { hash: hash, chain: br.chain, orderId: q.orderId || null, since: Date.now(), out: q.out, state: 'sent' };
      br.busy = false; br.status = ''; brRenderGo();
      setText('brHint', 'Sent. deBridge is filling it: the HYPE lands in this wallet on HyperEVM in a minute or two. You can switch back to HyperEVM any time; the page keeps watching.');
      toast('ETH sent on ' + BR_CHAINS[br.chain].name + '. HYPE lands on HyperEVM in a minute or two.', 'ok');
      $('brPay').value = ''; $('brGet').value = ''; setText('brQuote', 'Type an amount for a quote.'); brRenderTerms(null);
      brTrack();
      renderAction();
    }).catch(function (e) {
      br.busy = false; br.status = ''; brRenderGo();
      setText('brHint', 'Not sent: ' + (e && (e.shortMessage || e.message) ? (e.shortMessage || e.message) : 'the wallet said no.'));
      if (br.quote === q0) br.quote.at = 0;
    });
  }
  /* (2026-11-06, the owner's MetaMask popup: "Account 1", 0.0993 ETH to deBridge, a red network fee and "Review alert";
     "cant even confirmn") Before the wallet opens: the account the page shows must be one the wallet lets this site
     use, and it must hold the ETH plus the network fee the wallet holds back (about one and a half times today's fee). Either one
     missing is said here in plain words, with the account and the numbers, instead of a popup that cannot confirm. */
  function brCheckFrom(fq) {
    var eth = wallet.eth, a = wallet.account, name = BR_CHAINS[br.chain].name, wn = walletName(eth);
    return eth.request({ method: 'eth_accounts', params: [] }).then(function (list) {
      var ok = (list || []).some(function (x) { return String(x).toLowerCase() === a.toLowerCase(); });
      if (!ok) throw new Error(wn + ' is not letting this site use ' + shortAddr(a) + '. Open ' + wn + ', pick that account, connect it to confetti.trade, then tap Bring ETH again.');
      return Promise.all([
        eth.request({ method: 'eth_getBalance', params: [a, 'latest'] }),
        eth.request({ method: 'eth_gasPrice', params: [] }).catch(function () { return '0x0'; }),
        eth.request({ method: 'eth_estimateGas', params: [{ from: a, to: fq.tx.to, data: fq.tx.data, value: '0x' + fq.value.toString(16) }] }).catch(function () { return null; })
      ]);
    }).then(function (r) {
      var bal = BigInt(r[0]), gas = (r[2] ? BigInt(r[2]) : 300000n) * BigInt(r[1]) * 3n / 2n;
      br.balWei = bal; brRenderBal();
      if (bal < fq.value + gas) {
        throw new Error(shortAddr(a) + ' has ' + brFmtEth(bal) + ' ETH on ' + name + '; this needs ' + brFmtEth(fq.value) + ' ETH plus up to ' +
          brFmtEth(gas) + ' for the network fee. Send less (Max works it out), or open ' + wn + ' and switch to the account that holds the ETH: the page follows.');
      }
      return a;
    });
  }
  /* Follow the order: the tx gives the order id, the order gives its state; done when the HYPE is out. */
  function brTrack() {
    if (br.poll) clearInterval(br.poll);
    br.poll = setInterval(function () {
      var f = br.inflight; if (!f) { clearInterval(br.poll); br.poll = null; return; }
      if (Date.now() - f.since > 30 * 60000) { f.state = 'slow'; renderAction(); return; }
      var p = f.orderId ? Promise.resolve(f.orderId) : brFetch(BR_API + '/dln/tx/' + f.hash + '/order-ids').then(function (j) { return j && j.orderIds && j.orderIds[0]; });
      p.then(function (id) {
        if (!id) return;
        f.orderId = id;
        return brFetch(BR_API + '/dln/order/' + id + '/status').then(function (s) {
          var st = s && s.status || '';
          if (/^(Fulfilled|SentUnlock|ClaimedUnlock)$/.test(st)) {
            br.inflight = null; clearInterval(br.poll); br.poll = null;
            toast('Landed: about ' + brFmtHype(f.out) + ' HYPE is in this wallet on HyperEVM.', 'ok');
            refreshWalletUsdc();   /* the guide reads this wallet's HYPE (the walk: it showed 0 HYPE, "bring ETH", after landing) */
            setText('brHint', 'Landed. Switch back to HyperEVM to go on.');
            brRenderGo(); renderAction();
          } else if (/Cancel/.test(st)) {
            br.inflight = null; clearInterval(br.poll); br.poll = null;
            setText('brHint', 'deBridge cancelled the order; the ETH comes back to the wallet it left. Try again, or a different amount.');
            brRenderGo(); renderAction();
          } else { f.state = st || f.state; renderAction(); }
        });
      }).catch(function () { /* next tick */ });
    }, 5000);
  }
  /* the wallet already sits on Arbitrum, Ethereum or Base: send from there (no switch before the bridge) */
  function brFollowWallet() {
    if (br.busy || br.inflight || !BR_CHAINS[wallet.chainId] || br.chain === wallet.chainId) return;
    br.chain = wallet.chainId;
    var sel = $('brChain'); if (sel) sel.value = String(br.chain);
    brRefreshBal();
    brQuoteNow();
  }
  function initBridge() {
    var card = $('bridgeCard'); if (!card) return;
    var sel = $('brChain');
    if (sel) sel.addEventListener('change', function () { br.chain = Number(sel.value) || 42161; brRefreshBal(); brQuoteNow(); });
    var mx = $('brMax'); if (mx) mx.addEventListener('click', brMax);
    $('brPay').addEventListener('input', function () { clearTimeout(br.timer); br.timer = setTimeout(brQuoteNow, 400); });
    $('brGo').addEventListener('click', brGo);
    brRenderTerms(null); brRenderGo();
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

  /* v5: what a demo fill charged as its size fee, as the exchange logs it right after the fill (its own log index in
     the same transaction); nothing when the fee is 0 */
  function demoFeeLog(pid, kind, notional, fee, hash) {
    if (!(fee > 0)) return [];
    var l = demoLog('TradeFeeCharged', [pid, wallet.account, kind, numToUsd6(notional), numToUsd6(fee)], hash);
    l.index = 1;
    return [l];
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
        longCap: 1000000, shortCap: 1000000, maxNotional: 1000000, payoutCapX: isV5() ? 50 : 200, entryDeadbandBps: 1, borrowRateX10: 5,
        opensPaused: false, retired: false, frozenPx: 0, market: m,
        raw: window.ConfettiSettle ? window.ConfettiSettle.curve({ baseRateBps: 1000, rateMultiplier: 15000, referenceNotionalUsd: 20000000000n, positionMultiplierE6: 130000000000000n }) : null, lastPx18: null
      };
      m.inst = inst; m.instrumentId = i; state.byInstId[i] = inst;
      /* a v5 config: the demo's markets fill as v5's do (every coin with a Pyth feed on the fast price, at the delay
         config.json restates for it, 2 s where it restates none; PEOPLE, which has none, on the HyperCore rule) */
      if (isV5()) house.fast[i] = { on: m.symbol !== 'PEOPLE', delay: m.fastDelay || 2, maxDevBps: 300, maxConfBps: 100 };
      /* and carry the size charge at its launch setting (ops/one/launch.json tradeFees): 4.5 bps of the size a side,
         at most 10% of the stake; the win cap is the launch markets' 50x (the contract takes 10x to 50x) */
      if (isV5()) house.tradeFee[i] = { rateX10: 45, capBps: 1000 };
      house.oi[m.symbol] = { long: 1950, short: 640 };
      /* v5: room for the $5 quick amount at 1000x (a $4,545 position) */
      house.maxPos[i] = isV5() ? { long: 5000, short: 5000 } : { long: 2500, short: 2500 };
    });
    if (isV5()) { house.minDelay = 5; house.delaysAt = Date.now(); }
    state.instrumentsLoaded = true;
    hbots.loaded = true;
  }

  /* (amt2) The demo teaches what a real trade does: each coin's live terms (entry spread, exit deadband, borrow, win cap)
     and the house's cuts are read once from the exchange, read-only, as any visit reads them; a trade opened in the demo
     is stamped with them (demoPos) as a real one is. The launch terms above (1 bp, 5%) stood in for good before, so
     after a change on the exchange the demo showed a 1000x trade giving up a tenth of what went in at the open while a
     real one gave up a fifth. They still stand in until the answer lands, and for good when the chain does not answer.
     The pretend account, its money and everything it sends stay pretend. */
  function demoTerms() {
    var ex = read.exchange;
    if (!DEMO || !ex) return;
    var none = function () { return null; }, redraw = function () { renderForm(); renderAction(); };
    ex.instrumentCount().then(function (n) {
      var ids = [];
      for (var i = 0; i < Number(n); i++) ids.push(i);
      return Promise.all(ids.map(function (i) { return ex.instrument(i).catch(none); }));
    }).then(function (rows) {
      rows.forEach(function (r) {
        if (!r || r.retired) return;
        var m = state.markets.filter(function (x) { return x.hlAssetIndex === Number(r.hlAssetIndex); })[0], inst = m && m.inst;
        if (!inst) return;
        inst.entryDeadbandBps = Number(r.entryDeadbandBps); inst.deadbandBps = Number(r.deadbandBps);
        inst.borrowRateX10 = Number(r.borrowRateX10); inst.payoutCapX = Number(r.payoutCapX);
      });
      redraw();
      /* the launch exchange: each coin's charge on size and its fill delay, as the chain holds them (tradeFee(id),
         fastPricing(id)), matched by the same asset index; a read that fails keeps the launch stand-in */
      if (!isV5() || !ex.tradeFee || !ex.fastPricing) return null;
      return Promise.all(rows.map(function (r, i) {
        if (!r || r.retired) return null;
        var m = state.markets.filter(function (x) { return x.hlAssetIndex === Number(r.hlAssetIndex); })[0];
        if (!m || m.instrumentId == null) return null;
        return Promise.all([ex.tradeFee(i).catch(none), ex.fastPricing(i).catch(none)]).then(function (a) {
          if (a[0]) house.tradeFee[m.instrumentId] = { rateX10: Number(a[0][0]), capBps: Number(a[0][1]) };
          if (a[1]) house.fast[m.instrumentId] = { on: !!a[1].on, delay: Number(a[1].delay), maxDevBps: Number(a[1].maxDevBps), maxConfBps: Number(a[1].maxConfBps) };
        });
      })).then(redraw);
    }).catch(none);
    Promise.all([ex.winFeeBps(), ex.lossFeeBps(), ex.borrowFreeHours(), ex.maxWinBps(), ex.houseFreeUsdc()]).then(function (r) {
      house.winFeeBps = Number(r[0]); house.lossFeeBps = Number(r[1]); house.borrowFreeHours = Number(r[2]); house.maxWinBps = Number(r[3]);
      house.free = usd6ToNum(r[4]);   /* what sizes the most one trade can win (maxProfitFor), as on the live page */
      redraw();
    }).catch(none);
  }

  /* (CF_PNL) The demo settles where the exchange settles: Hyperliquid's oracle print, from its activeAssetCtx stream
     (the fast feed, which runs in the demo too), else the 30 s stats feed's oraclePx; the mid only until either has
     answered. Before, the demo priced on the mid: 4-5 bps off the settlement price, measured. */
  function demoOracle() {
    var S = window.ConfettiSettle;
    state.markets.forEach(function (m) {
      if (m.instrumentId == null) return;
      if (fast.at[m.coin] && Date.now() - fast.at[m.coin] < PX_FRESH_MS) return;   /* the stream holds it */
      var c = state.ctx[m.coin];
      var raw = c && c.oraclePxStr && S ? S.parseOracle(c.oraclePxStr, m.szDecimals) : null;
      if (raw != null && c.at && Date.now() - c.at < 45000) { setOraclePx(m.instrumentId, S.oracle18(raw, m.szDecimals), 'ctx', c.at); return; }
      var px = state.mids[m.coin];
      if (px > 0 && !(house.oraclePx18ById[m.instrumentId] != null && oracle.src[m.instrumentId] !== 'mid' && Date.now() - (house.oraclePxAt[m.instrumentId] || 0) < PX_FRESH_MS)) setOraclePx(m.instrumentId, toPx18(px), 'mid', state.midsAt || Date.now());
    });
  }

  function demoBoot() {
    if (!window.ethers || !exIface) { toast('The demo needs ethers.js, which did not load.', 'err', null, 0); return; }
    demoInsts();
    house.feePool = 0; house.queued = 0; house.queueLen = 2; house.queueHead = 2; house.winFeeBps = isV5() ? 0 : 500; house.lossFeeBps = isV5() ? 0 : 500; house.minMargin = demoOpt('min') !== '' && Number(demoOpt('min')) > 0 ? Number(demoOpt('min')) : isV5() ? 4.5 : 5; house.borrowFreeHours = 1; house.maxWinBps = 2500; house.free = 10000;
    house.instCount = Object.keys(state.byInstId).length; house.breakerBps = 10000;
    demoTerms();
    house.block = demo.block; house.blockAt = Date.now();
    wallet.account = window.ethers.getAddress('0xde00000000000000000000000000000000000001');
    wallet.chainId = CHAIN_ID;
    acct.walletUsdc = 120; acct.allowance = 0;
    ui.hypeWei = 50000000000000000n;
    /* demo knobs: &hype=low (the gas note), &queued=1 (the paying-earlier-winners line), &paused=WIF (a paused coin) */
    if (demoOpt('hype') === 'low') ui.hypeWei = 1000000000000000n;
    else if (demoOpt('hype') !== '' && isFinite(Number(demoOpt('hype')))) ui.hypeWei = BigInt(Math.round(Number(demoOpt('hype')) * 1e6)) * 1000000000000n;   /* &hype=2: two HYPE (First steps previews) */
    /* First steps previews: &usdc=<n> USDC in the wallet, &chain=<id> the wallet's chain, &setup=<step> the step, &swap=1 the swap block */
    if (demoOpt('usdc') !== '' && isFinite(Number(demoOpt('usdc')))) acct.walletUsdc = Number(demoOpt('usdc'));
    if (demoOpt('chain') !== '' && isFinite(Number(demoOpt('chain')))) wallet.chainId = Number(demoOpt('chain'));
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
    demoWhenPriced(function () { demoSeed(); if (PRACTICE) setTimeout(practiceStart, 700); });
  }

  function demoWhenPriced(fn) {
    var t0 = Date.now();
    (function wait() {
      var ok = ['DOGE', 'WIF', 'ETH'].every(function (s) { var m = state.bySym[s]; return m && state.mids[m.coin] > 0; });
      if (ok || Date.now() - t0 > 6000) {
        ['DOGE', 'WIF'].forEach(function (s) { var m = state.bySym[s]; if (m && !(state.mids[m.coin] > 0)) state.mids[m.coin] = DEMO_FALLBACK_PX[s]; });
        demoOracle();
        fn();
        return;
      }
      setTimeout(wait, 250);
    })();
  }

  function demoPos(m, isLong, margin, lev, entry, openedAt, feeX10) {
    var px18 = typeof entry === 'bigint' ? entry : toPx18(entry);
    /* (amt2) stamped as executeOpen stamps a real one: the market's terms and the house's cuts right now (the launch
       exchange's cuts of a result are 0; the demo reads the chain's own, demoTerms), and the most it can win the smaller
       of amount x win cap and the house's share (maxProfitFor). The position carries its size-fee stamp. */
    var cut = isV5() ? 0 : 500;
    var win = house.winFeeBps >= 0 ? house.winFeeBps : cut, loss = house.lossFeeBps >= 0 ? house.lossFeeBps : cut, free = house.borrowFreeHours >= 0 ? house.borrowFreeHours : 1;
    var cap = maxProfitFor(margin, m.inst);
    if (feeX10 == null) feeX10 = feeShareFor(m.instrumentId, lev);
    var p = {
      feeX10: feeX10, openFee: feeOnStake(margin, feeX10),
      id: BigInt(demo.nextPos++), instrumentId: m.instrumentId, isLong: isLong, margin: margin, leverage: lev,
      /* v5: the stake and the money added after the open in the contract's units, as an account read carries them */
      margin6: numToUsd6(margin), added6: 0n, added: 0, bust18: null,
      entry: px18ToNum(px18), entryPx18: px18, openedAt: openedAt != null ? openedAt : Math.floor(Date.now() / 1000) - 900,
      deadbandBps: m.inst.deadbandBps, payoutCapX: m.inst.payoutCapX, maxProfit: isFinite(cap) ? cap : margin * m.inst.payoutCapX, winFeeBps: win, lossFeeBps: loss,
      entryDeadbandBps: m.inst.entryDeadbandBps, borrowRateX10: m.inst.borrowRateX10, borrowFreeHours: free, preview: null
    };
    /* (CF_PNL) the same position in the contract's units, so the demo's cards settle it exactly as the live page does */
    if (window.ConfettiSettle) p.raw = window.ConfettiSettle.position({
      isLong: isLong, marginUsdc: numToUsd6(margin), leverage: lev, maxProfitUsdc: numToUsd6(p.maxProfit), entryPx18: px18, openedAt: p.openedAt,
      deadbandBps: p.deadbandBps, winFeeBps: win, lossFeeBps: loss, entryDeadbandBps: p.entryDeadbandBps, borrowRateX10: p.borrowRateX10, borrowFreeHours: free
    }, feeX10);
    return p;
  }

  function demoSeed() {
    var doge = state.bySym.DOGE, wif = state.bySym.WIF, eth = state.bySym.ETH;
    if (!doge || !wif || doge.instrumentId == null || wif.instrumentId == null) return;
    var pd = state.mids[doge.coin], pw = state.mids[wif.coin], pe = eth ? state.mids[eth.coin] : 0;
    var p1 = demoPos(doge, true, 10, 20, pd * 0.994);   /* in profit */
    var p2 = demoPos(wif, false, 10, 50, pw * 0.989);   /* a loss, its liquidation getting close (amber) */
    var p3 = eth && eth.instrumentId != null && pe > 0 ? demoPos(eth, false, 15, 5, pe * 1.01) : null;   /* 3rd position on ETH, short */
    acct.positions = p3 ? [p1, p2, p3] : [p1, p2];
    acct.available = 50; acct.marginInUse = p3 ? 35 : 20; acct.pending = 0; acct.loaded = true; acct.owner = wallet.account;
    if (PRACTICE) { acct.positions = []; acct.marginInUse = 0; }   /* the practice run starts with nothing open */
    /* &bal=20: the balance (a low-balance ticket) */
    if (demoOpt('bal') !== '' && isFinite(Number(demoOpt('bal')))) acct.available = Number(demoOpt('bal'));
    var wpid = String(p2.id);
    /* ?demo=idle: both positions open and nothing in flight (the Position sheet, Close all) */
    if (DEMO !== 'idle' && !PRACTICE) {
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
    var logs = [[demoLog('Deposited', [me, me, numToUsd6(70)], demoHash()), 10800],
     [demoLog('PositionOpened', [61n, me, doge.instrumentId, true, numToUsd6(10), 50, e61, 31n, true], demoHash()), 10200],
     [demoLog('PositionClosed', [61n, me, x61, usd(w61), usd(w61 * 0.05), usd(10 + w61 * 0.95), 0n, 0n, true], demoHash()), 9000],
     [demoLog('PositionOpened', [62n, me, wif.instrumentId, false, numToUsd6(10), 50, e62, 32n, true], demoHash()), 7200],
     [demoLog('PositionClosed', [62n, me, x62, usd(l62), usd(-l62 * 0.05), usd(10 + l62 * 1.05), 0n, 0n, true], demoHash()), 6600],
     [demoLog('PositionOpened', [63n, me, doge.instrumentId, true, numToUsd6(10), 50, e63, 33n, true], demoHash()), 5400],
     [demoLog('PositionLiquidated', [63n, me, me, x63, numToUsd6(10), numToUsd6(0.05), 0n], demoHash()), 4800],
    ];
    /* the open positions: each open with, on v5, the log of what opening it took (none when that is 0) */
    var seedOpen = function (p, isLong, usdIn, lev, req, ago) {
      var hsh = demoHash();
      logs.push([demoLog('PositionOpened', [p.id, me, p.instrumentId, isLong, numToUsd6(usdIn), lev, p.entryPx18, req, true], hsh), ago]);
      demoFeeLog(p.id, 0, usdIn * lev, p.openFee, hsh).forEach(function (l) { logs.push([l, ago]); });
    };
    seedOpen(p1, true, 10, 20, 41n, 900);
    seedOpen(p2, false, 10, 50, 42n, 600);
    if (p3) seedOpen(p3, false, 15, 5, 43n, 300);
    logs.filter(function (x) { return !PRACTICE || x[1] > 1000; }).forEach(function (x) { hist.blockTs[x[0].blockNumber] = now - x[1]; addLogs([x[0]]); });   /* the practice run keeps the three past outcomes only */
    hist.done = true;
    if (DEMO === 'pending') {
      /* an open request the ticket follows, held: Opening, then late, then expired */
      var id = String(demo.nextReq++);
      pend.opens[id] = { id: id, instrumentId: doge.instrumentId, isLong: true, margin: 10, leverage: 20, px0: pd, requestedAt: chainNow() - 1, block: demo.block };
      demo.hold['o' + id] = true;
      acct.available -= reqIn(pend.opens[id]); acct.pending = reqIn(pend.opens[id]);
      tkSet('req', { reqId: id, isLong: true, sym: doge.symbol, lev: 20, margin: 10 });
      openSheet();
    }
    renderAccount(); renderPositions(); renderAction(); renderForm(); renderHistory();
    if (isV5() && Number(demoOpt('liqback')) > 0) setTimeout(demoLiqBack, Number(demoOpt('liqback')) * 1000);
    if (DEMO === 'tour') setTimeout(startTour, 600);
  }

  /* A simulated transaction: about a second "in the wallet", then the state change and the
     event logs the exchange would emit. */
  function demoTx(kind, args, hooks) {
    var hash = demoHash();
    return new Promise(function (ok) { setTimeout(ok, 300); }).then(function () {
      if (hooks && hooks.sent) { try { hooks.sent(hash, { nonce: null }); } catch (e) { /* never blocks */ } }
      return new Promise(function (ok) { setTimeout(ok, 700); });
    }).then(function () {
      var logs = [];
      if (kind === 'requestOpen') {
        var inst = state.byInstId[Number(args[0])];
        var margin = usd6ToNum(args[2]);
        /* the request takes the stake and, on v5, its open fee on top */
        var hold = margin + feeOnStake(margin, feeShareFor(Number(args[0]), Number(args[3])));
        if (!inst || hold > acct.available + quickHeld() + 1e-9) throw new Error('Not enough balance in the demo.');
        acct.available -= hold; acct.pending += hold;
        var rid = BigInt(demo.nextReq++);
        logs.push(demoLog('OpenRequested', [rid, wallet.account, Number(args[0]), !!args[1], args[2], Number(args[3]), toPx18(oraclePriceFor(inst.market)), ZERO], hash));
        /* v6: the router's open with levels parks them on the request in the same transaction */
        if (hooks && hooks.trig) logs.push(demoBookLog('OpenTriggersSet', [rid, wallet.account, hooks.trig.tp18, hooks.trig.sl18], hash));
      } else if (kind === 'executeOpen') {
        var r = pend.opens[String(args[0])];
        /* a fast market past the keeper's window: the exchange refunds the request (FastPriceMissed) */
        if (r && fastOf(r.instrumentId)) {
          acct.available += reqIn(r); acct.pending = Math.max(0, acct.pending - reqIn(r));
          logs = [demoLog('OpenRequestCancelled', [BigInt(r.id), wallet.account, exIface.getError('FastPriceMissed').selector], hash)];
        } else if (r) logs = demoFillOpen(r, hash);
      } else if (kind === 'cancelOpen') {
        var r2 = pend.opens[String(args[0])];
        if (r2) { acct.available += reqIn(r2); acct.pending = Math.max(0, acct.pending - reqIn(r2)); }
      } else if (kind === 'requestClose' || kind === CLOSE_BPS) {
        /* a share close (CLOSE_BPS) is requested the same way; its share rides on the request (submitClose notes it) */
        var p = posById(args[0]);
        /* px0 is the HyperCore price, as the exchange records it (not a fast market's estimated print) */
        logs.push(demoLog('CloseRequested', [BigInt(args[0]), wallet.account, toPx18(p ? oraclePriceFor(positionMarket(p)) : 1)], hash));
      } else if (kind === 'executeClose') {
        /* past its three public seconds a fast market's held close is the owner's, at the worse of the two prices */
        var dcr0 = acct.closeReqs[String(args[0])], dp0 = posById(args[0]);
        var late = !!(dcr0 && dp0 && fastOf(dp0.instrumentId) && chainNow() - dcr0.requestedAt > closeOwnFrom(dp0.instrumentId));
        logs = demoFillClose(String(args[0]), hash, late ? ownClosePx(dp0) : null);
      } else if (kind === 'cancelClose') {
        delete demo.hold['c' + String(args[0])];
      } else if (kind === 'setTriggers') {
        logs = demoSetTriggers(args, hash);
      }
      return { hash: hash, blockNumber: demo.block, status: 1, logs: logs };
    });
  }

  /* a fast market's fill also logs the print it used (FillPriced): the one for request time + delay */
  function demoPrint(instId, kind, key, px18, requestedAt, hash) {
    var f = fastOf(instId);
    if (!f) return [];
    var at = requestedAt != null ? Math.floor(requestedAt) + f.delay : Math.floor(chainNow()) - 1;
    return [demoLog('FillPriced', [BigInt(key), instId, kind, BigInt(at), BigInt(px18), 0n], hash)];
  }

  function demoFillOpen(r, hash) {
    var inst = state.byInstId[r.instrumentId];
    /* filled as the exchange fills: the oracle print now, the entry spread against the trader (executeOpen) */
    var px18 = house.oraclePx18ById[r.instrumentId] != null ? house.oraclePx18ById[r.instrumentId] : toPx18(oraclePriceFor(inst.market));
    var entry18 = window.ConfettiSettle ? window.ConfettiSettle.openEntry(px18, r.isLong, inst.entryDeadbandBps || 0) : px18;
    var p = demoPos(inst.market, r.isLong, r.margin, r.leverage, entry18, Math.floor(chainNow()), reqShare(r));
    /* the whole reservation leaves pending: the stake into the position, the open fee to the pool */
    acct.pending = Math.max(0, acct.pending - reqIn(r));
    acct.marginInUse += r.margin;
    acct.positions.push(p);
    var log = demoLog('PositionOpened', [p.id, wallet.account, r.instrumentId, r.isLong, numToUsd6(r.margin), r.leverage, p.entryPx18, BigInt(r.id), true], hash);
    /* v5: the open fee, logged right after the open as the exchange logs it (none when it is 0) */
    var ofl = demoFeeLog(p.id, 0, r.margin * r.leverage, p.openFee, hash);
    /* the print first, so History's row for this fill already has it */
    var opl = demoPrint(r.instrumentId, 0, r.id, px18, r.requestedAt, hash);
    notePrints(opl);
    ofl.forEach(demoRecord);
    demoRecord(log);
    return [log].concat(ofl, opl);
  }

  function demoFillClose(pid, hash, atPx) {
    var p = posById(pid);
    if (!p || demo.closed[pid]) return [];
    /* v5: a request for a share fills that share and leaves the rest open */
    var dsh = acct.closeReqs[pid];
    if (dsh && dsh.bps > 0 && dsh.bps < 10000 && isV5()) return demoFillShare(pid, dsh.bps, hash);
    var est = positionEstimate(p);
    var px = closePriceFor(p);
    /* atPx: the price the exchange would use instead of the one now (the owner's late close, 16.2) */
    if (atPx > 0 && atPx !== px) { var instA = state.byInstId[p.instrumentId], eA = estimateClose(p, instA, atPx, true); eA.gross = eA.pnl; eA.tradeFee = eA.tradeFee || 0; est = eA; px = atPx; }
    demo.closed[pid] = true;
    acct.marginInUse = Math.max(0, acct.marginInUse - p.margin);
    acct.available += est.payout;
    /* pnlUsdc is the exchange's own figure (est.gross); the payout is after the close fee, logged right after (v5) */
    var log = demoLog('PositionClosed', [BigInt(pid), wallet.account, toPx18(px), BigInt(Math.round((est.gross != null ? est.gross : est.pnl) * 1e6)), BigInt(Math.round(est.fee * 1e6)), BigInt(Math.round(est.payout * 1e6)), 0n, BigInt(Math.round(est.borrow * 1e6)), true], hash);
    var cfl = demoFeeLog(BigInt(pid), 1, p.margin * p.leverage, est.tradeFee, hash);
    cfl.forEach(demoRecord);
    var dcr = acct.closeReqs[pid];
    /* a held close finished by the page (executeClose after the window) is a HyperCore-rule fill: no print */
    var cpl = demo.hold['c' + pid] ? [] : demoPrint(p.instrumentId, 1, pid, toPx18(px), dcr ? dcr.requestedAt : null, hash);
    notePrints(cpl);
    demoRecord(log);
    return [log].concat(cfl, cpl);
  }

  /* ---- v5 demo: a share close and money added to a position (the dialog further down, pmOpen) ----
     The demo has no contract to ask, so it works both with the page's own maths, the way the contract does:
     - what stays open after a share closes is the contract's _restTerms (pmRest: the stake cut by the share rounded
       down, the added money and the maximum profit cut in the same proportion);
     - a share settles as the whole position less what stays open, at one price (the contract's _closeShare), so the
       parts of a position add up to one close;
     - added money moves the liquidation price by the contract's own formula (bustPriceOf18).
     settle.js's form of a position carries the added money (the launch contracts' collateral: ExchangeBase._collateral,
     _bustPrice, _restTerms, _closeShare, held to forge's own answers), so the demo and the real page price such a
     position exactly, with the contract's own figures (chainPv) on top wherever the real page has them. */
  function demoRaw(p) {
    if (!window.ConfettiSettle) return null;
    return window.ConfettiSettle.position({
      addedMarginUsdc: p.added6 || 0n,
      isLong: p.isLong, marginUsdc: p.margin6, leverage: p.leverage, maxProfitUsdc: numToUsd6(p.maxProfit), entryPx18: p.entryPx18, openedAt: p.openedAt,
      deadbandBps: p.deadbandBps, winFeeBps: p.winFeeBps, lossFeeBps: p.lossFeeBps, entryDeadbandBps: p.entryDeadbandBps, borrowRateX10: p.borrowRateX10, borrowFreeHours: p.borrowFreeHours
    }, p.feeX10);
  }
  /* the position that stays open when bps of p closes (a copy; p is left as it is) */
  function demoRest(p, bps) {
    var r = pmRest(p, bps), q = {};
    Object.keys(p).forEach(function (k) { q[k] = p[k]; });
    q.margin6 = r.margin6; q.margin = usd6ToNum(r.margin6);
    q.added6 = r.coll6 - r.margin6; q.added = usd6ToNum(q.added6);
    q.maxProfit = p.margin6 > 0n ? usd6ToNum(numToUsd6(p.maxProfit) * r.margin6 / p.margin6) : 0;
    q.openFee = feeOnStake(q.margin, posFeeX10(p));
    q.bust18 = null; q.chainPv = null; q.preview = null;
    q.raw = demoRaw(q);
    return q;
  }
  /* what closing bps of p pays at the price now: { gross, fee, payout, borrow, tradeFee } in USD (gross: the
     exchange's own pnl figure of the share; payout: what lands in the balance), or null without a fresh price */
  function demoShare(p, bps) {
    /* the contract's own share close (settle.js previewClose with bps: ExchangeExt._previewCloseAt), at the price the
       card is priced at; the difference of two whole closes below only where that cannot be worked */
    var S = window.ConfettiSettle, inst0 = state.byInstId[p.instrumentId];
    if (S && p.raw && inst0 && inst0.raw && !inst0.retired && !priceDelayed(p)) {
      var f18 = fastPx18(p.instrumentId), px18 = f18 != null ? f18 : house.oraclePx18ById[p.instrumentId];
      if (px18 != null && px18 > 0n && !S.value(p.raw, inst0.raw, px18, BigInt(Math.floor(house.chainTs != null ? house.chainTs : Date.now() / 1000)), true).liquidated) {
        var qe = house.queueLen == null ? true : house.queueHead === house.queueLen;
        var r = S.previewClose(p.raw, inst0.raw, px18, BigInt(Math.floor(house.chainTs != null ? house.chainTs : Date.now() / 1000)), qe, bps);
        return { gross: S.usd(r.pnl), fee: S.usd(r.fee), payout: S.usd(r.payout), borrow: S.usd(r.borrow), tradeFee: S.usd(r.tradeFee) };
      }
    }
    var all = positionEstimate(p), rest = bps < 10000 ? positionEstimate(demoRest(p, bps)) : null;
    if (!all || all.delayed || !isFinite(all.payout) || (rest && (rest.delayed || !isFinite(rest.payout)))) return null;
    var g = function (e) { return e ? (e.gross != null ? e.gross : e.pnl) : 0; };
    var n = function (e, k) { return e && isFinite(e[k]) ? e[k] : 0; };
    return { gross: g(all) - g(rest), fee: n(all, 'fee') - n(rest, 'fee'), payout: Math.max(0, all.payout - n(rest, 'payout')), borrow: n(all, 'borrow') - n(rest, 'borrow'), tradeFee: n(all, 'tradeFee') - n(rest, 'tradeFee') };
  }
  /* A share close fills: its payout lands in the balance and the position stays open under its id with the rest.
     Logged as the exchange logs it (PositionPartiallyClosed, the close fee of the part, the print it used), so the
     page's real code reports it (reportShareClose). */
  function demoFillShare(pid, bps, hash) {
    var p = posById(pid);
    if (!p || demo.closed[pid]) return [];
    var sh = demoShare(p, bps) || { gross: 0, fee: 0, payout: 0, borrow: 0, tradeFee: 0 }, rest = demoRest(p, bps), px = closePriceFor(p);
    var closed6 = p.margin6 - rest.margin6, at = acct.positions.indexOf(p);
    acct.marginInUse = Math.max(0, acct.marginInUse - (posColl(p) - posColl(rest)));
    acct.available += sh.payout;
    if (at >= 0) acct.positions[at] = rest;
    var log = demoLog('PositionPartiallyClosed', [BigInt(pid), wallet.account, toPx18(px), BigInt(Math.round(sh.gross * 1e6)), numToUsd6(Math.max(0, sh.fee)), numToUsd6(sh.payout), 0n,
      numToUsd6(Math.max(0, sh.borrow)), true, bps, closed6, rest.margin6, rest.added6, numToUsd6(rest.maxProfit)], hash);
    var cfl = demoFeeLog(BigInt(pid), 1, usd6ToNum(closed6) * p.leverage, sh.tradeFee, hash);
    cfl.forEach(demoRecord);
    var dcr = acct.closeReqs[pid];
    var cpl = demo.hold['c' + pid] ? [] : demoPrint(p.instrumentId, 1, pid, toPx18(px), dcr ? dcr.requestedAt : null, hash);
    notePrints(cpl);
    demoRecord(log);
    return [log].concat(cfl, cpl);
  }
  /* Money added to a position: about a second "in the wallet", then it is in. From the balance into the position,
     the liquidation price on the larger collateral, MarginAdded in History. Resolves true; a refusal says why
     (pm.addSay), as submitAddMargin's does. */
  function demoAddMargin(pos, amt6) {
    setBusy(true);
    return new Promise(function (ok) { setTimeout(ok, 700); }).then(function () {
      pm.addSent = true; pmRender();      /* the pretend wallet said yes */
      return new Promise(function (ok) { setTimeout(ok, 900); });
    }).then(function () {
      var p = posById(pos.id), amt = usd6ToNum(amt6), pid = String(pos.id);
      if (!p || demo.closed[pid]) throw new Error('That position is gone.');
      if (amt > acct.available + 1e-9) throw new Error('Not enough balance in the demo.');
      p.added6 = (p.added6 || 0n) + amt6; p.added = usd6ToNum(p.added6); p.bust18 = null; p.chainPv = null;
      p.raw = demoRaw(p);
      acct.available -= amt; acct.marginInUse += amt;
      var bust18 = posBust18(p), m = positionMarket(p);
      demoRecord(demoLog('MarginAdded', [p.id, wallet.account, amt6, p.added6, bust18], demoHash()));
      pm.last[pid] = { kind: 'add', amt: amt, endPx: px18ToNum(bust18), at: Date.now() };
      toast('Added ' + fmtUsd(amt) + ' to your ' + posLabel(p) + '. Liquidation now ' + fmtPrice(px18ToNum(bust18), m ? m.szDecimals : null) + '.', 'ok');
      demoRefresh();
      return true;
    }).catch(function (e) {
      pm.addSay = e && e.message ? e.message : 'It did not go in.';
      return false;
    }).then(function (ok) { setBusy(false); return ok; });
  }

  /* &liqback=N (v5 demo): N seconds in, the first position has $4 added and is liquidated on a price from before
     that add. The exchange judges it without the add and gives the $4 back (V5P_SPEC 16.1): MarginAdded, then
     PositionLiquidated on the stake alone with MarginReturned right after it. The balance ends where it was. */
  function demoLiqBack() {
    var p = acct.positions[0];
    if (!p || !isV5() || demo.closed[String(p.id)] || acct.closeReqs[String(p.id)]) return;
    var pid = String(p.id), me = wallet.account, add = 4, hash = demoHash(), bust18 = posBust18(p);
    demoRecord(demoLog('MarginAdded', [p.id, me, numToUsd6(add), numToUsd6(add), bust18], demoHash()));
    demo.closed[pid] = true;
    acct.marginInUse = Math.max(0, acct.marginInUse - p.margin);
    var logs = [demoLog('PositionLiquidated', [p.id, me, me, bust18, numToUsd6(p.margin), numToUsd6(p.margin * 0.005), 0n], hash), demoLog('MarginReturned', [p.id, me, numToUsd6(add)], hash)];
    logs[1].index = 1;   /* its own log index in the same transaction, right after the liquidation */
    logs.forEach(demoRecord);
    reportCloseOutcome(pid, logs, hash, p);
    setTimeout(demoRefresh, 1200);
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
      if (r.busy || demo.hold['o' + r.id] || now - r.requestedAt < fillSecs(r.instrumentId)) return;
      var hash = demoHash();
      var logs = demoFillOpen(r, hash);
      delete pend.opens[r.id];
      reportOpenOutcome(r, logs, hash);
    });
    Object.keys(acct.closeReqs).forEach(function (pid) {
      var cr = acct.closeReqs[pid];
      if (cr.busy || demo.hold['c' + pid] || now - cr.requestedAt < fillSecs(crInst(pid))) return;
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
    if ((dm && dm.open) || depSwapShow() || depSwapSmall() || (setup.on && (setup.step === 'hype' || setup.step === 'bridge'))) { refreshWalletUsdc(); if (typeof swRefreshBalances === 'function') swRefreshBalances(); }
    if (keeper && Date.now() - keeperAt >= KEEPER_EVERY_MS) { keeperAt = Date.now(); keeper.refresh().then(renderStatus); }
    if (brOn() && wallet.account && !br.busy) brRefreshBal();   /* the Bring ETH card's balance line and Max */
  }

  function onVisibility() {
    syncLiveFeed();
    syncFastFeed();
    syncHeads();
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
      setInterval(syncFastFeed, 1000);
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
        setInterval(tickOracle, ORACLE_EVERY_MS);
        setInterval(syncFastFeed, 1000);
        /* (CF_PNL) the block feed: the P&L cards and the fill watch, block by block */
        syncHeads();
        setInterval(syncHeads, 1000);
        setInterval(function () { if (!document.hidden) loadInstruments(); }, INSTRUMENTS_EVERY_MS);
        setInterval(function () { if (!document.hidden) loadFast(); }, FAST_EVERY_MS);
        setTimeout(tryAutoConnect, 50);
        setTimeout(watchExternalConnect, EXT_POLL_MS);
      });
    }
    /* the first-trade tour: once the silent reconnect has had its chance, for a visitor or a
       wallet that has not seen it (a wallet connecting later starts it from onChainChanged) */
    /* First steps: re-read what the wallet has once a second (renderAction calls it too) */
    setInterval(function () { try { setupRender(); } catch (e) { /* ignore */ } }, 1000);
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
    'function unwrapWETH9WithFee(uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable',
    'function sweepTokenWithFee(address token, uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable',
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
    var v3 = q.route.kind === 'v3';
    var outEl = $('swGet'); if (outEl) outEl.value = q.out > 0n ? swFmt(v3 ? swNet(q.out) : q.out, T[sw.get].dec) : '';
    var unit = amt > 0 ? Number(E.formatUnits(q.out, T[sw.get].dec)) / amt : 0;
    setText('swQuote', '1 ' + sw.pay + ' = ' + String(Number(unit.toPrecision(5))) + ' ' + sw.get + ' · moves the pool ' + q.impact.toFixed(q.impact < 0.1 ? 2 : 1) + '% · ' + (v3 ? 'HyperSwap V3' + swFeeNote() : 'HyperSwap V2'));
    setText('swTerms', 'min received ' + swFmt(v3 ? swNet(q.minOut) : q.minOut, T[sw.get].dec) + ' ' + sw.get);
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
  /* The Confetti fee on a V3 swap (the owner, 2026-11-02: "1% on hype to usdc"): taken by HyperSwap's own router inside
     the swap call (sweepTokenWithFee / unwrapWETH9WithFee, capped at 100 bips by the router) to the fee wallet in
     config.fees; nothing extra to sign. Shown net: the amount and min received are what the wallet gets. */
  function swFeeBips() { var f = feeCfg(); return f.wallet ? f.swapBips : 0; }
  function swNet(x) { var b = swFeeBips(); return b ? x - (x * BigInt(b)) / 10000n : x; }
  function swFeeNote() { var b = swFeeBips(); return b ? ' · Confetti fee ' + (b / 100) + '%' : ''; }
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
    if (bal != null && !DEMO) {   /* the demo's pretend address holds nothing on chain: it still shows quotes */
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
      var net = route.kind === 'v3' ? swNet(out) : out;
      outEl.value = out > 0n ? swFmt(net, T[sw.get].dec) : '';
      var unit = Number(E.formatUnits(out, T[sw.get].dec)) / amt;
      setText('swQuote', '1 ' + sw.pay + ' = ' + String(Number(unit.toPrecision(5))) + ' ' + sw.get + ' · moves the pool ' + impact.toFixed(impact < 0.1 ? 2 : 1) + '% · ' + (route.kind === 'v3' ? 'HyperSwap V3' + swFeeNote() : 'HyperSwap V2'));
      if (minOut == null) { setText('swTerms', 'Too big for this pool right now: try a smaller amount.'); swRenderGo(); return; }
      sw.quote = { route: route, amountIn: amountIn, out: out, minOut: minOut, impact: impact, at: Date.now(), slip: sw.slip };
      if (sw.pay === 'HYPE' && sw.get === 'USDC') swNoteHypeUsd(amountIn, out);
      setText('swTerms', 'min received ' + swFmt(route.kind === 'v3' ? swNet(minOut) : minOut, T[sw.get].dec) + ' ' + sw.get);
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
    var bips = swFeeBips(), feeTo = feeCfg().wallet;
    var params = {
      tokenIn: pay.addr, tokenOut: get.addr, fee: q.route.fee,
      // HYPE out, or a fee: the router keeps the output and pays it out (less the fee) in the same call
      recipient: get.native || bips ? swapCfg().v3Router : wallet.account,
      deadline: deadline, amountIn: q.amountIn, amountOutMinimum: q.minOut, sqrtPriceLimitX96: 0n,
    };
    var calls = [v3.interface.encodeFunctionData('exactInputSingle', [params])];
    if (get.native) calls.push(bips ? v3.interface.encodeFunctionData('unwrapWETH9WithFee', [q.minOut, wallet.account, BigInt(bips), feeTo]) : v3.interface.encodeFunctionData('unwrapWETH9', [q.minOut, wallet.account]));
    else if (bips) calls.push(v3.interface.encodeFunctionData('sweepTokenWithFee', [get.addr, q.minOut, wallet.account, BigInt(bips), feeTo]));
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
  function swOnWallet() { try { swRefreshBalances(); swRenderGo(); } catch (e) { /* never blocks the page */ } try { brRenderTerms(br.quote); brRenderGo(); } catch (e) { /* the box renders when it exists */ } }   /* the fee lines read config, which lands after init */


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
    if (isSheetMode()) closeSheet();   /* phones: the sheet gives way to Orders, where the row now sits */
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
  /* v5: the stake a limit order opens with. One placed in Simple carries the amount it may take (o.amount): its
     stake is the most that fits in it with the open fee on top. One placed on the Pro ticket carries the stake. */
  function limStake(o, m) { return o.amount > 0 ? stakeOfAmount(o.amount, m && m.instrumentId != null ? feeShareFor(m.instrumentId, o.lev) : 0) : o.margin; }
  /* what the order takes from the balance when it fires */
  function limIn(o) { var m = state.bySym[o.sym]; return o.amount > 0 ? o.amount : amountOfStake(o.margin, m && m.instrumentId != null ? feeShareFor(m.instrumentId, o.lev) : 0); }
  function limitProblem(o, m) {
    var keep = { market: state.market, side: form.side, margin: form.margin, lev: form.lev };
    state.market = m; form.side = o.isLong ? 'long' : 'short'; form.lev = o.lev; form.margin = limStake(o, m);
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
    if (acct.loaded && acct.available < limIn(o)) return 'waiting: balance short';
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
    form.lev = o.lev; form.margin = limStake(o, m); form.maxed = !!o.maxed;   // form.lev direct: no clamp, no LS.lev write
    var mi = $('marginInput'); if (mi) mi.value = String(form.margin);       // the box says what the button says
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
    onDeskChange(function () { renderLimits(); });   // (2026-11-02) the picker is on every width now
    limLoad();
  }

  /* ---- Take profit / Stop loss (the owner, 2026-10-26: "set it up the best way") -------------------------------
     v4's Exchange takes a close only from the trader's wallet or the SessionRouter fixed at deploy, so a TP/SL is
     not an on-chain order. It is a rule this browser keeps per position (storage, as the limit orders) and fires
     as the same close request the Close button sends, through the session key when one-click is on. It works
     while this page is open; the ticket, the rows and the phone sheet say so. A rule typed before the open is
     parked under the request id and adopted when PositionOpened names the position. */
  var tpsl = { rules: {}, pending: {}, missed: {}, firing: null, forKey: null, unsaved: false, editing: {}, confirm: {} };
  var TPSL_CLAIM_MS = 60000;       // a claimed rule is closing from some tab for this long
  var TPSL_HOLD_MS = 5 * 60000;    // a refused close waits this long before it tries again
  var TPSL_NEW_MS = 60000;         // a fill this fresh may not be among the read positions yet
  /* the launch exchange keeps its rules under a key of its own: its position ids start again at 1, and the v4 rules stay
     where the v4 run-off page (v4.html) reads them, for the v4 positions they were set on (V5P_SPEC 18.12) */
  function tpslKey() { var g = isV6() ? 'tpsl6.' : 'tpsl.'; return 'confetti.trade.' + g + (wallet.account && !DEMO ? wallet.account.toLowerCase() : 'demo'); }
  function tpslLoad() {
    var k = tpslKey(), raw = lsGet(k);
    if (raw == null && tpsl.unsaved && tpsl.forKey === k) { tpslRedraw(); return; }   // storage blocked: this tab's rules stay
    tpsl.forKey = k;
    var d = null; try { d = JSON.parse(raw || 'null'); } catch (e) { d = null; }
    tpsl.rules = (d && d.rules) || {}; tpsl.pending = (d && d.pending) || {}; tpsl.missed = (d && d.missed) || {};
    tpslRedraw();
  }
  function tpslSave() {
    var s = JSON.stringify(Object.keys(tpsl.missed).length ? { rules: tpsl.rules, pending: tpsl.pending, missed: tpsl.missed } : { rules: tpsl.rules, pending: tpsl.pending }); lsSet(tpslKey(), s);
    if ((Object.keys(tpsl.rules).length || Object.keys(tpsl.pending).length || Object.keys(tpsl.missed).length) && lsGet(tpslKey()) !== s && !tpsl.unsaved) {
      tpsl.unsaved = true; tpsl.forKey = tpslKey();
      toast('This browser is not saving site data: the take profit / stop loss lives only until this tab closes.', 'err');
    }
    tpslRedraw();
  }
  function tpslNum(v) { v = String(v == null ? '' : v).trim(); if (v === '') return null; var n = Number(v); return isFinite(n) ? n : NaN; }
  /* a position's levels (or, for the ticket's pseudo-position, the next open's) go on chain (v6): no 0.1% rule for them */
  function tpslChain(p) { return !!p && (p.entryPx18 == null && !p.openedAt ? trigMarket(p.instrumentId) : trigWhere(p) === 'chain'); }
  function tpslDec(pos) { var m = positionMarket(pos); return m && m.szDecimals != null ? m.szDecimals : 4; }
  /* The checks: a take profit on the winning side of the price, a stop on the losing side and short of the
     liquidation price (a stop past it could never fire: the position is liquidated first). entry is the
     position's price (the price itself for the ticket). Returns the sentence that refuses, or ''.
     chain (a level on chain): no 0.1% rule. The browser rule fires a stop 0.1% early (so it closes before its
     level); an on-chain stop fires at the first print past it, so a stop next to the price is the trader's to set.
     (amt4) bust, when given, is the chain's own closing price (tpslBust: bustPrice(id) of an open trade, the bust of the
     price it would fill at for one not opened yet), and the stop is held to that: the exchange liquidates AT that price
     too (ImpactLib.isBusted; the TriggerBook's band reads a print at the bust as a liquidation before it reads the
     stop), so a stop on it is refused; the last 1e-12 covers the float of an 18-digit price. */
  function tpslProblem(isLong, lev, entry, px, tp, sl, sz, chain, bust) {
    var side = sideWord(isLong).toLowerCase(); if (!(bust > 0)) bust = bustPriceNum(entry, isLong, lev);
    var edge = bust > 0 ? bust * 1e-12 : 0;
    if (tp != null && !(tp > 0)) return 'Type a take profit price, or leave it empty.';
    if (sl != null && !(sl > 0)) return 'Type a stop loss price, or leave it empty.';
    if (tp == null && sl == null) return 'Type a take profit or a stop loss price.';
    if (!(px > 0)) return TPSL_WAIT;   /* (amt5) no price read from the chain: nothing is accepted, the box waits */
    if (tp != null && px > 0 && (isLong ? tp <= px : tp >= px)) return 'A take profit for a ' + side + ' goes ' + (isLong ? 'above' : 'below') + ' the price, now ' + fmtPrice(px, sz) + '.';
    if (sl != null && px > 0 && (isLong ? sl >= px : sl <= px)) return 'A stop loss for a ' + side + ' goes ' + (isLong ? 'below' : 'above') + ' the price, now ' + fmtPrice(px, sz) + '.';
    if (!chain && sl != null && px > 0 && (isLong ? sl * (1 + LIM_TOL) >= px : sl * (1 - LIM_TOL) <= px)) return 'That stop is within 0.1% of the price: it would close right now. Use Close, or set it further away.';
    if (sl != null && bust > 0 && (isLong ? sl <= bust + edge : sl >= bust - edge)) return 'That stop is past the liquidation price, ' + fmtPrice(bust, sz) + ': the position would be liquidated first. Set it ' + (isLong ? 'higher' : 'lower') + '.';
    return '';
  }
  /* The price a few typed digits mean on this market: the number moved by a power of ten until it sits within
     half of the current price, so "772" on a 0.0772 market reads 0.0772 and "7.7" reads 0.077. null when the
     number already reads as typed (or is not a number yet). */
  function tpslComplete(raw, now, sz) {
    var n = tpslNum(raw); if (n == null || !(n > 0) || !(now > 0)) return null;
    var best = null;
    for (var k = -8; k <= 8; k++) {
      var c = n * Math.pow(10, k), ratio = c / now;
      if (ratio >= 0.5 && ratio <= 2 && (best == null || Math.abs(ratio - 1) < Math.abs(best.ratio - 1))) best = { k: k, px: c, ratio: ratio };
    }
    if (!best || best.k === 0) return null;
    var px = Number(fmtPrice(best.px, sz)); return px > 0 ? px : null;
  }
  /* The position's close maths (fees, impact curve, borrow) at that price: how far the price is from now (away, a share
     of now), the dollar result there (pnl) and that against what went in (pct of margin). tpslLine words it for Pro;
     Simple's boxes word the same numbers their own way (smApi.autoRead), so the two can never disagree. */
  function tpslNums(p, px, now) {
    var inst = state.byInstId[p.instrumentId], queueEmpty = house.queueLen == null ? true : house.queueHead === house.queueLen;
    var est = estimateClose(p, inst, px, queueEmpty);
    /* against what went in (both size charges counted, and the borrow so far: netPnl's rule). (amt3) At or past the
       price it closes itself at, the exchange liquidates it first: nothing comes back */
    var inAmt = posIn(p), bust = tpslBust(p);
    if (bust > 0 && px > 0 && (p.isLong ? px <= bust : px >= bust)) est = { net: -inAmt, payout: 0 };
    return { away: now > 0 ? px / now - 1 : NaN, pnl: est.net, pct: inAmt > 0 ? est.net / inAmt : 0, margin: inAmt, back: est.payout };   /* back: what a close there gives back */
  }
  /* "Stop loss 0.077000 · 0.29% below now · about -$0.60 (-6.00% of your $10.00)" */
  function tpslLine(p, kind, px, now) {
    var r = tpslNums(p, px, now), sz = tpslDec(p), away = r.away;
    return (kind === 'tp' ? 'Take profit ' : 'Stop loss ') + fmtPrice(px, sz)
      + (isFinite(away) ? ' · ' + Math.abs(away * 100).toFixed(2) + '% ' + (away >= 0 ? 'above' : 'below') + ' now' : '')
      + ' · about ' + fmtUsd(r.pnl, true) + ' (' + fmtPct(r.pct, true) + ' of your ' + fmtUsd(r.margin) + ')';
  }
  /* The ticket's would-be position at the current price, for the readout before an open. (amt2) It opens where a real
     one does: the price moved by the market's entry spread against the trader (spreadEntry, as executeOpen books it and
     as pretendPos does for the ticket's money lines), so a level's readout is what that level really brings. It read
     from the price itself before: too good by spread x leverage of the amount put in (2 bps at 1000x: a fifth of it).
     print keeps the price it was read at: the checks (tpslProblem) are measured from that, as the exchange works the
     liquidation price from the print and never from the spread entry, so which prices are taken is unchanged. */
  /* (amt3) and it opens at the oracle print (openPriceFor, as the ticket's money lines and the cards price), not at the
     book mid: the mid sits up to 15 bps off the print (measured), at 1000x more than the whole amount.
     (amt4, the lead's call after three reviews) The CHECKS are measured from that print too, and so is "now": the
     exchange fills, liquidates and lets a stop fire at its own oracle print, never at the book mid. Held to the mid, the
     sheet took stops that could never fire (21 of 49 with the mid 9.5 bps under the print) and refused ones that could,
     naming a closing price the chain does not have. printFor: the print as the chain last gave it, NaN while it is
     still being read (the first second or two of a sheet on a coin no card shows): then nothing is checked or shown
     against the mid, the boxes wait (TPSL_WAIT). tpslBust: the price a trade closes itself at, the chain's own. */
  var TPSL_WAIT = 'One moment: reading the price.';
  function printFor(m) {
    var id = m ? m.instrumentId : null, opx = id != null ? house.oraclePxById[id] : NaN, at = id != null ? house.oraclePxAt[id] : 0;
    return opx > 0 && at && Date.now() - at < PX_FRESH_MS ? opx : NaN;
  }
  /* (amt5) "now" for an open trade's boxes: the chain's print as well, or NaN and the box waits. It was the cards' display
     price, which falls back to the chart mid when chain reads fail for 15 s: with the mid 20 bps over the last print the
     sheet took an Up x100 stop above that print. The chart never decides what is accepted. */
  /* THE LAUNCH EXCHANGE (ported from the v4 rule above, not copied). A fast market's fills, levels and liquidations are
     judged on Pyth's print in USDT terms, which the page cannot read; its own best figure for the next print is fastPx18
     (the HyperCore price the chain gives, carried by the last print the exchange logged). levelNow: that figure, and only
     while the chain's own read under it is fresh (printFor): the chart alone never decides what is accepted, on any
     market. A market off Pyth (PEOPLE): the chain's oracle print itself, as on v4. */
  function levelNow(x) {
    var at = printFor(x); if (!(at > 0)) return NaN;
    var id = x.instrumentId, f = id != null && fastOf(id) ? fastPx18(id) : null;
    return f != null ? px18ToNum(f) : at;
  }
  function tpslNow(p) { return levelNow(p); }
  function tpslBust(p) { return p.bust > 0 ? p.bust : p.entryPx18 != null ? px18ToNum(posBust18(p)) : bustPriceNum(p.entry, p.isLong, p.leverage); }
  function tpslPseudo(m, isLong, lev, at) {
    var o18 = house.oraclePx18ById[m.instrumentId], bust = o18 != null && at === house.oraclePxById[m.instrumentId] ? px18ToNum(bustPrice18(o18, isLong, lev)) : bustPriceNum(at, isLong, lev);
    /* with the size charge a trade opened now would carry (the stamp, and the open side on top of this stake) */
    var share = feeShareFor(m.instrumentId, lev);
    return { instrumentId: m.instrumentId, entry: spreadEntry(at, isLong, m.inst), print: at, bust: bust, entryPx18: null, isLong: isLong, margin: form.margin, leverage: lev, openedAt: 0, winFeeBps: -1, lossFeeBps: -1, deadbandBps: 0, maxProfit: -1,
      feeX10: share, openFee: feeOnStake(form.margin, share) };
  }
  /* Under a price box, as it is typed: the completion to take ("→ 0.077200?", Enter takes it), else the refusal
     in red, else the readout. Returns 'fin' while a completion is offered, the refusal, or ''. */
  function tpslFieldRead(readEl, input, kind, p, now, onChange) {
    readEl.textContent = ''; input.classList.remove('is-bad');
    var raw = input.value, n = tpslNum(raw);
    if (n == null) return '';
    var sz = tpslDec(p), done = tpslComplete(raw, now, sz);
    if (done != null) {
      var b = el('button', 'tpsl-fin', '→ ' + fmtPrice(done, sz) + '?'); b.type = 'button';
      b.addEventListener('click', function () { input.value = String(done); onChange(); });
      readEl.appendChild(b); readEl.appendChild(document.createTextNode(' Enter takes it'));
      return 'fin';
    }
    var why = tpslProblem(p.isLong, posLev(p), p.entry, now, kind === 'tp' ? n : null, kind === 'sl' ? n : null, sz, tpslChain(p), tpslBust(p));
    if (why) { input.classList.add('is-bad'); readEl.appendChild(el('span', 'is-bad', why)); return why; }
    readEl.textContent = tpslLine(p, kind, n, now);
    return '';
  }
  /* The same reading for Simple's boxes, as data: { n } nothing typed (n null), { n, fin } the price a few typed digits
     mean (finish it first), { n, why } the refusal, else { n, away, pnl, pct, margin } (tpslNums). The very checks above. */
  function tpslRead(p, kind, raw, now) {
    var n = tpslNum(raw); if (n == null) return { n: null };
    var sz = tpslDec(p), done = tpslComplete(raw, now, sz);
    if (done != null) return { n: n, fin: done };
    var why = tpslProblem(p.isLong, posLev(p), p.entry, now, kind === 'tp' ? n : null, kind === 'sl' ? n : null, sz, tpslChain(p), tpslBust(p));
    if (why) return { n: n, why: why };
    var r = tpslNums(p, n, now); r.n = n; return r;
  }
  /* The ticket's two boxes (desktop): what they ask for the next open, and why it is refused. */
  function tpslTicketWant(m, isLong, lev) {
    var ti = $('dkTpPx'), si = $('dkSlPx');
    if (!ti || !si || !isDesk() || !m) return { tp: null, sl: null, why: '' };
    var tp = tpslNum(ti.value), sl = tpslNum(si.value);
    if (tp == null && sl == null) return { tp: null, sl: null, why: '' };
    var px = levelNow(m); if (!(px > 0)) return { tp: tp, sl: sl, why: TPSL_WAIT };
    /* a number the completion would move is not finished: say what it probably means */
    var ft = tpslComplete(ti.value, px, m.szDecimals), fs = tpslComplete(si.value, px, m.szDecimals);
    if (ft != null) return { tp: tp, sl: sl, why: 'Finish the take profit price: did you mean ' + fmtPrice(ft, m.szDecimals) + '?' };
    if (fs != null) return { tp: tp, sl: sl, why: 'Finish the stop loss price: did you mean ' + fmtPrice(fs, m.szDecimals) + '?' };
    return { tp: tp, sl: sl, why: tpslProblem(isLong, lev, px, px, tp, sl, m.szDecimals, trigMarket(m.instrumentId), tpslPseudo(m, isLong, lev, px).bust) };
  }
  /* The ticket's hint, as the boxes are typed: a completion to take, a refusal, or the readout for each level. */
  function tpslTicketCheck() {
    var m = state.market, ti = $('dkTpPx'), si = $('dkSlPx'), h = $('dkTpSlHint'); if (!m || !ti || !si || !h) return;
    var isLong = form.side === 'long', now = levelNow(m);
    if (!(now > 0)) { h.textContent = tpslNum(ti.value) == null && tpslNum(si.value) == null ? 'Optional. Closes the position for you from this page while it is open.' : TPSL_WAIT; return; }
    var p = tpslPseudo(m, isLong, form.lev, now);
    h.textContent = ''; var any = false, bad = false, fin = false;
    [[ti, 'tp'], [si, 'sl']].forEach(function (x) {
      var i = x[0], kind = x[1];
      if (tpslNum(i.value) == null) { i.classList.remove('is-bad'); return; }
      any = true;
      var line = el('div', 'tpsl-read');
      var r = tpslFieldRead(line, i, kind, p, now, tpslTicketCheck);
      if (r === 'fin') fin = true; else if (r) bad = true;
      h.appendChild(line);
    });
    var onChain = trigMarket(m.instrumentId);
    if (!any) h.textContent = onChain ? 'Optional. ' + TRIG_SAY_ALWAYS : 'Optional. Closes the position for you from this page while it is open.';
    else if (fin) h.appendChild(el('div', '', 'Finish the price first: Enter takes the one offered.'));
    else if (!bad) h.appendChild(el('div', '', onChain ? 'Set with the open, on chain. ' + TRIG_SAY_ALWAYS + (tpslNum(si.value) != null ? ' ' + trigStopSay(form.lev) : '') : 'Set for the next open. Closes from this page while it is open.'));
  }
  /* A LEVEL TYPED WITH AN OPEN IS NEVER LOST IN SILENCE (two rare gaps found on the live page, 2026-11-20; closed here for
     the launch, where a fast market fills 2 to 4 s after the request).
     1. The fill seen before the request's receipt. The levels are parked when the receipt names the request; the block
        feed can show the fill first (a slow receipt, a 2 s market). The fill then found nothing parked, and the levels
        parked a moment later waited for a fill that had already been. Every fill this page sees is noted (tpslNoteFill);
        levels parked for a request that has already filled go on its position at once (tpslPark; trigParked for the
        levels parked on chain).
     2. The fill that lands while the page reloads. The parked levels are in storage, but no page saw the fill, so nobody
        adopted them. tpslSweep (every check, once the account is read): a parked request this page does not track any more
        is looked up in the exchange's own logs from its block: filled, the levels go on its position, checked against
        the fill like any other (tpslFillCheck, on the event's figures and once more on the position); refunded or
        cancelled, they go; still waiting on chain, the page's own scan takes it. Nothing is guessed from the positions. */
  var TPSL_SWEEP_MS = 12000, TPSL_SWEEP_EVERY_MS = 20000, TPSL_PARK_MAX_MS = 24 * 3600000, tpslFills = {}, tpslSweeping = {};
  function tpslNoteFill(reqId, pid, a, at) {
    var now = Date.now();
    Object.keys(tpslFills).forEach(function (k) { if (now - tpslFills[k].seen > 10 * 60000) delete tpslFills[k]; });
    tpslFills[String(reqId)] = { pid: String(pid), a: a, at: at || 0, seen: now };
  }
  function tpslPark(reqId, want, m, isLong, lev, block) {
    tpsl.pending[reqId] = { tp: want.tp, sl: want.sl, sym: m.symbol, isLong: isLong, lev: lev, at: Date.now(), block: block > 0 ? block : null }; tpslSave();
    var ti = $('dkTpPx'), si = $('dkSlPx'); if (ti) ti.value = ''; if (si) si.value = ''; tpslTicketCheck();
    /* (gap 1) its fill was seen before this receipt: on the position now */
    var f = tpslFills[String(reqId)];
    if (f) { try { tpslAdopt(String(reqId), f.pid, f.a); } catch (e) { /* the sweep is the second chance */ } }
  }
  function tpslSweep() {
    if (DEMO || !wallet.account || !acct.loaded || !read.exchange || !read.logProvider || !exIface || !isAddr(cfg.contracts && cfg.contracts.exchange)) return;
    var now = Date.now(), account = wallet.account, E = window.ethers;
    Object.keys(tpsl.pending).forEach(function (reqId) {
      var w = tpsl.pending[reqId];
      if (!w || pend.opens[reqId] || tpslSweeping[reqId] > now - TPSL_SWEEP_EVERY_MS || now - (w.at || 0) < TPSL_SWEEP_MS) return;
      if (tpslFills[reqId]) { tpslAdopt(reqId, tpslFills[reqId].pid, tpslFills[reqId].a); return; }
      tpslSweeping[reqId] = now;
      var head = house.block || 0, age = Math.ceil((now - (w.at || now)) / 1000);
      var from = w.block > 0 ? w.block : Math.max(0, head - age * 2 - 600);
      read.exchange.openRequest(BigInt(reqId)).then(function (r) {
        if (wallet.account !== account || !tpsl.pending[reqId]) return null;
        if (r && r.trader && !/^0x0{40}$/i.test(String(r.trader))) return null;      /* still waiting on chain: the page's own scan tracks it */
        return Promise.all([
          read.logProvider.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: 'latest', topics: [exIface.getEvent('PositionOpened').topicHash, null, E.zeroPadValue(account, 32)] }),
          read.logProvider.getLogs({ address: cfg.contracts.exchange, fromBlock: from, toBlock: 'latest', topics: [exIface.getEvent('OpenRequestCancelled').topicHash, topicId(reqId)] })
        ]).then(function (res) {
          if (wallet.account !== account || !tpsl.pending[reqId]) return;
          var hit = parsedLogs(res[0]).filter(function (p) { return p.name === 'PositionOpened' && String(p.args.requestId) === String(reqId); })[0];
          if (hit) { tpslNoteFill(reqId, String(hit.args.positionId), hit.args, 0); tpslAdopt(reqId, String(hit.args.positionId), hit.args); return; }
          /* refunded or cancelled (its own log), or older than a day with no fill in reach: never a level on some other trade */
          if (parsedLogs(res[1]).length || now - (w.at || 0) > TPSL_PARK_MAX_MS) tpslDropPending(reqId);
        });
      }).catch(function () { /* the next sweep asks again */ });
    });
  }
  /* (amt5) THE CHECK AT THE FILL. The sheet took the levels against the print it had; the trade fills a few seconds later
     at a newer print, and its closing price is worked from that one (bustPrice(id)). So each parked level is held once
     more to the opened position, by the open trade's own rule: "now" is the print it filled at (its entry before the
     spread, ImpactLib.rawEntry) and the closing price is the position's. A level that would fire at once (the trigger
     itself is asked, tpslCrossed at the fill print: the wrong side of the fill, or a stop within the 0.1% it fires early
     by) or can no longer fire (a stop at or past the closing price: the exchange liquidates there, ImpactLib.isBusted;
     compared in the chain's 18 digits, the typed number read digit for digit) is NOT put on the trade: tpslFillCheck
     gives it back under miss, the trade opens without it and its card says so once (tpsl.missed; Simple:
     positions().missed, until the card's key is pressed or a level is set). A level that is still fine goes on
     unchanged. The fill print is read digit for digit too (formatUnits), so a level typed exactly on it is seen as on
     it (Number(x) / 1e18 is a float step under 62,071.3). Measured before: WIF Up x500, stop 0.133879 taken at 0.13404,
     filled 5 bps higher: it closes itself at 0.1339058, the stop could never fire; 5 bps lower it fired at the open. */
  function tpslFillCheck(p, w) {
    var U = window.ethers, bust18 = posBust18(p), bust = px18ToNum(bust18), out = { tp: null, sl: null, miss: null };
    var at = Number(U.formatUnits(rawEntry18(p.entryPx18, p.isLong, p.entryDeadbandBps), 18));
    ['tp', 'sl'].forEach(function (k) {
      var v = w[k]; if (v == null) return;
      var rule = {}; rule[k] = v;
      var bad = !(v > 0) || !(at > 0) || !!tpslCrossed(rule, p, at);
      if (!bad && k === 'sl') {
        var v18 = null; try { v18 = /e/i.test(String(v)) ? null : U.parseUnits(String(v), 18); } catch (e) { v18 = null; }
        bad = v18 != null ? (p.isLong ? v18 <= bust18 : v18 >= bust18) : (p.isLong ? v <= bust * (1 + 1e-12) : v >= bust * (1 - 1e-12));
      }
      if (bad) (out.miss = out.miss || {})[k] = v; else out[k] = v;
    });
    return out;
  }
  function tpslMiss(pid, miss) {
    var m = tpsl.missed[pid] || {};
    tpsl.missed[pid] = { tp: miss.tp != null ? miss.tp : m.tp != null ? m.tp : null, sl: miss.sl != null ? miss.sl : m.sl != null ? m.sl : null, at: Date.now() };
  }
  function tpslSeen(pid) { if (tpsl.missed[pid]) { delete tpsl.missed[pid]; tpslSave(); } }
  /* a: the PositionOpened event's own figures, for a fill whose position this page has not read yet */
  function tpslAdopt(reqId, pid, a) {
    var w = tpsl.pending[reqId]; if (!w) return;
    delete tpsl.pending[reqId];
    var p = posById(pid);
    if (!p && a && a.entryPx18 != null) {
      var inst = state.byInstId[Number(a.instrumentId)] || {};
      p = { instrumentId: Number(a.instrumentId), isLong: !!a.isLong, leverage: Number(a.leverage), entryPx18: BigInt(a.entryPx18), entry: px18ToNum(a.entryPx18), entryDeadbandBps: inst.entryDeadbandBps || 0, provisional: true };
    }
    var c = p && p.entryPx18 != null ? tpslFillCheck(p, w) : { tp: w.tp, sl: w.sl, miss: null };
    if (c.tp != null || c.sl != null) {
      tpsl.rules[pid] = { tp: c.tp, sl: c.sl, at: Date.now() };
      /* read from the event (the stamps are the market's as this page last read them): once more on positions(id) */
      if (!p || p.provisional || p.entryPx18 == null) tpsl.rules[pid].fill = 1;
    }
    if (c.miss) tpslMiss(pid, c.miss);
    tpslSave();
    if (!c.miss) toast('Take profit / stop loss set on your ' + sideWord(w.isLong) + ' ' + w.sym + '. It closes from this page while it is open.');
    else if (document.documentElement.getAttribute('data-mode') !== 'simple') {
      var sz = szOf(w.sym), said = [c.miss.tp != null ? 'take profit ' + fmtPrice(c.miss.tp, sz) : '', c.miss.sl != null ? 'stop loss ' + fmtPrice(c.miss.sl, sz) : ''].filter(Boolean).join(' and ');
      toast('Your ' + sideWord(w.isLong) + ' ' + w.sym + ' opened without the ' + said + ': the price moved before the fill. Set a new one on the position.', 'err');
    }
  }
  function tpslDropPending(reqId) { if (tpsl.pending[reqId]) { delete tpsl.pending[reqId]; tpslSave(); } }
  function tpslSet(pid, tp, sl) {
    var p = posById(pid); if (!p) return 'That position is gone.';
    if (trigWhere(p) === 'chain') return trigSet(pid, tp, sl);     /* the book holds them, set from here on chain */
    if (trigWhere(p) === 'paused') return TRIG_PAUSED_SAY;
    var px = tpslNow(p);   /* (amt5) the chain's print or nothing: never the chart */
    var why = tpslProblem(p.isLong, posLev(p), p.entry, px, tp, sl, tpslDec(p), false, tpslBust(p)); if (why) return why;
    tpsl.rules[pid] = { tp: tp, sl: sl, at: Date.now() }; delete tpsl.missed[pid]; tpslSave();
    return '';
  }
  function tpslClear(pid) {
    var p = posById(pid);
    /* v6: levels on chain are removed on chain ((0, 0)); a browser rule of the same trade goes with them */
    if (p && trigWhere(p) === 'chain' && (trigHas(pid) || trig.save[String(pid)])) trigSet(pid, null, null);
    if (tpsl.rules[pid]) { delete tpsl.rules[pid]; tpslSave(); }
  }
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
    if (Object.keys(tpsl.pending).length) { try { tpslSweep(); } catch (e) { /* never stops the rules */ } }
    var pids = Object.keys(tpsl.rules), said = Object.keys(tpsl.missed); if (!pids.length && !said.length) return;
    var now = Date.now();
    /* rules of positions that are gone (closed by hand, liquidated, another tab) leave quietly; (amt5) so does the card's
       note of a level not set at the fill. One just filled may not be among the read positions yet (TPSL_NEW_MS) */
    if (wallet.account && acct.loaded) {
      var changed = false;
      pids.forEach(function (pid) { if (!posById(pid) && !acct.closeReqs[pid] && !ui.closing[pid] && !ui.checking[pid] && !ui.settling[pid] && !(tpsl.rules[pid].fill && now - tpsl.rules[pid].at < TPSL_NEW_MS)) { delete tpsl.rules[pid]; changed = true; } });
      said.forEach(function (pid) { if (!posById(pid) && !(now - tpsl.missed[pid].at < TPSL_NEW_MS)) { delete tpsl.missed[pid]; changed = true; } });
      /* (amt5) a rule taken on the event's figures: held once more to the position as the chain gives it */
      pids.forEach(function (pid) {
        var r = tpsl.rules[pid], p = r && r.fill ? posById(pid) : null; if (!p || p.provisional || p.entryPx18 == null) return;
        var c = tpslFillCheck(p, r); delete r.fill; r.tp = c.tp; r.sl = c.sl;
        if (c.miss) tpslMiss(pid, c.miss);
        if (r.tp == null && r.sl == null) delete tpsl.rules[pid];
        changed = true;
      });
      if (changed) { tpslSave(); pids = Object.keys(tpsl.rules); }
    }
    if (tpsl.firing || state.busy || tk.phase === 'wallet' || tk.phase === 'req') return;
    for (var i = 0; i < pids.length; i++) {
      var pid = pids[i], r = tpsl.rules[pid], p = posById(pid); if (!p) continue;
      if (acct.closeReqs[pid] || ui.closing[pid] || ui.checking[pid] || ui.settling[pid]) continue;
      /* v6: levels on chain fire on chain; this page's own close for them is the backup's rule only (trigBackup) */
      if (r.from !== 'backup' && trigWhere(p) === 'chain' && trigHas(pid)) continue;
      /* a rule this page made from the chain's levels acts only while what made it holds, never from storage alone (a
         reload, another day): the backup's while this page has seen its level crossed long enough (trigBackup), a
         paused market's while that market is paused */
      /* the backup is a take profit's alone: a stop the page saw reached is never closed by this page (finding S1) */
      if (r.from === 'backup' && !(trigWhere(p) === 'chain' && trig.cross[pid] && trig.cross[pid].ripe && trig.cross[pid].which === 'tp' && r.sl == null)) continue;
      if (r.from === 'chain' && trigWhere(p) !== 'paused') continue;
      if (r.claimed) {
        if (now - r.claimed < TPSL_CLAIM_MS) continue;                                  // some tab is closing it
        /* a claim this old means the tab that sent it went away mid-request: the outcome is unknown */
        delete r.claimed; delete r.fired; r.hold = 'another tab was closing it. Check the position, then set it again.'; r.until = now + TPSL_HOLD_MS; tpslSave();
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
    tpsl.firing = pid; r.claimed = Date.now(); r.fired = which; tpslSave();      /* fired: which level it was, for the card that says so */
    if (r.from === 'backup') trig.backupBy[pid] = { which: which, at: Date.now() };      /* v6: this page's own close for a level nobody fired in time: the result says so */
    toast((which === 'tp' ? 'Take profit hit: ' : 'Stop loss hit: ') + 'closing your ' + posLabel(p) + ' at ' + fmtPrice(px, tpslDec(p)) + '.', 'ok');
    submitClose(p).then(function (ok) {
      var cur = tpsl.rules[pid];
      if (!ok) delete trig.backupBy[pid];
      if (ok) { delete tpsl.rules[pid]; tpslSave(); }
      else if (cur) { delete cur.claimed; delete cur.fired; cur.hold = 'the close was not sent. It tries again in a few minutes; Close it by hand if you want it now.'; cur.until = Date.now() + TPSL_HOLD_MS; tpslSave(); }
    });
    setTimeout(function () { tpsl.firing = null; }, 3000);
    return true;
  }
  /* The line under a position card or row: the levels and a status, Edit / Remove, or the one button to set them;
     the inline editor while editing. */
  function tpslSub(p) { var sub = el('div', 'tpsl-sub'); sub.setAttribute('data-for', String(p.id)); tpslFill(sub, p); return sub; }
  function tpslSubFor(pid) { return document.querySelector('#posLines .tpsl-sub[data-for="' + pid + '"]'); }
  function tpslWhy(pid) {
    var p = posById(pid), ca = p ? trigAuto(p) : null;
    if (ca) return '· ' + (ca.status || trigWords(ca));
    return tpslStatus(pid) ? '· ' + tpslStatus(pid) : '· closes from this page while it is open';
  }
  /* v6, Pro's words for a record on chain (trigAuto) */
  function trigWords(a) {
    if (a.err) return a.err;
    if (a.local) return 'closes from this page while it is open: save it again to put it on chain';
    if (a.saving === 'wait') return 'saving… keep this page open a few seconds';
    if (a.saving) return 'saving…';
    if (a.crossed && a.crossed.which === 'sl') return 'stop loss reached at ' + trigClock(a.crossed.at) + (!a.crossed.slow ? ': closing' : ': not closed yet' +
      (a.crossed.own ? ' (a stop that closes late closes at your price, ' + a.crossed.levelText + '; Close takes the market price instead)' : ' (Close takes the market price now)'));
    if (a.crossed) return 'reached at ' + trigClock(a.crossed.at) + ': closing' + (a.crossed.slow ? ' (late: this page closes it itself at the market price at ' + trigClock(a.crossed.closeAt) + ' if it still has not)' : '');
    if (a.missed) return 'stop loss reached at ' + trigClock(a.missed.at) + ' and not closed: it can still close the trade at your price, ' + a.missed.levelText;
    if (a.paused) return 'paused on this market: it closes from this page while it is open';
    if ((a.starts || a.updating) && a.already) return 'the price is already past this ' + (a.already === 'tp' ? 'take profit' : 'stop loss') + ': it closes the trade when it starts in ' + (a.starts || a.updating) + ' s';
    if (a.starts) return 'starts in ' + a.starts + ' s';
    if (a.updating) return 'updating: your old levels count for ' + a.updating + ' more seconds';
    if (a.past) return 'this stop loss is past the liquidation price: it does nothing while it is there';
    return 'closes your trade even when Confetti is closed';
  }
  function tpslFill(sub, p) {
    var pid = String(p.id), ca = trigAuto(p), r = ca ? (ca.tp != null || ca.sl != null || ca.updating ? ca : null) : tpsl.rules[pid], sz = tpslDec(p);
    sub.textContent = '';
    if (tpsl.editing[pid]) { sub.appendChild(tpslEditor(pid, p)); return; }
    if (r) {
      if (r.tp != null) { sub.appendChild(el('span', '', 'Take profit ')); sub.appendChild(el('b', '', fmtPrice(r.tp, sz))); }
      if (r.sl != null) { sub.appendChild(el('span', '', (r.tp != null ? '· ' : '') + 'Stop loss ')); sub.appendChild(el('b', '', fmtPrice(r.sl, sz))); }
      sub.appendChild(el('span', 'tpsl-why', tpslWhy(pid)));
      var e = el('button', 'btn btn-sm', 'Edit'); e.type = 'button'; e.addEventListener('click', function () { tpsl.editing[pid] = true; tpslRefresh(pid); });
      var c = el('button', 'btn btn-sm', 'Remove'); c.type = 'button'; c.addEventListener('click', function () { tpslClear(pid); if (!ca) toast('Take profit / stop loss removed from your ' + posLabel(p) + '.'); });
      sub.appendChild(e); sub.appendChild(c);
    } else {
      var s = el('button', 'btn btn-sm', 'Take profit / stop loss'); s.type = 'button';
      s.addEventListener('click', function () { tpsl.editing[pid] = true; tpslRefresh(pid); });
      sub.appendChild(s);
    }
    pmButtons(sub, p);
  }
  /* The editor: two price boxes with a readout under each (the completion while the number is unfinished, the
     refusal in red, else the consequence), Save and Cancel level with the boxes. Save asks "Are you sure?" with the
     lines recomputed from the live price; Yes checks once more at the click, then stores. */
  function tpslEditor(pid, p) {
    var ca = trigAuto(p), r = ca ? { tp: ca.tp, sl: ca.sl } : tpsl.rules[pid] || {}, box = el('div', 'tpsl-edit'), c = tpsl.confirm[pid];
    var onChain = tpslChain(p);
    var now = tpslNow(p);
    if (c) {
      var why0 = tpslProblem(p.isLong, posLev(p), p.entry, now, c.tp, c.sl, tpslDec(p), tpslChain(p), tpslBust(p));
      box.classList.add('is-sure');
      box.appendChild(el('b', 'tpsl-sure-k', why0 ? 'Not set.' : 'Are you sure?'));
      if (why0) box.appendChild(el('span', 'is-bad', why0));
      else {
        if (c.tp != null) box.appendChild(el('span', 'tpsl-sure-l', tpslLine(p, 'tp', c.tp, now)));
        if (c.sl != null) box.appendChild(el('span', 'tpsl-sure-l', tpslLine(p, 'sl', c.sl, now)));
        box.appendChild(el('span', 'tpsl-why', onChain ? TRIG_SAY_ALWAYS + (c.sl != null ? ' ' + trigStopSay(posLev(p)) : '') : 'It closes from this page while it is open' + (sessionLive() ? '.' : '; your wallet asks to confirm the close.')));
      }
      var row = el('div', 'tpsl-btns');
      var yes = el('button', 'btn btn-sm', why0 ? 'Back' : 'Yes, set it'); yes.type = 'button';
      var no = el('button', 'btn btn-sm', why0 ? 'Cancel' : 'Back'); no.type = 'button';
      yes.addEventListener('click', function () {
        if (why0) { delete tpsl.confirm[pid]; tpslRefresh(pid); return; }
        var w = tpslSet(pid, c.tp, c.sl);                                   // the check once more, at the click
        delete tpsl.confirm[pid];
        if (w) { tpslRefresh(pid); toast(w, 'err'); return; }
        delete tpsl.editing[pid]; tpslRefresh(pid);
        if (!onChain) toast('Set on your ' + posLabel(p) + '. It closes from this page while it is open.', 'ok');
      });
      no.addEventListener('click', function () { delete tpsl.confirm[pid]; if (why0) delete tpsl.editing[pid]; tpslRefresh(pid); });
      row.appendChild(yes); row.appendChild(no); box.appendChild(row);
      setTimeout(function () { yes.focus(); }, 0);
      return box;
    }
    var save = el('button', 'btn btn-sm', 'Save'); save.type = 'button';
    var back = el('button', 'btn btn-sm', 'Cancel'); back.type = 'button';
    var fields = [];
    function field(label, val, kind) {
      var wrap = el('div', 'tpsl-f'), l = el('label', 'tpsl-k', label), i = el('input', 'input'), rd = el('div', 'tpsl-read');
      i.type = 'number'; i.min = '0'; i.step = 'any'; i.inputMode = 'decimal'; i.placeholder = '—';
      if (val != null) i.value = String(val);
      wrap.appendChild(l); wrap.appendChild(i);
      var f = { input: i, read: rd, kind: kind };
      function read() { tpslFieldRead(rd, i, kind, p, now, read); }
      i.addEventListener('input', read);
      i.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return; ev.preventDefault();
        var fin = rd.querySelector('.tpsl-fin'); if (fin) { fin.click(); return; }
        save.click();
      });
      f.readNow = read;
      fields.push(f); box.appendChild(wrap); return f;
    }
    var ft = field('Take profit', r.tp, 'tp'), fs = field('Stop loss', r.sl, 'sl');
    box.appendChild(save); box.appendChild(back);
    box.appendChild(ft.read); box.appendChild(fs.read);
    var why = el('span', 'tpsl-why', onChain ? TRIG_SAY_ALWAYS : 'Closes from this page while it is open.');
    box.appendChild(why);
    save.addEventListener('click', function () {
      var fin = box.querySelector('.tpsl-fin'); if (fin) { fin.click(); return; }   // an unfinished number is taken first
      var tp = tpslNum(ft.input.value), sl = tpslNum(fs.input.value);
      var w = tpslProblem(p.isLong, posLev(p), p.entry, now, tp, sl, tpslDec(p), tpslChain(p), tpslBust(p));
      ft.input.classList.toggle('is-bad', !!w && /take profit/i.test(w)); fs.input.classList.toggle('is-bad', !!w && /stop/i.test(w));
      if (w) { why.textContent = w; why.classList.add('is-bad'); return; }
      tpsl.confirm[pid] = { tp: tp, sl: sl }; tpslRefresh(pid);
    });
    back.addEventListener('click', function () { delete tpsl.editing[pid]; tpslRefresh(pid); });
    fields.forEach(function (f) { if (tpslNum(f.input.value) != null) f.readNow(); });
    setTimeout(function () { ft.input.focus(); }, 0);
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
    var ca = trigAuto(p), r = ca ? { tp: ca.tp, sl: ca.sl } : tpsl.rules[pid] || {}, ti = phq(d, '.js-ps-tp'), si = phq(d, '.js-ps-sl'), note = phq(d, '.js-ps-tpnote');
    if (d._tpslPid !== pid) {
      d._tpslPid = pid; d._tpslWant = null;
      if (ti) { ti.value = r.tp != null ? String(r.tp) : ''; ti.classList.remove('is-bad'); }
      if (si) { si.value = r.sl != null ? String(r.sl) : ''; si.classList.remove('is-bad'); }
      phShow(d, '.js-ps-tpsure', false); phShow(d, '.js-ps-tpsave', true);
      tpslPhRead(d);
    }
    if (note && !note._said) note.textContent = ca ? (r.tp != null || r.sl != null ? 'Set. ' + trigWords(ca).replace(/^./, function (x) { return x.toUpperCase(); }) + '.' : 'Optional. ' + TRIG_SAY_ALWAYS)
      : (r.tp != null || r.sl != null)
      ? 'Set. ' + (tpslStatus(pid) ? 'Status: ' + tpslStatus(pid) + '.' : 'Closes while this page is open on your phone.')
      : 'Optional. Closes it for you while this page is open on your phone.';
  }
  function tpslPhSay(d, t, ms) {
    var note = phq(d, '.js-ps-tpnote'); if (!note) return;
    note._said = true; note.textContent = t;
    setTimeout(function () { note._said = false; try { renderPhSheet(); } catch (e) { /* ignore */ } }, ms);
  }
  function tpslPhNow(p) { return tpslNow(p); }
  /* The readouts under the phone's two boxes, as they are typed. */
  function tpslPhRead(d) {
    var s = ui.phSheet, p = s && s.mode !== 'all' ? posById(s.pid) : null; if (!p) return;
    var now = tpslPhNow(p);
    [['.js-ps-tp', '.js-ps-tpread-tp', 'tp'], ['.js-ps-sl', '.js-ps-tpread-sl', 'sl']].forEach(function (x) {
      var i = phq(d, x[0]), rd = phq(d, x[1]); if (!i || !rd) return;
      if (tpslNum(i.value) == null) { rd.textContent = ''; i.classList.remove('is-bad'); return; }
      tpslFieldRead(rd, i, x[2], p, now, function () { tpslPhRead(d); });
    });
  }
  /* Save on the phone: an unfinished number is taken first, then the checks, then "Are you sure?" with the lines. */
  function onPhTpSave() {
    var d = $('phPosSheet'), s = ui.phSheet; if (!d || !s || s.mode === 'all') return;
    var pid = s.pid, p = posById(pid); if (!p) return;
    var fin = d.querySelector('.js-ps-tpsl .tpsl-fin'); if (fin) { fin.click(); return; }
    var ti = phq(d, '.js-ps-tp'), si = phq(d, '.js-ps-sl');
    var tp = tpslNum(ti ? ti.value : ''), sl = tpslNum(si ? si.value : '');
    if (tp == null && sl == null) { tpslClear(pid); tpslPhSay(d, 'Removed.', 1500); return; }
    var now = tpslPhNow(p);
    var w = tpslProblem(p.isLong, posLev(p), p.entry, now, tp, sl, tpslDec(p), tpslChain(p), tpslBust(p));
    if (ti) ti.classList.toggle('is-bad', !!w && /take profit/i.test(w));
    if (si) si.classList.toggle('is-bad', !!w && /stop/i.test(w));
    if (w) { tpslPhSay(d, w, 5000); return; }
    var sum = phq(d, '.js-ps-tpsum');
    if (sum) {
      sum.textContent = '';
      if (tp != null) sum.appendChild(el('div', '', tpslLine(p, 'tp', tp, now)));
      if (sl != null) sum.appendChild(el('div', '', tpslLine(p, 'sl', sl, now)));
    }
    d._tpslWant = { tp: tp, sl: sl };
    phShow(d, '.js-ps-tpsave', false); phShow(d, '.js-ps-tpsure', true);
  }
  function onPhTpYes() {
    var d = $('phPosSheet'), s = ui.phSheet; if (!d || !s || s.mode === 'all') return;
    var want = d._tpslWant || {}; d._tpslWant = null;
    var p0 = posById(s.pid), chain0 = !!(p0 && tpslChain(p0));
    var w = tpslSet(s.pid, want.tp, want.sl);                                    // the check once more, at the tap
    phShow(d, '.js-ps-tpsure', false); phShow(d, '.js-ps-tpsave', true);
    tpslPhSay(d, w || (chain0 ? 'Saving on chain…' : 'Saved. Closes while this page is open on your phone.'), w ? 5000 : 1500);
  }
  function onPhTpBack() { var d = $('phPosSheet'); if (!d) return; d._tpslWant = null; phShow(d, '.js-ps-tpsure', false); phShow(d, '.js-ps-tpsave', true); }
  function initTpSl() {
    var box = $('dkTpSlBox'), ti = $('dkTpPx'), si = $('dkSlPx');
    if (box) { document.documentElement.setAttribute('data-tpsl', '1'); box.hidden = false; }
    [ti, si].forEach(function (i) {
      if (!i) return;
      i.disabled = false;
      i.addEventListener('input', tpslTicketCheck);
      i.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return; ev.preventDefault();
        var fin = $('dkTpSlHint') && $('dkTpSlHint').querySelector('.tpsl-fin');
        if (fin) fin.click(); else i.blur();                                   // Enter takes the completion; a trade needs the button
      });
    });
    var d = $('phPosSheet');
    if (d) {
      var on = function (c, fn) { var n = d.querySelector(c); if (n) n.addEventListener('click', fn); };
      on('.js-ps-tpsave', onPhTpSave); on('.js-ps-tpyes', onPhTpYes); on('.js-ps-tpback', onPhTpBack);
      ['.js-ps-tp', '.js-ps-sl'].forEach(function (c) { var n = d.querySelector(c); if (n) n.addEventListener('input', function () { tpslPhRead(d); }); });
    }
    var _renderAction = renderAction;
    renderAction = function () { _renderAction(); try { tpslTicketCheck(); } catch (e) { /* ignore */ } };
    window.addEventListener('storage', function (ev) { if (ev.key === tpslKey()) tpslLoad(); });
    tpslLoad();
  }

  /* ---- v6: take profit and stop loss on chain (config.json "version" >= 6; V5P_SPEC section 18) -------------------
     The owner, 2026-11-19: "we need to bring back stop loss and take profit", then "then yes develop a real"; 11-16 "i
     want to be a legitimate exchange". On v6 a fast market's levels live in the TriggerBook, on chain: set with the open
     in one transaction (the router's requestOpenWithTriggers through one-tap, its openWithTriggers from the wallet: one
     confirm) or on an open trade (the router's setTriggers through one-tap, the book's own from the wallet; (0, 0)
     removes them), and fired by anyone who brings Pyth's signed prints (the house keeper's two boxes, any bot), whether
     this page is open or not. A level fires at the first Pyth print past it (one print a second counts) and closes the
     whole trade at that print; a stop loss fired more than 5 seconds after that second closes at its own level; a print
     past the liquidation price with a stop inside it liquidates. A change counts the market's fast delay after it lands (2 to
     4 seconds at launch, by market: the card's "starts in N s" counts the record's own armedAt down, never a fixed 2)
     and the levels it replaces count until then; for 5 seconds after a change counts the book refuses the
     next one (TriggerSettling) unless no level was set before that change, so the page holds such a change and sends it
     once it can land ("Saving…").
     Where a position's levels live (trigWhere): 'chain' on a fast market of a v6 exchange whose book this page checked,
     once config.json "triggersLive" is true (the v6 keepers' trigger loop passed its smoke check, MIGRATION_V6) or when
     the book already holds levels for it; 'paused' when the book holds levels and the market is off Pyth now (records
     pause: nothing fires on chain, so the browser rule acts on them while the page is open); '' the browser rule above
     (PEOPLE, a market off Pyth, every position of a v4 / v5 exchange, v6 before the flag).
     The page reads every record of the account's positions (triggers(id)) with the account read, follows the book's
     events at each block while something is moving, and shows what the chain holds. While it is open it is also a
     backup for a take profit only (trigBackup): one its own price has been past by TRIG_BACKUP_BPS for
     TRIG_BACKUP_TP_S with no fire is closed with the close request the Close button sends (a later fire voids it:
     V5P_SPEC 18.4 step 12). For a stop loss it never sends a close of its own (review finding S1): a stop fired late
     closes at the stop's own level, and a close request priced after the missed exit would hand the keeper the pick
     between that level and the market price of the request; the card says the stop was reached, when, and the price a
     late stop closes at, and Close stays the trader's own key. It never sends executeTriggersPyth: that takes Pyth's
     signed prints, which Pyth gives out with a key only (the kit has no relay for them yet). And a trade that ended
     while the page was closed is told when the trader comes back (trigAwayReport). */
  var TRIG_WINDOW_S = 5;           /* the book's TRIGGER_WINDOW: a fire after its exit second + 5 is late */
  var TRIG_LAND_S = 2;             /* how long after a session key's send the page counts on it landing (a block or two) */
  /* a crossed take profit unfired this long is closed by this page's own request (trigBackup): the window, the fast
     delay and a few blocks. A stop loss has no such number: this page never closes a trade for a stop it saw reached
     (finding S1: the chain owes a late stop its own level, which this page's request would give away) */
  var TRIG_BACKUP_TP_S = 12;
  var TRIG_BACKUP_BPS = 5;         /* how far past a level the page's own price must be (its estimate, not Pyth's print) */
  var TRIG_ERR_MS = 20000;         /* a failed save is said on the card this long */
  /* rec: position id -> { o, n } the book's older and newer record ({ tp18, sl18, armedAt }, BigInt levels);
     since: market -> fastSince; parked: request id -> { tp18, sl18 } levels parked on an open request; save: position
     id -> { tp18, sl18, tp, sl, phase 'wait' | 'send', until, tries } a change on its way; err: position id -> { text,
     at }; fired: position id -> { kind, at, level18, exit18, late, tx } (TriggerFired); cross: position id ->
     { which, level, since, at, px, ripe } a level the page's own price is past (trigBackup); seen: position id -> { tp,
     sl } each { at, px }, the first time the page saw that level reached; backupBy: position id -> which level this
     page's own close was sent for; awayWas: position id -> what Simple needs of a trade that ended while the page was
     closed; pv: 'id:px18' -> the chain's previewCloseAt */
  var trig = { bookAsked: false, rec: {}, since: {}, parked: {}, save: {}, err: {}, fired: {}, cross: {}, seen: {}, missed: {}, backupBy: {}, awayWas: {}, picks: {}, snapSig: null, pv: {}, pvAsk: {}, reading: false, demoBook: {} };
  var TRIG_NONE = { tp18: 0n, sl18: 0n, armedAt: 0 };
  /* the demo's pretend book: its logs carry this address, as a real receipt's carry the book's */
  var TRIG_DEMO_BOOK = '0xde0000000000000000000000000000000000b00c';
  setInterval(function () { if (isV6() && wallet.account) { try { trigPump(); if (DEMO) demoTrigKeeper(); trigTick(); } catch (e) { /* never stops the page */ } } }, 500);
  /* Pro's lines follow the levels' own clock (starts in N s, the old levels counting, a clear in force, a level
     reached): redrawn when what a line would say or offer has changed. A line being edited is left alone (tpslRedraw). */
  function trigTick() {
    if (!trigOn() || !acct.loaded) return;
    var sig = acct.positions.map(function (p) {
      var a = trigAuto(p);
      return a ? [p.id, a.tp, a.sl, a.already || '', a.starts, a.updating, a.saving, a.err ? 1 : 0, a.past ? 1 : 0, a.paused ? 1 : 0, a.local ? 1 : 0, a.crossed ? a.crossed.which + (a.crossed.slow ? 's' : '') : '', a.missed ? 'm' : ''].join(':') : String(p.id);
    }).join('|');
    if (sig === trig.tickSig) return;
    trig.tickSig = sig;
    tpslRedraw();
  }

  /* The book is usable on this page (v6, pinned, checked; the demo has a pretend one). */
  function trigOn() { return isV6() && (DEMO ? true : !!read.book); }
  /* The trigger screens are on: the site config says the v6 keepers' trigger loop passed its smoke check. */
  function trigLive() { return trigOn() && cfg.triggersLive === true; }
  /* A new open on this market takes its levels on chain (an open with levels goes through the router). */
  function trigMarket(instId) { return trigLive() && !!fastOf(instId) && !!(DEMO || read.router); }
  function trigLv(t) { return !!t && (t.tp18 > 0n || t.sl18 > 0n); }
  /* The book holds a level for this position (the newer record, or the older one while a change arms). */
  function trigHas(pid) {
    var r = trig.rec[String(pid)];
    if (!r) return false;
    return trigLv(r.n) || (trigLv(r.o) && chainNow() < r.n.armedAt);
  }
  function trigWhere(p) {
    if (!p || !trigOn()) return '';
    var has = trigHas(p.id);
    if (fastOf(p.instrumentId)) return trigLive() || has ? 'chain' : '';
    return has ? 'paused' : '';
  }

  /* A typed price (the scale every fast-market price on this page is in: USDT terms, FillPriced.px18's) as the book's
     uint96 at 1e18: 0n for none, null for one that cannot be a level. Exact for what a person types: the number's
     shortest decimal, not its binary tail. */
  function trigPx18(n) {
    if (n == null) return 0n;
    if (!(n > 0) || !isFinite(n)) return null;
    var s = Number(n).toPrecision(15), m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
    if (m) {
      var digits = m[1] + (m[2] || ''), exp = Number(m[3]);
      if (exp >= 0) return null;     /* above 1e15: no price */
      s = '0.' + new Array(-exp).join('0') + digits;
    }
    s = s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
    var parts = s.split('.');
    if (parts[1] && parts[1].length > 18) s = parts[0] + '.' + parts[1].slice(0, 18);
    try {
      var v = window.ethers.parseUnits(s, 18);
      return v > 0n && v < (1n << 96n) ? v : null;
    } catch (e) { return null; }
  }
  function trigNum(x18) { return x18 > 0n ? px18ToNum(x18) : null; }
  function trigNorm(t) {
    if (!t) return TRIG_NONE;
    return { tp18: BigInt(t.tpPx18 != null ? t.tpPx18 : t[0]), sl18: BigInt(t.slPx18 != null ? t.slPx18 : t[1]), armedAt: Number(t.armedAt != null ? t.armedAt : t[2]) };
  }

  /* A record's state at chain second `now` (V5P_SPEC 18.2, 18.3): the levels the trade shows are the newest written
     (what was asked last); they count from armedAt (and, after the market was switched back on Pyth, from fastSince +
     delay); until then the levels they replace count (old). wait: the second a change sent now must wait for (the book
     refuses one landing in [newer.armedAt, newer.armedAt + 5) while the older record has a level). */
  function trigState(pid, now) {
    var r = trig.rec[String(pid)];
    if (!r || !r.n.armedAt) return null;
    var n = r.n, o = r.o, p = posById(pid);
    var f = p ? fastOf(p.instrumentId) : null, since = p ? trig.since[p.instrumentId] : null;
    var start = n.armedAt;
    if (f && since > 0 && since + f.delay > start) start = since + f.delay;
    var arming = now < start, old = arming && now < n.armedAt && trigLv(o) && o.armedAt && now >= o.armedAt ? o : null;
    return {
      tp18: n.tp18, sl18: n.sl18, tp: trigNum(n.tp18), sl: trigNum(n.sl18), armedAt: n.armedAt, start: start,
      arming: arming, left: arming ? start - now : 0, old: old ? { tp: trigNum(old.tp18), sl: trigNum(old.sl18) } : null,
      has: trigLv(n) || !!old,
      wait: trigLv(o) && now < n.armedAt + TRIG_WINDOW_S ? n.armedAt + TRIG_WINDOW_S : 0
    };
  }

  /* The levels in force at chain second `now` (the record that judges that second's print), or null. */
  function trigForce(pid, now) {
    var r = trig.rec[String(pid)];
    if (!r) return null;
    var t = r.n.armedAt && now >= r.n.armedAt ? r.n : r.o.armedAt && now >= r.o.armedAt ? r.o : null;
    return trigLv(t) ? t : null;
  }

  /* The book's records of these positions (one triggers(id) each); a read that fails keeps the last. */
  function trigRead(ids) {
    if (DEMO || !read.book || !ids || !ids.length) return Promise.resolve();
    var a = wallet.account;
    return Promise.all(ids.map(function (id) { return read.book.triggers(BigInt(id)).catch(function () { return null; }); })).then(function (rows) {
      if (wallet.account !== a) return;
      var changed = false;
      rows.forEach(function (r, i) {
        if (!r) return;
        var pid = String(ids[i]), was = trig.rec[pid], now = { o: trigNorm(r[0]), n: trigNorm(r[1]) };
        if (!was || was.o.armedAt !== now.o.armedAt || was.n.armedAt !== now.n.armedAt || was.n.tp18 !== now.n.tp18 || was.n.sl18 !== now.n.sl18) {
          changed = true;
          if (was && was.n.armedAt !== now.n.armedAt) delete trig.seen[pid];      /* a new record: what the page saw was of the old one */
          /* a missed stop is forgotten once the book no longer holds its record (trigMissed shows it only while that record is the one in force) */
          if (was && was.n.armedAt !== now.n.armedAt && trig.missed[pid] && trig.missed[pid].armedAt !== now.n.armedAt && trig.missed[pid].armedAt !== now.o.armedAt) delete trig.missed[pid];
        }
        trig.rec[pid] = now;
      });
      if (changed) trigChanged();
    });
  }
  /* the account read is in: the records of its positions, and the records of positions that are gone leave */
  function trigAccount() {
    if (!isV6()) return;
    if (!DEMO && !read.book && read.exchange && !trig.bookAsked) loadTriggerBook();
    var have = {};
    acct.positions.forEach(function (p) { have[String(p.id)] = true; });
    Object.keys(trig.rec).forEach(function (pid) { if (!have[pid] && !ui.checking[pid]) delete trig.rec[pid]; });
    Object.keys(trig.save).forEach(function (pid) { if (!have[pid]) delete trig.save[pid]; });
    trigRead(acct.positions.map(function (p) { return p.id; }));
    trigSnapSave();
    trigAwayGone();
  }

  /* ---- while you were away (v6). A take profit or stop loss closes a trade with this page closed, so the page must
     say so when the trader is back. Each account read leaves what is open in this browser (trigSnapSave: the few
     figures a result needs), once the away scan of this visit is done (as LS.seen moves). On the next visit scanAway
     reads the account's closes, liquidations, size fees and the book's fires since the last block seen, and each trade
     of that snapshot that ended is reported as a close this page watched (trigAwayReport: reportCloseOutcome with the
     snapshot's position), so Pro's result card and Simple's result say what they say live: closed by your stop loss,
     at what price, when it was crossed. A trade of the snapshot that is gone with no log in the range read (more than
     AWAY_MAX_BLOCKS back) is said too, without figures (trigAwayGone). ---- */
  function trigSnapKey(account) { return 'confetti.trade.open6.' + String(account).toLowerCase(); }
  function trigSnapSave(force) {      /* force: a test writes it in the demo */
    var a = wallet.account;
    if (!isV6() || (DEMO && !force) || !a || !acct.loaded || ui.awayDone[a] !== 'done') return;
    var pos = {};
    acct.positions.forEach(function (p) {
      pos[String(p.id)] = { id: String(p.id), instrumentId: p.instrumentId, isLong: !!p.isLong, margin: p.margin, leverage: p.leverage, entry: p.entry, openedAt: p.openedAt || 0,
        added: p.added > 0 ? p.added : 0, openFee: posOpenFee(p), feeX10: posFeeX10(p) };
    });
    var sig = JSON.stringify(pos);
    if (sig === trig.snapSig) return;
    trig.snapSig = sig;
    lsSet(trigSnapKey(a), JSON.stringify({ block: house.block || 0, pos: pos }));
  }
  function trigSnapLoad(account) {
    var d = null;
    try { d = JSON.parse(lsGet(trigSnapKey(account)) || 'null'); } catch (e) { d = null; }
    return d && d.pos && Object.keys(d.pos).length ? d : null;
  }
  /* what Simple's result needs of a trade it never showed in this visit */
  function trigWas(p) {
    var m = positionMarket(p);
    return { sym: m ? m.symbol : '', isLong: !!p.isLong, lev: p.leverage, margin: p.margin + posOpenFee(p) };
  }
  /* The ends of the snapshot's trades among the away scan's logs (the Exchange's by owner, the book's fires by owner),
     each reported as its own result. Returns the ids it reports, so the away card does not say them twice. */
  function trigAwayReport(account, exLogs, bookLogs, snap, bookAt) {
    var told = {};
    if (!isV6() || !snap || !snap.pos) return told;
    try { trigNoteLogs(bookLogs, bookAt); } catch (e) { /* the result then reads as a plain close */ }
    var ends = {};
    parsedLogs(exLogs).forEach(function (h) {
      if (h.name !== 'PositionClosed' && h.name !== 'PositionLiquidated') return;
      var pid = String(h.args.positionId);
      if (!snap.pos[pid] || ui.reported[pid] === true) return;
      ends[pid] = { tx: h.tx, block: h.block };
    });
    var pids = Object.keys(ends);
    if (!pids.length) return told;
    var need = {};
    pids.forEach(function (pid) {
      told[pid] = true;
      trig.awayWas[pid] = trigWas(snap.pos[pid]);
      if (ends[pid].block != null && heads.tsByBlock[ends[pid].block] == null) need[ends[pid].block] = true;
    });
    var prov = read.logProvider || read.provider;
    Promise.all(Object.keys(need).map(function (b) {
      if (!prov || !prov.getBlock) return null;
      return prov.getBlock(Number(b)).then(function (x) { if (x && x.timestamp != null) heads.tsByBlock[Number(b)] = Number(x.timestamp); }, function () { /* the result then says no closing time */ });
    })).then(function () {
      if (wallet.account !== account) return;
      pids.forEach(function (pid) {
        var e = ends[pid];
        var own = function (l) { try { return l.transactionHash === e.tx && l.topics && l.topics.length > 1 && BigInt(l.topics[1]) === BigInt(pid); } catch (x) { return false; } };
        try { reportCloseOutcome(pid, (exLogs || []).filter(own).concat((bookLogs || []).filter(own)), e.tx, snap.pos[pid]); } catch (x) { /* one result never stops the others */ }
      });
    });
    trig.awaySnap = { account: account, snap: snap, told: told };
    return told;
  }
  /* A trade of the last visit's snapshot that is gone, with no end among the logs the away scan read: said once, without
     figures. Runs when both the scan and the first account read of this visit are in. */
  function trigAwayGone() {
    var a = wallet.account, w = trig.awaySnap;
    if (!isV6() || !a || !acct.loaded || !w || w.account !== a || w.gone) return;
    if (!DEMO && ui.awayDone[a] !== 'done') return;
    w.gone = true;
    var have = {};
    acct.positions.forEach(function (p) { have[String(p.id)] = true; });
    Object.keys(w.snap.pos).forEach(function (pid) {
      if (have[pid] || w.told[pid] || ui.reported[pid]) return;
      ui.reported[pid] = true;
      var p = w.snap.pos[pid], was = trigWas(p);
      sm.gone[pid] = was;
      addRecent({ key: 'g' + pid, pid: pid, title: posLabel(p) + ' is no longer open', lines: ['It ended while you were away. History shows how it ended.'], ttl: 60000 });
    });
  }
  function trigReady() { if (wallet.account && acct.loaded) trigAccount(); trigChanged(); }
  function trigChanged() {
    /* a position whose levels are on chain needs no browser rule; one whose market is off Pyth gets the chain's levels
       as its browser rule while it is paused (and loses them when it is back) */
    var changed = false;
    acct.positions.forEach(function (p) {
      var pid = String(p.id), w = trigWhere(p), r = tpsl.rules[pid];
      if (w === 'chain' && trigHas(pid) && r && r.from !== 'backup' && !r.claimed) { delete tpsl.rules[pid]; changed = true; }
      if (w === 'paused') {
        var t = trigForce(pid, chainNow()) || (trig.rec[pid] && trig.rec[pid].n);
        var tp = t ? trigNum(t.tp18) : null, sl = t ? trigNum(t.sl18) : null;
        if ((!r || r.from === 'chain') && (tp != null || sl != null) && !(r && r.tp === tp && r.sl === sl)) {
          if (!(r && r.claimed)) { tpsl.rules[pid] = { tp: tp, sl: sl, at: Date.now(), from: 'chain' }; changed = true; }
        }
      } else if (r && r.from === 'chain' && !r.claimed) { delete tpsl.rules[pid]; changed = true; }
    });
    if (changed) tpslSave(); else tpslRedraw();
    renderPositions();
  }

  /* Set, change or remove (both null) a position's levels on chain. Pro's checks first (tpslProblem, on chain: no
     0.1% rule). Returns '' when the change is on its way (or waiting for its second), else the sentence that refuses it. */
  function trigSet(pid, tp, sl) {
    pid = String(pid);
    var p = posById(pid);
    if (!p) return 'That position is gone.';
    if (trigWhere(p) !== 'chain') return 'Take profit and stop loss are not on chain for this trade.';
    if (tp != null || sl != null) {
      var px = tpslNow(p);   /* the chain's price or a wait (TPSL_WAIT): never the chart; the stop held to the chain's own bustPrice(id) */
      var why = tpslProblem(p.isLong, posLev(p), p.entry, px, tp, sl, tpslDec(p), true, tpslBust(p));
      if (why) return why;
    }
    var tp18 = trigPx18(tp), sl18 = trigPx18(sl);
    if (tp18 == null || sl18 == null) return 'That price cannot be a level.';
    delete trig.err[pid];
    var cur = trig.save[pid];
    if (cur && cur.phase === 'send') { cur.next = { tp18: tp18, sl18: sl18, tp: tp, sl: sl }; trigChanged(); return ''; }
    trig.save[pid] = { tp18: tp18, sl18: sl18, tp: tp, sl: sl, phase: 'wait', until: 0, tries: 0 };
    trigPump();
    trigChanged();
    return '';
  }

  /* The changes waiting for their second: each sent once it can land (one at a time per position). */
  function trigPump() {
    var now = chainNow();
    Object.keys(trig.save).forEach(function (pid) {
      var s = trig.save[pid];
      if (s.phase !== 'wait') return;
      var st = trigState(pid, now), wait = st ? st.wait : 0;
      /* a session key's send lands within a block or two; a wallet's after its confirm, any time: it waits the whole
         settling time out first, so it never lands inside it */
      var viaKey = DEMO || sessionLive();
      if (wait && !(viaKey && st && now + TRIG_LAND_S < st.armedAt)) { s.until = Math.max(s.until || 0, wait); }
      if (s.until && now < s.until + 0.3) return;
      trigSend(pid, s);
    });
  }

  function trigSend(pid, s) {
    var p = posById(pid);
    if (!p) { delete trig.save[pid]; return; }
    s.phase = 'send'; s.tries += 1;
    var both = s.tp18 === 0n && s.sl18 === 0n;
    var desc = (both ? 'Remove take profit and stop loss' : 'Take profit / stop loss') + ' on your ' + posLabel(p);
    trigChanged();
    trigTx(desc, pid, s.tp18, s.sl18).then(function (rc) {
      if (trig.save[pid] !== s) return;
      trigNoteLogs((rc && rc.logs) || []);
      var next = s.next;
      delete trig.save[pid];
      if (next) { trig.save[pid] = { tp18: next.tp18, sl18: next.sl18, tp: next.tp, sl: next.sl, phase: 'wait', until: 0, tries: 0 }; }
      return trigRead([pid]).then(function () { trigPump(); trigChanged(); });
    }, function (e) {
      if (trig.save[pid] !== s) return;
      var name = revertName(e), args = trigErrArgs(e);
      if (name === 'TriggerSettling' && s.tries < 4) {
        /* the change landed in the settling time after all: it waits for the second the book named */
        s.phase = 'wait'; s.until = args && args[0] != null ? Number(args[0]) : chainNow() + TRIG_WINDOW_S;
        trigChanged();
        return trigRead([pid]);
      }
      delete trig.save[pid];
      var text = isUserRejection(e) ? 'Not saved: you said no in your wallet.'
        : name === 'UnknownPosition' ? 'Not saved: this trade is already closed.'
        : name === 'NotFastMarket' || name === 'MarketRetired' ? 'Not saved: this market is paused for take profit and stop loss right now.'
        : 'Not saved: ' + describeError(e);
      trig.err[pid] = { text: text, at: Date.now() };
      trigChanged();
      if (name === 'NotFastMarket') { try { loadFast(); } catch (x) { /* ignore */ } }
    });
  }
  function trigErrArgs(e) {
    var d = revertData(e);
    if (!d || !bookIface) return null;
    try { var p = bookIface.parseError(d); return p ? p.args : null; } catch (x) { return null; }
  }

  /* setTriggers: through the session key when one-tap is live (the router forwards it to the book for this trader),
     else from the wallet to the book (one confirm). A session the router refuses, or a key out of gas, goes to the
     wallet once. */
  function trigTx(desc, pid, tp18, sl18, again) {
    var args = [BigInt(pid), tp18, sl18];
    if (DEMO) return demoTx('setTriggers', args);
    var E = window.ethers;
    if (!again && sessionLive() && !house.usdcBad && !house.gate && read.router) {
      var keyAddr = sess.key.address, router = new E.Contract(read.router.target, routerAbi(), sess.key);
      return inSessionTurn(function () {
        var sh = { sent: function (hash, tx) { sessNonceSent(keyAddr, tx); }, overrides: sessionOverrides(keyAddr) };
        return sendTx(desc, router.setTriggers, args, true, keyAddr, sh).then(function (rc) { sess.nonceOk = true; return rc; }, function (e) {
          if (/reverted on chain/.test(String(e && e.message)) || (e && e.code === 'CALL_EXCEPTION' && e.receipt)) sess.nonceOk = true; else sess.nonce = null;
          throw e;
        });
      }).catch(function (e) {
        if (isNonceTrouble(e) && again !== 'nonce') return trigTx(desc, pid, tp18, sl18, 'nonce');
        if (!SESSION_ERRORS[revertName(e)] && !isGasShortfall(e)) throw e;
        return refreshSession().then(function () { return trigTx(desc, pid, tp18, sl18, true); });
      });
    }
    return Promise.resolve().then(function () {
      requireSigner();
      if (!read.book) throw new Error('Take profit and stop loss are not ready on this page yet.');
      var book = new E.Contract(read.book.target, TRIGGER_BOOK_ABI, wallet.signer);
      return sendTx(desc, book.setTriggers, args, true, wallet.account);
    });
  }

  /* v6: the ticket's levels as the book's, when this open takes them on chain (null: the browser rule parks them) */
  function trigWant(m, want) {
    if (!want || (want.tp == null && want.sl == null) || !m || !trigMarket(m.instrumentId)) return null;
    var tp18 = trigPx18(want.tp), sl18 = trigPx18(want.sl);
    return tp18 == null || sl18 == null ? null : { tp18: tp18, sl18: sl18 };
  }
  /* Why an open did not go through, said for one that carried levels: the router's open reverts whole when the book
     refuses them (the market just went off Pyth, or was retired), so the trade can go in without them. */
  function trigOpenErr(e, tw) {
    var n = tw ? revertName(e) : null;
    if (n === 'NotFastMarket' || n === 'MarketRetired') return 'take profit and stop loss are paused on this market right now. Open without them.';
    return describeError(e);
  }
  /* An open request filed with levels parked on it (the router's forms): kept until its fill hands them over. */
  function trigParked(reqId, tp18, sl18) {
    trig.parked[String(reqId)] = { tp18: tp18, sl18: sl18 };
    /* the fill was seen before this receipt (tpslNoteFill): its position shows them now, and the read that follows is the
       chain's word. After a reload nothing needs this: the book holds them and the account read brings them (trigRead). */
    var f = tpslFills[String(reqId)];
    if (f) { try { trigAdopt(String(reqId), f.pid, f.at, Number(f.a.instrumentId)); } catch (e) { /* the read after it is the chain's word */ } }
  }
  /* The book's TriggerFired of a position, from block `from` on (a vanished position, a close that ended): [] when
     there is no book or the read fails. */
  function trigFireLogs(prov, from, pid) {
    if (!isV6() || DEMO || !read.book || !bookIface) return Promise.resolve([]);
    return prov.getLogs({ address: read.book.target, fromBlock: from, toBlock: 'latest', topics: [bookIface.getEvent('TriggerFired').topicHash, topicId(pid)] }).catch(function () { return []; });
  }
  /* One position's closes and fires between two blocks, in the log node's chunks (a tab that slept: lookupVanished).
     Best effort: a chunk that fails ends the walk with what was found; the near range still answers. */
  function trigLogsFar(prov, from, to, pid, exTopics) {
    var out = { ex: [], book: [] }, chunk = Math.max(1000, Number(cfg.logChunkBlocks) || 20000);
    var bookAt = DEMO ? TRIG_DEMO_BOOK : read.book ? read.book.target : null;
    var fired = bookAt && bookIface ? [bookIface.getEvent('TriggerFired').topicHash, topicId(pid)] : null;
    function walk(a) {
      if (a > to) return Promise.resolve(out);
      var b = Math.min(to, a + chunk - 1);
      return Promise.all([prov.getLogs({ address: cfg.contracts.exchange, fromBlock: a, toBlock: b, topics: exTopics }),
        fired ? prov.getLogs({ address: bookAt, fromBlock: a, toBlock: b, topics: fired }) : []]).then(function (r) {
        out.ex = out.ex.concat(r[0] || []); out.book = out.book.concat(r[1] || []);
        return walk(b + 1);
      });
    }
    return walk(from).catch(function () { return out; });
  }

  /* The fill of a request with parked levels: the position's first record, armed at the fill's block time + the
     market's delay (the book's onOpen), shown at once; the reads that follow are the chain's word. When the chain
     holds nothing for the trade (the market was switched off Pyth before the fill: nothing is handed over, V5P_SPEC
     18.3), the levels the trader asked for are kept by this page instead, as on any market off Pyth, marked so the
     card says it (kept). */
  function trigAdopt(reqId, pid, openedAt, instId) {
    var w = trig.parked[String(reqId)];
    if (!w) return;
    delete trig.parked[String(reqId)];
    pid = String(pid);
    var p = posById(pid), f = fastOf(instId), at = p && p.openedAt > 0 ? p.openedAt : openedAt > 0 ? openedAt : Math.floor(chainNow());
    var kept = function () {
      if (trigHas(pid) || tpsl.rules[pid] || !posById(pid)) return;
      tpsl.rules[pid] = { tp: trigNum(w.tp18), sl: trigNum(w.sl18), at: Date.now(), kept: true }; tpslSave();
      toast('Your take profit and stop loss did not go on chain with this trade: its market was paused for them as it opened. They close it from this page while it is open.', 'err');
      trigChanged();
    };
    if (!f) { setTimeout(function () { trigRead([pid]).then(kept); }, 1500); return; }
    if (!trig.rec[pid]) trig.rec[pid] = { o: TRIG_NONE, n: { tp18: w.tp18, sl18: w.sl18, armedAt: at + (f ? f.delay : 2) } };
    trigChanged();
    setTimeout(function () { trigRead([pid]); }, 1500);
    /* a second read a few seconds on (a node a block behind answers the first with nothing): still nothing, and the page
       keeps them. The demo's book is this page's own record: nothing to read */
    if (!DEMO) setTimeout(function () { trigRead([pid]).then(kept); }, 6000);
  }

  /* The book's events in a block's (or a receipt's) logs: TriggersSet moves a record as the book does (the newer
     becomes the older once it was in force), TriggerFired says which level closed a trade. */
  function trigNoteLogs(logs, at) {
    if (!isV6() || !bookIface) return;
    var book = at ? String(at).toLowerCase() : DEMO ? TRIG_DEMO_BOOK : read.book ? String(read.book.target).toLowerCase() : null;
    if (!book) return;
    var me = wallet.account ? wallet.account.toLowerCase() : '';
    var changed = false;
    (logs || []).forEach(function (log) {
      if (!log || String(log.address || '').toLowerCase() !== book) return;
      var ev = null;
      try { ev = bookIface.parseLog({ topics: Array.from(log.topics), data: log.data }); } catch (e) { ev = null; }
      /* by position, not by name: an ethers Result's "at" is Array.prototype.at */
      if (!ev || String(ev.args[1] || '').toLowerCase() !== me) return;
      var pid = String(ev.args[0]);
      if (ev.name === 'TriggersSet') {
        var r = trig.rec[pid] || { o: TRIG_NONE, n: TRIG_NONE }, ts = trigLogTs(log), nw = { tp18: BigInt(ev.args[2]), sl18: BigInt(ev.args[3]), armedAt: Number(ev.args[4]) };
        if (ts == null) ts = Math.floor(chainNow());      /* just landed: its block is about now */
        if (r.n.armedAt === nw.armedAt && r.n.tp18 === nw.tp18 && r.n.sl18 === nw.sl18) return;
        var o = ts != null && r.n.armedAt && ts >= r.n.armedAt ? r.n : r.o;
        trig.rec[pid] = { o: o, n: nw };
        delete trig.seen[pid];
        changed = true;
      } else if (ev.name === 'TriggerFired') {
        trig.fired[pid] = { kind: Number(ev.args[2]), at: Number(ev.args[3]), level18: BigInt(ev.args[4]), exit18: BigInt(ev.args[5]), late: !!ev.args[6], tx: log.transactionHash };
        changed = true;
      }
    });
    if (changed) trigChanged();
  }
  function trigLogTs(log) { var b = log && log.blockNumber != null ? Number(log.blockNumber) : null; return b != null && heads.tsByBlock[b] != null ? heads.tsByBlock[b] : null; }

  /* What a fire of this position says, from TriggerFired in these logs (or one already seen), or null. sz: the decimals
     of the position's market (it may be gone from the account by now) */
  function trigFiredIn(logs, pid, sz) {
    trigNoteLogs(logs);
    var f = trig.fired[String(pid)];
    if (!f) return null;
    if (sz == null) { var p = posById(pid), m = p ? positionMarket(p) : null; sz = m ? m.szDecimals : null; }
    return { kind: f.kind, late: f.late, at: f.at, level: fmtPrice(px18ToNum(f.level18), sz), exit: fmtPrice(px18ToNum(f.exit18), sz), tx: f.tx };
  }
  /* The words of a fire on its result: "Closed by your stop loss at 0.07698", a late stop "Closed by your stop loss at
     your price, 0.07700", a gap past the liquidation price "Liquidated: the price jumped past your stop loss and your
     liquidation price in one second". */
  function trigFiredLine(t) {
    if (!t) return '';
    if (t.kind === 2) return 'Liquidated: the price jumped past your stop loss and your liquidation price in one second.';
    var what = t.kind === 0 ? 'take profit' : 'stop loss';
    return 'Closed by your ' + what + ' at ' + (t.kind === 1 && t.late ? 'your price, ' + t.level : t.exit) + '.';
  }
  /* The receipt's line: when the level was crossed and when the trade closed ("Take profit crossed at 12:03:05 (price
     1.2345), closed at 12:03:06"). */
  function trigReceiptLine(t, closedTs) {
    if (!t || !(t.at > 0)) return '';
    var clock = function (s) { return new Date(s * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
    var what = t.kind === 0 ? 'Take profit' : 'Stop loss';
    return what + ' crossed at ' + clock(t.at) + (t.kind === 1 && t.late ? '' : ' (price ' + t.exit + ')') + (closedTs > 0 ? ', closed at ' + clock(closedTs) : '') + (t.kind === 1 && t.late ? ', late: at your price, ' + t.level : '') + '.';
  }

  function trigClock(s) { return new Date(s * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  /* A level this page saw reached that did not close the trade: "Your take profit was reached at 12:03:05 (about 1.2345
     on this page) and did not fire." (the page's own price, not Pyth's print: an estimate, and said so). t: the fire
     that closed the trade, if one did. A take profit reached and never fired is said whatever closed the trade later
     (V5P_SPEC 18.16, item 1); a stop loss when no fire closed it. When the close was this page's own (the backup,
     trigBackup), the line says that: "... and did not fire on chain in time, so this page closed the trade at the
     market price." */
  function trigSeenLine(pid, t, sz) {
    pid = String(pid);
    var sn = trig.seen[pid], by = !t && trig.backupBy[pid] ? trig.backupBy[pid].which : '';
    if (!sn) return '';
    var which = by && sn[by] ? by : sn.tp && !(t && t.kind === 0) ? 'tp' : sn.sl && !t ? 'sl' : '';
    if (!which) return '';
    if (sz == null) { var p = posById(pid), m = p ? positionMarket(p) : null; sz = m ? m.szDecimals : null; }
    return 'Your ' + (which === 'tp' ? 'take profit' : 'stop loss') + ' was reached at ' + trigClock(sn[which].at) + ' (about ' + fmtPrice(sn[which].px, sz) + ' on this page) and did not fire' +
      (by === which ? ' on chain in time, so this page closed the trade at the market price.' : '.');
  }
  /* A stop loss at or past the liquidation price does nothing while it is there (the liquidation comes first). */
  function trigStopPast(p, sl) {
    if (!(sl > 0) || !p) return false;
    var b = px18ToNum(posBust18(p));
    return b > 0 && (p.isLong ? sl <= b : sl >= b);
  }

  /* The backup while this page is open: a take profit in force that the page's own price has been past by
     TRIG_BACKUP_BPS for TRIG_BACKUP_TP_S with no fire becomes a browser rule that the next check fires (the Close
     button's request, at the market price). The backup rule lives only while the page sees its level crossed: once
     the price is back, the level has moved, or the levels are no longer on chain, a rule whose close is not on its way
     goes (it must never act later as a plain browser rule).
     A stop loss the page sees reached is watched and said on the card, and never closed by this page (finding S1). The
     chain owes a stop missed by more than 5 seconds its own level, for as long as the trade is open; a close request
     filed after the missed exit is priced later, and the keeper could then either fire the stop late at its level or
     fill the request at the market price, whichever pays the trader less. So the page files nothing and gives nothing
     away; a backup rule for a stop (one left in storage by an earlier page) is dropped on sight. own: the page first
     saw the stop reached more than 2 s after its record's first second (the page looks about once a second, so a
     crossing it meets that early may be the record's first print, which has no witness) and with the price still inside the liquidation price, the
     case in which a late fire closes at the stop's own level (V5P_SPEC 18.1); otherwise the card promises no price. */
  function trigBackup() {
    var on = trigOn(), now = chainNow(), t = Date.now(), saved = false, said = false;
    acct.positions.forEach(function (p) {
      var pid = String(p.id), br = tpsl.rules[pid], which = '', tp = null, sl = null, px = 0, own = false;
      var busy = !!(acct.closeReqs[pid] || ui.closing[pid] || ui.checking[pid] || ui.settling[pid]);
      if (on && !busy && trigWhere(p) === 'chain') {
        var f = trigForce(pid, Math.floor(now));
        px = closePriceFor(p);
        if (f && px > 0 && !priceDelayed(p)) {
          var k = TRIG_BACKUP_BPS / 10000;
          tp = trigNum(f.tp18); sl = trigNum(f.sl18);
          if (sl != null && !trigStopPast(p, sl) && (p.isLong ? px <= sl * (1 - k) : px >= sl * (1 + k))) which = 'sl';
          else if (tp != null && (p.isLong ? px >= tp * (1 + k) : px <= tp * (1 - k))) which = 'tp';
          if (which === 'sl') {
            var fm = fastOf(p.instrumentId), snc = trig.since[p.instrumentId], st0 = f.armedAt, bst = px18ToNum(posBust18(p));
            if (fm && snc > 0 && snc + fm.delay > st0) st0 = snc + fm.delay;
            own = Math.floor(now) > st0 + 2 && (!(bst > 0) || (p.isLong ? px > bst : px < bst));
          }
        }
      }
      var lv = which === 'tp' ? tp : which === 'sl' ? sl : null;
      /* a backup rule is a take profit's, for the level the page sees crossed now; any other goes, a stop's always */
      if (br && br.from === 'backup' && !br.claimed && !busy && (which !== 'tp' || br.tp !== lv || br.sl != null)) { delete tpsl.rules[pid]; saved = true; }
      /* the note of this page's own close goes once that close is no longer on its way (it was cancelled, or never left) */
      var bb = trig.backupBy[pid];
      if (bb && !busy && !(br && br.claimed) && Date.now() - bb.at > 30000) delete trig.backupBy[pid];
      var c = trig.cross[pid];
      if (!which) { if (c) { delete trig.cross[pid]; said = true; } return; }
      if (!c || c.which !== which || c.level !== lv) {
        c = trig.cross[pid] = { which: which, level: lv, since: t, at: Math.floor(now), px: px, ripe: false, own: own };
        /* the first time this page saw the level reached: if it never fires, the trade's result says so */
        var sn = trig.seen[pid] || (trig.seen[pid] = {});
        if (!sn[which]) sn[which] = { at: c.at, px: px };
        said = true;
        return;
      }
      /* a stop loss: nothing is sent, ever (finding S1); the card keeps saying it and the price it is owed. One the
         page has watched past its window with that price owed is remembered as missed (trig.missed), so the card still
         says so when the price comes back inside: the chain keeps the late fire at the stop's level open to anyone for
         as long as the trade and that record stand, and a trader who sees the price recover must not be surprised by it */
      if (which !== 'tp') {
        if (c.own && !trig.missed[pid] && t - c.since > (TRIG_WINDOW_S + 3) * 1000) { trig.missed[pid] = { at: c.at, level: c.level, armedAt: trigForce(pid, Math.floor(now)).armedAt }; said = true; }
        return;
      }
      if (t - c.since < TRIG_BACKUP_TP_S * 1000) return;
      c.ripe = true;
      if (tpsl.rules[pid]) return;
      tpsl.rules[pid] = { tp: tp, sl: null, at: t, from: 'backup' };
      saved = true;
    });
    if (saved) tpslSave();
    else if (said) smEmit('positions');      /* the card says a level was reached, or stops saying it */
  }
  /* A level this page has seen crossed that has not closed the trade yet (trigBackup's): which, since which second,
     whether it is taking longer than a fire should (slow); for a take profit the second this page closes the trade
     itself (closeAt); for a stop loss closeAt is 0 (this page never does), level is the stop's own price and own says
     whether a late fire closes at it (trigBackup). */
  /* A stop loss this page watched go unfired past its window, now that the price is back inside it (trigBackup): when
     it was reached and its price, while the record that was crossed is still the one in force; else null. */
  function trigMissed(pid, sv) {
    var m = trig.missed[pid];
    if (!m || sv || trig.cross[pid]) return null;
    var f = trigForce(pid, Math.floor(chainNow())), pm = posById(pid);
    if (!f || f.armedAt !== m.armedAt || trigNum(f.sl18) !== m.level) return null;
    /* a market switched off Pyth and back on judges prints from its new start only: what was crossed before is gone */
    var fm = pm ? fastOf(pm.instrumentId) : null, snc = pm ? trig.since[pm.instrumentId] : 0;
    if (!fm || (snc > 0 && snc + fm.delay > m.at)) return null;
    return { at: m.at, level: m.level, levelText: fmtPrice(m.level, pm ? tpslDec(pm) : null) };
  }
  function trigCrossed(pid, sv) {
    var c = trig.cross[pid], pc = posById(pid);
    if (!c || sv) return null;
    return { which: c.which, at: c.at, slow: Date.now() - c.since > (TRIG_WINDOW_S + 3) * 1000, closeAt: c.which === 'tp' ? c.at + TRIG_BACKUP_TP_S : 0,
      level: c.level, levelText: fmtPrice(c.level, pc ? tpslDec(pc) : null), own: c.which === 'sl' && !!c.own };
  }

  /* Something the block feed should follow logs for: a change on its way, or a level the price is near or past. */
  function trigBusy() {
    if (!trigOn() || !wallet.account) return false;
    if (Object.keys(trig.save).length) return true;
    var now = Math.floor(chainNow());
    return acct.positions.some(function (p) {
      var f = trigWhere(p) === 'chain' ? trigForce(String(p.id), now) : null, px = f ? closePriceFor(p) : 0;
      if (!f || !(px > 0)) return false;
      var near = function (lv) { return lv > 0n && Math.abs(px / px18ToNum(lv) - 1) < 0.002; };
      return near(f.tp18) || near(f.sl18) || (f.sl18 > 0n && (p.isLong ? px <= px18ToNum(f.sl18) : px >= px18ToNum(f.sl18))) || (f.tp18 > 0n && (p.isLong ? px >= px18ToNum(f.tp18) : px <= px18ToNum(f.tp18)));
    });
  }

  /* The chain's own figures at a typed level (previewCloseAt(id, 10000, px18)), for the readout under a box; asked once
     per price (a quarter second after the typing stops), kept. */
  function trigPreview(pid, n) {
    var px18 = trigPx18(n);
    if (DEMO || !read.exchange || !px18 || px18 <= 0n) return null;
    var k = String(pid) + ':' + String(px18);
    if (trig.pv[k]) return trig.pv[k];
    if (!trig.pvAsk[k]) {
      trig.pvAsk[k] = setTimeout(function () {
        read.exchange.previewCloseAt(BigInt(pid), 10000, px18).then(function (r) {
          trig.pv[k] = { pnl: usd6ToNum(r[0]), fee: usd6ToNum(r[1]), payout: usd6ToNum(r[2]) };
          smEmit('positions');
        }, function () { /* the page's own figure stays */ });
      }, 250);
    }
    return null;
  }

  /* The sheet's quick picks (V5P_SPEC 18.11, the card): the price at which the page's own close figure for this
     position (tpslNums, the readout under a box) is a given share of what went in, found by halving between the price
     where the trade closes itself and far on the winning side (the figure rises with the price for a long, falls for a
     short); then held to the checks a typed price gets (tpslProblem). "Just before" the price where the trade closes
     itself is a tenth of the way back from it to the entry: far enough that an ordinary one-second move past the stop
     is not also past that price. The six prices are kept a few seconds (they do not depend on the price now); which of
     them can be set does. */
  var TRIG_PICKS = { tp: [0.25, 0.5, 1], sl: [-0.25, -0.5] };
  function trigPickPx(p, target, bust, sz) {
    var lo = bust, hi = p.isLong ? p.entry * (1 + 3 / Math.max(1, posLev(p)) + 0.02) : p.entry * Math.max(0.0001, 1 - 3 / Math.max(1, posLev(p)) - 0.02);
    var f = function (px) { try { return tpslNums(p, px, px).pct; } catch (e) { return NaN; } };
    if (!(bust > 0) || !isFinite(f(lo)) || !isFinite(f(hi)) || f(hi) < target || f(lo) > target) return null;
    for (var i = 0; i < 48; i++) { var mid = (lo + hi) / 2; if (f(mid) < target) lo = mid; else hi = mid; }
    var px = Number(fmtPrice(hi, sz));
    return px > 0 ? px : null;
  }
  function trigPicks(p) {
    var pid = String(p.id), m = positionMarket(p), sz = m ? m.szDecimals : null, bust = px18ToNum(posBust18(p));
    var key = [p.entry, p.margin, p.added || 0, bust].join('|'), c = trig.picks[pid];
    if (!c || c.key !== key || Date.now() - c.at > 5000) {
      c = trig.picks[pid] = { key: key, at: Date.now(), tp: [], sl: [] };
      TRIG_PICKS.tp.forEach(function (t) { c.tp.push({ k: '+' + Math.round(t * 100) + '%', px: trigPickPx(p, t, bust, sz) }); });
      TRIG_PICKS.sl.forEach(function (t) { c.sl.push({ k: '−' + Math.round(-t * 100) + '%', px: trigPickPx(p, t, bust, sz) }); });
      var near = bust > 0 ? Number(fmtPrice(bust + (p.entry - bust) * 0.1, sz)) : null;
      c.sl.push({ k: 'Furthest', px: near > 0 ? near : null, far: true });
    }
    var now = tpslNow(p);      /* NaN while the chain's price is being read: no pick can be taken then (TPSL_WAIT) */
    var chain = tpslChain(p), lev = posLev(p);
    var ok = function (kind, px) { return px != null && !tpslProblem(p.isLong, lev, p.entry, now, kind === 'tp' ? px : null, kind === 'sl' ? px : null, sz, chain, bust); };
    return { tp: c.tp.map(function (x) { return { k: x.k, px: ok('tp', x.px) ? x.px : null }; }), sl: c.sl.map(function (x) { return { k: x.k, px: ok('sl', x.px) ? x.px : null, far: !!x.far }; }) };
  }

  /* The sentences of V5P_SPEC 18.11, in Pro's words (Simple says them in its own). */
  var TRIG_SAY_ALWAYS = 'Your take profit and stop loss close this trade even when Confetti is closed.';
  /* a market off Pyth (or retired): the book pauses its records and refuses a change (NotFastMarket, MarketRetired) */
  var TRIG_PAUSED_SAY = 'Take profit and stop loss are paused on this market right now. You can change them when it is back; until then they close this trade only while Confetti is open here.';
  function trigStopSay(lev) {
    return 'We check the price once a second. Once it reaches your stop, the trade closes at that price. A sudden jump can close it past your price.' +
      (lev >= 250 ? ' At this leverage one second can jump past your stop and your liquidation price together. Then the trade is liquidated.' : '');
  }
  /* positions()'s auto for a trade whose levels are on chain: trigAuto, with the status of this page's own close for
     them (the backup's, or the browser rule's on a paused market) while that is on its way */
  function trigAutoOf(p, rule, pid) {
    var a = trigAuto(p);
    if (!a) return null;
    if (rule && (rule.from === 'backup' || rule.from === 'chain')) { a.status = tpslStatus(pid); if (rule.claimed) a.fired = rule.fired || ''; }
    return a;
  }

  /* ---- the demo's pretend book: the book's own rules on the demo's clock, its events, and a keeper that fires a level
     the card's price crosses (at that price, as a fire at the exit print would) ---- */
  function demoBookLog(name, values, hash) {
    var enc = bookIface.encodeEventLog(name, values);
    return { address: TRIG_DEMO_BOOK, topics: enc.topics, data: enc.data, transactionHash: hash, blockNumber: demo.block, index: 0 };
  }
  function demoBookRevert(name, args) {
    var e = new Error('The book refused it (' + name + ').');
    e.data = bookIface.encodeErrorResult(name, args);
    return e;
  }
  /* setTriggers as TriggerBook.setTriggers does it (V5P_SPEC 18.3) */
  function demoSetTriggers(args, hash) {
    var pid = String(args[0]), tp18 = BigInt(args[1]), sl18 = BigInt(args[2]), p = posById(pid);
    if (!p || demo.closed[pid]) throw demoBookRevert('UnknownPosition', [BigInt(pid)]);
    var inst = state.byInstId[p.instrumentId];
    if (inst && inst.retired) throw demoBookRevert('MarketRetired', []);
    var f = fastOf(p.instrumentId);
    if (!f) throw demoBookRevert('NotFastMarket', []);
    var r = trig.rec[pid] || { o: TRIG_NONE, n: TRIG_NONE }, now = Math.floor(chainNow()), o = r.o;
    if (now >= r.n.armedAt) {
      var until = r.n.armedAt + TRIG_WINDOW_S;
      if (trigLv(r.o) && now < until) throw demoBookRevert('TriggerSettling', [BigInt(until)]);
      if (r.n.armedAt !== 0) o = r.n;
    }
    var nw = { tp18: tp18, sl18: sl18, armedAt: now + f.delay };
    trig.rec[pid] = { o: o, n: nw };
    return [demoBookLog('TriggersSet', [BigInt(pid), wallet.account, tp18, sl18, BigInt(nw.armedAt)], hash)];
  }
  /* the demo's keeper: a level in force that the card's price is past fires (the bust first, then the stop, then the
     take profit, as the book's band orders them), closing the whole trade at that price */
  function demoTrigKeeper() {
    if (!DEMO || !trigOn() || !acct.loaded || trig.keeperOff) return;      /* keeperOff: a test's keepers that do not fire */
    var now = Math.floor(chainNow());
    acct.positions.slice().forEach(function (p) {
      var pid = String(p.id);
      if (demo.closed[pid] || acct.closeReqs[pid] || trig.fired[pid] || !fastOf(p.instrumentId)) return;
      var t = trigForce(pid, now), px = closePriceFor(p);
      if (!t || !(px > 0)) return;
      var bust = px18ToNum(posBust18(p)), sl = trigNum(t.sl18), tp = trigNum(t.tp18), kind = -1;
      if (p.isLong ? px <= bust : px >= bust) kind = sl != null && (p.isLong ? sl > bust : sl < bust) ? 2 : -1;
      else if (sl != null && (p.isLong ? px <= sl : px >= sl)) kind = 1;
      else if (tp != null && (p.isLong ? px >= tp : px <= tp)) kind = 0;
      if (kind >= 0) demoTrigFire(p, kind, px, kind === 0 ? t.tp18 : t.sl18, now);
    });
  }
  function demoTrigFire(p, kind, px, level18, at) {
    var pid = String(p.id), hash = demoHash(), me = wallet.account, px18 = toPx18(px);
    var fired = demoBookLog('TriggerFired', [p.id, me, kind, BigInt(at), level18, px18, false], hash), logs;
    trigNoteLogs([fired]);
    if (kind === 2) {
      demo.closed[pid] = true;
      /* the collateral is forfeited: the stake and the money added to it (PositionLiquidated's marginUsdc, as the contract logs it) */
      acct.marginInUse = Math.max(0, acct.marginInUse - posColl(p));
      logs = [demoLog('PositionLiquidated', [p.id, me, me, px18, numToUsd6(posColl(p)), numToUsd6(posColl(p) * 0.005), 0n], hash)];
      logs.forEach(demoRecord);
    } else logs = demoFillClose(pid, hash, px);
    reportCloseOutcome(pid, [fired].concat(logs), hash, p);
    setTimeout(demoRefresh, 1200);
  }

  /* For Simple and the cards: a position's levels as the chain holds them (or the change on its way), and its state. */
  function trigAuto(p) {
    var pid = String(p.id), where = trigWhere(p);
    if (!where) return null;
    var now = chainNow(), st = trigState(pid, now), sv = trig.save[pid], er = trig.err[pid], f = trig.fired[pid];
    if (!(st && st.has) && !sv && !(f && (acct.closeReqs[pid] || ui.checking[pid] || ui.settling[pid]))) {
      /* nothing on chain: a browser rule set before the screens went live is what this trade has. It keeps working while
         the page is open; saving it again puts it on chain (local) */
      var r = tpsl.rules[pid];
      if (r && r.from !== 'backup' && r.from !== 'chain') {
        if (where !== 'chain') return null;
        return { chain: true, local: true, paused: false, tp: r.tp != null ? r.tp : null, sl: r.sl != null ? r.sl : null, starts: 0, updating: 0, saving: '',
          err: er && Date.now() - er.at < TRIG_ERR_MS ? er.text : '', past: false, backup: false, crossed: null, missed: null, status: tpslStatus(pid), fired: r.claimed ? r.fired || '' : '' };
      }
    }
    var tp = sv ? sv.tp : st ? st.tp : null, sl = sv ? sv.sl : st ? st.sl : null;
    /* (the check at the fill, on chain) The book takes a level with no side check: one the price is already past when
       its record starts closes the trade at that record's first print (ITriggerBook). The order sheet held the levels
       to the price it had; the fill came a few seconds later at a newer one. So while a record waits for its start the
       page looks once more, at its own price for the next print (tpslNow; nothing while the chain's read is not fresh):
       already: the level the price is at or past now, which will close the trade when the record starts unless the
       price comes back or the level is changed. A stop at or past the closing price is `past` (it can never fire). */
    var already = '';
    if (!sv && st && st.arming && st.has && where === 'chain') {
      var nowPx = tpslNow(p), stopPast = sl != null && trigStopPast(p, sl);
      if (nowPx > 0) already = sl != null && !stopPast && (p.isLong ? nowPx <= sl : nowPx >= sl) ? 'sl' : tp != null && (p.isLong ? nowPx >= tp : nowPx <= tp) ? 'tp' : '';
    }
    return {
      chain: true, paused: where === 'paused', tp: tp != null ? tp : null, sl: sl != null ? sl : null, already: already,
      starts: !sv && st && st.arming && !st.old && st.has ? Math.max(1, Math.ceil(st.left)) : 0,
      updating: !sv && st && st.arming && st.old ? Math.max(1, Math.ceil(st.left)) : 0,
      saving: sv ? (sv.phase === 'wait' && sv.until > now ? 'wait' : 'send') : '',
      err: er && Date.now() - er.at < TRIG_ERR_MS ? er.text : '',
      past: sl != null && trigStopPast(p, sl),
      backup: !!(tpsl.rules[pid] && tpsl.rules[pid].from === 'backup'),
      crossed: where === 'chain' ? trigCrossed(pid, sv) : null,
      missed: where === 'chain' ? trigMissed(pid, sv) : null,
      /* fired: the level a fire on chain closed it by, or the one this page's own close (the backup) is on its way for */
      status: '', fired: f ? (f.kind === 0 ? 'tp' : 'sl') : trig.backupBy[pid] && (acct.closeReqs[pid] || ui.closing[pid] || ui.checking[pid] || ui.settling[pid]) ? trig.backupBy[pid].which : ''
    };
  }

  /* ---- v5: close part of a position, add margin (config.json "version" >= 5) -------------------------------
     One dialog with two tabs, opened from a position's tools line (desktop, tablet: Close part · Add margin) or its
     Position sheet (phones). Off on a v4 config and in the demo.
     Close part: 25 / 50 / 75 / 100 % or a typed share (0.01 % steps: bps). Before the confirm it shows what that
     share pays at the price now, from previewClose(id, bps), read again every PM_READ_MS while the dialog is open
     (the P&L cards' own pace), and what stays open, worked as the contract works it (pmRest). A share whose rest
     would hold less than minMarginUsdc() is refused with the minimum named; 100 % never is. 100 % is
     submitClose(pos), the Close button's own path (requestClose(uint256)); a share is submitClose(pos, bps)
     (requestClose(uint256,uint16), from the wallet or the session key).
     Add margin: an amount from the Confetti balance (shown), with the new liquidation price and effective leverage
     from previewAddMargin(id, amount) before the confirm; addMargin goes from the wallet (the router has none). An
     amount over the balance or past 1x (collateral over the size) is refused before anything is sent.
     TWO FACES (the owner, 2026-11-19: "we are still doing top ups and partial closes right"): the dialog below is
     the Pro face. In Simple the same dialog runs behind Simple's own cream sheet (pm.face 'sm', opened from the trade
     card's two keys through the [simple] api's part): Simple draws pmView's figures in its own words and its taps
     come back as pmPick / pmTyped / pmAmtTyped / pmMax / pmGo. Nothing is worked out twice.
     THE DEMO (a v5 config): no contract to ask, so the previews are the demo's own maths a moment later
     (pmDemoRead), a share close fills through the demo keeper (demoFillShare) and an add goes in after a pretend
     wallet second (demoAddMargin). The real page's gate is pmOn alone. */
  var PM_READ_MS = 2000;
  var PM_PRESETS = [2500, 5000, 7500, 10000];
  /* pid: the position the dialog is on; tab: 'close' or 'add'; bps: the preset picked (0: none, or a typed share);
     seq: the latest chain read (older answers are dropped); flying: reads out; close / add: the last previews
     ({ pid, bps, pnl, fee, payout } / { pid, amt6, coll6, bust18 }); closeErr / addErr: why the last preview
     failed; addSay: why the last addMargin did not go in; addBusy: it is out; done: the last share close
     ({ pid, text, until }), said in the Position sheet */
  var pm = { pid: null, tab: 'close', bps: 0, seq: 0, flying: 0, timer: null, wait: null, close: null, add: null, closeErr: '', addErr: '', addSay: '', addBusy: false, done: null,
    /* face: 'sm' while Simple's sheet is the dialog's face, null for the dialog itself; closeName / addName /
       sayName: the contract's own name of the refusal behind closeErr / addErr / addSay ('' when it is none of its);
       sayNo: the wallet said no to the add; last: per position, what the dialog last did to it ({ kind: 'part',
       bps, pnl, paid, exit } or { kind: 'add', amt, endPx }, with at), for the cream card's line */
    face: null, closeName: '', addName: '', sayName: '', sayNo: false, last: {} };

  function pmOn() { return isV5() && !DEMO && hasExchange(); }
  /* the demo on a v5 config has both as well, on its own maths: nothing is read from a chain, nothing is sent */
  function pmDemo() { return !!DEMO && isV5(); }
  function pmCan() { return pmOn() || pmDemo(); }
  /* a face is up: the dialog is open, or Simple's sheet stands in for it */
  function pmUp() { var d = $('pmModal'); return !!pm.face || !!(d && d.open); }
  /* the share of a close on its way for this position (bps under 10000), else 0 */
  function pmPartOf(pid) { var cr = acct.closeReqs[String(pid)], b = cr ? cr.bps : ui.closing[String(pid)]; return typeof b === 'number' && b > 0 && b < 10000 ? b : 0; }

  /* The tools line under a position (tpslFill): Close part and Add margin, at its right end. */
  function pmButtons(sub, p) {
    if (!pmCan()) return;
    var pid = String(p.id);
    [['close', 'Close part'], ['add', 'Add margin']].forEach(function (t, i) {
      var b = el('button', 'btn btn-sm', t[1]);
      b.type = 'button';
      b.setAttribute('data-pm', t[0]);
      if (i === 0) b.style.marginLeft = 'auto';
      b.addEventListener('click', function () { pmOpen(pid, t[0]); });
      sub.appendChild(b);
    });
  }

  /* The Position sheet (phones, renderPhSheet): the same two under the figures while the position is open and
     nothing is closing; for a while after a share close its note says what came back. */
  function pmSheet(d, on) {
    var box = d.querySelector('.js-ps-pm');
    if (!box && on && pmCan()) {
      var at = d.querySelector('.js-ps-tpsl');
      if (!at || !at.parentNode) return;
      box = el('div', 'ph-ps-btns js-ps-pm');
      [['close', 'Close part'], ['add', 'Add margin']].forEach(function (t) {
        var b = el('button', 'ph-btn', t[1]);
        b.type = 'button';
        b.setAttribute('data-pm', t[0]);
        b.addEventListener('click', function () { var s = ui.phSheet; if (s && s.mode === 'pos') pmOpen(s.pid, t[0]); });
        box.appendChild(b);
      });
      at.parentNode.insertBefore(box, at);
    }
    if (box) box.hidden = !on;
    var s = ui.phSheet, done = pm.done;
    if (on && s && done && done.pid === s.pid && Date.now() < done.until) { phText(d, '.js-ps-note', done.text); phShow(d, '.js-ps-note', true); }
  }

  function pmKv(key, id) {
    var row = el('div', 'kv');
    row.appendChild(el('span', 'kv-key', key));
    var v = el('span', 'kv-val', '—');
    v.id = id;
    row.appendChild(v);
    return row;
  }

  /* The dialog, built once (the markup of the Withdraw dialog: a sheet on a phone). */
  function pmDialog() {
    var d = $('pmModal');
    if (d) return d;
    d = el('dialog', 'modal sheet-modal');
    d.id = 'pmModal';
    d.setAttribute('aria-labelledby', 'pmTitle');
    var grab = el('div', 'sheet-grab ph-only');
    grab.setAttribute('aria-hidden', 'true');
    d.appendChild(grab);
    var form = el('form');
    form.method = 'dialog'; form.autocomplete = 'off'; form.noValidate = true;
    var head = el('div', 'panel-head');
    var title = el('span', null, 'Your position');
    title.id = 'pmTitle';
    head.appendChild(title);
    var x = el('button', 'btn btn-sm btn-ghost btn-plain', '✕');
    x.type = 'button'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', pmClose);
    head.appendChild(x);
    form.appendChild(head);
    var body = el('div', 'panel-body stack');
    var seg = el('div', 'seg');
    seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Close part or add margin');
    [['close', 'Close part'], ['add', 'Add margin']].forEach(function (t) {
      var b = el('button', 'seg-item', t[1]);
      b.type = 'button';
      b.setAttribute('data-pm-tab', t[0]);
      b.addEventListener('click', function () { pmTab(t[0]); });
      seg.appendChild(b);
    });
    body.appendChild(seg);
    /* Close part */
    var cp = el('div', 'stack');
    cp.setAttribute('data-pm-pane', 'close');
    var chips = el('div', 'chip-row');
    PM_PRESETS.forEach(function (b) {
      var c = el('button', 'pick', fmtBps(b));
      c.type = 'button';
      c.setAttribute('data-pm-bps', String(b));
      c.addEventListener('click', function () { pmPick(b); });
      chips.appendChild(c);
    });
    cp.appendChild(chips);
    var pl = el('label', 'label', 'Or type a share');
    pl.htmlFor = 'pmPct';
    cp.appendChild(pl);
    var pg = el('div', 'input-group');
    var pi = el('input', 'input');
    pi.id = 'pmPct'; pi.type = 'number'; pi.min = '0.01'; pi.max = '100'; pi.step = '0.01'; pi.inputMode = 'decimal'; pi.placeholder = '33.5';
    pi.addEventListener('input', pmTyped);
    pg.appendChild(pi);
    pg.appendChild(el('span', 'unit', '%'));
    cp.appendChild(pg);
    cp.appendChild(pmKv('Closes', 'pmCloseSize'));
    cp.appendChild(pmKv('P&L on it', 'pmClosePnl'));
    cp.appendChild(pmKv('Fee', 'pmCloseFee'));
    cp.appendChild(pmKv('You get back about', 'pmClosePay'));
    cp.appendChild(pmKv('Stays open', 'pmCloseRest'));
    /* a share keeps the liquidation price (the rest has the same collateral per size): said, with the way to move it */
    cp.appendChild(pmKv('Liquidation', 'pmCloseLiq'));
    var keep = el('div', 'hint');
    keep.id = 'pmCloseKeep';
    keep.appendChild(document.createTextNode('Closing part keeps your liquidation price. To move it away, '));
    var ka = el('a', null, 'add margin');
    ka.href = '#'; ka.setAttribute('role', 'button');
    ka.addEventListener('click', function (ev) { ev.preventDefault(); pmTab('add'); });
    keep.appendChild(ka);
    keep.appendChild(document.createTextNode('.'));
    cp.appendChild(keep);
    var ch = el('div', 'hint');
    ch.id = 'pmCloseHint'; ch.setAttribute('aria-live', 'polite');
    cp.appendChild(ch);
    var ca = el('div', 'modal-actions');
    var ck = el('button', 'btn', 'Keep open');
    ck.type = 'button'; ck.addEventListener('click', pmClose);
    var cg = el('button', 'btn go-close', 'Close');
    cg.type = 'submit'; cg.id = 'pmCloseGo';
    ca.appendChild(ck); ca.appendChild(cg);
    cp.appendChild(ca);
    body.appendChild(cp);
    /* Add margin */
    var ap = el('div', 'stack');
    ap.setAttribute('data-pm-pane', 'add');
    ap.appendChild(pmKv('Your balance', 'pmAvail'));
    var al = el('label', 'label', 'Add');
    al.htmlFor = 'pmAmt';
    ap.appendChild(al);
    var ag = el('div', 'input-group');
    var ai = el('input', 'input');
    ai.id = 'pmAmt'; ai.type = 'number'; ai.min = '0'; ai.step = 'any'; ai.inputMode = 'decimal'; ai.placeholder = '0.00';
    ai.addEventListener('input', pmAmtTyped);
    ag.appendChild(ai);
    ag.appendChild(el('span', 'unit', 'USDC'));
    ap.appendChild(ag);
    var aq = el('div', 'quick');
    var am = el('button', 'btn', 'Max');
    am.type = 'button'; am.addEventListener('click', pmMax);
    aq.appendChild(am);
    ap.appendChild(aq);
    ap.appendChild(pmKv('Put in', 'pmAddMargin'));
    ap.appendChild(pmKv('Leverage', 'pmAddLev'));
    ap.appendChild(pmKv('Liquidation', 'pmAddLiq'));
    var ah = el('div', 'hint');
    ah.id = 'pmAddHint'; ah.setAttribute('aria-live', 'polite');
    ap.appendChild(ah);
    var aa = el('div', 'modal-actions');
    var ak = el('button', 'btn', 'Cancel');
    ak.type = 'button'; ak.addEventListener('click', pmClose);
    var ad = el('button', 'btn btn-primary', 'Add');
    ad.type = 'submit'; ad.id = 'pmAddGo';
    aa.appendChild(ak); aa.appendChild(ad);
    ap.appendChild(aa);
    body.appendChild(ap);
    form.appendChild(body);
    form.addEventListener('submit', function (ev) { ev.preventDefault(); pmGo(); });
    d.appendChild(form);
    d.addEventListener('click', function (ev) { if (ev.target === d) pmClose(); });
    d.addEventListener('close', pmStop);
    document.body.appendChild(d);
    return d;
  }

  /* face 'sm': Simple's sheet is what the trader sees (the dialog's own nodes still hold the typed share and
     amount, unseen). Returns true once it is up. */
  function pmOpen(pid, tab, face) {
    pid = String(pid);
    if (!pmCan() || !posById(pid)) return false;
    if (!wallet.account) { connect(); return false; }
    pmDialog();
    pm.pid = pid; pm.bps = 0; pm.close = null; pm.add = null; pm.closeErr = ''; pm.addErr = ''; pm.addSay = '';
    pm.closeName = ''; pm.addName = ''; pm.sayName = ''; pm.sayNo = false;
    var pi = $('pmPct'); if (pi) pi.value = '';
    var ai = $('pmAmt'); if (ai) ai.value = '';
    pm.tab = tab === 'add' ? 'add' : 'close';
    pm.face = face === 'sm' ? 'sm' : null;
    if (!pm.face) openDialog('pmModal');
    if (!pm.timer) pm.timer = setInterval(pmTick, PM_READ_MS);
    pmReadNow();
    pmReadMin();
    if (!pm.face && pm.tab === 'add' && ai && !isPhone()) ai.focus();
    return true;
  }

  function pmTab(tab) {
    pm.tab = tab;
    pmReadNow();
    var ai = $('pmAmt');
    if (!pm.face && tab === 'add' && ai && !isPhone()) ai.focus();
  }

  /* closed by the dialog itself (it went, or its position did): Simple's sheet is told, and follows */
  function pmClose() {
    if (pm.face) { pm.face = null; pmStop(); smEmit('part'); return; }
    closeDialog('pmModal');
  }

  /* the dialog's own inputs, by whichever face: a preset key, the typed share, the typed amount */
  function pmPick(b) { pm.bps = b; pm.closeErr = ''; pm.closeName = ''; var i = $('pmPct'); if (i) i.value = ''; pmReadNow(); }
  function pmTyped() { pm.bps = 0; pm.closeErr = ''; pm.closeName = ''; pmRead(); }
  function pmAmtTyped() { pm.addSay = ''; pm.addErr = ''; pm.addName = ''; pm.sayName = ''; pm.sayNo = false; pmRead(); }

  function pmStop() {
    if (pm.timer) { clearInterval(pm.timer); pm.timer = null; }
    clearTimeout(pm.wait);
    pm.seq++;
  }

  /* Every PM_READ_MS while the dialog is open: the preview again at the price now (not while one is out); the
     dialog goes when its position does (closed or liquidated: its own card says so). */
  function pmTick() {
    if (!pmUp()) { pmStop(); return; }
    if (!posById(pm.pid)) { pmClose(); return; }
    if (pm.flying) { pmRender(); return; }
    pmReadNow();
  }

  /* The share picked: a preset, or the typed percent (0.01 to 100, two decimals at most); why: a typed share
     that is not one. */
  function pmShare() {
    var i = $('pmPct'), raw = i ? String(i.value).trim() : '';
    if (raw === '') return { bps: pm.bps, why: '' };
    var n = Number(raw);
    if (!isFinite(n) || n <= 0 || n > 100) return { bps: 0, why: 'Type a share from 0.01% to 100%.' };
    var b = Math.round(n * 100);
    if (Math.abs(b - n * 100) > 1e-6) return { bps: 0, why: 'Two decimals at most: 0.01% steps.' };
    return { bps: b, why: '' };
  }

  /* What a close of bps leaves open, worked as the contract works it (6-decimal USDC): margin M - floor(M x bps /
     10000), added margin floor(A x rest / M); its collateral and its size. */
  function pmRest(p, bps) {
    var M = p.margin6, A = p.added6 || 0n;
    var m = M - M * BigInt(bps) / 10000n;
    var a = M > 0n ? A * m / M : 0n;
    return { margin6: m, coll6: m + a, notional6: m * BigInt(p.leverage) };
  }

  function pmMin6() { return BigInt(Math.round(minMargin() * 1e6)); }

  /* The minimum from the chain (minMarginUsdc), read when the dialog opens and when a preview says the rest would
     be under it: the owner may have moved it since the page last read the house. A new value redoes the preview. */
  function pmReadMin() {
    if (pmDemo() || !read.exchange) return;      /* the demo's minimum is its own: nothing is read from a chain there */
    var was = house.minMargin;
    read.exchange.minMarginUsdc().then(function (v) {
      house.minMargin = usd6ToNum(v);
      if (house.minMargin !== was) pmReadNow(); else pmRender();
    }, function () { /* the house read tries again on its own */ });
  }

  /* The largest share under 100 % whose rest keeps at least the minimum (0: none does, only a full close). */
  function pmMaxShare(p) {
    var lo = 0, hi = 9999, min6 = pmMin6();
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (pmRest(p, mid).coll6 >= min6) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /* Whether the share s can be closed now: { code, max }. code '' when it can; 'pending' a close of this position
     is on its way; 'typed' what is typed is not a share (s.why says how); 'only' nothing under 100 % leaves the
     minimum open; 'min' this share would leave less than the minimum (max: the largest share that does not). */
  function pmCloseCheck(p, s) {
    var pid = String(p.id);
    if (acct.closeReqs[pid] || ui.closing[pid] || ui.checking[pid] || ui.settling[pid]) return { code: 'pending', max: 0 };
    if (s.why) return { code: 'typed', max: 0 };
    if (!s.bps || s.bps >= 10000) return { code: '', max: 0 };
    var max = pmMaxShare(p);
    return { code: s.bps <= max ? '' : max ? 'min' : 'only', max: max };
  }
  /* Why the share s cannot be closed now (one line), or ''. */
  function pmCloseWhy(p, s) {
    var c = pmCloseCheck(p, s);
    if (c.code === 'pending') return closePendingSay(String(p.id));
    if (c.code === 'typed') return s.why;
    if (!c.code) return '';
    var min = fmtUsdShort(minMargin());
    if (c.code === 'only') return 'Only a full close: what stays open must be at least ' + min + '.';
    return 'What stays open would be ' + fmtUsd(usd6ToNum(pmRest(p, s.bps).coll6)) + ', under the ' + min + ' minimum. Close at most ' + fmtBps(c.max) + ', or 100%.';
  }

  /* The most margin the position can still take: up to 1x (collateral = size). */
  function pmRoom6(p) { return p.margin6 * BigInt(p.leverage) - p.margin6 - (p.added6 || 0n); }

  /* The amount typed on Add margin, checked: above zero, no further than 1x, within the balance. code names the
     refusal for a face with its own words: 'zero', 'full' (at 1x already), 'room' (more than it can take), 'bal'. */
  function pmAmount(p) {
    var i = $('pmAmt'), raw = i ? String(i.value).trim() : '';
    if (raw === '') return { amt6: 0n, why: '', code: '' };
    var v = Number(raw);
    var amt6 = isFinite(v) && v > 0 ? numToUsd6(v) : 0n;
    if (amt6 <= 0n) return { amt6: 0n, why: 'Type an amount above zero.', code: 'zero' };
    var room6 = pmRoom6(p);
    if (room6 <= 0n) return { amt6: amt6, why: 'It is at 1x already: it cannot take more margin.', code: 'full' };
    if (amt6 > room6) return { amt6: amt6, why: 'At most ' + fmtUsd(usd6ToNum(room6)) + ' here: more would take it below 1x.', code: 'room' };
    if (v > acct.available + 1e-9) return { amt6: amt6, why: 'More than your balance (' + fmtUsd(acct.available) + ').', code: 'bal' };
    return { amt6: amt6, why: '', code: '' };
  }

  function pmMax() {
    var p = posById(pm.pid);
    if (!p) return;
    var v = Math.min(acct.available, usd6ToNum(pmRoom6(p)));
    var i = $('pmAmt');
    if (i) i.value = v > 0 ? String(Math.floor(v * 1e6) / 1e6) : '';
    pm.addSay = ''; pm.addErr = '';
    pmReadNow();
  }

  /* A typed change reads after a short pause; a tap at once. */
  function pmRead() { clearTimeout(pm.wait); pm.wait = setTimeout(pmReadNow, 250); pmRender(); }

  /* The open tab's preview from the chain at the price now. */
  function pmReadNow() {
    clearTimeout(pm.wait);
    var p = posById(pm.pid);
    pmRender();
    if (!p) return;
    if (pmDemo()) { pmDemoRead(p); return; }
    if (!read.exchange || !read.exchangeBps) return;
    var seq = ++pm.seq, pid = pm.pid, q;
    if (pm.tab === 'close') {
      var s = pmShare();
      if (!s.bps || pmCloseWhy(p, s)) return;
      /* a live fast market's card prices its position at its estimated print (fastPx18), and its Close key says
         what closing pays there: the share is asked at that same price (previewCloseAt, the contract's own figures
         at a given price), so the dialog and the card never disagree. Elsewhere, and whenever there is no such
         price, previewClose at the oracle price as before. */
      var f18 = fastPx18(p.instrumentId);
      q = (f18 != null ? read.exchange.previewCloseAt(p.id, s.bps, f18) : read.exchangeBps[PREVIEW_BPS](p.id, s.bps)).then(function (r) {
        if (seq !== pm.seq) return;
        pm.close = { pid: pid, bps: s.bps, pnl: usd6ToNum(r[0]), fee: usd6ToNum(r[1]), payout: usd6ToNum(r[2]) };
        pm.closeErr = ''; pm.closeName = '';
      }, function (e) {
        if (seq !== pm.seq) return;
        pm.close = null;
        pm.closeErr = describeErrorAs(e, CLOSE_SHARE_WORDS); pm.closeName = revertName(e) || '';
        if (revertName(e) === 'MarginBelowMinimum') pmReadMin();
      });
    } else {
      var a = pmAmount(p);
      if (!a.amt6 || a.why) return;
      q = read.exchange.previewAddMargin(p.id, a.amt6).then(function (r) {
        if (seq !== pm.seq) return;
        pm.add = { pid: pid, amt6: a.amt6, coll6: BigInt(r[0]), bust18: BigInt(r[1]) };
        pm.addErr = ''; pm.addName = '';
      }, function (e) {
        if (seq !== pm.seq) return;
        pm.add = null;
        pm.addErr = describeErrorAs(e, ADD_MARGIN_WORDS); pm.addName = revertName(e) || '';
      });
    }
    pm.flying++;
    q.then(function () { pm.flying--; if (seq === pm.seq) pmRender(); });
  }

  /* The demo's previews, a moment later as a read would answer: what closing that share pays at the price now
     (demoShare) and the liquidation price on the larger collateral (bustPriceOf18). The contract refuses an add to
     a position already past its liquidation price (PositionBusted); so does the demo. */
  function pmDemoRead(p) {
    var seq = ++pm.seq, pid = pm.pid, tab = pm.tab, s = pmShare(), a = pmAmount(p);
    if (tab === 'close' ? (!s.bps || !!pmCloseWhy(p, s)) : (!a.amt6 || !!a.why)) return;
    pm.flying++;
    setTimeout(function () {
      pm.flying--;
      if (seq !== pm.seq) return;
      var now = posById(pid);
      if (!now) return;
      if (tab === 'close') {
        var sh = demoShare(now, s.bps);
        if (sh) { pm.close = { pid: pid, bps: s.bps, pnl: sh.gross, fee: sh.fee, payout: sh.payout }; pm.closeErr = ''; }
        else { pm.close = null; pm.closeErr = 'The price is delayed. It is read again in a moment.'; }
        pm.closeName = '';
      } else {
        var px = closePriceFor(now), bust = px18ToNum(posBust18(now));
        if (px > 0 && bust > 0 && (now.isLong ? px <= bust : px >= bust)) { pm.add = null; pm.addErr = ADD_MARGIN_WORDS.PositionBusted(); pm.addName = 'PositionBusted'; }
        else {
          var coll6 = now.margin6 + (now.added6 || 0n) + a.amt6;
          pm.add = { pid: pid, amt6: a.amt6, coll6: coll6, bust18: bustPriceOf18(rawEntry18(now.entryPx18, now.isLong, now.entryDeadbandBps), now.isLong, coll6, now.margin6 * BigInt(now.leverage)) };
          pm.addErr = ''; pm.addName = '';
        }
      }
      pmRender();
    }, 350);
  }

  /* The open tab as data, for a face that draws it itself (Simple's sheet): the very figures and checks
     pmRenderClose and pmRenderAdd write into the dialog, as numbers and codes instead of Pro's sentences. null when
     Simple's sheet is not the face, or the position is gone.
     close: bps the share picked (0: none), preset / typed where it came from, code why it cannot be closed
       (pmCloseCheck) with max the largest share that can, ok, full (100 %), take what closing it pays now (null
       until the preview is in), stays what the trade then holds as its card counts it (the stake and added money
       that stay, and what opening that stake took), wait the preview is on its way, err / errName a preview that
       failed.
     add: typed, amt, code why it cannot be added (pmAmount), room what the trade can still take, available the
       balance, px the price its card measures from, now / after { endPx, away, boost, inAmt } (after: null until the
       preview is in), wait, err / errName, sending the add is out (sent: the wallet has let it go and the chain has
       it), say / sayName / sayNo why the last add did not go in.
     both: secs the seconds a fill of this market takes (fillSecs), fast, oneTap (a share close needs no wallet),
       min the least a trade may hold, busy a send of this page is out. */
  function pmView() {
    var p = posById(pm.pid);
    if (!pm.face || !p) return null;
    var m = positionMarket(p);
    var v = { pid: String(p.id), tab: pm.tab, sym: m ? m.symbol : '', sz: m ? m.szDecimals : null, isLong: p.isLong, busy: !!state.busy,
      secs: fillSecs(p.instrumentId), fast: !!fastOf(p.instrumentId), oneTap: sessionLive(), min: minMargin() };
    if (pm.tab === 'close') {
      var s = pmShare(), c = pmCloseCheck(p, s), ok = s.bps > 0 && !c.code, full = s.bps >= 10000, rest = ok && !full ? pmRest(p, s.bps) : null;
      var pv = ok && pm.close && pm.close.pid === pm.pid && pm.close.bps === s.bps ? pm.close : null;
      var pi = $('pmPct');
      v.presets = PM_PRESETS; v.bps = s.bps; v.preset = pm.bps; v.typed = pi ? String(pi.value) : ''; v.code = c.code; v.max = pmMaxShare(p);
      v.ok = ok; v.full = full; v.take = pv ? pv.payout : null;
      v.stays = !ok ? null : full ? 0 : usd6ToNum(rest.coll6) + feeOnStake(usd6ToNum(rest.margin6), posFeeX10(p));
      v.wait = ok && !pv && !pm.closeErr; v.err = ok && !pv ? pm.closeErr : ''; v.errName = ok && !pv ? pm.closeName : '';
    } else {
      var a = pmAmount(p), apv = a.amt6 && !a.why && pm.add && pm.add.pid === pm.pid && pm.add.amt6 === a.amt6 ? pm.add : null;
      var notional6 = p.margin6 * BigInt(p.leverage), px = closePriceFor(p), ai = $('pmAmt');
      var away = function (end) { return px > 0 && end > 0 ? Math.max(0, p.isLong ? (px - end) / px : (end - px) / px) : NaN; };
      var endNow = px18ToNum(posBust18(p)), endAfter = apv ? px18ToNum(apv.bust18) : NaN;
      v.typed = ai ? String(ai.value) : ''; v.amt = usd6ToNum(a.amt6); v.code = a.code || ''; v.room = usd6ToNum(pmRoom6(p)); v.available = acct.available; v.px = px;
      v.now = { endPx: endNow, away: away(endNow), boost: Number(levShown(p)), inAmt: posIn(p) };
      v.after = apv ? { endPx: endAfter, away: away(endAfter), boost: apv.coll6 > 0n ? Math.round(Number(notional6 * 10000n / apv.coll6) / 100) / 100 : NaN, inAmt: usd6ToNum(apv.coll6) + posOpenFee(p) } : null;
      v.ok = !!apv; v.wait = !!a.amt6 && !a.why && !apv && !pm.addErr; v.err = a.amt6 && !a.why && !apv ? pm.addErr : ''; v.errName = a.amt6 && !a.why && !apv ? pm.addName : '';
      v.sending = !!pm.addBusy; v.sent = !!(pm.addBusy && pm.addSent); v.say = pm.addSay; v.sayName = pm.sayName; v.sayNo = !!pm.sayNo;
    }
    return v;
  }

  function pmRender() {
    if (pm.face) { smEmit('part'); return; }      /* Simple's sheet draws it (pmView) */
    var d = $('pmModal'), p = posById(pm.pid);
    if (!d || !d.open || !p) return;
    setText('pmTitle', posLabel(p));
    Array.prototype.forEach.call(d.querySelectorAll('[data-pm-tab]'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-pm-tab') === pm.tab ? 'true' : 'false'); });
    Array.prototype.forEach.call(d.querySelectorAll('[data-pm-pane]'), function (x) { x.style.display = x.getAttribute('data-pm-pane') === pm.tab ? '' : 'none'; });
    if (pm.tab === 'close') pmRenderClose(d, p); else pmRenderAdd(p);
  }

  function pmRenderClose(d, p) {
    var s = pmShare(), why = pmCloseWhy(p, s), max = pmMaxShare(p), min = fmtUsdShort(minMargin());
    Array.prototype.forEach.call(d.querySelectorAll('[data-pm-bps]'), function (c) {
      var b = Number(c.getAttribute('data-pm-bps')), off = b < 10000 && b > max;
      c.setAttribute('aria-pressed', pm.bps === b && s.bps === b ? 'true' : 'false');
      c.disabled = off;
      c.title = off ? 'What stays open would be under the ' + min + ' minimum.' : '';
    });
    var ok = s.bps > 0 && !why;
    var rest = ok ? pmRest(p, s.bps) : null, full = s.bps >= 10000;
    var pv = ok && pm.close && pm.close.pid === pm.pid && pm.close.bps === s.bps ? pm.close : null;
    var wait = ok ? (pm.closeErr ? '—' : '…') : '—';
    setText('pmCloseSize', ok ? fmtUsd(usd6ToNum(p.margin6 - rest.margin6) * p.leverage) + ' of ' + fmtUsd(p.margin * p.leverage) + ' (' + fmtBps(s.bps) + ')' : '—');
    setText('pmClosePnl', pv ? fmtUsd(pv.pnl, true) : wait);
    var pe = $('pmClosePnl');
    if (pe) pe.className = 'kv-val' + (pv && pv.pnl > 0 ? ' pos' : pv && pv.pnl < 0 ? ' neg' : '');
    setText('pmCloseFee', pv ? fmtUsd(pv.fee) : wait);
    setText('pmClosePay', pv ? fmtUsd(pv.payout) : wait);
    setText('pmCloseRest', !ok ? '—' : full ? 'Nothing: the position closes' : fmtUsd(usd6ToNum(rest.coll6)) + ' put in · ' + fmtUsd(usd6ToNum(rest.notional6)) + ' size');
    var keepOn = ok && !full, lm = positionMarket(p);
    var lq = $('pmCloseLiq');
    if (lq) { lq.textContent = fmtPrice(px18ToNum(posBust18(p)), lm ? lm.szDecimals : null) + ' · stays the same'; lq.parentNode.style.display = keepOn ? '' : 'none'; }
    var kp = $('pmCloseKeep');
    if (kp) kp.style.display = keepOn ? '' : 'none';
    var err = why || (ok && !pv ? pm.closeErr : '');
    var hint = $('pmCloseHint');
    if (hint) {
      hint.textContent = err || (!s.bps ? 'Pick how much to close. What stays open keeps at least ' + min + '.'
        : 'At the price now. It closes at ' + (fastOf(p.instrumentId) ? fastWhen(fastOf(p.instrumentId), 'confirm') + ', in about ' : 'the price a few seconds after you confirm, about ') + fillSecs(p.instrumentId) + ' s.' + (sessionLive() ? '' : ' Your wallet asks next.'));
      hint.classList.toggle('is-err', !!err);
    }
    var go = $('pmCloseGo');
    if (go) {
      go.textContent = !ok ? 'Close' : (full ? 'Close all' : 'Close ' + fmtBps(s.bps)) + (pv ? ' · about ' + fmtUsdHead(pv.payout) : pm.closeErr ? '' : '…');
      go.disabled = !pv || state.busy;
    }
  }

  function pmRenderAdd(p) {
    var m = positionMarket(p), sz = m ? m.szDecimals : null;
    setText('pmAvail', fmtUsd(acct.available));
    var a = pmAmount(p);
    var pv = a.amt6 && !a.why && pm.add && pm.add.pid === pm.pid && pm.add.amt6 === a.amt6 ? pm.add : null;
    var notional6 = p.margin6 * BigInt(p.leverage);
    setText('pmAddMargin', fmtUsd(posColl(p)) + (pv ? ' → ' + fmtUsd(usd6ToNum(pv.coll6)) : ''));
    setText('pmAddLev', levShown(p) + 'x' + (pv && pv.coll6 > 0n ? ' → ' + String(Math.round(Number(notional6 * 10000n / pv.coll6) / 100) / 100) + 'x' : ''));
    setText('pmAddLiq', fmtPrice(px18ToNum(posBust18(p)), sz) + (pv ? ' → ' + fmtPrice(px18ToNum(pv.bust18), sz) : ''));
    var err = a.why || pm.addSay || (a.amt6 && !pv ? pm.addErr : '');
    var room = usd6ToNum(pmRoom6(p));
    var hint = $('pmAddHint');
    if (hint) {
      hint.textContent = err || (pm.addBusy ? 'Confirm in your wallet. It goes in at once, no fill to wait for.'
        : pv ? 'From your Confetti balance, at once. Your wallet asks to confirm.' + (fastOf(p.instrumentId) ? ' It protects the position from the next second\'s price on: a liquidation on an earlier price uses the old liquidation price and gives this money back.' : '')
        : a.amt6 ? 'Working out the new liquidation price…'
        : room > 0 ? 'Move the liquidation price away: up to ' + fmtUsd(room) + ' more, which takes it to 1x.' : 'It is at 1x already: it cannot take more margin.');
      hint.classList.toggle('is-err', !!err);
    }
    var go = $('pmAddGo');
    if (go) {
      go.textContent = pm.addBusy ? 'Adding…' : a.amt6 && !a.why ? 'Add ' + fmtUsd(usd6ToNum(a.amt6)) : 'Add';
      go.disabled = !pv || !!a.why || pm.addBusy || state.busy;
    }
  }

  /* The dialog's button. Returns a promise for a face that waits on it: true once the close request is filed, or
     the money is in; false when nothing went (the dialog says why). */
  function pmGo() {
    var p = posById(pm.pid), no = Promise.resolve(false);
    if (!p || state.busy || pm.addBusy) return no;
    if (pm.tab === 'close') {
      var s = pmShare();
      if (!s.bps || pmCloseWhy(p, s) || !(pm.close && pm.close.pid === pm.pid && pm.close.bps === s.bps)) { pmRender(); return no; }
      pmClose();
      /* 100 %: the Close button's own path */
      return s.bps >= 10000 ? submitClose(p) : submitClose(p, s.bps);
    }
    var a = pmAmount(p);
    if (!a.amt6 || a.why || !(pm.add && pm.add.pid === pm.pid && pm.add.amt6 === a.amt6)) { pmRender(); return no; }
    pm.addBusy = true; pm.addSay = '';
    pmRender();
    return submitAddMargin(p, a.amt6).then(function (ok) {
      pm.addBusy = false;
      if (ok) pmClose(); else pmRender();
      return ok;
    });
  }

  /* addMargin from the wallet (a session key cannot). Resolves true once it is in; else pm.addSay says why. */
  function submitAddMargin(pos, amt6) {
    pm.sayName = ''; pm.sayNo = false; pm.addSent = false;
    if (DEMO) return demoAddMargin(pos, amt6);
    try { requireSigner(); } catch (e) { pm.addSay = e.message; return Promise.resolve(false); }
    var label = posLabel(pos), m = positionMarket(pos), sz = m ? m.szDecimals : null;
    var desc = 'Add ' + fmtUsd(usd6ToNum(amt6)) + ' to ' + label;
    setBusy(true);
    /* sent: the wallet said yes and the transaction is out (pm.addSent, for a face that says so) */
    return sendTx(desc, exchangeWrite().addMargin, [pos.id, amt6], true, wallet.account, { sent: function () { pm.addSent = true; pmRender(); } }).then(function (rc) {
      var ev = receiptEvents(rc, 'MarginAdded')[0];
      pm.last[String(pos.id)] = { kind: 'add', amt: usd6ToNum(amt6), endPx: ev ? px18ToNum(ev.args.bustPx18) : null, at: Date.now() };
      toast('Added ' + fmtUsd(usd6ToNum(amt6)) + ' to your ' + label + '.' + (ev ? ' Liquidation now ' + fmtPrice(px18ToNum(ev.args.bustPx18), sz) + '.' : ''), 'ok', txLink(rc.hash));
      return afterTx().then(function () { return true; }, function () { return true; });
    }).catch(function (e) {
      pm.addSay = describeErrorAs(e, ADD_MARGIN_WORDS); pm.sayName = revertName(e) || ''; pm.sayNo = isUserRejection(e);
      return false;
    }).then(function (ok) { setBusy(false); return ok; });
  }

  function init() {
    try { initSwap(); } catch (e) { /* the swap card never blocks the page */ }
    try { initBridge(); } catch (e) { /* the Bring ETH box never blocks the page */ }
    try { initOnramp(); } catch (e) { /* the on-ramp never blocks the page */ }
    try { initPosView(); } catch (e) { /* the view switch never blocks the page */ }
    try { initLimits(); } catch (e) { /* limit orders never block the page */ }
    try { initTpSl(); } catch (e) { /* take profit / stop loss never blocks the page */ }
    try { initHoverPnl(); } catch (e) { /* the hover box never blocks the page */ }
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

  /* ==== [simple] BEGIN: the seam to simple.js ========================================================================
     Confetti Simple (the owner, 2026-11-11: "much simpler and easier to get going"): the phone view that lives in
     simple.js / simple.css. This block is the whole of it in this file, but for three marked one-line hooks ("[simple] hook"
     in openWalletApps, onrampGo and makeProvider). simple.js is loaded async and never holds this file up: whichever of the two arrives
     second does the hand-over (start(), at the end of the block), once, with the narrow api below: readers of this page's
     state, the very actions the Pro ticket and sheets run, and change events. Nothing else of the page can be reached
     from outside. The wraps at the end call the function they wrap first and only add an event; a few step aside or add a
     check while Simple is what the phone shows (smShown()). Without simple.js or simple.css, or with config
     ui.simplePhones "off", the page runs exactly as before. */
  var sm = { subs: {}, hooks: null, noSwitch: 0, want: null, results: {}, gone: {}, dep: null, orOpened: false, switchChain: null, look: false };
  function smEmit(ev, a) { var l = sm.subs[ev]; if (l) l.forEach(function (f) { try { f(a); } catch (e) { /* Simple never breaks the page */ } }); }
  function smShown() { return !!(sm.hooks && sm.hooks.shown && sm.hooks.shown()); }   /* Simple is what the phone shows now */
  /* The ticket's own numbers and checks, asked for a trade Simple describes (the way limitProblem asks them). */
  /* v5: the amount typed in Simple is what leaves the trading money. The stake the request carries is the most
     that, with its open fee on top, still fits in that amount (settle.js stakeFor, the contract's own integers); on
     v4, for a house wallet and on a market without the fee it is the amount itself. */
  function smStake(o, m) { return stakeOfAmount(o.margin, m && m.instrumentId != null ? feeShareFor(m.instrumentId, o.lev) : 0); }
  /* the ticket's refusal for the trade Simple describes; under the minimum it names the smallest amount, which is
     what Simple's box holds (the minimum stake and what opening it takes) */
  function smProblem() {
    var why = marketBlock() || orderProblem() || '';
    if (why && isV5() && minKnown() && form.margin > 0 && form.margin < minMargin()) return 'The smallest trade is ' + fmtUsd(amountOfStake(minMargin(), ticketShare())) + '.';
    return why;
  }
  function smWith(o, fn) {
    var m = o && state.bySym[o.sym];
    if (!m) return null;
    var keep = { market: state.market, side: form.side, margin: form.margin, lev: form.lev };
    state.market = m; form.side = o.isLong ? 'long' : 'short'; form.lev = o.lev; form.margin = smStake(o, m);
    try { return fn(m); } finally { state.market = keep.market; form.side = keep.side; form.margin = keep.margin; form.lev = keep.lev; }
  }
  /* What the Pro ticket's button does (onAction), for the trade Simple's sheet shows: the same checks, then the same
     submitOpen. Returns '' once the order is on its way, or the sentence that stopped it. The sheet itself showed both
     outcomes in dollars, so the big-trade check is not asked a second time. */
  function smOpen(o) {
    var m = o && state.bySym[o.sym];
    if (!m) return 'That coin is not on Confetti.';
    if (state.busy || tk.phase === 'wallet' || tk.phase === 'req') return 'One moment: the last order is still going in.';
    if (!window.ethers || !wallet.account || !hasExchange() || !acct.loaded) return 'Your account is still loading.';
    /* checked with Simple's numbers first, the way the readers ask: a refusal leaves the Pro ticket exactly as it was */
    var pre = smWith(o, function () { return smProblem(); });
    if (pre) return pre;
    if (state.market !== m) selectMarket(o.sym);
    if (tk.phase) tkReset();
    if (lim.type === 'limit' && lim.firing === null) setOrderType('market');
    setSide(o.isLong ? 'long' : 'short');
    form.lev = o.lev; form.margin = smStake(o, m); form.maxed = !!o.maxed; form.touched = true; form.levCustom = false;
    var why = marketBlock() || orderProblem();          /* before any render: renderAction's fitLeverage must not change what was shown */
    if (why) return why;
    lsSet(LS.lev + m.symbol, String(o.lev));
    var mi = $('marginInput'); if (mi) mi.value = String(form.margin);
    renderAmountChips(); renderLeverage(); renderForm(); renderAction();
    ui.levFit = null;
    sm.want = o.tp != null || o.sl != null ? { tp: o.tp != null ? o.tp : null, sl: o.sl != null ? o.sl : null, why: '' } : null;
    var n0 = quick.list.length;
    try { submitOpen(); } finally { sm.want = null; }
    /* submitOpen can step back without a word (the ticket not ready): then nothing is on its way, and Simple's sheet must know */
    if (!tk.phase && quick.list.length === n0) return 'That did not start. Press again.';
    return '';
  }
  /* The Add USDC sheet's one-tap swap (depSwapGo) without its box: all the wallet's HYPE above the gas it keeps. */
  function smSwapHype(capWei) {
    var T = swTokens(), route = swRoute('HYPE', 'USDC'), top = depSwapMaxWei(), amountIn = capWei != null && capWei < top ? capWei : top, prev = ui.hypeWei;
    if (!route || !swReady() || !(amountIn > 0n)) return Promise.reject(new Error('Nothing to convert.'));
    return swV3Quote(route, T.HYPE.addr, amountIn).then(function (r) {
      var minOut = r.out > 0n ? swMinOut(r.out, 1, r.impact) : null;
      if (minOut == null) throw new Error('That is too much for one go right now. Try again in a minute.');
      swNoteHypeUsd(amountIn, r.out);
      return swSend({ route: route, amountIn: amountIn, out: r.out, minOut: minOut, impact: r.impact, at: Date.now(), slip: 1 }, T.HYPE, T.USDC, 'Swap ' + swFmt(amountIn, 18) + ' HYPE for USDC');
    }).then(function () { return swAfterLanded(prev); });
  }
  var smApi = {
    demo: DEMO, chainId: CHAIN_ID, usdc: USDC, exchange: CONTRACTS.exchange, swapKeepWei: DEP_SWAP_RESERVE_WEI,
    on: function (ev, fn) { (sm.subs[ev] = sm.subs[ev] || []).push(fn); },
    cfg: function () { return cfg || {}; },
    isPhone: isPhone, onPhoneChange: onPhoneChange,
    fmt: { usd: fmtUsd, usdShort: fmtUsdShort, price: fmtPrice, addr: shortAddr, move: fmtMove },
    info: postInfo,
    wallet: function () {
      return { account: wallet.account, chainId: wallet.chainId, eth: wallet.eth, name: wallet.eth ? walletName(wallet.eth) : '', has: !!(wallet.eth || getInjected()), ready: !!window.ethers };
    },
    account: function () {
      /* min: the least that opens a trade (v5: the smallest stake with what opening it at 1x takes on top, on the
         market where that is least) */
      var mm = minMargin(), least = null;
      if (isV5()) state.markets.forEach(function (m) { if (m.instrumentId == null) return; var s = feeShareFor(m.instrumentId, 1); if (least == null || s < least) least = s; });
      /* inTrades: what went into the open trades and the orders on their way; on v5 the sum of the cards' own
         "in" amounts (each stake with what opening it took), so the line under the balance and the cards agree */
      var inTrades = isV5() && acct.loaded ? acct.positions.reduce(function (s, p) { return s + posIn(p); }, 0) + acct.pending : acct.marginInUse + acct.pending;
      return { loaded: acct.loaded, available: acct.available, inTrades: inTrades, walletUsdc: acct.walletUsdc, allowance: acct.allowance, hypeWei: ui.hypeWei,
        hypeUsd: sw.hypeUsd || NaN, busy: !!state.busy, word: state.busy ? sendWord() : '', dep: dep.step, depTwo: dep.two, min: minKnown() ? amountOfStake(mm, least || 0) : null };
    },
    markets: function () {
      var firsts = ['BTC', 'ETH', 'SOL'];
      function rank(m) { var i = firsts.indexOf(m.symbol); return i < 0 ? firsts.length : i; }
      return state.markets.filter(marketOnChain).sort(function (a, b) { return rank(a) - rank(b) || state.markets.indexOf(a) - state.markets.indexOf(b); }).map(function (m) {
        return { sym: m.symbol, coin: m.coin, sz: m.szDecimals, maxLev: maxLev(m), tag: marketTagText(m), per: coinsPerUnit(m.symbol) };
      });
    },
    price: function (sym) {
      var m = state.bySym[sym]; if (!m) return null;
      var c = state.ctx[m.coin];
      return { px: state.mids[m.coin], prev: c ? c.prevDayPx : NaN, sz: m.szDecimals, at: state.midsAt };
    },
    /* [simple] house and per-coin stats: the house LP, site-wide 24h volume, and per-coin OI and volume */
    houseStats: function () {
      var sum = cvol.entries.reduce(function (s, e) { return s + (isFinite(e.n) ? e.n : 0); }, 0);
      return { lp: house.lp, vol24h: sum, loaded: house.lp != null };
    },
    coinStats: function (sym) {
      var m = state.bySym[sym]; if (!m) return null;
      /* the Pro view reads open interest only for its own market: read the coin the simple view shows, at most every 15 s */
      var at = house.oiAt || (house.oiAt = {}), ex = read.exchange, now = Date.now();
      if (!DEMO && ex && m.instrumentId != null && !(at[m.symbol] > now - 15000)) {
        at[m.symbol] = now;
        ex.openInterest(m.instrumentId).then(function (r) {
          house.oi[m.symbol] = { long: usd6ToNum(r[0]), short: usd6ToNum(r[1]) };
          if (hbots.n) loadHouseBotOi();
        }).catch(function () { at[m.symbol] = now - 10000; });   /* a failed read tries again about 5 s later */
      }
      var oi = publicOi(m.symbol, m.instrumentId);
      var c = state.ctx[m.coin];
      return { oiUp: oi ? oi.long : NaN, oiDown: oi ? oi.short : NaN, vol24h: c ? c.vol24h : NaN };
    },
    /* a would-be trade in the ticket's own numbers: the price it opens near, what a 1% move pays, the move that ends it */
    trade: function (o) {
      return smWith(o, function (m) {
        termsFresh(m);   /* (amt2) this coin's terms, at most 10 s old while a sheet prices it */
        sheetPriced(m);  /* (amt3) and its oracle print, as fresh as a card's */
        var px = openPriceFor(m), isLong = form.side === 'long', mp = m.inst ? house.maxPos[m.inst.id] : null;
        var win = px > 0 && form.margin > 0 ? estimateClose(pretendPos(px, form.margin), m.inst, px * (isLong ? 1.01 : 0.99), true) : null;
        var block = marketBlock();
        /* win1: what a 1% move pays against the amount typed (the payout at +1% less everything that went in);
           min: the smallest amount whose stake reaches the minimum at this leverage */
        return { px: px, sz: m.szDecimals, win1: win && !win.flat ? win.net : NaN, endPct: bustMovePct(form.lev), endPx: bustPriceNum(px, isLong, form.lev),
          min: minKnown() ? amountOfStake(minMargin(), ticketShare()) : null, room: mp ? (isLong ? mp.long : mp.short) : null, block: block, problem: block ? '' : smProblem(),
          oneTap: ONE_TAP_FORCED && (DEMO || read.router) ? oneTapWhy(form.margin > 0 ? numToUsd6(form.margin) : null) : '' };
      });
    },
    open: smOpen,
    /* a take profit / stop loss for that trade, by the ticket's own rule: '' when fine, else the sentence that refuses it */
    autoCheck: function (o, tp, sl) { return smWith(o, function (m) { sheetPriced(m); var px = levelNow(m), isLong = form.side === 'long'; return px > 0 ? tpslProblem(isLong, form.lev, px, px, tp, sl, m.szDecimals, trigMarket(m.instrumentId), tpslPseudo(m, isLong, form.lev, px).bust) : TPSL_WAIT; }); },
    /* the take profit / stop loss boxes of Simple's sheets (the owner, 2026-11-19: "just make it visible on screen", "on the
       card"), by the code of Pro's own boxes. autoRead: one typed price, read for an open trade (its id) or for one not
       opened yet ({ sym, isLong, margin, lev }): tpslRead's { n, fin | why | away, pnl, pct, margin }, plus now, the
       price it was read at (the oracle print; { n, wait } and no now while that is still being read). autoSet: both levels of an open trade, the checks once more at the press ('' or the refusal);
       neither level removes them. autoKept: false while this browser is not saving site data (the rule then lives
       only as long as this tab). */
    autoRead: function (who, kind, raw) {
      if (who && typeof who === 'object') {
        return smWith(who, function (m) {
          sheetPriced(m); var now = levelNow(m);
          if (!(now > 0)) return { n: tpslNum(raw), wait: true };   /* (amt4) the print is still being read: nothing against the mid */
          var r = tpslRead(tpslPseudo(m, form.side === 'long', form.lev, now), kind, raw, now); r.now = now; return r;
        });
      }
      var p = posById(who); if (!p) return null;
      var now = tpslNow(p);
      if (!(now > 0)) return { n: tpslNum(raw), wait: true };   /* (amt5) as before an open: the chain's price or a wait, never the chart */
      var r = tpslRead(p, kind, raw, now); r.now = now;
      /* a level on chain reads the chain's own figures at that price (previewCloseAt) once they are in: what comes back
         there less what went in */
      if (r.n != null && r.fin == null && !r.why && tpslChain(p)) {
        var pv = trigPreview(p.id, r.n);
        if (pv) { r.pnl = pv.payout - posIn(p); r.pct = posIn(p) > 0 ? r.pnl / posIn(p) : 0; r.back = pv.payout; r.chain = true; }
      }
      return r;
    },
    /* (amt2) An open trade read at any price, for Simple's chart under the finger or the cursor: what a close there gives
       back (worth) and that against what went in (pnl), by the page's own close maths (hoverAt, Pro's chart hover: the
       trade's stamped terms, the impact curve, the borrow so far, the charge on its size; nothing back at or past its
       closing price). Simple worked this itself as size x move, so every win read too high. */
    worthAt: function (pid, px) {
      var p = posById(pid); if (!p || !(px > 0)) return null;
      var r = hoverAt(p, px);
      return { pnl: r.pnl, worth: r.worth, busted: r.busted };
    },
    /* v6: where a trade's take profit and stop loss live. autoChain(sym): a new open on that coin takes them on chain
       (they close it even when Confetti is closed); autoLev(pid | { lev }): the leverage the high-boost sentence reads. */
    autoChain: function (sym) { var m = state.bySym[sym]; return !!(m && m.instrumentId != null && trigMarket(m.instrumentId)); },
    autoSet: function (pid, tp, sl) {
      pid = String(pid);
      var ap = posById(pid);
      if (ap && trigWhere(ap) === 'paused') return TRIG_PAUSED_SAY;      /* v6: the book refuses a change while the market is off Pyth */
      if (tp == null && sl == null) { tpslClear(pid); return ''; }
      return tpslSet(pid, tp, sl);
    },
    autoKept: function () { return !tpsl.unsaved; },
    autoSeen: function (pid) { tpslSeen(String(pid)); },   /* (amt5) the card's note of a level not set at the fill has been answered */
    ticket: function () { return { phase: tk.phase, msg: tk.msg || '', sym: tk.sym, posId: tk.posId }; },
    ticketDone: function () { if (tk.phase && tk.phase !== 'wallet' && tk.phase !== 'req') tkReset(); },
    positions: function () {
      return phList().map(function (it) {
        var p = it.p, m = positionMarket(p), e = it.est || {}, rule = tpsl.rules[it.pid], le = null;
        try { le = liveEstimate(p, e); } catch (x) { le = null; }
        /* margin: what went in (v5: the stake and what opening it took); stake and closeCost (v5 only): the stake
           itself and what closing takes out of the payout; back: what a close at the entry puts back */
        var cc = feeOnStake(p.margin, posFeeX10(p));
        /* a close only the wallet can still finish fills at the worse of two prices: the card's result is worked out
           at that price while it waits (the float estimate; the card marks it with its ≈) */
        var st = closeStatus(it.pid, p), wpx = st && st.own ? ownClosePx(p) : null, we = null;
        if (wpx) { try { we = estimateClose(p, state.byInstId[p.instrumentId], wpx, house.queueLen == null ? true : house.queueHead === house.queueLen); } catch (x) { we = null; } }
        if (we) le = { pnl: we.net, payout: we.payout };
        /* v5, money added to the trade: margin counts it (posIn), added is that money alone, and boost is the boost
           the trade now runs at (the opening one, lev, until money is added). part: the share a close on its way
           is for (bps under 10000; 0: all of it, or none); can: Close part and Add to this trade exist for it */
        return { id: it.pid, sym: m ? m.symbol : '', sz: m ? m.szDecimals : null, isLong: p.isLong, lev: p.leverage, margin: posIn(p), entry: p.entry, px: it.px,
          stake: isV5() ? p.margin : null, closeCost: isV5() ? cc : null, back: Math.max(0, posColl(p) - cc),
          added: p.added > 0 ? p.added : 0, boost: Number(levShown(p)), part: pmPartOf(it.pid), can: pmCan(),
          endPx: it.room.liq, away: it.room.away, near: it.room.cls, share: it.share, pnl: netPnl(le || e, posIn(p)), payout: le ? le.payout : e.payout, delayed: !!e.delayed,
          status: st, est: !!le || !!fastOf(p.instrumentId),      /* est: pnl / payout are the live estimate (the card's ≈), not the figure at the last print */
          /* the take profit / stop loss rule: its levels, tpslStatus ('' while it waits; closing, held: why, ...) and, while
             its close is on the way, which level fired */
          auto: trigAutoOf(p, rule, it.pid) || (rule ? { tp: rule.tp, sl: rule.sl, status: tpslStatus(it.pid), fired: rule.claimed ? rule.fired || '' : '', kept: !!rule.kept } : null),
          /* (amt5) a level typed on the order sheet that the fill left unable to fire, or firing at once: not set, said once
             (a browser rule's; a level on chain is the chain's from the fill on, and the card says what the chain holds) */
          missed: tpsl.missed[it.pid] ? { tp: tpsl.missed[it.pid].tp, sl: tpsl.missed[it.pid].sl } : null };
      });
    },
    openings: function () {
      return phOpenings().map(function (o) {
        var r = o.r, st = o.kind === 'end' ? { say: o.say, tone: 'bad' } : openingStatus(r, o.kind);
        return { key: o.key, kind: o.kind, sym: reqSym(r), isLong: !!r.isLong, lev: r.leverage, margin: reqIn(r), say: st.say || '', tone: st.tone || '', btn: st.btn || '', note: st.note || '', share: st.share || 0 };
      });
    },
    openingAct: function (key) { var r = pend.opens[String(key).slice(1)]; if (r) openReqAction(r); },
    result: function (pid) {
      pid = String(pid);
      var r = sm.results[pid] || ui.phResult[pid] || null;
      /* v6: a trade that ended while the page was closed: what it was (Simple never showed it in this visit) */
      if (r && trig.awayWas[pid] && !r.was) { r.was = trig.awayWas[pid]; r.away = true; }
      /* (amt2) a close's result as money: less the borrow the exchange took from the payout (what came back, plus
         anything still owed, less what went in; closeNet has the charge on its size both ways) */
      if (r && !r.liq && r.borrow > 0) { var n = {}; Object.keys(r).forEach(function (k) { n[k] = r[k]; }); n.pnl = r.pnl - r.borrow; return n; }
      return r;
    },
    /* v6: a trade of the last visit that is gone with nothing read about how it ended ({ sym, isLong, lev, margin }), or null */
    gone: function (pid) { return sm.gone[String(pid)] || null; },
    /* v6: the card sheet's quick picks for an open trade: take profit at +25% / +50% / +100% of what went in, stop loss
       at -25% / -50% of it and just before the price where the trade closes itself. px: the price at which this page's
       own close figure (the readout's) gives that result, null when there is none on the right side of the price now */
    autoPicks: function (pid) { var p = posById(pid); return p ? trigPicks(p) : null; },
    /* v5: what this account still has on the v4 Exchange (its balance, what is in its trades and held by its
       orders there), or null when nothing: Simple's way to v4.html */
    old4: function () {
      var l = oldLinks.v4;
      if (!(l && l.show && wallet.account && wallet.account === l.account)) return null;
      /* rules: the take profit / stop loss rules this browser holds for the account's v4 trades (the key the v4 trade
         page kept them under): from the launch on they act on v4.html only, and Simple's note says so */
      var n4 = 0;
      try { var d4 = JSON.parse(lsGet('confetti.trade.tpsl.' + wallet.account.toLowerCase()) || 'null'); n4 = d4 && d4.rules ? Object.keys(d4.rules).length : 0; } catch (e) { n4 = 0; }
      return { total: l.total, href: 'v4.html', rules: isV6() ? n4 : 0 };
    },
    /* v5: the seconds an order on that coin takes to fill, by the chain's own setting for that market (fillSecs: a
       fast market's delay and a block, else the old rule's wait and a block). null on a v4 config and until the
       setting has been read, so Simple never says a time from a guess */
    fill: function (sym) {
      var m = state.bySym[sym], id = m ? m.instrumentId : null;
      if (!isV5() || id == null || !fastKnown(id) || (!fastOf(id) && !house.delaysAt)) return null;
      return fillSecs(id);
    },
    close: function (pid) { var p = posById(pid); return p ? submitClose(p) : Promise.resolve(false); },
    /* Close part and Add to this trade (v5; the owner, 2026-11-04: "can we make it so that you can close a % of your
       position", 2026-11-19: "we are still doing top ups and partial closes right"). The cream card's two keys open
       the page's own dialog (pmOpen) with Simple's sheet as its face: everything is the dialog's (its presets, the
       typed share and amount, its checks, its previews, and pmGo, which sends through submitClose and
       submitAddMargin). open(pid, 'close' | 'add'): true once it is up. view: pmView, the open tab as data. pick /
       type / amount: the dialog's inputs. go: its button, resolving true once the close is filed or the money
       is in. shut: Simple's sheet closed. last(pid): what the dialog last did to that trade (a part closed, money
       added), for a minute, for the card's line. The event 'part' fires whenever the dialog would redraw. */
    part: {
      open: function (pid, tab) { return pmOpen(pid, tab, 'sm'); },
      shut: function () { if (pm.face) { pm.face = null; pmStop(); } },
      view: pmView,
      pick: function (bps) { if (pm.face) pmPick(Number(bps)); },
      type: function (raw) { var i = $('pmPct'); if (!pm.face || !i) return; i.value = String(raw == null ? '' : raw).replace(/\.$/, ''); pmTyped(); },
      amount: function (raw) { var i = $('pmAmt'); if (!pm.face || !i) return; i.value = String(raw == null ? '' : raw).replace(/\.$/, ''); pmAmtTyped(); },
      go: function () { return pm.face ? Promise.resolve(pmGo()).then(function (ok) { return !!ok; }) : Promise.resolve(false); },
      last: function (pid) { var l = pm.last[String(pid)]; return l && Date.now() - l.at < 60000 ? l : null; }
    },
    closeAct: function (pid) { var p = posById(pid); if (p) closeReqAction(p); },
    share: function (pid) { var r = ui.recent.filter(function (x) { return x.key === 'c' + pid; })[0], b = r && (r.buttons || []).filter(function (x) { return x.label === 'Share'; })[0]; if (b) b.fn(); return !!b; },
    session: function () { return { live: sessionLive(), feeWei: sess.feeWei, router: !!read.router }; },
    /* "Powered by Blockfront" on Simple's trade cards (the owner, 2026-11-19: "powered by block front", "on the position cards
       actually"). True only while this page really reads the chain through Blockfront: it is switched on (blockfrontOn: never in
       the demo, never with config.json "blockfront": false) AND the read provider's last good answer came from it (rpcState.read,
       the one marked hook in makeProvider: once Blockfront fails over to another endpoint this is false until it answers again). */
    poweredByBlockfront: function () { return blockfrontOn() && rpcState.read === BLOCKFRONT_RPC; },
    fees: feeCfg,
    /* Simple's Connect leaves the wallet on the chain its ETH is on: the one switch that Connect would ask is skipped, and
       only that one (the mark dies with the press, or after a few seconds) */
    connect: function () { sm.noSwitch = Date.now(); return Promise.resolve(connect()).then(function () { sm.noSwitch = 0; }, function () { sm.noSwitch = 0; }); },
    switchWallet: switchWallet, disconnect: disconnect, walletApps: openWalletApps,
    /* onto HyperEVM: the wallet itself is asked where it is (what the page remembers can be stale), moved if it is elsewhere,
       asked again, and only then is the page's own record written */
    toHyperEvm: function () {
      var eth = wallet.eth || getInjected();
      if (!eth) return Promise.reject(new Error('No wallet.'));
      function read() { return eth.request({ method: 'eth_chainId', params: [] }).then(function (hex) { var was = wallet.chainId; wallet.chainId = parseInt(hex, 16); return was !== wallet.chainId || !wallet.signer; }); }
      return read().then(function (moved) {
        if (wallet.chainId === CHAIN_ID) return moved ? onChainChanged() : null;
        sm.noSwitch = 0;
        return sm.switchChain().then(read).then(function () {
          if (wallet.chainId !== CHAIN_ID) throw new Error('The wallet stayed on another network.');
          return onChainChanged();
        });
      });
    },
    /* Simple moved the wallet itself (to the chain the ETH is on): the page's record of the network is written from the wallet */
    chainSeen: function () {
      var eth = wallet.eth || getInjected();
      if (!eth) return Promise.resolve();
      return eth.request({ method: 'eth_chainId', params: [] }).then(function (hex) { wallet.chainId = parseInt(hex, 16); return onChainChanged(); });
    },
    /* the page's own off switch for anything that sends ('' when sending is allowed) */
    gate: function () { return (cfg ? '' : 'config.json is not in yet.') || house.gate || (house.usdcBad ? 'This exchange does not settle in native USDC.' : '') || (hasExchange() ? '' : 'Trading is off on this copy of the site.'); },
    refresh: function () { return Promise.all([refreshAccount(), refreshWalletUsdc(), refreshSession()]); },
    /* the Pro deposit, answering whether it went in: true once submitDeposit said "Deposited" (its own word, seen by the toast
       wrap below), false when it ended any other way */
    deposit: function (amount) { var mark = sm.dep = { ok: false }; return Promise.resolve(submitDeposit(amount)).then(function () { if (sm.dep === mark) sm.dep = null; return mark.ok; }); },
    swapHype: smSwapHype,
    applePayOn: onrampOn,
    /* the Pro checkout, answering whether MoonPay's tab got its address (onrampGo marks sm.orOpened: the one hook there) */
    applePay: function (amount) {
      onramp.amount = amount; sm.orOpened = false; onrampGo();
      return new Promise(function (done) { (function wait(n) { if (!onramp.busy || !n) done(!!sm.orOpened); else setTimeout(function () { wait(n - 1); }, 200); })(150); });
    },
    pro: function (what, arg) {
      if (what === 'withdraw') openWithdraw();
      else if (what === 'addUsdc') sm.openDeposit();
      else if (what === 'position') openPhPosSheet(arg, null);
      else if (what === 'account') { renderAccount(); openPhSheet('phAcctSheet', null); }
      else if (what === 'menu') openPhSheet('phMenuSheet', null);
      else if (what === 'coin') { sm.look = false; if (arg) selectMarket(arg); }
      /* Simple's Candles: a look at this coin's chart in Pro. The First steps guide does not cover it for a visitor (sm.look) */
      else if (what === 'candles') { sm.look = true; selectMarket(arg); }
    },
    redraw: function () {
      try {
        rethemeChart(); placeChartBar(); loadCandles(true);
        /* the chart was laid out while Pro was out of sight (no width: its time scale sat clamped off the latest bars). Once it
           has its width, back to the latest candles exactly where a fresh load puts them (no animation: an animated scroll
           stops a hair short) */
        (function back(n) {
          requestAnimationFrame(function () {
            try { var ts = chart.api.timeScale(); if (ts.width() > 0) ts.scrollToPosition(chartOptions().timeScale.rightOffset, false); else if (n) back(n - 1); } catch (e) { /* no chart on this page */ }
          });
        })(60);
      } catch (e) { /* the chart never blocks the switch */ }
      /* Pro's own title and address again (Simple wrote its screen's): the ticket's market */
      if (state.market) { try { history.replaceState(history.state, '', '#' + encodeURIComponent(state.market.symbol)); } catch (e) { /* the address stays */ } }
      renderMarketHeader(); renderAccount(); renderPositions(); renderAction();
    },
    /* [simple] chart: readers and helpers for Simple's Lightweight Charts (candlestick chart in simple.js).
       Simple creates its own LW chart instance; these expose Pro's theme, timeframes, candle loading, and
       live price subscription so Simple reuses Pro's data plumbing without duplicating it. */
    chart: {
      TF_MS: TF_MS,
      CANDLE_COUNT: CANDLE_COUNT,
      TZ_OFFSET_S: TZ_OFFSET_S,
      theme: function () {
        /* Simple sets its CSS variables on body (html[data-mode="simple"] body); read from there */
        var el = smShown() ? document.body : document.documentElement;
        function cv(name, fallback) { var v = getComputedStyle(el).getPropertyValue(name); return (v ? v.trim() : '') || fallback; }
        return {
          raised: cv('--raised', '#faf6ed'), ink: cv('--ink', '#2a2520'), muted: cv('--ink-muted', '#5f564b'),
          faint: cv('--ink-faint', '#7a7060'), rule: cv('--rule', '#d4cbba'), ruleStrong: cv('--rule-strong', '#b8ad92'),
          pos: cv('--pos', '#2e7a4c'), neg: cv('--neg', '#b44855'), accent: cv('--accent', '#8b2020'),
          page: cv('--page', '#f4ecd8'), mono: cv('--font-mono', 'monospace')
        };
      },
      precision: function (px, sz) { return pricePrecision(px, sz); },
      barTime: function (t) { return Math.floor(t / 1000) - TZ_OFFSET_S; },
      /* load candles for a coin/tf; returns a promise of { candles, precision } or rejects on failure */
      loadCandles: function (coin, tf) {
        var ms = TF_MS[tf];
        if (!ms) return Promise.reject(new Error('unknown tf'));
        var end = Date.now(), start = end - (CANDLE_COUNT + 2) * ms;
        return postInfo({ type: 'candleSnapshot', req: { coin: coin, interval: tf, startTime: start, endTime: end } }, 8000)
          .then(function (rows) {
            if (!Array.isArray(rows)) throw new Error('bad candles');
            var parsed = rows.map(function (r) {
              return { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) || 0 };
            }).filter(function (k) {
              return isFinite(k.t) && isFinite(k.o) && isFinite(k.h) && isFinite(k.l) && isFinite(k.c) && k.c > 0;
            }).slice(-CANDLE_COUNT);
            if (parsed.length === 0) throw new Error('no candles');
            /* continuous candles: each bar opens at the previous bar's close */
            for (var i = 1; i < parsed.length; i++) {
              var k = parsed[i], o = parsed[i - 1].c;
              k.o = o;
              if (o > k.h) k.h = o;
              if (o < k.l) k.l = o;
            }
            var lastPx = parsed[parsed.length - 1].c;
            var m = state.bySym && Object.values(state.bySym).filter(function (x) { return x.coin === coin; })[0];
            var precision = pricePrecision(lastPx, m ? m.szDecimals : 2);
            return { candles: parsed, precision: precision };
          });
      }
    },
    /* [simple] limit orders: Simple's 'At a price' option */
    limits: {
      orders: function () {
        return lim.orders.map(function (o) {
          var px = state.mids[o.coin];
          return { id: o.id, sym: o.sym, isLong: o.isLong, margin: o.amount > 0 ? o.amount : limIn(o), lev: o.lev, px: o.limitPx, sz: o.szDec, now: px > 0 ? px : null, at: o.at, expires: o.expires, hold: o.hold || null };
        });
      },
      place: function (sym, isLong, margin, lev, px) {
        var m = markets().filter(function (x) { return x.symbol === sym; })[0];
        if (!m) return { ok: false, err: 'Unknown coin.' };
        var now = marketPrice(m);
        if (!(px > 0)) return { ok: false, err: 'Type a limit price.' };
        if (isFinite(now) && now > 0 && limitCrossed({ isLong: isLong, limitPx: px }, now)) {
          return { ok: false, err: (isLong ? 'A buy limit at or above the price' : 'A sell limit at or below the price') + ' would fill right now: use Now, or set the price ' + (isLong ? 'lower' : 'higher') + '.' };
        }
        var dup = lim.orders.some(function (x) { return x.sym === sym && x.isLong === isLong && x.limitPx === px && x.margin === margin && x.lev === lev; });
        if (dup) return { ok: false, err: 'That limit is already placed.' };
        /* amount: what Simple's box said, the whole of what the order takes (v5); the stake is worked from it when it fires */
        var o = { id: 'L' + Date.now().toString(36), sym: sym, coin: m.coin, isLong: isLong, margin: margin, amount: isV5() ? margin : undefined, lev: lev, maxed: false, limitPx: px, szDec: m.szDecimals, at: Date.now(), expires: Date.now() + LIM_EXPIRY_MS };
        lim.orders.push(o); limSave();
        return { ok: true, id: o.id };
      },
      cancel: function (id) { cancelLimit(id); return true; },
      marketPrice: function (sym) {
        var m = markets().filter(function (x) { return x.symbol === sym; })[0];
        return m ? marketPrice(m) : null;
      }
    }
  };
  (function () {
    function also(ev, fn) { return function () { var r = fn.apply(this, arguments); smEmit(ev, arguments[0]); return r; }; }
    renderAccount = also('account', renderAccount);
    renderPositions = also('positions', renderPositions);
    updateCards = also('cards', updateCards);
    renderWallet = also('wallet', renderWallet);
    renderAction = also('action', renderAction);
    renderTicketProgress = also('ticket', renderTicketProgress);
    onPrices = also('prices', onPrices);
    renderMarketMenuPrices = also('stats', renderMarketMenuPrices);
    /* while Simple is on screen the tab title and the address follow Simple's screen (simple.js writes them): the Pro
       ticket's market, which keeps running out of sight, writes neither. redraw() gives them back to Pro. */
    var _header = renderMarketHeader;
    renderMarketHeader = function () { var t = document.title, r = _header.apply(this, arguments); if (smShown() && document.title !== t) document.title = t; return r; };
    var _select = selectMarket;
    selectMarket = function () {
      var u = location.href, st = history.state, r = _select.apply(this, arguments);
      if (smShown() && (location.href !== u || history.state !== st)) { try { history.replaceState(st, '', u); } catch (e) { /* the address stays */ } }      /* Simple's depth mark too */
      return r;
    };
    /* a close's figures, kept the moment it is reported: the phone rows drop ui.phResult as soon as the position is gone */
    var _recent = addRecent;
    addRecent = function (r) { if (r && r.pid != null && ui.phResult[String(r.pid)]) sm.results[String(r.pid)] = ui.phResult[String(r.pid)]; var out = _recent.apply(this, arguments); smEmit('result', r); return out; };
    var _toast = toast;
    /* while Simple is on screen it says things in its own place and words (sm.hooks.toast answers true); a null return is
       what a missing #toasts host already gives every caller */
    toast = function (text, kind) {
      if (sm.dep && kind === 'ok' && /^Deposited /.test(String(text))) sm.dep.ok = true;      /* what api.deposit answers with */
      if (smShown() && sm.hooks.toast && sm.hooks.toast(String(text), kind || '')) return null;
      return _toast.apply(this, arguments);
    };
    /* Add USDC's phone entry points open Simple's Add money while Simple is this visitor's (sm.hooks.addMoney says) */
    sm.openDeposit = openDeposit;
    openDeposit = function () {
      try { if (sm.hooks && sm.hooks.addMoney && sm.hooks.addMoney()) return; } catch (e) { /* Simple's sheet did not open: Pro's own does */ }
      return sm.openDeposit.apply(this, arguments);
    };
    /* no First steps guide and no tour over Simple, and Simple's Connect leaves the wallet on the chain its ETH is on */
    var _step = setupStepNow; setupStepNow = function () { return smShown() || (sm.look && !wallet.account) ? null : _step(); };
    var _tour = maybeStartTour; maybeStartTour = function () { if (!smShown()) return _tour.apply(this, arguments); };
    sm.switchChain = switchChain;
    switchChain = function () {
      var skip = sm.noSwitch && smShown() && Date.now() - sm.noSwitch < 8000;
      sm.noSwitch = 0;
      return skip ? Promise.resolve() : sm.switchChain.apply(this, arguments);
    };
    /* While Simple is on screen, every send the WALLET signs (the one-tap setup, an open or a close without one-tap, a deposit,
       a withdrawal) first asks the wallet which network it is on, and stops unless it is HyperEVM: Simple's open and close do
       not pass the ticket's own network check, and what the page remembers of the network can be stale. A session key's send
       (from: the key) never reaches the wallet and is not asked.
       And the wait on the wallet always ends: a wallet that has not answered a send after a minute (or that first question
       after a quarter of one) fails it with a sentence, the way a "no" in the wallet does, so the ticket, the close and the
       deposit come back to a button that works. It carries the wallet's own "no" code, so the Pro code stops there as it
       does for a no (forced one-tap would otherwise go on and ask the wallet to sign the trade itself: a second request
       to a wallet that is not answering); describeError gives its sentence instead of "You cancelled". A "yes" given
       later still sends what the person confirmed in the wallet; the page then learns of it from the chain like any other
       change. */
    function smAnswer(p, ms, why) {
      return new Promise(function (yes, no) {
        var t = setTimeout(function () { var e = new Error(why); e.code = 'ACTION_REJECTED'; e.smQuiet = true; no(e); }, ms);
        Promise.resolve(p).then(function (v) { clearTimeout(t); yes(v); }, function (e) { clearTimeout(t); no(e); });
      });
    }
    var _describe = describeError;
    describeError = function (err) { return err && err.smQuiet ? err.message : _describe.apply(this, arguments); };
    var _sendTx = sendTx;
    sendTx = function (desc, method, args, quiet, from) {
      var self = this, all = Array.prototype.slice.call(arguments), eth = wallet.eth;
      if (DEMO || !smShown() || !eth || (from && sess.key && String(from).toLowerCase() === sess.key.address.toLowerCase())) return _sendTx.apply(self, all);
      /* the method as sendTx knows it (its checks before the send read its other parts), with the wallet's answer timed */
      if (typeof method === 'function' && typeof Proxy === 'function') {
        all[1] = new Proxy(method, { apply: function (fn, me, a) { return smAnswer(fn.apply(me, a), 60000, 'Your wallet did not answer. If it is still asking, say no there, then press again.'); } });
      }
      return smAnswer(eth.request({ method: 'eth_chainId', params: [] }), 15000, 'Your wallet did not answer. Press again.').then(function (hex) {
        wallet.chainId = parseInt(hex, 16);
        if (wallet.chainId !== CHAIN_ID) throw new Error('Switch the wallet to HyperEVM (999) first.');
        return _sendTx.apply(self, all);
      });
    };
    /* a take profit / stop loss typed in Simple's sheet rides with that one open (parked, then adopted, as the ticket's) */
    var _want = tpslTicketWant; tpslTicketWant = function () { return sm.want || _want.apply(this, arguments); };
    var _start = start;
    start = function () {
      _start();
      /* simple.js is loaded async and never holds this file up: whichever of the two arrives second does the hand-over. If the
         page finishes loading and simple.js has not come (or did not start), this page view is Pro and stays Pro. */
      var took = false;
      function off(name) { try { delete window[name]; } catch (e) { window[name] = undefined; } }
      function toPro() {
        document.documentElement.removeAttribute('data-mode');
        var bar = document.querySelector('meta[name="theme-color"]'); if (bar) bar.setAttribute('content', cssVar('--page', '#0d1229'));
      }
      function hand(init) {
        if (took) return;
        took = true; off('ConfettiSimpleTake');
        if (typeof init === 'function') { try { sm.hooks = init(smApi) || null; } catch (e) { console.error('simple.js did not start', e); } }
        if (!sm.hooks) toPro();
      }
      var init = window.ConfettiSimpleInit;
      off('ConfettiSimpleInit');
      if (typeof init === 'function') { hand(init); return; }
      window.ConfettiSimpleTake = hand;
      var late = function () { setTimeout(function () { hand(null); }, 0); };
      if (document.readyState === 'complete') late(); else window.addEventListener('load', late);
    };
  })();
  /* ==== [simple] END ================================================================================================= */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
