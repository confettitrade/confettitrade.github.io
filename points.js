/* confetti points: the rules engine (mirrors ops/points/indexer.py) and the live HUD.
 *
 * points.json is the indexer's snapshot (authoritative totals and the engine state of every wallet at
 * block B). This file follows the chain from B itself (same RPCs as config.json), applies
 * points-rules.json to each new event, and so ticks within seconds; the next snapshot replaces it.
 * Read-only: it only calls eth_accounts, eth_blockNumber, eth_getLogs and eth_getBlockByNumber.
 */
(function (root) {
  'use strict';

  var DAY = 86400;
  var ZERO = '0x0000000000000000000000000000000000000000';
  var NOSHARE = { refShare: 1, refBonus: 1, refLadder: 1, refFees: 1, referred: 1 };

  /* ================================================================ engine */

  function newWallet() {
    return { t: 0, b: {}, hr: {}, d: -1, sk: 0, bk: 0, sm: [], vol: 0, vm: 0, mk: [], net: 0, wm: 0, fn: 0,
      op: {}, cp: {}, stk: [0, 0], by: '', kids: [], act: 0, ld: 0, code: '', rf: 0, rp: 0 };
  }

  function Engine(rules, wallets) {
    this.r = rules;
    this.W = wallets || {};
  }

  Engine.prototype.w = function (a) {
    var x = this.W[a];
    if (!x) { x = newWallet(); this.W[a] = x; }
    return x;
  };

  Engine.prototype.award = function (a, src, pts, t, out, share) {
    if (share === undefined) share = true;
    if (!(pts > 0)) return;
    var w = this.w(a);
    var cap = this.r.dailyCaps[src];
    if (cap !== undefined) {
      var day = Math.floor(t / DAY);
      var c = w.cp[src];
      if (!c || c[0] !== day) { c = [day, 0]; w.cp[src] = c; }
      var room = cap - c[1];
      if (room <= 0) return;
      if (pts > room) pts = room;
      c[1] += pts;
    }
    w.t += pts;
    w.b[src] = (w.b[src] || 0) + pts;
    var h = String(Math.floor(t / 3600));
    w.hr[h] = (w.hr[h] || 0) + pts;
    out.push([a, src, pts]);
    if (share && !NOSHARE[src] && w.by) {
      this.award(w.by, 'refShare', pts * this.r.referral.shareBps / 10000, t, out, false);
    }
  };

  Engine.prototype.touch = function (a, t, out) {
    var w = this.w(a);
    var day = Math.floor(t / DAY);
    if (w.d === day) return;
    w.sk = (w.d === day - 1) ? w.sk + 1 : 1;
    w.d = day;
    if (w.sk > w.bk) w.bk = w.sk;
    var st = this.r.streak;
    this.award(a, 'daily', this.r.daily.flat, t, out);
    this.award(a, 'streak', Math.min(w.sk, st.maxDays) * st.perDay, t, out);
    for (var i = 0; i < st.milestones.length; i++) {
      var m = st.milestones[i];
      if (w.sk >= m.at && w.sm.indexOf(m.at) < 0) {
        w.sm.push(m.at);
        this.award(a, 'streak', m.pts, t, out);
      }
    }
  };

  Engine.prototype.fundedReferral = function (a, t, out) {
    var w = this.w(a);
    if (!w.by || w.rp) return;
    w.rp = 1;
    var ref = this.w(w.by);
    var rf = this.r.referral;
    ref.act += 1;
    this.award(w.by, 'refBonus', rf.firstTrade, t, out, false);
    while (ref.ld < rf.ladder.length && ref.act >= rf.ladder[ref.ld].at) {
      this.award(w.by, 'refLadder', rf.ladder[ref.ld].pts, t, out, false);
      ref.ld += 1;
    }
    this.award(a, 'referred', rf.referredWelcome, t, out, false);
  };

  Engine.prototype.accrue = function (a, t, out) {
    var w = this.w(a);
    var s = w.stk;
    if (s[0] > 0 && t > s[1]) {
      var pts = s[0] / 1000 * this.r.staking.perThousandConfettiPerDay * (t - s[1]) / DAY;
      this.award(a, 'staking', pts, t, out);
    }
    if (t > s[1]) s[1] = t;
  };

  Engine.prototype.accrueAll = function (t) {
    var out = [];
    for (var a in this.W) {
      if (this.W[a].stk[0] > 0) this.accrue(a, t, out);
    }
    return out;
  };

  Engine.prototype.apply = function (ev) {
    var out = [];
    var k = ev.k, a = ev.a, t = ev.t, r = this.r, w, i;
    if (k === 'dep') {
      this.touch(a, t, out);
      w = this.w(a);
      w.net += ev.v;
      if (w.net > w.wm) {
        this.award(a, 'deposit', (w.net - w.wm) * r.deposit.perUsdc, t, out);
        w.wm = w.net;
      }
    } else if (k === 'wd') {
      this.w(a).net -= ev.v;
    } else if (k === 'open') {
      w = this.w(a);
      w.op[String(ev.id)] = [ev.m, ev.l, ev.x, ev.b];
      if (ev.m >= r.minMarginUsdc) {
        this.touch(a, t, out);
        var notional = ev.m * ev.l;
        var lv = r.open.leverage;
        var lf = lv[lv.length - 1].x;
        for (i = 0; i < lv.length; i++) { if (ev.l <= lv[i].upTo) { lf = lv[i].x; break; } }
        this.award(a, 'open', notional * r.open.perNotionalUsd * lf, t, out);
        if (w.mk.indexOf(ev.x) < 0) {
          w.mk.push(ev.x);
          this.award(a, 'market', r.firstMarket.flat, t, out);
        }
        w.vol += notional;
        var ms = r.volume.milestones;
        while (w.vm < ms.length && w.vol >= ms[w.vm].at) {
          this.award(a, 'volume', ms[w.vm].pts, t, out);
          w.vm += 1;
        }
        if (!w.fn) { w.fn = 1; this.fundedReferral(a, t, out); }
      }
    } else if (k === 'close') {
      w = this.w(a);
      var pos = w.op[String(ev.id)];
      delete w.op[String(ev.id)];
      this.touch(a, t, out);
      if (pos && ev.b - pos[3] >= r.minHoldBlocks) {
        var n = pos[0] * pos[1];
        this.award(a, 'close', n * r.close.perNotionalUsd, t, out);
        var c, pts;
        if (ev.p > 0) {
          var net = ev.p - ev.f;
          c = r.win;
          pts = (net >= c.minUsdc ? c.flat : 0) + net * c.perUsdc;
          this.award(a, 'win', Math.min(pts, c.max), t, out);
        } else if (ev.p < 0) {
          var lost = -ev.p + ev.f;
          c = r.loss;
          pts = (lost >= c.minUsdc ? c.flat : 0) + lost * c.perUsdc;
          this.award(a, 'loss', Math.min(pts, c.max), t, out);
        }
      }
    } else if (k === 'liq') {
      w = this.w(a);
      delete w.op[String(ev.id)];
      this.touch(a, t, out);
      var lc = r.liquidation;
      this.award(a, 'liquidation', Math.min(lc.flat + ev.m * lc.perUsdc, lc.max), t, out);
      if (ev.r !== a) this.award(ev.r, 'liquidator', lc.liquidatorFlat, t, out);
    } else if (k === 'code') {
      w = this.w(a);
      if (!w.code) {
        w.code = ev.c;
        this.award(a, 'code', r.code.flat, t, out);
      } else {
        w.code = ev.c;
      }
    } else if (k === 'refset') {
      w = this.w(a);
      if (!w.by && ev.r !== ZERO && ev.r !== a) {
        w.by = ev.r;
        this.w(ev.r).kids.push(a);
        if (w.fn) this.fundedReferral(a, t, out);
      }
    } else if (k === 'paid') {
      this.w(a).rf += ev.v;
      this.award(a, 'refFees', ev.v * r.referral.feePerUsdc, t, out, false);
    } else if (k === 'stake') {
      this.accrue(a, t, out);
      this.w(a).stk[0] += ev.v;
    } else if (k === 'unstake') {
      this.accrue(a, t, out);
      var s = this.w(a).stk;
      s[0] = Math.max(0, s[0] - ev.v);
    }
    return out;
  };

  var api = { Engine: Engine, newWallet: newWallet };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof document === 'undefined') return;
  root.ConfettiPointsEngine = api;

  /* ================================================================ HUD */

  var TOPICS = {
    '0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7': 'dep',
    '0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5': 'wd',
    '0x2682e1f684e3e147d98092851958f214e94786046406bb4487f09758818c4fc7': 'open',
    '0xdf970ab523e009ea6752d30592f57ba858bbcba00e98d99bc3f277ffa32dae76': 'close',
    '0xd2dd1a738a1eebcc2e8a445ee8749ca54296b00bce8cf25d819eca9244e319a0': 'liq',
    '0xd07860d38e071bfab5c5f262789fd0c4e15fe7dad8e287f47ff0e962d71092a4': 'code',
    '0x0a721ab4682ceb61c7e4d264ef879fc419a6d764b136e7d96ef54b2053c75673': 'paid',
    '0x5f7165288eef601591cf549e15ff19ef9060b7f71b9c115be946fa1fe7ebf68a': 'refset',
    '0x9e71bc8eea02a63969f509818f2dafb9254532904319f9dbda79b67bd34a5f3d': 'stake',
    '0x0f5bb82176feb1b5e747e28471aa92156a04d9f3ab9f45f28e2d704232b93f75': 'unstake'
  };
  var TOPIC_LIST = Object.keys(TOPICS);
  var ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  var SNAP_EVERY_MS = 120000;
  var POLL_MS = 2500;
  var BASE_URL = 'https://confetti.trade/?ref=';

  var S = {
    cfg: null, rules: null, snap: null, eng: null,
    snapBlock: 0, cursor: 0, headTs: 0, headSeenAt: 0, live: false,
    me: '', view: '', forced: '',
    shown: 0, target: 0, deltaPending: 0, deltaTimer: 0,
    ts: {}, dirty: true, panel: null, rpcIdx: 0, chunk: 1000,
    providers: [], err: ''
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { return Math.floor(n + 1e-9).toLocaleString('en-US'); }
  function short(a) { return a.slice(0, 6) + '…' + a.slice(-4); }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }

  /* ---- rpc ------------------------------------------------------------------------------- */

  function rpcUrls() {
    var c = S.cfg || {};
    var list = [c.logRpcUrl, c.rpcUrl, 'https://hyperliquid.drpc.org', 'https://rpc.purroofgroup.com', 'https://rpc.hyperliquid.xyz/evm'];
    var out = [];
    list.forEach(function (u) { if (u && out.indexOf(u) < 0) out.push(u); });
    return out;
  }

  function rpc(method, params) {
    var urls = rpcUrls();
    var tries = 0;
    function attempt() {
      var url = urls[S.rpcIdx % urls.length];
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }) })
        .then(function (r) { if (r.status === 429) throw new Error('429'); return r.json(); })
        .then(function (j) {
          if (j.error) {
            var m = String(j.error.message || '');
            var e = new Error(m); e.rpc = true; throw e;
          }
          return j.result;
        })
        .catch(function (e) {
          if (e && e.rpc && !/rate/i.test(e.message)) throw e;
          tries += 1;
          S.rpcIdx += 1;
          if (tries >= urls.length * 2) throw e;
          return attempt();
        });
    }
    return attempt();
  }

  /* ---- log decoding ---------------------------------------------------------------------- */

  function word(data, i) { return BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64)); }
  function sword(data, i) { var v = word(data, i); return v >= (1n << 255n) ? v - (1n << 256n) : v; }
  function taddr(t) { return '0x' + t.slice(26).toLowerCase(); }
  function tint(t) { return Number(BigInt(t)); }
  function usd(b) { return Number(b) / 1e6; }

  function decodeLog(lg) {
    var k = TOPICS[lg.topics[0]];
    if (!k) return null;
    var d = lg.data;
    var ev = { k: k, b: parseInt(lg.blockNumber, 16), i: parseInt(lg.logIndex, 16) };
    if (k === 'dep') { ev.a = taddr(lg.topics[1]); ev.v = usd(word(d, 0)); }
    else if (k === 'wd') { ev.a = taddr(lg.topics[1]); ev.v = usd(word(d, 0)); }
    else if (k === 'open') { ev.id = tint(lg.topics[1]); ev.a = taddr(lg.topics[2]); ev.x = tint(lg.topics[3]); ev.m = usd(word(d, 1)); ev.l = Number(word(d, 2)); }
    else if (k === 'close') { ev.id = tint(lg.topics[1]); ev.a = taddr(lg.topics[2]); ev.p = Number(sword(d, 1)) / 1e6; ev.f = usd(word(d, 2)); }
    else if (k === 'liq') { ev.id = tint(lg.topics[1]); ev.a = taddr(lg.topics[2]); ev.r = taddr(lg.topics[3]); ev.m = usd(word(d, 1)); }
    else if (k === 'code') {
      ev.a = taddr(lg.topics[1]);
      var len = Number(word(d, 1));
      var hex = d.slice(2 + 128, 2 + 128 + len * 2);
      var s = '';
      for (var j = 0; j < hex.length; j += 2) s += String.fromCharCode(parseInt(hex.slice(j, j + 2), 16));
      ev.c = s;
    }
    else if (k === 'paid') { ev.a = taddr(lg.topics[1]); ev.v = usd(word(d, 0)); }
    else if (k === 'refset') { ev.a = taddr(lg.topics[1]); ev.r = taddr(lg.topics[2]); }
    else if (k === 'stake' || k === 'unstake') { ev.a = taddr(lg.topics[1]); ev.v = Number(word(d, 0)) / 1e18; }
    return ev;
  }

  function blockTs(n) {
    if (S.ts[n]) return Promise.resolve(S.ts[n]);
    return rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false]).then(function (b) {
      S.ts[n] = parseInt(b.timestamp, 16);
      return S.ts[n];
    });
  }

  function fetchLogs(from, to) {
    var c = S.cfg.contracts;
    var addrs = [c.exchange, c.referrals, c.staking].map(function (x) { return x.toLowerCase(); });
    var all = [];
    function step(start) {
      if (start > to) return Promise.resolve(all);
      var end = Math.min(start + S.chunk - 1, to);
      return rpc('eth_getLogs', [{ address: addrs, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16), topics: [TOPIC_LIST] }])
        .then(function (logs) { all = all.concat(logs || []); return step(end + 1); })
        .catch(function (e) {
          if (e && e.rpc && S.chunk > 50) { S.chunk = Math.max(50, Math.floor(S.chunk / 2)); S.rpcIdx += 1; return step(start); }
          throw e;
        });
    }
    return step(from);
  }

  /* ---- data ------------------------------------------------------------------------------ */

  function getJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
  }

  function loadSnapshot(first) {
    return getJson('points.json?t=' + Math.floor(Date.now() / 30000)).then(function (snap) {
      if (!first && S.snap && snap.generatedTs <= S.snap.generatedTs) return;
      S.snap = snap;
      S.eng = new Engine(S.rules, snap.wallets);
      S.snapBlock = snap.block;
      S.cursor = snap.block;
      S.headTs = snap.blockTime; S.headSeenAt = Date.now();
      S.live = false;
      S.dirty = true;
    });
  }

  function chainNow() { return S.headTs + (Date.now() - S.headSeenAt) / 1000; }

  function myW() { return S.eng && S.view ? S.eng.W[S.view] : null; }

  function followOnce() {
    if (!S.eng || !S.cfg) return Promise.resolve();
    return rpc('eth_getBlockByNumber', ['latest', false]).then(function (b) {
      var head = parseInt(b.number, 16);
      S.headTs = parseInt(b.timestamp, 16); S.headSeenAt = Date.now();
      S.ts[head] = S.headTs;
      if (head <= S.cursor) return;
      var from = S.cursor + 1;
      return fetchLogs(from, head).then(function (logs) {
        var evs = [];
        logs.forEach(function (lg) { var e = decodeLog(lg); if (e) evs.push(e); });
        evs.sort(function (x, y) { return x.b - y.b || x.i - y.i; });
        var blocks = [];
        evs.forEach(function (e) { if (blocks.indexOf(e.b) < 0) blocks.push(e.b); });
        return Promise.all(blocks.map(blockTs)).then(function () { return evs; });
      }).then(function (evs) {
        var announce = S.live;
        evs.forEach(function (e) {
          e.t = S.ts[e.b];
          var awards = S.eng.apply(e);
          if (announce) onAwards(awards, e);
        });
        S.cursor = head;
        S.live = true;
        S.err = '';
        S.dirty = true;
      });
    }).catch(function (e) { S.err = String(e && e.message || e); });
  }

  /* ---- awards: toast + pill delta ------------------------------------------------------- */

  function onAwards(awards, ev) {
    if (!S.view) return;
    var mine = awards.filter(function (x) { return x[0] === S.view; });
    if (!mine.length) return;
    var sum = 0, by = {};
    mine.forEach(function (x) { sum += x[2]; by[x[1]] = (by[x[1]] || 0) + x[2]; });
    if (sum < 1) return;
    var names = Object.keys(by).sort(function (p, q) { return by[q] - by[p]; }).slice(0, 2).map(function (s) { return (S.rules.sources[s] || s).toLowerCase(); });
    toast('+' + fmt(sum) + ' points', names.join(', '));
    S.deltaPending += sum;
    updateDelta();
  }

  function toast(big, small) {
    var host = $('ptsToasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ptsToasts'; host.className = 'pts-toasts';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    var el = document.createElement('div');
    el.className = 'pts-toast';
    el.innerHTML = '<b>' + esc(big) + '</b><span>' + esc(small) + '</span>';
    host.appendChild(el);
    while (host.children.length > 3) host.removeChild(host.firstChild);
    setTimeout(function () { el.classList.add('is-out'); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 400); }, 5200);
  }

  function updateDelta() {
    var els = [$('ptsPillDelta'), $('ptsDeltaBig')];
    els.forEach(function (el) {
      if (!el) return;
      el.textContent = S.deltaPending >= 1 ? '+' + fmt(S.deltaPending) : '';
      el.classList.remove('is-pop'); void el.offsetWidth; el.classList.add('is-pop');
    });
    clearTimeout(S.deltaTimer);
    S.deltaTimer = setTimeout(function () {
      S.deltaPending = 0;
      els.forEach(function (el) { if (el) { el.textContent = ''; el.classList.remove('is-pop'); } });
    }, 9000);
  }

  /* ---- derived numbers ------------------------------------------------------------------- */

  function pendingStake(w) {
    if (!w || !(w.stk[0] > 0)) return 0;
    var dt = chainNow() - w.stk[1];
    return dt > 0 ? w.stk[0] / 1000 * S.rules.staking.perThousandConfettiPerDay * dt / DAY : 0;
  }

  function totalFor(w) { return w ? w.t + pendingStake(w) : 0; }

  function perHour(w) {
    if (!w) return 0;
    var nowH = Math.floor(chainNow() / 3600);
    var s = 0;
    for (var h in w.hr) { if (parseInt(h, 10) > nowH - 24) s += w.hr[h]; }
    return s / 24;
  }

  function rankOf(a) {
    if (!S.eng) return { rk: 0, of: 0 };
    var W = S.eng.W;
    var house = (S.snap.wallets[a] && S.snap.wallets[a].house) || 0;
    var rk = 0, n = 0;
    var mine = W[a] ? W[a].t : 0;
    for (var k in W) {
      var x = W[k];
      if (x.t <= 0 || (S.snap.wallets[k] && S.snap.wallets[k].house)) continue;
      n += 1;
      if (x.t > mine || (x.t === mine && k < a)) rk += 1;
    }
    return { rk: house || mine <= 0 ? 0 : rk + 1, of: n };
  }

  function board() {
    var W = S.eng.W, rows = [];
    for (var k in W) {
      var x = W[k];
      if (x.t <= 0 || (S.snap.wallets[k] && S.snap.wallets[k].house)) continue;
      rows.push({ a: k, t: x.t, kids: x.kids.length, act: x.act });
    }
    rows.sort(function (p, q) { return q.t - p.t || (p.a < q.a ? -1 : 1); });
    return rows;
  }

  function networkTotal() {
    var t = 0;
    for (var k in S.eng.W) t += S.eng.W[k].t;
    return t;
  }

  /* ---- wallet ---------------------------------------------------------------------------- */

  function listen() {
    try {
      window.addEventListener('eip6963:announceProvider', function (ev) {
        if (ev && ev.detail && ev.detail.provider) S.providers.push(ev.detail.provider);
      });
      window.dispatchEvent(new Event('eip6963:requestProvider'));
    } catch (e) { /* ignore */ }
  }

  function injected() {
    var eth = window.ethereum;
    if (eth) {
      if (Array.isArray(eth.providers) && eth.providers.length) {
        var mm = eth.providers.filter(function (p) { return p.isMetaMask; })[0];
        return mm || eth.providers[0];
      }
      return eth;
    }
    return S.providers[0] || null;
  }

  function applyView() {
    var prev = S.view;
    S.view = S.forced || S.me;
    if (S.view !== prev) {
      S.deltaPending = 0; updateDelta();
      S.shown = totalFor(myW()); S.target = S.shown;
    }
    S.dirty = true;
  }

  function setMe(a) {
    a = a ? String(a).toLowerCase() : '';
    if (a === S.me) return;
    S.me = a;
    applyView();
  }

  function pollAccount() {
    var eth = injected();
    if (!eth || typeof eth.request !== 'function') return;
    eth.request({ method: 'eth_accounts' }).then(function (acc) {
      setMe(acc && acc[0] ? acc[0] : '');
    }).catch(function () { /* stay as is */ });
  }

  function watchWallet() {
    var eth = injected();
    if (eth && typeof eth.on === 'function' && !S.subscribed) {
      S.subscribed = true;
      eth.on('accountsChanged', function (acc) { setMe(acc && acc[0] ? acc[0] : ''); });
    }
  }

  /* ---- pill ------------------------------------------------------------------------------ */

  function mountPill() {
    var pill = document.createElement('a');
    pill.className = 'pts-pill';
    pill.id = 'ptsPill';
    pill.href = $('pointsPanel') ? '#pointsPanel' : 'trade.html#pointsPanel';
    pill.setAttribute('aria-label', 'Points');
    pill.innerHTML = '<span class="pts-pill-label">Points</span><span class="pts-pill-val" id="ptsPillVal">—</span><span class="pts-pill-delta" id="ptsPillDelta" aria-live="polite"></span>';
    var host = document.querySelector('.header-actions') || document.querySelector('.header-tools');
    var bar = document.querySelector('.header-actions') ? document.querySelector('header.header') : null;
    var mq = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
    function place() {
      if (!host) return;
      /* on a phone the actions row is full: the pill rides on the wordmark row instead */
      if (bar && mq && mq.matches && bar.querySelector('.wordmark')) {
        bar.insertBefore(pill, bar.querySelector('.wordmark').nextSibling);
        pill.classList.add('pts-pill-top');
      } else {
        host.insertBefore(pill, host.firstChild);
        pill.classList.remove('pts-pill-top');
      }
    }
    if (host) {
      place();
      if (mq && mq.addEventListener) mq.addEventListener('change', place);
    } else {
      pill.classList.add('pts-pill-float');
      document.body.appendChild(pill);
    }
    pill.addEventListener('click', function (e) {
      var p = $('pointsPanel');
      if (p) { e.preventDefault(); p.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); }
    });
  }

  /* ---- panel ----------------------------------------------------------------------------- */

  var SRC_ORDER = ['refShare', 'refBonus', 'refLadder', 'refFees', 'referred', 'open', 'close', 'win', 'loss', 'liquidation', 'liquidator',
    'deposit', 'staking', 'daily', 'streak', 'market', 'volume', 'code'];

  function rulesList() {
    var r = S.rules, f = function (n) { return n.toLocaleString('en-US'); };
    var rf = r.referral;
    var lv = r.open.leverage;
    var lad = rf.ladder.map(function (x) { return f(x.pts) + ' at ' + f(x.at); }).join(', ');
    var rows = [
      ['Referrals', (rf.shareBps / 100) + '% of everything your referees earn, for good. ' + f(rf.firstTrade) + ' when each makes a first trade. ' + lad + ' referred traders. ' + f(rf.feePerUsdc) + ' per USDC of referral fees.', 1],
      ['Open', f(r.open.perNotionalUsd) + ' per $ of notional, x' + lv[0].x + ' to x' + lv[lv.length - 1].x + ' by leverage'],
      ['Close', f(r.close.perNotionalUsd) + ' per $ of notional'],
      ['Win', f(r.win.flat) + ' plus ' + f(r.win.perUsdc) + ' per USDC won'],
      ['Loss', f(r.loss.flat) + ' plus ' + f(r.loss.perUsdc) + ' per USDC lost'],
      ['Liquidated', f(r.liquidation.flat) + ' plus ' + f(r.liquidation.perUsdc) + ' per USDC of margin; ' + f(r.liquidation.liquidatorFlat) + ' for liquidating someone'],
      ['Deposit', f(r.deposit.perUsdc) + ' per USDC of new money'],
      ['Stake', f(r.staking.perThousandConfettiPerDay) + ' per 1,000 CONFETTI a day'],
      ['Each day', f(r.daily.flat) + ' plus ' + f(r.streak.perDay) + ' per streak day (to ' + r.streak.maxDays + '); streak bonuses at ' + r.streak.milestones.map(function (x) { return x.at; }).join(', ')],
      ['New market', f(r.firstMarket.flat) + ' for the first trade in each'],
      ['Volume', r.volume.milestones.map(function (x) { return f(x.pts) + ' at $' + f(x.at); }).join(', ')]
    ];
    return rows.map(function (x) {
      return '<li' + (x[2] ? ' class="is-top"' : '') + '><b>' + esc(x[0]) + (x[2] ? ' <i>pays the most</i>' : '') + '</b><span>' + esc(x[1]) + '</span></li>';
    }).join('');
  }

  function mountPanel() {
    var p = $('pointsPanel');
    if (!p) return;
    p.innerHTML =
      '<div class="pts-head"><span class="pts-title">Points</span><span class="pts-meta" id="ptsMeta"></span></div>' +
      '<div class="pts-body">' +
      '<div class="pts-hero">' +
        '<div class="pts-big"><span id="ptsBig">0</span><span class="pts-delta" id="ptsDeltaBig" aria-live="polite"></span></div>' +
        '<div class="pts-sub" id="ptsSub"></div>' +
      '</div>' +
      '<div class="pts-cols">' +
        '<div class="pts-col" id="ptsColA"></div>' +
        '<div class="pts-col" id="ptsColB"></div>' +
        '<div class="pts-col" id="ptsColC"></div>' +
      '</div></div>';
    p.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-pts]') : null;
      if (!t) return;
      var what = t.getAttribute('data-pts');
      if (what === 'copy') copyLink(t);
      else if (what === 'refer') { var tab = $('tabRefer'); if (tab) { tab.click(); tab.scrollIntoView({ block: 'center' }); } }
      else if (what === 'connect') { var c = $('connectBtn'); if (c) c.click(); }
    });
  }

  function copyLink(btn) {
    var w = myW();
    if (!w || !w.code) return;
    var text = BASE_URL + w.code;
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy link'; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
    } else { legacyCopy(text); done(); }
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function renderPanel() {
    var p = $('pointsPanel');
    if (!p || !S.eng) return;
    var w = myW();
    var rk = S.view ? rankOf(S.view) : { rk: 0, of: 0 };
    var snap = S.snap;
    $('ptsMeta').textContent = 'rules v' + S.rules.version + ' · snapshot block ' + fmt(S.snapBlock) + (S.live ? ' · live' : '');

    // column A: breakdown
    var a = $('ptsColA'), html = '';
    if (!S.view) {
      html = '<h3>Your points</h3><div class="pts-empty">Connect a wallet and every action here earns points. Deposits, opens, closes, wins, losses, staking, each day you show up, and referrals most of all.</div>' +
        '<button class="btn btn-sm" type="button" data-pts="connect"' + ($('connectBtn') ? '' : ' hidden') + '>Connect</button>';
    } else {
      var b = w ? w.b : {}, srcs = Object.keys(b).filter(function (s) { return b[s] > 0; });
      var mx = 0; srcs.forEach(function (s) { if (b[s] > mx) mx = b[s]; });
      var pend = pendingStake(w);
      srcs.sort(function (x, y) { return (SRC_ORDER.indexOf(x) < 0 ? 99 : SRC_ORDER.indexOf(x)) - (SRC_ORDER.indexOf(y) < 0 ? 99 : SRC_ORDER.indexOf(y)); });
      html = '<h3>Where it comes from</h3>';
      if (!srcs.length) html += '<div class="pts-empty">No points yet. Deposit, open a position or stake CONFETTI and they start.</div>';
      html += '<ul class="pts-bars">' + srcs.map(function (s) {
        var v = b[s] + (s === 'staking' ? pend : 0);
        var top = s.indexOf('ref') === 0;
        return '<li' + (top ? ' class="is-ref"' : '') + '><span class="pts-bl">' + esc(S.rules.sources[s] || s) + '</span><span class="pts-bv" data-src="' + s + '">' + fmt(v) + '</span><span class="pts-bb"><i style="width:' + Math.max(2, Math.round(100 * v / Math.max(mx, 1))) + '%"></i></span></li>';
      }).join('') + '</ul>';
      var sk = w ? w.sk : 0;
      var alive = w && w.d >= Math.floor(chainNow() / DAY) - 1;
      html += '<div class="pts-kv"><span>Streak</span><b>' + (alive ? sk : 0) + ' day' + ((alive ? sk : 0) === 1 ? '' : 's') + '</b></div>' +
        '<div class="pts-kv"><span>Best streak</span><b>' + (w ? w.bk : 0) + '</b></div>';
      if (w && w.stk[0] > 0) {
        html += '<div class="pts-kv"><span>Staked</span><b>' + fmt(w.stk[0]) + ' CONFETTI</b></div>' +
          '<div class="pts-kv"><span>Staking earns</span><b id="ptsStkRate"></b></div>';
      }
    }
    a.innerHTML = html;

    // column B: referrals + rules
    var bcol = $('ptsColB'), rh = '<h3>Referrals <i>pay the most</i></h3>';
    var rf = S.rules.referral;
    if (!S.view) {
      rh += '<div class="pts-empty">Your link, your referees and what they earn you show here once a wallet is connected.</div>';
    } else if (w && w.code) {
      var link = BASE_URL + w.code;
      var next = null;
      for (var i = 0; i < rf.ladder.length; i++) { if (w.act < rf.ladder[i].at) { next = rf.ladder[i]; break; } }
      rh += '<div class="pts-link"><code id="ptsLink">' + esc(link) + '</code><button class="btn btn-sm" type="button" data-pts="copy">Copy link</button></div>' +
        '<div class="pts-kv"><span>Referred</span><b>' + w.kids.length + '</b></div>' +
        '<div class="pts-kv"><span>Active traders</span><b>' + w.act + '</b></div>' +
        '<div class="pts-kv"><span>Earned from referrals</span><b>' + fmt((w.b.refShare || 0) + (w.b.refBonus || 0) + (w.b.refLadder || 0) + (w.b.refFees || 0)) + '</b></div>' +
        '<div class="pts-kv"><span>You get</span><b>' + (rf.shareBps / 100) + '% of what they earn</b></div>' +
        (next ? '<div class="pts-kv"><span>Next step</span><b>' + fmt(next.pts) + ' at ' + next.at + ' active</b></div>' : '<div class="pts-kv"><span>Ladder</span><b>complete</b></div>');
      if (w.by) rh += '<div class="pts-kv"><span>Referred by</span><b>' + esc(short(w.by)) + '</b></div>';
    } else {
      rh += '<div class="pts-empty">Register a code and your link is ready. You earn ' + (rf.shareBps / 100) + '% of everything your referees earn, and ' + fmt(rf.firstTrade) + ' each time one makes a first trade.</div>' +
        '<button class="btn btn-sm" type="button" data-pts="refer"' + ($('tabRefer') ? '' : ' hidden') + '>Get a code</button>';
      if (w && w.by) rh += '<div class="pts-kv"><span>Referred by</span><b>' + esc(short(w.by)) + '</b></div>';
    }
    rh += '<h3 class="pts-h-rules">Rules</h3><ul class="pts-rules">' + rulesList() + '</ul>';
    bcol.innerHTML = rh;

    // column C: leaderboard
    var rows = board(), top = rows.slice(0, 50);
    var lh = '<h3>Leaderboard <i>' + fmt(rows.length) + ' wallet' + (rows.length === 1 ? '' : 's') + ' · ' + fmt(networkTotal()) + ' points</i></h3><ol class="pts-board">';
    top.forEach(function (r, idx) {
      var you = S.view && r.a === S.view;
      lh += '<li' + (you ? ' class="is-you"' : '') + '><span class="pts-rk">' + (idx + 1) + '</span><span class="pts-ad">' + (you ? 'You' : esc(short(r.a))) + (r.act > 0 ? '<em>' + r.act + ' referred</em>' : '') + '</span><span class="pts-pt">' + fmt(r.t) + '</span></li>';
    });
    if (!top.length) lh += '<li><span class="pts-ad">No one yet.</span></li>';
    lh += '</ol>';
    if (S.view && rk.rk > 50) {
      lh += '<div class="pts-you"><span class="pts-rk">' + rk.rk + '</span><span class="pts-ad">You</span><span class="pts-pt">' + fmt(totalFor(w)) + '</span></div>';
    }
    $('ptsColC').innerHTML = lh;
    S.panelRank = rk;
  }

  /* ---- ticking --------------------------------------------------------------------------- */

  function setNum(el, v) { if (el) el.textContent = fmt(v); }

  function tick() {
    if (!S.eng) return;
    var w = myW();
    var target = totalFor(w);
    S.target = target;
    // ease the shown number toward the target
    if (reduced() || Math.abs(target - S.shown) < 0.5) S.shown = target;
    else S.shown += (target - S.shown) * 0.22;
    var val = $('ptsPillVal');
    if (val) {
      if (!S.view) { val.textContent = 'Earn'; }
      else val.textContent = fmt(S.shown);
    }
    var pill = $('ptsPill');
    if (pill) pill.classList.toggle('is-idle', !S.view);
    if (S.panelOn) {
      var big = $('ptsBig');
      if (big) big.textContent = S.view ? fmt(S.shown) : fmt(networkTotal());
      var sub = $('ptsSub');
      if (sub) {
        if (!S.view) sub.textContent = 'earned by everyone so far';
        else {
          var ph = perHour(w);
          var rk = S.panelRank || { rk: 0, of: 0 };
          sub.innerHTML = '<span>' + fmt(ph) + ' per hour <i>24 h average</i></span>' +
            (rk.rk ? '<span>rank ' + rk.rk + ' of ' + fmt(rk.of) + '</span>' : '') +
            (w && w.stk[0] > 0 ? '<span class="pts-live"><i class="pts-dot"></i>earning now</span>' : '');
        }
      }
      var rate = $('ptsStkRate');
      if (rate && w) rate.textContent = fmt(w.stk[0] / 1000 * S.rules.staking.perThousandConfettiPerDay) + ' a day';
      if (w && w.stk[0] > 0) {
        var sv = document.querySelector('.pts-bv[data-src="staking"]');
        if (sv) sv.textContent = fmt((w.b.staking || 0) + pendingStake(w));
      }
      var meta = $('ptsMeta');
      if (meta && S.err) meta.textContent = 'rules v' + S.rules.version + ' · reconnecting';
    }
    if (S.dirty) { S.dirty = false; if (S.panelOn) renderPanel(); }
  }

  /* ---- boot ------------------------------------------------------------------------------ */

  function forcedAddress() {
    try {
      var a = new URLSearchParams(location.search).get('addr');
      if (a && ADDR_RE.test(a.trim())) return a.trim().toLowerCase();
    } catch (e) { /* ignore */ }
    return '';
  }

  function boot() {
    S.forced = forcedAddress();
    mountPill();
    S.panelOn = !!$('pointsPanel');
    if (S.panelOn) mountPanel();
    listen();
    Promise.all([getJson('config.json'), getJson('points-rules.json?t=' + Math.floor(Date.now() / 60000))]).then(function (r) {
      S.cfg = r[0]; S.rules = r[1];
      S.chunk = Math.min(1000, S.cfg.logChunkBlocks || 1000);
      return loadSnapshot(true);
    }).then(function () {
      pollAccount(); watchWallet();
      applyView();
      followOnce();
      setInterval(followOnce, POLL_MS);
      setInterval(function () { loadSnapshot(false).then(function () { return null; }).catch(function () { /* keep the current one */ }); }, SNAP_EVERY_MS);
      setInterval(function () { pollAccount(); watchWallet(); }, 3000);
      setInterval(tick, 250);
      setInterval(function () { S.dirty = true; }, 15000);
      tick();
    }).catch(function (e) {
      var v = $('ptsPillVal'); if (v) v.textContent = '—';
      var m = $('ptsMeta'); if (m) m.textContent = 'points unavailable · retrying';
      setTimeout(boot, 15000);
      void e;
    });
  }

  root.confettiPoints = {
    setAddress: function (a) { S.forced = a && ADDR_RE.test(a) ? a.toLowerCase() : ''; applyView(); },
    state: function () { return S; },
    /* test hook: apply a synthetic event to the live engine and announce it */
    inject: function (ev) { var out = S.eng.apply(ev); onAwards(out, ev); S.dirty = true; return out; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : this);
