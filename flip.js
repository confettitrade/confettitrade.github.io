/* confetti_ — flip.js
   The coin flip page (flip.html, flip.css): heads or tails, an amount, one Flip key, the result, a feed of recent flips.

   Where the money is: a flip plays from the visitor's own wallet. The stake is USDC the wallet lets the game's contract
   (CoinFlip, config.json contracts.coinFlip) take for that one flip; a win comes back to the same wallet from the
   contract, in the transaction that brings the result. Nothing here touches the Exchange or the trading balance.
   Where the result comes from: the contract asks Pyth Entropy for a random number, mixed from 32 random bytes this page
   makes for each flip and a number the provider committed to beforehand. Even is heads, odd is tails. The page only
   shows what the contract settled; it decides nothing.

   Two ways the page runs:
   - live: contracts.coinFlip is an address. Reads go to config.json's rpcUrl; the wallet is asked only to connect, to allow
     the game to take USDC (once), to send a flip, and to take back the stake of a flip that never got its number.
   - demo: flip.html?demo=1, or no address in the config yet (the page then also says "Coming soon"). Pretend money, a coin
     decided by the browser's own random bytes, a feed of pretend flips. No wallet, no network.

   One screen in every state: nothing appears or moves under the thumb. The key says what the next press does. */
(function () {
  'use strict';

  var E = window.ethers;
  var WALLET_KEY = 'confetti.wallet';                 /* the wallet chosen on any page of the site (tabs.js) */
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
    if (!S.demo && !S.account) add(list, item(hasWallet() ? 'Connect wallet' : 'Open in your wallet app', '', function () { connect(false); }));
    add(list, item('Trade', 'coins, up or down', null, 'trade.html'));
    add(list, item('Coin flip', 'you are here', null, 'flip.html' + (S.demo && !S.soon ? '?demo=1' : ''), true));
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

  /* ---- the wallet (live only): the site's own way (tabs.js): EIP-6963, the choice remembered, MetaMask's account list ---- */
  var announced = [];
  function listenForProviders() {
    window.addEventListener('eip6963:announceProvider', function (ev) { if (ev && ev.detail && ev.detail.provider) announced.push(ev.detail); });
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) { /* ignore */ }
  }
  function walletList() {
    var seen = {};
    return announced.filter(function (d) { var k = d && d.info ? (d.info.rdns || d.info.uuid || d.info.name) : ''; if (!k || seen[k]) return false; seen[k] = 1; return true; });
  }
  function hasWallet() { return walletList().length > 0 || !!window.ethereum; }
  function nameOf(eth) { var hit = walletList().filter(function (d) { return d.provider === eth; })[0]; return hit && hit.info && hit.info.name ? String(hit.info.name) : 'Wallet'; }
  function getInjected() {
    var list = walletList(), pref = lsGet(WALLET_KEY) || '';
    if (pref) { var hit = list.filter(function (d) { return d.info && d.info.rdns === pref; })[0]; if (hit) return hit.provider; }
    if (list.length === 1) return list[0].provider;
    var eth = window.ethereum;
    if (eth) return Array.isArray(eth.providers) && eth.providers.length ? eth.providers[0] : eth;
    return list.length ? list[0].provider : null;
  }
  var PICK = null;
  function chooseWallet(always) {
    var list = walletList();
    if (list.length < 2 && !(always && list.length)) return Promise.resolve(getInjected());
    return new Promise(function (resolve) {
      var sh = PICK || (PICK = makeSheet('Wallet')), done = false;
      function finish(p) { if (done) return; done = true; sh.onClose = null; sh.close(); resolve(p); }
      txt(sh.title, 'Choose a wallet'); sh.body.textContent = ''; sh.foot.textContent = '';
      var box = h('div', 'sm-menu fl-wallets');
      list.forEach(function (d) {
        var kids = [];
        if (d.info.icon && /^data:image\//.test(d.info.icon)) { var img = h('img'); img.src = d.info.icon; img.alt = ''; kids.push(img); }
        kids.push(d.info.name || d.info.rdns || 'Wallet'); kids.push(h('i', null, '›'));
        add(box, btn(null, kids, function () { lsSet(WALLET_KEY, d.info.rdns || ''); finish(d.provider); }));
      });
      add(sh.body, box);
      sh.onClose = function () { finish(null); };
      sh.open();
    });
  }
  function isMetaMask(eth) {
    var hit = walletList().filter(function (d) { return d.provider === eth; })[0], rdns = hit && hit.info && hit.info.rdns ? String(hit.info.rdns) : '';
    if (rdns) return /^io\.metamask/.test(rdns);
    return !!(eth && eth.isMetaMask && !eth.isPhantom && !eth.isRabby && !eth.isBraveWallet && !eth.isCoinbaseWallet && !eth.isOkxWallet && !eth.isTrust && !eth.isTrustWallet);
  }
  function pickAccounts(eth) {
    var plain = function () { return eth.request({ method: 'eth_requestAccounts', params: [] }); };
    if (!isMetaMask(eth)) return plain();
    return eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }).then(function () { return eth.request({ method: 'eth_accounts', params: [] }); }, function (e) {
      if (e && (e.code === 4001 || e.code === -32002 || /user (rejected|denied)/i.test(String(e.message || '')))) throw e;
      return plain();
    });
  }
  var subscribed = [];
  function subscribe(eth) {
    if (subscribed.indexOf(eth) >= 0 || typeof eth.on !== 'function') return;
    subscribed.push(eth);
    eth.on('accountsChanged', function (accounts) { if (eth !== S.eth) return; if (!accounts || !accounts.length) disconnect(); else setAccount(eth, accounts[0]); });
    eth.on('chainChanged', function (hex) { if (eth !== S.eth) return; S.chainOk = parseInt(hex, 16) === Number(S.cfg.chainId); paint(); });
  }
  function setAccount(eth, account) {
    S.eth = eth; S.account = E.getAddress(account); S.walletName = nameOf(eth); S.bal = null; S.allowance = 0n; S.hype = null; S.pending = null;
    subscribe(eth);
    return eth.request({ method: 'eth_chainId', params: [] }).then(function (hex) { S.chainOk = parseInt(hex, 16) === Number(S.cfg.chainId); }, function () { S.chainOk = true; }).then(function () {
      paint(); paintFeed();      /* the feed marks this wallet's own flips */
      return Promise.all([readWallet(), resume()]);
    }).then(paint);
  }
  function connect(always) {
    if (S.demo) return Promise.resolve();
    if (!hasWallet()) { say('No wallet found in this browser. Open confetti.trade in your wallet app, or add a wallet extension.'); paint(); return Promise.resolve(); }
    S.phase = 'wallet'; say(''); paint();
    return chooseWallet(always).then(function (eth) {
      if (!eth) return null;
      return pickAccounts(eth).then(function (accounts) {
        if (!accounts || !accounts.length) throw new Error('No account returned by the wallet.');
        return setAccount(eth, accounts[0]);
      });
    }).catch(function (e) { say(describe(e)); }).then(function () { if (S.phase === 'wallet') S.phase = 'idle'; paint(); });
  }
  function disconnect() { S.account = null; S.eth = null; S.bal = null; S.allowance = 0n; S.hype = null; S.pending = null; if (S.phase !== 'air') S.phase = 'idle'; say(''); paint(); paintFeed(); }
  function autoConnect() {
    var eth = getInjected();
    if (!eth) return;
    eth.request({ method: 'eth_accounts', params: [] }).then(function (accounts) { if (accounts && accounts.length) return setAccount(eth, accounts[0]); }).catch(function () { /* stay disconnected */ });
  }
  function switchChain() {
    var c = S.cfg, eth = S.eth;
    return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: c.chainIdHex }] }).catch(function (e) {
      if (!e || (e.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(e.message || '')))) throw e;
      return eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: c.chainIdHex, chainName: c.chainName, rpcUrls: [c.rpcUrl], nativeCurrency: c.nativeCurrency, blockExplorerUrls: [c.explorerUrl] }] });
    }).then(function () { return eth.request({ method: 'eth_chainId', params: [] }); }).then(function (hex) { S.chainOk = parseInt(hex, 16) === Number(c.chainId); });
  }

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
    if (S.bal != null && S.usd > S.bal + 1e-9) return { key: 'Not enough USDC', why: (S.demo ? 'Your demo wallet holds ' : 'Your wallet holds ') + usd(S.bal) + (S.demo ? '.' : ' USDC.'), field: true };
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
    if (S.bal != null && (S.demo || S.account)) add(w, ['Flips play from your wallet\'s USDC. It holds ', h('b', null, usd(S.bal)), '.']);
    else add(w, 'Flips play from your wallet\'s USDC.');
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
    if (S.phase === 'wallet') { label = 'Confirm in your wallet…'; busy = true; }
    else if (S.phase === 'allowing') { label = 'Allowing USDC…'; busy = true; }
    else if (S.phase === 'sending') { label = 'Sending your flip…'; busy = true; }
    else if (S.phase === 'refunding') { label = 'Taking it back…'; busy = true; }
    else if (S.phase === 'air') { label = 'Flipping…'; busy = true; if (!sayText && S.slow) { sayText = 'The number is taking longer than usual. Your stake is safe: the flip lands when it arrives.'; sayOk = true; } }
    else if (!S.demo && !S.account) { label = hasWallet() || !S.walletsAsked ? 'Connect wallet' : 'Open in your wallet app'; }
    else if (!S.demo && !S.chainOk) { label = 'Switch to HyperEVM'; }
    else if (S.pending && !S.demo && pendingLate()) { label = 'Take your ' + usdShort(S.pending.stake) + ' back'; if (!sayText) { sayText = pendingSay(); sayOk = true; } }
    else if (S.pending && !S.demo) { label = 'Waiting for the number…'; dis = true; if (!sayText) { sayText = pendingSay(); sayOk = true; } }
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
  function signerGame() { return new E.BrowserProvider(S.eth).getSigner().then(function (s) { return { s: s, g: new E.Contract(S.game, ABI, s), u: new E.Contract(S.cfg.contracts.usdc, ERC20, s) }; }); }
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
      readWallet().then(paint);
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
            Promise.all([readWallet(), readGame(), readFeed()]).then(function () { paint(); paintFeed(); });
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

  /* ---- the one key ---- */
  function press() {
    if (S.phase !== 'idle' && S.phase !== 'landed') return;
    if (!S.demo && !S.account) { S.walletsAsked = true; connect(false); return; }
    if (!S.demo && !S.chainOk) { S.phase = 'wallet'; say(''); paint(); switchChain().catch(function (e) { say(describe(e)); }).then(function () { S.phase = 'idle'; paint(); }); return; }
    if (S.pending && !S.demo) { if (now() >= S.pending.at + S.refundDelay) refund(); return; }
    S.touched = true;
    if (problem()) { paint(); return; }
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
      listenForProviders();
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
