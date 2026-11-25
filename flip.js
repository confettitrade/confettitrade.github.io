/* confetti_ — flip.js
   The coin flip page (flip.html, flip.css): heads or tails, an amount, one Flip key, the result, a feed of recent flips.

   Where the money is: a flip plays from the visitor's own wallet. The stake is USDC the wallet lets the game's contract
   (CoinFlip, config.json contracts.coinFlip) take for that one flip; a win comes back to the same wallet from the
   contract, in the transaction that brings the result. Nothing here touches the Exchange or the trading balance.
   Where the result comes from: the contract asks Pyth Entropy for a random number, mixed from 32 random bytes this page
   makes for each flip and a number the provider committed to beforehand. Even is heads, odd is tails. The page only
   shows what the contract settled; it decides nothing.

   Two ways the page runs:
   - live: contracts.coinFlip is an address. Reads go to config.json's rpcUrl. The wallet part is gamewallet.js (the sheet with
     every wallet the browser offers, the connect, the move to HyperEVM); this script asks the wallet only to allow the game
     to take USDC (once), to send a flip, and to take back the stake of a flip that never got its number.
   - demo: flip.html?demo=1, or no address in the config yet (the page then also says "Coming soon"). Pretend money, a coin
     decided by the browser's own random bytes, a feed of pretend flips. No wallet, no network.

   One screen in every state: nothing appears or moves under the thumb. The key says what the next press does. */
(function () {
  'use strict';

  var E = window.ethers;
  var GW = window.ConfettiGameWallet || null;         /* gamewallet.js: find, connect, HyperEVM, the wallet sheet */
  var OPEN_KEY = 'confetti.flip.open.';               /* + account: a flip still waiting for its number */
  var QUICK = [1, 5, 10, 25, 50, 100, 150, 200];
  var FEED_ROWS = 10;

  var ABI = [
    'function payoutX100() view returns (uint16)', 'function maxBet() view returns (uint256)', 'function paused() view returns (bool)',
    'function flipFee() view returns (uint256)', 'function refundDelay() view returns (uint32)', 'function lastId() view returns (uint64)',
    'function getFlip(uint64 id) view returns (tuple(address player, uint64 stake, uint16 payoutX100, bool heads, uint8 status, address provider, uint64 sequence, uint32 requestedAt))',
    'function flip(bool heads, uint256 stake, bytes32 userRandom) payable returns (uint64)',
    'function refund(uint64 id)',
    'event FlipRequested(uint64 indexed id, address indexed player, uint256 stake, bool heads, uint16 payoutX100)',
    'event FlipSettled(uint64 indexed id, address indexed player, bool won, uint256 payout, bytes32 randomness)',
    'error GamePaused()', 'error BetTooSmall(uint256 stake, uint256 minBet)', 'error BetTooLarge(uint256 stake, uint256 maxBet)',
    'error FeeTooLow(uint256 sent, uint256 fee)', 'error FeeChangeNotReturned()', 'error TooEarly(uint256 refundableAt)', 'error NotOpen(uint64 id)', 'error NotPlayer()'
  ];
  var ERC20 = ['function balanceOf(address) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 amount) returns (bool)'];
  var ST = { OPEN: 1, WON: 2, LOST: 3, REFUNDED: 4 };

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
  function usd(n) { return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function usdShort(n) { return Math.abs(n - Math.round(n)) < 0.005 ? '$' + Math.round(n).toLocaleString('en-US') : usd(n); }
  function short(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; }
  function sideWord(heads) { return heads ? 'heads' : 'tails'; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function from6(v) { return Number(v) / 1e6; }
  function to6(n) { return BigInt(Math.round(n * 1e6)); }
  /* what a win pays, as the contract works it out (stake x payoutX100 / 100, rounded down), shown down to the cent */
  function payOf(stake, x100) { return Math.floor(Math.round(stake * 100) * x100 / 100 + 1e-9) / 100; }
  /* the time the contract goes by: this device's clock, set right by the newest block read (live); refunds and "ago" use it */
  function now() { return Date.now() / 1000 + (S.skew || 0); }
  function ago(ts) {
    var s = Math.max(0, Math.round(now() - ts));
    if (s < 5) return 'now'; if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
  }
  function hypeText(wei) { var n = Number(wei) / 1e18; return n >= 0.01 ? n.toFixed(3) : n >= 0.0001 ? n.toFixed(4) : n.toPrecision(2); }

  /* ---- state ---- */
  var el = {};
  var S = {
    cfg: null, demo: true, soon: false, game: '', ready: false,
    heads: true, text: '10', usd: 10,
    x100: 196, minBet: 1, maxBet: null, paused: false, fee: 0n, refundDelay: 21600,
    account: null, eth: null, walletName: '', chainOk: true, bal: null, allowance: 0n, hype: null,
    phase: 'idle',            /* idle | wallet | allowing | sending | air | landed | refunding */
    last: null,               /* the flip just settled: { id, won, heads (how it landed), called, stake, payout, x100, tx } */
    pending: null,            /* a flip of this wallet still waiting: { id, at, stake, heads, x100 } */
    say: '', sayOk: false, feed: [], feedState: 'loading', head: null, spb: 1
  };

  /* ---- the coin: tossed up, turning in the air until the result is known, then down on the side that landed ----
     ang: degrees about the coin's own level axis (0 = heads up, 180 = tails up). y: px above the table. */
  var COIN = { ang: 0, y: 0, mode: 'rest', t0: 0, raf: 0, last: 0, a0: 0, a1: 0, y0: 0, done: null, want: null, face: true };
  var SPIN = 1080, UP_MS = 480, FALL_MS = 620, BOUNCE_MS = 240;
  /* how high a toss goes: three tenths of the coin, but never out of the page's own room above it (measured at the toss:
     on a short phone the coin starts right under the top bar) */
  function coinRise() { return COIN.rise || Math.max(8, el.lift.offsetWidth * 0.3); }
  function coinRoom() {
    var d = el.lift.offsetWidth, top = el.stage.getBoundingClientRect().bottom - 20 - d, bar = el.root.querySelector('.sm-top').getBoundingClientRect().bottom;
    COIN.rise = Math.max(8, Math.min(d * 0.3, top - bar - d * 0.07));
  }
  function coinPaint() {
    var H = coinRise(), u = Math.max(0, Math.min(1.2, COIN.y / H));
    el.coin.style.transform = 'rotateX(' + COIN.ang.toFixed(2) + 'deg)';
    el.lift.style.transform = 'translateY(' + (-COIN.y).toFixed(2) + 'px) rotateX(18deg) scale(' + (1 + 0.08 * u).toFixed(4) + ')';
    el.shadow.style.transform = 'scale(' + (1 - 0.32 * u).toFixed(4) + ')';
    el.shadow.style.opacity = (1 - 0.45 * u).toFixed(3);
  }
  function coinFrame(now) {
    COIN.raf = 0;
    var dt = Math.min(50, now - COIN.last), t = now - COIN.t0, H = coinRise();
    COIN.last = now;
    if (COIN.mode === 'up') {
      var p = Math.min(1, t / UP_MS);
      COIN.y = H * (1 - Math.pow(1 - p, 3));
      COIN.ang += SPIN * dt / 1000;
      if (p >= 1) { COIN.mode = 'air'; COIN.t0 = now; if (COIN.want != null) coinLand(COIN.want, COIN.done); }
    } else if (COIN.mode === 'air') {
      COIN.y = H + 4 * Math.sin(t / 190);
      COIN.ang += SPIN * dt / 1000;
    } else if (COIN.mode === 'down') {
      var q = Math.min(1, t / FALL_MS);
      COIN.ang = COIN.a0 + (COIN.a1 - COIN.a0) * q;      /* it turns on at the speed it had until it meets the table */
      COIN.y = COIN.y0 * (1 - q * q);
      if (q >= 1) { COIN.mode = 'bounce'; COIN.t0 = now; COIN.ang = COIN.a1; }
    } else if (COIN.mode === 'bounce') {
      var b = Math.min(1, t / BOUNCE_MS);
      COIN.y = H * 0.09 * 4 * b * (1 - b);
      if (b >= 1) {
        COIN.mode = 'rest'; COIN.y = 0; COIN.ang = COIN.face ? 0 : 180;
        coinPaint();
        var done = COIN.done; COIN.done = null; COIN.want = null;
        if (done) done();
        return;
      }
    }
    coinPaint();
    if (!COIN.raf) COIN.raf = requestAnimationFrame(coinFrame);
  }
  function coinGo() { if (!COIN.raf) { COIN.last = performance.now(); COIN.raf = requestAnimationFrame(coinFrame); } }
  /* the press: up it goes */
  function coinToss() {
    COIN.want = null; COIN.done = null;
    coinRoom();
    if (reduced()) { COIN.mode = 'air'; el.stage.classList.add('is-wait'); return; }
    COIN.mode = 'up'; COIN.t0 = performance.now();
    coinGo();
  }
  /* the result is known: down on `heads` (true) or tails, then done() */
  function coinLand(heads, done) {
    COIN.face = !!heads;
    if (reduced()) { el.stage.classList.remove('is-wait'); COIN.mode = 'rest'; COIN.y = 0; COIN.ang = heads ? 0 : 180; coinPaint(); if (done) done(); return; }
    if (COIN.mode === 'up') { COIN.want = !!heads; COIN.done = done; return; }      /* still rising: land once it is up */
    var want = heads ? 0 : 180, a = COIN.ang, turn = a + 720 + ((want - (a + 720)) % 360 + 360) % 360;
    COIN.a0 = a; COIN.a1 = turn; COIN.y0 = COIN.y; COIN.done = done;
    COIN.mode = 'down'; COIN.t0 = performance.now();
    coinGo();
  }
  /* flat on the table at once (a refusal after the toss, a side picked while idle) */
  function coinRest(heads) {
    if (COIN.raf) { cancelAnimationFrame(COIN.raf); COIN.raf = 0; }
    el.stage.classList.remove('is-wait');
    COIN.mode = 'rest'; COIN.y = 0; COIN.face = !!heads; COIN.ang = heads ? 0 : 180; COIN.done = null; COIN.want = null;
    coinPaint();
  }
  /* a side picked while the coin lies there: it turns over, half a turn */
  function coinShow(heads) {
    if (COIN.mode !== 'rest' || COIN.face === !!heads) return;
    if (reduced()) { coinRest(heads); return; }
    COIN.face = !!heads;
    var a = COIN.ang, t0 = performance.now(), a1 = a + 180, H = coinRise() * 0.35;
    COIN.mode = 'turn';
    (function step(now) {
      if (COIN.mode !== 'turn') return;
      var p = Math.min(1, (now - t0) / 320), e = 1 - Math.pow(1 - p, 3);
      COIN.ang = a + (a1 - a) * e; COIN.y = H * 4 * p * (1 - p);
      coinPaint();
      if (p < 1) requestAnimationFrame(step); else { COIN.mode = 'rest'; COIN.ang = heads ? 0 : 180; COIN.y = 0; coinPaint(); }
    })(t0);
  }

  /* a win: a handful of paper, in the page's own inks (not on reduced motion) */
  function burst() {
    if (reduced()) return;
    var box = el.lift.getBoundingClientRect(), cv = h('canvas', 'fl-burst'), dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60';
    cv.width = Math.round(window.innerWidth * dpr); cv.height = Math.round(window.innerHeight * dpr);
    document.body.appendChild(cv);
    var ctx = cv.getContext('2d'), cx = box.left + box.width / 2, cy = box.top + box.height / 2, t0 = performance.now(), bits = [];
    var inks = ['#2a2520', '#2e7a4c', '#b44855', '#8a7f66', '#9a6400', '#2e7a4c'];
    for (var i = 0; i < 42; i++) {
      var a = -Math.PI / 2 + (Math.random() - 0.5) * 2.5, v = 220 + Math.random() * 380;
      bits.push({ x: cx + (Math.random() - 0.5) * box.width * 0.5, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: 5 + Math.random() * 6, hh: 3 + Math.random() * 4, r: Math.random() * 6.3, vr: (Math.random() - 0.5) * 14, c: inks[i % inks.length] });
    }
    ctx.scale(dpr, dpr);
    (function frame(now) {
      var t = (now - t0) / 1000;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (t > 1.5) { cv.remove(); return; }
      bits.forEach(function (b) {
        var x = b.x + b.vx * t * (1 - 0.25 * t), y = b.y + b.vy * t + 520 * t * t;
        ctx.save(); ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - 0.9) / 0.6);
        ctx.translate(x, y); ctx.rotate(b.r + b.vr * t); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.hh / 2, b.w, b.hh); ctx.restore();
      });
      requestAnimationFrame(frame);
    })(t0);
  }

  /* ---- sheets: Simple's own (simple.css dialog.sm-sheet), for the menu and the wallet chooser ---- */
  var sheets = [];
  function makeSheet(name) {
    var d = h('dialog', 'sm-sheet fl-sheet');
    var title = h('h2'); title.id = 'flSheet' + name; title.tabIndex = -1; d.setAttribute('aria-labelledby', title.id);
    var x = btn('sm-x', '✕', function () { sh.close(); }); x.setAttribute('aria-label', 'Close');
    var head = h('div', 'sm-sh-head', [title, x]), body = h('div', 'sm-sh-body'), foot = h('div', 'sm-sh-foot');
    add(d, [head, body, foot]);
    document.body.appendChild(d);
    function shut() { clearTimeout(sh.outT); sh.outT = 0; d.classList.remove('is-out', 'is-gone'); d.inert = false; try { d.close(); } catch (e) { d.removeAttribute('open'); } }
    var sh = {
      d: d, title: title, body: body, foot: foot, isOpen: false, onClose: null, outT: 0,
      open: function () {
        if (sh.isOpen) return;
        if (sh.outT || d.open) shut();
        sh.isOpen = true; d.style.removeProperty('--sm-drag');
        try { d.showModal(); } catch (e) { d.setAttribute('open', ''); }
        try { title.focus({ preventScroll: true }); } catch (e) { /* fine */ }
        sheets.push(sh); body.scrollTop = 0;
        try { history.pushState({ flSheet: sheets.length }, ''); } catch (e) { /* fine */ }
      },
      close: function (fromPop) {
        if (!sh.isOpen) return;
        sh.isOpen = false; sheets = sheets.filter(function (s) { return s !== sh; });
        if (!fromPop) { try { if (history.state && history.state.flSheet) history.back(); } catch (e) { /* fine */ } }
        shut();
        if (!reduced()) {
          var keep = document.activeElement;
          try {
            d.classList.add('is-out', 'is-gone'); d.inert = true; d.show();
            if (keep && keep !== document.body && document.activeElement !== keep && document.contains(keep)) keep.focus({ preventScroll: true });
            sh.outT = setTimeout(shut, 180);
          } catch (e) { shut(); }
        }
        if (sh.onClose) { var f = sh.onClose; sh.onClose = null; f(); }
      }
    };
    d.addEventListener('cancel', function (ev) { ev.preventDefault(); sh.close(); });
    d.addEventListener('click', function (ev) { if (ev.target === d) sh.close(); });
    var y0 = null, dy = 0, t0 = 0;
    head.addEventListener('pointerdown', function (ev) { if (ev.target.closest('button')) return; y0 = ev.clientY; dy = 0; t0 = Date.now(); try { head.setPointerCapture(ev.pointerId); } catch (e) { /* fine */ } });
    head.addEventListener('pointermove', function (ev) { if (y0 == null) return; dy = Math.max(0, ev.clientY - y0); d.style.setProperty('--sm-drag', dy + 'px'); });
    var up = function () { if (y0 == null) return; var fast = dy > 24 && dy / Math.max(1, Date.now() - t0) > 0.5; y0 = null; if (dy > 90 || fast) sh.close(); else d.style.removeProperty('--sm-drag'); };
    head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
    return sh;
  }
  window.addEventListener('popstate', function () { var top = sheets[sheets.length - 1]; if (top) top.close(true); });

  var MENU = null;
  function openMenu() {
    var sh = MENU || (MENU = makeSheet('Menu'));
    function item(label, hint, fn, href, now) {
      var n = href ? h('a', now ? 'fl-menu-now' : null, [label, h('i', null, hint || '›')]) : btn(null, [label, h('i', null, hint || '›')], function () { sh.close(); setTimeout(fn, 200); });
      if (href) n.href = href;
      if (now) { n.setAttribute('aria-current', 'page'); n.setAttribute('aria-pressed', 'true'); }
      return n;
    }
    txt(sh.title, 'Menu'); sh.body.textContent = ''; sh.foot.textContent = '';
    if (S.demo) add(sh.body, h('div', 'sm-who', [h('b', null, 'Demo wallet'), h('i', null, 'Pretend money. Nothing here is real.')]));
    else if (S.account) {
      add(sh.body, h('div', 'sm-who', [h('b', null, (S.walletName || 'Wallet') + ' connected'), h('i', null, S.account),
        h('div', 'sm-links', [btn('sm-link', 'Switch wallet', function () { sh.close(); setTimeout(function () { connect(true); }, 200); }), btn('sm-link', 'Disconnect', function () { sh.close(); setTimeout(disconnect, 200); })])]));
    }
    var list = h('div', 'sm-menu');
    if (!S.demo && !S.account) add(list, item('Connect wallet', 'MetaMask, Phantom, any wallet', function () { connect(false); }));
    if (!S.demo && S.account) add(list, item('Add money', 'HYPE, ETH, USDT, Bitcoin', function () { openAdd(); }));
    add(list, item('Trade', 'coins, up or down', null, 'trade.html'));
    add(list, item('Coin flip', 'you are here', null, 'flip.html' + (S.demo && !S.soon ? '?demo=1' : ''), true));
    add(list, item('Crash', 'cash out before it does', null, 'crash.html'));
    add(list, item('Portfolio', 'your trades', null, 'portfolio.html'));
    add(list, item('Leaderboard', 'top traders', null, 'leaderboard.html'));
    add(list, item('House', 'LP and stats', null, 'house.html'));
    add(list, item('$FETTI', '', null, 'confetti.html'));
    var sub = h('div', 'sm-menu-sub');
    add(sub, item('Docs', '', null, 'docs.html'));
    add(sub, item('Contracts', '', null, 'contracts.html'));
    add(list, sub);
    if (S.demo && !S.soon) add(list, item('Play for real', 'leave the demo', null, 'flip.html'));
    add(sh.body, list);
    sh.open();
  }

  /* ---- the wallet (live only). gamewallet.js finds the wallets, shows the sheet, connects and moves the wallet to HyperEVM;
     here is what the page does with the wallet it is handed. ---- */
  var subscribed = [];
  function subscribe(eth) {
    if (subscribed.indexOf(eth) >= 0 || typeof eth.on !== 'function') return;
    subscribed.push(eth);
    eth.on('accountsChanged', function (accounts) { if (eth !== S.eth) return; if (!accounts || !accounts.length) disconnect(); else setAccount(eth, accounts[0]); });
    eth.on('chainChanged', function (hex) { if (eth !== S.eth) return; S.chainOk = parseInt(hex, 16) === Number(S.cfg.chainId); paint(); });
  }
  function setAccount(eth, account) {
    S.eth = eth; S.account = E.getAddress(account); S.walletName = GW.nameOf(eth); S.bal = null; S.allowance = 0n; S.hype = null; S.pending = null;
    subscribe(eth); loadPend();
    return GW.chainOf(eth).then(function (id) { S.chainOk = id === Number(S.cfg.chainId); }, function () { S.chainOk = true; }).then(function () {
      paint(); paintFeed();      /* the feed marks this wallet's own flips */
      return Promise.all([readWallet(), resume()]);
    }).then(paint);
  }
  /* a Connect press: the sheet (every wallet this browser offers; on a phone with none, the keys that open this page inside a
     wallet app), the wallet's own connect, then HyperEVM, added or switched to for them. A wallet that will not move stays
     connected: its words go on the line over the key, and the key offers the switch again. */
  function connect(always) {
    if (S.demo) return Promise.resolve();
    if (!GW) { say('The wallet part of this page did not load. Reload the page.'); paint(); return Promise.resolve(); }
    say(''); paint();
    return GW.connect({
      always: !!always, note: 'Pick the wallet to flip from. Flips play straight from its USDC on HyperEVM: no deposit first.',
      onStep: function (step, name) { if (S.phase === 'idle' || S.phase === 'landed') S.phase = 'wallet'; S.wstep = step === 'chain' ? 'Switching to HyperEVM…' : 'Confirm in ' + name + '…'; paint(); }
    }).then(function (r) {
      if (!r) return null;
      return setAccount(r.eth, r.account).then(function () { if (r.say && !S.chainOk) say(r.say); });
    }, function (e) { say(e && e.plain ? e.message : describe(e)); }).then(function () { S.wstep = ''; if (S.phase === 'wallet') S.phase = 'idle'; paint(); });
  }
  function disconnect() { ADD.pend = null; clearTimeout(ADD.tt); if (ADD.sh && ADD.sh.isOpen) ADD.sh.close(); S.account = null; S.eth = null; S.bal = null; S.allowance = 0n; S.hype = null; S.pending = null; if (S.phase !== 'air') S.phase = 'idle'; say(''); paint(); paintFeed(); }
  /* a wallet connected before: asked quietly on load (nothing opens). It is not moved to HyperEVM without a press. */
  function autoConnect() {
    if (!GW) return;
    GW.restore().then(function (r) { if (r && !S.account) return setAccount(r.eth, r.account); }).catch(function () { /* stay disconnected */ });
  }
  function switchChain() { return GW.toChain(S.eth).then(function () { S.chainOk = true; }); }

  /* ---- reading the chain (live) ---- */
  var RPC = null, LOGS = null, GAME = null, USDC = null;
  function rpcFor(url) { return new E.JsonRpcProvider(url, Number(S.cfg.chainId), { staticNetwork: true, batchMaxCount: Number(S.cfg.rpcBatchMaxCount) || 1 }); }
  function rpc() { return RPC || (RPC = rpcFor(S.cfg.rpcUrl)); }
  function logs() { return LOGS || (LOGS = S.cfg.logRpcUrl && S.cfg.logRpcUrl !== S.cfg.rpcUrl ? rpcFor(S.cfg.logRpcUrl) : rpc()); }
  function game() { return GAME || (GAME = new E.Contract(S.game, ABI, rpc())); }
  function usdcC() { return USDC || (USDC = new E.Contract(S.cfg.contracts.usdc, ERC20, rpc())); }
  function readGame() {
    var g = game();
    return Promise.all([g.payoutX100(), g.maxBet(), g.paused(), g.flipFee(), g.refundDelay()]).then(function (v) {
      S.x100 = Number(v[0]); S.maxBet = from6(v[1]); S.paused = !!v[2]; S.fee = BigInt(v[3]); S.refundDelay = Number(v[4]); S.ready = true;
    });
  }
  function readWallet() {
    if (!S.account) return Promise.resolve();
    var a = S.account;
    return Promise.all([usdcC().balanceOf(a), usdcC().allowance(a, S.game), rpc().getBalance(a)]).then(function (v) {
      if (a !== S.account) return;
      S.bal = from6(v[0]); S.allowance = BigInt(v[1]); S.hype = BigInt(v[2]);
    }).catch(function () { /* the next read tries again */ });
  }
  function flipRow(id, f) {
    return { id: Number(id), who: f.player, stake: from6(f.stake), x100: Number(f.payoutX100), called: !!f.heads, status: Number(f.status), at: Number(f.requestedAt), tx: '' };
  }
  /* the newest flips, from the contract's own records; a settled row never changes, so it is read once */
  var rowCache = {};
  function readFeed() {
    var g = game();
    return headBlock().catch(function () { /* the clock stays as it was */ }).then(function () { return g.lastId(); }).then(function (n) {
      n = Number(n);
      var ids = [];
      for (var i = n; i >= 1 && ids.length < FEED_ROWS + 2; i--) ids.push(i);
      return Promise.all(ids.map(function (id) {
        var c = rowCache[id];
        if (c && c.status !== ST.OPEN) return c;
        return g.getFlip(id).then(function (f) { var r = flipRow(id, f); if (c && c.tx) r.tx = c.tx; rowCache[id] = r; return r; });
      }));
    }).then(function (rows) {
      S.feed = rows.filter(function (r) { return r.status === ST.OPEN || r.status === ST.WON || r.status === ST.LOST; }).slice(0, FEED_ROWS);
      S.feedState = S.feed.length ? 'rows' : 'empty';
      S.feed.forEach(findTx);
      /* a flip of this wallet still open that this device did not remember (another device, storage cleared) */
      var mine = !S.pending && S.account && (S.phase === 'idle' || S.phase === 'landed') ? S.feed.filter(function (r) { return r.status === ST.OPEN && String(r.who).toLowerCase() === S.account.toLowerCase(); })[0] : null;
      if (mine) adoptOpen({ id: mine.id, at: mine.at, stake: mine.stake, heads: mine.called, x100: mine.x100 });
    }).catch(function () { if (S.feedState === 'loading') S.feedState = 'error'; });
  }
  /* the transaction that settled a flip: one small log read around the block its time points at (the contract keeps the
     time a flip was asked, not its block), asked once per flip. Without it the row links to the game's own page. */
  function headBlock() {
    if (S.head && Date.now() - S.head.read < 20000) return Promise.resolve(S.head);
    return rpc().getBlock('latest').then(function (b) {
      S.head = { n: b.number, ts: b.timestamp, read: Date.now() };
      S.skew = b.timestamp - Date.now() / 1000;
      if (Math.abs(S.skew) < 30) S.skew = 0;      /* a block or two behind the clock is the same time */
      if (S.spbRead) return S.head;
      S.spbRead = true;
      return rpc().getBlock(Math.max(1, b.number - 3000)).then(function (o) { if (o && b.number > o.number) S.spb = Math.max(0.2, (b.timestamp - o.timestamp) / (b.number - o.number)); return S.head; }, function () { return S.head; });
    });
  }
  function findTx(r) {
    if (r.tx || r.txAsked || (r.status !== ST.WON && r.status !== ST.LOST)) return;
    r.txAsked = true;
    headBlock().then(function (hd) {
      var at = hd.n - Math.round((hd.ts - r.at) / S.spb), from = Math.max(0, at - 400), to = Math.min(hd.n, at + 2400);
      var topic = game().interface.getEvent('FlipSettled').topicHash;
      return logs().getLogs({ address: S.game, topics: [topic, E.zeroPadValue(E.toBeHex(r.id), 32)], fromBlock: from, toBlock: to });
    }).then(function (ls) { if (ls && ls.length) { r.tx = ls[0].transactionHash; paintFeed(); } }).catch(function () { r.txAsked = false; });
  }

  /* ---- what the visitor may stake, and why not ---- */
  function limit() {
    var most = S.maxBet;
    if (most != null && S.bal != null && S.bal < most) most = Math.floor(S.bal * 100) / 100;
    return most;
  }
  function problem() {
    if (!S.ready) return { key: 'One moment…', why: S.readErr ? 'The game could not be read just now. The page keeps trying.' : '' };
    if (S.paused) return { key: 'Flips are paused', why: 'The table is closed for a moment. Flips already in the air still land and pay.' };
    if (S.maxBet != null && S.maxBet < S.minBet) return { key: 'The table is closed', why: 'The table is not taking flips right now. Come back soon.' };
    if (!(S.usd > 0)) return { key: 'Type an amount', why: '', field: true, quiet: true };
    if (S.usd < S.minBet) return { key: 'The least is ' + usdShort(S.minBet), why: 'The least a flip may be is ' + usd(S.minBet) + '.', field: true };
    if (S.maxBet != null && S.usd > S.maxBet + 1e-9) return { key: 'The most is ' + usd(S.maxBet), why: 'The most a flip may be right now is ' + usd(S.maxBet) + '.', field: true };
    if (S.bal != null && S.usd > S.bal + 1e-9) return { key: 'Not enough USDC', why: (S.demo ? 'Your demo wallet holds ' : 'Your wallet holds ') + usd(S.bal) + (S.demo ? '.' : ' USDC. Add money with HYPE, ETH, USDT or Bitcoin.'), field: true, add: !S.demo && !!S.account };
    /* USDC but no HYPE: HyperEVM takes a little for every flip (the network, the random number), so the key brings some */
    if (!S.demo && S.account && S.hype != null && S.hype < S.fee * 5n / 4n + 200000000000000n) return { key: 'Add money', why: 'Your wallet has no HYPE to spare, and each flip takes a little (about ' + hypeText(S.fee * 5n / 4n + 300000000000000n) + ' HYPE: the network, and the random number). Add money brings some along.', add: true };
    return null;
  }

  /* ---- painting: every number and word on the page comes from S ---- */
  function say(s, ok) { S.say = s || ''; S.sayOk = !!ok; }
  function paintTop() {
    show(el.who, !!S.account || S.demo);
    if (S.demo) { txt(el.whoAddr, 'Demo'); el.who.setAttribute('aria-label', 'Demo wallet. Menu'); }
    else if (S.account) { txt(el.whoAddr, S.account.slice(0, 4) + '…' + S.account.slice(-4)); el.who.setAttribute('aria-label', 'Wallet ' + S.account + '. Menu'); }
  }
  function paintMode() {
    var m = el.mode;
    if (S.soon) { m.textContent = ''; add(m, [h('b', null, 'Coming soon.'), ' A demo with pretend money.']); show(m, true); }
    else if (S.demo) { txt(m, 'Demo: pretend money. Nothing here is real.'); show(m, true); }
    else show(m, false);
  }
  function paintForm() {
    var busy = (S.phase !== 'idle' && S.phase !== 'landed') || !!(S.pending && !S.demo), x = S.x100 / 100, win = S.usd > 0 ? payOf(S.usd, S.x100) : 0;
    txt(el.pays, 'Win pays ' + x.toFixed(2) + '×');
    el.headsKey.setAttribute('aria-pressed', S.heads ? 'true' : 'false'); el.tailsKey.setAttribute('aria-pressed', S.heads ? 'false' : 'true');
    el.headsKey.disabled = busy; el.tailsKey.disabled = busy; el.amount.disabled = busy;
    Array.prototype.forEach.call(el.chips.children, function (b) { var v = Number(b.getAttribute('data-usd')); b.setAttribute('aria-pressed', Math.abs(v - S.usd) < 0.005 ? 'true' : 'false'); b.disabled = busy || (S.maxBet != null && v > S.maxBet + 1e-9) || (S.bal != null && v > S.bal + 1e-9); });
    var most = limit();
    if (most != null && most >= S.minBet && !S.paused) { txt(el.most, 'Most right now ' + usd(most)); el.most.disabled = busy; el.most.setAttribute('aria-label', 'The most a flip may be right now: ' + usd(most) + '. Fill it in'); show(el.most, true); }
    else show(el.most, false);
    txt(el.winWhen, cap(sideWord(S.heads)) + ': win pays'); txt(el.loseWhen, cap(sideWord(!S.heads)) + ': you lose');
    /* the two boxes say what this flip would do; an amount that cannot be flipped has nothing to say */
    var pr = problem(), can = S.usd > 0 && !(pr && pr.field);
    txt(el.win, can ? usd(win) : '—'); txt(el.lose, can ? usd(S.usd) : '—');
    /* after a flip, the box that came true is ruled in ink and the other one steps back */
    var hit = S.phase === 'landed' && S.last ? (S.last.won ? 'win' : 'lose') : '';
    el.win.parentNode.className = hit === 'win' ? 'is-hit' : hit ? 'is-miss' : ''; el.lose.parentNode.className = hit === 'lose' ? 'is-hit' : hit ? 'is-miss' : '';
    /* (the amount's own word about it shows once it has been touched) */
    el.amt.classList.toggle('is-bad', !!(pr && pr.field && !pr.quiet && S.touched));
    var w = el.wallet; w.textContent = '';
    if (S.demo) add(w, S.bal != null ? ['Flips play from your wallet\'s USDC. It holds ', h('b', null, usd(S.bal)), '.'] : 'Flips play from your wallet\'s USDC.');
    else if (!S.account) add(w, 'Connect MetaMask, Phantom or any wallet and flip straight from its USDC. No deposit first.');
    else {
      add(w, [h('b', null, S.walletName || 'Your wallet'), ' is connected. Flips play straight from its USDC']);
      add(w, S.bal != null ? [': ', h('b', null, usd(S.bal)), ' now.'] : '.');
      add(w, [' ', btn('sm-link fl-addkey', ADD.pend ? 'Money on its way' : 'Add money', function () { openAdd(); })]);
    }
  }
  function paintResult() {
    var r = el.result, big, sub, c = '';
    if (S.phase === 'air' || S.phase === 'sending' || S.phase === 'allowing' || S.phase === 'wallet' || S.phase === 'refunding') {
      c = 'is-air';
      if (S.phase === 'air') { big = 'In the air…'; sub = cap(sideWord(S.heads)) + ' for ' + usd(S.usd) + '.'; }
      else if (S.phase === 'allowing') { big = 'One moment…'; sub = 'Letting the game use your USDC.'; }
      else if (S.phase === 'refunding') { big = 'One moment…'; sub = 'Taking your stake back.'; }
      else { big = 'Heads or tails?'; sub = 'Waiting for your wallet.'; }
    } else if (S.phase === 'landed' && S.last) {
      var L = S.last, side = cap(sideWord(L.heads));
      if (L.won) { c = 'is-won'; big = 'You won ' + usd(L.payout); sub = side + ' landed. ' + (S.demo ? 'It is in your demo wallet.' : 'It is in your wallet.'); }
      else { c = 'is-lost'; big = 'Not this time'; sub = side + ' landed. Your ' + usd(L.stake) + ' is gone.'; }
    } else if (S.pending && !S.demo) { c = 'is-air'; big = 'One flip is still out'; sub = usd(S.pending.stake) + ' on ' + sideWord(S.pending.heads) + (pendingLate() ? ': no number came.' : ', waiting for its number.'); }
    else { big = 'Heads or tails?'; sub = 'Pick a side, pick an amount, flip.'; }
    r.className = 'fl-result ' + c + (S.popNow ? ' is-in' : '');
    S.popNow = false;
    txt(el.resBig, big); txt(el.resSub, sub);
  }
  function pendingLate() { return now() >= S.pending.at + S.refundDelay; }
  /* what can be done about a flip whose number has not come: said by the key, where the press is */
  function pendingSay() {
    if (pendingLate()) return 'No number came for it. You can take the stake back now.';
    var left = S.pending.at + S.refundDelay - now(), t = left > 5400 ? Math.round(left / 3600) + ' hours' : Math.max(1, Math.round(left / 60)) + ' minutes';
    return 'It lands as soon as the number comes. If none does, the stake can be taken back in ' + t + '.';
  }
  function paintKey() {
    var k = el.go, label, dis = false, busy = false, share = false, pr = problem(), words = 'Flip · ' + usdShort(S.usd) + ' on ' + sideWord(S.heads);
    var sayText = S.say, sayOk = S.sayOk;
    if (S.phase === 'wallet') { label = S.wstep || 'Confirm in your wallet…'; busy = true; }
    else if (S.phase === 'allowing') { label = 'Allowing USDC…'; busy = true; }
    else if (S.phase === 'sending') { label = 'Sending your flip…'; busy = true; }
    else if (S.phase === 'refunding') { label = 'Taking it back…'; busy = true; }
    else if (S.phase === 'air') { label = 'Flipping…'; busy = true; if (!sayText && S.slow) { sayText = 'The number is taking longer than usual. Your stake is safe: the flip lands when it arrives.'; sayOk = true; } }
    else if (!S.demo && !S.account) { label = 'Connect wallet'; }
    else if (!S.demo && !S.chainOk) { label = 'Switch to HyperEVM'; }
    else if (S.pending && !S.demo && pendingLate()) { label = 'Take your ' + usdShort(S.pending.stake) + ' back'; if (!sayText) { sayText = pendingSay(); sayOk = true; } }
    else if (S.pending && !S.demo) { label = 'Waiting for the number…'; dis = true; if (!sayText) { sayText = pendingSay(); sayOk = true; } }
    else if (pr && pr.add) { label = 'Add money'; if (!sayText) { sayText = pr.why; sayOk = true; } }      /* short of USDC: the key adds it */
    else if (pr) { label = pr.key; dis = true; if (!sayText && pr.why && (!pr.field || S.touched)) sayText = pr.why; }
    else if (S.phase === 'landed') { label = 'Flip again'; share = !!(S.last && S.last.won && window.ConfettiShare); }
    else {
      label = words;
      if (!sayText && !S.demo && S.account && S.allowance < to6(S.usd)) { sayText = 'First flip: your wallet asks twice. Once to let the game use your USDC, then the flip itself.'; sayOk = true; }
    }
    txt(k, label);
    k.disabled = dis; k.classList.toggle('is-busy', busy); k.classList.toggle('is-long', label.length > 22);
    if (busy) k.setAttribute('aria-busy', 'true'); else k.removeAttribute('aria-busy');
    show(el.share, share); el.keys.classList.toggle('is-two', share);
    txt(el.sayLine, sayText); el.sayLine.classList.toggle('is-ok', sayOk); el.sayLine.classList.toggle('is-bad', !!sayText && !sayOk);
  }
  function rowNode(r) {
    var open = r.status === ST.OPEN, won = r.status === ST.WON, landed = won ? r.called : !r.called, pay = payOf(r.stake, r.x100);
    var mini = h('i', 'fl-mini ' + (open ? (r.called ? 'is-h' : 'is-t') : landed ? 'is-h' : 'is-t'), open ? (r.called ? 'H' : 'T') : landed ? 'H' : 'T');
    mini.setAttribute('aria-hidden', 'true');
    /* no wallet addresses in the feed (the owner, 2026-11-23): a flip is the player's own, or just a player's */
    var mine = r.you || (!S.demo && S.account && String(r.who).toLowerCase() === S.account.toLowerCase()), who = mine ? 'You' : 'A player';
    var left = h('span', 'fl-row-t', [h('b', null, who), h('i', null, [usd(r.stake) + ' on ' + sideWord(r.called), open ? null : h('span', 'fl-row-land', ' · ' + sideWord(landed) + ' landed')])]);
    var right = h('span', 'fl-row-r', [h('b', open ? 'sm-mute' : won ? 'sm-up' : 'sm-dn', open ? 'In the air' : won ? 'Won ' + usd(pay) : 'Lost ' + usd(r.stake)), h('i', null, ago(r.at))]);
    var href = S.demo ? '' : r.tx ? S.cfg.explorerUrl + '/tx/' + r.tx : S.cfg.explorerUrl + '/address/' + S.game;
    var n = href ? h('a', 'fl-row', [mini, left, right, h('span', 'fl-row-go', '›')]) : h('div', 'fl-row', [mini, left, right]);
    if (href) { n.href = href; n.target = '_blank'; n.rel = 'noopener'; n.setAttribute('aria-label', who + ' ' + (open ? 'flip in the air' : won ? 'won ' + usd(pay) : 'lost ' + usd(r.stake)) + '. ' + (r.tx ? 'Open the transaction' : 'Open the game on the explorer')); }
    if (r.you || (!S.demo && S.account && String(r.who).toLowerCase() === S.account.toLowerCase())) n.classList.add('is-you');
    if (r.isNew) { n.classList.add('is-new'); r.isNew = false; }
    return n;
  }
  function paintFeed() {
    var f = el.feed;
    show(el.live, S.feedState === 'rows' || S.feedState === 'empty');
    el.live.classList.toggle('is-demo', S.demo);
    if (el.liveWord) txt(el.liveWord, S.demo ? 'Demo' : 'Live');
    f.textContent = '';
    if (S.feedState === 'loading') { var sk = h('div', 'fl-skel'); for (var i = 0; i < 4; i++) add(sk, h('i')); add(f, sk); return; }
    if (S.feedState === 'error') { add(f, h('div', 'fl-feed-say', 'The recent flips could not be read just now. The page keeps trying.')); return; }
    if (S.feedState === 'empty') { add(f, h('div', 'fl-feed-say', 'No flips yet. Yours can be the first.')); return; }
    S.feed.forEach(function (r) { add(f, rowNode(r)); });
  }
  function paintHow() {
    var a = el.gameLink;
    if (!S.demo && isAddr(S.game)) { a.href = S.cfg.explorerUrl + '/address/' + S.game; show(a, true); } else show(a, false);
    var note = el.hypeNote;
    if (!S.demo && S.fee > 0n) { txt(note, 'Asking for the number takes about ' + hypeText(S.fee) + ' HYPE from your wallet with each flip; what is not needed comes straight back.'); show(note, true); } else show(note, false);
  }
  function paint() { paintTop(); paintMode(); paintForm(); paintResult(); paintKey(); paintHow(); el.root.classList.toggle('is-air', S.phase === 'air'); more(); }
  function more() { var m = el.main; el.root.classList.toggle('is-more', m.scrollHeight - m.clientHeight - m.scrollTop > 6); }

  /* ---- the amount field ---- */
  function setAmount(text, fromField) {
    var v = String(text).replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,2}).*$/, '$1');
    S.text = v; S.usd = Number(v) || 0;
    if (!fromField || el.amount.value !== v) el.amount.value = v;
    clearResult();
  }
  /* back to choosing: the last result leaves the screen and the coin lies on the side that is called */
  function clearResult() { if (S.phase === 'landed') { S.phase = 'idle'; S.last = null; coinShow(S.heads); } say(''); }

  /* ---- a flip, demo ---- */
  function demoSeed() {
    var who = ['0x7a3f9c1b2e4d5a6f8091a2b3c4d5e6f708192a3b', '0x1c9e44aa07b3d2f6e8a15c7d9b0e3f4a5c6d7e8f', '0x9b02d5e7f8a1c3b4d6e80f1a2c3d4e5f6a7b8c9d', '0x44e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3', '0xd3a87f6e5d4c3b2a19087f6e5d4c3b2a1908d3a8', '0x2f6b8c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b', '0xa81c5e7d9f0b2a4c6e8d0f1b3a5c7e9d1f3b5a7c'];
    var stakes = [5, 10, 1, 25, 10, 5, 2, 10, 25, 5], now = Date.now() / 1000, t = 14, rows = [];
    for (var i = 0; i < 6; i++) {
      var called = (i * 7 + 3) % 2 === 0, won = (i * 5 + 1) % 3 !== 0 ? i % 2 === 0 : i % 2 === 1;
      rows.push({ id: 100 - i, who: who[i % who.length], stake: stakes[i], x100: 196, called: called, status: won ? ST.WON : ST.LOST, at: now - t, tx: '' });
      t += 40 + i * 95;
    }
    S.feed = rows; S.feedState = 'rows'; S.demoWho = who; S.demoStakes = stakes; S.demoId = 101;
  }
  function demoDrip() {
    if (document.hidden || S.phase === 'air') return;
    var r = new Uint8Array(3); crypto.getRandomValues(r);
    S.feed.unshift({ id: S.demoId++, who: S.demoWho[r[0] % S.demoWho.length], stake: S.demoStakes[r[1] % S.demoStakes.length], x100: 196, called: (r[2] & 2) === 0, status: (r[2] & 1) === 0 ? ST.WON : ST.LOST, at: Date.now() / 1000, tx: '', isNew: true });
    S.feed = S.feed.slice(0, FEED_ROWS);
    paintFeed();
  }
  function demoFlip() {
    var stake = S.usd, called = S.heads, x100 = S.x100;
    S.bal = Math.round((S.bal - stake) * 100) / 100;
    S.phase = 'air'; S.slow = false; say(''); coinToss(); paint();
    var r = new Uint8Array(1); crypto.getRandomValues(r);
    var landed = (r[0] & 1) === 0, won = landed === called, payout = payOf(stake, x100);
    setTimeout(function () {
      coinLand(landed, function () {
        if (won) S.bal = Math.round((S.bal + payout) * 100) / 100;
        landedNow({ id: S.demoId++, won: won, heads: landed, called: called, stake: stake, payout: won ? payout : 0, x100: x100, tx: '' });
        S.feed.unshift({ id: S.last.id, who: '0xDE00000000000000000000000000000000000001', stake: stake, x100: x100, called: called, status: won ? ST.WON : ST.LOST, at: Date.now() / 1000, tx: '', isNew: true, you: true });
        S.feed = S.feed.slice(0, FEED_ROWS);
        paintFeed();
        if (S.bal < S.minBet) { S.bal = 100; say('Your demo wallet ran dry, so it was filled again: $100.00 of pretend money.', true); paint(); }
      });
    }, 1300 + Math.random() * 700);
  }
  function landedNow(last) {
    S.last = last; S.phase = 'landed'; S.popNow = true; S.pending = null;
    if (last.won) burst();
    paint();
  }

  /* ---- a flip, live ---- */
  function describe(e) {
    var m = String((e && (e.shortMessage || e.message)) || e || ''), name = e && e.revert && e.revert.name;
    if (e && (e.code === 4001 || e.code === 'ACTION_REJECTED') || /user (rejected|denied)|rejected the request/i.test(m)) return 'Cancelled in your wallet. Nothing was sent.';
    if (name === 'GamePaused') return 'Flips are paused right now. Nothing was taken.';
    if (name === 'BetTooLarge') return 'That is over the most a flip may be right now. Try a smaller amount.';
    if (name === 'BetTooSmall') return 'That is under the least a flip may be.';
    if (name === 'FeeTooLow') return 'What the random number costs just moved. Press Flip again.';
    if (name === 'TooEarly') return 'That flip can still get its number. Its stake can be taken back later.';
    if (/insufficient funds/i.test(m)) return 'Your wallet needs a little HYPE: for the network, and for the flip\'s random number.';
    if (e && e.code === -32002) return 'Your wallet is already asking you something. Open it and answer there.';
    return 'That did not go through. Nothing was taken. Try again in a moment.';
  }
  function signerGame() { return Promise.resolve().then(function () { var s = GW.signer(S.eth, S.account); return { s: s, g: new E.Contract(S.game, ABI, s), u: new E.Contract(S.cfg.contracts.usdc, ERC20, s) }; }); }
  function liveFlip() {
    var stake6 = to6(S.usd), called = S.heads, stake = S.usd, x100 = S.x100, tossed = false;
    S.phase = 'wallet'; say(''); paint();
    Promise.all([readGame(), readWallet()]).then(function () {
      var pr = problem();
      if (pr) { var er = new Error(pr.why || pr.key); er.plain = true; throw er; }
      x100 = S.x100;
      var need = S.fee * 5n / 4n;
      if (S.hype != null && S.hype < need + 200000000000000n) { var eh = new Error('Your wallet needs about ' + hypeText(need + 300000000000000n) + ' HYPE: for the network, and for the flip\'s random number.'); eh.plain = true; throw eh; }
      return signerGame();
    }).then(function (c) {
      if (S.allowance >= stake6) return c;
      return c.u.approve(S.game, E.MaxUint256).then(function (tx) { S.phase = 'allowing'; paint(); return tx.wait(); }).then(function () { S.allowance = E.MaxUint256; S.phase = 'wallet'; paint(); return c; });
    }).then(function (c) {
      var rnd = new Uint8Array(32); crypto.getRandomValues(rnd);
      return c.g.flip(called, stake6, E.hexlify(rnd), { value: S.fee * 5n / 4n });
    }).then(function (tx) {
      S.phase = 'sending'; paint();
      return tx.wait();
    }).then(function (rc) {
      var id = null, iface = game().interface;
      (rc.logs || []).forEach(function (l) { try { var p = iface.parseLog(l); if (p && p.name === 'FlipRequested') id = Number(p.args.id); } catch (e) { /* another contract's log */ } });
      if (id == null) throw new Error('The flip was sent but its number could not be read. Reload the page.');
      S.pending = { id: id, at: Math.round(now()), stake: stake, heads: called, x100: x100 };
      lsSet(OPEN_KEY + S.account.toLowerCase(), String(id));
      S.phase = 'air'; S.slow = false; S.airAt = Date.now(); tossed = true; coinToss(); paint();
      readWallet().then(rebase).then(paint);
      return waitResult(id);
    }).catch(function (e) {
      if (tossed) coinRest(called); else coinShow(called);
      S.phase = 'idle'; say(e && e.plain ? e.message : describe(e)); paint();
      readWallet().then(paint);
    });
  }
  /* the flip is on the chain: the coin stays in the air until the contract has settled it */
  function waitResult(id) {
    var g = game(), acct = S.account;
    return new Promise(function (resolve) {
      (function ask() {
        if (acct !== S.account || !S.pending || S.pending.id !== id) { resolve(); return; }
        g.getFlip(id).then(function (f) {
          var st = Number(f.status);
          if (st === ST.OPEN) {
            if (!S.slow && Date.now() - S.airAt > 45000) { S.slow = true; paint(); }
            setTimeout(ask, Date.now() - S.airAt > 60000 ? 4000 : 1100);
            return;
          }
          lsSet(OPEN_KEY + acct.toLowerCase(), null);
          if (st === ST.REFUNDED) { S.pending = null; S.phase = 'idle'; coinRest(S.heads); say('That flip\'s stake is back in your wallet.', true); readWallet().then(paint); paint(); resolve(); return; }
          var won = st === ST.WON, called = !!f.heads, landed = won ? called : !called, stake = from6(f.stake), x100 = Number(f.payoutX100);
          var row = flipRow(id, f); rowCache[id] = row;
          var finish = function () {
            landedNow({ id: id, won: won, heads: landed, called: called, stake: stake, payout: won ? payOf(stake, x100) : 0, x100: x100, tx: '' });
            Promise.all([readWallet().then(rebase), readGame(), readFeed()]).then(function () { paint(); paintFeed(); });
            resolve();
          };
          if (S.phase !== 'air') { S.phase = 'air'; coinToss(); }
          var early = 1200 - (Date.now() - (S.airAt || 0));
          setTimeout(function () { coinLand(landed, finish); }, Math.max(0, early));
        }, function () { setTimeout(ask, 2500); });
      })();
    });
  }
  /* a flip of this wallet that was still open when the page was left */
  function resume() {
    if (S.demo || !S.account) return Promise.resolve();
    var id = Number(lsGet(OPEN_KEY + S.account.toLowerCase()) || 0), acct = S.account;
    if (!id) return Promise.resolve();
    return game().getFlip(id).then(function (f) {
      if (acct !== S.account) return;
      if (Number(f.status) !== ST.OPEN || String(f.player).toLowerCase() !== acct.toLowerCase()) { lsSet(OPEN_KEY + acct.toLowerCase(), null); return; }
      adoptOpen({ id: id, at: Number(f.requestedAt), stake: from6(f.stake), heads: !!f.heads, x100: Number(f.payoutX100) });
    }).catch(function () { /* the next load tries again */ });
  }
  /* the page shows that flip: its side, its amount, the coin lying on the side that was called, and waits for its number */
  function adoptOpen(p) {
    S.pending = p; S.heads = p.heads; S.text = String(p.stake); S.usd = p.stake; el.amount.value = S.text; S.airAt = 0;
    if (COIN.mode === 'rest') coinRest(p.heads);
    waitResult(p.id);
  }
  function refund() {
    var p = S.pending;
    S.phase = 'wallet'; say(''); paint();
    signerGame().then(function (c) { return c.g.refund(p.id); }).then(function (tx) { S.phase = 'refunding'; paint(); return tx.wait(); }).then(function () {
      lsSet(OPEN_KEY + S.account.toLowerCase(), null);
      S.pending = null; S.phase = 'idle'; say('Your ' + usd(p.stake) + ' is back in your wallet.', true);
      return readWallet();
    }).catch(function (e) { S.phase = 'idle'; say(describe(e)); }).then(paint);
  }

  /* ---- Add money (live): other coins in, USDC in the wallet out ----
     The trading page's way (simple.js, Add money), cut to what a flip needs: the dollars land as USDC in the visitor's own wallet,
     where flips play from, so no order carries any call and the page keeps no share.
     - HYPE in this wallet: one transaction on HyperEVM to Relay's router, which swaps it and sends the USDC back.
     - ETH (Base, Arbitrum, Ethereum), USDT (Tron, Arbitrum, Ethereum), Bitcoin, or HYPE from somewhere else: Relay gives an address
       for this wallet; what is paid there arrives as USDC, with a little HYPE for the flips' own costs when the wallet has none.
     Every order is read before anything is shown or asked and refused unless it is the one asked for. */
  var RELAY = 'https://api.relay.link', ZERO = '0x0000000000000000000000000000000000000000';
  var HYPE_ROUTER = '0x0729e2a4716d9f7dd17858d5d504426d228697f7', MC = '0xcd6e13f7', SWEEP = '0x9bb43718';      /* Relay's router here; its multicall and cleanupErc20s */
  var DEP_EVM = '0x4cd00e387622c35bddb9b4c962c136462338bc31', RELAY_SOLVER = '0xf70da97812cb96acdf810712aa562db8dfa3dbef';
  var HYPE_KEEP = 20000000000000000n;       /* HYPE left in the wallet for flips (each takes the number's cost and its gas) */
  var HYPE_LOW = 30000000000000000n;        /* under this an address order brings a little HYPE along */
  var ADD_KEY = 'confetti.flip.add.', EVM_OK = /^0x[0-9a-fA-F]{40}$/;
  function evmK(chain, coin, sym, name, dec, showDec, eta) { return { evm: true, chain: chain, coin: coin, dep: DEP_EVM, sym: sym, name: name, dec: dec, show: showDec, min: 10, eta: eta, ok: EVM_OK }; }
  var AK = {
    btc: { chain: 8253038, coin: 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8', dep: 'bc1qzmtn0q92ayejt2hpffvlktcpmyy7vvsd06sefu', sym: 'BTC', name: 'Bitcoin', dec: 8, show: 5, min: 25, eta: 'about 20 minutes', ok: /^(bc1[02-9ac-hj-np-z]{20,80}|[13][1-9A-HJ-NP-Za-km-z]{25,39})$/ },
    tron: { chain: 728126428, coin: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', dep: 'TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN', sym: 'USDT', name: 'Tron', dec: 6, show: 2, min: 10, eta: 'a minute or two', ok: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },
    eth8453: evmK(8453, ZERO, 'ETH', 'Base', 18, 5, 'about a minute'), eth42161: evmK(42161, ZERO, 'ETH', 'Arbitrum', 18, 5, 'about a minute'), eth1: evmK(1, ZERO, 'ETH', 'Ethereum', 18, 5, 'a few minutes'),
    usdt42161: evmK(42161, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', 'USDT', 'Arbitrum', 6, 2, 'about a minute'), usdt1: evmK(1, '0xdac17f958d2ee523a2206206994597c13d831ec7', 'USDT', 'Ethereum', 6, 2, 'a few minutes'),
    hype: evmK(999, ZERO, 'HYPE', 'HyperEVM', 18, 3, 'about a minute')
  };
  /* the ways on the form. kinds: the address orders a way can be (its networks); none: paid from this wallet */
  var WAYS = [
    { key: 'hype', title: 'HYPE in this wallet', kinds: null },
    { key: 'eth', title: 'ETH', sub: 'Base, Arbitrum or Ethereum', kinds: ['eth8453', 'eth42161', 'eth1'] },
    { key: 'usdt', title: 'USDT', sub: 'Tron, Arbitrum or Ethereum', kinds: ['tron', 'usdt42161', 'usdt1'] },
    { key: 'btc', title: 'Bitcoin', sub: 'from any Bitcoin wallet', kinds: ['btc'] },
    { key: 'hypeA', title: 'HYPE from an exchange', sub: 'or from another wallet', kinds: ['hype'] }
  ];
  var ADD_CHIPS = [10, 25, 50, 100];
  var ADD = { sh: null, R: null, view: 'form', typed: '25', way: 'hype', net: { eth: 0, usdt: 0 }, refund: { tron: '', btc: '' }, q: null, err: '', busy: '', pend: null, px: null, pxAt: 0, seq: 0, qt: 0, tt: 0 };
  function lowS(x) { return String(x || '').toLowerCase(); }
  function getJson(url, body) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null, timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
    var opt = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { accept: 'application/json' } };
    if (ctrl) opt.signal = ctrl.signal;
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error((j && (j.message || j.errorMessage)) || ('answered ' + r.status)); e.api = j || {}; throw e; } return j; });
    }).then(function (j) { if (timer) clearTimeout(timer); return j; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }
  function plain(s) { var e = new Error(s); e.plain = true; return e; }
  function copyText(s, b) {
    var done = function () { if (b._was == null) b._was = b.textContent; b.textContent = 'Copied'; clearTimeout(b._t); b._t = setTimeout(function () { b.textContent = b._was; b._was = null; }, 1400); };
    function old() { try { var t = h('textarea'); t.value = s; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; (b.closest('dialog') || document.body).appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done(); } catch (e) { /* the text is on the screen */ } }
    try { navigator.clipboard.writeText(s).then(done, old); } catch (e) { old(); }
  }
  function drawQr(cv, text) {
    var go = function () {
      try {
        var q = window.ConfettiQR.create(text, { errorCorrectionLevel: 'M' }), n = q.modules.size, s = 6, pad = 3, c = cv.getContext('2d');
        cv.width = cv.height = (n + pad * 2) * s; c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height); c.fillStyle = '#000';
        for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (q.modules.get(y, x)) c.fillRect((x + pad) * s, (y + pad) * s, s, s);
      } catch (e) { cv.hidden = true; }
    };
    if (window.ConfettiQR) { go(); return; }
    var sc = document.createElement('script'); sc.src = 'qr.js?v=card1'; sc.async = true; sc.onload = go; sc.onerror = function () { cv.hidden = true; }; document.head.appendChild(sc);
  }
  /* exact: the digits to type, never a float's */
  function coinS(v, dec) { var s = String(BigInt(v)), i, f; while (s.length <= dec) s = '0' + s; i = s.length - dec; f = s.slice(i).replace(/0+$/, ''); return s.slice(0, i) + (f ? '.' + f : ''); }
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58d(s) {
    var n = 0n, i, z = 0; s = String(s);
    for (i = 0; i < s.length; i++) { var k = B58.indexOf(s[i]); if (k < 0) throw new Error('not base58'); n = n * 58n + BigInt(k); }
    while (z < s.length && s[z] === '1') z++;
    var hex = n === 0n ? '' : n.toString(16); if (hex.length % 2) hex = '0' + hex;
    var out = new Uint8Array(z + hex.length / 2); for (i = 0; i < hex.length / 2; i++) out[z + i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function tronOk(s) {
    try { var b = b58d(s); if (!AK.tron.ok.test(s) || b.length !== 25 || b[0] !== 0x41) return false; var c = E.getBytes(E.sha256(E.sha256(b.slice(0, 21)))); return c[0] === b[21] && c[1] === b[22] && c[2] === b[23] && c[3] === b[24]; } catch (e) { return false; }
  }
  /* the prices the form works a coin amount from: Hyperliquid's own mids (config.json hyperliquidInfoUrl), asked again after 30 s */
  function readPx() {
    if (ADD.px && Date.now() - ADD.pxAt < 30000) return Promise.resolve(ADD.px);
    return getJson(S.cfg.hyperliquidInfoUrl || 'https://api.hyperliquid.xyz/info', { type: 'allMids' }).then(function (j) {
      var p = { BTC: Number(j.BTC), ETH: Number(j.ETH), HYPE: Number(j.HYPE), USDT: 1 };
      if (!(p.BTC > 0 && p.ETH > 0 && p.HYPE > 0)) throw new Error('prices');
      ADD.px = p; ADD.pxAt = Date.now(); return p;
    });
  }
  function addWay() { return WAYS.filter(function (w) { return w.key === ADD.way; })[0] || WAYS[0]; }
  function addKind() { var w = addWay(); return w.kinds ? w.kinds[Math.min(w.kinds.length - 1, ADD.net[w.key] || 0)] : null; }
  function addUsd() { return Number(ADD.typed) || 0; }
  function addMin() { var k = addKind(); return k ? AK[k].min : 5; }
  function hypeSpare() { return S.hype == null ? null : S.hype > HYPE_KEEP ? S.hype - HYPE_KEEP : 0n; }
  function needRefund(k) { return k === 'tron'; }                 /* Tron has no "the wallet that paid": a refund needs an address */
  function refundOf(k) { return k === 'tron' || k === 'btc' ? String(ADD.refund[k] || '').trim() : ''; }
  function refundOk(k) { var r = refundOf(k); return !r ? !needRefund(k) : k === 'tron' ? tronOk(r) : AK.btc.ok.test(r); }
  /* a little HYPE with an address order when the wallet has next to none: a flip cannot be sent without it */
  function topUsd(usdAmt) { return S.hype != null && S.hype >= HYPE_LOW ? 0 : usdAmt >= 20 ? 2 : 1; }

  /* HYPE in the wallet -> exactly these dollars of USDC, same chain. Refused unless: HyperEVM; Relay's router; HYPE in, paid as the
     value; at least these dollars out; the wallet as the recipient; and every sweep the router makes going to the wallet. */
  function hypeOk(data, account) {
    var co = E.AbiCoder.defaultAbiCoder(), calls, sweeps = 0;
    try { if (lowS(data).slice(0, 10) !== MC) return false; calls = co.decode(['(address,bool,uint256,bytes)[]', 'address', 'address', 'bytes'], '0x' + String(data).slice(10))[0]; } catch (e) { return false; }
    var back = Array.from(calls).every(function (x) {
      if (lowS(x[0]) !== HYPE_ROUTER || lowS(x[3]).slice(0, 10) !== SWEEP) return true;
      sweeps++;
      try { var to = co.decode(['address[]', 'address[]', 'uint256[]', 'bytes'], '0x' + String(x[3]).slice(10))[1]; return to.length > 0 && Array.from(to).every(function (a) { return lowS(a) === lowS(account); }); } catch (e) { return false; }
    });
    return back && sweeps > 0;
  }
  function orderHype(account, gross6) {
    var b = { user: account, recipient: account, refundTo: account, originChainId: Number(S.cfg.chainId), destinationChainId: Number(S.cfg.chainId), originCurrency: ZERO, destinationCurrency: S.cfg.contracts.usdc, amount: String(gross6), tradeType: 'EXACT_OUTPUT', slippageTolerance: '50' };
    return getJson(RELAY + '/quote/v2', b).then(function (j) {
      var d = j.details || {}, st = j.steps || [], it = st.length === 1 && st[0].items && st[0].items.length === 1 ? st[0].items[0] : null, tx = it && it.data;
      if (!tx || !d.currencyIn || !d.currencyOut) throw new Error('unexpected quote');
      var cin = d.currencyIn.currency || {}, cout = d.currencyOut.currency || {}, min = BigInt(d.currencyOut.minimumAmount || 0), chain = Number(S.cfg.chainId);
      if (Number(tx.chainId) !== chain || lowS(tx.to) !== HYPE_ROUTER || lowS(cin.address) !== ZERO || Number(cin.chainId) !== chain || lowS(cout.address) !== lowS(S.cfg.contracts.usdc) || Number(cout.chainId) !== chain
        || String(tx.value) !== String(d.currencyIn.amount) || min < gross6 || lowS(d.recipient) !== lowS(account) || !hypeOk(tx.data, account)) throw new Error('quote does not match the order');
      var usdIn = Number(d.currencyIn.amountUsd), px = ADD.px && ADD.px.HYPE;
      /* the HYPE it costs held against the page's own price: never more than 4% over these dollars */
      if (px > 0 && Number(tx.value) / 1e18 * px > Number(gross6) / 1e6 * 1.04 + 0.05) throw new Error('quote does not match the order');
      return { rail: 'hype', usd: usdIn, payWei: BigInt(tx.value), gross6: gross6, net: Number(gross6) / 1e6, to: tx.to, data: tx.data, gas: BigInt(tx.gas || 0), id: st[0].requestId };
    });
  }
  function quoteHype(account, usdAmt) {
    var g0 = BigInt(Math.max(1, Math.floor(usdAmt * 0.985 * 1e6)));
    return orderHype(account, g0).then(function (q) {
      if (Math.abs(q.usd - usdAmt) < 0.02) return q;
      return orderHype(account, g0 + BigInt(Math.round((usdAmt - q.usd) * 0.99 * 1e6)));      /* one correction lands on the typed dollars */
    });
  }
  /* an address of Relay's for this wallet. Refused unless: a fresh address of the right kind (never the wallet's own, Relay's
     depository, solver or router); this coin, this network, this amount; USDC on HyperEVM out, to the wallet and nobody else; no
     calls; every refund to the wallet or the address given; the HYPE top-up there when asked; and about these dollars landing. */
  function orderAddr(o) {
    var k = AK[o.kind], amt = BigInt(Math.round(o.usd / o.px * Math.pow(10, k.show))) * 10n ** BigInt(k.dec - k.show), user = k.evm ? o.account : o.refund || (o.kind === 'btc' ? k.coin : '');
    if (!user || !(amt > 0n)) return Promise.reject(plain('Type an address a refund can go to.'));
    var usdc = S.cfg.contracts.usdc, chain = Number(S.cfg.chainId);
    var b = { user: user, recipient: o.account, refundTo: user, originChainId: k.chain, destinationChainId: chain, originCurrency: k.coin, destinationCurrency: usdc, amount: String(amt), tradeType: 'EXACT_INPUT', useDepositAddress: true };
    if (o.topUsd > 0) { b.topupGas = true; b.topupGasAmount = String(Math.round(o.topUsd * 1e6)); }
    return getJson(RELAY + '/quote/v2', b).then(function (j) {
      var d = j.details || {}, st = (j.steps || [])[0] || {}, dep = String(st.depositAddress || ''), v2 = (j.protocol || {}).v2 || {}, od = v2.orderData || {}, out = od.output || {}, pd = v2.paymentDetails || {};
      if (!dep || !st.requestId || !d.currencyIn || !d.currencyOut) throw new Error('unexpected quote');
      var cin = d.currencyIn.currency || {}, cout = d.currencyOut.currency || {}, got = BigInt(d.currencyOut.amount || 0), inUsd = Number(amt) / Math.pow(10, k.dec) * o.px, pays = out.payments || [];
      var refunds = (od.inputs || []).every(function (inp) { return (inp.refunds || []).every(function (r) { return /^0x/.test(String(r.recipient)) ? lowS(r.recipient) === lowS(o.account) : !o.refund || String(r.recipient) === o.refund; }); });
      var ok = (o.kind === 'tron' ? tronOk(dep) : k.ok.test(dep)) && lowS(dep) !== lowS(k.dep) && (!k.evm || (lowS(dep) !== lowS(o.account) && lowS(dep) !== RELAY_SOLVER && lowS(dep) !== HYPE_ROUTER))
        && String(d.currencyIn.amount) === String(amt) && String(pd.amount) === String(amt)
        && (k.evm ? lowS(pd.depository) === k.dep && lowS(pd.currency) === lowS(k.coin) && lowS(cin.address) === lowS(k.coin) : pd.depository === k.dep && cin.address === k.coin)
        && Number(cin.chainId) === k.chain && lowS(cout.address) === lowS(usdc) && Number(cout.chainId) === chain && lowS(d.recipient) === lowS(o.account)
        && pays.length >= 1 && pays.every(function (p) { return lowS(p.recipient) === lowS(o.account) && lowS(p.currency) === lowS(usdc); }) && Array.isArray(out.calls) && out.calls.length === 0
        && refunds && (!(o.topUsd > 0) || !!d.currencyGasTopup)
        && Number(got) / 1e6 <= inUsd * 1.02 && Number(got) / 1e6 >= inUsd - Math.max(8, inUsd * 0.06);
      if (!ok) throw new Error('quote does not match the order');
      if (Number(got) / 1e6 < inUsd * 0.7) throw plain('That is too little to send this way. Try a bit more.');
      return { rail: 'addr', kind: o.kind, usd: inUsd, amt: amt, net: Number(got) / 1e6, addr: dep, id: st.requestId, refund: o.refund || '', top: o.topUsd > 0 };
    });
  }
  function relayState(id) {
    return getJson(RELAY + '/intents/status/v3?requestId=' + encodeURIComponent(id)).then(function (j) {
      var s = j && j.status;
      return s === 'success' ? 'done' : s === 'refund' ? 'refunded' : s === 'failure' ? 'failed' : s === 'pending' || s === 'submitted' ? 'moving' : 'sent';
    });
  }
  function addSay(e) {
    if (e && e.plain) return e.message;
    var code = e && e.api && e.api.errorCode;
    if (code === 'AMOUNT_TOO_LOW') return 'That is too little to send. Try a bit more.';
    if (code === 'AMOUNT_TOO_HIGH') return 'That is more than can be sent in one go. Try a smaller amount.';
    return 'There is no price for that right now. Try again in a minute.';
  }
  /* the form's quote: asked a moment after the last change, and only the newest answer counts */
  function addKey() { var k = addKind(); return [S.account, ADD.way, k || '', addUsd(), k ? refundOf(k) : ''].join('|'); }
  function scheduleQuote(ms) { clearTimeout(ADD.qt); ADD.seq++; ADD.q = null; ADD.qt = setTimeout(quoteAdd, ms == null ? 500 : ms); }
  function quoteAdd() {
    var seq = ++ADD.seq, k = addKind(), usdAmt = addUsd(), acct = S.account, key = addKey();
    if (!acct || ADD.view !== 'form' || !(usdAmt >= addMin()) || usdAmt > 5000 || (k && !refundOk(k)) || (!k && hypeSpare() === 0n)) { ADD.busy = ''; fillAdd(); return Promise.resolve(); }
    ADD.busy = 'quote'; ADD.err = ''; fillAdd();
    return readPx().then(function (px) {
      return k ? orderAddr({ kind: k, usd: usdAmt, px: px[AK[k].sym], account: acct, refund: refundOf(k), topUsd: k === 'hype' ? 0 : topUsd(usdAmt) }) : quoteHype(acct, usdAmt);
    }).then(function (q) { if (seq !== ADD.seq) return; q.key = key; q.at = Date.now(); ADD.q = q; ADD.err = ''; }, function (e) { if (seq !== ADD.seq) return; ADD.q = null; ADD.err = addSay(e); })
      .then(function () { if (seq === ADD.seq) { ADD.busy = ''; fillAdd(); } });
  }
  function freshQuote() { return ADD.q && ADD.q.key === addKey() && Date.now() - ADD.q.at < 45000 ? Promise.resolve(ADD.q) : quoteAdd().then(function () { return ADD.q; }); }

  /* a payment to an address, remembered on this device until it lands */
  function savePend() { if (S.account) lsSet(ADD_KEY + S.account.toLowerCase(), ADD.pend ? JSON.stringify(ADD.pend) : null); }
  function loadPend() {
    ADD.pend = null; clearTimeout(ADD.tt);
    if (S.demo || !S.account) return;
    try { var p = JSON.parse(lsGet(ADD_KEY + S.account.toLowerCase()) || 'null'); if (p && AK[p.kind] && p.addr && p.id && Date.now() - p.since < 7 * 86400000) ADD.pend = p; } catch (e) { /* none */ }
    if (ADD.pend) trackAdd();
  }
  function dropPend() { ADD.pend = null; clearTimeout(ADD.tt); savePend(); }
  /* a flip moved the wallet's USDC: what a waiting payment is measured from moves with it */
  function rebase() { var p = ADD.pend; if (p && S.bal != null && p.bal1 != null) { p.usdc0 += S.bal - p.bal1; p.bal1 = S.bal; savePend(); } }
  function trackAdd() {
    clearTimeout(ADD.tt);
    var p = ADD.pend; if (!p) return;
    var again = function () { ADD.tt = setTimeout(trackAdd, p.seen || Date.now() - p.since < 1800000 ? 6000 : 20000); };
    if (document.hidden) { again(); return; }
    Promise.all([relayState(p.id).catch(function () { return null; }), readWallet()]).then(function (x) {
      if (ADD.pend !== p) return;
      var st = x[0], got = S.bal != null && p.usdc0 != null ? Math.round((S.bal - p.usdc0) * 100) / 100 : 0;
      p.bal1 = S.bal;
      if (st === 'moving' || st === 'done') p.seen = p.seen || Date.now();
      if (st === 'refunded') { dropPend(); addDone('That payment could not be added and was sent back.', false); return; }
      /* landed: the wallet's dollars rose after the payment was seen (a short payment is credited for what it is), or about the
         expected dollars came, or Relay says the order is done */
      if ((got >= 0.5 && (p.seen || got >= p.net * 0.5)) || st === 'done') { dropPend(); addDone(usd(got >= 0.5 ? got : p.net) + ' is in your wallet. Ready to flip.', true); return; }
      p.state = st === 'failed' ? 'failed' : p.seen ? 'seen' : 'waiting'; savePend(); again();
      if (ADD.sh && ADD.sh.isOpen && ADD.view === 'pay') fillPay();
      paintForm();
    });
  }
  function addDone(text, ok) {
    ADD.view = 'form'; ADD.q = null; ADD.err = ''; ADD.busy = '';
    if (ADD.sh && ADD.sh.isOpen) ADD.sh.close();
    if (S.phase === 'idle' || S.phase === 'landed') say(text, ok);
    readWallet().then(paint); paint();
  }

  function openAdd() {
    if (S.demo) return;
    if (!S.account) { connect(false); return; }
    var sh = ADD.sh || (ADD.sh = makeSheet('Add'));
    if (!ADD.pend) {
      var lack = S.bal != null && S.usd > S.bal ? Math.ceil(S.usd - S.bal) : 0;
      if (lack > 0) ADD.typed = String(Math.max(10, lack));
      /* HYPE in the wallet is the one-tap way; without any to spare the form opens on ETH */
      ADD.way = hypeSpare() > 0n ? 'hype' : ADD.way === 'hype' ? 'eth' : ADD.way;
    }
    ADD.view = ADD.pend ? 'pay' : 'form'; ADD.err = ''; ADD.busy = '';
    paintAdd(); sh.open();
    readWallet().then(function () { if (sh.isOpen && ADD.view === 'form') fillAdd(); });
    if (ADD.view === 'form') scheduleQuote(0); else trackAdd();
  }
  function paintAdd() { var sh = ADD.sh; sh.body.textContent = ''; sh.foot.textContent = ''; ADD.R = {}; if (ADD.view === 'pay' && ADD.pend) { buildPay(); fillPay(); } else { ADD.view = 'form'; buildAddForm(); fillAdd(); } }
  function buildAddForm() {
    var sh = ADD.sh, r = ADD.R;
    txt(sh.title, 'Add money');
    r.amt = h('input'); r.amt.id = 'flAddAmount'; r.amt.type = 'text'; r.amt.inputMode = 'decimal'; r.amt.maxLength = 7; r.amt.placeholder = '0'; r.amt.value = ADD.typed; r.amt.setAttribute('autocomplete', 'off'); r.amt.setAttribute('aria-label', 'Dollars to add');
    r.amt.addEventListener('input', function () { var v = r.amt.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,2}).*$/, '$1'); if (r.amt.value !== v) r.amt.value = v; ADD.typed = v; ADD.err = ''; fillAdd(); scheduleQuote(); });
    r.chips = h('div', 'sm-chips fl-chips fl-addchips');
    ADD_CHIPS.forEach(function (v) { var b = btn(null, '$' + v, function () { ADD.typed = String(v); r.amt.value = ADD.typed; ADD.err = ''; fillAdd(); scheduleQuote(0); }); b._v = v; r.chips.appendChild(b); });
    r.ways = h('div', 'sm-ways'); r.ways.setAttribute('role', 'radiogroup'); r.ways.setAttribute('aria-label', 'Pay with');
    r.way = {};
    WAYS.forEach(function (w) {
      var sub = h('i'), b = btn('sm-pick', [h('span', 'sm-radio'), h('span', 'sm-t', [h('b', null, w.title), sub])], function () {
        if (w.key === 'hype' && hypeSpare() === 0n) return;
        ADD.way = w.key; ADD.err = ''; fillAdd(); scheduleQuote(0);
      });
      b.setAttribute('role', 'radio'); r.way[w.key] = { n: b, sub: sub }; r.ways.appendChild(b);
    });
    r.net = h('div', 'sm-seg2 is-net'); r.net.setAttribute('role', 'group'); r.net.setAttribute('aria-label', 'Network');
    [0, 1, 2].forEach(function (i) { var b = btn(null, '', function () { ADD.net[ADD.way] = i; ADD.err = ''; fillAdd(); scheduleQuote(0); }); r.net.appendChild(b); });
    r.ref = h('input', 'sm-field'); r.ref.type = 'text'; r.ref.maxLength = 90; r.ref.setAttribute('autocomplete', 'off'); r.ref.setAttribute('autocapitalize', 'off'); r.ref.setAttribute('spellcheck', 'false'); r.ref.setAttribute('aria-label', 'Refund address');
    r.ref.addEventListener('input', function () { var k = addKind(); if (k !== 'tron' && k !== 'btc') return; ADD.refund[k] = r.ref.value.trim(); ADD.err = ''; fillAdd(); scheduleQuote(700); });
    r.refLab = h('p', 'sm-fine', ''); r.refBox = h('div', 'sm-refbox', [r.refLab, r.ref]);
    r.get = h('span', 'is-go', ''); r.cost = h('span', null, ''); r.costLab = h('span', null, ''); r.eta = h('span', null, '');
    r.sum = h('div', 'sm-sum', [h('div', 'sm-sumrow', [h('span', null, 'Lands in your wallet'), r.get]), h('div', 'sm-sumrow', [r.costLab, r.cost]), h('div', 'sm-sumrow', [h('span', null, 'Ready in'), r.eta])]);
    r.fine = h('p', 'sm-fine', ''); r.say = h('p', 'sm-say fl-addsay', ''); r.say.setAttribute('role', 'status');
    add(sh.body, [h('div', 'sm-label', 'Amount'), h('label', 'sm-amt is-mid', [h('span', null, '$'), r.amt]), r.chips, h('div', 'sm-label', 'Pay with'), r.ways, r.net, r.refBox, r.sum, r.fine]);
    r.go = btn('sm-btn is-primary', '', addGo);
    add(sh.foot, [r.say, r.go]);
  }
  function fillAdd() {
    var r = ADD.R; if (!r || !r.go || ADD.view !== 'form') return;
    var w = addWay(), k = addKind(), usdAmt = addUsd(), q = ADD.q && ADD.q.key === addKey() ? ADD.q : null, spare = hypeSpare(), min = addMin(), busy = ADD.busy;
    Array.prototype.forEach.call(r.chips.children, function (b) { b.setAttribute('aria-pressed', Math.abs(b._v - usdAmt) < 0.005 ? 'true' : 'false'); });
    WAYS.forEach(function (x) {
      var n = r.way[x.key], on = x.key === ADD.way, off = x.key === 'hype' && spare === 0n;
      n.n.setAttribute('aria-checked', on ? 'true' : 'false'); n.n.classList.toggle('is-off', off); n.n.disabled = !!busy && busy !== 'quote';
      txt(n.sub, x.key !== 'hype' ? x.sub : S.hype == null ? 'one confirmation' : off ? 'This wallet has none to spare' : 'You hold ' + hypeText(S.hype) + ' HYPE. One confirmation.');
    });
    show(r.net, !!(w.kinds && w.kinds.length > 1));
    if (w.kinds && w.kinds.length > 1) Array.prototype.forEach.call(r.net.children, function (b, i) { txt(b, AK[w.kinds[i]].name); b.setAttribute('aria-pressed', (ADD.net[w.key] || 0) === i ? 'true' : 'false'); });
    var ref = k === 'tron' || k === 'btc';
    show(r.refBox, ref);
    if (ref) {
      txt(r.refLab, k === 'tron' ? 'Your own USDT address on Tron: if a payment cannot be added, it goes back there.' : 'Paying from an exchange? Type a Bitcoin address of your own for a refund. From your own wallet, leave this empty.');
      r.ref.placeholder = k === 'tron' ? 'T…' : 'bc1… (optional)';
      if (r.ref._k !== k) { r.ref._k = k; r.ref.value = ADD.refund[k] || ''; }
      r.ref.classList.toggle('is-bad', !!refundOf(k) && !refundOk(k));
    }
    var K = k ? AK[k] : null;
    txt(r.get, q ? 'about ' + usd(q.net) : '—');
    txt(r.costLab, k ? 'You send' : 'It costs');
    txt(r.cost, q ? (k ? coinS(q.amt, K.dec) + ' ' + K.sym : hypeText(q.payWei) + ' HYPE') : '—');
    txt(r.eta, k ? K.eta + ' after you pay' : 'a few seconds');
    txt(r.fine, k ? 'You get an address' + (K.sym === 'HYPE' ? '' : ' on ' + K.name) + ' to send ' + K.sym + ' to, from an exchange or any wallet. It arrives as USDC in your wallet ' + short(S.account) + (q && q.top ? ', with a little HYPE for your flips.' : '.')
      : 'Your HYPE is swapped for USDC in one transaction, and the USDC stays in your wallet. ' + hypeText(HYPE_KEEP) + ' HYPE is always left for your flips.');
    var label, dis = false, sayText = ADD.err, tooMuch = !k && q && spare != null && q.payWei > spare;
    if (busy === 'wallet') { label = 'Confirm in your wallet…'; dis = true; }
    else if (busy === 'sending') { label = 'Adding…'; dis = true; }
    else if (!(usdAmt > 0)) { label = 'Type an amount'; dis = true; }
    else if (usdAmt < min) { label = 'The least is ' + usdShort(min); dis = true; }
    else if (usdAmt > 5000) { label = 'The most is $5,000'; dis = true; }
    else if (k && !refundOk(k)) { label = refundOf(k) ? 'Check the refund address' : 'Type your refund address'; dis = true; }
    else if (busy === 'quote') { label = 'One moment…'; dis = true; }
    else if (tooMuch) { label = 'Not enough HYPE'; dis = true; sayText = 'Your wallet can spare ' + hypeText(spare) + ' HYPE. Try a smaller amount, or pay another way.'; }
    else if (ADD.err || !q) { label = 'Try again'; }
    else if (!S.chainOk && !k) { label = 'Switch to HyperEVM'; }
    else label = k ? 'Show the address' : 'Add ' + usd(q.net) + ' with HYPE';
    txt(r.go, label); r.go.disabled = dis; r.go.classList.toggle('is-busy', busy === 'wallet' || busy === 'sending' || busy === 'quote');
    txt(r.say, sayText); r.say.classList.toggle('is-bad', !!sayText);
  }
  function addGo() {
    var k = addKind();
    if (ADD.busy) return;
    if (ADD.err || !ADD.q || ADD.q.key !== addKey()) { ADD.err = ''; scheduleQuote(0); return; }
    if (k) { startPay(); return; }
    payHype();
  }
  function payHype() {
    var acct = S.account;
    ADD.busy = 'wallet'; ADD.err = ''; fillAdd();
    (S.chainOk ? Promise.resolve() : switchChain()).then(function () { return Promise.all([freshQuote(), readWallet()]); }).then(function (x) {
      var q = x[0], spare = hypeSpare();
      if (!q || q.rail !== 'hype') throw plain(ADD.err || 'There is no price for that right now. Try again in a minute.');
      if (acct !== S.account) throw plain('The wallet changed. Nothing was sent.');
      if (spare != null && q.payWei > spare) throw plain('Your wallet can spare ' + hypeText(spare) + ' HYPE. Try a smaller amount.');
      ADD.busy = 'wallet'; fillAdd();
      return Promise.resolve(GW.signer(S.eth, S.account)).then(function (s) {
        var tx = { to: q.to, data: q.data, value: q.payWei };
        if (q.gas > 0n) tx.gasLimit = q.gas * 13n / 10n;
        return s.sendTransaction(tx);
      }).then(function (tx) { ADD.busy = 'sending'; fillAdd(); return tx.wait(); }).then(function (rc) {
        if (!rc || rc.status !== 1) throw plain('That did not go through. Nothing was taken but the network fee.');
        return readWallet().then(function () { rebase(); addDone(usd(q.net) + ' is in your wallet. Ready to flip.', true); });
      });
    }).catch(function (e) { ADD.busy = ''; ADD.err = e && e.plain ? e.message : describe(e); fillAdd(); });
  }
  function startPay() {
    var q = ADD.q, k = AK[q.kind];
    ADD.pend = { kind: q.kind, addr: q.addr, id: q.id, amt: coinS(q.amt, k.dec), net: q.net, refund: q.refund, top: q.top, since: Date.now(), usdc0: S.bal, bal1: S.bal, seen: 0, state: 'waiting' };
    savePend(); ADD.q = null; ADD.view = 'pay'; paintAdd(); paintForm(); trackAdd();
  }
  function step(box) { var s = { n: h('div', 'sm-st'), m: h('span', 'sm-m', '✓'), b: h('b'), i: h('i') }; add(s.n, [s.m, h('span', null, [s.b, s.i])]); box.appendChild(s.n); return s; }
  function setStep(s, state, b, i) { s.n.className = 'sm-st is-' + state; txt(s.b, b); txt(s.i, i); }
  function buildPay() {
    var sh = ADD.sh, r = ADD.R, p = ADD.pend, k = AK[p.kind], box = h('div', 'sm-steps is-tight');
    txt(sh.title, 'Send ' + (k.sym === 'BTC' ? 'Bitcoin' : k.sym) + (k.sym === 'HYPE' || k.sym === 'BTC' ? '' : ' on ' + k.name));
    r.cAmt = btn('sm-copy', 'Copy', function () { copyText(p.amt, r.cAmt); }); r.cAmt.setAttribute('aria-label', 'Copy the amount');
    r.qr = h('canvas', 'sm-qr'); r.qr.setAttribute('role', 'img'); r.qr.setAttribute('aria-label', 'QR code of the address');
    drawQr(r.qr, p.kind === 'btc' ? 'bitcoin:' + p.addr + '?amount=' + p.amt : p.addr);
    r.s = [step(box), step(box), step(box)];
    r.fine = h('p', 'sm-fine', '');
    r.stop = btn('sm-link', 'Cancel: I have not paid', function () { dropPend(); ADD.view = 'form'; paintAdd(); paintForm(); scheduleQuote(0); });
    add(sh.body, [h('div', 'sm-label', 'Send'), h('div', 'sm-payrow', [h('div', 'sm-big is-mid sm-payamt', [p.amt, h('small', null, ' ' + k.sym)]), r.cAmt]),
      h('div', 'sm-label', 'To this address' + (k.sym === 'BTC' ? '' : ', on ' + k.name)), h('div', 'sm-addr', p.addr), r.qr, box, r.fine, h('div', 'sm-links', [r.stop])]);
    r.go = btn('sm-btn is-primary', 'Copy address', function () { copyText(p.addr, r.go); });
    add(sh.foot, r.go);
    sh.body.scrollTop = 0;
  }
  function fillPay() {
    var r = ADD.R, p = ADD.pend; if (!p || !r || !r.s) return;
    var k = AK[p.kind], seen = !!p.seen, failed = p.state === 'failed';
    var back = p.refund ? 'your address …' + p.refund.slice(-4) : k.evm ? 'your wallet ' + short(S.account) + ' on ' + k.name : 'the wallet that paid';
    setStep(r.s[0], seen ? 'done' : 'now', seen ? 'Payment seen' : 'Waiting for your payment', seen ? 'It is on the ' + k.name + ' network' : 'Pay from ' + (p.kind === 'btc' && !p.refund ? 'a Bitcoin wallet of your own' : 'an exchange or any wallet') + '. This page sees it by itself.');
    setStep(r.s[1], seen ? 'now' : 'later', k.name + ' confirms it', failed ? 'This one has not gone through yet. The page keeps looking.' : seen ? 'Arriving in your wallet…' : 'Usually ' + k.eta + ' after you pay');
    setStep(r.s[2], 'later', 'About ' + usd(p.net) + ' of USDC lands in your wallet ' + short(S.account), p.top ? 'With a little HYPE for your flips. Then flip.' : 'Then flip.');
    txt(r.fine, 'Any amount works: you get what it is worth when it arrives. A payment too small to send on goes back to ' + back + ', less what sending it back costs.'
      + (p.kind === 'btc' && !p.refund ? ' Do not pay this one from an exchange: a payment from an exchange that cannot be added is not sent back by itself.' : '') + ' You can close this: the page shows it when it lands.');
    show(r.stop, !seen);
  }

  /* ---- the one key ---- */
  function press() {
    if (S.phase !== 'idle' && S.phase !== 'landed') return;
    if (!S.demo && !S.account) { connect(false); return; }
    if (!S.demo && !S.chainOk) { S.phase = 'wallet'; S.wstep = 'Switching to HyperEVM…'; say(''); paint(); switchChain().catch(function (e) { say(e && e.plain ? e.message : describe(e)); }).then(function () { S.wstep = ''; S.phase = 'idle'; paint(); }); return; }
    if (S.pending && !S.demo) { if (now() >= S.pending.at + S.refundDelay) refund(); return; }
    S.touched = true;
    var pr = problem();
    if (pr && pr.add) { openAdd(); return; }
    if (pr) { paint(); return; }
    S.last = null;
    if (S.demo) demoFlip(); else liveFlip();
  }
  function shareWin() {
    var L = S.last;
    if (!L || !L.won || !window.ConfettiShare) return;
    window.ConfettiShare.open({ sym: 'FLIP', side: 'long', sideWord: L.heads ? 'HEADS' : 'TAILS', lev: L.x100 / 100, margin: L.stake, pnl: Math.round((L.payout - L.stake) * 100) / 100, account: S.demo ? '' : S.account,
      lines: ['Coin flip', 'Heads or tails', 'Fully onchain on hyperliquid'] }, { key: 'flip:' + L.id + ':' + L.stake, title: 'Share your win' });
  }

  /* ---- start ---- */
  function fitViewport() {
    var vv = window.visualViewport, r = el.root;
    if (!vv) return;
    var kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    if (kb > 80) { r.style.bottom = 'auto'; r.style.top = vv.offsetTop + 'px'; r.style.height = vv.height + 'px'; if (document.activeElement === el.amount && el.amount.scrollIntoView) el.amount.scrollIntoView({ block: 'center' }); }
    else { r.style.removeProperty('bottom'); r.style.removeProperty('top'); r.style.removeProperty('height'); }
    more();
  }
  function wire() {
    el.headsKey.addEventListener('click', function () { if (S.heads) return; S.heads = true; clearResult(); coinShow(true); paint(); });
    el.tailsKey.addEventListener('click', function () { if (!S.heads) return; S.heads = false; clearResult(); coinShow(false); paint(); });
    el.amount.addEventListener('input', function () { setAmount(el.amount.value, true); paint(); });
    el.amount.addEventListener('blur', function () { S.touched = true; paint(); });
    el.amount.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); el.amount.blur(); } });
    el.amount.addEventListener('focus', function () { setTimeout(function () { try { el.amount.select(); } catch (e) { /* fine */ } }, 0); });
    el.amt.addEventListener('click', function (ev) { if (ev.target !== el.amount) el.amount.focus(); });
    Array.prototype.forEach.call(el.chips.children, function (b) { b.addEventListener('click', function () { S.touched = true; setAmount(b.getAttribute('data-usd')); paint(); }); });
    el.most.addEventListener('click', function (ev) { ev.preventDefault(); var m = limit(); if (m != null) { S.touched = true; setAmount(String(Math.floor(m * 100) / 100)); paint(); } });
    el.go.addEventListener('click', press);
    el.share.addEventListener('click', shareWin);
    el.menu.addEventListener('click', openMenu);
    el.who.addEventListener('click', openMenu);
    el.main.addEventListener('scroll', more, { passive: true });
    window.addEventListener('resize', function () { coinPaint(); more(); });
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitViewport); window.visualViewport.addEventListener('scroll', fitViewport); }
    document.addEventListener('visibilitychange', function () { if (!document.hidden && !S.demo && S.ready) tick(); });
  }
  /* every 10 s the feed (one read, and one more for each flip not seen before); every third time the game's numbers and the
     wallet's too. Nothing is asked while the page is not on screen. */
  var ticks = 0;
  function tick() {
    if (S.demo || document.hidden) return;
    var all = ticks++ % 3 === 0, jobs = [readFeed()];
    if (all) jobs.push(readGame().then(function () { S.readErr = false; }, function () { S.readErr = true; }), readWallet());
    Promise.all(jobs).then(function () { paint(); paintFeed(); }, function () { paint(); paintFeed(); });
  }
  function start(cfg) {
    var q = null;
    try { q = new URLSearchParams(location.search); } catch (e) { q = null; }
    S.cfg = cfg || {};
    S.game = cfg && cfg.contracts && isAddr(cfg.contracts.coinFlip) ? cfg.contracts.coinFlip : '';
    S.soon = !S.game;
    S.demo = !!(S.soon || !E || (q && q.get('demo') === '1'));
    if (S.demo) {
      S.ready = true; S.bal = 100; S.maxBet = 50; S.x100 = 196;
      demoSeed();
      setInterval(demoDrip, 6500);
      setInterval(paintFeed, 20000);
    } else {
      if (GW) GW.init(cfg);
      readGame().then(function () { S.readErr = false; paint(); }, function () { S.readErr = true; paint(); });
      readFeed().then(paintFeed);
      setTimeout(autoConnect, 250);
      setInterval(tick, 10000);
      setInterval(function () { if (S.pending) paint(); }, 30000);
    }
    paint(); paintFeed();
  }
  function boot() {
    ['root:flRoot', 'main:flMain', 'who:flWho', 'whoAddr:flWhoAddr', 'menu:flMenu', 'mode:flMode', 'pays:flPays', 'stage:flStage', 'lift:flLift', 'coin:flCoin', 'shadow:flShadow',
      'result:flResult', 'resBig:flResBig', 'resSub:flResSub', 'headsKey:flHeads', 'tailsKey:flTails', 'most:flMost', 'amt:flAmt', 'amount:flAmount', 'chips:flChips', 'winWhen:flWinWhen', 'win:flWin',
      'loseWhen:flLoseWhen', 'lose:flLose', 'wallet:flWalletLine', 'live:flLive', 'liveWord:flLiveWord', 'feed:flFeed', 'gameLink:flGameLink', 'hypeNote:flHypeNote', 'sayLine:flSay', 'keys:flKeys', 'share:flShare', 'go:flGo']
      .forEach(function (p) { var kv = p.split(':'); el[kv[0]] = $(kv[1]); });
    coinPaint();
    wire();
    paintFeed();
    fetch('config.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('config'); return r.json(); }).then(start, function () { start(null); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
