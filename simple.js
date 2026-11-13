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
    VIRTUAL: 'Virtuals', WIF: 'dogwifhat', MELANIA: 'Melania', FLOKI: 'Floki', PENGU: 'Pudgy Penguins', PEOPLE: 'ConstitutionDAO', TRUMP: 'Trump', PEPE: 'Pepe'
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

  var S = { flag: 'optin', mode: 'pro', place: 'home', sym: null, pid: null, done: null, seen: {}, res: null, sig: '', homeY: 0, claim: false, lastErr: null, snackT: null };
  var el = {}, R = {};
  var sheets = [], H = { depth: 0, skip: 0 };

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
    S.place = place; S.sym = sym || S.sym; S.pid = pid || null; S.pickOnce = !!pid; S.sig = ''; S.since = Date.now();
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
    var i = h('input'); i.type = 'text'; i.id = id; i.value = value; i.maxLength = 9;
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
    if (kind === 'err') { S.lastErr = { text: plain(text), at: Date.now() }; if (!S.claim && !sheets.length && !/HyperEVM|Switch|^Closed |liquidated/.test(text) && !(S.place === 'coin' && /did not go through|Didn.t open/.test(text))) snack(S.lastErr.text);      /* not twice: the coin's card says that one itself */ kick(); }
    else if (S.tell && Date.now() - S.tell < 15000) { S.tell = 0; snack(plain(text)); }      /* the answer to Switch wallet, said once */
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
    var ps = w.account && a.loaded ? api.positions() : [], os = w.account ? api.openings() : [];
    var st = homeState(w, a), p = ADD.pend;
    var sig = ['dkLeft', st, w.has, p ? p.rail + p.state : '', S.res ? S.res.key : '', ps.map(x => x.id).join(','), os.map(x => x.key).join(','),
      mk.map(m => m.sym).join(','), api.applePayOn(), a.inTrades > 0, S.sym].join('|');

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

      /* pending add note */
      if (p) {
        DK.R.pend = noteCard();
        DK.R.pend.n.addEventListener('click', () => { openAddDesktop(); });
        add(scroll, h('div', 'sm-sec', DK.R.pend.n));
      }

      /* result card */
      if (S.res) {
        var res = S.res, c = noteCard(), win = res.pnl > 0;
        txt(c.b, res.liq ? res.sym + ' closed itself' : res.sym + ' closed: ' + usdP(res.pnl));
        txt(c.i, res.liq ? 'The ' + usdS(res.lost) + ' you put in is gone.' : usd(res.paid) + ' is back in your trading money.');
        c.icon.className = 'sm-pill ' + (win ? 'is-up' : 'is-dn'); c.icon.textContent = win ? '✓' : '×';
        c.n.addEventListener('click', () => { S.done = res; S.res = null; S.sym = res.sym; S.place = 'done'; S.sig = ''; paint(); });
        add(scroll, h('div', 'sm-sec', c.n));
      }

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
        var row = btn('sm-row' + (S.sym === m.sym ? ' is-sel' : ''), [h('span', 'sm-tk', [h('b', null, m.sym), h('i', null, nameOf(m.sym))]), r.spk, h('span', 'sm-pr', [r.v, r.c])], () => { selectCoin(m.sym); });
        list.appendChild(row);
      });
      var sec = h('div', 'sm-sec', [h('div', 'sm-label', 'Trade a coin'), list]);
      add(scroll, sec);
    }

    /* update values */
    var bt = st !== 'visitor' && a.loaded ? usd(a.available) : '$—';
    txt(DK.R.bal, bt); cls(DK.R.bal, 'sm-big' + (bt.length > 11 ? ' is-longer' : bt.length > 9 ? ' is-long' : ''));
    if (DK.R.sub && st === 'money') txt(DK.R.sub, a.inTrades > 0 ? usd(a.inTrades) + ' more is in your open trades.' : '');
    if (p && p.final && p.state === 'done' && !DK.panel && Date.now() - (p.at || 0) > 60000) { dropPend(); return; }
    if (DK.R.pend && p) fillPend(p);

    /* update trade rows */
    var ps2 = w.account && a.loaded ? api.positions() : [], os2 = w.account ? api.openings() : [];
    ps2.forEach(x => {
      var r = DK.R.rows['p' + see(x)]; if (!r) return;
      var st2 = x.status;
      txt(r.sub, st2 ? plainStatus(st2.text) : usdS(x.margin) + ' in');
      txt(r.v, x.delayed || !isFinite(x.pnl) ? '—' : (x.est ? '≈ ' : '') + usdP(x.pnl)); cls(r.v, tone(x.pnl));
      txt(r.c, x.delayed || !isFinite(x.pnl) ? 'price delayed' : pct(x.pnl / x.margin)); cls(r.c, tone(x.pnl));
    });
    os2.forEach(o => { var r = DK.R.rows['o' + o.key]; if (r) { txt(r.sub, plainStatus(o.say)); cls(r.sub, o.tone === 'bad' ? 'sm-dn' : ''); } });

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
    var os = w.account ? api.openings().filter(o => o.sym === S.sym) : [];

    var sig = ['center', S.sym, S.pid, ps.map(x => x.id).join(','), os.map(o => o.key).join(','), COIN.tf, S.place].join('|');
    if (DK.centerSig !== sig) {
      DK.centerSig = sig;
      inner.textContent = '';
      DK.CR = { cards: {} };

      add(inner, h('div', 'sm-cname', nameOf(S.sym)));
      var cbar = h('div', 'sm-cbar');
      DK.CR.px = h('span', 'sm-price', '—');
      DK.CR.chg = h('span', 'sm-chg', '');
      add(cbar, [DK.CR.px, DK.CR.chg]);
      add(inner, cbar);

      /* chart */
      var chart = h('div', 'sm-chart' + (ps.length ? ' is-set' : ''));
      DK.CR.svg = svg(null, '0 0 100 100'); DK.CR.svg.setAttribute('preserveAspectRatio', 'none');
      DK.CR.marks = h('div', 'sm-marks');
      DK.CR.csay = h('div', 'sm-chart-say', '');
      add(chart, [DK.CR.svg, DK.CR.marks, DK.CR.csay]);
      add(inner, chart);

      /* timeframe buttons */
      DK.CR.tf = h('div', 'sm-tf');
      ['1H', '1D', '1W', '1M'].forEach(t => {
        var b = btn(null, t, () => {
          if (t === 'Candles') { api.pro('candles', S.sym); setMode('pro'); return; }
          COIN.tf = t; S.sig = ''; paint();
        });
        DK.CR.tf.appendChild(b);
      });
      add(inner, DK.CR.tf);

      /* positions */
      if (ps.length || os.length) {
        var trades = h('div', 'sm-trades');
        os.forEach(o => { trades.appendChild(buildPosCardDesktop(o, true)); });
        ps.forEach(x => { trades.appendChild(buildPosCardDesktop(x, false)); });
        var tl = h('div', 'sm-label', (ps.length + os.length > 1 ? 'Your trades on ' : 'Your trade on ') + S.sym); tl.style.marginTop = '28px'; add(inner, [tl, trades]);
      }

      /* Up/Down bar */
      dirbar.hidden = false;
      dirbar.textContent = '';
      add(dirbar, [
        btn('sm-dir is-up', ['▲ UP', h('i', null, '(Click here to open)')], () => { openOrderDesktop(S.sym, true); }),
        btn('sm-dir is-dn', ['▼ DOWN', h('i', null, '(Click here to open)')], () => { openOrderDesktop(S.sym, false); })
      ]);
    }

    /* update values */
    if (q && m) {
      var px = q.px, prev = q.prev, move = prev > 0 && px > 0 ? px / prev - 1 : NaN;
      txt(DK.CR.px, price(px, q.sz)); cls(DK.CR.px, 'sm-price' + (String(price(px, q.sz)).length > 10 ? ' is-long' : ''));
      txt(DK.CR.chg, isFinite(move) ? arrow(move) + pct(move) + ' today' : ''); cls(DK.CR.chg, 'sm-chg ' + tone(move));
      drawChart(m, q, ps.length ? chartMarks(ps[0]) : []);
    }

    /* trade cards: P&L, the Close button, and why a close did not happen */
    ps.forEach(x => {
      var c = DK.CR.cards && DK.CR.cards[x.id]; if (!c) return;
      var mine = COIN.closing === x.id, err = COIN.errs[x.id] || '';
      txt(c.pnl, (x.est ? '≈ ' : '') + usdP(x.pnl)); cls(c.pnl, 'sm-pnl ' + tone(x.pnl));
      txt(c.go, mine ? 'Closing…' : 'Close · take about ' + usd(x.payout)); c.go.disabled = !!COIN.closing || x.status === 'closing';
      txt(c.say, err); show(c.say, !!err);
    });
    os.forEach(o => { var c = DK.CR.cards && DK.CR.cards['o' + o.key]; if (c) txt(c.say, plainStatus(o.say)); });

    /* update tf buttons */
    each(DK.CR.tf, b => { b.setAttribute('aria-pressed', b.textContent === COIN.tf ? 'true' : 'false'); });
  }

  function buildPosCardDesktop(x, isOpening) {
    var card = h('div', 'sm-pos' + (isOpening ? ' is-quiet' : ''));
    var hdr = h('div', 'sm-pos-h', [h('span', null, [sidePill(x.isLong), h('span', 'sm-in', usdS(x.margin) + ' × ' + x.lev)])]);
    add(card, hdr);
    var c = { pnl: h('div', 'sm-pnl'), say: h('p', 'sm-say is-bad') };
    if (!isOpening) {
      c.go = btn('sm-btn is-primary', '', () => { if (!COIN.closing && !early()) closeGo(x.id); });
      c.say.hidden = true; add(card, [c.pnl, c.go, c.say]); DK.CR.cards[x.id] = c;
    } else {
      c.say = h('p', 'sm-say', plainStatus(x.say)); add(card, c.say); DK.CR.cards['o' + x.key] = c;
    }
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
    if (!ADD.busy) ADD.view = ADD.fin ? 'finish' : p ? (p.final ? (p.state === 'done' ? 'ready' : 'fail') : p.rail === 'apple' ? 'apple' : 'moving') : 'form';
    ADD.err = ''; ADD.built = '';
    api.refresh().catch(noop); readBalances(); scheduleQuote(0);
    S.sig = ''; paint();
  }

  function closePanel() {
    DK.panel = ''; DK.busy = false;
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
      var lab = h('label', 'sm-label', 'Amount'); lab.htmlFor = 'smDkOrdAmount';
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

      add(body, [lab, h('div', 'sm-amt is-mid', [h('span', null, '$'), DK.OR.amt]), chips,
        h('div', 'sm-label', 'Boost'), seg, DK.OR.levBox, DK.OR.risk,
        h('div', 'sm-out', [h('div', null, [DK.OR.wk, DK.OR.w]), h('div', null, [DK.OR.lk, DK.OR.l])])]);

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

    var needMoney = a.loaded && a.available < (t.min || 5);
    var why = '';
    if (t.block) why = plain(t.block);
    else if (DK.orderCustom && DK.orderLevBad) why = 'Type a boost from 1× to ' + m.maxLev + '×.';
    else if (needMoney) why = 'You need at least ' + usdS(t.min || 5) + ' to trade.';
    else if (!(amt2 > 0)) why = 'Type an amount.';
    else if (amt2 < t.min) why = 'The smallest trade is ' + usdS(t.min) + '.';
    else if (amt2 > a.available + 1e-9) why = 'That is more than your trading money (' + usd(a.available) + ').';
    else if (t.problem) why = plain(t.problem);

    txt(DK.OR.say, why || DK.orderErr || ''); cls(DK.OR.say, 'sm-say' + (why || DK.orderErr ? ' is-bad' : ''));
    var word = DK.busy ? (!api.demo && (!api.session().live || t.oneTap) ? CONFIRM : 'Opening…') : '';
    DK.OR.go._add = needMoney && !t.block && !DK.busy;
    txt(DK.OR.go, word || (DK.OR.go._add ? 'Add money' : 'Open ' + (up ? 'UP' : 'DOWN') + ' · ' + usdS(amt2) + ' × ' + lev));
    cls(DK.OR.go, 'sm-btn ' + (DK.OR.go._add ? 'is-primary' : up ? 'is-up' : 'is-dn') + (word ? ' is-busy' : ''));
    DK.OR.go.disabled = !!word || (!!why && !DK.OR.go._add);
  }

  function desktopOrderGo() {
    if (DK.busy || early()) return;
    if (DK.OR.go._add) { closePanel(); openAddDesktop(); return; }
    if (DK.OR.go.disabled) return;
    var amt = parseFloat(String(DK.orderTyped).replace(/[^0-9.]/g, '')) || 0;
    var o = { sym: DK.orderSym, isLong: DK.orderLong, margin: amt, lev: DK.orderLev, maxed: DK.orderAll, tp: null, sl: null };
    var s = api.session(), t = api.trade(o) || {};
    /* this press has a token: closing the panel ends it, and a press that has ended sends nothing */
    var mine = DK.busy = Date.now() + Math.random();
    DK.orderErr = ''; S.claim = true; S.lastErr = null; paint();
    (!api.demo && (!s.live || t.oneTap) ? timed(api.toHyperEvm(), 30000, STAYED + 'nothing was sent. Press again and let it change.') : Promise.resolve()).then(() => {
      if (DK.busy !== mine || DK.panel !== 'order') { S.claim = false; return; }
      var why = api.open(o); DK.busy = false; S.claim = false;
      if (why) { DK.orderErr = plain(why); paint(); return; }
      if (!o.maxed) lsSet(AMT_KEY, String(o.margin)); lsSet('confetti.trade.lev.' + o.sym, String(o.lev));
      closePanel();
    }, e => { if (DK.busy !== mine) return; DK.busy = false; S.claim = false; DK.orderErr = errText(e); paint(); });
  }

  function paintDesktopAdd() {
    var head = el.panelHead, body = el.panelBody, foot = el.panelFoot;
    var v = ADD.view || 'form';

    head.querySelector('h2').textContent = v === 'form' ? 'Add money' : v === 'moving' || v === 'apple' ? 'On its way' : v === 'ready' ? 'Added' : v === 'finish' ? 'Finish adding' : 'Not added';
    head.querySelector('.sm-x').onclick = closePanel;

    if (ADD.built !== v + '-dk') {
      ADD.built = v + '-dk'; body.textContent = ''; foot.textContent = ''; ADD.R = {};
      /* Create a temporary sheet-like object for build functions to use the panel directly */
      var tempSh = { title: head.querySelector('h2'), body: body, foot: foot, d: el.right, isOpen: true, close: closePanel };
      var oldSh = ADD.sh;
      ADD.sh = tempSh;
      ({ form: buildForm, moving: buildMoving, apple: buildMoving, ready: buildReady, fail: buildFail, finish: buildFinish })[v]();
      ADD.sh = oldSh;
    }
    /* Use temp sheet for fill functions so they update the panel elements */
    var tempSh2 = { title: head.querySelector('h2'), body: body, foot: foot, d: el.right, isOpen: true, close: closePanel };
    var oldSh2 = ADD.sh;
    ADD.sh = tempSh2;
    ({ form: fillForm, moving: fillMoving, apple: fillMoving, ready: fillReady, fail: noop, finish: fillFinish })[v]();
    fillWait();
    ADD.sh = oldSh2;
  }

  /* Escape key closes panel */
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && shown() && isDesktop() && DK.panel && !document.querySelector('dialog[open]')) { closePanel(); ev.preventDefault(); }
  });


  function paintTop() {
    var w = api.wallet(), a = api.account();
    var dk = isDesktop();
    var key = [dk ? 'dk' : (S.place === 'coin' ? S.sym : ''), w.account || '', w.ready, w.has, a.loaded, window.innerWidth < 380].join('|');
    if (el.top.getAttribute('data-k') !== key) {
      el.top.setAttribute('data-k', key); el.top.textContent = '';
      var left;
      if (!dk && S.place === 'coin') { left = btn('sm-back', [h('span', 'sm-arr', '←'), S.sym], () => { back(); }); left.setAttribute('aria-label', 'Back to the coins'); }
      else {
        left = h('a', 'sm-logo', ['confetti', h('i', null, '_')]); left.href = 'trade.html'; left.setAttribute('aria-label', 'confetti, home');
        left.addEventListener('click', ev => { ev.preventDefault(); if (!dk && S.place !== 'home') back(); else if (el.main) el.main.scrollTop = 0; });
      }
      var rightItems = [];
      if (dk) {
        /* Desktop header: money chip (connected), wallet chip or Connect button, Menu */
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
        /* Phone header: money chip and wallet/menu chip */
        R.money = btn('sm-chip', h('span', null, h('b', null, '')), () => { openAdd(); });
        R.money.setAttribute('aria-label', 'Your trading money. Add money');
        R.who = btn('sm-chip' + (w.account ? '' : ' is-off'), h('span', null, w.account ? [h('i', 'sm-dot'), short(w.account)] : 'Menu'), openMenu);
        R.who.setAttribute('aria-label', w.account ? 'Wallet ' + w.account + '. Menu' : 'Menu');
        rightItems.push(R.money, R.who);
      }
      add(el.top, [left, h('span', 'sm-top-r', rightItems)]);
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
    var ps = w.account && a.loaded ? api.positions() : [], os = w.account ? api.openings() : [];
    var st = homeState(w, a), p = ADD.pend;
    var sig = ['home', st, w.has, p ? p.rail + p.state : '', S.res ? S.res.key : '', ps.map(x => x.id).join(','), os.map(x => x.key).join(','),
      mk.map(m => m.sym).join(','), api.applePayOn(), a.inTrades > 0].join('|');
    if (S.sig !== sig) { S.sig = sig; buildHome(st, w, a, mk, ps, os, p); }
    var bt = st !== 'visitor' && a.loaded ? usd(a.available) : '$—';      /* no wallet yet: a dash, as on the desktop page, never "$0.00" */
    txt(R.bal, bt); cls(R.bal, 'sm-big' + (bt.length > 11 ? ' is-longer' : bt.length > 9 ? ' is-long' : ''));
    if (R.sub && st === 'money') txt(R.sub, a.inTrades > 0 ? usd(a.inTrades) + ' more is in your open trades.' : '');
    if (p && p.final && p.state === 'done' && !(ADD.sh && ADD.sh.isOpen) && Date.now() - (p.at || 0) > 60000) { dropPend(); return; }
    if (R.pend && p) fillPend(p);
    ps.forEach(x => {
      var r = R.rows['p' + see(x)]; if (!r) return;
      var st2 = x.status;
      txt(r.sub, st2 ? plainStatus(st2.text) : usdS(x.margin) + ' in');
      txt(r.v, x.delayed || !isFinite(x.pnl) ? '—' : (x.est ? '≈ ' : '') + usdP(x.pnl)); cls(r.v, tone(x.pnl));
      txt(r.c, x.delayed || !isFinite(x.pnl) ? 'price delayed' : pct(x.pnl / x.margin)); cls(r.c, tone(x.pnl));
    });
    os.forEach(function (o) { var r = R.rows['o' + o.key]; if (r) { txt(r.sub, plainStatus(o.say)); cls(r.sub, o.tone === 'bad' ? 'sm-dn' : ''); } });
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
    else if (st === 'empty' && !p) add(main, h('p', 'sm-mid', api.applePayOn() ? 'Add money to start: Apple Pay, or ETH you already have on Base, Arbitrum or Ethereum.' : 'Add money to start, with ETH you already have on Base, Arbitrum or Ethereum.'));
    else if (st === 'money') {
      if (a.inTrades > 0) add(main, R.sub = h('p', 'sm-mid', ''));
      add(main, h('div', 'sm-links', [btn('sm-link', 'Add money', () => { openAdd(); }), a.available > 0 ? btn('sm-link', 'Withdraw', withdraw) : null]));
    }
    if (p) { R.pend = noteCard(); R.pend.n.addEventListener('click', () => { openAdd(); }); add(main, R.pend.n); }
    if (S.res) {
      var res = S.res, c = noteCard(), win = res.pnl > 0;
      txt(c.b, res.liq ? res.sym + ' closed itself' : res.sym + ' closed: ' + usdP(res.pnl)); txt(c.i, res.liq ? 'The ' + usdS(res.lost) + ' you put in is gone.' : usd(res.paid) + ' is back in your trading money.');
      c.icon.className = 'sm-pill ' + (win ? 'is-up' : 'is-dn'); c.icon.textContent = win ? '✓' : '×';
      c.n.addEventListener('click', () => { S.done = res; S.res = null; go('done', res.sym); });
      add(main, c.n);
    }
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
      var row = btn('sm-row', [h('span', 'sm-tk', [h('b', null, m.sym), h('i', null, nameOf(m.sym))]), r.spk, h('span', 'sm-pr', [r.v, r.c])], () => { go('coin', m.sym); });
      list.appendChild(row);
    });
    var sec = h('div', 'sm-sec', [h('div', 'sm-label', 'Trade a coin'), list]); sec.id = 'smCoins';
    add(main, sec);
    if (st === 'visitor') {
      add(cta, btn('sm-btn is-primary', w.has ? 'Connect wallet' : 'Open in your wallet app', doConnect));
      if (!api.demo) { var d = h('a', 'sm-link', 'Just looking? Try it with pretend money'); d.href = 'trade.html?demo=1&mode=simple'; d.style.justifyContent = 'center'; add(cta, d); }
    } else if (st === 'empty' && !p) add(cta, btn('sm-btn is-primary', 'Add money', () => { openAdd(); }));
    loadSparks(mk);
  }
  function see(x) { S.seen[x.id] = { sym: x.sym, isLong: x.isLong, lev: x.lev, margin: x.margin }; return x.id; }
  function noteCard() {
    var c = { icon: h('span', 'sm-spin'), b: h('b'), i: h('i') };
    c.n = btn('sm-note', [c.icon, h('span', 'sm-t', [c.b, c.i]), h('span', 'sm-chev', '›')]);
    return c;
  }
  function tradeRow(key, x, fn, rows) {
    var r = (rows || R.rows)[key] = { sub: h('i'), v: h('b', null, key.charAt(0) === 'o' ? usdS(x.margin) : '—'), c: h('i') };
    var pill = h('span', 'sm-pill ' + (x.isLong ? 'is-up' : 'is-dn'), (x.isLong ? '▲ UP ' : '▼ DOWN ') + x.lev + '×');
    var who = h('b', null, [x.sym + ' ', pill]); who.style.display = 'flex'; who.style.alignItems = 'center'; who.style.gap = '8px';
    return btn('sm-row is-pos', [h('span', 'sm-tk', [who, r.sub]), h('span', 'sm-pr', [r.v, r.c])], fn);
  }
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
    if (!NO_PRO) add(list, item('Pro view', 'candles, limit orders, history, points', () => { api.pro('coin', S.place !== 'home' ? S.sym : null); setMode('pro'); }));      /* from a coin: Pro opens on that coin */
    if (!w.account && !api.demo) add(list, item('Try it with pretend money', '', null, 'trade.html?demo=1&mode=simple'));
    if (api.demo) add(list, item('Leave the demo', 'trade for real', null, 'trade.html?mode=simple'));
    /* the site's other pages (owner 2026-11-12: "we also had other stuff we hadded", "do both") */
    add(list, h('div', 'sm-label', 'More'));
    [['Portfolio', 'your trades and history', 'portfolio.html'], ['Leaderboard', 'points and PnL', 'leaderboard.html'], ['House', 'provide liquidity', 'house.html'],
     ['$FETTI', 'stake and earn', 'confetti.html'], ['Docs', 'how it works', 'docs.html'], ['Contracts', 'on HyperEVM', 'contracts.html']].forEach(r => { add(list, item(r[0], r[1], null, r[2])); });
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
    return getJson(CH[chain].rpc, { jsonrpc: '2.0', id: 1, method: method, params: params || [] }).then(j => { if (j.error) throw new Error(j.error.message || 'rpc'); return j.result; });
  }

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
  var RAILS = { relay: relay, debridge: debridge };
  /* Relay first. The second rail only when Relay itself says it has no route for the order; a timeout, a busy answer or an
     answer the page refused keeps the first rail and is asked again. Every quote is then held against the page's own figures. */
  var NO_ROUTE = /^(NO_SWAP_ROUTES_FOUND|NO_INTERNAL_SWAP_ROUTES_FOUND|NO_QUOTES|INSUFFICIENT_LIQUIDITY|UNSUPPORTED_ROUTE|UNSUPPORTED_CURRENCY|SWAP_IMPACT_TOO_HIGH)$/;
  function held(q, o) {
    var mine = Number(q.payWei) / 1e18 * o.ethPx;          /* what the ETH is worth at the page's own price */
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
    err: '', chainsOpen: false, busy: '', wait: null, pend: null, fin: null, ttimer: null, atimer: null, added: null, balErr: {}, btimer: null, run: 0, rtimer: null, asking: 0 };

  function amount() { var n = Number(String(ADD.typed).replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; }
  function ethPx() { var p = api.price('ETH'); return p && p.px > 0 ? p.px : NaN; }
  function balUsd(c) { var b = ADD.bal[c], px = ethPx(); return b != null && px > 0 ? Number(b) / 1e18 * px : NaN; }
  function spendable(c) { var b = ADD.bal[c]; return b != null && b > CH[c].keep ? b - CH[c].keep : 0n; }
  /* The wallet's ETH on the three chains. The chain the wallet is on is read through the wallet, the others over a public
     RPC. A read that failed leaves that chain unknown (never zero) and is asked again a few seconds later. */
  function readBalances() {
    var w = api.wallet(); if (!w.account) return;
    if (ADD.balFor !== w.account) { ADD.bal = {}; ADD.balErr = {}; ADD.balFor = w.account; }
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
  }
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
    return { apple: api.applePayOn(), eth: true, wallet: a.walletUsdc >= 1 };
  }
  function method() {
    var m = methods(), c = chainNow();
    if (ADD.method && m[ADD.method]) return ADD.method;
    if (c != null) return 'eth';
    if (m.wallet) return 'wallet';
    return m.apple ? 'apple' : 'eth';
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
  function orderOf() {
    var f = api.fees(), w = api.wallet();
    return { chain: chainNow(), usd: amount(), account: w.account, topUsd: topUsd(), feePct: f.wallet ? f.bridgePercent : 0, feeTo: f.wallet, ethPx: ethPx() };
  }
  function scheduleQuote(ms) { clearTimeout(ADD.qtimer); ADD.qtimer = setTimeout(doQuote, ms == null ? 350 : ms); }
  function doQuote() {
    clearTimeout(ADD.qtimer);
    if (!ADD.sh || !ADD.sh.isOpen || ADD.view !== 'form' || ADD.busy) return;
    var o = orderOf(), seq = ++ADD.qseq;
    if (method() !== 'eth' || o.chain == null || !(o.usd >= MIN_ADD_USD) || !(o.ethPx > 0) || document.hidden || api.gate()) { ADD.q = null; ADD.qerr = ''; ADD.quoting = false; paintAdd(); if (document.hidden) scheduleQuote(5000); return; }
    ADD.quoting = true; paintAdd();
    var soon = false;
    quoteRails(o).then(function (q) { if (seq === ADD.qseq) { ADD.q = q; ADD.q.forUsd = o.usd; ADD.qerr = ''; ADD.qsoon = false; } }, function (e) { if (seq === ADD.qseq) { ADD.q = null; ADD.qerr = errText(e); soon = ADD.qsoon = !!(e && e.again); } }).then(() => {
      if (seq !== ADD.qseq) return;
      ADD.quoting = false; paintAdd();
      ADD.qtimer = setTimeout(doQuote, soon ? 5000 : 25000);  /* quotes go stale: asked again while the sheet is open, and once more before sending */
    });
  }
  function finOf(p) { return p.rail === 'apple' ? (p.swapped ? { hype: false, cap: p.usdc || 0 } : { hype: true, hype0: p.hype0 }) : { hype: false, cap: p.net }; }
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
    if (!ADD.busy) ADD.view = ADD.fin ? 'finish' : p ? (p.final ? (p.state === 'done' ? 'ready' : 'fail') : p.rail === 'apple' ? 'apple' : 'moving') : 'form';
    ADD.err = ''; ADD.built = '';
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
      ({ form: buildForm, moving: buildMoving, apple: buildMoving, ready: buildReady, fail: buildFail, finish: buildFinish })[v]();
    }
    ({ form: fillForm, moving: fillMoving, apple: fillMoving, ready: fillReady, fail: noop, finish: fillFinish })[v]();
    fillWait();
  }

  function buildForm() {
    var sh = ADD.sh, r = ADD.R, m = methods();
    txt(sh.title, 'Add money');
    r.amt = amtInput('smAddAmount', 'How much, in dollars', ADD.typed, v => { ADD.typed = v; ADD.err = ''; ADD.q = null; ADD.max = false; paintAdd(); scheduleQuote(); });
    var lab = h('label', 'sm-label', 'How much'); lab.htmlFor = 'smAddAmount';
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
      p.n = btn('sm-pick', [h('span', 'sm-radio'), h('span', 'sm-t', [h('b', null, title), p.sub])], ev => {
        if (p.more && p.more.contains(ev.target)) return;
        ADD.method = key; ADD.err = ''; ADD.q = null; ADD.max = false; paintAdd(); scheduleQuote(0);
      });
      p.n.setAttribute('role', 'radio');
      return p;
    }
    r.apple = pick('apple', 'Apple Pay'); r.eth = pick('eth', 'ETH in your wallet'); r.wallet = pick('wallet', 'Money already in your wallet');
    r.eth.more = h('span', 'sm-more', '›'); r.eth.more.setAttribute('role', 'button'); r.eth.more.setAttribute('aria-label', 'Choose where the ETH comes from');
    r.eth.more.addEventListener('click', () => { ADD.method = 'eth'; ADD.chainsOpen = !ADD.chainsOpen; paintAdd(); });
    r.eth.n.appendChild(r.eth.more);
    r.opts = h('div', 'sm-opts');
    CH_ORDER.forEach(function (c) { var b = btn(null, [h('span', null, CH[c].name), h('span')], () => { ADD.userChain = c; ADD.method = 'eth'; ADD.chainsOpen = false; ADD.q = null; ADD.err = ''; paintAdd(); scheduleQuote(0); }); b._c = c; r.opts.appendChild(b); });
    var group = h('div', null, [r.apple.n, r.eth.n, r.opts, r.wallet.n]); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'Pay with');
    r.get = h('span', 'is-go', ''); r.eta = h('span', null, '');
    r.fine = h('p', 'sm-fine', '');
    add(sh.body, [lab, h('div', 'sm-amt', [h('span', null, '$'), r.amt]), r.chips, h('div', 'sm-label', 'Pay with'), group,
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
    if (m !== 'eth') return 250;
    var c = chainNow(), px = ethPx();
    return c != null && px > 0 ? Math.floor(Number(spendable(c)) / 1e18 * px * 0.995 * 100) / 100 : 0;
  }
  function fillForm() {
    var r = ADD.R, m = method(), ms = methods(), a = api.account(), w = api.wallet(), amt = amount(), c = chainNow(), q = ADD.q && ADD.q.chain === c && Math.abs(ADD.q.forUsd - amt) < 0.005 ? ADD.q : null;
    var busy = !!ADD.busy;
    if (document.activeElement !== r.amt && r.amt.value !== ADD.typed) r.amt.value = ADD.typed;
    r.amt.disabled = busy;
    each(r.chips, b => {
      var v = b._slot === 'max' ? (m === 'apple' ? 250 : 'max') : b._slot; b._v = v;
      txt(b, v === 'max' ? 'Max' : '$' + v);
      b.setAttribute('aria-pressed', (v === 'max' ? !!ADD.max : !ADD.max && amt === v) ? 'true' : 'false'); b.disabled = busy;
    });
    show(r.wallet.n, ms.wallet);
    [['apple', r.apple], ['eth', r.eth], ['wallet', r.wallet]].forEach(x => { x[1].n.setAttribute('aria-checked', x[0] === m ? 'true' : 'false'); x[1].n.disabled = busy; });
    txt(r.apple.sub, 'Card on your phone · a few minutes');
    txt(r.wallet.sub, usd(a.walletUsdc) + ' ready to add');
    var all = CH_ORDER.every(x => ADD.bal[x] != null), bad = CH_ORDER.filter(x => ADD.bal[x] == null && ADD.balErr[x])[0];
    /* "No ETH" only when all three chains answered; a chain that could not be read is said as that (it is asked again by itself) */
    txt(r.eth.sub, c != null ? 'On ' + CH[c].name + ' · you have ' + usd(balUsd(c)) : bad != null ? 'Could not check ' + CH[bad].name + ' just now.' : !all ? 'Looking in your wallet…' : 'No ETH found on Base, Arbitrum or Ethereum');
    show(r.opts, ADD.chainsOpen && m === 'eth');
    each(r.opts, b => {
      var x = b._c, v = balUsd(x);
      txt(b.lastChild, ADD.refused[x] ? 'not in this wallet' : ADD.bal[x] == null ? (ADD.balErr[x] ? 'could not check' : '…') : usd(v));
      b.setAttribute('aria-pressed', x === c ? 'true' : 'false'); b.disabled = !!ADD.refused[x] || !(ADD.bal[x] > 0n);
    });
    /* the summary: what lands (exact: the order fixes it), and when */
    var get = '…', eta = '', fine = '', why = ADD.err, ok = false, label = 'Add ' + usdS(amt), note = '', retry = false;
    if (m === 'eth') {
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
          if (all) note = ms.apple ? 'No ETH in this wallet on Base, Arbitrum or Ethereum. Apple Pay works without any.' : 'Send ETH to this wallet on Base, switch wallet, or tap Other ways to add.';
          if (note && !r.seen) { r.seen = true; setTimeout(() => { if (r.other.scrollIntoView) r.other.scrollIntoView({ block: 'nearest' }); }, 80); }
        } else {
          why = why || (amt > 0 && amt < MIN_ADD_USD ? 'The smallest amount is ' + usdS(MIN_ADD_USD) + '.' : amt > 0 && !ADD.qsoon ? ADD.qerr : '');
          /* a price service that is busy is not the person's mistake: said quietly, and it is asked again by itself */
          if (!why && amt >= MIN_ADD_USD && ADD.qsoon && ADD.qerr) note = 'Still getting a price. It is asked again by itself.';
          retry = amt >= MIN_ADD_USD && !!ADD.qerr && !ADD.err;       /* no price: the button asks again instead of sitting dead */
        }
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
    if (!(amt > 0)) { get = '—'; ok = false; }
    if (api.gate()) { ok = false; retry = false; why = OFF; }
    txt(r.get, get); txt(r.eta, eta || '—');
    txt(r.fine, fine);
    txt(r.say, why || note || ''); cls(r.say, 'sm-say' + (why ? ' is-bad' : ''));
    var word = { 'switch': 'Getting your wallet ready…', check: 'Checking the price…', wallet: CONFIRM, asking: 'Waiting for your wallet…', open: 'Opening MoonPay…' }[ADD.busy];
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
    add(p, [(w.of ? w.i + ' of ' + w.of + '. ' : '') + 'Your wallet shows one payment of ', h('b', null, w.amount), '. Nothing is sent until you confirm.']);
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
    var q0 = ADD.q, o = orderOf(), c = o.chain, w = api.wallet(), acct = w.account, q = null, a0 = null, hashes = [];
    if (!q0 || q0.chain !== c) return;
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
    timed(walletTo(c), 30000, NO_ANSWER).then(() => {
      check(); ADD.busy = 'check'; paintAdd();
      return Promise.all([RAILS[q0.rail].refresh(q0, o), api.refresh().catch(noop)]);
    }).then(x => {
      check();
      var fq = held(x[0], o); fq.forUsd = q0.forUsd;
      if (fq.payWei > q0.payWei + q0.payWei / 200n) { ADD.q = fq; throw say('The price moved a little. Check the new numbers and press again.'); }
      q = ADD.q = fq;
      return Promise.all([w.eth.request({ method: 'eth_accounts', params: [] }), w.eth.request({ method: 'eth_getBalance', params: [acct, 'latest'] }), w.eth.request({ method: 'eth_gasPrice', params: [] }).catch(() => '0x0')]);
    }).then(x => {
      check();
      var mine = (x[0] || []).some(y => String(y).toLowerCase() === acct.toLowerCase()), bal = BigInt(x[1]), gas = 120000n * BigInt(x[2]) * BigInt(q.steps.length) * 3n / 2n;
      if (!mine) throw say((w.name || 'Your wallet') + ' is not letting this page use ' + short(acct) + '. Open it, pick that account, then press again.');
      ADD.bal[c] = bal;
      if (bal < q.payWei + gas) throw say('You have ' + ethS(bal) + ' ETH on ' + CH[c].name + '. This needs ' + ethS(q.payWei) + ' ETH plus about ' + ethS(gas) + ' ETH for the network. Try less, or tap Max.');
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
          ADD.busy = 'wallet'; ADD.wait = { text: i + '|' + st.value, i: i + 1, of: q.steps.length > 1 ? q.steps.length : 0, amount: ethS(st.value) + ' ETH on ' + CH[c].name }; paintAdd();
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
      } else ADD.err = errText(e);
      redoAdd();
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
    var known = p && typeof p === 'object' && typeof p.since === 'number' && (p.rail === 'apple' || (RAILS[p.rail] && CH[p.chain] && typeof p.hash === 'string'));
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
    if (ADD.sh && ADD.sh.isOpen && (ADD.view === 'moving' || ADD.view === 'apple')) ADD.view = state === 'done' ? 'ready' : state === 'finish' ? 'finish' : 'fail';
    redo();
  }
  /* Following an add. The rail's own word ends it: refunded is said first; done ends it as added (at once when the balance
     shows it or the dollars sit in the wallet, else a quarter of a minute later: the rail's word is final). The balance alone
     ends it only when the rail cannot be asked: a balance that rose for another reason is not this add. A rail that says the
     order failed is shown as that, and still followed (a return may come later). Nothing is asked while the tab is hidden. */
  function track() {
    clearTimeout(ADD.ttimer);
    var p = ADD.pend; if (!p || p.final || p.rail === 'apple' || p.state === 'arrived') return;
    if (document.hidden) return;
    var age = Date.now() - p.since, again = () => { ADD.ttimer = setTimeout(track, age < 60000 ? 2000 : age < 600000 ? 5000 : 15000); };
    var rcpt = p.sentOk ? Promise.resolve(null) : rpc(p.chain, 'eth_getTransactionReceipt', [p.hash]).catch(() => null);
    Promise.all([rcpt, RAILS[p.rail].track(p).catch(() => null), api.refresh().catch(noop)]).then(x => {
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
  function fillPend(p) {
    var c = R.pend, final = p.final, apple = p.rail === 'apple', failed = p.state === 'failed';
    cls(c.icon, final ? 'sm-pill ' + (p.state === 'done' ? 'is-up' : 'is-dn') : p.state === 'arrived' ? 'sm-pill is-up' : failed ? 'sm-pill is-dn' : 'sm-spin');
    txt(c.icon, final ? (p.state === 'done' ? '✓' : '×') : p.state === 'arrived' ? '✓' : failed ? '×' : '');
    txt(c.b, final ? (p.state === 'done' ? usd(p.net) + ' added' : 'Adding ' + usdS(p.usd) + ' did not go through') : p.state === 'arrived' ? 'Your money arrived' : failed ? 'Adding ' + usdS(p.usd) + ' did not go through' : 'Adding ' + usdS(p.usd));
    txt(c.i, final ? (p.state === 'done' ? 'Ready to trade.' : 'Tap to see what happened.') : p.state === 'arrived' ? 'One more step. Tap to finish.' : failed ? 'Tap to see what is known.' : apple ? 'Waiting for your Apple Pay purchase' : p.state === 'sent' && !p.sentOk ? 'Leaving your wallet…' : Date.now() - p.since > 90000 ? (p.rail === 'debridge' ? 'Taking longer than usual.' : 'Taking longer than usual. Your money is safe.') : 'Arriving on confetti…');
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
    var name = CH[p.chain].name, age = Date.now() - p.since, slow = age > 90000, second = p.rail === 'debridge', failed = p.state === 'failed';
    var lost = !p.sentOk && age > 180000;            /* three minutes and the payment itself has not shown up on its chain */
    setStep(r.s[0], p.sentOk ? 'done' : 'now', p.sentOk ? 'Sent from ' + name : 'Leaving ' + name,
      lost ? 'The payment has not shown up on ' + name + '. If your wallet no longer lists it, nothing left.' : p.pay + ' ETH ' + (p.sentOk ? 'left your wallet' : 'is leaving your wallet'));
    setStep(r.s[1], p.sentOk ? 'now' : 'later', 'Arriving on confetti',
      failed ? 'This one did not go through, and we cannot see yet where it stands.'
        : slow && p.sentOk ? (second ? 'Taking longer than usual. It has not arrived yet.' : 'Taking longer than usual. Your money is safe: it arrives, or it goes back to your wallet.') : 'Usually under a minute');
    setStep(r.s[2], 'later', 'Ready to trade', usd(p.net));
    txt(r.fine, failed ? 'What is known: order ' + short(p.id || '') + ', payment ' + short(p.hash) + ' on ' + name + '. We keep looking.' : 'You can close this. We’ll show it here when it lands.');
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
    var sh = ADD.sh, p = ADD.pend || {}, name = (CH[p.chain] || {}).name, second = p.rail === 'debridge' && p.why !== 'origin', link = null;
    txt(sh.title, 'Not added');
    if (second && p.id) { link = h('a', 'sm-link', 'See this order'); link.href = 'https://app.debridge.finance/order?orderId=' + p.id; link.target = '_blank'; link.rel = 'noopener'; }
    add(sh.body, [h('div', 'sm-ok is-loss', '×'), h('div', 'sm-label', 'Adding ' + usdS(p.usd)), h('div', 'sm-big is-mid', 'It didn’t go through'),
      h('p', 'sm-mid', p.why === 'origin' ? 'The payment did not go through on ' + name + ', so nothing left your wallet except the little the network took.'
        : second ? 'The order was cancelled and nothing was added. What it held does not come back by itself: it is claimed back, as dollars on ' + name + ', from the order’s own page.'
        : 'Your ETH is on its way back to your wallet on ' + name + ', less what the network took. Nothing was added.'), link]);
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
     itself, its auto-close prices) and has its own card under the chart, with its own Close and auto-close. Up and Down stay,
     for another trade on the coin. Every trade action is the Pro code's (api.open, api.close) ---- */

  var COIN = { tf: '1D', errs: {}, closing: null };
  function market(sym) { return api.markets().filter(m => m.sym === sym)[0] || null; }
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
    var os = w.account ? api.openings().filter(o => o.sym === sym) : [];
    if (S.pid != null && !ps.some(x => x.id === S.pid)) S.pid = null;
    var mode = ps.length || os.length ? 'trade' : 'chart';
    var sig = ['coin', sym, mode, COIN.tf, ps.map(x => x.id).join(','), os.map(o => o.key).join(',')].join('|');
    if (S.sig !== sig) { S.sig = sig; buildCoin(sym, mode, ps, os); }
    var move = q.prev > 0 && q.px > 0 ? q.px / q.prev - 1 : NaN, pt = price(q.px, q.sz);
    flash(R.px, q.px); txt(R.px, pt); cls(R.px, 'sm-price' + (pt.length > 9 ? ' is-long' : '')); R.px.style.color = q.at && Date.now() - q.at < 15000 ? '' : 'var(--ink-muted)';
    txt(R.chg, isFinite(move) ? arrow(move) + pct(move) + ' today' : ''); cls(R.chg, 'sm-chg ' + tone(move));
    /* the trades on the chart: where each opened, where it closes itself, and its auto-close prices */
    var marks = [], tag = ps.length > 1;
    ps.forEach(x => {
      var t = tag ? (x.isLong ? '▲' : '▼') + x.lev + '× ' : '';
      if (x.entry > 0) marks.push({ px: x.entry, kind: 'entry', label: t + 'opened ' + price(x.entry, x.sz) });
      if (x.endPx > 0) marks.push({ px: x.endPx, kind: 'liq', label: t + 'closes itself ' + price(x.endPx, x.sz) });
      if (x.auto && x.auto.tp != null) marks.push({ px: x.auto.tp, kind: 'tp', label: t + 'take profit ' + price(x.auto.tp, x.sz) });
      if (x.auto && x.auto.sl != null) marks.push({ px: x.auto.sl, kind: 'sl', label: t + 'stop ' + price(x.auto.sl, x.sz) });
    });
    drawChart(m, q, marks);
    os.forEach(o => {
      var c = R.cards['o' + o.key]; if (!c) return;
      txt(c.pnl, o.kind === 'end' ? 'Not opened' : 'Opening…'); txt(c.pct, o.tone ? plainStatus(o.say) : 'A few seconds'); cls(c.pct, 'sm-pnlp ' + (o.tone === 'bad' ? 'sm-dn' : 'sm-mute'));
      /* an order that did not open: one press opens the sheet again for the same coin and side; one held up: one press finishes it */
      var ob = o.btn, ended = o.kind === 'end' && !ob;
      show(c.go, !!ob || ended);
      txt(c.go, ended ? 'Try again' : ob ? (/back/.test(ob) ? ob : 'Finish opening now') : '');
      c.go._act = () => { if (ended) openOrder(o.sym, o.isLong); else if (ob) api.openingAct(o.key); };
    });
    ps.forEach(x => {
      var c = R.cards['p' + see(x)]; if (!c) return;
      var ok = !x.delayed && isFinite(x.pnl);
      txt(c.pnl, ok ? (x.est ? '≈ ' : '') + usdP(x.pnl) : '—'); cls(c.pnl, 'sm-pnl ' + (ok ? tone(x.pnl) : 'sm-mute'));
      txt(c.pct, ok ? pct(x.pnl / x.margin) : 'The price is delayed'); cls(c.pct, 'sm-pnlp ' + (ok ? tone(x.pnl) : 'sm-mute'));
      txt(c.entry, price(x.entry, x.sz));
      txt(c.end, price(x.endPx, x.sz) + (x.entry > 0 && x.endPx > 0 ? ' (' + pct(x.endPx / x.entry - 1, 2) + ')' : '')); cls(c.end, 'sm-dn');
      var au = x.auto ? [x.auto.tp != null ? 'profit at ' + price(x.auto.tp, x.sz) : '', x.auto.sl != null ? 'stop at ' + price(x.auto.sl, x.sz) : ''].filter(Boolean) : null, key = au ? au.join('|') : 'Off';
      if (c.auto._k !== key) {
        c.auto._k = key; c.auto.textContent = '';
        if (!au) txt(c.auto, 'Off'); else add(c.auto, au.length ? au.map((t, i) => { var n = h('span', null, (i ? '' : 'On · ') + t); n.style.whiteSpace = 'nowrap'; n.style.display = 'block'; return n; }) : 'On');
      }
      /* its one action: Close (what it gives back, live), or the close on its way, said in place */
      var st = x.status, mine = COIN.closing === x.id, err = COIN.errs[x.id] || '', say = err, label, busy = false, act = null;
      if (st && st.final) { label = 'Closed'; busy = true; }
      else if (st && st.btn) {
        var again = /again/i.test(st.btn);
        label = again ? 'Try closing again' : 'Finish closing now'; act = () => { api.closeAct(x.id); };
        say = again ? 'It did not close. Your trade is still open.' : 'It is taking longer than usual. One tap finishes it.';
      } else if (st || mine) {
        var still = st && /^Still/.test(st.text);
        label = st && /^Confirm/.test(st.text) ? CONFIRM : still ? 'Still closing…' : st && /^Check|^Closed/.test(st.text) ? plainStatus(st.text) : 'Closing…'; busy = true;
        say = still ? 'Taking longer than usual. Your trade stays open until it closes.' : '';
      }
      else label = 'Close · take about ' + (isFinite(x.payout) && !x.delayed ? usd(x.payout) : usdS(x.margin));
      txt(c.close, label); cls(c.close, 'sm-btn is-primary' + (busy ? ' is-busy' : '')); c.close.disabled = busy; c.close._act = act;
      txt(c.say, say || ''); cls(c.say, 'sm-say' + (err && say === err ? ' is-bad' : '')); show(c.say, !!say);
      c.set.disabled = !!(st || mine); txt(c.chev, c.set.disabled ? '' : '›');
    });
  }
  function buildCoin(sym, mode, ps, os) {
    var main = el.main, cta = el.cta, trade = mode === 'trade';
    main.className = 'sm-main' + (trade ? ' is-trade' : ' is-fit'); main.textContent = ''; cta.textContent = ''; cta.className = 'sm-cta is-two';
    R.cards = {};
    add(main, [h('div', 'sm-cname', nameOf(sym)), h('div', 'sm-cbar', [R.px = h('span', 'sm-price', ''), R.chg = h('span', 'sm-chg', '')])]);
    R.svg = svg('', '0 0 100 100'); R.csay = h('div', 'sm-chart-say', ''); R.marks = h('div', 'sm-marks'); R.marks.setAttribute('aria-hidden', 'true');
    var tf = h('div', 'sm-tf');
    Object.keys(TF).forEach(function (k) { var b = btn(null, k, () => { COIN.tf = k; redo(); }); b.setAttribute('aria-pressed', k === COIN.tf ? 'true' : 'false'); tf.appendChild(b); });
    add(main, [h('div', 'sm-chart' + (trade ? ' is-set' : ''), [R.svg, R.marks, R.csay]), tf]);
    var up = btn('sm-dir is-up', ['▲ Up', h('i', null, '(Click here to open)')], () => { openOrder(sym, true); });
    var dn = btn('sm-dir is-dn', ['▼ Down', h('i', null, '(Click here to open)')], () => { openOrder(sym, false); });
    add(cta, [up, dn]);
    if (!trade) return;
    function head(x) { return h('div', 'sm-pos-h', [h('span', null, [x.sym, sidePill(x.isLong, x.lev)]), h('span', 'sm-in', usdS(x.margin) + ' in')]); }
    var box = h('div', 'sm-trades', h('div', 'sm-label', ps.length + os.length > 1 ? 'Your trades on ' + sym : 'Your trade on ' + sym));
    os.forEach(o => {
      var c = R.cards['o' + o.key] = { pnl: h('div', 'sm-pnl sm-mute', ''), pct: h('div', 'sm-pnlp', '') };
      c.go = btn('sm-btn is-primary', '', () => { if (c.go._act) c.go._act(); }); c.go.hidden = true;
      c.n = h('div', 'sm-pos', [head(o), h('div', 'sm-pnlrow', [c.pnl, c.pct]), c.go]);
      box.appendChild(c.n);
    });
    ps.forEach(x => {
      var c = R.cards['p' + x.id] = { pnl: h('div', 'sm-pnl sm-mute', ''), pct: h('div', 'sm-pnlp', ''), entry: h('span', null, '—'), end: h('span', null, '—'), auto: h('span', null, '—'), chev: h('i', 'sm-chev', '›'), say: sayLine() };
      c.close = btn('sm-btn is-primary', '', () => { if (c.close._act) c.close._act(); else closeGo(x.id); });
      c.set = btn('sm-kv is-btn', [h('span', null, 'Auto-close'), h('span', 'sm-kv-v', [c.auto, c.chev])], () => { api.pro('position', x.id); });
      c.set.setAttribute('aria-label', 'Auto-close for this trade: set take profit and stop loss');
      c.n = h('div', 'sm-pos', [head(x), h('div', 'sm-pnlrow', [c.pnl, c.pct]), c.say, c.close,
        h('div', 'sm-kvs', [h('div', 'sm-kv', [h('span', null, 'You opened at'), c.entry]), h('div', 'sm-kv', [h('span', null, 'Closes itself at'), c.end]), c.set])]);
      box.appendChild(c.n);
    });
    main.appendChild(box);
    /* opened from that trade's row on Home: its card is brought into view */
    var pick = S.pickOnce && S.pid != null && R.cards['p' + S.pid]; S.pickOnce = false;
    if (pick && ps.length > 1 && ps[0].id !== S.pid) setTimeout(() => { if (pick.n.isConnected) pick.n.scrollIntoView({ block: 'nearest' }); }, 60);
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
  function closeGo(pid) {
    var s = api.session();
    if (COIN.closing || early()) return;
    COIN.errs[pid] = ''; COIN.closing = pid; S.claim = true; S.lastErr = null; kick();
    /* the wallet signs a close only when one-tap is not on: then it is asked onto HyperEVM first, and that wait ends by itself
       (after it, a late yes in the wallet only moves the wallet: the close is not sent behind the person's back) */
    (!api.demo && !s.live ? timed(api.toHyperEvm(), 30000, '') : Promise.resolve()).then(() => api.close(pid)).then(ok => {
      if (!ok) COIN.errs[pid] = lastErr() || 'It did not close, so your trade is still open. Try again.';
    }, () => { COIN.errs[pid] = STAYED + 'it did not close. Try again.'; }).then(() => { S.claim = false; COIN.closing = null; kick(); });
  }
  /* a trade ended (closed, or it closed itself): the result takes the coin's place, or waits on Home as a card */
  function onResult(r) {
    var pid = r && r.pid, res = pid && api.result(pid), seen = pid && S.seen[pid];
    if (!res || !seen || !/^[cl]/.test(String(r.key))) { kick(); return; }
    var d = { key: r.key, pid: pid, sym: seen.sym, isLong: seen.isLong, lev: seen.lev, margin: seen.margin, liq: !!res.liq, pnl: res.liq ? -res.lost : res.pnl, paid: res.liq ? 0 : res.paid, lost: res.lost, exit: res.exit };
    if (shown() && !isDesktop() && S.place === 'coin' && S.sym === d.sym && !sheets.length) { S.done = d; S.place = 'done'; S.sig = ''; } else S.res = d;
    redo();
  }
  function paintDone() {
    var d = S.done, a = api.account();
    if (!d) { S.place = 'home'; S.sig = ''; paintHome(); return; }
    if (S.sig !== 'done' + d.key) {
      S.sig = 'done' + d.key;
      var main = el.main, cta = el.cta, win = d.pnl > 0.004, flat = Math.abs(d.pnl) <= 0.004;
      main.className = 'sm-main'; main.textContent = ''; cta.textContent = ''; cta.className = 'sm-cta';
      R.bal = h('b', null, '');
      add(main, [h('div', 'sm-ok' + (win ? '' : flat ? ' is-flat' : ' is-loss'), win ? '✓' : flat ? '=' : '×'),
        h('div', 'sm-label', d.sym + (d.isLong ? ' up ' : ' down ') + d.lev + '×, ' + (d.liq ? 'closed itself' : 'closed')),
        h('div', 'sm-big ' + tone(d.pnl), usdP(d.pnl)),
        h('p', 'sm-mid', d.liq ? ['The price reached ' + (d.exit ? '$' + d.exit : 'its limit') + ', so this trade closed itself. The ' + usdS(d.lost) + ' you put in is gone. Nothing more is owed.', h('br'), 'Balance: ', R.bal]
          : [usd(d.paid) + ' is back in your trading money.', h('br'), 'Balance: ', R.bal])]);
      add(cta, btn('sm-btn is-primary', 'Trade again', () => { S.done = null; S.place = 'coin'; S.sym = d.sym; S.pid = null; S.sig = ''; paint(); }));
      if (win) add(cta, btn('sm-btn is-ghost', 'Share this win', function () { if (!api.share(d.pid)) snack('The picture of this win is no longer here. Your history in Pro view still has it.'); }));
    }
    txt(R.bal, a.loaded ? usd(a.available) : '…');
  }

  /* ---- the sheet: dollars, Boost, both outcomes in dollars, one Open ---- */

  var ORD = { sh: null, sym: null, isLong: true, typed: '10', all: false, lev: 20, err: '', busy: false, auto: false, R: {} };
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
    ORD.sym = sym; ORD.isLong = isLong; ORD.err = ''; ORD.busy = false; ORD.auto = false; ORD.all = false; S.claim = false;
    ORD.typed = String(a.loaded && a.available >= a.min && a.available < last ? Math.floor(a.available) : last);
    ORD.max = m.maxLev; ORD.levBad = false;
    ORD.lev = lv >= 1 && lv <= m.maxLev && Math.round(lv) === lv ? lv : steps.filter(v => v <= 20).pop() || steps[0];
    ORD.custom = steps.indexOf(ORD.lev) < 0;
    sh.title.textContent = ''; add(sh.title, [sym, sidePill(isLong)]);
    sh.body.textContent = ''; sh.foot.textContent = '';
    r.amt = amtInput('smOrdAmount', 'Amount, in dollars', ORD.typed, v => { ORD.typed = v; ORD.all = false; ORD.err = ''; paintOrder(); });
    var lab = h('label', 'sm-label', 'Amount'); lab.htmlFor = 'smOrdAmount';
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
    r.autoV = h('i', null, '');
    r.autoRow = btn('sm-opt', [h('span', null, 'Auto-close (take profit, stop loss)'), r.autoV], function () { ORD.auto = !ORD.auto; paintOrder(); if (ORD.auto) setTimeout(function () { r.autoBox.scrollIntoView({ block: 'nearest' }); }, 30); });
    function pxIn(label) { var i = h('input'); i.type = 'text'; i.setAttribute('inputmode', 'decimal'); i.setAttribute('autocomplete', 'off'); i.placeholder = 'a price, optional'; i.setAttribute('aria-label', label);
      i.addEventListener('input', () => { ORD.err = ''; paintOrder(); }); return i; }
    r.tp = pxIn('Take profit at'); r.sl = pxIn('Stop loss at');
    r.autoBox = h('div', 'sm-auto', [h('label', null, [h('span', null, 'Take profit at'), r.tp]), h('label', null, [h('span', null, 'Stop loss at'), r.sl]), h('p', 'sm-fine', 'Optional. It closes the trade for you while Confetti is open on this phone.')]);
    add(sh.body, [lab, h('div', 'sm-amt is-mid', [h('span', null, '$'), r.amt]), r.chips, h('div', 'sm-label', 'Boost'), r.seg, r.levBox, r.risk,
      h('div', 'sm-out', [h('div', null, [r.wk, r.w]), h('div', null, [r.lk, r.l])]), r.autoRow, r.autoBox]);
    r.say = sayLine();
    r.go = btn('sm-btn', '', orderGo);
    add(sh.foot, [r.say, r.go]);
    sh.onClose = () => { ORD.busy = false; S.claim = false; };
    sh.open(); paintOrder();
  }
  function num(v) { v = String(v || '').trim(); if (!v) return null; var n = Number(v.replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? n : NaN; }
  function paintOrder() {
    var r = ORD.R, sym = ORD.sym, up = ORD.isLong, amt = ordAmount(), lev = ORD.lev, a = api.account(), tk = api.ticket();
    var t = api.trade({ sym: sym, isLong: up, margin: amt, lev: lev }) || {}, mv = api.fmt.move(t.endPct);
    /* an order this sheet handed to the Pro code (ORD.sent): the wallet (first trade: one-tap, once), then on its way; the sheet
       steps aside. Before that the ticket's state is some earlier order's (a trade still open, one still going in) and says
       nothing about this press */
    if (ORD.busy && ORD.sent) {
      if (tk.phase === 'error' || tk.phase === 'refunded' || tk.phase === 'unknown') { ORD.err = plain(tk.msg) || 'It did not go through. Nothing was taken.'; ORD.busy = false; S.claim = false; api.ticketDone(); }
      else if (tk.phase !== 'wallet' && (tk.phase || api.openings().some(o => o.sym === sym) || (ORD.sent && Date.now() - ORD.sent > 20000))) { ORD.busy = false; S.claim = false; ORD.sh.close(); S.sig = ''; return; }
    }
    if (document.activeElement !== r.amt && r.amt.value !== ORD.typed) r.amt.value = ORD.typed;
    each(r.chips, b => { b.setAttribute('aria-pressed', (b._v === 'all' ? ORD.all : !ORD.all && amt === b._v) ? 'true' : 'false'); b.disabled = !!ORD.busy; });
    each(r.seg, b => {
      var on = b._v === 'custom' ? ORD.custom : !ORD.custom && b._v === lev;
      b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.disabled = !!ORD.busy;
      if (b._v === 'custom') txt(b, ORD.custom && !ORD.levBad ? lev + '×' : 'Custom');
    });
    show(r.levBox, ORD.custom); r.lev.disabled = !!ORD.busy;
    r.amt.disabled = r.autoRow.disabled = r.tp.disabled = r.sl.disabled = !!ORD.busy;
    txt(r.risk, lev + '× makes every 1% move worth ' + lev + '%. A ' + mv + '% ' + (up ? 'drop' : 'rise') + ' closes this trade and the ' + (amt > 0 ? usdS(amt) : 'money') + ' is gone.');
    txt(r.wk, sym + (up ? ' up 1%' : ' down 1%')); txt(r.w, isFinite(t.win1) ? usdP(t.win1) : '—');
    txt(r.lk, sym + (up ? ' down ' : ' up ') + mv + '%'); txt(r.l, amt > 0 ? '−' + usd(amt) : '—');
    var tp = ORD.auto ? num(r.tp.value) : null, sl = ORD.auto ? num(r.sl.value) : null;
    show(r.autoBox, ORD.auto); txt(r.autoV, (tp != null || sl != null ? 'On ' : 'Off ') + (ORD.auto ? '▴' : '›')); r.autoRow.setAttribute('aria-expanded', ORD.auto ? 'true' : 'false');
    /* two things can stand above the button: why this trade cannot be opened as typed (the button is off until that changes),
       and what stopped the last press (the button stays on: pressing again is the way on) */
    var err = ORD.err, why = '', needMoney = a.loaded && a.available < (t.min || 5), note = '';
    if (!ORD.busy) {
      if (t.block) why = plain(t.block);
      else if (ORD.custom && ORD.levBad) why = 'Type a boost from 1× to ' + ORD.max + '×.';
      else if (needMoney) why = 'You need at least ' + usdS(t.min || 5) + ' to trade.';
      else if (!(amt > 0)) why = 'Type an amount.';
      else if (amt < t.min) why = 'The smallest trade is ' + usdS(t.min) + '.';
      else if (amt > a.available + 1e-9) why = 'That is more than your trading money (' + usd(a.available) + ').';
      else if (t.room != null && amt * lev > t.room + 1e-6) why = 'Too big right now. Pick a smaller amount or a lower boost.';
      else if (t.problem) why = plain(t.problem);
      else if (tp != null || sl != null) why = plain(api.autoCheck({ sym: sym, isLong: up, margin: amt, lev: lev }, tp, sl) || '');
    }
    if (!why && !err && t.oneTap && !api.demo) note = t.oneTap === 'first' ? 'First trade: your wallet asks once to turn on one‑tap trading. After that, no popups.' : 'Your wallet asks once to renew one‑tap trading.';
    txt(r.say, why || err || note); cls(r.say, 'sm-say' + (why || err ? ' is-bad' : ''));      /* the reason the button is off comes first */
    var word = ORD.busy ? (tk.phase === 'wallet' || t.oneTap ? CONFIRM : 'Opening…') : '';
    r.go._add = needMoney && !ORD.busy && !t.block;
    txt(r.go, word || (r.go._add ? 'Add money' : 'Open ' + (up ? 'UP' : 'DOWN') + ' · ' + usdS(amt) + ' × ' + lev));
    cls(r.go, 'sm-btn ' + (r.go._add ? 'is-primary' : up ? 'is-up' : 'is-dn') + (word ? ' is-busy' : ''));
    r.go.disabled = !!word || (!!why && !r.go._add);
    r.go._o = { sym: sym, isLong: up, margin: amt, lev: lev, maxed: ORD.all, tp: tp, sl: sl };
  }
  function orderGo() {
    var r = ORD.R, o = r.go._o, s = api.session();
    if (ORD.busy || r.go.disabled || early()) return;
    if (r.go._add) { ORD.sh.close(); setTimeout(() => { openAdd(); }, 200); return; }
    /* this press has a token: closing the sheet ends it, and a press that has ended sends nothing */
    var mine = ORD.busy = Date.now() + Math.random(), t = api.trade(o) || {};
    ORD.err = ''; ORD.sent = 0; S.claim = true; S.lastErr = null; paintOrder();
    /* whenever the wallet will be asked (one-tap is not on, or cannot carry this order) it is asked onto HyperEVM first;
       the demo has no wallet and asks nothing */
    (!api.demo && (!s.live || t.oneTap) ? timed(api.toHyperEvm(), 30000, STAYED + 'nothing was sent. Press again and let it change.') : Promise.resolve()).then(() => {
      if (ORD.busy !== mine || !ORD.sh.isOpen) return;
      var why = api.open(o);
      if (why) { ORD.busy = false; S.claim = false; ORD.err = plain(why); } else { ORD.sent = Date.now(); if (!o.maxed) lsSet(AMT_KEY, String(o.margin)); lsSet('confetti.trade.lev.' + o.sym, String(o.lev)); }
      if (ORD.sh.isOpen) paintOrder();
    }, e => { if (ORD.busy !== mine) return; ORD.busy = false; S.claim = false; ORD.err = errText(e); if (ORD.sh.isOpen) paintOrder(); });
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
    el.center = $('smCenter'); el.centerInner = $('smCenterInner'); el.dirbar = $('smDirbar');
    el.right = $('smRight'); el.panelHead = $('smPanelHead'); el.panelBody = $('smPanelBody'); el.panelFoot = $('smPanelFoot');
    if (!el.root || !el.top) return null;
    S.flag = flagOf(); S.flagDk = flagDkOf();
    lsSet(FLAG_KEY, S.flag); lsSet(FLAG_DK_KEY, S.flagDk);
    S.param = param(); S.mode = wantMode();
    /* A page view that painted Pro stays Pro (no flip on a slow load): the flag just cached decides the next load. A view the
       boot painted as Simple is corrected only towards Pro (the flag "off", or nobody asked and it is not the default). */
    if (S.mode === 'simple' && !booted) S.mode = 'pro';
    ['account', 'positions', 'cards', 'action', 'ticket', 'prices', 'stats'].forEach(ev => { api.on(ev, kick); });
    var who = null;
    /* the open sheet shows what the record now says (or the form, read again) */
    function sync() {
      var p = ADD.pend;
      ADD.view = ADD.fin ? 'finish' : p ? (p.final ? (p.state === 'done' ? 'ready' : 'fail') : p.rail === 'apple' ? 'apple' : 'moving') : 'form';
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
    BOOT.hash = '';
    /* Pro's Add USDC entry points open Simple's Add money only while Simple is what the phone shows: with Pro on screen
       (a saved "pro", the First steps guide, a wide window) Pro keeps its own sheet */
    return { shown: shown, toast: onToast, addMoney: () => { if (!shown() || api.demo) return false; openAdd(); return true; } };
  };
  /* simple.js is loaded async: trade.js never waits for it, and whichever arrives second does the hand-over */
  if (typeof window.ConfettiSimpleTake === 'function') window.ConfettiSimpleTake(init); else window.ConfettiSimpleInit = init;
})();
