/* confetti_  —  simple.js
   Confetti Simple, the phone view (the owner, 2026-11-11: "much simpler and
   easier to get going"): Home, the coin, one sheet, the trade as one card, the
   result, in one look: the cream paper (simple.css). Pro, today's phone view,
   stays whole and one tap away.
   Add money is a dollar amount, one button, one confirmation. The money rides
   a rail (quote, send, track): Relay first, deBridge second. A Relay order
   carries its own destination calls, so the dollars land in the trader's
   Confetti balance and a little HYPE lands in the wallet, in the one order.
   No trading logic lives here: trade.js hands over a narrow api (its [simple]
   block) and every action runs the Pro code. No build step, no library. */
(function () {
  'use strict';

  var api = null, E = null;
  var MODE_KEY = 'confetti.trade.mode', FLAG_KEY = 'confetti.trade.simpleFlag2', FLAG_DK_KEY = 'confetti.trade.simpleDesktopFlag', SEEN_KEY = 'confetti.trade.simpleSeen';
  var ADD_KEY = 'confetti.simple.add.', AMT_KEY = 'confetti.simple.amount', SPARK_KEY = 'confetti.simple.line.';
  var ZERO = '0x0000000000000000000000000000000000000000';
  var NAMES = {
    BTC: 'Bitcoin', ETH: 'Ether', SOL: 'Solana', DOGE: 'Dogecoin', XRP: 'XRP', LINK: 'Chainlink', PUMP: 'Pump', FARTCOIN: 'Fartcoin',
    VIRTUAL: 'Virtuals', WIF: 'dogwifhat', MELANIA: 'Melania', FLOKI: 'Floki', PENGU: 'Pudgy Penguins', PEOPLE: 'ConstitutionDAO', TRUMP: 'Trump', PEPE: 'Pepe', ZEC: 'Zcash'
  };
  /* The chains a wallet's ETH is read on and sent from. keep: ETH left for that chain's own network fee. */
  var CH = {
    8453: { name: 'Base', hex: '0x2105', rpc: 'https://mainnet.base.org', keep: 300000000000000n },
    42161: { name: 'Arbitrum', hex: '0xa4b1', rpc: 'https://arb1.arbitrum.io/rpc', keep: 300000000000000n },
    1: { name: 'Ethereum', hex: '0x1', rpc: 'https://ethereum-rpc.publicnode.com', keep: 3000000000000000n }
  };
  var CH_ORDER = [8453, 42161, 1];
  var RELAY = 'https://api.relay.link', DLN = 'https://dln.debridge.finance/v1.0', DLN_HYPEREVM = 100000022;
  /* A first session's HYPE, measured on a fork: one-tap setup 135,201 gas, an open + a close 301,210. The top-up
     covers the setup, about 50 trades at the fee now and what trade.js keeps back; never over $2. */
  var GAS_SETUP = 135201n, GAS_TRADE = 301210n, TOPUP_TRADES = 50n, HYPE_FLOOR = 3000000000000000n, TOPUP_MAX_USD = 2;
  var MIN_ADD_USD = 5;
  /* HYPE already in the wallet pays too (the owner, 2026-11-19: "for add money can we make it so hype can be bridged automatically like
     eth can"): one Relay order on HyperEVM itself (hypeRail below). HYPE_ROUTER: the one address such an order may go to, Relay's router
     here (the same contract that runs the ETH orders' calls on arrival). HYPE_SLIP: the price room asked of the order, in hundredths of a
     percent (the order keeps about twice it); what the room leaves over comes back to the wallet. HYPE_GAS: the order's own gas, kept
     back with the HYPE for trading (514,542 used on a fork). MC / SWEEP: the router's multicall(calls, refundTo, nftRecipient, metadata)
     and cleanupErc20s(tokens, recipients, amounts, metadata), read to check the order before the wallet opens. */
  var HYPE_ROUTER = '0x0729e2a4716d9f7dd17858d5d504426d228697f7', HYPE_SLIP = '50', HYPE_GAS = 1000000n, MC = '0xcd6e13f7', SWEEP = '0x9bb43718';

  /* away: the results of trades that ended while Confetti was closed (v6: a take profit or stop loss fires on chain), each
     its own card on Home until it is opened */
  var S = { flag: 'optin', mode: 'pro', place: 'home', sym: null, pid: null, done: null, seen: {}, res: null, away: [], sig: '', homeY: 0, claim: false, lastErr: null, snackT: null };
  var el = {}, R = {};
  var sheets = [], H = { depth: 0, skip: 0 };
  /* FETTI levels and money back (fetti.js): null unless the page has it and config.json's fetti.moneyBack is on (v5) */
  var FXS = { set: false };
  function fx() {
    var f = window.ConfettiFetti;
    if (!f || !api) return null;
    if (!FXS.set) { FXS.set = true; f.setup(api.cfg(), { demo: !!api.demo }); f.subscribe(kick); }
    return f.on() ? f : null;
  }

  /* ---- small things ---- */

  function $(id) { return document.getElementById(id); }
  function add(n, kids) {
    (Array.isArray(kids) ? kids : [kids]).forEach(k => { if (k == null || k === false) return; n.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k))); });
    return n;
  }
  function h(tag, cls, kids) { var n = document.createElement(tag); if (cls) n.className = cls; if (kids != null) add(n, kids); return n; }
  function btn(cls, kids, fn) { var b = h('button', cls, kids); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; }
  function txt(n, s) { if (n && n.textContent !== s) n.textContent = s; }
  function cls(n, c) { if (n && n.className !== c) n.className = c; }
  function show(n, on) { if (n && n.hidden === !!on) n.hidden = !on; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function noop() {}
  var STAYED = 'Your wallet stayed on another network, so ';
  function each(n, fn) { Array.prototype.forEach.call(n.children, fn); }
  function sayLine() { var n = h('p', 'sm-say', ''); n.setAttribute('aria-live', 'polite'); return n; }
  function redo() { S.sig = ''; kick(); }
  var CONFIRM = 'Confirm in your wallet…', NS = 'http://www.w3.org/2000/svg';

  /* Money and prices as people say them: $48.35, +$1.00, −$10.00, $0.067810, $82,478. */
  function usd(n) { return n == null || !isFinite(n) ? '$—' : '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function usdS(n) { return n == null || !isFinite(n) ? '$—' : Math.abs(n - Math.round(n)) < 0.005 ? '$' + Math.round(n).toLocaleString('en-US') : usd(n); }
  function usdP(n) { return n == null || !isFinite(n) ? '—' : (n > 0.004 ? '+' : n < -0.004 ? '−' : '') + usd(n); }
  /* Compact USD: $64.9K, $1.2M, $820 */
  function usdK(n) {
    if (n == null || !isFinite(n)) return '$—';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 10e6 ? 0 : 1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(n >= 10e3 ? 0 : 1) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function price(p, sz) {
    if (!(p > 0)) return '—';
    if (p >= 10000) return '$' + Math.round(p).toLocaleString('en-US');
    var d = (String(api.fmt.price(p, sz)).split('.')[1] || '').length;
    return '$' + p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function pct(x, d) { return !isFinite(x) ? '' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(d == null ? 1 : d) + '%'; }
  function arrow(x) { return x > 0 ? '▲ ' : x < 0 ? '▼ ' : ''; }
  function tone(x) { return x > 0 ? 'sm-up' : x < 0 ? 'sm-dn' : 'sm-mute'; }
  function short(a) { return !a ? '' : window.innerWidth < 380 ? '…' + a.slice(-4) : a.slice(0, 6) + '…' + a.slice(-4); }
  /* the phone top bar holds four keys once a wallet is connected (Back or the logo, the House, the wallet, Menu), so the
     wallet key gives way first: 0 = the dot and the last 4, 1 = "…" and the last 4, 2 = the usual short form */
  function topFit() { var x = window.innerWidth; return x < 400 ? 0 : x < 520 ? 1 : 2; }
  function shortTop(a) { var f = topFit(); return !a ? '' : f === 0 ? a.slice(-4) : f === 1 ? '…' + a.slice(-4) : a.slice(0, 6) + '…' + a.slice(-4); }
  function ethS(wei) { var n = Number(wei) / 1e18; return String(Number(n.toPrecision(n >= 1 ? 6 : 4))); }
  function nameOf(sym) { return NAMES[sym] || sym; }
  /* An error from the Pro code, in Simple's words where the words differ. */
  function plain(s) {
    s = String(s || '');
    if (/need a little HYPE/i.test(s)) return 'Your wallet has run out of the little the network needs. Add money and that is topped up too.';
    if (/Switch the wallet to|stayed on another network/i.test(s)) return STAYED + 'nothing was sent. Press again and let it change.';
    s = s.replace(/for a (long|short)\b/g, (x, d) => d === 'long' ? 'on an Up trade' : 'on a Down trade').replace(/\bLong\b/g, 'Up').replace(/\blong\b/g, 'up').replace(/\bShort\b/g, 'Down').replace(/\bshort\b/g, 'down')
      .replace(/\b(P)ositions?\b/g, 'Trade').replace(/\bpositions\b/g, 'trades').replace(/\bposition\b/g, 'trade')
      .replace(/\bwas liquidated\b/g, 'closed itself').replace(/would be liquidated/g, 'would close itself').replace(/the price passed your liquidation price/g, 'the price moved past where this trade would close itself').replace(/liquidated first/g, 'it closed itself first').replace(/the liquidation price/g, 'the price where it closes itself').replace(/liquidates/g, 'ends').replace(/\bleverage\b/g, 'boost').replace(/\bLeverage\b/g, 'Boost').replace(/(\d)x\b/g, '$1×');
    return /\bfees?\b/i.test(s) ? 'That cannot be done right now. Try again in a moment.' : s;     /* Simple never talks about fees */
  }
  function errText(e) {
    if (e && e.plain != null) return e.plain;
    var code = e && (e.code != null ? e.code : e.info && e.info.error && e.info.error.code), m = String((e && (e.shortMessage || e.message)) || '');
    if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied|cancel)/i.test(m)) return 'You cancelled in your wallet. Nothing was sent.';
    if (/insufficient funds/i.test(m)) return 'Not enough ETH for this amount plus a little extra for the network. Try a little less.';
    /* anything else is not Simple's sentence: it goes to the console, and the screen says one line that claims nothing */
    try { console.error('[simple]', e); } catch (x) { /* no console */ }
    return 'That did not work. Look in your wallet before you try again.';
  }
  function say(e) { var x = new Error(e); x.plain = e; return x; }
  var OFF = 'Adding money is off right now. Try again in a little while.', AGAIN = 'Try again in a moment.';
  var NO_ANSWER = 'Your wallet did not answer. Press again.', CANCELLED = 'Cancelled here. If your wallet is still asking, say no there too.';
  /* a wait on the wallet always ends: with p, or after ms with the sentence (a late answer then changes nothing) */
  function timed(p, ms, why) {
    return new Promise((yes, no) => { var t = setTimeout(() => { no(say(why)); }, ms); Promise.resolve(p).then(v => { clearTimeout(t); yes(v); }, e => { clearTimeout(t); no(e); }); });
  }
  /* A sheet's button rises exactly where the button that opened it was: for a little over half a second after a sheet opens
     or the place changes, a press on what came up is the same tap (or its twin, up to half a second later) and is ignored. */
  function early() { return Date.now() - (S.since || 0) < 650; }
  /* dollars cut to whole cents, without losing a cent to the float (29.999999 is 30.00) */
  function cents(x) { return Math.floor(x * 100 + 1e-6) / 100; }

  /* ---- which view: Simple or Pro ---- */

  function param() { try { var p = new URLSearchParams(location.search).get('mode'); return p === 'simple' || p === 'pro' ? p : null; } catch (e) { return null; } }
  function flagOf() { var u = api.cfg().ui, f = u && u.simplePhones; return f === 'off' || f === 'default' ? f : 'optin'; }
  function flagDkOf() { var u = api.cfg().ui, f = u && u.simpleDesktop; return f === 'off' || f === 'default' ? f : 'optin'; }
  /* wider than a phone and a mouse or trackpad: a phone on its side or a tablet is neither (applyMode then keeps Pro) */
  function wide() { var f = true; try { f = window.matchMedia('(pointer: fine)').matches; } catch (e) { /* old browser: by width */ } return window.innerWidth > 640 && f; }
  /* the layout: desktop (wide() = wider than a phone and a mouse or trackpad) gets the three-column layout,
     phone gets the single-column layout. */
  function isDesktop() { return wide(); }
  /* "Asked for Simple": a saved "simple", or a "pro" that Simple's own menu wrote. Nothing else is asking: not ?mode=pro,
     not some other stored string. Only for someone who asked (or under "default") does Pro's Menu offer the way back. */
  function asked() { var c = lsGet(MODE_KEY); return S.param === 'simple' || c === 'simple' || (c === 'pro' && lsGet(SEEN_KEY) === '1') || S.mode === 'simple'; }
  function enabled() {
    var flag = wide() ? S.flagDk : S.flag;
    return flag === 'default' || (flag === 'optin' && asked());
  }
  var NO_PRO = true;   /* owner 2026-11-12 "no more pro" "for now": no Pro view, no Candles; set false to bring Pro back */
  function wantMode() {
    var flag = wide() ? S.flagDk : S.flag;
    if (flag === 'off') return 'pro';
    if (NO_PRO) return 'simple';   /* owner 2026-11-12: "no more pro", "for now" */
    var c = S.param || lsGet(MODE_KEY);
    return c === 'simple' || c === 'pro' ? c : flag === 'default' ? 'simple' : 'pro';
  }
  /* Simple is what the screen shows: the mode, proper width, and the shell really on screen (applyMode keeps S.on) */
  function shown() { return !!S.on; }
  function applyMode() {
    var root = document.documentElement, bar = document.querySelector('meta[name="theme-color"]');
    var dk = wide(), phoneOk = !dk && api.isPhone(), deskOk = dk;
    var on = S.mode === 'simple' && !!api && (phoneOk || deskOk);
    if (on) {
      root.setAttribute('data-mode', 'simple');
      /* simple.css is what shows the shell. If it is not here, this page view runs as Pro: Pro's toasts, guide and sheets */
      if (el.root && getComputedStyle(el.root).display === 'none') { on = false; S.mode = 'pro'; }
    }
    if (!on) root.removeAttribute('data-mode');
    S.on = on;
    /* the browser bar: paper with Simple (its one look, in simple.css), the page's own colour with Pro */
    if (bar) bar.content = on ? '#f4ecd8' : getComputedStyle(root).getPropertyValue('--page').trim() || '#0d1229';
    proLink();
    if (on) {
      /* Simple takes the screen: at Home unless a place is on the back stack, and without what Pro was still saying */
      if (!S.was) { if (H.depth === 0) S.place = 'home'; var ts = $('toasts'); if (ts) ts.textContent = ''; restack(); }
      S.sig = ''; paint();
    }
    else if (S.was) { sheets.slice().forEach(sh => { sh.close(true, true); }); H.depth = 0; api.redraw(); }
    S.was = on; if (on) S.ever = true;
  }
  /* Simple comes on at depth 0 (Home): the entry the browser is on must say so. It can still carry an older depth: Simple
     was on before (a phone turned past 640 px and back, Pro and back), or the page was reloaded on a coin. Coming back,
     the browser is walked back to the entry Simple started from (that back is skipped when it arrives), so the next back
     after a coin is the list and the one after it leaves; on a first start the entry is simply marked as depth 0. */
  function restack() {
    var st = history.state, at = st && typeof st.sm === 'number' ? st.sm : 0;
    if (!(at > 0)) return;
    if (S.ever) { H.skip++; try { history.go(-at); return; } catch (e) { H.skip--; } }
    try { history.replaceState(null, ''); } catch (e) { /* the entry stays */ }
  }
  function setMode(mode, once) {
    S.mode = mode; S.param = null;
    if (!once) {
      lsSet(MODE_KEY, mode); lsSet(SEEN_KEY, '1');
      /* the choice was made in the page: the address stops saying otherwise, so a reload keeps it */
      try { var u = new URL(location.href); if (u.searchParams.has('mode')) { u.searchParams.delete('mode'); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } } catch (e) { /* the address stays */ }
    }
    applyMode(); window.scrollTo(0, 0);
  }
  /* Pro's own Menu sheet gets the way back, for a visitor Simple is offered to */
  function proLink() {
    var list = document.querySelector('#phMenuSheet .ph-menu-list'), a = $('smToSimple');
    if (!list) return;
    if (!enabled()) { if (a) a.remove(); return; }
    if (a) return;
    a = h('a', null, 'Simple view'); a.id = 'smToSimple'; a.href = '#';
    a.addEventListener('click', function (ev) { ev.preventDefault(); var x = document.querySelector('#phMenuSheet [data-close]'); if (x) x.click(); setTimeout(() => { setMode('simple'); }, 220); });
    list.insertBefore(a, list.firstChild);
  }

  /* ---- back: the phone's back gesture walks Simple's places and sheets ---- */

  /* Every step into a place or a sheet is one history entry carrying its depth ({ sm: n }); the entry of a coin carries that
     coin in its address (#BTC). A back the page itself started (the ←, a sheet's ✕) is skipped when it arrives; a back the
     person made walks Simple down to the depth of the entry the browser landed on, so two backs that met in flight, or a
     forward, never leave Simple a step out of line with the browser. */
  function hPush(url) { H.depth++; try { if (url) history.pushState({ sm: H.depth }, '', url); else history.pushState({ sm: H.depth }, ''); } catch (e) { /* no history here */ } }
  function hBack() { if (H.depth > 0) { H.depth--; H.skip++; try { history.back(); } catch (e) { H.skip--; } } }
  function onPop(ev) {
    var at = ev && ev.state && typeof ev.state.sm === 'number' ? ev.state.sm : 0;
    if (H.skip > 0) {
      H.skip--;
      /* the browser stopped deeper than Simple is (two backs were taken as one): one more back, also skipped */
      if (!H.skip && shown() && at > H.depth) { H.skip++; try { history.go(H.depth - at); } catch (e) { H.skip--; } }
      if (!H.skip) addr();
      return;
    }
    if (!shown()) return;
    if (at > H.depth) { H.skip++; try { history.go(H.depth - at); } catch (e) { H.skip--; } return; }      /* a forward: back to where Simple is */
    while (H.depth > at) { H.depth--; back(true); }
    addr();
  }
  /* The tab's title and the address say what is on screen: Home is the page's own title and no coin in the address; a coin
     (and its result) is that coin, the way Pro writes it ("0.0684 DOGE — confetti_", #DOGE). A link copied here opens what
     was on screen. Not while a back the page started is still on its way: the entry it leaves keeps its own address. */
  var BOOT = window.ConfettiSimpleBoot || { hash: '', title: '' }, HOME_TITLE = BOOT.title || 'confetti_ — trade';
  function addr() {
    if (!shown() || H.skip) return;
    var sym = S.place === 'home' ? '' : S.sym, q = sym && api.price(sym);
    var t = sym ? (q && q.px > 0 ? api.fmt.price(q.px, q.sz) + ' ' : '') + sym + ' — confetti_' : HOME_TITLE;
    if (document.title !== t) document.title = t;
    var want = sym ? '#' + encodeURIComponent(sym) : '';
    if (location.hash !== want) { try { history.replaceState(history.state, '', location.pathname + location.search + want); } catch (e) { /* the address stays */ } }
  }
  /* the coin the address named when the page came (trade.html#BTC): opened over Home, so back leads to the coins */
  function bootCoin() {
    var raw = String(BOOT.hash || '').replace(/^#/, ''), sym = '';
    try { sym = decodeURIComponent(raw).toUpperCase(); } catch (e) { sym = ''; }
    BOOT.hash = '';
    if (!sym || /^POS=/.test(sym) || !market(sym)) return false;
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* the address stays */ }
    go('coin', sym);
    return true;
  }
  function back(fromPop) {
    if (sheets.length) { sheets[sheets.length - 1].close(fromPop); return; }
    if (S.place === 'home') return;
    S.place = 'home'; S.sig = ''; S.done = null;
    if (!fromPop) hBack();
    paint(); el.main.scrollTop = S.homeY;
  }
  function go(place, sym, pid) {
    if (S.place === 'home') { S.homeY = el.main.scrollTop; hPush(location.pathname + location.search + '#' + encodeURIComponent(sym || S.sym)); }
    S.place = place; S.sym = sym || S.sym; S.pid = pid || null; S.pickOnce = !!pid; S.sig = ''; S.since = Date.now(); COIN.tmode = 0;
    paint(); el.main.scrollTop = 0;
  }

  /* ---- sheets: four ways out (swipe down, the cross, a tap outside, Esc / back) ---- */

  function makeSheet(name, tall) {
    var d = h('dialog', 'sm-sheet' + (tall ? ' is-tall' : ''));
    var title = h('h2'); title.id = 'smSheet' + name; title.tabIndex = -1; d.setAttribute('aria-labelledby', title.id);
    var x = btn('sm-x', '✕', () => { sh.close(); }); x.setAttribute('aria-label', 'Close');
    var head = h('div', 'sm-sh-head', [title, x]), body = h('div', 'sm-sh-body'), foot = h('div', 'sm-sh-foot');
    add(d, [head, body, foot]);
    document.body.appendChild(d);
    function shut() { clearTimeout(sh.outT); sh.outT = 0; d.classList.remove('is-out', 'is-gone'); d.inert = false; try { d.close(); } catch (e) { d.removeAttribute('open'); } }
    var sh = {
      d: d, title: title, body: body, foot: foot, isOpen: false, onClose: null, outT: 0,
      open: function () {
        if (sh.isOpen) return;
        if (sh.outT || d.open) shut();      /* opened again while it was still sliding away */
        sh.isOpen = true; S.since = Date.now(); d.style.removeProperty('--sm-drag');
        try { d.showModal(); } catch (e) { d.setAttribute('open', ''); }
        try { title.focus({ preventScroll: true }); } catch (e) { /* fine */ }
        sheets.push(sh); hPush(); body.scrollTop = 0; fitKeyboard();
      },
      /* Closed is closed at once: the page takes the next tap (the ← right after ✕ was lost while the sheet was still modal
         for its slide away), and what closing does runs now. The slide is only a picture: no longer modal, and no taps. */
      close: function (fromPop, now) {
        if (!sh.isOpen) return;
        sh.isOpen = false; sheets = sheets.filter(s => s !== sh);
        if (!fromPop) { hBack(); var p = S.ptr; if (p && Date.now() - p.t < 700) S.shut = { x: p.x, y: p.y, t: Date.now() }; }
        shut();
        if (!now && !reduced()) {
          /* is-gone: no taps (a class, not :modal, which older Safari does not know); inert: nothing in it takes focus, and focus
             stays on what it went back to when the sheet closed (the opener) */
          var keep = document.activeElement;
          try {
            d.classList.add('is-out', 'is-gone'); d.inert = true; d.show();
            if (keep && keep !== document.body && document.activeElement !== keep && document.contains(keep)) keep.focus({ preventScroll: true });
            sh.outT = setTimeout(shut, 180);
          } catch (e) { shut(); }
        }
        if (sh.onClose) sh.onClose();
        kick();
      }
    };
    d.addEventListener('cancel', ev => { ev.preventDefault(); sh.close(); });
    d.addEventListener('click', ev => { if (ev.target === d) sh.close(); });
    var y0 = null, dy = 0, t0 = 0;
    head.addEventListener('pointerdown', function (ev) { if (ev.target.closest('button')) return; y0 = ev.clientY; dy = 0; t0 = Date.now(); try { head.setPointerCapture(ev.pointerId); } catch (e) { /* fine */ } });
    head.addEventListener('pointermove', ev => { if (y0 == null) return; dy = Math.max(0, ev.clientY - y0); d.style.setProperty('--sm-drag', dy + 'px'); });
    var up = () => { if (y0 == null) return; var fast = dy > 24 && dy / Math.max(1, Date.now() - t0) > 0.5; y0 = null; if (dy > 90 || fast) sh.close(); else d.style.removeProperty('--sm-drag'); };
    head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
    return sh;
  }
  /* the keyboard: the sheet's button rides above it and the field typed in scrolls into view */
  function fitKeyboard() {
    var vv = window.visualViewport, top = sheets[sheets.length - 1];
    if (!top) return;
    var kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    top.d.style.setProperty('--sm-kb', kb + 'px');
    var f = document.activeElement;
    if (f && /^(INPUT|TEXTAREA)$/.test(f.tagName) && top.d.contains(f) && f.scrollIntoView) f.scrollIntoView({ block: kb > 0 ? 'center' : 'nearest' });
  }

  /* the amount: a real field (tap the big number, the numeric keypad), digits and one dot */
  function amtInput(id, label, value, onInput) {
    var i = h('input'); i.type = 'text'; i.id = id; i.value = value; i.maxLength = 9; i.placeholder = '0';
    i.setAttribute('inputmode', 'decimal'); i.setAttribute('enterkeyhint', 'done'); i.setAttribute('autocomplete', 'off'); i.setAttribute('aria-label', label);
    i.addEventListener('input', () => { var v = i.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'); if (v !== i.value) i.value = v; onInput(v); });
    i.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); i.blur(); } });
    i.addEventListener('focus', function () { setTimeout(function () { try { i.select(); } catch (e) { /* fine */ } fitKeyboard(); }, 0); });
    return i;
  }

  /* a message that needs no tap: bottom, above the action, one at a time */
  function snack(text) {
    var old = el.root.querySelector('.sm-snack'); if (old) old.remove();
    clearTimeout(S.snackT);
    var n = h('div', 'sm-snack', text); n.setAttribute('role', 'status');
    el.root.insertBefore(n, el.cta);
    S.snackT = setTimeout(() => { n.remove(); }, 6000);
  }
  /* trade.js asks before a toast: in Simple the place that started the action says it (true: handled) */
  function onToast(text, kind) {
    if (!shown() || document.querySelector('dialog[open]:not(.sm-sheet)')) return false;
    if (REF.sh && REF.sh.isOpen && refHeard(text, kind)) return true;      /* Refer friends: the sheet says what its own send came to */
    if (kind === 'err') { S.lastErr = { text: plain(text), at: Date.now() }; if (!S.claim && !sheets.length && !/HyperEVM|Switch|^Closed |liquidated/.test(text) && !(S.place === 'coin' && /did not go through|Didn.t open/.test(text))) snack(S.lastErr.text);      /* not twice: the coin's card says that one itself */ kick(); }
    else if (S.tell && Date.now() - S.tell < 15000) { S.tell = 0; snack(plain(text)); }      /* the answer to Switch wallet, said once */
    else if (/^(Take profit|Stop loss) hit: /.test(text)) {
      /* a take profit / stop loss fired: said where the person is, unless that trade's own card is on screen (it says so itself) */
      var on = /closing your (\S+) /.exec(text);
      if (!(S.place === 'coin' && on && on[1] === S.sym)) snack(plain(text).replace(/ hit: closing/, ' reached: closing').replace(/ at ([0-9.,]+)\.$/, ' at $$$1.'));
    }
    return true;
  }
  function lastErr() { var e = S.lastErr; return e && Date.now() - e.at < 4000 ? e.text : ''; }

  /* ---- wallet steps ---- */

  function doConnect() {
    var w = api.wallet();
    if (!w.ready) { snack('The wallet part of the page did not load. Reload the page.'); return; }
    if (!w.has) { api.walletApps(); return; }
    api.connect();
  }
  function withdraw() { if (api.demo) { api.pro('withdraw'); return; }      /* the demo has no wallet to move: its own sheet */
    api.toHyperEvm().then(() => { api.pro('withdraw'); }, () => { snack(STAYED + 'nothing happened. Try Withdraw again.'); }); }

  /* ---- painting ---- */

  var dirty = false;
  function kick() {
    if (dirty || !shown()) return;
    dirty = true;
    var run = function () { dirty = false; try { paint(); } catch (e) { console.error('simple.js', e); } };
    if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(run); else setTimeout(run, 30);
  }
  function paint() {
    if (!shown()) return;
    /* which level fired, kept for its result ("closed by your take profit") wherever the person is when it fires */
    if (api.wallet().account) api.positions().forEach(x => { if (x.auto && x.auto.fired) AUTO.fired[x.id] = x.auto.fired; });
    ffSync(); ffDoneCheck();      /* (cf_FILLFEEL) each order's own place, from its press to its trade; a close shown ahead of the chain */
    paintTop();
    if (isDesktop()) {
      paintDesktopLeft();
      paintDesktopCenter();
      paintDesktopRight();
    } else {
      if (S.place === 'coin') paintCoin(); else if (S.place === 'done') paintDone(); else paintHome();
      edge();
      if (ADD.sh && ADD.sh.isOpen) paintAdd();
      if (ORD.sh && ORD.sh.isOpen) paintOrder();
    }
    if (AUTO.sh && AUTO.sh.isOpen) paintAuto();      /* the take profit / stop loss sheet, on a phone and on a desktop */
    if (PART.sh && PART.sh.isOpen) paintPart();      /* Close part / Add to this trade, the same */
    if (LV.sh && LV.sh.isOpen) paintLevels();        /* FETTI levels (fetti.js), on a phone and on a desktop */
    if (REF.sh && REF.sh.isOpen) paintRefer();       /* Refer friends, the same */
    if (OT.sh && OT.sh.isOpen) paintOneTap();        /* One-tap trading, the same */
    addr();
  }
  /* The list scrolls under the bottom bar, never behind it: while more is below, the bar has an edge (so a row cut at the
     bar reads as "more below"); with no bar, the list keeps its own room above the iPhone's home bar (simple.css). */
  function edge() {
    var m = el.main, bare = !el.cta.firstChild, more = !bare && m.scrollHeight - m.clientHeight - m.scrollTop > 2;
    if (el.root.classList.contains('is-more') !== more) el.root.classList.toggle('is-more', more);
    if (el.root.classList.contains('no-cta') !== bare) el.root.classList.toggle('no-cta', bare);
  }

  /* ---- Desktop: three-column layout ---- */
  var DK = { panel: '', built: '', R: {} };

  function paintDesktopLeft() {
    var w = api.wallet(), a = api.account(), mk = api.markets();
    var ps = w.account && a.loaded ? api.positions() : [], os = w.account ? ffOrders() : [];
    var st = homeState(w, a), p = ADD.pend;
    /* the result card also says which price the trade ended at once that is known (v5: "price at 12:03:05, Pyth") */
    var resAt = S.res ? ((api.result(S.res.pid) || {}).at || '') : '';
    var sig = ['dkLeft', st, w.has, p ? p.rail + p.state : '', S.res ? S.res.key + resAt : '', S.away.map(x => x.key).join(','), ps.map(x => x.id).join(','), os.map(x => x.key).join(','),
      mk.map(m => m.sym).join(','), api.applePayOn(), a.inTrades > 0, S.sym, old4Sig(), fxShow(w, st)].join('|');

    if (DK.leftSig !== sig) {
      DK.leftSig = sig;
      var head = el.leftHead, scroll = el.leftScroll;
      head.textContent = ''; scroll.textContent = '';
      DK.R.rows = {};

      /* header: balance + actions */
      add(head, h('div', 'sm-label', 'Your trading money'));
      DK.R.bal = h('div', 'sm-big', '');
      add(head, DK.R.bal);
      if (st === 'visitor') {
        add(head, h('p', 'sm-mid', 'Connect a wallet to trade.'));
        add(head, h('div', 'sm-links', btn('sm-link', w.has ? 'Connect wallet' : 'Open in wallet app', doConnect)));
      } else if (st === 'empty' && !p) {
        add(head, h('p', 'sm-mid', 'Add money to start.'));
        add(head, h('div', 'sm-links', btn('sm-link', 'Add money', () => { openAddDesktop(); })));
      } else if (st === 'money') {
        if (a.inTrades > 0) add(head, DK.R.sub = h('p', 'sm-mid', ''));
        add(head, h('div', 'sm-links', [btn('sm-link', 'Add money', () => { openAddDesktop(); }), a.available > 0 ? btn('sm-link', 'Withdraw', withdraw) : null]));
      }

      /* money back for stakers (fetti.js): the same key as on a phone */
      DK.R.fx = fxShow(w, st) ? fxCard() : null; if (DK.R.fx) add(scroll, h('div', 'sm-sec', DK.R.fx.n));
      add(scroll, h('div', 'sm-sec', flipCard()));
      add(scroll, h('div', 'sm-sec', crashCard()));
      /* money still on the earlier version (v5 only): one key to the page that closes it out */
      var o4d = old4Card(); if (o4d) add(scroll, h('div', 'sm-sec', o4d));

      /* pending add note */
      if (p) {
        DK.R.pend = noteCard();
        DK.R.pend.n.addEventListener('click', () => { openAddDesktop(); });
        add(scroll, h('div', 'sm-sec', DK.R.pend.n));
      }

      /* result card */
      if (S.res) {
        var res = S.res, c = noteCard(), win = res.pnl > 0;
        txt(c.b, resTitle(res));
        txt(c.i, resLine(res, false));
        c.icon.className = 'sm-pill ' + (win ? 'is-up' : 'is-dn'); c.icon.textContent = win ? '✓' : '×';
        c.n.addEventListener('click', () => { openDoneDesktop(res); });
        add(scroll, h('div', 'sm-sec', [c.n, resLink(res)]));
      }
      awayCards(d => { S.sym = d.sym; S.place = 'done'; S.sig = ''; paint(); }, true).forEach(n => add(scroll, h('div', 'sm-sec', n)));

      /* open trades */
      if (ps.length || os.length) {
        var box = h('div', 'sm-rows');
        os.forEach(o => { box.appendChild(tradeRow('o' + o.key, o, () => { selectCoin(o.sym); }, DK.R.rows)); });
        ps.forEach(x => { box.appendChild(tradeRow('p' + x.id, x, () => { selectCoin(x.sym, x.id); }, DK.R.rows)); });
        add(scroll, h('div', 'sm-sec', [h('div', 'sm-label', 'Your trades'), box]));
      }

      /* coin list */
      var list = h('div', 'sm-rows');
      mk.forEach(m => {
        var r = DK.R.rows['m' + m.sym] = { v: h('b', null, '—'), c: h('i'), spk: svg('sm-spk', '0 0 72 28') };
        var tb = h('span', 'sm-trade', [h('span', 'sm-trade-long', 'Click here to place trade'), h('span', 'sm-trade-short', 'Place trade')]);
        var row = btn('sm-row' + (S.sym === m.sym ? ' is-sel' : ''), [h('span', 'sm-tk', [h('b', m.sym.length >= 8 ? 'is-long' : null, m.sym), h('i', null, nameOf(m.sym))]), r.spk, tb, h('span', 'sm-pr', [r.v, r.c])], () => { selectCoin(m.sym); });
        list.appendChild(row);
      });
      var sec = h('div', 'sm-sec', [h('div', 'sm-label', 'Trade a coin'), list]);
      add(scroll, [sec, newsCard()]);
    }

    /* update values */
    var bt = st !== 'visitor' && a.loaded ? usd(a.available) : '$—';
    txt(DK.R.bal, bt); cls(DK.R.bal, 'sm-big' + (bt.length > 11 ? ' is-longer' : bt.length > 9 ? ' is-long' : ''));
    if (DK.R.sub && st === 'money') txt(DK.R.sub, a.inTrades > 0 ? usd(a.inTrades) + ' more is in your open trades.' : '');
    if (p && p.final && p.state === 'done' && !DK.panel && Date.now() - (p.at || 0) > 60000) { dropPend(); return; }
    if (DK.R.pend && p) fillPend(p, DK.R.pend);
    if (DK.R.fx) fxFill(DK.R.fx);

    /* update trade rows */
    var ps2 = w.account && a.loaded ? api.positions() : [], os2 = w.account ? ffOrders() : [];
    ps2.forEach(x => {
      var r = DK.R.rows['p' + see(x)]; if (!r) return;
      var st2 = x.status;
      txt(r.pill, pillText(x.isLong, boostOf(x)));
      txt(r.sub, st2 ? plainStatus(st2.text) : usdS(x.margin) + ' in');
      roomShort(r.room, x, ' · ', !!st2);
      txt(r.v, x.delayed || !isFinite(x.pnl) ? '—' : (x.est ? '≈ ' : '') + usdP(x.pnl)); cls(r.v, tone(x.pnl));
      txt(r.c, x.delayed || !isFinite(x.pnl) ? 'price delayed' : pct(x.pnl / x.margin)); cls(r.c, tone(x.pnl));
    });
    os2.forEach(o => { var r = DK.R.rows['o' + o.key]; if (r) ffRowLook(r, o); });      /* (cf_FILLFEEL) an order on its way: its trade's row */

    /* update coin rows */
    var mk2 = api.markets();
    mk2.forEach(m => {
      var r = DK.R.rows['m' + m.sym], q = api.price(m.sym); if (!r || !q) return;
      var move = q.prev > 0 && q.px > 0 ? q.px / q.prev - 1 : NaN;
      flash(r.v, q.px); txt(r.v, price(q.px, q.sz)); r.v.style.color = q.at && Date.now() - q.at < 15000 ? '' : 'var(--ink-muted)';
      txt(r.c, isFinite(move) ? arrow(move) + pct(move) : ''); cls(r.c, tone(move));
      spark(r.spk, m.coin, move);
    });
    loadSparks(mk2);
  }

  function selectCoin(sym, pid) {
    S.sym = sym; S.pid = pid || null; S.place = 'coin'; S.sig = ''; paint();
  }

  function paintDesktopCenter() {
    var inner = el.centerInner, dirbar = el.dirbar;
    if (!S.sym) { var first = (api.markets() || [])[0]; if (first) S.sym = first.sym; }   /* a wide screen opens on the first coin, never an empty middle */
    if (!S.sym) {
      /* no coin selected: welcome message */
      var sig = 'center-welcome';
      if (DK.centerSig !== sig) {
        DK.centerSig = sig;
        inner.textContent = '';
        dirbar.hidden = true;
        add(inner, [h('div', 'sm-label', 'Select a coin'), h('p', 'sm-mid', 'Pick a coin from the list on the left to see the price and trade.')]);
      }
      return;
    }

    var m = market(S.sym), q = api.price(S.sym), w = api.wallet(), a = api.account();
    var ps = w.account && a.loaded ? api.positions().filter(x => x.sym === S.sym) : [];
    var allOs = w.account ? ffOrders() : [], os = allOs.filter(o => o.sym === S.sym);

    var allPs = w.account && a.loaded ? api.positions() : [];
    /* (cf_FILLFEEL) an order on its way stands here as the trade it becomes (ffLook): among this coin's cards and among "All
       your open trades", the strip that is in view on a wide screen; one that will not become a trade: what became of it */
    var overs = os.filter(o => !ffLook(o)), psD = ffLooks(os).concat(ps), allD = ffLooks(allOs).concat(allPs);
    var sig = ['center', S.sym, S.pid, psD.map(x => x.id).join(','), overs.map(o => o.key).join(','), allD.map(x => x.id).join(','), COIN.tf, S.place].join('|');
    if (DK.centerSig !== sig) {
      DK.centerSig = sig;
      /* (cf_FILLFEEL) built again when an order or a trade comes or goes: this coin's chart, alive and on screen, is kept as it
         is (made anew it stood empty for a moment each time), and so is how far the middle is scrolled */
      var was = DK.CR, keepC = !!(m && was && was.chart && was.chart.isConnected && smChart.api && smChart.host === was.chartHost && smChart.coin === m.coin), y0 = inner.scrollTop;
      inner.textContent = '';
      DK.CR = { cards: {} };

      add(inner, h('div', 'sm-cname', nameOf(S.sym)));
      var cbar = h('div', 'sm-cbar');
      DK.CR.px = h('span', 'sm-price', '—');
      DK.CR.chg = h('span', 'sm-chg', '');
      add(cbar, [DK.CR.px, DK.CR.chg]);
      add(inner, cbar);
      /* Per-coin stats */
      DK.CR.stats = h('div', 'sm-stats', '');
      add(inner, DK.CR.stats);

      /* chart: LightweightCharts container */
      var chart = keepC ? was.chart : h('div', 'sm-chart');
      cls(chart, 'sm-chart' + (psD.length || overs.length ? ' is-set' : ''));      /* an order has its trade's place from the press */
      DK.CR.chart = chart; DK.CR.chartHost = keepC ? was.chartHost : h('div', 'sm-chart-lw');
      DK.CR.csay = keepC ? was.csay : h('div', 'sm-chart-say', '');
      if (!keepC) add(chart, [DK.CR.chartHost, DK.CR.csay]);
      add(inner, chart);

      /* timeframe and mode buttons */
      DK.CR.tf = h('div', 'sm-tf');
      CHART_TF.forEach(function (t) {
        var b = btn(null, t, () => { setSmChartTf(t); S.sig = ''; paint(); });
        DK.CR.tf.appendChild(b);
      });
      /* Line/Candles toggle */
      DK.CR.lineBtn = btn(null, 'Line', () => { setSmChartMode('line'); S.sig = ''; paint(); });
      DK.CR.candleBtn = btn(null, 'Candles', () => { setSmChartMode('candles'); S.sig = ''; paint(); });
      DK.CR.tf.appendChild(h('span', 'sm-tf-sep', ''));
      DK.CR.tf.appendChild(DK.CR.lineBtn);
      DK.CR.tf.appendChild(DK.CR.candleBtn);
      add(inner, DK.CR.tf);

      /* initialize chart after layout */
      if (!keepC) setTimeout(() => { initSmChart(DK.CR.chartHost, m.coin, m.sz); }, 0);

      /* positions */
      if (psD.length || overs.length) {
        var trades = h('div', 'sm-trades');
        overs.forEach(o => { var s = o.slot || ffSlot(o.key); if (s) trades.appendChild(ffOverCard({ k: 'o' + o.key, s: s, o: o }).n); });
        psD.forEach(x => { trades.appendChild(buildPosCardDesktop(x)); });
        var tl = h('div', 'sm-label', (psD.length + overs.length > 1 ? 'Your trades on ' : 'Your trade on ') + S.sym); tl.style.marginTop = '28px'; add(inner, [tl, trades]);
      }
      if (keepC) inner.scrollTop = y0;

      /* Up/Down bar */
      dirbar.hidden = false;
      dirbar.textContent = '';
      add(dirbar, [
        btn('sm-dir is-up', ['▲ UP', h('i', null, '(Click here to open)')], () => { openOrderDesktop(S.sym, true); }),
        btn('sm-dir is-dn', ['▼ DOWN', h('i', null, '(Click here to open)')], () => { openOrderDesktop(S.sym, false); })
      ]);

      /* All open trades section: all positions across all coins */
      var allTr = el.allTrades;
      if (allD.length) {
        allTr.hidden = false;
        allTr.textContent = '';
        DK.AT = { cards: {} };
        add(allTr, h('div', 'sm-label', 'All your open trades'));
        allD.forEach(x => {
          var c = DK.AT.cards[x.id] = { pnl: h('span', 'sm-all-pnl', '—'), close: h('button', 'sm-all-close', 'Close'), room: h('span', 'sm-room-s') };
          var coin = h('span', 'sm-all-coin', x.sym); coin.addEventListener('click', () => { selectCoin(x.sym, x.id); });
          var pill = c.pill = h('span', 'sm-all-pill ' + (x.isLong ? 'sm-pill is-up' : 'sm-pill is-dn'), (x.isLong ? '▲ ' : '▼ ') + boostOf(x) + '×');
          var inAmt = c.inAmt = h('span', 'sm-all-in', usdS(x.margin) + ' in');
          c.close.addEventListener('click', () => { if (c.close._act) { if (!early()) c.close._act(); return; } closeGo(x.id); });
          c.auto = h('span', 'sm-all-auto', ''); c.auto.hidden = true;      /* its take profit and stop loss once set (kept current below) */
          var card = h('div', 'sm-all-card', [coin, pill, inAmt, c.room, c.pnl, c.close, c.auto]);
          if (x.ff) ffGuard(card);
          allTr.appendChild(card);
        });
      } else {
        allTr.hidden = true;
        DK.AT = null;
      }
    }

    /* update values */
    if (q && m) {
      var px = q.px, prev = q.prev, move = prev > 0 && px > 0 ? px / prev - 1 : NaN;
      txt(DK.CR.px, price(px, q.sz)); cls(DK.CR.px, 'sm-price' + (String(price(px, q.sz)).length > 10 ? ' is-long' : ''));
      txt(DK.CR.chg, isFinite(move) ? arrow(move) + pct(move) + ' today' : ''); cls(DK.CR.chg, 'sm-chg ' + tone(move));
      /* update stats */
      if (DK.CR.stats) {
        var cs = api.coinStats(S.sym);
        var parts = [];
        if (cs && isFinite(cs.oiUp)) parts.push('Open Up ' + usdK(cs.oiUp));
        if (cs && isFinite(cs.oiDown)) parts.push('Open Down ' + usdK(cs.oiDown));
        if (cs && isFinite(cs.vol24h) && cs.vol24h > 0) parts.push('24h volume ' + usdK(cs.vol24h));
        txt(DK.CR.stats, parts.join(' · ') || '');
      }
      /* update chart: sync price lines, update last candle from live price */
      syncSmPriceLines();
      if (px > 0 && smChart.candles.length) updateSmChartFromPrice(px);
    }

    /* trade cards: P&L, the Close button, and why a close did not happen */
    psD.forEach(x => {
      var c = DK.CR.cards && DK.CR.cards[x.id]; if (!c) return;
      var mine = COIN.closing === x.id, err = COIN.errs[x.id] || '';
      txt(c.pnl, (x.est ? '≈ ' : '') + usdP(x.pnl)); cls(c.pnl, 'sm-pnl ' + tone(x.pnl));
      roomSet(c.room, x);
      /* a close held up past its window, or out of time: the card's one key finishes it or asks again, as on a phone */
      var sb = x.status && !x.status.final && x.status.btn ? x.status.btn : '', again = /again/i.test(sb);
      var own = !!(sb && !again && x.status.own);
      /* a close on its way that this page did not start here (a take profit / stop loss, another tab) is said too */
      var going = !sb && (mine || !!(x.status && !x.status.final));
      txt(c.go, sb ? (again ? 'Try closing again' : own ? 'Close now from your wallet' : 'Finish closing now') : going ? 'Closing' + partOf(x) + '…' : x.status ? 'Closed' : 'Close · take about ' + usd(x.payout));
      c.go.disabled = !sb && (!!COIN.closing || !!x.status); c.go._act = sb ? () => { heldCloseGo(x.id, own); } : null;
      var say = err || (sb ? (again ? 'It did not close. Your trade is still open.' : own ? OWN_SAY : 'It is taking longer than usual. One press finishes it.') : '');
      var as = say ? '' : autoSay(x);      /* else: a take profit / stop loss that fired, or waits on hold */
      txt(c.say, say || as); cls(c.say, 'sm-say' + (say ? ' is-bad' : ' is-warn')); show(c.say, !!(say || as));
      otKey(c.go, c.say, x);      /* one-tap for everyone: this close's wallet step, said on its key */
      txt(c.entry, price(x.entry, x.sz)); txt(c.end, price(x.endPx, x.sz));
      txt(c.in, usdS(x.margin) + ' × ' + boostOf(x));
      autoKeySet(c.ak, x, !!(x.status || mine));
      partKeysSet(c.pk, x, !!(x.status || mine));
      poweredSet(c.pb);
      ffLate(c, x); ffPartLook(c, x);
    });
    overs.forEach(o => { var c = DK.CR.cards && DK.CR.cards['o' + o.key]; if (c) ffOverPaint(c, o); });

    /* all trades section: update P&L */
    if (DK.AT && DK.AT.cards) {
      allD.forEach(x => {
        var c = DK.AT.cards[x.id]; if (!c) return;
        var ok = !x.delayed && isFinite(x.pnl);
        txt(c.pnl, ok ? (x.est ? '≈ ' : '') + usdP(x.pnl) : '—'); cls(c.pnl, 'sm-all-pnl ' + (ok ? tone(x.pnl) : ''));
        roomShort(c.room, x, '', false);
        /* a close held up past its time: this row's key finishes it, closes it from the wallet, or asks again */
        var st = x.status, sb = st && !st.final && st.btn ? st.btn : '', again = /again/i.test(sb), own = !!(sb && !again && st.own);
        c.close._act = sb ? () => { heldCloseGo(x.id, own); } : null;
        c.close.disabled = !sb && (!!COIN.closing || !!st);
        c.close.textContent = sb ? (again ? 'Close again' : own ? 'Close now' : 'Finish now') : st && st.final ? 'Closed' : OT.close && OT.close.pid === x.id ? 'In your wallet…' : st || COIN.closing === x.id ? 'Closing…' : 'Close';
        if (sb) c.close.title = again ? 'It did not close. Your trade is still open.' : own ? OWN_SAY : 'It is taking longer than usual. One press finishes it.'; else c.close.removeAttribute('title');
        var a = x.auto || {}, at = [a.tp != null ? 'Take profit ' + price(a.tp, x.sz) : '', a.sl != null ? 'Stop loss ' + price(a.sl, x.sz) : ''].filter(Boolean).join(' · ');
        txt(c.auto, at); show(c.auto, !!at);
        txt(c.pill, (x.isLong ? '▲ ' : '▼ ') + boostOf(x) + '×'); txt(c.inAmt, usdS(x.margin) + ' in');      /* both move when part closes or money is added */
      });
    }

    /* update tf and mode buttons */
    each(DK.CR.tf, b => {
      var t = b.textContent;
      if (t === 'Line') b.setAttribute('aria-pressed', COIN.mode === 'line' ? 'true' : 'false');
      else if (t === 'Candles') b.setAttribute('aria-pressed', COIN.mode === 'candles' ? 'true' : 'false');
      else b.setAttribute('aria-pressed', t === COIN.tf ? 'true' : 'false');
    });
  }

  function buildPosCardDesktop(x) {
    var card = h('div', 'sm-pos');
    var c = { n: card, pnl: h('div', 'sm-pnl'), say: h('p', 'sm-say is-bad') };
    c.in = h('span', 'sm-in', usdS(x.margin) + ' × ' + boostOf(x));
    var hdr = h('div', 'sm-pos-h', [h('span', null, [sidePill(x.isLong), c.in])]);
    add(card, hdr);
    c.room = roomNew();
    c.go = btn('sm-btn is-primary', '', () => { if (c.go._act) { if (!early()) c.go._act(); return; } if (!COIN.closing && !early()) closeGo(x.id); });
    /* the phone card's figures under the key: where it opened, where it closes itself, its take profit and stop loss,
       then Close part and Add to this trade (v5) */
    c.entry = h('span', null, '—'); c.end = h('span', 'sm-dn', '—'); c.ak = autoKey(x); c.pk = partKeys(x); c.pb = poweredRow();
    c.say.hidden = true; add(card, [c.pnl, c.room.n, c.go, c.say,
      h('div', 'sm-kvs', [h('div', 'sm-kv', [h('span', null, 'You opened at'), c.entry]), h('div', 'sm-kv', [h('span', null, 'Closes itself at'), c.end]), c.ak.n, c.pk ? c.pk.n : null, c.pb])]);
    DK.CR.cards[x.id] = c;
    if (x.ff) ffGuard(card, () => c.go._ffLive ? c.go : null);      /* (cf_FILLFEEL) an order drawn as its trade: its keys wait for the trade */
    return card;
  }

  function paintDesktopRight() {
    if (!DK.panel) {
      el.root.classList.remove('has-panel');
      return;
    }
    el.root.classList.add('has-panel');
    if (DK.panel === 'order') paintDesktopOrder();
    else if (DK.panel === 'add') paintDesktopAdd();
    else if (DK.panel === 'done') paintDesktopDone();
  }

  function openOrderDesktop(sym, isLong) {
    var w = api.wallet();
    if (!w.account) { doConnect(); return; }
    DK.panel = 'order'; DK.orderSym = sym; DK.orderLong = isLong;
    DK.orderTyped = '10'; DK.orderAll = false; DK.orderErr = '';
    var m = market(sym), steps = boosts(m ? m.maxLev : 20);
    DK.orderLev = steps.filter(v => v <= 20).pop() || steps[0];
    DK.orderCustom = false; DK.orderLevBad = false; DK.orderAuto = false; DK.orderSig = ''; DK.busy = false;
    S.sig = ''; paint();
  }

  function openAddDesktop() {
    var w = api.wallet(), p = ADD.pend;
    if (!w.account) { doConnect(); return; }
    if (api.demo) { api.pro('addUsdc'); return; }  /* demo has no wallet to send from: Pro's own sheet */
    if (api.gate() && !p) { snack(OFF); return; }
    if (DK.panel && DK.panel !== 'add') closePanel();
    DK.panel = 'add';
    /* the panel stands in for the phone's Add sheet, so every "is the Add sheet open" check and every repaint reaches it */
    ADD.sh = { dk: true, get isOpen() { return DK.panel === 'add'; }, get body() { return el.panelBody; }, get foot() { return el.panelFoot; }, get title() { return el.panelHead.querySelector('h2'); }, get d() { return el.right; }, close: closePanel, open: noop };
    if (p && !p.final && p.state === 'arrived') ADD.fin = ADD.fin || finOf(p);
    if (!ADD.busy) ADD.view = viewOf(p);
    ADD.err = ''; ADD.built = ''; ADD.note = ''; ADD.auto = false;
    api.refresh().catch(noop); readBalances(); scheduleQuote(0);
    S.sig = ''; paint();
  }

  function closePanel() {
    DK.panel = ''; DK.busy = false; DK.done = null;
    el.root.classList.remove('has-panel');
    ADD.busy = ''; clearTimeout(ADD.qtimer); clearTimeout(ADD.btimer);
    if (ADD.run) endRun(null);
    S.sig = ''; paint();
  }

  function paintDesktopOrder() {
    var head = el.panelHead, body = el.panelBody, foot = el.panelFoot;
    var sym = DK.orderSym, up = DK.orderLong, m = market(sym);
    if (!m) { closePanel(); return; }

    var sig = 'order|' + sym + '|' + up;
    if (DK.orderSig !== sig) {
      DK.orderSig = sig;
      head.querySelector('h2').textContent = '';
      add(head.querySelector('h2'), [sym + ' ', sidePill(up)]);
      head.querySelector('.sm-x').onclick = closePanel;
      body.textContent = ''; foot.textContent = '';

      /* build order form */
      var amt = ordAmount();
      DK.OR = {};
      DK.OR.amt = amtInput('smDkOrdAmount', 'Amount', DK.orderTyped, v => { DK.orderTyped = v; DK.orderAll = false; DK.orderErr = ''; paint(); });
      var lab = h('label', 'sm-label is-amt', ['Amount', h('span', 'sm-hint', 'Type any amount')]); lab.htmlFor = 'smDkOrdAmount';
      var chips = h('div', 'sm-chips');
      [5, 10, 25, 'all'].forEach(v => {
        var b = btn(null, v === 'all' ? 'All' : '$' + v, () => {
          var bal = api.account().available;
          DK.orderAll = v === 'all'; DK.orderTyped = String(v === 'all' ? Math.floor(bal * 100) / 100 : v);
          DK.OR.amt.value = DK.orderTyped; DK.orderErr = ''; paint();
        });
        b._v = v; chips.appendChild(b);
      });
      DK.OR.chips = chips;

      /* boost selector */
      var steps = boosts(m.maxLev);
      var seg = h('div', 'sm-seg is-grid');
      steps.forEach(v => {
        var b = btn(null, v + '×', () => { DK.orderLev = v; DK.orderCustom = false; DK.orderLevBad = false; DK.orderErr = ''; paint(); });
        b._v = v; seg.appendChild(b);
      });
      var cb = btn(null, 'Custom', () => {
        DK.orderCustom = true; DK.orderErr = '';
        if (steps.indexOf(DK.orderLev) >= 0) { DK.OR.lev.value = ''; DK.orderLevBad = true; }
        paint(); setTimeout(() => { DK.OR.lev.focus(); }, 30);
      });
      cb._v = 'custom'; seg.appendChild(cb);
      DK.OR.seg = seg;
      DK.OR.lev = h('input'); DK.OR.lev.id = 'smDkOrdLev'; DK.OR.lev.type = 'text'; DK.OR.lev.setAttribute('inputmode', 'numeric');
      DK.OR.lev.setAttribute('autocomplete', 'off'); DK.OR.lev.placeholder = 'e.g. ' + Math.min(m.maxLev, 75);
      DK.OR.lev.addEventListener('input', () => {
        var d = DK.OR.lev.value.replace(/[^0-9]/g, '').slice(0, 4); if (d !== DK.OR.lev.value) DK.OR.lev.value = d;
        var n = Number(d); DK.orderErr = '';
        if (d && n >= 1 && n <= m.maxLev) { DK.orderLev = n; DK.orderLevBad = false; } else DK.orderLevBad = true;
        paint();
      });
      DK.OR.levBox = h('label', 'sm-levc', [h('span', null, 'Your boost'), h('span', 'sm-levc-in', [DK.OR.lev, h('b', null, '×')]), h('i', null, '1× to ' + m.maxLev + '×')]);
      DK.OR.levBox.htmlFor = 'smDkOrdLev';

      /* outcome display */
      DK.OR.risk = h('p', 'sm-risk', '');
      DK.OR.w = h('b', 'sm-up', ''); DK.OR.l = h('b', 'sm-dn', '');
      DK.OR.wk = h('span'); DK.OR.lk = h('span');

      /* take profit and stop loss, both in view, as on a phone */
      var again = () => { DK.orderErr = ''; paint(); };
      DK.OR.tp = autoField('tp', again, true); DK.OR.sl = autoField('sl', again, true);
      DK.OR.autoFine = h('p', 'sm-fine sm-ak-fine', '');

      add(body, [lab, h('label', 'sm-amt is-mid', [h('span', null, '$'), DK.OR.amt]), chips,
        h('div', 'sm-label', 'Boost'), seg, DK.OR.levBox, DK.OR.risk,
        h('div', 'sm-out', [h('div', null, [DK.OR.wk, DK.OR.w]), h('div', null, [DK.OR.lk, DK.OR.l])]),
        h('div', 'sm-ak-two', [DK.OR.tp.n, DK.OR.sl.n]), DK.OR.autoFine]);

      DK.OR.say = sayLine();
      DK.OR.go = btn('sm-btn', '', () => { desktopOrderGo(); });
      add(foot, [DK.OR.say, DK.OR.go]);
    }

    /* update values */
    var amt2 = parseFloat(String(DK.orderTyped).replace(/[^0-9.]/g, '')) || 0;
    var lev = DK.orderLev, a = api.account();
    var t = api.trade({ sym: sym, isLong: up, margin: amt2, lev: lev }) || {};
    var mv = api.fmt.move(t.endPct);

    each(DK.OR.chips, b => { b.setAttribute('aria-pressed', (b._v === 'all' ? DK.orderAll : !DK.orderAll && amt2 === b._v) ? 'true' : 'false'); });
    each(DK.OR.seg, b => {
      b.setAttribute('aria-pressed', (b._v === 'custom' ? DK.orderCustom : !DK.orderCustom && b._v === lev) ? 'true' : 'false'); b.disabled = !!DK.busy;
      if (b._v === 'custom') txt(b, DK.orderCustom && !DK.orderLevBad ? lev + '×' : 'Custom');
    });
    show(DK.OR.levBox, !!DK.orderCustom); DK.OR.lev.disabled = DK.OR.amt.disabled = !!DK.busy;

    txt(DK.OR.risk, lev + '× makes every 1% move worth ' + lev + '%. A ' + mv + '% ' + (up ? 'drop' : 'rise') + ' closes this trade and the ' + (amt2 > 0 ? usdS(amt2) : 'money') + ' is gone.');
    txt(DK.OR.wk, sym + (up ? ' up 1%' : ' down 1%')); txt(DK.OR.w, isFinite(t.win1) ? usdP(t.win1) : '—');
    txt(DK.OR.lk, sym + (up ? ' down ' : ' up ') + mv + '%'); txt(DK.OR.l, amt2 > 0 ? '−' + usd(amt2) : '—');

    var oo = { sym: sym, isLong: up, margin: amt2, lev: lev }, tpF = DK.OR.tp, slF = DK.OR.sl;
    autoShow(tpF, api.autoRead(oo, 'tp', tpF.i.value), t.sz, up, t.endPx); autoShow(slF, api.autoRead(oo, 'sl', slF.i.value), t.sz, up, t.endPx);
    tpF.i.disabled = slF.i.disabled = !!DK.busy;
    var onChain = api.autoChain && api.autoChain(sym);      /* v6: this open takes them on chain */
    txt(DK.OR.autoFine, 'Optional. ' + (onChain ? 'They close this trade even when Confetti is closed.' : honest()));
    var tp = num(tpF.i.value), sl = num(slF.i.value), fin = tpF.fin != null ? tpF.fin : slF.fin;
    DK.OR.want = { tp: tp, sl: sl };

    var needMoney = a.loaded && t.min > 0 && a.available < t.min;
    var why = '';
    if (t.block) why = plain(t.block);
    else if (DK.orderCustom && DK.orderLevBad) why = 'Type a boost from 1× to ' + m.maxLev + '×.';
    else if (needMoney) why = 'You need at least ' + usdS(t.min) + ' to trade.';
    else if (!(amt2 > 0)) why = 'Type an amount.';
    else if (amt2 < t.min) why = 'The smallest trade is ' + usdS(t.min) + '.';
    else if (amt2 > a.available + 1e-9) why = 'That is more than your trading money (' + usd(a.available) + ').';
    else if (t.problem) why = plain(t.problem);
    else if (fin != null) why = 'Finish the ' + (tpF.fin != null ? 'take profit' : 'stop loss') + ' price: did you mean ' + price(fin, t.sz) + '?';
    else if (tp != null || sl != null) why = tpF.bad || slF.bad || autoWhy(api.autoCheck(oo, tp, sl) || '');

    /* one-tap for everyone, as on a phone (paintOrder): said above the key before the press, what the wallet shows while it is
       asked, and Add money as the key for a wallet short of the HYPE for it */
    var ot = !why ? otWhy(oo) : '', otShort = !!ot && !DK.busy && otView().short;
    if (otShort) why = OT_SHORT;
    /* a take profit or stop loss typed: what to know about it stands above the button (as on a phone) */
    var note = DK.busy && DK.ot ? DK.ot : ot && !otShort && !DK.orderErr ? otNote(ot)
      : !why && !DK.orderErr && (tp != null || sl != null) ? (onChain ? CHAIN_ALWAYS : (tp != null && sl != null ? 'Your take profit and stop loss fire' : tp != null ? 'Your take profit fires' : 'Your stop loss fires') + ' while Confetti is open in this browser.') : '';
    if (onChain && sl != null) txt(DK.OR.autoFine, chainStop(lev));
    show(DK.OR.autoFine, (tp == null && sl == null) || (onChain && sl != null));
    txt(DK.OR.say, why || DK.orderErr || note); cls(DK.OR.say, 'sm-say' + ((why && !autoWait(why)) || DK.orderErr ? ' is-bad' : DK.busy && DK.ot ? ' is-warn' : ''));
    /* (cf_FILLFEEL) the key answers by going down, with its own words: the wallet's turn is said, never a wait ("Opening…") */
    var word = DK.busy && (DK.ot || (!api.demo && (!api.session().live || t.oneTap))) ? CONFIRM : '';
    DK.OR.go._add = (needMoney || otShort) && !t.block && !DK.busy;
    txt(DK.OR.go, word || (DK.OR.go._add ? 'Add money' : 'Open ' + (up ? 'UP' : 'DOWN') + ' · ' + usdS(amt2) + ' × ' + lev));
    cls(DK.OR.go, 'sm-btn ' + (DK.OR.go._add ? 'is-primary' : up ? 'is-up' : 'is-dn') + (DK.busy ? ' is-busy' : ''));
    DK.OR.go.disabled = !!DK.busy || (!!why && !DK.OR.go._add);
  }

  function desktopOrderGo() {
    if (DK.busy || early()) return;
    if (DK.OR.go._add) { closePanel(); openAddDesktop(); return; }
    if (DK.OR.go.disabled) return;
    var amt = parseFloat(String(DK.orderTyped).replace(/[^0-9.]/g, '')) || 0, want = DK.OR.want || {};
    var o = { sym: DK.orderSym, isLong: DK.orderLong, margin: amt, lev: DK.orderLev, maxed: DK.orderAll, tp: want.tp != null ? want.tp : null, sl: want.sl != null ? want.sl : null };
    var s = api.session(), t = api.trade(o) || {}, ot = otWhy(o);
    /* this press has a token: closing the panel ends it, and a press that has ended sends nothing */
    var mine = DK.busy = Date.now() + Math.random();
    DK.orderErr = ''; DK.ot = ot ? otAsk(ot, 'Then this trade opens.') : ''; S.claim = true; S.lastErr = null; paint();
    /* one-tap for everyone: the wallet is asked that one thing first (otStep), then the open goes out through one-tap */
    (ot ? otStep(o) : !api.demo && (!s.live || t.oneTap) ? timed(api.toHyperEvm(), 30000, STAYED + 'nothing was sent. Press again and let it change.') : Promise.resolve()).then(() => {
      DK.ot = '';
      if (DK.busy !== mine || DK.panel !== 'order') { S.claim = false; return; }
      var why = api.open(o); DK.busy = false; S.claim = false; if (!why) { ffTap(o); ffAsk(); }
      if (why) { DK.orderErr = plain(why); paint(); return; }
      if (!o.maxed) lsSet(AMT_KEY, String(o.margin)); lsSet('confetti.trade.lev.' + o.sym, String(o.lev));
      closePanel();
    }, e => { DK.ot = ''; if (DK.busy !== mine) return; DK.busy = false; S.claim = false; DK.orderErr = errText(e); paint(); });
  }

  function paintDesktopAdd() {
    var head = el.panelHead, body = el.panelBody, foot = el.panelFoot;
    var v = ADD.view || 'form';

    head.querySelector('h2').textContent = v === 'form' ? 'Add money' : v === 'moving' || v === 'apple' ? 'On its way' : v === 'pay' ? payTitle(ADD.pend) : v === 'ready' ? 'Added' : v === 'finish' ? 'Finish adding' : 'Not added';
    head.querySelector('.sm-x').onclick = closePanel;

    if (ADD.built !== v + '-dk') {
      ADD.built = v + '-dk'; body.textContent = ''; foot.textContent = ''; ADD.R = {};
      /* Create a temporary sheet-like object for build functions to use the panel directly */
      var tempSh = { title: head.querySelector('h2'), body: body, foot: foot, d: el.right, isOpen: true, close: closePanel };
      var oldSh = ADD.sh;
      ADD.sh = tempSh;
      ({ form: buildForm, moving: buildMoving, apple: buildMoving, ready: buildReady, fail: buildFail, finish: buildFinish, pay: buildPay })[v]();
      ADD.sh = oldSh;
    }
    /* Use temp sheet for fill functions so they update the panel elements */
    var tempSh2 = { title: head.querySelector('h2'), body: body, foot: foot, d: el.right, isOpen: true, close: closePanel };
    var oldSh2 = ADD.sh;
    ADD.sh = tempSh2;
    ({ form: fillForm, moving: fillMoving, apple: fillMoving, ready: fillReady, fail: noop, finish: fillFinish, pay: fillPay })[v]();
    fillWait();
    ADD.sh = oldSh2;
  }

  /* Escape key closes panel */
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && shown() && isDesktop() && DK.panel && !document.querySelector('dialog[open]')) { closePanel(); ev.preventDefault(); }
  });


  function paintTop() {
    var w = api.wallet(), a = api.account(), hs = api.houseStats();
    var dk = isDesktop();
    var key = [dk ? 'dk' : (S.place === 'coin' ? S.sym : ''), w.account || '', w.ready, w.has, a.loaded, window.innerWidth < 380, dk ? '' : topFit(), hs.loaded].join('|');
    if (el.top.getAttribute('data-k') !== key) {
      el.top.setAttribute('data-k', key); el.top.textContent = '';
      var left;
      /* a signed-in phone bar has a Menu key at its end: Back's coin name steps down a size when it is a long one (CSS, by width) */
      el.top.classList.toggle('has-menu', !dk && !!w.account);
      if (!dk && S.place === 'coin') { left = btn('sm-back' + (S.sym.length > 6 ? ' is-long' : S.sym.length > 4 ? ' is-mid' : ''), [h('span', 'sm-arr', '←'), S.sym], () => { back(); }); left.setAttribute('aria-label', 'Back to the coins'); }
      else {
        left = h('a', 'sm-logo', ['confetti', h('i', null, '_')]); left.href = 'trade.html'; left.setAttribute('aria-label', 'confetti, home');
        left.addEventListener('click', ev => { ev.preventDefault(); if (!dk && S.place !== 'home') back(); else if (el.main) el.main.scrollTop = 0; });
      }
      /* House chip: LP and site-wide 24h volume, links to house.html */
      var houseVal = hs.loaded ? usdK(hs.lp) : '—';
      var volVal = hs.vol24h > 0 ? usdK(hs.vol24h) : '';
      /* the volume slot always exists: the 24h scan lands seconds after the first paint, and the refresh below fills it */
      var houseInner = [h('b', null, 'House ' + houseVal), h('i', null, volVal ? '24h ' + volVal : '')];
      R.house = h('a', 'sm-house', h('span', null, houseInner)); R.house.href = 'house.html';
      R.house.setAttribute('aria-label', 'House LP ' + houseVal + (volVal ? ', 24h volume ' + volVal : '') + '. View house stats');
      var rightItems = [];
      if (dk) {
        /* Desktop header: house chip, money chip (connected), wallet chip or Connect button, Menu */
        rightItems.push(R.house);
        if (w.account) {
          R.money = btn('sm-chip', h('span', null, h('b', null, '')), () => { openAddDesktop(); });
          R.money.setAttribute('aria-label', 'Your trading money. Add money');
          rightItems.push(R.money);
          R.who = btn('sm-chip', h('span', null, [h('i', 'sm-dot'), short(w.account)]), openMenu);
          R.who.setAttribute('aria-label', 'Wallet ' + w.account + '. Menu');
          rightItems.push(R.who);
        } else {
          R.connect = btn('sm-connect', 'Connect wallet', doConnect);
          R.connect.setAttribute('aria-label', 'Connect your wallet to trade');
          rightItems.push(R.connect);
        }
        R.menu = btn('sm-chip', h('span', null, 'Menu'), openMenu);
        R.menu.setAttribute('aria-label', 'Menu');
        rightItems.push(R.menu);
      } else {
        /* Phone header: house chip, the wallet chip (connected), and a Menu key last, as on desktop (owner 11/18: "it doesnt
           have a menu button at the top you have to click on your wallet address to see the menu"). Money is shown on page.
           A visitor's one chip already says Menu. Both keys open the same menu. */
        rightItems.push(R.house);
        R.who = btn('sm-chip' + (w.account ? ' sm-who-key' : ' is-off'), h('span', null, w.account ? [h('i', 'sm-dot'), shortTop(w.account)] : 'Menu'), openMenu);
        R.who.setAttribute('aria-label', w.account ? 'Wallet ' + w.account + '. Menu' : 'Menu');
        rightItems.push(R.who);
        if (w.account) {
          /* the word; on the narrowest phones (under 370 px) three drawn bars stand in for it (CSS) */
          R.menu = btn('sm-chip sm-menu-key', h('span', null, [h('b', 'sm-menu-w', 'Menu'), h('i', 'sm-bars')]), openMenu);
          R.menu.setAttribute('aria-label', 'Menu');
          rightItems.push(R.menu);
        }
      }
      add(el.top, [left, h('span', 'sm-top-r', rightItems)]);
    }
    /* Update house chip value */
    if (R.house) {
      var hsNow = api.houseStats();
      var hv = hsNow.loaded ? usdK(hsNow.lp) : '—';
      var vv = hsNow.vol24h > 0 ? usdK(hsNow.vol24h) : '';
      var hb = R.house.querySelector('b');
      if (hb) txt(hb, 'House ' + hv);
      var hi = R.house.querySelector('i');
      if (hi && vv) txt(hi, '24h ' + vv);
      else if (hi && !vv) hi.textContent = '';
    }
    /* Update money chip value */
    if (R.money && w.account && a.loaded) {
      txt(R.money.querySelector('b'), usd(a.available));
      show(R.money, dk || S.place !== 'home');
    } else if (R.money) {
      show(R.money, false);
    }
  }

  /* ---- Home: your trading money, Add money, the coins ---- */

  function homeState(w, a) { return !w.account ? 'visitor' : !a.loaded ? 'loading' : (a.available >= 1 || a.inTrades > 0) ? 'money' : 'empty'; }
  function paintHome() {
    var w = api.wallet(), a = api.account(), mk = api.markets();
    var ps = w.account && a.loaded ? api.positions() : [], os = w.account ? ffOrders() : [];
    var st = homeState(w, a), p = ADD.pend;
    var sig = ['home', st, w.has, p ? p.rail + p.state : '', S.res ? S.res.key : '', S.away.map(x => x.key).join(','), ps.map(x => x.id).join(','), os.map(x => x.key).join(','),
      mk.map(m => m.sym).join(','), api.applePayOn(), a.inTrades > 0, old4Sig(), fxShow(w, st)].join('|');
    if (S.sig !== sig) { S.sig = sig; buildHome(st, w, a, mk, ps, os, p); }
    if (R.fx) fxFill(R.fx);
    var bt = st !== 'visitor' && a.loaded ? usd(a.available) : '$—';      /* no wallet yet: a dash, as on the desktop page, never "$0.00" */
    txt(R.bal, bt); cls(R.bal, 'sm-big' + (bt.length > 11 ? ' is-longer' : bt.length > 9 ? ' is-long' : ''));
    if (R.sub && st === 'money') txt(R.sub, a.inTrades > 0 ? usd(a.inTrades) + ' more is in your open trades.' : '');
    if (p && p.final && p.state === 'done' && !(ADD.sh && ADD.sh.isOpen) && Date.now() - (p.at || 0) > 60000) { dropPend(); return; }
    if (R.pend && p) fillPend(p);
    ps.forEach(x => {
      var r = R.rows['p' + see(x)]; if (!r) return;
      var st2 = x.status;
      txt(r.pill, pillText(x.isLong, boostOf(x)));
      txt(r.sub, st2 ? plainStatus(st2.text) : usdS(x.margin) + ' in');
      roomShort(r.room, x, ' · ', !!st2);
      txt(r.v, x.delayed || !isFinite(x.pnl) ? '—' : (x.est ? '≈ ' : '') + usdP(x.pnl)); cls(r.v, tone(x.pnl));
      txt(r.c, x.delayed || !isFinite(x.pnl) ? 'price delayed' : pct(x.pnl / x.margin)); cls(r.c, tone(x.pnl));
    });
    os.forEach(function (o) { var r = R.rows['o' + o.key]; if (r) ffRowLook(r, o); });      /* (cf_FILLFEEL) an order on its way: its trade's row */
    mk.forEach(m => {
      var r = R.rows['m' + m.sym], q = api.price(m.sym); if (!r || !q) return;
      var move = q.prev > 0 && q.px > 0 ? q.px / q.prev - 1 : NaN;
      flash(r.v, q.px); txt(r.v, price(q.px, q.sz)); r.v.style.color = q.at && Date.now() - q.at < 15000 ? '' : 'var(--ink-muted)';
      txt(r.c, isFinite(move) ? arrow(move) + pct(move) : ''); cls(r.c, tone(move));
      spark(r.spk, m.coin, move);
    });
    loadSparks(mk);        /* the rows on screen now; cheap when nothing is due */
  }
  function buildHome(st, w, a, mk, ps, os, p) {
    var main = el.main, cta = el.cta;
    main.className = 'sm-main'; main.textContent = ''; cta.textContent = ''; cta.className = 'sm-cta';
    R.rows = {}; R.pend = null; R.sub = null;
    if (api.demo) add(main, h('p', 'sm-fine', 'Demo: pretend money. Nothing here is real.'));
    add(main, [h('div', 'sm-label', 'Your trading money'), R.bal = h('div', 'sm-big', '')]);
    if (st === 'visitor') add(main, h('p', 'sm-mid', 'Pick a coin and say if it goes up or down. Connect a wallet to start, or just look around.'));
    else if (st === 'empty' && !p) add(main, h('p', 'sm-mid', api.applePayOn() ? 'Add money to start: Apple Pay, HYPE in your wallet, or ETH on Base, Arbitrum or Ethereum.' : 'Add money to start, with HYPE in your wallet or ETH on Base, Arbitrum or Ethereum.'));
    else if (st === 'money') {
      if (a.inTrades > 0) add(main, R.sub = h('p', 'sm-mid', ''));
      add(main, h('div', 'sm-links', [btn('sm-link', 'Add money', () => { openAdd(); }), a.available > 0 ? btn('sm-link', 'Withdraw', withdraw) : null]));
    }
    R.fx = fxShow(w, st) ? fxCard() : null; if (R.fx) add(main, R.fx.n);
    add(main, flipCard());
    add(main, crashCard());
    var o4 = old4Card(); if (o4) add(main, o4);
    if (p) { R.pend = noteCard(); R.pend.n.addEventListener('click', () => { openAdd(); }); add(main, R.pend.n); }
    if (S.res) {
      var res = S.res, c = noteCard(), win = res.pnl > 0;
      txt(c.b, resTitle(res)); txt(c.i, res.liq ? goneWords(res) : usd(res.paid) + ' is back in your trading money.');
      c.icon.className = 'sm-pill ' + (win ? 'is-up' : 'is-dn'); c.icon.textContent = win ? '✓' : '×';
      c.n.addEventListener('click', () => { S.done = res; S.res = null; go('done', res.sym); });
      add(main, c.n);
    }
    awayCards(d => { go('done', d.sym); }).forEach(n => add(main, n));
    if (ps.length || os.length) {
      var box = h('div', 'sm-rows');
      os.forEach(function (o) { box.appendChild(tradeRow('o' + o.key, o, () => { go('coin', o.sym); })); });
      ps.forEach(function (x) { box.appendChild(tradeRow('p' + x.id, x, () => { go('coin', x.sym, x.id); })); });
      add(main, h('div', 'sm-sec', [h('div', 'sm-label', 'Your trades'), box]));
    }
    var list = h('div', 'sm-rows');
    if (!mk.length) add(list, h('div', 'sm-skel', [h('i'), h('i'), h('i'), h('i'), h('i')]));
    mk.forEach(m => {
      var r = R.rows['m' + m.sym] = { v: h('b', null, '—'), c: h('i'), spk: svg('sm-spk', '0 0 72 28') };
      var tb = h('span', 'sm-trade', [h('span', 'sm-trade-long', 'Click here to place trade'), h('span', 'sm-trade-short', 'Place trade')]);
      var row = btn('sm-row', [h('span', 'sm-tk', [h('b', m.sym.length >= 8 ? 'is-long' : null, m.sym), h('i', null, nameOf(m.sym))]), r.spk, tb, h('span', 'sm-pr', [r.v, r.c])], () => { go('coin', m.sym); });
      list.appendChild(row);
    });
    var sec = h('div', 'sm-sec', [h('div', 'sm-label', 'Trade a coin'), list]); sec.id = 'smCoins';
    add(main, [sec, newsCard()]);
    if (st === 'visitor') {
      add(cta, btn('sm-btn is-primary', w.has ? 'Connect wallet' : 'Open in your wallet app', doConnect));
      if (!api.demo) { var d = h('a', 'sm-link', 'Just looking? Try it with pretend money'); d.href = 'trade.html?demo=1&mode=simple'; d.style.justifyContent = 'center'; add(cta, d); }
    } else if (st === 'empty' && !p) add(cta, btn('sm-btn is-primary', 'Add money', () => { openAdd(); }));
    loadSparks(mk);
  }
  function see(x) { S.seen[x.id] = { sym: x.sym, isLong: x.isLong, lev: boostOf(x), margin: x.margin, stake: x.stake, added: x.added, cc: x.closeCost }; return x.id; }
  /* v5, during the v4 run-off: what the account still has on the earlier version of the exchange, as a note key
     that leads to its page (v4.html: close what is open there, take the money out). Nothing on a v4 config, and
     nothing once that account has nothing left there. */
  function old4() { try { return api.old4 ? api.old4() : null; } catch (e) { return null; } }
  function old4Sig() { var o = old4(); return o ? 'v4:' + Math.round(o.total * 100) + (o.rules ? 'r' : '') : ''; }
  function old4Card() {
    var o = old4(); if (!o) return null;
    var c = noteCard();
    c.icon.className = 'sm-pill'; c.icon.textContent = '$';
    txt(c.b, 'You have ' + usd(o.total) + ' on the earlier version');
    /* v6: a v5 trade's take profit and stop loss are this browser's own rule, and from now on only that page runs it */
    txt(c.i, 'Close what is open there and take it out.' + (o.rules ? ' The take profit and stop loss you set there now work only while that page is open.' : ''));
    c.n.addEventListener('click', () => { location.href = o.href; });
    return c.n;
  }
  /* a result's first line on its card: which level closed the trade, when one did */
  function resTitle(d) {
    if (d.liq) return d.sym + ' closed itself';
    return d.sym + (d.by === 'tp' ? ' closed by your take profit: ' : d.by === 'sl' ? ' closed by your stop loss: ' : ' closed: ') + usdP(d.pnl);
  }
  /* the trades that ended while Confetti was closed: one card each, in the order they were read. A tap opens its result
     (openIt). One that is just gone (nothing was read about how it ended) comes last and goes with its tap: its mark is
     a cross, not the chevron of a card that opens something */
  function awayCards(openIt, desk) {
    return S.away.filter(d => !d.gone).concat(S.away.filter(d => d.gone)).map(d => {
      var c = noteCard(), win = d.pnl > 0;
      if (d.gone) {
        txt(c.b, d.sym + ' is no longer open'); txt(c.i, 'It ended while you were away. Your trading money has what it paid back.');
        c.icon.className = 'sm-pill'; c.icon.textContent = '•';
        var x = c.n.querySelector('.sm-chev'); if (x) x.textContent = '×';
        c.n.setAttribute('aria-label', d.sym + ' is no longer open. It ended while you were away. Dismiss.');
        c.n.addEventListener('click', () => { S.away = S.away.filter(x => x !== d); S.sig = ''; DK.leftSig = ''; kick(); });
        return c.n;
      }
      txt(c.b, resTitle(d)); txt(c.i, desk ? resLine(d, true) : 'While you were away. ' + (d.liq ? goneWords(d) : usd(d.paid) + ' is back in your trading money.'));
      c.icon.className = 'sm-pill ' + (win ? 'is-up' : 'is-dn'); c.icon.textContent = win ? '✓' : '×';
      c.n.addEventListener('click', () => { S.away = S.away.filter(x => x !== d); S.done = d; openIt(d); });
      return desk ? h('div', null, [c.n, resLink(d)]) : c.n;
    });
  }
  /* a result card's second line on a desktop, where the card is all there is of a result (a phone opens the result
     screen): what came back, then how it ended (the level that fired, its price, when it was crossed and when the trade
     closed; or the price and its moment), and a level the page saw reached that did not fire */
  function resLine(d, away) {
    var now = api.result(d.pid) || {}, tw = trigDone(d), at = now.at || '', seen = now.seen ? plainPx(now.seen) : '';
    return (away ? 'While you were away. ' : '')
      + (d.liq ? (d.trig && d.trig.kind === 2 ? 'In one second the price jumped past your stop loss and past the price where this trade closes itself. ' : '') + goneWords(d) : usd(d.paid) + ' is back in your trading money.')
      + (tw ? ' ' + tw : at && d.exit ? ' ' + (d.liq ? 'Closed itself at $' : 'Closed at $') + d.exit + ': ' + at + '.' : '') + (seen ? ' ' + seen : '');
  }
  /* the transaction that closed a trade whose level fired on chain, on the explorer ('' in the demo: its hashes are pretend) */
  function txUrl(d) {
    var now = api.result(d.pid);
    return d.trig && now && now.tx && !api.demo ? String((api.cfg() || {}).explorerUrl || 'https://hyperevmscan.io').replace(/\/$/, '') + '/tx/' + now.tx : '';
  }
  function resLink(d) {
    var u = txUrl(d); if (!u) return null;
    var a = h('a', 'sm-link sm-res-link', 'See it on the chain'); a.target = '_blank'; a.rel = 'noopener'; a.href = u;
    return a;
  }
  /* the coin flip's card (the owner, 2026-11-23: "put FLIP A COIN somwhere on the front page with a picture of the coin linking
     to the coinflip"): a coin drawn in the page's own ink and paper, the words, and the whole card a key to flip.html */
  function flipCard() {
    var coin = h('span', 'sm-flip-coin');
    coin.innerHTML = '<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true" focusable="false"><circle cx="24" cy="24" r="22" fill="#f4ecd8" stroke="#1c1a17" stroke-width="2.5"/><circle cx="24" cy="24" r="16.5" fill="none" stroke="#1c1a17" stroke-width="1" stroke-dasharray="1.5 2.2"/><text x="24" y="31" text-anchor="middle" font-size="19" font-weight="700" font-family="Georgia, serif" fill="#1c1a17">H</text></svg>';
    return btn('sm-note sm-flip-note', [coin, h('span', 'sm-t', [h('b', null, 'FLIP A COIN'), h('i', null, 'Heads or tails. A win pays 1.96x.')]), h('span', 'sm-chev', '›')], () => { location.href = 'flip.html'; });
  }
  /* the crash game's card, beside the coin flip's and built the same way (its classes too): the climbing line drawn in the
     page's own ink and paper with the paper piece at its tip, the words, and the whole card a key to crash.html */
  function crashCard() {
    var pic = h('span', 'sm-flip-coin');
    pic.innerHTML = '<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true" focusable="false"><rect x="2" y="2" width="44" height="44" rx="9" fill="#f4ecd8" stroke="#1c1a17" stroke-width="2.5"/><path d="M9 38.5h30" fill="none" stroke="#1c1a17" stroke-width="1" stroke-dasharray="1.5 2.2"/><path d="M9 36.5C21 35.5 30 30 35.5 14" fill="none" stroke="#1c1a17" stroke-width="3" stroke-linecap="round"/><rect x="31.5" y="7.5" width="10" height="6.5" rx="0.8" transform="rotate(-24 36.5 10.75)" fill="#2e7a4c"/></svg>';
    return btn('sm-note sm-flip-note', [pic, h('span', 'sm-t', [h('b', null, 'CRASH'), h('i', null, 'Cash out before it does.')]), h('span', 'sm-chev', '›')], () => { location.href = 'crash.html'; });
  }
  function noteCard() {
    var c = { icon: h('span', 'sm-spin'), b: h('b'), i: h('i') };
    c.n = btn('sm-note', [c.icon, h('span', 'sm-t', [c.b, c.i]), h('span', 'sm-chev', '›')]);
    return c;
  }
  /* (cf_BFNEWS) the one small announcement, under the coins on Home (the owner, 2026-11-19: "a little announcment somwhere"): a slim
     paper card with the article's link, and a close that hides it for this browser (and for this visit where nothing can be kept). */
  var NEWS_KEY = 'confetti.simple.bfnews', NEWS = { off: false };
  function newsCard() {
    if (NEWS.off || lsGet(NEWS_KEY) === '1') return null;
    var go = h('a', 'sm-news-go', 'Read about Blockfront ›'); go.href = 'blockfront.html';
    var x = btn('sm-news-x', '✕', () => { NEWS.off = true; lsSet(NEWS_KEY, '1'); Array.prototype.forEach.call(el.root.querySelectorAll('.sm-news'), n => { n.parentNode.removeChild(n); }); });
    x.setAttribute('aria-label', 'Hide this note');
    return h('div', 'sm-news', [h('p', null, [h('b', null, 'Here’s what we’re also working on:'), ' a decentralized RPC and data transformation market for Hyperliquid.']), go, x]);
  }
  function tradeRow(key, x, fn, rows) {
    var r = (rows || R.rows)[key] = { sub: h('span'), room: h('em', 'sm-room-s'), v: h('b', null, key.charAt(0) === 'o' ? usdS(x.margin) : '—'), c: h('i') };
    var pill = r.pill = h('span', 'sm-pill ' + (x.isLong ? 'is-up' : 'is-dn'), pillText(x.isLong, boostOf(x)));
    var who = h('b', null, [x.sym + ' ', pill]); who.style.display = 'flex'; who.style.alignItems = 'center'; who.style.gap = '8px';
    return btn('sm-row is-pos', [h('span', 'sm-tk', [who, h('i', null, [r.sub, r.room])]), h('span', 'sm-pr', [r.v, r.c])], fn);
  }
  /* a trade that closed itself: what is gone and, when money was added to it too late to count (v5), what came back */
  function goneWords(r) {
    return r.back > 0 ? 'The ' + usdS(r.lost) + ' that was in it is gone. The ' + usdS(r.back) + ' you added came too late to count and is back in your trading money.'
      : 'The ' + usdS(r.lost) + ' you put in is gone.';
  }
  /* a close held up past its time: the key and the sentence. own: only the wallet itself can still finish it (v5) */
  var OWN_SAY = 'It did not close in time. Now only your own wallet can close it. It closes at the price of that moment or the price when you asked to close, whichever is less good for you.';
  function plainStatus(s) {
    s = String(s || '');
    if (/^Filling|^Sending|^Sent|^Opening/.test(s)) return 'Opening…';
    if (/^Closing|^Getting ready/.test(s)) return 'Closing…';
    var m = /^Still (opening|closing)/.exec(s);
    if (m) return 'Still ' + m[1] + '… taking longer than usual.';
    if (/^Checking|^Closed\./.test(s)) return 'Closed. Adding it up…';
    return plain(s);
  }
  /* a price change is one short quiet flash of colour on the number */
  function flash(n, px) {
    var was = n._px; n._px = px;
    if (!(was > 0) || !(px > 0) || was === px || reduced()) return;
    n.classList.remove('sm-tick-up', 'sm-tick-dn'); void n.offsetWidth; n.classList.add(px > was ? 'sm-tick-up' : 'sm-tick-dn');
  }

  /* ---- the small lines: 24 h of 15-minute closes per coin from the page's own info loader, one request at a
     time, kept ten minutes (the coin's 1D chart reads the same series) ---- */
  var series = {}, sparkQ = [], sparkBusy = false;
  var TF = { '1H': ['1m', 60, 30000], '1D': ['15m', 96, 600000], '1W': ['2h', 84, 1200000], '1M': ['8h', 90, 3600000] };
  function seriesKey(coin, tf) { return coin + '|' + tf; }
  function getSeries(coin, tf) { var s = series[seriesKey(coin, tf)]; return s && s.pts.length > 1 ? s : null; }
  /* One series. A load that failed or came back empty is not asked again at once: the wait doubles with each failure in a
     row (15 s, 30 s, ... 5 minutes), and callers start a load only when none is due to wait (due()). The 1D series of the
     small lines is also kept in sessionStorage for its ten minutes, so a reload asks nothing. */
  function due(s) { return !s || (!s.busy && Date.now() >= (s.next || 0)); }
  function loadSeries(coin, tf) {
    var k = seriesKey(coin, tf), s = series[k], def = TF[tf];
    if (s && s.busy) return s.p;
    if (!due(s)) return Promise.resolve(s);
    s = series[k] = s || { pts: [], at: 0, busy: false, fails: 0, next: 0 };
    s.busy = true;
    var ms = { '1m': 60000, '15m': 900000, '2h': 7200000, '8h': 28800000 }[def[0]], end = Date.now();
    return s.p = api.info({ type: 'candleSnapshot', req: { coin: coin, interval: def[0], startTime: end - (def[1] + 1) * ms, endTime: end } }, 8000).then(rows => {
      var pts = (Array.isArray(rows) ? rows : []).map(r => Number(r.c)).filter(c => c > 0).slice(-def[1]);
      if (pts.length < 2) throw new Error('no candles');
      s.pts = pts; s.at = Date.now(); s.fails = 0; s.next = s.at + def[2];
      if (tf === '1D') { try { sessionStorage.setItem(SPARK_KEY + coin, JSON.stringify({ at: s.at, pts: pts })); } catch (e) { /* not kept */ } }
    }).catch(() => { s.fails = (s.fails || 0) + 1; s.next = Date.now() + Math.min(300000, 15000 * Math.pow(2, s.fails - 1)); }).then(() => { s.busy = false; return s; });
  }
  function keptSeries(coin) {
    try {
      var j = JSON.parse(sessionStorage.getItem(SPARK_KEY + coin) || 'null');
      if (j && Array.isArray(j.pts) && j.pts.length > 1 && Date.now() - j.at < TF['1D'][2]) return { pts: j.pts, at: j.at, busy: false, fails: 0, next: j.at + TF['1D'][2] };
    } catch (e) { /* nothing kept */ }
    return null;
  }
  /* the small lines: only for the rows on screen (more as rows scroll in), one request at a time */
  function loadSparks(mk) {
    mk.forEach(m => {
      var k = seriesKey(m.coin, '1D');
      var r = isDesktop() ? DK.R.rows && DK.R.rows['m' + m.sym] : R.rows && R.rows['m' + m.sym];
      var b = r && r.spk && r.spk.getBoundingClientRect();
      if (!b || b.bottom <= 0 || b.top >= window.innerHeight) return;
      if (!series[k]) { var kept = keptSeries(m.coin); if (kept) { series[k] = kept; return; } }
      if (due(series[k]) && sparkQ.indexOf(m.coin) < 0) sparkQ.push(m.coin);
    });
    if (sparkBusy) return;
    sparkBusy = true;
    (function next() {
      var coin = sparkQ.shift();
      if (!coin || !shown()) { sparkBusy = false; return; }
      loadSeries(coin, '1D').then(() => { kick(); setTimeout(next, 250); });
    })();
  }
  function svg(c, box) { var n = document.createElementNS(NS, 'svg'); n.setAttribute('class', c); n.setAttribute('viewBox', box); n.setAttribute('preserveAspectRatio', 'none'); n.setAttribute('aria-hidden', 'true'); return n; }
  function linePoints(pts, w, hh, pad, lo0, hi0) {
    var lo = lo0 != null ? lo0 : Math.min.apply(null, pts), hi = hi0 != null ? hi0 : Math.max.apply(null, pts), span = hi - lo || hi || 1;
    return pts.map((p, i) => (i * w / (pts.length - 1)).toFixed(1) + ',' + (pad + (hh - 2 * pad) * (1 - (p - lo) / span)).toFixed(1)).join(' ');
  }
  function spark(n, coin, move) {
    var s = getSeries(coin, '1D'); if (!s || n._at === s.at) return;
    n._at = s.at; n.textContent = '';
    var l = document.createElementNS(NS, 'polyline');
    l.setAttribute('points', linePoints(s.pts, 72, 28, 3));
    l.setAttribute('stroke', (isFinite(move) ? move : s.pts[s.pts.length - 1] - s.pts[0]) < 0 ? 'var(--neg)' : 'var(--pos)');
    n.appendChild(l);
  }

  /* ---- the menu: which wallet, the ways out, Pro ---- */

  var MENU = { sh: null };
  function openMenu() {
    var sh = MENU.sh || (MENU.sh = makeSheet('Menu')), w = api.wallet(), a = api.account();
    function item(label, hint, fn, href) {
      var n = href ? h('a', null, [label, h('i', null, hint || '›')]) : btn(null, [label, h('i', null, hint || '›')], () => { sh.close(); setTimeout(fn, 200); });
      if (href) n.href = href;
      return n;
    }
    txt(sh.title, 'Menu'); sh.body.textContent = ''; sh.foot.textContent = '';
    /* the demo's wallet is pretend: nothing to switch or disconnect (both left the demo stuck without one) */
    if (w.account && api.demo) add(sh.body, h('div', 'sm-who', [h('b', null, 'Demo wallet'), h('i', null, 'Pretend money. Nothing here is real.')]));
    else if (w.account) {
      add(sh.body, h('div', 'sm-who', [h('b', null, (w.name || 'Wallet') + ' connected'), h('i', null, w.account),
        h('div', 'sm-links', [btn('sm-link', 'Switch wallet', () => { sh.close(); S.tell = Date.now(); setTimeout(api.switchWallet, 200); }), btn('sm-link', 'Disconnect', () => { sh.close(); setTimeout(api.disconnect, 200); })])]));
    }
    var list = h('div', 'sm-menu');
    if (!w.account) add(list, item(w.has ? 'Connect wallet' : 'Open in your wallet app', '', doConnect));
    if (w.account) add(list, item('Add money', '', () => { openAdd(); }));
    if (w.account && a.loaded && a.available > 0) add(list, item('Withdraw', 'to your wallet', withdraw));
    var o4m = w.account ? old4() : null;
    if (o4m) add(list, item('Earlier version', usd(o4m.total) + ' to take out', null, o4m.href));
    /* page links */
    add(list, item('Portfolio', 'your trades', null, 'portfolio.html'));
    add(list, item('Leaderboard', 'top traders', null, 'leaderboard.html'));
    add(list, item('House', 'LP and stats', null, 'house.html'));
    add(list, item('$FETTI', fxMenuHint(w), null, 'confetti.html'));
    add(list, item('Coin flip', 'heads or tails', null, 'flip.html'));
    add(list, item('Crash', 'cash out before it does', null, 'crash.html'));
    var F = fx();
    if (F && w.account && F.drawOn()) add(list, item('Weekly draw', fxDrawHint(w), () => { openDraw(); }));
    if (F && F.tableHref()) add(list, item('FETTI table', 'stake FETTI, win FETTI', null, F.tableHref()));
    add(list, item('Blockfront', 'what we’re also working on', null, 'blockfront.html'));
    /* sub-links: smaller docs and contracts */
    var sub = h('div', 'sm-menu-sub');
    add(sub, item('Docs', '', null, 'docs.html'));
    add(sub, item('Contracts', '', null, 'contracts.html'));
    add(list, sub);
    /* one-tap trading: Simple's own sheet, its state on the line (the demo's is pretend, like its money) */
    if (w.account && otS().can) add(list, item('One-tap trading', otHint(), openOneTap));
    /* refer: Simple's own sheet (a visitor sees what it brings and a Connect key) */
    add(list, MENU.ref = item('Refer friends', refMenuHint(), openRefer));
    refShare();
    if (!NO_PRO) add(list, item('Pro view', 'candles, limit orders, history, points', () => { api.pro('coin', S.place !== 'home' ? S.sym : null); setMode('pro'); }));
    add(sh.body, list);
    sh.open();
  }

  /* ---- Add money: the rails ----
     quote(o) -> { rail, chain, usd, payWei, gross6, net6, steps, id }; refresh(q, o) -> the same order priced again right
     before the wallet opens; track(p) -> 'sent' | 'moving' | 'done' | 'refunded' | 'failed'. o: { chain, usd, account, topUsd,
     feePct, feeTo, ethPx }. What lands (net6) is fixed by the order; only the ETH it costs can move. */

  var IF = null;
  function iface() { return IF || (IF = new E.Interface(['function transfer(address to, uint256 amount)', 'function approve(address spender, uint256 amount)', 'function depositFor(address beneficiary, uint256 amountUsdc)'])); }
  function getJson(url, body) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null, timer = ctrl ? setTimeout(() => { ctrl.abort(); }, 12000) : null;
    var opt = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { accept: 'application/json' } };
    if (ctrl) opt.signal = ctrl.signal;
    return fetch(url, opt).then(r => {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error((j && (j.message || j.errorMessage)) || ('answered ' + r.status)); e.api = j || {}; throw e; } return j; });
    }).finally(() => { if (timer) clearTimeout(timer); });
  }
  function rpc(chain, method, params) {
    return getJson(rpcAt(chain), { jsonrpc: '2.0', id: 1, method: method, params: params || [] }).then(j => { if (j.error) throw new Error(j.error.message || 'rpc'); return j.result; });
  }
  /* an ETH chain's public RPC; HyperEVM's is the page's own (config.json rpcUrl) */
  function rpcAt(chain) { var u = String(api.cfg().rpcUrl || ''); return CH[chain] ? CH[chain].rpc : /^https:\/\//.test(u) ? u : 'https://rpc.hyperliquid.xyz/evm'; }

  var relay = {
    order: function (o, gross6) {
      var fee6 = o.feePct && o.feeTo ? gross6 * BigInt(Math.round(o.feePct * 100)) / 10000n : 0n, net6 = gross6 - fee6, f = iface(), txs = [];
      if (fee6 >= gross6) return Promise.reject(say(OFF));      /* the share can never be the whole order (the percent itself is checked in quoteRails) */
      /* the destination calls, run by Relay's router with the order's dollars: the 3% to the fee wallet, then the deposit */
      if (fee6 > 0n) txs.push({ to: api.usdc, value: '0', data: f.encodeFunctionData('transfer', [o.feeTo, fee6]) });
      txs.push({ to: api.usdc, value: '0', data: f.encodeFunctionData('approve', [api.exchange, net6]) });
      txs.push({ to: api.exchange, value: '0', data: f.encodeFunctionData('depositFor', [o.account, net6]) });
      var b = { user: o.account, recipient: o.account, refundTo: o.account, originChainId: o.chain, destinationChainId: api.chainId, originCurrency: ZERO,
        destinationCurrency: api.usdc, amount: String(gross6), tradeType: 'EXACT_OUTPUT', txs: txs };
      if (o.topUsd > 0) { b.topupGas = true; b.topupGasAmount = String(Math.round(o.topUsd * 1e6)); }
      return getJson(RELAY + '/quote/v2', b).then(j => {
        var d = j.details || {}, st = j.steps || [], it = st.length === 1 && st[0].items && st[0].items.length === 1 ? st[0].items[0] : null, tx = it && it.data;
        if (!tx || !d.currencyIn || !d.currencyOut) throw new Error('unexpected quote');
        var v2 = (j.protocol || {}).v2 || {}, od = v2.orderData || {}, calls = (od.output || {}).calls, low = x => String(x || '').toLowerCase();
        /* the order must be the one asked for, or it is refused: this chain; these dollars out; these very calls, as many, each to
           its target with its calldata; the account as the recipient and as every refund's recipient; the payment going to the
           depository the answer itself names; and the top-up there when one was asked for */
        var same = Array.isArray(calls) && calls.length === txs.length && txs.every(function (t, i) { var c = low(calls[i]).replace(/^0x/, ''); return c.slice(24, 64) === low(t.to).slice(2) && c.indexOf(low(t.data).slice(2)) >= 0; });
        var mine = low(d.recipient) === low(o.account) && (od.inputs || []).every(function (inp) { return (inp.refunds || []).every(r => low(r.recipient) === low(o.account)); });
        if (Number(tx.chainId) !== o.chain || String(d.currencyOut.amount) !== String(gross6) || !same || !mine || low(tx.to) !== low((v2.paymentDetails || {}).depository) || (o.topUsd > 0 && !d.currencyGasTopup)) throw new Error('quote does not match the order');
        return { rail: 'relay', chain: o.chain, usd: Number(d.currencyIn.amountUsd), payWei: BigInt(tx.value), gross6: gross6, net6: net6,
          steps: [{ to: tx.to, data: tx.data, value: BigInt(tx.value) }], id: st[0].requestId };
      });
    },
    quote: function (o) {
      var self = this, g0 = BigInt(Math.max(1, Math.floor((o.usd - o.topUsd) * 0.992 * 1e6)));
      return self.order(o, g0).then(q => {
        if (Math.abs(q.usd - o.usd) < 0.02) return q;
        return self.order(o, g0 + BigInt(Math.round((o.usd - q.usd) * 0.997 * 1e6)));  /* one correction lands on the typed dollars */
      });
    },
    refresh: function (q, o) { return this.order(o, q.gross6); },
    track: function (p) {
      return getJson(RELAY + '/intents/status/v3?requestId=' + encodeURIComponent(p.id)).then(j => {
        var s = j && j.status;
        return s === 'success' ? 'done' : s === 'refund' ? 'refunded' : s === 'failure' ? 'failed' : s === 'pending' || s === 'submitted' ? 'moving' : 'sent';
      });
    }
  };

  var debridge = {
    ask: function (o, out, token, hook, fee) {
      var q = [['srcChainId', o.chain], ['srcChainTokenIn', ZERO], ['dstChainId', DLN_HYPEREVM], ['dstChainTokenOut', token], ['prependOperatingExpenses', 'true'],
        ['dstChainTokenOutRecipient', o.account], ['senderAddress', o.account], ['srcChainOrderAuthorityAddress', o.account], ['dstChainOrderAuthorityAddress', o.account]];
      q.push(['srcChainTokenInAmount', out.wei != null ? String(out.wei) : 'auto'], ['dstChainTokenOutAmount', out.wei != null ? 'auto' : String(out.net6)]);
      if (fee && o.feePct && o.feeTo) q.push(['affiliateFeePercent', String(o.feePct)], ['affiliateFeeRecipient', o.feeTo]);
      if (hook) q.push(['dlnHook', JSON.stringify({ type: 'evm_transaction_call', data: { to: api.exchange, calldata: iface().encodeFunctionData('depositFor', [o.account, out.net6]), gas: 0 } })]);
      return getJson(DLN + '/dln/order/create-tx?' + q.map(kv => kv[0] + '=' + encodeURIComponent(kv[1])).join('&'));
    },
    /* the deposit rides the order as a hook (deBridge approves the Exchange, then calls depositFor); it brings no gas,
       so a wallet short of HYPE gets a second small order for it: 1 of 2, 2 of 2 on the same chain */
    order: function (o, net6) {
      var self = this, gasWei = o.topUsd > 0 ? BigInt(Math.round(o.topUsd / o.ethPx * 1e18)) : 0n;
      return Promise.all([self.ask(o, { net6: net6 }, api.usdc, true, true), gasWei > 0n ? self.ask(o, { wei: gasWei }, ZERO, false, false) : null]).then(r => {
        var j = r[0], g = r[1], tx = j.tx || {}, est = j.estimation || {};
        if (!tx.data || !tx.to || String((est.dstChainTokenOut || {}).amount) !== String(net6)) throw new Error('unexpected quote');
        var steps = [{ to: tx.to, data: tx.data, value: BigInt(tx.value) }], pay = BigInt(tx.value);
        if (g && g.tx && g.tx.data) { steps.push({ to: g.tx.to, data: g.tx.data, value: BigInt(g.tx.value) }); pay += BigInt(g.tx.value); }
        return { rail: 'debridge', chain: o.chain, usd: Number(pay) / 1e18 * o.ethPx, payWei: pay, gross6: net6, net6: net6, steps: steps, id: j.orderId || null };
      });
    },
    quote: function (o) {
      var self = this, flat = 0.001 * o.ethPx * (o.topUsd > 0 ? 2 : 1), n0 = BigInt(Math.max(1, Math.floor((o.usd - flat - o.topUsd) * 0.955 * 1e6)));
      return self.order(o, n0).then(q => {
        if (Math.abs(q.usd - o.usd) < 0.05) return q;
        return self.order(o, n0 + BigInt(Math.round((o.usd - q.usd) * 0.96 * 1e6)));
      });
    },
    refresh: function (q, o) { return this.order(o, q.net6); },
    track: function (p) {
      var id = p.id ? Promise.resolve(p.id) : getJson(DLN + '/dln/tx/' + p.hash + '/order-ids').then(j => j && j.orderIds && j.orderIds[0]);
      return id.then(oid => {
        if (!oid) return 'sent';
        p.id = oid;
        return getJson(DLN + '/dln/order/' + oid + '/status').then(s => { var t = (s && s.status) || ''; return /^(Fulfilled|SentUnlock|ClaimedUnlock)$/.test(t) ? 'done' : /Cancel/.test(t) ? 'refunded' : 'moving'; });
      });
    }
  };
  /* HYPE in the wallet: a same-chain Relay order on HyperEVM, priced like the ETH order (these dollars out, exactly, and the HYPE it
     costs). One transaction from the wallet to Relay's router, which swaps the HYPE, runs the very calls the ETH order carries (the share
     to the fee wallet, the approve, depositFor), then sweeps what the swap made above the order's dollars back to the wallet. No call may
     fail, so the transaction runs whole or not at all, and its receipt is the rail's word (track). The order is read before the wallet
     opens and refused unless it is the one asked for: HyperEVM; Relay's router; HYPE in, paid as the value; at least these dollars out;
     these very calls back to back, none allowed to fail; and every sweep going to the account. */
  function hypeOrderOk(data, txs, account) {
    var co = E.AbiCoder.defaultAbiCoder(), low = x => String(x || '').toLowerCase(), calls;
    try { if (low(data).slice(0, 10) !== MC) return false; calls = co.decode(['(address,bool,uint256,bytes)[]', 'address', 'address', 'bytes'], '0x' + String(data).slice(10))[0]; } catch (e) { return false; }
    var mine = false, sweeps = 0;
    for (var i = 0; i + txs.length <= calls.length && !mine; i++) {
      mine = txs.every((t, k) => { var x = calls[i + k]; return low(x[0]) === low(t.to) && x[1] === false && BigInt(x[2]) === 0n && low(x[3]) === low(t.data); });
    }
    var back = calls.every(x => {
      if (low(x[0]) !== HYPE_ROUTER || low(x[3]).slice(0, 10) !== SWEEP) return true;
      sweeps++;
      try { var to = co.decode(['address[]', 'address[]', 'uint256[]', 'bytes'], '0x' + String(x[3]).slice(10))[1]; return to.length > 0 && Array.from(to).every(a => low(a) === low(account)); } catch (e) { return false; }
    });
    return mine && back && sweeps > 0;
  }
  var hypeRail = {
    order: function (o, gross6) {
      var fee6 = o.feePct && o.feeTo ? gross6 * BigInt(Math.round(o.feePct * 100)) / 10000n : 0n, net6 = gross6 - fee6, f = iface(), txs = [];
      if (fee6 >= gross6) return Promise.reject(say(OFF));
      if (fee6 > 0n) txs.push({ to: api.usdc, value: '0', data: f.encodeFunctionData('transfer', [o.feeTo, fee6]) });
      txs.push({ to: api.usdc, value: '0', data: f.encodeFunctionData('approve', [api.exchange, net6]) });
      txs.push({ to: api.exchange, value: '0', data: f.encodeFunctionData('depositFor', [o.account, net6]) });
      var b = { user: o.account, recipient: o.account, refundTo: o.account, originChainId: api.chainId, destinationChainId: api.chainId, originCurrency: ZERO,
        destinationCurrency: api.usdc, amount: String(gross6), tradeType: 'EXACT_OUTPUT', txs: txs, slippageTolerance: HYPE_SLIP };
      return getJson(RELAY + '/quote/v2', b).then(j => {
        var d = j.details || {}, st = j.steps || [], it = st.length === 1 && st[0].items && st[0].items.length === 1 ? st[0].items[0] : null, tx = it && it.data, low = x => String(x || '').toLowerCase();
        if (!tx || !d.currencyIn || !d.currencyOut) throw new Error('unexpected quote');
        var cin = d.currencyIn.currency || {}, cout = d.currencyOut.currency || {}, min = BigInt(d.currencyOut.minimumAmount || 0);
        if (Number(tx.chainId) !== api.chainId || low(tx.to) !== HYPE_ROUTER || low(cin.address) !== ZERO || Number(cin.chainId) !== api.chainId || low(cout.address) !== low(api.usdc)
          || String(tx.value) !== String(d.currencyIn.amount) || min < gross6 || low(d.recipient) !== low(o.account) || !hypeOrderOk(tx.data, txs, o.account)) throw new Error('quote does not match the order');
        return { rail: 'hype', chain: api.chainId, usd: Number(d.currencyIn.amountUsd), payWei: BigInt(tx.value), gross6: gross6, net6: net6,
          steps: [{ to: tx.to, data: tx.data, value: BigInt(tx.value) }], id: st[0].requestId, gas: BigInt(tx.gas || 0) };
      });
    },
    quote: function (o) {
      var self = this, g0 = BigInt(Math.max(1, Math.floor(o.usd * 0.985 * 1e6)));
      return self.order(o, g0).then(q => {
        if (Math.abs(q.usd - o.usd) < 0.02) return q;
        return self.order(o, g0 + BigInt(Math.round((o.usd - q.usd) * 0.99 * 1e6)));     /* one correction lands on the typed dollars */
      }).then(q => {
        /* Max: never more HYPE than the wallet can spare (the page's price and the order's can differ a little); such an order is held to
           its own dollars, not the typed ones (capped) */
        return o.capWei == null || q.payWei <= o.capWei ? q : self.order(o, q.gross6 * o.capWei / q.payWei * 998n / 1000n).then(c => { c.capped = true; return c; });
      });
    },
    refresh: function (q, o) { return this.order(o, q.gross6); },
    track: function () { return Promise.resolve(null); }        /* one transaction: its receipt is its word (track) */
  };
  function quoteHype(o) {
    if (o.feeTo && !(Number(o.feePct) >= 0 && Number(o.feePct) <= 10)) return Promise.reject(say(OFF));
    return hypeRail.quote(o).then(q => held(q, q.capped ? Object.assign({}, o, { usd: q.usd }) : o), e => {
      if (e && e.plain != null) throw e;
      var code = e && e.api && e.api.errorCode;
      if (code === 'AMOUNT_TOO_LOW') throw say('That is too little to send. Try a bit more.');
      if (code === 'AMOUNT_TOO_HIGH') throw say('That is more than can be sent in one go. Try a smaller amount.');
      if (NO_ROUTE.test(code || '')) throw say('There is no price for that right now. Try again in a minute.');
      var x = say(AGAIN); x.again = true; throw x;      /* a timeout, a busy answer or an answer the page refused: asked again */
    });
  }
  /* ---- more ways to pay (the owner, 2026-11-20: "can we add solana, btc, and usdt to the add money like eth", "offer both options
     for all those listed currencies", "we are going to need to do fetti too") ----
     USDT in the connected wallet: USDT0 on HyperEVM (a same-chain Relay order, as HYPE's), USDT on Arbitrum or Ethereum (a Relay order
     that carries the same destination calls as ETH's). An allowance for exactly the order's USDT, to Relay's own contract, then the
     payment. SOL from a Solana wallet (wallet standard): one instruction to Relay's depository program, read byte by byte first.
     Bitcoin, and USDT on Tron, by address: Relay gives an address for this trader; what is paid there arrives as dollars in the
     trader's own wallet on HyperEVM (an address order carries no destination calls, Relay's own rule), and the page's Finish step
     adds it. Any amount paid is credited for what it is; the page's share rides the order as Relay's app share. FETTI: sold for HYPE
     on its own pool (never more than moves its price by the cap), then the HYPE pays the way HYPE does.
     Every order is read before anything is asked or shown and refused unless it is the one asked for. */
  var DEP_EVM = '0x4cd00e387622c35bddb9b4c962c136462338bc31';                       /* Relay's depository on the EVM chains */
  var RELAY_SOLVER = '0xf70da97812cb96acdf810712aa562db8dfa3dbef';                  /* Relay's solver, the same address on every EVM chain */
  var USDT0 = '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', USDT0_PROXY = '0x5567954cd026cebfe486062cb75848e0f1c12e58', TAM = '0xf9e4bab4';
  var UT = { 999: { name: 'HyperEVM', token: USDT0 }, 42161: { name: 'Arbitrum', token: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' }, 1: { name: 'Ethereum', token: '0xdac17f958d2ee523a2206206994597c13d831ec7' } }, UT_ORDER = [999, 42161, 1];
  var SOLC = { chain: 792703809, coin: '11111111111111111111111111111111', program: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2', rpc: 'https://solana-rpc.publicnode.com', keep: 3000000n };
  /* the address ways. dep: Relay's depository there (the order must name it); min: under it most of a payment goes to that network */
  var EVM_OK = /^0x[0-9a-fA-F]{40}$/;
  function evmK(chain, coin, sym, name, dec, showDec, eta, small) { return { evm: true, chain: chain, coin: coin, dep: DEP_EVM, sym: sym, name: name, dec: dec, show: showDec, min: 10, eta: eta, small: small, ok: EVM_OK, title: 'Send ' + sym + (sym === 'HYPE' ? '' : ' on ' + name) }; }
  var AK = {
    btc: { chain: 8253038, coin: 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8', dep: 'bc1qzmtn0q92ayejt2hpffvlktcpmyy7vvsd06sefu', sym: 'BTC', name: 'Bitcoin', dec: 8, show: 5, min: 25, small: 10, eta: 'about 20 minutes', title: 'Send Bitcoin', ok: /^(bc1[02-9ac-hj-np-z]{20,80}|[13][1-9A-HJ-NP-Za-km-z]{25,39})$/ },
    tron: { chain: 728126428, coin: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', dep: 'TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN', sym: 'USDT', name: 'Tron', dec: 6, show: 2, min: 10, small: 5, eta: 'a minute or two', title: 'Send USDT on Tron', ok: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },
    /* an address of Relay's on an EVM chain (no key needed there): ETH and HYPE the way an exchange sends them, and USDT off Tron */
    eth8453: evmK(8453, ZERO, 'ETH', 'Base', 18, 5, 'about a minute', 5), eth42161: evmK(42161, ZERO, 'ETH', 'Arbitrum', 18, 5, 'about a minute', 5), eth1: evmK(1, ZERO, 'ETH', 'Ethereum', 18, 5, 'a few minutes', 10),
    hype: evmK(999, ZERO, 'HYPE', 'HyperEVM', 18, 3, 'about a minute', 5),
    usdt42161: evmK(42161, UT[42161].token, 'USDT', 'Arbitrum', 6, 2, 'about a minute', 5), usdt1: evmK(1, UT[1].token, 'USDT', 'Ethereum', 6, 2, 'a few minutes', 10)
  };
  var AKS = { eth: ['eth8453', 'eth42161', 'eth1'], usdt: ['tron', 'usdt42161', 'usdt1'] };
  function payTitle(p) { return (p && AK[p.kind] && AK[p.kind].title) || 'Send'; }
  function kindPx(k) { var y = AK[k].sym; return y === 'BTC' ? coinPx('BTC') : y === 'ETH' ? ethPx() : y === 'HYPE' ? hypePx() : 1; }
  /* who pays a Bitcoin address: an exchange (a refund address is then asked: Relay does not send a refund back to an exchange's own
     wallet) or the trader's own wallet (a refund goes back to the wallet that paid) */
  function needRef(k) { return k === 'tron' || (k === 'btc' && ADD.btcFrom !== 'own'); }
  var NEW = { usdt: 1, sol: 1, btc: 1, fetti: 1 };
  var ERC = null;
  function erc() {
    return ERC || (ERC = new E.Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256)',
      'function getReserves() view returns (uint112,uint112,uint32)', 'function getAmountsOut(uint256,address[]) view returns (uint256[])', 'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline)']));
  }
  function ecall(c, to, fn, args) { return rpc(c, 'eth_call', [{ to: to, data: erc().encodeFunctionData(fn, args || []) }, 'latest']).then(hex => erc().decodeFunctionResult(fn, hex)); }
  function lowS(x) { return String(x || '').toLowerCase(); }
  function n6(v) { return (Number(v) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function solS(l) { return String(Number((Number(l) / 1e9).toPrecision(4))); }
  function coinS(v, dec) { var s = String(BigInt(v)), i, f; while (s.length <= dec) s = '0' + s; i = s.length - dec; f = s.slice(i).replace(/0+$/, ''); return s.slice(0, i) + (f ? '.' + f : ''); }      /* exact: the digits to type, never a float's */
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58d(s) {
    var n = 0n, i, z = 0; s = String(s);
    for (i = 0; i < s.length; i++) { var k = B58.indexOf(s[i]); if (k < 0) throw new Error('not base58'); n = n * 58n + BigInt(k); }
    while (z < s.length && s[z] === '1') z++;
    var hex = n === 0n ? '' : n.toString(16); if (hex.length % 2) hex = '0' + hex;
    var out = new Uint8Array(z + hex.length / 2); for (i = 0; i < hex.length / 2; i++) out[z + i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function b58e(b) { var n = 0n, i, z = 0, s = ''; for (i = 0; i < b.length; i++) n = n * 256n + BigInt(b[i]); while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } while (z < b.length && b[z] === 0) { s = '1' + s; z++; } return s; }
  function tronOk(s) {
    try { var b = b58d(s); if (!AK.tron.ok.test(s) || b.length !== 25 || b[0] !== 0x41) return false; var c = E.getBytes(E.sha256(E.sha256(b.slice(0, 21)))); return c[0] === b[21] && c[1] === b[22] && c[2] === b[23] && c[3] === b[24]; } catch (e) { return false; }
  }
  /* the destination calls every order carries: the share to the fee wallet, the approve, the deposit for the trader */
  function destCalls(o, gross6) {
    var fee6 = o.feePct && o.feeTo ? gross6 * BigInt(Math.round(o.feePct * 100)) / 10000n : 0n, net6 = gross6 - fee6, f = iface(), txs = [];
    if (fee6 >= gross6) throw say(OFF);
    if (fee6 > 0n) txs.push({ to: api.usdc, value: '0', data: f.encodeFunctionData('transfer', [o.feeTo, fee6]) });
    txs.push({ to: api.usdc, value: '0', data: f.encodeFunctionData('approve', [api.exchange, net6]) });
    txs.push({ to: api.exchange, value: '0', data: f.encodeFunctionData('depositFor', [o.account, net6]) });
    return { txs: txs, net6: net6 };
  }
  /* a cross-chain order's own record of its calls and refunds: these very calls, and every refund on HyperEVM to the account */
  function sameCalls(od, txs) { var calls = (od.output || {}).calls; return Array.isArray(calls) && calls.length === txs.length && txs.every(function (t, i) { var c = lowS(calls[i]).replace(/^0x/, ''); return c.slice(24, 64) === lowS(t.to).slice(2) && c.indexOf(lowS(t.data).slice(2)) >= 0; }); }
  function refundsTo(od, account, origin) { return (od.inputs || []).every(function (inp) { return (inp.refunds || []).every(r => /^0x/.test(String(r.recipient)) ? lowS(r.recipient) === lowS(account) : origin == null || String(r.recipient) === origin); }); }
  function one(j) { var st = j.steps || []; return st.length === 1 && st[0].items && st[0].items.length === 1 ? st[0].items[0].data : null; }
  /* asked like the ETH order: priced once, corrected once, so what is paid lands on the typed dollars */
  function landOn(rail, o, g0, k) { return rail.order(o, g0).then(q => Math.abs(q.usd - o.usd) < 0.02 ? q : rail.order(o, g0 + BigInt(Math.round((o.usd - q.usd) * k * 1e6)))); }
  function heldNew(q, o) {
    var mine = q.rail === 'sol' ? Number(q.payWei) / 1e9 * o.px : q.usd;
    if (Math.abs(q.usd - o.usd) > Math.max(0.05, o.usd * 0.01) || Math.abs(mine - o.usd) > o.usd * 0.08) { var e = say(AGAIN); e.again = true; throw e; }
    return q;
  }
  function railErr(e) {
    if (e && e.plain != null) throw e;
    var code = e && e.api && e.api.errorCode, msg = String((e && e.api && e.api.message) || '');
    if (code === 'AMOUNT_TOO_LOW') throw say('That is too little to send. Try a bit more.');
    if (code === 'AMOUNT_TOO_HIGH') throw say('That is more than can be sent in one go. Try a smaller amount.');
    if (/invalid address/i.test(msg)) throw say('That address was not accepted. Check it and try again.');
    if (NO_ROUTE.test(code || '')) throw say('There is no price for that right now. Try again in a minute.');
    if (!(e && e.api)) { try { console.error('[simple] order refused', e); } catch (y) { /* no console */ } }      /* an answer the page refused: its reason goes to the console, never the screen */
    var x = say(AGAIN); x.again = true; throw x;
  }

  /* USDT in the wallet. HyperEVM: Relay's approval proxy pulls exactly the order's USDT0 and runs the swap and the calls in one
     transaction (transferAndMulticall), read whole here. Arbitrum / Ethereum: the deposit to Relay's depository, the calls on
     arrival. The allowance is the page's own call (this token, that contract, exactly this amount), never the quote's. */
  function proxyOrderOk(data, txs, account, tok, amt) {
    var co = E.AbiCoder.defaultAbiCoder(), d, calls;
    try { if (lowS(data).slice(0, 10) !== TAM) return false; d = co.decode(['address[]', 'uint256[]', '(address,bool,uint256,bytes)[]', 'address', 'address', 'bytes'], '0x' + String(data).slice(10)); calls = d[2]; } catch (e) { return false; }
    if (d[0].length !== 1 || lowS(d[0][0]) !== lowS(tok) || BigInt(d[1][0]) !== amt || lowS(d[3]) !== lowS(account)) return false;
    var mine = false, home = 0;
    for (var i = 0; i + txs.length <= calls.length && !mine; i++) mine = txs.every((t, k) => { var x = calls[i + k]; return lowS(x[0]) === lowS(t.to) && x[1] === false && BigInt(x[2]) === 0n && lowS(x[3]) === lowS(t.data); });
    /* every sweep goes to the account, the dollars' own among them; but for Relay's own sliver of the USDT it was handed (a named
       amount, never over a five-hundredth of it, to Relay's solver) */
    var back = calls.every(x => {
      if (lowS(x[0]) !== HYPE_ROUTER || lowS(x[3]).slice(0, 10) !== SWEEP) return true;
      try {
        var s = co.decode(['address[]', 'address[]', 'uint256[]', 'bytes'], '0x' + String(x[3]).slice(10)), n = s[0].length;
        if (!n || s[1].length !== n || s[2].length !== n) return false;
        for (var k = 0; k < n; k++) {
          if (lowS(s[1][k]) === lowS(account)) { if (lowS(s[0][k]) === lowS(api.usdc)) home++; continue; }
          if (!(lowS(s[1][k]) === RELAY_SOLVER && lowS(s[0][k]) === lowS(tok) && BigInt(s[2][k]) > 0n && BigInt(s[2][k]) <= amt / 500n)) return false;
        }
        return true;
      } catch (e) { return false; }
    });
    return mine && back && home > 0;
  }
  var usdtRail = {
    order: function (o, gross6) {
      var c = o.chain, same = c === api.chainId, tok = UT[c].token, spender = same ? USDT0_PROXY : DEP_EVM, dc = destCalls(o, gross6), txs = dc.txs;
      var b = { user: o.account, recipient: o.account, refundTo: o.account, originChainId: c, destinationChainId: api.chainId, originCurrency: tok, destinationCurrency: api.usdc, amount: String(gross6), tradeType: 'EXACT_OUTPUT', txs: txs };
      if (same) b.slippageTolerance = HYPE_SLIP; else if (o.topUsd > 0) { b.topupGas = true; b.topupGasAmount = String(Math.round(o.topUsd * 1e6)); }
      return Promise.all([getJson(RELAY + '/quote/v2', b), ecall(c, tok, 'allowance', [o.account, spender]).then(r => BigInt(r[0]), () => null)]).then(r => {
        var j = r[0], have = r[1], d = j.details || {}, st = j.steps || [], last = st.length ? st[st.length - 1] : null, tx = last && last.items && last.items.length === 1 ? last.items[0].data : null;
        if (!tx || st.length > 2 || !d.currencyIn || !d.currencyOut) throw new Error('unexpected quote');
        var cin = d.currencyIn.currency || {}, cout = d.currencyOut.currency || {}, amt = BigInt(d.currencyIn.amount), v2 = (j.protocol || {}).v2 || {}, od = v2.orderData || {}, ap = st.length === 2 && st[0].items && st[0].items[0] ? st[0].items[0].data : null;
        var allow = erc().encodeFunctionData('approve', [spender, amt]);
        var ok = Number(tx.chainId) === c && lowS(tx.to) === spender && BigInt(tx.value || 0) === 0n && lowS(cin.address) === lowS(tok) && Number(cin.chainId) === c && lowS(cout.address) === lowS(api.usdc) && lowS(d.recipient) === lowS(o.account)
          && (!ap || (lowS(ap.to) === lowS(tok) && lowS(ap.data) === lowS(allow) && BigInt(ap.value || 0) === 0n))
          && (same ? BigInt(d.currencyOut.minimumAmount || 0) >= gross6 && proxyOrderOk(tx.data, txs, o.account, tok, amt)
            : String(d.currencyOut.amount) === String(gross6) && sameCalls(od, txs) && refundsTo(od, o.account) && lowS((v2.paymentDetails || {}).depository) === DEP_EVM && (!(o.topUsd > 0) || !!d.currencyGasTopup));
        if (!ok) throw new Error('quote does not match the order');
        var steps = [];
        if (have == null || have < amt) {
          if (c === 1 && have != null && have > 0n) steps.push({ to: tok, data: erc().encodeFunctionData('approve', [spender, 0n]), value: 0n, what: 'reset' });     /* Ethereum's USDT changes an allowance only from zero */
          steps.push({ to: tok, data: allow, value: 0n, what: 'allow' });
        }
        steps.push({ to: tx.to, data: tx.data, value: 0n, what: 'pay' });
        return { rail: 'usdt', chain: c, usd: Number(amt) / 1e6, pay6: amt, gross6: gross6, net6: dc.net6, steps: steps, id: last.requestId };
      });
    },
    quote: function (o) { return landOn(this, o, BigInt(Math.max(1, Math.floor((o.usd - (o.topUsd || 0)) * 0.99 * 1e6))), 0.997); },
    track: function (p) { return p.chain === api.chainId ? Promise.resolve(null) : relay.track(p); }
  };

  /* SOL from a Solana wallet. The wallets announce themselves (the wallet standard); the page builds the transaction itself from
     the order's one instruction: Relay's depository program, the trader's Solana account its only signer, the amount and the
     order's id in its data exactly as the answer's own figures say. */
  var SW = { list: [], w: null, acct: null, bal: null, on: false };
  function swStart() {
    if (SW.on) return; SW.on = true;
    var reg = function () {
      for (var i = 0; i < arguments.length; i++) {
        var w = arguments[i];
        try { if (w && w.features && w.features['standard:connect'] && w.features['solana:signAndSendTransaction'] && Array.prototype.indexOf.call(w.chains || [], 'solana:mainnet') >= 0 && SW.list.indexOf(w) < 0) SW.list.push(w); } catch (e) { /* not a wallet */ }
      }
      kick(); return noop;
    };
    var hub = Object.freeze({ register: reg });
    try {
      window.addEventListener('wallet-standard:register-wallet', function (ev) { try { ev.detail(hub); } catch (e) { /* not ours */ } });
      window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: hub }));
    } catch (e) { /* an old browser: no Solana wallet is found */ }
  }
  function solRpc(method, params) { return getJson(SOLC.rpc, { jsonrpc: '2.0', id: 1, method: method, params: params || [] }).then(j => { if (j.error) throw new Error(j.error.message || 'rpc'); return j.result; }); }
  function readSol() { if (SW.acct) solRpc('getBalance', [SW.acct.address, { commitment: 'confirmed' }]).then(r => { SW.bal = BigInt(r.value); kick(); scheduleQuote(); }).catch(noop); }
  function swConnect(w) {
    return timed(Promise.resolve().then(() => w.features['standard:connect'].connect()), 60000, NO_ANSWER).then(r => {
      var a = Array.prototype.filter.call((r && r.accounts) || w.accounts || [], x => Array.prototype.indexOf.call(x.chains || [], 'solana:mainnet') >= 0)[0];
      if (!a || b58d(a.address).length !== 32) throw say((w.name || 'That wallet') + ' did not share a Solana account.');
      SW.w = w; SW.acct = a; SW.bal = null; readSol();
    });
  }
  function cu16(n) { var o = []; for (;;) { var b = n & 0x7f; n >>= 7; if (n) o.push(b | 0x80); else { o.push(b); return o; } } }
  function solTx(payer, ix, blockhash) {
    var keys = [{ k: payer, s: true, w: true }], at = {}; at[payer] = 0;
    ix.keys.concat([{ pubkey: ix.programId, isSigner: false, isWritable: false }]).forEach(x => {
      var i = at[x.pubkey];
      if (i == null) { at[x.pubkey] = keys.length; keys.push({ k: x.pubkey, s: !!x.isSigner, w: !!x.isWritable }); } else { keys[i].s = keys[i].s || !!x.isSigner; keys[i].w = keys[i].w || !!x.isWritable; }
    });
    var ord = keys.filter(x => x.s && x.w).concat(keys.filter(x => x.s && !x.w), keys.filter(x => !x.s && x.w), keys.filter(x => !x.s && !x.w)), idx = {};
    ord.forEach((x, i) => { idx[x.k] = i; });
    var msg = [ord.filter(x => x.s).length, ord.filter(x => x.s && !x.w).length, ord.filter(x => !x.s && !x.w).length].concat(cu16(ord.length));
    ord.forEach(x => { var b = b58d(x.k); if (b.length !== 32) throw new Error('bad key'); msg.push.apply(msg, b); });
    var bh = b58d(blockhash), data = E.getBytes('0x' + ix.data); if (bh.length !== 32) throw new Error('bad blockhash');
    msg.push.apply(msg, bh);
    msg = msg.concat(cu16(1), [idx[ix.programId]], cu16(ix.keys.length), ix.keys.map(x => idx[x.pubkey]), cu16(data.length), Array.from(data));
    return new Uint8Array([1].concat(new Array(64).fill(0), msg));
  }
  var solRail = {
    order: function (o, gross6) {
      var dc = destCalls(o, gross6), txs = dc.txs;
      var b = { user: o.sol, recipient: o.account, refundTo: o.sol, originChainId: SOLC.chain, destinationChainId: api.chainId, originCurrency: SOLC.coin, destinationCurrency: api.usdc, amount: String(gross6), tradeType: 'EXACT_OUTPUT', txs: txs };
      if (o.topUsd > 0) { b.topupGas = true; b.topupGasAmount = String(Math.round(o.topUsd * 1e6)); }
      return getJson(RELAY + '/quote/v2', b).then(j => {
        var d = j.details || {}, tx = one(j), ixs = tx && tx.instructions, ix = Array.isArray(ixs) && ixs.length === 1 ? ixs[0] : null;
        if (!ix || !Array.isArray(ix.keys) || !d.currencyIn || !d.currencyOut) throw new Error('unexpected quote');
        var v2 = (j.protocol || {}).v2 || {}, od = v2.orderData || {}, cin = d.currencyIn.currency || {}, lam = BigInt(d.currencyIn.amount), data = lowS(ix.data), le = '';
        for (var i = 0; i < 8; i++) le += ('0' + Number((lam >> BigInt(8 * i)) & 255n).toString(16)).slice(-2);
        var signers = ix.keys.filter(k => k.isSigner);
        var ok = ix.programId === SOLC.program && (v2.paymentDetails || {}).depository === SOLC.program && signers.length >= 1 && signers.every(k => k.pubkey === o.sol)
          && /^[0-9a-f]{96}$/.test(data) && data.slice(16, 32) === le && data.slice(32) === lowS(v2.orderId).replace(/^0x/, '')
          && cin.address === SOLC.coin && Number(cin.chainId) === SOLC.chain && String(d.currencyOut.amount) === String(gross6) && sameCalls(od, txs)
          && lowS(d.recipient) === lowS(o.account) && refundsTo(od, o.account, o.sol) && (!(o.topUsd > 0) || !!d.currencyGasTopup);
        if (!ok) throw new Error('quote does not match the order');
        return { rail: 'sol', chain: SOLC.chain, usd: Number(d.currencyIn.amountUsd), payWei: lam, gross6: gross6, net6: dc.net6, ix: ix, id: j.steps[0].requestId };
      });
    },
    quote: function (o) { return landOn(this, o, BigInt(Math.max(1, Math.floor((o.usd - (o.topUsd || 0)) * 0.985 * 1e6))), 0.997); },
    track: function (p) { return relay.track(p); }
  };
  /* a Solana payment's own word, shaped like an EVM receipt for the follower */
  function solRcpt(p) {
    return solRpc('getSignatureStatuses', [[p.hash], { searchTransactionHistory: true }]).then(r => {
      var s = r && r.value && r.value[0];
      return !s ? null : s.err ? { status: '0x0' } : /^(confirmed|finalized)$/.test(s.confirmationStatus || '') ? { status: '0x1' } : null;
    });
  }

  /* Paying to an address. An open address of Relay's for this trader: whatever is paid there is priced when it arrives and lands,
     as dollars, in the trader's own wallet on HyperEVM, with a little HYPE when the wallet has none. Read before it is shown:
     the coin and the amount asked; the trader as the only recipient; no calls; refunds to the trader (or the refund address
     given); Relay's own depository behind it. */
  var addrRail = {
    order: function (o) {
      var k = AK[o.kind], amt = BigInt(Math.round(o.usd / o.px * Math.pow(10, k.show))) * 10n ** BigInt(k.dec - k.show), user = k.evm ? o.account : o.refund || (o.kind === 'btc' ? k.coin : '');
      if (!user || !(amt > 0n)) return Promise.reject(say(AGAIN));
      var b = { user: user, recipient: o.account, refundTo: user, originChainId: k.chain, destinationChainId: api.chainId, originCurrency: k.coin, destinationCurrency: api.usdc, amount: String(amt), tradeType: 'EXACT_INPUT', useDepositAddress: true };
      if (o.feePct > 0 && o.feeTo) b.appFees = [{ recipient: o.feeTo, fee: String(Math.round(o.feePct * 100)) }];
      if (o.topUsd > 0) { b.topupGas = true; b.topupGasAmount = String(Math.round(o.topUsd * 1e6)); }
      return getJson(RELAY + '/quote/v2', b).then(j => {
        var d = j.details || {}, st = (j.steps || [])[0] || {}, dep = String(st.depositAddress || ''), v2 = (j.protocol || {}).v2 || {}, od = v2.orderData || {}, out = od.output || {}, pd = v2.paymentDetails || {};
        if (!dep || !st.requestId || !d.currencyIn || !d.currencyOut) throw new Error('unexpected quote');
        var cin = d.currencyIn.currency || {}, cout = d.currencyOut.currency || {}, got = BigInt(d.currencyOut.amount || 0), inUsd = Number(amt) / Math.pow(10, k.dec) * o.px, pays = out.payments || [];
        var ok = (o.kind === 'tron' ? tronOk(dep) : k.ok.test(dep)) && lowS(dep) !== lowS(k.dep) && (!k.evm || (lowS(dep) !== lowS(o.account) && lowS(dep) !== RELAY_SOLVER && lowS(dep) !== HYPE_ROUTER)) && String(d.currencyIn.amount) === String(amt) && String(pd.amount) === String(amt)
          && (k.evm ? lowS(pd.depository) === k.dep && lowS(pd.currency) === lowS(k.coin) && lowS(cin.address) === lowS(k.coin) : pd.depository === k.dep && cin.address === k.coin) && Number(cin.chainId) === k.chain && lowS(cout.address) === lowS(api.usdc) && Number(cout.chainId) === api.chainId && lowS(d.recipient) === lowS(o.account)
          && pays.length >= 1 && pays.every(p => lowS(p.recipient) === lowS(o.account) && lowS(p.currency) === lowS(api.usdc)) && Array.isArray(out.calls) && out.calls.length === 0
          && refundsTo(od, o.account, o.refund || null) && (!(o.topUsd > 0) || !!d.currencyGasTopup)
          && Number(got) / 1e6 <= inUsd * 1.02 && Number(got) / 1e6 >= inUsd * (1 - (o.feePct || 0) / 100) - Math.max(8, inUsd * 0.06);
        if (!ok) throw new Error('quote does not match the order');
        if (Number(got) / 1e6 < inUsd * 0.7) throw say('That is too little to send this way. Try a bit more.');
        return { rail: 'addr', kind: o.kind, chain: k.chain, usd: inUsd, amt: amt, gross6: got, net6: got, addr: dep, id: st.requestId, refund: o.refund || '' };
      });
    },
    quote: function (o) { return this.order(o); },
    track: function (p) { return relay.track(p); }
  };
  /* the payment as its own chain shows it: Bitcoin's public mempool, Tron's public index. { seen, conf } or null (could not ask) */
  function addrSeen(p) {
    if (p.kind === 'btc') {
      return Promise.all([getJson('https://mempool.space/api/address/' + p.addr + '/txs'), getJson('https://mempool.space/api/blocks/tip/height')]).then(r => {
        var best = null;
        (Array.isArray(r[0]) ? r[0] : []).forEach(t => { if ((t.vout || []).some(v => v.scriptpubkey_address === p.addr)) { var c = t.status && t.status.confirmed ? Math.max(1, Number(r[1]) - t.status.block_height + 1) : 0; if (!best || c > best.conf) best = { seen: true, conf: c }; } });
        return best || { seen: false, conf: 0 };
      });
    }
    var k = AK[p.kind];
    /* an EVM address: the coin sitting on it before Relay moves it on (a look that comes too late is covered by Relay's own word) */
    if (k.evm) return (k.coin === ZERO ? rpc(k.chain, 'eth_getBalance', [p.addr, 'latest']).then(hex => BigInt(hex)) : ecall(k.chain, k.coin, 'balanceOf', [p.addr]).then(r => BigInt(r[0]))).then(b => ({ seen: b > 0n, conf: b > 0n ? 1 : 0 }));
    return getJson('https://api.trongrid.io/v1/accounts/' + p.addr + '/transactions/trc20?limit=5&only_to=true&contract_address=' + AK.tron.coin).then(j => {
      var n = (j && j.data) || []; return { seen: n.length > 0, conf: n.length > 0 ? 1 : 0 };
    });
  }
  function trackAddr() {
    clearTimeout(ADD.ttimer);
    var p = ADD.pend; if (!p || p.final || p.rail !== 'addr' || p.state === 'arrived' || document.hidden) return;
    var again = () => { ADD.ttimer = setTimeout(trackAddr, p.seen || Date.now() - p.since < 1800000 ? 6000 : 20000); };
    Promise.all([addrSeen(p).catch(() => null), relay.track(p).catch(() => null), api.refresh().catch(noop)]).then(x => {
      if (ADD.pend !== p || p.final || p.state === 'arrived') return;
      var s = x[0], st = x[1], a = api.account(), got = a.loaded ? cents(a.walletUsdc - p.wusdc0) : 0;
      if ((s && s.seen) || st === 'moving' || st === 'done') p.seen = p.seen || Date.now();
      if (s && s.seen) p.conf = s.conf;
      if (st === 'refunded') { finishPend('refunded'); return; }
      /* arrived: the wallet's dollars rose after the payment was seen, whatever the amount (a short payment is credited for what
         it is; Relay may fill it under a new order, so its word on the first order is not waited for). A payment this page never
         saw counts only when about the expected dollars came. */
      if (got >= 0.5 && (p.seen || got >= p.net * 0.5)) { p.cap = got; finishPend('finish'); return; }
      p.state = st === 'failed' ? 'failed' : p.seen ? 'seen' : 'waiting'; savePend(); kick(); again();
      if (ADD.sh && ADD.sh.isOpen && ADD.view === 'pay') paintAdd();
    });
  }

  /* FETTI in the wallet (free FETTI only: staked FETTI is not the wallet's to spend). Its one market is the pool against HYPE, so a
     sale moves its price: the dollars shown are the sale priced on the pool now and the HYPE it makes priced by Relay now, and one
     add never moves the price by more than the cap (config swap.fettiMovePct, 2 unless set). */
  var FT = { bal: null, rf: null, rw: null, allow: null };
  /* FETTI as a way to add money is switched off (the owner, 2026-11-21: "pause this immediately"). false: the way is not
     offered anywhere on the form and can never be the picked way. true brings it back exactly as it was. */
  var FETTI_PAY = true;
  function fcfg() { var c = api.cfg() || {}, s = c.swap || {}; return { tok: (c.contracts || {}).confetti, router: s.router, pair: s.pair, whype: s.whype, cap: Number(s.fettiMovePct) > 0 && Number(s.fettiMovePct) <= 10 ? Number(s.fettiMovePct) : 2 }; }
  function setReserves(r, f) { var w0 = BigInt(f.whype) < BigInt(f.tok); FT.rw = BigInt(w0 ? r[0] : r[1]); FT.rf = BigInt(w0 ? r[1] : r[0]); }
  function readFetti() {
    var f = fcfg(), a = api.wallet().account; if (!a || !f.tok || !f.pair || !f.router) return;
    Promise.all([ecall(api.chainId, f.tok, 'balanceOf', [a]), ecall(api.chainId, f.pair, 'getReserves'), ecall(api.chainId, f.tok, 'allowance', [a, f.router])]).then(r => {
      if (api.wallet().account !== a) return;
      FT.bal = BigInt(r[0][0]); setReserves(r[1], f); FT.allow = BigInt(r[2][0]); kick(); scheduleQuote();
    }).catch(noop);
  }
  function fettiPx() { var px = hypePx(); return FT.rf > 0n && px > 0 ? Number(FT.rw) / Number(FT.rf) * px : NaN; }
  function fettiCapWei() { return FT.rf == null ? 0n : BigInt(Math.floor(Number(FT.rf) * (1 / Math.sqrt(1 - fcfg().cap / 100) - 1) * 0.998)); }
  function fettiMaxWei() { var cap = fettiCapWei(); return FT.bal == null ? 0n : FT.bal < cap ? FT.bal : cap; }
  function fettiMove(dx) { var r = Number(FT.rf); return r > 0 ? (1 - Math.pow(r / (r + Number(dx)), 2)) * 100 : 100; }
  function fettiUsd(wei) { var px = fettiPx(); return px > 0 ? Number(wei) / 1e18 * px : NaN; }
  function quoteFetti(o) {
    var f = fcfg(), px = fettiPx(), dx = o.max ? fettiMaxWei() : px > 0 ? BigInt(Math.round(o.usd / px * 1e6)) * 1000000000000n : 0n;
    if (!(dx > 0n)) return Promise.reject(say(AGAIN));
    return ecall(api.chainId, f.router, 'getAmountsOut', [dx, [f.tok, f.whype]]).then(r => {
      var out = BigInt(r[0][1]);
      return getJson(RELAY + '/quote/v2', { user: o.account, recipient: o.account, refundTo: o.account, originChainId: api.chainId, destinationChainId: api.chainId, originCurrency: ZERO, destinationCurrency: api.usdc, amount: String(out), tradeType: 'EXACT_INPUT' }).then(j => {
        var d = j.details || {}, co = d.currencyOut || {}, got = BigInt(co.amount || 0), hp = hypePx();
        if (!(got > 0n) || lowS((co.currency || {}).address) !== lowS(api.usdc) || !(hp > 0) || Math.abs(Number(got) / 1e6 - Number(out) / 1e18 * hp) > Number(out) / 1e18 * hp * 0.08) throw new Error('unexpected quote');
        /* what the HYPE order will land: Relay's dollars for that HYPE, less the page's share and the order's own price room */
        return { rail: 'fetti', chain: api.chainId, usd: Number(dx) / 1e18 * px, dx: dx, out: out, gross6: got, net6: got * BigInt(10000 - Math.round((o.feePct || 0) * 100)) / 10000n * 980n / 1000n, move: fettiMove(dx) };
      });
    });
  }
  function btcWallets() {
    var o = [];
    try {
      if (window.unisat && window.unisat.sendBitcoin) o.push({ name: 'UniSat', send: (a, s) => window.unisat.sendBitcoin(a, s) });
      var xv = window.XverseProviders && window.XverseProviders.BitcoinProvider;
      if (xv && xv.request) o.push({ name: 'Xverse', send: (a, s) => xv.request('sendTransfer', { recipients: [{ address: a, amount: s }] }).then(r => { if (r && r.error) throw r.error; return r; }) });
      var lw = window.LeatherProvider;
      if (lw && lw.request) o.push({ name: 'Leather', send: (a, s) => lw.request('sendTransfer', { recipients: [{ address: a, amount: String(s) }], network: 'mainnet' }) });
    } catch (e) { /* none */ }
    return o;
  }

  var RAILS = { relay: relay, debridge: debridge, hype: hypeRail, usdt: usdtRail, sol: solRail, addr: addrRail };
  /* Relay first. The second rail only when Relay itself says it has no route for the order; a timeout, a busy answer or an
     answer the page refused keeps the first rail and is asked again. Every quote is then held against the page's own figures. */
  var NO_ROUTE = /^(NO_SWAP_ROUTES_FOUND|NO_INTERNAL_SWAP_ROUTES_FOUND|NO_QUOTES|INSUFFICIENT_LIQUIDITY|UNSUPPORTED_ROUTE|UNSUPPORTED_CURRENCY|SWAP_IMPACT_TOO_HIGH)$/;
  function held(q, o) {
    var mine = Number(q.payWei) / 1e18 * (q.rail === 'hype' ? o.px : o.ethPx);          /* what the ETH (or HYPE) is worth at the page's own price */
    if (Math.abs(q.usd - o.usd) > Math.max(0.05, o.usd * 0.01) || Math.abs(mine - o.usd) > o.usd * 0.08) { var e = say(AGAIN); e.again = true; throw e; }
    return q;
  }
  function quoteRails(o) {
    if (o.feeTo && !(Number(o.feePct) >= 0 && Number(o.feePct) <= 10)) return Promise.reject(say(OFF));
    return relay.quote(o).then(q => held(q, o), e => {
      if (e && e.plain != null) throw e;
      var code = e && e.api && e.api.errorCode;
      if (code === 'AMOUNT_TOO_LOW') throw say('That is too little to send. Try a bit more.');
      if (code === 'AMOUNT_TOO_HIGH') throw say('That is more than can be sent in one go. Try a smaller amount.');
      if (!NO_ROUTE.test(code || '')) { var x = say(AGAIN); x.again = true; throw x; }
      return debridge.quote(o).then(q => held(q, o)).catch(() => { throw say('There is no price for that right now. Try again in a minute.'); });
    });
  }

  var ADD = { sh: null, view: '', typed: '50', method: null, userChain: null, refused: {}, bal: {}, gas: {}, balFor: null, balAt: 0, q: null, quoting: false, qseq: 0, qtimer: null, qerr: '',
    err: '', chainsOpen: false, how: { usdt: 'wallet', eth: 'wallet', hype: 'wallet' }, ak: {}, btcFrom: 'exch', refund: {}, usdtChain: null, ub: {}, ubErr: {}, uOpen: false, moreOpen: null, note: '', auto: false, busy: '', wait: null, pend: null, fin: null, ttimer: null, atimer: null, added: null, balErr: {}, btimer: null, run: 0, rtimer: null, asking: 0 };

  function amount() { var n = Number(String(ADD.typed).replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; }
  function ethPx() { var p = api.price('ETH'); return p && p.px > 0 ? p.px : NaN; }
  function balUsd(c) { var b = ADD.bal[c], px = ethPx(); return b != null && px > 0 ? Number(b) / 1e18 * px : NaN; }
  function spendable(c) { var b = ADD.bal[c]; return b != null && b > CH[c].keep ? b - CH[c].keep : 0n; }
  /* The wallet's ETH on the three chains. The chain the wallet is on is read through the wallet, the others over a public
     RPC. A read that failed leaves that chain unknown (never zero) and is asked again a few seconds later. */
  function readBalances() {
    var w = api.wallet(); if (!w.account) return;
    if (ADD.balFor !== w.account) { ADD.bal = {}; ADD.balErr = {}; ADD.ub = {}; ADD.ubErr = {}; FT.bal = null; FT.allow = null; ADD.balFor = w.account; }
    ADD.balAt = Date.now(); clearTimeout(ADD.btimer);
    CH_ORDER.forEach(c => {
      var ask = w.chainId === c && w.eth ? w.eth.request({ method: 'eth_getBalance', params: [w.account, 'latest'] }).catch(() => rpc(c, 'eth_getBalance', [w.account, 'latest'])) : rpc(c, 'eth_getBalance', [w.account, 'latest']);
      ask.then(hex => { if (ADD.balFor === w.account) { ADD.bal[c] = BigInt(hex); ADD.balErr[c] = false; kick(); scheduleQuote(); } }).catch(() => {
        if (ADD.balFor !== w.account) return;
        ADD.balErr[c] = true; kick();
        clearTimeout(ADD.btimer); ADD.btimer = setTimeout(() => { if (ADD.sh && ADD.sh.isOpen && ADD.view === 'form') readBalances(); }, 6000);
      });
      rpc(c, 'eth_gasPrice', []).then(hex => { ADD.gas[c] = BigInt(hex); }).catch(noop);
    });
    /* the wallet's HYPE is the page's own read (api.refresh); its price and HyperEVM's gas price are asked here */
    readHypePx();
    rpc(api.chainId, 'eth_gasPrice', []).then(hex => { ADD.gas[api.chainId] = BigInt(hex); }).catch(noop);
    readMore();
  }
  /* HYPE's price: Hyperliquid's own (asked when the sheet opens and every half minute while it is open), else what the page's own
     swap last saw. Unknown until either answers: the HYPE row then shows the coin only and is not picked by itself. */
  var HPX = { px: NaN, at: 0, asking: false };
  function hypePx() { var a = api.account(); return HPX.px > 0 && Date.now() - HPX.at < 180000 ? HPX.px : a.hypeUsd > 0 ? a.hypeUsd : HPX.px > 0 ? HPX.px : NaN; }
  function readHypePx() {
    if (HPX.asking || Date.now() - HPX.at < 30000) return;
    HPX.asking = true;
    Promise.resolve().then(() => api.info({ type: 'allMids' }, 5000)).then(m => { var v = Number(m && m.HYPE); if (v > 0) { HPX.px = v; HPX.at = Date.now(); kick(); scheduleQuote(); } }).catch(noop).then(() => { HPX.asking = false; });
  }
  /* The HYPE kept in the wallet, never spent here: what the page keeps today (its swap's 0.03 HYPE, or a first session's setup and
     about 50 trades as the ETH order tops up, whichever is more), plus this order's own gas. The rest is what can pay. */
  function hypeHold() {
    var s = api.session(), fee = s.feeWei && s.feeWei > 0n ? BigInt(s.feeWei) : 200000000n, need = s.live ? HYPE_FLOOR : HYPE_FLOOR + (GAS_SETUP + TOPUP_TRADES * GAS_TRADE) * fee;
    var keep = BigInt(api.swapKeepWei || 0n);
    return need > keep ? need : keep;
  }
  function hypeKeep() { var gp = ADD.gas[api.chainId] > 0n ? ADD.gas[api.chainId] : 1000000000n; return hypeHold() + HYPE_GAS * gp * 2n; }
  function hypeHave() { var a = api.account(); return a.hypeWei != null ? BigInt(a.hypeWei) : null; }
  function hypeSpare() { var h = hypeHave(), k = hypeKeep(); return h != null && h > k ? h - k : 0n; }
  function hypeUsd(wei) { var px = hypePx(); return wei != null && px > 0 ? Number(wei) / 1e18 * px : NaN; }
  function hypeMax() { var px = hypePx(); return px > 0 ? Math.floor(Number(hypeSpare()) / 1e18 * px * 0.995 * 100) / 100 : 0; }
  /* 'ok': enough spare HYPE to add from; 'low': under the smallest add, so the row is greyed; '': not known yet */
  function hypeState() { return hypeHave() == null || !(hypePx() > 0) ? '' : hypeUsd(hypeSpare()) >= MIN_ADD_USD ? 'ok' : 'low'; }
  var LOW_HYPE = 'Not enough HYPE to pay with: a little always stays in your wallet for your trades.';
  /* Where the ETH comes from: their pick; else the wallet's own chain when it covers the amount; else the first of
     Base, Arbitrum, Ethereum that does; else the one holding the most. */
  function chainNow() {
    var px = ethPx(), want = px > 0 ? BigInt(Math.round(amount() / px * 1e18)) : 0n, ok = CH_ORDER.filter(c => !ADD.refused[c] && ADD.bal[c] != null);
    if (ADD.userChain && ok.indexOf(ADD.userChain) >= 0) return ADD.userChain;
    var covers = ok.filter(c => spendable(c) >= want && want > 0n), on = api.wallet().chainId;
    if (covers.indexOf(on) >= 0) return on;
    if (covers.length) return covers[0];
    var best = null; ok.forEach(c => { if (ADD.bal[c] > 0n && (best == null || ADD.bal[c] > ADD.bal[best])) best = c; });
    return best;
  }
  function methods() {
    var a = api.account();
    return { apple: api.applePayOn(), eth: true, hype: true, wallet: a.walletUsdc >= 1, usdt: true, sol: true, btc: true, fetti: true };
  }
  /* the most dollars of ETH one chain can send (unread chains count as none) */
  function ethBest() { var px = ethPx(), best = 0; CH_ORDER.forEach(c => { if (!ADD.refused[c] && ADD.bal[c] != null && px > 0) best = Math.max(best, Number(spendable(c)) / 1e18 * px); }); return best; }
  function method() {
    var m = methods(), c = chainNow(), hs = hypeState();
    if (!FETTI_PAY && ADD.method === 'fetti') ADD.method = null;
    if (ADD.method && m[ADD.method] && !(ADD.method === 'hype' && hs === 'low' && ADD.how.hype !== 'addr')) return ADD.method;
    /* USDT in the wallet that covers the amount when neither the ETH nor the spare HYPE does */
    if (usdtBest() >= Math.max(MIN_ADD_USD, amount()) && ethBest() < amount() && !(hs === 'ok' && hypeUsd(hypeSpare()) >= amount())) return 'usdt';
    /* their pick; else the richer of the wallet's ETH and its spare HYPE, as ETH picks its richest chain */
    if (hs === 'ok' && hypeUsd(hypeSpare()) > ethBest()) return 'hype';
    if (c != null) return 'eth';
    if (m.wallet) return 'wallet';
    if (usdtBest() >= MIN_ADD_USD) return 'usdt';
    if (FETTI_PAY && fettiUsd(fettiMaxWei()) >= MIN_ADD_USD) return 'fetti';
    return m.apple ? 'apple' : 'eth';
  }
  /* the new ways' own state: where the USDT is, which address way, what makes a quote this way's own */
  function usdtUsd(c) { var b = ADD.ub[c]; return b != null ? Number(b) / 1e6 : NaN; }
  function usdtBest() { var best = 0; UT_ORDER.forEach(c => { if (ADD.ub[c] != null) best = Math.max(best, usdtUsd(c)); }); return best; }
  function usdtChain() {
    var ok = UT_ORDER.filter(c => ADD.ub[c] != null && !ADD.refused[c]), want = amount();
    if (ADD.usdtChain && ok.indexOf(ADD.usdtChain) >= 0) return ADD.usdtChain;
    var covers = ok.filter(c => usdtUsd(c) >= want && want > 0);
    if (covers.length) return covers[0];
    var best = null; ok.forEach(c => { if (ADD.ub[c] > 0n && (best == null || ADD.ub[c] > ADD.ub[best])) best = c; });
    return best;
  }
  function kindNow() { var m = method(), x; return m === 'btc' ? 'btc' : ADD.how[m] !== 'addr' ? null : m === 'hype' ? 'hype' : AKS[m] ? ((x = ADD.ak[m]) && AKS[m].indexOf(x) >= 0 ? x : AKS[m][0]) : null; }
  function refundNow() { var k = kindNow(); return k && needRef(k) ? String(ADD.refund[k] || '').trim() : ''; }
  function wayKey() { var m = method(), k = kindNow(); return [m, k || '', m === 'usdt' && !k ? usdtChain() : '', refundNow(), m === 'sol' && SW.acct ? SW.acct.address : '', m === 'fetti' && ADD.max ? 'max' : ''].join('|'); }
  function coinPx(sym) { var p = api.price(sym); return p && p.px > 0 ? p.px : NaN; }
  /* the wallet's USDT where it can pay from, its free FETTI and the pool, and a connected Solana wallet's SOL */
  function readMore() {
    var w = api.wallet(), a = w.account; if (!a) return;
    swStart();
    UT_ORDER.forEach(c => {
      ecall(c, UT[c].token, 'balanceOf', [a]).then(r => { if (ADD.balFor === a) { ADD.ub[c] = BigInt(r[0]); ADD.ubErr[c] = false; kick(); scheduleQuote(); } }, () => { if (ADD.balFor === a) { ADD.ubErr[c] = true; kick(); } });
    });
    readFetti(); readSol();
  }
  /* the HYPE the wallet lacks, in dollars: for a first session (the setup and about 50 trades) while one-tap is not on, and the
     floor the page keeps in the wallet once it is. 0: it has enough. */
  function topUsd() {
    var s = api.session(), a = api.account();
    var fee = s.feeWei && s.feeWei > 0n ? BigInt(s.feeWei) : 200000000n, need = s.live ? HYPE_FLOOR : HYPE_FLOOR + (GAS_SETUP + TOPUP_TRADES * GAS_TRADE) * fee, have = a.hypeWei != null ? BigInt(a.hypeWei) : 0n;
    if (have >= need) return 0;
    if (!(a.hypeUsd > 0)) return 0.45;
    return Math.min(TOPUP_MAX_USD, Math.max(0.1, Math.ceil(Number(need - have) / 1e18 * a.hypeUsd * 20) / 20));
  }
  /* the page's own share of an Add money order, by the FETTI level this wallet held for the last 7 days (perks.json, never the
     live stake: a level bought for one add and sold after would pay for itself). 1: all of it; 0.5 at Level 1; 0 from Level 2 */
  function addShare() { var F = fx(), w = api.wallet(); return F && w.account ? F.addShare(w.account) : 1; }
  function orderOf() {
    var f = api.fees(), w = api.wallet(), k = addShare(), m = method(), kn = kindNow();
    /* the new ways: the ETH rule (fees.bridgePercent) where the money crosses chains, the HYPE rule (fees.swapBips) where it does not;
       the FETTI level's own part of it (addShare) as on ETH and HYPE */
    function part(pct) { return { feePct: f.wallet ? pct * k : 0, kept: f.wallet ? pct * (1 - k) : 0 }; }
    if (kn) return Object.assign({ kind: kn, chain: AK[kn].chain, usd: amount(), account: w.account, refund: refundNow(), topUsd: topUsd(), feeTo: f.wallet, px: kindPx(kn) }, part(kn === 'hype' ? f.swapBips / 100 : f.bridgePercent));
    if (m === 'usdt') { var uc = usdtChain(), here = uc === api.chainId; return Object.assign({ chain: uc, usd: amount(), account: w.account, topUsd: here ? 0 : topUsd(), feeTo: f.wallet }, part(here ? f.swapBips / 100 : f.bridgePercent)); }
    if (m === 'sol') return Object.assign({ chain: SOLC.chain, usd: amount(), account: w.account, sol: SW.acct ? SW.acct.address : null, topUsd: topUsd(), feeTo: f.wallet, px: coinPx('SOL') }, part(f.bridgePercent));
    if (m === 'fetti') return Object.assign({ chain: api.chainId, usd: amount(), account: w.account, max: !!ADD.max, feeTo: f.wallet }, part(f.swapBips / 100));
    /* HYPE: no gas top-up (the wallet holds HYPE), the share of a HYPE conversion (the page's own swap's, fees.swapBips), and on Max
       never more HYPE than the wallet can spare */
    if (method() === 'hype') return { chain: api.chainId, usd: amount(), account: w.account, topUsd: 0, feePct: f.wallet ? f.swapBips / 100 * k : 0, feeTo: f.wallet, px: hypePx(), capWei: ADD.max ? hypeSpare() : null, kept: f.wallet ? f.swapBips / 100 * (1 - k) : 0 };
    return { chain: chainNow(), usd: amount(), account: w.account, topUsd: topUsd(), feePct: f.wallet ? f.bridgePercent * k : 0, feeTo: f.wallet, ethPx: ethPx(), kept: f.wallet ? f.bridgePercent * (1 - k) : 0 };
  }
  function scheduleQuote(ms) { clearTimeout(ADD.qtimer); ADD.qtimer = setTimeout(doQuote, ms == null ? 350 : ms); }
  function doQuote() {
    clearTimeout(ADD.qtimer);
    if (!ADD.sh || !ADD.sh.isOpen || ADD.view !== 'form' || ADD.busy) return;
    if (NEW[method()] || kindNow()) { doQuoteNew(); return; }
    var o = orderOf(), seq = ++ADD.qseq, hy = method() === 'hype';
    if (hy) readHypePx();
    /* HYPE: no price is asked for more than the wallet can spare (the form says so instead) */
    var off = hy ? !(o.px > 0) || (!ADD.max && o.usd > hypeMax() + 0.005) : method() !== 'eth' || !(o.ethPx > 0);
    if (off || o.chain == null || !(o.usd >= MIN_ADD_USD) || document.hidden || api.gate()) { ADD.q = null; ADD.qerr = ''; ADD.quoting = false; paintAdd(); if (document.hidden) scheduleQuote(5000); return; }
    ADD.quoting = true; paintAdd();
    var soon = false;
    (hy ? quoteHype(o) : quoteRails(o)).then(function (q) { if (seq === ADD.qseq) { ADD.q = q; ADD.q.forUsd = o.usd; ADD.qerr = ''; ADD.qsoon = false; } }, function (e) { if (seq === ADD.qseq) { ADD.q = null; ADD.qerr = errText(e); soon = ADD.qsoon = !!(e && e.again); } }).then(() => {
      if (seq !== ADD.qseq) return;
      ADD.quoting = false; paintAdd();
      ADD.qtimer = setTimeout(doQuote, soon ? 5000 : 25000);  /* quotes go stale: asked again while the sheet is open, and once more before sending */
      /* the HYPE a FETTI sale just made: its order is pressed for the trader, who confirms it in the wallet like any other */
      if (ADD.auto && ADD.q && !ADD.busy) { ADD.auto = false; paintAdd(); if (ADD.R.go && ADD.R.go._ok) addGo(); }
    });
  }
  /* a price for one of the new ways. null: nothing to price yet (the form says what is missing). An address order is kept for
     two minutes, not asked again every half minute: each asking makes a new address. */
  function newQuote(m, o) {
    if (o.feeTo && !(Number(o.feePct) >= 0 && Number(o.feePct) <= 10)) return () => Promise.reject(say(OFF));
    var k = kindNow();
    if (k) return !(o.px > 0) || (needRef(k) && !(k === 'tron' ? tronOk(o.refund) : AK.btc.ok.test(o.refund))) || o.usd < AK[k].min ? null : () => addrRail.quote(o).catch(railErr);
    if (m === 'usdt') return o.chain == null || o.usd > usdtUsd(o.chain) + 0.005 ? null : () => usdtRail.quote(o).then(q => heldNew(q, o), railErr);
    if (m === 'sol') return !o.sol || !(o.px > 0) ? null : () => solRail.quote(o).then(q => heldNew(q, o), railErr);
    if (m === 'fetti') return FT.bal == null || !(fettiPx() > 0) || (!o.max && (o.usd > fettiUsd(fettiCapWei()) + 0.005 || o.usd > fettiUsd(FT.bal) + 0.005)) ? null : () => quoteFetti(o).catch(railErr);
    return null;
  }
  function doQuoteNew() {
    var m = method(), o = orderOf(), key = wayKey(), ask = newQuote(m, o), seq = ++ADD.qseq, soon = false, addr = !!kindNow();
    if (m === 'fetti' || m === 'hype') readHypePx();
    if (!ask || !(o.usd >= MIN_ADD_USD) || document.hidden || api.gate()) { ADD.q = null; ADD.qerr = ''; ADD.quoting = false; paintAdd(); if (document.hidden) scheduleQuote(5000); return; }
    if (addr && ADD.q && ADD.q.key === key && Math.abs(ADD.q.forUsd - o.usd) < 0.005 && Date.now() - ADD.q.at < 120000) { ADD.quoting = false; paintAdd(); ADD.qtimer = setTimeout(doQuote, 30000); return; }
    ADD.quoting = true; paintAdd();
    ask().then(function (q) { if (seq === ADD.qseq) { q.forUsd = o.usd; q.key = key; q.at = Date.now(); ADD.q = q; ADD.qerr = ''; ADD.qsoon = false; } }, function (e) { if (seq === ADD.qseq) { ADD.q = null; ADD.qerr = errText(e); soon = ADD.qsoon = !!(e && e.again); } }).then(() => {
      if (seq !== ADD.qseq) return;
      ADD.quoting = false; paintAdd();
      ADD.qtimer = setTimeout(doQuote, soon ? 5000 : addr ? 30000 : 25000);
    });
  }
  /* the screen a record stands on: one rule for the phone sheet, the desktop panel, and a wallet or a second tab changing under either */
  function viewOf(p) { return ADD.fin ? 'finish' : p ? (p.final ? (p.state === 'done' ? 'ready' : 'fail') : p.rail === 'apple' ? 'apple' : p.rail === 'addr' ? 'pay' : 'moving') : 'form'; }
  function finOf(p) { return p.rail === 'addr' ? { hype: false, cap: p.cap || p.net } : p.rail === 'apple' ? (p.swapped ? { hype: false, cap: p.usdc || 0 } : { hype: true, hype0: p.hype0 }) : { hype: false, cap: p.net }; }
  function openAdd() {
    var w = api.wallet(), p = ADD.pend;
    if (!w.account) { doConnect(); return; }
    if (api.demo) { api.pro('addUsdc'); return; }
    if (api.gate() && !p) { snack(OFF); return; }
    var sh = ADD.sh && !ADD.sh.dk ? ADD.sh : (ADD.sh = ADD.phoneSh || (ADD.phoneSh = makeSheet('Add', true)));
    sh.onClose = () => {
      ADD.chainsOpen = false; clearTimeout(ADD.qtimer); clearTimeout(ADD.btimer);
      if (ADD.run) endRun(null);                      /* a press whose sheet was closed never opens the wallet */
      if (ADD.view === 'ready' || ADD.view === 'fail') { ADD.view = ''; ADD.added = null; if (ADD.pend && ADD.pend.final) dropPend(); }
    };
    if (p && !p.final && p.state === 'arrived') ADD.fin = ADD.fin || finOf(p);       /* an arrival put off with "Not now" is offered again */
    if (!ADD.busy) ADD.view = viewOf(p);
    ADD.err = ''; ADD.built = ''; ADD.note = ''; ADD.auto = false;
    sh.open();
    api.refresh().catch(noop); readBalances();
    paintAdd(); scheduleQuote(0);
  }

  function paintAdd() {
    if (ADD.sh && ADD.sh.dk) { if (ADD.sh.isOpen) paintDesktopAdd(); return; }
    var sh = ADD.sh, v = ADD.view || 'form';
    if (ADD.built !== v) {
      ADD.built = v; sh.body.textContent = ''; sh.foot.textContent = ''; ADD.R = {};
      var old = sh.d.querySelector('.sm-wait'); if (old) old.remove();
      ({ form: buildForm, moving: buildMoving, apple: buildMoving, ready: buildReady, fail: buildFail, finish: buildFinish, pay: buildPay })[v]();
    }
    ({ form: fillForm, moving: fillMoving, apple: fillMoving, ready: fillReady, fail: noop, finish: fillFinish, pay: fillPay })[v]();
    fillWait();
  }

  function buildForm() {
    var sh = ADD.sh, r = ADD.R, m = methods();
    txt(sh.title, 'Add money');
    r.amt = amtInput('smAddAmount', 'How much, in dollars', ADD.typed, v => { ADD.typed = v; ADD.err = ''; ADD.q = null; ADD.max = false; paintAdd(); scheduleQuote(); });
    var lab = h('label', 'sm-label is-amt', ['How much', h('span', 'sm-hint', 'Type any amount')]); lab.htmlFor = 'smAddAmount';
    r.chips = h('div', 'sm-chips');
    [25, 50, 100, 'max'].forEach(v => {
      var b = btn(null, '', () => {
        var val = b._v;
        if (val === 'max') { val = maxUsd(); ADD.max = true; if (!(val > 0)) { ADD.err = 'There is nothing to add from there yet.'; paintAdd(); return; } } else ADD.max = false;
        ADD.typed = String(val); r.amt.value = ADD.typed; ADD.err = ''; ADD.q = null; paintAdd(); scheduleQuote(0);
      });
      b._slot = v; r.chips.appendChild(b);
    });
    function pick(key, title) {
      var p = { sub: h('i') };
      p.n = btn('sm-pick', [h('span', 'sm-radio'), h('span', 'sm-t', [p.b = h('b', null, title), p.sub])], ev => {
        if (p.more && p.more.contains(ev.target)) return;
        if (key === 'hype' && hypeState() === 'low') ADD.how.hype = 'addr';     /* greyed: the wallet cannot pay with it, so its address way opens */
        ADD.method = key; ADD.err = ''; ADD.q = null; ADD.max = false; ADD.note = ''; ADD.auto = false; paintAdd(); scheduleQuote(0);
      });
      p.n.setAttribute('role', 'radio');
      return p;
    }
    r.apple = pick('apple', 'Apple Pay'); r.eth = pick('eth', 'ETH in your wallet'); r.hype = pick('hype', 'HYPE in your wallet'); r.wallet = pick('wallet', 'Money already in your wallet');
    r.eth.more = h('span', 'sm-more', '›'); r.eth.more.setAttribute('role', 'button'); r.eth.more.setAttribute('aria-label', 'Choose where the ETH comes from');
    r.eth.more.addEventListener('click', () => { var was = ADD.how.eth; ADD.method = 'eth'; ADD.how.eth = 'wallet'; ADD.chainsOpen = !ADD.chainsOpen; if (was === 'addr') { ADD.q = null; scheduleQuote(0); } paintAdd(); });
    r.eth.n.appendChild(r.eth.more);
    r.opts = h('div', 'sm-opts');
    CH_ORDER.forEach(function (c) { var b = btn(null, [h('span', null, CH[c].name), h('span')], () => { ADD.userChain = c; ADD.method = 'eth'; ADD.chainsOpen = false; ADD.q = null; ADD.err = ''; paintAdd(); scheduleQuote(0); }); b._c = c; r.opts.appendChild(b); });
    /* the new ways. A row shows when it is picked or the wallet can pay that way now; the others wait behind one key. */
    r.usdt = pick('usdt', 'USDT'); r.sol = pick('sol', 'SOL in a Solana wallet'); r.btc = pick('btc', 'Bitcoin'); r.fetti = pick('fetti', 'FETTI in your wallet');
    /* the two ways each coin is offered: from the connected wallet, or to an address shown with its QR code (Bitcoin: who pays it) */
    r.how = h('div', 'sm-seg2');
    [0, 1].forEach(i => {
      var b = btn(null, '', () => {
        var mm = method();
        if (mm === 'btc') ADD.btcFrom = i ? 'exch' : 'own';
        else if (mm === 'hype' && !i && hypeState() === 'low') { ADD.err = LOW_HYPE; paintAdd(); return; }
        else ADD.how[mm] = i ? 'addr' : 'wallet';
        ADD.uOpen = false; ADD.chainsOpen = false; ADD.q = null; ADD.err = ''; ADD.max = false; paintAdd(); scheduleQuote(0);
      });
      b._i = i; r.how.appendChild(b);
    });
    r.net = h('div', 'sm-seg2 is-net');
    [0, 1, 2].forEach(i => { var b = btn(null, '', () => { var mm = method(); if (!AKS[mm]) return; ADD.ak[mm] = AKS[mm][i]; ADD.q = null; ADD.err = ''; paintAdd(); scheduleQuote(0); }); b._i = i; r.net.appendChild(b); });
    r.usdt.more = h('span', 'sm-more', '›'); r.usdt.more.setAttribute('role', 'button'); r.usdt.more.setAttribute('aria-label', 'Choose where the USDT comes from');
    r.usdt.more.addEventListener('click', () => { ADD.method = 'usdt'; ADD.how.usdt = 'wallet'; ADD.uOpen = !ADD.uOpen; ADD.q = null; paintAdd(); scheduleQuote(0); });
    r.usdt.n.appendChild(r.usdt.more);
    r.uopts = h('div', 'sm-opts');
    UT_ORDER.forEach(function (c) { var b = btn(null, [h('span', null, UT[c].name), h('span')], () => { ADD.usdtChain = c; ADD.uOpen = false; ADD.q = null; ADD.err = ''; paintAdd(); scheduleQuote(0); }); b._c = c; r.uopts.appendChild(b); });
    r.ref = h('input', 'sm-field'); r.ref.type = 'text'; r.ref.maxLength = 90; r.ref.setAttribute('autocomplete', 'off'); r.ref.setAttribute('autocapitalize', 'off'); r.ref.setAttribute('spellcheck', 'false'); r.ref.setAttribute('aria-label', 'Refund address');
    r.ref.addEventListener('input', () => { var k = kindNow(); if (!k) return; ADD.refund[k] = r.ref.value.trim(); ADD.q = null; ADD.err = ''; paintAdd(); scheduleQuote(700); });
    r.refLab = h('p', 'sm-fine', ''); r.refBox = h('div', 'sm-refbox', [r.refLab, r.ref]);
    r.refKey = btn('sm-link sm-refkey', 'Paying from an exchange?', () => { ADD.refOpen = true; paintAdd(); setTimeout(() => { try { r.ref.focus(); } catch (e) { /* fine */ } }, 60); });
    var here = /^https:$/.test(location.protocol) ? location.origin + location.pathname : 'https://confetti.trade/trade.html', enc = encodeURIComponent;
    r.solLinks = h('div', 'sm-links');
    (api.isPhone() ? [['Open in Phantom', 'https://phantom.app/ul/browse/' + enc(here) + '?ref=' + enc(here)], ['Open in Solflare', 'https://solflare.com/ul/v1/browse/' + enc(here) + '?ref=' + enc(here)]]
      : [['Get Phantom', 'https://phantom.com/download'], ['Get Solflare', 'https://solflare.com/download']]).forEach(x => { var a = h('a', 'sm-link', x[0]); a.href = x[1]; a.target = '_blank'; a.rel = 'noopener'; r.solLinks.appendChild(a); });
    r.moreKey = btn('sm-morekey', [h('b', null, 'More ways to pay'), h('span', null, '')], () => { ADD.moreOpen = !r._open; paintAdd(); });
    r.moreList = h('div', 'sm-opts is-more');
    [['usdt', 'USDT'], ['sol', 'Solana'], ['btc', 'Bitcoin'], ['fetti', 'FETTI']].filter(x => FETTI_PAY || x[0] !== 'fetti').forEach(x => {
      var b = btn(null, [h('span', null, x[1]), h('span')], () => { ADD.method = x[0]; ADD.moreOpen = false; ADD.err = ''; ADD.q = null; ADD.max = false; ADD.note = ''; ADD.auto = false; paintAdd(); scheduleQuote(0); });
      b._m = x[0]; r.moreList.appendChild(b);
    });
    var group = h('div', 'sm-ways', [r.apple.n, r.eth.n, r.opts, r.hype.n, r.wallet.n, r.usdt.n, r.how, r.net, r.uopts, r.sol.n, r.solLinks, r.btc.n, r.refKey, r.fetti.n, r.refBox, r.moreKey, r.moreList]); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'Pay with');
    r.get = h('span', 'is-go', ''); r.eta = h('span', null, '');
    r.fine = h('p', 'sm-fine', '');
    add(sh.body, [lab, h('label', 'sm-amt', [h('span', null, '$'), r.amt]), r.chips, h('div', 'sm-label', 'Pay with'), group,
      h('div', 'sm-sum', [h('div', 'sm-sumrow', [h('span', null, 'You’ll trade with'), r.get]), h('div', 'sm-sumrow', [h('span', null, 'Ready in'), r.eta])]), r.fine]);
    r.say = sayLine();
    r.go = btn('sm-btn is-primary', '', addGo);
    r.other = btn('sm-quiet', 'Other ways to add', function () { if (ADD.busy) return; ADD.sh.close(); setTimeout(function () { timed(api.toHyperEvm(), 30000, '').then(() => { api.pro('addUsdc'); }, () => { snack(STAYED + 'nothing happened. Try again.'); }); }, 220); });
    r.stop = btn('sm-link', 'Cancel', () => { endRun(CANCELLED); }); r.stop.style.justifyContent = 'center';
    add(sh.foot, [r.say, r.go, r.stop]);
    add(sh.body, r.other);
    show(r.apple.n, m.apple);
  }
  function maxUsd() {
    var m = method(), a = api.account();
    if (m === 'wallet') return cents(a.walletUsdc);
    if (kindNow()) return 250;
    if (m === 'hype') return hypeMax();          /* all the HYPE above what stays for trading */
    if (m === 'usdt') { var uc = usdtChain(); return uc != null ? Math.floor(usdtUsd(uc) * 100) / 100 : 0; }
    if (m === 'sol') { var sp = coinPx('SOL'); return SW.bal != null && SW.bal > SOLC.keep && sp > 0 ? Math.floor(Number(SW.bal - SOLC.keep) / 1e9 * sp * 0.99 * 100) / 100 : 0; }
    if (m === 'fetti') { var fu = fettiUsd(fettiMaxWei()); return fu > 0 ? Math.floor(fu * 100) / 100 : 0; }
    if (m !== 'eth') return 250;
    var c = chainNow(), px = ethPx();
    return c != null && px > 0 ? Math.floor(Number(spendable(c)) / 1e18 * px * 0.995 * 100) / 100 : 0;
  }
  function fillForm() {
    var r = ADD.R, m = method(), ms = methods(), a = api.account(), w = api.wallet(), amt = amount(), c = chainNow(), hy = m === 'hype', kn = kindNow();
    var q = ADD.q && ADD.q.chain === (hy ? api.chainId : c) && Math.abs(ADD.q.forUsd - amt) < 0.005 ? ADD.q : null;
    if (NEW[m] || kn) q = ADD.q && ADD.q.key === wayKey() && Math.abs(ADD.q.forUsd - amt) < 0.005 ? ADD.q : null;
    else if (q && !(q.rail === 'relay' || q.rail === 'debridge' || q.rail === 'hype')) q = null;
    var busy = !!ADD.busy;
    /* the wallet's HYPE (or its price) came in after the sheet asked: HYPE is priced now */
    var hsig = m + '|' + hypeState() + '|' + hypeHave();
    if (ADD.hsig !== hsig) { if (ADD.hsig != null && hy && !busy) scheduleQuote(); ADD.hsig = hsig; }
    if (document.activeElement !== r.amt && r.amt.value !== ADD.typed) r.amt.value = ADD.typed;
    r.amt.disabled = busy;
    each(r.chips, b => {
      var v = b._slot === 'max' ? (m === 'apple' || kindNow() ? 250 : 'max') : b._slot; b._v = v;
      txt(b, v === 'max' ? 'Max' : '$' + v);
      b.setAttribute('aria-pressed', (v === 'max' ? !!ADD.max : !ADD.max && amt === v) ? 'true' : 'false'); b.disabled = busy;
    });
    show(r.wallet.n, ms.wallet);
    [['apple', r.apple], ['eth', r.eth], ['hype', r.hype], ['wallet', r.wallet], ['usdt', r.usdt], ['sol', r.sol], ['btc', r.btc], ['fetti', r.fetti]].forEach(x => { x[1].n.setAttribute('aria-checked', x[0] === m ? 'true' : 'false'); x[1].n.disabled = busy; });
    fillWays(r, m, ms, busy);
    txt(r.apple.sub, 'Card on your phone · a few minutes');
    txt(r.wallet.sub, usd(a.walletUsdc) + ' ready to add');
    /* HYPE: what the wallet holds and what it is worth; greyed (and saying why when tapped) when what it can spare is under the smallest add */
    var hw = hypeHave(), low = hypeState() === 'low';
    txt(r.hype.sub, kn === 'hype' ? 'From an exchange or another wallet' : hw == null ? 'Looking in your wallet…' : hw === 0n ? 'No HYPE in this wallet' : ethS(hw) + '\u00a0HYPE' + (hypePx() > 0 ? ' · you have ' + usd(hypeUsd(hw)) : ''));
    var grey = low && kn !== 'hype';
    if (r.hype.n.getAttribute('aria-disabled') !== String(grey)) r.hype.n.setAttribute('aria-disabled', String(grey));
    var all = CH_ORDER.every(x => ADD.bal[x] != null), bad = CH_ORDER.filter(x => ADD.bal[x] == null && ADD.balErr[x])[0];
    /* "No ETH" only when all three chains answered; a chain that could not be read is said as that (it is asked again by itself) */
    txt(r.eth.b, m === 'eth' && kn ? 'ETH' : 'ETH in your wallet'); txt(r.hype.b, kn === 'hype' ? 'HYPE' : 'HYPE in your wallet');
    txt(r.eth.sub, m === 'eth' && kn ? 'On ' + AK[kn].name + ' · from an exchange or a wallet' : c != null ? 'On ' + CH[c].name + ' · you have ' + usd(balUsd(c)) : bad != null ? 'Could not check ' + CH[bad].name + ' just now.' : !all ? 'Looking in your wallet…' : 'No ETH found on Base, Arbitrum or Ethereum');
    show(r.opts, ADD.chainsOpen && m === 'eth' && !kn); show(r.eth.more, !(m === 'eth' && kn));
    each(r.opts, b => {
      var x = b._c, v = balUsd(x);
      txt(b.lastChild, ADD.refused[x] ? 'not in this wallet' : ADD.bal[x] == null ? (ADD.balErr[x] ? 'could not check' : '…') : usd(v));
      b.setAttribute('aria-pressed', x === c ? 'true' : 'false'); b.disabled = !!ADD.refused[x] || !(ADD.bal[x] > 0n);
    });
    /* the summary: what lands (exact: the order fixes it), and when */
    var get = '…', eta = '', fine = '', why = ADD.err, ok = false, label = 'Add ' + usdS(amt), note = '', retry = false;
    if (kn || NEW[m]) {
      var z = newWay(m, amt, q, a, w); get = z.get; eta = z.eta; fine = z.fine; why = z.why; ok = z.ok; label = z.label; note = z.note; retry = z.retry;
    } else if (m === 'eth') {
      /* the line promises no more than the wallet does: a wallet on another network asks to change first */
      var hop = c != null && w.chainId !== c ? ' Your wallet may first ask to change network.' : '';
      eta = 'about a minute'; fine = 'One confirmation in your wallet.' + hop;
      if (q) fine = 'One confirmation in your wallet: ' + ethS(q.payWei) + ' ETH on ' + CH[c].name + '.' + hop;
      if (q) {
        get = usd(Number(q.net6) / 1e6); ok = true;
        if (q.steps.length > 1) fine = 'Two confirmations in your wallet, one after the other: ' + ethS(q.payWei) + ' ETH on ' + CH[c].name + ' in all.' + hop;
        if (Number(q.net6) / 1e6 + a.available < a.min) { ok = false; why = why || 'Add a little more: trades start at ' + usdS(a.min) + '.'; }
        if (q.payWei > spendable(c) + CH[c].keep / 2n) { ok = false; why = why || 'You have ' + ethS(ADD.bal[c]) + ' ETH on ' + CH[c].name + ' (' + usd(balUsd(c)) + '). This needs ' + ethS(q.payWei) + ' ETH plus a little extra for the network. Try less, or tap Max.'; }
      } else if (!ADD.quoting) {
        get = '—'; eta = '';
        if (c == null) {
          /* nothing to price: what cannot be said is left blank, and the next step is said (not an error: nothing went wrong) */
          fine = '';
          if (all) note = ms.apple ? 'No ETH in this wallet on Base, Arbitrum or Ethereum. Apple Pay works without any.' : 'No ETH in this wallet on Base, Arbitrum or Ethereum. Pick another way to pay, or pay ETH by QR Code.';
          if (note && !r.seen && !r._open) { r.seen = true; setTimeout(() => { if (r.other.scrollIntoView) r.other.scrollIntoView({ block: 'nearest' }); }, 80); }
        } else {
          why = why || (amt > 0 && amt < MIN_ADD_USD ? 'The smallest amount is ' + usdS(MIN_ADD_USD) + '.' : amt > 0 && !ADD.qsoon ? ADD.qerr : '');
          /* a price service that is busy is not the person's mistake: said quietly, and it is asked again by itself */
          if (!why && amt >= MIN_ADD_USD && ADD.qsoon && ADD.qerr) note = 'Still getting a price. It is asked again by itself.';
          retry = amt >= MIN_ADD_USD && !!ADD.qerr && !ADD.err;       /* no price: the button asks again instead of sitting dead */
        }
      }
    } else if (hy) {
      /* HYPE: the same promise as ETH (one confirmation, what lands is exact); what stays in the wallet for trading is said once */
      var hhop = w.chainId !== api.chainId ? ' Your wallet may first ask to change network.' : '', stays = ' A little HYPE stays in your wallet for your trades.';
      var over = !ADD.max && amt > hypeMax() + 0.005 && hypePx() > 0;
      eta = 'a few seconds'; fine = 'One confirmation in your wallet.' + stays + hhop;
      if (q) {
        fine = 'One confirmation in your wallet: ' + ethS(q.payWei) + '\u00a0HYPE.' + stays + hhop;
        get = usd(Number(q.net6) / 1e6); ok = true;
        if (Number(q.net6) / 1e6 + a.available < a.min) { ok = false; why = why || 'Add a little more: trades start at ' + usdS(a.min) + '.'; }
        if (q.payWei > hypeSpare()) over = true;
      }
      if (over) { ok = false; get = '—'; eta = ''; fine = ''; why = why || 'You have ' + ethS(hw || 0n) + '\u00a0HYPE (' + usd(hypeUsd(hw || 0n)) + '). A little stays in your wallet for your trades, so up to ' + usd(hypeMax()) + ' can be added. Try less, or tap Max.'; }
      else if (!q && !ADD.quoting) {
        get = '—'; eta = '';
        why = why || (amt > 0 && amt < MIN_ADD_USD ? 'The smallest amount is ' + usdS(MIN_ADD_USD) + '.' : amt > 0 && !ADD.qsoon ? ADD.qerr : '');
        if (!why && amt >= MIN_ADD_USD && ADD.qsoon && ADD.qerr) note = 'Still getting a price. It is asked again by itself.';
        retry = amt >= MIN_ADD_USD && !!ADD.qerr && !ADD.err;
      }
    } else if (m === 'apple') {
      /* MoonPay's checkout shows its own numbers; these say what to expect (card 4.5%, $4.50 at least) */
      var card = Math.max(4.5, amt * 0.045), keep = isFinite(a.hypeUsd) ? Number(api.swapKeepWei) / 1e18 * a.hypeUsd : 2, left = Math.max(0, amt - card - keep), cf = left * 0.013;
      get = 'about ' + usd(left - cf); eta = 'a few minutes'; ok = amt >= 20;
      fine = 'You pay in MoonPay’s checkout, which shows the exact numbers.'; label = 'Buy with Apple Pay';
      if (!ok && amt > 0) why = why || 'Apple Pay starts at $20.';
    } else if (m === 'wallet') {
      get = usd(cents(Math.min(amt, a.walletUsdc))); eta = 'under a minute'; ok = amt > 0 && amt <= a.walletUsdc + 0.005;
      fine = 'Two quick confirmations in your wallet.';
      if (amt > a.walletUsdc + 0.005) why = why || 'Your wallet has ' + usd(a.walletUsdc) + ' ready. Tap Max to add all of it.';
    }
    if (!(amt > 0) && !(m === 'sol' && !SW.acct)) { get = '—'; ok = false; }
    if (hy && !kn && !why && !note && ADD.note) note = ADD.note;
    /* an address way whose summary sits under the fold on a small phone: what lands is said beside the key too */
    if (kn && ok && !why && !note && ADD.sh.foot && ADD.sh.body && r.get.getBoundingClientRect().bottom + ADD.sh.body.scrollTop > ADD.sh.foot.getBoundingClientRect().top) note = 'You’ll trade with ' + get + '.';
    if (api.gate()) { ok = false; retry = false; why = OFF; }
    /* a staker's level keeps more of the add in the trading money: said once, in dollars, after what lands */
    if (q && (m === 'eth' || hy)) { var ko = orderOf(); if (ko.kept > 0 && amt > 0) fine += ' Your FETTI level adds ' + usd(amt * ko.kept / 100) + ' to this.'; }
    txt(r.get, get); txt(r.eta, eta || '—');
    txt(r.fine, fine);
    txt(r.say, why || note || ''); cls(r.say, 'sm-say' + (why && why !== LOW_HYPE ? ' is-bad' : ''));      /* the greyed HYPE row's why is a note, not a mistake */
    var word = { 'switch': 'Getting your wallet ready…', check: 'Checking the price…', wallet: CONFIRM, asking: 'Waiting for your wallet…', open: 'Opening MoonPay…', net: 'Waiting for the network…', connect: 'Opening your wallet…' }[ADD.busy];
    txt(r.go, word || (retry ? 'Try again' : label));
    cls(r.go, 'sm-btn ' + (m === 'apple' ? 'is-apple' : 'is-primary') + (word ? ' is-busy' : ''));
    r.go.disabled = !ok && !word && !retry; r.go._ok = ok && !word; r.go._retry = retry && !ok && !word;
    show(r.stop, ADD.busy === 'switch' || ADD.busy === 'check'); r.other.disabled = busy;
  }

  /* the wallet is open: nothing is sent until it says yes. A wait with a way out, not a second question. */
  function fillWait() {
    var sh = ADD.sh, w = ADD.wait, n = sh.d.querySelector('.sm-wait');
    if (!w) { if (n) n.remove(); return; }
    if (!n) {
      n = h('div', 'sm-wait', h('div', null, [h('span', 'sm-spin is-big'), h('h3', null, 'Confirm in your wallet'), h('p'), btn('sm-btn is-ghost', 'Cancel', () => { endRun(CANCELLED); })]));
      sh.d.appendChild(n);
    }
    var p = n.querySelector('p'), key = w.text; if (p._k === key) return;
    p._k = key; p.textContent = '';
    add(p, [(w.of ? w.i + ' of ' + w.of + '. ' : '') + (w.lead || 'Your wallet shows one payment of '), h('b', null, w.amount), w.tail || '. Nothing is sent until you confirm.']);
  }

  /* One press is one run. Cancel, closing the sheet, or a wallet that does not answer ends the run, and a run that has ended
     never opens the wallet and never sends. If the wallet is still showing a request when the run ends, the form stays locked
     ("Waiting for your wallet…") until the wallet answers it or a minute passes, so a second press cannot put a second payment
     beside the first; and a payment that does leave the wallet is followed, whatever was pressed here. */
  function redoAdd() { if (ADD.sh && ADD.sh.isOpen && ADD.view === 'form') { paintAdd(); if (!ADD.busy) scheduleQuote(0); } }
  function endRun(why) {
    var asking = ADD.asking;
    ADD.run = 0; ADD.wait = null; clearTimeout(ADD.rtimer);
    ADD.busy = asking ? 'asking' : '';
    if (why != null) ADD.err = why;
    if (asking) ADD.rtimer = setTimeout(() => { if (ADD.asking === asking) { ADD.asking = 0; ADD.busy = ''; redoAdd(); } }, 60000);
    redoAdd();
  }
  function appleGo(amt) {
    var a0 = api.account();
    /* the purchase is recognised by the coin that arrives: no start while the wallet's coin is not known */
    if (a0.hypeWei == null) { ADD.err = 'Still reading your wallet. Press again in a moment.'; api.refresh().catch(noop); paintAdd(); return; }
    ADD.busy = 'open'; paintAdd();
    Promise.resolve(api.applePay(amt)).then(ok => ok, () => false).then(ok => {
      ADD.busy = '';
      if (!ok) { ADD.err = 'MoonPay could not be opened right now. Try again in a moment.'; redoAdd(); return; }
      setPend({ rail: 'apple', usd: amt, since: Date.now(), hype0: String(a0.hypeWei), state: 'waiting' });
      ADD.view = 'apple'; if (ADD.sh.isOpen) paintAdd(); watchApple();
    });
  }

  /* One press: the wallet is asked onto the chain, the order is priced once more (a worse price stops and shows), the
     account is checked for the amount and the network's own part (said with the numbers), then the wallet opens. */
  function addGo() {
    var r = ADD.R, m = method(), amt = amount();
    if (ADD.busy || early()) return;
    if (r.go._retry) { ADD.qerr = ''; ADD.q = null; doQuote(); return; }      /* there was no price: ask again */
    if (!r.go._ok) return;
    ADD.err = '';
    if (api.gate()) { ADD.err = OFF; paintAdd(); return; }
    if (m === 'apple') { appleGo(amt); return; }
    if (m === 'wallet') { ADD.fin = { hype: false, cap: amt, auto: true }; ADD.view = 'finish'; paintAdd(); finishGo(); return; }
    if (kindNow()) { addrGo(); return; }
    if (NEW[m]) { ({ usdt: usdtGo, btc: addrGo, sol: SW.acct ? solGo : solConnect, fetti: fettiGo })[m](); return; }
    var hy = m === 'hype', q0 = ADD.q, o = orderOf(), c = o.chain, w = api.wallet(), acct = w.account, q = null, a0 = null, hashes = [];
    if (!q0 || q0.chain !== c || (q0.rail === 'hype') !== hy) return;
    var run = ADD.run = Date.now() + Math.random();
    function live() { return ADD.run === run; }
    function check() { if (!live()) throw say(''); }
    function arm(ms, why) { clearTimeout(ADD.rtimer); ADD.rtimer = setTimeout(() => { if (live()) endRun(why); }, ms); }
    /* something left the wallet: from here it is the record's, whatever else happened to the press */
    function followed() {
      if (ADD.pend && ADD.pend.hash === hashes[0]) { ADD.pend.pay = ethS(hashes.length === q.steps.length ? q.payWei : q.steps[0].value); savePend(); }
      if (live() || !ADD.run) { ADD.run = 0; ADD.asking = 0; ADD.wait = null; ADD.busy = ''; clearTimeout(ADD.rtimer); }
      ADD.typed = '50'; ADD.q = null; ADD.err = '';
      if (api.wallet().account === acct && ADD.pend) { ADD.view = 'moving'; if (ADD.sh.isOpen) paintAdd(); track(); }
      timed(api.toHyperEvm(), 30000, '').catch(noop);      /* back to where the trading is, so the first trade needs no network step */
    }
    ADD.busy = 'switch'; clearTimeout(ADD.qtimer); paintAdd(); arm(60000, NO_ANSWER);
    timed(hy ? toHype() : walletTo(c), 30000, NO_ANSWER).then(() => {
      check(); ADD.busy = 'check'; paintAdd();
      return Promise.all([RAILS[q0.rail].refresh(q0, o), api.refresh().catch(noop)]);
    }).then(x => {
      check();
      var fq = held(x[0], q0.capped ? Object.assign({}, o, { usd: x[0].usd }) : o); fq.forUsd = q0.forUsd; if (q0.capped) fq.capped = true;
      if (fq.payWei > q0.payWei + q0.payWei / 200n) { ADD.q = fq; throw say('The price moved a little. Check the new numbers and press again.'); }
      q = ADD.q = fq;
      return Promise.all([w.eth.request({ method: 'eth_accounts', params: [] }), w.eth.request({ method: 'eth_getBalance', params: [acct, 'latest'] }), w.eth.request({ method: 'eth_gasPrice', params: [] }).catch(() => '0x0')]);
    }).then(x => {
      check();
      var mine = (x[0] || []).some(y => String(y).toLowerCase() === acct.toLowerCase()), bal = BigInt(x[1]), gas = 120000n * BigInt(x[2]) * BigInt(q.steps.length) * 3n / 2n;
      if (!mine) throw say((w.name || 'Your wallet') + ' is not letting this page use ' + short(acct) + '. Open it, pick that account, then press again.');
      if (hy) {
        /* HYPE: the payment, this order's own gas and what stays for trading must all fit in the wallet, read just now */
        if (bal < q.payWei + hypeHold() + (q.gas > 0n ? q.gas : HYPE_GAS) * BigInt(x[2]) * 3n / 2n) throw say('You have ' + ethS(bal) + '\u00a0HYPE. This needs ' + ethS(q.payWei) + '\u00a0HYPE, and a little stays in your wallet for your trades. Try less, or tap Max.');
      } else {
        ADD.bal[c] = bal;
        if (bal < q.payWei + gas) throw say('You have ' + ethS(bal) + ' ETH on ' + CH[c].name + '. This needs ' + ethS(q.payWei) + ' ETH plus about ' + ethS(gas) + ' ETH for the network. Try less, or tap Max.');
      }
      a0 = api.account();        /* what the add is measured against, read before anything can leave the wallet */
      var signer = new E.JsonRpcSigner(new E.BrowserProvider(w.eth), acct);
      return q.steps.reduce((p, st, i) => p.then(() => {
        check();
        if (api.wallet().account !== acct) throw say('Your wallet changed account, so nothing was sent. Check the numbers and press again.');
        if (api.gate()) throw say(OFF);
        /* right before the wallet opens: it must still be on the chain this payment is for */
        return w.eth.request({ method: 'eth_chainId', params: [] }).then(hex => {
          if (parseInt(hex, 16) !== c) throw say('Your wallet moved to another network, so nothing was sent. Press again.');
          check();
          ADD.busy = 'wallet'; ADD.wait = { text: i + '|' + st.value, i: i + 1, of: q.steps.length > 1 ? q.steps.length : 0, amount: ethS(st.value) + (hy ? '\u00a0HYPE' : ' ETH on ' + CH[c].name) }; paintAdd();
          arm(60000, 'Your wallet did not answer. If it is still asking, say no there, then press again.');
          var mark = ADD.asking = run + i + 1;
          /* the hash comes back the moment the wallet has sent it, and the record is written with the first one */
          return signer.sendUncheckedTransaction({ to: st.to, data: st.data, value: st.value, chainId: c }).then(hash => {
            if (ADD.asking === mark) ADD.asking = 0;
            hashes.push(hash);
            if (hashes.length === 1) setPend({ rail: q.rail, chain: c, hash: hash, id: q.id, usd: q0.forUsd, net: Number(q.net6) / 1e6, pay: ethS(st.value), since: Date.now(), avail0: a0.available, wusdc0: a0.walletUsdc, state: 'sent', sentOk: false }, acct);
          }, e => { if (ADD.asking === mark) ADD.asking = 0; throw e; });
        });
      }), Promise.resolve());
    }).then(followed, e => {
      if (hashes.length) { followed(); return; }
      if (!live()) {            /* cancelled, closed or timed out: its sentence is already on the form */
        if (ADD.busy === 'asking' && !ADD.asking) { ADD.busy = ''; clearTimeout(ADD.rtimer); redoAdd(); }
        return;
      }
      ADD.run = 0; ADD.wait = null; ADD.busy = ''; clearTimeout(ADD.rtimer);
      if (e && e.refusedChain) {
        ADD.refused[c] = true; if (ADD.userChain === c) ADD.userChain = null;
        var next = chainNow();
        ADD.err = (w.name || 'Your wallet') + ' does not have ' + CH[c].name + (next != null ? ', so this will come from ' + CH[next].name + ' instead. Check the numbers and press again.' : ' and there is no ETH on the others. Try another wallet or another way to pay.');
      } else if (hy && /insufficient funds/i.test(String((e && (e.shortMessage || e.message)) || ''))) ADD.err = 'Not enough HYPE for this amount plus a little extra for the network. Try a little less.';
      else ADD.err = errText(e);
      redoAdd();
    });
  }
  /* ---- the new ways on the form, and their presses ---- */
  function placeOf(p) { return p.rail === 'sol' ? 'Solana' : (CH[p.chain] || UT[p.chain] || {}).name || ''; }
  /* which rows show: the picked way and the ways this wallet can pay with now, those first; the rest behind "More ways to pay",
     which stands open by itself when the wallet has nothing to pay with yet */
  function fillWays(r, m, ms, busy) {
    var use = { usdt: usdtBest() >= MIN_ADD_USD, sol: !!SW.acct, btc: false, fetti: FETTI_PAY && fettiUsd(fettiMaxWei()) >= MIN_ADD_USD }, hid = [];
    var can = { apple: true, eth: ethBest() >= MIN_ADD_USD, hype: hypeState() === 'ok', wallet: true }, any = can.eth || can.hype || ms.wallet || use.usdt || use.sol || use.fetti;
    ['usdt', 'sol', 'btc', 'fetti'].forEach(k => { var off = k === 'fetti' && !FETTI_PAY, on = !off && (m === k || use[k]); show(r[k].n, on); can[k] = use[k]; if (!on && !off) hid.push({ usdt: 'USDT', sol: 'Solana', btc: 'Bitcoin', fetti: 'FETTI' }[k]); });
    /* first what this wallet can pay with now; then a new way that was picked; a wallet with nothing to pay with leads with the list */
    var kN = kindNow();      /* a coin picked with its address way leads, like a way the wallet can pay with */
    function ord(n, k) { var v = can[k] || (k === m && kN) ? '0' : NEW[k] ? '1' : any ? '2' : '4'; if (n.style.order !== v) n.style.order = v; }
    /* a new way is picked: the ETH and HYPE rows that cannot pay now step aside, so what it costs and what lands stay in sight
       (they are back the moment the wallet can pay with them, or another way is picked) */
    show(r.eth.n, !NEW[m] || can.eth); show(r.hype.n, !NEW[m] || can.hype);
    ord(r.apple.n, 'apple'); ord(r.eth.n, 'eth'); ord(r.opts, 'eth'); ord(r.hype.n, 'hype'); ord(r.wallet.n, 'wallet'); ord(r.usdt.n, 'usdt'); ord(r.how, 'usdt'); ord(r.uopts, 'usdt');
    ord(r.sol.n, 'sol'); ord(r.solLinks, 'sol'); ord(r.btc.n, 'btc'); ord(r.fetti.n, 'fetti');
    var open = ADD.moreOpen == null ? !any && !NEW[m] && !kN : ADD.moreOpen; r._open = open;
    /* a wallet with nothing to pay with sees the ways themselves, not a key to open them */
    show(r.moreKey, hid.length > 0 && !(ADD.moreOpen == null && open)); show(r.moreList, hid.length > 0 && open);
    r.moreKey.setAttribute('aria-expanded', String(open)); r.moreKey.disabled = busy; txt(r.moreKey.lastChild, open ? 'Hide' : hid.join(' · '));
    each(r.moreList, b => { show(b, !(m === b._m || use[b._m])); b.disabled = busy; txt(b.lastChild, { usdt: 'your wallet, or QR Code', sol: 'under a minute', btc: AK.btc.eta, fetti: 'under a minute' }[b._m]); });
    var uc = usdtChain(), uall = UT_ORDER.every(x => ADD.ub[x] != null), k = kindNow(), tron = m === 'usdt' && !!k, sp = coinPx('SOL');
    function after(n, prev, key) { if (n.previousSibling !== prev) prev.parentNode.insertBefore(n, prev.nextSibling); ord(n, key); }
    txt(r.usdt.sub, tron ? 'On ' + AK[k].name + ' · from an exchange or a wallet' : uc != null ? 'On ' + UT[uc].name + ' · you have ' + usd(usdtUsd(uc)) : !uall ? 'Looking in your wallet…' : 'From your wallet, or QR Code');
    txt(r.sol.sub, SW.acct ? (SW.w.name || 'Wallet') + ' …' + SW.acct.address.slice(-4) + (SW.bal != null ? ' · ' + solS(SW.bal) + ' SOL' + (sp > 0 ? ' · you have ' + usd(Number(SW.bal) / 1e9 * sp) : '') : '') : SW.list.length ? SW.list.slice(0, 2).map(x => x.name).join(' or ') + ' found' : 'Phantom, Solflare or Backpack');
    var bq = m === 'btc' && ADD.q && ADD.q.rail === 'addr' && ADD.q.kind === 'btc' && ADD.q.key === wayKey() ? ADD.q : null;
    txt(r.btc.sub, bq ? coinS(bq.amt, 8) + ' BTC · ' + AK.btc.eta : 'QR Code · ' + AK.btc.eta);
    txt(r.fetti.sub, FT.bal == null ? 'Looking in your wallet…' : FT.bal === 0n ? 'No free FETTI in this wallet' : ethS(FT.bal) + ' FETTI free' + (fettiPx() > 0 ? ' · you have ' + usd(fettiUsd(FT.bal)) : ''));
    /* under the picked coin: its two ways (Bitcoin: who is paying), and for an address the network it is sent on */
    var two = m === 'btc' || m === 'usdt' || m === 'eth' || m === 'hype', nets = k && AKS[m] ? AKS[m] : null;
    show(r.how, two); show(r.net, !!nets);
    if (two) {
      after(r.how, r[m].n, m);
      each(r.how, b => { txt(b, m === 'btc' ? (b._i ? 'From an exchange' : 'From my wallet') : b._i ? 'QR Code' : 'From your wallet'); b.setAttribute('aria-pressed', String(m === 'btc' ? (ADD.btcFrom !== 'own') === !!b._i : (ADD.how[m] === 'addr') === !!b._i)); b.disabled = busy; });
    }
    if (nets) { after(r.net, r.how, m); each(r.net, b => { txt(b, AK[nets[b._i]].name); b.setAttribute('aria-pressed', String(nets[b._i] === k)); b.disabled = busy; }); }
    show(r.usdt.more, !tron); show(r.uopts, ADD.uOpen && m === 'usdt' && !tron);
    each(r.uopts, b => {
      var x = b._c;
      txt(b.lastChild, ADD.refused[x] ? 'not in this wallet' : ADD.ub[x] == null ? (ADD.ubErr[x] ? 'could not check' : '…') : usd(usdtUsd(x)));
      b.setAttribute('aria-pressed', x === uc ? 'true' : 'false'); b.disabled = !!ADD.refused[x] || !(ADD.ub[x] > 0n);
    });
    /* where a payment that cannot be added goes back: asked for Tron (it has no way back to a sender) and for Bitcoin paid from an exchange */
    var refOn = !!k && needRef(k);
    show(r.refBox, refOn); show(r.refKey, false);
    if (refOn) {
      after(r.refBox, k === 'tron' ? r.net : r.how, m);
      txt(r.refLab, 'Where a payment that cannot be added goes back: a ' + AK[k].name + ' wallet of yours, or your exchange’s ' + (k === 'tron' ? 'USDT deposit address on Tron.' : 'Bitcoin deposit address.'));
      r.ref.placeholder = k === 'tron' ? 'T… a Tron address of yours' : 'bc1… a Bitcoin address of yours';
      if (document.activeElement !== r.ref && r.ref.value !== (ADD.refund[k] || '')) r.ref.value = ADD.refund[k] || '';
      r.ref.disabled = busy;
    }
    show(r.solLinks, m === 'sol' && !SW.acct && !SW.list.length);
  }
  /* the summary of a new way: what lands, when, what the wallet will ask, and why not when it cannot go */
  function newWay(m, amt, q, a, w) {
    var z = { get: '…', eta: '', fine: '', why: ADD.err, ok: false, label: 'Add ' + usdS(amt), note: '', retry: false }, dest = short(w.account), k = kindNow();
    function unpriced(min) {
      z.get = '—'; z.eta = ''; z.fine = '';
      z.why = z.why || (amt > 0 && amt < min ? 'The smallest amount this way is ' + usdS(min) + '.' : amt > 0 && !ADD.qsoon ? ADD.qerr : '');
      if (!z.why && amt >= min && ADD.qsoon && ADD.qerr) z.note = 'Still getting a price. It is asked again by itself.';
      z.retry = amt >= min && !!ADD.qerr && !ADD.err;
    }
    function small() { if (q && Number(q.net6) / 1e6 + a.available < a.min) { z.ok = false; z.why = z.why || 'Add a little more: trades start at ' + usdS(a.min) + '.'; } }
    if (k) {
      var kk = AK[k], ref = refundNow(), nr = needRef(k);
      z.eta = kk.eta; z.label = 'Show the address';
      if (nr && !ref) { z.get = '—'; z.note = k === 'tron' ? 'Type a Tron address above to see what you will get.' : 'Type a Bitcoin address above to see what you will get. Paying from a wallet of your own? Tap From my wallet.'; return z; }
      if (nr && !(k === 'tron' ? tronOk(ref) : kk.ok.test(ref))) { z.get = '—'; z.why = z.why || 'That does not look like a ' + kk.name + ' address. Check it.'; return z; }
      if (!(kindPx(k) > 0)) { z.get = '—'; z.note = 'Still getting a price. It is asked again by itself.'; return z; }
      if (q) {
        z.get = 'about ' + usd(Number(q.net6) / 1e6); z.ok = true;
        z.fine = 'You send ' + coinS(q.amt, kk.dec) + ' ' + kk.sym + (k === 'btc' || k === 'hype' ? '' : ' on ' + kk.name) + ' to an address shown next. The dollars land in your wallet ' + dest + ', then one tap adds them.' + (k === 'btc' && !nr ? ' Pay this one from a wallet of your own, not from an exchange.' : '');
        small();
      } else if (!ADD.quoting) unpriced(kk.min);
      return z;
    }
    if (m === 'usdt') {
      var c = usdtChain(), same = c === api.chainId, hop = c != null && w.chainId !== c ? ' Your wallet may first ask to change network.' : '';
      z.eta = same ? 'a few seconds' : 'about a minute';
      if (c == null) { z.get = '—'; z.eta = ''; if (UT_ORDER.every(x => ADD.ub[x] != null)) z.note = 'No USDT in this wallet on HyperEVM, Arbitrum or Ethereum. Tap QR Code to send it from an exchange or another wallet.'; return z; }
      z.fine = 'Two confirmations in your wallet: allow the USDT, then pay.' + hop;
      if (amt > usdtUsd(c) + 0.005) { z.get = '—'; z.eta = ''; z.fine = ''; z.why = z.why || 'You have ' + usd(usdtUsd(c)) + ' of USDT on ' + UT[c].name + '. Try less, or tap Max.'; return z; }
      if (q) {
        var n = q.steps.length;
        z.get = usd(Number(q.net6) / 1e6); z.ok = true;
        z.fine = (n === 1 ? 'One confirmation in your wallet: ' : (n === 2 ? 'Two' : 'Three') + ' confirmations in your wallet, one after the other (allow, then pay): ') + n6(q.pay6) + ' USDT' + (same ? '' : ' on ' + UT[c].name) + '.' + hop;
        small();
        if (q.pay6 > ADD.ub[c]) { z.ok = false; z.why = z.why || 'You have ' + usd(usdtUsd(c)) + ' of USDT on ' + UT[c].name + '. This needs ' + n6(q.pay6) + '. Try less, or tap Max.'; }
      } else if (!ADD.quoting) unpriced(MIN_ADD_USD);
      return z;
    }
    if (m === 'sol') {
      z.eta = 'under a minute';
      if (!SW.acct) {
        z.get = '—'; z.eta = '';
        if (SW.list.length) { z.ok = true; z.label = 'Connect ' + (SW.list[0].name || 'your Solana wallet'); z.fine = 'Your Solana wallet pays. The money is added for the wallet you trade with, ' + dest + '.'; }
        else { z.label = 'No Solana wallet here'; z.note = api.isPhone() ? 'Open this page inside Phantom or Solflare to pay with SOL. There, connect the wallet you trade with.' : 'No Solana wallet found in this browser. Phantom, Solflare and Backpack work.'; }
        return z;
      }
      z.fine = 'One confirmation in ' + (SW.w.name || 'your Solana wallet') + '.';
      if (!(coinPx('SOL') > 0)) { z.get = '—'; z.note = 'Still getting a price. It is asked again by itself.'; return z; }
      if (q) {
        z.get = usd(Number(q.net6) / 1e6); z.ok = true;
        z.fine = 'One confirmation in ' + (SW.w.name || 'your Solana wallet') + ': ' + solS(q.payWei) + ' SOL. It is added for ' + dest + '.';
        small();
        if (SW.bal != null && q.payWei + SOLC.keep > SW.bal) { z.ok = false; z.why = z.why || 'You have ' + solS(SW.bal) + ' SOL. This needs ' + solS(q.payWei) + ' SOL plus a little for the network. Try less, or tap Max.'; }
      } else if (!ADD.quoting) unpriced(MIN_ADD_USD);
      return z;
    }
    /* FETTI */
    z.eta = 'under a minute';
    if (FT.bal == null || !(fettiPx() > 0)) { z.get = '—'; z.eta = ''; return z; }
    var cap = fettiUsd(fettiCapWei()), have = fettiUsd(FT.bal);
    if (!(have >= MIN_ADD_USD)) { z.get = '—'; z.eta = ''; z.note = 'No free FETTI in this wallet. Staked FETTI stays staked: unstake it first to pay with it.'; return z; }
    if (!ADD.max && amt > have + 0.005) { z.get = '—'; z.eta = ''; z.why = z.why || 'You have ' + ethS(FT.bal) + ' free FETTI (' + usd(have) + '). Staked FETTI stays staked. Try less, or tap Max.'; return z; }
    if (!ADD.max && amt > cap + 0.005) { z.get = '—'; z.eta = ''; z.why = z.why || 'That much would move FETTI’s price by more than ' + fcfg().cap + '%. One add can be up to ' + usd(Math.floor(cap * 100) / 100) + ' right now. Try less, or tap Max.'; return z; }
    if (q) {
      var steps = (FT.allow != null && FT.allow >= q.dx ? 0 : 1) + 2;
      z.get = 'about ' + usd(Number(q.net6) / 1e6); z.ok = true;
      z.fine = (steps === 3 ? 'Three confirmations in your wallet: allow the sale, sell ' : 'Two confirmations in your wallet: sell ') + ethS(q.dx) + ' FETTI for HYPE, then add it. The sale moves FETTI’s price by about ' + (q.move < 0.1 ? '0.1' : q.move.toFixed(1)) + '%.';
      small();
    } else if (!ADD.quoting) unpriced(MIN_ADD_USD);
    return z;
  }
  /* One press of a new way is one run, under addGo's own rules: Cancel, closing the sheet or a wallet that does not answer ends it,
     an ended run never opens a wallet, and what does leave a wallet is followed whatever was pressed here. */
  function newRun(body, gasCoin) {
    var run = ADD.run = Date.now() + Math.random(), n = 0;
    var R = {
      acct: api.wallet().account, sent: false,
      live: () => ADD.run === run,
      check: () => { if (ADD.run !== run) throw say(''); },
      arm: (ms, why) => { clearTimeout(ADD.rtimer); ADD.rtimer = setTimeout(() => { if (ADD.run === run) endRun(why); }, ms); },
      /* the wallet is asked: the overlay says what it shows, and the form stays locked until it answers */
      ask: (wait, fn) => {
        R.check(); ADD.busy = 'wallet'; ADD.wait = wait; paintAdd();
        R.arm(90000, 'Your wallet did not answer. If it is still asking, say no there, then press again.');
        var mark = ADD.asking = run + (++n);
        return Promise.resolve().then(fn).then(v => { if (ADD.asking === mark) ADD.asking = 0; return v; }, e => { if (ADD.asking === mark) ADD.asking = 0; throw e; });
      }
    };
    ADD.err = ''; clearTimeout(ADD.qtimer);
    function followed() {
      if (R.live() || !ADD.run) { ADD.run = 0; ADD.asking = 0; ADD.wait = null; ADD.busy = ''; clearTimeout(ADD.rtimer); }
      ADD.typed = '50'; ADD.q = null; ADD.err = '';
      if (api.wallet().account === R.acct && ADD.pend) { ADD.view = 'moving'; if (ADD.sh.isOpen) paintAdd(); track(); }
      if (ADD.pend && ADD.pend.rail !== 'sol') timed(api.toHyperEvm(), 30000, '').catch(noop);
    }
    Promise.resolve().then(() => body(R)).then(() => { if (R.sent) followed(); }, e => {
      if (R.sent) { followed(); return; }
      if (!R.live()) { if (ADD.busy === 'asking' && !ADD.asking) { ADD.busy = ''; clearTimeout(ADD.rtimer); redoAdd(); } return; }
      ADD.run = 0; ADD.wait = null; ADD.busy = ''; clearTimeout(ADD.rtimer);
      ADD.err = gasCoin && /insufficient funds/i.test(String((e && (e.shortMessage || e.message)) || '')) ? 'Not enough ' + gasCoin + ' for the network’s own part. Add a little and press again.' : errText(e);
      redoAdd();
    });
  }
  function sendEvm(R, c, st, wait) {
    var w = api.wallet();
    return w.eth.request({ method: 'eth_chainId', params: [] }).then(hex => {
      if (parseInt(hex, 16) !== c) throw say('Your wallet moved to another network, so nothing was sent. Press again.');
      if (api.wallet().account !== R.acct) throw say('Your wallet changed account, so nothing was sent. Check the numbers and press again.');
      if (api.gate()) throw say(OFF);
      return R.ask(wait, () => new E.JsonRpcSigner(new E.BrowserProvider(w.eth), R.acct).sendUncheckedTransaction({ to: st.to, data: st.data, value: st.value || 0n, chainId: c }));
    });
  }
  /* a step the next one stands on (an allowance, a sale): waited for on its own chain before anything else is asked */
  function mined(R, c, hash, failed) {
    ADD.busy = 'net'; ADD.wait = null; paintAdd(); R.arm(180000, 'The network is slow to answer. Look in your wallet before you press again.');
    return new Promise((yes, no) => {
      (function look() {
        if (!R.live()) { no(say('')); return; }
        rpc(c, 'eth_getTransactionReceipt', [hash]).catch(() => null).then(rc => {
          if (rc && rc.status === '0x1') yes(rc); else if (rc && rc.status === '0x0') no(say(failed)); else setTimeout(look, 1500);
        });
      })();
    });
  }
  function usdtGo() {
    var q0 = ADD.q, o = orderOf(), c = o.chain, w = api.wallet(), same = c === api.chainId, name = UT[c] && UT[c].name, q = null, a0 = null;
    if (!q0 || q0.rail !== 'usdt' || q0.chain !== c) return;
    newRun(R => {
      ADD.busy = 'switch'; paintAdd(); R.arm(60000, NO_ANSWER);
      return timed(same ? toHype() : walletTo(c), 30000, NO_ANSWER).then(() => {
        R.check(); ADD.busy = 'check'; paintAdd();
        return Promise.all([usdtRail.order(o, q0.gross6), api.refresh().catch(noop)]);
      }).then(x => {
        R.check();
        var fq = heldNew(x[0], o); fq.forUsd = q0.forUsd; fq.key = q0.key; fq.at = Date.now();
        if (fq.pay6 > q0.pay6 + q0.pay6 / 200n) { ADD.q = fq; throw say('The price moved a little. Check the new numbers and press again.'); }
        q = ADD.q = fq;
        return Promise.all([w.eth.request({ method: 'eth_accounts', params: [] }), w.eth.request({ method: 'eth_getBalance', params: [R.acct, 'latest'] }), w.eth.request({ method: 'eth_gasPrice', params: [] }).catch(() => '0x0'),
          w.eth.request({ method: 'eth_call', params: [{ to: UT[c].token, data: erc().encodeFunctionData('balanceOf', [R.acct]) }, 'latest'] })]);
      }).then(x => {
        R.check();
        var mine = (x[0] || []).some(y => String(y).toLowerCase() === R.acct.toLowerCase()), bal = BigInt(x[1]), have = BigInt(x[3]), gas = (same ? 900000n : 90000n * BigInt(q.steps.length) + 110000n) * BigInt(x[2]) * 3n / 2n;
        if (!mine) throw say((w.name || 'Your wallet') + ' is not letting this page use ' + short(R.acct) + '. Open it, pick that account, then press again.');
        ADD.ub[c] = have;
        if (have < q.pay6) throw say('You have ' + n6(have) + ' USDT' + (same ? '' : ' on ' + name) + '. This needs ' + n6(q.pay6) + '. Try less, or tap Max.');
        if (bal < gas) throw say('This needs a little ' + (same ? 'HYPE' : 'ETH on ' + name) + ' for the network’s own part: about ' + ethS(gas) + (same ? ' HYPE' : ' ETH') + '. Your wallet has ' + ethS(bal) + '.');
        a0 = api.account();
        return q.steps.reduce((p, st, i) => p.then(() => {
          R.check();
          var wait = { text: i + '|' + st.what, i: i + 1, of: q.steps.length > 1 ? q.steps.length : 0, amount: n6(q.pay6) + ' USDT' + (same ? '' : ' on ' + name) };
          if (st.what === 'allow') { wait.lead = 'Your wallet asks to allow exactly '; wait.tail = ' for this payment. Nothing is sent by this step.'; }
          if (st.what === 'reset') { wait.lead = 'Your wallet first clears an older allowance (it shows '; wait.amount = '0 USDT'; wait.tail = '). Nothing is sent by this step.'; }
          return sendEvm(R, c, st, wait).then(hash => {
            if (st.what !== 'pay') return mined(R, c, hash, 'That step did not go through, so nothing was sent. Press again.');
            setPend({ rail: 'usdt', chain: c, hash: hash, id: q.id, usd: q0.forUsd, net: Number(q.net6) / 1e6, pay: n6(q.pay6), coin: 'USDT', since: Date.now(), avail0: a0.available, wusdc0: a0.walletUsdc, state: 'sent', sentOk: false }, R.acct);
            R.sent = true;
          });
        }), Promise.resolve());
      });
    }, same ? 'HYPE' : 'ETH on ' + name);
  }
  function solConnect() {
    if (!SW.list.length || ADD.busy) return;
    ADD.busy = 'connect'; ADD.err = ''; paintAdd();
    swConnect(SW.list[0]).then(() => { ADD.busy = ''; redoAdd(); }, e => { ADD.busy = ''; ADD.err = e && e.plain != null && e.plain !== NO_ANSWER ? e.plain : 'Your Solana wallet did not connect. Nothing was sent.'; redoAdd(); });
  }
  function solGo() {
    var q0 = ADD.q, o = orderOf(), sw = SW.w, sa = SW.acct, q = null;
    if (!q0 || q0.rail !== 'sol' || !sw || !sa || o.sol !== sa.address) return;
    newRun(R => {
      ADD.busy = 'check'; paintAdd(); R.arm(60000, AGAIN);
      return Promise.all([solRail.order(o, q0.gross6), solRpc('getBalance', [sa.address, { commitment: 'confirmed' }]), solRpc('getLatestBlockhash', [{ commitment: 'confirmed' }]), api.refresh().catch(noop)]).then(x => {
        R.check();
        var fq = heldNew(x[0], o), bal = BigInt(x[1].value); fq.forUsd = q0.forUsd; fq.key = q0.key; fq.at = Date.now(); SW.bal = bal;
        if (fq.payWei > q0.payWei + q0.payWei / 200n) { ADD.q = fq; throw say('The price moved a little. Check the new numbers and press again.'); }
        q = ADD.q = fq;
        if (bal < q.payWei + SOLC.keep) throw say('You have ' + solS(bal) + ' SOL. This needs ' + solS(q.payWei) + ' SOL plus a little for the network. Try less, or tap Max.');
        if (api.wallet().account !== R.acct) throw say('Your wallet changed account, so nothing was sent. Check the numbers and press again.');
        if (api.gate()) throw say(OFF);
        var bytes = solTx(sa.address, q.ix, x[2].value.blockhash), a0 = api.account();
        return R.ask({ text: 'sol|' + q.payWei, i: 1, of: 0, amount: solS(q.payWei) + ' SOL' }, () => sw.features['solana:signAndSendTransaction'].signAndSendTransaction({ account: sa, chain: 'solana:mainnet', transaction: bytes })).then(res => {
          var one0 = Array.isArray(res) ? res[0] : res, sig = one0 && one0.signature;
          if (!sig) throw new Error('no signature');
          setPend({ rail: 'sol', chain: SOLC.chain, hash: typeof sig === 'string' ? sig : b58e(sig), id: q.id, usd: q0.forUsd, net: Number(q.net6) / 1e6, pay: solS(q.payWei), coin: 'SOL', since: Date.now(), avail0: a0.available, wusdc0: a0.walletUsdc, state: 'sent', sentOk: false }, R.acct);
          R.sent = true; readSol();
        });
      });
    }, 'SOL');
  }
  /* "Show the address": the order just read becomes the record, and the page waits for the payment */
  function addrGo() {
    var q = ADD.q, a0 = api.account();
    if (!q || q.rail !== 'addr' || q.key !== wayKey() || ADD.busy) return;
    if (api.gate()) { ADD.err = OFF; paintAdd(); return; }
    if (Date.now() - q.at > 180000) { ADD.q = null; ADD.err = 'That price is a few minutes old. Check the new numbers and press again.'; paintAdd(); scheduleQuote(0); return; }
    if (!a0.loaded) { ADD.err = 'Still reading your wallet. Press again in a moment.'; api.refresh().catch(noop); paintAdd(); return; }
    setPend({ rail: 'addr', kind: q.kind, addr: q.addr, amt: coinS(q.amt, AK[q.kind].dec), sats: String(q.amt), id: q.id, usd: q.forUsd, net: Number(q.net6) / 1e6, refund: q.refund, since: Date.now(), avail0: a0.available, wusdc0: a0.walletUsdc, state: 'waiting' });
    ADD.q = null; ADD.typed = '50'; ADD.err = ''; ADD.view = 'pay'; paintAdd(); track();
  }
  /* FETTI: the allowance (exactly the sale, when the wallet has not given it), the sale on the pool, and then the HYPE that came pays
     the way HYPE does: its own order, pressed here, confirmed in the wallet. A run that stops after the sale leaves that HYPE in the
     wallet, and the form on HYPE with it. */
  function fettiGo() { if (!FETTI_PAY) return;
    var q0 = ADD.q, f = fcfg(), c = api.chainId;
    if (!q0 || q0.rail !== 'fetti') return;
    newRun(R => {
      var h0 = null, n = 3, i = 0, still = 'That step did not go through, so your FETTI is still in your wallet. Press again.';
      ADD.busy = 'switch'; paintAdd(); R.arm(60000, NO_ANSWER);
      return timed(toHype(), 30000, NO_ANSWER).then(() => {
        R.check(); ADD.busy = 'check'; paintAdd();
        return Promise.all([ecall(c, f.router, 'getAmountsOut', [q0.dx, [f.tok, f.whype]]), ecall(c, f.tok, 'balanceOf', [R.acct]), ecall(c, f.tok, 'allowance', [R.acct, f.router]), ecall(c, f.pair, 'getReserves'), api.refresh().catch(noop)]);
      }).then(x => {
        R.check();
        var out = BigInt(x[0][0][1]), bal = BigInt(x[1][0]), al = BigInt(x[2][0]), min = out * 99n / 100n;
        setReserves(x[3], f); FT.bal = bal; FT.allow = al; h0 = hypeHave();
        if (bal < q0.dx) throw say('You have ' + ethS(bal) + ' free FETTI. This needs ' + ethS(q0.dx) + '. Try less, or tap Max.');
        if (fettiMove(q0.dx) > f.cap + 0.05) { ADD.q = null; throw say('FETTI’s pool changed, and this would now move its price by more than ' + f.cap + '%. Check the numbers and press again.'); }
        if (out < q0.out * 995n / 1000n) { ADD.q = null; throw say('The price moved a little. Check the new numbers and press again.'); }
        if (h0 == null || h0 < 2000000000000000n) throw say('This needs a little HYPE in your wallet for the network’s own part.');
        n = (al < q0.dx ? 1 : 0) + 2;
        var p = Promise.resolve();
        if (al < q0.dx) p = p.then(() => sendEvm(R, c, { to: f.tok, data: erc().encodeFunctionData('approve', [f.router, q0.dx]) }, { text: 'f-allow', i: ++i, of: n, lead: 'Your wallet asks to allow exactly ', amount: ethS(q0.dx) + ' FETTI', tail: ' to be sold. Nothing is sent by this step.' })).then(hash => mined(R, c, hash, still));
        return p.then(() => sendEvm(R, c, { to: f.router, data: erc().encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens', [q0.dx, min, [f.tok, f.whype], R.acct, ZERO, Math.floor(Date.now() / 1000) + 900]) },      /* the page's own sale, as its swap makes it */
          { text: 'f-sell', i: ++i, of: n, lead: 'Your wallet shows the sale of ', amount: ethS(q0.dx) + ' FETTI', tail: ' for HYPE. Nothing is sold until you confirm.' })).then(hash => mined(R, c, hash, still))
          .then(() => lookAgain(() => { var h1 = hypeHave(); return h1 != null && h1 > h0; }, 6)).then(() => {
            R.check();
            var h1 = hypeHave(), came = h1 != null && h1 > h0 ? h1 - h0 : min, spare = hypeSpare(), use = came < spare ? came : spare, v = Math.floor(hypeUsd(use) * 0.99 * 100) / 100;
            ADD.run = 0; ADD.asking = 0; ADD.wait = null; ADD.busy = ''; clearTimeout(ADD.rtimer);
            ADD.method = 'hype'; ADD.max = false; ADD.q = null; ADD.err = ''; if (v > 0) ADD.typed = String(v);
            ADD.note = 'Your FETTI is now ' + ethS(came) + ' HYPE in your wallet. One more confirmation adds it.'; ADD.auto = v >= MIN_ADD_USD;
            readFetti(); redoAdd();
          });
      });
    }, 'HYPE');
  }
  function copyText(s, b) {
    var done = () => { if (b._was == null) b._was = b.textContent; b.textContent = 'Copied'; clearTimeout(b._t); b._t = setTimeout(() => { b.textContent = b._was; b._was = null; }, 1400); };
    function old() { try { var t = h('textarea'); t.value = s; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done(); } catch (e) { /* the address is on the screen */ } }
    try { navigator.clipboard.writeText(s).then(done, old); } catch (e) { old(); }
  }
  function drawQr(cv, text) {
    var go = () => {
      try {
        var q = window.ConfettiQR.create(text, { errorCorrectionLevel: 'M' }), n = q.modules.size, s = 6, pad = 3, c = cv.getContext('2d');
        cv.width = cv.height = (n + pad * 2) * s; c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height); c.fillStyle = '#000';
        for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (q.modules.get(y, x)) c.fillRect((x + pad) * s, (y + pad) * s, s, s);
      } catch (e) { cv.hidden = true; }
    };
    if (window.ConfettiQR) { go(); return; }
    var sc = document.createElement('script'); sc.src = 'qr.js?v=card1'; sc.async = true; sc.onload = go; sc.onerror = () => { cv.hidden = true; }; document.head.appendChild(sc);
  }
  /* Pay to an address: the amount, the address and its QR code, and the payment followed in place. One black key copies the address. */
  function buildPay() {
    var sh = ADD.sh, r = ADD.R, p = ADD.pend, k = AK[p.kind], box = h('div', 'sm-steps is-tight'), bw = p.kind === 'btc' ? btcWallets() : [];
    txt(sh.title, payTitle(p));
    r.cAmt = btn('sm-copy', 'Copy', () => { copyText(p.amt, r.cAmt); }); r.cAmt.setAttribute('aria-label', 'Copy the amount');
    r.qr = h('canvas', 'sm-qr'); r.qr.setAttribute('role', 'img'); r.qr.setAttribute('aria-label', 'QR code of the address');
    drawQr(r.qr, p.kind === 'btc' ? 'bitcoin:' + p.addr + '?amount=' + p.amt : p.addr);
    r.s = [step(box), step(box), step(box)];
    r.fine = h('p', 'sm-fine', '');
    r.stop = btn('sm-link', 'Cancel: I have not paid', () => { dropPend(); ADD.view = 'form'; paintAdd(); readBalances(); scheduleQuote(0); });
    /* once a payment is seen the record is kept (it is followed until it lands) and the form is one tap away: money already in the
       wallet, ETH, HYPE and every other way stay within reach while this one arrives */
    r.else = btn('sm-link', 'Add money another way', () => { ADD.view = 'form'; ADD.err = ''; paintAdd(); readBalances(); scheduleQuote(0); });
    r.links = h('div', 'sm-links', [r.stop, r.else]);
    if (bw.length) {
      r.wal = btn('sm-link', 'Pay from ' + bw[0].name, () => { r.wal.disabled = true; Promise.resolve().then(() => bw[0].send(p.addr, Number(p.sats))).catch(noop).then(() => { r.wal.disabled = false; track(); }); });
      r.links.insertBefore(r.wal, r.stop);
    } else if (p.kind === 'btc' && api.isPhone()) { r.wal = h('a', 'sm-link', 'Open in a Bitcoin wallet'); r.wal.href = 'bitcoin:' + p.addr + '?amount=' + p.amt; r.links.insertBefore(r.wal, r.stop); }
    add(sh.body, [h('div', 'sm-label', 'Send'), h('div', 'sm-payrow', [h('div', 'sm-big is-mid sm-payamt', [p.amt, h('small', null, ' ' + k.sym)]), r.cAmt]),
      h('div', 'sm-label', 'To this address, on ' + k.name), h('div', 'sm-addr', p.addr), r.qr, box, r.fine, r.links]);
    r.go = btn('sm-btn is-primary', 'Copy address', () => { copyText(p.addr, r.go); });
    add(sh.foot, r.go);
    /* open the pay screen at its top: the amount and its Copy key come first (the form above may have left the body scrolled) */
    sh.body.scrollTop = 0; requestAnimationFrame(() => { sh.body.scrollTop = 0; });
  }
  function fillPay() {
    var r = ADD.R, p = ADD.pend; if (!p || !r.s) return;
    var k = AK[p.kind], seen = !!p.seen, btc = p.kind === 'btc', conf = p.conf || 0, failed = p.state === 'failed';
    var own = btc && !p.refund, back = p.refund ? 'your address …' + p.refund.slice(-4) : k.evm ? 'your wallet ' + short(api.wallet().account) + ' on ' + k.name : 'the wallet that paid';
    setStep(r.s[0], seen ? 'done' : 'now', seen ? 'Payment seen' : 'Waiting for your payment', seen ? 'It is on the ' + k.name + ' network' : own ? 'Pay from a Bitcoin wallet of your own. This page sees it by itself.' : 'Pay from an exchange or any wallet. This page sees it by itself.');
    setStep(r.s[1], seen ? 'now' : 'later', k.name + ' confirms it', failed ? 'This one has not gone through yet. We keep looking.'
      : btc ? (seen && conf >= 1 ? 'Confirmed. Arriving in your wallet…' : seen ? 'Waiting for the next Bitcoin block: usually 10 to 20 minutes' : 'Usually 10 to 20 minutes after you pay')
        : seen ? 'Arriving in your wallet…' : 'Usually ' + k.eta + ' after you pay');
    setStep(r.s[2], 'later', 'About ' + usd(p.net) + ' lands in your wallet ' + short(api.wallet().account), 'Then one tap here adds it to your trading money');
    txt(r.fine, 'Any amount works, now or later: you get what it is worth when it arrives, and a second payment lands in your wallet the same way. A payment too small to send on goes back to ' + back + ', less what sending it back costs.'
      + (own ? ' Do not pay this one from an exchange: a payment from an exchange that cannot be added is not sent back by itself.' : '') + ' You can close this: we’ll show it here when it lands.');
    show(r.stop, !seen); show(r.else, seen); if (r.wal) show(r.wal, !seen);
  }

  /* HYPE pays where the trading is: the page's own move of the wallet onto HyperEVM (said in Simple's words when it stays put) */
  function toHype() {
    return api.toHyperEvm().catch(e => {
      var code = e && (e.code != null ? e.code : e.info && e.info.error && e.info.error.code), m = String((e && (e.shortMessage || e.message)) || '');
      if (e && e.plain != null) throw e;
      if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied)/i.test(m)) throw say('Your wallet stayed where it was, so nothing was sent.');
      throw say(STAYED + 'nothing was sent. Press again and let it change.');
    });
  }
  /* Ask the wallet onto the chain the ETH is on; the person never does it by hand. A chain counts as "not in this wallet" only
     when the wallet says it does not know it (after it was offered the chain), or when it is somewhere else after the switch.
     Anything else is a wallet that did not answer: nothing is concluded from it. */
  function walletTo(c) {
    var w = api.wallet(), eth = w.eth, where = () => eth.request({ method: 'eth_chainId', params: [] }).then(hex => parseInt(hex, 16));
    function refused() { var x = new Error('refused'); x.refusedChain = true; return x; }
    function move() { return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CH[c].hex }] }); }
    return where().then(now => {
      if (now === c) return;
      return move().catch(e => {
        var code = e && e.code, m = String((e && e.message) || '');
        if (code === 4001 || /user (rejected|denied)/i.test(m)) throw say('Your wallet stayed where it was, so nothing was sent.');
        if (code === 4100) throw say((w.name || 'Your wallet') + ' is not letting this page use ' + short(w.account) + '. Open it, pick that account, then press again.');
        if (code !== 4902 && !/unrecognized chain|unknown chain|not been added|does not exist/i.test(m)) throw say(NO_ANSWER);
        return eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CH[c].hex, chainName: CH[c].name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [CH[c].rpc] }] }).then(move).catch(x => {
          if (x && (x.code === 4001 || /user (rejected|denied)/i.test(String(x.message || '')))) throw say('Your wallet stayed where it was, so nothing was sent.');
          throw refused();
        });
      }).then(where).then(now2 => { if (now2 !== c) throw refused(); });
    }).then(() => { api.chainSeen().catch(noop); });      /* the page's own record follows; the press does not wait for its reload */
  }

  /* ---- money on its way: remembered per wallet, followed until it lands or comes back ---- */

  function pendKey(a) { a = a || api.wallet().account; return a ? ADD_KEY + a.toLowerCase() : null; }
  /* the record is filed under the account that paid; it shows on the page only while the page is still on that account */
  function setPend(p, acct) {
    var k = pendKey(acct); if (k) lsSet(k, JSON.stringify(p));
    if (acct && acct !== api.wallet().account) return;
    ADD.pend = p; redo();
  }
  function savePend() { var k = pendKey(); if (k && ADD.pend) lsSet(k, JSON.stringify(ADD.pend)); }
  function dropPend() { var k = pendKey(); if (k) lsDel(k); ADD.pend = null; ADD.fin = null; clearTimeout(ADD.ttimer); clearInterval(ADD.atimer); redo(); }
  function loadPend() {
    var k = pendKey(), p = null;
    clearTimeout(ADD.ttimer); clearInterval(ADD.atimer); ADD.pend = null; ADD.fin = null;
    try { p = k ? JSON.parse(lsGet(k) || 'null') : null; } catch (e) { p = null; }
    /* only a record of a shape this code wrote, and not older than three days; anything else is deleted, never followed */
    var known = p && typeof p === 'object' && typeof p.since === 'number' && (p.rail === 'apple' || (p.rail === 'addr' ? !!AK[p.kind] && typeof p.addr === 'string' && typeof p.amt === 'string'
      : RAILS[p.rail] && (p.rail === 'hype' ? p.chain === api.chainId : p.rail === 'sol' ? p.chain === SOLC.chain : p.rail === 'usdt' ? !!UT[p.chain] : CH[p.chain]) && typeof p.hash === 'string'));
    if (!known || Date.now() - p.since > 3 * 86400000) { if (k && lsGet(k) != null) lsDel(k); return; }
    ADD.pend = p;
    if (p.final) return;
    if (p.state === 'arrived') ADD.fin = finOf(p); else if (p.rail === 'apple') watchApple(); else track();
  }
  function finishPend(state) {
    var p = ADD.pend; if (!p) return;
    clearTimeout(ADD.ttimer);
    if (state === 'finish') { p.state = 'arrived'; p.final = false; ADD.fin = ADD.fin || finOf(p); }     /* made once: a second read never starts a second Finish */
    else { p.state = state; p.final = true; p.at = Date.now(); }
    savePend();
    if (ADD.sh && ADD.sh.isOpen && (ADD.view === 'moving' || ADD.view === 'apple' || ADD.view === 'pay')) ADD.view = state === 'done' ? 'ready' : state === 'finish' ? 'finish' : 'fail';
    redo();
  }
  /* Following an add. The rail's own word ends it: refunded is said first; done ends it as added (at once when the balance
     shows it or the dollars sit in the wallet, else a quarter of a minute later: the rail's word is final). The balance alone
     ends it only when the rail cannot be asked: a balance that rose for another reason is not this add. A rail that says the
     order failed is shown as that, and still followed (a return may come later). Nothing is asked while the tab is hidden. */
  function track() {
    clearTimeout(ADD.ttimer);
    var p = ADD.pend; if (!p || p.final || p.rail === 'apple' || p.state === 'arrived') return;
    if (p.rail === 'addr') { trackAddr(); return; }
    if (document.hidden) return;
    var age = Date.now() - p.since, again = () => { ADD.ttimer = setTimeout(track, age < 60000 ? 2000 : age < 600000 ? 5000 : 15000); };
    var here = p.rail === 'hype' || (p.rail === 'usdt' && p.chain === api.chainId);
    var rcpt = p.sentOk ? Promise.resolve(null) : (p.rail === 'sol' ? solRcpt(p) : rpc(p.chain, 'eth_getTransactionReceipt', [p.hash])).catch(() => null);
    /* a HYPE order is one transaction on HyperEVM that runs whole or not at all: its receipt is the rail's word */
    var word = here ? rcpt.then(rc => p.sentOk || (rc && rc.status === '0x1') ? 'done' : 'sent') : RAILS[p.rail].track(p).catch(() => null);
    Promise.all([rcpt, word, api.refresh().catch(noop)]).then(x => {
      if (ADD.pend !== p || p.final || p.state === 'arrived') return;
      var a = api.account(), st = x[1];
      if (x[0] && x[0].status === '0x0') { p.why = 'origin'; finishPend('refunded'); return; }
      if ((x[0] && x[0].status === '0x1') || (st && st !== 'sent')) p.sentOk = true;
      if (st === 'refunded') { finishPend('refunded'); return; }
      var landed = a.loaded && a.available >= p.avail0 + p.net - 0.02;
      if (st === 'done') {
        p.doneAt = p.doneAt || Date.now();
        if (landed) { finishPend('done'); return; }
        if (a.walletUsdc >= p.wusdc0 + p.net * 0.98) { finishPend('finish'); return; }  /* the deposit step did not run: the dollars sit in the wallet */
        if (Date.now() - p.doneAt > 15000) { finishPend('done'); return; }
      } else if (st == null && landed) { finishPend('done'); return; }
      p.state = st === 'failed' ? 'failed' : st === 'done' || st === 'moving' || p.sentOk ? 'moving' : 'sent';
      savePend(); kick(); again();
    });
  }
  function watchApple() {
    clearInterval(ADD.atimer);
    ADD.atimer = setInterval(() => {
      var p = ADD.pend; if (!p || p.rail !== 'apple' || p.state !== 'waiting') { clearInterval(ADD.atimer); return; }
      if (document.hidden) return;
      api.refresh().catch(noop).then(() => {
        var a = api.account();
        if (ADD.pend !== p || a.hypeWei == null) return;
        if (BigInt(a.hypeWei) > BigInt(p.hype0) + 10000000000000000n) {  /* the purchase landed in the wallet */
          p.state = 'arrived'; savePend(); ADD.fin = ADD.fin || finOf(p); clearInterval(ADD.atimer);
          if (ADD.sh && ADD.sh.isOpen && ADD.view === 'apple') ADD.view = 'finish';
          redo();
        }
      });
    }, 8000);
  }
  function fillPend(p, card) {
    var c = card || R.pend, final = p.final, apple = p.rail === 'apple', failed = p.state === 'failed';
    cls(c.icon, final ? 'sm-pill ' + (p.state === 'done' ? 'is-up' : 'is-dn') : p.state === 'arrived' ? 'sm-pill is-up' : failed ? 'sm-pill is-dn' : 'sm-spin');
    txt(c.icon, final ? (p.state === 'done' ? '✓' : '×') : p.state === 'arrived' ? '✓' : failed ? '×' : '');
    txt(c.b, final ? (p.state === 'done' ? usd(p.net) + ' added' : 'Adding ' + usdS(p.usd) + ' did not go through') : p.state === 'arrived' ? 'Your money arrived' : failed ? 'Adding ' + usdS(p.usd) + ' did not go through' : 'Adding ' + usdS(p.usd));
    txt(c.i, final ? (p.state === 'done' ? 'Ready to trade.' : 'Tap to see what happened.') : p.state === 'arrived' ? 'One more step. Tap to finish.' : failed ? 'Tap to see what is known.' : apple ? 'Waiting for your Apple Pay purchase' : p.rail === 'addr' ? (p.seen ? 'Payment seen. Arriving in your wallet…' : 'Waiting for your payment. Tap for the address.') : p.state === 'sent' && !p.sentOk ? 'Leaving your wallet…' : Date.now() - p.since > 90000 ? (p.rail === 'debridge' ? 'Taking longer than usual.' : 'Taking longer than usual. Your money is safe.') : 'Arriving on confetti…');
  }
  function step(n) { var s = { n: h('div', 'sm-st'), m: h('span', 'sm-m', '✓'), b: h('b'), i: h('i') }; add(s.n, [s.m, h('span', null, [s.b, s.i])]); n.appendChild(s.n); return s; }
  function setStep(s, state, b, i) { cls(s.n, 'sm-st is-' + state); txt(s.b, b); txt(s.i, i); txt(s.m, state === 'bad' ? '×' : '✓'); }
  function otherWays() { ADD.sh.close(); setTimeout(() => { timed(api.toHyperEvm(), 30000, '').then(() => { api.pro('addUsdc'); }, () => { snack(STAYED + 'nothing happened. Try again.'); }); }, 220); }
  function buildMoving() {
    var sh = ADD.sh, r = ADD.R, box = h('div', 'sm-steps'), toForm = () => { dropPend(); ADD.view = 'form'; paintAdd(); readBalances(); scheduleQuote(0); };
    txt(sh.title, 'On its way');
    r.label = h('div', 'sm-label', ''); r.s = [step(box), step(box), step(box)];
    r.fine = h('p', 'sm-fine', '');
    r.hop = h('p', 'sm-fine', 'Your wallet may ask to change network now. Say yes: that is where you trade.');
    /* the quiet ways on: shown only when there is a reason (see fillMoving) */
    r.where = h('a', 'sm-link', 'See this order'); r.where.target = '_blank'; r.where.rel = 'noopener';
    r.stop = btn('sm-link', 'Stop following this', toForm);
    r.again = btn('sm-link', 'Start again', toForm);
    r.other = btn('sm-link', 'Other ways to add', otherWays);
    r.drop = btn('sm-link', 'I did not buy anything', () => { dropPend(); ADD.view = 'form'; paintAdd(); scheduleQuote(0); });
    add(sh.body, [r.label, box, r.fine, r.hop, h('div', 'sm-links', [r.where, r.stop, r.again, r.other, r.drop])]);
    r.go = btn('sm-btn is-primary is-busy', 'Moving your money…'); r.go.disabled = true;
    add(sh.foot, r.go);
  }
  function fillMoving() {
    var r = ADD.R, p = ADD.pend; if (!p) return;
    var apple = p.rail === 'apple';
    txt(r.label, 'Adding ' + usdS(p.usd));
    show(r.drop, apple); show(r.hop, !apple && api.wallet().chainId !== api.chainId);
    if (apple) {
      setStep(r.s[0], 'now', 'Pay in the MoonPay tab', 'Apple Pay, in the tab that just opened');
      setStep(r.s[1], 'later', 'Arriving in your wallet', 'A few minutes after you pay');
      setStep(r.s[2], 'later', 'Ready to trade', 'One tap here finishes it');
      txt(r.fine, 'You can close this. We’ll show it here when it lands.'); txt(r.go, 'Waiting for your purchase…');
      show(r.where, false); show(r.stop, false); show(r.again, false); show(r.other, false); return;
    }
    var hy = p.rail === 'hype' || p.chain === api.chainId, coin = p.coin || (hy ? 'HYPE' : 'ETH'), name = hy ? '' : placeOf(p), age = Date.now() - p.since, slow = age > 90000, second = p.rail === 'debridge', failed = p.state === 'failed';
    var lost = !p.sentOk && age > 180000;            /* three minutes and the payment itself has not shown up on its chain */
    /* HYPE pays from where the trading is: its steps name the wallet, not a network */
    if (hy) setStep(r.s[0], p.sentOk ? 'done' : 'now', p.sentOk ? 'Sent from your wallet' : 'Leaving your wallet', lost ? 'The payment has not shown up yet. If your wallet no longer lists it, nothing left.' : p.pay + '\u00a0' + coin);
    else setStep(r.s[0], p.sentOk ? 'done' : 'now', p.sentOk ? 'Sent from ' + name : 'Leaving ' + name,
      lost ? 'The payment has not shown up on ' + name + '. If your wallet no longer lists it, nothing left.' : p.pay + ' ' + coin + ' ' + (p.sentOk ? 'left your wallet' : 'is leaving your wallet'));
    setStep(r.s[1], p.sentOk ? 'now' : 'later', 'Arriving on confetti',
      failed ? 'This one did not go through, and we cannot see yet where it stands.'
        : slow && p.sentOk ? (second ? 'Taking longer than usual. It has not arrived yet.' : 'Taking longer than usual. Your money is safe: it arrives, or it goes back to your wallet.') : hy ? 'Usually a few seconds' : 'Usually under a minute');
    setStep(r.s[2], 'later', 'Ready to trade', usd(p.net));
    txt(r.fine, failed ? 'What is known: order ' + short(p.id || '') + ', payment ' + short(p.hash) + (hy ? '' : ' on ' + name) + '. We keep looking.' : 'You can close this. We’ll show it here when it lands.');
    var link = second && p.id && (slow || failed) ? 'https://app.debridge.finance/order?orderId=' + p.id : '';
    show(r.where, !!link); if (link) r.where.href = link;
    show(r.again, lost); show(r.other, lost); show(r.stop, !lost && (failed || age > 600000));
    txt(r.go, failed ? 'Looking for it…' : lost ? 'Waiting for the payment…' : 'Moving your money…');      /* the status line never claims more than is known */
  }
  function buildReady() {
    var sh = ADD.sh, r = ADD.R, a = api.account();
    txt(sh.title, 'Added');
    r.bal = h('div', 'sm-big', '');
    add(sh.body, [h('div', 'sm-ok', '✓'), h('div', 'sm-label', 'Your trading money'), r.bal, h('p', 'sm-now', 'NOW PICK A COIN TO TRADE')]);
    add(sh.foot, [btn('sm-btn is-primary', 'Pick a coin', toCoins),
      btn('sm-btn is-ghost', 'Add more', () => { clearTimeout(ADD.ctimer); if (ADD.pend) dropPend(); ADD.view = 'form'; paintAdd(); scheduleQuote(0); })]);
    /* then it goes to the list of coins by itself (owner, 11/11), unless "Add more" was pressed first */
    clearTimeout(ADD.ctimer); ADD.ctimer = setTimeout(() => { if (ADD.sh.isOpen && ADD.view === 'ready') toCoins(); }, 2600);
  }
  /* close the sheet and land on the coin list: from a coin page back to Home first, then the list scrolled into view */
  function toCoins() {
    clearTimeout(ADD.ctimer); if (ADD.pend) dropPend();
    if (ADD.sh && ADD.sh.isOpen) ADD.sh.close();
    var fromCoin = S.place !== 'home';
    setTimeout(() => {
      if (fromCoin && S.place !== 'home' && !sheets.length) back();
      setTimeout(() => { var c = el.main.querySelector('#smCoins'); if (c && S.place === 'home') c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 120);
    }, fromCoin ? 60 : 0);
  }
  function fillReady() { txt(ADD.R.bal, usd(api.account().available)); }
  function buildFail() {
    var sh = ADD.sh, p = ADD.pend || {}, name = placeOf(p), coin = p.coin || 'ETH', second = p.rail === 'debridge' && p.why !== 'origin', link = null;
    txt(sh.title, 'Not added');
    if (second && p.id) { link = h('a', 'sm-link', 'See this order'); link.href = 'https://app.debridge.finance/order?orderId=' + p.id; link.target = '_blank'; link.rel = 'noopener'; }
    add(sh.body, [h('div', 'sm-ok is-loss', '×'), h('div', 'sm-label', 'Adding ' + usdS(p.usd)), h('div', 'sm-big is-mid', 'It didn’t go through'),
      h('p', 'sm-mid', p.rail === 'addr' ? 'Your payment is on its way back to ' + (p.refund ? 'your address …' + p.refund.slice(-4) : (AK[p.kind] || {}).evm ? 'your wallet on ' + AK[p.kind].name : 'the wallet that paid') + ', less what the network took. Nothing was added.' + (p.kind === 'btc' && !p.refund ? ' A payment made from an exchange is not sent back by itself: Relay, the service that carries it, returns it through its support.' : '')
        : p.rail === 'usdt' && p.chain === api.chainId ? 'The payment did not go through, so your USDT is still in your wallet. Only the little the network took is gone.'
        : p.rail === 'hype' ? 'The payment did not go through, so your HYPE is still in your wallet. Only the little the network took is gone.'
        : p.why === 'origin' ? 'The payment did not go through on ' + name + ', so nothing left your wallet except the little the network took.'
        : second ? 'The order was cancelled and nothing was added. What it held does not come back by itself: it is claimed back, as dollars on ' + name + ', from the order’s own page.'
        : 'Your ' + coin + ' is on its way back to your wallet on ' + name + ', less what the network took. Nothing was added.'), link]);
    add(sh.foot, [btn('sm-btn is-primary', 'Try again', () => { dropPend(); ADD.view = 'form'; paintAdd(); readBalances(); scheduleQuote(0); }), btn('sm-btn is-ghost', 'Close', () => { ADD.sh.close(); })]);
  }

  /* Finish: what arrived in the wallet goes the rest of the way, each wallet step counted in place. The steps are the Pro
     sheet's own: its one-tap conversion, then its deposit (which allows the amount first when needed). It moves only what
     arrived, never everything in the wallet: the order's dollars for a rail order; for Apple Pay the coin that came (what the
     wallet holds now less what it held before) and then the dollars that conversion made. Pressed again after a stop, it
     moves only what is still missing. */
  function finishPlan() {
    var a = api.account(), f = ADD.fin, have = a.hypeWei != null ? BigInt(a.hypeWei) : 0n, spare = have > api.swapKeepWei ? have - api.swapKeepWei : 0n;
    if (f.hype0 != null) { var came = have > BigInt(f.hype0) ? have - BigInt(f.hype0) : 0n; if (came < spare) spare = came; }
    var conv = !!f.hype && !f.swapped && a.hypeUsd > 0 && Number(spare) / 1e18 * a.hypeUsd >= 1;
    var cap = f.cap != null ? f.cap : 0, gone = f.w0 != null ? Math.max(0, f.w0 - a.walletUsdc) : 0;
    var amt = cents(Math.max(0, Math.min(cap - gone, a.walletUsdc))), allow = conv || !(a.allowance + 1e-9 >= amt);
    return { conv: conv, spare: spare, amt: amt, cap: cap, gone: gone, n: (conv ? 1 : 0) + (allow ? 1 : 0) + 1, worth: conv ? Number(spare) / 1e18 * a.hypeUsd : amt };
  }
  function buildFinish() {
    var sh = ADD.sh, r = ADD.R;
    txt(sh.title, 'Almost there');
    r.big = h('div', 'sm-big is-mid', ''); r.mid = h('p', 'sm-mid', '');
    add(sh.body, [h('div', 'sm-label', 'In your wallet'), r.big, r.mid]);
    r.say = sayLine();
    r.go = btn('sm-btn is-primary', 'Finish', finishGo);
    /* a way back to the form: the arrival keeps its card on Home and is offered again there */
    r.later = btn('sm-link', 'Not now', () => { var f = ADD.fin; if (f && f.busy) return; ADD.fin = null; ADD.view = 'form'; paintAdd(); readBalances(); scheduleQuote(0); }); r.later.style.justifyContent = 'center';
    add(sh.foot, [r.say, r.go, r.later]);
  }
  function fillFinish() {
    var r = ADD.R, f = ADD.fin; if (!f) return;
    var a = api.account(), pl = finishPlan(), n = f.n || pl.n, i = f.busy ? (f.dep ? (f.base || 0) + (a.dep === 'deposit' && a.depTwo ? 2 : 1) : f.i || 1) : 0;
    if (i > n) n = i;
    /* "about" until the conversion has landed; after it, the dollars it really made */
    var est = f.busy ? !!f.conv : pl.conv;
    txt(r.big, (est ? 'about ' : '') + usd(est ? (f.busy && f.worth ? f.worth : pl.worth) : f.busy && f.moving ? f.moving : pl.amt));
    txt(r.mid, (f.busy ? 'Keep this open.' : 'One press puts it in your trading money.') + ' Your wallet asks ' + (n === 1 ? 'once' : n + ' times, one after the other') + '.');
    txt(r.say, f.err || ''); cls(r.say, 'sm-say' + (f.err ? ' is-bad' : ''));
    txt(r.go, f.busy ? i + ' of ' + n + ' · Confirm in your wallet…' : 'Finish'); cls(r.go, 'sm-btn is-primary' + (f.busy ? ' is-busy' : '')); r.go.disabled = !!f.busy;
    show(r.later, !f.busy);
  }
  /* look again a few times before concluding: a deposit that went in can be read late */
  function lookAgain(test, n) {
    return api.refresh().catch(noop).then(() => test() ? true : n > 1 ? new Promise(go => { setTimeout(go, 1500); }).then(() => lookAgain(test, n - 1)) : false);
  }
  function finishGo() {
    var f = ADD.fin; if (!f || f.busy || early()) return;
    if (api.gate()) { f.err = OFF; if (ADD.sh.isOpen) paintAdd(); return; }
    var a0 = api.account();
    if (f.w0 == null) f.w0 = a0.walletUsdc;          /* the wallet's dollars when Finish first ran: what has left since is not moved again */
    var pl = finishPlan();
    f.busy = true; f.err = ''; f.i = 1; f.n = pl.n; f.worth = pl.worth; f.conv = pl.conv; f.moving = pl.amt; f.dep = false; S.claim = true; paintAdd();
    timed(api.toHyperEvm(), 30000, STAYED + 'nothing moved. Press Finish and let it change.').then(() => {
      if (!pl.conv) return;
      var u0 = api.account().walletUsdc;
      return api.swapHype(pl.spare).then(() => api.refresh().catch(noop), () => { throw say('The first step did not go through. Press Finish to try again.'); }).then(() => {
        var made = cents(api.account().walletUsdc - u0);
        f.swapped = true; f.conv = false; f.cap = made > 0 ? made : 0; f.w0 = api.account().walletUsdc; f.moving = f.cap;
        if (ADD.pend && ADD.pend.rail === 'apple') { ADD.pend.swapped = true; ADD.pend.usdc = f.cap; savePend(); }
      });
    }).then(() => {
      var p2 = finishPlan(), a = api.account(), before = a.available, wBefore = a.walletUsdc, amt = p2.amt;
      if (!(amt > 0)) {
        if (p2.cap > 0 && p2.gone >= p2.cap - 0.01) { ADD.added = { net: p2.cap }; return; }      /* it had gone in already: the earlier read was late */
        throw say('Nothing has arrived in your wallet yet. Give it a minute, then press Finish again.');
      }
      f.base = pl.conv ? 1 : 0; f.dep = true; f.moving = amt; S.lastErr = null; paintAdd();
      return Promise.resolve(api.deposit(amt)).then(ok => {
        f.dep = false;
        var went = () => { var x = api.account(); return x.available >= before + amt - 0.01 || x.walletUsdc <= wBefore - amt + 0.01; };
        return ok ? api.refresh().catch(noop).then(() => true) : lookAgain(went, 6);
      }).then(ok => {
        if (!ok) throw say('It stopped before the last step. Press Finish to go on.');
        ADD.added = { net: cents(Math.min(p2.cap, p2.gone + amt)) };
      });
    }).then(() => {
      S.claim = false; ADD.fin = null;
      if (ADD.pend) { ADD.pend.net = ADD.added.net; ADD.pend.state = 'done'; ADD.pend.final = true; ADD.pend.at = Date.now(); savePend(); }
      ADD.view = 'ready'; S.sig = ''; if (ADD.sh.isOpen) paintAdd(); kick();
    }, e => {
      S.claim = false; f.busy = false; f.dep = false;
      f.err = errText(e);
      if (ADD.sh.isOpen) paintAdd(); kick();
    });
  }

  /* ---- the coin: price, today's move, the chart and its ranges, Up and Down. With trades open on it (or going in) the page
     stays the same trading view: each trade is drawn on the chart the way Pro draws it (where it opened, where it closes
     itself, its take profit and stop loss) and has its own card under the chart, with its own Close, take profit and stop loss. Up and Down stay,
     for another trade on the coin. Every trade action is the Pro code's (api.open, api.close) ---- */

  var COIN = { tf: '1H', mode: 'candles', errs: {}, closing: null, part: 0 };      /* part: the share (bps) of the close on its way from here, 0 for a whole one */
  var CHART_TF = ['1m', '5m', '15m', '1H', '4H', '1D'];
  /* The LightweightCharts chart for Simple: one instance shared between phone and desktop, destroyed on
     navigation away from a coin. The chart seam in trade.js loads candles and exposes Pro's theme. */
  var smChart = { api: null, series: null, host: null, coin: null, candles: [], byTime: {}, precision: 4, lines: [], lineSig: '', keep: [], meta: [], drag: null, tap: null };
  function smChartTheme() {
    var t = api.chart.theme();
    return {
      background: { type: 'solid', color: t.page },
      textColor: t.ink,
      fontFamily: t.mono,
      fontSize: isDesktop() ? 11 : 12
    };
  }
  function smChartOptions() {
    var t = api.chart.theme();
    var LW = window.LightweightCharts;
    return {
      autoSize: true,
      layout: smChartTheme(),
      grid: { vertLines: { color: t.rule, style: 1 }, horzLines: { color: t.rule, style: 1 } },
      rightPriceScale: { borderColor: t.ruleStrong, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: t.ruleStrong, timeVisible: true, secondsVisible: COIN.tf === '1m', rightOffset: 3, barSpacing: 7 },
      handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      crosshair: {
        mode: LW && LW.CrosshairMode ? LW.CrosshairMode.Normal : 0,
        vertLine: { color: t.faint, labelBackgroundColor: t.ink, style: 1 },
        horzLine: { color: t.faint, labelBackgroundColor: t.ink, style: 1 }
      },
      localization: { priceFormatter: function (p) { return Number(p).toFixed(smChart.precision); } }
    };
  }
  function smSeriesOptions() {
    var t = api.chart.theme();
    return {
      upColor: t.pos, downColor: t.neg,
      borderUpColor: t.pos, borderDownColor: t.neg,
      wickUpColor: t.pos, wickDownColor: t.neg,
      priceLineColor: t.ink,
      priceFormat: { type: 'price', precision: smChart.precision, minMove: Math.pow(10, -smChart.precision) },
      autoscaleInfoProvider: smAutoscale
    };
  }
  function smLineOptions() {
    var t = api.chart.theme();
    return {
      color: t.pos, lineWidth: 2, crosshairMarkerVisible: true,
      priceLineVisible: false, lastValueVisible: true,
      priceFormat: { type: 'price', precision: smChart.precision, minMove: Math.pow(10, -smChart.precision) },
      autoscaleInfoProvider: smAutoscale
    };
  }
  /* the trades' own prices (where it opened, its take profit and stop loss) that sit near the candles, within one candle range
     of them, are taken into the chart's range, so a level set near the price is never just off the edge; one further away
     leaves the candles as they are */
  function smAutoscale(original) {
    var res = original(), r = res && res.priceRange;
    if (!r || !(r.maxValue > r.minValue)) return res;
    var lo = r.minValue, hi = r.maxValue, span = hi - lo;
    (smChart.keep || []).forEach(function (px) { if (px > 0 && px >= r.minValue - span && px <= r.maxValue + span) { lo = Math.min(lo, px); hi = Math.max(hi, px); } });
    return lo === r.minValue && hi === r.maxValue ? res : { priceRange: { minValue: lo, maxValue: hi }, margins: res.margins };
  }
  function smBarTime(t) { return api.chart.barTime(t); }
  function smToBar(k) { return { time: smBarTime(k.t), open: k.o, high: k.h, low: k.l, close: k.c }; }
  function smToLinePoint(k) { return { time: smBarTime(k.t), value: k.c }; }
  /* ---- hover P&L: shows position P&L at the crosshair price ---- */
  function onSmCrosshair(param) {
    if (!param || !param.point || !smChart.series) { hideSmHoverPnl(); return; }
    var ps = api.positions().filter(function (x) { return x.sym === S.sym; });
    if (!ps.length) { hideSmHoverPnl(); return; }
    var px = smChart.series.coordinateToPrice(param.point.y);
    if (px == null || !(px > 0)) { hideSmHoverPnl(); return; }
    renderSmHoverPnl(ps, Number(px), param.point);
  }
  function hoverPnlAt(p, px) {
    /* (amt2) the trade read at that price by the page's own close maths (api.worthAt, the Pro chart's hover): what a close
       there gives back, and that against what went in; nothing back at or past the price where it closes itself. This
       worked size x move itself before, which no close pays: a win read a sixth too high and more. */
    var r = api.worthAt ? api.worthAt(p.id, px) : null;
    return r && isFinite(r.pnl) && isFinite(r.worth) ? { pnl: r.pnl, worth: r.worth, busted: !!r.busted } : null;
  }
  function renderSmHoverPnl(ps, px, point) {
    var box = getSmHoverBox();
    if (!box) return;
    var rs = ps.map(function (p) { return hoverPnlAt(p, px); });
    if (rs.some(function (r) { return !r; })) { hideSmHoverPnl(); return; }      /* no figure rather than a wrong one */
    box.textContent = '';
    var totalPnl = 0, totalWorth = 0, totalMargin = 0;
    ps.forEach(function (p, i) {
      var r = rs[i];
      totalPnl += r.pnl; totalWorth += r.worth; totalMargin += p.margin;
    });
    var pxText = price(px, ps[0].sz);
    if (ps.length === 1) {
      var p = ps[0], r = rs[0], pnlPct = p.margin > 0 ? r.pnl / p.margin : 0;
      add(box, h('span', null, (p.isLong ? 'Up' : 'Down') + ' at ' + pxText));
      add(box, h('b', r.pnl >= 0 ? 'sm-up' : 'sm-dn', usdP(r.pnl) + ' (' + pct(pnlPct) + ')'));
      add(box, h('span', null, r.busted ? 'Closes itself here' : 'Worth ' + usd(r.worth)));
    } else {
      add(box, h('span', null, ps.length + ' trades at ' + pxText));
      var tpct = totalMargin > 0 ? totalPnl / totalMargin : 0;
      add(box, h('b', totalPnl >= 0 ? 'sm-up' : 'sm-dn', 'Total ' + usdP(totalPnl) + ' (' + pct(tpct) + ')'));
      add(box, h('span', null, 'Worth ' + usd(totalWorth)));
    }
    box.classList.remove('is-hidden');
    /* position the box near the cursor */
    var host = smChart.host ? smChart.host.parentElement : null;
    if (!host) return;
    var w = box.offsetWidth, hh = box.offsetHeight, W = host.clientWidth, H = host.clientHeight;
    var x = point.x + 12, y = point.y - hh - 8;
    if (x + w > W - 8) x = point.x - w - 12;
    if (x < 8) x = 8;
    if (y < 6) y = point.y + 12;
    if (y + hh > H - 6) y = H - hh - 6;
    box.style.left = Math.round(x) + 'px';
    box.style.top = Math.round(y) + 'px';
  }
  function getSmHoverBox() {
    var host = smChart.host ? smChart.host.parentElement : null;
    if (!host) return null;
    var box = host.querySelector('.sm-hover');
    if (!box) {
      box = h('div', 'sm-hover is-hidden');
      host.appendChild(box);
    }
    return box;
  }
  function hideSmHoverPnl() {
    var box = smChart.host ? smChart.host.parentElement && smChart.host.parentElement.querySelector('.sm-hover') : null;
    if (box && !box.classList.contains('is-hidden')) box.classList.add('is-hidden');
  }
  function initSmChart(host, coin, sz) {
    if (!window.LightweightCharts || !host) return;
    destroySmChart();
    smChart.host = host;
    smChart.coin = coin;
    smChart.api = window.LightweightCharts.createChart(host, smChartOptions());
    if (COIN.mode === 'candles') {
      smChart.series = smChart.api.addCandlestickSeries(smSeriesOptions());
    } else {
      smChart.series = smChart.api.addLineSeries(smLineOptions());
    }
    /* subscribe to crosshair moves for hover P&L */
    smChart.api.subscribeCrosshairMove(onSmCrosshair);
    if (!host._smLines) { host._smLines = true; smLinesInit(host); }      /* the take profit / stop loss lines: tap, drag */
    loadSmCandles(coin);
  }
  function destroySmChart() {
    if (smChart.api) { try { smChart.api.remove(); } catch (e) { /* already gone */ } }
    smChart.api = null; smChart.series = null; smChart.host = null; smChart.coin = null;
    smChart.candles = []; smChart.byTime = {}; smChart.lines = []; smChart.lineSig = ''; smChart.keep = []; smChart.meta = []; smChart.drag = null; smChart.tap = null;
  }
  function loadSmCandles(coin) {
    if (!smChart.api || !coin) return;
    var tf = COIN.tf.toLowerCase();
    api.chart.loadCandles(coin, tf).then(function (r) {
      if (smChart.coin !== coin) return;
      smChart.candles = r.candles;
      smChart.precision = r.precision;
      smChart.byTime = {};
      r.candles.forEach(function (k, i) { smChart.byTime[smBarTime(k.t)] = i; });
      if (smChart.series) {
        smChart.series.applyOptions(COIN.mode === 'candles' ? smSeriesOptions() : smLineOptions());
        if (COIN.mode === 'candles') {
          smChart.series.setData(r.candles.map(smToBar));
        } else {
          smChart.series.setData(r.candles.map(smToLinePoint));
        }
      }
      smChart.api.applyOptions({ timeScale: { secondsVisible: tf === '1m' } });
      smChart.api.timeScale().scrollToRealTime();
      syncSmPriceLines();
    }).catch(function () {
      /* candles unavailable */
    });
  }
  function updateSmChartFromPrice(px) {
    if (!smChart.series || !smChart.candles.length || !(px > 0)) return;
    var tf = COIN.tf.toLowerCase();
    var ms = api.chart.TF_MS[tf];
    if (!ms) return;
    var bucket = Math.floor(Date.now() / ms) * ms;
    var last = smChart.candles[smChart.candles.length - 1];
    if (bucket > last.t) {
      var bar = { t: bucket, o: last.c, h: Math.max(last.c, px), l: Math.min(last.c, px), c: px, v: 0 };
      smChart.candles.push(bar);
      if (smChart.candles.length > api.chart.CANDLE_COUNT) smChart.candles.shift();
      smChart.byTime = {};
      smChart.candles.forEach(function (k, i) { smChart.byTime[smBarTime(k.t)] = i; });
      smChart.series.update(COIN.mode === 'candles' ? smToBar(bar) : smToLinePoint(bar));
    } else {
      last.c = px;
      if (px > last.h) last.h = px;
      if (px < last.l) last.l = px;
      smChart.series.update(COIN.mode === 'candles' ? smToBar(last) : smToLinePoint(last));
    }
  }
  function setSmChartMode(mode) {
    if (mode === COIN.mode || !smChart.api) return;
    COIN.mode = mode;
    if (smChart.series) { try { smChart.api.removeSeries(smChart.series); } catch (e) { /* ok */ } }
    if (mode === 'candles') {
      smChart.series = smChart.api.addCandlestickSeries(smSeriesOptions());
      smChart.series.setData(smChart.candles.map(smToBar));
    } else {
      smChart.series = smChart.api.addLineSeries(smLineOptions());
      smChart.series.setData(smChart.candles.map(smToLinePoint));
    }
    syncSmPriceLines();
  }
  function setSmChartTf(tf) {
    if (tf === COIN.tf || !smChart.coin) return;
    COIN.tf = tf;
    loadSmCandles(smChart.coin);
  }
  /* Price lines for open positions: "You opened at" and "Closes itself at" (liquidation), plus TP/SL when set */
  function syncSmPriceLines() {
    if (!smChart.series) return;
    var t = api.chart.theme();
    /* (cf_FILLFEEL) an order on its way has its lines too, as the trade it becomes (its levels' lines are not to be moved yet) */
    var ps = ffLooks(api.wallet().account ? ffOrders() : [], S.sym).concat(api.positions().filter(function (x) { return x.sym === S.sym; }));
    var lines = [];
    ps.forEach(function (p) {
      if (p.entry > 0) lines.push({ px: p.entry, title: 'You opened at', color: t.ink, style: 2 });
      if (p.endPx > 0) lines.push({ px: p.endPx, title: 'Closes itself at', color: t.accent, style: 0 });
      if (p.auto && p.auto.tp != null) lines.push({ px: p.auto.tp, title: 'Take profit', color: t.pos, style: 2, pid: p.id, kind: p.ff ? '' : 'tp' });
      if (p.auto && p.auto.sl != null) lines.push({ px: p.auto.sl, title: 'Stop loss', color: t.neg, style: 2, pid: p.id, kind: p.ff ? '' : 'sl' });
    });
    var sig = lines.map(function (l) { return l.px + ':' + l.title; }).join('|');
    if (sig === smChart.lineSig || smChart.drag) return;      /* a line being dragged stays where the pointer has it */
    smChart.lineSig = sig;
    /* near the candles: inside the chart's range (smAutoscale). Where it closes itself stays as it always was, a line that shows
       when the candles reach it (taking it in would squeeze them on every high boost) */
    smChart.keep = lines.filter(function (l) { return l.title !== 'Closes itself at'; }).map(function (l) { return l.px; });
    /* remove old lines */
    smChart.lines.forEach(function (line) { try { smChart.series.removePriceLine(line); } catch (e) { /* ok */ } });
    smChart.lines = []; smChart.meta = [];
    /* add new lines */
    lines.forEach(function (l) {
      var line = smChart.series.createPriceLine({
        price: l.px, color: l.color, lineWidth: 1, lineStyle: l.style,
        axisLabelVisible: true, title: l.title
      });
      smChart.lines.push(line);
      if (l.kind) smChart.meta.push({ line: line, pid: l.pid, kind: l.kind, px: l.px, title: l.title });
    });
  }
  /* (v6) the trade's own Take profit and Stop loss lines: a tap on one opens the trade's sheet; on a desktop one can be
     dragged, and the new level goes on release through the sheet's own path (api.autoSet: the same checks; on chain or in
     this browser, as the trade's levels live). Where it opened and where it closes itself stay put. */
  var LINE_HIT_PX = 10;
  function smLineAt(y) {
    var best = null, bd = LINE_HIT_PX + 1;
    (smChart.meta || []).forEach(function (m) {
      var c = smChart.series ? smChart.series.priceToCoordinate(m.px) : null;
      if (c == null) return;
      var d = Math.abs(c - y);
      if (d < bd) { bd = d; best = m; }
    });
    return best;
  }
  function smPointY(ev) { var r = smChart.host.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
  function smLinesInit(host) {
    host.addEventListener('pointerdown', ev => {
      if (!smChart.series || ev.button > 0) return;
      var pt = smPointY(ev), m = smLineAt(pt.y);
      if (!m) return;
      if (isDesktop() && ev.pointerType === 'mouse') {
        /* a drag: the chart does not pan or zoom under it */
        ev.preventDefault(); ev.stopPropagation();
        smChart.drag = { m: m, y0: pt.y, moved: false, px: m.px };
        try { smChart.api.applyOptions({ handleScroll: false, handleScale: false }); } catch (e) { /* ok */ }
        try { host.setPointerCapture(ev.pointerId); } catch (e) { /* ok */ }
      } else smChart.tap = { m: m, x: pt.x, y: pt.y, at: Date.now() };
    }, true);
    host.addEventListener('pointermove', ev => {
      if (!smChart.series) return;
      var pt = smPointY(ev), d = smChart.drag;
      if (!d) { if (isDesktop() && ev.pointerType === 'mouse') host.style.cursor = smLineAt(pt.y) ? 'ns-resize' : ''; return; }
      ev.preventDefault(); ev.stopPropagation();
      if (!d.moved && Math.abs(pt.y - d.y0) < 3) return;
      var px = smChart.series.coordinateToPrice(pt.y);
      if (!(px > 0)) return;
      d.moved = true; d.px = Number(px.toFixed(Math.max(0, smChart.precision)));
      var dx = autoOf(d.m.pid);
      try { d.m.line.applyOptions({ price: d.px, title: d.m.title + ' ' + price(d.px, dx ? dx.sz : null) }); } catch (e) { /* ok */ }
    }, true);
    var end = ev => {
      var d = smChart.drag, t = smChart.tap;
      smChart.tap = null;
      if (d) {
        ev.preventDefault(); ev.stopPropagation();
        smChart.drag = null;
        try { smChart.api.applyOptions({ handleScroll: smChartOptions().handleScroll, handleScale: smChartOptions().handleScale }); } catch (e) { /* ok */ }
        if (!d.moved) { openAuto(d.m.pid); return; }
        var x = autoOf(d.m.pid), a = (x && x.auto) || {};
        var tp = d.m.kind === 'tp' ? d.px : (a.tp != null ? a.tp : null), sl = d.m.kind === 'sl' ? d.px : (a.sl != null ? a.sl : null);
        var w = x && !x.status && !early() ? api.autoSet(d.m.pid, tp, sl) : 'This trade is closing.';
        if (w) snack(autoWhy(w));
        smChart.lineSig = '';      /* the lines come back to what the trade holds (the new level once it is in) */
        syncSmPriceLines(); kick();
        return;
      }
      if (t && ev.type === 'pointerup') {
        var pt = smPointY(ev);
        if (Math.abs(pt.x - t.x) < 8 && Math.abs(pt.y - t.y) < 8 && Date.now() - t.at < 600) openAuto(t.m.pid);
      }
    };
    host.addEventListener('pointerup', end, true);
    host.addEventListener('pointercancel', end, true);
  }
  function market(sym) { return api.markets().filter(m => m.sym === sym)[0] || null; }
  /* (cf_LIQ) Room before a trade closes itself: one line and a slim bar under the P&L, live on every price tick. The figure is how
     far the price now is from the closing price (api.positions().away, a share of the price now); the bar is how much of the
     full move to it is left (share: full while the trade is ahead), and both take the Pro cards' colours (near: amber under
     half, red under a fifth). A late price shows a dash and an empty bar, never an old figure. Read-only: nothing to press. */
  function roomFig(a) {
    var v = a * 100, s = v >= 1 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(2) : v.toFixed(3);
    return (Number(s) > 0 ? s : '<0.001') + '%';      /* an open trade never reads 0%: at 1000× the whole room is 0.05% */
  }
  function roomNew() {
    var r = { t: h('span', 'sm-room-t', ''), v: h('b', 'sm-room-v', '—'), f: h('i') };
    r.n = h('div', 'sm-room is-late', [h('div', 'sm-room-l', [r.t, r.v]), h('div', 'sm-room-bar', r.f)]);
    r.n.setAttribute('role', 'img'); r.f.style.width = '0%';
    return r;
  }
  function roomSet(r, x) {
    if (!r) return;
    var late = !!x.delayed || !(x.px > 0) || !(x.endPx > 0) || !isFinite(x.away), past = !late && !(x.away > 0);
    var share = late || past || !isFinite(x.share) ? 0 : Math.max(0, Math.min(1, x.share)), fig = late ? '—' : past ? '' : roomFig(x.away);
    var at = price(x.endPx, x.sz), w = Math.round(share * 1000) / 10 + '%';
    txt(r.t, past ? 'At the price where it closes itself' : 'Closes itself if ' + x.sym + (x.isLong ? ' falls' : ' rises'));
    txt(r.v, fig);
    cls(r.n, 'sm-room' + (late ? ' is-late' : past ? ' is-red' : x.near ? ' ' + x.near : ''));
    if (r.f.style.width !== w) r.f.style.width = w;
    var al = x.sym + ' closes itself at ' + at + (late ? '. The price is delayed.' : past ? '. The price is there now.' : ', ' + fig + (x.isLong ? ' below' : ' above') + ' the price now.');
    if (r.al !== al) { r.al = al; r.n.setAttribute('aria-label', al); }
  }
  /* the same distance in a few words, for a row: quiet while there is room, amber and red as on the cards; nothing while the price is late */
  function roomShort(n, x, lead, off) {
    var late = off || !!x.delayed || !(x.px > 0) || !(x.endPx > 0) || !isFinite(x.away), past = !late && !(x.away > 0);
    txt(n, late ? '' : (lead || '') + (past ? 'at the price where it closes itself' : roomFig(x.away) + ' from closing itself'));
    cls(n, 'sm-room-s' + (late ? '' : past ? ' is-red' : x.near ? ' ' + x.near : ''));
  }
  /* (cf_BFNEWS) "Powered by Blockfront", the last line of a trade card (the owner, 2026-11-19: "powered by block front", then "on the
     position cards actually"): one line in the card's own key / value style, its link the article. It shows only while this page
     really reads the chain through Blockfront (api.poweredByBlockfront: switched on, and the read provider's last good answer came
     from it), so never in the demo and never while config.json says "blockfront": false. Decided at most once in 30 s (the provider's
     own wait before it tries an endpoint again) and only on the cards' normal repaint: a fail-over hides the line once, no flicker. */
  var PB = { on: false, at: 0 };
  function poweredRow() {
    var a = h('a', null, 'Blockfront'); a.href = 'blockfront.html';
    var n = h('div', 'sm-kv sm-pb', [h('span', null, 'Powered by'), a]); n.hidden = true;
    return n;
  }
  function poweredSet(n) {
    var now = Date.now();
    if (now - PB.at >= 30000) { PB.at = now; try { PB.on = !!(api.poweredByBlockfront && api.poweredByBlockfront()); } catch (e) { PB.on = false; } }
    show(n, PB.on);
  }
  function sidePill(isLong, lev) { return h('span', 'sm-pill ' + (isLong ? 'is-up' : 'is-dn'), (isLong ? '▲ UP' : '▼ DOWN') + (lev ? ' ' + lev + '×' : '')); }
  function chartMarks(p) {
    var marks = [];
    if (p.entry > 0) marks.push({ px: p.entry, kind: 'entry', label: 'opened ' + price(p.entry, p.sz) });
    if (p.endPx > 0) marks.push({ px: p.endPx, kind: 'liq', label: 'closes itself ' + price(p.endPx, p.sz) });
    if (p.auto && p.auto.tp != null) marks.push({ px: p.auto.tp, kind: 'tp', label: 'take profit ' + price(p.auto.tp, p.sz) });
    if (p.auto && p.auto.sl != null) marks.push({ px: p.auto.sl, kind: 'sl', label: 'stop ' + price(p.auto.sl, p.sz) });
    return marks;
  }
  function paintCoin() {
    var sym = S.sym, w = api.wallet(), a = api.account(), q = api.price(sym), m = market(sym);
    if (!q || !m) { back(); return; }
    var ps = w.account && a.loaded ? api.positions().filter(x => x.sym === sym) : [];
    var os = w.account ? ffOrders().filter(o => o.sym === sym) : [];
    var lims = w.account ? api.limits.orders().filter(o => o.sym === sym) : [];
    if (S.pid != null && !ps.some(x => x.id === S.pid)) S.pid = null;
    /* (cf_FILLFEEL) what stands on the screen: an order on its way as the trade it becomes, then the trades (ffItems). An order
       that reached the chain, filled, or did not open keeps its card's place (ffMorph); anything else is built anew */
    var items = ffItems(sym, ps, os), mode = items.length || lims.length ? 'trade' : 'chart';
    var sig = ['coin', sym, mode, COIN.tf, items.map(it => it.k + it.kind.charAt(0)).join(','), lims.map(o => o.id).join(',')].join('|');
    if (S.sig !== sig && !ffMorph(sig, sym, mode, items, lims)) { S.sig = sig; buildCoin(sym, mode, ps, os, lims); }
    var move = q.prev > 0 && q.px > 0 ? q.px / q.prev - 1 : NaN, pt = price(q.px, q.sz);
    flash(R.px, q.px); txt(R.px, pt); cls(R.px, 'sm-price' + (pt.length > 9 ? ' is-long' : '')); R.px.style.color = q.at && Date.now() - q.at < 15000 ? '' : 'var(--ink-muted)';
    txt(R.chg, isFinite(move) ? arrow(move) + pct(move) + ' today' : ''); cls(R.chg, 'sm-chg ' + tone(move));
    /* Update per-coin stats */
    if (R.stats) {
      var cs = api.coinStats(sym);
      var parts = [];
      if (cs && isFinite(cs.oiUp)) parts.push('Open Up ' + usdK(cs.oiUp));
      if (cs && isFinite(cs.oiDown)) parts.push('Open Down ' + usdK(cs.oiDown));
      if (cs && isFinite(cs.vol24h) && cs.vol24h > 0) parts.push('24h volume ' + usdK(cs.vol24h));
      txt(R.stats, parts.join(' · ') || '');
    }
    /* update the chart: sync price lines for positions, update last candle from live price */
    syncSmPriceLines();
    if (q.px > 0 && smChart.candles.length) updateSmChartFromPrice(q.px);
    /* update tf and mode button states */
    if (R.lineBtn) R.lineBtn.setAttribute('aria-pressed', COIN.mode === 'line' ? 'true' : 'false');
    if (R.candleBtn) R.candleBtn.setAttribute('aria-pressed', COIN.mode === 'candles' ? 'true' : 'false');
    items.forEach(it => { var c = it.kind === 'over' && R.cards[it.k]; if (c) ffOverPaint(c, it.o); });
    items.forEach(it => {
      var x = it.x, c = x && R.cards[it.k]; if (!c || c.kind === 'over') return;
      if (!x.ff) see(x);
      var ok = !x.delayed && isFinite(x.pnl);
      txt(c.pnl, ok ? (x.est ? '≈ ' : '') + usdP(x.pnl) : '—'); cls(c.pnl, 'sm-pnl ' + (ok ? tone(x.pnl) : 'sm-mute') + (c.pnlK || ''));
      txt(c.pct, ok ? pct(x.pnl / x.margin) : 'The price is delayed'); cls(c.pct, 'sm-pnlp ' + (ok ? tone(x.pnl) : 'sm-mute'));
      pnlFit(c);
      txt(c.entry, price(x.entry, x.sz));
      if (c.now) txt(c.now, q && q.px > 0 ? price(q.px, x.sz) : '—');      /* the coin's price now, live, between where it opened and where it closes itself */
      txt(c.end, price(x.endPx, x.sz)); cls(c.end, 'sm-dn');      /* the price; how far it is now is the line under the P&L */
      roomSet(c.room, x);
      /* its one action: Close (what it gives back, live), or the close on its way, said in place */
      var st = x.status, mine = COIN.closing === x.id, err = COIN.errs[x.id] || '', say = err, label, busy = false, act = null;
      if (st && st.final) { label = 'Closed'; busy = true; }
      else if (st && st.btn) {
        var again = /again/i.test(st.btn);
        var own = !again && !!st.own;
        label = again ? 'Try closing again' : own ? 'Close now from your wallet' : 'Finish closing now'; act = () => { heldCloseGo(x.id, own); };
        say = COIN.errs[x.id] || (again ? 'It did not close. Your trade is still open.' : own ? OWN_SAY : 'It is taking longer than usual. One tap finishes it.');
      } else if (st || mine) {
        var still = st && /^Still/.test(st.text), pc = partOf(x);      /* a part on its way says its share: "Closing 50%…" */
        label = st && /^Confirm/.test(st.text) ? CONFIRM : still ? 'Still closing' + pc + '…' : st && /^Check|^Closed/.test(st.text) ? plainStatus(st.text) : 'Closing' + pc + '…'; busy = true;
        say = still ? 'Taking longer than usual. Your trade stays open until it closes.' : '';
      }
      else label = 'Close · take about ' + (isFinite(x.payout) && !x.delayed ? usd(x.payout) : usdS(x.back != null ? x.back : x.margin));
      txt(c.close, label); cls(c.close, 'sm-btn is-primary' + (busy ? ' is-busy' : '')); c.close.disabled = busy; c.close._act = act;
      var as = say ? '' : autoSay(x);      /* else: a take profit / stop loss that fired, or waits on hold, says so here */
      txt(c.say, say || as); cls(c.say, 'sm-say' + (err && say === err ? ' is-bad' : as ? ' is-warn' : '')); show(c.say, !!(say || as));
      otKey(c.close, c.say, x);      /* one-tap for everyone: this close's wallet step, said on its key */
      headSet(c, x);
      autoKeySet(c.ak, x, !!(st || mine));
      partKeysSet(c.pk, x, !!(st || mine));
      poweredSet(c.pb);
      ffLate(c, x); ffPartLook(c, x);
    });
    /* limit order updates */
    lims.forEach(lm => {
      var c = R.cards['lim' + lm.id]; if (!c) return;
      txt(c.px, price(lm.px, lm.sz));
      txt(c.now, lm.now ? price(lm.now, lm.sz) : '—');
    });
    /* update all open trades section (other coins) */
    var allPs = api.positions().filter(p => p.sym !== sym);
    allPs.forEach(x => {
      var c = R.cards['all' + x.id]; if (!c) return;
      var ok = !x.delayed && isFinite(x.pnl);
      txt(c.pnl, ok ? (x.est ? '≈ ' : '') + usdP(x.pnl) : '—'); cls(c.pnl, 'sm-pnl ' + (ok ? tone(x.pnl) : 'sm-mute') + (c.pnlK || ''));
      txt(c.pct, ok ? pct(x.pnl / x.margin) : '—'); cls(c.pct, 'sm-pnlp ' + (ok ? tone(x.pnl) : 'sm-mute'));
      pnlFit(c);
      roomSet(c.room, x);
      var st = x.status, mine = COIN.closing === x.id, label, busy = false, act = null, say = '';
      if (st && st.final) { label = 'Closed'; busy = true; }
      else if (st && st.btn) {
        var again = /again/i.test(st.btn), own = !again && !!st.own;
        label = again ? 'Try closing again' : own ? 'Close now from your wallet' : 'Finish closing now'; act = () => { heldCloseGo(x.id, own); };
        say = COIN.errs[x.id] || (again ? 'It did not close. Your trade is still open.' : own ? OWN_SAY : 'It is taking longer than usual. One tap finishes it.');
      }
      else if (st || mine) { label = 'Closing' + partOf(x) + '…'; busy = true; }
      else label = 'Close · take about ' + (isFinite(x.payout) && !x.delayed ? usd(x.payout) : usdS(x.back != null ? x.back : x.margin));
      txt(c.close, label); cls(c.close, 'sm-btn is-primary' + (busy ? ' is-busy' : '')); c.close.disabled = busy; c.close._act = act;
      var as = say ? '' : autoSay(x);      /* else only a take profit / stop loss that fired or waits on hold */
      txt(c.say, say || as); cls(c.say, 'sm-say' + (as ? ' is-warn' : '')); show(c.say, !!(say || as));
      otKey(c.close, c.say, x);
      headSet(c, x);
      autoKeySet(c.ak, x, !!(st || mine));
      partKeysSet(c.pk, x, !!(st || mine));
      poweredSet(c.pb);
    });
    fitTrades();
  }
  /* (cf_POS_CARD) A card's result and its percent stay on one line whatever the figure. Before, on a 360 px phone a figure from
     $100 up (on a 390 px one from $1,000) pushed the percent to a second line: the card grew 25 px and Close moved under the
     thumb each time the figure crossed a digit. Now the figure steps down a size (36, 30, 26, 22 px), only as far as the line
     needs; looked at again only when the figure or the percent changes length (or the screen its width). */
  var PNL_K = ['', ' is-long', ' is-longer', ' is-longest'];
  function pnlFit(c) {
    var row = c.pnl.parentNode, key = c.pnl.textContent.length + '|' + c.pct.textContent.length + '|' + window.innerWidth;
    if (!row || c.pnlKey === key) return;
    c.pnlKey = key;
    var base = c.pnl.className.replace(/ is-long(er|est)?/g, '');
    for (var i = 0; i < PNL_K.length; i++) {
      c.pnlK = PNL_K[i]; c.pnl.className = base + c.pnlK;
      if (row.offsetHeight < 46) break;      /* one line: 40 px (its min-height); a second line makes it 65 */
    }
  }
  /* (cf_POS_CARD) The open trade's card whole on the screen, nothing to scroll (the owner, 2026-11-21: "make it so the open
     posistion card isnt cut off at the bottom making it so you have to scroll"). With a trade open, the trades sit right under
     the coin's price and the stats, the chart and its timeframes come under them (buildCoin). Three ways to lay the top out,
     taken in this order, the first in which the first card is whole above the Up / Down keys with 8 px to spare:
       0  the price as on every coin (its name, then the big price), "Your trade on" and the cards;
       1  the price in one line (the name, a smaller price, the day's move), the cards right under it;
       2  the cards first (a short screen, such as 360 x 560 with the browser's bars), the price in one line under them.
     Measured on the card as drawn, its Blockfront line counted even before it shows (it may come a moment later), against the
     screen without a passing message over the keys (a snack goes in 6 s): right after each build, and again on a later paint
     only when the card grew (a line it says, such as its take profit's note) and nothing is under way: no sheet open, no close
     on its way, the screen not scrolled down to the chart. One way only for the visit (0 to 1 to 2, never back until the coin
     is opened again: go), so nothing moves back and forth. */
  function tradeTop(n) {
    var main = el.main;
    COIN.tmode = n;
    main.classList.toggle('is-tsmall', n === 1);
    main.classList.toggle('is-tfirst', n === 2);
    if (R.box) main.insertBefore(R.box, n === 2 ? main.firstChild : R.stats);
  }
  function fitTrades() {
    var main = el.main, box = R.box, card = box && box.isConnected ? box.querySelector('.sm-pos') : null;
    if (!card || COIN.tmode >= 2) return;
    if (!R.fitNew && (main.scrollTop > 2 || sheets.length || COIN.closing != null || box.querySelector('.sm-btn.is-busy'))) return;
    var h0 = card.offsetHeight;
    if (!R.fitNew && h0 <= R.fitH) return;
    R.fitNew = false; R.fitH = h0;
    var pb = card.querySelector('.sm-pb'), extra = 0, sn = el.root.querySelector('.sm-snack');
    if (pb && pb.hidden) { pb.hidden = false; extra = card.offsetHeight - h0; pb.hidden = true; }
    var room = main.clientHeight + (sn ? sn.offsetHeight : 0) - 8;
    while (COIN.tmode < 2 && card.getBoundingClientRect().bottom - main.getBoundingClientRect().top + main.scrollTop + extra > room) tradeTop(COIN.tmode + 1);
  }
  /* a trade's card on its coin's screen. (cf_FILLFEEL) Its own function, under its own key: an order on its way has this card
     too, drawn as the trade it becomes (x.ff, ffLook), and the real trade's card takes its place where it stands (ffMorph) */
  function posCard(x, k) {
    var c = R.cards[k || 'p' + x.id] = { kind: x.ff ? 'look' : 'pos', pnl: h('div', 'sm-pnl sm-mute', ''), pct: h('div', 'sm-pnlp', ''), entry: h('span', null, '—'), now: h('span', null, '—'), end: h('span', null, '—'), say: sayLine(), room: roomNew() };
    c.close = btn('sm-btn is-primary', '', () => { if (c.close._act) c.close._act(); else closeGo(x.id); });
    c.ak = autoKey(x); c.set = c.ak.n;      /* Take profit and Stop loss, under where it opened and where it closes itself */
    c.pk = partKeys(x); c.pb = poweredRow();      /* then Close part and Add to this trade (v5), and whose pipes the page reads through */
    /* (cf_POS_CARD) where it opened and where it closes itself: one ruled line, side by side, each name above its price */
    c.n = h('div', 'sm-pos', [posHead(c, x, x.sym), h('div', 'sm-pnlrow', [c.pnl, c.pct]), c.room.n, c.say, c.close,
      h('div', 'sm-kvs', [h('div', 'sm-facts', [h('div', 'sm-fact', [h('span', null, 'You opened at'), c.entry]), h('div', 'sm-fact sm-fact-now', [h('span', null, 'Price now'), c.now]), h('div', 'sm-fact', [h('span', null, 'Closes itself at'), c.end])]), c.set, c.pk ? c.pk.n : null, c.pb])]);      /* (owner 11/21 "make it so you dont have to scroll to see current price") the price now sits on the card itself */
    if (x.ff) ffGuard(c.n, () => c.close._ffLive ? c.close : null);      /* its keys wait for the trade */
    return c;
  }
  function buildCoin(sym, mode, ps, os, lims) {
    var main = el.main, cta = el.cta, trade = mode === 'trade', m = market(sym);
    /* (cf_FILLFEEL) this coin's chart, alive and on screen, is kept as it is: the screen is built again when a trade comes or goes,
       and a chart made anew stood empty for a moment each time */
    var keep = !!(R.chartBox && R.chartBox.isConnected && smChart.api && smChart.host === R.chartHost && smChart.coin === m.coin);
    main.className = 'sm-main' + (trade ? ' is-trade' : ' is-fit'); main.textContent = ''; cta.textContent = ''; cta.className = 'sm-cta is-two';
    R.cards = {};
    add(main, [h('div', 'sm-cname', nameOf(sym)), h('div', 'sm-cbar', [R.px = h('span', 'sm-price', ''), R.chg = h('span', 'sm-chg', '')])]);
    /* Per-coin stats: Open Up / Open Down / 24h volume */
    R.stats = h('div', 'sm-stats', '');
    add(main, R.stats);
    /* LightweightCharts container */
    if (!keep) { R.chartHost = h('div', 'sm-chart-lw'); R.csay = h('div', 'sm-chart-say', ''); R.chartBox = h('div', 'sm-chart', [R.chartHost, R.csay]); }
    var chartBox = R.chartBox; cls(chartBox, 'sm-chart' + (trade ? ' is-set' : ''));
    /* timeframe and mode buttons */
    var tfBar = h('div', 'sm-tf');
    CHART_TF.forEach(function (t) {
      var b = btn(null, t, () => { setSmChartTf(t); S.sig = ''; paint(); });
      b.setAttribute('aria-pressed', t === COIN.tf ? 'true' : 'false');
      tfBar.appendChild(b);
    });
    /* Line/Candles toggle */
    var lineBtn = btn(null, 'Line', () => { setSmChartMode('line'); S.sig = ''; paint(); });
    lineBtn.setAttribute('aria-pressed', COIN.mode === 'line' ? 'true' : 'false');
    var candleBtn = btn(null, 'Candles', () => { setSmChartMode('candles'); S.sig = ''; paint(); });
    candleBtn.setAttribute('aria-pressed', COIN.mode === 'candles' ? 'true' : 'false');
    R.lineBtn = lineBtn; R.candleBtn = candleBtn;
    tfBar.appendChild(h('span', 'sm-tf-sep', ''));
    tfBar.appendChild(lineBtn);
    tfBar.appendChild(candleBtn);
    add(main, [chartBox, tfBar]);
    /* initialize chart after layout */
    if (!keep) setTimeout(() => { initSmChart(R.chartHost, m.coin, m.sz); }, 0);
    var up = btn('sm-dir is-up', ['▲ Up', h('i', null, '(Click here to open)')], () => { openOrder(sym, true); });
    var dn = btn('sm-dir is-dn', ['▼ Down', h('i', null, '(Click here to open)')], () => { openOrder(sym, false); });
    add(cta, [up, dn]);
    R.box = null; R.ffBuilt = ffStamp(sym, mode, lims);
    if (!trade) return;
    var items = ffItems(sym, ps, os), total = items.filter(it => it.kind !== 'hold').length + lims.length;
    var box = h('div', 'sm-trades', h('div', 'sm-label', total > 1 ? 'Your trades on ' + sym : 'Your trade on ' + sym));
    items.forEach(it => { if (it.kind !== 'hold') box.appendChild(ffBuild(it).n); });      /* (cf_FILLFEEL) the orders as their trades, then the trades */
    /* limit orders waiting to fire */
    lims.forEach(lm => {
      function limHead() { return h('div', 'sm-pos-h', [h('span', null, [sym, sidePill(lm.isLong, lm.lev), h('i', 'sm-wait-tag', 'Limit')]), h('span', 'sm-in', usdS(lm.margin) + ' in')]); }
      var c = R.cards['lim' + lm.id] = { now: h('span', null, '—'), px: h('span', null, '—') };
      c.cancel = btn('sm-btn is-ghost', 'Cancel', () => { api.limits.cancel(lm.id); S.sig = ''; kick(); });
      c.n = h('div', 'sm-pos is-lim', [limHead(),
        h('div', 'sm-kvs', [h('div', 'sm-kv', [h('span', null, 'Opens at'), c.px]), h('div', 'sm-kv', [h('span', null, 'Now'), c.now])]),
        h('p', 'sm-fine', 'Fires while Confetti is open on this phone.'), c.cancel]);
      box.appendChild(c.n);
    });
    R.box = box; R.fitNew = true; tradeTop(COIN.tmode || 0);      /* (cf_POS_CARD) under the price, or first: fitTrades */

    /* All open trades section: all positions across all coins, not just this one */
    var w = api.wallet(), a = api.account();
    var allPs = w.account && a.loaded ? api.positions() : [];
    /* every open trade is remembered, not only this coin's: one of the others can end while this page is up (its take
       profit or stop loss), and its result needs what the trade was */
    allPs.forEach(see);
    var otherPs = allPs.filter(p => p.sym !== sym);
    if (otherPs.length) {
      otherPs.sort((a2, b2) => (b2.openedAt || 0) - (a2.openedAt || 0));
      var allBox = h('div', 'sm-all-trades-ph');
      add(allBox, h('div', 'sm-label', 'Your other open trades'));
      otherPs.forEach(x => {
        var c = R.cards['all' + x.id] = { pnl: h('div', 'sm-pnl sm-mute', ''), pct: h('div', 'sm-pnlp', ''), say: sayLine(), room: roomNew() };
        function allHead(p) {
          var coin = h('span', 'sm-all-link', p.sym); coin.addEventListener('click', ev => { ev.stopPropagation(); go('coin', p.sym, p.id); });
          return posHead(c, p, coin);
        }
        c.say.hidden = true;      /* nothing is said on these cards: no empty line between the bar and Close */
        c.close = btn('sm-btn is-primary', '', () => { if (c.close._act) { if (!early()) c.close._act(); return; } closeGo(x.id); });
        c.ak = autoKey(x); c.set = c.ak.n; c.pk = partKeys(x); c.pb = poweredRow();
        c.n = h('div', 'sm-pos', [allHead(x), h('div', 'sm-pnlrow', [c.pnl, c.pct]), c.room.n, c.say, c.close,
          h('div', 'sm-kvs', [c.set, c.pk ? c.pk.n : null, c.pb])]);
        allBox.appendChild(c.n);
      });
      main.appendChild(allBox);
    }
    /* opened from that trade's row on Home: its card is brought into view */
    var pick = S.pickOnce && S.pid != null && R.cards[ffKeyOf(S.pid)]; S.pickOnce = false;
    if (pick && ps.length > 1 && ps[0].id !== S.pid) setTimeout(() => { if (pick.n.isConnected) pick.n.scrollIntoView({ block: 'nearest' }); }, 60);
  }
  /* ---- (cf_FILLFEEL) The trade looks filled from the press (the owner, 2026-11-21: "make the site look like it fills faster",
     then, told of a plan with a line that fills and a small burst: "skip this and just make it look filled").
     How long a fill takes is the chain's and the keeper's. From the press on Open, an order on its way is drawn as the trade it
     becomes: the open trade's own card (posCard) and rows, with the figures the page's own code gives for it filled at the
     price now (fig: trade.js openingFigures, the Pro card's own), the price it opened at and the price it closes itself at
     held as they stood at the press. No wait state, no line, no words. When the chain says it is open the real trade's card
     takes the order's place where it stands (ffMorph: the screen is not built again, the chart stays) and the real figures
     stand where the page's own stood. Its keys are the trade's keys; one pressed before the trade is really open says so in
     a line at the bottom of the screen and does nothing else.
     Only an order that does not go to plan changes its card. One that takes longer says so in the card's own line (and its
     key finishes it, where the page offers that). One that did not open (refused, refunded, the wallet said no, out of time)
     is only its top, "Not opened", what happened and its key (try again, or get the money back), in the words there were:
     nobody is left believing in a trade that is not there.
     A close does the same: the result's screen comes at the press with the result as it stands then (ffClosed) and takes the
     real figures when the chain has them; a close that is refused or held up goes back to the trade's card, which says so
     (ffDoneCheck). A part closing shows the smaller trade at once (ffPartLook).
     FF.slots: one per order, from its press to its trade (an order's key changes when it reaches the chain, then the trade
     has an id of its own), so its card, the prices held at the press and the levels typed for it stay one thing. ---- */
  var FF = { slots: [], n: 0, known: {}, primed: false, tap: null, can: null, who: null, part: {} };
  var NOT_YET = 'One moment: this trade is still opening. Try again in a few seconds.', PART_YET = 'One moment: the part is still closing. Try again in a few seconds.', DONE_YET = 'One moment: the last figures are still coming in. Try again in a few seconds.';
  function ffSame(s, y) { return s.sym === y.sym && s.isLong === !!y.isLong && Number(s.lev) === Number(y.lev); }
  function ffSlot(okey) { return FF.slots.filter(s => s.okey === okey)[0] || null; }
  function ffSlotOf(pid) { pid = String(pid); return FF.slots.filter(s => s.pid === pid)[0] || null; }
  /* an order that waits in place a moment: gone from the orders, its trade not read yet */
  function ffWaits(s) { return !!s && !s.okey && s.pid == null && !s.pre && !s.fail && FF.slots.indexOf(s) >= 0; }
  /* a press on Open that went out: its order's place keeps the levels typed for it */
  function ffTap(o) { FF.tap = { sym: o.sym, isLong: !!o.isLong, lev: o.lev, margin: o.margin, at: Date.now(), tp: o.tp != null && isFinite(o.tp) ? o.tp : null, sl: o.sl != null && isFinite(o.sl) ? o.sl : null }; }
  /* An order the wallet is still being asked about (the first trade: one-tap, once; a wallet that confirms each one): the
     page's own code has taken it (api.open said yes, its ticket waits on the wallet) and it is not in the list of orders yet.
     It has its place already; the list's own entry takes the place over the moment the wallet has sent it, and if the
     wallet says no the place says so (ffSync). While it is asked, the place says what happens, not a passing message. */
  function ffAsk() {
    var t = FF.tap;
    if (!t || api.ticket().phase !== 'wallet') return false;
    FF.tap = null; S.claim = true;
    FF.slots.push({ id: ++FF.n, sym: t.sym, isLong: t.isLong, lev: t.lev, margin: t.margin, tp: t.tp, sl: t.sl, pid: null, okey: '', pre: t.at });
    return true;
  }
  function ffSync() {
    var w = api.wallet(), a = api.account(), now = Date.now();
    if (w.account !== FF.who) { FF.who = w.account || null; FF.slots = []; FF.known = {}; FF.primed = false; FF.part = {}; }      /* another account: its own orders and trades */
    if (!w.account) return;
    var os = api.openings(), live = {}, pids = {};
    os.forEach(o => { live[o.key] = o; });
    FF.slots.forEach(s => { if (s.okey && !live[s.okey]) { s.okey = ''; s.lost = now; } });
    os.forEach(o => {
      if (ffSlot(o.key)) return;
      var s = FF.slots.filter(z => !z.okey && z.pid == null && !z.fail && ffSame(z, o))[0];
      if (!s) {
        var t = FF.tap && ffSame(FF.tap, o) && now - FF.tap.at < 90000 ? FF.tap : null;
        if (t) FF.tap = null;
        FF.slots.push(s = { id: ++FF.n, sym: o.sym, isLong: !!o.isLong, lev: o.lev, margin: o.margin, tp: t ? t.tp : null, sl: t ? t.sl : null, pid: null });
      }
      if (s.pre) S.claim = false;
      s.okey = o.key; s.lost = 0; s.pre = 0; s.end = o.kind === 'end';
    });
    /* an asked order whose wallet step ended with no order sent: the wallet said no (its place says so, for as long as the
       page's own such notes stay), or nothing is known (its place goes, after the moment an entry may still come) */
    var tk = api.ticket();
    FF.slots.forEach(s => {
      if (!s.pre || s.okey || (tk.phase === 'wallet' && now - s.pre < 120000)) return;
      s.pre = 0; S.claim = false;
      if (tk.phase === 'error' || tk.phase === 'refunded' || tk.phase === 'unknown') { s.fail = plain(tk.msg) || 'It did not go through. Nothing was taken.'; s.failAt = now; api.ticketDone(); }
      else s.lost = now;
    });
    if (a.loaded) {
      api.positions().forEach(x => {
        var id = String(x.id);
        pids[id] = true; FF.can = !!x.can;
        if (FF.known[id]) return;
        FF.known[id] = true;
        if (!FF.primed) return;      /* the trades there were when the page came up were opened before it */
        var s = FF.slots.filter(z => !z.okey && z.pid == null && !z.end && !z.pre && !z.fail && ffSame(z, x))[0];
        if (s) { s.pid = id; s.landed = now; }
      });
      FF.primed = true;
    }
    /* a slot lives as long as what it stands for: its order, its trade, a wallet's no for a quarter of a minute */
    FF.slots = FF.slots.filter(s => s.okey || s.pre || (s.fail ? now - s.failAt < 15000 : s.pid != null ? (!a.loaded || pids[s.pid] || now - s.landed < 5000) : now - s.lost < 1500));
    Object.keys(FF.part).forEach(pid => { if (ffPartOver(pid)) delete FF.part[pid]; });
  }
  /* The orders on their way, as every list of them is drawn: the ones the wallet is still asked about (or said no to) first,
     in the shape of the page's own entries, then the page's own (api.openings()) */
  function ffOrders() {
    var mine = FF.slots.filter(s => (s.pre || s.fail) && !s.okey && s.pid == null).map(s => s.fail
      ? { key: 'w' + s.id, kind: 'end', sym: s.sym, isLong: s.isLong, lev: s.lev, margin: s.margin, say: s.fail, tone: 'bad', btn: '', share: 0, fig: null, slot: s }
      : { key: 'w' + s.id, kind: 'ask', sym: s.sym, isLong: s.isLong, lev: s.lev, margin: s.margin, say: '', tone: '', btn: '', share: 0, fig: api.figure ? api.figure({ sym: s.sym, isLong: s.isLong, margin: s.margin, lev: s.lev }) : null, slot: s });
    return mine.concat(api.openings());
  }
  /* an order that will not become a trade by itself: it did not open, or its time ran out (one press gets the money back) */
  function ffOver(o) { return o.kind === 'end' || /back/.test(o.btn) || o.tone === 'bad'; }
  /* An order as the trade it becomes: an entry of api.positions()' shape, for the trade's own card and rows. The price it
     opened at and the price it closes itself at are held from the first figures (the press); what it has made and what a
     close gives back are the page's own figures for it filled at the price now, so nothing jumps when the real ones come.
     null: not to be drawn as a trade (ffOver) */
  function ffLook(o) {
    var s = o.slot || ffSlot(o.key), f = o.fig, ok = !!(f && f.fresh);
    if (!s || ffOver(o)) return null;
    if (ok && s.entry == null && f.entry > 0) { s.entry = f.entry; s.endPx = f.endPx; s.sz = f.sz; }
    var px = ok ? f.px : NaN, away = px > 0 && s.endPx > 0 ? Math.max(0, s.isLong ? (px - s.endPx) / px : (s.endPx - px) / px) : NaN;
    var full = s.entry > 0 && s.endPx > 0 ? Math.abs(s.entry - s.endPx) / s.entry : NaN, share = isFinite(away) && full > 0 ? Math.min(1, away / full) : NaN;
    return { id: 'f' + s.id, ff: s, ffO: o, sym: s.sym, sz: s.sz != null ? s.sz : f ? f.sz : null, isLong: s.isLong, lev: s.lev, boost: s.lev, margin: o.margin,
      entry: s.entry, px: px, endPx: s.endPx, away: away, share: share, near: share < 0.2 ? 'is-red' : share < 0.5 ? 'is-amber' : '',
      pnl: ok ? f.pnl : NaN, payout: ok ? f.payout : NaN, delayed: !ok || s.entry == null, est: true, status: null, part: 0,
      can: FF.can != null ? FF.can : !!api.part && Number((api.cfg() || {}).version) >= 5, auto: s.tp != null || s.sl != null ? { tp: s.tp, sl: s.sl } : null };
  }
  /* every order drawn as its trade, on one coin or on all */
  function ffLooks(os, sym) { return os.filter(o => sym == null || o.sym === sym).map(ffLook).filter(Boolean); }
  /* the card of a trade, real or still an order, by the trade's id */
  function ffKeyOf(pid) { var s = ffSlotOf(pid); return s ? 's' + s.id : 'p' + pid; }
  /* What stands on a coin's screen, in the order it is drawn: the orders (as their trades: look; or what became of them:
     over), an order waiting a moment for its trade to be read (hold), then the trades (pos). A card keeps its key from the
     order's press to the trade's end, so it is never taken away and put back */
  function ffItems(sym, ps, os) {
    var out = [];
    os.forEach(o => { var s = o.slot || ffSlot(o.key), x = ffLook(o); if (s) out.push(x ? { k: 's' + s.id, kind: 'look', x: x, o: o, s: s } : { k: 's' + s.id, kind: 'over', o: o, s: s }); });
    FF.slots.forEach(s => { if (s.sym === sym && ffWaits(s)) out.push({ k: 's' + s.id, kind: 'hold', s: s }); });
    ps.forEach(x => { out.push({ k: ffKeyOf(x.id), kind: 'pos', x: x }); });
    return out;
  }
  function ffStamp(sym, mode, lims) { return [sym, mode, lims.map(o => o.id).join(',')].join('|'); }
  function ffBuild(it) { return it.kind === 'over' ? ffOverCard(it) : posCard(it.x, it.k); }
  /* the coin's screen as it stands, brought in line with what should stand on it without building it again: an order's card
     turned into its trade's card in the same place (or into what became of it). false: build it (something else changed) */
  function ffMorph(sig, sym, mode, items, lims) {
    var box = R.box, todo = [], want = {};
    if (!S.sig || mode !== 'trade' || !box || !box.isConnected || R.ffBuilt !== ffStamp(sym, mode, lims)) return false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i], c = R.cards[it.k];
      want[it.k] = true;
      if (!c || !c.n.isConnected) { if (it.kind === 'hold') continue; return false; }
      if (it.kind !== 'hold' && c.kind !== it.kind) todo.push(it);
    }
    if (Object.keys(R.cards).some(k => /^(s|p)\d/.test(k) && !want[k])) return false;
    todo.forEach(it => { var old = R.cards[it.k], c = ffBuild(it); old.n.replaceWith(c.n); });
    /* in the order a fresh build gives */
    var nodes = items.filter(it => R.cards[it.k]).map(it => R.cards[it.k].n), have = Array.prototype.filter.call(box.children, n => nodes.indexOf(n) >= 0);
    if (nodes.some((n, j) => have[j] !== n)) { var after = have[have.length - 1].nextSibling; nodes.forEach(n => { box.insertBefore(n, after); }); }
    S.sig = sig;
    return true;
  }
  /* a key of a card or a row that draws an order as its trade, pressed before the trade is really open: said, nothing done.
     The one key such a card may really offer (finish an order that is held up) goes through. Also the result's screen shown
     from the press on Close, for the keys that hand out its picture (words) */
  function ffGuard(n, live, words) {
    n.addEventListener('click', ev => {
      var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!b || !n.contains(b) || (live && live() === b)) return;
      ev.preventDefault(); ev.stopPropagation(); snack(words || NOT_YET);
    }, true);
  }
  /* an order's card as its trade, when it takes longer than it should: said in the card's own line, in the words there were;
     held up with a key of the page's own (finish it): the card's one key is that key. c.close on a phone, c.go on a wide screen */
  function ffLate(c, x) {
    var o = x.ffO, key = c.close || c.go, late = !!o && (!!o.tone || !!o.btn);
    key._ffLive = !!(late && o.btn);
    if (!late) return;
    txt(c.say, plainStatus(o.say)); cls(c.say, 'sm-say is-warn'); show(c.say, true);
    if (o.btn) { txt(key, 'Finish opening now'); key._act = () => { api.openingAct(o.key); }; }
  }
  /* what became of an order that will not become a trade: its top, "Not opened", what happened, its key */
  function ffOverCard(it) {
    var s = it.s, dk = isDesktop(), c = { kind: 'over', ff: s, pnl: h('div', 'sm-pnl sm-mute', 'Not opened'), say: sayLine() };
    c.go = btn('sm-btn is-primary', '', () => { if (c.go._act && !early()) c.go._act(); });
    c.n = h('div', 'sm-pos is-over', [dk ? h('div', 'sm-pos-h', [h('span', null, [sidePill(s.isLong), h('span', 'sm-in', usdS(s.margin) + ' × ' + s.lev)])])
      : h('div', 'sm-pos-h', [h('span', null, [s.sym, sidePill(s.isLong, s.lev)]), h('span', 'sm-in', usdS(s.margin) + ' in')]), dk ? c.pnl : h('div', 'sm-pnlrow', c.pnl), c.say, c.go]);
    if (dk) DK.CR.cards[it.k] = c; else R.cards[it.k] = c;
    return c;
  }
  function ffOverPaint(c, o) {
    var s = c.ff, ended = o.kind === 'end', ob = ended ? '' : o.btn;
    txt(c.say, plainStatus(o.say)); cls(c.say, 'sm-say' + (o.tone === 'bad' ? ' is-bad' : ''));
    /* its key: one press opens the order again for the same coin and side; out of time: one press gets the money back, and
       while that press is on its way the key waits */
    txt(c.go, ended ? 'Try again' : ob || 'One moment…'); cls(c.go, 'sm-btn is-primary' + (ended || ob ? '' : ' is-busy')); c.go.disabled = !(ended || ob);
    c.go._act = ended ? () => { if (s.fail) s.failAt = 0; (isDesktop() ? openOrderDesktop : openOrder)(s.sym, s.isLong); } : ob ? () => { api.openingAct(o.key); } : null;
  }
  /* a row of "Your trades" for an order: its trade's row; one that will not become a trade, or takes longer: what the page says of it */
  function ffRowLook(r, o) {
    var x = ffLook(o), late = !x || !!o.tone || !!o.btn, off = !x || x.delayed || !isFinite(x.pnl);
    txt(r.sub, late ? plainStatus(o.say) : usdS(x.margin) + ' in'); cls(r.sub, o.tone === 'bad' ? 'sm-dn' : '');
    if (x && !late) roomShort(r.room, x, ' · ', false); else { txt(r.room, ''); cls(r.room, 'sm-room-s'); }
    txt(r.v, !x ? usdS(o.margin) : off ? '—' : '≈ ' + usdP(x.pnl)); cls(r.v, x && !off ? tone(x.pnl) : '');
    txt(r.c, !x ? '' : off ? 'price delayed' : pct(x.pnl / x.margin)); cls(r.c, x && !off ? tone(x.pnl) : '');
  }

  /* ---- a close looks closed from the press ---- */
  /* The result's screen, at the press on Close, with the result as the card stood: what it had made, what a close gives
     back. Marked est until the chain's own result takes its place (onResult); nothing is drawn where the figures are not
     fresh, and then the card says "Closing…" as it did */
  function ffClosed(pid) {
    var x = api.positions().filter(p => p.id === pid)[0];
    if (!x || x.delayed || !isFinite(x.pnl) || !isFinite(x.payout) || !shown() || sheets.length) return;
    var d = { key: 'c' + pid + '~', pid: pid, sym: x.sym, isLong: x.isLong, lev: boostOf(x), margin: x.margin, liq: false, pnl: x.pnl, paid: x.payout, lost: 0, back: 0, exit: '', by: '', est: true, at: Date.now() };
    see(x); d.paidIn = fxPaid(S.seen[pid], false);
    if (!isDesktop()) { if (S.place === 'coin') { S.done = d; S.place = 'done'; S.sig = ''; } }
    else if ((!DK.panel || DK.panel === 'done') && !document.querySelector('dialog[open]')) openDoneDesktop(d);
  }
  /* the result's screen shown ahead of the chain: back to the trade's card the moment the close is known not to have gone
     through, or to be held up. The card says which, in the words there were */
  function ffDoneCheck() {
    var bad = d => {
      if (!d || !d.est) return false;
      var x = api.positions().filter(p => p.id === d.pid)[0], st = x && x.status;
      return !!COIN.errs[d.pid] || !!(st && st.btn) || (!!x && !st && COIN.closing !== d.pid && Date.now() - d.at > 1500);
    };
    if (S.place === 'done' && bad(S.done)) { var d = S.done; S.done = null; S.place = 'coin'; S.sym = d.sym; S.pid = d.pid; S.sig = ''; }
    if (DK.panel === 'done' && bad(DK.done)) closePanel();
  }
  /* that screen until the real result is in: the trade's picture comes with the real figures (its place is kept), and the
     keys that hand it out say so if pressed: a picture of figures that may still change is not handed out */
  function ffDoneWait(box, foot) {
    Array.prototype.forEach.call(box.querySelectorAll('.sm-card'), n => { n.classList.add('is-ff-wait'); ffGuard(n, null, DONE_YET); });
    Array.prototype.forEach.call(foot.querySelectorAll('.sm-btn.is-ghost'), n => { ffGuard(n, null, DONE_YET); });
  }
  /* and its line for the price it closed at keeps its room, so nothing moves when the line comes */
  function ffDoneHold(at) { if (at.hidden) { txt(at, '\u00a0'); at.hidden = false; } }

  /* ---- a part closing shows the smaller trade at once ---- */
  function ffPartOver(pid) {
    var e = FF.part[pid], x = api.positions().filter(p => p.id === pid)[0], st = x && x.status, l = api.part ? api.part.last(pid) : null;
    return !e || !x || !!COIN.errs[pid] || !!(st && st.btn) || !!(l && l.at >= e.at) || (!st && COIN.closing !== pid && Date.now() - e.at > 1500);
  }
  /* the card of a trade whose part is closing (after the card's own paint): what stays in it, its result and what a close
     gives back, each less the part; the line for what the part gave back, as the sheet said it; its keys as an open
     trade's. The chain's own figures take their places when the part has closed; a part that did not close is said by
     the card as before. c.close / c.in on a phone, c.go on a wide screen */
  function ffPartLook(c, x) {
    var e = FF.part[x.id], key = c.close || c.go;
    if (!e || !c.pnl) return;
    var f = 1 - e.bps / 10000, ok = !x.delayed && isFinite(x.pnl), stays = e.stays != null ? e.stays : x.margin * f;
    if (c.in) txt(c.in, usdS(stays) + (c.close ? ' in' : ' × ' + boostOf(x)));
    if (ok) txt(c.pnl, '≈ ' + usdP(x.pnl * f));
    txt(key, 'Close · take about ' + (isFinite(x.payout) && !x.delayed ? usd(x.payout * f) : usdS(x.margin * f)));
    if (c.close) cls(key, 'sm-btn is-primary');
    key.disabled = false; key._act = () => { snack(PART_YET); };
    show(c.say, false);
    autoKeySet(c.ak, x, false);
    if (c.pk) {
      c.pk.close.disabled = c.pk.add.disabled = false;
      var k = 'est' + e.bps + '|' + e.take;
      if (c.pk.didKey !== k) { c.pk.didKey = k; c.pk.did.textContent = ''; add(c.pk.did, ['Closed ' + pctS(e.bps) + ': ', h('b', null, usd(e.take)), ' is back in your trading money (', h('b', tone(e.pnl), usdP(e.pnl)), ').']); }
      show(c.pk.did, true);
    }
  }

  function toPro(sym) { api.pro('candles', sym); setMode('pro', true); }  /* a look at the candles: the next visit opens in Simple again */
  /* The line, scaled to the range plus the trades' prices that sit near it (up to one and a half ranges beyond it): a price
     further away is said at the chart's top or bottom edge with an arrow, so a far one never flattens the line. The labels
     are HTML over the chart (the line's own box stretches), nudged apart when two prices sit close. */
  function drawChart(m, q, marks, tgt) {
    var dk = isDesktop();
    var svgEl = dk ? DK.CR.svg : R.svg;
    var marksEl = dk ? DK.CR.marks : R.marks;
    var csayEl = dk ? DK.CR.csay : R.csay;
    var s = getSeries(m.coin, COIN.tf);
    if (due(series[seriesKey(m.coin, COIN.tf)])) loadSeries(m.coin, COIN.tf).then(kick);      /* never while a failed load is waiting its turn */
    if (!s) { txt(csayEl, 'Loading the chart…'); return; }
    marks = marks || [];
    var hh = marksEl.clientHeight;
    var key = s.at + '|' + q.px + '|' + COIN.tf + '|' + hh + '|' + marks.map(k => k.kind + k.px + k.label).join(','); if (svgEl._k === key) return;
    svgEl._k = key; txt(csayEl, ''); svgEl.textContent = ''; marksEl.textContent = '';
    var pts = s.pts.slice(); if (q.px > 0) pts[pts.length - 1] = q.px;
    var lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts), span0 = hi - lo || hi * 0.002 || 1, room = span0 * 1.5, near = [], far = [];
    marks.forEach(k => { if (!(k.px > 0)) return; if (k.px >= lo - room && k.px <= hi + room) near.push(k); else far.push(k); });
    near.forEach(k => { lo = Math.min(lo, k.px); hi = Math.max(hi, k.px); });
    var line = linePoints(pts, 100, 100, 4, lo, hi), col = pts[pts.length - 1] < pts[0] ? 'var(--neg)' : 'var(--pos)';
    var area = document.createElementNS(NS, 'polygon'); area.setAttribute('points', line + ' 100,100 0,100'); area.setAttribute('fill', col); area.setAttribute('opacity', '0.1');
    var l = document.createElementNS(NS, 'polyline'); l.setAttribute('points', line); l.setAttribute('stroke', col);
    svgEl.appendChild(area); svgEl.appendChild(l);
    if (!marks.length) return;
    var span = hi - lo || 1, yOf = p => 4 + 92 * (1 - (p - lo) / span);
    var items = near.map(k => ({ k: k, y: yOf(k.px) })).concat(far.map(k => ({ k: k, y: k.px > hi ? 0 : 100, edge: k.px > hi ? 'top' : 'bot' })));
    /* labels at least 18 px apart, in the order of their prices, kept inside the chart */
    items.sort((x, y) => x.y - y.y);
    var H = Math.max(1, hh), gap = 18, at = items.map(it => it.edge === 'top' ? 9 : it.edge === 'bot' ? H - 9 : Math.min(H - 9, Math.max(9, it.y / 100 * H)));
    for (var i = 1; i < at.length; i++) if (at[i] - at[i - 1] < gap) at[i] = at[i - 1] + gap;
    if (at.length && at[at.length - 1] > H - 9) { at[at.length - 1] = H - 9; for (var j = at.length - 2; j >= 0; j--) if (at[j + 1] - at[j] < gap) at[j] = at[j + 1] - gap; }
    items.forEach((it, i) => {
      var row = h('div', 'sm-mk is-' + it.k.kind + (it.edge ? ' is-edge' : ''));
      row.style.top = it.y + '%';
      var lab = h('span', null, it.edge ? it.k.label + (it.edge === 'top' ? ' ↑' : ' ↓') : it.k.label);
      lab.style.top = Math.round(at[i] - it.y / 100 * H) + 'px';
      row.appendChild(lab); marksEl.appendChild(row);
    });
  }
  /* the key of a close that is held up (finish it, close it from the wallet, ask again). When the wallet itself must
     sign (the close is the wallet's alone, or one-tap is not on) it is asked onto HyperEVM first, as closeGo does */
  function heldCloseGo(pid, own) {
    var s = api.session();
    if (api.demo || (s.live && !own)) { api.closeAct(pid); return; }
    COIN.errs[pid] = ''; S.claim = true;
    timed(api.toHyperEvm(), 30000, '').then(() => { api.closeAct(pid); }, () => { COIN.errs[pid] = STAYED + 'it did not close. Try again.'; }).then(() => { S.claim = false; kick(); });
  }
  /* One-tap for everyone: a Close that one-tap cannot carry yet (a trader who arrives with a trade open and no one-tap, or
     whose one-tap has run out or ended) first asks the wallet that one thing (otStep); the card's key says the wallet's turn
     and its line what the wallet shows (otKey). After the yes the close goes out through one-tap, shown as every close is. A
     no leaves one line on the card and the same Close key.
     A wallet short of the HYPE for the step: the line says so and Add money opens. One case is left to Pro's own way, as
     before: a wallet that could not give one-tap enough to run on but can still pay for one send itself (v.own) is never
     kept from closing a trade; it confirms that close in the wallet. */
  function closeGo(pid, stepped) {
    var s = api.session(), ot = stepped ? '' : otWhy(), v = ot ? otView() : null;
    if (COIN.closing || (!stepped && early())) return;
    if (ot && v.short && !v.own) { COIN.errs[pid] = OT_SHORT; S.lastErr = null; kick(); setTimeout(addMoneyAny, 250); return; }
    if (ot && !v.short) {
      COIN.errs[pid] = ''; COIN.closing = pid; S.claim = true; S.lastErr = null;
      OT.close = { pid: pid, say: otAsk(ot, 'Then this trade closes.') }; kick();
      otStep(null).then(() => { OT.close = null; COIN.closing = null; closeGo(pid, true); }, e => {
        OT.close = null; COIN.closing = null; S.claim = false; COIN.errs[pid] = e.plain; kick();
        if (e.add) setTimeout(addMoneyAny, 250);
      });
      return;
    }
    COIN.errs[pid] = ''; COIN.closing = pid; S.claim = true; S.lastErr = null;
    ffClosed(pid);      /* (cf_FILLFEEL) the result's screen at once, as the card stood; the chain's own result takes its place */
    kick();
    /* the wallet signs a close only when one-tap is not on: then it is asked onto HyperEVM first, and that wait ends by itself
       (after it, a late yes in the wallet only moves the wallet: the close is not sent behind the person's back) */
    (!api.demo && !s.live ? timed(api.toHyperEvm(), 30000, '') : Promise.resolve()).then(() => api.close(pid)).then(ok => {
      if (!ok) COIN.errs[pid] = lastErr() || 'It did not close, so your trade is still open. Try again.';
    }, () => { COIN.errs[pid] = STAYED + 'it did not close. Try again.'; }).then(() => { S.claim = false; COIN.closing = null; kick(); });
  }
  /* a trade ended (closed, or it closed itself): the result takes the coin's place, or waits on Home as a card */
  function onResult(r) {
    var pid = r && r.pid, res = pid && api.result(pid), seen = pid && (S.seen[pid] || (res && res.was));
    /* v6: a trade of the last visit that is gone, with nothing read about how it ended */
    var lost = pid && /^g/.test(String(r.key)) && api.gone ? api.gone(pid) : null;
    if (lost) { if (!S.away.some(x => x.key === r.key)) S.away.push({ key: r.key, pid: pid, sym: lost.sym, isLong: lost.isLong, lev: lost.lev, margin: lost.margin, gone: true, pnl: 0 }); redo(); return; }
    if (!res || !seen || !/^[cl]/.test(String(r.key))) { kick(); return; }
    var d = { key: r.key, pid: pid, sym: seen.sym, isLong: seen.isLong, lev: seen.lev, margin: seen.margin, liq: !!res.liq, pnl: res.liq ? -res.lost : res.pnl, paid: res.liq ? 0 : res.paid, lost: res.lost, back: res.liq && res.back > 0 ? res.back : 0, exit: res.exit };
    d.by = res.liq ? '' : AUTO.fired[pid] || '';      /* closed by its take profit or its stop loss: the result says so */
    d.paidIn = fxPaid(seen, d.liq);                      /* what it put in that money back counts (v5), for the result's one line */
    /* a level that fired on chain (TriggerFired): which one, when it was crossed, a late stop at its own price */
    if (res.trig) { d.trig = res.trig; d.closedAt = res.closedAt || 0; if (res.trig.kind !== 2) d.by = res.trig.kind === 0 ? 'tp' : 'sl'; }
    /* it ended while Confetti was closed: its own card on Home, beside any others */
    if (res.away) { d.away = true; if (!S.away.some(x => x.key === d.key)) S.away.push(d); redo(); return; }
    /* (cf_FILLFEEL) its result's screen is up already, from the press on Close: the real figures take its place there */
    if (S.done && S.done.est && S.done.pid === pid && S.place === 'done') { S.done = d; S.res = null; redo(); return; }
    if (DK.done && DK.done.est && DK.done.pid === pid && DK.panel === 'done') { DK.done = d; S.res = null; redo(); return; }
    if (shown() && !isDesktop() && S.place === 'coin' && S.sym === d.sym && !sheets.length) { S.done = d; S.place = 'done'; S.sig = ''; }
    /* a wide screen on that coin, nothing open over it: the result (and its card) comes up in the right-hand panel */
    else if (shown() && isDesktop() && !DK.panel && S.sym === d.sym && !document.querySelector('dialog[open]')) { openDoneDesktop(d); return; }
    else {
      S.res = d;
      /* on another coin's page (a phone): said at once; its card waits on the first screen */
      if (shown() && !isDesktop() && S.place === 'coin') snack(resTitle(d) + '.');
    }
    redo();
  }
  /* the end screen's own words: "DOGE up 20×, closed by your take profit", and what is back or gone, with the balance */
  function doneLabel(d) { return d.sym + (d.isLong ? ' up ' : ' down ') + d.lev + '×, ' + (d.liq ? 'closed itself' : d.by === 'tp' ? 'closed by your take profit' : d.by === 'sl' ? 'closed by your stop loss' : 'closed') + (d.away ? ' while you were away' : ''); }
  function doneMid(d, bal) {
    return d.liq ? [(d.trig && d.trig.kind === 2 ? 'In one second the price jumped past your stop loss and past the price where this trade closes itself, so it closed itself at ' + (d.exit ? '$' + d.exit : 'that price') + '. ' : 'The price reached ' + (d.exit ? '$' + d.exit : 'its limit') + ', so this trade closed itself. ') + goneWords(d) + ' Nothing more is owed.', h('br'), 'Balance: ', bal]
      : [usd(d.paid) + ' is back in your trading money.', h('br'), 'Balance: ', bal];
  }
  /* a level that fired on chain, in the result's words: "Closed by your stop loss at $0.07698. It was crossed at
     12:03:05 and the trade closed at 12:03:06."; a late stop "Closed by your stop loss at your price, $0.07700" */
  function trigDone(d) {
    var t = d && d.trig;
    if (!t || t.kind === 2) return '';
    var clock = s => new Date(s * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var what = t.kind === 0 ? 'take profit' : 'stop loss', late = t.kind === 1 && t.late;
    return 'Closed by your ' + what + ' at ' + (late ? 'your price, $' + t.level : '$' + t.exit) + '.' +
      (t.at > 0 ? ' It was crossed at ' + clock(t.at) + (d.closedAt > 0 ? ' and the trade closed at ' + clock(d.closedAt) : '') + (late ? ', late, so at your own price' : '') + '.' : '');
  }
  /* under an end screen's words, on a phone and in a wide screen's panel alike: the level that fired on chain (its price,
     when it was crossed, when the trade closed), else the price it ended at and that price's moment; a take profit the page
     saw reached that did not fire (V5P_SPEC 18.16 item 1); and the transaction that closed it, for anyone to check */
  function doneAt(d, atNode, txNode) {
    var now = api.result(d.pid), at = now && now.at ? now.at : '', tw = trigDone(d);
    var seen = now && now.seen ? plainPx(now.seen) : '';      /* plainPx gives its price a $ */
    var atw = tw || (at ? (d.exit ? (d.liq ? 'Closed itself at $' : 'Closed at $') + d.exit + ': ' : 'The ') + at + '.' : '');
    txt(atNode, atw + (seen ? (atw ? ' ' : '') + seen : '')); show(atNode, !!(atw || seen));
    var txu = txUrl(d);
    if (txNode) { if (txu && txNode.href !== txu) txNode.href = txu; show(txNode, !!txu); }
  }
  function paintDone() {
    var d = S.done, a = api.account();
    if (!d) { S.place = 'home'; S.sig = ''; paintHome(); return; }
    if (S.sig !== 'done' + d.key) {
      S.sig = 'done' + d.key;
      var main = el.main, cta = el.cta, win = d.pnl > 0.004, flat = Math.abs(d.pnl) <= 0.004, card = cardOn();
      main.className = 'sm-main'; main.textContent = ''; cta.textContent = ''; cta.className = 'sm-cta';
      R.bal = h('b', null, '');
      add(main, [h('div', 'sm-ok' + (win ? '' : flat ? ' is-flat' : ' is-loss'), win ? '✓' : flat ? '=' : '×'),
        h('div', 'sm-label', doneLabel(d)), h('div', 'sm-big ' + tone(d.pnl), usdP(d.pnl)), h('p', 'sm-mid', doneMid(d, R.bal))]);
      /* which price it ended at, and from what moment ("price at 12:03:05, Pyth"); empty on a market without it */
      R.at = h('p', 'sm-fine', ''); R.at.hidden = true; add(main, R.at);
      /* a level that fired on chain links the transaction that closed the trade (anyone can check it) */
      R.tx = h('a', 'sm-link', 'See it on the chain'); R.tx.target = '_blank'; R.tx.rel = 'noopener'; R.tx.hidden = true; add(main, R.tx);
      /* money back (fetti.js): what this trade brings back, or would at Level 1 */
      var fl = fxLine(d); if (fl) add(main, fl);
      /* the trader's own card, under the screen's words */
      if (card) add(main, cardKey(d, () => { cardGo(d); }));
      add(cta, btn('sm-btn is-primary', 'Trade again', () => { S.done = null; S.place = 'coin'; S.sym = d.sym; S.pid = null; S.sig = ''; paint(); }));
      if (card) add(cta, btn('sm-btn is-ghost', 'Share your trade', () => { cardGo(d); }));
      if (d.est) ffDoneWait(main, cta);      /* (cf_FILLFEEL) shown from the press: its picture and Share wait for the real figures */
    }
    txt(R.bal, a.loaded ? usd(a.available + (d.est ? d.paid : 0)) : '…');
    doneAt(d, R.at, R.tx);
    if (d.est) ffDoneHold(R.at);
  }

  /* ---- the trade card at the end (the owner, 2026-11-19: two mock-ups, then "can you use those at the end"). Every end
     screen shows the trader's own card in his design, green for a win and red for a loss: share.js draws it from the same
     figures the screen says (what went in, what it made or lost, the coin, the side, the boost), with the short address and a
     QR code to confetti.trade carrying the trader's own referral code.
     The owner, 2026-11-21: "make it so they customize the pnl cards too. removeable wallet address. removable trade amount.",
     then "make it so when you click share on portfolio page it shows the new pnl cards". A tap on the card or on Share your
     trade opens the card's sheet, and that sheet is share.js's own (ConfettiShare.open): the one every Share on every page
     opens, with the card on top, the trader's choices under it and the key that shares or saves the PNG. Here it only joins
     Simple's sheets (the phone's back, a change of view and the double-tap guard treat it like any other), and when it
     closes the end screen's own card wears the choices made in it. ---- */

  var CARD = { caps: {}, keys: [] };
  function cardOn() { var cs = window.ConfettiShare; return !!(cs && cs.open && cs.drawCardInto && cs.cardAlt && cs.cardPrefs); }
  /* the trader's own referral code, as Pro's Refer panel shows it (trade.js reads it from the chain when the wallet connects) */
  function refCode() { var n = $('rfCode'), c = n ? String(n.textContent || '').trim() : ''; return /^[a-z0-9_]{3,16}$/.test(c) ? c : ''; }
  function cardOf(d) { return { sym: d.sym, isLong: d.isLong, lev: d.lev, margin: d.margin, pnl: d.pnl, account: api.wallet().account || '', code: refCode(), level: fxBadge() }; }
  /* the trader's choices: the ones kept on this device for this wallet (share.js: cardPrefs), and this trade's own caption */
  function cardO(d) { var o = window.ConfettiShare.cardPrefs.get(api.wallet().account || ''); o.caption = CARD.caps[d.key] || ''; return o; }
  /* the card itself, a key as wide as the screen: drawn at its own size on the page with the trader's choices, and again
     when they change. In words, for a screen reader: only what the card shows (never the address) */
  function cardKey(d, onTap) {
    var cv = h('canvas'), n = btn('sm-card', cv, onTap);
    cv.setAttribute('aria-hidden', 'true');
    var tries = 0;
    n._draw = function draw() {
      var w = n.clientWidth;
      n.setAttribute('aria-label', window.ConfettiShare.cardAlt(cardOf(d), cardO(d)) + ' Share it');
      if (!w) { if (++tries < 60) requestAnimationFrame(draw); return; }
      window.ConfettiShare.drawCardInto(cv, cardOf(d), w, cardO(d)).then(() => { n.classList.add('is-in'); }, () => { n.hidden = true; });
    };
    n._draw();
    CARD.keys = CARD.keys.filter(k => document.contains(k)).concat([n]);
    return n;
  }
  function cardGo(d) {
    if (!cardOn()) return;
    var me = null;
    window.ConfettiShare.open(cardOf(d), {
      key: d.key,
      opened: ctl => { me = { d: ctl.dialog, close: ctl.close }; S.since = Date.now(); sheets.push(me); hPush(); },
      /* closed (as makeSheet's close does it), and the end screen's own card wears the choices */
      closed: (fromPop, o) => {
        sheets = sheets.filter(s => s !== me);
        if (!fromPop) { hBack(); var p = S.ptr; if (p && Date.now() - p.t < 700) S.shut = { x: p.x, y: p.y, t: Date.now() }; }
        if (o) CARD.caps[d.key] = o.caption;
        CARD.keys = CARD.keys.filter(k => document.contains(k)); CARD.keys.forEach(k => { k._draw(); });
        kick();
      }
    });
  }

  /* a wide screen's end screen: the right-hand panel, with the result's words, the card and its keys */
  function openDoneDesktop(d) {
    if (DK.panel && DK.panel !== 'done') closePanel();
    DK.panel = 'done'; DK.done = d; DK.doneSig = ''; S.res = null; S.sym = d.sym; S.place = 'coin'; S.sig = ''; paint();
  }
  function paintDesktopDone() {
    var d = DK.done, a = api.account(), head = el.panelHead, body = el.panelBody, foot = el.panelFoot;
    if (!d) { closePanel(); return; }
    if (DK.doneSig !== d.key) {
      DK.doneSig = d.key;
      var win = d.pnl > 0.004, flat = Math.abs(d.pnl) <= 0.004, card = cardOn(), R2 = DK.DR = { bal: h('b', null, ''), say: sayLine(), at: h('p', 'sm-fine', ''), tx: h('a', 'sm-link', 'See it on the chain') };
      R2.tx.target = '_blank'; R2.tx.rel = 'noopener'; R2.tx.hidden = true;
      R2.at.hidden = true;      /* which price it ended at, and from what moment (v5); empty on a market without it */
      head.querySelector('h2').textContent = d.sym + ' closed';
      head.querySelector('.sm-x').onclick = closePanel;
      body.textContent = ''; foot.textContent = '';
      add(body, [h('div', 'sm-ok' + (win ? '' : flat ? ' is-flat' : ' is-loss'), win ? '✓' : flat ? '=' : '×'),
        h('div', 'sm-label', doneLabel(d)), h('div', 'sm-big ' + tone(d.pnl), usdP(d.pnl)), h('p', 'sm-mid', doneMid(d, R2.bal)), R2.at, R2.tx, fxLine(d),
        card ? cardKey(d, () => { cardGo(d); }) : null]);
      add(foot, [R2.say, btn('sm-btn is-primary', 'Trade again', closePanel), card ? btn('sm-btn is-ghost sm-card-go', 'Share your trade', () => { cardGo(d); }) : null]);
      if (d.est) ffDoneWait(body, foot);      /* (cf_FILLFEEL) shown from the press: its picture and Share wait for the real figures */
    }
    txt(DK.DR.bal, a.loaded ? usd(a.available + (d.est ? d.paid : 0)) : '…');
    doneAt(d, DK.DR.at, DK.DR.tx);
    if (d.est) ffDoneHold(DK.DR.at);
  }

  /* ---- take profit and stop loss (the owner, 2026-11-19: "we need to bring back stop loss and take profit", "just make it
     visible on screen", "on the card"). Every trade card shows both levels, or Not set, under where it opened and where it
     closes itself, in one key that opens this sheet; the order sheet has both boxes in view. The rule itself is the Pro
     code's (trade.js): a close this browser sends when the price crosses a level, through one-tap when it is on, held to
     Pro's checks (api.autoRead / autoSet / autoCheck). So where it is set the sheet says the one thing that matters about
     it: it fires while Confetti is open here.
     v6 (then "then yes develop a real"): on a fast market of a v6 exchange the levels live on chain (x.auto.chain, a new
     open's: api.autoChain(sym)). The same screens set, change and remove them there; they close the trade whether this
     page is open or not, so those sheets say that instead, with how a stop fills (V5P_SPEC 18.11, in Simple's words: the
     liquidation price is where a trade closes itself, leverage is its boost), and the card says what the chain is doing:
     starts in N s (the market's own delay, 2 to 4 at launch), the old levels still counting, saving, paused on this market. PEOPLE and a market off Pyth keep the
     browser rule. ---- */

  var AUTO = { sh: null, pid: null, R: {}, err: '', was: null, fired: {}, n: 0 };
  function honest() { return isDesktop() ? 'It fires while Confetti is open in this browser.' : 'It fires while Confetti is open on this phone.'; }
  var CHAIN_ALWAYS = 'Your take profit and stop loss close this trade even when Confetti is closed.';
  /* under a stop on chain, at every boost; at 250× and more the jump past both */
  function chainStop(lev) {
    return 'We check the price once a second. Once it reaches your stop, the trade closes at that price. A sudden jump can close it past your price.' +
      (lev >= 250 ? ' At ' + lev + '× one second can move past both your stop and the price where the trade closes itself. Then it closes itself instead.' : '');
  }
  function clockOf(s) { return new Date(s * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function kvRow(k, v) { return h('div', 'sm-kv', [h('span', null, k), v]); }
  /* the card's key: Take profit and Stop loss, each with its price or Not set, in the card's own key / value lines */
  function autoKey(x) {
    var k = { tp: h('b', 'is-off', 'Not set'), sl: h('b', 'is-off', 'Not set'), chev: h('i', 'sm-chev', '›') };
    k.n = btn('sm-kv is-btn sm-ak', [h('span', 'sm-ak-rows', [h('span', 'sm-ak-row', [h('span', null, 'Take profit'), k.tp]), h('span', 'sm-ak-row', [h('span', null, 'Stop loss'), k.sl])]), k.chev], () => { openAuto(x.id); });
    return k;
  }
  function autoKeySet(k, x, off) {
    /* a close on its way: the levels it had stay in view (a rule that fired is gone from storage as soon as its close is sent) */
    if (off && !x.auto) { k.n.disabled = true; txt(k.chev, ''); return; }
    var a = x.auto || {}, tp = a.tp != null ? price(a.tp, x.sz) : '', sl = a.sl != null ? price(a.sl, x.sz) : '';
    txt(k.tp, tp || 'Not set'); cls(k.tp, tp ? '' : 'is-off');
    txt(k.sl, sl || 'Not set'); cls(k.sl, sl ? '' : 'is-off');
    k.n.disabled = !!off; txt(k.chev, off ? '' : '›');
    var al = 'Take profit ' + (tp || 'not set') + ', stop loss ' + (sl || 'not set') + (off ? '.' : tp || sl ? '. Change them.' : '. Set them.');
    if (k.al !== al) { k.al = al; k.n.setAttribute('aria-label', al); }
  }
  /* what a trade's rule has to say on its card: which level fired, while its close is on the way; why it waits */
  function autoSay(x) {
    var a = x.auto;
    if (a && a.fired) AUTO.fired[x.id] = a.fired;
    /* a fire that did not end in a close is forgotten: the rule is back without it (held), or nothing is closing any more */
    else if (a || (!x.status && COIN.closing !== x.id)) delete AUTO.fired[x.id];
    var f = AUTO.fired[x.id];
    if (f && (x.status || COIN.closing === x.id)) return 'The price reached your ' + (f === 'tp' ? 'take profit' : 'stop loss') + ': closing it for you.';
    /* v6: what the chain is doing with them */
    if (a && a.chain && !x.status) {
      /* a status that only says how a close would be confirmed hides nothing: paused, and "only while open", matter more */
      var quiet = !a.status || /wallet asks|waiting for a wallet/.test(a.status);
      if (a.err) return a.err;
      if (a.saving === 'wait') return 'Saving… keep this page open a few seconds.';
      if (a.saving) return 'Saving your take profit and stop loss…';
      /* a level this page has seen reached: the close is on its way; a take profit that takes longer than it should says
         when this page closes the trade itself. A stop loss is never closed by this page (a stop that closes late closes
         at the stop's own price, and a close sent from here would give that up): the card says the price it closes at
         and what Close would take instead */
      if (a.crossed && quiet && a.crossed.which === 'sl' && a.crossed.slow) {
        return 'Your stop loss was reached at ' + clockOf(a.crossed.at) + ' and has not closed the trade yet. ' +
          (a.crossed.own ? 'A stop that closes late closes at your price, ' + price(a.crossed.level, x.sz) + '. If you press Close, you get the market price instead.'
            : 'If you press Close, you get the market price now.');
      }
      if (a.crossed && quiet) {
        var cw = a.crossed.which === 'tp' ? 'take profit' : 'stop loss';
        return a.crossed.slow ? 'Your ' + cw + ' was reached at ' + clockOf(a.crossed.at) + ' and has not closed yet. If it still has not at ' + clockOf(a.crossed.closeAt) + ', this page closes the trade at the market price.'
          : 'The price reached your ' + cw + ' at ' + clockOf(a.crossed.at) + ': closing.';
      }
      /* a stop this page watched go unfired, the price now back inside it: the chain still owes it its own price, and
         anyone may still send that close */
      if (a.missed && quiet) return 'Your stop loss was reached at ' + clockOf(a.missed.at) + ' and did not close the trade. It can still close it at your price, ' + price(a.missed.level, x.sz) + '.';
      if (a.paused && quiet) return 'Paused on this market: while it is paused, they close this trade only while Confetti is open here.';
      /* a level the price is already at or past while it waits for its start: it closes the trade when it starts */
      if ((a.starts || a.updating) && a.already) return 'The price is already past your ' + (a.already === 'tp' ? 'take profit' : 'stop loss') + '. It closes this trade when it starts, in ' + (a.starts || a.updating) + ' s, unless the price comes back.';
      if (a.starts) return 'Take profit and stop loss start in ' + a.starts + ' s.';
      if (a.updating) return 'Updating: your old levels count for ' + a.updating + ' more second' + (a.updating === 1 ? '' : 's') + '.';
      if (a.past) return 'Your stop loss is past the price where this trade closes itself, so it does nothing there. Move it closer.';
      if (a.local && quiet) return 'These still work only while Confetti is open here. Save them again to make them work when it is closed.';
    }
    /* v6: levels asked for with the open that did not go on chain (its market was paused for them as it opened) */
    if (a && a.kept && !x.status && (!a.status || /wallet asks|waiting for a wallet/.test(a.status))) return 'These did not go on chain: this market is paused for them. They close this trade only while Confetti is open here.';
    if (x.missed && !x.status && COIN.closing !== x.id && !(a && /^held: /.test(a.status || ''))) return autoMissed(x);
    if (!a || !a.status || a.status === 'closing') return '';
    if (/^held: /.test(a.status)) {
      var why = a.status.slice(6);
      return /not sent/.test(why) ? 'Its take profit or stop loss tried to close it, and the close did not go through. It tries again in a few minutes, or press Close.'
        : /another tab/.test(why) ? 'Another tab was closing it. Check this trade, then set its take profit and stop loss again.'
        : 'Take profit and stop loss wait: ' + plain(why);
    }
    if (/wallet asks/.test(a.status) && !api.demo) return 'When it fires, your wallet asks you to confirm the close.';
    return '';
  }
  /* (amt5) a take profit or stop loss typed on the order sheet that could not go on the trade as it opened: the price moved
     between the press and the open, and at the price it opened at that level could no longer fire, or would have closed
     the trade at once (trade.js tpslFillCheck). The trade opened without it; its card says so, with the price that was
     typed, until its Take profit / Stop loss key right under this line is pressed or a level is set */
  function autoMissed(x) {
    var m = x.missed, tp = m.tp != null ? 'take profit at ' + price(m.tp, x.sz) : '', sl = m.sl != null ? 'stop loss at ' + price(m.sl, x.sz) : '';
    return 'The price moved before this trade opened, so your ' + (tp && sl ? tp + ' and ' + sl + ' were' : (tp || sl) + ' was') + ' not set. Set ' + (tp && sl ? 'new ones' : 'a new one') + ' below.';
  }
  /* a price box: its name above it, the box ($ and the number, the decimal keypad), and under it what that price does */
  function autoField(kind, onInput, short) {
    var f = { kind: kind, i: h('input'), rd: h('div', 'sm-ak-read', ''), fin: null, bad: '', onInput: onInput, short: !!short };
    f.i.type = 'text'; f.i.id = 'smAk' + kind + (++AUTO.n); f.i.placeholder = 'Not set';
    f.i.setAttribute('inputmode', 'decimal'); f.i.setAttribute('enterkeyhint', 'done'); f.i.setAttribute('autocomplete', 'off');
    var lab = h('label', 'sm-label', kind === 'tp' ? 'Take profit' : 'Stop loss'); lab.htmlFor = f.i.id;
    var box = h('span', 'sm-ak-in', [h('span', null, '$'), f.i]);
    box.addEventListener('pointerdown', ev => { if (ev.target !== f.i && !f.i.disabled) { ev.preventDefault(); f.i.focus(); } });      /* the whole box is the target */
    /* quick picks (the card's sheet): three keys under the box, each a price; filled by paintAuto, empty elsewhere */
    f.picks = h('div', 'sm-ak-picks'); f.picks.hidden = true; f.pk = [];
    f.n = h('div', 'sm-ak-f is-' + kind, [lab, box, f.picks, f.rd]);
    /* as it is typed the line above the button can grow (a refusal, "did you mean"): the box and what is under it stay in view */
    f.i.addEventListener('input', () => {
      var v = f.i.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'); if (v !== f.i.value) f.i.value = v; onInput();
      requestAnimationFrame(() => { try { f.n.scrollIntoView({ block: 'nearest' }); } catch (e) { /* fine */ } });
    });
    f.i.addEventListener('keydown', ev => { if (ev.key !== 'Enter') return; ev.preventDefault(); if (f.fin != null) { f.i.value = String(f.fin); onInput(); } else f.i.blur(); });
    f.i.addEventListener('focus', () => { setTimeout(fitKeyboard, 0); });
    return f;
  }
  /* Pro's sentence in Simple's words, its prices in dollars ("now 0.0587" reads "now $0.0587"; "0.1%" stays) */
  function plainPx(s) { return plain(s).replace(/(\s)(\d+(?:,\d{3})*\.\d+)(?![\d%])/g, '$1$$$2'); }
  /* a refusal of Pro's checks (tpslProblem) in a few words, so it fits above the button on the smallest phone; the check is
     the same, only the sentence is shorter. Anything else is Pro's own sentence in Simple's words */
  function autoWhy(s) {
    s = String(s || ''); var m;
    if ((m = /^A (take profit|stop loss) for a (long|short) goes (above|below) the price, now ([\d.,]+)\.$/.exec(s))) return 'A ' + m[1] + ' on ' + (m[2] === 'long' ? 'an Up' : 'a Down') + ' trade goes ' + m[3] + ' $' + m[4] + ', the price now.';
    if (/^That stop is within/.test(s)) return 'That stop is so close to the price now that it would close the trade at once.';
    if ((m = /^That stop is past the liquidation price, ([\d.,]+): .* Set it (higher|lower)\.$/.exec(s))) return 'The trade closes itself at $' + m[1] + ' first. Set the stop ' + m[2] + '.';
    return plainPx(s);
  }
  /* (amt4) the first second or two of a sheet, while the price a trade opens at is still being read: the boxes show nothing
     yet and the button waits; a wait is a note, not a mistake (no red) */
  function autoWait(s) { return /^One moment: reading the price/.test(s); }
  /* a reading (api.autoRead) under its box: the price a few digits probably mean, as a key to take it; or how far that
     price is from now and about what it brings (the words of Pro's own line). A refusal marks the box; the sentence
     stands above the button, where the reason a button is off always stands */
  function autoShow(f, r, sz, up, end) {
    var on = !!(r && r.n != null);
    f.fin = on && r.fin != null ? r.fin : null; f.bad = on && r.why ? autoWhy(r.why) : '';
    f.n.classList.toggle('is-bad', !!f.bad);
    /* nothing typed: where it can go. A take profit beyond the price now (above it for an Up trade); a stop loss between the
       price now and where the trade closes itself (end), the two bounds Pro's checks hold it to */
    var now = r && r.now > 0 ? r.now : 0, hint = '';
    if (!on && now) hint = f.kind === 'sl' && end > 0 ? 'Between ' + price(Math.min(now, end), sz) + ' and ' + price(Math.max(now, end), sz) : ((f.kind === 'tp') === !!up ? 'Above ' : 'Below ') + price(now, sz);
    var key = !on ? 'hint' + hint : f.fin != null ? 'fin' + f.fin : f.bad ? 'bad' : 'ok' + r.away + '|' + r.pnl + '|' + r.margin;
    if (f.rk === key) return;
    f.rk = key; f.rd.textContent = '';
    if (!on) { if (hint) add(f.rd, h('span', 'sm-ak-hint', hint)); return; }
    if (f.bad) return;
    if (f.fin != null) { add(f.rd, btn('sm-ak-fin', 'Use ' + price(f.fin, sz), () => { f.i.value = String(f.fin); f.onInput(); })); return; }
    var away = isFinite(r.away) ? Math.abs(r.away * 100).toFixed(2) + '% ' + (r.away >= 0 ? 'above' : 'below') + ' now' : '';
    /* the order sheet's narrow boxes: the dollars alone; the card's sheet: against what is in, as Pro's line says it */
    add(f.rd, [h('span', null, away), isFinite(r.pnl) && r.margin > 0 ? h('b', tone(r.pnl), 'about ' + usdP(r.pnl) + (f.short ? '' : ' (' + pct(r.pct) + ' of your ' + usdS(r.margin) + ')')) : null]);
  }
  function autoOf(pid) { return api.positions().filter(p => p.id === pid)[0] || null; }
  /* the card's sheet: the trade's three prices on top, the two boxes, Save. Opened from the card's key */
  function openAuto(pid) {
    var x = autoOf(pid);
    if (!x || early() || sheets.length || x.status) return;
    if (x.missed) { api.autoSeen(pid); kick(); }      /* (amt5) the card said a level was not set: said once, this is the key to set a new one */
    var sh = AUTO.sh || (AUTO.sh = makeSheet('Auto')), r = AUTO.R = {}, a = x.auto || {};
    AUTO.pid = pid; AUTO.err = ''; AUTO.was = { tp: a.tp != null ? a.tp : null, sl: a.sl != null ? a.sl : null };
    sh.title.textContent = ''; add(sh.title, [x.sym, sidePill(x.isLong, boostOf(x))]);
    sh.body.textContent = ''; sh.foot.textContent = '';
    r.now = h('span', null, '—'); r.entry = h('span', null, '—'); r.end = h('span', 'sm-dn', '—');
    var again = () => { AUTO.err = ''; paintAuto(); };
    r.tp = autoField('tp', again); r.sl = autoField('sl', again);
    r.tp.i.value = a.tp != null ? String(a.tp) : ''; r.sl.i.value = a.sl != null ? String(a.sl) : '';
    r.fine = h('p', 'sm-fine sm-ak-fine', '');
    add(sh.body, [h('div', 'sm-kvs sm-ak-top', [kvRow('Price now', r.now), kvRow('You opened at', r.entry), kvRow('Closes itself at', r.end)]),
      h('div', 'sm-ak-fields', [r.tp.n, r.sl.n]), r.fine]);
    r.say = sayLine();
    r.go = btn('sm-btn is-primary', '', autoGo);
    r.off = btn('sm-quiet', 'Remove take profit and stop loss', autoOff);
    add(sh.foot, [r.say, r.go, r.off]);
    sh.onClose = () => { AUTO.pid = null; };
    sh.open(); paintAuto();
  }
  function paintAuto() {
    var r = AUTO.R, pid = AUTO.pid, x = pid != null ? autoOf(pid) : null;
    if (!AUTO.sh || !AUTO.sh.isOpen) return;
    /* the trade closed, or its close is on the way (its take profit, its stop loss, Close): nothing is left to set */
    if (!x || x.status) { AUTO.sh.close(); return; }
    var sz = x.sz, rt = api.autoRead(pid, 'tp', r.tp.i.value) || {}, rs = api.autoRead(pid, 'sl', r.sl.i.value) || {};
    txt(r.now, price(rt.now, sz)); txt(r.entry, price(x.entry, sz)); txt(r.end, price(x.endPx, sz));
    autoShow(r.tp, rt, sz, x.isLong, x.endPx); autoShow(r.sl, rs, sz, x.isLong, x.endPx);
    autoPicks(pid, r);
    var tp = num(r.tp.i.value), sl = num(r.sl.i.value), was = AUTO.was, had = was.tp != null || was.sl != null;
    var same = tp === was.tp && sl === was.sl, none = tp == null && sl == null, fin = r.tp.fin != null || r.sl.fin != null;
    var why = AUTO.err || r.tp.bad || r.sl.bad;
    /* (amt5) the chain's price cannot be read just now: a typed level is not judged against the chart, the button waits */
    if (!why && !same && !none && !fin && (rt.wait || rs.wait)) why = 'One moment: reading the price.';
    var local = !!(x.auto && x.auto.local);      /* v6: a browser rule from before; saving it puts it on chain */
    /* one-tap for everyone: a save that one-tap cannot carry yet first asks the wallet that one thing (autoStep). While it is
       asked the key says the wallet's turn and the line what it shows; a wallet short of the HYPE for it gets Add money */
    var otN = AUTO.ot ? '' : autoOt(x, tp, sl, same && !(local && !none)), otShort = !!otN && !why && otView().short;
    if (otShort) why = OT_SHORT;
    txt(r.go, AUTO.ot ? CONFIRM : otShort ? 'Add money' : same && !(local && !none) ? 'Done' : same ? 'Save them' : fin ? 'Take the price offered' : none ? 'Remove both' : had ? 'Save changes' : tp != null && sl != null ? 'Set both' : tp != null ? 'Set take profit' : 'Set stop loss');
    cls(r.go, 'sm-btn is-primary' + (AUTO.ot ? ' is-busy' : ''));
    r.go.disabled = !!AUTO.ot || (!same && !fin && !!why && !otShort); r.go._add = otShort; r.off.disabled = !!AUTO.ot;
    /* v6, on chain: they close it with this page closed. That stands right above the key, in view on every phone (the
       reason a key is off comes first); under the boxes: how a stop fills, and that a change goes from the wallet
       without one-tap */
    var ch = !!(x.auto && x.auto.chain && !x.auto.paused);
    /* a stop the page saw reached that has not closed the trade yet is still owed its own price by the chain; the book
       keeps only the last two sets of levels, so changes made now can drop it. Said where the key is, before it is pressed */
    var cr = ch && x.auto.crossed && x.auto.crossed.which === 'sl' && x.auto.crossed.slow && x.auto.crossed.own ? x.auto.crossed : null;
    var owed = cr && !same ? 'Your stop loss was reached at ' + clockOf(cr.at) + ' and has not closed the trade yet. Changing it now can give up closing at its price.' : '';
    txt(r.say, AUTO.ot || why || owed || (ch ? CHAIN_ALWAYS : '')); cls(r.say, 'sm-say' + (AUTO.ot ? ' is-warn' : why && !autoWait(why) ? ' is-bad' : owed ? ' is-warn' : '')); show(r.say, !!AUTO.ot || !!why || ch);
    show(r.off, had && !none);
    var once = otN && !otShort ? otOnce(otN) : '';
    var fine = honest() + (!api.autoKept() ? ' This browser is not saving site data, so it lasts only while this tab is open.' : once ? ' ' + once : '');
    if (ch) fine = (sl != null ? chainStop(boostOf(x)) : '') + (once ? (sl != null ? ' ' : '') + once : '');
    else if (x.auto && x.auto.paused) fine = 'Paused on this market: while it is paused, they close this trade only while Confetti is open here. ' + fine;
    txt(r.fine, fine); show(r.fine, !!fine);
  }
  /* (v6) the quick picks of the card's sheet: take profit +25% / +50% / +100% of what went in, stop loss -25% / -50% of it
     and the furthest a stop can sensibly go (just before the price where the trade closes itself). A key puts its price
     in the box (the readout under it says what it does, as for a typed one); a pick that cannot be set now (the price is
     already past it) is off. The keys are made once and only their state changes, so nothing moves under the thumb. */
  function autoPicks(pid, r) {
    var pk = api.autoPicks ? api.autoPicks(pid) : null;
    [r.tp, r.sl].forEach(f => {
      var list = pk ? pk[f.kind] : null;
      if (!list || !list.length) { f.picks.hidden = true; return; }
      if (!f.pk.length) {
        list.forEach((it, i) => {
          var b = btn('sm-ak-pick', it.k, () => { var now = f.pk[i]; if (now.px == null || f.i.disabled) return; f.i.value = String(now.px); f.onInput(); });
          b.setAttribute('aria-label', (f.kind === 'tp' ? 'Take profit at ' : 'Stop loss at ') + (it.far ? 'the furthest it can go, just before the trade closes itself' : it.k.replace('−', 'minus ').replace('+', 'plus ') + ' of what you put in'));
          f.pk.push({ b: b, px: null }); add(f.picks, b);
        });
      }
      list.forEach((it, i) => { var k = f.pk[i]; if (!k) return; k.px = it.px; k.b.disabled = it.px == null; k.b.setAttribute('aria-pressed', it.px != null && num(f.i.value) === it.px ? 'true' : 'false'); });
      f.picks.hidden = false;
    });
  }
  /* One-tap for everyone, for a take profit and a stop loss: why this save needs the wallet's one step first ('' when it does
     not). A level on chain is sent now, and one this browser keeps closes the trade later, both through one-tap; only taking
     this browser's own levels off sends nothing. */
  function autoOt(x, tp, sl, nothing) {
    if (nothing || !x) return '';
    return (x.auto && x.auto.chain) || (api.autoChain && api.autoChain(x.sym)) || tp != null || sl != null ? otWhy() : '';
  }
  function otOnce(why) { return why === 'wait' ? '' : nb('Your wallet asks once to ' + (why === 'expired' ? 'renew' : why === 'gas' ? 'top up' : 'turn on') + ' one-tap trading. After that, no popups.'); }
  /* the step for a save: true when it was started (the save follows the wallet's yes, by `then`) */
  function autoStep(ot, then) {
    var pid = AUTO.pid;
    if (!ot) return false;
    AUTO.err = ''; AUTO.ot = otAsk(ot, 'Then your changes are saved.'); S.claim = true; paintAuto();
    otStep(null).then(() => { AUTO.ot = ''; S.claim = false; if (AUTO.pid === pid && AUTO.sh.isOpen) { paintAuto(); then(); } },      /* the key is its own again before it is pressed for the trader */
      e => { AUTO.ot = ''; S.claim = false; if (AUTO.pid === pid && AUTO.sh.isOpen) { AUTO.err = e.plain; paintAuto(); } });
    return true;
  }
  function autoGo(ev, stepped) {
    var r = AUTO.R, pid = AUTO.pid;
    if (pid == null || AUTO.ot || (stepped !== true && early()) || r.go.disabled) return;
    if (r.go._add) { AUTO.sh.close(); setTimeout(addMoneyAny, 200); return; }
    /* an unfinished number is taken first (as Pro's Save does): the box reads it again and the next press saves */
    if (r.tp.fin != null || r.sl.fin != null) { [r.tp, r.sl].forEach(f => { if (f.fin != null) f.i.value = String(f.fin); }); paintAuto(); return; }
    var tp = num(r.tp.i.value), sl = num(r.sl.i.value), x = autoOf(pid);
    if (tp === AUTO.was.tp && sl === AUTO.was.sl && !(x && x.auto && x.auto.local && (tp != null || sl != null))) { AUTO.sh.close(); return; }
    if (stepped !== true && autoStep(autoOt(x, tp, sl), () => { autoGo(null, true); })) return;
    var w = api.autoSet(pid, tp, sl);       /* Pro's checks once more, at the press */
    if (w) { AUTO.err = autoWait(w) ? '' : autoWhy(w); paintAuto(); return; }      /* a wait is not a refusal: the line above the button says it */
    AUTO.sh.close(); kick();      /* the card under the sheet now shows the new levels: that is the answer */
  }
  function autoOff(ev, stepped) {
    var pid = AUTO.pid; if (pid == null || AUTO.ot || (stepped !== true && early())) return;
    if (stepped !== true && !otView().short && autoStep(autoOt(autoOf(pid), null, null), () => { autoOff(null, true); })) return;
    var w = api.autoSet(pid, null, null);      /* v6: refused on a market whose levels are paused, with why */
    if (w) { AUTO.err = autoWhy(w); paintAuto(); return; }
    AUTO.sh.close(); kick();
  }

  /* ---- Close part and Add to this trade (v5; the owner, 2026-11-04: "can we make it so that you can close a % of your position",
     2026-11-19: "we are still doing top ups and partial closes right"). Under its take profit and stop loss every trade card has
     two keys. Each opens a sheet that is the face of the page's own dialog for it (trade.js pmOpen, through api.part): the dialog
     keeps the share or the amount, runs its checks, asks the exchange what would happen and sends; the sheet shows those figures
     (api.part.view) in Simple's words and hands every tap back. Nothing is worked out here.
     Close part: 25 / 50 / 75 % or All, or a typed percent, with what the trader takes now and what stays in the trade; one tap
     closes it (through one-tap when it is on; All is the card's own Close). The card then shows what is left and says what the
     part gave back; its take profit and stop loss stay on what is left.
     Add to this trade: an amount from the trading money, with where the trade closes itself now and after, how far each is from
     the price, and the boost now and after. The wallet confirms this one (one-tap cannot send it), and the sheet says so.
     A config before v5 has neither (x.can), and the end screen with its card comes only when a whole trade ends. ---- */

  var PART = { sh: null, pid: null, tab: '', R: {}, err: '', busy: '', run: null, max: false };
  /* the boost a trade runs at: the one it opened with until money is added to it */
  function boostOf(x) { return x.boost != null ? x.boost : x.lev; }
  function pillText(isLong, lev) { return (isLong ? '▲ UP' : '▼ DOWN') + (lev ? ' ' + lev + '×' : ''); }
  function pctS(bps) { return String(bps / 100) + '%'; }
  function secsS(n) { return n + (n === 1 ? ' second' : ' seconds'); }
  /* " 50%" for the Close key of a trade whose close on its way is for a part ("Closing 50%…"); '' for a whole one */
  function partOf(x) { var b = x.part || (COIN.closing === x.id ? COIN.part : 0); return b ? ' ' + pctS(b) : ''; }
  /* a trade card's top line. Its boost and what is in it change when a part closes or money is added: both are kept current */
  function posHead(c, x, who) {
    c.pill = sidePill(x.isLong, boostOf(x)); c.in = h('span', 'sm-in', usdS(x.margin) + ' in');
    return h('div', 'sm-pos-h', [h('span', null, [who, c.pill]), c.in]);
  }
  function headSet(c, x) { txt(c.pill, pillText(x.isLong, boostOf(x))); txt(c.in, usdS(x.margin) + ' in'); }
  /* the card's two keys, the same size, side by side under its take profit and stop loss; none where the exchange has neither */
  function partKeys(x) {
    if (!x.can || !api.part) return null;
    var who = ', ' + x.sym + (x.isLong ? ' up' : ' down');
    var k = { close: btn('sm-pk', 'Close part', () => { openPart(x.id, 'close'); }), add: btn('sm-pk', 'Add to this trade', () => { openPart(x.id, 'add'); }) };
    k.close.setAttribute('aria-label', 'Close part' + who); k.add.setAttribute('aria-label', 'Add to this trade' + who);
    /* under them, for a minute after either: what the part gave back, or what was added (nothing above it moves when it comes) */
    k.did = h('p', 'sm-say sm-pt-did', ''); k.did.setAttribute('aria-live', 'polite'); k.did.hidden = true;
    k.n = h('div', 'sm-pkb', [h('div', 'sm-pks', [k.close, k.add]), k.did]);
    return k;
  }
  /* off while a close of that trade (all of it, or a part) is on its way */
  function partKeysSet(k, x, off) {
    if (!k) return;
    k.close.disabled = k.add.disabled = !!off;
    var s = partSay(x), key = s.map(n => typeof n === 'string' ? n : n.textContent).join('');
    if (k.didKey !== key) { k.didKey = key; k.did.textContent = ''; add(k.did, s); }
    show(k.did, !!key);
  }
  /* what was last done to this trade, for a minute, in its card's own line: the part that closed, or the money added. In the
     end screen's own manner: a quiet sentence, the money in ink, the result in its colour and with its sign */
  function partSay(x) {
    var l = api.part ? api.part.last(x.id) : null;
    if (!l) return [];
    if (l.kind === 'part') return ['Closed ' + pctS(l.bps) + ': ', h('b', null, usd(l.paid)), ' is back in your trading money (', h('b', tone(l.pnl), usdP(l.pnl)), ').'];
    return ['Added ', h('b', null, usdS(l.amt)), '.'].concat(l.endPx > 0 ? [' It now closes itself at ', h('b', null, price(l.endPx, x.sz)), '.'] : []);
  }
  function openPart(pid, tab) {
    var x = autoOf(pid);
    if (!x || !x.can || early() || sheets.length || x.status || COIN.closing) return;
    if (!api.part.open(pid, tab)) return;
    var sh = PART.sh || (PART.sh = makeSheet('Part')), r = PART.R = {};
    PART.pid = pid; PART.tab = tab; PART.err = ''; PART.busy = ''; PART.run = null; PART.max = false;
    sh.title.textContent = ''; add(sh.title, [h('span', 'sr-only', tab === 'close' ? 'Close part: ' : 'Add to this trade: '), x.sym, sidePill(x.isLong, boostOf(x))]);
    sh.body.textContent = ''; sh.foot.textContent = '';
    r.say = sayLine(); r.go = btn('sm-btn is-primary', '', partGo); r.wal = h('p', 'sm-fine sm-pt-wal', '');
    if (tab === 'close') partCloseBuild(sh, r); else partAddBuild(sh, r);
    add(sh.foot, [r.say, r.go, r.wal]);
    sh.onClose = () => { PART.pid = null; PART.busy = ''; PART.run = null; api.part.shut(); };
    sh.open(); paintPart();
  }
  /* the typed percent sits right before its % sign: the field is as wide as what is in it, measured in its own face
     (a twin of the field's text, out of sight, in the same box) */
  function pctFit(i) {
    var m = i._m;
    if (!m) { m = i._m = h('span', 'sm-pct-m', ''); m.setAttribute('aria-hidden', 'true'); if (i.parentNode) i.parentNode.appendChild(m); }
    txt(m, i.value || i.placeholder || '0');
    var w = m.offsetWidth;
    if (w > 0) i.style.width = (w + 3) + 'px';
  }
  function partCloseBuild(sh, r) {
    var v = api.part.view() || {};
    r.pct = h('input'); r.pct.type = 'text'; r.pct.id = 'smPartPct'; r.pct.maxLength = 5; r.pct.placeholder = '0';
    r.pct.setAttribute('inputmode', 'decimal'); r.pct.setAttribute('enterkeyhint', 'done'); r.pct.setAttribute('autocomplete', 'off'); r.pct.setAttribute('aria-label', 'How much to close, in percent');
    r.pct.addEventListener('input', () => {
      /* digits and one dot, two decimals at most (the exchange takes hundredths of a percent) */
      var t = r.pct.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d{0,3})\d*((?:\.\d{0,2})?).*$/, '$1$2');
      if (t !== r.pct.value) r.pct.value = t;
      PART.err = ''; pctFit(r.pct); api.part.type(t); paintPart();
    });
    r.pct.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); r.pct.blur(); } });
    r.pct.addEventListener('focus', () => { setTimeout(() => { try { r.pct.select(); } catch (e) { /* fine */ } fitKeyboard(); }, 0); });
    var lab = h('label', 'sm-label is-amt', ['How much to close', h('span', 'sm-hint', 'Type any percent')]); lab.htmlFor = 'smPartPct';
    r.chips = h('div', 'sm-chips');
    (v.presets || []).forEach(b => {
      var k = btn(null, b >= 10000 ? 'All' : pctS(b), () => { if (PART.busy) return; PART.err = ''; api.part.pick(b); paintPart(); });
      k._v = b; r.chips.appendChild(k);
    });
    r.note = h('p', 'sm-fine sm-pt-note', ''); r.note.hidden = true;
    r.take = h('b', null, ''); r.stay = h('b', null, '');
    r.fine = h('p', 'sm-fine sm-pt-fine', '');
    add(sh.body, [lab, h('label', 'sm-amt is-mid is-pct', [r.pct, h('span', null, '%')]), r.chips, r.note,
      h('div', 'sm-out sm-pt-out', [h('div', null, [h('span', null, 'You take about'), r.take]), h('div', null, [h('span', null, 'Stays in the trade'), r.stay])]), r.fine]);
    /* it opens on half, the share most asked for; a trade too small to give up half opens on the most it can close in part
       (or on All, when it can only close in full), so the two boxes show the chain's figures at once, never two dashes */
    if (v.max >= 5000) api.part.pick(5000);
    else if (v.max >= 100) api.part.type(String(Math.floor(v.max / 100)));
    else if ((v.presets || []).indexOf(10000) >= 0) api.part.pick(10000);
  }
  function partAddBuild(sh, r) {
    var v = api.part.view() || {};
    r.amt = amtInput('smPartAmt', 'How much to add, in dollars', '', t => { PART.err = ''; PART.max = false; api.part.amount(t); paintPart(); });
    var lab = h('label', 'sm-label is-amt', ['How much to add', h('span', 'sm-hint', 'Type any amount')]); lab.htmlFor = 'smPartAmt';
    r.chips = h('div', 'sm-chips');
    [5, 10, 25, 'max'].forEach(a => {
      var k = btn(null, a === 'max' ? 'Max' : '$' + a, () => {
        if (PART.busy) return;
        var w = api.part.view(), t = a === 'max' ? (w ? String(partCap(w)) : '') : String(a);
        PART.err = ''; PART.max = a === 'max'; r.amt.value = t; api.part.amount(t); paintPart();
      });
      k._v = a; r.chips.appendChild(k);
    });
    r.from = h('p', 'sm-fine sm-pt-from', '');
    r.n1 = h('b', null, ''); r.n2 = h('i', null, ''); r.aLab = h('span', null, 'After'); r.a1 = h('b', null, ''); r.a2 = h('i', null, '');
    r.boost = h('span', null, '');
    r.fine = h('p', 'sm-fine sm-pt-fine', '');
    add(sh.body, [lab, h('label', 'sm-amt is-mid', [h('span', null, '$'), r.amt]), r.chips, r.from,
      h('div', 'sm-label sm-pt-lab', 'Closes itself at'),
      h('div', 'sm-out sm-pt-out is-ba', [h('div', null, [h('span', null, 'Now'), r.n1, r.n2]), h('div', null, [r.aLab, r.a1, r.a2])]),
      h('div', 'sm-kvs sm-pt-kv', kvRow('Boost', r.boost)), r.fine]);
    /* it opens on $10, or on what there is to add when that is less */
    var cap = partCap(v), first = cap >= 10 ? '10' : cap >= 5 ? '5' : cap > 0 ? String(cap) : '';
    PART.max = !!first && cap < 5;
    if (first) { r.amt.value = first; api.part.amount(first); }
  }
  /* the most that can be added: all the trading money, or what the trade can still take when that is less */
  function partCap(v) { return cents(Math.max(0, Math.min(v.available || 0, v.room || 0))); }
  function boostS(b) { return isFinite(b) ? b + '×' : '—'; }
  function paintPart() {
    var sh = PART.sh, r = PART.R;
    if (!sh || !sh.isOpen) return;
    var v = api.part.view(), x = PART.pid != null ? autoOf(PART.pid) : null;
    /* the dialog let go (the close was filed, the money is in, or the trade is gone): so does its face */
    if (!v || !x) { if (PART.busy === 'send') ffHand(sh); else sh.close(); return; }      /* (cf_FILLFEEL) a press on its way: the sheet gives way to the card quick off the mark */
    if (v.tab === 'close') partClosePaint(r, v); else partAddPaint(r, v);
  }
  function partClosePaint(r, v) {
    var busy = !!PART.busy, s = api.session(), min = usdS(v.min), most = v.max >= 100 ? pctS(Math.floor(v.max / 100) * 100) : '';
    each(r.chips, b => {
      b.setAttribute('aria-pressed', v.preset === b._v && v.bps === b._v ? 'true' : 'false');
      b.disabled = busy || (b._v < 10000 && b._v > v.max);
    });
    if (document.activeElement !== r.pct) { var t = v.bps ? String(v.bps / 100) : v.typed; if (r.pct.value !== t) r.pct.value = t; }
    pctFit(r.pct); r.pct.disabled = busy;
    var why = PART.err || (v.code === 'pending' ? 'A close of this trade is already on its way. Wait for it to finish.'
      : v.code === 'typed' ? 'Type a percent from 1 to 100.'
      : v.code === 'only' || (v.code === 'min' && !most) ? 'At least ' + min + ' stays in a trade, so this one can only be closed in full.'
      : v.code === 'min' ? 'That would leave less than ' + min + ' in the trade. Close up to ' + most + ', or all of it.'
      : v.err ? (v.errName === 'MarginBelowMinimum' ? 'That would leave less than ' + min + ' in the trade. Close less, or all of it.' : 'That could not be worked out just now. It is asked again by itself.') : '');
    /* a key that is off says why under the row, once: a small trade cannot give up much of itself */
    var note = why || v.max >= 7500 ? '' : most ? 'At least ' + min + ' stays in a trade, so you can close up to ' + most + ' of this one, or all of it.' : 'At least ' + min + ' stays in a trade, so this one can only be closed in full.';
    txt(r.note, note); show(r.note, !!note);
    txt(r.take, v.take != null ? usd(v.take) : v.wait ? 'Working it out…' : '—'); cls(r.take, v.take != null ? '' : 'is-off');
    txt(r.stay, v.stays == null ? '—' : v.full ? 'Nothing' : usd(v.stays)); cls(r.stay, v.stays == null ? 'is-off' : '');
    txt(r.fine, 'It closes in about ' + secsS(v.secs) + ', at the price then, so the amounts can move a little.');
    /* one-tap for everyone: the wallet's one step first (partGo), on the key and in the line while it is asked */
    var ot = PART.busy === 'ot';
    txt(r.say, ot ? PART.ot : why); cls(r.say, 'sm-say' + (ot ? ' is-warn' : why ? ' is-bad' : '')); show(r.say, ot || !!why);
    var word = ot ? CONFIRM : PART.busy === 'switch' ? 'Getting your wallet ready…' : PART.busy ? 'Closing…' : '';
    txt(r.go, word || (!v.ok ? 'Close part' : (v.full ? 'Close all' : 'Close ' + pctS(v.bps)) + (v.take != null ? ' · take about ' + usd(v.take) : '')));
    cls(r.go, 'sm-btn is-primary' + (word ? ' is-busy' : '')); r.go.disabled = !!word || !v.ok || v.take == null || !!v.busy;
    /* the quiet line under the key, only when the wallet has to say yes first: once, to set one-tap up (a wallet short of the
       HYPE for that, which confirms this close itself, is told so) */
    var once = PART.busy && !ot ? '' : otWhy(), ov = once ? otView() : null, wal = once ? (ov.short && ov.own ? 'Your wallet asks you to confirm.' : otOnce(once)) : !api.demo && !s.live ? 'Your wallet asks you to confirm.' : '';
    txt(r.wal, wal); show(r.wal, !!wal);
  }
  function partAddPaint(r, v) {
    var busy = !!PART.busy || !!v.sending, cap = partCap(v), amt = v.amt, now = v.now, af = v.after, sz = v.sz;
    r.amt.disabled = busy;
    each(r.chips, b => {
      b.setAttribute('aria-pressed', (b._v === 'max' ? PART.max : !PART.max && amt === b._v) ? 'true' : 'false');
      b.disabled = busy || !(cap > 0) || (b._v !== 'max' && b._v > cap + 1e-9);
    });
    txt(r.from, 'From your trading money: ' + usd(v.available));
    txt(r.n1, price(now.endPx, sz)); txt(r.n2, isFinite(now.away) ? roomFig(now.away) + ' away' : '');
    txt(r.aLab, amt > 0 && !v.code ? 'After adding ' + usdS(amt) : 'After');
    txt(r.a1, af ? price(af.endPx, sz) : v.wait ? 'Working it out…' : '—'); cls(r.a1, af ? '' : 'is-off');
    txt(r.a2, af && isFinite(af.away) ? roomFig(af.away) + ' away' : '');
    txt(r.boost, af ? boostS(now.boost) + ' → ' + boostS(af.boost) : boostS(now.boost));
    var gone = 'The price is already where this trade closes itself, so money cannot be added to it now.';
    var why = PART.err || (v.code === 'zero' ? 'Type an amount.'
      : v.code === 'full' ? 'This trade is at 1× boost already: it cannot take more money.'
      : v.code === 'bal' || (v.code === 'room' && amt > v.available + 1e-9 && v.available < v.room) ? 'That is more than your trading money (' + usd(v.available) + ').'
      : v.code === 'room' ? 'This trade can take up to ' + usd(v.room) + ' more.'
      : v.err ? (v.errName === 'PositionBusted' ? gone : v.errName === 'LeverageOutOfRange' ? 'This trade cannot take that much.' : 'That could not be worked out just now. It is asked again by itself.')
      : !v.sending && v.say ? (v.sayNo ? (/did not answer/.test(v.say) ? plain(v.say) : 'You cancelled in your wallet. Nothing was added.')
        : /Switch the wallet|another network/i.test(v.say) ? plain(v.say)
        : (v.sayName === 'PositionBusted' ? 'The price reached where this trade closes itself first. ' : '') + 'It was not added: your ' + usdS(amt) + ' is still in your trading money.')
      : !(cap > 0) && !(v.room > 0) ? 'This trade is at 1× boost already: it cannot take more money.'
      : !(cap > 0) ? 'There is no trading money to add from.' : '');
    txt(r.say, why); cls(r.say, 'sm-say' + (why ? ' is-bad' : '')); show(r.say, !!why);
    /* said before the tap, truthfully: in a market on the fast price the money counts from the next second's price on, and
       comes back if the trade had closed itself on an earlier one */
    txt(r.fine, v.fast ? 'It counts from the next second on. If the trade has closed itself by then, this money comes straight back to you.' : 'It counts at once.');
    var word = PART.busy === 'switch' ? 'Getting your wallet ready…' : v.sending ? (v.sent ? 'Adding ' + usdS(amt) + '…' : CONFIRM) : PART.busy ? CONFIRM : '';
    txt(r.go, word || (amt > 0 && !v.code ? 'Add ' + usdS(amt) : 'Add to this trade'));
    cls(r.go, 'sm-btn is-primary' + (word ? ' is-busy' : '')); r.go.disabled = !!word || !v.ok || !!v.busy;
    txt(r.wal, 'Your wallet asks you to confirm this one.'); show(r.wal, true);
  }
  function partGo(ev, stepped) {
    var r = PART.R, v = api.part.view(), s = api.session(), pid = PART.pid, close = !!v && v.tab === 'close';
    if (!v || PART.busy || (stepped !== true && early()) || r.go.disabled) return;
    PART.err = '';
    if (close && v.full) { ffHand(PART.sh); closeGo(pid); return; }      /* All: the card's own Close, by its own path */
    /* one-tap for everyone: a part close that one-tap cannot carry yet first asks the wallet that one thing (otStep), then
       goes out through one-tap. A no leaves its line and the same key; a wallet short of the HYPE for it is sent to Add money,
       unless it can still pay for one send itself: that one confirms this close in the wallet, as before */
    var ot = close && stepped !== true ? otWhy() : '', ov = ot ? otView() : null;
    if (ot && !(ov.short && ov.own)) {
      var run0 = PART.run = {};
      PART.busy = 'ot'; PART.ot = otAsk(ot, 'Then the part closes.'); S.claim = true; S.lastErr = null; paintPart();
      otStep(null).then(() => {
        S.claim = false; if (PART.run !== run0) return;
        PART.busy = ''; PART.run = null; if (PART.pid === pid && PART.sh.isOpen) { paintPart(); partGo(null, true); }
      }, e => {
        S.claim = false; if (PART.run !== run0) return;
        PART.busy = ''; PART.run = null; PART.err = e.plain;
        if (e.add && PART.sh.isOpen) { COIN.errs[pid] = e.plain; PART.sh.close(); setTimeout(addMoneyAny, 250); } else if (PART.sh.isOpen) paintPart();
      });
      return;
    }
    /* when the wallet itself signs (the add always; a part close only while one-tap is not on) it is asked onto HyperEVM first,
       as Close does; that wait ends by itself, and a sheet closed meanwhile sends nothing */
    var wallet = !api.demo && (!close || !s.live), run = PART.run = {};
    PART.busy = wallet ? 'switch' : 'send'; S.lastErr = null; paintPart();
    (wallet ? timed(api.toHyperEvm(), 30000, '') : Promise.resolve()).then(() => {
      if (PART.run !== run || PART.pid !== pid || !PART.sh.isOpen) return null;
      PART.busy = 'send'; S.claim = true;
      if (close) {
        COIN.errs[pid] = ''; COIN.closing = pid; COIN.part = v.bps;
        /* (cf_FILLFEEL) the card shows the smaller trade at once (ffPartLook), by the sheet's own figures */
        var px = autoOf(pid); if (px && v.take != null) FF.part[pid] = { bps: v.bps, take: v.take, stays: v.stays, pnl: isFinite(px.pnl) ? px.pnl * v.bps / 10000 : 0, at: Date.now() };
      }
      paintPart();
      return api.part.go();
    }).then(ok => {
      /* a part close the sheet let go of that was then not filed: said on the card, where Close's own failure is said */
      if (ok === false && close && !(PART.pid === pid && PART.sh.isOpen && api.part.view())) COIN.errs[pid] = lastErr() || 'It did not close, so all of your trade is still open. Try again.';
    }, () => { if (PART.run === run) PART.err = STAYED + (close ? 'nothing was closed.' : 'nothing was added.') + ' Press again and let it change.'; }).then(() => {
      if (PART.run === run) { PART.busy = ''; PART.run = null; }
      S.claim = false; if (close && COIN.closing === pid) { COIN.closing = null; COIN.part = 0; }
      kick();
    });
  }

  /* ---- FETTI levels and money back (the owner, 2026-11-19: "i want fetti to be an exchange token", "plan it i want it part
     of v5", then "yes on all"; cf_w/fetti_token/PLAN.md, section 3.5). Stake a little FETTI and part of what your own trades
     paid in comes back to your trading money, 7 days after each trade, if the FETTI stayed staked. fetti.js holds the rules,
     the reads and the three wallet steps; this is how Simple shows them: one key on Home, the level sheet, one line on a
     trade's result, the Menu's $FETTI line, the Add money share, the level on the trade card. It never names what a trade
     costs: "what your trades paid in", "money back". Nothing here pays anyone: the perks bot does, from its own wallet. ---- */

  var LV = { sh: null, pick: 0, R: {}, busy: 0, step: null, err: '', done: null, built: '' };

  /* the key shows for a wallet that trades (money in, or in trades), with the switch on, unless the bot leaves it out */
  function fxShow(w, st) { var F = fx(), m; return !!(F && w.account && st === 'money' && !((m = F.mine(w.account)) && m.skip)); }
  function fxCard() {
    var c = noteCard();
    c.n.classList.add('sm-fx-note');
    c.icon.className = 'sm-pill sm-fx-ic';
    c.n.addEventListener('click', () => { openLevels(); });
    return c;
  }
  /* the key's two lines, by where the wallet stands: money on its way, a level, a stake still warming, or nothing yet */
  function fxWords(acct) {
    var F = fx(), s = F.standing(acct), m = F.mine(acct), l1 = F.level(1), hold = F.holdDays();
    if (s.known && s.level > 0 && m && m.pending >= 0.01) {
      return { b: 'Coming back to you: ' + usd(m.pending), i: m.next && m.next.usd >= 0.01 ? 'Next: ' + usd(m.next.usd) + ' on ' + F.fmt.day(m.next.at) + '.' : 'It lands ' + hold + ' days after each trade.', on: true };
    }
    if (s.known && s.level > 0) return { b: 'Level ' + s.level + ': ' + F.pctOf(s.level) + '% back on every trade', i: 'It lands ' + hold + ' days after each trade.', on: true };
    if (s.known && s.warming > 0 && s.soon > 0) return { b: 'Level ' + s.soon + ' starts at ' + F.fmt.clock(s.warmAt), i: 'Staked FETTI counts after a one-hour wait.', on: true };
    var q = l1 ? F.quote(l1.fetti) : null;
    return { b: 'Get money back on every trade', i: 'Stake a little FETTI.' + (q && q.usd > 0 ? ' Level 1 is about ' + F.fmt.about(q.usd) + '.' : ''), on: false };
  }
  function fxFill(c) {
    var F = fx(), acct = api.wallet().account;
    if (!F || !acct) return;
    F.loadMe(acct, 60000); F.loadPerks(); F.loadPool(120000);      /* cheap: each one reads only when its last read is that old */
    var w = fxWords(acct);
    txt(c.b, w.b); txt(c.i, w.i); txt(c.icon, w.on ? '+$' : '%');
    c.n.setAttribute('aria-label', w.b + '. ' + w.i + ' Open the levels');
  }
  function fxMenuHint(w) {
    var F = fx(); if (!F) return 'the token';
    var s = w.account ? F.standing(w.account) : null;
    return s && s.known && s.level > 0 ? 'Level ' + s.level + ' · ' + F.pctOf(s.level) + '% back' : 'money back on trades';
  }
  /* the level on the trade card (share.js draws a small badge): 0 draws none */
  function fxBadge() { var F = fx(), a = api.wallet().account; if (!F || !a) return 0; var s = F.standing(a); return s.known ? s.level : 0; }

  /* what a trade put in that money back counts (v5: what opening it took, and closing it unless it closed itself), and
     whether it paid the capped share instead of the full rate (money back leaves those out). From the card's last figures. */
  function fxPaid(seen, liq) {
    if (!seen || !(seen.stake > 0)) return null;
    var open = Math.max(0, seen.margin - seen.stake - (seen.added || 0)), close = liq ? 0 : Math.max(0, seen.cc || 0);
    var tf = api.cfg().tradeFee || {}, cap = (tf.capBps != null ? Number(tf.capBps) : 1000) / 10000;
    return { open: open, close: close, liq: !!liq, ts: Date.now() / 1000, capped: seen.cc > 0 && seen.cc >= seen.stake * cap * 0.999 };
  }
  /* the result's one line: a staker hears what comes back and when; anyone else what Level 1 would bring, with a way there */
  function fxLine(d) {
    var F = fx(), acct = api.wallet().account;
    if (!F || !acct || !d.paidIn) return null;
    var s = F.standing(acct), t = { account: acct, open: d.paidIn.open, close: d.paidIn.close, liq: d.paidIn.liq, ts: d.paidIn.ts, capped: d.paidIn.capped };
    if (s.known && s.level > 0) {
      var b = F.tradeBack(t);
      return b ? h('p', 'sm-fine sm-fx-line', (b.upTo ? 'Up to ' : 'About ') + usd(b.usd) + ' of this trade comes back to you on ' + F.fmt.day(b.at) + ', if your FETTI stays staked.') : null;
    }
    var b1 = F.tradeBack(t, 1);
    if (!b1) return null;
    return h('div', 'sm-fx-line', [h('p', 'sm-fine', 'With Level 1, about ' + usd(b1.usd) + ' of this trade would come back to you.'), btn('sm-link sm-fx-go', 'See the levels', () => { openLevels(); })]);
  }

  /* ---- the level sheet: four level keys, what one costs today, one black key, three wallet steps ---- */

  function openLevels(n) {
    var F = fx(), w = api.wallet();
    if (!F) return;
    if (!w.account) { doConnect(); return; }
    var sh = LV.sh || (LV.sh = makeSheet('Levels')), s = F.standing(w.account), top = F.levels().length;
    LV.pick = n >= 1 && n <= top ? n : Math.min(top, (s.known ? Math.max(s.level, s.soon || 0) : 0) + 1);
    LV.err = ''; LV.done = null; LV.step = null; LV.built = '';
    sh.onClose = () => { LV.busy = 0; LV.step = null; };      /* a closed sheet ends the run: no further step is asked */
    sh.open();
    F.loadMe(w.account, true); F.loadPerks(); F.loadPool(true);
    paintLevels();
  }
  function paintLevels() {
    var F = fx(), acct = api.wallet().account;
    if (!F || !acct) { LV.sh.close(); return; }
    var view = LV.done ? 'done' : 'levels';
    if (LV.built !== view) { LV.built = view; if (view === 'done') lvBuildDone(); else lvBuild(); }
    if (view === 'levels') { lvFill(); lvWait(); } else lvWait();
  }
  function lvBuild() {
    var F = fx(), sh = LV.sh, r = LV.R = {};
    txt(sh.title, 'Money back'); sh.body.textContent = ''; sh.foot.textContent = '';
    var old = sh.d.querySelector('.sm-wait'); if (old) old.remove();
    r.group = h('div', 'sm-fx-levels'); r.group.setAttribute('role', 'radiogroup'); r.group.setAttribute('aria-label', 'Levels');
    r.rows = F.levels().map(l => {
      var x = { l: l, cost: h('i'), tag: h('em', 'sm-fx-tag', '') };
      x.n = btn('sm-pick sm-fx-lv', [h('span', 'sm-radio'), h('span', 'sm-t', [h('b', null, ['Level ' + l.n, h('span', 'sm-fx-pct', l.pct + '% back')]), x.cost]), x.tag], () => {
        if (LV.busy) return;
        LV.pick = l.n; LV.err = ''; paintLevels();
      });
      x.n.setAttribute('role', 'radio');
      r.group.appendChild(x.n);
      return x;
    });
    r.would = h('p', 'sm-fx-would', '');
    r.cost = h('span', 'is-go', ''); r.how = h('span', null, '');
    r.sum = h('div', 'sm-sum', [h('div', 'sm-sumrow', [h('span', null, 'It costs'), r.cost]), h('div', 'sm-sumrow', [h('span', null, 'From your wallet'), r.how])]);
    r.fine = h('p', 'sm-fine', '');
    add(sh.body, [h('p', 'sm-mid sm-fx-lead', 'Stake a little FETTI and part of what your trades pay in comes back to your trading money.'), r.group, r.would, r.sum, r.fine]);
    r.say = sayLine();
    r.go = btn('sm-btn is-primary', '', lvGo);
    add(sh.foot, [r.say, r.go]);
  }
  function lvFill() {
    var F = fx(), r = LV.R, acct = api.wallet().account, s = F.standing(acct), m = F.mine(acct), have = s.known ? s.level : 0;
    var p = F.plan(acct, LV.pick), busy = !!LV.busy, hold = F.holdDays();
    r.rows.forEach(x => {
      var l = x.l, q = F.quote(l.fetti);
      x.n.setAttribute('aria-checked', LV.pick === l.n ? 'true' : 'false'); x.n.disabled = busy;
      txt(x.cost, F.fmt.fetti(l.fetti) + (q ? ' · about ' + F.fmt.about(q.usd) : ''));
      txt(x.tag, have >= l.n ? (have === l.n ? 'Yours' : '✓') : s.soon >= l.n ? 'Soon' : '');
      show(x.tag, !!x.tag.textContent);
    });
    /* what this wallet's own trades would have brought (perks.json); said only when there is such a number */
    var wv = m && m.would && m.would[LV.pick - 1] > 0 ? m.would[LV.pick - 1] : null;
    txt(r.would, wv != null ? 'Your trades of the last 30 days would have brought back ' + usd(wv) + ' at Level ' + LV.pick + '.' : ''); show(r.would, wv != null);
    var cost = '…', how = '…', label = 'Get Level ' + LV.pick, why = '', note = '', fine = '';
    var steps = 'It lands ' + hold + ' days after each trade if your FETTI stayed staked. FETTI’s price moves: what you stake can be worth less later.';
    if (!F.canSend()) why = 'Getting a level is off on this copy of the site.';
    if (!p || p.loading) { note = s.known ? 'Getting today’s price…' : 'Looking in your wallet…'; fine = steps; }
    else if (p.done) {
      cost = '—'; how = '—'; label = 'Level ' + LV.pick + ' is yours';
      note = LV.pick < F.levels().length ? 'Pick a higher level to get more back.' : 'That is the top level.';
      fine = 'Unstaking gives up what is on its way to you. ' + steps;
    } else {
      cost = p.usd > 0 ? usd(p.usd) : 'nothing more';
      how = p.buy > 0 ? ethS(p.hypeIn) + ' HYPE' : F.fmt.fetti(p.need);
      label = p.usd > 0 ? 'Get Level ' + LV.pick + ' for ' + usd(p.usd) : 'Stake ' + F.fmt.fetti(p.need) + ' for Level ' + LV.pick;
      var n = p.steps.length, list = p.steps.map(x => ({ buy: 'buy FETTI with HYPE', approve: 'let Staking take it', stake: 'stake it' })[x]);
      fine = (n === 1 ? 'One confirmation in your wallet: ' : (n === 2 ? 'Two' : 'Three') + ' confirmations in your wallet, one after the other: ') + list.join(', ') + '. ' +
        (p.buy > 0 && p.move > 0.02 ? 'This buy moves FETTI’s price up ' + (p.move * 100).toFixed(1) + '%. ' : '') + 'It counts after a one-hour wait. ' + steps;
      why = why || p.why || '';
    }
    txt(r.cost, cost); txt(r.how, how); txt(r.fine, fine);
    show(r.sum, !(p && p.done));
    var err = LV.err;
    txt(r.say, why || err || note); cls(r.say, 'sm-say' + (why || err ? ' is-bad' : ''));
    var word = busy ? (LV.step ? LV.step.i + ' of ' + LV.step.of + ' · ' + CONFIRM : 'Getting your wallet ready…') : '';
    txt(r.go, word || label);
    cls(r.go, 'sm-btn is-primary' + (word ? ' is-busy' : ''));
    r.go.disabled = !!word || !!why || !p || !!p.loading || !!p.done;
  }
  /* the wallet is open on a step: which one, what it asks, a way out (as Add money's) */
  function lvWait() {
    var sh = LV.sh, st = LV.busy ? LV.step : null, n = sh.d.querySelector('.sm-wait'), F = fx();
    if (!st) { if (n) n.remove(); return; }
    if (!n) {
      n = h('div', 'sm-wait', h('div', null, [h('span', 'sm-spin is-big'), h('h3', null, 'Confirm in your wallet'), h('p'), btn('sm-btn is-ghost', 'Cancel', () => { LV.busy = 0; LV.step = null; LV.err = CANCELLED; paintLevels(); })]));
      sh.d.appendChild(n);
    }
    var p = n.querySelector('p'), pl = st.p, key = st.i + st.word;
    if (p._k === key) return;
    p._k = key; p.textContent = '';
    var what = st.word === 'buy' ? ['Your wallet asks to buy ', h('b', null, F.fmt.fetti(pl.buy * 1.01)), ' with ', h('b', null, ethS(pl.hypeIn) + ' HYPE'), '.']
      : st.word === 'approve' ? ['Your wallet asks to let Confetti Staking take the FETTI for this level, and no more.']
      : ['Your wallet asks to stake ', h('b', null, 'the FETTI for Level ' + pl.n), '.'];
    add(p, [h('b', 'sm-fx-of', st.i + ' of ' + st.of + '. ')].concat(what, [' Nothing is sent until you confirm.']));
  }
  function lvGo() {
    var F = fx(), w = api.wallet(), acct = w.account;
    if (!F || !acct || LV.busy || early()) return;
    var p = F.plan(acct, LV.pick);
    if (!p || p.loading || p.done || p.why || !F.canSend()) return;
    var mine = LV.busy = Date.now() + Math.random(), alive = () => LV.busy === mine && LV.sh.isOpen;
    LV.err = ''; LV.step = null; paintLevels();
    /* the wallet onto HyperEVM first (the demo has none); then the steps, each one confirmed in the wallet */
    (api.demo ? Promise.resolve() : timed(api.toHyperEvm(), 30000, STAYED + 'nothing was sent. Press again and let it change.')).then(() => {
      if (!alive()) throw say(CANCELLED);
      return F.run(acct, p, w.eth, (i, of, word) => { if (alive()) { LV.step = { i: i, of: of, word: word, p: p }; paintLevels(); } }, alive);
    }).then(res => {
      if (LV.busy !== mine) return;
      LV.busy = 0; LV.step = null; LV.done = { n: LV.pick, staked: res.staked };
      paintLevels(); S.sig = ''; kick();
    }, e => {
      if (LV.busy !== mine) return;
      var at = LV.step, first = !at || at.i <= 1;
      LV.busy = 0; LV.step = null;
      LV.err = e && e.cancelled ? CANCELLED : first ? errText(e) : errText(e).replace(/ Nothing was sent\.$/, '') + ' Step ' + at.i + ' of ' + at.of + ' did not finish; what went through stays in your wallet. Press again to finish.';
      F.loadMe(acct, true);
      if (LV.sh.isOpen) paintLevels();
    });
  }
  function lvBuildDone() {
    var F = fx(), sh = LV.sh, d = LV.done, hold = F.holdDays();
    txt(sh.title, 'Money back'); sh.body.textContent = ''; sh.foot.textContent = '';
    add(sh.body, [h('div', 'sm-ok', '✓'), h('div', 'sm-label', 'Level ' + d.n + ' is on'),
      h('p', 'sm-mid', 'You staked ' + F.fmt.fetti(d.staked) + '. It counts after a one-hour wait. From then on ' + F.pctOf(d.n) + '% of what each trade pays in comes back to your trading money, ' + hold + ' days after the trade.'),
      h('p', 'sm-fine', 'Unstaking gives up what is on its way to you. The $FETTI page shows your level and lets you unstake any time.')]);
    add(sh.foot, btn('sm-btn is-primary', 'Done', () => { sh.close(); }));
  }

  /* ---- the weekly draw (config.json fetti.draw.on; off until the owner turns it on, with its line in the terms) ---- */

  var DRW = { sh: null };
  function fxDrawHint(w) {
    var F = fx(), d = F && F.draw();
    return d && d.prize > 0 ? 'win ' + usd(d.prize) + (d.drawAt ? ' on ' + F.fmt.day(d.drawAt) : '') : 'for stakers who trade';
  }
  function openDraw() {
    var F = fx(), w = api.wallet();
    if (!F || !F.drawOn()) return;
    var sh = DRW.sh || (DRW.sh = makeSheet('Draw'));
    var fill = () => {
      var d = F.draw(), t = d && w.account ? d.tickets[w.account.toLowerCase()] || 0 : 0;
      txt(sh.title, 'Weekly draw'); sh.body.textContent = ''; sh.foot.textContent = '';
      add(sh.body, [h('div', 'sm-label', 'This week’s prize'), h('div', 'sm-big', d ? usd(d.prize) : '$—'),
        h('p', 'sm-mid', d && d.drawAt ? 'Drawn on ' + F.fmt.day(d.drawAt) + ' at ' + F.fmt.clock(d.drawAt) + '.' : 'Drawn once a week.'),
        h('div', 'sm-sum', [h('div', 'sm-sumrow', [h('span', null, 'Your tickets'), h('span', 'is-go', String(Math.floor(t)))]), h('div', 'sm-sumrow', [h('span', null, 'All tickets'), h('span', null, d ? String(Math.floor(d.total)) : '—')])]),
        h('p', 'sm-fine', 'Each dollar your trades paid this week is one share of the chances, for wallets that keep a FETTI level all week. The prize lands in the winner’s trading money. The full rules are in the terms.')]);
      add(sh.foot, btn('sm-btn is-primary', 'Close', () => { sh.close(); }));
    };
    fill(); sh.open();
    F.loadDraw(true).then(() => { if (sh.isOpen) fill(); });
  }

  /* ---- Refer friends (the owner, 2026-11-21: "switch the refer site to the new layout"). The menu's Refer friends used to
     throw the whole page into Pro to show Pro's Refer tab; now it opens this sheet. The sheet is that tab's face and no more:
     trade.js keeps the tab filled in out of sight (the code, what it earned, who referred this wallet, the extra codes), and
     the sheet shows what the tab shows and presses the tab's own keys: its Register form, its Create code form, its Claim
     key. Every check, contract call and refusal is therefore Pro's own, and nothing here builds a transaction.
     Two figures are also read here, by the view calls the tab itself makes, so that they are live while the sheet is open:
     the share (referralShareBps: the page never writes that number itself) and what the main code has earned
     (referralEarned). The card keeps one shape in every wallet state: the link or the box to make it, its keys, its QR code.
     Simple has its own words for what a trade costs: a friend's trades "pay in". ---- */

  /* run: the send in hand ('make' | 'create' | 'claim'), step: where it is ('ask' the tab, 'net' the wallet's network, 'chain' sent);
     ring: the box a refusal was about, ringed red until the next press or keystroke; got: the fresh earned figure and whose it is */
  var REF = { sh: null, R: null, f: null, watch: null, timer: 0, canShare: false, more: false, run: '', step: '', code: '', moved: false, sync: false, seq: 0,
    say: '', bad: false, ring: '', bps: null, asking: false, got: null, rows: null };
  var REF_SITE = 'confetti.trade/?ref=', REF_RULES = '3 to 16 characters: a-z, 0-9, underscore. One per wallet, for good.';
  function refLink(code) { return 'https://' + REF_SITE + code; }
  /* a line of Pro's Refer tab, as it stands */
  function proText(id) { var n = $(id); return n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  /* What the tab shows for this wallet. state: none (no wallet), load (not read yet), make (no code: the tab offers its
     Register form), have. more: the tab offers extra codes (its factory is in and checked); rows: each one's name, link, what
     it earned and what a claim would send; due: what the tab's Claim key would send now, '' when it has nothing to send. */
  function refView() {
    var w = api.wallet(), code = w.account ? refCode() : '', form = $('referForm'), box = $('rfMore'), claim = $('vaultClaim'), list = $('rfVaults'), rows = [];
    var more = !!(w.account && box && !box.hidden);
    if (more && list) each(list, row => {
      var a = row.querySelector('.kv-key a'), s = row.querySelector('.kv-val span'), m = /^(.*?) earned(?: · (.*?) to claim)?$/.exec(s ? String(s.textContent || '') : '');
      rows.push({ name: a ? String(a.textContent || '') : '', link: a ? a.getAttribute('href') || '' : '', earned: m ? m[1] : '', due: m && m[2] ? m[2] : '' });
    });
    return {
      account: w.account || '', code: code, state: !w.account ? 'none' : code ? 'have' : form && !form.hidden ? 'make' : 'load',
      earned: proText('rfEarned'), by: proText('rfBy'), more: more, total: proText('rfMoreTotal'), rows: rows,
      due: more && claim && !claim.hidden ? (/^Claim (\S+)/.exec(proText('vaultClaim')) || [])[1] || '' : ''
    };
  }
  /* the two live figures: the same view calls as the tab's, on the registry config.json names */
  function refAsk(fn, args) {
    var to = String((api.cfg().contracts || {}).referrals || '');
    if (!E || !/^0x[0-9a-fA-F]{40}$/.test(to)) return Promise.reject(new Error('no registry'));
    var f = REF.f || (REF.f = new E.Interface(['function referralShareBps() view returns (uint16)', 'function referralEarned(address referrer) view returns (uint256)']));
    return rpc(api.chainId, 'eth_call', [{ to: to, data: f.encodeFunctionData(fn, args) }, 'latest']).then(hex => f.decodeFunctionResult(fn, hex)[0]);
  }
  /* the share: asked until it is known, then kept for this page view */
  function refShare() {
    if (REF.bps != null || REF.asking) return;
    REF.asking = true;
    refAsk('referralShareBps', []).then(v => { REF.bps = Number(v); }, noop).then(() => {
      REF.asking = false;
      var i = MENU.ref && MENU.ref.querySelector('i'); if (i) txt(i, refMenuHint());
      paintRefer();
    });
  }
  function refPct() { return REF.bps != null && isFinite(REF.bps) ? String(Number((REF.bps / 100).toFixed(2))) + '%' : ''; }
  function refMenuHint() { return 'earn ' + (refPct() || 'USDC'); }
  function refEarned() {
    var a = api.wallet().account;
    if (!a || api.demo) return;
    refAsk('referralEarned', [a]).then(v => { if (api.wallet().account === a) { REF.got = { a: a, n: Number(v) / 1e6 }; paintRefer(); } }, noop);
  }
  function refSay(s, bad, ring) { REF.say = s || ''; REF.bad = !!bad; REF.ring = ring || ''; paintRefer(); }
  function refEnd(s, bad, ring) { REF.run = ''; REF.step = ''; REF.moved = false; ++REF.seq; if (!bad) refEarned(); refSay(s, bad, ring); }
  /* a code box: only what a code may hold gets in (a-z, 0-9, underscore; capitals come in small), up to 16 */
  function refInput(id, label, hold, go) {
    var i = h('input'); i.type = 'text'; i.id = id; i.maxLength = 16; i.placeholder = hold; i.spellcheck = false;
    i.setAttribute('aria-label', label); i.setAttribute('autocomplete', 'off'); i.setAttribute('autocapitalize', 'none'); i.setAttribute('autocorrect', 'off'); i.setAttribute('enterkeyhint', 'go');
    i.addEventListener('input', () => { var c = i.value.toLowerCase().replace(/[^a-z0-9_]/g, ''); if (c !== i.value) i.value = c; if (REF.say && !REF.run) refSay(''); });
    i.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
    i.addEventListener('focus', () => { setTimeout(fitKeyboard, 0); });
    return i;
  }
  function openRefer() {
    var sh = REF.sh;
    if (!sh) {
      sh = REF.sh = makeSheet('Refer', true); sh.d.classList.add('is-rf');
      sh.body.addEventListener('scroll', refEdge, { passive: true });
      refBuild();
    }
    REF.say = ''; REF.bad = false; REF.ring = ''; REF.more = false;
    sh.onClose = () => { clearInterval(REF.timer); REF.timer = 0; REF.run = ''; REF.step = ''; REF.moved = false; ++REF.seq; };      /* a send already with the wallet goes on as Pro's own */
    sh.open();
    /* whatever the tab changes shows here at once */
    var tab = $('panelRefer');
    if (!REF.watch && tab && typeof MutationObserver === 'function') {
      REF.watch = new MutationObserver(() => { if (REF.sh.isOpen) { refRefused(); paintRefer(); } });
      REF.watch.observe(tab, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'disabled'] });
    }
    refShare(); refEarned();
    clearInterval(REF.timer);
    REF.timer = setInterval(() => { if (!document.hidden) { refShare(); refEarned(); } }, 20000);
    paintRefer();
  }
  function refBuild() {
    var sh = REF.sh, r = REF.R = {};
    REF.canShare = typeof navigator.share === 'function';
    txt(sh.title, 'Refer friends');
    /* the card */
    r.lab = h('div', 'sm-label', ''); r.rate = h('span', 'sm-pill is-up', '');
    r.pitchB = h('b', null, ''); r.pitchT = h('span', null, '');
    r.pitch = h('div', 'sm-rf-pitch', [r.pitchB, r.pitchT, h('span', null, 'You get it in USDC.')]);
    r.code = h('b', 'sm-rf-code', '');
    r.in = refInput('smRefCode', 'Your code', 'your_code', () => { refGo('make', r.in.value); });
    r.link = h('div', 'sm-rf-link', [h('span', 'sm-rf-pre', REF_SITE), r.code, r.in]);
    r.link.addEventListener('click', ev => { if (ev.target !== r.in && !r.in.hidden && !r.in.disabled) r.in.focus(); });
    r.copy = btn('sm-btn is-ghost', 'Copy link', () => { var c = refCode(); if (c) copyText(refLink(c), r.copy); });
    r.share = btn('sm-btn is-primary', 'Share', refShareGo);
    r.make = btn('sm-btn is-primary is-wide', 'Make my code', () => { refGo('make', r.in.value); });
    r.keys = h('div', 'sm-rf-keys', [r.copy, r.share, r.make]);
    r.qr = h('canvas', 'sm-rf-qr'); r.qr.setAttribute('role', 'img'); r.qr.setAttribute('aria-label', 'QR code of your link'); r.qr.hidden = true;
    r.qrOff = h('div', 'sm-rf-qr is-off', [h('i'), h('i'), h('i')]); r.qrOff.setAttribute('aria-hidden', 'true');      /* where the QR code will stand: its three corner marks, faint */
    r.tipB = h('b', null, ''); r.tipT = h('span', null, '');
    r.strip = h('div', 'sm-rf-show', [r.qr, r.qrOff, h('p', 'sm-rf-tip', [r.tipB, r.tipT])]);
    r.pass = h('div', 'sm-rf-pass', [h('div', 'sm-rf-head', [r.lab, r.rate]), r.pitch, r.link, r.keys, r.strip]);
    /* what it has earned, and the extra codes' money when some waits */
    r.amt = h('span', null, ''); r.note = h('p', 'sm-fine', '');
    r.claimT = h('span', null, ''); r.claim = btn('sm-btn is-ghost', '', () => { refGo('claim'); });
    r.claimRow = h('div', 'sm-rf-claim', [r.claimT, r.claim]);
    r.earn = h('div', 'sm-rf-earn', [h('div', 'sm-label', 'Earned so far'), h('div', 'sm-big', [r.amt, h('small', null, 'USDC')]), r.note, r.claimRow]);
    r.how3 = h('li', null, '');
    r.byV = h('span', null, ''); r.by = h('div', 'sm-kv', [h('span', null, 'Referred by'), r.byV]);
    r.how = h('div', 'sm-rf-how', [h('div', 'sm-label', 'How it works'), h('ol', null, [h('li', null, 'Send your link, or show its QR code.'), h('li', null, 'Your friend makes a first trade on confetti.'), r.how3]), r.by]);
    /* more codes: quiet, behind one key */
    r.moreSum = h('span', null, '');
    r.moreKey = btn('sm-rf-more', [h('span', 'sm-t', [h('b', null, 'More codes'), r.moreSum]), h('i', null, '›')], () => { REF.more = !REF.more; paintRefer(); });
    r.list = h('div', 'sm-rf-list');
    r.vin = refInput('smRefMore', 'Another code', 'another_code', () => { refGo('create', r.vin.value); });
    r.vbox = h('div', 'sm-rf-box', r.vin);
    r.vgo = btn('sm-btn is-ghost', 'Create code', () => { refGo('create', r.vin.value); });
    r.codes = h('div', 'sm-rf-codes', [h('p', 'sm-fine', 'Each extra code is a small contract of its own that pays only you. What it earns waits there until you claim it to your wallet.'),
      r.list, h('div', 'sm-label', 'Make another code'), h('div', 'sm-rf-new', [r.vbox, r.vgo])]);
    r.codes.id = 'smRefCodes'; r.moreKey.setAttribute('aria-controls', r.codes.id);
    add(sh.body, [r.pass, r.earn, r.how, r.moreKey, r.codes]);
    r.say = sayLine();
    r.go = btn('sm-btn is-primary', '', doConnect);
    add(sh.foot, [r.say, r.go]);
  }
  function paintRefer() {
    var sh = REF.sh, r = REF.R;
    if (!sh || !sh.isOpen || !r) return;
    var v = refView(), st = v.state, none = st === 'none', make = st === 'make', have = st === 'have', pct = refPct(), run = REF.run;
    var word = !run ? '' : REF.step === 'net' ? 'Getting your wallet ready…' : REF.step === 'chain' ? (run === 'claim' ? 'Sending it to your wallet…' : 'Making your code…') : api.account().busy ? CONFIRM : 'Checking…';
    /* the card */
    txt(r.lab, none ? 'Invite friends' : make ? 'Make your link' : 'Your link');
    txt(r.rate, pct ? 'earns ' + pct : ''); show(r.rate, !none && !!pct);
    show(r.pitch, none); show(r.link, !none); show(r.keys, !none);
    txt(r.pitchB, pct ? 'Earn ' + pct : 'Earn USDC');
    txt(r.pitchT, (pct ? 'of' : 'A share of') + ' what your friends’ trades pay in.');
    cls(r.link, 'sm-rf-link' + (make ? ' is-make' + (REF.ring === 'make' ? ' is-bad' : '') : ''));
    show(r.code, !make); show(r.in, make); r.in.disabled = !!run;
    txt(r.code, have ? v.code : ''); cls(r.code, 'sm-rf-code' + (have ? '' : ' is-wait'));
    if (have && r.code._n !== v.code.length) { r.code._n = v.code.length; r.code.style.setProperty('--n', String(Math.max(8, v.code.length))); }
    show(r.copy, !make); show(r.share, !make && REF.canShare); show(r.make, make);
    cls(r.copy, 'sm-btn ' + (REF.canShare ? 'is-ghost' : 'is-primary is-wide')); r.copy.disabled = !have; r.share.disabled = !have;
    txt(r.make, run === 'make' ? word : 'Make my code'); cls(r.make, 'sm-btn is-primary is-wide' + (run === 'make' ? ' is-busy' : '')); r.make.disabled = !!run;
    var link = have ? refLink(v.code) : '';
    if (!have) { r.qr.hidden = true; r.qr._for = ''; }
    else if (r.qr._for !== link) { r.qr._for = link; r.qr.hidden = false; r.qr.width = 0; drawQr(r.qr, link); refQrFit(40); }
    var qr = have && !r.qr.hidden, hint = proText('referHint');
    show(r.qrOff, !qr);
    txt(r.tipB, none ? 'Your own link and QR code' : have ? (qr ? 'Meeting in person?' : 'Your link is ready') : make ? 'Pick your code' : 'One moment');
    txt(r.tipT, none ? 'Connect your wallet to make them.' : have ? (qr ? 'Your friend scans this and opens confetti with your code.' : 'Copy it or share it with the keys above.') : make ? REF_RULES : /configured/.test(hint) ? hint : 'Reading your code from the chain…');
    /* earned */
    show(r.earn, !none);
    var sum = api.demo ? usd(0) : REF.got && REF.got.a === v.account ? usd(REF.got.n) : /^\$/.test(v.earned) ? v.earned : '$—';
    txt(r.amt, sum); cls(r.amt, /[1-9]/.test(sum) ? 'sm-up' : '');      /* money made is green, as everywhere in Simple */
    txt(r.note, (pct ? 'Your ' + pct : 'Your share') + ' lands in your trading money as your friends trade.');
    show(r.claimRow, !!v.due);
    txt(r.claimT, v.due ? v.due + ' is waiting in your extra codes.' : '');
    txt(r.claim, run === 'claim' ? word : 'Claim ' + v.due + ' to your wallet'); cls(r.claim, 'sm-btn is-ghost' + (run === 'claim' ? ' is-busy' : '')); r.claim.disabled = !!run;
    /* how it works, and who referred this wallet */
    txt(r.how3, 'You earn ' + (pct || 'a share') + ' of what their trades pay in.');
    var by = v.by.replace(/ · set on your first fill$/, ' · from your first trade');
    show(r.by, !!by && by !== '—' && by !== 'none'); txt(r.byV, by);
    /* more codes */
    show(r.moreKey, v.more); show(r.codes, v.more && REF.more);
    r.moreKey.setAttribute('aria-expanded', v.more && REF.more ? 'true' : 'false');
    txt(r.moreSum, v.total === '…' || v.total === '—' ? '' : /retrying/.test(v.total) ? 'not loaded yet' : v.total);
    var sig = JSON.stringify(v.rows);
    if (REF.rows !== sig) {
      REF.rows = sig; r.list.textContent = '';
      v.rows.forEach(x => {
        var c = x.link ? btn('sm-copy', 'Copy', () => { copyText(x.link, c); }) : null;
        if (c) c.setAttribute('aria-label', 'Copy the link of ' + x.name);
        add(r.list, h('div', 'sm-rf-row', [h('div', 'sm-t', [h('b', null, x.name), h('i', null, (x.earned || '—') + ' earned' + (x.due ? ' · ' + x.due + ' to claim' : ''))]), c]));
      });
    }
    cls(r.vbox, 'sm-rf-box' + (REF.ring === 'create' ? ' is-bad' : ''));
    r.vin.disabled = !!run;
    txt(r.vgo, run === 'create' ? word : 'Create code'); cls(r.vgo, 'sm-btn is-ghost' + (run === 'create' ? ' is-busy' : '')); r.vgo.disabled = !!run;
    /* the foot: what the last press came to, and for a visitor the way in */
    show(r.go, none); txt(r.go, api.wallet().has ? 'Connect wallet' : 'Open in your wallet app');
    txt(r.say, REF.say); cls(r.say, 'sm-say' + (REF.say && REF.bad ? ' is-bad' : ''));
    refEdge();
  }
  /* more of the sheet below: its foot shows an edge, as Home's bar does over the list */
  function refEdge() {
    var sh = REF.sh, b = sh.body, more = b.scrollHeight - b.clientHeight - b.scrollTop > 2;
    if (sh.d.classList.contains('is-more') !== more) sh.d.classList.toggle('is-more', more);
  }
  /* The QR code at 3 CSS px a module (drawQr draws 6 canvas px a module), so every square is a whole number of screen pixels
     at any density. drawQr may first have to fetch qr.js: looked at again until it has drawn, or has given up (hidden). */
  function refQrFit(tries) {
    var cv = REF.R.qr;
    if (cv.hidden) { paintRefer(); return; }
    if (cv.width > 0) { cv.style.width = cv.style.height = cv.width / 2 + 'px'; return; }
    if (tries > 0) setTimeout(() => { refQrFit(tries - 1); }, 150);
  }
  /* the phone's share sheet with the link (the key is there only where the browser has one) */
  function refShareGo() {
    var c = refCode(), link = c ? refLink(c) : '';
    if (!link) return;
    try { navigator.share({ title: 'confetti', text: 'Trade on confetti with my link.', url: link }).catch(e => { if (!e || e.name !== 'AbortError') copyText(link, REF.R.share); }); }
    catch (e) { copyText(link, REF.R.share); }
  }
  /* One of the tab's three sends, by the tab's own key: make (its Register form), create (its Create code form), claim (its
     Claim key). The form is filled in and submitted as a tap on its button would, so the tab runs its checks in its own
     order: the code's shape, whether it is taken, the wallet and its network, then the send. What it answers comes back as
     the form's hint in red (refRefused) or as a toast (refHeard). A wallet that is not on HyperEVM (Simple's Connect leaves
     it where its ETH is) is moved there when the tab says so, and the same press goes in once more. */
  function refGo(kind, code) {
    if (REF.run || early()) return;
    if (api.account().busy) { refSay('One moment: the last thing you sent is still going through.', true); return; }
    REF.run = kind; REF.moved = false; REF.code = String(code || ''); REF.say = ''; REF.bad = false; REF.ring = '';
    refPress();
  }
  function refPress() {
    var kind = REF.run, mine = ++REF.seq;
    REF.step = 'ask'; paintRefer();
    /* the tab never leaves a press unanswered; if it somehow does, the key comes back */
    setTimeout(() => { if (REF.seq === mine && REF.step === 'ask' && !api.account().busy) refEnd('That did not start. Press again.', true); }, 25000);
    if (kind === 'claim') { REF.sync = true; try { $('vaultClaim').click(); } finally { REF.sync = false; } return; }
    var make = kind === 'make', form = $(make ? 'referForm' : 'vaultForm'), field = $(make ? 'referCode' : 'vaultCode');
    field.value = REF.code;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    refRefused();
  }
  /* the tab refused the code in its form's hint: its shape, or it is taken */
  function refRefused() {
    if (REF.step !== 'ask' || REF.run === 'claim' || !REF.run) return;
    var id = REF.run === 'make' ? 'referHint' : 'vaultHint', n = $(id);
    if (!n || !n.classList.contains('is-err')) return;
    var s = proText(id), taken = /^Code "(.+)" is taken\.$/.exec(s);
    refEnd(taken ? 'The code ' + taken[1] + ' is taken. Try another one.' : plain(s), true, REF.run);
  }
  /* a toast of the tab while a send of this sheet is running: true when it was this send's (then the sheet says it) */
  function refHeard(text, kind) {
    var run = REF.run;
    if (!run) return false;
    if (kind === 'pending') { REF.step = 'chain'; paintRefer(); return true; }
    if (kind === 'err') {
      var m = /^(?:Register|Create|Claim) failed: ([\s\S]*)$/.exec(text), why = m ? m[1] : text;
      /* without the tab's own "... failed:" it is this send's only when it is one of the refusals the tab makes before it
         sends (said inside the press itself, or in its own words); anything else is some other part of the page speaking */
      if (!m && !REF.sync && text !== api.gate() && !/^(Connect a wallet first|Switch the wallet to HyperEVM|ethers\.js not loaded|Exchange address not configured|This exchange does not settle|Referrals address unknown|Extra codes are not available)/.test(text)) return false;
      if (/Switch the wallet to HyperEVM/.test(why) && !REF.moved) {
        var mine = ++REF.seq, live = () => REF.seq === mine && REF.sh.isOpen;
        REF.moved = true; REF.step = 'net'; paintRefer();
        timed(api.toHyperEvm(), 30000, STAYED + 'nothing was sent. Press again and let it change.').then(() => { if (live()) refPress(); },
          e => { if (live()) refEnd(/another network/i.test(String(e && e.message)) ? plain(e.message) : errText(e), true); });
        return true;
      }
      refEnd(plain(why), true);
      return true;
    }
    if (kind === 'ok' && /^Code \S+ is yours/.test(text)) {
      if (run === 'create') REF.R.vin.value = ''; else REF.R.in.value = '';
      refEnd('Code ' + /^Code (\S+) /.exec(text)[1] + ' is yours.', false);
      return true;
    }
    if (kind === 'ok' && /to your wallet/.test(text)) { refEnd(plain(text), false); return true; }
    if (!kind && /^Demo: /.test(text)) { refEnd('Demo: pretend money. Nothing is sent.', false); return true; }
    return false;
  }

  /* ---- One-tap for everyone (the owner, 2026-11-21: "when iu click on one tap trading from the menu it brings up the old
     layout", then "make one tap the default for all users make them all use it").
     One-tap is Pro's own (trade.js): a key kept in this browser that may open and close this wallet's trades and set their take
     profit and stop loss, and nothing else. The wallet turns it on with one confirmation, which also gives it a little HYPE to
     run on, for 30 days. What is Simple's:
     THE STEP (otStep). A press that one-tap cannot carry yet (Open, Close, Close part, a take profit or stop loss, a limit
     order) first asks the wallet that one thing, by Pro's own step (api.oneTap: trade.js ensureOneTap, the transaction Pro
     sends, to the byte), and only then sends the press, which goes through one-tap with no wallet. The sheet or the card the
     press came from says what the wallet is asked while it is asked; a no leaves one line and the same key. Simple has no
     switch for it and offers no way round it. (Adding to a trade is the wallet's own, as before: one-tap cannot send it.)
     THE SHEET (openOneTap), the menu's One-tap trading, where the menu used to throw the page into Pro: its state in plain
     words, about how many trades its HYPE is good for, how long it lasts, and its keys: Turn on, Top up, Renew (and Done when
     nothing is needed). The three are that same step: it sets up, tops up and starts the 30 days again in one confirmation,
     as Pro's does.
     NOT ENOUGH HYPE (otView().short): the step is not started when the wallet could not leave one-tap enough to run on. The
     place says so in one line and Add money is the way on: every order of that sheet tops the wallet's HYPE up (topUsd). One
     exception, for a Close only: a wallet that can still pay for one send of its own closes its trade the old way (closeGo).
     In the demo it is pretend, like the money: off until the first press, which shows the step as it will look.
     Words: "one-tap", "your wallet", "HYPE"; never the machinery, never what a trade costs. ---- */

  var OT = { sh: null, R: null, run: false, seq: 0, say: '', bad: false, add: false, demo: null, timer: 0, close: null };
  var OT_LOW = 10, OT_SOON = 5 * 86400;      /* running low: under ten trades left; near its end: five days */
  /* "one-tap" never breaks at its hyphen in a line of text (the hyphen that does not break, as the order sheet's note had it) */
  function nb(s) { return String(s).replace(/([Oo])ne-tap/g, '$1ne\u2011tap'); }
  var OT_SHORT = nb('Your wallet is short of the little HYPE one-tap runs on. Add money and that is topped up too.');
  var OT_NO = 'You said no in your wallet, so nothing was sent. Press again when you are ready.';
  function hypeS(wei) { var n = Number(wei) / 1e18; return n > 0 && n < 0.0001 ? 'under 0.0001' : String(Number(n.toFixed(4))); }
  function addMoneyAny() { if (isDesktop()) openAddDesktop(); else openAdd(); }
  /* The demo's one-tap: not set up until the first press turns it on, then 30 days and a full 0.02 HYPE.
     trade.html?demo=1&onetap=on | low | renew | out | ended starts the demo in that state, so each one can be looked at. */
  function otDemo() {
    var d = OT.demo, now = Date.now() / 1000, q = '';
    if (d) return d;
    d = OT.demo = { set: false, exp: 0, hype: 0n };
    try { q = new URLSearchParams(location.search).get('onetap') || ''; } catch (e) { /* not asked for */ }
    if (/^(on|low|renew|out|ended)$/.test(q)) {
      d.set = true; d.exp = now + (q === 'renew' ? 3 * 86400 + 7200 : q === 'ended' ? -7200 : 30 * 86400);
      d.hype = q === 'low' ? 1000000000000000n + GAS_TRADE * 200000000n * 6n + 1n : q === 'out' ? 400000000000000n : 20000000000000000n;
      if (q !== 'out' && q !== 'ended') api.oneTap().catch(noop);      /* trade.js's own pretend switch: this demo's trades need no step */
    }
    return d;
  }
  /* One-tap as trade.js has it (api.session), in the numbers the sheet and the step work with: can (this copy of the site has
     one-tap at all), live, why it cannot carry a trade now ('first' | 'expired' | 'gas'), when it ends and the chain's clock
     (seconds), the HYPE its key holds, the least it runs on, what a wallet step gives it at most and what the wallet keeps
     back for that step, and the network's price now */
  function otS() {
    var s = api.session(), big = (x, d) => x != null ? BigInt(x) : d;
    var o = { can: !!s.router, live: !!s.live, why: s.why || '', loaded: s.loaded !== false, elsewhere: !!s.elsewhere, exp: s.expiry != null ? Number(s.expiry) : null, now: s.now > 0 ? Number(s.now) : Date.now() / 1000,
      hype: big(s.gasWei, null), need: big(s.needWei, 1000000000000000n), pack: big(s.packWei, 20000000000000000n), keep: big(s.keepWei, 2000000000000000n),
      days: s.days || 30, fee: s.feeWei && s.feeWei > 0n ? BigInt(s.feeWei) : 200000000n };
    if (api.demo) {
      var d = otDemo();
      o.can = o.loaded = true; o.elsewhere = false; o.exp = d.set ? d.exp : null; o.hype = d.set ? d.hype : null;
      o.why = !d.set ? 'first' : d.exp <= o.now + 60 ? 'expired' : d.hype < o.need ? 'gas' : ''; o.live = !o.why;
    }
    return o;
  }
  /* What the sheet shows and the step checks. state: load (not read yet), off (not set up in this browser), on, low (under ten
     trades of HYPE left), soon (under five days left), out (its HYPE is used up), ended (its days are over). trades: about how
     many trades (an open and its close, measured: GAS_TRADE) its HYPE is still good for; left: the seconds it still lasts;
     send: the HYPE a wallet step would give it now (trade.js: up to 0.02, less what the wallet keeps for the step itself);
     fresh: the trades a full step is good for; short: the wallet could not leave it enough to run on, or pay for the step. */
  function otView() {
    var a = api.account(), s = otS(), per = GAS_TRADE * s.fee, t = x => Number((x > s.need ? x - s.need : 0n) / per);
    var left = s.exp != null ? s.exp - s.now : null, trades = s.hype != null ? t(s.hype) : null;
    var have = !api.demo && a.hypeWei != null ? BigInt(a.hypeWei) : null;
    var send = have == null ? s.pack : have > s.keep ? (have - s.keep < s.pack ? have - s.keep : s.pack) : 0n, after = (s.hype || 0n) + send;
    var st = !s.loaded ? 'load' : s.live ? (trades < OT_LOW ? 'low' : left != null && left < OT_SOON ? 'soon' : 'on') : s.why === 'expired' ? 'ended' : s.why === 'gas' ? 'out' : 'off';
    /* own: short of what one-tap runs on, yet able to pay for one send of its own (a Close is never kept from such a wallet) */
    return { s: s, state: st, live: s.live, trades: trades, left: left, send: send, fresh: t(s.pack), short: have != null && (after < s.need || have < GAS_SETUP * s.fee * 2n), own: have != null && have >= per * 2n };
  }
  /* why a press needs the step first ('' when one-tap carries it, and on a copy of the site that has no one-tap). o: the trade,
     when the press is an open (one over the key's own limit per trade raises it in the same step: 'cap'). 'wait': the chain
     has not been read yet (the first second of a visit): nothing is said or asked before it has (otStep reads it first) */
  function otWhy(o) {
    var s = otS(), t;
    if (!s.can) return '';
    if (!s.loaded) return 'wait';
    if (!api.demo && o) { t = api.trade(o) || {}; return t.oneTap || ''; }
    return s.live ? '' : s.why || 'first';
  }
  function otAbout(n) { return n >= 1000 ? 'over 1,000' : 'about ' + (n >= 100 ? Math.floor(n / 10) * 10 : n >= 20 ? Math.floor(n / 5) * 5 : n); }
  function otSpan(sec) { var d = Math.round(sec / 86400), hr = Math.max(1, Math.floor(sec / 3600)); return sec >= 129600 ? d + ' days' : hr >= 24 ? '1 day' : hr === 1 ? '1 hour' : hr + ' hours'; }
  function otDay(sec) { return new Date(sec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  /* above a key, before it is pressed: what the wallet will be asked, once */
  function otNote(why) {
    var v = otView(), hype = v.send > 0n ? ' with ' + hypeS(v.send) + ' HYPE' : '';
    return nb(why === 'wait' ? '' : why === 'expired' ? 'One-tap trading has ended: your wallet asks once to renew it' + hype + '. After that, no popups.'
      : why === 'gas' ? 'One-tap trading has run out: your wallet asks once to top it up' + hype + '. After that, no popups.'
      : why === 'cap' ? 'This trade is over your one-tap limit: your wallet asks once to raise it.'
      : 'First trade: your wallet asks once to turn on one-tap trading' + hype + '. After that, no popups.');
  }
  /* while the wallet is asked: what it shows, and what happens after its yes */
  function otAsk(why, then) {
    var v = otView(), pays = v.send > 0n && why !== 'cap';
    if (why === 'wait') return nb('If your wallet asks, it is once, for one-tap trading. ' + then);
    return nb((pays ? 'Your wallet shows one payment of ' + hypeS(v.send) + ' HYPE to ' + (why === 'expired' ? 'renew' : why === 'gas' ? 'top up' : 'turn on')
      : 'One yes in your wallet ' + (why === 'expired' ? 'renews' : why === 'gas' ? 'tops up' : why === 'cap' ? 'raises the limit of' : 'turns on')) + ' one-tap trading. ' + then);
  }
  function otSay(text, addMoney) { var e = say(nb(text)); e.add = !!addMoney; return e; }
  /* what stopped the step, in one line. trade.js's own timed-out wallet sentence is kept; everything unknown goes to the
     console and the line claims nothing */
  function otErr(e) {
    var m = String((e && (e.shortMessage || e.message)) || ''), code = e && (e.code != null ? e.code : e.info && e.info.error && e.info.error.code);
    if (e && e.plain != null) return e.plain;
    if (e && e.smQuiet) return m;
    if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied|cancel)/i.test(m)) return OT_NO;
    if (/insufficient funds|need a little HYPE/i.test(m)) return OT_SHORT;
    if (/Switch the wallet to|another network/i.test(m)) return STAYED + 'nothing was sent. Press again and let it change.';
    if (/local storage/i.test(m)) return 'This browser is not saving site data, and one-tap needs that. Allow it for this site, then press again.';
    if (/^(One moment|Connect a wallet first)/.test(m)) return m;
    if (api.gate() && m === api.gate()) return 'Trading is off right now. Try again in a little while.';
    try { console.error('[simple] one-tap', e); } catch (x) { /* no console */ }
    return 'One-tap did not turn on, so nothing was sent. Press again.';
  }
  /* The step: the chain's word on one-tap read first if it has not been (so one that is on is never set up again), the wallet
     onto HyperEVM, Pro's own one-tap confirmation, then a look that it really carries trades now. Resolves when it does;
     rejects with the one line to say (e.plain), and e.add when Add money is the way on. Nothing of the press it was for has
     been sent when it rejects. o: the trade, when the press is an open. always: the sheet's own keys, which top up and renew a
     one-tap that is on (a press of a trade never does: one that is on carries it). */
  function otStep(o, always) {
    return (otS().loaded ? Promise.resolve() : api.refresh().catch(noop)).then(() => {
      var why = otWhy(o);
      if (!why && !always) return null;
      if (why === 'wait') throw otSay('Still reading your account. Press again in a moment.');
      if (otView().short) throw otSay(OT_SHORT, true);
      var net = api.demo ? Promise.resolve() : timed(api.toHyperEvm(), 30000, STAYED + 'nothing was sent. Press again and let it change.');
      return net.then(() => api.oneTap(o || null)).then(() => {
        if (api.demo) { var d = otDemo(), s = otS(); d.hype = (d.set ? d.hype : 0n) + s.pack; d.set = true; d.exp = s.now + s.days * 86400; }
        var left = otWhy(o);
        if (left === 'gas') throw otSay('One-tap is set up, but it has too little HYPE to run on yet. Add money and that is topped up too.', true);
        if (left) throw otSay('One-tap is set up, but this page has not seen it yet. Press again in a moment.');
      }, e => { var line = otErr(e); throw otSay(line, line === OT_SHORT); });
    });
  }
  /* a trade card's Close key while the step for that close is with the wallet (after the card's own paint): the key says the
     wallet's turn, the card's line what it is asked */
  function otKey(key, line, x) {
    var c = OT.close;
    if (!c || c.pid !== x.id) return;
    txt(key, CONFIRM); cls(key, 'sm-btn is-primary is-busy'); key.disabled = true;
    if (line) { txt(line, c.say); cls(line, 'sm-say is-warn'); show(line, true); }
  }

  /* the menu's line: its state in a word or two */
  function otHint() {
    var v = otView(), st = v.state;
    return st === 'on' ? 'On' : st === 'soon' ? 'Ends in ' + otSpan(v.left) : st === 'low' ? 'Running low' : st === 'out' ? 'Run out' : st === 'ended' ? 'Ended' : st === 'off' ? 'Not set up yet' : '…';
  }
  function openOneTap() {
    var sh = OT.sh;
    if (!sh) { sh = OT.sh = makeSheet('OneTap', true); sh.d.classList.add('is-ot'); otBuild(); }
    OT.say = ''; OT.bad = false; OT.add = false;
    sh.onClose = () => { clearInterval(OT.timer); OT.timer = 0; };      /* a step already with the wallet goes on, as Pro's own */
    sh.open();
    api.refresh().catch(noop);
    clearInterval(OT.timer);
    OT.timer = setInterval(() => { if (document.hidden) return; if (!OT.run) api.refresh().catch(noop); paintOneTap(); }, 15000);
    paintOneTap();
  }
  function otBuild() {
    var sh = OT.sh, r = OT.R = {};
    txt(sh.title, 'One-tap trading');
    /* the card: one shape in every state. What it is and how long it lasts; its state, large; one sentence; how many trades
       its HYPE is good for, as a line and a bar (the trade card's own); three facts */
    r.pill = h('span', 'sm-pill', '');
    r.word = h('b', 'sm-ot-word', ''); r.sub = h('p', 'sm-ot-sub', '');
    r.mt = h('span', 'sm-room-t', ''); r.mv = h('span', 'sm-room-v', ''); r.bar = h('i');
    r.meter = h('div', 'sm-room sm-ot-meter', [h('div', 'sm-room-l', [r.mt, r.mv]), h('div', 'sm-room-bar', r.bar)]);
    r.f = [0, 1, 2].map(() => ({ k: h('span', null, ''), v: h('span', null, '') }));
    r.pass = h('div', 'sm-rf-pass sm-ot-pass', [h('div', 'sm-rf-head', [h('div', 'sm-label', 'Your one-tap'), r.pill]), r.word, r.sub, r.meter,
      h('div', 'sm-facts sm-ot-facts', r.f.map((f, i) => h('div', 'sm-fact' + (i === 1 ? ' sm-fact-now' : ''), [f.k, f.v])))]);
    r.how3 = h('li', null, '');
    r.how = h('div', 'sm-rf-how', [h('div', 'sm-label', 'How it works'), h('ol', null, [h('li', null, 'Your wallet says yes once.'), h('li', null, 'After that, opening and closing a trade is one tap. No popups.'), r.how3])]);
    r.know = h('p', 'sm-fine sm-ot-know', nb('One-tap can only open and close your trades and set their take profit and stop loss. It can never take money out.'));
    add(sh.body, [r.pass, r.how, r.know]);
    r.say = sayLine();
    r.alt = btn('sm-btn is-ghost', '', () => { otGo(true); }); r.go = btn('sm-btn is-primary', '', () => { otGo(false); });
    add(sh.foot, [r.say, h('div', 'sm-ot-keys', [r.alt, r.go])]);
  }
  function paintOneTap() {
    var sh = OT.sh, r = OT.R;
    if (!sh || !sh.isOpen || !r) return;
    if (!api.wallet().account) { sh.close(); return; }
    var v = otView(), s = v.s, st = v.state, run = OT.run, set = st !== 'off' && st !== 'load', near = v.left != null && v.left < OT_SOON;
    var hype = v.send > 0n ? hypeS(v.send) + ' HYPE' : '', full = hypeS(s.pack) + ' HYPE', days = s.days + ' days';
    /* the card */
    txt(r.pill, !set ? '' : st === 'ended' ? 'ended ' + otDay(s.exp) : otSpan(v.left) + ' left');
    cls(r.pill, 'sm-pill' + (st === 'ended' ? ' is-dn' : st === 'out' ? ' is-plain' : near ? ' is-warn' : ' is-up')); show(r.pill, set);
    var word = st === 'load' ? '' : st === 'off' ? 'Not set up yet' : st === 'low' ? 'Running low' : st === 'out' ? 'Run out' : st === 'ended' ? 'Ended' : 'On';
    txt(r.word, word); if (r.word._n !== word.length) { r.word._n = word.length; r.word.style.setProperty('--n', String(Math.max(7, word.length))); }      /* as large as the card's width lets that word be */
    cls(r.word, 'sm-ot-word' + (st === 'load' ? ' is-wait' : st === 'on' || st === 'soon' ? ' is-on' : st === 'low' ? ' is-warn' : st === 'out' || st === 'ended' ? ' is-bad' : ''));
    txt(r.sub, st === 'load' ? 'Reading it from the chain…'
      : st === 'off' ? (s.elsewhere ? 'It is on in another browser. Turning it on here moves it to this one.' : 'Turn it on once and every trade is one tap: your wallet stays out of the way.')
      : st === 'low' ? 'Its HYPE is nearly used up. Top it up and your trades keep going through at one tap.'
      : st === 'out' ? 'Its HYPE is used up. Top it up and your trades go through at one tap again.'
      : st === 'ended' ? 'Its ' + days + ' are over. Renew it and your trades go through at one tap again.'
      : st === 'soon' ? 'Your trades go through at one tap. It ends ' + otDay(s.exp) + ': renew it any time before.'
      : 'Your trades go through at one tap. Your wallet stays out of the way.');
    txt(r.mt, set ? 'Trades left' : 'Good for'); txt(r.mv, st === 'load' ? '—' : set ? (v.trades > 0 ? otAbout(v.trades) : 'none') : otAbout(v.fresh) + ' trades');
    cls(r.meter, 'sm-room sm-ot-meter' + (!set ? ' is-late is-off' : st === 'ended' ? ' is-late' : st === 'out' || !(v.trades > 0) ? ' is-red' : st === 'low' ? ' is-amber' : ''));
    var pc = set && s.hype != null && s.pack > 0n ? Math.min(100, Number(s.hype * 1000n / s.pack) / 10) : 0;
    r.bar.style.width = pc + '%';
    var facts = set ? [[st === 'ended' ? 'Ended on' : 'Lasts until', otDay(s.exp)], ['Kept in', 'this browser'], ['HYPE in it', (Number(s.hype || 0n) / 1e18).toFixed(4)]]
      : [['Wallet asks', 'once'], ['Lasts', days], ['Runs on', full]];
    r.f.forEach((f, i) => { txt(f.k, facts[i][0]); txt(f.v, st === 'load' ? '—' : facts[i][1]); });
    txt(r.how3, 'It runs on a little of your HYPE and lasts ' + days + '. Then one yes renews it.');
    /* the keys: one in ink, always. Turn on; Top up when its HYPE is low or used up; Renew near its end and after it; Done
       when nothing is needed, with Top up beside it on paper. One step is behind all of them. Add money when the wallet is
       short of the HYPE for it */
    var needs = st === 'off' || st === 'out' || st === 'ended', toAdd = OT.add || (needs && v.short), calm = st === 'on' || st === 'soon', two = !toAdd && calm && !run;
    var main = toAdd ? 'Add money' : st === 'load' ? 'One moment…' : st === 'off' ? 'Turn on one-tap' : st === 'ended' || st === 'soon' ? 'Renew for ' + days : st === 'on' ? 'Done' : 'Top up' + (hype ? ' · ' + hype : '');
    txt(r.go, run ? CONFIRM : nb(main)); cls(r.go, 'sm-btn is-primary' + (run ? ' is-busy' : ''));
    r.go.disabled = run || st === 'load'; r.go._add = toAdd; r.go._done = !toAdd && st === 'on';
    txt(r.alt, 'Top up'); show(r.alt, two); r.alt.disabled = run;
    r.alt.parentNode.classList.toggle('is-two', two);
    /* the line over the keys: what the last press came to; while the wallet is asked, what it shows; else what a press does */
    var line = run ? (v.send > 0n ? 'Your wallet shows one payment of ' + hype + '. Nothing is sent until you confirm.' : 'Your wallet asks you to confirm. Nothing is sent until you do.')
      : OT.say ? OT.say : toAdd ? OT_SHORT : st === 'load' ? ''
      : st === 'off' ? 'Your wallet asks once' + (hype ? ' and gives it ' + hype + ' to run on.' : '.')
      : st === 'soon' || st === 'ended' ? 'Renewing starts ' + days + ' again' + (hype ? ' and sends it ' + hype + ' from your wallet.' : '. Your wallet asks once.')
      : 'A top-up starts its ' + days + ' again' + (hype ? ' and sends it ' + hype + ' from your wallet.' : '. Your wallet asks once.');
    /* the HYPE the wallet sends stands out in the line, as the amount does in Add money's own wallet line */
    line = nb(line);
    if (r.say._k !== line) {
      var at = hype ? line.indexOf(hype) : -1;
      r.say._k = line; r.say.textContent = '';
      add(r.say, at < 0 ? [line] : [line.slice(0, at), h('b', null, hype), line.slice(at + hype.length)]);
    }
    cls(r.say, 'sm-say' + (!run && OT.say && OT.bad ? ' is-bad' : run || (!OT.say && toAdd) ? ' is-warn' : ''));
    otEdge();
  }
  function otEdge() {
    var sh = OT.sh, b = sh.body, more = b.scrollHeight - b.clientHeight - b.scrollTop > 2;
    if (sh.d.classList.contains('is-more') !== more) sh.d.classList.toggle('is-more', more);
  }
  /* the sheet's keys: the one step (alt: Top up beside the main key), Done, or the way to the HYPE it lacks */
  function otGo(alt) {
    var r = OT.R, v = otView();
    if (OT.run || early() || v.state === 'load') return;
    if (!alt && r.go._add) { OT.sh.close(); setTimeout(addMoneyAny, 200); return; }
    if (!alt && r.go._done) { OT.sh.close(); return; }
    if (v.short) { OT.say = ''; OT.add = true; paintOneTap(); return; }
    var was = v.state, mine = ++OT.seq;
    OT.run = true; OT.say = ''; OT.bad = false; S.claim = true; paintOneTap();
    otStep(null, true).then(() => {
      OT.say = was === 'off' ? 'One-tap is on. From here, every trade is one tap.' : 'Done: one-tap is topped up and its ' + v.s.days + ' days start again.'; OT.bad = false;
    }, e => { OT.say = e.add ? '' : e.plain; OT.bad = !e.add; OT.add = !!e.add; }).then(() => {
      if (OT.seq === mine) OT.run = false;
      S.claim = false; paintOneTap(); kick();
    });
  }


  /* ---- the sheet: dollars, Boost, both outcomes in dollars, one Open ---- */

  var ORD = { sh: null, sym: null, isLong: true, typed: '10', all: false, lev: 20, err: '', busy: false, limit: false, limitPx: '', R: {} };
  /* five set boosts per coin (the coin's top one last), plus Custom for any whole number from 1x to the top. On the 1000x
     coins 250x and 500x are among the five (owner, 11/11) */
  function boosts(max) {
    var pool = max >= 1000 ? [20, 100, 250, 500] : max >= 250 ? [5, 20, 50, 100] : [2, 5, 10, 20];
    var s = pool.filter(v => v < max);
    s.push(max);
    return s;
  }
  function ordAmount() { var n = Number(String(ORD.typed).replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; }
  function openOrder(sym, isLong) {
    var w = api.wallet(), a = api.account(), m = market(sym);
    if (!w.account) { doConnect(); return; }
    if (!m) return;
    var sh = ORD.sh || (ORD.sh = makeSheet('Order')), r = ORD.R = {}, steps = boosts(m.maxLev), last = Number(lsGet(AMT_KEY)) || 10, lv = Number(lsGet('confetti.trade.lev.' + sym)) || 20;
    ORD.sym = sym; ORD.isLong = isLong; ORD.err = ''; ORD.busy = false; ORD.limit = false; ORD.limitPx = ''; ORD.all = false; S.claim = false;
    ORD.typed = String(a.loaded && a.available >= a.min && a.available < last ? Math.floor(a.available) : last);
    ORD.max = m.maxLev; ORD.levBad = false;
    ORD.lev = lv >= 1 && lv <= m.maxLev && Math.round(lv) === lv ? lv : steps.filter(v => v <= 20).pop() || steps[0];
    ORD.custom = steps.indexOf(ORD.lev) < 0;
    sh.title.textContent = ''; add(sh.title, [sym, sidePill(isLong)]);
    sh.body.textContent = ''; sh.foot.textContent = '';
    r.amt = amtInput('smOrdAmount', 'Amount, in dollars', ORD.typed, v => { ORD.typed = v; ORD.all = false; ORD.err = ''; paintOrder(); });
    var lab = h('label', 'sm-label is-amt', ['Amount', h('span', 'sm-hint', 'Type any amount')]); lab.htmlFor = 'smOrdAmount';
    r.chips = h('div', 'sm-chips');
    [5, 10, 25, 'all'].forEach(v => {
      var b = btn(null, v === 'all' ? 'All' : '$' + v, () => {
        var bal = api.account().available;
        ORD.all = v === 'all'; ORD.typed = String(v === 'all' ? Math.floor(bal * 100) / 100 : v); r.amt.value = ORD.typed; ORD.err = ''; paintOrder();
      });
      b._v = v; r.chips.appendChild(b);
    });
    r.seg = h('div', 'sm-seg is-grid'); r.seg.setAttribute('role', 'group'); r.seg.setAttribute('aria-label', 'Boost');
    steps.forEach(function (v) { var b = btn(null, v + '×', () => { ORD.lev = v; ORD.custom = false; ORD.levBad = false; ORD.err = ''; paintOrder(); }); b._v = v; r.seg.appendChild(b); });
    var cb = btn(null, 'Custom', () => {
      ORD.custom = true; ORD.err = ''; if (steps.indexOf(ORD.lev) >= 0) { r.lev.value = ''; ORD.levBad = true; }
      paintOrder(); setTimeout(() => { r.lev.focus(); }, 30);
    });
    cb._v = 'custom'; r.seg.appendChild(cb);
    r.lev = h('input'); r.lev.id = 'smOrdLev'; r.lev.type = 'text'; r.lev.setAttribute('inputmode', 'numeric'); r.lev.setAttribute('enterkeyhint', 'done');
    r.lev.setAttribute('autocomplete', 'off'); r.lev.placeholder = 'e.g. ' + Math.min(m.maxLev, 75); r.lev.value = ORD.custom ? String(ORD.lev) : '';
    r.lev.addEventListener('input', () => {
      var d = r.lev.value.replace(/[^0-9]/g, '').slice(0, 4); if (d !== r.lev.value) r.lev.value = d;
      var n = Number(d); ORD.err = '';
      if (d && n >= 1 && n <= m.maxLev) { ORD.lev = n; ORD.levBad = false; } else ORD.levBad = true;
      paintOrder();
    });
    r.lev.addEventListener('keydown', ev => { if (ev.key === 'Enter') r.lev.blur(); });
    var ll = h('label', 'sm-levc', [h('span', null, 'Your boost'), h('span', 'sm-levc-in', [r.lev, h('b', null, '×')]), h('i', null, '1× to ' + m.maxLev + '×')]); ll.htmlFor = 'smOrdLev';
    r.levBox = ll;
    r.risk = h('p', 'sm-risk', ''); r.w = h('b', 'sm-up', ''); r.l = h('b', 'sm-dn', ''); r.wk = h('span'); r.lk = h('span');
    /* take profit and stop loss: both boxes by name and in view, under the two outcomes (no longer a closed row at the end) */
    var again = () => { ORD.err = ''; paintOrder(); };
    r.tp = autoField('tp', again, true); r.sl = autoField('sl', again, true);
    r.autoBox = h('div', 'sm-ak-two', [r.tp.n, r.sl.n]);
    r.autoFine = h('p', 'sm-fine sm-ak-fine', '');
    /* limit order: "At a price" option */
    r.limSeg = h('div', 'sm-seg'); r.limSeg.setAttribute('role', 'group'); r.limSeg.setAttribute('aria-label', 'When');
    r.limNow = btn(null, 'Now', () => { ORD.limit = false; ORD.err = ''; paintOrder(); }); r.limNow._v = 'now';
    r.limAt = btn(null, 'At a price', () => { ORD.limit = true; ORD.err = ''; paintOrder(); var px = api.limits.marketPrice(sym); if (px > 0 && !ORD.limitPx) { ORD.limitPx = String(Number(px.toPrecision(6))); } setTimeout(() => { r.limPx.focus(); }, 30); }); r.limAt._v = 'at';
    r.limSeg.appendChild(r.limNow); r.limSeg.appendChild(r.limAt);
    r.limPx = h('input'); r.limPx.id = 'smOrdLimPx'; r.limPx.type = 'text'; r.limPx.setAttribute('inputmode', 'decimal'); r.limPx.setAttribute('autocomplete', 'off'); r.limPx.placeholder = 'the price it opens at';
    r.limPx.addEventListener('input', () => { ORD.limitPx = r.limPx.value; ORD.err = ''; paintOrder(); });
    r.limPx.addEventListener('keydown', ev => { if (ev.key === 'Enter') r.limPx.blur(); });
    r.limBox = h('div', 'sm-lim', [h('label', null, [h('span', null, 'Opens when ' + sym + ' reaches'), r.limPx]), h('p', 'sm-fine', 'The order waits in this browser and fires while Confetti is open.')]);
    add(sh.body, [lab, h('label', 'sm-amt is-mid', [h('span', null, '$'), r.amt]), r.chips, h('div', 'sm-label', 'Boost'), r.seg, r.levBox, r.risk,
      h('div', 'sm-out', [h('div', null, [r.wk, r.w]), h('div', null, [r.lk, r.l])]), r.autoBox, r.autoFine, h('div', 'sm-label sm-when', 'When'), r.limSeg, r.limBox]);
    r.say = sayLine();
    r.go = btn('sm-btn', '', orderGo);
    add(sh.foot, [r.say, r.go]);
    sh.onClose = () => { ORD.busy = false; ORD.ot = ''; S.claim = false; };
    sh.open(); paintOrder();
  }
  function num(v) { v = String(v || '').trim(); if (!v) return null; var n = Number(v.replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? n : NaN; }
  function paintOrder() {
    var r = ORD.R, sym = ORD.sym, up = ORD.isLong, amt = ordAmount(), lev = ORD.lev, a = api.account(), tk = api.ticket();
    var t = api.trade({ sym: sym, isLong: up, margin: amt, lev: lev }) || {}, mv = api.fmt.move(t.endPct);
    /* (cf_FILLFEEL) the sheet gives way the moment the page's own code has taken the order (orderGo): from then on the order's
       card, drawn as its trade, says whatever becomes of it */
    if (document.activeElement !== r.amt && r.amt.value !== ORD.typed) r.amt.value = ORD.typed;
    each(r.chips, b => { b.setAttribute('aria-pressed', (b._v === 'all' ? ORD.all : !ORD.all && amt === b._v) ? 'true' : 'false'); b.disabled = !!ORD.busy; });
    each(r.seg, b => {
      var on = b._v === 'custom' ? ORD.custom : !ORD.custom && b._v === lev;
      b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.disabled = !!ORD.busy;
      if (b._v === 'custom') txt(b, ORD.custom && !ORD.levBad ? lev + '×' : 'Custom');
    });
    /* limit order toggle */
    r.limNow.setAttribute('aria-pressed', !ORD.limit ? 'true' : 'false'); r.limNow.disabled = !!ORD.busy;
    r.limAt.setAttribute('aria-pressed', ORD.limit ? 'true' : 'false'); r.limAt.disabled = !!ORD.busy;
    show(r.limBox, ORD.limit); r.limPx.disabled = !!ORD.busy;
    if (document.activeElement !== r.limPx && r.limPx.value !== ORD.limitPx) r.limPx.value = ORD.limitPx;
    show(r.levBox, ORD.custom); r.lev.disabled = !!ORD.busy;
    r.amt.disabled = !!ORD.busy;
    /* the two boxes: read as Pro's ticket reads them, for this very trade at the price now. A limit order opens later, without
       them (its card takes them once it is open) */
    var oo = { sym: sym, isLong: up, margin: amt, lev: lev };
    var rt = ORD.limit ? null : api.autoRead(oo, 'tp', r.tp.i.value), rs = ORD.limit ? null : api.autoRead(oo, 'sl', r.sl.i.value);
    autoShow(r.tp, rt, t.sz, up, t.endPx); autoShow(r.sl, rs, t.sz, up, t.endPx);
    r.tp.i.disabled = r.sl.i.disabled = !!ORD.busy || ORD.limit;
    r.autoBox.classList.toggle('is-off', ORD.limit);
    var onChain = !ORD.limit && api.autoChain && api.autoChain(sym);      /* v6: this open takes them on chain */
    txt(r.autoFine, ORD.limit ? 'A limit order opens without them. Set them on its card once it is open.' : 'Optional. ' + (onChain ? 'They close this trade even when Confetti is closed.' : honest()));
    txt(r.risk, lev + '× makes every 1% move worth ' + lev + '%. A ' + mv + '% ' + (up ? 'drop' : 'rise') + ' closes this trade and the ' + (amt > 0 ? usdS(amt) : 'money') + ' is gone.');
    txt(r.wk, sym + (up ? ' up 1%' : ' down 1%')); txt(r.w, isFinite(t.win1) ? usdP(t.win1) : '—');
    txt(r.lk, sym + (up ? ' down ' : ' up ') + mv + '%'); txt(r.l, amt > 0 ? '−' + usd(amt) : '—');
    var tp = ORD.limit ? null : num(r.tp.i.value), sl = ORD.limit ? null : num(r.sl.i.value), fin = r.tp.fin != null ? r.tp.fin : r.sl.fin;
    /* two things can stand above the button: why this trade cannot be opened as typed (the button is off until that changes),
       and what stopped the last press (the button stays on: pressing again is the way on) */
    var err = ORD.err, why = '', needMoney = a.loaded && t.min > 0 && a.available < t.min, note = '';
    if (!ORD.busy) {
      if (t.block) why = plain(t.block);
      else if (ORD.custom && ORD.levBad) why = 'Type a boost from 1× to ' + ORD.max + '×.';
      else if (needMoney) why = 'You need at least ' + usdS(t.min) + ' to trade.';
      else if (!(amt > 0)) why = 'Type an amount.';
      else if (amt < t.min) why = 'The smallest trade is ' + usdS(t.min) + '.';
      else if (amt > a.available + 1e-9) why = 'That is more than your trading money (' + usd(a.available) + ').';
      else if (t.room != null && amt * lev > t.room + 1e-6) why = 'Too big right now. Pick a smaller amount or a lower boost.';
      else if (t.problem) why = plain(t.problem);
      else if (fin != null) why = 'Finish the ' + (r.tp.fin != null ? 'take profit' : 'stop loss') + ' price: did you mean ' + price(fin, t.sz) + '?';
      else if (tp != null || sl != null) why = r.tp.bad || r.sl.bad || autoWhy(api.autoCheck(oo, tp, sl) || '');
      else if (ORD.limit && !(Number(ORD.limitPx) > 0)) why = 'Type a price for your limit order.';
    }
    /* one-tap for everyone: an open that one-tap cannot carry yet first asks the wallet that one thing (otStep). It is said
       above the key before the press (in the demo too, where it is pretend); while the wallet is asked the line says what it
       shows; a wallet short of the HYPE for it gets Add money as its key */
    var ot = !why ? otWhy(oo) : '', otShort = !!ot && !ORD.busy && otView().short;
    if (otShort) why = OT_SHORT;
    if (ORD.busy && ORD.ot) note = ORD.ot;
    else if (ot && !otShort && !err) note = otNote(ot);
    /* a take profit or stop loss typed: the one thing to know about it stands right above the button, in view on every phone */
    else if (!why && !err && (tp != null || sl != null)) note = onChain ? CHAIN_ALWAYS : (tp != null && sl != null ? 'Your take profit and stop loss fire' : tp != null ? 'Your take profit fires' : 'Your stop loss fires') + ' while Confetti is open ' + (isDesktop() ? 'in this browser.' : 'on this phone.');
    /* v6: under a stop on chain, how it fills (at every boost) */
    if (onChain && sl != null) txt(r.autoFine, chainStop(lev));
    show(r.autoFine, ORD.limit || (tp == null && sl == null) || (onChain && sl != null));      /* said above the button instead */
    txt(r.say, why || err || note); cls(r.say, 'sm-say' + ((why && !autoWait(why)) || err ? ' is-bad' : ORD.busy && ORD.ot ? ' is-warn' : ''));      /* the reason the button is off comes first */
    /* (cf_FILLFEEL) the key answers by going down, with its own words: the wallet's turn is said, never a wait ("Opening…") */
    var word = ORD.busy && (ORD.ot || (!api.demo && (tk.phase === 'wallet' || t.oneTap || !api.session().live))) ? CONFIRM : '';
    r.go._add = (needMoney || otShort) && !ORD.busy && !t.block;
    if (ORD.limit) {
      txt(r.go, word || (r.go._add ? 'Add money' : 'Open ' + (up ? 'UP' : 'DOWN') + ' at $' + ORD.limitPx + ' · ' + usdS(amt) + ' × ' + lev));
    } else {
      txt(r.go, word || (r.go._add ? 'Add money' : 'Open ' + (up ? 'UP' : 'DOWN') + ' · ' + usdS(amt) + ' × ' + lev));
    }
    cls(r.go, 'sm-btn ' + (r.go._add ? 'is-primary' : up ? 'is-up' : 'is-dn') + (ORD.busy ? ' is-busy' : ''));
    r.go.disabled = !!ORD.busy || (!!why && !r.go._add);
    r.go._o = { sym: sym, isLong: up, margin: amt, lev: lev, maxed: ORD.all, tp: tp, sl: sl, limit: ORD.limit, limitPx: Number(ORD.limitPx) };
  }
  function orderGo() {
    var r = ORD.R, o = r.go._o, s = api.session();
    if (ORD.busy || r.go.disabled || early()) return;
    if (r.go._add) { ORD.sh.close(); setTimeout(() => { openAdd(); }, 200); return; }
    var ot = otWhy(o);
    /* limit order: placed in browser, no wallet interaction (it opens later through one-tap, so one-tap is set up first) */
    function place() {
      var res = api.limits.place(o.sym, o.isLong, o.margin, o.lev, o.limitPx);
      if (!res.ok) { ORD.err = res.err; paintOrder(); return; }
      snack('Limit placed: ' + (o.isLong ? 'Up' : 'Down') + ' ' + o.sym + ' at $' + o.limitPx + '. It fires while Confetti is open.');
      if (!o.maxed) lsSet(AMT_KEY, String(o.margin)); lsSet('confetti.trade.lev.' + o.sym, String(o.lev));
      ORD.sh.close(); S.sig = ''; kick();
    }
    var lim = !!(o.limit && o.limitPx > 0);
    if (lim && !ot) { place(); return; }
    /* this press has a token: closing the sheet ends it, and a press that has ended sends nothing */
    var mine = ORD.busy = Date.now() + Math.random(), t = api.trade(o) || {};
    ORD.err = ''; ORD.ot = ot ? otAsk(ot, lim ? 'Then your order is placed.' : 'Then this trade opens.') : ''; S.claim = true; S.lastErr = null;
    paintOrder();
    function send() {
      if (ORD.busy !== mine || !ORD.sh.isOpen) return;
      if (lim) { ORD.busy = false; S.claim = false; place(); return; }
      var why = api.open(o);
      if (why) { ORD.busy = false; S.claim = false; ORD.err = plain(why); paintOrder(); return; }
      S.claim = false; if (!o.maxed) lsSet(AMT_KEY, String(o.margin)); lsSet('confetti.trade.lev.' + o.sym, String(o.lev));
      /* (cf_FILLFEEL) the page's own code has taken the order: the sheet gives way at once to the order's card, drawn as its
         trade. Where the wallet is still to be asked the order is not in the list yet and has its place all the same (ffAsk);
         a wallet that says no is said there, and Try again brings this sheet back with the same amount and boost */
      ffTap(o); ffAsk(); ffHand(); S.sig = '';
    }
    /* one-tap for everyone: where one-tap cannot carry this open yet, the wallet is asked that one thing first (otStep: onto
       HyperEVM, then Pro's own step); a no, or a wallet that never answers, leaves its line above the same key. Then the open
       goes out through one-tap, as every one after it.
       (cf_FILLFEEL) With no wallet to ask, the order goes out right behind the frame that shows the pressed key. On a copy of
       the site without one-tap the wallet signs the open itself, and is asked onto HyperEVM first */
    if (ot) { otStep(o).then(() => { ORD.ot = ''; send(); }, e => { ORD.ot = ''; if (ORD.busy !== mine) return; ORD.busy = false; S.claim = false; ORD.err = e.plain; if (ORD.sh.isOpen) paintOrder(); }); return; }
    if (api.demo || (s.live && !t.oneTap)) { ffNext(send); return; }
    timed(api.toHyperEvm(), 30000, STAYED + 'nothing was sent. Press again and let it change.').then(send, e => { if (ORD.busy !== mine) return; ORD.busy = false; S.claim = false; ORD.err = errText(e); if (ORD.sh.isOpen) paintOrder(); });
  }
  /* (cf_FILLFEEL) a sheet gives way to the card its press is on (the order sheet to its order's card, Close part to its trade's):
     the same slide away, quick off the mark, so the card under it is in view sooner (is-handing, simple.css). A sheet's own
     close, by its ✕ or a swipe, is as it was */
  function ffHand(sh) {
    sh = sh || ORD.sh;
    var d = sh.d;
    d.classList.add('is-handing'); sh.close();
    setTimeout(() => { d.classList.remove('is-handing'); }, 240);
  }
  /* (cf_FILLFEEL) right behind the frame that shows the pressed key: a press is answered within one frame, and the work it
     starts comes straight after (at once where there are no frames to wait for: a page out of sight) */
  function ffNext(fn) {
    var ran = false, run = () => { if (!ran) { ran = true; fn(); } };
    if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(() => { setTimeout(run, 0); });
    setTimeout(run, 80);
  }

  /* ---- start: trade.js calls this once, with its api ---- */

  /* trade.js never started: the page as it is without Simple. Not tied to a short clock, so a slow load never flips between
     views: only trade.js failing to load, or a quarter of a minute passing after the page finished loading (trade.js starts
     once config.json is in, which can be after the load event). A page view that went to Pro this way stays Pro. */
  function noStart() {
    if (api || S.gaveUp) return;
    S.gaveUp = true;
    var root = document.documentElement, bar = document.querySelector('meta[name="theme-color"]');
    root.removeAttribute('data-mode');
    if (bar) bar.content = getComputedStyle(root).getPropertyValue('--page').trim() || '#0d1229';
  }
  (function () {
    var tag = document.querySelector('script[src^="trade.js"]'), wait = () => { setTimeout(noStart, 15000); };
    if (tag) tag.addEventListener('error', noStart);
    if (document.readyState === 'complete') wait(); else window.addEventListener('load', wait);
  })();
  var init = a => {
    var booted = document.documentElement.getAttribute('data-mode') === 'simple' && !S.gaveUp;
    api = a; E = window.ethers;
    el.root = $('smRoot'); el.top = $('smTop'); el.main = $('smMain'); el.cta = $('smCta');
    /* desktop elements */
    el.body = $('smBody'); el.left = $('smLeft'); el.leftHead = $('smLeftHead'); el.leftScroll = $('smLeftScroll');
    el.center = $('smCenter'); el.centerInner = $('smCenterInner'); el.dirbar = $('smDirbar'); el.allTrades = $('smAllTrades');
    el.right = $('smRight'); el.panelHead = $('smPanelHead'); el.panelBody = $('smPanelBody'); el.panelFoot = $('smPanelFoot');
    if (!el.root || !el.top) return null;
    S.flag = flagOf(); S.flagDk = flagDkOf();
    lsSet(FLAG_KEY, S.flag); lsSet(FLAG_DK_KEY, S.flagDk);
    S.param = param(); S.mode = wantMode();
    /* A page view that painted Pro stays Pro (no flip on a slow load): the flag just cached decides the next load. A view the
       boot painted as Simple is corrected only towards Pro (the flag "off", or nobody asked and it is not the default). */
    if (S.mode === 'simple' && !booted) S.mode = 'pro';
    ['account', 'positions', 'cards', 'action', 'ticket', 'prices', 'stats', 'part'].forEach(ev => { api.on(ev, kick); });
    var who = null;
    /* the open sheet shows what the record now says (or the form, read again) */
    function sync() {
      var p = ADD.pend;
      ADD.view = viewOf(p);
      ADD.built = ''; readBalances(); paintAdd(); scheduleQuote(0);
    }
    api.on('wallet', () => {
      var w = api.wallet().account || null;
      if (w !== who) {
        /* another account: nothing of the old one stays on the sheet (its ETH, its price, a press in flight), and it is read again */
        who = w; if (ADD.run) endRun(null);
        ADD.q = null; ADD.userChain = null; ADD.refused = {}; ADD.bal = {}; ADD.balErr = {}; ADD.balFor = null; ADD.err = ''; ++ADD.qseq; loadPend(); S.sig = '';
        if (ADD.sh && ADD.sh.isOpen) {
          if (!w) ADD.sh.close();
          else sync();
        }
      }
      kick();
    });
    /* a second tab on the same wallet changed this add's record (finished it, stopped following it, started one): this tab
       follows, unless it is in the middle of a press of its own */
    window.addEventListener('storage', ev => {
      if (!ev.key || ev.key !== pendKey() || ADD.run || ADD.busy || (ADD.fin && ADD.fin.busy)) return;
      loadPend(); if (ADD.sh && ADD.sh.isOpen) sync(); redo();
    });
    api.on('result', onResult);
    api.onPhoneChange(applyMode);
    window.addEventListener('popstate', onPop);
    /* a second tap on the spot that closed a sheet (a double tap on ✕ or outside it) is the same tap, not a press on the page */
    document.addEventListener('pointerdown', ev => { S.ptr = { x: ev.clientX, y: ev.clientY, t: Date.now() }; }, true);
    el.root.addEventListener('click', ev => {
      var s = S.shut; if (!s) return;
      S.shut = null;
      if (Date.now() - s.t < 450 && Math.abs(ev.clientX - s.x) < 32 && Math.abs(ev.clientY - s.y) < 32) { ev.preventDefault(); ev.stopPropagation(); }
    }, true);
    /* rows that scroll into view get their small lines then */
    el.main.addEventListener('scroll', () => { if (!S.edgeF) S.edgeF = requestAnimationFrame(() => { S.edgeF = 0; edge(); }); clearTimeout(S.sct); S.sct = setTimeout(() => { if (shown() && S.place === 'home') kick(); }, 200); }, { passive: true });
    var wasDesktop = wide();
    window.addEventListener('resize', () => {
      var nowDesktop = wide();
      if (nowDesktop !== wasDesktop) { wasDesktop = nowDesktop; S.mode = wantMode(); applyMode(); }
      kick(); fitKeyboard();
    });
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitKeyboard); window.visualViewport.addEventListener('scroll', fitKeyboard); }
    document.addEventListener('visibilitychange', function () { if (!document.hidden && ADD.pend && !ADD.pend.final) { if (ADD.pend.rail === 'apple') watchApple(); else track(); } });
    setInterval(() => { if (shown() && (ADD.pend || S.place !== 'home')) kick(); }, 1000);
    who = api.wallet().account || null; loadPend();
    applyMode();
    if (shown()) bootCoin();
    if (shown()) refShare();      /* the menu's "earn 15%" is the chain's own number */
    /* trade.html?levels=2: the $FETTI page's "Get a level" key, the level sheet open on Level 2 */
    try { var lvq = new URLSearchParams(location.search).get('levels'); if (lvq && shown()) setTimeout(() => { if (fx()) openLevels(Number(lvq) || null); }, 600); } catch (e) { /* none asked for */ }
    BOOT.hash = '';
    /* Pro's Add USDC entry points open Simple's Add money only while Simple is what the phone shows: with Pro on screen
       (a saved "pro", the First steps guide, a wide window) Pro keeps its own sheet */
    return { shown: shown, toast: onToast, addMoney: () => { if (!shown() || api.demo) return false; openAdd(); return true; } };
  };
  /* simple.js is loaded async: trade.js never waits for it, and whichever arrives second does the hand-over */
  if (typeof window.ConfettiSimpleTake === 'function') window.ConfettiSimpleTake(init); else window.ConfettiSimpleInit = init;
})();
