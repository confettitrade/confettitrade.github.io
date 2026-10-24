/* Share your win: after a winning close, a 1600x900 PNG card (the flex poster: the trade's Hyperliquid
   chart and numbers dimmed under confetti, the name and the PnL on top) and a 5 s 1080x1920 clip (the PnL
   counts up, turns gold on a plate and bursts into confetti), drawn on canvas and recorded in the browser.
   Same look as the card, poster and clip renders. No contract calls.

   window.ConfettiShare.open(trade or a Promise of one) opens the dialog. trade:
     { id?, sym, coin?, szDecimals?, side: 'long' | 'short', lev, margin, entry, exit, pnl,
       openTs, closeTs (unix seconds), account?, code? (referral code), name? (overrides the default) }
   window.ConfettiShare.use({ postInfo: fn }) hands over the page's Hyperliquid info call for the candles. */
(function () {
  'use strict';

  var CARD_W = 1600, CARD_H = 900;
  var CLIP_W = 1080, CLIP_H = 1920, CLIP_FPS = 30, CLIP_S = 5;
  /* clip timeline (s): count-up, pop (gold, plate, burst), footer */
  var COUNT_AT = 0.25, COUNT_S = 1.4, POP_AT = 1.75, FOOT_AT = CLIP_S - 1;
  var LS_NAME = 'confetti.share.name.', LS_CODE = 'confetti.share.code.';
  var SITE = 'https://confetti.trade';
  var NAME_MAX = 24;
  /* mp4 first (plays everywhere X accepts), webm where the browser cannot record mp4 */
  var MIMES_AV = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm'];
  var MIMES_V = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  /* candle intervals the info API serves, in minutes; the smallest that keeps the chart readable wins */
  var INTERVALS = [['1m', 1], ['3m', 3], ['5m', 5], ['15m', 15], ['30m', 30], ['1h', 60], ['2h', 120], ['4h', 240], ['8h', 480], ['12h', 720], ['1d', 1440]];
  var MAX_CANDLES = 180;

  /* candles and the trade line in these, the PnL in gold */
  var POS = '#4ade80', NEG = '#f47287', GOLD = '#facc15';
  var CONF_CARD = ['#b44855', '#2ea060', '#8b2020', '#f4ecd8', '#facc15', '#788cff'];
  var CONF = ['#b44855', '#2ea060', '#e0786e', '#f4ecd8', '#facc15', '#788cff', '#4ade80', '#ff8cc8'];

  var hooks = { postInfo: null };
  var cur = null;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function easeOut(x) { x = clamp(x, 0, 1); return 1 - Math.pow(1 - x, 3); }

  function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; }

  function money(n, signed) {
    var abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-' : signed ? '+' : '') + '$' + abs;
  }

  function betText(m) {
    var whole = Math.abs(m - Math.round(m)) < 0.005;
    return '$' + m.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  }

  function pctText(t) {
    var r = t.pnl / t.margin * 100;
    return '+' + (r >= 1000 ? Math.round(r).toLocaleString('en-US') : r.toFixed(1)) + '%';
  }

  function priceText(p, sz) {
    if (!(p > 0) || !isFinite(p)) return '—';
    var cap = sz == null ? 7 : Math.max(2, 7 - sz);
    return p.toFixed(clamp(4 - Math.floor(Math.log10(p)), 2, cap));
  }

  function sideText(t) { return t.side === 'short' ? 'SHORT' : 'LONG'; }

  /* seeded, so a redraw (new name) keeps the same confetti */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seedOf(t) { return ((Number(t.closeTs) || 0) ^ (Number(t.id) || 0) * 2654435761) >>> 0; }

  /* ---- palette and fonts: paper.css [data-theme="night"], whatever theme the page is in ---------- */

  function rgbOf(c, fb) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim());
    if (!m) return fb ? rgbOf(fb) : [0, 0, 0];
    var h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function rgba(c, a) { var v = rgbOf(c); return 'rgba(' + v[0] + ',' + v[1] + ',' + v[2] + ',' + a + ')'; }

  function mix(c1, c2, k) {
    var a = rgbOf(c1), b = rgbOf(c2);
    return 'rgb(' + a.map(function (v, i) { return Math.round(v + (b[i] - v) * k); }).join(',') + ')';
  }

  var palCache = null;

  function palette() {
    if (palCache) return palCache;
    var probe = document.createElement('div');
    probe.setAttribute('data-theme', 'night');
    probe.hidden = true;
    (document.body || document.documentElement).appendChild(probe);
    var cs = getComputedStyle(probe);
    function v(name, fb) { var x = cs.getPropertyValue(name); x = x ? x.trim() : ''; return x || fb; }
    var hex = function (name, fb) { var x = v(name, fb); return /^#[0-9a-f]{3,6}$/i.test(x) ? x : fb; };
    palCache = {
      page: hex('--page', '#0d1229'), panel: hex('--panel', '#171d3d'), raised: hex('--raised', '#1e2548'),
      rule: hex('--rule', '#2a3261'), ruleStrong: hex('--rule-strong', '#3f4883'),
      ink: hex('--ink', '#f4eaf2'), muted: hex('--ink-muted', '#b9b2c6'), faint: hex('--ink-faint', '#8a839c'),
      accent: hex('--accent', '#e86a6a'),
      ui: v('--font-ui', '"Soehne", system-ui, sans-serif'),
      mono: v('--font-mono', '"Soehne Mono", ui-monospace, monospace'),
      brand: v('--font-brand', '"Soehne Breit", "Soehne", sans-serif')
    };
    probe.parentNode.removeChild(probe);
    return palCache;
  }

  var fontsPromise = null;

  /* font-display: swap faces load only when used; ask for every face the canvas draws, then wait */
  function fontsReady() {
    if (fontsPromise) return fontsPromise;
    var P = palette();
    if (!document.fonts || !document.fonts.load) { fontsPromise = Promise.resolve(); return fontsPromise; }
    var faces = ['400 24px ' + P.ui, '600 24px ' + P.ui, '400 24px ' + P.mono, '600 24px ' + P.mono, '700 24px ' + P.brand];
    var all = Promise.all(faces.map(function (f) { return document.fonts.load(f).catch(function () {}); }))
      .then(function () { return document.fonts.ready; });
    fontsPromise = Promise.race([all, new Promise(function (ok) { setTimeout(ok, 4000); })]);
    return fontsPromise;
  }

  /* ---- drawing helpers ---------------------------------------------------------------------------- */

  function setFont(ctx, weight, size, fam) { ctx.font = weight + ' ' + Math.round(size) + 'px ' + fam; }

  /* sets the font at size, smaller when the text would be wider than maxW */
  function fitFont(ctx, text, weight, size, fam, maxW) {
    setFont(ctx, weight, size, fam);
    var w = ctx.measureText(text).width;
    if (w > maxW) { size = Math.floor(size * maxW / w); setFont(ctx, weight, size, fam); }
    return size;
  }

  function roundRect(ctx, x0, y0, x1, y1, r) {
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x1, y0, x1, y1, r);
    ctx.arcTo(x1, y1, x0, y1, r);
    ctx.arcTo(x0, y1, x0, y0, r);
    ctx.arcTo(x0, y0, x1, y0, r);
    ctx.closePath();
  }

  /* PIL's stroke_width w is an outline w wide around the glyph: a canvas line twice that */
  function outlined(ctx, text, x, y, fill, stroke, w) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = w * 2;
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  function piece(ctx, cx, cy, w, h, deg, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate(deg * Math.PI / 180);
    ctx.fillStyle = color;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /* the wordmark: "confetti" in the brand face and the red block after it; returns its width */
  function wordmark(ctx, x, top, size, P, alpha, outline) {
    setFont(ctx, 700, size, P.brand);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    var w = ctx.measureText('confetti').width;
    ctx.globalAlpha = alpha;
    if (outline) outlined(ctx, 'confetti', x, top, P.ink, P.page, outline);
    else { ctx.fillStyle = P.ink; ctx.fillText('confetti', x, top); }
    ctx.fillStyle = P.accent;
    ctx.fillRect(x + w + size * 0.18, top + size * 0.27, size * 0.41, size * 0.86);
    ctx.globalAlpha = 1;
    return w + size * 0.59;
  }

  /* ---- candles (Hyperliquid info API, through the page's own postInfo) ----------------------------- */

  function intervalFor(t) {
    var spanMin = Math.max(1, (t.closeTs - t.openTs) / 60);
    for (var i = 0; i < INTERVALS.length; i++) {
      var iv = INTERVALS[i][1];
      if ((spanMin + Math.max(30, 15 * iv)) / iv <= MAX_CANDLES) return INTERVALS[i];
    }
    return INTERVALS[INTERVALS.length - 1];
  }

  function fetchCandles(t) {
    if (typeof hooks.postInfo !== 'function') return Promise.reject(new Error('no info api'));
    if (!(t.openTs > 0) || !(t.closeTs >= t.openTs)) return Promise.reject(new Error('no times'));
    var iv = intervalFor(t);
    var ivMs = iv[1] * 60000;
    var start = t.openTs * 1000 - Math.max(30, 15 * iv[1]) * 60000;
    var end = t.closeTs * 1000 + ivMs;
    return hooks.postInfo({ type: 'candleSnapshot', req: { coin: t.coin || t.sym, interval: iv[0], startTime: start, endTime: end } }, 8000)
      .then(function (rows) {
        if (!Array.isArray(rows)) throw new Error('bad candles');
        var out = rows.map(function (r) {
          return { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) };
        }).filter(function (c) {
          return isFinite(c.t) && c.t <= t.closeTs * 1000 && c.h > 0 && c.l > 0 && isFinite(c.o) && isFinite(c.c);
        }).sort(function (a, b) { return a.t - b.t; });
        if (out.length < 2) throw new Error('no candles');
        return { iv: iv[0], ivMs: ivMs, rows: out };
      });
  }

  function clockText(ms, long) {
    var d = new Date(ms);
    var hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return long ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : hm;
  }

  /* ---- the card ----------------------------------------------------------------------------------- */

  function drawChart(ctx, t, ch, P) {
    var cx0 = 48, cy0 = 120, cx1 = 1000, cy1 = 800;
    roundRect(ctx, cx0, cy0, cx1, cy1, 18);
    ctx.fillStyle = P.panel; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = P.rule; ctx.stroke();
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    setFont(ctx, 600, 26, P.ui); ctx.fillStyle = P.ink;
    var title = t.sym + '-USD';
    ctx.fillText(title, cx0 + 28, cy0 + 22);
    var tw = ctx.measureText(title).width;
    setFont(ctx, 400, 20, P.ui); ctx.fillStyle = P.faint;
    ctx.fillText(ch.iv + ' · Hyperliquid', cx0 + 28 + tw + 12, cy0 + 27);

    var px0 = cx0 + 28, py0 = cy0 + 80, px1 = cx1 - 120, py1 = cy1 - 56;
    var rows = ch.rows;
    var lo = Infinity, hi = -Infinity;
    rows.forEach(function (c) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); });
    lo = Math.min(lo, t.entry, t.exit); hi = Math.max(hi, t.entry, t.exit);
    var pad = (hi - lo) * 0.08 || hi * 0.001;
    lo -= pad; hi += pad;
    var t0 = rows[0].t, t1 = Math.max(t.closeTs * 1000, rows[rows.length - 1].t + ch.ivMs) + 2 * ch.ivMs;
    function xAt(ms) { return px0 + (ms - t0) / (t1 - t0) * (px1 - px0); }
    function yAt(p) { return py1 - (p - lo) / (hi - lo) * (py1 - py0); }
    var step = ch.ivMs / (t1 - t0) * (px1 - px0);

    /* grid and prices */
    setFont(ctx, 400, 17, P.mono);
    ctx.lineWidth = 1;
    for (var k = 0; k < 5; k++) {
      var p = lo + (hi - lo) * k / 4, y = Math.round(yAt(p)) + 0.5;
      ctx.strokeStyle = P.rule;
      ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke();
      ctx.fillStyle = P.faint; ctx.textBaseline = 'middle';
      ctx.fillText(priceText(p, t.szDecimals), px1 + 14, y);
    }
    /* times, on round local minutes */
    var spanMin = (t1 - t0) / 60000;
    var steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440, 2880, 10080];
    var every = steps.filter(function (s) { return spanMin / s <= 6; })[0] || 10080;
    var off = -new Date(t0).getTimezoneOffset() * 60000;
    var em = every * 60000;
    ctx.textBaseline = 'top'; ctx.textAlign = 'center'; ctx.fillStyle = P.faint;
    for (var m = Math.ceil((t0 + off) / em) * em - off; m < t1; m += em) {
      ctx.fillText(clockText(m, every >= 1440), xAt(m), py1 + 16);
    }
    ctx.textAlign = 'left';

    /* entry, dashed */
    var ye = yAt(t.entry);
    ctx.save();
    ctx.setLineDash([10, 8]); ctx.lineWidth = 2; ctx.strokeStyle = P.muted;
    ctx.beginPath(); ctx.moveTo(px0, ye); ctx.lineTo(px1, ye); ctx.stroke();
    ctx.restore();

    /* candles */
    rows.forEach(function (c) {
      var x = xAt(c.t + ch.ivMs / 2);
      var col = c.c >= c.o ? POS : NEG;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = Math.max(1, Math.min(1.6, step * 0.2));
      ctx.beginPath(); ctx.moveTo(x, yAt(c.h)); ctx.lineTo(x, yAt(c.l)); ctx.stroke();
      var top = yAt(Math.max(c.o, c.c)), bot = yAt(Math.min(c.o, c.c));
      if (bot - top < 1.2) bot = top + 1.2;
      var bw = Math.max(1, step * 0.32);
      ctx.fillRect(x - bw, top, bw * 2, bot - top);
    });

    /* entry label and the open marker */
    setFont(ctx, 400, 17, P.mono);
    var lbl = 'entry ' + priceText(t.entry, t.szDecimals);
    var lw = ctx.measureText(lbl).width;
    var ly = ye + 8 + 30 > py1 ? ye - 36 : ye + 8;
    roundRect(ctx, px0 + 2, ly, px0 + 18 + lw, ly + 28, 6);
    ctx.fillStyle = P.panel; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = P.rule; ctx.stroke();
    ctx.fillStyle = P.muted; ctx.textBaseline = 'middle';
    ctx.fillText(lbl, px0 + 10, ly + 14);
    var xo = xAt(t.openTs * 1000);
    ctx.fillStyle = t.side === 'short' ? NEG : POS;
    ctx.beginPath();
    if (t.side === 'short') { ctx.moveTo(xo, ye - 14); ctx.lineTo(xo - 11, ye - 32); ctx.lineTo(xo + 11, ye - 32); }
    else { ctx.moveTo(xo, ye + 14); ctx.lineTo(xo - 11, ye + 32); ctx.lineTo(xo + 11, ye + 32); }
    ctx.closePath(); ctx.fill();

    /* the exit: a gold line from the open, the dot and its ring */
    var xp = xAt(t.closeTs * 1000), yp = yAt(t.exit);
    ctx.strokeStyle = GOLD; ctx.fillStyle = GOLD; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xo, yp); ctx.lineTo(xp, yp); ctx.stroke();
    ctx.beginPath(); ctx.arc(xp, yp, 9, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(xp, yp, 18, 0, Math.PI * 2); ctx.stroke();
    setFont(ctx, 600, 18, P.ui);
    var xl = 'exit · ' + priceText(t.exit, t.szDecimals);
    var xw = ctx.measureText(xl).width;
    ctx.textBaseline = 'top';
    ctx.fillText(xl, clamp(xp - xw + 20, px0, cx1 - 16 - xw), yp - 50 < py0 - 30 ? yp + 28 : yp - 50);
  }

  /* make_card: the chart on the left, the numbers on the right */
  function drawBase(ctx, t, ch, P) {
    var W = CARD_W, H = CARD_H;
    ctx.fillStyle = P.page; ctx.fillRect(0, 0, W, H);
    var r = rng(seedOf(t) + 11);
    var keep = [[30, 100, 1020, 820], [1030, 20, 1590, 850], [30, 815, 520, 875]];
    for (var placed = 0, guard = 0; placed < 30 && guard < 3000; guard++) {
      var x = r() * (W - 20), y = r() * (H - 30);
      if (keep.some(function (k) { return x > k[0] - 30 && x < k[2] && y > k[1] - 40 && y < k[3]; })) continue;
      piece(ctx, x + 6, y + 11, 12, 22, r() * 360, CONF_CARD[placed % CONF_CARD.length], 110 / 255);
      placed++;
    }
    if (ch) drawChart(ctx, t, ch, P);

    var rx = 1050, right = W - 48;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    wordmark(ctx, rx, 44, 46, P, 1, 0);
    setFont(ctx, 600, 34, P.ui); ctx.fillStyle = P.ink;
    var title = t.sym + '-USD';
    fitFont(ctx, title, 600, 34, P.ui, 300);
    ctx.fillText(title, rx, 150);
    var px = rx + ctx.measureText(title).width + 20;
    var pill = sideText(t) + ' ' + t.lev + 'x';
    setFont(ctx, 600, 24, P.mono);
    var pw = ctx.measureText(pill).width + 28;
    var sc = t.side === 'short' ? NEG : POS;
    roundRect(ctx, px, 154, px + pw, 194, 8);
    ctx.fillStyle = mix(P.page, sc, 0.22); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = sc; ctx.stroke();
    ctx.fillStyle = sc; ctx.textBaseline = 'middle';
    ctx.fillText(pill, px + 14, 175);
    ctx.textBaseline = 'top';
    setFont(ctx, 400, 22, P.ui); ctx.fillStyle = P.muted;
    ctx.fillText('closed pnl', rx, 236);
    var pnl = money(t.pnl, true);
    fitFont(ctx, pnl, 600, 86, P.mono, right - rx + 4);
    ctx.fillStyle = GOLD; ctx.fillText(pnl, rx - 4, 266);
    setFont(ctx, 600, 34, P.mono); ctx.fillStyle = POS;
    ctx.fillText(pctText(t) + ' on the bet', rx, 372);
    var rows = [
      ['Bet', money(t.margin)], ['Leverage', t.lev + 'x'], ['Position', '$' + Math.round(t.margin * t.lev).toLocaleString('en-US')],
      ['Entry', priceText(t.entry, t.szDecimals)], ['Exit', priceText(t.exit, t.szDecimals)]
    ];
    var y = 452;
    ctx.lineWidth = 1; ctx.strokeStyle = P.rule;
    rows.forEach(function (row) {
      ctx.beginPath(); ctx.moveTo(rx, y - 10.5); ctx.lineTo(right, y - 10.5); ctx.stroke();
      setFont(ctx, 400, 26, P.ui); ctx.fillStyle = P.muted; ctx.textAlign = 'left';
      ctx.fillText(row[0], rx, y);
      setFont(ctx, 600, 28, P.mono); ctx.fillStyle = P.ink; ctx.textAlign = 'right';
      ctx.fillText(row[1], right, y - 2);
      y += 58;
    });
    ctx.textAlign = 'left';
    ctx.beginPath(); ctx.moveTo(rx, y - 10.5); ctx.lineTo(right, y - 10.5); ctx.stroke();
    if (t.name) { fitFont(ctx, t.name, 600, 26, P.ui, right - rx); ctx.fillStyle = P.ink; ctx.fillText(t.name, rx, 760); }
    setFont(ctx, 400, 22, P.ui); ctx.fillStyle = P.muted;
    ctx.fillText('confetti.trade · @confetti_trade', rx, 798);
    ctx.fillStyle = P.faint;
    ctx.fillText('1000x on meme coins. against the house.', 48, 830);
  }

  /* make_poster: the card blurred and dimmed, confetti everywhere, the trade in big letters */
  function drawCard(t, ch) {
    var P = palette();
    var W = CARD_W, H = CARD_H;
    var base = document.createElement('canvas');
    base.width = W; base.height = H;
    drawBase(base.getContext('2d'), t, ch, P);

    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = P.page; ctx.fillRect(0, 0, W, H);
    ctx.filter = 'blur(1.6px)';
    ctx.drawImage(base, 0, 0);
    ctx.filter = 'none';
    ctx.fillStyle = rgba(P.page, 150 / 255);
    ctx.fillRect(0, 0, W, H);

    /* the explosion (make_poster): a gold flash, rays, a radial blast with motion trails, and a drift;
       faint right behind each line of text so the letters stay clean */
    var r = rng(seedOf(t) + 2026);
    var ex = W / 2, ey = H * 0.43;
    var fl = ctx.createRadialGradient(ex, ey, 10, ex, ey, 620);
    fl.addColorStop(0, rgba(GOLD, 0.30)); fl.addColorStop(0.45, rgba(GOLD, 0.10)); fl.addColorStop(1, rgba(GOLD, 0));
    ctx.save(); ctx.translate(ex, ey); ctx.scale(1.5, 0.8); ctx.translate(-ex, -ey);
    ctx.fillStyle = fl; ctx.fillRect(0, 0, W, H); ctx.restore();
    var boxes = [[470, 150, 1130, 262], [330, 268, 1270, 440], [450, 505, 1150, 590], [470, 610, 1130, 690], [560, 740, 1040, 815]];
    function quiet(px, py) {
      for (var b = 0; b < boxes.length; b++) {
        var q = boxes[b];
        if (px > q[0] - 20 && px < q[2] + 20 && py > q[1] - 20 && py < q[3] + 20) return 0.12;
      }
      return 1;
    }
    for (var ri = 0; ri < 46; ri++) {
      var ra = ri / 46 * Math.PI * 2 + (r() - 0.5) * 0.08;
      var r0 = 190 + r() * 70, r1 = 560 + r() * 420;
      ctx.strokeStyle = rgba(CONF[ri % CONF.length], 70 / 255); ctx.lineWidth = 2 + r() * 3;
      ctx.beginPath(); ctx.moveTo(ex + Math.cos(ra) * r0 * 1.25, ey + Math.sin(ra) * r0 * 0.7);
      ctx.lineTo(ex + Math.cos(ra) * r1 * 1.25, ey + Math.sin(ra) * r1 * 0.7); ctx.stroke();
    }
    for (var i = 0; i < 780; i++) {
      var burst = i < 560, a, x, y, sz;
      if (burst) {
        a = r() * Math.PI * 2;
        var d = 180 + Math.pow(r(), 0.7) * 820;
        x = ex + Math.cos(a) * d * 1.25; y = ey + Math.sin(a) * d * 0.72; sz = 1 + d / 1000 * 0.9;
      } else { a = r() * Math.PI * 2; x = -30 + r() * (W + 40); y = -30 + r() * (H + 40); sz = 0.9; }
      var w = (14 + r() * 14) * sz, h = (26 + r() * 30) * sz;
      if (r() < 0.2) w = h = (12 + r() * 10) * sz;
      var rot = burst ? (-a * 180 / Math.PI + 90 + (r() - 0.5) * 100) : r() * 360;
      var alpha = (190 + r() * 65) / 255 * quiet(x, y);
      var col = CONF[i % CONF.length];
      if (burst && r() < 0.55) {
        for (var tr = 1; tr <= 3; tr++) piece(ctx, x - Math.cos(a) * tr * 16 * sz, y - Math.sin(a) * tr * 10 * sz, w, h, rot, col, alpha * 0.32 / tr);
      }
      piece(ctx, x, y, w, h, rot, col, alpha);
    }

    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    var maxW = W - 120;
    if (t.name) { fitFont(ctx, t.name, 700, 92, P.brand, maxW); outlined(ctx, t.name, W / 2, 150, P.ink, P.page, 9); }
    var pnl = money(t.pnl, true);
    var size = fitFont(ctx, pnl, 600, 200, P.mono, maxW);
    outlined(ctx, pnl, W / 2, 268 + (200 - size) * 0.5, GOLD, P.page, 12);
    var line = t.sym + '  ' + sideText(t) + '  ' + t.lev + 'x';
    fitFont(ctx, line, 600, 70, P.mono, maxW);
    outlined(ctx, line, W / 2, 512, POS, P.page, 9);
    var bet = betText(t.margin) + ' bet  →  ' + pctText(t);
    fitFont(ctx, bet, 600, 58, P.ui, maxW);
    outlined(ctx, bet, W / 2, 612, P.ink, P.page, 8);

    /* footer: wordmark + link */
    ctx.textAlign = 'left';
    setFont(ctx, 700, 44, P.brand);
    var mw = ctx.measureText('confetti').width + 44 * 0.59;
    setFont(ctx, 400, 32, P.ui);
    var lw = ctx.measureText('confetti.trade').width;
    var x0 = (W - mw - 18 - lw) / 2;
    wordmark(ctx, x0, 752, 44, P, 1, 5);
    setFont(ctx, 400, 32, P.ui);
    outlined(ctx, 'confetti.trade', x0 + mw + 18, 762, P.muted, P.page, 4);
    return cv;
  }

  /* ---- the clip ----------------------------------------------------------------------------------- */

  function makeParticles(t) {
    var r = rng(seedOf(t) + 42);
    var out = [];
    for (var i = 0; i < 560; i++) {
      var second = i >= 400;                       /* a second, smaller wave a beat later */
      var a = r() * Math.PI * 2;
      var v = second ? 400 + r() * 1300 : 600 + r() * 2300;
      out.push({
        vx: Math.cos(a) * v * 0.9, vy: Math.sin(a) * v - 650, delay: (second ? 0.22 : 0) + r() * 0.06,
        rot: r() * 360, vr: (r() - 0.5) * 1440, flip: r() * Math.PI * 2, vf: 4 + r() * 10,
        w: (second ? 14 : 22) + r() * (second ? 12 : 22), h: (second ? 26 : 40) + r() * (second ? 20 : 40), c: CONF[i % CONF.length]
      });
    }
    return out;
  }

  /* one frame at s seconds */
  function drawFrame(ctx, t, parts, s, P) {
    var W = CLIP_W, H = CLIP_H, cx = W / 2, cy = 900;
    ctx.globalAlpha = 1;
    ctx.fillStyle = P.page; ctx.fillRect(0, 0, W, H);
    var intro = easeOut(s / 0.4);

    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    var head = t.sym + ' ' + sideText(t) + ' ' + t.lev + 'x' + (t.name ? ' · ' + t.name : '');
    fitFont(ctx, head, 600, 44, P.ui, W - 160);
    ctx.globalAlpha = intro; ctx.fillStyle = P.muted;
    ctx.fillText(head, cx, 200);
    ctx.globalAlpha = 1;

    var pop = s - POP_AT;
    var k = pop < 0 ? 0 : easeOut(pop / 0.3);
    var v = pop >= 0 ? t.pnl : t.pnl * easeOut((s - COUNT_AT) / COUNT_S);
    var text = money(v, true);

    if (pop >= 0 && pop < 0.9) {
      var fr = 120 + pop * 1700, fa = Math.max(0, 0.55 * (1 - pop / 0.9));
      var g0 = ctx.createRadialGradient(cx, cy, fr * 0.2, cx, cy, fr);
      g0.addColorStop(0, rgba(GOLD, fa)); g0.addColorStop(1, rgba(GOLD, 0));
      ctx.fillStyle = g0; ctx.fillRect(0, 0, W, H);
    }
    if (pop >= 0) {
      var pk = easeOut(pop / 0.25);
      ctx.globalAlpha = pk;
      roundRect(ctx, 70, cy - 170, W - 70, cy + 170, 28);
      ctx.fillStyle = rgba(P.raised, 0.92); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = P.ruleStrong; ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* the burst, out of the number */
    if (pop > 0) {
      /* linear air drag: up fast, then a slow fall at g / kd, swaying */
      var g = 2000, kd = 1.6;
      parts.forEach(function (p) {
        var dt = pop - p.delay;
        if (dt <= 0) return;
        var e = (1 - Math.exp(-kd * dt)) / kd;
        var x = cx + p.vx * e + Math.sin(p.flip + dt * 3) * 24 * Math.min(1, dt);
        var y = cy + g / kd * dt + (p.vy - g / kd) * e;
        if (y > H + 80 || x < -80 || x > W + 80) return;
        var fw = p.w * Math.max(0.15, Math.abs(Math.cos(p.flip + p.vf * dt)));
        piece(ctx, x, y, fw, p.h, p.rot + p.vr * dt, p.c, 1);
      });
    }

    /* the number: green while it counts, gold with a spring pop */
    var scale = pop < 0 ? 1 : 1.08 - 0.08 * Math.exp(-6 * pop) * Math.cos(14 * pop);
    var size = fitFont(ctx, money(t.pnl, true), 600, 170, P.mono, (W - 180) / 1.16);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.globalAlpha = intro;
    setFont(ctx, 600, size, P.mono);
    ctx.textBaseline = 'middle';
    outlined(ctx, text, 0, 0, mix(POS, GOLD, k), P.page, 6);
    ctx.restore();

    if (pop > 0.3) {
      var bet = betText(t.margin) + ' bet  →  ' + pctText(t);
      fitFont(ctx, bet, 600, 64, P.ui, W - 160);
      ctx.globalAlpha = easeOut((pop - 0.3) / 0.4);
      ctx.fillStyle = P.ink; ctx.textBaseline = 'top';
      ctx.fillText(bet, cx, cy + 230);
      ctx.globalAlpha = 1;
    }

    if (s > FOOT_AT) {
      var fa = easeOut((s - FOOT_AT) / 0.45);
      ctx.textAlign = 'left';
      setFont(ctx, 700, 110, P.brand);
      var mw = ctx.measureText('confetti').width + 110 * 0.59;
      wordmark(ctx, (W - mw) / 2, 1480, 110, P, fa, 0);
      setFont(ctx, 400, 48, P.ui);
      ctx.textAlign = 'center'; ctx.globalAlpha = fa; ctx.fillStyle = P.muted;
      ctx.fillText('confetti.trade', cx, 1640);
      ctx.globalAlpha = 1;
    }
  }

  /* a soft pop at the burst and a short party-blower toot, into the recording only */
  function scheduleSound(ac, dest, at) {
    var pop = ac.createBufferSource();
    var n = Math.floor(ac.sampleRate * 0.12);
    var buf = ac.createBuffer(1, n, ac.sampleRate);
    var d = buf.getChannelData(0);
    var r = rng(7);
    for (var i = 0; i < n; i++) d[i] = (r() * 2 - 1) * Math.exp(-i / (ac.sampleRate * 0.02));
    pop.buffer = buf;
    var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.8;
    var pg = ac.createGain(); pg.gain.value = 0.9;
    pop.connect(bp); bp.connect(pg); pg.connect(dest);
    pop.start(at);
    var thump = ac.createOscillator();
    thump.frequency.setValueAtTime(160, at); thump.frequency.exponentialRampToValueAtTime(55, at + 0.14);
    var tg = ac.createGain();
    tg.gain.setValueAtTime(0.0001, at); tg.gain.exponentialRampToValueAtTime(0.5, at + 0.005); tg.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    thump.connect(tg); tg.connect(dest);
    thump.start(at); thump.stop(at + 0.2);

    var b0 = at + 0.14, len = 0.7;
    var lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    var bg = ac.createGain();
    bg.gain.setValueAtTime(0.0001, b0); bg.gain.exponentialRampToValueAtTime(0.11, b0 + 0.03);
    bg.gain.setValueAtTime(0.11, b0 + len - 0.18); bg.gain.exponentialRampToValueAtTime(0.0001, b0 + len);
    lp.connect(bg); bg.connect(dest);
    [['sawtooth', 1], ['square', 1.005]].forEach(function (o) {
      var osc = ac.createOscillator();
      osc.type = o[0];
      osc.frequency.setValueAtTime(380 * o[1], b0); osc.frequency.linearRampToValueAtTime(500 * o[1], b0 + 0.25);
      osc.connect(lp);
      osc.start(b0); osc.stop(b0 + len + 0.02);
    });
  }

  /* the recorder types to try, best first; '' = the browser's default */
  function mimeCandidates(withAudio) {
    if (typeof MediaRecorder === 'undefined') return [];
    var list = (withAudio ? MIMES_AV : MIMES_V).filter(function (m) { return !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(m); });
    list.push('');
    return list;
  }

  /* The first recording in a browser session loses frames: in Chrome (headless on Windows, mp4 and webm
     alike) nothing is kept from ~0.3 s to ~2 s of the first take while the encoder starts; later takes are
     whole. So one throwaway 2.2 s take at the clip's size, once per page, run while the card is drawn. */
  var warmed = null;

  function warmEncoder() {
    if (warmed) return warmed;
    warmed = new Promise(function (ok) {
      var mime = mimeCandidates(false)[0];
      var cv = document.createElement('canvas');
      if (mime == null || !cv.captureStream) { ok(); return; }
      cv.width = CLIP_W; cv.height = CLIP_H;
      var ctx = cv.getContext('2d');
      var stream = cv.captureStream(CLIP_FPS), rec, timer = null, n = 0, t0 = performance.now();
      function end() { clearTimeout(timer); stream.getTracks().forEach(function (tr) { tr.stop(); }); ok(); }
      try {
        rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        rec.onstop = end;
        rec.start();
      } catch (e) { end(); return; }
      (function paint() {
        ctx.fillStyle = n++ % 2 ? '#0d1229' : '#0e132a';
        ctx.fillRect(0, 0, CLIP_W, CLIP_H);
        if (performance.now() - t0 < 2200) { timer = setTimeout(paint, 1000 / CLIP_FPS); return; }
        try { rec.stop(); } catch (e) { end(); }
      })();
    });
    return warmed;
  }

  /* one take of the 5 s clip, drawn in real time on a canvas and recorded as mime */
  function recordOnce(t, mime, done, fail) {
    var P = palette();
    var cv = document.createElement('canvas');
    cv.width = CLIP_W; cv.height = CLIP_H;
    var ctx = cv.getContext('2d');
    var parts = makeParticles(t);
    drawFrame(ctx, t, parts, 0, P);

    var stream = cv.captureStream(CLIP_FPS);
    var ac = null;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ac = new AC();
    } catch (e) { ac = null; }

    var chunks = [], cancelled = false, timer = null, raf = null, rec = null;
    function stopAll() {
      clearTimeout(timer);
      if (window.cancelAnimationFrame) cancelAnimationFrame(raf);
      stream.getTracks().forEach(function (tr) { tr.stop(); });
      if (ac && ac.state !== 'closed') ac.close().catch(function () {});
    }

    var startAt = 0;
    function tick() {
      if (cancelled) return;
      var s = (performance.now() - startAt) / 1000;
      drawFrame(ctx, t, parts, Math.min(s, CLIP_S), P);
      if (s >= CLIP_S) { timer = setTimeout(function () { if (rec.state !== 'inactive') rec.stop(); }, 120); return; }
      if (!document.hidden && window.requestAnimationFrame) raf = requestAnimationFrame(tick);
      else timer = setTimeout(tick, 1000 / CLIP_FPS);
    }
    function go() {
      if (cancelled) return;
      /* sound only from a running context; a suspended one would add a track that carries nothing */
      var dest = null;
      if (ac && ac.state === 'running') {
        try {
          dest = ac.createMediaStreamDestination();
          var track = dest.stream.getAudioTracks()[0];
          if (track) stream.addTrack(track); else dest = null;
        } catch (e) { dest = null; }
      }
      try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : { videoBitsPerSecond: 8000000 }); }
      catch (e) { cancelled = true; stopAll(); fail(e); return; }
      rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onerror = function (ev) { if (!cancelled) { cancelled = true; stopAll(); fail(ev.error || new Error('recording failed')); } };
      rec.onstop = function () {
        stopAll();
        if (cancelled) return;
        var type = rec.mimeType || mime || 'video/webm';
        done(new Blob(chunks, { type: type.split(';')[0] }), type);
      };
      if (dest) scheduleSound(ac, dest, ac.currentTime + POP_AT);
      try { rec.start(500); } catch (e) { cancelled = true; stopAll(); fail(e); return; }
      startAt = performance.now();
      tick();
    }
    /* the context starts suspended without a gesture; give resume a moment, record silent if it stays so */
    if (ac && ac.state !== 'running') {
      Promise.race([ac.resume().catch(function () {}), new Promise(function (ok) { setTimeout(ok, 300); })]).then(go);
    } else go();

    return {
      cancel: function () {
        if (cancelled) return;
        cancelled = true;
        try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) { /* already stopped */ }
        stopAll();
      }
    };
  }

  /* the clip, trying the next recorder type when the encoder refuses one (isTypeSupported can say yes to
     a type whose encoder then fails: headless Chrome on Windows, 'video/mp4;codecs=avc1,mp4a.40.2' at
     1080x1920); done(blob, mime) or fail(err) */
  function recordClip(t, done, fail) {
    var list = document.createElement('canvas').captureStream ? mimeCandidates(!!(window.AudioContext || window.webkitAudioContext)) : [];
    var take = null, dead = false;
    function next(i) { setTimeout(function () { attempt(i); }, 0); }
    function attempt(i) {
      if (dead) return;
      if (i >= list.length) { fail(new Error('This browser could not record the clip.')); return; }
      take = recordOnce(t, list[i], function (blob, type) {
        if (blob.size) done(blob, type); else next(i + 1);
      }, function () { next(i + 1); });
    }
    warmEncoder().then(function () { attempt(0); });
    return { cancel: function () { dead = true; if (take) take.cancel(); } };
  }

  /* ---- the dialog ---------------------------------------------------------------------------------- */

  var CSS = [
    '.cs-modal { width: min(760px, calc(100vw - 2 * var(--gutter, 16px))); max-width: none; max-height: calc(100vh - 24px); overflow: auto; box-sizing: border-box; padding: 0; border: 1px solid var(--ink); background: var(--raised); color: var(--ink); box-shadow: 8px 8px 0 var(--sunken); }',
    '.cs-modal::backdrop { background: rgba(0, 0, 0, 0.55); }',
    '.cs-modal .panel-head { font-size: var(--text-xl); }',
    '.cs-previews { display: grid; grid-template-columns: minmax(0, 1fr) 152px; gap: 12px; align-items: start; }',
    '.cs-shot { position: relative; min-width: 0; border: 1px solid var(--rule); background: var(--page); }',
    '.cs-card { aspect-ratio: 16 / 9; }',
    '.cs-clip { aspect-ratio: 9 / 16; }',
    '.cs-shot canvas, .cs-shot video { display: block; width: 100%; height: 100%; }',
    '.cs-wait { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 8px; text-align: center; font-size: var(--text-xs); color: var(--ink-faint); }',
    '.cs-wait[hidden], .cs-shot [hidden] { display: none; }',
    '.cs-field { display: flex; flex-direction: column; gap: 4px; }',
    '.cs-field .input { width: 100%; box-sizing: border-box; min-width: 0; }',
    '.cs-actions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }',
    '.cs-actions .btn { min-width: 0; padding: 0 6px; }',
    '.cs-fine { font-size: var(--text-xs); line-height: 1.5; color: var(--ink-faint); text-align: center; }',
    '.cs-note { min-height: 1.4em; font-size: var(--text-xs); color: var(--ink-faint); text-align: center; }',
    '.cs-note.is-err { color: var(--neg); }',
    '@media (max-width: 600px) {',
    '  .cs-previews { grid-template-columns: minmax(0, 1fr); }',
    '  .cs-clip { width: 46%; justify-self: center; }',
    '  .cs-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }',
    '}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('csStyle')) return;
    var st = document.createElement('style');
    st.id = 'csStyle';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(label, primary) {
    var b = node('button', 'btn' + (primary ? ' btn-primary' : ''), label);
    b.type = 'button';
    b.disabled = true;
    return b;
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.parentNode.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function fileBase(t) {
    return 'confetti-' + String(t.sym).toLowerCase().replace(/[^a-z0-9]+/g, '') + '-' + (t.id != null ? t.id : t.closeTs);
  }

  function nameKey(t) { return LS_NAME + (t.account ? String(t.account).toLowerCase() : 'anon'); }

  /* the trade with numbers, and the name and code filled in */
  function normalise(raw) {
    var t = {};
    Object.keys(raw || {}).forEach(function (k) { t[k] = raw[k]; });
    ['lev', 'margin', 'entry', 'exit', 'pnl', 'openTs', 'closeTs'].forEach(function (k) { t[k] = Number(t[k]); });
    if (t.szDecimals != null) t.szDecimals = Number(t.szDecimals);
    t.side = t.side === 'short' ? 'short' : 'long';
    t.sym = String(t.sym || '?');
    if (!(t.pnl > 0) || !(t.margin > 0) || !(t.lev > 0)) { var no = new Error('Not a winning close.'); no.plain = true; throw no; }
    var acct = t.account ? String(t.account).toLowerCase() : null;
    if (acct && t.code) lsSet(LS_CODE + acct, String(t.code));
    if (acct && !t.code) t.code = lsGet(LS_CODE + acct) || '';
    var name = t.name || lsGet(nameKey(t)) || t.code || shortAddr(acct);
    t.name = String(name || '').slice(0, NAME_MAX);
    return t;
  }

  function close() {
    if (cur && cur.dlg.open) cur.dlg.close();
    else if (cur) teardown(cur);
  }

  function teardown(s) {
    if (s.clip) s.clip.cancel();
    s.timers.forEach(clearTimeout);
    s.urls.forEach(function (u) { URL.revokeObjectURL(u); });
    if (s.dlg.parentNode) s.dlg.parentNode.removeChild(s.dlg);
    if (cur === s) cur = null;
  }

  function open(src) {
    close();
    warmEncoder();
    injectCss();
    var s = { dlg: null, trade: null, candles: undefined, cardBlob: null, clipBlob: null, clipMime: '', clip: null, urls: [], timers: [], gen: 0 };
    cur = s;

    var dlg = node('dialog', 'cs-modal');
    dlg.setAttribute('aria-labelledby', 'csTitle');
    s.dlg = dlg;
    var head = node('div', 'panel-head');
    var title = node('span', null, 'Share your win'); title.id = 'csTitle';
    var x = node('button', 'btn btn-sm btn-ghost btn-plain', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    head.appendChild(title); head.appendChild(x);
    var body = node('div', 'panel-body stack');

    var previews = node('div', 'cs-previews');
    var cardBox = node('div', 'cs-shot cs-card');
    var cardWait = node('div', 'cs-wait', 'Reading the trade…');
    cardBox.appendChild(cardWait);
    var clipBox = node('div', 'cs-shot cs-clip');
    var clipWait = node('div', 'cs-wait', 'Making the clip…');
    var video = document.createElement('video');
    video.controls = true; video.playsInline = true; video.setAttribute('playsinline', ''); video.preload = 'metadata';
    video.hidden = true;
    clipBox.appendChild(video); clipBox.appendChild(clipWait);
    previews.appendChild(cardBox); previews.appendChild(clipBox);

    var field = node('label', 'cs-field');
    field.appendChild(node('span', 'label', 'Name on the card'));
    var input = node('input', 'input');
    input.type = 'text'; input.maxLength = NAME_MAX; input.autocomplete = 'off'; input.spellcheck = false;
    field.appendChild(input);

    var actions = node('div', 'cs-actions');
    var bSave = button('Save card'), bClip = button('Save clip'), bCopy = button('Copy card'), bPost = button('Post on X', true);
    [bSave, bClip, bCopy, bPost].forEach(function (b) { actions.appendChild(b); });
    var fine = node('div', 'cs-fine', 'Attach the card or the clip to the post.');
    var note = node('div', 'cs-note'); note.setAttribute('aria-live', 'polite');

    body.appendChild(previews); body.appendChild(field); body.appendChild(actions); body.appendChild(fine); body.appendChild(note);
    dlg.appendChild(head); dlg.appendChild(body);
    document.body.appendChild(dlg);
    dlg.addEventListener('close', function () { teardown(s); });
    dlg.addEventListener('click', function (ev) { if (ev.target === dlg) dlg.close(); });
    x.addEventListener('click', function () { dlg.close(); });
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');

    function say(text, err) { note.textContent = text || ''; note.classList.toggle('is-err', !!err); }

    function renderCard() {
      var t = s.trade;
      var cv = drawCard(t, s.candles);
      var old = cardBox.querySelector('canvas');
      if (old) cardBox.replaceChild(cv, old); else cardBox.insertBefore(cv, cardWait);
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', (t.name ? t.name + ': ' : '') + money(t.pnl, true) + ' on ' + t.sym + ' ' + t.side + ' ' + t.lev + 'x');
      cardWait.hidden = true;
      s.cardBlob = null;
      bSave.disabled = true; bCopy.disabled = true;
      s.cardPromise = new Promise(function (ok, no) {
        cv.toBlob(function (b) { if (b) ok(b); else no(new Error('no image')); }, 'image/png');
      });
      s.cardPromise.then(function (b) {
        if (cur !== s || cardBox.querySelector('canvas') !== cv) return;
        s.cardBlob = b; bSave.disabled = false; bCopy.disabled = false;
      }, function () { say('Could not make the card image.', true); });
    }

    function renderClip() {
      if (s.clip) s.clip.cancel();
      var gen = ++s.gen;
      s.clipBlob = null; bClip.disabled = true;
      video.hidden = true; video.removeAttribute('src'); video.load();
      clipWait.textContent = 'Making the clip…'; clipWait.hidden = false;
      s.clip = recordClip(s.trade, function (blob, mime) {
        if (cur !== s || gen !== s.gen) return;
        s.clip = null;
        s.clipBlob = blob; s.clipMime = mime;
        var url = URL.createObjectURL(blob);
        s.urls.push(url);
        video.muted = true;
        var still = reducedMotion();
        video.autoplay = !still; video.loop = !still;
        video.src = url;
        video.hidden = false; clipWait.hidden = true;
        bClip.disabled = false;
        if (!still) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      }, function (e) {
        if (cur !== s || gen !== s.gen) return;
        s.clip = null;
        clipWait.textContent = (e && e.message) || 'Could not record the clip.';
      });
    }

    function later(fn, ms) { var id = setTimeout(fn, ms); s.timers.push(id); return id; }
    var cardTimer = null, clipTimer = null;
    input.addEventListener('input', function () {
      if (!s.trade) return;
      s.trade.name = input.value.trim().slice(0, NAME_MAX);
      lsSet(nameKey(s.trade), s.trade.name);
      clearTimeout(cardTimer); clearTimeout(clipTimer);
      if (s.clip) { s.clip.cancel(); s.clip = null; s.gen++; clipWait.textContent = 'Making the clip…'; clipWait.hidden = false; video.hidden = true; bClip.disabled = true; }
      cardTimer = later(renderCard, 250);
      clipTimer = later(renderClip, 900);
    });

    bSave.addEventListener('click', function () {
      if (s.cardBlob) saveBlob(s.cardBlob, fileBase(s.trade) + '.png');
    });
    bClip.addEventListener('click', function () {
      if (s.clipBlob) saveBlob(s.clipBlob, fileBase(s.trade) + (/mp4/.test(s.clipMime) ? '.mp4' : '.webm'));
    });
    bCopy.addEventListener('click', function () {
      var fallback = function () { if (s.cardBlob) { saveBlob(s.cardBlob, fileBase(s.trade) + '.png'); say('Copy is blocked here; saved the card instead.'); } };
      try {
        if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') { fallback(); return; }
        navigator.clipboard.write([new ClipboardItem({ 'image/png': s.cardBlob || s.cardPromise })])
          .then(function () { say('Card copied.'); }, fallback);
      } catch (e) { fallback(); }
    });
    bPost.addEventListener('click', function () {
      var t = s.trade;
      var text = money(t.pnl, true) + ' on ' + t.sym + ' ' + t.lev + 'x. confetti.trade';
      var link = t.code ? SITE + '/?ref=' + encodeURIComponent(t.code) : SITE;
      var url = 'https://x.com/intent/post?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(link);
      window.open(url, '_blank', 'noopener');
    });

    Promise.resolve(src).then(function (raw) {
      if (cur !== s) return;
      s.trade = normalise(raw);
      input.value = s.trade.name;
      bPost.disabled = false;
      cardWait.textContent = 'Drawing the card…';
      return fontsReady().then(function () {
        return fetchCandles(s.trade).catch(function () { return null; });
      }).then(function (ch) {
        if (cur !== s) return;
        s.candles = ch;
        renderCard();
        renderClip();
      });
    }).catch(function (e) {
      if (cur !== s) return;
      cardWait.textContent = 'Could not read this trade.';
      clipWait.textContent = '';
      say(e && e.plain ? e.message : 'The chain did not answer; try again in a moment.', true);
    });
    return s;
  }

  window.ConfettiShare = {
    open: function (trade) { open(trade); },
    use: function (h) { if (h && typeof h.postInfo === 'function') hooks.postInfo = h.postInfo; }
  };
})();
