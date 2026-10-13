/* ==========================================================================
   confetti_  —  trade.js
   Drives trade.html: Hyperliquid price feeds (allMids every 2 s, candles,
   24h stats), the lightweight-charts candlestick chart, contract reads from
   a plain RPC, direct ethers v6 wallet transactions (approve, deposit,
   withdraw, open, close), the positions / history / status tabs and the
   wallet plumbing (chain switch, account changes, revert reasons).
   No build step. Config comes from config.json (falls back to
   config.example.json). Contract ABI fragments are written by hand from
   contracts/src/interfaces/IExchange.sol and IPriceOracle.sol.
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
  var THEME_KEY = 'confetti.theme';
  var LS = { market: 'confetti.trade.market', side: 'confetti.trade.side', lev: 'confetti.trade.lev.', tab: 'confetti.trade.tab' };
  var TZ_OFFSET_S = new Date().getTimezoneOffset() * 60;
  var ZERO = '0x0000000000000000000000000000000000000000';

  /* Fixed protocol constants (IExchange header). Config may restate them but cannot change the contract. */
  var MIN_MARGIN = 10;
  var BUST_BUFFER_PCT = 95;
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
    /* trading */
    'function open(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage) returns (uint256 positionId)',
    'function close(uint256 positionId) returns (uint256 payoutUsdc, uint256 queuedUsdc)',
    'function liquidate(uint256 positionId) returns (uint256 bountyUsdc)',
    'function harvest(uint256 maxEntries) returns (uint256 entriesPaid, uint256 paidUsdc)',
    'function pushFees() returns (uint256 toStakersUsdc, uint256 toRecipientUsdc)',
    /* views */
    'function balanceOf(address user) view returns (uint256 availableUsdc)',
    'function marginInUse(address user) view returns (uint256 usdc)',
    'function positions(uint256 positionId) view returns (tuple(address owner, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 entryPx18, uint64 openedAt, uint16 deadbandBps, uint16 payoutCapX, uint16 feeBps))',
    'function positionIdsOf(address user) view returns (uint256[])',
    'function bustPrice(uint256 positionId) view returns (uint256 px18)',
    'function previewClose(uint256 positionId) view returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc)',
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
    'function feeBps() view returns (uint16)',
    'function usdc() view returns (address)',
    'function oracle() view returns (address)',
    'function confetti() view returns (address)',
    'function tokenomics() view returns (address)',
    'function staking() view returns (address)',
    'function owner() view returns (address)',
    'function pauseGuardian() view returns (address)',
    'function marketKeeper() view returns (address)',
    'function feeRecipient() view returns (address)',
    /* events */
    'event Deposited(address indexed user, address indexed payer, uint256 amountUsdc)',
    'event Withdrawn(address indexed user, uint256 amountUsdc)',
    'event PositionOpened(uint256 indexed positionId, address indexed owner, uint32 indexed instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 entryPx18)',
    'event PositionClosed(uint256 indexed positionId, address indexed owner, uint256 exitPx18, int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc, uint256 queuedUsdc, uint256 confettiMinted)',
    'event PositionLiquidated(uint256 indexed positionId, address indexed owner, address indexed liquidator, uint256 exitPx18, uint128 marginUsdc, uint256 bountyUsdc, uint256 feeUsdc, uint256 confettiMinted)',
    'event QueueAppended(uint256 indexed index, address indexed recipient, uint256 amountUsdc)',
    'event QueuePaid(uint256 indexed index, address indexed recipient, uint256 paidUsdc, uint256 remainingUsdc)',
    'event FeesPushed(uint256 toStakersUsdc, uint256 toRecipientUsdc)',
    'event StakerOverflowSwept(uint256 amountUsdc)',
    'event InstrumentAdded(uint32 indexed instrumentId, uint32 hlAssetIndex, uint8 szDecimals, uint8 tier, uint32 maxLeverage)',
    'event OiCapsSet(uint32 indexed instrumentId, uint128 longOiCapUsd, uint128 shortOiCapUsd)',
    'event PositionCapsSet(uint32 indexed instrumentId, uint128 maxNotionalUsd, uint16 payoutCapX)',
    'event PayoutCapped(uint256 indexed positionId, uint256 cappedGainUsdc, uint256 forfeitedUsdc)',
    'event LpBreakerTripped(uint256 netOutflowUsdc, uint256 thresholdUsdc, uint256 windowStartLpUsdc)',
    'event BreakerCleared(address indexed by)',
    'event BreakerBpsSet(uint16 breakerBps)',
    'event MarketOpensPausedSet(uint32 indexed instrumentId, bool paused)',
    'event GlobalOpensPausedSet(bool paused)',
    'event InstrumentRetired(uint32 indexed instrumentId, uint256 frozenPx18)',
    /* errors: Exchange */
    'error Unauthorized()',
    'error ZeroAddress()',
    'error ZeroAmount()',
    'error UnknownInstrument(uint32 instrumentId)',
    'error MarketRetired(uint32 instrumentId)',
    'error OpensPausedGlobally()',
    'error OpensPausedForMarket(uint32 instrumentId)',
    'error MarginBelowMinimum(uint256 marginUsdc, uint256 minimumUsdc)',
    'error LeverageOutOfRange(uint32 leverage, uint32 maxLeverage)',
    'error OiCapExceeded(uint32 instrumentId, bool isLong, uint256 headroomUsd)',
    'error PositionTooLarge(uint32 instrumentId, uint256 notionalUsd, uint256 maxNotionalUsd)',
    'error OpensPausedByBreaker()',
    'error BreakerNotTripped()',
    'error FeedAlive(uint32 instrumentId)',
    'error InsufficientBalance(uint256 availableUsdc, uint256 requestedUsdc)',
    'error UnknownPosition(uint256 positionId)',
    'error NotPositionOwner(uint256 positionId, address caller)',
    'error NotLiquidatable(uint256 positionId, uint256 px18, uint256 bustPx18)',
    'error InvalidTier(uint8 tier)',
    'error ParamOutOfBounds(string name, uint256 value)',
    'error QueueEmpty()',
    'error QueueNotEmpty()',
    'error NothingToPush()',
    /* errors: PriceOracle, bubble up through open/close */
    'error FeedUnavailable(uint32 instrumentId)',
    'error ZeroPrice(uint32 instrumentId)',
    'error ClampOutOfBounds(uint16 clampBps)',
    /* errors: OpenZeppelin, bubble up through deposit/withdraw */
    'error OwnableUnauthorizedAccount(address account)',
    'error ReentrancyGuardReentrantCall()',
    'error SafeERC20FailedOperation(address token)',
    'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
    'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
    'error ERC20InvalidReceiver(address receiver)',
    'error ERC20InvalidSender(address sender)'
  ];

  var ERC20_ABI = [
    'function approve(address spender, uint256 value) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
    'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)'
  ];

  var ORACLE_ABI = [
    'function price(uint32 instrumentId) view returns (uint256 px18)',
    'function rawMid(uint32 instrumentId) view returns (uint256)',
    'function oraclePrice(uint32 instrumentId) view returns (uint256)',
    'function markPrice(uint32 instrumentId) view returns (uint256)',
    'error FeedUnavailable(uint32 instrumentId)',
    'error ZeroPrice(uint32 instrumentId)',
    'error UnknownInstrument(uint32 instrumentId)'
  ];

  var exIface = null; /* ethers.Interface for EXCHANGE_ABI */

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

  var acct = { loaded: false, available: 0, marginInUse: 0, positions: [], walletUsdc: 0, allowance: 0 };

  var house = {
    addrs: {}, lp: null, feePool: null, queued: null, queueLen: null, queueHead: null,
    globalPaused: false, breakerTripped: false, instCount: null, block: null, blockAt: 0, oi: {}, oraclePx: null,
    feeRate: null
  };

  var read = { provider: null, logProvider: null, exchange: null };

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
          midPx: Number(c.midPx)
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
    var oi = house.oi[m.symbol];
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
    var groups = [['A', 'Tier A · x1000'], ['B', 'Tier B · x250'], ['C', 'Tier C · x50']];
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

  /* Bust price, float version of ImpactLib.bustPrice: entry * (lev*100 -/+ 95) / (lev*100). */
  function bustPriceNum(entry, isLong, lev) {
    if (!(entry > 0) || !(lev >= 1)) return NaN;
    var den = lev * 100;
    return isLong ? entry * (den - BUST_BUFFER_PCT) / den : entry * (den + BUST_BUFFER_PCT) / den;
  }

  /* Exact version on the 1e18 entry, same rounding as the contract (long ceil, short floor). */
  function bustPrice18(entryPx18, isLong, lev) {
    var den = BigInt(lev) * 100n;
    if (isLong) {
      var num = entryPx18 * (den - BigInt(BUST_BUFFER_PCT));
      return (num + den - 1n) / den;
    }
    return entryPx18 * (den + BigInt(BUST_BUFFER_PCT)) / den;
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
    var px = marketPrice(m);
    var notional = isFinite(form.margin) && form.margin > 0 ? form.margin * form.lev : NaN;
    setText('orderValue', isFinite(notional) ? fmtUsd(notional) : '—');
    setText('bustPrice', fmtPrice(bustPriceNum(px, form.side === 'long', form.lev), m ? m.szDecimals : null));
    /* DESIGN 3b: the payout cap is shown before the user opens. */
    var capX = m && m.inst ? m.inst.payoutCapX : 0;
    setText('maxProfit', capX > 0 && isFinite(form.margin) && form.margin > 0 ? fmtUsd(form.margin * capX * (1 - feeRate())) + ' (x' + capX + ')' : '—');
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
        var px = marketPrice(m);
        var bust = bustPriceNum(px, form.side === 'long', form.lev);
        note = 'Busts on a ' + (BUST_BUFFER_PCT / form.lev).toFixed(3) + '% move' + (isFinite(bust) ? ' (' + fmtPrice(bust, m.szDecimals) + ')' : '') + '.';
      }
    }
    if (state.busy) { disabled = true; note = 'Confirm in your wallet…'; err = false; }
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
    read.provider = makeProvider(cfg.rpcUrl);
    read.logProvider = cfg.logRpcUrl && cfg.logRpcUrl !== cfg.rpcUrl ? makeProvider(cfg.logRpcUrl) : read.provider;
    if (hasExchange()) read.exchange = new E.Contract(cfg.contracts.exchange, EXCHANGE_ABI, read.provider);
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

  function refreshHouse() {
    var ex = read.exchange;
    if (!ex) {
      return read.provider ? read.provider.getBlockNumber().then(function (b) { house.block = Number(b); house.blockAt = Date.now(); renderStatus(); }).catch(function () {}) : Promise.resolve();
    }
    return Promise.all([
      ex.lpBalance(), ex.feePool(), ex.queuedTotal(), ex.queueLength(), ex.queueHead(), ex.globalOpensPaused(), read.provider.getBlockNumber(),
      ex.breakerTripped().catch(function () { return false; }),
      ex.feeBps().catch(function () { return null; })
    ]).then(function (r) {
      house.lp = usd6ToNum(r[0]); house.feePool = usd6ToNum(r[1]); house.queued = usd6ToNum(r[2]);
      house.queueLen = Number(r[3]); house.queueHead = Number(r[4]); house.globalPaused = !!r[5];
      house.block = Number(r[6]); house.blockAt = Date.now(); house.breakerTripped = !!r[7];
      if (r[8] != null) house.feeRate = Number(r[8]) / 1e4;
      renderStatus(); renderAction();
    }).catch(function () { /* transient RPC trouble: keep the last values */ });
  }

  function loadHouseAddresses() {
    var ex = read.exchange;
    if (!ex) return Promise.resolve();
    var names = ['usdc', 'oracle', 'confetti', 'tokenomics', 'staking', 'owner', 'feeRecipient', 'pauseGuardian', 'marketKeeper'];
    return Promise.all(names.map(function (n) { return ex[n]().catch(function () { return null; }); })).then(function (vals) {
      names.forEach(function (n, i) { if (vals[i]) house.addrs[n] = vals[i]; });
      renderStatus();
    });
  }

  function refreshMarketChain() {
    var m = state.market;
    var ex = read.exchange;
    if (!m || !ex || m.instrumentId == null) return Promise.resolve();
    var id = m.instrumentId;
    var E = window.ethers;
    var oracleAddr = house.addrs.oracle || (cfg.contracts && cfg.contracts.oracle);
    var oracle = isAddr(oracleAddr) ? new E.Contract(oracleAddr, ORACLE_ABI, read.provider) : null;
    return Promise.all([
      ex.openInterest(id),
      ex.instrument(id),
      oracle ? oracle.price(id).catch(function () { return null; }) : Promise.resolve(null)
    ]).then(function (r) {
      house.oi[m.symbol] = { long: usd6ToNum(r[0][0]), short: usd6ToNum(r[0][1]) };
      var inst = normInst(r[1], id);
      inst.market = m;
      m.inst = inst;
      state.byInstId[id] = inst;
      house.oraclePx = r[2] == null ? null : px18ToNum(r[2]);
      renderMarketHeader(); renderLeverage(); renderAction(); renderStatus();
    }).catch(function () { /* keep the last values */ });
  }

  function usdcAddress() { return house.addrs.usdc || (cfg.contracts && cfg.contracts.usdc); }

  function refreshAccount() {
    if (!wallet.account || !read.exchange) return Promise.resolve();
    var ex = read.exchange;
    var a = wallet.account;
    return Promise.all([ex.balanceOf(a), ex.marginInUse(a), ex.positionIdsOf(a)]).then(function (r) {
      var ids = Array.from(r[2]).map(function (x) { return BigInt(x); });
      return Promise.all(ids.map(function (id) { return ex.positions(id); })).then(function (ps) {
        if (wallet.account !== a) return;
        var positions = [];
        ps.forEach(function (p, i) {
          if (!p || p.owner === ZERO) return;
          positions.push({
            id: ids[i], instrumentId: Number(p.instrumentId), isLong: !!p.isLong,
            margin: usd6ToNum(p.marginUsdc), leverage: Number(p.leverage),
            entry: px18ToNum(p.entryPx18), entryPx18: BigInt(p.entryPx18), openedAt: Number(p.openedAt),
            /* settlement terms stamped at open (DESIGN 5); the close settles on these */
            deadbandBps: Number(p.deadbandBps), payoutCapX: Number(p.payoutCapX), feeBps: Number(p.feeBps)
          });
        });
        positions.sort(function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });
        acct.available = usd6ToNum(r[0]);
        acct.marginInUse = usd6ToNum(r[1]);
        acct.positions = positions;
        acct.loaded = true;
        renderAccount(); renderPositions(); renderAction(); renderStatus();
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

  function positionEstimate(pos) {
    var m = positionMarket(pos);
    var px = m ? marketPrice(m) : NaN;
    var inst = state.byInstId[pos.instrumentId];
    var queueEmpty = house.queueLen == null ? true : house.queueHead === house.queueLen;
    return estimateClose(pos, inst, px, queueEmpty);
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
    setText('eqMargin', fmtUsd(acct.marginInUse));
    setText('eqEquity', fmtUsd(acct.available + acct.marginInUse + (isFinite(pnl) ? pnl : 0)));
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

  /* Fill the live PnL span of one position line. Only this span depends on the mark. */
  function fillPositionPnl(line, p) {
    var m = positionMarket(p);
    var px = m ? marketPrice(m) : NaN;
    var est = positionEstimate(p);
    var span = line.querySelector('[data-role="pnl"]');
    if (!span) return;
    span.textContent = isFinite(px) ? fmtUsd(est.pnl, true) : '—';
    span.className = est.pnl > 0 ? 'pos' : est.pnl < 0 ? 'neg' : '';
    span.title = isFinite(px) && !est.flat
      ? 'mark ' + fmtPrice(px, m ? m.szDecimals : null) + ' · payout ' + fmtUsd(est.payout) + (est.fee ? ' · fee ' + fmtUsd(est.fee) : '')
      : '';
  }

  /* One .pos-line per open position: sym, side+lev, margin, entry, bust, pnl, [Close]. */
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
    var btn = el('button', 'btn btn-sm btn-ghost', 'Close');
    btn.type = 'button';
    btn.setAttribute('data-id', String(p.id));
    btn.disabled = state.busy;
    btn.addEventListener('click', function () { submitClose(p); });
    line.appendChild(btn);
    fillPositionPnl(line, p);
    return line;
  }

  function renderPositions() {
    var host = $('posLines');
    var empty = $('posEmpty');
    if (!host) return;
    setText('posCount', acct.positions.length ? ' ' + acct.positions.length : '');
    clearLines(host);
    if (!wallet.account) { empty.textContent = 'Connect a wallet to see your positions.'; empty.removeAttribute('hidden'); return; }
    if (!hasExchange()) { empty.textContent = 'Exchange address not configured.'; empty.removeAttribute('hidden'); return; }
    if (!acct.loaded) { empty.textContent = 'Loading…'; empty.removeAttribute('hidden'); return; }
    if (!acct.positions.length) { empty.textContent = 'No open positions.'; empty.removeAttribute('hidden'); return; }
    empty.setAttribute('hidden', '');
    var frag = document.createDocumentFragment();
    acct.positions.forEach(function (p) { frag.appendChild(positionLine(p)); });
    host.appendChild(frag);
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
        renderWallet(); renderAction(); renderStatus(); renderPositions();
        if (wallet.chainId !== CHAIN_ID) toast('Wallet is on chain ' + wallet.chainId + '. Switch to HyperEVM (999) to trade.', 'err');
        return Promise.all([refreshAccount(), refreshWalletUsdc(), loadHistory(true)]);
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
    acct.loaded = false; acct.available = 0; acct.marginInUse = 0; acct.positions = []; acct.walletUsdc = 0; acct.allowance = 0;
    hist = freshHistory();
    renderAccount(); renderPositions(); renderHistory();
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
    MarketRetired: function (a) { return 'Market #' + a[0] + ' is retired: closes only.'; },
    OpensPausedGlobally: function () { return 'Opens are paused on every market.'; },
    OpensPausedForMarket: function (a) { return 'Opens are paused on market #' + a[0] + '.'; },
    MarginBelowMinimum: function (a) { return 'Margin ' + fmtUsd(usd6ToNum(a[0])) + ' is below the minimum ' + fmtUsd(usd6ToNum(a[1])) + '.'; },
    LeverageOutOfRange: function (a) { return 'Leverage x' + a[0] + ' is outside x1..x' + a[1] + '.'; },
    OiCapExceeded: function (a) { return (a[1] ? 'Long' : 'Short') + ' OI cap reached on market #' + a[0] + ': headroom ' + fmtUsd(usd6ToNum(a[2])) + '.'; },
    PositionTooLarge: function (a) { return 'Position of ' + fmtUsd(usd6ToNum(a[1])) + ' notional exceeds the per-position cap of ' + fmtUsd(usd6ToNum(a[2])) + ' on market #' + a[0] + '.'; },
    OpensPausedByBreaker: function () { return 'Opens are paused: the LP loss breaker is tripped.'; },
    BreakerNotTripped: function () { return 'The LP breaker is not tripped.'; },
    FeedAlive: function (a) { return 'Market #' + a[0] + ' still has a live price feed; retire it normally.'; },
    InsufficientBalance: function (a) { return 'Insufficient exchange balance: available ' + fmtUsd(usd6ToNum(a[0])) + ', needed ' + fmtUsd(usd6ToNum(a[1])) + '.'; },
    UnknownPosition: function (a) { return 'Position #' + a[0] + ' does not exist (already closed or liquidated).'; },
    NotPositionOwner: function (a) { return 'Position #' + a[0] + ' is not owned by this wallet.'; },
    NotLiquidatable: function (a) { return 'Position #' + a[0] + ' is not at its bust price (' + fmtPrice(px18ToNum(a[1])) + ' vs ' + fmtPrice(px18ToNum(a[2])) + ').'; },
    InvalidTier: function (a) { return 'Invalid tier ' + a[0] + '.'; },
    ParamOutOfBounds: function (a) { return 'Parameter ' + a[0] + ' out of bounds (' + a[1] + ').'; },
    QueueEmpty: function () { return 'The payout queue is empty.'; },
    QueueNotEmpty: function () { return 'Not allowed while the payout queue is active.'; },
    NothingToPush: function () { return 'Nothing to push right now.'; },
    FeedUnavailable: function (a) { return 'Price feed unavailable for market #' + a[0] + '. Try again in a moment.'; },
    ZeroPrice: function (a) { return 'Price feed returned zero for market #' + a[0] + '.'; },
    ClampOutOfBounds: function (a) { return 'Clamp ' + a[0] + ' bps is out of bounds.'; },
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

  function decodeRevert(data) {
    var E = window.ethers;
    if (exIface) {
      try { var p = exIface.parseError(data); if (p) return friendly(p.name, p.args); } catch (e) { /* not ours */ }
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
    return Promise.all([refreshAccount(), refreshWalletUsdc(), refreshHouse(), refreshMarketChain()]).then(function () {
      return loadHistory(true);
    });
  }

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
    sendTx(desc, ex.open, [m.instrumentId, isLong, margin6, lev]).then(function (rc) {
      var ev = receiptEvents(rc, 'PositionOpened')[0];
      var id = ev ? String(ev.args.positionId) : '?';
      var entry = ev ? fmtPrice(px18ToNum(ev.args.entryPx18)) : '—';
      toast('Opened #' + id + ': ' + (isLong ? 'long ' : 'short ') + m.symbol + ' x' + lev + ', margin ' + fmtUsd(form.margin) + ', entry ' + entry + '.', 'ok', txLink(rc.hash));
      return afterTx();
    }).catch(function (e) {
      toast(desc + ' failed: ' + describeError(e), 'err');
    }).then(function () { setBusy(false); });
  }

  function submitClose(pos) {
    try { requireSigner(); } catch (e) { toast(e.message, 'err'); return Promise.resolve(false); }
    var m = positionMarket(pos);
    var desc = 'Close #' + pos.id + (m ? ' ' + m.symbol : '');
    setBusy(true);
    var ex = exchangeWrite();
    return sendTx(desc, ex.close, [pos.id]).then(function (rc) {
      var ev = receiptEvents(rc, 'PositionClosed')[0];
      if (ev) {
        var a = ev.args;
        var pnl = usd6ToNum(a.pnlUsdc);
        var msg = 'Closed #' + pos.id + ' at ' + fmtPrice(px18ToNum(a.exitPx18)) + ': PnL ' + fmtUsd(pnl, true) + ', paid ' + fmtUsd(usd6ToNum(a.payoutUsdc));
        if (a.queuedUsdc > 0n) msg += ', queued ' + fmtUsd(usd6ToNum(a.queuedUsdc));
        if (a.confettiMinted > 0n) msg += ', ' + fmtInt(tokenToNum(a.confettiMinted)) + ' CONFETTI minted';
        toast(msg + '.', pnl >= 0 ? 'ok' : 'err', txLink(rc.hash));
      } else {
        toast(desc + ' confirmed.', 'ok', txLink(rc.hash));
      }
      return afterTx().then(function () { return true; });
    }).catch(function (e) {
      toast(desc + ' failed: ' + describeError(e), 'err');
      return false;
    }).then(function (ok) { setBusy(false); return ok; });
  }

  function closeAll() {
    if (state.busy || !acct.positions.length) return;
    var list = acct.positions.slice();
    (function next(i) {
      if (i >= list.length) return;
      submitClose(list[i]).then(function (ok) { if (ok) next(i + 1); else toast('Close all stopped at #' + list[i].id + '.', 'err'); });
    })(0);
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
    var q2 = { address: addr, fromBlock: from, toBlock: to, topics: [[t('PositionOpened'), t('PositionClosed'), t('PositionLiquidated'), t('QueueAppended'), t('QueuePaid')], null, user] };
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
    setText('stPaused', read.exchange ? (house.globalPaused ? 'yes' : 'no') : '—');
    setText('stBreaker', read.exchange ? (house.breakerTripped ? 'tripped · opens paused' : 'armed') : '—');
    setText('stFee', read.exchange && house.feeRate != null ? feePctText() : '—');
    setText('finePrint', 'No funding, no spread. Wins pay the impact haircut plus a ' + feePctText() + ' fee.');
    setText('stInstCount', house.instCount != null ? String(house.instCount) : '—');

    addrCell('stExchange', cfg.contracts && cfg.contracts.exchange);
    addrCell('stUsdc', usdcAddress());
    addrCell('stOracle', house.addrs.oracle || (cfg.contracts && cfg.contracts.oracle));
    addrCell('stConfetti', house.addrs.confetti || (cfg.contracts && cfg.contracts.confetti));
    addrCell('stTokenomics', house.addrs.tokenomics || (cfg.contracts && cfg.contracts.tokenomics));
    addrCell('stStaking', house.addrs.staking || (cfg.contracts && cfg.contracts.staking));
    addrCell('stOwner', house.addrs.owner);
    addrCell('stFeeRecipient', house.addrs.feeRecipient);

    var m = state.market;
    var inst = m && m.inst;
    if (inst) {
      setText('stInst', '#' + inst.id + ' · HL ' + inst.hlAssetIndex + ' · sz ' + inst.szDecimals + ' · tier ' + tierLetter(m) + ' x' + inst.maxLeverage + (inst.retired ? ' · retired' : inst.opensPaused ? ' · paused' : ''));
      setText('stBand', inst.deadbandBps + ' bps / ' + inst.clampBps + ' bps');
      setText('stCurve', (inst.baseRate * 100).toFixed(0) + '% · ' + fmtInt(inst.rateMultiplier) + ' · $' + fmtInt(inst.referenceNotional) + ' · ' + fmtInt(inst.positionMultiplier));
      setText('stCaps', fmtUsdCompact(inst.longCap) + ' / ' + fmtUsdCompact(inst.shortCap));
      setText('stOraclePx', house.oraclePx != null ? fmtPrice(house.oraclePx) : (inst.retired ? fmtPrice(inst.frozenPx) + ' (frozen)' : '—'));
    } else {
      setText('stInst', m ? (hasExchange() ? (state.instrumentsLoaded ? 'not on chain yet' : 'loading…') : 'HL ' + m.hlAssetIndex + ' · tier ' + m.tier) : '—');
      setText('stBand', '—'); setText('stCurve', '—'); setText('stCaps', '—'); setText('stOraclePx', '—');
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
    show(saved === 'history' || saved === 'status' ? saved : 'positions');
    var more = $('histMoreBtn');
    if (more) more.addEventListener('click', function () { loadHistory(false); });
    var closeAllBtn = $('closeAllBtn');
    if (closeAllBtn) closeAllBtn.addEventListener('click', closeAll);
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
    buildMarkets();
    initTheme();
    initHeader();
    initMarketMenu();
    initForm();
    initTabs();
    initDialogs();
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
      start();
    }).catch(function (e) {
      cfg = { contracts: {}, markets: [] };
      start();
      toast('Could not load config.json: ' + (e && e.message ? e.message : e) + '. Serve the site over http and copy config.example.json to config.json.', 'err', null, 0);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
