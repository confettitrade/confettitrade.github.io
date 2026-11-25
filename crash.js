/* confetti_ — crash.js
   The crash page (crash.html, crash.css): one round for everyone, one number climbing from 1.00x, one key under the thumb.

   The round is the round server's (CRASH_SPEC.md): BETTING (bets taken) -> LOCKING (the bets go on chain) -> FLIGHT (the
   multiplier climbs, m(t) = e^(0.00006 t)) -> CRASHED (the result) -> the next round. This page keeps what the server says
   and draws it. It decides nothing: the crash point was fixed before the round, the contract pays.

   Where the money is: a bet plays from the visitor's own wallet's USDC. Nothing is deposited anywhere first. Set up once
   (two wallet confirmations: allow USDC, and let a key kept in this browser bet and cash out for this wallet, up to an
   amount, until a date), then no wallet window opens in a round: a bet and a cash-out are messages signed by that key.

   Two sockets, one page:
   - live: config.json has contracts.crash and crash.api. The socket is wss://<api>/crash/ws.
   - demo: crash.html?demo=1, or while either config value is empty (the page then also says "Coming soon"). The socket is
     crashdemo.js: a round server in the page, the same states, curve and messages, pretend money and players.
   Everything below the socket (the clock, the round, the stage, the key, the sheets) is the same code for both.

   The clock: the server's time is measured (ping / pong; the sample with the shortest round trip wins) and the multiplier
   is drawn on every animation frame from the round's flightStartMs and that measure. No timer counts it up, so it never
   drifts, and a message that arrives late changes nothing on screen.

   The frame: one canvas holds the number, the line and the paper piece. Per frame nothing else is touched but the key's
   own figure (one text node) while there is money in the air. Every other word on the page changes only when a message
   or a press changes it. */
(function () {
  'use strict';

  var E = window.ethers, GW = window.ConfettiGameWallet || null, M = window.ConfettiCrashMath;
  var LS = { my: 'confetti.crash.bet.', key: 'confetti.crash.session.', amt: 'confetti.crash.amount', auto: 'confetti.crash.auto', nonce: 'confetti.crash.nonce.' };
  var DEMO_ME = '0xDE00000000000000000000000000000000000001';
  var BET_SPAN = 6000;                      /* a betting window, when the server's first word about it came late */
  var SAID_WON = 2400, SAID_LOST = 1800;    /* how long a result holds the key before the next bet is offered */
  var BUDGETS = [200, 1000, 5000, 25000], SESSION_DAYS = 30;

  /* the contract, as this page calls and reads it (contracts/src/crash/Crash.sol; CRASH_SPEC_ADDENDA.md) */
  var ABI = [
    'function MIN_BET() view returns (uint256)', 'function paused() view returns (bool)', 'function edgeBps() view returns (uint16)',
    'function salt() view returns (bytes32)', 'function terminal() view returns (bytes32)', 'function chainBase() view returns (uint64)',
    'function crashPoint(bytes32 seed, uint16 edgeBps) view returns (uint256)',
    'function sessions(address player) view returns (address key, uint64 expiry, uint256 stakeLeft)',
    'function lastBetOf(address player) view returns (uint64 round, uint32 index)', 'function owed(address player) view returns (uint256)',
    'function getRound(uint64 round) view returns (tuple(uint64 lockedAt, uint64 refundAt, uint32 bets, uint32 cursor, uint16 edgeBps, uint8 state, uint64 maxWin, uint64 stakeTotal, uint64 crashX100, uint64 paid, uint128 reserveCap, uint128 reservedAtLock))',
    'function getBet(uint64 round, uint32 index) view returns (tuple(address player, uint64 stake, uint32 autoX100))',
    'function setSession(address key, uint64 expiry, uint256 maxStakeTotal)', 'function revokeSession()', 'function refund(uint64 round)', 'function claim()'
  ];
  var ERC20 = ['function balanceOf(address) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 amount) returns (bool)'];
  var RS = { LOCKED: 1, REVEALED: 2, SETTLED: 3, EXPIRED: 4 };      /* a round's state on chain */

  /* ---- small things ---- */
  function $(id) { return document.getElementById(id); }
  function add(n, kids) {
    (Array.isArray(kids) ? kids : [kids]).forEach(function (k) { if (k == null || k === false) return; n.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k))); });
    return n;
  }
  function h(tag, cls, kids) { var n = document.createElement(tag); if (cls) n.className = cls; if (kids != null) add(n, kids); return n; }
  function btn(cls, kids, fn) { var b = h('button', cls, kids); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; }
  function txt(n, s) { if (n && n.textContent !== s) n.textContent = s; }
  function show(n, on) { if (n && n.hidden === !!on) n.hidden = !on; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function isAddr(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a); }
  function perf() { return performance.now(); }
  function usd(n) { return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function usdShort(n) { return Math.abs(n - Math.round(n)) < 0.005 ? '$' + Math.round(n).toLocaleString('en-US') : usd(n); }
  function from6(v) { return Number(v) / 1e6; }
  function to6(n) { return Math.round(n * 1e6); }
  function xs(x100) { return (x100 / 100).toFixed(2) + 'x'; }
  function short(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; }
  /* dollars and cents from whole cents, with no allocation to speak of: this one runs every frame */
  function centsText(c) {
    var d = Math.floor(c / 100), r = c - d * 100, s = String(d);
    if (d >= 1000) s = s.slice(0, s.length - 3) + ',' + s.slice(s.length - 3);
    return '$' + s + (r < 10 ? '.0' : '.') + r;
  }
  /* what a cash-out at x100 pays, in whole cents, as the contract works it out (stake x X / 100, never over stake + the most one bet may win) */
  function payCents(stake6, x100) {
    var p = Math.floor(stake6 * x100 / 100);
    if (S.maxWin6 != null && p > stake6 + S.maxWin6) p = stake6 + S.maxWin6;
    return Math.floor(p / 10000 + 1e-9);
  }

  /* ---- state: every word and number on the page comes from here ---- */
  var el = {};
  var S = {
    cfg: null, demo: true, soon: false, walk: false, game: '', api: '',
    ready: false, netDown: false,
    round: 0, phase: '', phaseEnds: null, flightStart: null, betSpan: BET_SPAN,
    crashRound: 0, crashX100: 0, crashMs: 0, crashPerf: 0,
    edgeBps: 100, minBet: 1, maxBet: null, maxWin6: null, paused: false,
    bets: [], history: [], chainInfo: null, newTag: 0,
    text: '10', usd: 10, autoText: '', auto: 0, autoBad: false, every: false, touched: false,
    my: null,                 /* this visitor's bet: { round, stake6, usd, auto, cap, nonce, sig, state, label, sentX, outX, outAt, endAt, paid } */
    queued: false,            /* "Bet next round" was pressed: the bet goes in when the next round opens */
    cancelled: null, owed: null, last: null,
    account: null, eth: null, walletName: '', chainOk: true, bal: null, allowance: 0, hype: null,
    sess: null,               /* the session the contract holds for this wallet: { key, expiry, left6 (what it may still stake) } */
    key: null,                /* the key kept in this browser for this wallet (an ethers Wallet), when it is the contract's */
    fresh: { allow: null, sess: null, gone: null },      /* what this page just set on chain (a lagging node does not undo it) */
    stuck: null,              /* a bet of this wallet in a round that was never settled: { round, usd, at (when it can be taken back) } */
    held: 0,                  /* a payout the token would not deliver, kept by the contract for this wallet */
    notice: '', busy: '', say: null
  };
  var NET = null;

  /* ---- the clock: the server's time, from this device's steady clock and a measured offset ---- */
  var CLK = { off: null, target: null, samples: [], sent: {}, id: 0, timer: 0 };
  function clockSeen(serverMs) { if (CLK.off == null && serverMs > 0) { CLK.off = serverMs - perf(); CLK.target = CLK.off; } }
  function ping() { if (!NET) return; var id = ++CLK.id; CLK.sent[id] = perf(); NET.send({ t: 'ping', id: id }); }
  function pong(m) {
    var t0 = CLK.sent[m.id], t1 = perf(), best;
    if (t0 == null || !(m.serverMs > 0)) return;
    delete CLK.sent[m.id];
    CLK.samples.push({ rtt: t1 - t0, off: m.serverMs - (t0 + t1) / 2 });
    if (CLK.samples.length > 8) CLK.samples.shift();
    best = CLK.samples.reduce(function (a, b) { return b.rtt < a.rtt ? b : a; });
    CLK.target = best.off;
    if (CLK.off == null || Math.abs(CLK.target - CLK.off) > 400) CLK.off = CLK.target;      /* far out: set; near: eased in, below */
  }
  /* a better measure is eased in (at most 8% of real time), so the number never jumps */
  function clockStep(dt) {
    if (CLK.off == null || CLK.target === CLK.off) return;
    var d = CLK.target - CLK.off, lim = dt * 0.08;
    CLK.off += Math.max(-lim, Math.min(lim, d));
  }
  function pings() {
    clearTimeout(CLK.timer);
    var n = 0;
    (function go() { if (!document.hidden) ping(); CLK.timer = setTimeout(go, ++n < 6 ? 300 : 10000); })();
  }

  /* ==== the stage: the number, the line, the paper piece. One canvas, drawn every frame. ==== */
  var ST = { cv: null, c: null, w: 0, h: 0, dpr: 1, col: null, fBrand: 'sans-serif', fUi: 'sans-serif', cells: {}, fadeAt: 0, held: null, outs: [], bits: [], raf: 0, last: 0, grid: { cur: -1, prev: -1, at: 0, ms: 0 }, clear: 0, capLen: -1, capW: 0 };
  var STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];      /* gridlines, in hundredths */
  var TICKS = [1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000, 300000];                 /* time marks, in ms */
  function tokens() {
    var cs = getComputedStyle(el.root);
    function v(n, d) { var s = cs.getPropertyValue(n).trim(); return s || d; }
    ST.col = { ink: v('--ink', '#2a2520'), muted: v('--ink-muted', '#5f564b'), faint: v('--ink-faint', '#7a7060'), rule: v('--rule', '#d4cbba'), ruleS: v('--rule-strong', '#b8ad92'),
      pos: v('--pos', '#2e7a4c'), posT: v('--sm-pos-t', '#27693f'), negT: v('--sm-neg-t', '#a33d4a'), page: v('--page', '#f4ecd8'), raised: v('--raised', '#faf6ed'), sunken: v('--sunken', '#e8dec8') };
    ST.fBrand = v('--font-brand', 'sans-serif'); ST.fUi = v('--font-ui', 'sans-serif'); ST.cells = {};
  }
  function fit() {
    var r = el.stage.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
    if (!r.width || !r.height) return;
    ST.w = r.width; ST.h = r.height; ST.dpr = dpr;
    var pw = Math.round(r.width * dpr), ph = Math.round(r.height * dpr);
    if (ST.cv.width !== pw || ST.cv.height !== ph) { ST.cv.width = pw; ST.cv.height = ph; }
    ST.cells = {};
  }
  /* the number is set in cells of one width, so a changing digit moves nothing beside it */
  function cells(size) {
    var k = String(size), c = ST.cells[k], i, w = 0;
    if (c) return c;
    ST.c.font = '700 ' + size + 'px ' + ST.fBrand;
    for (i = 0; i < 10; i++) w = Math.max(w, ST.c.measureText(String(i)).width);
    c = ST.cells[k] = { d: w * 0.985, p: ST.c.measureText('.').width, one: ST.c.measureText('1').width };
    ST.c.font = '700 ' + Math.round(size * 0.5) + 'px ' + ST.fBrand;
    c.x = ST.c.measureText('x').width;
    return c;
  }
  /* the number's size: the biggest thing on the page, as big as the stage's width and height let it be */
  function numBase() { return Math.round(Math.min(84, Math.max(44, ST.w * 0.2), ST.h * 0.27)); }
  function numberSize(text) {
    var base = numBase(), c = cells(base), digits = text.replace(/\D/g, '').length;
    /* its right end stays short of where the line's tip settles (nine tenths across), so the two never meet */
    var w = digits * c.d + c.p + c.x + 4, room = 0.9 * (ST.w - 54) - 30;
    return w > room ? Math.floor(base * room / w) : Math.round(base);
  }
  function drawNumber(c, text, x, y, color) {
    var size = numberSize(text), cw = cells(size), i, ch, cx = x;
    c.fillStyle = color; c.textBaseline = 'alphabetic'; c.textAlign = 'center';
    c.font = '700 ' + size + 'px ' + ST.fBrand;
    for (i = 0; i < text.length; i++) {
      ch = text.charAt(i);
      if (ch === '.') { c.fillText('.', cx + cw.p / 2, y); cx += cw.p; }
      else { c.fillText(ch, cx + cw.d / 2, y); cx += cw.d; }
    }
    c.font = '700 ' + Math.round(size * 0.5) + 'px ' + ST.fBrand; c.textAlign = 'left';
    c.fillText('x', cx + 3, y);
    return cx + 3 + cw.x;
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  /* the picture of a flight at ms milliseconds: the scale widens as it climbs, so the tip settles high and to the right
     and the line bends under it */
  function drawFlight(c, ms, o) {
    var W = ST.w, H = ST.h, col = ST.col, L = 8, R = W - 46, T = 16, B = H - 22, pw = R - L, ph = B - T;
    /* the window a flight starts in: five seconds wide, up to 1.5x. The tip crosses it, settles nine tenths across and
       eight tenths up, and from there the scale widens under it. */
    var m = Math.exp(M.K * ms), tMax = Math.max(5000, ms / 0.9), mMax = Math.max(1.5, 1 + (m - 1) / 0.8), per = ph / (mMax - 1) / 100, i, a;
    function X(t) { return L + t / tMax * pw; }
    function Y(mm) { return B - (mm - 1) / (mMax - 1) * ph; }
    c.globalAlpha = o.alpha;
    /* the scale: a rule at every round multiplier that has room, its name at the right. When the scale has widened past a
       step the next one takes over in a third of a second, so two sets never crowd each other. Beside the number the rules
       start after it. */
    var want = 0, G = ST.grid; while (want < STEPS.length - 1 && STEPS[want] * per < 30) want++;
    if (G.cur < 0 || ms < G.ms - 1) { G.cur = want; G.prev = -1; G.at = -1e6; }
    else if (want !== G.cur) { G.prev = G.cur; G.cur = want; G.at = o.now; }
    G.ms = ms;
    var ga = o.still ? 1 : clamp01((o.now - G.at) / 320), top100 = Math.floor(mMax * 100), v, y, pass, st, al;
    c.lineWidth = 1; c.font = '500 12px ' + ST.fUi; c.textAlign = 'left'; c.textBaseline = 'middle'; c.strokeStyle = col.rule; c.fillStyle = col.faint;
    for (pass = 0; pass < 2; pass++) {
      st = pass ? G.cur : G.prev; al = pass ? ga : 1 - ga;
      if (st < 0 || al <= 0) continue;
      c.globalAlpha = o.alpha * al;
      for (v = Math.ceil(101 / STEPS[st]) * STEPS[st]; v <= top100; v += STEPS[st]) {
        y = Math.round(Y(v / 100)) + 0.5;
        c.beginPath(); c.moveTo(y < o.band ? Math.min(R, Math.max(L, o.clear)) : L, y); c.lineTo(R, y); c.stroke();
        if (y > 10) c.fillText(STEPS[st] % 100 === 0 ? (v / 100) + 'x' : (v / 100).toFixed(1) + 'x', R + 7, y);
      }
    }
    /* the floor (1.00x) and the seconds along it */
    c.globalAlpha = o.alpha; c.strokeStyle = col.ruleS;
    c.beginPath(); c.moveTo(L, Math.round(B) + 0.5); c.lineTo(R, Math.round(B) + 0.5); c.stroke();
    var t0 = 0; while (t0 < TICKS.length - 1 && TICKS[t0] / tMax * pw < 46) t0++;
    c.fillStyle = col.faint; c.textAlign = 'center'; c.textBaseline = 'top'; c.font = '500 11px ' + ST.fUi;
    for (v = TICKS[t0]; v <= tMax * 0.985; v += TICKS[t0]) {
      c.beginPath(); c.moveTo(Math.round(X(v)) + 0.5, B); c.lineTo(Math.round(X(v)) + 0.5, B + 4); c.stroke();
      c.fillText(v % 60000 === 0 ? (v / 60000) + 'm' : (v / 1000) + 's', X(v), B + 7);
    }
    c.textAlign = 'left'; c.textBaseline = 'middle'; c.font = '500 12px ' + ST.fUi; c.fillText('1x', R + 7, B);
    /* the line: m(t), sampled. After the crash its end has come away. */
    var N = 56, end = o.crashed ? 0.9 : 1, snap = o.crashed ? clamp01((o.now - o.crashPerf) / 520) : 0, t;
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath(); c.moveTo(X(0), Y(1));
    for (i = 1; i <= N; i++) { t = ms * end * i / N; c.lineTo(X(t), Y(Math.exp(M.K * t))); }
    c.lineTo(X(ms * end), B); c.lineTo(X(0), B); c.closePath();
    c.globalAlpha = o.alpha * 0.05; c.fillStyle = col.ink; c.fill();
    c.globalAlpha = o.alpha; c.strokeStyle = col.ink; c.lineWidth = 3.25;
    c.beginPath(); c.moveTo(X(0), Y(1));
    for (i = 1; i <= N; i++) { t = ms * end * i / N; c.lineTo(X(t), Y(Math.exp(M.K * t))); }
    c.stroke();
    var ax = X(ms * end), ay = Y(Math.exp(M.K * ms * end)), tx = X(ms), ty = Y(m), ang = Math.atan2(ty - Y(Math.exp(M.K * ms * 0.97)), tx - X(ms * 0.97));
    if (o.crashed) {
      /* the end that came away: it swings down from where it broke and fades; the stub keeps a frayed end */
      var e = snap * snap;
      if (snap < 1 && !o.still) {
        c.save(); c.translate(ax, ay); c.rotate(e * 1.5); c.globalAlpha = o.alpha * (1 - snap);
        c.beginPath(); c.moveTo(0, 0);
        for (i = 1; i <= 8; i++) { t = ms * (end + (1 - end) * i / 8); c.lineTo(X(t) - ax, Y(Math.exp(M.K * t)) - ay); }
        c.stroke(); c.restore();
      }
      c.globalAlpha = o.alpha; c.lineWidth = 2;
      if (ms > 80) {      /* (a round that crashed at 1.00x never left the floor: there is no end to fray) */
        c.beginPath(); c.moveTo(ax, ay); c.lineTo(ax + Math.cos(ang - 0.75) * 7, ay + Math.sin(ang - 0.75) * 7);
        c.moveTo(ax, ay); c.lineTo(ax + Math.cos(ang + 0.6) * 6, ay + Math.sin(ang + 0.6) * 6); c.stroke();
      }
    }
    /* this visitor's auto cash out, while it is still ahead: a dashed line at its height, named at the right */
    if (o.auto && o.auto / 100 <= mMax && !o.crashed) {
      var ya = Math.round(Y(o.auto / 100)) + 0.5;
      c.save(); c.globalAlpha = o.alpha * 0.85; c.strokeStyle = col.pos; c.lineWidth = 1.5; c.setLineDash([5, 4]);
      c.beginPath(); c.moveTo(ya < o.band ? Math.min(R, Math.max(L, o.clear)) : L, ya); c.lineTo(R, ya); c.stroke(); c.restore();
      c.font = '600 11px ' + ST.fUi; c.textAlign = 'right'; c.textBaseline = 'bottom'; c.fillStyle = col.posT; c.globalAlpha = o.alpha;
      c.fillText('auto ' + xs(o.auto), R - 2, ya - 3);
    }
    /* where others left: small rings on the line. Where this visitor left: a full dot and its number. */
    c.lineWidth = 1.5;
    for (i = 0; i < ST.outs.length; i++) {
      var q = ST.outs[i], qt = M.msFor(q.x);
      if (qt > ms * end || q.mine) continue;
      c.beginPath(); c.arc(X(qt), Y(q.x / 100), 3, 0, 6.2832); c.fillStyle = col.page; c.fill(); c.strokeStyle = col.muted; c.stroke();
    }
    var markX = null, markY = null;
    if (o.mine && M.msFor(o.mine) <= ms + 1) {
      var mt = M.msFor(o.mine), mx = X(mt), my = Y(o.mine / 100), lab = xs(o.mine), lw;
      markX = mx; markY = my;
      c.beginPath(); c.arc(mx, my, 6, 0, 6.2832); c.fillStyle = col.pos; c.fill(); c.lineWidth = 2; c.strokeStyle = col.page; c.stroke();
      c.font = '700 13px ' + ST.fUi; lw = c.measureText(lab).width + 14;
      /* its number hangs under the dot, in the room under the line; a dot near the floor carries it above instead */
      var bx = Math.max(L, Math.min(R - lw, mx - 8)), by = my + 12;
      if (by + 22 > B - 3) { bx = Math.max(L, Math.min(R - lw, mx - lw + 8)); by = my - 34; }
      if (bx < o.clear && by < o.band) bx = Math.min(R - lw, o.clear);      /* never over the number */
      c.fillStyle = col.raised; c.strokeStyle = col.pos; c.lineWidth = 1.5;
      c.beginPath(); roundRect(c, bx, by, lw, 22, 6); c.fill(); c.stroke();
      c.fillStyle = col.posT; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(lab, bx + lw / 2, by + 11.5);
    }
    /* the paper piece riding the tip; at the crash it lets go and falls */
    var px = tx, py = ty, rot = ang, flut = 1, pa = o.alpha;
    if (!o.still) { rot += Math.sin(o.now / 230) * 0.28; flut = 0.72 + 0.28 * Math.cos(o.now / 310); }
    if (o.crashed) {
      var ft = (o.now - o.crashPerf) / 1000;
      if (o.still) pa = 0;
      else { px += 46 * ft; py += -70 * ft + 620 * ft * ft; rot += ft * 9; flut = Math.cos(ft * 13); if (py > H + 24) pa = 0; }
    }
    if (pa > 0) {
      c.save(); c.globalAlpha = pa; c.translate(px, py); c.rotate(rot); c.scale(1, flut);
      c.fillStyle = flut < 0 ? '#1f5a37' : col.pos; c.fillRect(-10, -6.5, 20, 13);
      c.restore();
    }
    c.globalAlpha = 1;
    return { x: tx, y: ty, markX: markX, markY: markY };
  }
  function roundRect(c, x, y, w, hh, r) { c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + hh, r); c.arcTo(x + w, y + hh, x, y + hh, r); c.arcTo(x, y + hh, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  /* a handful of paper from the point this visitor cashed out at (not on reduced motion) */
  function burst(x, y) {
    if (reduced()) return;
    var inks = [ST.col.ink, ST.col.pos, '#b44855', '#8a7f66', '#9a6400', ST.col.pos], i, a, v;
    ST.bits = [];
    for (i = 0; i < 30; i++) {
      a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6; v = 150 + Math.random() * 260;
      ST.bits.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: 5 + Math.random() * 6, hh: 3 + Math.random() * 4, r: Math.random() * 6.3, vr: (Math.random() - 0.5) * 14, c: inks[i % inks.length], t0: perf() });
    }
  }
  function drawBits(c, now) {
    if (!ST.bits.length) return;
    var live = false, i, b, t;
    for (i = 0; i < ST.bits.length; i++) {
      b = ST.bits[i]; t = (now - b.t0) / 1000;
      if (t > 1.4) continue;
      live = true;
      c.save(); c.globalAlpha = Math.max(0, 1 - Math.max(0, t - 0.8) / 0.6);
      c.translate(b.x + b.vx * t * (1 - 0.25 * t), b.y + b.vy * t + 480 * t * t); c.rotate(b.r + b.vr * t);
      c.fillStyle = b.c; c.fillRect(-b.w / 2, -b.hh / 2, b.w, b.hh); c.restore();
    }
    if (!live) ST.bits = [];
  }
  function draw(now) {
    var c = ST.c, W = ST.w, H = ST.h, col = ST.col, still = reduced();
    if (!c || !W) return;
    c.setTransform(ST.dpr, 0, 0, ST.dpr, 0, 0); c.clearRect(0, 0, W, H);
    var sNow = CLK.off != null ? now + CLK.off : null, ph = S.phase, my = S.my && S.my.round === S.round ? S.my : null;
    var num = '1.00', numCol = col.faint, cap = '', capCol = col.muted, bar = -1, tip = null;
    var mineX = my && my.state === 'out' ? my.outX : 0, base = numBase(), ny = 12 + Math.round(base * 0.76), cy = ny + (H < 210 ? 20 : 25), band = cy + 12, clear = ST.clear || 0;
    if (ph === 'FLIGHT' && sNow != null && S.flightStart != null) {
      var ms = Math.max(0, sNow - S.flightStart);
      tip = drawFlight(c, ms, { alpha: 1, crashed: false, now: now, still: still, mine: mineX, band: band, clear: clear, auto: my && (my.state === 'in' || my.state === 'pending') ? my.auto : 0 });
      ST.held = { ms: ms, mine: mineX }; ST.restAt = 0; ST.fadeAt = 0;
      num = (M.x100At(ms) / 100).toFixed(2); numCol = S.netDown ? col.faint : col.ink;
      if (S.netDown) cap = 'Connection lost. Reconnecting…';
      else if (my && my.state === 'out') { cap = 'You cashed out at ' + xs(my.outX); capCol = col.posT; }
      else if (my && (my.state === 'in' || my.state === 'pending')) cap = 'You are in for ' + usdShort(my.usd) + (my.auto ? ' · auto ' + xs(my.auto) : '');
    } else if (ph === 'CRASHED' && S.crashRound === S.round) {
      drawFlight(c, S.crashMs, { alpha: 1, crashed: true, crashPerf: S.crashPerf, now: now, still: still, mine: mineX, band: band, clear: clear });
      ST.held = { ms: S.crashMs, mine: mineX }; ST.fadeAt = 0; ST.restAt = 0;
      num = (S.crashX100 / 100).toFixed(2); numCol = col.negT; cap = 'Crashed at ' + xs(S.crashX100); capCol = col.negT;
    } else {
      /* between rounds: the last line fades off the paper, the number waits at 1.00x */
      if (ST.held) {
        if (!ST.fadeAt) ST.fadeAt = now;
        var f = still ? 1 : (now - ST.fadeAt) / 420;
        if (f >= 1) ST.held = null;
        else drawFlight(c, ST.held.ms, { alpha: 1 - f, crashed: true, crashPerf: -1e6, now: now, still: true, mine: ST.held.mine, band: band, clear: clear });
      }
      /* at rest the stage is the start line: the scale as a flight begins it, the paper piece waiting at 1.00x */
      if (!ST.held) {
        if (!ST.restAt) ST.restAt = now;
        drawFlight(c, 0, { alpha: still ? 1 : clamp01((now - ST.restAt) / 260), crashed: false, now: now, still: true, mine: 0, band: band, clear: clear });
      } else ST.restAt = 0;
      if (!S.ready) { num = ''; cap = S.netDown ? 'Reconnecting…' : 'One moment…'; }
      else if (S.paused) cap = 'The table is paused';
      else if (ph === 'BETTING' && sNow != null && S.phaseEnds != null && S.phaseEnds - sNow > 0) {
        var left = S.phaseEnds - sNow;
        cap = 'Next round in ' + (Math.ceil(left / 100) / 10).toFixed(1); bar = clamp01(left / S.betSpan);
      } else if (ph === 'LOCKING' || ph === 'BETTING') cap = 'Starting';
      else if (ph === 'FLIGHT' || ph === 'CRASHED') cap = 'One moment…';
    }
    var right = num ? drawNumber(c, num, 8, ny, numCol) : 0;
    if (cap) {
      c.font = '600 ' + (H < 210 ? 13 : 15) + 'px ' + ST.fUi; c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillStyle = capCol; c.fillText(cap, 10, cy);
      if (cap.length !== ST.capLen) { ST.capLen = cap.length; ST.capW = c.measureText(cap).width; }
      right = Math.max(right, 10 + ST.capW);
    }
    ST.clear = right + 14;
    if (bar >= 0) {
      c.fillStyle = col.sunken; c.beginPath(); roundRect(c, 10, cy + 10, 168, 6, 3); c.fill();
      if (bar > 0.01) { c.fillStyle = col.ink; c.beginPath(); roundRect(c, 10, cy + 10, Math.max(6, 168 * bar), 6, 3); c.fill(); }
    }
    if (ST.burstNext && tip && tip.markX != null) { ST.burstNext = false; burst(tip.markX, tip.markY); }
    drawBits(c, now);
  }

  /* ---- the frame ---- */
  var KEY = { act: '', mode: '', text: '', since: 0, swallow: 0, timer: 0 };
  function frame(now) {
    ST.raf = requestAnimationFrame(frame);
    var dt = Math.min(100, now - (ST.last || now)); ST.last = now;
    clockStep(dt);
    draw(now);
    /* the one word that changes every frame: what the key would cash out right now */
    if (KEY.mode === 'cash' && S.my && S.flightStart != null && CLK.off != null) {
      var x = M.x100At(Math.max(0, now + CLK.off - S.flightStart)), my = S.my;
      if ((my.auto && x >= my.auto) || x >= my.cap) { my.autoHit = true; paintKey(); return; }
      var t = 'Cash out ' + centsText(payCents(my.stake6, x));
      if (t !== KEY.text) { KEY.text = t; el.goT.firstChild.nodeValue = t; }
    }
  }

  /* ==== the socket ==== */
  function liveNet(api) {
    var host = String(api).replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, ''), ws = null, tries = 0, shut = false;
    function open() {
      try { ws = new WebSocket('wss://' + host + '/crash/ws'); } catch (e) { retry(); return; }
      ws.onopen = function () { tries = 0; S.netDown = false; pings(); paintAll(); };
      ws.onmessage = function (ev) { var m = null; try { m = JSON.parse(ev.data); } catch (e) { m = null; } if (m) onMsg(m); };
      ws.onclose = function () { if (!shut) retry(); };
      ws.onerror = function () { try { ws.close(); } catch (e) { /* closing */ } };
    }
    function retry() { S.netDown = true; paintAll(); setTimeout(open, Math.min(8000, 500 * Math.pow(2, tries++))); }
    fetch('https://' + host + '/crash/state', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) { if (m && !S.ready) { m.t = 'state'; onMsg(m); } }).catch(function () { /* the socket brings it */ });
    open();
    return { send: function (m) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; }, close: function () { shut = true; try { ws.close(); } catch (e) { /* closed */ } } };
  }

  /* ==== what the server says ==== */
  function mineLabel(p) { return p === 'You' || (S.my && S.my.round === S.round && S.my.label && p === S.my.label); }
  function normBet(b) { return { p: String(b.p), stake6: Number(b.stake), auto: Number(b.auto) || 0, out: Number(b.out) || 0, lost: false, isNew: false }; }
  function onMsg(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'pong') { pong(m); return; }
    if (m.t === 'state') { onState(m); return; }
    if (m.round != null && m.round !== S.round && m.t !== 'settled' && m.t !== 'refunding' && m.t !== 'refunded') return;       /* a word about another round: the next state brings this one */
    if (m.t === 'bet') {
      var b = normBet(m);
      if (!S.bets.some(function (x) { return x.p === b.p; })) { b.isNew = true; S.bets.push(b); }
      paintCount(); paintPlayers();
      return;
    }
    /* to this visitor alone: the bet is in, and this is its row's label for the round (shown as "You") */
    if (m.t === 'betAccepted') {
      var c = S.cancelled;
      if (S.my && S.my.nonce === m.nonce && S.my.round === S.round) { S.my.label = String(m.p); if (S.my.state === 'sent') S.my.state = 'in'; saveMy(); paintPlayers(); paintKey(); paintSay(); }
      /* the server took the bet after this visitor had already cancelled it: now it has a label, the cancel is sent again */
      else if (c && c.round === S.round && c.bet.nonce === m.nonce) { c.label = String(m.p); if (S.phase === 'BETTING') NET.send({ t: 'cancelBet', round: c.round, player: me(), nonce: c.bet.nonce, sig: sign('CancelBet', { round: c.round, player: me(), nonce: c.bet.nonce }) }); }
      return;
    }
    if (m.t === 'betRefused') {
      if (S.my && S.my.nonce === m.nonce && S.my.state === 'sent') { S.my = null; saveMy(); S.queued = false; betRefused(String(m.why || '')); paintAll(); }
      return;
    }
    /* a bet left the round before it started (its player cancelled it, or the contract did not lock it): its stake never moved */
    if (m.t === 'betCancelled') {
      var p = String(m.p), wasMine = mineLabel(p);
      S.bets = S.bets.filter(function (x) { return x.p !== p; });
      if (wasMine) { S.my = null; saveMy(); say('Your bet did not go into the round: ' + refusedWords(String(m.why || '')), false, 8000); }
      if (S.cancelled && S.cancelled.round === S.round && S.cancelled.label === p) S.cancelled = null;
      paintAll();
      return;
    }
    if (m.t === 'roundCancelled') {
      S.bets = []; ST.outs = [];
      if (S.my && S.my.round === S.round) { S.my = null; saveMy(); say('That round was called off before it started. No stake moved.', true, 8000); }
      paintAll();
      return;
    }
    if (m.t === 'out') { onOut(String(m.p), Number(m.multX100)); return; }
    if (m.t === 'outRefused') { outRefused(String(m.why || '')); return; }
    if (m.t === 'crash') { onCrash(Number(m.crashX100), m.seed, m.settleTx); paintAll(); return; }
    if (m.t === 'settled') { onSettled(m.round, m.tx); return; }
    /* a locked round that could not be settled in time: every stake goes back by itself */
    if (m.t === 'refunding') { if (S.my && S.my.round === m.round) say('This round could not be settled. Every stake in it goes back to its wallet by itself: nothing to do.', true, 0, S.round); paintSay(); return; }
    if (m.t === 'refunded') {
      if (S.my && S.my.round === m.round) { say('Your ' + usd(S.my.usd) + ' from that round is back in your wallet.', true, 9000); if (S.demo && S.my.paid) S.bal = Math.round((S.bal + S.my.usd) * 100) / 100; S.my = null; saveMy(); }
      if (!S.demo) readWallet().then(paintAll);
      paintAll();
    }
  }
  /* the round server's own reasons (CRASH_SPEC_ADDENDA.md), in the page's words. Nothing was taken in any of them. */
  function refusedWords(why) {
    var w = String(why || '').toLowerCase().replace(/^not locked:\s*/, '');
    if (w === 'betting is closed' || w === 'wrong round') return 'That round had just closed. Nothing was taken.';
    if (w === 'you already have a bet in this round') return 'You already have a bet in this round.';
    if (w === 'stake under the minimum') return 'That is under the least a bet may be. Nothing was taken.';
    if (w === 'stake over the maximum') return 'That is over the most a bet may be right now. Nothing was taken.';
    if (w === 'auto cash-out must be 1.01x or more') return 'An auto cash out starts at 1.01x. Nothing was taken.';
    if (w === 'no session key' || w === 'session expired' || w === 'signature does not match your session key') return 'This device\'s set-up has ended. Set up to play again. Nothing was taken.';
    if (w === 'session budget used up') return 'This device has bet all it was set up for. Set up to play again. Nothing was taken.';
    if (w === 'not enough usdc') return 'Your wallet does not hold enough USDC for that bet. Nothing was taken.';
    if (w === 'usdc approval too low') return 'The game may no longer take that much USDC from your wallet. Set up to play again. Nothing was taken.';
    if (w === 'round is full') return 'This round had no room left for that bet. An auto cash out takes less room: set one, or bet less.';
    if (w === 'the game is paused') return 'The table is paused for a moment. Nothing was taken.';
    if (w === 'too many messages') return 'Too many presses at once. Wait a moment and press again.';
    if (w === 'try again') return 'The round server could not check that bet in time. Nothing was taken. The next round is a moment away.';
    if (w === 'the lock did not reach the chain' || w.indexOf('the contract refused the lock') === 0) return 'This round could not be started on HyperEVM, so it was called off. Nothing was taken.';
    if (w === 'not locked') return 'It was not locked into the round. Nothing was taken.';
    if (w === 'cancelled') return 'It was cancelled. Nothing was taken.';
    return 'The round server did not take it. Nothing left your wallet.';
  }
  function betRefused(why) {
    say(refusedWords(why), false, 8000);
    /* a reason about the set-up: the wallet's side is read again, so the key offers the set-up */
    if (/session|approval|usdc/.test(why) && !S.demo) readWallet().then(paintAll);
  }
  function outRefused(why) {
    var my = S.my;
    if (!my || my.round !== S.round || my.state !== 'pending') return;
    if (why === 'already out') return;                                   /* the auto target or the cap got there first: its "out" says where */
    if (why === 'too late') { my.late = true; return; }                  /* the crash says the rest */
    if (why === 'no bet in this round') { S.my = null; saveMy(); say('The round server holds no bet of yours in this round.', false, 6000); paintAll(); return; }
    my.state = 'in';
    say(why === 'the round has not started' ? 'The round had not started yet. Press again.' : why === 'signature does not match your session key' ? 'This device\'s set-up has ended, so it cannot cash out by hand. An auto cash out you set still stands.' : why === 'too many messages' ? 'Too many presses at once. Wait a moment, then press again.' : 'That press could not be read. Press again.', false, 6000);
    paintKey(); paintSay();
  }
  function onState(m) {
    clockSeen(Number(m.serverMs));
    /* a word about a round already known to be over (a server catching up after a restart): the crash stands */
    if (Number(m.round) === S.crashRound && m.phase !== 'CRASHED' && S.round === S.crashRound) return;
    var was = S.phase, newRound = Number(m.round) !== S.round;
    S.round = Number(m.round); S.phase = String(m.phase); S.phaseEnds = m.phaseEndsMs == null ? null : Number(m.phaseEndsMs); S.flightStart = m.flightStartMs == null ? null : Number(m.flightStartMs);
    if (m.edgeBps != null) S.edgeBps = Number(m.edgeBps);
    if (m.maxBet != null) S.maxBet = from6(m.maxBet);
    if (m.maxWinPerBet != null) S.maxWin6 = Number(m.maxWinPerBet);
    if (m.minBet != null) S.minBet = from6(m.minBet);
    S.paused = !!m.paused; S.notice = typeof m.notice === 'string' ? m.notice.slice(0, 160) : '';
    if (m.demo) S.chainInfo = m.demo;
    var old = S.bets;
    S.bets = (m.bets || []).map(normBet);
    S.bets.forEach(function (b) { var o = old.filter(function (x) { return x.p === b.p; })[0]; if (o) b.lost = o.lost; });
    mergeHistory(m.history || []);
    S.ready = true;
    if (newRound) { S.crashRound = S.crashRound === S.round ? S.crashRound : 0; ST.outs = []; S.cancelled = S.cancelled && S.cancelled.round === S.round ? S.cancelled : null; }
    S.bets.forEach(function (b) { if (b.out) noteOut(b.p, b.out); });
    if (S.phase === 'BETTING' && S.phaseEnds != null && CLK.off != null && (was !== 'BETTING' || newRound)) S.betSpan = Math.max(BET_SPAN, S.phaseEnds - (perf() + CLK.off));
    restoreMine();
    reconcile();
    if (S.phase === 'CRASHED' && S.crashRound !== S.round) { var h0 = S.history.filter(function (x) { return x.round === S.round; })[0]; if (h0) onCrash(h0.crashX100, h0.seed, h0.tx); }
    if (S.phase === 'BETTING' && (was !== 'BETTING' || newRound)) bettingOpened();
    if (S.phase === 'LOCKING' && was !== 'LOCKING') locked();
    announce(was, newRound);
    paintAll();
  }
  function mergeHistory(list) {
    var known = {};
    S.history.forEach(function (x) { known[x.round] = x; });
    list.forEach(function (r) { var k = known[r.round]; if (k) { if (!k.seed && r.seed) k.seed = r.seed; return; } S.history.push({ round: Number(r.round), crashX100: Number(r.crashX100), seed: r.seed || '', tx: r.settleTx || r.tx || '' }); });
    S.history.sort(function (a, b) { return b.round - a.round; });
    if (S.history.length > 60) S.history.length = 60;
  }
  function noteOut(p, x) { if (!ST.outs.some(function (o) { return o.p === p; })) ST.outs.push({ p: p, x: x, mine: mineLabel(p) }); }
  /* this visitor's bet held against the server's list */
  function reconcile() {
    var my = S.my, c = S.cancelled, hit;
    if (c && c.round === S.round && S.phase !== 'BETTING') {
      /* a cancel that came too late: the bet is in the round after all */
      hit = S.bets.filter(function (b) { return b.p === 'You' || (c.label && b.p === c.label); })[0];
      if (hit && !my) { my = S.my = c.bet; my.state = 'in'; say('Your cancel came too late: that bet is in this round.', false, 6000); }
      S.cancelled = null;
    }
    if (!my) return;
    if (my.round !== S.round) { if (my.round < S.round && (S.phase === 'BETTING' || my.round < S.round - 1)) { S.my = null; saveMy(); } return; }
    hit = S.bets.filter(function (b) { return mineLabel(b.p); })[0];
    if (hit) {
      if (my.state === 'sent') my.state = 'in';
      if (hit.out && my.state !== 'out') iAmOut(hit.out);
      my.label = hit.p;
    } else if (my.state === 'sent' && S.phase !== 'BETTING') {
      S.my = null; say('Your bet did not get in before the round closed. Nothing was taken.', false, 6000);
    } else if (my.state === 'in' && S.phase === 'BETTING' && !my.label) {
      /* nothing to hold it against yet */
    }
    saveMy();
  }
  function saveMy() {
    var who = me(); if (!who) return;
    var my = S.my;
    lsSet(LS.my + who.toLowerCase(), my && (my.state === 'sent' || my.state === 'in' || my.state === 'pending') ? JSON.stringify({ round: my.round, stake6: my.stake6, usd: my.usd, auto: my.auto, cap: my.cap, nonce: my.nonce, sig: my.sig, label: my.label, state: 'in' }) : null);
  }
  /* a page loaded again mid-round: the bet this device placed is still this visitor's */
  function restoreMine() {
    if (S.my || S.restored === S.round || S.demo) return;
    S.restored = S.round;
    var who = me(); if (!who) return;
    try { var p = JSON.parse(lsGet(LS.my + who.toLowerCase()) || 'null'); if (p && p.round === S.round && S.bets.some(function (b) { return b.p === 'You' || b.p === p.label; })) S.my = p; } catch (e) { /* none */ }
  }
  function bettingOpened() {
    if (S.last) { S.last.rounds++; if (perf() - S.last.at > 90000) S.last = null; }
    if (S.my && S.my.round !== S.round) { S.my = null; saveMy(); }
    if (S.say && S.say.round && S.say.round !== S.round) S.say = null;
    ST.fadeAt = 0;
    if ((S.queued || S.every) && !S.my) {
      S.queued = false;
      var g = gate(), pr = problem();
      if (g) { if (S.every) setEvery(false); return; }
      if (pr) { if (S.every) { setEvery(false); say('Bet every round is off: ' + (pr.funds ? 'your wallet ran short.' : pr.why || 'that bet cannot go in.'), false, 8000); } return; }
      placeBet();
    }
  }
  /* the bets are on their way to the chain: a stake leaves the wallet now */
  function locked() {
    var my = S.my;
    if (!my || my.round !== S.round || (my.state !== 'in' && my.state !== 'sent') || my.paid) return;
    my.paid = true;
    if (S.demo) S.bal = Math.round((S.bal - my.usd) * 100) / 100;
    else {
      /* until the wallet is read again: what the lock takes from the wallet, the allowance and the set-up's budget */
      if (S.bal != null) S.bal = Math.max(0, Math.round((S.bal - my.usd) * 100) / 100);
      S.allowance = Math.max(0, S.allowance - my.stake6);
      if (S.sess) S.sess.left6 = Math.max(0, S.sess.left6 - my.stake6);
    }
  }
  function onOut(p, x) {
    var b = S.bets.filter(function (k) { return k.p === p; })[0];
    if (b) b.out = x;
    noteOut(p, x);
    if (mineLabel(p) && S.my && S.my.round === S.round && S.my.state !== 'out') iAmOut(x);
    paintForm(); paintPlayers(); paintKey(); paintSay();
  }
  function iAmOut(x) {
    var my = S.my, win = payCents(my.stake6, x) / 100 - my.usd;
    my.state = 'out'; my.outX = x; my.outAt = perf(); my.win = Math.round(win * 100) / 100;
    S.owed = { round: my.round, usd: payCents(my.stake6, x) / 100 };
    S.last = { round: my.round, x: x, stake: my.usd, win: my.win, settled: false, at: perf(), rounds: 0 };
    ST.outs.forEach(function (o) { if (o.p === my.label || o.p === 'You') o.mine = true; });
    if (S.flightStart != null) { ST.burstNext = true; ST.markX = null; ST.markY = null; }
    saveMy();
    clearTimeout(KEY.timer); KEY.timer = setTimeout(function () { paintKey(); paintSay(); }, SAID_WON + 30);
    live('You cashed out at ' + xs(x) + '. You win ' + usd(my.win) + '.');
  }
  function onCrash(x100, seed, tx) {
    if (S.crashRound === S.round) return;
    S.crashRound = S.round; S.crashX100 = x100; S.crashMs = M.msFor(x100); S.crashPerf = perf(); S.phase = 'CRASHED';
    if (!S.history.some(function (r) { return r.round === S.round; })) { S.history.unshift({ round: S.round, crashX100: x100, seed: seed || '', tx: tx || '' }); S.newTag = S.round; if (S.history.length > 60) S.history.length = 60; }
    else S.history.forEach(function (r) { if (r.round === S.round && !r.seed && seed) r.seed = seed; });
    S.bets.forEach(function (b) { if (!b.out) b.lost = true; });
    var my = S.my;
    if (my && my.round === S.round && my.state !== 'out') {
      var late = my.state === 'pending' && !my.autoHit;
      if (my.state === 'sent') { S.my = null; }
      else {
        my.state = 'lost'; my.endAt = perf(); S.last = null;
        say(late ? 'Too late: it crashed at ' + xs(x100) + ' before your cash-out got there. Your ' + usd(my.usd) + ' is gone.' : 'It crashed at ' + xs(x100) + '. Your ' + usd(my.usd) + ' is gone.', false, 0, S.round);
        clearTimeout(KEY.timer); KEY.timer = setTimeout(function () { paintKey(); }, SAID_LOST + 30);
      }
      saveMy();
    }
    live('Crashed at ' + xs(x100) + '.');
  }
  function onSettled(round, tx) {
    S.history.forEach(function (r) { if (r.round === round && tx) r.tx = tx; });
    if (S.owed && S.owed.round === round) {
      if (S.demo) S.bal = Math.round((S.bal + S.owed.usd) * 100) / 100;
      S.owed = null;
      if (S.last && S.last.round === round) S.last.settled = true;
    }
    if (S.demo && S.bal != null && S.bal < S.minBet && !(S.my && S.my.round === S.round)) { S.bal = 100; say('Your demo wallet ran dry, so it was filled again: $100.00 of pretend money.', true, 6000); }
    if (!S.demo) readWallet().then(paintAll);
    paintAll();
  }
  /* for a screen reader: the round, said once per change (the canvas is a picture) */
  function live(s) { txt(el.live, s); }
  function announce(was, newRound) {
    if (S.phase === was && !newRound) return;
    if (S.phase === 'BETTING') live('Round ' + S.round + '. Bets are open.');
    else if (S.phase === 'LOCKING') live('Starting.');
    else if (S.phase === 'FLIGHT') live('The round is climbing.');
  }

  /* ==== this visitor's bet ==== */
  function me() { return S.demo && !S.account ? DEMO_ME : S.account; }
  function nextNonce() {
    var who = (me() || '').toLowerCase(), last = Number(lsGet(LS.nonce + who) || 0), n = Math.max(Date.now(), last + 1);
    lsSet(LS.nonce + who, String(n));
    return n;
  }
  /* signed here, at once, by the key kept in this browser: no wallet window, nothing to wait for. The hash is the contract's
     own (EIP-712, crashmath.js); the key only signs it. */
  var DOM = { key: '', sep: '' };
  function sign(kind, v) {
    if (!S.key || !S.key.signingKey) return '0x';
    var k = S.cfg.chainId + ':' + S.game;
    if (DOM.key !== k) { DOM.key = k; DOM.sep = M.domainSeparator(Number(S.cfg.chainId), S.game); }
    return S.key.signingKey.sign(kind === 'Bet' ? M.betDigest(DOM.sep, v) : kind === 'CashOut' ? M.cashOutDigest(DOM.sep, v) : M.cancelBetDigest(DOM.sep, v)).serialized;
  }
  /* what stands between this visitor and a bet that is not about the bet itself: a wallet, the network, the set-up */
  function gate() {
    if (S.demo && !S.walk) return null;
    if (!S.account) return { label: 'Connect wallet', act: 'connect' };
    if (!S.chainOk) return { label: 'Switch to HyperEVM', act: 'chain' };
    /* the wallet's side could not be read yet (the node did not answer): said as that, never as "set up" */
    if (S.readErr && !S.sess) return { label: 'One moment…', busy: true, why: 'Your wallet could not be read just now. The page keeps trying.' };
    if (!sessionOk()) return { label: 'Set up to play', act: 'setup' };
    return null;
  }
  function sessionLeft() { return S.sess ? S.sess.left6 / 1e6 : 0; }
  function sessionOk() {
    var s = S.sess, need = Math.max(S.minBet, S.usd || 0);
    if (!s || !S.key || s.key.toLowerCase() !== S.key.address.toLowerCase()) return false;
    if (s.expiry <= Date.now() / 1000 + 120) return false;
    return sessionLeft() + 1e-9 >= need && S.allowance / 1e6 + 1e-9 >= need;
  }
  function problem() {
    if (S.paused) return { key: 'The table is paused', why: S.notice || 'The table is closed for a moment. A round already running still settles.' };
    if (!(S.usd > 0)) return { key: 'Type an amount', why: '', field: true, quiet: true };
    if (S.usd < S.minBet) return { key: 'The least is ' + usdShort(S.minBet), why: 'The least a bet may be is ' + usd(S.minBet) + '.', field: true };
    if (S.maxBet != null && S.usd > S.maxBet + 1e-9) return { key: 'The most is ' + usdShort(S.maxBet), why: 'The most a bet may be right now is ' + usd(S.maxBet) + '.', field: true };
    if (S.autoBad) return { key: 'Auto: 1.01x or more', why: 'An auto cash out starts at 1.01x. Leave the box empty for none.', auto: true };
    if (S.bal != null && S.usd > S.bal + 1e-9) return { key: 'Not enough USDC', why: S.demo ? 'Your demo wallet holds ' + usd(S.bal) + '.' : (S.walletName || 'Your wallet') + ' holds ' + usd(S.bal) + ' of USDC on HyperEVM.', field: true, funds: true };
    return null;
  }
  function placeBet() {
    if (!NET || S.my) return;
    var stake6 = to6(S.usd), round = S.round, nonce = nextNonce(), who = me();
    var sig = sign('Bet', { round: round, player: who, stake: String(stake6), autoX100: S.auto, nonce: nonce });
    S.my = { round: round, stake6: stake6, usd: S.usd, auto: S.auto, cap: M.capX100(stake6, S.maxWin6 == null ? 1e15 : S.maxWin6), nonce: nonce, sig: sig, state: 'sent', label: null };
    S.say = null;
    saveMy();
    if (!NET.send({ t: 'bet', round: round, player: who, stake: String(stake6), autoX100: S.auto, nonce: nonce, sig: sig })) { S.my = null; saveMy(); say('The connection dropped. Your bet did not go in.', false, 5000); }
    paintAll();
  }
  function cancelBet() {
    var my = S.my;
    if (!my || my.round !== S.round || S.phase !== 'BETTING') return;
    NET.send({ t: 'cancelBet', round: my.round, player: me(), nonce: my.nonce, sig: sign('CancelBet', { round: my.round, player: me(), nonce: my.nonce }) });
    S.cancelled = { round: my.round, label: my.label, bet: my };
    S.bets = S.bets.filter(function (b) { return !mineLabel(b.p); });
    S.my = null; saveMy();
    if (S.every) setEvery(false);
    say('Your bet is out of this round. Nothing was taken.', true, 4000);
    paintAll();
  }
  /* the press that matters. The figure is fixed and the message signed and sent in this same turn; the key says so before
     the next frame, and the server's "out" turns it into the result. */
  function cashOut() {
    var my = S.my;
    if (!my || my.round !== S.round || my.state !== 'in' || S.phase !== 'FLIGHT' || S.flightStart == null || CLK.off == null || S.netDown) return;
    var x = M.x100At(Math.max(0, perf() + CLK.off - S.flightStart)), who = me();
    if (my.auto && x >= my.auto) x = my.auto;
    if (x >= my.cap) x = my.cap;
    my.state = 'pending'; my.sentX = x; my.sentAt = perf();
    paintKey();
    if (!NET.send({ t: 'out', round: my.round, player: who, multX100: x, sig: sign('CashOut', { round: my.round, player: who, multX100: x }) })) { my.state = 'in'; say('The connection dropped before that could be sent. Press again.', false, 4000); paintKey(); }
    else { try { if (navigator.vibrate && !reduced()) navigator.vibrate(12); } catch (e) { /* no buzz on this device */ } }      /* a phone answers the thumb too */
    paintSay();
  }
  function setEvery(on) {
    S.every = !!on;
    el.every.setAttribute('aria-checked', S.every ? 'true' : 'false');
    paintForm();
  }

  /* ==== painting (only when something changed; the frame above never calls these) ==== */
  function say(text, ok, ttl, round) {
    S.say = text ? { text: text, ok: !!ok, round: round || 0, id: (S.sayId = (S.sayId || 0) + 1) } : null;
    if (text && ttl) { var id = S.sayId; setTimeout(function () { if (S.say && S.say.id === id) { S.say = null; paintSay(); } }, ttl); }
  }
  function paintTop() {
    var demoWho = S.demo && !S.walk;
    show(el.who, !!S.account || demoWho);
    if (demoWho) { txt(el.whoAddr, 'Demo'); el.who.setAttribute('aria-label', 'Demo wallet. Menu'); }
    else if (S.account) { txt(el.whoAddr, S.account.slice(0, 4) + '…' + S.account.slice(-4)); el.who.setAttribute('aria-label', 'Wallet ' + S.account + '. Menu'); }
  }
  function paintMode() {
    var m = el.mode;
    if (S.soon) { m.textContent = ''; add(m, [h('b', null, 'Coming soon.'), ' A demo with pretend money.']); show(m, true); }
    else if (S.demo) { txt(m, 'Demo: pretend money. Nothing here is real.'); show(m, true); }
    else show(m, false);
  }
  function paintCount() {
    var n = S.bets.length, sum = 0;
    S.bets.forEach(function (b) { sum += b.stake6; });
    txt(el.count, !S.ready ? '\u00a0' : n ? n + ' playing, ' + usdShort(Math.round(sum / 1e4) / 100) + ' in' : 'No bets yet');
    el.count.classList.toggle('is-none', !n);
  }
  function paintStrip() {
    var sig = S.history.slice(0, 20).map(function (r) { return r.round + ':' + r.crashX100; }).join(',');
    if (sig === S.stripSig) return;
    S.stripSig = sig;
    var f = el.strip; f.textContent = '';
    if (!S.history.length) { add(f, h('span', 'cr-strip-say', S.ready ? 'The last rounds show here.' : '')); return; }
    S.history.slice(0, 20).forEach(function (r) {
      var b = btn('cr-tag' + (r.crashX100 < 200 ? ' is-low' : '') + (r.round === S.newTag ? ' is-new' : ''), xs(r.crashX100), function () { openFair(r.round); });
      b.setAttribute('aria-label', 'Round ' + r.round + ' crashed at ' + xs(r.crashX100) + '. Check it');
      add(f, b);
    });
    f.scrollLeft = 0;
  }
  function paintForm() {
    if (!S.cfg) return;
    var my = S.my && S.my.round === S.round ? S.my : null, riding = !!(my && S.phase === 'FLIGHT' && (my.state === 'in' || my.state === 'pending'));
    var pr = problem();
    el.root.classList.toggle('is-riding', riding);
    el.amount.disabled = riding; el.autoIn.disabled = riding;
    Array.prototype.forEach.call(el.chips.children, function (b) { var v = Number(b.getAttribute('data-usd')); b.setAttribute('aria-pressed', Math.abs(v - S.usd) < 0.005 ? 'true' : 'false'); b.disabled = riding || (S.maxBet != null && v > S.maxBet + 1e-9) || (S.bal != null && v > S.bal + 1e-9); });
    Array.prototype.forEach.call(el.autoChips.children, function (b) { var v = Number(b.getAttribute('data-x')); b.setAttribute('aria-pressed', v === S.auto ? 'true' : 'false'); b.disabled = riding; });
    el.amt.classList.toggle('is-bad', !!(pr && pr.field && !pr.quiet && S.touched));
    el.autoBox.classList.toggle('is-bad', !!S.autoBad); el.autoBox.classList.toggle('is-on', S.auto > 0);
    /* the line under the boxes: what this bet does, from the numbers on the page */
    var w = el.wins; w.textContent = '';
    if (!(S.usd > 0)) add(w, '\u00a0');
    else if (S.autoBad) add(w, 'An auto cash out starts at 1.01x.');
    else if (S.auto) {
      var stake6 = to6(S.usd), cap = S.maxWin6 == null ? 1e15 : M.capX100(stake6, S.maxWin6), x = Math.min(S.auto, cap), pay = payCents(stake6, x) / 100;
      add(w, ['Pays ', h('b', null, usd(pay)), ' if it reaches ' + xs(x) + ': ', h('b', null, '+' + usd(pay - S.usd)), x < S.auto ? ' (the most one bet may win)' : '.']);
    } else add(w, 'No auto cash out: you press before it crashes.');
    txt(el.everyHint, S.every ? 'On: ' + usdShort(S.usd) + ' goes in as every round opens.' : 'Off: one bet for each press.');
    var wl = el.wallet; wl.textContent = '';
    if (S.demo && !S.walk) add(wl, S.bal != null ? ['Your demo wallet holds ', h('b', null, usd(S.bal)), ' of pretend money.'] : 'Pretend money.');
    else if (!S.account) add(wl, 'Connect MetaMask, Phantom or any wallet and play straight from its USDC. No deposit first.');
    else {
      add(wl, [h('b', null, S.walletName || 'Your wallet'), ' is connected. Bets play straight from its USDC']);
      add(wl, S.bal != null ? [': ', h('b', null, usd(S.bal)), ' now.'] : '.');
    }
  }
  function paintPlayers() {
    var f = el.players, rows = S.bets.slice(), flying = S.phase === 'FLIGHT', done = S.phase === 'CRASHED' && S.crashRound === S.round;
    show(el.liveDot, S.ready);
    el.liveDot.classList.toggle('is-demo', S.demo); el.liveDot.classList.toggle('is-off', S.netDown);
    txt(el.liveWord, S.netDown ? 'Reconnecting' : S.demo ? 'Demo' : 'Live');
    f.textContent = '';
    if (!S.ready) { add(f, h('div', 'cr-players-say', 'One moment…')); return; }
    if (!rows.length) { add(f, h('div', 'cr-players-say', S.phase === 'BETTING' ? 'Nobody is in this round yet. Yours can be the first bet.' : 'Nobody is in this round.')); return; }
    rows.sort(function (a, b) { return (mineLabel(b.p) ? 1 : 0) - (mineLabel(a.p) ? 1 : 0); });
    rows.forEach(function (b) {
      var mine = mineLabel(b.p), stake = b.stake6 / 1e6, right;
      if (b.out) { var win = payCents(b.stake6, b.out) / 100 - stake; right = h('span', 'cr-prow-r', [h('b', 'sm-up', 'Out at ' + xs(b.out)), h('i', null, 'won ' + usd(win))]); }
      else if (done || b.lost) right = h('span', 'cr-prow-r', [h('b', 'sm-dn', 'Lost ' + usd(stake)), h('i', null, 'did not cash out')]);
      else right = h('span', 'cr-prow-r', [h('b', 'sm-mute', flying ? 'In the air' : 'In'), h('i', null, b.auto ? 'auto at ' + xs(b.auto) : 'by hand')]);
      var n = h('div', 'cr-prow' + (mine ? ' is-you' : '') + (b.isNew ? ' is-new' : ''), [h('span', 'cr-prow-t', [h('b', null, mine ? 'You' : b.p), h('i', null, usd(stake))]), right]);
      b.isNew = false;
      add(f, n);
    });
  }
  /* the one key: what the next press does, said on it */
  function keyState() {
    var my = S.my && S.my.round === S.round ? S.my : null, ph = S.phase, t = perf(), g, pr;
    if (S.busy) return { label: S.busy, busy: true };
    if (!S.ready) return { label: S.netDown ? 'Reconnecting…' : 'One moment…', busy: true };
    if (my) {
      if (my.state === 'out' && t - my.outAt < SAID_WON) return { label: 'You cashed out at ' + xs(my.outX) + ': +' + usd(my.win), said: 'won' };
      if (my.state === 'lost' && t - my.endAt < SAID_LOST) return { label: 'Not this time', said: 'lost' };
      if (my.state === 'pending') return { label: 'Cashing out ' + centsText(payCents(my.stake6, my.sentX)) + ' at ' + xs(my.sentX), said: 'sent' };
      if (my.state === 'in' && ph === 'FLIGHT') {
        if (S.netDown) return { label: 'Reconnecting…', busy: true };
        if (my.autoHit) return { label: 'Cashing out at ' + xs(Math.min(my.auto || my.cap, my.cap)), said: 'sent' };
        return { label: 'Cash out', act: 'cash', mode: 'cash' };
      }
      if ((my.state === 'in' || my.state === 'sent') && (ph === 'LOCKING' || ph === 'FLIGHT')) return { label: 'Waiting', busy: true };
      if ((my.state === 'in' || my.state === 'sent') && ph === 'BETTING') return { label: 'Cancel bet', act: 'cancel', ghost: true };
    }
    g = gate();
    if (g) return g;
    if (S.stuck && Date.now() / 1000 >= S.stuck.at + 3) return { label: 'Take your ' + usdShort(S.stuck.usd) + ' back', act: 'refund', why: 'Round ' + S.stuck.round + ' was never settled. Its stake can be taken back now.' };
    if (S.netDown) return { label: 'Reconnecting…', busy: true };
    if (S.queued || (S.every && ph !== 'BETTING' && !problem())) return { label: 'Cancel bet', act: 'unqueue', ghost: true };
    pr = problem();
    if (pr) return { label: pr.key, dis: true, why: pr.why && (!pr.field || S.touched) ? pr.why : '' };
    if (ph === 'BETTING') return { label: 'Bet ' + usdShort(S.usd), act: 'bet' };
    return { label: 'Bet next round', act: 'queue' };
  }
  function paintKey() {
    if (!S.cfg) return;
    var k = keyState(), b = el.go, label = k.label;
    if (k.mode === 'cash') { label = 'Cash out ' + centsText(payCents(S.my.stake6, S.flightStart != null && CLK.off != null ? M.x100At(Math.max(0, perf() + CLK.off - S.flightStart)) : 100)); }
    if (k.act !== KEY.act) KEY.since = perf();
    KEY.act = k.act || ''; KEY.mode = k.mode || ''; KEY.text = label; KEY.why = k.why || '';
    if (el.goT.firstChild) el.goT.firstChild.nodeValue = label; else el.goT.appendChild(document.createTextNode(label));
    b.className = 'sm-btn cr-go ' + (k.ghost ? 'is-ghost' : 'is-primary') + (k.busy ? ' is-busy' : '') + (k.said ? ' is-said is-' + k.said : '') + (label.length > 24 ? ' is-long' : '');
    b.disabled = !!k.dis;
    if (k.busy || k.said) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    if (k.busy) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
  }
  function paintSay() {
    if (!S.cfg) return;
    var my = S.my && S.my.round === S.round ? S.my : null, s = S.say, text = '', cls = '', share = false, L = S.last;
    if (s) { text = s.text; cls = s.ok ? 'is-ok' : 'is-bad'; }
    else if (my && my.state === 'out') { text = perf() - my.outAt < SAID_WON ? (L && L.settled ? 'It is in your wallet.' : 'Paid into your wallet as the round ends.') : 'Cashed out at ' + xs(my.outX) + ': +' + usd(my.win) + '. ' + (L && L.settled ? 'It is in your wallet.' : 'Paid as the round ends.'); cls = 'is-won'; share = my.outX >= 200; }
    else if (my && my.state === 'pending') { text = 'Sent at ' + xs(my.sentX) + '.'; cls = 'is-ok'; }
    else if (my && (my.state === 'in' || my.state === 'sent') && S.phase === 'BETTING') { text = 'You are in this round: ' + usdShort(my.usd) + (my.auto ? ', auto cash out at ' + xs(my.auto) + '.' : '.'); cls = 'is-ok'; }
    else if (my && my.state === 'in' && S.phase === 'FLIGHT') { text = my.auto ? 'It cashes out by itself at ' + xs(my.auto) + ', or press sooner.' : ''; cls = 'is-ok'; }
    else if (S.queued || (S.every && S.phase !== 'BETTING' && !problem())) { text = 'Your ' + usdShort(S.usd) + ' goes in when the next round opens.'; cls = 'is-ok'; }
    /* the last win stays said while the next round takes its bets; once that round flies the line is its own */
    else if (!my && L && L.x && (L.rounds === 0 || (L.rounds === 1 && (S.phase === 'BETTING' || S.phase === 'LOCKING'))) && perf() - L.at < 90000) { text = 'Cashed out at ' + xs(L.x) + ': +' + usd(L.win) + '. ' + (L.settled ? 'It is in your wallet.' : 'Paid as the round ends.'); cls = 'is-won'; }
    else if (KEY.why) { text = KEY.why; cls = 'is-bad'; }
    else if ((!S.demo || S.walk) && S.account && S.chainOk && !sessionOk() && S.ready) {
      text = !S.sess || !S.key ? 'One sheet, two wallet confirmations, then no wallet window in a round.' : S.sess.expiry <= Date.now() / 1000 + 120 ? 'This device\'s set-up has run out. One sheet sets it up again.' : 'This device has bet all it was set up for. One sheet sets it up again.';
      cls = 'is-ok';
    }
    else if (S.notice) { text = S.notice; cls = 'is-ok'; }
    txt(el.sayLine, text); el.sayLine.className = 'sm-say cr-say ' + cls;
    /* a win of 2x or more can be shared for a minute and a half, whatever the line says; never while money is in the air */
    if (L && L.x >= 200 && perf() - L.at < 90000 && !(my && S.phase === 'FLIGHT' && (my.state === 'in' || my.state === 'pending'))) share = true;
    show(el.share, share && !!window.ConfettiShare);
  }
  function paintHow() {
    var a = el.gameLink;
    if (!S.demo && isAddr(S.game)) { a.href = S.cfg.explorerUrl + '/address/' + S.game; show(a, true); } else show(a, false);
  }
  /* nothing is said before config.json has been read: the page does not yet know whether it is live or the demo */
  function paintAll() { if (!S.cfg) return; paintTop(); paintMode(); paintCount(); paintStrip(); paintForm(); paintPlayers(); paintKey(); paintSay(); paintHow(); more(); }
  function more() { var m = el.main; el.root.classList.toggle('is-more', m.scrollHeight - m.clientHeight - m.scrollTop > 6); }

  /* ---- the two boxes ---- */
  function setAmount(text, fromField) {
    var v = String(text).replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,2}).*$/, '$1');
    S.text = v; S.usd = Number(v) || 0;
    if (!fromField || el.amount.value !== v) el.amount.value = v;
    lsSet(LS.amt, v);
  }
  function setAuto(text, fromField) {
    var v = String(text).replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,2}).*$/, '$1'), n = Number(v);
    S.autoText = v;
    S.auto = v && n >= 1.01 ? Math.min(100000, Math.round(n * 100)) : 0;
    S.autoBad = !!v && !(n >= 1.01);
    if (!fromField || el.autoIn.value !== v) el.autoIn.value = v;
    el.autoIn.style.width = v ? 'calc(' + (v.length - (v.indexOf('.') >= 0 ? 0.55 : 0)) + 'ch + 3px)' : '';      /* a point is narrower than a figure */
    lsSet(LS.auto, v || null);
  }

  /* ==== sheets ==== */
  function sheet(name) { if (!GW) throw new Error('gamewallet.js did not load'); return GW.sheet(name, 'cr-sheet'); }
  var MENU = null;
  function openMenu() {
    var sh = MENU || (MENU = sheet('Menu'));
    function item(label, hint, fn, href, now) {
      var n = href ? h('a', now ? 'cr-menu-now' : null, [label, h('i', null, hint || '›')]) : btn(null, [label, h('i', null, hint || '›')], function () { sh.close(); setTimeout(fn, 200); });
      if (href) n.href = href;
      if (now) { n.setAttribute('aria-current', 'page'); n.setAttribute('aria-pressed', 'true'); }
      return n;
    }
    txt(sh.title, 'Menu'); sh.body.textContent = ''; sh.foot.textContent = '';
    if (S.demo && !S.walk) add(sh.body, h('div', 'sm-who', [h('b', null, 'Demo wallet'), h('i', null, 'Pretend money. Nothing here is real.')]));
    else if (S.account) {
      add(sh.body, h('div', 'sm-who', [h('b', null, (S.walletName || 'Wallet') + ' connected'), h('i', null, S.account),
        h('div', 'sm-links', [btn('sm-link', 'Switch wallet', function () { sh.close(); setTimeout(function () { connect(true); }, 200); }), btn('sm-link', 'Disconnect', function () { sh.close(); setTimeout(disconnect, 200); })])]));
    }
    var list = h('div', 'sm-menu');
    if (!(S.demo && !S.walk) && !S.account) add(list, item('Connect wallet', 'MetaMask, Phantom, any wallet', function () { connect(false); }));
    if (S.account && S.sess && S.sess.expiry > Date.now() / 1000) add(list, item('Stop playing on this device', 'ends the set-up', function () { openStop(); }));
    if (S.account && S.held > 0.004) add(list, item('Collect ' + usd(S.held), 'a payout held for you', function () { collect(); }));
    add(list, item('Is it fair?', 'check any round', function () { openFair(0); }));
    add(list, item('Trade', 'coins, up or down', null, 'trade.html'));
    add(list, item('Crash', 'you are here', null, 'crash.html' + (S.demo && !S.soon ? '?demo=1' : ''), true));
    add(list, item('Coin flip', 'heads or tails', null, 'flip.html'));
    add(list, item('Portfolio', 'your trades', null, 'portfolio.html'));
    add(list, item('Leaderboard', 'top traders', null, 'leaderboard.html'));
    add(list, item('House', 'LP and stats', null, 'house.html'));
    add(list, item('$FETTI', '', null, 'confetti.html'));
    var sub = h('div', 'sm-menu-sub');
    add(sub, item('Docs', '', null, 'docs.html'));
    add(sub, item('Contracts', '', null, 'contracts.html'));
    add(list, sub);
    if (S.demo && !S.soon) add(list, item('Play for real', 'leave the demo', null, 'crash.html'));
    if (S.demo && !S.walk) add(list, item('First-time steps', 'a pretend run', null, 'crash.html?demo=1&first=1'));
    add(sh.body, list);
    sh.open();
  }

  /* ---- Fair?: the check of a round, worked out here from its seed and the salt ---- */
  var FAIR = { sh: null, round: 0, facts: null };
  /* what the check needs from the contract: the current chain's salt, its published end, and the round before its first */
  function chainFacts() {
    if (S.chainInfo) return Promise.resolve({ salt: S.chainInfo.salt, terminal: S.chainInfo.terminal, base: Number(S.chainInfo.chainBase) || 0 });
    if (FAIR.facts) return Promise.resolve(FAIR.facts);
    return Promise.all([game().salt(), game().terminal(), game().chainBase()]).then(function (v) { return (FAIR.facts = { salt: String(v[0]), terminal: String(v[1]), base: Number(v[2]) }); });
  }
  function openFair(round) {
    var sh = FAIR.sh || (FAIR.sh = sheet('Fair'));
    var settled = S.history.filter(function (r) { return !!r.seed; });
    FAIR.round = round && settled.some(function (r) { return r.round === round; }) ? round : settled.length ? settled[0].round : 0;
    fillFair(); sh.open();
  }
  function fillFair() {
    var sh = FAIR.sh, settled = S.history.filter(function (r) { return !!r.seed; }), i = -1, r, k;
    for (k = 0; k < settled.length; k++) if (settled[k].round === FAIR.round) i = k;
    r = i >= 0 ? settled[i] : null;
    txt(sh.title, 'Is it fair?'); sh.body.textContent = ''; sh.foot.textContent = '';
    add(sh.body, h('p', 'sm-fine', 'The crash point of every round is fixed before the round starts. Before the first round the house made a long chain of secret numbers, each one the fingerprint of the one before it, and published the last one on HyperEVM. Each round reveals the next number back along the chain, and its crash point is worked out from that number alone. Your browser has just done that sum again, here:'));
    if (!r) {
      add(sh.body, h('div', 'cr-fairbox', h('div', 'cr-fairrow', [h('span', null, 'No round to check yet'), h('i', null, 'A round\'s number is revealed the moment it crashes. The first one that does shows here.')])));
    } else {
      var box = h('div', 'cr-fairbox'), res = h('span', null, 'Checking…'), link = h('i', null, 'Checking…'), saltC = h('code', null, '…'), sum = h('i', null, '');
      add(box, h('div', 'cr-fairrow', [h('span', null, 'Round ' + r.round + (r.round === S.round ? ' (the one that just ended)' : '')), h('div', 'cr-fairbig', [h('b', null, xs(r.crashX100)), res])]));
      add(box, h('div', 'cr-fairrow', [h('span', null, 'This round\'s number (its seed)'), h('code', null, r.seed), link]));
      add(box, h('div', 'cr-fairrow', [h('span', null, 'The salt'), saltC, h('i', null, S.demo ? 'In the demo it is made in this browser. Live, it is read from the contract: the hash of a block mined after the chain was published, so the house could not have picked a chain it liked.' : 'Read from the contract just now: the hash of a block mined after the chain was published, so the house could not have picked a chain it liked.')]));
      add(box, h('div', 'cr-fairrow', [h('span', null, 'The sum'), sum]));
      add(sh.body, box);
      var want = FAIR.round;
      chainFacts().then(function (c) {
        if (FAIR.round !== want || !sh.isOpen) return;
        txt(saltC, c.salt);
        if (r.round <= c.base) { res.className = ''; txt(res, 'an earlier chain'); link.className = ''; txt(link, 'This round was played on an earlier chain. The contract now holds the next chain\'s salt, so this page cannot do its sum again; the contract did it when the round was settled.'); return; }
        var hsh = M.roundHash(r.seed, c.salt), r52 = M.r52(hsh), older = settled[i + 1] && settled[i + 1].round > c.base ? settled[i + 1] : null, gap = older ? r.round - older.round : r.round - c.base, ok;
        function sums(edge, how) {
          var got = M.crashFromR(r52, edge);
          res.className = got === r.crashX100 ? 'is-yes' : 'is-no';
          txt(res, got === r.crashX100 ? '✓ the sum gives ' + xs(got) + ' too' : '✗ the sum gives ' + xs(got));
          sum.textContent = '';
          add(sum, ['keccak256(seed, salt) starts ', h('b', null, hsh.slice(0, 15) + '…'), '. Its first 52 bits are r = ', h('b', null, String(r52)), '. The crash point is ' + (100 - edge / 100) + ' × 2⁵² ÷ (2⁵² − r) ÷ 100, cut to two places and never under 1.00x: ', h('b', null, xs(got)), '. So a round reaches a multiplier m about ' + (1 - edge / 10000).toFixed(3).replace(/0$/, '') + ' ÷ m of the time.', how || '']);
          return got === r.crashX100;
        }
        if (gap >= 1 && gap <= 256) {
          ok = M.chainOk(r.seed, older ? older.seed : c.terminal, gap);
          link.className = ok ? 'is-yes' : 'is-no';
          txt(link, (ok ? '✓ ' : '✗ ') + (gap === 1 ? 'Its fingerprint (keccak256) is' + (ok ? ' ' : ' not ') : 'Hashed ' + gap + ' times (once for every round number since) it is' + (ok ? ' ' : ' not ')) + (older ? 'the number round ' + older.round + ' revealed.' : 'the end of the chain, published before its first round.') + (ok ? ' The chain holds.' : ''));
        } else { link.className = ''; txt(link, 'Its fingerprint must be the number the round before it revealed. That round is older than this page remembers; the contract checked the link when the round was settled.'); }
        if (sums(S.edgeBps) || S.demo) return;
        /* not the same: the round may have been locked with another edge. The contract's record of the round has it. */
        game().getRound(r.round).then(function (g) { var e2 = Number(g.edgeBps); if (FAIR.round === want && e2 && e2 !== S.edgeBps) sums(e2, ' (This round was locked while the edge was ' + (e2 / 100) + '%.)'); }).catch(function () { /* the first answer stands */ });
      }, function () { if (FAIR.round === want) { txt(res, 'could not be read just now'); txt(link, 'Try again in a moment.'); } });
      var nav = h('div', 'cr-fairnav'), older = btn(null, '‹ Older round', function () { FAIR.round = settled[i + 1].round; fillFair(); sh.body.scrollTop = 0; }), newer = btn(null, 'Newer round ›', function () { FAIR.round = settled[i - 1].round; fillFair(); sh.body.scrollTop = 0; });
      older.disabled = !settled[i + 1]; newer.disabled = i <= 0;
      add(nav, [older, newer]); add(sh.body, nav);
    }
    add(sh.body, h('p', 'sm-fine cr-limit', 'The honest limit: nobody can change a crash point once the chain is published, and anyone can check every round. The round server does know the next crash point, as on every game of this kind, and it decides which cash-outs arrived in time. An auto cash out needs no trust at all: it is settled from the revealed number alone.'));
    var links = h('p', 'sm-fine cr-how-links');
    if (!S.demo && isAddr(S.game)) { var a = h('a', null, 'The contract'); a.href = S.cfg.explorerUrl + '/address/' + S.game; a.target = '_blank'; a.rel = 'noopener'; add(links, a); }
    if (!S.demo && r && r.tx) { var t = h('a', null, 'This round\'s settlement'); t.href = S.cfg.explorerUrl + '/tx/' + r.tx; t.target = '_blank'; t.rel = 'noopener'; add(links, t); }
    var v = h('a', null, 'Test the sum'); v.href = 'crash_vectors.html'; v.target = '_blank'; v.rel = 'noopener'; add(links, v);
    add(sh.body, links);
  }

  /* ---- Set up to play: allow USDC, then let this device's key play. Two wallet presses, each said before it. ---- */
  var SET = { sh: null, budget: 1000, busy: '', err: '', R: null };
  function step(box) { var s = { n: h('div', 'sm-st'), m: h('span', 'sm-m', '✓'), b: h('b'), i: h('i') }; add(s.n, [s.m, h('span', null, [s.b, s.i])]); box.appendChild(s.n); return s; }
  function setStep(s, state, b, i) { s.n.className = 'sm-st is-' + state; txt(s.b, b); txt(s.i, i); }
  function openSetup() {
    var sh = SET.sh || (SET.sh = sheet('Setup')), r = SET.R = {}, w = S.walletName || 'your wallet', box = h('div', 'sm-steps is-tight');
    SET.busy = ''; SET.err = '';
    txt(sh.title, 'Set up to play'); sh.body.textContent = ''; sh.foot.textContent = '';
    add(sh.body, h('p', 'sm-fine', ['Once, in ' + w + ': two confirmations. After that you bet and cash out with ', h('b', null, 'no wallet window'), ', because a cash-out cannot wait for one. Your USDC stays in your wallet until a bet is placed.']));
    add(sh.body, h('div', 'sm-label cr-budget', 'The most this device may bet in all'));
    r.chips = h('div', 'sm-chips cr-budget-chips');
    BUDGETS.forEach(function (v) { var b = btn(null, usdShort(v), function () { if (SET.busy) return; SET.budget = v; fillSetup(); }); b._v = v; r.chips.appendChild(b); });
    add(sh.body, r.chips);
    r.note = h('p', 'sm-fine', '');
    add(sh.body, r.note);
    r.s = [step(box), step(box)];
    add(sh.body, box);
    r.fine = h('p', 'sm-fine', '');
    add(sh.body, r.fine);
    r.say = h('p', 'sm-say cr-setsay', ''); r.say.setAttribute('role', 'status');
    r.go = btn('sm-btn is-primary', '', setupGo);
    add(sh.foot, [r.say, r.go]);
    fillSetup(); sh.open();
    readWallet().then(function () { if (sh.isOpen) fillSetup(); });
  }
  function allowOk() { return S.allowance >= SET.budget * 1e6; }
  function fillSetup() {
    var r = SET.R; if (!r || !r.go) return;
    var w = S.walletName || 'Your wallet', b = usdShort(SET.budget), a = allowOk(), busy = SET.busy, each = S.usd >= S.minBet ? S.usd : 10;
    Array.prototype.forEach.call(r.chips.children, function (c) { c.setAttribute('aria-pressed', c._v === SET.budget ? 'true' : 'false'); c.disabled = !!busy; });
    r.note.textContent = '';
    add(r.note, ['Every bet counts towards it, won or lost: ', h('b', null, b), ' is ' + Math.floor(SET.budget / each).toLocaleString('en-US') + ' rounds at ' + usdShort(each) + ' a round. When it is used up, this sheet sets it up again.']);
    setStep(r.s[0], a ? 'done' : 'now', a ? 'The game may take USDC for your bets' : 'Let the game take USDC for your bets', a ? 'Allowed already. Only what you bet ever leaves.' : w + ' asks you to allow up to ' + b + ' of USDC. Only what you bet ever leaves, and a win comes straight back to the wallet.');
    setStep(r.s[1], a ? 'now' : 'later', 'Let this device play for you', w + ' asks once more. This browser gets a key that can only bet your USDC in this game, up to ' + b + ' in all, for ' + SESSION_DAYS + ' days. It cannot send your money anywhere.');
    txt(r.fine, 'End it any time: Menu, Stop playing on this device.' + (S.hype != null && S.hype < 300000000000000 ? ' The two confirmations need a little HYPE for the network (about 0.001); your wallet has next to none. Playing itself needs none.' : ' Playing itself needs no HYPE: the round server pays for every round.'));
    var label = busy === 'wallet' ? 'Confirm in ' + (S.walletName || 'your wallet') + '…' : busy === 'allow' ? 'Allowing USDC…' : busy === 'session' ? 'Setting up…' : a ? 'Let this device play' : 'Allow ' + b + ' of USDC';
    txt(r.go, label); r.go.classList.toggle('is-busy', !!busy);
    txt(r.say, SET.err); r.say.classList.toggle('is-bad', !!SET.err);
  }
  function setupGo() {
    if (SET.busy) return;
    var cap6 = SET.budget * 1e6, acct = S.account;
    SET.err = ''; SET.busy = 'wallet'; fillSetup();
    var p = allowOk() ? CHAIN.setSession(cap6, function () { SET.busy = 'session'; fillSetup(); }).then(function () {
      SET.busy = ''; if (SET.sh.isOpen) SET.sh.close();
      say('Set up. From here a bet and a cash-out need no wallet window.', true, 7000);
      return readWallet();
    }) : CHAIN.approve(cap6, function () { SET.busy = 'allow'; fillSetup(); }).then(function () { S.allowance = Math.max(S.allowance, cap6); S.fresh.allow = { v: cap6, t: Date.now() }; SET.busy = ''; return readWallet(); });
    p.then(function () { if (acct === S.account) { fillSetup(); paintAll(); } }, function (e) { SET.busy = ''; SET.err = e && e.plain ? e.message : describe(e); fillSetup(); });
  }
  /* Stop playing on this device: the contract forgets the key (one wallet press), then this browser does */
  var STOP = { sh: null, busy: false, err: '' };
  function openStop() {
    var sh = STOP.sh || (STOP.sh = sheet('Stop')), sayP = h('p', 'sm-say cr-setsay', ''), go;
    STOP.busy = false;
    txt(sh.title, 'Stop playing on this device'); sh.body.textContent = ''; sh.foot.textContent = '';
    add(sh.body, h('p', 'sm-fine', ['This ends the set-up: the key kept in this browser can no longer bet or cash out for ', h('b', null, short(S.account)), '. ' + (S.walletName || 'Your wallet') + ' asks you to confirm it once. Your USDC is where it always was, in your wallet. A bet already in a round still plays out, and an auto cash out still pays.']));
    go = btn('sm-btn is-primary', 'Stop playing on this device', function () {
      if (STOP.busy) return;
      STOP.busy = true; txt(go, 'Confirm in ' + (S.walletName || 'your wallet') + '…'); go.classList.add('is-busy'); txt(sayP, '');
      CHAIN.revoke(function () { txt(go, 'Stopping…'); }).then(function () {
        lsSet(LS.key + S.account.toLowerCase(), null); S.key = null; S.sess = null; setEvery(false); S.queued = false;
        sh.close(); say('This device can no longer play for you. Set up again any time.', true, 7000);
        return readWallet();
      }).then(paintAll, function (e) { STOP.busy = false; txt(go, 'Stop playing on this device'); go.classList.remove('is-busy'); txt(sayP, e && e.plain ? e.message : describe(e)); sayP.classList.add('is-bad'); });
    });
    add(sh.foot, [sayP, go]);
    sh.open();
  }

  /* ==== the wallet and the contract (live; the first-time walk of the demo pretends the contract) ==== */
  var RPC = null, GAME = null, USDC = null;
  function rpc() { return RPC || (RPC = new E.JsonRpcProvider(S.cfg.rpcUrl, Number(S.cfg.chainId), { staticNetwork: true, batchMaxCount: Number(S.cfg.rpcBatchMaxCount) || 1 })); }
  function game() { return GAME || (GAME = new E.Contract(S.game, ABI, rpc())); }
  function usdcC() { return USDC || (USDC = new E.Contract(S.cfg.contracts.usdc, ERC20, rpc())); }
  function describe(e) {
    var m = String((e && (e.shortMessage || e.message)) || e || '');
    if (GW && GW.rejected(e)) return 'Cancelled in your wallet. Nothing was sent.';
    if (/insufficient funds/i.test(m)) return 'Your wallet needs a little HYPE for the network (about 0.001). Nothing was sent.';
    if (e && e.code === -32002) return 'Your wallet is already asking you something. Open it and answer there.';
    return 'That did not go through. Nothing was taken. Try again in a moment.';
  }
  function loadKey() {
    S.key = null;
    if (!S.account || !E) return;
    var pk = lsGet(LS.key + S.account.toLowerCase());
    if (pk && /^0x[0-9a-fA-F]{64}$/.test(pk)) { try { S.key = new E.Wallet(pk); } catch (e) { S.key = null; } }
  }
  /* the contract, as the page uses it. onSent: the wallet said yes, the transaction is on its way. */
  var CHAIN = {
    read: function () {
      var a = S.account, g = game(), cap = function (v) { return Number(v > 9007199254740991n ? 9007199254740991n : v); };
      return Promise.all([usdcC().balanceOf(a), usdcC().allowance(a, S.game), g.sessions(a), rpc().getBalance(a), g.owed(a).catch(function () { return 0n; }), g.lastBetOf(a).catch(function () { return null; })]).then(function (v) {
        if (a !== S.account) return null;
        var f = S.fresh, now = Date.now();
        S.bal = from6(v[0]); S.allowance = cap(v[1]); S.hype = cap(v[3]); S.held = from6(v[4]);
        S.sess = /^0x0{40}$/.test(String(v[2].key)) ? null : { key: String(v[2].key), expiry: Number(v[2].expiry), left6: cap(v[2].stakeLeft) };
        /* a node a block behind the wallet's own confirmation: what was just set stands for a few seconds */
        if (f.allow && now - f.allow.t < 20000) S.allowance = Math.max(S.allowance, f.allow.v);
        if (f.sess && now - f.sess.t < 20000 && (!S.sess || S.sess.key.toLowerCase() !== f.sess.v.key.toLowerCase())) S.sess = f.sess.v;
        if (f.gone && now - f.gone.t < 20000) S.sess = null;
        /* a bet of this wallet in a round that was never settled: once its time has come the stake can be taken back */
        var lr = v[5] ? Number(v[5].round) : 0, li = v[5] ? Number(v[5].index) : 0;
        if (!lr || lr === S.settledSeen) { S.stuck = null; return null; }
        return Promise.all([g.getRound(lr), g.getBet(lr, li)]).then(function (x) {
          if (a !== S.account) return;
          var st = Number(x[0].state), mine = String(x[1].player).toLowerCase() === a.toLowerCase() && x[1].stake > 0n;
          if (st === RS.SETTLED || (st === RS.EXPIRED && !mine)) { S.settledSeen = lr; S.stuck = null; }
          else S.stuck = mine && (st === RS.LOCKED || st === RS.REVEALED || st === RS.EXPIRED) ? { round: lr, usd: from6(x[1].stake), at: Number(x[0].refundAt) } : null;
        }, function () { /* the next read asks again */ });
      });
    },
    approve: function (cap6, onSent) {
      var u = new E.Contract(S.cfg.contracts.usdc, ERC20, GW.signer(S.eth, S.account));
      return u.approve(S.game, BigInt(cap6)).then(function (tx) { onSent(); return tx.wait(); });
    },
    setSession: function (cap6, onSent) {
      var a = S.account.toLowerCase(), fresh = E.Wallet.createRandom(), g = new E.Contract(S.game, ABI, GW.signer(S.eth, S.account));
      var expiry = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
      /* the new key waits beside the old one until the contract has it: a refused confirmation changes nothing */
      lsSet(LS.key + a + '.next', fresh.privateKey);
      if (lsGet(LS.key + a + '.next') !== fresh.privateKey) return Promise.reject(Object.assign(new Error('This browser keeps no storage for this site, and the set-up needs it. Leave private mode and try again.'), { plain: true }));
      return g.setSession(fresh.address, expiry, BigInt(cap6)).then(function (tx) { onSent(); return tx.wait(); }).then(function () {
        lsSet(LS.key + a, fresh.privateKey); lsSet(LS.key + a + '.next', null); loadKey();
        S.sess = { key: fresh.address, expiry: expiry, left6: cap6 }; S.fresh.sess = { v: S.sess, t: Date.now() }; S.fresh.gone = null;
      });
    },
    revoke: function (onSent) {
      var g = new E.Contract(S.game, ABI, GW.signer(S.eth, S.account));
      return g.revokeSession().then(function (tx) { onSent(); return tx.wait(); }).then(function () { S.fresh.gone = { t: Date.now() }; S.fresh.sess = null; });
    },
    refund: function (round, onSent) {
      var g = new E.Contract(S.game, ABI, GW.signer(S.eth, S.account));
      return g.refund(round).then(function (tx) { onSent(); return tx.wait(); });
    },
    claim: function (onSent) {
      var g = new E.Contract(S.game, ABI, GW.signer(S.eth, S.account));
      return g.claim().then(function (tx) { onSent(); return tx.wait(); });
    }
  };
  /* the demo's first-time walk: the same sheets and words, a pretend contract. Nothing is sent, nothing is asked of the wallet. */
  var PRETEND = {
    read: function () { if (S.bal == null) S.bal = 100; S.hype = 1e16; return Promise.resolve(); },
    approve: function (cap6, onSent) { return wait(700).then(onSent).then(function () { return wait(900); }).then(function () { S.allowance = cap6; }); },
    setSession: function (cap6, onSent) { return wait(700).then(onSent).then(function () { return wait(900); }).then(function () { S.key = { address: DEMO_ME, signingKey: null }; S.sess = { key: DEMO_ME, expiry: Date.now() / 1000 + SESSION_DAYS * 86400, left6: cap6 }; }); },
    revoke: function (onSent) { return wait(700).then(onSent).then(function () { return wait(700); }); }
  };
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function readWallet() {
    if (!S.account || (S.demo && !S.walk)) return Promise.resolve();
    return CHAIN.read().then(function () { S.readErr = false; }, function () {
      S.readErr = true;
      clearTimeout(S.readT); S.readT = setTimeout(function () { if (S.readErr && S.account) readWallet().then(paintAll); }, 5000);      /* and again in five seconds */
    });
  }
  var subscribed = [];
  function subscribe(eth) {
    if (subscribed.indexOf(eth) >= 0 || typeof eth.on !== 'function') return;
    subscribed.push(eth);
    eth.on('accountsChanged', function (accounts) { if (eth !== S.eth) return; if (!accounts || !accounts.length) disconnect(); else setAccount(eth, accounts[0]); });
    eth.on('chainChanged', function (hex) { if (eth !== S.eth) return; S.chainOk = parseInt(hex, 16) === Number(S.cfg.chainId || 999); paintAll(); });
  }
  function setAccount(eth, account) {
    S.eth = eth; S.account = E ? E.getAddress(account) : String(account); S.walletName = GW.nameOf(eth); S.bal = S.walk ? 100 : null; S.allowance = 0; S.hype = null; S.sess = null; S.my = null; S.queued = false; S.restored = 0;
    S.stuck = null; S.held = 0; S.settledSeen = 0; S.fresh = { allow: null, sess: null, gone: null };
    setEvery(false); subscribe(eth);
    if (!S.walk) loadKey();
    return GW.chainOf(eth).then(function (id) { S.chainOk = id === Number(S.cfg.chainId || 999); }, function () { S.chainOk = true; }).then(function () { paintAll(); return readWallet(); }).then(paintAll);
  }
  function connect(always) {
    if (!GW) { say('The wallet part of this page did not load. Reload the page.'); paintAll(); return Promise.resolve(); }
    say('');
    return GW.connect({
      always: !!always, note: 'Pick the wallet to play from. Bets play straight from its USDC on HyperEVM: no deposit first.',
      onStep: function (stepName, name) { S.busy = stepName === 'chain' ? 'Switching to HyperEVM…' : 'Confirm in ' + name + '…'; paintKey(); }
    }).then(function (r) {
      if (!r) return null;
      return setAccount(r.eth, r.account).then(function () { if (r.say && !S.chainOk) say(r.say); });
    }, function (e) { say(e && e.plain ? e.message : describe(e)); }).then(function () { S.busy = ''; paintAll(); });
  }
  function disconnect() {
    [SET.sh, STOP.sh].forEach(function (s) { if (s && s.isOpen) s.close(); });
    S.account = null; S.eth = null; S.bal = null; S.allowance = 0; S.hype = null; S.sess = null; S.key = null; S.my = null; S.queued = false; S.stuck = null; S.held = 0; setEvery(false); S.busy = ''; say(''); paintAll();
  }
  function toChain() {
    S.busy = 'Switching to HyperEVM…'; say(''); paintKey();
    GW.toChain(S.eth).then(function () { S.chainOk = true; }, function (e) { say(e && e.plain ? e.message : describe(e)); }).then(function () { S.busy = ''; paintAll(); });
  }
  /* a bet in a round that was never settled: the stake comes back with one wallet confirmation */
  function takeBack() {
    var p = S.stuck; if (!p) return;
    S.busy = 'Confirm in ' + (S.walletName || 'your wallet') + '…'; say(''); paintKey();
    CHAIN.refund(p.round, function () { S.busy = 'Taking it back…'; paintKey(); }).then(function () {
      S.stuck = null; S.settledSeen = p.round; say('Your ' + usd(p.usd) + ' from round ' + p.round + ' is back in your wallet.', true, 9000);
      return readWallet();
    }, function (e) { say(e && e.plain ? e.message : describe(e)); }).then(function () { S.busy = ''; paintAll(); });
  }
  /* a payout the token would not deliver when the round was settled (rare): the contract kept it; this collects it */
  function collect() {
    var amt = S.held;
    S.busy = 'Confirm in ' + (S.walletName || 'your wallet') + '…'; say(''); paintKey();
    CHAIN.claim(function () { S.busy = 'Collecting…'; paintKey(); }).then(function () {
      S.held = 0; say(usd(amt) + ' is in your wallet.', true, 9000);
      return readWallet();
    }, function (e) { say(e && e.plain ? e.message : describe(e)); }).then(function () { S.busy = ''; paintAll(); });
  }

  /* ==== the one key ==== */
  function press() {
    var act = KEY.act, t = perf();
    if (!act || el.go.disabled) return;
    if (act !== 'cash' && t - KEY.since < 380) return;        /* a second tap meant for the key as it was a moment ago */
    S.touched = true;
    if (act === 'cash') cashOut();
    else if (act === 'bet') { if (problem() || gate()) { paintAll(); return; } placeBet(); }
    else if (act === 'queue') { if (problem() || gate()) { paintAll(); return; } S.queued = true; S.say = null; paintAll(); }
    else if (act === 'unqueue') { S.queued = false; if (S.every) setEvery(false); paintAll(); }
    else if (act === 'cancel') cancelBet();
    else if (act === 'connect') connect(false);
    else if (act === 'chain') toChain();
    else if (act === 'setup') openSetup();
    else if (act === 'refund') takeBack();
  }
  function shareWin() {
    var my = S.my && S.my.state === 'out' ? S.my : null, L = my ? { round: my.round, x: my.outX, stake: my.usd, win: my.win } : S.last;
    if (!L || !window.ConfettiShare) return;
    window.ConfettiShare.open({ sym: 'CRASH', side: 'long', sideWord: 'CASH OUT', lev: L.x / 100, margin: L.stake, pnl: L.win, account: S.demo ? '' : S.account,
      lines: ['Crash', 'Cash out before it does', 'Fully onchain on hyperliquid'] }, { key: 'crash:' + L.round + ':' + L.stake, title: 'Share your win' });
  }

  /* ==== start ==== */
  function fitViewport() {
    var vv = window.visualViewport, r = el.root;
    if (!vv) return;
    var kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)), f = document.activeElement;
    if (kb > 80) { r.style.bottom = 'auto'; r.style.top = vv.offsetTop + 'px'; r.style.height = vv.height + 'px'; if ((f === el.amount || f === el.autoIn) && f.scrollIntoView) f.scrollIntoView({ block: 'center' }); }
    else { r.style.removeProperty('bottom'); r.style.removeProperty('top'); r.style.removeProperty('height'); }
    fit(); more();
  }
  function wire() {
    el.amount.addEventListener('input', function () { setAmount(el.amount.value, true); paintForm(); paintKey(); paintSay(); });
    el.autoIn.addEventListener('input', function () { setAuto(el.autoIn.value, true); paintForm(); paintKey(); paintSay(); });
    [el.amount, el.autoIn].forEach(function (f) {
      f.addEventListener('blur', function () { S.touched = true; paintForm(); paintKey(); paintSay(); });
      f.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); f.blur(); } });
      f.addEventListener('focus', function () { setTimeout(function () { try { f.select(); } catch (e) { /* fine */ } }, 0); });
    });
    el.amt.addEventListener('click', function (ev) { if (ev.target !== el.amount) el.amount.focus(); });
    el.autoBox.addEventListener('click', function (ev) { if (ev.target !== el.autoIn) el.autoIn.focus(); });
    Array.prototype.forEach.call(el.chips.children, function (b) { b.addEventListener('click', function () { S.touched = true; setAmount(b.getAttribute('data-usd')); paintForm(); paintKey(); paintSay(); }); });
    /* an auto quick key sets it; the one that is on, pressed again, takes it off */
    Array.prototype.forEach.call(el.autoChips.children, function (b) { b.addEventListener('click', function () { var v = Number(b.getAttribute('data-x')); setAuto(S.auto === v ? '' : (v / 100).toFixed(2)); paintForm(); paintKey(); paintSay(); }); });
    el.every.addEventListener('click', function () { setEvery(!S.every); if (!S.every) S.queued = false; paintKey(); paintSay(); });
    /* Cash out answers on the way down, not on the way up: a press is a press */
    el.go.addEventListener('pointerdown', function (ev) { if (KEY.act === 'cash' && (ev.button === 0 || ev.pointerType !== 'mouse')) { KEY.swallow = perf(); cashOut(); } });
    el.go.addEventListener('click', function () { if (perf() - KEY.swallow < 700) { KEY.swallow = 0; return; } press(); });
    el.share.addEventListener('click', shareWin);
    el.menu.addEventListener('click', openMenu);
    el.who.addEventListener('click', openMenu);
    el.fair.addEventListener('click', function () { openFair(0); });
    el.fair2.addEventListener('click', function () { openFair(0); });
    el.main.addEventListener('scroll', more, { passive: true });
    window.addEventListener('resize', function () { fit(); more(); });
    if (window.ResizeObserver) new ResizeObserver(fit).observe(el.stage);
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitViewport); window.visualViewport.addEventListener('scroll', fitViewport); }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { ST.last = 0; if (!S.demo) readWallet().then(paintAll); } });
  }
  function start(cfg) {
    var q = null;
    try { q = new URLSearchParams(location.search); } catch (e) { q = null; }
    S.cfg = cfg || {};
    S.game = cfg && cfg.contracts && isAddr(cfg.contracts.crash) ? cfg.contracts.crash : '';
    if (S.game && E) { try { S.game = E.getAddress(S.game.toLowerCase()); } catch (e) { S.game = ''; } }
    S.api = cfg && cfg.crash && typeof cfg.crash.api === 'string' ? cfg.crash.api.trim() : '';
    S.soon = !S.game || !S.api;
    S.demo = !!(S.soon || !E || (q && q.get('demo') === '1'));
    S.walk = !!(S.demo && GW && q && q.get('first') === '1');
    if (GW) GW.init(cfg);
    if (S.demo) {
      S.bal = 100; S.maxBet = 100; S.maxWin6 = 1e9;
      if (S.walk) CHAIN = PRETEND;
      NET = window.ConfettiCrashDemo.connect(onMsg);
      pings();
    } else {
      NET = liveNet(S.api);
      setTimeout(function () { GW.restore().then(function (r) { if (r && !S.account) return setAccount(r.eth, r.account); }).catch(function () { /* stay disconnected */ }); }, 250);
      setInterval(function () { if (!document.hidden && S.account) readWallet().then(function () { paintForm(); paintKey(); paintSay(); }); }, 30000);
    }
    paintAll();
  }
  function boot() {
    ['root:crRoot', 'main:crMain', 'who:crWho', 'whoAddr:crWhoAddr', 'menu:crMenu', 'mode:crMode', 'count:crCount', 'strip:crStrip', 'fair:crFair', 'fair2:crFair2', 'stage:crStage', 'cv:crCanvas', 'live:crLive',
      'amt:crAmt', 'amount:crAmount', 'autoBox:crAutoBox', 'autoIn:crAuto', 'chips:crChips', 'autoChips:crAutoChips', 'wins:crWins', 'every:crEvery', 'everyHint:crEveryHint', 'wallet:crWalletLine',
      'liveDot:crLiveDot', 'liveWord:crLiveWord', 'players:crPlayers', 'gameLink:crGameLink', 'sayLine:crSay', 'share:crShare', 'go:crGo', 'goT:crGoT']
      .forEach(function (p) { var kv = p.split(':'); el[kv[0]] = $(kv[1]); });
    ST.cv = el.cv; ST.c = el.cv.getContext('2d');
    tokens(); fit();
    var a = lsGet(LS.amt), x = lsGet(LS.auto);
    if (a && Number(a) > 0) setAmount(a);
    if (x) setAuto(x);
    wire();
    paintAll();
    ST.raf = requestAnimationFrame(frame);
    try { document.fonts.ready.then(function () { tokens(); }); document.fonts.addEventListener('loadingdone', function () { ST.cells = {}; }); } catch (e) { /* the fallback face draws */ }
    fetch('config.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('config'); return r.json(); }).then(start, function () { start(null); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
