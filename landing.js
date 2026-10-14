/* ==========================================================================
   confetti_  —  landing.js
   Drives index.html: the ticker tape (Hyperliquid allMids every 5 s), the
   preview card's canvas chart (DOGE 1m candles, last 60), the preview's
   fake order form, the falling confetti and the night-theme toggle.
   No build step, no dependencies. Every network call fails soft.
   ========================================================================== */
(function () {
  'use strict';

  var INFO_URL = 'https://api.hyperliquid.xyz/info';
  var TAPE_COINS = ['DOGE', 'FARTCOIN', 'kPEPE', 'WIF', 'PENGU', 'TRUMP', 'SPX', 'kBONK', 'MELANIA', 'POPCAT'];
  var CHART_COIN = 'DOGE';
  var TAPE_EVERY_MS = 5000;
  var CANDLES_EVERY_MS = 60000;
  var CANDLE_COUNT = 60;
  var TAPE_SPEED_PX_S = 55;
  var THEME_KEY = 'confetti.theme';
  /* DESIGN s5: bust when the adverse move reaches the smaller of 0.95 / leverage and
     1 / leverage - 5 bps (ImpactLib.bustPrice): 5 bps at 1000x, 95 bps at 100x and below. */
  function bustMove(lev) { return Math.min(0.95 / lev, 1 / lev - 0.0005); }

  /* ---- small helpers ---------------------------------------------------- */

  function $(id) { return document.getElementById(id); }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = v ? v.trim() : '';
    return v || fallback;
  }

  var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function reducedMotion() { return !!(motionQuery && motionQuery.matches); }

  function onMotionChange(fn) {
    if (!motionQuery) return;
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', fn);
    else if (motionQuery.addListener) motionQuery.addListener(fn);
  }

  /* POST to the Hyperliquid info endpoint with a timeout. Resolves to parsed JSON. */
  function postInfo(body, timeoutMs) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 6000) : null;
    return fetch(INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('info ' + res.status);
      return res.json();
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  function fmtUsd(n) {
    if (!isFinite(n)) return '—';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* Five significant figures, so 82766, 1.9107, 0.085388 and 0.004101 all read well. */
  function fmtPrice(p) {
    if (!isFinite(p) || p <= 0) return '—';
    var decimals = p >= 1000 ? 2 : p >= 1 ? 4 : Math.min(8, 3 - Math.floor(Math.log10(p)));
    return p.toFixed(decimals);
  }

  /* Axis labels: enough decimals to tell neighbouring grid lines apart. */
  function fmtAxis(p, span) {
    var decimals = span > 0 ? Math.ceil(-Math.log10(span)) + 1 : 2;
    decimals = Math.min(8, Math.max(2, decimals));
    return p.toFixed(decimals);
  }

  /* Deterministic PRNG so the confetti layout is the same on every load. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---- ticker tape ------------------------------------------------------ */

  var tape = {
    el: $('ticker'),
    track: $('tickerTrack'),
    status: $('tickerStatus'),
    last: {},        /* sym -> last mid as a number */
    lastRaw: {},     /* sym -> last mid as the API string */
    failures: 0,
    inFlight: false
  };

  /* Builds the tape skeleton: symbols with a dash, two copies when it scrolls. */
  function buildTape() {
    if (!tape.track) return;
    var copies = reducedMotion() ? 1 : 2;
    var frag = document.createDocumentFragment();
    for (var c = 0; c < copies; c++) {
      var half = document.createElement('span');
      half.className = 'ticker-half';
      if (c > 0) half.setAttribute('aria-hidden', 'true');
      TAPE_COINS.forEach(function (sym) {
        var item = document.createElement('span');
        item.className = 'ticker-item';
        item.setAttribute('data-sym', sym);
        var s = document.createElement('span');
        s.className = 'sym';
        s.textContent = sym.replace(/^k(?=[A-Z])/, ''); /* kPEPE shows as PEPE */
        var p = document.createElement('span');
        p.className = 'px';
        p.textContent = tape.lastRaw[sym] || '—';
        item.appendChild(s);
        item.appendChild(p);
        half.appendChild(item);
        var dot = document.createElement('span');
        dot.className = 'ticker-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.textContent = '·';
        half.appendChild(dot);
      });
      frag.appendChild(half);
    }
    tape.track.textContent = '';
    tape.track.appendChild(frag);
    tape.track.classList.toggle('is-loop', copies === 2);
    tape.track.classList.toggle('is-static', copies === 1);
    sizeTape();
  }

  /* Keeps the scroll speed constant regardless of how wide the content is. */
  function sizeTape() {
    if (!tape.track) return;
    var half = tape.track.querySelector('.ticker-half');
    if (!half) return;
    var width = half.getBoundingClientRect().width;
    if (width > 0) {
      tape.track.style.setProperty('--ticker-duration', (width / TAPE_SPEED_PX_S).toFixed(1) + 's');
    }
  }

  function updateTape(mids) {
    if (!tape.track || !mids || typeof mids !== 'object') return;
    TAPE_COINS.forEach(function (sym) {
      var raw = mids[sym];
      if (raw == null) return;
      var v = Number(raw);
      if (!isFinite(v) || v <= 0) return;
      var prev = tape.last[sym];
      var dir = (prev == null || v === prev) ? '' : (v > prev ? 'is-up' : 'is-down');
      tape.last[sym] = v;
      tape.lastRaw[sym] = String(raw);
      var nodes = tape.track.querySelectorAll('[data-sym="' + sym + '"]');
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].classList.remove('is-up', 'is-down');
        if (dir) nodes[i].classList.add(dir);
        var px = nodes[i].querySelector('.px');
        if (px) px.textContent = String(raw);
      }
    });
  }

  function setTapeStale(stale) {
    if (!tape.status) return;
    if (stale) tape.status.removeAttribute('hidden');
    else tape.status.setAttribute('hidden', '');
  }

  /* `force` lets the first call run even in a background tab, so prices are
     ready the moment the tab is shown; the interval still skips hidden tabs. */
  function refreshTape(force) {
    if (tape.inFlight || (document.hidden && !force)) return;
    tape.inFlight = true;
    postInfo({ type: 'allMids' }, 5000).then(function (mids) {
      tape.failures = 0;
      setTapeStale(false);
      updateTape(mids);
      var doge = Number(mids && mids[CHART_COIN]);
      if (isFinite(doge) && doge > 0) onLivePrice(doge);
    }).catch(function () {
      tape.failures += 1;
      if (tape.failures >= 2) setTapeStale(true);
    }).then(function () {
      tape.inFlight = false;
    });
  }

  /* ---- preview chart ----------------------------------------------------- */

  var chart = {
    canvas: $('pvChart'),
    pill: $('pvPill'),
    candles: null,     /* [{t, o, h, l, c}] oldest first */
    synthetic: false,  /* true when drawn from a placeholder walk */
    inFlight: false,
    raf: 0
  };

  function syntheticCandles(base) {
    var rnd = mulberry32(42);
    var out = [];
    var minute = 60000;
    var t0 = Math.floor(Date.now() / minute) * minute - CANDLE_COUNT * minute;
    var p = base;
    for (var i = 0; i < CANDLE_COUNT; i++) {
      var o = p;
      var c = o * (1 + (rnd() - 0.5) * 0.004);
      var h = Math.max(o, c) * (1 + rnd() * 0.0015);
      var l = Math.min(o, c) * (1 - rnd() * 0.0015);
      out.push({ t: t0 + i * minute, o: o, h: h, l: l, c: c });
      p = c;
    }
    return out;
  }

  function loadCandles() {
    if (chart.inFlight || !chart.canvas) return;
    chart.inFlight = true;
    var end = Date.now();
    var start = end - (CANDLE_COUNT + 5) * 60000;
    postInfo({
      type: 'candleSnapshot',
      req: { coin: CHART_COIN, interval: '1m', startTime: start, endTime: end }
    }, 8000).then(function (rows) {
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('no candles');
      var parsed = rows.map(function (r) {
        return { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) };
      }).filter(function (k) {
        return isFinite(k.t) && isFinite(k.o) && isFinite(k.h) && isFinite(k.l) && isFinite(k.c) && k.c > 0;
      });
      if (parsed.length === 0) throw new Error('bad candles');
      chart.candles = parsed.slice(-CANDLE_COUNT);
      chart.synthetic = false;
      /* Seed the order form from the last close so Bust/Entry never wait on the tape. */
      if (!isFinite(form.price)) form.price = chart.candles[chart.candles.length - 1].c;
    }).catch(function () {
      if (!chart.candles) {
        chart.candles = syntheticCandles(tape.last[CHART_COIN] || 0.085);
        chart.synthetic = true;
      }
    }).then(function () {
      chart.inFlight = false;
      scheduleDraw();
      renderForm();
    });
  }

  /* Folds a fresh mid into the last candle (or opens a new minute). */
  function onLivePrice(mid) {
    form.price = mid;
    if (chart.candles && !chart.synthetic) {
      var ks = chart.candles;
      var last = ks[ks.length - 1];
      var minute = 60000;
      var now = Math.floor(Date.now() / minute) * minute;
      if (now > last.t) {
        ks.push({ t: now, o: last.c, h: Math.max(last.c, mid), l: Math.min(last.c, mid), c: mid });
        if (ks.length > CANDLE_COUNT) ks.shift();
      } else {
        last.c = mid;
        if (mid > last.h) last.h = mid;
        if (mid < last.l) last.l = mid;
      }
      scheduleDraw();
    } else if (chart.synthetic) {
      /* Placeholder walk: re-seat it on the real price so the pill matches. */
      chart.candles = syntheticCandles(mid);
      scheduleDraw();
    }
    renderForm();
  }

  function scheduleDraw() {
    if (chart.raf) return;
    chart.raf = (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () {
      chart.raf = 0;
      drawChart();
    });
  }

  function drawChart() {
    var canvas = chart.canvas;
    if (!canvas || !chart.candles || chart.candles.length === 0) return;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (!w || !h) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var pw = Math.round(w * dpr);
    var ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var faint = cssVar('--ink-faint', '#7a7060');
    var rule = cssVar('--rule', '#d4cbba');
    var pos = cssVar('--pos', '#2e7a4c');
    var neg = cssVar('--neg', '#b44855');
    var page = cssVar('--page', '#f4ecd8');
    var mono = cssVar('--font-mono', 'monospace');

    var padL = 6, padR = 48, padT = 24, padB = 10;
    var cw = w - padL - padR;
    var ch = h - padT - padB;
    if (cw <= 10 || ch <= 10) return;

    var ks = chart.candles;
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < ks.length; i++) {
      if (ks[i].l < lo) lo = ks[i].l;
      if (ks[i].h > hi) hi = ks[i].h;
    }
    if (!(hi > lo)) { hi = lo * 1.001; lo = lo * 0.999; }
    var span = hi - lo;
    lo -= span * 0.08;
    hi += span * 0.08;
    span = hi - lo;

    function y(p) { return padT + ((hi - p) / span) * ch; }

    var slot = cw / ks.length;
    var bodyW = Math.max(1, Math.floor(slot * 0.6));

    /* grid and axis */
    ctx.font = '8px ' + mono;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    var lines = 4;
    for (var g = 0; g <= lines; g++) {
      var gp = hi - (span * g) / lines;
      var gy = Math.round(y(gp)) + 0.5;
      ctx.strokeStyle = rule;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(padL + cw, gy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = faint;
      ctx.fillText(fmtAxis(gp, span), padL + cw + 6, gy);
    }

    /* candles */
    for (var k = 0; k < ks.length; k++) {
      var c = ks[k];
      var x = padL + slot * k + slot / 2;
      var xx = Math.round(x) + 0.5;
      var col = c.c >= c.o ? pos : neg;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(xx, y(c.h));
      ctx.lineTo(xx, y(c.l));
      ctx.stroke();
      var top = y(Math.max(c.o, c.c));
      var bot = y(Math.min(c.o, c.c));
      ctx.fillRect(Math.round(x - bodyW / 2), top, bodyW, Math.max(1, bot - top));
    }

    /* last price line and tag */
    var last = ks[ks.length - 1];
    var ly = Math.round(y(last.c)) + 0.5;
    var lc = last.c >= last.o ? pos : neg;
    ctx.strokeStyle = lc;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, ly);
    ctx.lineTo(padL + cw, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    var tag = fmtAxis(last.c, span);
    var tw = ctx.measureText(tag).width + 8;
    ctx.fillStyle = lc;
    ctx.fillRect(padL + cw + 2, ly - 7, tw, 14);
    ctx.fillStyle = page;
    ctx.fillText(tag, padL + cw + 6, ly);

    /* pill */
    if (chart.pill) {
      chart.pill.textContent = CHART_COIN + ' ' + fmtPrice(last.c) + (chart.synthetic ? ' · offline' : '');
      chart.pill.classList.toggle('pill-pos', last.c >= last.o);
      chart.pill.classList.toggle('pill-neg', last.c < last.o);
    }
  }

  /* ---- preview order form (fake, but the numbers are honest) ------------- */

  var form = { side: 'long', margin: 100, lev: 250, price: NaN, available: 1140.18 };

  function levFromSlider(v) { return Math.max(1, Math.min(1000, Math.round(Math.pow(1000, v / 1000)))); }
  function sliderFromLev(l) { return Math.round((1000 * Math.log(l)) / Math.log(1000)); }

  function renderForm() {
    var levVal = $('pvLevVal');
    var notional = $('pvNotional');
    var bust = $('pvBust');
    var action = $('pvAction');
    var entry = $('pvEntry');
    if (levVal) levVal.textContent = 'x' + form.lev;
    if (notional) notional.textContent = fmtUsd(form.margin * form.lev);
    if (bust) {
      var dir = form.side === 'long' ? -1 : 1;
      var bp = isFinite(form.price) ? form.price * (1 + dir * bustMove(form.lev)) : NaN;
      bust.textContent = fmtPrice(bp);
    }
    if (action) {
      action.textContent = (form.side === 'long' ? 'Long ' : 'Short ') + CHART_COIN;
      action.classList.toggle('btn-long', form.side === 'long');
      action.classList.toggle('btn-short', form.side === 'short');
    }
    if (entry) entry.textContent = fmtPrice(form.price);
  }

  function initForm() {
    var lev = $('pvLev');
    var margin = $('pvMargin');
    var seg = $('pvSide');
    if (lev) {
      lev.value = String(sliderFromLev(form.lev));
      lev.addEventListener('input', function () {
        form.lev = levFromSlider(Number(lev.value));
        renderForm();
      });
    }
    if (margin) {
      margin.addEventListener('input', function () {
        var m = Number(margin.value);
        form.margin = isFinite(m) && m > 0 ? m : 0;
        renderForm();
      });
    }
    if (seg) {
      seg.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('[data-side]') : null;
        if (!btn) return;
        form.side = btn.getAttribute('data-side') === 'short' ? 'short' : 'long';
        var items = seg.querySelectorAll('[data-side]');
        for (var i = 0; i < items.length; i++) {
          items[i].setAttribute('aria-pressed', items[i] === btn ? 'true' : 'false');
        }
        renderForm();
      });
    }
    var quick = document.querySelectorAll('.pv .quick [data-mult]');
    for (var q = 0; q < quick.length; q++) {
      quick[q].addEventListener('click', function (ev) {
        var mult = ev.currentTarget.getAttribute('data-mult');
        var next = mult === 'max' ? form.available : form.margin * Number(mult);
        next = Math.max(10, Math.min(form.available, Math.round(next * 100) / 100));
        form.margin = next;
        if (margin) margin.value = String(next);
        renderForm();
      });
    }
    renderForm();
  }

  /* ---- confetti scatter ---------------------------------------------------- */

  function scatterConfetti() {
    var layer = $('confetti');
    if (!layer) return;
    var colours = ['var(--neg)', 'var(--pos)', 'var(--accent)', 'var(--ink)', 'var(--rule-strong)'];
    var count = window.innerWidth < 600 ? 24 : 40;
    var rnd = mulberry32(7);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < count; i++) {
      var p = document.createElement('span');
      p.className = 'confetti-piece';
      p.style.setProperty('--x', (rnd() * 100).toFixed(2) + '%');
      p.style.setProperty('--w', (5 + Math.round(rnd() * 5)) + 'px');
      p.style.setProperty('--h', (9 + Math.round(rnd() * 8)) + 'px');
      p.style.setProperty('--c', colours[i % colours.length]);
      p.style.setProperty('--dur', (16 + rnd() * 18).toFixed(1) + 's');
      p.style.setProperty('--delay', (-rnd() * 30).toFixed(1) + 's');
      p.style.setProperty('--drift', Math.round(rnd() * 120 - 60) + 'px');
      p.style.setProperty('--r0', Math.round(rnd() * 360) + 'deg');
      p.style.setProperty('--r1', Math.round(360 + rnd() * 720) + 'deg');
      p.style.setProperty('--ty', (rnd() * 100).toFixed(1) + '%');
      frag.appendChild(p);
    }
    layer.appendChild(frag);
  }

  /* ---- night theme --------------------------------------------------------- */

  function initTheme() {
    var btn = $('themeToggle');
    var root = document.documentElement;
    var meta = document.querySelector('meta[name="theme-color"]');

    function apply(night, persist) {
      if (night) root.setAttribute('data-theme', 'night');
      else root.removeAttribute('data-theme');
      if (btn) {
        btn.setAttribute('aria-pressed', night ? 'true' : 'false');
        btn.textContent = night ? 'Paper' : 'Night';
      }
      if (meta) meta.setAttribute('content', cssVar('--page', '#f4ecd8'));
      if (persist) {
        try { localStorage.setItem(THEME_KEY, night ? 'night' : 'paper'); } catch (e) { /* ignore */ }
      }
      scheduleDraw();
    }

    apply(root.getAttribute('data-theme') === 'night', false);
    if (btn) {
      btn.addEventListener('click', function () {
        apply(root.getAttribute('data-theme') !== 'night', true);
      });
    }
  }

  /* ---- wiring ------------------------------------------------------------- */

  var resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      sizeTape();
      scheduleDraw();
    }, 80);
  }

  function onVisibility() {
    var layer = $('confetti');
    if (layer) layer.classList.toggle('is-paused', !!document.hidden);
    if (!document.hidden) {
      refreshTape();
      loadCandles();
    }
  }

  /* ?ref=CODE on any page: kept for the trade page, which passes the referrer on the first fill. */
  function captureRef() {
    try {
      var code = new URLSearchParams(location.search).get('ref');
      if (code && /^[a-z0-9_]{3,16}$/.test(code.trim().toLowerCase())) localStorage.setItem('confetti.ref', code.trim().toLowerCase());
    } catch (e) { /* storage blocked */ }
  }

  /* House market-activity bots (config.json "houseBots", disclosed in docs.html): left out of every public number.
     This page has no live account data of its own; the helper is here so anything added to it that lists
     traders drops theirs the same way trade.js does. Nothing is labelled on screen. */
  var houseBots = { idx: {}, n: 0 };
  function isHouseBot(a) { return typeof a === 'string' && !!houseBots.idx[a.toLowerCase()]; }
  window.ConfettiHouseBots = window.ConfettiHouseBots || {
    isBot: isHouseBot,
    filter: function (rows, addrOf) { return houseBots.n ? rows.filter(function (r) { return !isHouseBot(addrOf(r)); }) : rows; },
    count: function () { return houseBots.n; }
  };
  function loadHouseBots() {
    try {
      fetch('config.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
        var list = c && Array.isArray(c.houseBots) ? c.houseBots.slice(0, 20) : [];
        list.forEach(function (a, i) {
          if (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !houseBots.idx[a.toLowerCase()]) { houseBots.idx[a.toLowerCase()] = i + 1; houseBots.n++; }
        });
      }).catch(function () { /* decoration */ });
    } catch (e) { /* no fetch */ }
  }

  function init() {
    captureRef();
    loadHouseBots();
    buildTape();
    initTheme();
    scatterConfetti();
    initForm();

    refreshTape(true);
    loadCandles();
    setInterval(function () { refreshTape(false); }, TAPE_EVERY_MS);
    setInterval(loadCandles, CANDLES_EVERY_MS);

    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    onMotionChange(function () { buildTape(); });

    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { sizeTape(); scheduleDraw(); }, function () {});
    }
    if (typeof ResizeObserver === 'function' && chart.canvas) {
      new ResizeObserver(function () { scheduleDraw(); }).observe(chart.canvas);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
