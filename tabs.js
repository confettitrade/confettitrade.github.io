/* ==========================================================================
   confetti_  —  tabs.js
   Drives the Portfolio, House, Confetti, Leaderboard, v2 and v3 pages (body
   data-page="portfolio" | "house" | "confetti" | "leaderboard" | "v2" | "v3"). Contract addresses are
   pinned (CONTRACTS, as in trade.js) and checked against the Exchange's own getters
   over a plain RPC, Exchange events over eth_getLogs, and the points engine
   (points.js) for the points board. The only transactions are the Confetti
   page's approve / stake / unstake / claim on the Staking contract and its move of a v3 stake
   (claim / unstake on the v3 Staking, contracts.v3Staking, then approve / stake here), its FETTI
   buy / sell on HyperSwap V2's FETTI / WHYPE pool (router and pair pinned in SWAP), and the v2 /
   v3 pages' requestClose / executeClose / cancelClose / cancelOpen / withdraw on the v2 / v3
   Exchange (config contracts.v2Exchange / v3Exchange), sent from the user's wallet. No build step.
   ABI fragments are copied from the compiled v4 ABIs (IExchange, IStaking); FETTI's are plain
   ERC-20; the v3 Staking's from ops/abi/StakingV3.json; the v2 / v3 Exchange's from
   ops/abi/ExchangeV2.json / ExchangeV3.json;
   HyperSwap's from its deployed contracts (no artifact; ops/check_site_abi.js lists them as external).
   ========================================================================== */
(function () {
  'use strict';

  var CHAIN_ID = 999;
  var CHAIN_HEX = '0x3e7';
  var ZERO = '0x0000000000000000000000000000000000000000';
  var THEME_KEY = 'confetti.theme';

  /* Pinned like trade.js, the same block (ops/write_config.py rewrites both, ops/check_site_pins.js
     checks them against site/config.json): every contract address, the chain id and the RPC /
     info hosts. A config.json that differs is refused and the pins are used; an empty pin is off.
     The Exchange's own getters (EX_GETTERS) are compared with the pins once it is readable. */
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
  /* HyperSwap V2's FETTI / WHYPE pool for the Confetti page's buy / sell box. External contracts,
     not deploy outputs: ops/write_config.py does not rewrite this block (it carries config.json
     "swap" across a redeploy) and ops/check_site_pins.js checks it against config.json "swap".
     Verified on chain 2026-10-17: router.factory() 0x7244…1C48 = pair.factory(), router.WETH() =
     WHYPE, pair token0 WHYPE / token1 FETTI. The box shows at once when config "swap" equals these;
     the page re-reads them behind it, hides it on any difference and sends nothing until they pass.
     Only tabs.js carries it; trade.js has no swap. */
  /* ---- BEGIN PINNED SWAP (HyperSwap V2, external) ---- */
  var SWAP = {
    router: '0xb4a9c4e6ea8e2191d2fa5b380452a634fb21240a',
    pair: '0x9cD9b6514f28325c8F18F1c5aBe311D5c737D930',
    whype: '0x5555555555555555555555555555555555555555'
  };
  /* ---- END PINNED SWAP ---- */
  var USDC = CONTRACTS.usdc;
  var EX_GETTERS = ['usdc', 'staking', 'oracle', 'referrals', 'extension'];
  /* the EX_GETTERS addresses the Confetti page sends transactions to (approve, stake, unstake, claim) */
  var TX_GETTERS = { staking: true };
  var RPC_HOSTS = ['rpc.hyperliquid.xyz', 'hyperliquid.drpc.org', 'rpc.purroofgroup.com'];
  var INFO_HOSTS = ['api.hyperliquid.xyz'];
  var DEFAULT_RPC = 'https://rpc.hyperliquid.xyz/evm';
  var DEFAULT_INFO = 'https://api.hyperliquid.xyz/info';

  var EVERY_MS = { portfolio: 10000, house: 10000, confetti: 15000, leaderboard: 60000, closeOut: 5000 };
  var SWAP_EVERY_MS = 10000;   /* the swap box: pool, HYPE mid, balances and quote */
  var SWAP_DEADLINE_S = 600;   /* a swap's router deadline past the chain clock */
  var SLIP_MIN = 0.1, SLIP_MAX = 10, SLIP_DEFAULT = 1;   /* swap slippage, percent */
  var V2_EVERY_MS = 30000;     /* Portfolio's read of the v2 / v3 balances behind its v2 / v3 links */
  var KEEPER_EVERY_MS = 30000;
  var HBOT_EVERY_MS = 60000;
  var HIST_PAGE = 50;          /* history lines shown per page on Portfolio */
  var BOARD_ROWS = 50;         /* lines per leaderboard */
  var QUEUE_ROWS = 25;         /* payout-queue entries listed on House */
  var PUSH_WINDOW_DAYS = 30;   /* APR: reward pushes over this many days, annualised */

  /* Local demo for screenshots (the $FETTI page): a pretend holder with FETTI in the wallet, a stake,
     a warming stake and a claim, a seeded pool and recent pushes; no wallet, no chain. Only on
     localhost or 127.0.0.1 with ?demo=1 (signed in; add &v3=1 for a v3 stake to move) or ?demo=out
     (signed out). On any other host (confetti.trade) DEMO is null, and every demo branch below starts
     by checking it, so nothing of the demo runs, reads or sends. The same gate as trade.js. */
  var DEMO = (function () {
    try {
      var h = String(location.hostname || '');
      if (h !== 'localhost' && h !== '127.0.0.1') return null;
      var v = new URLSearchParams(location.search).get('demo');
      return v === '1' || v === 'out' ? v : null;
    } catch (e) { return null; }
  })();

  /* ---- tiny helpers ------------------------------------------------------- */

  function $(id) { return document.getElementById(id); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function setText(id, text) { var n = $(id); if (n) n.textContent = text; }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = v ? v.trim() : '';
    return v || fallback;
  }

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
    return (signed && n > 0 ? '+$' : '$') + abs;
  }

  function fmtInt(n) { return isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—'; }

  /* "$10" for whole dollars, "$12.50" otherwise: the amount as people say it (trade.js fmtUsdShort). */
  function fmtUsdShort(n) {
    if (n == null || !isFinite(n)) return '—';
    return Math.abs(n - Math.round(n)) < 0.005 && n >= 0 ? '$' + Math.round(n).toLocaleString('en-US') : fmtUsd(n);
  }

  /* Same as trade.js: cents dropped from $10,000, M / B above a million. */
  function fmtUsdCompact(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return '$' + Math.round(n).toLocaleString('en-US');
    return fmtUsd(n);
  }

  /* FETTI amounts: whole tokens, two decimals below 1,000. */
  function fmtTok(n) {
    if (n == null || !isFinite(n)) return '—';
    return n >= 1000 ? fmtInt(Math.floor(n)) : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  /* HYPE amounts: four decimals from 1, six below. */
  function fmtHype(n) {
    if (n == null || !isFinite(n)) return '—';
    return n >= 1000 ? fmtInt(n) : n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 4 : 6 });
  }

  function fmtPct(x) {
    if (x == null || !isFinite(x)) return '—';
    var p = x * 100;
    return (p >= 100 ? fmtInt(p) : p.toFixed(p >= 10 ? 1 : 2)) + '%';
  }

  function fmtPrice(p, szDecimals) {
    if (p == null || !isFinite(p) || p <= 0) return '—';
    var cap = szDecimals == null ? 7 : Math.max(2, 7 - szDecimals);
    return p.toFixed(clamp(4 - Math.floor(Math.log10(p)), 2, cap));
  }

  function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }

  function fmtTime(ts) {
    if (!ts) return '…';
    var d = new Date(ts * 1000);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  /* Seconds as a short span, the keeper cell's units: 45s, 12m, 5h, 3d. */
  function fmtSpan(s) {
    s = Math.max(0, Math.floor(s));
    if (s < 90) return s + 's';
    if (s < 90 * 60) return Math.round(s / 60) + 'm';
    if (s < 48 * 3600) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  /* A contract duration in words: 7 days, 36 hours, 1 day. */
  function fmtDuration(s) {
    if (!(s > 0)) return '—';
    var unit = s % 86400 === 0 ? 86400 : s % 3600 === 0 ? 3600 : 60;
    var n = Math.round(s / unit);
    return n + ' ' + (unit === 86400 ? 'day' : unit === 3600 ? 'hour' : 'minute') + (n === 1 ? '' : 's');
  }

  function usd6(x) { return Number(x) / 1e6; }
  function px18(x) { return Number(x) / 1e18; }
  function tok18(x) { return Number(x) / 1e18; }

  function isAddr(a) { return !!(window.ethers && a && window.ethers.isAddress(a) && String(a).toLowerCase() !== ZERO); }

  function signCls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; }

  /* "+3.6%": P&L as a share of the amount put in (trade.js fmtPct1). */
  function fmtPct1(x) {
    if (x == null || !isFinite(x)) return '';
    return (x > 0 ? '+' : x < 0 ? '-' : '') + Math.abs(x * 100).toFixed(1) + '%';
  }

  /* "0.75%" / "5.3%": the distance to liquidation (trade.js fmtAway). */
  function fmtAway(away) { return (away * 100).toFixed(away >= 0.01 ? 1 : 2) + '%'; }

  /* ---- liquidation maths, ported from trade.js for the Portfolio rows (piece 12) ------------
     The same numbers as the trade page: BUST_BUFFER_PCT / BUST_GAP_BPS (trade.js:143-144),
     bustMoveUnits, bustMovePct and bustPrice18 (trade.js:1810-1829), rawEntry18 and posBust18
     (trade.js:1833-1847), liqRoom (trade.js:3752-3761). A position needs entryPx18 (the 1e18
     entry as read, a BigInt) and entryDeadbandBps, which readAccount keeps from the read. */
  var BUST_BUFFER_PCT = 95;
  var BUST_GAP_BPS = 5;

  /* The bust move in units of 1 / (lev x 10000), as ImpactLib.bustPrice works it: the smaller
     of 9500 (95% of 1/lev) and 10000 - BUST_GAP_BPS x lev (1/lev minus the gap). */
  function bustMoveUnits(lev) {
    var gap = BUST_GAP_BPS * lev;
    return Math.min(BUST_BUFFER_PCT * 100, gap < 10000 ? 10000 - gap : 0);
  }

  /* The bust move as a percentage of price: 0.05% at 1000x, 9.5% at 10x. */
  function bustMovePct(lev) { return bustMoveUnits(lev) / (lev * 100); }

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

  /* A position's liquidation price, how far the price now is from it, and its colour: amber
     under half of the full liquidation move, red under a fifth. */
  function liqRoom(p, px) {
    var liq = p.entryPx18 != null ? px18(posBust18(p)) : NaN;
    var out = { liq: liq, away: NaN, cls: '' };
    if (!(px > 0) || !(liq > 0)) return out;
    out.away = Math.max(0, p.isLong ? (px - liq) / px : (liq - px) / px);
    var share = out.away / (bustMovePct(p.leverage) / 100);
    out.cls = share < 0.2 ? 'is-red' : share < 0.5 ? 'is-amber' : '';
    return out;
  }

  /* ---- config ------------------------------------------------------------- */

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

  /* Hyperliquid info API (config hyperliquidInfoUrl, pinned to INFO_HOSTS), as in trade.js. */
  function postInfo(body, timeoutMs) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 6000) : null;
    return fetch((cfg && cfg.hyperliquidInfoUrl) || DEFAULT_INFO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('info ' + res.status);
      return res.json();
    }).finally(function () { clearTimeout(timer); });
  }

  function hostAllowed(url, hosts) {
    var h = '';
    try { h = new URL(String(url)).hostname.toLowerCase(); } catch (e) { h = ''; }
    return !!h && hosts.indexOf(h) !== -1 && /^https:/i.test(String(url));
  }

  function addrOrNull(v) {
    var s = v == null ? '' : String(v).trim();
    return /^0x[0-9a-fA-F]{40}$/.test(s) && s.toLowerCase() !== ZERO ? s : null;
  }

  function sameAddr(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }

  /* Same rule as trade.js: the pins are in force. A config address that differs from its pin (or
     has none) is reported; zero / missing = unset. Chain id and RPC / info hosts are pinned too. */
  function pinConfig(c) {
    var bad = [];
    var src = c.contracts && typeof c.contracts === 'object' ? c.contracts : {};
    Object.keys(src).forEach(function (k) {
      var a = addrOrNull(src[k]);
      var s = src[k] == null ? '' : String(src[k]).trim();
      var pin = Object.prototype.hasOwnProperty.call(CONTRACTS, k) ? CONTRACTS[k] : '';
      if ((a || (s && s.toLowerCase() !== ZERO)) && !sameAddr(a, pin)) bad.push('contracts.' + k + ' ' + s);
    });
    c.contracts = {};
    Object.keys(CONTRACTS).forEach(function (k) { var a = addrOrNull(CONTRACTS[k]); if (a) c.contracts[k] = a; });
    if (c.chainId != null && Number(c.chainId) !== CHAIN_ID) bad.push('chainId ' + c.chainId);
    c.chainId = CHAIN_ID;
    if (c.rpcUrl && !hostAllowed(c.rpcUrl, RPC_HOSTS)) { bad.push('rpcUrl ' + c.rpcUrl); c.rpcUrl = DEFAULT_RPC; }
    if (!c.rpcUrl) c.rpcUrl = DEFAULT_RPC;
    if (c.logRpcUrl && !hostAllowed(c.logRpcUrl, RPC_HOSTS)) { bad.push('logRpcUrl ' + c.logRpcUrl); c.logRpcUrl = null; }
    if (c.hyperliquidInfoUrl && !hostAllowed(c.hyperliquidInfoUrl, INFO_HOSTS)) { bad.push('hyperliquidInfoUrl ' + c.hyperliquidInfoUrl); c.hyperliquidInfoUrl = DEFAULT_INFO; }
    /* config "swap" with a pair turns the swap box on; its addresses are the SWAP pins. agreed: config
       names every pin and nothing else, so the box shows at once and the chain check runs behind it. */
    if (c.swap && typeof c.swap === 'object' && addrOrNull(c.swap.pair)) {
      var swapBad = bad.length;
      Object.keys(c.swap).forEach(function (k) {
        var a = addrOrNull(c.swap[k]);
        var s = c.swap[k] == null ? '' : String(c.swap[k]).trim();
        var pin = Object.prototype.hasOwnProperty.call(SWAP, k) ? SWAP[k] : '';
        if ((a || (s && s.toLowerCase() !== ZERO)) && !sameAddr(a, pin)) bad.push('swap.' + k + ' ' + s);
      });
      var agreed = bad.length === swapBad && Object.keys(SWAP).every(function (k) { return sameAddr(c.swap[k], SWAP[k]); });
      c.swap = addrOrNull(SWAP.router) && addrOrNull(SWAP.pair) && addrOrNull(SWAP.whype) ? { router: SWAP.router, pair: SWAP.pair, whype: SWAP.whype, agreed: agreed } : null;
    } else {
      c.swap = null;
    }
    return bad;
  }

  function explorer(kind, value) {
    var base = (cfg && cfg.explorerUrl) || 'https://hyperevmscan.io';
    return base.replace(/\/$/, '') + '/' + kind + '/' + value;
  }

  function deployBlock() { return Number(cfg.deployBlock) > 0 ? Number(cfg.deployBlock) : 0; }
  function v2DeployBlock() { return Number(cfg.v2DeployBlock) > 0 ? Number(cfg.v2DeployBlock) : 0; }
  function v3DeployBlock() { return Number(cfg.v3DeployBlock) > 0 ? Number(cfg.v3DeployBlock) : 0; }

  /* ---- house bots (config.json "houseBots"): left out of every public number when listed ---- */

  var hbots = { idx: {}, n: 0 };

  function initHouseBots(list) {
    (Array.isArray(list) ? list : []).slice(0, 20).forEach(function (a) {
      if (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !hbots.idx[a.toLowerCase()]) { hbots.idx[a.toLowerCase()] = true; hbots.n++; }
    });
  }
  function isHouseBot(a) { return !!(typeof a === 'string' && hbots.idx[a.toLowerCase()]); }

  /* ---- ABI fragments (hand-written from the Solidity interfaces) ---------- */

  var POSITION_T = 'tuple(address owner, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint96 maxProfitUsdc, uint256 entryPx18, uint64 openedAt, uint16 deadbandBps, uint16 payoutCapX, uint16 winFeeBps, uint16 lossFeeBps, uint16 entryDeadbandBps, uint16 borrowRateX10, uint16 borrowFreeHours)';
  var INSTRUMENT_T = 'tuple(uint32 hlAssetIndex, uint8 szDecimals, uint8 tier, uint32 maxLeverage, uint16 deadbandBps, uint16 clampBps, uint16 baseRateBps, uint64 rateMultiplier, uint128 referenceNotionalUsd, uint128 positionMultiplierE6, uint128 longOiCapUsd, uint128 shortOiCapUsd, uint128 maxNotionalUsd, uint16 payoutCapX, uint16 posX10, uint16 sideX10, uint16 stressBps, uint16 entryDeadbandBps, uint16 borrowRateX10, bool opensPaused, bool retired, uint256 lastPx18)';

  var EXCHANGE_ABI = [
    'function balanceOf(address user) view returns (uint256 availableUsdc)',
    'function marginInUse(address user) view returns (uint256 usdc)',
    'function pendingOf(address user) view returns (uint256 usdc)',
    'function positions(uint256 positionId) view returns (' + POSITION_T + ')',
    'function positionIdsOf(address user) view returns (uint256[])',
    'function previewClose(uint256 positionId) view returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc)',
    'function execPrice(uint32 instrumentId, bool isLong, bool isOpen) view returns (uint256 px18)',
    'function instrument(uint32 instrumentId) view returns (' + INSTRUMENT_T + ')',
    'function instrumentCount() view returns (uint32)',
    'function openInterest(uint32 instrumentId) view returns (uint256 longUsd, uint256 shortUsd)',
    'function lpBalance() view returns (uint256 usdc)',
    'function feePool() view returns (uint256 usdc)',
    'function houseFreeUsdc() view returns (uint256 usdc)',
    'function houseExposureUsdc() view returns (uint256 usdc)',
    'function rhoBps() view returns (uint16)',
    'function maxPositionUsd(uint32 instrumentId, bool isLong) view returns (uint256 usd)',
    'function openMaxPayoutUsdc() view returns (uint256)',
    'function queueLength() view returns (uint256)',
    'function queueHead() view returns (uint256)',
    'function queueEntry(uint256 index) view returns (address recipient, uint256 owedUsdc)',
    'function queuedTotal() view returns (uint256 usdc)',
    'function globalOpensPaused() view returns (bool)',
    'function breakerTripped() view returns (bool)',
    'function breakerBps() view returns (uint16)',
    'function breakerFloorUsdc() view returns (uint128)',
    'function breakerWindow() view returns (uint64 windowStart, uint256 windowStartLpUsdc, int256 netOutflowUsdc)',
    'function isKeeper(address account) view returns (bool)',
    'function usdc() view returns (address)',
    'function staking() view returns (address)',
    'function oracle() view returns (address)',
    'function referrals() view returns (address)',
    'function extension() view returns (address)',
    'event Deposited(address indexed user, address indexed payer, uint256 amountUsdc)',
    'event Withdrawn(address indexed user, uint256 amountUsdc)',
    'event OpenRequestCancelled(uint256 indexed requestId, address indexed trader, bytes4 reason)',
    'event PositionOpened(uint256 indexed positionId, address indexed owner, uint32 indexed instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 entryPx18, uint256 requestId, bool keeperFill)',
    'event PositionClosed(uint256 indexed positionId, address indexed owner, uint256 exitPx18, int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc, uint256 queuedUsdc, uint256 borrowUsdc, bool keeperFill)',
    'event PositionLiquidated(uint256 indexed positionId, address indexed owner, address indexed liquidator, uint256 exitPx18, uint128 marginUsdc, uint256 bountyUsdc, uint256 feeUsdc)',
    'event QueueAppended(uint256 indexed index, address indexed recipient, uint256 amountUsdc)',
    'event QueuePaid(uint256 indexed index, address indexed recipient, uint256 paidUsdc, uint256 remainingUsdc)',
    'event HouseDeposited(uint256 amountUsdc, uint256 lpAfterUsdc)',
    'event HouseWithdrawn(uint256 amountUsdc, uint256 lpAfterUsdc)'
  ];

  var STAKING_ABI = [
    'function stake(uint256 amount)',
    'function unstake(uint256 amount)',
    'function claim() returns (uint256 usdc)',
    'function stakedOf(address user) view returns (uint256)',
    'function activeStakeOf(address user) view returns (uint256)',
    'function warmingOf(address user) view returns (uint256 amount, uint64 activatesAt)',
    'function earned(address user) view returns (uint256 usdc)',
    'function totalStaked() view returns (uint256)',
    'function totalWarming() view returns (uint256)',
    'function totalStake() view returns (uint256)',
    'function totalRewardsUsdc() view returns (uint256)',
    'function confetti() view returns (address)',
    'event RewardNotified(address indexed from, uint256 usdc, uint256 accRewardPerShareE30After)',
    'error ZeroAddress()',
    'error ZeroAmount()',
    'error InsufficientStake(uint256 staked, uint256 requested)'
  ];

  /* FETTI (contracts.confetti, the token v3 already used): plain ERC-20. */
  var CONFETTI_ABI = [
    'function balanceOf(address account) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 value) returns (bool)',
    'function totalSupply() view returns (uint256)'
  ];

  /* The v3 Staking (contracts.v3Staking): what moving a v3 stake needs. Checked by
     ops/check_site_abi.js against ops/abi/StakingV3.json. */
  var V3_STAKING_ABI = [
    'function claim() returns (uint256 usdc)',
    'function unstake(uint256 amount)',
    'function stakedOf(address user) view returns (uint256)',
    'function earned(address user) view returns (uint256 usdc)',
    'function confetti() view returns (address)',
    'error ZeroAmount()',
    'error InsufficientStake(uint256 staked, uint256 requested)'
  ];

  /* HyperSwap V2 (SWAP pins), from the deployed router and pair: a Camelot-style fork, so the
     native-coin swaps are the ...SupportingFeeOnTransferTokens ones with a referrer (zero here:
     no fee share to anyone) and return nothing; plain swapExactETHForTokens is not deployed.
     getReserves returns each token's fee in FEE_DENOMINATOR parts (300 / 100000 = 0.3%). */
  var SWAP_ROUTER_ABI = [
    'function factory() view returns (address)',
    'function WETH() view returns (address)',
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
    'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline) payable',
    'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline)'
  ];

  var SWAP_PAIR_ABI = [
    'function factory() view returns (address)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint16 token0FeePercent, uint16 token1FeePercent)',
    'function FEE_DENOMINATOR() view returns (uint256)'
  ];

  /* The v2 Exchange (config contracts.v2Exchange): what the v2 page needs to close out and withdraw,
     and Portfolio's three balance reads. Checked by ops/check_site_abi.js against
     ops/abi/ExchangeV2.json, not the v3 build. */
  var V2_EXCHANGE_ABI = [
    'function balanceOf(address user) view returns (uint256 availableUsdc)',
    'function marginInUse(address user) view returns (uint256 usdc)',
    'function pendingOf(address user) view returns (uint256 usdc)',
    'function positionIdsOf(address user) view returns (uint256[])',
    'function positions(uint256 positionId) view returns (tuple(address owner, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 entryPx18, uint64 openedAt, uint16 deadbandBps, uint16 payoutCapX, uint16 feeBps))',
    'function previewClose(uint256 positionId) view returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc)',
    'function execPrice(uint32 instrumentId, bool isLong, bool isOpen) view returns (uint256 px18)',
    'function openRequest(uint256 requestId) view returns (tuple(address trader, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint64 requestedAt, uint256 px0, address referrer))',
    'function closeRequest(uint256 positionId) view returns (tuple(uint64 requestedAt, uint256 px0))',
    'function instrument(uint32 instrumentId) view returns (tuple(uint32 hlAssetIndex, uint8 szDecimals, uint8 tier, uint32 maxLeverage, uint16 deadbandBps, uint16 clampBps, uint16 baseRateBps, uint64 rateMultiplier, uint128 referenceNotionalUsd, uint128 positionMultiplierE6, uint128 longOiCapUsd, uint128 shortOiCapUsd, uint128 maxNotionalUsd, uint16 payoutCapX, bool opensPaused, bool retired, uint256 frozenPx18))',
    'function instrumentCount() view returns (uint32)',
    'function minDelay() view returns (uint32)',
    'function grace() view returns (uint32)',
    'function expiry() view returns (uint32)',
    'function usdc() view returns (address)',
    'function withdraw(uint256 amountUsdc)',
    'function requestClose(uint256 positionId)',
    'function executeClose(uint256 positionId) returns (uint256 payoutUsdc, uint256 queuedUsdc)',
    'function cancelClose(uint256 positionId)',
    'function cancelOpen(uint256 requestId)',
    'event OpenRequested(uint256 indexed requestId, address indexed trader, uint32 indexed instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 px0, address referrer)',
    'error ZeroAmount()',
    'error InsufficientBalance(uint256 availableUsdc, uint256 requestedUsdc)',
    'error UnknownPosition(uint256 positionId)',
    'error NotPositionOwner(uint256 positionId, address caller)',
    'error UnknownRequest()',
    'error TooEarly()',
    'error KeeperWindow()',
    'error RequestExpired()',
    'error RequestNotExpired()',
    'error CloseAlreadyPending()',
    'error SafeERC20FailedOperation(address token)'
  ];

  /* The v3 Exchange (config contracts.v3Exchange): the v3 page's close-out and withdraw, Portfolio's
     and the trade page's v3 link, and the Confetti page's v3 balance. Its struct shapes are the v3
     build's. Checked by ops/check_site_abi.js against ops/abi/ExchangeV3.json. */
  var V3_EXCHANGE_ABI = [
    'function balanceOf(address user) view returns (uint256 availableUsdc)',
    'function marginInUse(address user) view returns (uint256 usdc)',
    'function pendingOf(address user) view returns (uint256 usdc)',
    'function positionIdsOf(address user) view returns (uint256[])',
    'function positions(uint256 positionId) view returns (tuple(address owner, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 entryPx18, uint64 openedAt, uint16 deadbandBps, uint16 payoutCapX, uint16 feeBps))',
    'function previewClose(uint256 positionId) view returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc)',
    'function execPrice(uint32 instrumentId, bool isLong, bool isOpen) view returns (uint256 px18)',
    'function openRequest(uint256 requestId) view returns (tuple(address trader, uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint64 requestedAt, uint256 px0, address referrer))',
    'function closeRequest(uint256 positionId) view returns (tuple(uint64 requestedAt, uint256 px0))',
    'function instrument(uint32 instrumentId) view returns (tuple(uint32 hlAssetIndex, uint8 szDecimals, uint8 tier, uint32 maxLeverage, uint16 deadbandBps, uint16 clampBps, uint16 baseRateBps, uint64 rateMultiplier, uint128 referenceNotionalUsd, uint128 positionMultiplierE6, uint128 longOiCapUsd, uint128 shortOiCapUsd, uint128 maxNotionalUsd, uint16 payoutCapX, bool opensPaused, bool retired, uint256 frozenPx18))',
    'function instrumentCount() view returns (uint32)',
    'function minDelay() view returns (uint32)',
    'function grace() view returns (uint32)',
    'function expiry() view returns (uint32)',
    'function usdc() view returns (address)',
    'function withdraw(uint256 amountUsdc)',
    'function requestClose(uint256 positionId)',
    'function executeClose(uint256 positionId) returns (uint256 payoutUsdc, uint256 queuedUsdc)',
    'function cancelClose(uint256 positionId)',
    'function cancelOpen(uint256 requestId)',
    'event OpenRequested(uint256 indexed requestId, address indexed trader, uint32 indexed instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 px0, address referrer)',
    'error ZeroAmount()',
    'error InsufficientBalance(uint256 availableUsdc, uint256 requestedUsdc)',
    'error UnknownPosition(uint256 positionId)',
    'error NotPositionOwner(uint256 positionId, address caller)',
    'error UnknownRequest()',
    'error TooEarly()',
    'error KeeperWindow()',
    'error RequestExpired()',
    'error RequestNotExpired()',
    'error CloseAlreadyPending()'
  ];

  var read = { provider: null, logProvider: null, ex: null, staking: null, confetti: null, v3Staking: null, v2: null, v3: null };
  var exIface = null, stIface = null, cfIface = null, v2Iface = null, v3Iface = null;

  function makeProvider(url) {
    return new window.ethers.JsonRpcProvider(url, { chainId: CHAIN_ID, name: 'hyperevm' }, {
      staticNetwork: true,
      batchMaxCount: Number(cfg.rpcBatchMaxCount) >= 1 ? Number(cfg.rpcBatchMaxCount) : 1,
      polling: false
    });
  }

  function initRead() {
    var E = window.ethers;
    exIface = new E.Interface(EXCHANGE_ABI);
    stIface = new E.Interface(STAKING_ABI);
    cfIface = new E.Interface(CONFETTI_ABI);
    read.provider = makeProvider(cfg.rpcUrl);
    read.logProvider = cfg.logRpcUrl && cfg.logRpcUrl !== cfg.rpcUrl ? makeProvider(cfg.logRpcUrl) : read.provider;
    read.ex = cfg.contracts.exchange ? new E.Contract(cfg.contracts.exchange, EXCHANGE_ABI, read.provider) : null;
    if (cfg.contracts.v2Exchange) {
      v2Iface = new E.Interface(V2_EXCHANGE_ABI);
      read.v2 = new E.Contract(cfg.contracts.v2Exchange, V2_EXCHANGE_ABI, read.provider);
    }
    if (cfg.contracts.v3Exchange) {
      v3Iface = new E.Interface(V3_EXCHANGE_ABI);
      read.v3 = new E.Contract(cfg.contracts.v3Exchange, V3_EXCHANGE_ABI, read.provider);
    }
    bindContracts();
  }

  function bindContracts() {
    var E = window.ethers, k = cfg.contracts;
    read.staking = k.staking ? new E.Contract(k.staking, STAKING_ABI, read.provider) : null;
    read.confetti = k.confetti ? new E.Contract(k.confetti, CONFETTI_ABI, read.provider) : null;
    read.v3Staking = k.v3Staking ? new E.Contract(k.v3Staking, V3_STAKING_ABI, read.provider) : null;
  }

  /* Set when the exchange does not settle in the pinned USDC, or names a Staking other than the
     pinned one, or either Staking stakes another FETTI: reads go on, transactions are off. */
  var refused = null;

  /* The v4 gate: config "v4Placeholder", an empty exchangeExt pin, or exchange.extension() other
     than that pin. No v4 page sends a transaction while it is set; reads go on. */
  var gate = null;

  function setGate(text) {
    if (gate) return;
    gate = text;
    toast(gate, 'err', null, 0);
  }

  function initGate() {
    if (cfg.v4Placeholder === true) setGate('Not live yet.');
    else if (!addrOrNull(CONTRACTS.exchangeExt)) setGate('Contracts not ready.');
  }

  function refuse(what, got, pin) {
    console.error(what + ' ' + got + ' is not the pinned ' + (pin || 'none') + '; transactions are off.');
    if (refused) return;
    refused = 'The exchange does not match this site\'s pinned contracts. Transactions are off.';
    toast(refused, 'err', null, 0);
  }

  /* The Exchange's own getters against the pins: a disagreeing one is reported (one console error
     per field) and the pin stays in force; when it is a transaction target (USDC, Staking)
     transactions are off; extension() other than the exchangeExt pin sets the v4 gate. Then
     FETTI's pin against staking.confetti() and v3Staking.confetti().
     Rejects when usdc() could not be read, so the caller retries. */
  function checkExchange() {
    return Promise.all(EX_GETTERS.map(function (k) {
      return read.ex[k]().then(addrOrNull, none);
    })).then(function (vals) {
      if (!vals[0]) throw new Error('exchange.usdc() unreadable');
      EX_GETTERS.forEach(function (k, i) {
        var g = vals[i];
        if (k === 'extension') {
          if (!sameAddr(g, CONTRACTS.exchangeExt)) {
            console.error('exchange.extension() ' + g + ' is not the pinned ' + (CONTRACTS.exchangeExt || 'none') + '.');
            setGate('Contracts not ready.');
          }
          return;
        }
        if (!g) return;
        if (k === 'usdc') {
          if (sameAddr(g, USDC)) return;
          refused = 'This exchange settles in ' + g + ', not USDC ' + USDC + '. Transactions are off.';
          console.error('exchange.usdc() ' + g + ' is not the pinned USDC ' + USDC + '; transactions are off.');
          toast(refused, 'err', null, 0);
          return;
        }
        if (sameAddr(cfg.contracts[k], g)) return;
        if (TX_GETTERS[k]) refuse('exchange.' + k + '()', g, cfg.contracts[k]);
        else console.error('exchange.' + k + '() ' + g + ' is not the pinned ' + (cfg.contracts[k] || 'none') + '.');
      });
      return Promise.all([
        read.staking ? read.staking.confetti().then(addrOrNull, none) : null,
        read.v3Staking ? read.v3Staking.confetti().then(addrOrNull, none) : null
      ]);
    }).then(function (r) {
      if (r[0] && !sameAddr(r[0], cfg.contracts.confetti)) refuse('staking.confetti()', r[0], cfg.contracts.confetti);
      if (r[1] && !sameAddr(r[1], cfg.contracts.confetti)) refuse('v3Staking.confetti()', r[1], cfg.contracts.confetti);
    });
  }

  function none() { return null; }

  /* ---- chain clock and logs ------------------------------------------------ */

  var head = { block: null, ts: null, at: 0 };

  function readHead() {
    return read.provider.getBlock('latest').then(function (b) {
      head.block = Number(b.number); head.ts = Number(b.timestamp); head.at = Date.now();
      return head.block;
    });
  }

  function chainNow() { return head.ts == null ? Date.now() / 1000 : head.ts + (Date.now() - head.at) / 1000; }

  /* eth_getLogs over [from, to] in config-sized chunks, oldest first; a chunk the node refuses is
     retried at half the size. Each filter is { address, topics }; all filters run per chunk. */
  function scanLogs(filters, from, to) {
    var size = Math.max(1000, Number(cfg.logChunkBlocks) || 20000);
    var out = [];
    function step(start) {
      if (start > to) return Promise.resolve(out);
      var end = Math.min(to, start + size - 1);
      return Promise.all(filters.map(function (f) {
        return read.logProvider.getLogs({ address: f.address, topics: f.topics, fromBlock: start, toBlock: end });
      })).then(function (lists) {
        lists.forEach(function (l) { out = out.concat(l || []); });
        return step(end + 1);
      }, function (e) {
        if (size <= 1000) throw e;
        size = Math.max(1000, Math.floor(size / 2));
        return step(start);
      });
    }
    return step(from);
  }

  function topic(iface, name) { return iface.getEvent(name).topicHash; }

  function parseLog(iface, log) {
    try {
      var p = iface.parseLog({ topics: Array.from(log.topics), data: log.data });
      return p ? { name: p.name, args: p.args, block: Number(log.blockNumber), index: Number(log.index), tx: log.transactionHash, address: String(log.address).toLowerCase() } : null;
    } catch (e) { return null; }
  }

  /* Block timestamps, cached; missing ones are read three at a time. */
  var blockTs = {};
  var tsAsked = {};

  function fetchTimes(blocks) {
    var todo = [];
    blocks.forEach(function (b) { if (blockTs[b] == null && !tsAsked[b]) { tsAsked[b] = true; todo.push(b); } });
    var i = 0;
    function worker() {
      if (i >= todo.length) return Promise.resolve();
      var b = todo[i++];
      return read.provider.getBlock(b).then(function (blk) {
        if (blk) blockTs[b] = Number(blk.timestamp);
      }).catch(none).then(function () { delete tsAsked[b]; return worker(); });
    }
    return Promise.all([worker(), worker(), worker()]);
  }

  /* ---- markets (config markets matched to on-chain instruments) -------------------- */

  var mk = { byInstId: {}, list: [], loaded: false };

  function loadInstruments(contract) {
    var ex = contract || read.ex;
    return ex.instrumentCount().then(function (n) {
      var ids = [];
      for (var i = 0; i < Number(n); i++) ids.push(i);
      return Promise.all(ids.map(function (i) { return ex.instrument(i); }));
    }).then(function (rows) {
      mk.byInstId = {}; mk.list = [];
      rows.forEach(function (r, id) {
        var m = (cfg.markets || []).filter(function (x) { return Number(x.hlAssetIndex) === Number(r.hlAssetIndex); })[0];
        var inst = {
          id: id, sym: m ? m.symbol : '#' + id, coin: m ? (m.coin || m.symbol) : null, szDecimals: Number(r.szDecimals),
          tier: ['A', 'B', 'C'][Number(r.tier)] || '?', maxLeverage: Number(r.maxLeverage),
          longCap: usd6(r.longOiCapUsd), shortCap: usd6(r.shortOiCapUsd),
          opensPaused: !!r.opensPaused, retired: !!r.retired
        };
        mk.byInstId[id] = inst; mk.list.push(inst);
      });
      mk.loaded = true;
    });
  }

  function symOf(instId) { var i = mk.byInstId[instId]; return i ? i.sym : '#' + instId; }
  function szOf(instId) { var i = mk.byInstId[instId]; return i ? i.szDecimals : null; }
  function sideLev(isLong, lev) { return (isLong ? 'long' : 'short') + ' ' + lev + 'x'; }

  /* ---- wallet -------------------------------------------------------------- */

  var wallet = { eth: null, provider: null, signer: null, account: null, chainId: null, subscribed: false };
  var announced = [];
  var page = null;

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
      if (!walletList().length && !window.ethereum) toast('No wallet found. Open this page in a wallet browser or install a wallet extension.', 'err');
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
      return onWallet();
    }).then(function () {
      if (wallet.chainId !== CHAIN_ID) return switchChain().then(onWallet).catch(function (e) { toast(describeError(e), 'err'); });
    }).catch(function (e) {
      toast(describeError(e), 'err');
      renderWallet();
    });
  }

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
        return onWallet();
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
      onWallet();
    });
    eth.on('chainChanged', function (hex) { wallet.chainId = parseInt(hex, 16); onWallet(); });
    eth.on('disconnect', function () { disconnect(); });
  }

  function onWallet() {
    var done = function () { renderWallet(); if (page && page.onAccount) page.onAccount(); };
    if (wallet.eth && wallet.account) {
      wallet.provider = new window.ethers.BrowserProvider(wallet.eth);
      return wallet.provider.getSigner().then(function (s) { wallet.signer = s; }).catch(function () { wallet.signer = null; }).then(done);
    }
    done();
    return Promise.resolve();
  }

  function switchChain() {
    var eth = wallet.eth || getInjected();
    if (!eth) return Promise.reject(new Error('No wallet.'));
    return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] }).catch(function (err) {
      var code = err && (err.code != null ? err.code : (err.data && err.data.originalError && err.data.originalError.code));
      var msg = String((err && err.message) || '');
      if (!(code === 4902 || code === -32603 || /4902|unrecognized|not added|unknown chain/i.test(msg))) throw err;
      return eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_HEX, chainName: cfg.chainName || 'HyperEVM', rpcUrls: [DEFAULT_RPC],
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

  function disconnect() {
    wallet.account = null; wallet.signer = null; wallet.provider = null; wallet.chainId = null;
    onWallet();
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
    if (!wallet.account) phNums = null;
    renderPhAcct();
  }

  /* ---- phones (<= 640 px): the compact header (build 8) and its sheets (build 6) -------------------
     One flag for every phone-only behaviour; above 640 px the markup this fills is ph-only. */
  var PHONE_MQ = (function () { try { return window.matchMedia('(max-width: 640px)'); } catch (e) { return null; } })();
  var REDUCED_MQ = (function () { try { return window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return null; } })();
  function isPhone() { return !!(PHONE_MQ && PHONE_MQ.matches); }
  function reducedMotion() { return !!(REDUCED_MQ && REDUCED_MQ.matches); }
  /* The account numbers this page knows (the Portfolio page, for the connected wallet), else null */
  var phNums = null;

  /* Drag a sheet down by its grab handle or head: past 80 px or a flick faster than 0.5 px/ms
     dismisses it, short of that it springs back (the same as trade.js). */
  function sheetDrag(panel, zones, close) {
    if (!panel) return;
    var st = null;
    function down(ev) {
      if (!isPhone() || st || (ev.button != null && ev.button !== 0)) return;
      var t = ev.target;
      if (t && t.closest && t.closest('button, a, input, select, textarea, label')) return;
      st = { id: ev.pointerId, zone: ev.currentTarget, y0: ev.clientY, dy: 0, v: 0, lastY: ev.clientY, lastT: ev.timeStamp };
      try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
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
      if (ev.type === 'pointerup' && (s.dy > 80 || (v > 0.5 && s.dy > 8))) {
        panel.style.setProperty('--drag-y', s.dy + 'px');
        panel.style.transition = '';
        close(s.dy);
        return;
      }
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

  function phOpen(id, opener) {
    var d = $(id);
    if (!d || !isPhone() || d.open) return;
    d.style.transform = ''; d.style.transition = '';
    d._opener = opener || null;
    if (opener) opener.setAttribute('aria-expanded', 'true');
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }

  /* 200 ms slide out, then close; at once under reduced motion */
  function phClose(id) {
    var d = $(id);
    if (!d || !d.open) return;
    var shut = function () { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); };
    if (reducedMotion() || !isPhone()) { d.style.transform = ''; shut(); return; }
    if (d._phOut) return;
    d._phOut = true;
    d.style.transform = '';
    d.classList.add('is-out');
    setTimeout(function () { d._phOut = false; d.classList.remove('is-out'); d.style.removeProperty('--drag-y'); shut(); }, 200);
  }

  function renderPhAcct() {
    var b = $('phAcct');
    if (!b) return;
    var c = $('connectBtn');
    var mode, txt;
    if (!wallet.account) { mode = 'out'; txt = c ? c.textContent : 'Connect'; }
    else if (wallet.chainId !== CHAIN_ID) { mode = 'warn'; txt = shortAddr(wallet.account); }
    else if (phNums) { mode = 'in'; txt = Math.abs(phNums.available) >= 1e4 ? fmtUsdCompact(phNums.available) : fmtUsd(phNums.available); }
    else { mode = 'in'; txt = shortAddr(wallet.account); }
    var t = $('phAcctTxt');
    if (t && t.textContent !== txt) t.textContent = txt;
    b.classList.toggle('is-out', mode === 'out');
    b.classList.toggle('is-warn', mode === 'warn');
    var label = mode === 'out' ? txt : mode === 'warn' ? 'Account ' + txt + ': wrong network' : 'Account: ' + (phNums ? 'balance ' : '') + txt;
    if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
    b.setAttribute('aria-haspopup', mode === 'out' ? 'false' : 'dialog');
    var d = $('phAcctSheet');
    if (!d) return;
    var nums = d.querySelectorAll('.js-ph-num');
    for (var i = 0; i < nums.length; i++) nums[i].hidden = !phNums;
    if (phNums) {
      var set = function (c2, v, cls) { var n = d.querySelector(c2); if (n) { n.textContent = v; n.className = c2.slice(1) + (cls ? ' ' + cls : ''); } };
      set('.js-ph-bal', fmtUsd(phNums.available));
      set('.js-ph-margin', fmtUsd(phNums.margin));
      set('.js-ph-pnl', fmtUsd(phNums.pnl, true), signCls(phNums.pnl));
    }
    var a = d.querySelector('.js-ph-addr');
    if (a) { a.textContent = wallet.account ? shortAddr(wallet.account) : '—'; a.title = wallet.account || ''; }
    var ex = d.querySelector('.js-ph-explorer');
    if (ex && wallet.account) ex.href = explorer('address', wallet.account);
  }

  function initPhone() {
    ['phMenuSheet', 'phAcctSheet'].forEach(function (id) {
      var d = $(id);
      if (!d) return;
      Array.prototype.forEach.call(d.querySelectorAll('[data-close]'), function (x) { x.addEventListener('click', function () { phClose(id); }); });
      /* a tap on the scrim */
      d.addEventListener('click', function (ev) { if (ev.target === d) phClose(id); });
      d.addEventListener('cancel', function (ev) { if (isPhone() && !reducedMotion()) { ev.preventDefault(); phClose(id); } });
      d.addEventListener('close', function () {
        if (d._opener) { d._opener.setAttribute('aria-expanded', 'false'); try { d._opener.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
        d._opener = null;
      });
      sheetDrag(d, [d.querySelector('.sheet-grab'), d.querySelector('.panel-head')], function () { phClose(id); });
    });
    var menu = $('phMenu');
    if (menu) menu.addEventListener('click', function () { phOpen('phMenuSheet', menu); });
    var ms = $('phMenuSheet');
    if (ms) ms.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[aria-current="page"]') : null;
      if (a) { ev.preventDefault(); phClose('phMenuSheet'); }
    });
    var ab = $('phAcct');
    if (ab) ab.addEventListener('click', function () {
      if (!wallet.account) { connect(); return; }
      renderPhAcct();
      phOpen('phAcctSheet', ab);
    });
    var d = $('phAcctSheet');
    if (d) {
      var cp = d.querySelector('.js-ph-copy');
      if (cp) cp.addEventListener('click', function () {
        if (!wallet.account) return;
        var done = function () { toast('Copied ' + shortAddr(wallet.account) + '.'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(wallet.account).then(done, function () { toast(wallet.account); });
        else toast(wallet.account);
      });
      var dc = d.querySelector('.js-ph-disc');
      if (dc) dc.addEventListener('click', function () { phClose('phAcctSheet'); disconnect(); });
    }
    if (PHONE_MQ) {
      var leave = function () { if (!isPhone()) ['phMenuSheet', 'phAcctSheet'].forEach(function (id) { var s = $(id); if (s && s.open) s.close(); }); };
      if (PHONE_MQ.addEventListener) PHONE_MQ.addEventListener('change', leave); else if (PHONE_MQ.addListener) PHONE_MQ.addListener(leave);
    }
    renderPhAcct();
  }

  /* The points bar's Send (points.js) uses this page's wallet, as on the trade page. */
  window.ConfettiWallet = {
    account: function () { return wallet.account; },
    connect: function () { return connect(); },
    ensureChain: function () {
      if (refused) return Promise.reject(new Error(refused));
      return wallet.chainId === CHAIN_ID ? Promise.resolve() : switchChain().then(onWallet);
    },
    request: function (payload) { return (wallet.eth || getInjected()).request(payload); }
  };

  /* ---- errors and transactions ---------------------------------------------- */

  var FRIENDLY = {
    ZeroAmount: function () { return 'Amount must be more than zero.'; },
    InsufficientStake: function (a) { return 'Only ' + fmtTok(tok18(a[0])) + ' FETTI staked.'; },
    SafeERC20FailedOperation: function () { return 'Token transfer failed.'; },
    InsufficientBalance: function (a) { return 'Available is ' + fmtUsd(usd6(a[0])) + '.'; },
    UnknownPosition: function () { return 'Position already closed.'; },
    NotPositionOwner: function () { return 'Not your position.'; },
    UnknownRequest: function () { return 'Request already filled or cancelled.'; },
    TooEarly: function () { return 'Too early.'; },
    KeeperWindow: function () { return 'Keeper window. Try again in a few seconds.'; },
    RequestExpired: function () { return 'Request expired.'; },
    RequestNotExpired: function () { return 'Not expired yet.'; },
    CloseAlreadyPending: function () { return 'Close already requested.'; }
  };

  /* Error(string) reverts worth a plain line (HyperSwap's router reverts with strings). */
  var REVERT_TEXT = [
    [/INSUFFICIENT_OUTPUT_AMOUNT/, 'Price moved, raise slippage or try again.'],
    [/Router: EXPIRED/, 'Deadline passed, try again.']
  ];

  function walkError(err, fn) {
    var e = err, n = 0;
    while (e && n++ < 8) {
      if (fn(e)) return true;
      e = e.error || e.info && e.info.error || e.cause || null;
    }
    return false;
  }

  function describeError(err) {
    if (!err) return 'Something went wrong.';
    if (typeof err === 'string') return err;
    if (walkError(err, function (e) { return e.code === 4001 || e.code === 'ACTION_REJECTED' || /user (rejected|denied|cancel)/i.test(String(e.message || '')); })) return 'You cancelled in your wallet. Nothing was sent.';
    var data = null, text = null;
    walkError(err, function (e) { if (typeof e.data === 'string' && /^0x[0-9a-f]{8}/i.test(e.data)) { data = e.data; return true; } return false; });
    if (data) {
      var ifs = [stIface, cfIface, exIface, v2Iface, v3Iface];
      for (var i = 0; i < ifs.length; i++) {
        try {
          var p = ifs[i] && ifs[i].parseError(data);
          if (p && p.name === 'Error') { text = "That didn't go through: " + String(p.args[0]); break; }
          if (p) return FRIENDLY[p.name] ? FRIENDLY[p.name](p.args) : "That didn't go through, and nothing moved. (" + p.name + ')';
        } catch (e) { /* not this contract's */ }
      }
    }
    if (!text) walkError(err, function (e) {
      if (e.reason && typeof e.reason === 'string') { text = e.reason; return true; }
      if (e.shortMessage) { text = e.shortMessage; return true; }
      return false;
    });
    if (!text) text = String(err.message || err);
    for (var j = 0; j < REVERT_TEXT.length; j++) if (REVERT_TEXT[j][0].test(text)) return REVERT_TEXT[j][1];
    text = text.replace(/\s*\(.*action=.*$/s, '').replace(/^execution reverted:?\s*/i, "That didn't go through: ");
    if (/insufficient funds/i.test(text)) return 'You need a little HYPE on HyperEVM to pay network fees (about 0.01).';
    return text.length > 220 ? text.slice(0, 220) + '…' : text;
  }

  function requireSigner() {
    if (!window.ethers) throw new Error('ethers.js not loaded.');
    if (refused) throw new Error(refused);
    if (gate && !(page && page.closeOut)) throw new Error(gate);
    if (!wallet.account || !wallet.signer) throw new Error('Connect a wallet first.');
    if (wallet.chainId !== CHAIN_ID) throw new Error('Switch the wallet to HyperEVM (999) first.');
  }

  /* Dry-run with eth_call for a decoded revert reason, send, then wait for one confirmation. */
  function sendTx(desc, method, args) {
    return method.staticCall.apply(method, args).then(function () {
      return method.apply(null, args);
    }).then(function (tx) {
      var pending = toast(desc + ' sent, waiting for confirmation…', 'pending', { href: explorer('tx', tx.hash), label: shortAddr(tx.hash) }, 0);
      return tx.wait().then(function (rc) {
        dismissToast(pending);
        if (!rc || rc.status !== 1) throw new Error(desc + ' reverted on chain.');
        toast(desc + ' confirmed.', 'ok', { href: explorer('tx', tx.hash), label: shortAddr(tx.hash) });
        return rc;
      }, function (e) { dismissToast(pending); throw e; });
    });
  }

  /* ---- shared rendering ------------------------------------------------------ */

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

  /* Replace every .pos-line in host with these; the .empty line shows text when there are none. */
  function fillLines(host, lines, emptyText) {
    if (!host) return;
    var old = host.querySelectorAll('.pos-line');
    for (var i = 0; i < old.length; i++) host.removeChild(old[i]);
    var empty = host.querySelector('.empty');
    if (empty) {
      if (lines.length) empty.setAttribute('hidden', '');
      else { empty.textContent = emptyText; empty.removeAttribute('hidden'); }
    }
    var frag = document.createDocumentFragment();
    lines.forEach(function (l) { frag.appendChild(l); });
    host.appendChild(frag);
  }

  function addrLink(a, label) {
    var n = el('a', null, label || shortAddr(a));
    n.href = 'portfolio.html?addr=' + a;
    n.title = a;
    return n;
  }

  function explorerLink(kind, value, label) {
    var n = el('a', 'faint', label || shortAddr(value));
    n.href = explorer(kind, value); n.target = '_blank'; n.rel = 'noopener'; n.title = value;
    return n;
  }

  function valCell(id, text, cls, title) {
    var n = $(id);
    if (!n) return;
    n.textContent = text;
    n.className = 'kv-val' + (cls ? ' ' + cls : '');
    n.title = title || '';
  }

  function timeSpan(block) {
    var s = el('span', 'faint', blockTs[block] ? fmtTime(blockTs[block]) : '…');
    s.setAttribute('data-block', String(block));
    s.title = 'block ' + fmtInt(block);
    return s;
  }

  /* Fill in timestamps that arrived since the lines were drawn. */
  function paintTimes() {
    var cells = document.querySelectorAll('[data-block]');
    for (var i = 0; i < cells.length; i++) {
      var b = Number(cells[i].getAttribute('data-block'));
      if (blockTs[b]) cells[i].textContent = fmtTime(blockTs[b]);
    }
  }

  /* ==========================================================================
     Portfolio: open positions, history, realised PnL, fees paid, FETTI and stake
     ========================================================================== */

  function forcedAddr() {
    try {
      var a = new URLSearchParams(location.search).get('addr');
      if (a && /^0x[0-9a-fA-F]{40}$/.test(a.trim())) return window.ethers.getAddress(a.trim().toLowerCase());
    } catch (e) { /* ignore */ }
    return null;
  }

  var portfolio = (function () {
    var pf = null;

    function fresh(addr) {
      return {
        addr: addr, acct: null, positions: [], conf: null,
        rows: [], seen: {}, opened: {}, scannedTo: null, scanning: false, shown: HIST_PAGE,
        agg: { realised: 0, fees: 0, closed: 0, won: 0, liq: 0 },
        old: { v2: false, v3: false }, oldAt: 0
      };
    }

    function who() { return forcedAddr() || wallet.account || null; }

    function readAccount() {
      var ex = read.ex, a = pf.addr;
      return Promise.all([
        ex.balanceOf(a), ex.marginInUse(a), ex.pendingOf(a).catch(function () { return 0n; }), ex.positionIdsOf(a),
        read.confetti.balanceOf(a).catch(none), read.staking.stakedOf(a).catch(none), read.staking.earned(a).catch(none)
      ]).then(function (r) {
        var ids = Array.from(r[3]).map(function (x) { return BigInt(x); });
        return Promise.all(ids.map(function (id) {
          return Promise.all([ex.positions(id), ex.previewClose(id).catch(none)]);
        })).then(function (rows) {
          var positions = [];
          rows.forEach(function (row, i) {
            var p = row[0], pv = row[1];
            if (!p || p.owner === ZERO) return;
            positions.push({
              id: ids[i], instrumentId: Number(p.instrumentId), isLong: !!p.isLong, margin: usd6(p.marginUsdc),
              leverage: Number(p.leverage), entry: px18(p.entryPx18),
              /* the 1e18 entry and its spread, for the liquidation price (the phone rows) */
              entryPx18: BigInt(p.entryPx18), entryDeadbandBps: Number(p.entryDeadbandBps) || 0,
              pnl: pv ? usd6(pv[0]) : null, fee: pv ? usd6(pv[1]) : null, payout: pv ? usd6(pv[2]) : null
            });
          });
          positions.sort(function (x, y) { return x.id < y.id ? -1 : 1; });
          var instIds = [];
          positions.forEach(function (p) { if (instIds.indexOf(p.instrumentId) < 0) instIds.push(p.instrumentId); });
          return Promise.all(instIds.map(function (id) { return ex.execPrice(id, true, true).then(px18).catch(none); })).then(function (pxs) {
            var px = {};
            instIds.forEach(function (id, i) { px[id] = pxs[i]; });
            positions.forEach(function (p) { p.px = px[p.instrumentId]; });
            if (!pf || pf.addr !== a) return;
            pf.acct = { available: usd6(r[0]), margin: usd6(r[1]), pending: usd6(r[2]) };
            pf.positions = positions;
            pf.conf = { wallet: r[4] != null ? tok18(r[4]) : null, staked: r[5] != null ? tok18(r[5]) : null, earned: r[6] != null ? usd6(r[6]) : null };
          });
        });
      });
    }

    /* The v2 / v3 links show for the connected wallet while that Exchange still holds its balance,
       margin or a pending open request (a pending close keeps its position's margin in use). */
    function readOld() {
      var s = pf, a = s.addr;
      if (!wallet.account || !sameAddr(a, wallet.account)) { s.old = { v2: false, v3: false }; return Promise.resolve(); }
      if (Date.now() - s.oldAt < V2_EVERY_MS) return Promise.resolve();
      s.oldAt = Date.now();
      return Promise.all(['v2', 'v3'].map(function (k) {
        var ex = read[k];
        if (!ex) { s.old[k] = false; return null; }
        return Promise.all([ex.balanceOf(a), ex.marginInUse(a), ex.pendingOf(a)]).then(function (r) {
          s.old[k] = r[0] > 0n || r[1] > 0n || r[2] > 0n;
        });
      })).catch(function () { s.oldAt = 0; });
    }

    function addRow(p) {
      var key = p.tx + ':' + p.index;
      if (pf.seen[key]) return;
      pf.seen[key] = true;
      var a = p.args;
      if (p.name === 'PositionOpened') {
        pf.opened[String(a.positionId)] = {
          instrumentId: Number(a.instrumentId), isLong: !!a.isLong, leverage: Number(a.leverage),
          margin: usd6(a.marginUsdc), entry: px18(a.entryPx18), block: p.block
        };
      }
      if (p.name === 'PositionClosed') {
        var pnl = usd6(a.pnlUsdc);
        pf.agg.realised += pnl; pf.agg.fees += usd6(a.feeUsdc); pf.agg.closed += 1;
        if (pnl > 0) pf.agg.won += 1;
      }
      if (p.name === 'PositionLiquidated') {
        pf.agg.realised -= usd6(a.marginUsdc); pf.agg.fees += usd6(a.feeUsdc); pf.agg.closed += 1; pf.agg.liq += 1;
      }
      pf.rows.push(p);
    }

    /* Every Exchange event naming the address, from deployBlock on, read once and then followed. */
    function scanHistory() {
      var s = pf;
      if (s.scanning || head.block == null) return Promise.resolve();
      var from = s.scannedTo != null ? s.scannedTo + 1 : deployBlock();
      var to = head.block;
      if (from > to) return Promise.resolve();
      s.scanning = true;
      var user = window.ethers.zeroPadValue(s.addr, 32);
      var ex = cfg.contracts.exchange;
      var t = function (n) { return topic(exIface, n); };
      return scanLogs([
        { address: ex, topics: [[t('Deposited'), t('Withdrawn')], user] },
        { address: ex, topics: [[t('PositionOpened'), t('PositionClosed'), t('PositionLiquidated'), t('OpenRequestCancelled'), t('QueueAppended'), t('QueuePaid')], null, user] }
      ], from, to).then(function (logs) {
        s.scanning = false;
        if (pf !== s) return;
        logs.map(function (l) { return parseLog(exIface, l); }).filter(Boolean)
          .sort(function (x, y) { return x.block - y.block || x.index - y.index; })
          .forEach(addRow);
        s.rows.sort(function (x, y) { return y.block - x.block || y.index - x.index; });
        s.scannedTo = to;
      }, function (e) { s.scanning = false; throw e; });
    }

    function positionLine(p) {
      var sz = szOf(p.instrumentId);
      var line = el('div', 'pos-line');
      line.appendChild(el('span', 'sym', symOf(p.instrumentId)));
      line.appendChild(el('span', 'faint xs', '#' + p.id));
      line.appendChild(el('span', p.isLong ? 'pos' : 'neg', sideLev(p.isLong, p.leverage)));
      var m = el('span', null, fmtUsd(p.margin)); m.title = 'margin · size ' + fmtUsd(p.margin * p.leverage);
      line.appendChild(m);
      var e = el('span', null, fmtPrice(p.entry, sz)); e.title = 'entry';
      line.appendChild(e);
      var x = el('span', 'faint', '→ ' + fmtPrice(p.px, sz)); x.title = 'oracle now';
      line.appendChild(x);
      var pnl = el('span', signCls(p.pnl), p.pnl != null ? fmtUsd(p.pnl, true) : '—');
      if (p.payout != null) pnl.title = 'a close now pays ' + fmtUsd(p.payout) + (p.fee ? ' · fee ' + fmtUsd(p.fee) : '');
      line.appendChild(pnl);
      line.appendChild(el('span', 'grow'));
      var go = el('a', 'btn btn-sm btn-ghost', 'Trade');
      go.href = 'trade.html#' + encodeURIComponent(symOf(p.instrumentId));
      line.appendChild(go);
      return line;
    }

    /* Phones: the trade page's 64 px row (build 10's markup: side tag, coin, leverage, the P&L
       and its %, the 6 px liquidation bar and the distance, in liqRoom's colours), as one link
       to trade.html#pos=<id>, where the Position sheet holds Entry, Now, Put in, Size and the
       close. What a close pays now ('a close now pays') stays as the row's title and in its label. */
    function phRowEl(p) {
      var sz = szOf(p.instrumentId), sym = symOf(p.instrumentId);
      var a = el('a', 'ph-row ' + (p.isLong ? 'is-long' : 'is-short'));
      a.href = 'trade.html#pos=' + String(p.id);
      a.setAttribute('data-pid', String(p.id));
      var who = el('span', 'ph-row-who');
      who.appendChild(el('span', 'ph-side', p.isLong ? 'LONG' : 'SHORT'));
      who.appendChild(el('span', 'ph-sym', sym));
      who.appendChild(el('span', 'ph-lev', p.leverage + 'x'));
      a.appendChild(who);
      var known = p.pnl != null && isFinite(p.pnl);
      var cls = known ? signCls(p.pnl) : '';
      var money = el('span', 'ph-money');
      money.appendChild(el('span', 'ph-pnl-n' + (cls ? ' ' + cls : ''), known ? fmtUsd(p.pnl, true) : '—'));
      money.appendChild(el('span', 'ph-pct' + (cls ? ' ' + cls : ''), known ? fmtPct1(p.pnl / p.margin) : ''));
      a.appendChild(money);
      var room = liqRoom(p, p.px);
      var full = bustMovePct(p.leverage) / 100;
      var share = isFinite(room.away) && full > 0 ? clamp(room.away / full, 0, 1) : NaN;
      var tone = room.cls === 'is-red' ? ' is-red' : room.cls === 'is-amber' ? ' is-amber' : '';
      var liq = el('span', 'ph-row-liq');
      var bar = el('span', 'ph-bar' + tone); bar.setAttribute('aria-hidden', 'true');
      var fill = el('i'); fill.style.width = isFinite(share) ? (share * 100).toFixed(1) + '%' : '0%';
      bar.appendChild(fill);
      liq.appendChild(bar);
      liq.appendChild(el('span', 'ph-away' + tone, isFinite(room.away) ? fmtAway(room.away) + ' away' : 'Liquidation —'));
      a.appendChild(liq);
      if (room.cls === 'is-red') a.classList.add('is-near');
      if (p.payout != null) a.title = 'a close now pays about ' + fmtUsd(p.payout) + (p.fee ? ' · fee ' + fmtUsd(p.fee) : '');
      a.setAttribute('aria-label', (p.isLong ? 'Long' : 'Short') + ' ' + sym + ' ' + p.leverage + 'x. ' +
        (known ? 'P&L ' + fmtUsd(p.pnl, true) + ', ' + fmtPct1(p.pnl / p.margin) + '. ' : '') +
        'Entry ' + fmtPrice(p.entry, sz) + ', now ' + fmtPrice(p.px, sz) +
        (isFinite(room.liq) ? ', liquidation ' + fmtPrice(room.liq, sz) + (isFinite(room.away) ? ', ' + fmtAway(room.away) + ' away' : '') : '') +
        '. Put in ' + fmtUsd(p.margin) + ', size ' + fmtUsd(p.margin * p.leverage) + '.' +
        (p.payout != null ? ' A close now pays about ' + fmtUsd(p.payout) + '.' : '') + ' Opens this position on the trade page.');
      return a;
    }

    function renderPhRows(list) {
      var host = $('pfRows');
      if (!host) return;
      host.textContent = '';
      list.forEach(function (p) { host.appendChild(phRowEl(p)); });
    }

    function describe(r) {
      var a = r.args;
      var d = { label: r.name.toLowerCase(), market: null, id: null, side: null, amount: null, signed: true, details: '' };
      function byPid() {
        d.id = String(a.positionId);
        var o = pf.opened[d.id];
        if (o) { d.market = symOf(o.instrumentId); d.side = sideLev(o.isLong, o.leverage); }
      }
      switch (r.name) {
        case 'Deposited':
          d.label = 'deposit'; d.amount = usd6(a.amountUsdc);
          if (String(a.payer).toLowerCase() === String(cfg.contracts.staking).toLowerCase()) d.label = 'dividend';
          else if (String(a.payer).toLowerCase() !== pf.addr.toLowerCase()) d.details = 'from ' + shortAddr(a.payer);
          break;
        case 'Withdrawn':
          d.label = 'withdraw'; d.amount = -usd6(a.amountUsdc);
          break;
        case 'PositionOpened':
          d.label = 'opened'; d.id = String(a.positionId); d.market = symOf(Number(a.instrumentId));
          d.side = sideLev(a.isLong, a.leverage); d.amount = usd6(a.marginUsdc); d.signed = false;
          d.details = 'margin ' + fmtUsd(usd6(a.marginUsdc)) + ' · entry ' + fmtPrice(px18(a.entryPx18));
          break;
        case 'PositionClosed':
          d.label = 'closed'; byPid(); d.amount = usd6(a.pnlUsdc);
          d.details = 'exit ' + fmtPrice(px18(a.exitPx18)) + ' · paid ' + fmtUsd(usd6(a.payoutUsdc));
          if (a.queuedUsdc > 0n) d.details += ' · queued ' + fmtUsd(usd6(a.queuedUsdc));
          if (a.feeUsdc > 0n) d.details += ' · fee ' + fmtUsd(usd6(a.feeUsdc));
          if (a.borrowUsdc > 0n) d.details += ' · borrow ' + fmtUsd(usd6(a.borrowUsdc));
          break;
        case 'PositionLiquidated':
          d.label = 'liquidated'; byPid(); d.amount = -usd6(a.marginUsdc);
          d.details = 'exit ' + fmtPrice(px18(a.exitPx18)) + ' · fee ' + fmtUsd(usd6(a.feeUsdc));
          break;
        case 'QueueAppended':
          d.label = 'queued'; d.amount = usd6(a.amountUsdc); d.signed = false; d.details = 'entry #' + a.index + ' · owed';
          break;
        case 'QueuePaid':
          d.label = 'queue paid'; d.amount = usd6(a.paidUsdc); d.details = 'entry #' + a.index + ' · ' + fmtUsd(usd6(a.remainingUsdc)) + ' remaining';
          break;
        case 'OpenRequestCancelled':
          d.label = 'refunded'; d.id = 'r' + String(a.requestId);
          break;
      }
      return d;
    }

    /* Phones: the outcome first (piece 12). Line 1 is what happened and to which position, with
       the money on the right (coloured for P&L); line 2 the price, what came back and when; a
       liquidation adds its one plain sentence. The whole row is the transaction's explorer link;
       a win keeps Share. The same component, in the same words, as the trade page's rows
       (trade.js phHistoryLine). Every field today's line shows is here or in the row's title. */
    function phHistoryLine(r) {
      var a = r.args, d = describe(r);
      var o = d.id ? pf.opened[d.id] : null;
      var sz = o ? szOf(o.instrumentId) : (r.name === 'PositionOpened' ? szOf(Number(a.instrumentId)) : null);
      var what = { deposit: 'Deposit', dividend: 'Dividend', withdraw: 'Withdrawal', opened: 'Opened', closed: 'Closed', liquidated: 'Liquidated', queued: 'Win owed', 'queue paid': 'Owed win paid', refunded: 'Refunded' }[d.label] || d.label;
      var side = d.side ? d.side.charAt(0).toUpperCase() + d.side.slice(1) : null;
      var parts = [], sentence = null, cls = '';
      switch (r.name) {
        case 'Deposited': if (d.details) parts.push(d.details); break;
        case 'PositionOpened': parts.push('at ' + fmtPrice(px18(a.entryPx18), sz)); break;
        case 'PositionClosed':
          parts.push((o ? fmtPrice(o.entry, sz) + ' → ' : 'at ') + fmtPrice(px18(a.exitPx18), sz));
          parts.push(fmtUsd(usd6(a.payoutUsdc)) + ' back');
          if (a.feeUsdc > 0n && a.pnlUsdc > 0n) parts.push('fee ' + fmtUsd(usd6(a.feeUsdc)));
          if (a.borrowUsdc > 0n) parts.push('borrow ' + fmtUsd(usd6(a.borrowUsdc)));
          if (a.queuedUsdc > 0n) parts.push(fmtUsd(usd6(a.queuedUsdc)) + ' owed');
          cls = d.amount > 0 ? ' is-win' : d.amount < 0 ? ' is-loss' : '';
          break;
        case 'PositionLiquidated':
          parts.push('at ' + fmtPrice(px18(a.exitPx18), sz));
          if (a.feeUsdc > 0n) parts.push('fee ' + fmtUsd(usd6(a.feeUsdc)));
          sentence = 'You lost the ' + fmtUsdShort(usd6(a.marginUsdc)) + ' you put in. Nothing more is owed.';
          cls = ' is-liq';
          break;
        case 'QueueAppended': parts.push('paid automatically'); break;
        case 'QueuePaid': if (a.remainingUsdc > 0n) parts.push(fmtUsd(usd6(a.remainingUsdc)) + ' still owed'); break;
        case 'OpenRequestCancelled': parts.push("didn't open"); break;
      }
      var line = el('div', 'pos-line hist-line ph-hist' + cls);
      if (d.id) line.title = (d.id.charAt(0) === 'r' ? 'Request #' : 'Position #') + d.id.replace(/^r/, '') + (d.details ? ' · ' + d.details : '');
      var link = !!(r.tx && !DEMO);
      var main = el(link ? 'a' : 'span', 'ph-hist-main');
      if (link) { main.href = explorer('tx', r.tx); main.target = '_blank'; main.rel = 'noopener'; main.title = r.tx; }
      var top = el('span', 'ph-hist-top');
      var w = el('span', 'ph-hist-what', what + ' ');
      if (d.market) { w.appendChild(el('b', null, d.market)); if (side) w.appendChild(document.createTextNode(' ' + side)); }
      top.appendChild(w);
      if (d.amount != null) top.appendChild(el('b', 'ph-hist-money' + (d.signed ? (d.amount > 0 ? ' pos' : d.amount < 0 ? ' neg' : '') : ''), fmtUsd(d.amount, d.signed)));
      main.appendChild(top);
      var sub = el('span', 'ph-hist-sub');
      if (parts.length) sub.appendChild(document.createTextNode(parts.join(' · ') + ' · '));
      var time = timeSpan(r.block);
      time.className = 'ph-hist-time';
      sub.appendChild(time);
      main.appendChild(sub);
      if (sentence) main.appendChild(el('span', 'ph-hist-say', sentence));
      line.appendChild(main);
      if (r.name === 'PositionClosed' && d.amount > 0 && o && window.ConfettiShare && wallet.account && sameAddr(pf.addr, wallet.account)) {
        var share = el('button', 'ph-hist-share', 'Share');
        share.type = 'button'; share.title = 'Share your win';
        share.addEventListener('click', function (ev) { ev.preventDefault(); window.ConfettiShare.open(shareTrade(r, o)); });
        line.appendChild(share);
      }
      return line;
    }

    function historyLine(r) {
      if (isPhone()) return phHistoryLine(r);
      var d = describe(r);
      var line = el('div', 'pos-line');
      if (d.details) line.title = d.details;
      line.appendChild(timeSpan(r.block));
      line.appendChild(el('span', null, d.label));
      if (d.market) line.appendChild(el('span', 'sym', d.market));
      if (d.id) line.appendChild(el('span', 'faint xs', '#' + d.id));
      if (d.side) line.appendChild(el('span', d.side.charAt(0) === 'l' ? 'pos' : 'neg', d.side));
      if (d.amount != null) line.appendChild(el('span', d.signed ? signCls(d.amount) : '', fmtUsd(d.amount, d.signed)));
      var o = r.name === 'PositionClosed' && d.amount > 0 ? pf.opened[d.id] : null;
      if (o && window.ConfettiShare && wallet.account && sameAddr(pf.addr, wallet.account)) {
        var share = el('a', 'faint', 'share');
        share.href = '#'; share.setAttribute('role', 'button'); share.title = 'Share your win';
        share.addEventListener('click', function (ev) {
          ev.preventDefault();
          window.ConfettiShare.open(shareTrade(r, o));
        });
        line.appendChild(share);
      }
      line.appendChild(el('span', 'grow'));
      line.appendChild(explorerLink('tx', r.tx));
      return line;
    }

    /* A block's timestamp; one retry (the public RPC rate-limits), then null: the card goes without its chart */
    function timeOf(b) {
      if (blockTs[b] != null) return Promise.resolve(blockTs[b]);
      function get() {
        return read.provider.getBlock(b).then(function (blk) {
          if (!blk) throw new Error('block ' + b + ' not found');
          blockTs[b] = Number(blk.timestamp);
          return blockTs[b];
        });
      }
      return get().catch(function () {
        return new Promise(function (ok) { setTimeout(ok, 1500); }).then(get);
      }).catch(function () { return null; });
    }

    /* What the share card needs for one winning close: r its PositionClosed row, o its open (pf.opened) */
    function shareTrade(r, o) {
      var addr = pf.addr;
      return Promise.all([timeOf(o.block), timeOf(r.block)]).then(function (ts) {
        var inst = mk.byInstId[o.instrumentId];
        return {
          id: String(r.args.positionId), sym: symOf(o.instrumentId), coin: inst ? inst.coin : null, szDecimals: inst ? inst.szDecimals : null,
          side: o.isLong ? 'long' : 'short', lev: o.leverage, margin: o.margin, entry: o.entry,
          exit: px18(r.args.exitPx18), pnl: usd6(r.args.pnlUsdc), openTs: ts[0], closeTs: ts[1], account: addr
        };
      });
    }

    function render() {
      var sub = $('pfWho');
      if (sub) {
        sub.textContent = '';
        if (pf) {
          /* phones: the short form (the full address is the link's title and in the Account sheet) */
          sub.appendChild(explorerLink('address', pf.addr, isPhone() ? shortAddr(pf.addr) : pf.addr));
          if (forcedAddr() && (!wallet.account || wallet.account.toLowerCase() !== pf.addr.toLowerCase())) sub.appendChild(document.createTextNode(' · viewing'));
        }
      }
      ['v2', 'v3'].forEach(function (k) {
        var l = $(k === 'v2' ? 'pfV2' : 'pfV3');
        if (l) l.hidden = !(pf && pf.old[k] && wallet.account && sameAddr(pf.addr, wallet.account));
      });
      var ids = ['pfAvail', 'pfMargin', 'pfOpenPnl', 'pfEquity', 'pfRealised', 'pfFees', 'pfClosed', 'pfConf', 'pfStaked', 'pfEarned'];
      if (!pf) {
        if (phNums) { phNums = null; renderPhAcct(); }
        ids.forEach(function (id) { valCell(id, '—'); });
        renderPhRows([]);
        fillLines($('pfOpen'), [], 'Connect a wallet to see your portfolio.');
        fillLines($('pfHist'), [], 'Connect a wallet to see your history.');
        setText('pfOpenCount', ''); setText('pfHistCount', '');
        var mb = $('pfMore'); if (mb) mb.hidden = true;
        setText('pfRange', '');
        return;
      }
      var openPnl = null;
      pf.positions.forEach(function (p) { if (p.pnl != null) openPnl = (openPnl || 0) + p.pnl; });
      if (pf.acct) {
        valCell('pfAvail', fmtUsd(pf.acct.available));
        valCell('pfMargin', fmtUsd(pf.acct.margin + pf.acct.pending), '', pf.acct.pending > 0 ? fmtUsd(pf.acct.pending) + ' of it in requests still filling' : '');
        valCell('pfOpenPnl', pf.positions.length ? fmtUsd(openPnl || 0, true) : fmtUsd(0), signCls(openPnl || 0));
        valCell('pfEquity', fmtUsd(pf.acct.available + pf.acct.margin + pf.acct.pending + (openPnl || 0)));
        /* the phone header's balance and Account sheet: only for the connected wallet's own portfolio */
        phNums = wallet.account && sameAddr(pf.addr, wallet.account) ? { available: pf.acct.available, margin: pf.acct.margin + pf.acct.pending, pnl: openPnl || 0 } : null;
        renderPhAcct();
      }
      if (pf.conf) {
        valCell('pfConf', fmtTok(pf.conf.wallet));
        valCell('pfStaked', fmtTok(pf.conf.staked));
        valCell('pfEarned', fmtUsd(pf.conf.earned), '', 'USDC; claims land in your wallet');
      }
      var done = pf.scannedTo != null;
      valCell('pfRealised', done ? fmtUsd(pf.agg.realised, true) : '…', done ? signCls(pf.agg.realised) : '', 'closes and liquidations, after fees');
      valCell('pfFees', done ? fmtUsd(pf.agg.fees) : '…');
      valCell('pfClosed', done ? fmtInt(pf.agg.closed) + ' · ' + fmtInt(pf.agg.won) + ' won' + (pf.agg.liq ? ' · ' + fmtInt(pf.agg.liq) + ' liquidated' : '') : '…');

      setText('pfOpenCount', pf.positions.length ? String(pf.positions.length) : '');
      fillLines($('pfOpen'), pf.positions.map(positionLine), pf.acct ? 'No open positions.' : 'Loading…');
      renderPhRows(pf.positions);

      var shown = pf.rows.slice(0, pf.shown);
      setText('pfHistCount', pf.rows.length ? String(pf.rows.length) : '');
      fillLines($('pfHist'), shown.map(historyLine), done ? 'No events yet.' : 'Scanning events…');
      var more = $('pfMore');
      if (more) more.hidden = pf.rows.length <= pf.shown;
      setText('pfRange', done ? 'blocks ' + fmtInt(deployBlock()) + ' to ' + fmtInt(pf.scannedTo) : '');
      fetchTimes(shown.map(function (r) { return r.block; })).then(paintTimes);
    }

    function refresh() {
      if (!pf || DEMO) { render(); return Promise.resolve(); }
      var s = pf;
      return readHead().then(function () {
        return Promise.all([
          readAccount().catch(function (e) {
            if (!s.acct && !s.warned) { s.warned = true; toast('Could not read the account: ' + describeError(e), 'err'); }
          }),
          scanHistory().catch(function () { /* retried on the next poll */ }),
          readOld()
        ]);
      }).catch(function () { /* transient RPC trouble: keep the last values */ }).then(render);
    }

    function onAccount() {
      var a = who();
      if (pf && a && pf.addr.toLowerCase() === a.toLowerCase()) return;
      pf = a ? fresh(a) : null;
      render();
      refresh();
    }

    function init() {
      if (window.ConfettiShare) window.ConfettiShare.use({ postInfo: postInfo });
      var more = $('pfMore');
      if (more) more.addEventListener('click', function () { if (pf) { pf.shown += HIST_PAGE; render(); } });
      /* crossing 640 px (a rotate, a resize) redraws the lists in the other layout */
      if (PHONE_MQ) {
        var relayout = function () { render(); };
        if (PHONE_MQ.addEventListener) PHONE_MQ.addEventListener('change', relayout); else if (PHONE_MQ.addListener) PHONE_MQ.addListener(relayout);
      }
      var a = who();
      pf = a ? fresh(a) : null;
      render();
    }

    /* The local demo (DEMO, 127.0.0.1 only; the page boot calls this instead of the chain), for the
       phone previews (piece 12): ?demo=1 is the spec's trader signed in ($50 available, $20 in two
       positions: a WIF short 50x in loss with its liquidation getting close, a DOGE long 20x in
       profit; a history with a win, a loss, a liquidation, the two opens and the deposit; 12,000
       FETTI, 8,000 staked, $3.12 unclaimed), ?demo=out is signed out. Fixed prices and clock hours,
       so two runs on one day draw the same page. No exchange check, no chain read, no wallet;
       nothing is sent. The same gate as the $FETTI page's demo. */
    function demoBoot() {
      var E = window.ethers;
      /* the markets as loadInstruments indexes them: config order, so DOGE is 0 and WIF is 3 */
      mk.byInstId = {}; mk.list = [];
      (cfg.markets || []).forEach(function (m, i) {
        var inst = { id: i, sym: m.symbol, coin: m.coin || m.symbol, szDecimals: Number(m.szDecimals) || 0, tier: m.tier || 'A', maxLeverage: Number(m.maxLeverage) || 1, longCap: 1000000, shortCap: 1000000, opensPaused: false, retired: false };
        mk.byInstId[i] = inst; mk.list.push(inst);
      });
      mk.loaded = true;
      if (DEMO !== '1') {
        pf = null; render();
        toast('Demo: signed out, on this computer. Nothing is read or sent.', null, null, 6000);
        return;
      }
      var me = E.getAddress('0xde00000000000000000000000000000000000001');
      wallet.account = me; wallet.chainId = CHAIN_ID; wallet.signer = { demo: true };
      var bySym = {}; mk.list.forEach(function (i) { bySym[i.sym] = i.id; });
      var doge = bySym.DOGE != null ? bySym.DOGE : 0, wif = bySym.WIF != null ? bySym.WIF : 3;
      var u6 = function (v) { return BigInt(Math.round(v * 1e6)); };
      var p18 = function (x) { return BigInt(Math.round(x * 1e12)) * 1000000n; };
      var s = fresh(me);
      s.acct = { available: 50, margin: 20, pending: 0 };
      s.conf = { wallet: 12000, staked: 8000, earned: 3.12 };
      var pd = 0.080438, pw = 0.20259;  /* the prices now */
      s.positions = [
        { id: 11n, instrumentId: doge, isLong: true, margin: 10, leverage: 20, entry: 0.08, entryPx18: p18(0.08), entryDeadbandBps: 1, px: pd, pnl: 1.09, fee: 0.05, payout: 11.04 },
        { id: 12n, instrumentId: wif, isLong: false, margin: 10, leverage: 50, entry: 0.2003, entryPx18: p18(0.2003), entryDeadbandBps: 1, px: pw, pnl: -5.74, fee: 0, payout: 4.26 }
      ];
      /* the history, oldest first: the deposit, a win, a loss, a liquidation, then the two opens */
      var noon = new Date(); noon.setHours(12, 0, 0, 0);
      var day = Math.floor(noon.getTime() / 1000), block = 50500000, n = 0;
      var hash = function () { n += 1; return '0x' + ('de' + String(n)).padStart(64, '0'); };
      var row = function (name, args, ago) {
        block += 1; blockTs[block] = day - ago;
        return { name: name, args: args, block: block, index: 0, tx: hash(), address: String(cfg.contracts.exchange).toLowerCase() };
      };
      var opened = function (pid, inst, isLong, lev, entry, ago) {
        var r = row('PositionOpened', { positionId: BigInt(pid), owner: me, instrumentId: inst, isLong: isLong, marginUsdc: u6(10), leverage: lev, entryPx18: p18(entry), requestId: BigInt(pid), keeperFill: true }, ago);
        s.opened[String(pid)] = { instrumentId: inst, isLong: isLong, leverage: lev, margin: 10, entry: entry, block: r.block };
        return r;
      };
      var H = 3600, D = 86400;
      var rows = [
        row('Deposited', { user: me, payer: me, amountUsdc: u6(70) }, 5 * D + 3 * H),
        opened(7, doge, true, 50, 0.076, 4 * D + 2 * H),
        row('PositionClosed', { positionId: 7n, owner: me, exitPx18: p18(0.079), pnlUsdc: u6(19.74), feeUsdc: u6(0.99), payoutUsdc: u6(28.75), queuedUsdc: 0n, borrowUsdc: 0n, keeperFill: true }, 4 * D + 40 * 60),
        opened(8, wif, false, 50, 0.21, 3 * D + 1 * H),
        row('PositionClosed', { positionId: 8n, owner: me, exitPx18: p18(0.2109), pnlUsdc: -u6(2.14), feeUsdc: u6(0.11), payoutUsdc: u6(7.75), queuedUsdc: 0n, borrowUsdc: 0n, keeperFill: true }, 3 * D + 10 * 60),
        opened(9, doge, true, 50, 0.082, 2 * D + 4 * H),
        row('PositionLiquidated', { positionId: 9n, owner: me, liquidator: me, exitPx18: p18(0.080442), marginUsdc: u6(10), bountyUsdc: u6(0.05), feeUsdc: 0n }, 2 * D + 3 * H + 25 * 60),
        opened(11, doge, true, 20, 0.08, 2 * H + 20 * 60),
        opened(12, wif, false, 50, 0.2003, 8 * 60)
      ];
      rows.forEach(function (r) { s.seen[r.tx + ':' + r.index] = true; });
      s.rows = rows.slice().reverse();
      s.agg = { realised: 19.74 - 2.14 - 10, fees: 0.99 + 0.11, closed: 3, won: 1, liq: 1 };
      s.scannedTo = block;
      head.block = block;
      pf = s;
      renderWallet();
      render();
      toast('Demo: a pretend account on this computer. Nothing is sent.', null, null, 6000);
    }

    return { init: init, refresh: refresh, onAccount: onAccount, demo: demoBoot, every: EVERY_MS.portfolio };
  })();

  /* ==========================================================================
     House: house cash, fee pool, payout queue, book room, OI and limits by market, breaker,
     keeper, house deposits / withdrawals
     ========================================================================== */

  var housePage = (function () {
    var h = { v: null, oi: {}, queue: [], keeper: null, keeperAt: 0, bots: null, botsAt: 0, moves: [], seen: {}, scannedTo: null };

    /* The house bots' own open interest per instrument, taken out of the public numbers. */
    function loadBotOi() {
      if (!hbots.n || Date.now() - h.botsAt < HBOT_EVERY_MS) return Promise.resolve();
      h.botsAt = Date.now();
      var ex = read.ex, next = {};
      return Object.keys(hbots.idx).reduce(function (chain, a) {
        return chain.then(function () {
          return ex.positionIdsOf(a).then(function (ids) {
            return Promise.all(Array.from(ids).map(function (id) { return ex.positions(id); })).then(function (ps) {
              ps.forEach(function (p) {
                if (!p || p.owner === ZERO) return;
                var o = next[Number(p.instrumentId)] || (next[Number(p.instrumentId)] = { long: 0, short: 0 });
                o[p.isLong ? 'long' : 'short'] += usd6(p.marginUsdc) * Number(p.leverage);
              });
            });
          });
        });
      }, Promise.resolve()).then(function () { h.bots = next; }, function () { h.botsAt = 0; });
    }

    function readHouse() {
      var ex = read.ex;
      return Promise.all([
        ex.lpBalance(), ex.feePool(), ex.queuedTotal(), ex.queueLength(), ex.queueHead(), ex.globalOpensPaused(),
        ex.breakerTripped(), ex.breakerBps(), ex.breakerFloorUsdc(), ex.breakerWindow().catch(none),
        ex.openMaxPayoutUsdc().catch(none), ex.houseFreeUsdc(), ex.houseExposureUsdc(), ex.rhoBps()
      ]).then(function (r) {
        /* An open must keep exposure <= free * rhoBps / 10000 (IExchange): room is what is left of that. */
        var free = BigInt(r[11]), exposure = BigInt(r[12]), cap = free * BigInt(r[13]) / 10000n;
        h.v = {
          lp: usd6(r[0]), feePool: usd6(r[1]), queued: usd6(r[2]), queueLen: Number(r[3]), queueHead: Number(r[4]),
          paused: !!r[5], tripped: !!r[6], breakerBps: Number(r[7]), floor: usd6(r[8]),
          window: r[9] ? { start: Number(r[9][0]), startLp: usd6(r[9][1]), outflow: usd6(r[9][2]) } : null,
          maxPayout: r[10] != null ? usd6(r[10]) : null,
          free: usd6(free), exposure: usd6(exposure), rhoBps: Number(r[13]), room: usd6(cap > exposure ? cap - exposure : 0n)
        };
        var idx = [];
        for (var i = h.v.queueHead; i < Math.min(h.v.queueLen, h.v.queueHead + QUEUE_ROWS); i++) idx.push(i);
        return Promise.all([
          Promise.all(idx.map(function (i) { return ex.queueEntry(i).then(function (q) { return { index: i, to: q[0], owed: usd6(q[1]) }; }); })),
          Promise.all(mk.list.map(function (m) {
            return Promise.all([ex.openInterest(m.id), ex.maxPositionUsd(m.id, true).catch(none), ex.maxPositionUsd(m.id, false).catch(none)]).then(function (o) {
              return { id: m.id, long: usd6(o[0][0]), short: usd6(o[0][1]), maxLong: o[1] != null ? usd6(o[1]) : null, maxShort: o[2] != null ? usd6(o[2]) : null };
            });
          }))
        ]);
      }).then(function (r) {
        h.queue = r[0];
        h.oi = {};
        r[1].forEach(function (o) { h.oi[o.id] = o; });
      });
    }

    /* HouseDeposited / HouseWithdrawn on the Exchange from deployBlock, newest first. */
    function scanMoves() {
      var from = h.scannedTo != null ? h.scannedTo + 1 : deployBlock();
      return readHead().then(function (to) {
        if (from > to) return;
        return scanLogs([{ address: cfg.contracts.exchange, topics: [[topic(exIface, 'HouseDeposited'), topic(exIface, 'HouseWithdrawn')]] }], from, to).then(function (logs) {
          logs.map(function (l) { return parseLog(exIface, l); }).filter(Boolean).forEach(function (p) {
            var key = p.tx + ':' + p.index;
            if (h.seen[key]) return;
            h.seen[key] = true;
            h.moves.push({ block: p.block, index: p.index, tx: p.tx, out: p.name === 'HouseWithdrawn', amount: usd6(p.args.amountUsdc), after: usd6(p.args.lpAfterUsdc) });
          });
          h.moves.sort(function (x, y) { return y.block - x.block || y.index - x.index; });
          h.scannedTo = to;
        });
      }).then(function () {
        return fetchTimes(h.moves.slice(0, QUEUE_ROWS).map(function (m) { return m.block; }));
      });
    }

    function moveLine(m) {
      var line = el('div', 'pos-line');
      line.appendChild(timeSpan(m.block));
      line.appendChild(el('span', m.out ? 'neg' : 'pos', (m.out ? 'withdrawn ' : 'deposited ') + fmtUsd(m.amount)));
      line.appendChild(el('span', 'faint', 'house ' + fmtUsd(m.after)));
      line.appendChild(el('span', 'grow'));
      line.appendChild(explorerLink('tx', m.tx));
      return line;
    }

    function publicOi(id) {
      var o = h.oi[id];
      if (!o) return null;
      if (!hbots.n) return o;
      if (!h.bots) return null;
      var b = h.bots[id] || { long: 0, short: 0 };
      return { long: Math.max(0, o.long - b.long), short: Math.max(0, o.short - b.short) };
    }

    function oiLine(m) {
      var o = publicOi(m.id);
      var line = el('div', 'pos-line');
      line.appendChild(el('span', 'sym', m.sym));
      line.appendChild(el('span', 'badge badge-' + m.tier.toLowerCase(), m.tier));
      var l = el('span', 'pos', 'long ' + (o ? fmtUsdCompact(o.long) : '—'));
      var s = el('span', 'neg', 'short ' + (o ? fmtUsdCompact(o.short) : '—'));
      line.appendChild(l); line.appendChild(s);
      line.appendChild(el('span', 'faint', 'cap ' + (m.longCap === m.shortCap ? fmtUsdCompact(m.longCap) : fmtUsdCompact(m.longCap) + ' / ' + fmtUsdCompact(m.shortCap))));
      line.appendChild(el('span', 'faint', 'x' + m.maxLeverage));
      var lim = h.oi[m.id];
      if (lim && !m.retired) line.appendChild(el('span', 'faint', 'max ' + (lim.maxLong != null ? fmtUsdCompact(lim.maxLong) : '—') + ' / ' + (lim.maxShort != null ? fmtUsdCompact(lim.maxShort) : '—')));
      line.appendChild(el('span', 'grow'));
      if (m.retired) line.appendChild(el('span', 'faint', 'retired'));
      else if (m.opensPaused) line.appendChild(el('span', 'neg', 'opens paused'));
      return line;
    }

    function queueLine(q) {
      var line = el('div', 'pos-line');
      line.appendChild(el('span', 'faint xs', '#' + q.index));
      line.appendChild(addrLink(q.to));
      line.appendChild(el('span', null, fmtUsd(q.owed)));
      return line;
    }

    function render() {
      var v = h.v;
      if (v) {
        valCell('hsLp', fmtUsd(v.lp), '', 'USDC the house pays from');
        valCell('hsFeePool', fmtUsd(v.feePool), '', 'fees not yet pushed to stakers and the fee recipient');
        valCell('hsFree', fmtUsd(v.free), '', 'house cash less the queue and the fee pool');
        valCell('hsExposure', fmtUsd(v.exposure));
        valCell('hsRoom', fmtUsd(v.room), v.room > 0 ? '' : 'neg', 'exposure allowed: ' + (v.rhoBps / 100).toFixed(v.rhoBps % 100 ? 2 : 0) + '% of free cash');
        valCell('hsMaxPayout', v.maxPayout != null ? fmtUsd(v.maxPayout) : '—', v.maxPayout != null ? '' : 'faint',
          v.maxPayout != null ? 'if every open position closed at its cap' : '');
        valCell('hsQueued', fmtUsd(v.queued));
        valCell('hsQueueLen', fmtInt(v.queueLen - v.queueHead) + ' live · ' + fmtInt(v.queueLen) + ' ever');
        valCell('hsOpens', v.paused || v.tripped ? 'paused' : 'open', v.paused || v.tripped ? 'neg' : 'pos');
        valCell('hsBreaker', v.tripped ? 'tripped · opens paused' : (v.breakerBps >= 10000 ? 'off' : 'armed'), v.tripped ? 'neg' : '');
        var threshold = v.window ? Math.max(v.window.startLp * v.breakerBps / 1e4, v.floor) : null;
        valCell('hsTrips', v.breakerBps >= 10000 ? (v.tripped ? 'off · opens paused' : 'never') : (v.breakerBps / 100).toFixed(v.breakerBps % 100 ? 2 : 0) + '% of hour-start free cash · floor ' + fmtUsd(v.floor), '',
          'opens pause when net house outflow in a one-hour window passes the larger of the two');
        valCell('hsOutflow', v.window && v.window.start ? fmtUsd(v.window.outflow, true) + ' of ' + fmtUsd(threshold) : '—',
          v.window && v.window.outflow > 0 ? 'neg' : '', v.window && v.window.start ? 'window opened ' + fmtTime(v.window.start) + ' at ' + fmtUsd(v.window.startLp) : '');
      }
      renderKeeper();

      var mlist = mk.list.filter(function (m) { return !m.retired || (h.oi[m.id] && (h.oi[m.id].long || h.oi[m.id].short)); });
      var totL = 0, totS = 0, all = true;
      mlist.forEach(function (m) { var o = publicOi(m.id); if (o) { totL += o.long; totS += o.short; } else all = false; });
      setText('hsOiTotal', all && mlist.length ? 'long ' + fmtUsdCompact(totL) + ' · short ' + fmtUsdCompact(totS) : '');
      fillLines($('hsOi'), mlist.map(oiLine), mk.loaded ? 'No markets on chain.' : 'Loading…');
      setText('hsQueueCount', v && v.queueLen > v.queueHead ? String(v.queueLen - v.queueHead) : '');
      fillLines($('hsQueue'), h.queue.map(queueLine), v ? 'Queue empty.' : 'Loading…');
      setText('hsMovesCount', h.moves.length ? String(h.moves.length) : '');
      fillLines($('hsMoves'), h.moves.slice(0, QUEUE_ROWS).map(moveLine), h.scannedTo != null ? 'None yet.' : 'Scanning events…');
    }

    /* The keeper cell ticks every second between reads, on the chain clock. */
    function renderKeeper() {
      var kv = h.keeper ? h.keeper.view() : { text: '—', offline: false, title: '' };
      valCell('hsKeeper', kv.text, kv.offline ? 'neg' : (kv.text !== '—' ? 'pos' : ''), kv.title);
    }

    function refresh() {
      var jobs = [readHouse().catch(function () { /* keep the last values */ }), loadBotOi(), scanMoves().catch(function () { /* retried on the next poll */ })];
      if (h.keeper && Date.now() - h.keeperAt >= KEEPER_EVERY_MS) { h.keeperAt = Date.now(); jobs.push(h.keeper.refresh()); }
      return Promise.all(jobs).then(render);
    }

    function init() {
      if (window.ConfettiKeeper) h.keeper = window.ConfettiKeeper.create({ provider: read.provider, logProvider: read.logProvider, exchange: read.ex, iface: exIface });
      render();
      setInterval(function () { if (!document.hidden) renderKeeper(); }, 1000);
    }

    return { init: init, refresh: refresh, every: EVERY_MS.house };
  })();

  /* ==========================================================================
     Confetti: stake / unstake / claim on Staking, a v3 stake moved over (claim / unstake on the v3
     Staking, approve / stake here), APR from recent pushes priced off the FETTI / WHYPE pair
     ========================================================================== */

  var confettiPage = (function () {
    var c = { pool: null, me: null, pushes: [], seen: {}, scannedTo: null, deployTs: null, busy: false, note: null };
    var NOTE_MS = 20000;

    function readPool() {
      return Promise.all([
        read.staking.totalStake(), read.staking.totalRewardsUsdc(), read.confetti.totalSupply()
      ]).then(function (r) {
        c.pool = { stake: tok18(r[0]), rewards: usd6(r[1]), supply: tok18(r[2]) };
      });
    }

    function readMe() {
      var a = wallet.account;
      if (!a) { c.me = null; return Promise.resolve(); }
      var v3 = read.v3Staking, k = cfg.contracts;
      return Promise.all([
        read.confetti.balanceOf(a), read.staking.stakedOf(a), read.staking.earned(a), read.confetti.allowance(a, k.staking),
        read.staking.warmingOf(a),
        v3 ? v3.stakedOf(a) : 0n, v3 ? v3.earned(a) : 0n,
        read.v3 ? read.v3.balanceOf(a).catch(function () { return 0n; }) : 0n
      ]).then(function (r) {
        if (wallet.account !== a) return;
        c.me = {
          walletRaw: BigInt(r[0]), stakedRaw: BigInt(r[1]), earned: usd6(r[2]), allowanceRaw: BigInt(r[3]),
          warmingRaw: BigInt(r[4][0]), activatesAt: Number(r[4][1]),
          v3StakedRaw: BigInt(r[5]), v3EarnedRaw: BigInt(r[6]), v3BalanceRaw: BigInt(r[7])
        };
      });
    }

    /* RewardNotified on Staking from deployBlock: the Exchange's fee pushes, and anyone else's. */
    function scanPushes() {
      var from = c.scannedTo != null ? c.scannedTo + 1 : deployBlock();
      var to = head.block;
      var scan = to == null || from > to ? Promise.resolve() : scanLogs([{ address: cfg.contracts.staking, topics: [topic(stIface, 'RewardNotified')] }], from, to).then(function (logs) {
        logs.map(function (l) { return parseLog(stIface, l); }).filter(Boolean).forEach(function (p) {
          var key = p.tx + ':' + p.index;
          if (c.seen[key]) return;
          c.seen[key] = true;
          c.pushes.push({ block: p.block, tx: p.tx, from: String(p.args.from).toLowerCase(), usdc: usd6(p.args.usdc) });
        });
        c.pushes.sort(function (x, y) { return y.block - x.block; });
        c.scannedTo = to;
      });
      return scan.then(function () {
        return fetchTimes(c.pushes.map(function (p) { return p.block; }).concat([deployBlock()]));
      }).then(function () {
        if (blockTs[deployBlock()] != null) c.deployTs = blockTs[deployBlock()];
      });
    }

    /* FETTI in USD from the swap box's pair reserves and HYPE mid; null when the pair is off. */
    function fettiUsd() {
      var p = sw.checked && cfg.swap ? sw.pool : null;
      if (!p || !(p.fetti > 0n) || !(p.hype > 0n) || !(sw.hypeUsd > 0)) return null;
      return tok18(p.hype) / tok18(p.fetti) * sw.hypeUsd;
    }

    /* Pushes over the last PUSH_WINDOW_DAYS (or since deploy), annualised on all stake (active +
       warming) at the pair price. Before the first push is APR_MIN_DAYS old, or without a price:
       what was paid and over how many days. */
    var APR_MIN_DAYS = 7;
    function apr() {
      if (!c.pool || c.scannedTo == null || c.deployTs == null) return null;
      var now = chainNow();
      var since = Math.max(c.deployTs, now - PUSH_WINDOW_DAYS * 86400);
      var days = (now - since) / 86400;
      var sum = 0, n = 0, total = 0, first = null, dated = true;
      c.pushes.forEach(function (p) {
        var ts = blockTs[p.block];
        if (ts == null) { dated = false; return; }
        total += p.usdc;
        if (first == null || ts < first) first = ts;
        if (ts >= since) { sum += p.usdc; n++; }
      });
      if (!dated || !(days > 0)) return null;
      var price = fettiUsd();
      var value = price != null ? c.pool.stake * price : 0;
      var ripe = first != null && now - first >= APR_MIN_DAYS * 86400;
      return {
        sum: sum, n: n, days: days, price: price, total: total,
        paidDays: first != null ? Math.max(1, Math.round((now - first) / 86400)) : 0,
        apr: ripe && value > 0 ? (sum / days * 365) / value : null
      };
    }

    function pushLine(p) {
      var line = el('div', 'pos-line');
      line.appendChild(timeSpan(p.block));
      var src = p.from === String(cfg.contracts.exchange).toLowerCase() ? 'fees' : shortAddr(p.from);
      line.appendChild(el('span', null, src));
      line.appendChild(el('span', 'pos', fmtUsd(p.usdc)));
      line.appendChild(el('span', 'grow'));
      line.appendChild(explorerLink('tx', p.tx));
      return line;
    }

    function fmtRaw(raw) { return window.ethers.formatUnits(raw, 18); }

    function renderForms() {
      var me = c.me;
      var ready = !!(wallet.account && wallet.signer && wallet.chainId === CHAIN_ID && me && !gate && !refused);
      c.ready = ready;
      ['stakeBtn', 'unstakeBtn', 'claimBtn', 'stakeMax', 'unstakeMax'].forEach(function (id) { var b = $(id); if (b) b.disabled = c.busy || !ready; });
      var mv = $('moveBtn');
      if (mv) mv.disabled = c.busy || !ready || !read.v3Staking;
      var hint = $('cfHint');
      if (hint && !c.busy) {
        var note = c.note && Date.now() - c.note.at < NOTE_MS ? c.note : null;
        hint.classList.toggle('is-err', !!(note && note.err) || !!gate);
        hint.textContent = note ? note.text : gate ? gate : !wallet.account ? 'Connect a wallet to stake.' : wallet.chainId !== CHAIN_ID ? 'Switch the wallet to HyperEVM (999).' : 'Claims land in your wallet.';
      }
      swapForms();
      renderCard();
    }

    function render() {
      var p = c.pool, me = c.me;
      if (p) {
        valCell('cfTotal', fmtTok(p.stake), '', p.supply > 0 ? fmtPct(p.stake / p.supply) + ' of ' + fmtTok(p.supply) + ' FETTI' : '');
        valCell('cfRewards', fmtUsd(p.rewards), '', 'USDC paid to stakers');
      }
      var a = apr();
      if (a) {
        valCell('cfPushed', fmtUsd(a.sum) + ' · ' + fmtInt(a.n) + ' push' + (a.n === 1 ? '' : 'es'), '', 'last ' + Math.max(1, Math.round(a.days)) + ' days');
        var paid = a.paidDays ? fmtUsd(a.total) + ' paid over ' + a.paidDays + ' day' + (a.paidDays === 1 ? '' : 's') : '—';
        valCell('cfApr', a.apr != null ? fmtPct(a.apr) : paid, a.apr > 0 ? 'pos' : 'faint',
          a.apr != null ? 'last ' + Math.max(1, Math.round(a.days)) + ' days of pushes, annualised, on all stake at $' + fmtPrice(a.price) + ' per FETTI' : '');
      }
      if (me) {
        valCell('cfWallet', fmtTok(tok18(me.walletRaw)));
        valCell('cfV3Staked', fmtTok(tok18(me.v3StakedRaw)) + (me.v3EarnedRaw > 0n ? ' · ' + fmtUsd(usd6(me.v3EarnedRaw)) + ' unclaimed' : ''));
        valCell('cfStaked', fmtTok(tok18(me.stakedRaw)));
        valCell('cfWarming', me.warmingRaw > 0n ? fmtTok(tok18(me.warmingRaw)) + (me.activatesAt > chainNow() ? ' · active ' + fmtTime(me.activatesAt) : ' · active on next touch') : 'none');
        valCell('cfEarned', fmtUsd(me.earned), me.earned > 0 ? 'pos' : '');
        valCell('cfShare', p && p.stake > 0 ? fmtPct(tok18(me.stakedRaw) / p.stake) : '—');
      } else {
        ['cfWallet', 'cfStaked', 'cfWarming', 'cfEarned', 'cfShare'].forEach(function (id) { valCell(id, '—'); });
      }
      /* the move block: the v3 stake and its button while v3 Staking holds stake or USDC; the v3
         Exchange balance (where a v3 claim lands) with its link to v3.html while it is above zero */
      var moving = !!(me && read.v3Staking && (me.v3StakedRaw > 0n || me.v3EarnedRaw > 0n));
      var v3bal = !!(me && read.v3 && me.v3BalanceRaw > 0n);
      if (v3bal) setText('cfV3Bal', fmtUsd(usd6(me.v3BalanceRaw)));
      [['moveStake', moving], ['v3BalRow', v3bal], ['moveBlock', moving || v3bal]].forEach(function (x) { var n = $(x[0]); if (n) n.hidden = !x[1]; });
      setText('cfPushCount', c.pushes.length ? String(c.pushes.length) : '');
      fillLines($('cfPushes'), c.pushes.slice(0, BOARD_ROWS).map(pushLine), c.scannedTo != null ? 'No pushes yet.' : 'Scanning events…');
      renderForms();
      renderSwap();
    }

    function refresh() {
      if (DEMO) { render(); return Promise.resolve(); }
      return readHead().then(function () {
        return Promise.all([
          readPool().catch(function () { /* keep the last values */ }),
          readMe().catch(function () { /* keep the last values */ }),
          scanPushes().catch(function () { /* retried on the next poll */ })
        ]);
      }).catch(function () { /* transient RPC trouble */ }).then(render);
    }

    function parseAmount(id) {
      var s = String(($(id) && $(id).value) || '').trim();
      if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
      try { var v = window.ethers.parseUnits(s, 18); return v > 0n ? v : null; } catch (e) { return null; }
    }

    /* A message for the last action; it outlives re-renders for NOTE_MS. */
    function say(text, err) {
      c.note = { text: text, err: !!err, at: Date.now() };
      var n = $('cfHint');
      if (n) { n.textContent = text; n.classList.toggle('is-err', !!err); }
    }

    function hintErr(text) { say(text, true); }

    function run(desc, job) {
      try { requireSigner(); } catch (e) { hintErr(e.message); return; }
      c.busy = true; renderForms();
      say(desc + '…');
      if (DEMO) {
        /* the demo sends nothing: a moment "in the wallet", then the note */
        setTimeout(function () { c.busy = false; say('Demo: nothing is sent.'); renderForms(); }, 900);
        return;
      }
      job().then(function () {
        c.busy = false;
        say('Done.');
        renderForms();
        return refresh();
      }).catch(function (e) {
        c.busy = false;
        hintErr(describeError(e));
        renderForms();
      });
    }

    /* ANNOUNCED APPROVALS (the owner, 2026-10-23, for Phantom's warnings): before a two-step flow the hint says
       what the wallet will ask, the exact amount and which contract, with its verified source; each toast is
       numbered. */
    function approveLine(raw, spender, who, then) {
      return 'Two steps in your wallet: approve exactly ' + fmtTok(Number(window.ethers.formatUnits(raw, 18))) +
        ' FETTI for ' + who + ' (' + shortAddr(spender) + ', source verified on Sourcify), then ' + then + '.';
    }
    function approveDesc(raw) { return 'Approve ' + fmtTok(Number(window.ethers.formatUnits(raw, 18))) + ' FETTI (1 of 2)'; }

    function stake() {
      var amt = parseAmount('stakeAmount');
      if (amt == null) { hintErr('Enter an amount to stake.'); return; }
      if (c.me && amt > c.me.walletRaw) { hintErr('More than your wallet holds.'); return; }
      run('Staking', function () {
        var st = new window.ethers.Contract(cfg.contracts.staking, STAKING_ABI, wallet.signer);
        var cf = new window.ethers.Contract(cfg.contracts.confetti, CONFETTI_ABI, wallet.signer);
        var two = !(c.me && c.me.allowanceRaw >= amt);
        if (two) say(approveLine(amt, cfg.contracts.staking, 'Confetti Staking', 'stake it'));
        var approve = two ? sendTx(approveDesc(amt), cf.approve, [cfg.contracts.staking, amt]) : Promise.resolve();
        return approve.then(function () { return sendTx(two ? 'Stake (2 of 2)' : 'Stake', st.stake, [amt]); }).then(function () { $('stakeAmount').value = ''; });
      });
    }

    function unstake() {
      var amt = parseAmount('unstakeAmount');
      if (amt == null) { hintErr('Enter an amount to unstake.'); return; }
      if (c.me && amt > c.me.stakedRaw) { hintErr('More than you have staked.'); return; }
      run('Unstaking', function () {
        var st = new window.ethers.Contract(cfg.contracts.staking, STAKING_ABI, wallet.signer);
        return sendTx('Unstake', st.unstake, [amt]).then(function () { $('unstakeAmount').value = ''; });
      });
    }

    function claim() {
      if (c.me && !(c.me.earned > 0)) { hintErr('Nothing to claim yet.'); return; }
      run('Claiming', function () {
        var st = new window.ethers.Contract(cfg.contracts.staking, STAKING_ABI, wallet.signer);
        return sendTx('Claim', st.claim, []);
      });
    }

    /* A v3 stake moved here: claim on the v3 Staking when it has earned (the USDC lands in the v3
       trading balance), unstake all of it there, approve FETTI to Staking when short, stake. */
    function move() {
      var me = c.me, k = cfg.contracts, a = wallet.account;
      if (!me || !read.v3Staking || !(me.v3StakedRaw > 0n || me.v3EarnedRaw > 0n)) { hintErr('Nothing staked on v3.'); return; }
      run('Moving', function () {
        var E = window.ethers;
        var v3 = new E.Contract(k.v3Staking, V3_STAKING_ABI, wallet.signer);
        var st = new E.Contract(k.staking, STAKING_ABI, wallet.signer);
        var cf = new E.Contract(k.confetti, CONFETTI_ABI, wallet.signer);
        var claimed = me.v3EarnedRaw > 0n ? sendTx('Claim on v3', v3.claim, []) : Promise.resolve();
        return claimed.then(function () { return read.v3Staking.stakedOf(a); }).then(function (s) {
          var amt = BigInt(s);
          if (amt === 0n) return null;
          return sendTx('Unstake on v3', v3.unstake, [amt]).then(function () {
            return read.confetti.allowance(a, k.staking);
          }).then(function (al) {
            if (BigInt(al) >= amt) return null;
            say(approveLine(amt, k.staking, 'Confetti Staking', 'stake it'));
            return sendTx(approveDesc(amt), cf.approve, [k.staking, amt]);
          }).then(function () { return sendTx('Stake', st.stake, [amt]); });
        });
      });
    }

    /* ---- FETTI / HYPE on HyperSwap V2: shown when config has "swap"; every target is a pin ---- */

    /* on: the box shows (at once when config "swap" agrees with the pins, else after the chain check);
       checked: the chain check passed, the only state a swap can be sent in. */
    var sw = { on: false, checked: false, verifying: false, router: null, pair: null, whypeIs0: true, feeDen: 0n, pool: null, hypeUsd: null, me: null,
      mode: 'buy', quote: null, seq: 0, note: null, inFlight: false };

    /* Read-only router and pair on the pins. Until the check reads token0, WHYPE is token0 when its
       address sorts first (a V2 factory sorts the pair's tokens). */
    function swapContracts() {
      var E = window.ethers, s = cfg.swap;
      sw.router = new E.Contract(s.router, SWAP_ROUTER_ABI, read.provider);
      sw.pair = new E.Contract(s.pair, SWAP_PAIR_ABI, read.provider);
      sw.whypeIs0 = BigInt(s.whype) < BigInt(cfg.contracts.confetti);
      sw.on = !!s.agreed;
    }

    /* Router and pair against the SWAP pins and the pinned FETTI, behind the shown box: a difference
       hides it for good; an unreadable RPC rejects and the next tick tries again. Resolves true when it passed. */
    function swapVerify() {
      var s = cfg.swap, fetti = cfg.contracts.confetti, router = sw.router, pair = sw.pair;
      return Promise.all([router.WETH(), router.factory(), pair.factory(), pair.token0(), pair.token1(), pair.FEE_DENOMINATOR()]).then(function (r) {
        var w0 = sameAddr(r[3], s.whype) && sameAddr(r[4], fetti);
        var w1 = sameAddr(r[4], s.whype) && sameAddr(r[3], fetti);
        if (!sameAddr(r[0], s.whype) || !sameAddr(r[1], r[2]) || !(w0 || w1) || !(BigInt(r[5]) > 0n)) {
          console.error('swap: router ' + s.router + ' / pair ' + s.pair + ' do not match WHYPE ' + s.whype + ' and FETTI ' + fetti + '; the swap box is off.');
          cfg.swap = null; sw.on = false; sw.pool = null; sw.quote = null;
          return false;
        }
        if (w0 !== sw.whypeIs0) { sw.whypeIs0 = w0; sw.pool = null; sw.quote = null; }
        sw.feeDen = BigInt(r[5]); sw.checked = true; sw.on = true;
        return true;
      });
    }

    /* Reserves (oriented by whypeIs0 as it stands when they arrive) and, until known, the fee denominator. */
    function swapReadPool() {
      return Promise.all([sw.pair.getReserves(), sw.feeDen > 0n ? sw.feeDen : sw.pair.FEE_DENOMINATOR()]).then(function (x) {
        if (!cfg.swap) return;
        var r = x[0], a = BigInt(r[0]), b = BigInt(r[1]), fa = BigInt(r[2]), fb = BigInt(r[3]);
        if (!(sw.feeDen > 0n) && BigInt(x[1]) > 0n) sw.feeDen = BigInt(x[1]);
        sw.pool = sw.whypeIs0 ? { hype: a, fetti: b, feeHype: fa, feeFetti: fb } : { hype: b, fetti: a, feeHype: fb, feeFetti: fa };
      });
    }

    function swapReadMid() {
      return postInfo({ type: 'allMids' }, 5000).then(function (m) {
        var v = m && Number(m.HYPE);
        if (v > 0) sw.hypeUsd = v;
      });
    }

    function swapReadMe() {
      var a = wallet.account;
      if (!a) { sw.me = null; return Promise.resolve(); }
      return Promise.all([read.confetti.balanceOf(a), read.provider.getBalance(a)]).then(function (r) {
        if (wallet.account === a) sw.me = { fetti: BigInt(r[0]), hype: BigInt(r[1]) };
      });
    }

    /* The pair's own math (constant product, the input token's fee): the quote when the router's
       getAmountsOut cannot be read. */
    function reserveOut(amt, buy) {
      var p = sw.pool, rin = buy ? p.hype : p.fetti, rout = buy ? p.fetti : p.hype;
      if (!(sw.feeDen > 0n)) return 0n;
      var x = amt * (sw.feeDen - (buy ? p.feeHype : p.feeFetti));
      return rin > 0n && rout > 0n ? x * rout / (rin * sw.feeDen + x) : 0n;
    }

    function swapPath(buy) { return buy ? [cfg.swap.whype, cfg.contracts.confetti] : [cfg.contracts.confetti, cfg.swap.whype]; }

    function swapQuote() {
      var seq = ++sw.seq, buy = sw.mode === 'buy', amt = parseAmount('swAmount');
      if (amt == null || !sw.pool || !cfg.swap) { sw.quote = null; renderSwap(); return Promise.resolve(); }
      return sw.router.getAmountsOut(amt, swapPath(buy)).then(function (a) { return BigInt(a[a.length - 1]); }, function () { return reserveOut(amt, buy); }).then(function (out) {
        if (seq !== sw.seq) return;
        sw.quote = { mode: buy ? 'buy' : 'sell', amt: amt, out: out };
        renderSwap();
      });
    }

    /* Slippage in basis points, or null outside SLIP_MIN..SLIP_MAX percent. */
    function slipBps() {
      var v = Number(String(($('swSlip') && $('swSlip').value) || '').trim());
      return isFinite(v) && v >= SLIP_MIN && v <= SLIP_MAX ? Math.round(v * 100) : null;
    }

    function minOut(out, bps) { return out * BigInt(10000 - bps) / 10000n; }

    function renderSwap() {
      var box = $('swapBox');
      if (!box) return;
      box.hidden = !sw.on;
      if (!sw.on) return;
      var p = sw.pool, buy = sw.mode === 'buy';
      if (p && p.fetti > 0n) {
        var px = tok18(p.hype) / tok18(p.fetti);
        valCell('swPrice', fmtPrice(px) + ' HYPE' + (sw.hypeUsd ? ' · $' + fmtPrice(px * sw.hypeUsd) : ''), '', sw.hypeUsd ? 'HYPE $' + fmtPrice(sw.hypeUsd) + ', Hyperliquid mid' : '');
        valCell('swDepth', fmtTok(tok18(p.fetti)) + ' FETTI · ' + fmtHype(tok18(p.hype)) + ' HYPE');
        if (sw.feeDen > 0n) setText('swFee', +(Number(buy ? p.feeHype : p.feeFetti) / Number(sw.feeDen) * 100).toFixed(3) + '%');
      }
      valCell('swBal', sw.me ? fmtTok(tok18(sw.me.fetti)) + ' FETTI · ' + fmtHype(tok18(sw.me.hype)) + ' HYPE' : '—');
      [['swBuy', buy], ['swSell', !buy]].forEach(function (b) { var n = $(b[0]); if (n) n.setAttribute('aria-pressed', b[1] ? 'true' : 'false'); });
      setText('swUnit', buy ? 'HYPE' : 'FETTI');
      setText('swBtn', buy ? 'Buy' : 'Sell');
      var q = sw.quote && sw.quote.mode === sw.mode ? sw.quote : null, bps = slipBps();
      var unit = buy ? ' FETTI' : ' HYPE', fmt = buy ? fmtTok : fmtHype;
      if (q && p && sw.feeDen > 0n) {
        var fee = Number(buy ? p.feeHype : p.feeFetti) / Number(sw.feeDen);
        var rin = tok18(buy ? p.hype : p.fetti), rout = tok18(buy ? p.fetti : p.hype);
        var mid = rin > 0 ? tok18(q.amt) * (1 - fee) * rout / rin : 0;
        var impact = mid > 0 ? Math.max(0, 1 - tok18(q.out) / mid) : null;
        valCell('swOut', '~' + fmt(tok18(q.out)) + unit + ' · ' + fmtPct(impact) + ' impact');
        valCell('swMin', bps != null ? fmt(tok18(minOut(q.out, bps))) + unit : '—');
      } else {
        valCell('swOut', '—');
        valCell('swMin', '—');
      }
      swapForms();
    }

    function swapForms() {
      var btn = $('swBtn');
      if (!btn || !sw.on) return;
      var ready = !!(wallet.account && wallet.signer && wallet.chainId === CHAIN_ID && sw.me && !gate && !refused);
      var bps = slipBps();
      btn.disabled = c.busy || !ready || !sw.checked || bps == null || !(sw.quote && sw.quote.mode === sw.mode && sw.quote.out > 0n);
      ['swBuy', 'swSell'].forEach(function (id) { var n = $(id); if (n) n.disabled = c.busy; });
      var hint = $('swHint');
      if (hint && !c.busy) {
        var note = sw.note && Date.now() - sw.note.at < NOTE_MS ? sw.note : null;
        hint.classList.toggle('is-err', note ? note.err : bps == null);
        hint.textContent = note ? note.text : bps == null ? 'Slippage ' + SLIP_MIN + ' to ' + SLIP_MAX + '%.' :
          !wallet.account ? 'Connect a wallet to trade.' : wallet.chainId !== CHAIN_ID ? 'Switch the wallet to HyperEVM (999).' : !sw.checked ? 'Checking the pool on chain…' : '';
      }
    }

    function swSay(text, err) {
      sw.note = { text: text, err: !!err, at: Date.now() };
      var n = $('swHint');
      if (n) { n.textContent = text; n.classList.toggle('is-err', !!err); }
    }

    /* The chain check runs behind the box until it has passed once; the pool, HYPE mid, balances and
       quote are read whenever the box is on (so the numbers come straight from the pair at load). */
    function swapRefresh() {
      if (!cfg.swap || document.hidden) return Promise.resolve();
      if (!sw.checked && !sw.verifying) {
        sw.verifying = true;
        swapVerify().then(function (ok) { sw.verifying = false; renderSwap(); if (ok && !sw.pool) return swapRefresh(); },
          function () { sw.verifying = false; /* retried on the next tick */ });
      }
      if (!sw.on || sw.inFlight) { renderSwap(); return Promise.resolve(); }
      sw.inFlight = true;
      return Promise.all([swapReadPool(), swapReadMid().catch(none), swapReadMe().catch(none)]).then(swapQuote)
        .catch(function () { /* retried on the next tick */ }).then(function () { sw.inFlight = false; renderSwap(); });
    }

    function swapMode(mode) {
      if (c.busy || sw.mode === mode) return;
      sw.mode = mode; sw.quote = null; sw.seq++;
      $('swAmount').value = '';
      renderSwap();
    }

    /* Buy: HYPE in as value. Sell: approve FETTI to the router when the allowance is short, then swap.
       amountOutMin is the shown quote less the slippage; the deadline runs off the chain clock. */
    function swap() {
      var buy = sw.mode === 'buy', amt = parseAmount('swAmount'), bps = slipBps(), q = sw.quote;
      if (amt == null) { swSay('Enter an amount.', true); return; }
      if (sw.me && amt > (buy ? sw.me.hype : sw.me.fetti)) { swSay('More than your wallet holds.', true); return; }
      if (bps == null) { swSay('Slippage ' + SLIP_MIN + ' to ' + SLIP_MAX + '%.', true); return; }
      if (!q || q.mode !== sw.mode || q.amt !== amt || !(q.out > 0n)) { swSay('Quoting, try again.', true); swapQuote().catch(none); return; }
      if (!sw.checked) { swSay('Checking the pool on chain, try again.', true); return; }
      try { requireSigner(); } catch (e) { swSay(e.message, true); return; }
      var E = window.ethers, me = wallet.account, s = cfg.swap, fetti = cfg.contracts.confetti;
      var min = minOut(q.out, bps), deadline = Math.floor(chainNow()) + SWAP_DEADLINE_S;
      var router = new E.Contract(s.router, SWAP_ROUTER_ABI, wallet.signer);
      var desc = buy ? 'Buy FETTI' : 'Sell FETTI';
      c.busy = true; renderForms();
      swSay(desc + '…');
      var job = buy
        ? sendTx(desc, router.swapExactETHForTokensSupportingFeeOnTransferTokens, [min, swapPath(true), me, ZERO, deadline, { value: amt }])
        : read.confetti.allowance(me, s.router).then(function (al) {
          var cf = new E.Contract(fetti, CONFETTI_ABI, wallet.signer);
          if (BigInt(al) >= amt) return null;
          swSay('Two steps in your wallet: approve exactly ' + fmtTok(Number(E.formatUnits(amt, 18))) + ' FETTI for the HyperSwap router (' + shortAddr(s.router) + '), then sell.');
          return sendTx('Approve ' + fmtTok(Number(E.formatUnits(amt, 18))) + ' FETTI (1 of 2)', cf.approve, [s.router, amt]);
        }).then(function () {
          return sendTx(desc, router.swapExactTokensForETHSupportingFeeOnTransferTokens, [amt, min, swapPath(false), me, ZERO, deadline]);
        });
      job.then(function () {
        c.busy = false;
        $('swAmount').value = ''; sw.quote = null;
        swSay('Done.');
        return Promise.all([refresh(), swapRefresh()]);
      }).catch(function (e) {
        c.busy = false;
        swSay(describeError(e), true);
        renderForms();
      });
    }

    /* Started by the page boot before the exchange check: nothing here depends on it. */
    function swapInit() {
      if (!cfg.swap || !read.provider || !read.confetti) return;
      var timer = null;
      swapContracts();
      $('swSlip').value = String(SLIP_DEFAULT);
      var pl = $('swPoolLink'), fetti = addrOrNull(CONTRACTS.confetti);
      if (pl && fetti) { pl.href = 'https://app.hyperswap.exchange/#/swap?outputCurrency=' + fetti; pl.hidden = false; }
      renderSwap();
      $('swBuy').addEventListener('click', function () { swapMode('buy'); });
      $('swSell').addEventListener('click', function () { swapMode('sell'); });
      $('swBtn').addEventListener('click', swap);
      $('swAmount').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { swapQuote().catch(none); }, 250); });
      $('swSlip').addEventListener('input', renderSwap);
      swapRefresh();
      setInterval(swapRefresh, SWAP_EVERY_MS);
      document.addEventListener('visibilitychange', swapRefresh);
    }

    /* Max: the whole wallet into the stake box, the whole stake into the unstake box. */
    function stakeMaxFill() { if (c.me) $('stakeAmount').value = fmtRaw(c.me.walletRaw); }
    function unstakeMaxFill() { if (c.me) $('unstakeAmount').value = fmtRaw(c.me.stakedRaw); }

    /* The local demo (DEMO, 127.0.0.1 only; the page boot calls this instead of the chain): the spec's
       example holder. Times sit on fixed clock hours so two runs on one day draw the same page. */
    function demoBoot() {
      var E = window.ethers;
      var noon = new Date(); noon.setHours(12, 0, 0, 0);
      var day = Math.floor(noon.getTime() / 1000), block = 50500000;
      c.pool = { stake: 1250000, rewards: 18400, supply: 10000000 };
      c.deployTs = day - 120 * 86400;
      c.pushes = [];
      for (var i = 0; i < 12; i++) {
        var b = block - 1000 * (i + 1);
        blockTs[b] = day - (2 * i + 1) * 86400 - (i % 3) * 3600;
        c.pushes.push({ block: b, tx: '0xde' + String(i).padStart(62, '0'), from: String(cfg.contracts.exchange).toLowerCase(), usdc: 260 });
      }
      c.scannedTo = block;
      /* the swap box with the pair's numbers; no router, so an amount typed here quotes nothing */
      if (cfg.swap) {
        sw.on = true; sw.checked = true; sw.feeDen = 1000n; sw.hypeUsd = 24.5;
        sw.pool = { hype: E.parseUnits('42000', 18), fetti: E.parseUnits('3500000', 18), feeHype: 3n, feeFetti: 3n };
        if ($('swSlip')) $('swSlip').value = String(SLIP_DEFAULT);
        var bb = $('swBuy'), bs = $('swSell');
        if (bb) bb.addEventListener('click', function () { swapMode('buy'); });
        if (bs) bs.addEventListener('click', function () { swapMode('sell'); });
      }
      if (DEMO === '1') {
        var v3 = /[?&]v3=1(&|$)/.test(location.search);
        wallet.account = E.getAddress('0xde00000000000000000000000000000000000001');
        wallet.chainId = CHAIN_ID;
        wallet.signer = { demo: true };
        c.me = {
          walletRaw: E.parseUnits('12000', 18), stakedRaw: E.parseUnits('8000', 18), earned: 3.12, allowanceRaw: E.parseUnits('5000', 18),
          warmingRaw: E.parseUnits('500', 18), activatesAt: day + 86400,
          v3StakedRaw: v3 ? E.parseUnits('2500', 18) : 0n, v3EarnedRaw: v3 ? 1100000n : 0n, v3BalanceRaw: v3 ? 4200000n : 0n
        };
        sw.me = { fetti: c.me.walletRaw, hype: E.parseUnits('3.25', 18) };
      }
      renderWallet();
      render();
      toast(DEMO === '1' ? 'Demo: a pretend account on this computer. Nothing is sent.' : 'Demo: pretend pool figures on this computer. Nothing is read or sent.', null, null, 6000);
    }

    /* ---- phones (<= 640 px): the one stake card (build 9) --------------------------------------
       The ph-only #cfCard in confetti.html. Its Stake / Unstake toggle picks which of today's inputs
       and handlers the card drives (stakeAmount + stake, unstakeAmount + unstake): what is typed on
       the card is mirrored into that input on every keystroke, so the handlers read what they always
       read and clear what they always clear. Max is today's Max fill; 25 / 50 / 75 take that share of
       the same balance in wei (BigInt division floors to the token's own decimals and never passes the
       balance). The button names the action and the amount, 'Approve, then stake' when the allowance
       is short, and is an outline with the reason under it when it cannot act. Above 640 px the card
       is display:none and nothing here runs. */
    var ph = { mode: 'stake', chip: null, shown: '' };
    function phOn() { return isPhone() && !!$('cfCard'); }
    function phInputId() { return ph.mode === 'stake' ? 'stakeAmount' : 'unstakeAmount'; }
    function phBalance() { return c.me ? (ph.mode === 'stake' ? c.me.walletRaw : c.me.stakedRaw) : null; }
    /* "12000.0" -> "12000", "0.50" -> "0.5": the same number, written as a holder would type it */
    function tidyAmount(s) { s = String(s == null ? '' : s); return s.indexOf('.') < 0 ? s : s.replace(/0+$/, '').replace(/\.$/, ''); }
    function fmtAmt(raw) { return fmtTok(Number(window.ethers.formatUnits(raw, 18))); }
    /* The card shows the figure with its thousands separators ('6,000'); the input it drives holds the
       plain number ('6000'), which is what the handlers parse. */
    function plainOf(shown) { return String(shown == null ? '' : shown).replace(/,/g, ''); }
    function shownOf(plain) {
      var m = /^(\d*)(\.\d*)?$/.exec(plain);
      if (!m) return plain;
      return m[1].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (m[2] || '');
    }

    function phSetAmount(plain) {
      var real = $(phInputId()), card = $('cfAmount');
      if (real) real.value = plain;
      if (card) card.value = ph.shown = shownOf(plain);
    }

    /* A keystroke on the card: the plain number goes to the input the card drives, the separators are
       redrawn around the caret. A backspace that lands on a separator takes the digit before it. */
    function phTyped() {
      var n = $('cfAmount'), real = $(phInputId());
      if (!n || !real) return;
      var text = n.value, pos = n.selectionStart != null ? n.selectionStart : text.length;
      var before = plainOf(text.slice(0, pos)), after = plainOf(text.slice(pos));
      if (before + after === real.value && text.length < ph.shown.length && before.length) before = before.slice(0, -1);
      var plain = before + after, shown = shownOf(plain);
      real.value = plain;
      if (n.value !== shown) {
        n.value = shown;
        var i = 0, seen = 0;
        while (i < shown.length && seen < before.length) { if (shown.charAt(i) !== ',') seen++; i++; }
        try { n.setSelectionRange(i, i); } catch (e) { /* not a text field here */ }
      }
      ph.shown = shown;
    }

    function phChip(share) {
      if (!phOn() || c.busy || !c.me) return;
      if (share === 'max') {
        (ph.mode === 'stake' ? stakeMaxFill : unstakeMaxFill)();
        var real = $(phInputId());
        phSetAmount(tidyAmount(real ? real.value : ''));
      } else {
        var bal = phBalance();
        if (bal == null) return;
        phSetAmount(tidyAmount(window.ethers.formatUnits(bal * BigInt(share) / 100n, 18)));
      }
      ph.chip = share;
      if ('vibrate' in navigator) { try { navigator.vibrate(8); } catch (e) { /* not allowed here */ } }
      renderCard();
    }

    function phMode(mode) {
      if (!phOn() || c.busy || ph.mode === mode) return;
      ph.mode = mode; ph.chip = null;
      renderCard();
    }

    /* the input is as wide as its figures: a hidden mirror in the same font measures them; long
       figures step the size down (never under 18 px) */
    function fitAmount() {
      var n = $('cfAmount'), m = $('cfAmountMirror');
      if (!n || !m) return;
      var text = n.value || n.placeholder || '0', len = text.length;
      [n, m].forEach(function (x) { x.classList.toggle('is-long', len >= 10 && len < 14); x.classList.toggle('is-xlong', len >= 14); });
      m.textContent = text;
      n.style.width = (Math.ceil(m.offsetWidth) + 1) + 'px';
    }

    function renderCard() {
      var card = $('cfCard');
      if (!card || !isPhone()) return;
      var me = c.me, stake = ph.mode === 'stake', id = phInputId();
      var real = $(id), amt = $('cfAmount');
      if (amt && real && plainOf(amt.value) !== real.value) amt.value = ph.shown = shownOf(real.value);
      fitAmount();
      var raw = parseAmount(id), bal = phBalance();
      if (raw == null) ph.chip = null;
      var over = raw != null && bal != null && raw > bal;
      var two = stake && raw != null && !over && !!me && me.allowanceRaw < raw;
      var ready = !!c.ready;
      [['cfModeStake', stake], ['cfModeUnstake', !stake]].forEach(function (x) { var b = $(x[0]); if (b) { b.setAttribute('aria-pressed', x[1] ? 'true' : 'false'); b.disabled = c.busy; } });
      if (amt) amt.setAttribute('aria-label', stake ? 'Amount to stake, in FETTI' : 'Amount to unstake, in FETTI');
      setText('cfBal', (stake ? 'Wallet ' : 'Staked ') + (bal != null ? fmtTok(tok18(bal)) : '—'));
      var chips = card.querySelectorAll('.cf-chip');
      for (var i = 0; i < chips.length; i++) {
        chips[i].disabled = c.busy || !me || !(bal > 0n);
        chips[i].setAttribute('aria-pressed', ph.chip === chips[i].getAttribute('data-share') ? 'true' : 'false');
      }
      var go = $('cfGo');
      if (go) {
        var verb = stake ? 'Stake' : 'Unstake';
        go.textContent = raw == null ? verb + ' FETTI' : two ? 'Approve, then stake ' + fmtAmt(raw) + ' FETTI' : verb + ' ' + fmtAmt(raw) + ' FETTI';
        go.disabled = c.busy || !ready || raw == null || over;
      }
      /* the reason, or the next step, under the button: only while the hint carries no note of its own */
      var hint = $('cfHint');
      var note = c.note && Date.now() - c.note.at < NOTE_MS ? c.note : null;
      if (hint && !c.busy && !note && ready) {
        hint.textContent = !(bal > 0n) ? (stake ? 'No FETTI in this wallet to stake.' : 'Nothing staked to unstake.')
          : raw == null ? (stake ? 'Enter an amount to stake.' : 'Enter an amount to unstake.')
          : over ? (stake ? 'More than your wallet holds.' : 'More than you have staked.')
          : two ? 'Your wallet asks twice: approve, then stake.' : 'Your wallet asks you to confirm.';
        hint.classList.remove('is-err');
      }
    }

    function initCard() {
      var card = $('cfCard');
      if (!card) return;
      var on = function (id, fn) { var b = $(id); if (b) b.addEventListener('click', fn); };
      on('cfModeStake', function () { phMode('stake'); });
      on('cfModeUnstake', function () { phMode('unstake'); });
      Array.prototype.forEach.call(card.querySelectorAll('.cf-chip'), function (b) { b.addEventListener('click', function () { phChip(b.getAttribute('data-share')); }); });
      on('cfGo', function () { if (!phOn() || c.busy) return; (ph.mode === 'stake' ? stake : unstake)(); });
      var amt = $('cfAmount');
      if (amt) {
        amt.addEventListener('input', function () { if (!phOn()) return; phTyped(); ph.chip = null; renderCard(); });
        amt.addEventListener('keydown', function (ev) { if (ev.key !== 'Enter') return; ev.preventDefault(); var go = $('cfGo'); if (go && !go.disabled) go.click(); });
      }
      /* crossing 640 px either way: the card re-reads the input it drives */
      if (PHONE_MQ) { if (PHONE_MQ.addEventListener) PHONE_MQ.addEventListener('change', renderForms); else if (PHONE_MQ.addListener) PHONE_MQ.addListener(renderForms); }
    }

    function init() {
      var bind = function (id, fn) { var b = $(id); if (b) b.addEventListener('click', fn); };
      bind('stakeBtn', stake);
      bind('unstakeBtn', unstake);
      bind('claimBtn', claim);
      bind('stakeMax', stakeMaxFill);
      bind('unstakeMax', unstakeMaxFill);
      bind('moveBtn', move);
      initCard();
      render();
    }

    function onAccount() {
      c.me = null; sw.me = null; sw.note = null;
      render();
      readMe().catch(none).then(render);
      swapReadMe().catch(none).then(renderSwap);
    }

    return { early: swapInit, init: init, refresh: refresh, onAccount: onAccount, demo: demoBoot, every: EVERY_MS.confetti };
  })();

  /* ==========================================================================
     Leaderboard: points (points.json + the live engine in points.js) and realised PnL
     ========================================================================== */

  var leaderboard = (function () {
    var lb = { pnl: {}, seen: {}, scannedTo: null };

    /* House bots are left out only when config lists them: the configured
       addresses and the wallets the points snapshot flags as house. */
    function excluded(a, snapWallet) {
      if (!hbots.n) return false;
      return isHouseBot(a) || !!(snapWallet && snapWallet.house);
    }

    function pointsRows() {
      var P = window.confettiPoints && window.confettiPoints.state ? window.confettiPoints.state() : null;
      if (!P || !P.eng) return null;
      var W = P.eng.W, snapW = P.snap && P.snap.wallets ? P.snap.wallets : {}, rows = [];
      Object.keys(W).forEach(function (a) {
        var w = W[a];
        var bal = w.t - (w.sn || 0) + (w.rc || 0);
        if (bal <= 1e-6 || excluded(a, snapW[a])) return;
        rows.push({ a: a, v: bal });
      });
      rows.sort(function (x, y) { return y.v - x.v || (x.a < y.a ? -1 : 1); });
      return rows;
    }

    function scanPnl() {
      var from = lb.scannedTo != null ? lb.scannedTo + 1 : deployBlock();
      var to = head.block;
      if (to == null || from > to) return Promise.resolve();
      return scanLogs([{ address: cfg.contracts.exchange, topics: [[topic(exIface, 'PositionClosed'), topic(exIface, 'PositionLiquidated')]] }], from, to).then(function (logs) {
        logs.map(function (l) { return parseLog(exIface, l); }).filter(Boolean).forEach(function (p) {
          var key = p.tx + ':' + p.index;
          if (lb.seen[key]) return;
          lb.seen[key] = true;
          var a = String(p.args.owner).toLowerCase();
          var r = lb.pnl[a] || (lb.pnl[a] = { a: a, v: 0, n: 0, won: 0 });
          var d = p.name === 'PositionClosed' ? usd6(p.args.pnlUsdc) : -usd6(p.args.marginUsdc);
          r.v += d; r.n += 1; if (d > 0) r.won += 1;
        });
        lb.scannedTo = to;
      });
    }

    function pnlRows() {
      if (lb.scannedTo == null) return null;
      return Object.keys(lb.pnl).map(function (k) { return lb.pnl[k]; })
        .filter(function (r) { return !excluded(r.a); })
        .sort(function (x, y) { return y.v - x.v || (x.a < y.a ? -1 : 1); });
    }

    function boardLine(rank, r, me, value, extra) {
      var line = el('div', 'pos-line' + (me ? ' is-you' : ''));
      line.appendChild(el('span', 'rk', String(rank)));
      line.appendChild(addrLink(r.a, me ? 'you' : null));
      if (extra) line.appendChild(el('span', 'faint', extra));
      line.appendChild(el('span', 'grow'));
      line.appendChild(value);
      return line;
    }

    function board(rows, valueOf, extraOf) {
      var me = wallet.account ? wallet.account.toLowerCase() : null;
      var lines = rows.slice(0, BOARD_ROWS).map(function (r, i) { return boardLine(i + 1, r, r.a === me, valueOf(r), extraOf ? extraOf(r) : null); });
      if (me) {
        var at = -1;
        rows.forEach(function (r, i) { if (r.a === me) at = i; });
        if (at >= BOARD_ROWS) lines.push(boardLine(at + 1, rows[at], true, valueOf(rows[at]), extraOf ? extraOf(rows[at]) : null));
      }
      return lines;
    }

    function render() {
      setText('lbNote', hbots.n ? 'house bots left out' : '');
      var pts = pointsRows();
      setText('lbPtsCount', pts ? fmtInt(pts.length) + ' wallets' : '');
      fillLines($('lbPoints'), pts ? board(pts, function (r) { return el('span', null, fmtInt(Math.floor(r.v + 1e-9))); }) : [], pts ? 'No one yet.' : 'Loading points…');
      var pnl = pnlRows();
      setText('lbPnlCount', pnl ? fmtInt(pnl.length) + ' traders' : '');
      fillLines($('lbPnl'), pnl ? board(pnl, function (r) { return el('span', signCls(r.v), fmtUsd(r.v, true)); }, function (r) { return r.n + ' closed'; }) : [], pnl ? 'No closed trades yet.' : 'Scanning events…');
    }

    function refresh() {
      return readHead().then(scanPnl).catch(function () { /* retried on the next poll */ }).then(render);
    }

    function init() {
      render();
      /* the points engine (points.js) loads on its own and keeps following the chain: redraw when it moves */
      var sig = '';
      setInterval(function () {
        if (document.hidden) return;
        var rows = pointsRows();
        var next = rows ? rows.length + ':' + rows.reduce(function (s, r) { return s + r.v; }, 0).toFixed(2) : '';
        if (next !== sig) { sig = next; render(); }
      }, 3000);
    }

    return { init: init, refresh: refresh, onAccount: render, every: EVERY_MS.leaderboard };
  })();

  /* ==========================================================================
     v2 / v3: close out and withdraw on an earlier Exchange (config contracts.v2Exchange /
     contracts.v3Exchange, the page's setting o below). No opens, no deposits. The request windows
     are that exchange's, on the chain clock from the request: minDelay, then a keeper-only grace
     window; from there until expiry anyone may fill a request at the trader-worse of the
     request-time and fill-time oracle prints (the page offers the wallet fill of a close: Fill);
     after expiry only a cancel (an open request's margin comes back, a close request's position
     stays open). o: { key (element id prefix), name, exchange (config key), abi, read(), iface(),
     deployBlock() }.
     ========================================================================== */

  function closeOutPage(o) {
    var PAD_S = 1;           /* a wallet fill waits one second past the keeper window, a cancel one past expiry */
    var FILL_END_S = 2;      /* executeClose reverts RequestExpired past expiry: the wallet fill stops 2 s before it, for inclusion */
    var NOTE_MS = 20000;
    var win = { minDelay: 5, grace: 3, expiry: 60 };
    var v = null;            /* the connected account on this exchange */
    var busy = false;
    var note = null;

    /* addr; acct { available, margin, pending, availableRaw }; positions; closes: pending close
       requests by position id; opens: pending open requests by request id; cands: request ids
       from OpenRequested logs not yet seen filled or cancelled; scannedTo: last block scanned. */
    function fresh(addr) {
      return { addr: addr, acct: null, positions: [], closes: {}, opens: {}, cands: {}, scannedTo: null, scanning: false, warned: false };
    }

    /* wait (keeper window) -> fallback (wallet Fill) until expiry - FILL_END_S -> wait (expiring)
       until expiry + PAD_S -> expired (Cancel). */
    function phase(at) {
      var e = chainNow() - at, from = Math.min(win.minDelay + win.grace + PAD_S, win.expiry - 1), to = win.expiry + PAD_S;
      var end = Math.min(win.expiry, Math.max(from + 1, win.expiry - FILL_END_S));
      if (e < from) return { phase: 'wait', left: from - e, label: 'filling' };
      if (e <= end) return { phase: 'fallback', left: end - e };
      if (e <= to) return { phase: 'wait', left: to - e, label: 'expiring' };
      return { phase: 'expired', left: 0 };
    }

    function stateText(ph) {
      if (ph.phase === 'wait') return ph.label + ' · ' + Math.ceil(ph.left) + 's';
      if (ph.phase === 'fallback') return 'keeper missed · ' + Math.ceil(ph.left) + 's';
      return 'expired';
    }

    function canSend() { return !!(wallet.account && wallet.signer && wallet.chainId === CHAIN_ID && !refused); }

    /* The exchange must settle in the pinned USDC (else transactions are off), then its markets and
       request windows. Retried while the RPC is down. */
    function prepare() {
      if (!o.read()) { render(); return null; }
      var ex = o.read();
      var checked = function () {
        return ex.usdc().then(function (u) {
          if (sameAddr(u, USDC)) return;
          refused = 'The ' + o.name + ' exchange settles in ' + u + ', not USDC ' + USDC + '. Transactions are off.';
          console.error(o.name + ' exchange.usdc() ' + u + ' is not the pinned USDC ' + USDC + '; transactions are off.');
          toast(refused, 'err', null, 0);
        }, function () {
          return new Promise(function (res) { setTimeout(res, 5000); }).then(checked);
        });
      };
      var setWin = function (k) { return function (x) { win[k] = Number(x); }; };
      return checked().then(function () {
        return Promise.all([
          loadInstruments(ex),
          ex.minDelay().then(setWin('minDelay'), none), ex.grace().then(setWin('grace'), none), ex.expiry().then(setWin('expiry'), none)
        ]);
      }).catch(function (e) { toast('Could not read ' + o.name + ' markets: ' + describeError(e), 'err'); });
    }

    function readAccount(s) {
      var ex = o.read(), a = s.addr;
      return Promise.all([ex.balanceOf(a), ex.marginInUse(a), ex.pendingOf(a), ex.positionIdsOf(a)]).then(function (r) {
        var ids = Array.from(r[3]).map(function (x) { return BigInt(x); });
        return Promise.all(ids.map(function (id) {
          return Promise.all([ex.positions(id), ex.previewClose(id).catch(none), ex.closeRequest(id).catch(none)]);
        })).then(function (rows) {
          var positions = [], closes = {};
          rows.forEach(function (row, i) {
            var p = row[0], pv = row[1], cr = row[2];
            if (!p || p.owner === ZERO) return;
            positions.push({
              id: ids[i], instrumentId: Number(p.instrumentId), isLong: !!p.isLong, margin: usd6(p.marginUsdc),
              leverage: Number(p.leverage), entry: px18(p.entryPx18),
              pnl: pv ? usd6(pv[0]) : null, fee: pv ? usd6(pv[1]) : null, payout: pv ? usd6(pv[2]) : null
            });
            if (cr && Number(cr.requestedAt) > 0) closes[String(ids[i])] = { requestedAt: Number(cr.requestedAt), px0: px18(cr.px0) };
          });
          positions.sort(function (x, y) { return x.id < y.id ? -1 : 1; });
          var instIds = [];
          positions.forEach(function (p) { if (instIds.indexOf(p.instrumentId) < 0) instIds.push(p.instrumentId); });
          /* the live oracle price each position settles on (a retired market's frozen price) */
          return Promise.all(instIds.map(function (id) { return ex.execPrice(id, true, true).then(px18).catch(none); })).then(function (pxs) {
            var px = {};
            instIds.forEach(function (id, i) { px[id] = pxs[i]; });
            positions.forEach(function (p) { p.px = px[p.instrumentId]; });
            if (v !== s) return;
            s.acct = { available: usd6(r[0]), margin: usd6(r[1]), pending: usd6(r[2]), availableRaw: BigInt(r[0]) };
            s.positions = positions;
            s.closes = closes;
          });
        });
      });
    }

    /* OpenRequested by this trader, from the exchange's deploy block on, then followed. Scanned only while
       pendingOf holds margin: an open request holds its margin there until filled or cancelled. */
    function scanOpens(s) {
      if (s.scanning || head.block == null) return Promise.resolve();
      var from = s.scannedTo != null ? s.scannedTo + 1 : o.deployBlock();
      var to = head.block;
      if (from > to) return Promise.resolve();
      s.scanning = true;
      return scanLogs([{ address: cfg.contracts[o.exchange], topics: [topic(o.iface(), 'OpenRequested'), null, window.ethers.zeroPadValue(s.addr, 32)] }], from, to).then(function (logs) {
        s.scanning = false;
        logs.forEach(function (l) { var p = parseLog(o.iface(), l); if (p) s.cands[String(p.args.requestId)] = true; });
        s.scannedTo = to;
      }, function (e) { s.scanning = false; throw e; });
    }

    function readOpens(s) {
      if (!s.acct || !(s.acct.pending > 0)) { s.opens = {}; return Promise.resolve(); }
      return scanOpens(s).then(function () {
        var ids = Object.keys(s.cands);
        return Promise.all(ids.map(function (id) { return o.read().openRequest(BigInt(id)).catch(none); })).then(function (rows) {
          if (v !== s) return;
          var opens = {};
          rows.forEach(function (q, i) {
            if (!q) return;
            if (q.trader === ZERO) { delete s.cands[ids[i]]; return; }
            opens[ids[i]] = {
              id: ids[i], instrumentId: Number(q.instrumentId), isLong: !!q.isLong, margin: usd6(q.marginUsdc),
              leverage: Number(q.leverage), requestedAt: Number(q.requestedAt), px0: px18(q.px0)
            };
          });
          s.opens = opens;
        });
      });
    }

    /* ---- actions ---- */

    function writer() { return new window.ethers.Contract(cfg.contracts[o.exchange], o.abi, wallet.signer); }

    function say(text, err) {
      note = { text: text, err: !!err, at: Date.now() };
      renderForm();
    }

    function run(desc, job) {
      if (busy) return;
      try { requireSigner(); } catch (e) { toast(e.message, 'err'); return; }
      busy = true; render();
      job(writer()).catch(function (e) {
        toast(desc + ' failed: ' + describeError(e), 'err');
      }).then(function () {
        busy = false;
        return refresh();
      });
    }

    function label(instId, id) { return '#' + id + ' ' + symOf(instId); }

    function requestClose(p) {
      run('Close', function (ex) { return sendTx('Close ' + label(p.instrumentId, p.id), ex.requestClose, [p.id]); });
    }

    function fillClose(p) {
      run('Fill', function (ex) { return sendTx('Fill close ' + label(p.instrumentId, p.id), ex.executeClose, [p.id]); });
    }

    function cancelClose(p) {
      run('Cancel', function (ex) { return sendTx('Cancel close ' + label(p.instrumentId, p.id), ex.cancelClose, [p.id]); });
    }

    function cancelOpen(o) {
      run('Cancel', function (ex) { return sendTx('Cancel open #r' + o.id + ' ' + symOf(o.instrumentId), ex.cancelOpen, [BigInt(o.id)]); });
    }

    function parseUsd(id) {
      var s = String(($(id) && $(id).value) || '').trim();
      if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
      try { var x = window.ethers.parseUnits(s, 6); return x > 0n ? x : null; } catch (e) { return null; }
    }

    function withdraw() {
      var amt = parseUsd(o.key + 'Amount');
      if (amt == null) { say('Enter an amount.', true); return; }
      if (v && v.acct && amt > v.acct.availableRaw) { say('More than available.', true); return; }
      note = null;
      run('Withdraw', function (ex) {
        return sendTx('Withdraw ' + fmtUsd(usd6(amt)), ex.withdraw, [amt]).then(function () { $(o.key + 'Amount').value = ''; });
      });
    }

    /* ---- rendering ---- */

    function button(text, fn, title) {
      var b = el('button', 'btn btn-sm', text);
      b.type = 'button';
      b.disabled = busy || !canSend();
      if (title) b.title = title;
      b.addEventListener('click', fn);
      return b;
    }

    function positionLine(p) {
      var sz = szOf(p.instrumentId);
      var line = el('div', 'pos-line');
      line.appendChild(el('span', 'sym', symOf(p.instrumentId)));
      line.appendChild(el('span', 'faint xs', '#' + p.id));
      line.appendChild(el('span', p.isLong ? 'pos' : 'neg', sideLev(p.isLong, p.leverage)));
      var m = el('span', null, fmtUsd(p.margin)); m.title = 'margin · size ' + fmtUsd(p.margin * p.leverage);
      line.appendChild(m);
      var e = el('span', null, fmtPrice(p.entry, sz)); e.title = 'entry';
      line.appendChild(e);
      var x = el('span', 'faint', '→ ' + fmtPrice(p.px, sz)); x.title = 'oracle now';
      line.appendChild(x);
      var pnl = el('span', signCls(p.pnl), p.pnl != null ? fmtUsd(p.pnl, true) : '—');
      if (p.payout != null) pnl.title = 'a close now pays ' + fmtUsd(p.payout) + (p.fee ? ' · fee ' + fmtUsd(p.fee) : '');
      line.appendChild(pnl);
      line.appendChild(el('span', 'grow'));
      if (v.closes[String(p.id)]) line.appendChild(el('span', 'faint', 'closing'));
      else line.appendChild(button('Close', function () { requestClose(p); }));
      return line;
    }

    function stateSpan(at) {
      var ph = phase(at);
      var s = el('span', ph.phase === 'expired' ? 'neg' : 'faint', stateText(ph));
      s.setAttribute('data-at', String(at));
      s.setAttribute('data-phase', ph.phase);
      return { span: s, phase: ph.phase };
    }

    function closeLine(p, cr) {
      var line = el('div', 'pos-line');
      line.appendChild(el('span', null, 'close'));
      line.appendChild(el('span', 'sym', symOf(p.instrumentId)));
      line.appendChild(el('span', 'faint xs', '#' + p.id));
      line.appendChild(el('span', p.isLong ? 'pos' : 'neg', sideLev(p.isLong, p.leverage)));
      var px0 = el('span', null, fmtPrice(cr.px0, szOf(p.instrumentId))); px0.title = 'oracle at request';
      line.appendChild(px0);
      var st = stateSpan(cr.requestedAt);
      line.appendChild(st.span);
      line.appendChild(el('span', 'grow'));
      if (st.phase === 'fallback') line.appendChild(button('Fill', function () { fillClose(p); }, 'worse of the request and current oracle price'));
      else if (st.phase === 'expired') line.appendChild(button('Cancel', function () { cancelClose(p); }));
      return line;
    }

    function openLine(o) {
      var line = el('div', 'pos-line');
      line.appendChild(el('span', null, 'open'));
      line.appendChild(el('span', 'sym', symOf(o.instrumentId)));
      line.appendChild(el('span', 'faint xs', '#r' + o.id));
      line.appendChild(el('span', o.isLong ? 'pos' : 'neg', sideLev(o.isLong, o.leverage)));
      var m = el('span', null, fmtUsd(o.margin)); m.title = 'margin';
      line.appendChild(m);
      var st = stateSpan(o.requestedAt);
      line.appendChild(st.span);
      line.appendChild(el('span', 'grow'));
      if (st.phase === 'expired') line.appendChild(button('Cancel', function () { cancelOpen(o); }));
      return line;
    }

    function renderForm() {
      var ok = canSend() && !!(v && v.acct);
      [o.key + 'Withdraw', o.key + 'Max'].forEach(function (id) { var b = $(id); if (b) b.disabled = busy || !ok; });
      var hint = $(o.key + 'Hint');
      if (!hint) return;
      var n = note && Date.now() - note.at < NOTE_MS ? note : null;
      hint.classList.toggle('is-err', !!(n && n.err));
      hint.textContent = n ? n.text : busy ? 'Confirm in your wallet…' : !o.read() ? '' : !wallet.account ? 'Connect a wallet.' : wallet.chainId !== CHAIN_ID ? 'Switch the wallet to HyperEVM (999).' : '';
    }

    function render() {
      var sub = $(o.key + 'Who'), addr = cfg.contracts[o.exchange];
      if (sub) {
        sub.textContent = '';
        if (o.read()) sub.appendChild(explorerLink('address', addr, 'exchange ' + shortAddr(addr)));
      }
      var cells = [o.key + 'Avail', o.key + 'Margin', o.key + 'Pnl'];
      if (!o.read() || !v) {
        var why = !o.read() ? 'No ' + o.name + ' exchange in config.json.' : 'Connect a wallet.';
        cells.forEach(function (id) { valCell(id, '—'); });
        fillLines($(o.key + 'Open'), [], why);
        fillLines($(o.key + 'Pending'), [], why);
        setText(o.key + 'OpenCount', ''); setText(o.key + 'PendingCount', '');
        renderForm();
        return;
      }
      if (v.acct) {
        var pnl = 0;
        v.positions.forEach(function (p) { if (p.pnl != null) pnl += p.pnl; });
        valCell(o.key + 'Avail', fmtUsd(v.acct.available));
        valCell(o.key + 'Margin', fmtUsd(v.acct.margin + v.acct.pending), '', v.acct.pending > 0 ? fmtUsd(v.acct.pending) + ' in open requests' : '');
        valCell(o.key + 'Pnl', fmtUsd(pnl, true), signCls(pnl));
      } else {
        cells.forEach(function (id) { valCell(id, '—'); });
      }
      setText(o.key + 'OpenCount', v.positions.length ? String(v.positions.length) : '');
      fillLines($(o.key + 'Open'), v.positions.map(positionLine), v.acct ? 'No open positions.' : 'Loading…');

      var reqs = [];
      v.positions.forEach(function (p) { var cr = v.closes[String(p.id)]; if (cr) reqs.push(closeLine(p, cr)); });
      Object.keys(v.opens).sort(function (x, y) { return Number(x) - Number(y); }).forEach(function (id) { reqs.push(openLine(v.opens[id])); });
      setText(o.key + 'PendingCount', reqs.length ? String(reqs.length) : '');
      var empty = !v.acct ? 'Loading…' : v.acct.pending > 0 && !Object.keys(v.opens).length ? 'Scanning requests…' : 'No pending requests.';
      fillLines($(o.key + 'Pending'), reqs, empty);
      renderForm();
    }

    /* Countdowns between reads; a request that changes window is redrawn with its new button. */
    function tick() {
      var spans = document.querySelectorAll('#' + o.key + 'Pending [data-at]');
      for (var i = 0; i < spans.length; i++) {
        var ph = phase(Number(spans[i].getAttribute('data-at')));
        if (ph.phase !== spans[i].getAttribute('data-phase')) { render(); return; }
        spans[i].textContent = stateText(ph);
      }
    }

    function refresh() {
      if (!v || !o.read()) { render(); return Promise.resolve(); }
      var s = v;
      return readHead().then(function () {
        return readAccount(s).catch(function (e) {
          if (!s.acct && !s.warned) { s.warned = true; toast('Could not read the ' + o.name + ' account: ' + describeError(e), 'err'); }
        }).then(function () {
          return readOpens(s).catch(none);
        });
      }).catch(none).then(render);
    }

    function onAccount() {
      var a = wallet.account;
      if (v && a && sameAddr(v.addr, a)) { render(); return; }
      v = a ? fresh(a) : null;
      render();
      refresh();
    }

    function init() {
      var bind = function (id, fn) { var b = $(id); if (b) b.addEventListener('click', fn); };
      bind(o.key + 'Withdraw', withdraw);
      bind(o.key + 'Max', function () { if (v && v.acct) $(o.key + 'Amount').value = window.ethers.formatUnits(v.acct.availableRaw, 6); });
      v = wallet.account ? fresh(wallet.account) : null;
      render();
      setInterval(function () { if (!document.hidden) tick(); }, 1000);
    }

    return { init: init, refresh: refresh, onAccount: onAccount, prepare: prepare, every: EVERY_MS.closeOut, closeOut: true };
  }

  var v2Page = closeOutPage({ key: 'v2', name: 'v2', exchange: 'v2Exchange', abi: V2_EXCHANGE_ABI, deployBlock: v2DeployBlock,
    read: function () { return read.v2; }, iface: function () { return v2Iface; } });
  var v3Page = closeOutPage({ key: 'v3', name: 'v3', exchange: 'v3Exchange', abi: V3_EXCHANGE_ABI, deployBlock: v3DeployBlock,
    read: function () { return read.v3; }, iface: function () { return v3Iface; } });

  /* ---- theme, header, start ------------------------------------------------------- */

  function initTheme() {
    var btn = $('themeToggle');
    var root = document.documentElement;
    var meta = document.querySelector('meta[name="theme-color"]');
    function apply(night, persist) {
      if (night) root.setAttribute('data-theme', 'night'); else root.removeAttribute('data-theme');
      if (btn) { btn.setAttribute('aria-pressed', night ? 'true' : 'false'); btn.textContent = night ? 'Paper' : 'Night'; }
      if (meta) meta.setAttribute('content', cssVar('--page', '#f4ecd8'));
      if (persist) lsSet(THEME_KEY, night ? 'night' : 'paper');
    }
    apply(root.getAttribute('data-theme') === 'night', false);
    if (btn) btn.addEventListener('click', function () { apply(root.getAttribute('data-theme') !== 'night', true); });
  }

  var PAGES = { portfolio: portfolio, house: housePage, confetti: confettiPage, leaderboard: leaderboard, v2: v2Page, v3: v3Page };

  /* Nothing is read or sent until the exchange's getters have been checked; retried while the RPC is down. */
  function prepareExchange() {
    if (!read.ex) { toast('config.json names no exchange: chain reads are off.', 'err', null, 0); return null; }
    var checked = function () {
      return checkExchange().catch(function () {
        return new Promise(function (res) { setTimeout(res, 5000); }).then(checked);
      });
    };
    return checked().then(function () { return loadInstruments(); }).catch(function (e) { toast('Could not read markets from the exchange: ' + describeError(e), 'err'); });
  }

  function start() {
    initTheme();
    initPhone();
    var cb = $('connectBtn');
    if (cb) cb.addEventListener('click', function () { if (wallet.account) disconnect(); else connect(); });
    page = PAGES[document.body.getAttribute('data-page')] || null;
    if (!window.ethers) { toast('ethers.js did not load: chain reads are off.', 'err', null, 0); return; }
    listenForProviders();
    initRead();
    renderWallet();
    if (!page) return;
    if (!page.closeOut) initGate();
    /* The local demo (DEMO, 127.0.0.1 only) on a page that has one: no exchange check, no chain, no wallet. */
    var demo = !!(DEMO && page.demo);
    /* What needs no exchange check starts now (the Confetti page's swap box). */
    if (page.early && !demo) page.early();
    /* The v2 / v3 pages read their own exchange only (their own prepare); every other page the exchange. */
    var ready = demo ? Promise.resolve() : page.prepare ? page.prepare() : prepareExchange();
    if (!ready) return;
    ready.then(function () {
      page.init();
      if (demo) page.demo();
      var running = false;
      var tick = function () {
        if (document.hidden || running) return;
        running = true;
        var done = function () { running = false; };
        page.refresh().then(done, done);
      };
      tick();
      setInterval(tick, page.every);
      document.addEventListener('visibilitychange', tick);
      if (!demo) setTimeout(tryAutoConnect, 50);
    });
  }

  function init() {
    loadConfig().then(function (c) {
      cfg = c || {};
      initHouseBots(cfg.houseBots);
      var bad = pinConfig(cfg);
      start();
      if (bad.length) {
        console.error('config.json does not match the pinned values; using the pinned ones. Differences: ' + bad.join(', '));
        toast('config.json does not match this site\'s pinned values (' + bad.join(', ') + '). Using the pinned ones.', 'err', null, 0);
      }
    }).catch(function (e) {
      cfg = { contracts: {}, markets: [] };
      pinConfig(cfg);
      start();
      toast('Could not load config.json: ' + (e && e.message ? e.message : e) + '.', 'err', null, 0);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
