/* confetti_  —  fetti.js
   FETTI levels and money back on the cream pages (the owner, 2026-11-19: "i want fetti to be an exchange token", "plan it i
   want it part of v5", then "yes on all"; the plan: cf_w/fetti_token/PLAN.md, section 3.5).

   What it is, in one line: stake a little FETTI and part of what your own trades paid in comes back as trading money, 7 days
   after each trade, as long as the FETTI stayed staked. Four levels, counted in FETTI (never in dollars): 0.05 / 0.5 / 3 / 15
   FETTI for 10 / 20 / 30 / 40% back. Nothing here pays anyone: the payments are the perks bot's (ops/fetti/perks.py), from
   its own wallet, by Exchange.depositFor; this file only reads and shows, and runs the three wallet steps of "Get Level 1"
   (buy FETTI with HYPE on HyperSwap, approve, stake) for the person, each one confirmed in their own wallet.

   One small api, window.ConfettiFetti, for simple.js (the Home key, the level sheet, the result line, the Menu line, the
   Add money share) and tabs.js (the $FETTI page's "Your level" card, its counters and the unstake line).

   Where the numbers come from:
   - the levels: perks.json "levels" (the bot's own rules file, ops/fetti/rules.json, as it publishes them), else config.json
     fetti.levels, else the plan's launch numbers;
   - what is coming back to a wallet, what its trades would have brought at each level, the level it held for the last 7
     days: perks.json (written by the perks bot, recomputable from chain events with its --check);
   - what a wallet has staked, holds and may spend: the chain (Staking, FETTI, the wallet's HYPE), read here;
   - the dollar price of a level: the HyperSwap pool's own reserves and Hyperliquid's HYPE price, the price move included.
     It decides nothing: no rule anywhere reads a FETTI price to set a dollar amount.

   Switches (config.json "fetti"): moneyBack (the level key, the sheet and the lines; v5 configs only), draw.on (the weekly
   prize draw's entries) and table.on (the FETTI table's entries). The draw and the table ship off: with their switch off
   nothing of them is drawn or read.

   Every address a send goes to is pinned below and must equal config.json; the pool is checked on chain before the first send
   (the $FETTI page's own swap box check). No key is ever asked for or held: the wallet signs. */
(function () {
  'use strict';

  /* ---- BEGIN PINNED FETTI (FETTI, Staking, HyperSwap V2 FETTI / WHYPE) ---- */
  var PINS = {
    confetti: '0x995b36d7e33680fc6fa1db6fa4dc8e475b5233a2',
    staking: '0x2bf4976eb70cdcc03871ab60977fc4292587ce9a',
    router: '0xb4a9c4e6ea8e2191d2fa5b380452a634fb21240a',
    pair: '0x9cD9b6514f28325c8F18F1c5aBe311D5c737D930',
    whype: '0x5555555555555555555555555555555555555555'
  };
  /* ---- END PINNED FETTI ---- */
  var ZERO = '0x0000000000000000000000000000000000000000';
  var DEAD = '0x000000000000000000000000000000000000dEaD';
  var CHAIN_ID = 999;
  var RPC_HOSTS = ['rpc.hyperliquid.xyz', 'hyperliquid.drpc.org', 'rpc.purroofgroup.com'];
  var DEFAULT_RPC = 'https://rpc.hyperliquid.xyz/evm', DEFAULT_INFO = 'https://api.hyperliquid.xyz/info';

  /* The fragments this file calls, each one as tabs.js has it (the same names, so ops/check_site_abi.js can check them). */
  var STAKING_ABI = [
    'function stake(uint256 amount)',
    'function activeStakeOf(address user) view returns (uint256)',
    'function warmingOf(address user) view returns (uint256 amount, uint64 activatesAt)'
  ];
  var CONFETTI_ABI = [
    'function balanceOf(address account) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 value) returns (bool)'
  ];
  /* HyperSwap V2 is a Camelot-style fork: the native-coin buy is the ...SupportingFeeOnTransferTokens one with a referrer
     (zero: no share to anyone); getReserves carries each token's swap cost in FEE_DENOMINATOR parts. */
  var SWAP_ROUTER_ABI = [
    'function factory() view returns (address)',
    'function WETH() view returns (address)',
    'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline) payable'
  ];
  var SWAP_PAIR_ABI = [
    'function factory() view returns (address)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint16 token0FeePercent, uint16 token1FeePercent)',
    'function FEE_DENOMINATOR() view returns (uint256)'
  ];

  /* the plan's launch numbers, used only when neither perks.json nor config.json says otherwise */
  var LEVELS = [[0.05, 10], [0.5, 20], [3, 30], [15, 40]];
  var ADD_SHARE = [1, 0.5, 0, 0, 0];          /* the page's own share of an Add money order, by the level held 7 days */
  var HOLD_DAYS = 7, PAY_UTC_MIN = 30, PER_FETTI_DAY = 10, WARM_S = 3600;
  var BUY_ROOM = 0.01;                          /* the buy asks for this much more FETTI than the level needs: room for the price to move */
  var HYPE_KEEP = 20000000000000000n;           /* 0.02 HYPE stays in the wallet for the three steps' own network cost and the trades after */
  var STALE_S = 3 * 86400;                      /* a perks.json older than this says nothing personal */
  var POOL_MS = 15000, ME_MS = 15000, PERKS_MS = 300000, DRAW_MS = 300000;

  var X = {
    cfg: null, demo: false, fx: '', subs: [],
    perks: null, perksAt: 0, perksP: null, perksErr: false,
    draw: null, drawAt: 0, drawP: null,
    pool: null, poolAt: 0, poolP: null, hypeUsd: NaN,
    me: {}, meP: {}, read: null, checked: false, checkP: null
  };

  /* ---- small things ---- */

  function E() { return window.ethers; }
  /* an error whose message is the sentence the page shows (simple.js errText reads .plain) */
  function said(t) { var x = new Error(t); x.plain = t; return x; }
  function low(a) { return String(a || '').toLowerCase(); }
  function same(a, b) { return !!a && !!b && low(a) === low(b); }
  function num(v, d) { if (v == null || v === '' || typeof v === 'boolean') return d; var n = Number(v); return isFinite(n) ? n : d; }
  function fcfg() { var c = X.cfg && X.cfg.fetti; return c && typeof c === 'object' ? c : {}; }
  function sub(name) { var c = fcfg()[name]; return c && typeof c === 'object' ? c : {}; }
  function tell() { X.subs.forEach(function (f) { try { f(); } catch (e) { /* a reader never breaks this file */ } }); }
  function now() { return Date.now() / 1000; }
  function hostOk(url) {
    try { var u = new URL(url); return u.protocol === 'https:' && RPC_HOSTS.indexOf(u.hostname) >= 0; } catch (e) { return false; }
  }
  /* a same-site path only (perks.json, draw.json): never another host's file */
  function localPath(p, dflt) { p = String(p || dflt); return /^[a-z0-9_\-]+(\/[a-z0-9_\-]+)*\.json$/i.test(p) ? p : dflt; }
  function raw18(n) { var t = Number(n).toFixed(12); if (t.indexOf('.') >= 0) t = t.replace(/0+$/, '').replace(/\.$/, ''); return E().parseUnits(t || '0', 18); }      /* 12 places: no float tail (0.05 is 0.05) */
  function tok(rawv) { return Number(E().formatUnits(rawv, 18)); }

  /* Money and FETTI as the cream pages say them: $11.12, $0.40, 0.05 FETTI, 1.2 FETTI, 15 FETTI */
  function usd(n) { return n == null || !isFinite(n) ? '$—' : '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function usdAbout(n) {
    if (n == null || !isFinite(n)) return '$—';
    return n >= 100 ? '$' + Math.round(n).toLocaleString('en-US') : n >= 10 ? '$' + Math.round(n) : usd(n);
  }
  function fetti(n) {
    if (!isFinite(n)) return '— FETTI';
    var s = n >= 100 ? Math.round(n).toLocaleString('en-US') : n >= 1 ? String(Number(n.toFixed(2))) : String(Number(n.toPrecision(2)));
    return s + ' FETTI';
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function day(ts) { var d = new Date(ts * 1000); return MONTHS[d.getMonth()] + ' ' + d.getDate(); }
  function clock(ts) { var d = new Date(ts * 1000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

  /* ---- the rules ---- */

  function v5() { return !!X.cfg && Number(X.cfg.version) >= 5; }
  /* money back's pages: a v5 config with the switch on */
  function on() { return v5() && fcfg().moneyBack === true; }
  function drawOn() { return on() && sub('draw').on === true; }
  function tableOn() { return on() && sub('table').on === true; }

  /* [{ n, fetti, pct }], lowest first; a list that is not a clean ladder is not used */
  function cleanLevels(list) {
    if (!Array.isArray(list) || list.length < 1 || list.length > 8) return null;
    var out = [], last = 0, lastPct = 0;
    for (var i = 0; i < list.length; i++) {
      var x = list[i], f = Array.isArray(x) ? num(x[0], NaN) : x && num(x.fetti, NaN), p = Array.isArray(x) ? num(x[1], NaN) : x && num(x.pct != null ? x.pct : x.backPct, NaN);
      if (!(f > last) || !(p > lastPct) || !(p <= 100)) return null;
      out.push({ n: i + 1, fetti: f, pct: p }); last = f; lastPct = p;
    }
    return out;
  }
  function levels() {
    var p = fresh();
    return (p && cleanLevels(p.levels)) || cleanLevels(fcfg().levels) || cleanLevels(LEVELS);
  }
  function levelFor(count) { var n = 0; levels().forEach(function (l) { if (count + 1e-12 >= l.fetti) n = l.n; }); return n; }
  function level(n) { return levels().filter(function (l) { return l.n === n; })[0] || null; }
  function pctOf(n) { var l = level(n); return l ? l.pct : 0; }
  function holdDays() { var p = fresh(); return num(p && p.holdDays, num(fcfg().holdDays, HOLD_DAYS)); }
  function perFettiDay() { var p = fresh(); return num(p && p.perFettiDayUsd, num(fcfg().perFettiDayUsd, PER_FETTI_DAY)); }
  function payMin() { var p = fresh(); return num(p && p.payUtcMinute, num(fcfg().payUtcMinute, PAY_UTC_MIN)); }

  /* the first payment time on or after a trade's hold is over: blocks 7 days old, paid once a day at 00:30 UTC */
  function payDay(tradeTs) {
    var t = tradeTs + holdDays() * 86400, d = Math.floor(t / 86400) * 86400 + payMin() * 60;
    return d >= t ? d : d + 86400;
  }

  /* ---- perks.json: the bot's books, as public numbers ---- */

  function fresh() { var p = X.perks; return p && p.at > 0 && now() - p.at < STALE_S ? p : null; }
  function clean(p) {
    if (!p || typeof p !== 'object') return null;
    var out = { at: num(p.at, 0), levels: p.levels, holdDays: p.holdDays, perFettiDayUsd: p.perFettiDayUsd, payUtcMinute: p.payUtcMinute, totals: {}, wallets: {} };
    var t = p.totals || {};
    ['paid30', 'paidAll', 'pending', 'wallets'].forEach(function (k) { var v = num(t[k], NaN); if (v >= 0 && v < 1e9) out.totals[k] = v; });
    var w = p.wallets && typeof p.wallets === 'object' ? p.wallets : {};
    Object.keys(w).forEach(function (a) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return;
      var e = w[a] || {}, m = function (v) { v = num(v, 0); return v > 0 && v < 1e7 ? v : 0; }, lv = function (v) { v = Math.round(num(v, 0)); return v >= 0 && v <= 8 ? v : 0; };
      var nx = e.next && num(e.next.at, 0) > 0 ? { usd: m(e.next.usd), at: num(e.next.at, 0) } : null;
      out.wallets[low(a)] = { level: lv(e.level), held: lv(e.held), pending: m(e.pending), next: nx, paid30: m(e.paid30), would: Array.isArray(e.would) ? e.would.slice(0, 8).map(m) : [], ref: !!e.ref, skip: !!e.skip };
    });
    return out;
  }
  function loadPerks(force) {
    if (X.demo) return Promise.resolve(X.perks);
    if (!on()) return Promise.resolve(null);
    if (X.perksP) return X.perksP;
    if (!force && Date.now() - X.perksAt < PERKS_MS) return Promise.resolve(X.perks);
    X.perksAt = Date.now();
    var url = localPath(fcfg().perksUrl, 'perks.json');
    return X.perksP = fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw said('perks ' + r.status);
      return r.json();
    }).then(function (j) { X.perks = clean(j); X.perksErr = false; }, function () { X.perksErr = true; }).then(function () { X.perksP = null; tell(); return X.perks; });
  }
  function mine(account) { var p = fresh(); return p && account ? p.wallets[low(account)] || null : null; }
  function totals() { var p = fresh(); return p ? p.totals : null; }
  /* the level this wallet held for every hour of the last 7 days (perks.json): the Add money share goes by it, never by the live stake */
  function held(account) { var m = mine(account); return m && !m.skip ? m.held : 0; }
  function addShare(account) {
    if (!on()) return 1;
    var list = Array.isArray(fcfg().addShare) && fcfg().addShare.length ? fcfg().addShare : ADD_SHARE;
    var n = held(account), f = num(list[Math.min(n, list.length - 1)], 1);
    return f >= 0 && f <= 1 ? f : 1;
  }

  /* ---- the chain: the pool, the wallet's stake and balances ---- */

  function reader() {
    if (X.read) return X.read;
    var url = X.cfg && hostOk(X.cfg.rpcUrl) ? X.cfg.rpcUrl : DEFAULT_RPC, e = E();
    var pv = new e.JsonRpcProvider(url, { chainId: CHAIN_ID, name: 'hyperevm' }, { staticNetwork: true, batchMaxCount: 1, polling: false });
    X.read = { pv: pv, staking: new e.Contract(PINS.staking, STAKING_ABI, pv), fetti: new e.Contract(PINS.confetti, CONFETTI_ABI, pv),
      pair: new e.Contract(PINS.pair, SWAP_PAIR_ABI, pv), router: new e.Contract(PINS.router, SWAP_ROUTER_ABI, pv) };
    return X.read;
  }
  /* config.json must name exactly the pinned contracts, or this copy of the site buys and stakes nothing */
  function agreed() {
    var c = X.cfg || {}, k = c.contracts || {}, s = c.swap || {};
    return same(k.confetti, PINS.confetti) && same(k.staking, PINS.staking) && same(s.router, PINS.router) && same(s.pair, PINS.pair) && same(s.whype, PINS.whype);
  }
  /* the pool on chain against the pins (as the $FETTI page's swap box checks it): router's WETH, both factories, both tokens */
  function check() {
    if (X.demo) return Promise.resolve(true);
    if (X.checked) return Promise.resolve(true);
    if (X.checkP) return X.checkP;
    var r = reader();
    return X.checkP = Promise.all([r.router.WETH(), r.router.factory(), r.pair.factory(), r.pair.token0(), r.pair.token1()]).then(function (v) {
      var ok = same(v[0], PINS.whype) && same(v[1], v[2]) && ((same(v[3], PINS.whype) && same(v[4], PINS.confetti)) || (same(v[4], PINS.whype) && same(v[3], PINS.confetti)));
      X.checked = ok; X.whype0 = same(v[3], PINS.whype);
      return ok;
    }).finally(function () { X.checkP = null; });
  }
  function readHypeUsd() {
    var url = X.cfg && X.cfg.hyperliquidInfoUrl === DEFAULT_INFO ? X.cfg.hyperliquidInfoUrl : DEFAULT_INFO;
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }) })
      .then(function (r) { return r.json(); }).then(function (m) { var v = Number(m && m.HYPE); if (v > 0) X.hypeUsd = v; });
  }
  /* maxMs: how old a read may be (default 15 s; true: read now) */
  function loadPool(maxMs) {
    if (X.demo) return Promise.resolve(X.pool);
    if (X.poolP) return X.poolP;
    if (maxMs !== true && X.pool && Date.now() - X.poolAt < (maxMs > 0 ? maxMs : POOL_MS)) return Promise.resolve(X.pool);
    var r = reader();
    return X.poolP = Promise.all([r.pair.getReserves(), X.den ? X.den : r.pair.FEE_DENOMINATOR(), X.whype0 != null ? X.whype0 : r.pair.token0().then(function (t) { return same(t, PINS.whype); }), readHypeUsd().catch(function () { /* the last price */ })]).then(function (v) {
      var a = BigInt(v[0][0]), b = BigInt(v[0][1]), fa = BigInt(v[0][2]), fb = BigInt(v[0][3]);
      X.den = BigInt(v[1]); X.whype0 = v[2];
      X.pool = X.whype0 ? { hype: a, fetti: b, cost: fa } : { hype: b, fetti: a, cost: fb };
      X.poolAt = Date.now();
    }).catch(function () { /* the last pool, or none */ }).then(function () { X.poolP = null; tell(); return X.pool; });
  }
  /* the HYPE it takes to buy `out` FETTI (raw), the pair's own sum; null when the pool cannot give it */
  function hypeFor(out) {
    var p = X.pool, den = X.den || 100000n;
    if (!p || !(out > 0n) || out >= p.fetti) return null;
    return p.hype * out * den / ((p.fetti - out) * (den - p.cost)) + 1n;
  }
  /* a would-be buy of n FETTI: HYPE in, dollars, how far it moves the price */
  function quote(n) {
    if (!(n > 0)) return { fetti: 0, hype: 0n, usd: 0, move: 0 };
    var out = raw18(n), inn = hypeFor(out), p = X.pool;
    if (inn == null || !(X.hypeUsd > 0)) return null;
    var before = Number(p.hype) / Number(p.fetti), after = Number(p.hype + inn) / Number(p.fetti - out);
    return { fetti: n, out: out, hype: inn, usd: tok(inn) * X.hypeUsd, move: after / before - 1 };
  }
  function spot() { var p = X.pool; return p && X.hypeUsd > 0 ? Number(p.hype) / Number(p.fetti) * X.hypeUsd : NaN; }

  function loadMe(account, maxMs) {
    var a = low(account);
    if (!a) return Promise.resolve(null);
    if (X.demo) return Promise.resolve(X.me[a] || null);
    if (X.meP[a]) return X.meP[a];
    var m = X.me[a];
    if (maxMs !== true && m && Date.now() - m.read < (maxMs > 0 ? maxMs : ME_MS)) return Promise.resolve(m);
    var r = reader();
    return X.meP[a] = Promise.all([r.staking.activeStakeOf(account), r.staking.warmingOf(account), r.fetti.balanceOf(account), r.fetti.allowance(account, PINS.staking), r.pv.getBalance(account)]).then(function (v) {
      X.me[a] = { read: Date.now(), active: BigInt(v[0]), warming: BigInt(v[1][0]), warmAt: Number(v[1][1]), wallet: BigInt(v[2]), allowance: BigInt(v[3]), hype: BigInt(v[4]) };
    }).catch(function () { /* the last read, or none */ }).then(function () { delete X.meP[a]; tell(); return X.me[a] || null; });
  }
  /* what counts for the level now: the active stake, and a warm-up that is over (the contract moves it on the next action) */
  function counted(m) { if (!m) return NaN; return tok(m.active) + (m.warming > 0n && m.warmAt <= now() ? tok(m.warming) : 0); }
  /* a wallet's level as it stands: { known, count, level, warming, warmAt, wallet, hype } */
  function standing(account) {
    var m = X.me[low(account)];
    if (!m) return { known: false, count: NaN, level: 0 };
    var c = counted(m), warm = m.warming > 0n && m.warmAt > now();
    return { known: true, count: c, level: levelFor(c), warming: warm ? tok(m.warming) : 0, warmAt: warm ? m.warmAt : 0, wallet: tok(m.wallet), hype: m.hype, soon: warm ? levelFor(c + tok(m.warming)) : 0 };
  }

  /* ---- getting a level: what it takes, then the three wallet steps ---- */

  /* the steps to reach level n from where the wallet is: FETTI it still needs (after what it already has staked and holds),
     what it buys, the HYPE that costs, which steps the wallet will be asked for, and what stops it */
  function plan(account, n) {
    var l = level(n), m = X.me[low(account)];
    if (!l) return null;
    var st = standing(account), out = { n: n, pct: l.pct, target: l.fetti, have: st.known ? st.count + st.warming : NaN, steps: [], why: '' };
    if (!st.known || !m) { out.loading = true; return out; }
    var need = Math.max(0, l.fetti - out.have);
    out.need = need;
    if (need <= 1e-12) { out.done = true; return out; }
    var needRaw = raw18(need), fromWallet = m.wallet >= needRaw ? needRaw : m.wallet, buyRaw = needRaw - fromWallet;
    out.buy = tok(buyRaw);
    if (buyRaw > 0n) {
      if (!X.pool) { out.loading = true; return out; }
      var askRaw = buyRaw + buyRaw * BigInt(Math.round(BUY_ROOM * 10000)) / 10000n, inn = hypeFor(askRaw);
      if (inn == null || !(X.hypeUsd > 0)) { out.why = 'The FETTI pool cannot give a price right now. Try again in a minute.'; return out; }
      out.hypeIn = inn; out.minOut = buyRaw; out.usd = tok(inn) * X.hypeUsd;
      var q = quote(tok(askRaw)); out.move = q ? q.move : 0;
      out.steps.push('buy');
      var have = m.hype - HYPE_KEEP;
      if (have < inn) out.why = 'This takes ' + Number(tok(inn).toPrecision(3)) + ' HYPE from your wallet, plus a little for the network. Your wallet has ' + Number(tok(m.hype).toPrecision(3)) + ' HYPE.';
    } else out.usd = 0;
    /* the stake: everything bought, and what came from the wallet. Approve exactly that when the allowance is short */
    out.stakeEst = buyRaw > 0n ? m.wallet + raw18(out.buy * (1 + BUY_ROOM)) : needRaw;
    if (m.allowance < out.stakeEst) out.steps.push('approve');
    out.steps.push('stake');
    return out;
  }

  /* Run the steps of a plan with the person's own wallet (an EIP-1193 provider). onStep(i, of, word) says which one the wallet
     is showing. Each step waits for its receipt before the next is asked; a step that fails ends the run and says which. The
     run never asks for more than plan() showed: the buy's HYPE is the quoted amount, the stake is what the wallet holds of
     the level's FETTI after the buy, the approval is exactly that stake. alive(): false once the person closed the sheet. */
  function run(account, p, eth, onStep, alive) {
    alive = alive || function () { return true; };
    if (!p || p.done || p.why || p.loading || !p.steps.length) return Promise.reject(said(p && p.why ? p.why : 'Nothing to do.'));
    if (X.demo) return demoRun(account, p, onStep, alive);
    if (!agreed()) return Promise.reject(said('This copy of the site cannot buy FETTI: its settings do not match.'));
    var e = E(), of = p.steps.length, i = 0, me = account;
    function stop() { var x = said('Cancelled here. If your wallet is still asking, say no there too.'); x.cancelled = true; return x; }
    var signer = null;
    function wait(tx) { return tx.wait(1).then(function (rc) { if (!rc || rc.status !== 1) throw said('That step did not go through on chain. Nothing more was asked.'); return rc; }); }
    return check().then(function (ok) {
      if (!ok) throw said('The FETTI pool did not check out on chain. Nothing was sent.');
      return new e.BrowserProvider(eth).getSigner(me);
    }).then(function (s) {
      signer = s;
      return signer.provider.send('eth_chainId', []);
    }).then(function (hex) {
      if (parseInt(hex, 16) !== CHAIN_ID) throw said('Switch your wallet to HyperEVM first.');
      return loadMe(me, true);
    }).then(function (m) {
      if (!m) throw said('Your wallet could not be read just now. Try again.');
      var before = m.wallet;
      var chain = Promise.resolve();
      if (p.steps.indexOf('buy') >= 0) {
        chain = chain.then(function () {
          if (!alive()) throw stop();
          onStep(++i, of, 'buy');
          var router = new e.Contract(PINS.router, SWAP_ROUTER_ABI, signer), deadline = Math.floor(now()) + 600;
          return router.swapExactETHForTokensSupportingFeeOnTransferTokens(p.minOut, [PINS.whype, PINS.confetti], me, ZERO, deadline, { value: p.hypeIn }).then(wait);
        });
      }
      var amt = null;
      chain = chain.then(function () { return loadMe(me, true); }).then(function (m2) {
        if (!m2) throw said('Your wallet could not be read just now. Your FETTI is in your wallet: stake it on the $FETTI page.');
        var need = raw18(p.need);
        /* after a buy: all of it is staked (it was bought for this). Without one: the level's shortfall from the wallet */
        amt = p.steps.indexOf('buy') >= 0 ? m2.wallet : (m2.wallet >= need ? need : m2.wallet);
        if (!(amt > 0n) || (p.steps.indexOf('buy') >= 0 && m2.wallet <= before)) throw said('The FETTI did not arrive in your wallet. Nothing more was asked.');
        if (m2.allowance >= amt) return null;
        if (!alive()) throw stop();
        if (p.steps.indexOf('approve') < 0) { of++; p.steps.splice(p.steps.length - 1, 0, 'approve'); }
        onStep(++i, of, 'approve');
        return new e.Contract(PINS.confetti, CONFETTI_ABI, signer).approve(PINS.staking, amt).then(wait);
      }).then(function () {
        if (!alive()) throw stop();
        if (p.steps.indexOf('approve') >= 0 && i < of - 1) of--;          /* an approval that turned out not to be needed */
        onStep(++i, of, 'stake');
        return new e.Contract(PINS.staking, STAKING_ABI, signer).stake(amt).then(wait);
      }).then(function () { return loadMe(me, true); }).then(function () { return { staked: tok(amt) }; });
      return chain;
    });
  }

  /* ---- what a trade brings back ---- */

  /* t: { open, close } in dollars (what opening and closing it took), liq, ts (seconds), account, capped (the trade paid the
     capped share, not the full rate: money back leaves it out). Returns { usd, at, level, pct, capped, upTo } or null. */
  function tradeBack(t, n) {
    if (!t || t.capped) return null;
    var m = mine(t.account);
    if (m && m.skip) return null;
    var lv = n != null ? n : standing(t.account).level;
    var l = level(lv);
    if (!l) return null;
    var paid = (t.open > 0 ? t.open : 0) + (!t.liq && t.close > 0 ? t.close : 0);
    var base = paid * (m && m.ref === false ? 1 : 0.85);          /* a referred wallet's referrer took a share first: said low, never high */
    var v = base * l.pct / 100, cap = perFettiDay() * Math.max(l.fetti, standing(t.account).count || 0), upTo = false;
    if (cap > 0 && v > cap) { v = cap; upTo = true; }
    if (!(v >= 0.005)) return null;
    return { usd: v, at: payDay(t.ts || now()), level: lv, pct: l.pct, upTo: upTo };
  }

  /* ---- the weekly draw (off until its switch and its line in the terms) ---- */

  function loadDraw(force) {
    if (!drawOn()) return Promise.resolve(null);
    if (X.demo) return Promise.resolve(X.draw);
    if (X.drawP) return X.drawP;
    if (!force && Date.now() - X.drawAt < DRAW_MS) return Promise.resolve(X.draw);
    X.drawAt = Date.now();
    return X.drawP = fetch(localPath(sub('draw').url, 'draw.json'), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw said('draw ' + r.status); return r.json(); })
      .then(function (j) {
        var w = j && typeof j === 'object' ? j : {}, t = w.tickets && typeof w.tickets === 'object' ? w.tickets : {}, tk = {};
        Object.keys(t).forEach(function (a) { var v = num(t[a], 0); if (/^0x[0-9a-fA-F]{40}$/.test(a) && v > 0) tk[low(a)] = v; });
        X.draw = { prize: Math.max(0, num(w.prizeUsd, 0)), drawAt: num(w.drawAt, 0), total: Math.max(0, num(w.totalTickets, 0)), tickets: tk,
          last: w.last && typeof w.last === 'object' ? { winner: /^0x[0-9a-fA-F]{40}$/.test(w.last.winner) ? w.last.winner : '', prize: Math.max(0, num(w.last.prizeUsd, 0)) } : null };
      }, function () { /* the last one */ }).then(function () { X.drawP = null; tell(); return X.draw; });
  }

  /* ---- the demo (the page's own pretend account; nothing is read from the chain or sent) ---- */

  /* fx (localhost only, for the previews): none | l1 | l2 | warm | nohype | new */
  function demoSetup() {
    var e = E(), a = '0xde00000000000000000000000000000000000001', fx = X.fx || 'none', t = Math.floor(now());
    X.hypeUsd = 67; X.den = 100000n; X.whype0 = true;
    X.pool = { hype: e.parseUnits('223.9545', 18), fetti: e.parseUnits('67.6702', 18), cost: 300n };
    var st = { none: 0, l1: 0.06, l2: 0.62, warm: 0, nohype: 0, 'new': 0 }[fx] || 0;
    X.me[a] = { read: Date.now(), active: raw18(st), warming: fx === 'warm' ? raw18(0.0505) : 0n, warmAt: t + 2400, wallet: 0n, allowance: 0n, hype: fx === 'nohype' ? e.parseUnits('0.04', 18) : e.parseUnits('2.4', 18) };
    var w = {};
    if (fx !== 'new') {
      var pend = { l1: 0.62, l2: 12.4 }[fx] || 0;
      w[a] = { level: fx === 'l1' ? 1 : fx === 'l2' ? 2 : 0, held: fx === 'l1' ? 1 : fx === 'l2' ? 2 : 0, pending: pend, next: pend ? { usd: fx === 'l2' ? 1.84 : 0.11, at: payDay(t - 86400 * 3) } : null,
        paid30: fx === 'l2' ? 21.6 : fx === 'l1' ? 1.1 : 0, would: [2.1, 4.2, 6.3, 8.4], ref: false, skip: false };
    }
    X.perks = clean({ at: t - 1800, levels: LEVELS.map(function (l) { return { fetti: l[0], pct: l[1] }; }), holdDays: HOLD_DAYS, totals: { paid30: 182.4, paidAll: 182.4, pending: 61.2, wallets: 23 }, wallets: w });
    X.draw = { prize: 38.5, drawAt: t + 3 * 86400, total: 1240, tickets: {}, last: null };
    X.draw.tickets[a] = 64;
  }
  function demoRun(account, p, onStep, alive) {
    var of = p.steps.length, i = 0, a = low(account);
    function step(word) {
      return new Promise(function (ok, no) {
        if (!alive()) { var x = said('Cancelled here.'); x.cancelled = true; no(x); return; }
        onStep(++i, of, word); setTimeout(ok, 1100);
      });
    }
    var c = Promise.resolve();
    p.steps.forEach(function (s) { c = c.then(function () { return step(s); }); });
    return c.then(function () {
      var m = X.me[a];
      if (m) { m.warming += raw18(p.need * (p.steps.indexOf('buy') >= 0 ? 1 + BUY_ROOM : 1)); m.warmAt = Math.floor(now()) + WARM_S; m.hype -= p.hypeIn || 0n; }
      tell();
      return { staked: p.need };
    });
  }

  /* ---- start ---- */

  /* setup(cfg, { demo }): once per page, with its config. Reads start when a page asks (loadPerks, loadPool, loadMe). */
  function setup(cfg, opts) {
    X.cfg = cfg || {};
    X.demo = !!(opts && opts.demo);
    if (X.demo) {
      try {
        var hn = String(location.hostname || ''), q = new URLSearchParams(location.search).get('fx');
        X.fx = (hn === 'localhost' || hn === '127.0.0.1') && /^(none|l1|l2|warm|nohype|new)$/.test(q || '') ? q : 'none';
      } catch (e) { X.fx = 'none'; }
      demoSetup();
    }
    tell();
  }

  window.ConfettiFetti = {
    setup: setup, on: on, drawOn: drawOn, tableOn: tableOn, demo: function () { return X.demo; },
    subscribe: function (f) { X.subs.push(f); },
    levels: levels, level: level, levelFor: levelFor, pctOf: pctOf, holdDays: holdDays, perFettiDay: perFettiDay, payDay: payDay,
    loadPerks: loadPerks, mine: mine, totals: totals, held: held, addShare: addShare, perksAt: function () { var p = fresh(); return p ? p.at : 0; },
    loadPool: loadPool, quote: quote, spot: spot, hypeUsd: function () { return X.hypeUsd; },
    loadMe: loadMe, standing: standing, plan: plan, run: run, canSend: function () { return X.demo || agreed(); },
    tradeBack: tradeBack,
    demoMe: function (account) { return X.demo ? X.me[low(account)] || null : null; },
    loadDraw: loadDraw, draw: function () { return drawOn() ? X.draw : null; }, tableHref: function () { var h = String(sub('table').href || ''); return tableOn() && /^[a-z0-9_\-]+\.html(\?[a-z0-9=&_\-]*)?$/i.test(h) ? h : ''; },
    fmt: { usd: usd, about: usdAbout, fetti: fetti, day: day, clock: clock },
    DEAD: DEAD, PINS: PINS
  };
})();
