/* confetti points: the rules engine (mirrors ops/points/indexer.py) and the live HUD.
 *
 * points.json is the indexer's snapshot (authoritative totals and the engine state of every wallet at
 * block B). This file follows the chain from B itself (same RPCs as config.json), applies
 * points-rules.json to each new event, and so ticks within seconds; the next snapshot replaces it.
 * Transfers (rules v2): the PointsRelay emits PointsTransfer(from, to, amount); the engine applies it in block order
 * (valid only if the sender's balance covers it and neither wallet is a house bot). The Send panel in the header pill
 * calls relay.transfer through the connected wallet; everything else here is read-only (eth_accounts, eth_blockNumber,
 * eth_getLogs, eth_getBlockByNumber).
 */
(function (root) {
  'use strict';

  var DAY = 86400;
  var ZERO = '0x0000000000000000000000000000000000000000';
  var NOSHARE = { refShare: 1, refBonus: 1, refLadder: 1, refFees: 1, referred: 1 };
  var EPS = 1e-9;           // a balance within this of the amount covers it (the page shows floor(n + 1e-9))
  var MAX_REJECTED = 1000;

  /* what a wallet can spend or show: earned - sent + received */
  function balance(w) { return w.t - (w.sn || 0) + (w.rc || 0); }

  /* HOLDERS (mirrors ops/points/indexer.py holder_x / age_x): boosted points are multiplied by a convex curve of the
     staked FETTI (log-interpolated between rules.holder.curve points) times the time held (+ageWeeklyBps a week, up to
     ageMaxX; stake-weighted, so a top-up keeps it and an unstake restarts it). No rules.holder: 1. */
  function holderX(r, stake) {
    var h = r.holder;
    if (!h || !(stake > 0)) return 1;
    var p = h.curve;
    if (stake <= p[0][0]) return p[0][1];
    if (stake >= p[p.length - 1][0]) return p[p.length - 1][1];
    for (var i = 0; i < p.length - 1; i++) {
      var s0 = p[i][0], x0 = p[i][1], s1 = p[i + 1][0], x1 = p[i + 1][1];
      if (stake <= s1) return x0 + (x1 - x0) * (Math.log(stake) - Math.log(s0)) / (Math.log(s1) - Math.log(s0));
    }
    return p[p.length - 1][1];
  }
  function ageX(r, age) {
    var h = r.holder;
    if (!h || !(age > 0)) return 1;
    return Math.min(h.ageMaxX, 1 + h.ageWeeklyBps / 10000 * age / (7 * DAY));
  }

  /* ================================================================ engine */

  function newWallet() {
    return { t: 0, b: {}, hr: {}, d: -1, sk: 0, bk: 0, sm: [], vol: 0, vm: 0, mk: [], net: 0, wm: 0, fn: 0,
      op: {}, cp: {}, stk: [0, 0], sa: 0, by: '', kids: [], act: 0, ld: 0, code: '', rf: 0, rp: 0, sn: 0, rc: 0 };
  }

  /* house: an array of lowercase addresses or an {address: 1} map; rejected: the snapshot's list (or none) */
  function Engine(rules, wallets, house, rejected, vaults) {
    this.r = rules;
    this.W = wallets || {};
    /* code vault -> owner (CodeVaultFactory): a vault is the referrer on chain, its owner gets the points */
    this.vo = vaults || {};
    this.house = {};
    var self = this;
    if (Array.isArray(house)) house.forEach(function (a) { self.house[String(a).toLowerCase()] = 1; });
    else if (house) this.house = house;
    this.rej = rejected || [];
    this.lastWhy = '';
  }

  Engine.prototype.w = function (a) {
    var x = this.W[a];
    if (!x) { x = newWallet(); this.W[a] = x; }
    return x;
  };

  /* the holder multiplier at time t (house bots: 1); with t0, the age part averaged over [t0, t] */
  /* the wallet a referral address stands for: a code vault's owner, else the address itself */
  Engine.prototype.owner = function (a) {
    return Object.prototype.hasOwnProperty.call(this.vo, a) ? this.vo[a] : a;
  };

  Engine.prototype.mult = function (a, t, t0) {
    var w = this.w(a), s = w.stk[0];
    if (!(s > 0) || this.house[a] || !this.r.holder) return 1;
    var ax = ageX(this.r, t - (w.sa || 0));
    if (t0 !== undefined) ax = (ageX(this.r, t0 - (w.sa || 0)) + ax) / 2;
    return holderX(this.r, s) * ax;
  };

  Engine.prototype.award = function (a, src, pts, t, out, share, mult) {
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
    var hd = this.r.holder;
    if (hd && hd.boosted.indexOf(src) >= 0) pts *= (mult !== undefined ? mult : this.mult(a, t));
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
      this.award(a, 'staking', pts, t, out, true, this.mult(a, t, s[1]));
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

  /* A PointsTransfer from the relay. Valid: a whole amount >= 1, two different non-house wallets, and the sender's
     balance at this point (staking accrued to this block's time) covers it. Returns '' or the rejection reason. */
  Engine.prototype.transfer = function (ev, out) {
    var a = ev.a, to = ev.to, amt = ev.v, t = ev.t;
    var min = Math.max(1, Math.floor((this.r.transfer && this.r.transfer.min) || 1));
    var why = '';
    if (!(typeof amt === 'number' && isFinite(amt) && amt === Math.floor(amt)) || amt < min) why = 'amount';
    else if (a === to || to === ZERO) why = 'recipient';
    else if (this.house[a] || this.house[to]) why = 'house';
    else {
      this.accrue(a, t, out);
      if (balance(this.w(a)) + EPS < amt) why = 'balance';
    }
    if (why) {
      this.rej.push({ hash: ev.tx || '', reason: why, from: a, to: to, amount: amt, block: ev.b });
      if (this.rej.length > MAX_REJECTED) this.rej.splice(0, this.rej.length - MAX_REJECTED);
      return why;
    }
    var s = this.w(a), r = this.w(to);
    s.sn = (s.sn || 0) + amt;
    r.rc = (r.rc || 0) + amt;
    out.push([to, 'transfer', amt]);
    return '';
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
      var vault = Object.prototype.hasOwnProperty.call(this.vo, a);
      a = this.owner(a);   /* a vault's code is one more code of its owner's: the code points come once */
      w = this.w(a);
      if (!w.code) {
        w.code = ev.c;
        this.award(a, 'code', r.code.flat, t, out);
      } else if (!vault) {   /* an extra code never replaces the link the owner already shows */
        w.code = ev.c;
      }
    } else if (k === 'refset') {
      w = this.w(a);
      var by = this.owner(ev.r);   /* through a vault of one's own it is a self-referral: no referrer */
      if (!w.by && ev.r !== ZERO && by !== a) {
        w.by = by;
        this.w(by).kids.push(a);
        if (w.fn) this.fundedReferral(a, t, out);
      }
    } else if (k === 'paid') {
      a = this.owner(a);
      if (a === this.owner(ev.tr) || a === ev.tr) return out;   /* a vault paying its owner's own fees back */
      this.w(a).rf += ev.v;
      this.award(a, 'refFees', ev.v * r.referral.feePerUsdc, t, out, false);
    } else if (k === 'vault') {
      this.vo[ev.v] = a;
    } else if (k === 'stake') {
      this.accrue(a, t, out);
      var ws = this.w(a), st = ws.stk;
      /* the age is stake-weighted: a top-up keeps it, a fresh stake starts now */
      ws.sa = st[0] <= 0 ? t : ((ws.sa === undefined ? t : ws.sa) * st[0] + t * ev.v) / (st[0] + ev.v);
      st[0] += ev.v;
    } else if (k === 'unstake') {
      this.accrue(a, t, out);
      var wu = this.w(a), s = wu.stk;
      s[0] = Math.max(0, s[0] - ev.v);
      wu.sa = s[0] > 0 ? t : 0;
    } else if (k === 'xfer') {
      this.lastWhy = this.transfer(ev, out);
    }
    return out;
  };

  var api = { Engine: Engine, newWallet: newWallet, balance: balance };
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
    /* v4 Exchange: PositionOpened / Closed gain keeperFill (Closed's confettiMinted became borrowUsdc),
       PositionLiquidated drops confettiMinted; the words read below keep their offsets */
    '0xe3198cf2a81ef680e264c567b19609c810aeead02f89fce56620453ae4c62b9a': 'open',
    '0xf21c97f1434e8d81efa2f3955bb54d0d18472c1eaf6eb644a1a44f82d7ae9302': 'close',
    '0x04f15ca23238701937eb24acb2db7745e8d9f6d4bf40bfecdee7f25883542f37': 'liq',
    '0xd07860d38e071bfab5c5f262789fd0c4e15fe7dad8e287f47ff0e962d71092a4': 'code',
    '0x0a721ab4682ceb61c7e4d264ef879fc419a6d764b136e7d96ef54b2053c75673': 'paid',
    '0x5f7165288eef601591cf549e15ff19ef9060b7f71b9c115be946fa1fe7ebf68a': 'refset',
    '0x9e71bc8eea02a63969f509818f2dafb9254532904319f9dbda79b67bd34a5f3d': 'stake',
    '0x0f5bb82176feb1b5e747e28471aa92156a04d9f3ab9f45f28e2d704232b93f75': 'unstake',
    '0x7854bf0fa996684a07445d1f0eef8519c916412e98160206439c9c82fa566a69': 'xfer',
    /* CodeVaultFactory.VaultCreated(address indexed owner, address indexed vault, string code) */
    '0x3585389649c4946deb9f3d591291e9a7058addcb51d91b4cad87e5810fd8909b': 'vault'
  };
  var TOPIC_LIST = Object.keys(TOPICS);
  /* position ids per generation, as ops/points/indexer.py keeps them: v4 "4:<id>", v3 the plain number */
  var V4_TOPICS = {
    '0xe3198cf2a81ef680e264c567b19609c810aeead02f89fce56620453ae4c62b9a': 1,
    '0xf21c97f1434e8d81efa2f3955bb54d0d18472c1eaf6eb644a1a44f82d7ae9302': 1,
    '0x04f15ca23238701937eb24acb2db7745e8d9f6d4bf40bfecdee7f25883542f37': 1
  };
  var ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  var SNAP_EVERY_MS = 120000;
  var POLL_MS = 2500;
  var BASE_URL = 'https://confetti.trade/?ref=';

  var CHAIN_HEX = '0x3e7';
  var TRANSFER_SELECTOR = '0xfa537391';   // PointsRelay.sendPoints(address,uint256)
  var S = {
    relay: '', house: {}, sendBusy: false, todayShown: undefined,
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
  function pidOf(lg) { return V4_TOPICS[lg.topics[0]] ? '4:' + tint(lg.topics[1]) : tint(lg.topics[1]); }
  function usd(b) { return Number(b) / 1e6; }

  function decodeLog(lg) {
    var k = TOPICS[lg.topics[0]];
    if (!k) return null;
    var d = lg.data;
    var ev = { k: k, b: parseInt(lg.blockNumber, 16), i: parseInt(lg.logIndex, 16) };
    if (k === 'dep') { ev.a = taddr(lg.topics[1]); ev.v = usd(word(d, 0)); }
    else if (k === 'wd') { ev.a = taddr(lg.topics[1]); ev.v = usd(word(d, 0)); }
    else if (k === 'open') { ev.id = pidOf(lg); ev.a = taddr(lg.topics[2]); ev.x = tint(lg.topics[3]); ev.m = usd(word(d, 1)); ev.l = Number(word(d, 2)); }
    else if (k === 'close') { ev.id = pidOf(lg); ev.a = taddr(lg.topics[2]); ev.p = Number(sword(d, 1)) / 1e6; ev.f = usd(word(d, 2)); }
    else if (k === 'liq') { ev.id = pidOf(lg); ev.a = taddr(lg.topics[2]); ev.r = taddr(lg.topics[3]); ev.m = usd(word(d, 1)); }
    else if (k === 'code') {
      ev.a = taddr(lg.topics[1]);
      var len = Number(word(d, 1));
      var hex = d.slice(2 + 128, 2 + 128 + len * 2);
      var s = '';
      for (var j = 0; j < hex.length; j += 2) s += String.fromCharCode(parseInt(hex.slice(j, j + 2), 16));
      ev.c = s;
    }
    else if (k === 'paid') { ev.a = taddr(lg.topics[1]); ev.tr = taddr(lg.topics[2]); ev.v = usd(word(d, 0)); }
    else if (k === 'vault') { ev.a = taddr(lg.topics[1]); ev.v = taddr(lg.topics[2]); }
    else if (k === 'refset') { ev.a = taddr(lg.topics[1]); ev.r = taddr(lg.topics[2]); }
    else if (k === 'stake' || k === 'unstake') { ev.a = taddr(lg.topics[1]); ev.v = Number(word(d, 0)) / 1e18; }
    else if (k === 'xfer') {
      if (!S.relay || String(lg.address || '').toLowerCase() !== S.relay) return null;   // only the configured relay counts
      ev.a = taddr(lg.topics[1]); ev.to = taddr(lg.topics[2]); ev.v = Number(word(d, 0)); ev.tx = lg.transactionHash || '';
    }
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
    /* a v4 config also names the v3 contracts (v3Exchange / v3Referrals / v3Staking): they are followed too */
    var addrs = [c.exchange, c.referrals, c.staking, c.v3Exchange, c.v3Referrals, c.v3Staking, c.codeVaultFactory]
      .filter(function (x) { return ADDR_RE.test(String(x || '')) && !/^0x0{40}$/.test(x); })
      .map(function (x) { return x.toLowerCase(); });
    if (S.relay) addrs.push(S.relay);
    if (!addrs.length) return Promise.resolve([]);
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
      S.eng = new Engine(S.rules, snap.wallets, S.house, snap.rejected, snap.vaults);
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
        evs.forEach(function (e) { if (e.k === 'vault') S.eng.vo[e.v] = e.a; });
        evs.forEach(function (e) {
          e.t = S.ts[e.b];
          var awards = S.eng.apply(e);
          if (announce) { onAwards(awards, e); if (e.k === 'xfer') onTransfer(e, S.eng.lastWhy); }
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
    pillDelta(sum);
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

  var WHY = {
    balance: 'balance did not cover it',
    house: 'house wallets cannot send or receive',
    amount: 'whole points, 1 or more',
    recipient: 'bad recipient'
  };

  function onTransfer(ev, why) {
    if (!S.view || ev.a !== S.view) return;   // the receiver's toast is the 'Received' award
    if (why) toast('Transfer rejected', WHY[why] || why);
    else toast('-' + fmt(ev.v) + ' points', 'sent to ' + short(ev.to));
    renderSend();
  }

  function updateDelta() {
    var els = [$('ptsDeltaBig')];
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
    var now = chainNow(), dt = now - w.stk[1];
    return dt > 0 ? w.stk[0] / 1000 * S.rules.staking.perThousandConfettiPerDay * dt / DAY * liveMult(w, now, w.stk[1]) : 0;
  }

  /* a snapshot wallet's holder multiplier now (house bots carry house: 1) */
  function liveMult(w, t, t0) {
    if (!w || w.house || !(w.stk[0] > 0) || !S.rules.holder) return 1;
    var ax = ageX(S.rules, t - (w.sa || 0));
    if (t0 !== undefined) ax = (ageX(S.rules, t0 - (w.sa || 0)) + ax) / 2;
    return holderX(S.rules, w.stk[0]) * ax;
  }

  function totalFor(w) { return w ? balance(w) + pendingStake(w) : 0; }

  /* earned since 00:00 UTC (the day the daily caps run on), from the hourly buckets plus staking accrued since */
  function todayOf(w) {
    if (!w) return 0;
    var now = chainNow(), day0 = Math.floor(now / DAY) * DAY, h0 = day0 / 3600, s = 0;
    for (var h in w.hr) { if (parseInt(h, 10) >= h0) s += w.hr[h]; }
    if (w.stk[0] > 0) {
      var from = Math.max(w.stk[1], day0);
      if (now > from) s += w.stk[0] / 1000 * S.rules.staking.perThousandConfettiPerDay * (now - from) / DAY * liveMult(w, now, from);
    }
    return s;
  }

  function isHouse(a) { return !!(S.house[a] || (S.snap && S.snap.wallets[a] && S.snap.wallets[a].house)); }

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
    var house = isHouse(a);
    var rk = 0, n = 0;
    var mine = W[a] ? balance(W[a]) : 0;
    for (var k in W) {
      var x = W[k], bx = balance(x);
      if (bx <= 1e-6 || isHouse(k)) continue;
      n += 1;
      if (bx > mine || (bx === mine && k < a)) rk += 1;
    }
    return { rk: house || mine <= 1e-6 ? 0 : rk + 1, of: n };
  }

  function board() {
    var W = S.eng.W, rows = [];
    for (var k in W) {
      var x = W[k], bx = balance(x);
      if (bx <= 1e-6 || isHouse(k)) continue;
      rows.push({ a: k, t: bx, earned: x.t, kids: x.kids.length, act: x.act });
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
        if (ev && ev.detail && ev.detail.provider) { S.providers.push(ev.detail.provider); (S.details = S.details || []).push(ev.detail); }
      });
      window.dispatchEvent(new Event('eip6963:requestProvider'));
    } catch (e) { /* ignore */ }
  }

  function injected() {
    /* the wallet picked on the trade or tab pages (localStorage confetti.wallet = its EIP-6963 rdns) wins */
    var pref = ''; try { pref = localStorage.getItem('confetti.wallet') || ''; } catch (e) { pref = ''; }
    if (pref && S.details) {
      var hit = S.details.filter(function (d) { return d.info && d.info.rdns === pref; })[0];
      if (hit) return hit.provider;
    }
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
    if ($('ptsPill')) return;   // boot retries after a failed load: never a second bar
    /* The points bar: full width, green, bold, the first thing on every page. Never floats over content. */
    var bar = document.createElement('a');
    bar.className = 'pts-pill pts-bar';
    bar.id = 'ptsPill';
    bar.href = $('pointsPanel') ? '#pointsPanel' : 'trade.html#pointsPanel';
    bar.setAttribute('aria-label', 'Points');
    bar.innerHTML = '<span class="pts-bar-label">Points</span>' +
      '<span class="pts-pill-val" id="ptsPillVal">\u2014</span>' +
      '<span class="pts-pill-delta" id="ptsPillDelta" aria-live="polite"></span>' +
      '<span class="pts-bar-note">Every trade, deposit and referral earns. Referrals pay the most.</span>' +
      '<span class="pts-bar-cta">[ Earn ]</span>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.documentElement.classList.add('has-pts-bar');
    var send = document.createElement('button');
    send.type = 'button';
    send.id = 'ptsSendBtn';
    send.className = 'pts-bar-send';
    send.textContent = '[ Send ]';
    send.hidden = true;                         // shown once a relay address is configured
    send.setAttribute('aria-haspopup', 'dialog');
    send.setAttribute('aria-expanded', 'false');
    bar.appendChild(send);
    send.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggleSend(); });
    bar.addEventListener('click', function (e) {
      var p = $('pointsPanel');
      if (p) { e.preventDefault(); p.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); }
    });
    mountHeaderPill(bar.href);
  }

  /* Phones (<= 640 px): a page whose compact header carries the points pill (#phPts) hides the bar
     there (points.css, under html.has-ph-pts); the pill opens the points panel as the bar does. */
  function mountHeaderPill(href) {
    var pill = $('phPts');
    if (!pill) return;
    document.documentElement.classList.add('has-ph-pts');
    pill.href = href;
    pill.addEventListener('click', function (e) {
      var p = $('pointsPanel');
      if (p) { e.preventDefault(); p.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); }
    });
    /* Send, when a relay is set, lives in the Account sheet on a phone */
    var ps = document.querySelector('.js-ph-send');
    if (ps) ps.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var d = ps.closest ? ps.closest('dialog') : null;
      if (d && d.open) d.close();
      setTimeout(openSend, 0);
    });
  }

  /* "12,340"; from 100,000 "634K", from a million "1.2M": the pill fits a 360 px header */
  function fmtPill(n) {
    n = Math.floor(n + 1e-9);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e5) return Math.floor(n / 1e3) + 'K';
    return fmt(n);
  }

  /* New points: "+150" beside the number for 2 s, then it fades (160 ms) */
  function pillDelta(sum) {
    var el = $('phPtsDelta');
    if (!el || sum < 1) return;
    el.textContent = '+' + fmtPill(sum);
    el.classList.add('is-on');
    clearTimeout(S.pillTimer);
    S.pillTimer = setTimeout(function () {
      el.classList.remove('is-on');
      S.pillTimer = setTimeout(function () { el.textContent = ''; }, reduced() ? 0 : 180);
    }, 2000);
  }

  /* ---- send: relay.transfer through the connected wallet ----------------------------------------- */

  function relayOf() {
    var r = (S.rules && S.rules.relay) || (S.cfg && S.cfg.pointsRelay) || '';
    return ADDR_RE.test(String(r).trim()) ? String(r).trim().toLowerCase() : '';
  }

  function houseOf(cfg) {
    var m = {};
    (function walk(v) {
      if (typeof v === 'string') { if (ADDR_RE.test(v.trim())) m[v.trim().toLowerCase()] = 1; }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); });
    })(cfg && cfg.houseBots);
    return m;
  }

  function configureSend() {
    var btn = $('ptsSendBtn'), bar = $('ptsPill');
    if (btn) btn.hidden = !S.relay;
    if (bar) bar.classList.toggle('has-send', !!S.relay);
    var ps = document.querySelector('.js-ph-send');
    if (ps) ps.hidden = !S.relay;
    if (!S.relay) closeSend();
  }

  function pad32(hex) { return ('0000000000000000000000000000000000000000000000000000000000000000' + hex).slice(-64); }
  function transferData(to, amount) { return TRANSFER_SELECTOR + pad32(to.slice(2).toLowerCase()) + pad32(BigInt(amount).toString(16)); }

  function sendPanel() {
    var p = $('ptsSend');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'ptsSend';
    p.className = 'pts-send';
    p.hidden = true;
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Send points');
    p.innerHTML =
      '<div class="pts-send-head"><b>Send points</b><button type="button" class="pts-send-x" id="ptsSendX" aria-label="Close">\u00d7</button></div>' +
      '<label class="pts-send-f"><span>To</span><input class="input" id="ptsTo" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="0x\u2026"></label>' +
      '<label class="pts-send-f"><span>Amount</span><span class="pts-send-amt"><input class="input" id="ptsAmt" type="text" inputmode="numeric" autocomplete="off" placeholder="0"><button type="button" class="btn btn-sm" id="ptsMax">Max</button></span></label>' +
      '<div class="pts-send-note" id="ptsSendNote"></div>' +
      '<button type="button" class="btn btn-long btn-block" id="ptsSendGo">Send</button>' +
      '<div class="pts-send-out" id="ptsSendOut" aria-live="polite"></div>';
    document.body.appendChild(p);
    $('ptsSendX').addEventListener('click', closeSend);
    $('ptsMax').addEventListener('click', function () {
      var w = myW();
      $('ptsAmt').value = String(Math.max(0, Math.floor(totalFor(w) + 1e-9)));
    });
    $('ptsSendGo').addEventListener('click', doSend);
    p.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); doSend(); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSend(); });
    document.addEventListener('click', function (e) {
      var panel = $('ptsSend');
      if (!panel || panel.hidden) return;
      var t = e.target;
      if (panel.contains(t) || (t.closest && t.closest('#ptsSendBtn'))) return;
      closeSend();
    });
    return p;
  }

  function placeSend() {
    var p = $('ptsSend'), bar = $('ptsPill');
    if (!p || !bar) return;
    var hp = $('phPts');
    if (hp && hp.offsetParent && !bar.offsetParent) { p.style.top = ''; return; }   // phones: under the header (points.css)
    p.style.top = Math.round(bar.getBoundingClientRect().bottom + 6) + 'px';
  }

  function toggleSend() {
    var p = sendPanel();
    if (p.hidden) openSend(); else closeSend();
  }

  function openSend() {
    var p = sendPanel();
    p.hidden = false;
    placeSend();
    var b = $('ptsSendBtn'); if (b) b.setAttribute('aria-expanded', 'true');
    renderSend();
    var to = $('ptsTo'); if (to && !to.value) to.focus();
  }

  function closeSend() {
    var p = $('ptsSend');
    if (p) p.hidden = true;
    var b = $('ptsSendBtn'); if (b) b.setAttribute('aria-expanded', 'false');
  }

  function sendOut(html, kind) {
    var o = $('ptsSendOut');
    if (!o) return;
    o.className = 'pts-send-out' + (kind ? ' is-' + kind : '');
    o.innerHTML = html;
  }

  /* what the sender can spend, and their rejected transfers (so a refused one is explained, not silent) */
  function renderSend() {
    var n = $('ptsSendNote');
    if (!n || !S.eng) return;
    var w = myW(), html;
    if (!S.view) html = 'Connect a wallet to send. Whole points only; the balance must cover it.';
    else {
      html = 'You have <b>' + fmt(totalFor(w)) + '</b> points. Whole points only.';
      var mine = (S.eng.rej || []).filter(function (r) { return r.from === S.view; }).slice(-2);
      mine.forEach(function (r) { html += '<br><span class="pts-send-rej">Rejected: ' + fmt(r.amount) + ' to ' + esc(short(r.to)) + ' (' + esc(WHY[r.reason] || r.reason) + ')</span>'; });
    }
    n.innerHTML = html;
    placeSend();
  }

  function isRevert(e) { return e && (e.code === 3 || /revert/i.test(String(e.message || ''))); }

  function switchChainStandalone(eth) {
    var c = S.cfg || {};
    return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] }).catch(function (err) {
      var code = err && (err.code != null ? err.code : (err.data && err.data.originalError && err.data.originalError.code));
      var msg = String((err && err.message) || '');
      if (!(code === 4902 || code === -32603 || /4902|unrecognized|not added|unknown chain/i.test(msg))) throw err;
      return eth.request({ method: 'wallet_addEthereumChain', params: [{
        chainId: CHAIN_HEX, chainName: c.chainName || 'HyperEVM', rpcUrls: ['https://rpc.hyperliquid.xyz/evm'], /* the official RPC in the wallet prompt */
        nativeCurrency: c.nativeCurrency || { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
        blockExplorerUrls: c.explorerUrl ? [c.explorerUrl] : [] }] });
    }).then(function () { return eth.request({ method: 'eth_chainId' }); }).then(function (hex) {
      if (parseInt(hex, 16) !== 999) throw new Error('Switch the wallet to HyperEVM (999) first.');
    });
  }

  /* On the trade page this goes through trade.js's own wallet (window.ConfettiWallet: the same connect, chain switch and
     provider as the header Connect button); on the other pages it talks to the injected wallet directly. */
  function walletFlow() {
    var W = window.ConfettiWallet;
    if (W) {
      return Promise.resolve(W.account() ? null : W.connect()).then(function () {
        if (!W.account()) throw new Error('Connect a wallet first.');
        return W.ensureChain();
      }).then(function () { return { request: function (r) { return W.request(r); }, from: W.account() }; });
    }
    var eth = injected();
    if (!eth || typeof eth.request !== 'function') return Promise.reject(new Error('No wallet found. Open this page in a wallet browser or install a wallet extension.'));
    var from;
    return eth.request({ method: 'eth_requestAccounts' }).then(function (acc) {
      if (!acc || !acc[0]) throw new Error('No account returned by the wallet.');
      from = acc[0];
      return eth.request({ method: 'eth_chainId' });
    }).then(function (hex) {
      if (parseInt(hex, 16) !== 999) return switchChainStandalone(eth);
    }).then(function () { return { request: function (r) { return eth.request(r); }, from: from }; });
  }

  function errText(e) {
    if (e && (e.code === 4001 || /user (rejected|denied)/i.test(String(e.message || '')))) return 'Cancelled in the wallet.';
    var m = String((e && (e.shortMessage || e.message)) || e || 'Failed.').replace(/^execution reverted:?\s*/i, "That didn't go through: ");
    return m.length > 180 ? m.slice(0, 180) + '\u2026' : m;
  }

  function doSend() {
    if (S.sendBusy) return;
    if (!S.relay) { sendOut('Transfers are not open yet.', 'err'); return; }
    var to = String($('ptsTo').value || '').trim().toLowerCase();
    var raw = String($('ptsAmt').value || '').replace(/[,\s]/g, '');
    if (!ADDR_RE.test(to)) { sendOut('Enter the recipient as a 0x address.', 'err'); return; }
    if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) { sendOut('Whole points only, 1 or more.', 'err'); return; }
    if (Number(raw) > Number.MAX_SAFE_INTEGER) { sendOut('That amount is too large.', 'err'); return; }
    var amount = Number(raw);
    if (S.house[to]) { sendOut('House wallets cannot receive points.', 'err'); return; }
    S.sendBusy = true;
    var go = $('ptsSendGo'); if (go) go.disabled = true;
    sendOut('Confirm in your wallet\u2026', 'wait');
    var wf;
    walletFlow().then(function (w) {
      wf = w;
      var from = String(w.from).toLowerCase();
      setMe(from);
      if (from === to) throw new Error('Send to another address.');
      if (S.house[from]) throw new Error('House wallets cannot send points.');
      var have = Math.floor(totalFor(S.eng ? S.eng.W[from] : null) + 1e-9);
      if (amount > have) throw new Error('You have ' + fmt(have) + ' points.');
      var data = transferData(to, amount);
      return w.request({ method: 'eth_call', params: [{ from: w.from, to: S.relay, data: data }, 'latest'] }).then(null, function (e) {
        if (isRevert(e)) throw new Error("That didn't go through: the transfer was refused.");
        return null;   // a wallet that cannot eth_call: let the send itself decide
      }).then(function () {
        return w.request({ method: 'eth_sendTransaction', params: [{ from: w.from, to: S.relay, data: data }] });
      });
    }).then(function (hash) {
      var base = (S.cfg && S.cfg.explorerUrl) || 'https://hyperevmscan.io';
      sendOut('Sent <a href="' + esc(base + '/tx/' + hash) + '" target="_blank" rel="noopener">' + esc(String(hash).slice(0, 10) + '\u2026' + String(hash).slice(-6)) + '</a>. Balance updates within 5 minutes.', 'ok');
      $('ptsAmt').value = '';
    }).catch(function (e) {
      sendOut(esc(errText(e)), 'err');
    }).then(function () {
      S.sendBusy = false;
      var g = $('ptsSendGo'); if (g) g.disabled = false;
      renderSend();
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
      ['Stake', f(r.staking.perThousandConfettiPerDay) + ' per 1,000 FETTI a day'],
    ].concat(r.holder ? [
      ['Holders', 'staked FETTI multiplies your points: ' + r.holder.curve.filter(function (p) { return p[1] > 1; }).map(function (p) { return '×' + p[1] + ' at ' + f(p[0]); }).join(', ') +
        ', smoothly between; plus ' + (r.holder.ageWeeklyBps / 100) + '% a week held, up to ×' + r.holder.ageMaxX + '. Unstaking restarts the clock.']
    ] : []).concat([
      ['Each day', f(r.daily.flat) + ' plus ' + f(r.streak.perDay) + ' per streak day (to ' + r.streak.maxDays + '); streak bonuses at ' + r.streak.milestones.map(function (x) { return x.at; }).join(', ')],
      ['New market', f(r.firstMarket.flat) + ' for the first trade in each'],
      ['Volume', r.volume.milestones.map(function (x) { return f(x.pts) + ' at $' + f(x.at); }).join(', ')]
    ]);
    if (S.relay) rows.push(['Transfers', 'Send whole points to any wallet with Send in the bar. The balance must cover it. Referral shares and daily caps count earned points only. House wallets cannot send or receive.']);
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
      if (!srcs.length) html += '<div class="pts-empty">No points yet. Deposit, open a position or stake FETTI and they start.</div>';
      html += '<ul class="pts-bars">' + srcs.map(function (s) {
        var v = b[s] + (s === 'staking' ? pend : 0);
        var top = s.indexOf('ref') === 0;
        return '<li' + (top ? ' class="is-ref"' : '') + '><span class="pts-bl">' + esc(S.rules.sources[s] || s) + '</span><span class="pts-bv" data-src="' + s + '">' + fmt(v) + '</span><span class="pts-bb"><i style="width:' + Math.max(2, Math.round(100 * v / Math.max(mx, 1))) + '%"></i></span></li>';
      }).join('') + '</ul>';
      var sk = w ? w.sk : 0;
      var alive = w && w.d >= Math.floor(chainNow() / DAY) - 1;
      html += '<div class="pts-kv"><span>Streak</span><b>' + (alive ? sk : 0) + ' day' + ((alive ? sk : 0) === 1 ? '' : 's') + '</b></div>' +
        '<div class="pts-kv"><span>Best streak</span><b>' + (w ? w.bk : 0) + '</b></div>';
      if (w && ((w.rc || 0) > 0 || (w.sn || 0) > 0)) {
        html += '<div class="pts-kv"><span>Earned</span><b>' + fmt(w.t + pend) + '</b></div>' +
          '<div class="pts-kv"><span>Received</span><b>+' + fmt(w.rc || 0) + '</b></div>' +
          '<div class="pts-kv"><span>Sent</span><b>-' + fmt(w.sn || 0) + '</b></div>';
      }
      if (w && w.stk[0] > 0) {
        html += '<div class="pts-kv"><span>Staked</span><b>' + fmt(w.stk[0]) + ' FETTI</b></div>' +
          (S.rules.holder && !w.house ? '<div class="pts-kv pts-holder"><span>Holder multiplier</span><b>×' + holderX(S.rules, w.stk[0]).toFixed(1) +
            ' for size · ×' + ageX(S.rules, chainNow() - (w.sa || 0)).toFixed(2) + ' for time held = ×' + liveMult(w, chainNow()).toFixed(1) + '</b></div>' : '') +
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
    // the header adds up what the board lists (house wallets are left off the board, so they are left out of the total too)
    var listed = rows.reduce(function (s, r) { return s + Math.floor(r.t + 1e-9); }, 0);   // the same whole points each row shows
    var lh = '<h3>Leaderboard <i>' + fmt(rows.length) + ' wallet' + (rows.length === 1 ? '' : 's') + ' · ' + fmt(listed) + ' points</i></h3><ol class="pts-board">';
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
    var hv = $('phPtsVal'), hp = $('phPts');
    if (hv && hp) {
      var idle = !S.view;
      if (idle !== S.pillIdle) {
        S.pillIdle = idle;
        hp.classList.toggle('is-idle', idle);
        if (idle) hv.innerHTML = 'Earn<span class="ph-pts-word"> points</span>';
      }
      if (!idle) {
        var pv = fmtPill(S.shown);
        if (hv.textContent !== pv) hv.textContent = pv;
      }
      var pl = idle ? 'Points: earn points' : 'Points: ' + fmt(S.shown);
      if (hp.getAttribute('aria-label') !== pl) hp.setAttribute('aria-label', pl);
    }
    var dl = $('ptsPillDelta');
    if (dl) {
      var td = S.view ? Math.floor(todayOf(w)) : 0;
      var txt = td >= 1 ? '+' + fmt(td) : '';
      if (dl.textContent !== txt) {
        var up = S.todayShown !== undefined && td > S.todayShown;
        dl.textContent = txt;
        if (up) { dl.classList.remove('is-pop'); void dl.offsetWidth; dl.classList.add('is-pop'); }
      }
      S.todayShown = td;
      dl.title = 'earned today (UTC)';
    }
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
      if (rate && w) rate.textContent = fmt(w.stk[0] / 1000 * S.rules.staking.perThousandConfettiPerDay * liveMult(w, chainNow())) + ' a day';
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
      S.relay = relayOf();
      S.house = houseOf(S.cfg);
      configureSend();
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
      var hv = $('phPtsVal'); if (hv && S.view) hv.textContent = '—';
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
