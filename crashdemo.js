/* confetti_ — crashdemo.js
   The demo's round server: the crash game's server, in the page itself (crash.html?demo=1, and while the game is not
   deployed). It speaks the very socket the real one does (CRASH_SPEC.md section 5): the same states, the same curve, the same
   JSON messages, with pretend money and a handful of pretend players. crash.js cannot tell the two apart: it is handed an
   object with send() and gets messages back, and every line that draws or keeps the round is shared.

   What is real here: the hash chain (made in this browser, 300 links), the salt, the crash point worked out from each revealed
   seed by crashmath.js, the cash-out rule (a cash-out at X is taken at once if the curve is already there, held until it is
   if this clock ran ahead, never after the crash), the lower of a manual cash-out and an auto target.
   What is pretend: the money, the other players, the wire (a few tens of milliseconds each way, so the page's clock
   measuring has something to measure) and the server's clock (set apart from this device's on purpose).

   Time: every event has its own due time and is run in order, so a tab left in the background catches up exactly where a
   real server would be, instead of running late. */
(function () {
  'use strict';

  var M = window.ConfettiCrashMath;
  var BET_MS = 6000, SHOW_MS = 3000, CHAIN = 300, SKEW = 4321.5;
  var MAX_BET = 100000000n, MIN_BET = 1000000n, MAX_WIN = 1000000000n, EDGE = 100;
  var STAKES = [1, 1, 2, 5, 5, 10, 10, 10, 20, 25, 50];

  function connect(onMsg) {
    var open = true, queue = [], timer = 0, labelN = 0;
    var S = { round: 0, phase: 'BETTING', phaseEnds: null, flightStart: null, crashX100: 0, crashMs: 0, bets: [], history: [], chain: null, used: 0, salt: '', terminal: '' };

    function now() { return performance.timeOrigin + performance.now() + SKEW; }
    function lat() { return 22 + Math.random() * 30; }
    /* the wire, each way: a few tens of milliseconds, and (as on a real socket) never out of order */
    function pipe(deliver) {
      var q = [], t = 0, due = 0;
      function drain() { t = 0; while (q.length && q[0].at <= now() + 0.5) { var e = q.shift(); if (open) deliver(JSON.parse(e.s)); } if (q.length && open) t = setTimeout(drain, Math.max(0, q[0].at - now())); }
      return function (m, wait) { var at = Math.max(due + 0.01, now() + wait); due = at; q.push({ at: at, s: JSON.stringify(m) }); if (!t) t = setTimeout(drain, Math.max(0, q[0].at - now())); };
    }
    var down = pipe(function (m) { onMsg(m); }), up = pipe(function (m) { pump(); recv(m); });
    function emit(m, at) { if (open) down(m, at != null && now() - at > 400 ? 0 : lat()); }   /* catching up: no wire */
    function later(at, fn) { queue.push({ at: at, fn: fn }); queue.sort(function (a, b) { return a.at - b.at; }); arm(); }
    function arm() { clearTimeout(timer); if (open && queue.length) timer = setTimeout(pump, Math.max(0, Math.min(1000, queue[0].at - now()))); }
    function pump() { while (open && queue.length && queue[0].at <= now()) { var e = queue.shift(); e.fn(e.at); } arm(); }

    /* the chain: c[0] random, c[i] = keccak256(c[i-1]); the end is "committed"; round k reveals c[N-k] */
    function newChain() {
      var b = new Uint8Array(32); crypto.getRandomValues(b);
      var c = [M.hexOf(b)], i;
      for (i = 0; i < CHAIN; i++) c.push(M.keccakHex(c[i]));
      S.chain = c; S.used = 0; S.terminal = c[CHAIN]; S.base = Math.max(0, S.round - 1);      /* round k of a chain is round base + k */
      S.salt = M.keccakHex(S.terminal + S.terminal.slice(2));      /* stands in for the hash of a block after the commit */
    }
    function nextSeed() { if (S.used >= CHAIN) newChain(); S.used++; return S.chain[CHAIN - S.used]; }

    function stateMsg(at) {
      return { t: 'state', round: S.round, phase: S.phase, phaseEndsMs: S.phaseEnds, flightStartMs: S.flightStart, serverMs: now(), edgeBps: EDGE, minBet: String(MIN_BET), maxBet: String(MAX_BET), maxWinPerBet: String(MAX_WIN),
        paused: false, notice: '',
        bets: S.bets.map(function (b) { return { p: b.p, stake: String(b.stake), auto: b.auto, out: b.out }; }),
        history: S.history.slice(0, 50),
        demo: { terminal: S.terminal, salt: S.salt, chainBase: S.base } };      /* what the page reads from the contract when the game is live */
    }
    function mine() { return S.bets.filter(function (b) { return b.mine; })[0] || null; }

    /* a pretend player: joins some rounds, with a stake and the multiplier they mean to leave at (auto, or by hand) */
    function botPlan() {
      var u = Math.random(), x = Math.round(100 * (1.06 + -Math.log(1 - u * 0.985) * 0.85));
      return { stake: BigInt(STAKES[Math.floor(Math.random() * STAKES.length)]) * 1000000n, x: Math.min(5000, x), auto: Math.random() < 0.4 };
    }

    function betting(at) {
      S.round++; S.phase = 'BETTING'; S.phaseEnds = at + BET_MS; S.flightStart = null; S.bets = []; S.crashX100 = 0; labelN = 0;
      S.seed = nextSeed();
      emit(stateMsg(), at);
      var n = 3 + Math.floor(Math.random() * 6), i;
      for (i = 0; i < n; i++) (function (plan, when) {
        later(when, function (t) {
          if (S.phase !== 'BETTING') return;
          var b = { p: 'Player ' + (++labelN), stake: plan.stake, auto: plan.auto ? plan.x : 0, out: 0, x: plan.x, mine: false };
          S.bets.push(b);
          emit({ t: 'bet', round: S.round, p: b.p, stake: String(b.stake), auto: b.auto }, t);
        });
      })(botPlan(), at + 250 + Math.random() * (BET_MS - 700));
      later(at + BET_MS, locking);
    }
    function locking(at) {
      var ms = 1000 + Math.random() * 1300;
      S.phase = 'LOCKING'; S.phaseEnds = null;
      emit(stateMsg(), at);
      later(at + ms, flight);
    }
    function out(b, x, t) {
      if (S.phase !== 'FLIGHT' || b.out || x > S.crashX100) return;
      b.out = x;
      emit({ t: 'out', round: S.round, p: b.p, multX100: x }, t);
    }
    function flight(at) {
      var r = S.round;
      S.phase = 'FLIGHT'; S.phaseEnds = null; S.flightStart = at;
      S.crashX100 = M.crashX100(S.seed, S.salt, EDGE); S.crashMs = M.msFor(S.crashX100);
      emit(stateMsg(), at);
      S.bets.forEach(function (b) {
        /* the multiplier a bet leaves at by itself: its auto target, or where its profit reaches the most one bet may win */
        var cap = M.capX100(b.stake, MAX_WIN), x = b.mine ? (b.auto && b.auto < cap ? b.auto : cap) : b.x;
        if (x <= S.crashX100) later(at + M.msFor(x), function (t) { if (S.round === r) out(b, x, t); });
      });
      later(at + S.crashMs, crashed);
    }
    function crashed(at) {
      var r = S.round;
      S.phase = 'CRASHED'; S.phaseEnds = at + SHOW_MS;
      S.history.unshift({ round: r, crashX100: S.crashX100, seed: S.seed });
      if (S.history.length > 60) S.history.length = 60;
      emit({ t: 'crash', round: r, crashX100: S.crashX100, seed: S.seed, settleTx: null }, at);
      emit(stateMsg(), at);
      later(at + 700, function (t) { emit({ t: 'settled', round: r, tx: null }, t); });
      later(at + SHOW_MS, betting);
    }

    /* what the page sends */
    function recv(m) {
      if (!m || !open) return;
      if (m.t === 'ping') { emit({ t: 'pong', id: m.id, serverMs: now() }); return; }
      if (m.t === 'bet') {
        var stake = 0n; try { stake = BigInt(m.stake); } catch (e) { stake = 0n; }
        var auto = Number(m.autoX100) || 0;
        var why = m.round !== S.round ? 'wrong round' : S.phase !== 'BETTING' ? 'betting is closed' : mine() ? 'you already have a bet in this round' : stake < MIN_BET ? 'stake under the minimum' : stake > MAX_BET ? 'stake over the maximum' : auto !== 0 && auto < 101 ? 'auto cash-out must be 1.01x or more' : '';
        if (why) { emit({ t: 'betRefused', nonce: m.nonce, why: why }); return; }
        var seat = { p: 'Player ' + (++labelN), stake: stake, auto: auto, out: 0, x: 0, mine: true, nonce: m.nonce };
        S.bets.push(seat);
        /* to the sender alone: which row is theirs. To everyone: the bet. */
        emit({ t: 'betAccepted', round: S.round, nonce: m.nonce, p: seat.p });
        emit({ t: 'bet', round: S.round, p: seat.p, stake: String(stake), auto: auto });
        return;
      }
      if (m.t === 'cancelBet') {
        var b = mine();
        if (!b || m.round !== S.round || S.phase !== 'BETTING' || b.nonce !== m.nonce) return;
        S.bets = S.bets.filter(function (x) { return x !== b; });
        emit({ t: 'betCancelled', round: S.round, p: b.p, why: 'cancelled' });
        return;
      }
      if (m.t === 'out') {
        var me = mine(), x = Number(m.multX100), r = S.round;
        var no = m.round !== S.round || !me ? 'no bet in this round' : S.phase === 'BETTING' || S.phase === 'LOCKING' ? 'the round has not started' : S.phase !== 'FLIGHT' ? 'too late' : me.out ? 'already out' : !(x >= 100) ? 'bad message' : '';
        if (no) { emit({ t: 'outRefused', round: m.round, why: no }); return; }
        if (M.x100At(now() - S.flightStart) >= x) out(me, x, now());
        else later(S.flightStart + M.msFor(x), function (t) { if (S.round === r) out(me, x, t); });      /* this clock ran ahead: held until the curve is there */
      }
    }

    /* twenty rounds already played, so the strip of the last rounds is full at the first look */
    newChain();
    for (var k = 0; k < 20; k++) { var sd = nextSeed(); S.round++; S.history.unshift({ round: S.round, crashX100: M.crashX100(sd, S.salt, EDGE), seed: sd }); }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) pump(); });
    betting(now());

    return {
      send: function (m) { up(m, lat()); return true; },
      close: function () { open = false; clearTimeout(timer); },
      demo: true
    };
  }

  window.ConfettiCrashDemo = { connect: connect };
})();
