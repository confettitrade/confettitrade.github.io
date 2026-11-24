/* Share your trade: the trade card and the one sheet every Share on every page opens (the owner, 2026-11-21: "make it so
   when you click share on portfolio page it shows the new pnl cards", then "get rid of those janky old ones all together").

   The card: one closed trade as a 16:9 picture in the owner's design, drawn on canvas ("the trade card" below).
   The sheet: the card on top, drawn again at every choice, and under it the trader's choices (the address, the amount put
   in, how the result shows, four looks, a line of their own), then one black key that hands the PNG to the phone's share
   sheet, or saves it where there is none ("the sheet" below). Its markup and its CSS are in this file, so every page that
   loads share.js shows the same sheet: Simple's end screen, the portfolio page's rows, the trade page's rows and its close
   line. qr.js (beside this file) and the card's fonts load on first use. No contract calls, nothing is sent.

   window.ConfettiShare.open(trade or a Promise of one, host?) opens the sheet. trade:
     { id?, sym, side: 'long' | 'short' (or isLong), lev, margin (what went in), pnl (the result against it),
       account?, code? (the trader's own referral code), level? (the FETTI level),
       sideWord? (the word drawn after the slash in place of LONG / SHORT: the coin flip's HEADS / TAILS),
       lines? (three short lines for the card's bottom right, in place of the trading ones) }
   A field a page does not know is left out: the card goes without it (no address, the plain confetti.trade QR code, no
   level). host, all optional: { account (whose choices show while a Promise is still being read), key (which trade this is,
     for its caption; else the id), title (the sheet's heading; "Share your trade" without it), opened(ctl) and
     closed(fromBack, choices) for a page with sheets of its own (Simple): the sheet then joins that page's own back and
     double-tap handling instead of keeping its own; ctl = { dialog, close } }. */
(function () {
  'use strict';

  var LS_CODE = 'confetti.share.code.';
  var SITE = 'https://confetti.trade';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  /* seeded, so a redraw keeps the same confetti */
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

  function roundRect(ctx, x0, y0, x1, y1, r) {
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x1, y0, x1, y1, r);
    ctx.arcTo(x1, y1, x0, y1, r);
    ctx.arcTo(x0, y1, x0, y0, r);
    ctx.arcTo(x0, y0, x1, y0, r);
    ctx.closePath();
  }

  /* ---- the trade card: the owner's design (2026-11-19, two Phonto mock-ups and "can you use those at the end") ----------
     A 16:9 card at the end of every trade, green for a win and red for a loss, drawn in the mock-ups' own units (1672 x 941)
     and saved at twice that: the cream dotted paper under a soft dark vignette; the wordmark and its red block top left,
     confetti.trade top right; the app icon (c_) in the middle; on the left the signed percent, what went in ("Initial") and
     what came out ("Profit" / "Loss"); on the right the coin and side, and the leverage; bottom left the QR code (confetti.trade
     with the trader's referral code, the site's ?ref= link) and the short address; three small lines bottom right. Söhne
     throughout (the owner: "use sohne and sohne"): Schmal Halbfett drawn about 1.5 wide for the big figures (the mock-ups' weight
     and width), Leicht for the small lines, Breit Extrafett for the wordmark, the site logo's Breit Fett for the icon's c.
     Nothing here talks about fees.
     tradeCard({ sym, side | isLong, lev, margin, pnl, account?, code?, level? }, choices?) -> Promise of { canvas, blob, file,
     name, link, win, opts, text }. Fonts and the QR encoder (qr.js) load on first use; cardReady() starts that early.

     The trader's choices (the owner, 2026-11-21: "make it so they customize the pnl cards too. removeable wallet address.
     removable trade amount."). His card is the default, and every choice is a layer on it (cardOpts):
       addr     false takes the short address off the card, with nothing in its place;
       amount   false takes what went in ("Initial") off the card;
       result   'both' (his: the percent, the dollars under it), 'pct' (the percent alone) or 'usd' (the dollars in the percent's
                place, in its letters);
       look     'classic' (his), 'paper', 'confetti' or 'night': the same card, the same places, in the brand's other dress;
       caption  a short line of the trader's own, beside the QR code.
     A line that goes leaves no gap: the lines under the big figure close up and the block is set back on the icon's middle.
     What is switched off is not drawn, and nothing else the share carries has it: the file's name is the coin, the side and
     the boost; the only words handed to a share sheet are the trader's own caption. The QR code with the trader's referral
     code and the FETTI level stay on every look. */

  var TC_W = 1672, TC_H = 941, TC_SCALE = 2;
  var TC_FONTS = [['Soehne Schmal Card', 'fonts/soehne-schmal-600.woff2'], ['Soehne Leicht Card', 'fonts/soehne-300.woff2'], ['Soehne Breit Card', 'fonts/soehne-breit-900.woff2'],
    ['Soehne Breit Card C', 'fonts/soehne-breit-700.woff2']];
  var TC_BIG = '"Soehne Schmal Card", "Soehne", sans-serif', TC_SMALL = '"Soehne Leicht Card", "Soehne", sans-serif', TC_MARK = '"Soehne Breit Card", "Soehne Breit", sans-serif';
  var TC_C = '"Soehne Breit Card C", "Soehne Breit", sans-serif';      /* the icon's c: the site logo's own Breit Fett */
  var TC_QR_SRC = 'qr.js?v=card1';
  var TC_PAPER = '#f9edcf', TC_INK = '#000', TC_RED = '#f32d35';
  /* the mock-ups' own colours: the figures, the icon's face, its edge, its shadow */
  var TC_WIN = { ink: '#007552', face: '#39784e', edge: '#214d2e', shade: '22,66,34' };
  var TC_LOSS = { ink: '#e01717', face: '#c0121f', edge: '#7a020c', shade: '62,42,24' };
  var TC_SX = 1.45, TC_SX_PCT = 1.5;    /* Söhne Schmal drawn this much wider: the mock-ups' letters (the percent a touch more) */
  var TC_CAP_MAX = 40;
  /* the looks: his own first. ink: the wordmark and the small lines; win / loss: the figures and the icon; c: the icon's letter;
     lvl: the FETTI pill's line and letters, its tint, the paper under it */
  var TC_LOOKS = [
    { id: 'classic', name: 'Classic', ink: TC_INK, win: TC_WIN, loss: TC_LOSS, c: '#fff', lvl: ['#214d2e', 'rgba(57, 120, 78, 0.12)', TC_PAPER] },
    /* the app's own paper: flat cream, the fine dots, an ink frame like a trade's card, a black key for the icon */
    { id: 'paper', name: 'Paper', ink: '#2a2520', c: '#faf6ed', lvl: ['#2a2520', 'rgba(42, 37, 32, 0.05)', '#faf6ed'],
      win: { ink: '#2e7a4c', face: '#2a2520', edge: '#0f0d0b', shade: '42,37,32' }, loss: { ink: '#b44855', face: '#2a2520', edge: '#0f0d0b', shade: '42,37,32' } },
    /* his card under a throw of confetti in the brand's colours */
    { id: 'confetti', name: 'Confetti', ink: TC_INK, win: TC_WIN, loss: TC_LOSS, c: '#fff', lvl: ['#214d2e', 'rgba(57, 120, 78, 0.12)', TC_PAPER] },
    /* the black key as a card: ink paper, cream letters, the night colours for up and down */
    { id: 'night', name: 'Night', ink: '#f4ecd8', c: '#fff', lvl: ['#f4ecd8', 'rgba(244, 236, 216, 0.08)', '#2a2520'],
      win: { ink: '#4ade80', face: '#39784e', edge: '#214d2e', shade: '0,0,0' }, loss: { ink: '#f47287', face: '#c0121f', edge: '#7a020c', shade: '0,0,0' } }
  ];
  function tcLook(id) { for (var i = 0; i < TC_LOOKS.length; i++) if (TC_LOOKS[i].id === id) return TC_LOOKS[i]; return TC_LOOKS[0]; }

  /* the choices, whole and safe: anything missing or unknown is his card as he drew it */
  function cardOpts(o) {
    o = o && typeof o === 'object' ? o : {};
    var cap = String(o.caption == null ? '' : o.caption).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
    cap = (Array.from ? Array.from(cap) : cap.split('')).slice(0, TC_CAP_MAX).join('').trim();
    return { addr: o.addr !== false, amount: o.amount !== false, result: o.result === 'pct' || o.result === 'usd' ? o.result : 'both', look: tcLook(o.look).id, caption: cap };
  }

  /* the choices kept on this device, each wallet its own (never the caption: that is about one trade). Where storage is
     blocked they last as long as the page */
  var LS_CARD = 'confetti.card.', cardMem = {};
  function cardPrefsKey(account) { return LS_CARD + (account ? String(account).toLowerCase() : 'anon'); }
  function cardPrefsGet(account) {
    var k = cardPrefsKey(account), raw = cardMem[k] != null ? cardMem[k] : lsGet(k), o = null;
    try { o = raw ? JSON.parse(raw) : null; } catch (e) { o = null; }
    o = cardOpts(o); o.caption = '';
    return o;
  }
  function cardPrefsSet(account, opts) {
    var o = cardOpts(opts), k = cardPrefsKey(account), raw = JSON.stringify({ addr: o.addr, amount: o.amount, result: o.result, look: o.look });
    cardMem[k] = raw; lsSet(k, raw);
  }

  var tcLoad = null;
  /* the three faces and qr.js, once per page; a failure is forgotten so the next card tries again */
  function cardReady() {
    if (tcLoad) return tcLoad;
    var fonts = TC_FONTS.map(function (f) {
      if (typeof FontFace !== 'function' || !document.fonts) return Promise.resolve();
      var face = new FontFace(f[0], 'url("' + f[1] + '") format("woff2")', { style: 'normal', weight: 'normal' });
      document.fonts.add(face);
      return face.load();
    });
    var qr = window.ConfettiQR ? Promise.resolve() : new Promise(function (ok, no) {
      var s = document.createElement('script');
      s.src = TC_QR_SRC; s.async = true;
      s.onload = function () { if (window.ConfettiQR) ok(); else no(new Error('qr.js did not start')); };
      s.onerror = function () { no(new Error('qr.js did not load')); };
      document.head.appendChild(s);
    });
    tcLoad = Promise.all(fonts.concat([qr])).catch(function (e) { tcLoad = null; throw e; });
    return tcLoad;
  }

  /* the trade with numbers: win, the percent and the two money lines exactly as the end screen rounds them */
  function cardTrade(raw) {
    var t = {};
    Object.keys(raw || {}).forEach(function (k) { t[k] = raw[k]; });
    t.lev = Number(t.lev); t.margin = Number(t.margin); t.pnl = Number(t.pnl);
    if (!(t.margin > 0) || !isFinite(t.pnl) || !(t.lev > 0)) throw new Error('Not a closed trade.');
    t.long = t.isLong != null ? !!t.isLong : t.side !== 'short';
    t.sym = String(t.sym || '?');
    t.sideWord = t.sideWord ? String(t.sideWord).toUpperCase().slice(0, 8) : '';
    t.lines = Array.isArray(t.lines) && t.lines.length === 3 ? t.lines.map(function (s) { return String(s).slice(0, 34); }) : null;
    t.win = !(t.pnl < -0.004);                      /* the end screen's own line: a loss is under -$0.004 */
    var acct = t.account ? String(t.account).toLowerCase() : '';
    if (acct && t.code) lsSet(LS_CODE + acct, String(t.code));
    if (acct && !t.code) t.code = lsGet(LS_CODE + acct) || '';
    t.link = t.code ? SITE + '/?ref=' + encodeURIComponent(t.code) : SITE;
    t.addr = acct ? acct.slice(0, 6) + '…' + acct.slice(-4) : '';
    return t;
  }

  function cardMoney(n) { return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  /* the percent without its sign (the sign is drawn): "35.2", "100", "1,250" */
  function cardPct(t) {
    var r = Math.abs(t.pnl) / t.margin * 100;
    if (r >= 999.95) return Math.round(r).toLocaleString('en-US') + '%';
    var s = r.toFixed(1);
    return (s === '100.0' ? '100' : s) + '%';
  }

  /* Text placed by its ink: the ink starts at x (left) or ends at x (right), on baseline y. ls: room between letters in card
     units; sx: the letters drawn this much wider. Letters go one at a time (canvas letterSpacing is not on every phone),
     each where the string up to it ends, so kerning is kept; a slash sits `slash` closer to the letter before it (Söhne's
     slanted one stands off a capital's top). maxW: the ink is never wider (sx gives way to minSx first, then the size). Returns the
     ink box. */
  function tcLayout(ctx, text, o) {
    var size = o.size, sx = o.sx || 1, ls = o.ls || 0, minSx = o.minSx || sx;
    var m, n = text.length;
    function measure() {
      ctx.font = Math.round(size * 100) / 100 + 'px ' + o.font;
      var pre = [], pull = 0;
      for (var i = 0; i < n; i++) {
        if (o.slash && i > 0 && text.charAt(i) === '/') pull += o.slash;
        /* each letter where the string up to it ends: a pair's kerning lands on the letter after it (the mock-ups' figures
           are matched this way and stay so); kern: the pair's own kerning, for the lines added since */
        pre.push((o.kern ? ctx.measureText(text.slice(0, i + 1)).width - ctx.measureText(text.charAt(i)).width : ctx.measureText(text.slice(0, i)).width) + (i * ls - pull) / sx);
      }
      var first = ctx.measureText(text.charAt(0)), last = ctx.measureText(text.charAt(n - 1));
      var left = -first.actualBoundingBoxLeft, right = pre[n - 1] + last.actualBoundingBoxRight;
      m = { pre: pre, left: left, right: right, w: (right - left) * sx };
    }
    measure();
    if (o.maxW && m.w > o.maxW && sx > minSx) { sx = Math.max(minSx, sx * o.maxW / m.w); measure(); }
    if (o.maxW && m.w > o.maxW) { size = size * o.maxW / m.w; measure(); }
    var x0 = o.align === 'right' ? o.x - m.right * sx : o.x - m.left * sx;
    return { text: text, font: o.font, size: size, sx: sx, pre: m.pre, x0: x0, y: o.y, w: m.w, inkL: x0 + m.left * sx, inkR: x0 + m.right * sx };
  }

  function tcDraw(ctx, L, color) {
    ctx.save();
    ctx.font = Math.round(L.size * 100) / 100 + 'px ' + L.font;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.translate(L.x0, L.y);
    ctx.scale(L.sx, 1);
    for (var i = 0; i < L.text.length; i++) ctx.fillText(L.text.charAt(i), L.pre[i], 0);
    ctx.restore();
  }

  function tcText(ctx, text, o, color) { var L = tcLayout(ctx, text, o); tcDraw(ctx, L, color); return L; }

  /* the vignette's strength by distance from (836, 403), as measured off the mock-ups: [distance, alpha of rgb(40, 45, 25)] */
  var TC_VIG = [[300, 0], [356, 0.014], [416, 0.026], [476, 0.05], [536, 0.088], [596, 0.148], [656, 0.218], [716, 0.287], [776, 0.36],
    [836, 0.42], [930, 0.485], [1000, 0.53]];
  var tcVig = {};
  /* worked out once, pixel by pixel, on a small canvas the card scales up: a canvas gradient is dithered, and that grain
     makes the PNG three times the size. rgb: the shade's colour (his: 40, 45, 25) */
  function tcVignette(rgb) {
    rgb = rgb || [40, 45, 25];
    var key = rgb.join(',');
    if (tcVig[key]) return tcVig[key];
    var k = 8, w = Math.ceil(TC_W / k) + 1, h = Math.ceil(TC_H / k) + 1;
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var c2 = cv.getContext('2d'), img = c2.createImageData(w, h), d = img.data;
    for (var j = 0; j < h; j++) {
      for (var i = 0; i < w; i++) {
        var r = Math.sqrt(Math.pow(i * k - 836, 2) + Math.pow(j * k - 403, 2)), a = TC_VIG[TC_VIG.length - 1][1];
        for (var s = 1; s < TC_VIG.length; s++) {
          if (r <= TC_VIG[s][0]) { var p = TC_VIG[s - 1], q = TC_VIG[s]; a = r <= p[0] ? p[1] : p[1] + (q[1] - p[1]) * (r - p[0]) / (q[0] - p[0]); break; }
        }
        var o = (j * w + i) * 4;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = Math.round(a * 255);
      }
    }
    c2.putImageData(img, 0, 0);
    tcVig[key] = { cv: cv, k: k };
    return tcVig[key];
  }

  function tcDots(ctx, color, r) {
    ctx.fillStyle = color;
    for (var y = 37.4; y < TC_H; y += 43.6) {
      for (var x = 34.6; x < TC_W; x += 44.77) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  function tcShade(ctx, rgb) {
    var v = tcVignette(rgb);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = 'high'; } catch (e) { /* older browsers: the default smoothing */ }
    ctx.drawImage(v.cv, 0, 0, v.cv.width * v.k, v.cv.height * v.k);
    ctx.restore();
  }

  /* the paper: cream, the dot grid, and the soft dark vignette, darker at the sides and corners */
  function tcPaper(ctx) {
    ctx.fillStyle = TC_PAPER; ctx.fillRect(0, 0, TC_W, TC_H);
    tcDots(ctx, 'rgba(120, 95, 55, 0.24)', 2.9);
    tcShade(ctx);
  }

  /* the same throw for the same trade, on the page and in the PNG: the trade's own figures seed it */
  function tcSeed(t) {
    var s = t.sym + '|' + (t.long ? 'l' : 's') + '|' + t.lev + '|' + Math.round(t.margin * 100) + '|' + Math.round(t.pnl * 100), x = 2166136261;
    for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x >>> 0;
  }
  /* where the card's own things are, with room around them: no piece lands there, whatever is switched on or off (so the
     throw does not move when a choice does) */
  var TC_KEEP = [[30, 28, 470, 132], [1280, 14, 1672, 146], [40, 262, 652, 612], [652, 276, 1022, 660], [960, 524, 1672, 812], [0, 716, 1010, 941], [1196, 812, 1672, 941]];
  var TC_BITS = ['#b44855', '#2e7a4c', '#f32d35', '#facc15', '#788cff', '#2a2520'];
  function tcConfetti(ctx, t) {
    var r = rng(tcSeed(t) + 7), got = [];
    /* thrown from above: thick at the top, thinning down the card; a few big pieces, a few long strips, the rest small. No
       piece lies across another, and each has the wordmark block's own slightly rounded corners */
    for (var i = 0; i < 1600 && got.length < 84; i++) {
      var x = r() * TC_W, y = Math.pow(r(), 1.9) * TC_H, kind = r(), deg = r() * 180, col = TC_BITS[Math.floor(r() * TC_BITS.length)];
      var w = kind < 0.14 ? 56 + r() * 30 : kind < 0.42 ? 34 + r() * 14 : 19 + r() * 12, h = kind < 0.14 ? 8 + r() * 3 : kind < 0.42 ? 15 + r() * 6 : 9 + r() * 6;
      var pad = w / 2 + 8;
      if (TC_KEEP.some(function (k) { return x > k[0] - pad && x < k[2] + pad && y > k[1] - pad && y < k[3] + pad; })) continue;
      if (got.some(function (g) { var dx = g[0] - x, dy = g[1] - y, near = (g[2] + w) / 2 + 5; return dx * dx + dy * dy < near * near; })) continue;
      got.push([x, y, w]);
      ctx.save();
      ctx.translate(x, y); ctx.rotate(deg * Math.PI / 180);
      roundRect(ctx, -w / 2, -h / 2, w / 2, h / 2, Math.min(3, h / 3)); ctx.fillStyle = col; ctx.fill();
      ctx.restore();
    }
  }

  /* the card's ground in each look */
  function tcBack(ctx, look, t) {
    if (look.id === 'paper') {
      ctx.fillStyle = '#faf6ed'; ctx.fillRect(0, 0, TC_W, TC_H);
      tcDots(ctx, 'rgba(42, 37, 32, 0.13)', 2.6);
      ctx.lineWidth = 12; ctx.strokeStyle = '#2a2520'; ctx.strokeRect(6, 6, TC_W - 12, TC_H - 12);
      return;
    }
    if (look.id === 'night') {
      ctx.fillStyle = '#322c26'; ctx.fillRect(0, 0, TC_W, TC_H);
      tcDots(ctx, 'rgba(244, 236, 216, 0.11)', 2.9);
      tcShade(ctx, [8, 6, 4]);
      return;
    }
    tcPaper(ctx);
    if (look.id === 'confetti') tcConfetti(ctx, t);
  }

  /* the app icon: a rounded tile with a darker edge under it and a soft shadow, the white c and its bar */
  function tcIcon(ctx, pal, S, ink) {
    var x = 687, y = 314, w = 300, h = 296, r = 66, edge = 8;
    ctx.save();
    ctx.shadowColor = 'rgba(' + pal.shade + ', 0.52)';
    ctx.shadowBlur = 46 * S; ctx.shadowOffsetY = 12 * S;      /* the shadow is not scaled with the drawing */
    roundRect(ctx, x, y + edge, x + w, y + edge + h, r); ctx.fillStyle = pal.edge; ctx.fill();
    ctx.restore();
    roundRect(ctx, x, y + edge, x + w, y + edge + h, r); ctx.fillStyle = pal.edge; ctx.fill();
    roundRect(ctx, x, y, x + w, y + h, r); ctx.fillStyle = pal.face; ctx.fill();
    /* c: its ink in the mock-up's box (727..867 x 399..527); the bar 869..957 x 501..526 */
    var c = tcLayout(ctx, 'c', { font: TC_C, size: 233.5, x: 727, y: 524.5, sx: 0.935 });
    tcDraw(ctx, c, ink);
    ctx.fillStyle = ink; ctx.fillRect(870, 501, 88, 25);
  }

  function tcWordmark(ctx, ink) {
    var L = tcText(ctx, 'confetti', { font: TC_MARK, size: 77, x: 55, y: 98.5, ls: 0.2 }, ink);
    roundRect(ctx, L.inkR + 6, 51, L.inkR + 36, 107, 4); ctx.fillStyle = TC_RED; ctx.fill();
  }

  /* the QR code on white: as coarse as the link allows (the mock-up's look: version 2 for confetti.trade alone, 3 with most
     referral codes), error correction M, two modules of white around it, modules on whole pixels */
  function tcQr(ctx, link, S) {
    var q = null;
    [2, 3, 4].some(function (v) { try { q = window.ConfettiQR.create(link, { errorCorrectionLevel: 'M', version: v }); return true; } catch (e) { return false; } });
    if (!q) q = window.ConfettiQR.create(link, { errorCorrectionLevel: 'M' });
    var n = q.modules.size, quiet = 2, box = 168;
    /* whole device pixels per module where there are a few of them (the PNG); a small preview keeps the exact size */
    var px = box * S / (n + quiet * 2), mod = (px >= 3 ? Math.round(px) : px) / S, side = mod * (n + quiet * 2);
    var x0 = 26 + (box - side) / 2, y0 = 744 + (box - side) / 2;
    x0 = Math.round(x0 * S) / S; y0 = Math.round(y0 * S) / S;
    ctx.fillStyle = '#fff'; ctx.fillRect(x0, y0, side, side);
    ctx.fillStyle = '#000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) if (q.modules.get(r, c)) ctx.fillRect(x0 + (c + quiet) * mod, y0 + (r + quiet) * mod, mod, mod);
    }
    return { x: x0, y: y0, side: side, version: q.version };
  }

  /* A capsule ring (the mock-up's % has two, tall like a 0): outer box x0..x1 / y0..y1, its counter inside, filled even-odd */
  function tcRing(ctx, x0, y0, x1, y1, cx0, cy0, cx1, cy1) {
    ctx.beginPath();
    var r = Math.min((x1 - x0) / 2, (y1 - y0) / 2), q = Math.min((cx1 - cx0) / 2, (cy1 - cy0) / 2);
    ctx.moveTo(x0 + r, y0); ctx.arcTo(x1, y0, x1, y1, r); ctx.arcTo(x1, y1, x0, y1, r); ctx.arcTo(x0, y1, x0, y0, r); ctx.arcTo(x0, y0, x1, y0, r); ctx.closePath();
    ctx.moveTo(cx0 + q, cy0); ctx.arcTo(cx1, cy0, cx1, cy1, q); ctx.arcTo(cx1, cy1, cx0, cy1, q); ctx.arcTo(cx0, cy1, cx0, cy0, q); ctx.arcTo(cx0, cy0, cx1, cy0, q); ctx.closePath();
    ctx.fill('evenodd');
  }

  /* a heavy slash: bottom edge bx0..bx1 on y0, top edge tx0..tx1 on y1 */
  function tcSlash(ctx, bx0, bx1, y0, tx0, tx1, y1) {
    ctx.beginPath(); ctx.moveTo(bx0, y0); ctx.lineTo(bx1, y0); ctx.lineTo(tx1, y1); ctx.lineTo(tx0, y1); ctx.closePath(); ctx.fill();
  }

  /* The percent the mock-ups' way: a heavy plus or minus bar, the figures in Söhne Schmal, and his own chunky % (two tall
     rings and a heavy slash, measured off the mock-up), all in his units at k = size / 173 (his figures' size). Its ink starts
     at 66 on baseline 440.5 and never comes nearer the icon than about 70 (the mock-up keeps 118): it ends by 618.
     base: its baseline (his 440.5, lower when lines under it are switched off). usd: the dollars stand here instead, the
     same bar and the same letters, with no % after them. */
  function tcPercent(ctx, t, pal, base, usd) {
    var flat = Math.abs(t.pnl) <= 0.004, num = usd ? cardMoney(t.pnl) : cardPct(t).replace(/%$/, ''), maxW = 552;
    var size = 173, sx = TC_SX_PCT, P;
    function lay() {
      var k = size / 173, L = tcLayout(ctx, num, { font: TC_BIG, size: size, x: 0, y: base, sx: sx, ls: usd ? 3 * k : 0, kern: usd });
      var signW = flat ? 0 : (t.win ? 51 : 41) * k, gapS = flat ? 0 : 10 * k;
      P = { k: k, L: L, signW: signW, gapS: gapS, gapP: usd ? 0 : 9 * k, pctW: usd ? 0 : 164 * k };
      P.w = signW + gapS + L.w + P.gapP + P.pctW;
    }
    lay();
    if (P.w > maxW) { sx = Math.max(usd ? 1.3 : 1.15, sx * (P.L.w - (P.w - maxW)) / P.L.w); lay(); }
    for (var i = 0; i < 3 && P.w > maxW; i++) { size *= maxW / P.w; lay(); }
    var k = P.k, x = 66;
    ctx.fillStyle = pal.ink;
    if (!flat) {
      var cy = base - 50 * k, bar = 18 * k;
      ctx.fillRect(x, cy - bar / 2, P.signW, bar);
      if (t.win) ctx.fillRect(x + (P.signW - 19 * k) / 2, cy - P.signW / 2, 19 * k, P.signW);
    }
    var L = tcLayout(ctx, num, { font: TC_BIG, size: size, x: x + P.signW + P.gapS, y: base, sx: sx, ls: usd ? 3 * k : 0, kern: usd });
    tcDraw(ctx, L, pal.ink);
    if (usd) return;
    var p = L.inkR + P.gapP, f = function (v) { return p + v * k; }, g = function (v) { return base + v * k; };
    ctx.fillStyle = pal.ink;
    tcRing(ctx, f(0), g(-135.5), f(62), g(-41.5), f(24), g(-117.5), f(38), g(-61.5));
    tcRing(ctx, f(102), g(-92.5), f(164), g(1.5), f(126), g(-74.5), f(140), g(-18.5));
    tcSlash(ctx, f(50), f(75), g(0), f(90.5), f(115.5), g(-138.5));
  }

  /* COIN/SIDE, right-aligned at 1631 on baseline 658.5: the coin and the side in Söhne Schmal, between them the mock-up's own
     heavy upright slash (Söhne's is light and leans far). A long coin name gives up some width first, then some size, and
     never comes nearer the icon than about 84. */
  function tcCoin(ctx, sym, side, pal) {
    var size = 138, sx = TC_SX, maxW = 560, base = 658.5, right = 1631, A, B, k, w;
    function lay() {
      k = size / 138;
      A = tcLayout(ctx, sym, { font: TC_BIG, size: size, x: 0, y: base, sx: sx, ls: 4.5 });
      B = tcLayout(ctx, side, { font: TC_BIG, size: size, x: 0, y: base, sx: sx, ls: 4.5 });
      w = A.w + (10 + 47 + 14) * k + B.w;
    }
    lay();
    if (w > maxW) { sx = Math.max(1.1, sx * (A.w + B.w - (w - maxW)) / (A.w + B.w)); lay(); }
    for (var i = 0; i < 3 && w > maxW; i++) { size *= maxW / w; lay(); }
    B = tcLayout(ctx, side, { font: TC_BIG, size: size, x: right, y: base, sx: sx, ls: 4.5, align: 'right' });
    var s1 = B.inkL - 14 * k, s0 = s1 - 47 * k;          /* the slash: 22 wide, leaning 25 over 108, its top 10 over the capitals */
    A = tcLayout(ctx, sym, { font: TC_BIG, size: size, x: s0 - 10 * k, y: base, sx: sx, ls: 4.5, align: 'right' });
    tcDraw(ctx, A, pal.ink); tcDraw(ctx, B, pal.ink);
    ctx.fillStyle = pal.ink;
    tcSlash(ctx, s0, s0 + 22 * k, base, s1 - 22 * k, s1, base - 108.5 * k);
  }

  /* the trader's FETTI level (money back for stakers, fetti.js), a small ink-ringed pill under confetti.trade: "FETTI LEVEL 2".
     Level 0 or none draws nothing, so a card without a level is the owner's design exactly. */
  function tcLevel(ctx, n, look) {
    n = Math.round(Number(n) || 0);
    if (!(n >= 1 && n <= 9)) return;
    var L = tcLayout(ctx, 'FETTI LEVEL ' + n, { font: TC_BIG, size: 36, x: 1614, y: 114, align: 'right', ls: 2.5, sx: 1.15 });
    var x0 = L.inkL - 26, x1 = 1640, y0 = 70, y1 = 130;
    roundRect(ctx, x0, y0, x1, y1, 30); ctx.fillStyle = look.lvl[2]; ctx.fill(); ctx.fillStyle = look.lvl[1]; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = look.lvl[0]; roundRect(ctx, x0, y0, x1, y1, 30); ctx.stroke();
    tcDraw(ctx, L, look.lvl[0]);
  }

  /* a line of the trader's own words, drawn whole (an emoji or an accent is more than one unit: never letter by letter); its
     ink starts at x and is never wider than maxW */
  function tcPlain(ctx, text, o, color) {
    var size = o.size, m;
    function measure() { ctx.font = Math.round(size * 100) / 100 + 'px ' + o.font; m = ctx.measureText(text); }
    measure();
    var w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    if (o.maxW && w > o.maxW) { size = size * o.maxW / w; measure(); }
    ctx.save();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = color;
    ctx.fillText(text, o.x + m.actualBoundingBoxLeft, o.y);
    ctx.restore();
  }

  /* the card at S times the mock-up's size, with the trader's choices (o: cardOpts) */
  function drawTradeCard(t, S, o) {
    var look = tcLook(o.look), pal = t.win ? look.win : look.loss, ink = look.ink;
    var cv = document.createElement('canvas');
    cv.width = Math.round(TC_W * S); cv.height = Math.round(TC_H * S);
    var ctx = cv.getContext('2d');
    ctx.scale(S, S);
    tcBack(ctx, look, t);
    tcWordmark(ctx, ink);
    tcText(ctx, 'confetti.trade', { font: TC_SMALL, size: 29.5, x: 1640, y: 46.5, align: 'right', ls: -0.2 }, ink);
    tcLevel(ctx, t.level, look);
    tcIcon(ctx, pal, S, look.c);

    /* left: the signed percent, then Initial and Profit / Loss (his card). A line switched off is not there, the next one
       moves up into its place, and the block drops half of what went so it stays on the icon's middle */
    var lines = [];
    if (o.amount) lines.push(cardMoney(t.margin) + ' Initial');
    if (o.result === 'both') lines.push(cardMoney(t.pnl) + (t.win ? ' Profit' : ' Loss'));
    var dy = (2 - lines.length) * 31;
    tcPercent(ctx, t, pal, 440.5 + dy, o.result === 'usd');
    lines.forEach(function (s, i) { tcText(ctx, s, { font: TC_SMALL, size: 44.5, x: 113, y: 517.5 + dy + i * 62, maxW: 540 }, ink); });

    /* right: COIN/SIDE over the leverage, right-aligned */
    tcCoin(ctx, t.sym, t.sideWord || (t.long ? 'LONG' : 'SHORT'), pal);
    /* the boost the trade ran at, as its card and its end screen said it: a whole number as it is, one that money added
       to the trade left in between to two places ("6.67X", never rounded up to a boost the trade did not have) */
    tcText(ctx, cardLev(t.lev) + 'X', { font: TC_BIG, size: 138, x: 1630, y: 781.5, align: 'right', ls: 7.5, sx: TC_SX, maxW: 700 }, pal.ink);

    /* bottom left: the QR code, the short address beside its foot, and the trader's own line over the address (on the
       address's line when that is off); bottom right: the three lines */
    var qr = tcQr(ctx, t.link, S), addr = o.addr ? t.addr : '';
    if (addr) tcText(ctx, addr, { font: TC_SMALL, size: 35, x: 209, y: 906.5, ls: 4.7 }, ink);
    if (o.caption) tcPlain(ctx, o.caption, { font: TC_SMALL, size: 40, x: 210, y: addr ? 850.5 : 906.5, maxW: 760 }, ink);
    (t.lines || ['Perp Trading', 'Up to 1000x leverage', 'Fully onchain on hyperliquid']).forEach(function (s, i) {
      tcText(ctx, s, { font: TC_SMALL, size: 24.4, x: 1645, y: [855.5, 883.5, 912.5][i], align: 'right', ls: 0.9 }, ink);
    });
    cv.qr = qr;
    return cv;
  }

  function cardLev(lev) { var n = Number(lev); return isFinite(n) && n > 0 ? String(Math.round(n * 100) / 100) : '—'; }
  function cardName(t) { return 'confetti-' + t.sym.toLowerCase().replace(/[^a-z0-9]+/g, '') + '-' + (t.sideWord ? t.sideWord.toLowerCase().replace(/[^a-z0-9]+/g, '') : t.long ? 'long' : 'short') + '-' + cardLev(t.lev).replace('.', '_') + 'x.png'; }

  /* the card as a PNG file (2x), with what it was drawn from; a preview canvas of any width comes from drawCardInto.
     text: the only words that go with the picture, the trader's own caption (or none) */
  function tradeCard(raw, opts) {
    var t, o = cardOpts(opts);
    try { t = cardTrade(raw); } catch (e) { return Promise.reject(e); }
    return cardReady().then(function () {
      var cv = drawTradeCard(t, TC_SCALE, o);
      return new Promise(function (ok, no) {
        cv.toBlob(function (b) {
          if (!b) { no(new Error('no image')); return; }
          var name = cardName(t), file = null;
          try { file = new File([b], name, { type: 'image/png' }); } catch (e) { file = null; }
          ok({ canvas: cv, blob: b, file: file, name: name, link: t.link, win: t.win, trade: t, opts: o, text: o.caption });
        }, 'image/png');
      });
    });
  }

  /* the card drawn straight onto a canvas on the page, crisp at its own size (CSS width x device pixels). live: asked just
     before the canvas is touched; false leaves it as it is (the sheet moved on to another trade) */
  function cardInto(canvas, t, cssW, o, live) {
    return cardReady().then(function () {
      if (live && !live()) return t;
      var dpr = Math.min(3, window.devicePixelRatio || 1), S = Math.max(0.2, cssW * dpr / TC_W);
      var src = drawTradeCard(t, S, o);
      canvas.width = src.width; canvas.height = src.height;
      canvas.getContext('2d').drawImage(src, 0, 0);
      return t;
    });
  }
  function drawCardInto(canvas, raw, cssW, opts) { return cardInto(canvas, cardTrade(raw), cssW, cardOpts(opts)); }
  /* the card's place while its trade is being read: the card's own shapes, flat on sunk paper (the wordmark, the figure and
     its two lines, the icon, the coin and the boost, the QR code and the address, the three small lines), so what comes is
     no surprise. Nothing moves */
  var TC_HOLD = [[55, 46, 330, 62, 10], [66, 318, 470, 124, 14], [113, 484, 330, 36, 8], [113, 546, 290, 36, 8], [687, 318, 300, 300, 66],
    [1130, 556, 500, 104, 14], [1370, 684, 260, 98, 14], [30, 748, 160, 160, 10], [209, 880, 290, 28, 8], [1330, 858, 310, 56, 8]];
  function cardHold(canvas, cssW) {
    var dpr = Math.min(3, window.devicePixelRatio || 1), S = Math.max(0.2, cssW * dpr / TC_W);
    canvas.width = Math.round(TC_W * S); canvas.height = Math.round(TC_H * S);
    var ctx = canvas.getContext('2d');
    ctx.scale(S, S);
    ctx.fillStyle = '#e8dec8'; ctx.fillRect(0, 0, TC_W, TC_H);
    ctx.fillStyle = 'rgba(42, 37, 32, 0.09)';
    TC_HOLD.forEach(function (b) { roundRect(ctx, b[0], b[1], b[0] + b[2], b[1] + b[3], b[4]); ctx.fill(); });
  }

  /* does this browser hand a picture to a share sheet? (the key says Share where it does, Save where it cannot) */
  function cardCanShare() {
    try {
      var f = new File([new Blob(['x'], { type: 'image/png' })], 'card.png', { type: 'image/png' });
      return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [f] }));
    } catch (e) { return false; }
  }

  /* Share the PNG: the phone's share sheet with the file where the browser can, otherwise a download. Called from the tap
     itself with a file made before it (a share sheet needs the tap's own moment). The card's caption goes with it as the
     share's words where the browser takes words with a file; nothing else does. Resolves 'shared', 'saved' or 'cancelled'. */
  function shareCardFile(card) {
    var file = card && card.file;
    var data = file ? { files: [file] } : null;
    var can = false;
    try { can = !!(data && navigator.canShare && navigator.canShare(data) && navigator.share); } catch (e) { can = false; }
    if (can && card.text) {
      var withText = { files: [file], text: card.text };
      try { if (navigator.canShare(withText)) data = withText; } catch (e) { /* the picture alone */ }
    }
    if (can) {
      return navigator.share(data).then(function () { return 'shared'; }, function (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
        saveBlob(card.blob, card.name); return 'saved';
      });
    }
    saveBlob(card.blob, card.name);
    return Promise.resolve('saved');
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

  /* the card in words, for a screen reader: only what the card shows (never the address) */
  function altOf(t, o) {
    var sign = t.pnl > 0.004 ? '+' : t.pnl < -0.004 ? '−' : '', r = t.pnl / t.margin;
    var says = [t.sym + (t.sideWord ? ' ' + t.sideWord.toLowerCase() + ' ' : t.long ? ' up ' : ' down ') + cardLev(t.lev) + '×'];
    if (o.result !== 'usd') says.push((r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r * 100).toFixed(1) + '%');
    if (o.result !== 'pct') says.push(sign + cardMoney(t.pnl));
    if (o.amount) says.push(cardMoney(t.margin) + ' in');
    return 'Your trade card: ' + says.join(', ') + '.';
  }
  function cardAlt(raw, opts) { try { return altOf(cardTrade(raw), cardOpts(opts)); } catch (e) { return 'Your trade card.'; } }

  /* ---- the sheet: Share your trade. One sheet for every Share on every page, in the Simple look whatever the page wears:
     the colours, the keys and the type are all set here on the dialog itself, so nothing of the page's own theme reaches in.
     Four ways out (swipe down, the cross, a tap outside, Esc / the phone's back). On a phone it rises from the bottom; on a
     wide screen it is a panel on the right, under the top bar. The trader's choices are kept on this device for each wallet
     (cardPrefs); the caption belongs to one trade and is not kept. What is switched off is not on the card, not in the PNG
     and not in what a screen reader hears. The PNG is made as the choices settle: a share sheet has to open in the tap's own
     moment. A trade that is still being read (a Promise): the sheet is up at once with the card's place held, the choices
     waiting and the key saying so; a trade that could not be read says so and the key closes. ---- */

  var PCS_CSS = [
    '@media screen {',
    '  dialog.pcs-sheet {',
    '    --pcs-page: #f4ecd8; --pcs-raised: #faf6ed; --pcs-sunken: #e8dec8; --pcs-ink: #2a2520; --pcs-muted: #5f564b; --pcs-faint: #7a7060;',
    '    --pcs-rule: #d4cbba; --pcs-rule-strong: #b8ad92; --pcs-accent: #8b2020; --pcs-rim: #8a7f66; --pcs-rim-ink: #0f0d0b;',
    '    --pcs-shade: rgba(42, 37, 32, 0.42); --pcs-hi: rgba(255, 255, 255, 0.9); --pcs-focus: 0 0 0 2px #f4ecd8, 0 0 0 4px #8b2020; --pcs-pad: 16px;',
    '    position: fixed; inset: auto 0 0 0; box-sizing: border-box; margin: 0; width: 100%; max-width: none; max-height: 90vh; max-height: 90dvh;',
    '    padding: 0; border: 0; border-top: 1px solid var(--pcs-rule-strong); background: var(--pcs-raised); color: var(--pcs-ink);',
    '    overflow: hidden; transform: translateY(var(--pcs-drag, 0px));',
    '    font-family: var(--font-ui, "Soehne", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);',
    '    font-size: 17px; font-weight: 400; font-style: normal; line-height: 1.4; letter-spacing: normal; text-transform: none; text-align: start;',
    '    font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1, "ss01" 1; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;',
    '    text-rendering: optimizeLegibility; -webkit-tap-highlight-color: transparent; color-scheme: light;',
    '  }',
    '  dialog.pcs-sheet *, dialog.pcs-sheet *::before, dialog.pcs-sheet *::after { box-sizing: border-box; }',
    '  dialog.pcs-sheet [hidden] { display: none !important; }',
    '  dialog.pcs-sheet[open] { display: flex; flex-direction: column; animation: pcs-in 220ms ease-out; }',
    '  dialog.pcs-sheet.is-out { animation: pcs-out 180ms ease-in forwards; }',
    /* closed: the slide away is no longer modal and takes no taps; its shade goes with it */
    '  dialog.pcs-sheet.is-out.is-gone { z-index: 45; pointer-events: none; animation: pcs-out 180ms ease-in forwards, pcs-shade 180ms ease-in forwards; }',
    '  dialog.pcs-sheet.is-gone * { pointer-events: none; }',
    '  @keyframes pcs-shade { from { box-shadow: 0 0 0 100vmax rgba(42, 37, 32, 0.45); } to { box-shadow: 0 0 0 100vmax rgba(42, 37, 32, 0); } }',
    '  dialog.pcs-sheet::backdrop { background: rgba(42, 37, 32, 0.45); }',
    '  dialog.pcs-sheet[open]::backdrop { animation: pcs-fade 220ms ease-out; }',
    '  dialog.pcs-sheet.is-out::backdrop { animation: pcs-fade 180ms ease-in reverse forwards; }',
    '  @keyframes pcs-in { from { transform: translateY(100%); } } @keyframes pcs-out { to { transform: translateY(100%); } }',
    '  @keyframes pcs-fade { from { opacity: 0; } }',
    '  @keyframes pcs-slide-in { from { transform: translateX(100%); } }',

    /* the head: the grab handle, the title, the cross */
    '  dialog.pcs-sheet .pcs-head { flex: none; position: relative; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 60px; padding: 16px 4px 0 var(--pcs-pad); touch-action: none; }',
    '  dialog.pcs-sheet .pcs-head::before { content: ""; position: absolute; left: 50%; top: 8px; width: 40px; height: 5px; margin-left: -20px; border-radius: 3px; background: var(--pcs-rule-strong); }',
    '  dialog.pcs-sheet .pcs-head h2 {',
    '    display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; font-family: var(--font-display, var(--font-ui, "Soehne", system-ui, sans-serif));',
    '    font-size: 22px; font-weight: 600; line-height: 1.2; letter-spacing: -0.01em; color: var(--pcs-ink); outline: none; box-shadow: none;',
    '  }',

    /* every key: a rounded edge, a darker rim, a solid lip under it, a soft shadow on the paper; a press sinks it onto the lip */
    '  dialog.pcs-sheet button {',
    '    -webkit-appearance: none; appearance: none; margin: 0; padding: 0; font: inherit; cursor: pointer; touch-action: manipulation;',
    '    background: var(--pk-face, var(--pcs-raised)); color: var(--pk-ink, var(--pcs-ink));',
    '    border: 1px solid var(--pk-rim, var(--pcs-rim)); border-radius: var(--pk-r, 10px);',
    '    box-shadow: 0 var(--pk-now, var(--pk-lip, 3px)) 0 var(--pk-rim, var(--pcs-rim)), 0 calc(var(--pk-now, var(--pk-lip, 3px)) + 5px) var(--pk-blur, 10px) -5px var(--pk-shade, var(--pcs-shade)),',
    '                inset 0 1px 0 var(--pk-hi, var(--pcs-hi)), inset 0 -1px 0 var(--pk-lo, transparent);',
    '    text-decoration: none; transition: transform 80ms ease-out, box-shadow 80ms ease-out, background-color 80ms ease-out;',
    '    -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none;',
    '  }',
    '  dialog.pcs-sheet button:active { --pk-now: 1px; transform: translateY(calc(var(--pk-lip, 3px) - 1px)); filter: none; }',
    '  dialog.pcs-sheet button:focus-visible { outline: none; box-shadow: var(--pcs-focus), 0 var(--pk-now, var(--pk-lip, 3px)) 0 var(--pk-rim, var(--pcs-rim)), inset 0 1px 0 var(--pk-hi, var(--pcs-hi)); }',
    /* selected: pressed in and staying in */
    '  dialog.pcs-sheet button[aria-pressed="true"] {',
    '    background: var(--pcs-sunken); color: var(--pcs-ink); border-color: var(--pcs-ink);',
    '    box-shadow: inset 0 0 0 1px var(--pcs-ink), inset 0 3px 4px rgba(42, 37, 32, 0.22), 0 1px 0 var(--pcs-hi); transform: translateY(var(--pk-lip, 3px));',
    '  }',
    '  dialog.pcs-sheet button[aria-pressed="true"]:focus-visible { box-shadow: var(--pcs-focus), inset 0 0 0 1px var(--pcs-ink), inset 0 3px 4px rgba(42, 37, 32, 0.22); }',
    /* disabled and busy: no lip, no shadow: nothing looks pressable that is not; a busy key stays down until it is done */
    '  dialog.pcs-sheet button[disabled], dialog.pcs-sheet button.is-busy { box-shadow: none; transform: none; cursor: default; }',
    '  dialog.pcs-sheet button.is-busy { transform: translateY(var(--pk-lip, 3px)); }',
    /* close: a small square key, its target 46 px */
    '  dialog.pcs-sheet .pcs-x { --pk-lip: 2px; flex: none; position: relative; display: grid; place-items: center; width: 40px; height: 40px; margin-right: 12px; font-size: 17px; font-weight: 600; }',
    '  dialog.pcs-sheet .pcs-x::after { content: ""; position: absolute; inset: -3px; }',

    /* the card stays in view over the choices while they scroll (a short phone) */
    '  dialog.pcs-sheet .pcs-pv { flex: none; display: flex; justify-content: center; align-items: flex-start; padding: 2px var(--pcs-pad) 14px; border-bottom: 1px solid var(--pcs-rule); }',
    '  dialog.pcs-sheet .pcs-pv canvas {',
    '    display: block; flex: none; width: 100%; height: auto; aspect-ratio: 1672 / 941; border-radius: 8px; background: #f9edcf;',
    '    box-shadow: 0 0 0 1px var(--pcs-rim), 0 10px 18px -10px rgba(42, 37, 32, 0.55); opacity: 0; transition: opacity 160ms ease-out;',
    '  }',
    '  dialog.pcs-sheet .pcs-pv.is-in canvas { opacity: 1; }',
    /* a trade still being read: the card's place is held, flat */
    '  dialog.pcs-sheet .pcs-pv.is-wait canvas { opacity: 1; background: var(--pcs-sunken); transition: none; }',

    '  dialog.pcs-sheet .pcs-body { flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 0 var(--pcs-pad) 12px; }',
    '  dialog.pcs-sheet .pcs-g { margin-top: 12px; }',
    /* a group's name: one height, with or without the words at its right: nothing shifts when they come */
    '  dialog.pcs-sheet .pcs-label { display: flex; align-items: center; height: 20px; margin: 0 0 7px; font-size: 13px; font-weight: 500; line-height: 1.3; letter-spacing: 0.06em; text-transform: uppercase; color: var(--pcs-muted); }',
    '  dialog.pcs-sheet .pcs-label.is-row { justify-content: space-between; gap: 12px; }',
    '  dialog.pcs-sheet .pcs-hint { font-size: 14px; font-weight: 500; line-height: 20px; letter-spacing: normal; text-transform: none; color: var(--pcs-muted); }',
    /* beside Result: said in ink, it is about what the card gives away */
    '  dialog.pcs-sheet .pcs-hint.is-ink { color: var(--pcs-ink); white-space: nowrap; }',

    /* the two switches: a switch that is on is not a key pressed in: it stays up, and its track says on */
    '  dialog.pcs-sheet .pcs-sws { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding-bottom: 3px; }',
    '  dialog.pcs-sheet .pcs-sw { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; min-height: 48px; padding: 0 10px 0 14px; font-size: 16px; font-weight: 600; text-align: left; }',
    '  dialog.pcs-sheet .pcs-sw > span { min-width: 0; white-space: nowrap; }',
    '  dialog.pcs-sheet .pcs-tog { flex: none; position: relative; width: 44px; height: 26px; border-radius: 13px; background: var(--pcs-sunken); box-shadow: inset 0 0 0 1px var(--pcs-rim), inset 0 2px 3px rgba(42, 37, 32, 0.18); transition: background-color 160ms ease-out; }',
    '  dialog.pcs-sheet .pcs-tog::after { content: ""; position: absolute; left: 3px; top: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--pcs-raised); box-shadow: 0 0 0 1px var(--pcs-rim), 0 1px 2px rgba(42, 37, 32, 0.35); transition: transform 160ms ease-out; }',
    '  dialog.pcs-sheet .pcs-sw[aria-checked="true"] .pcs-tog { background: var(--pcs-ink); box-shadow: inset 0 0 0 1px var(--pcs-rim-ink); }',
    '  dialog.pcs-sheet .pcs-sw[aria-checked="true"] .pcs-tog::after { transform: translateX(18px); box-shadow: 0 0 0 1px var(--pcs-rim-ink), 0 1px 2px rgba(0, 0, 0, 0.4); }',
    '  dialog.pcs-sheet .pcs-sw[disabled] { opacity: 0.45; }',

    /* the result: three keys, the chosen one pressed in */
    '  dialog.pcs-sheet .pcs-seg { display: flex; gap: 11px 8px; margin: 8px 0 3px; }',
    '  dialog.pcs-sheet .pcs-seg button { flex: 1; height: 44px; font-size: 16px; font-weight: 600; }',
    '  dialog.pcs-sheet .pcs-seg button[aria-pressed="true"] { font-weight: 700; }',
    '  dialog.pcs-sheet .pcs-seg button[disabled] { opacity: 0.45; }',

    /* the looks: four small cards */
    '  dialog.pcs-sheet .pcs-looks { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding-bottom: 3px; }',
    '  dialog.pcs-sheet .pcs-look { display: flex; flex-direction: column; align-items: stretch; gap: 5px; min-width: 0; min-height: 64px; padding: 5px 5px 6px; font-size: 13px; font-weight: 600; line-height: 1.2; text-align: center; }',
    '  dialog.pcs-sheet .pcs-look canvas { display: block; width: 100%; height: auto; aspect-ratio: 1672 / 941; border-radius: 5px; background: var(--pcs-sunken); box-shadow: 0 0 0 1px rgba(42, 37, 32, 0.28); }',
    '  dialog.pcs-sheet .pcs-look > span { white-space: nowrap; }',
    '  dialog.pcs-sheet .pcs-look[disabled] { opacity: 0.45; }',

    /* the caption: a field sunk into the paper (keys stand up, fields sink in); 16 px on a phone so iPhones do not zoom */
    '  dialog.pcs-sheet .pcs-cap {',
    '    display: block; width: 100%; height: 48px; margin: 0; padding: 0 14px; border: 0; border-radius: 10px; background: var(--pcs-raised); color: var(--pcs-ink);',
    '    font: inherit; font-size: 17px; outline: none; caret-color: var(--pcs-accent);',
    '    box-shadow: inset 0 0 0 1px var(--pcs-rim), inset 0 3px 5px rgba(42, 37, 32, 0.16);',
    '  }',
    '  dialog.pcs-sheet .pcs-cap::placeholder { color: var(--pcs-faint); }',
    '  dialog.pcs-sheet .pcs-cap:focus, dialog.pcs-sheet .pcs-cap:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--pcs-ink), inset 0 3px 5px rgba(42, 37, 32, 0.16); }',
    '  dialog.pcs-sheet .pcs-cap[disabled] { opacity: 0.45; }',
    '  @media (max-width: 640px) { dialog.pcs-sheet .pcs-cap { font-size: 16px; } }',

    /* the foot: the one black key (the main step: the strongest key on the sheet), its brackets, room under it for its lip */
    '  dialog.pcs-sheet .pcs-foot { flex: none; position: relative; display: grid; gap: 12px; padding: 8px var(--pcs-pad) calc(12px + env(safe-area-inset-bottom) + var(--pcs-kb, 0px)); background: var(--pcs-raised); }',
    '  dialog.pcs-sheet .pcs-go {',
    '    --pk-r: 12px; --pk-lip: 4px; --pk-face: var(--pcs-ink); --pk-rim: var(--pcs-rim-ink); --pk-ink: var(--pcs-page);',
    '    --pk-hi: rgba(255, 255, 255, 0.16); --pk-lo: rgba(255, 255, 255, 0.16); --pk-shade: rgba(20, 17, 14, 0.62); --pk-blur: 14px;',
    '    display: flex; align-items: center; justify-content: center; width: 100%; height: 56px; padding: 0 12px; font-size: 18px; font-weight: 600; line-height: 1.15; text-align: center;',
    '  }',
    '  dialog.pcs-sheet .pcs-go::before { content: "[\\00a0"; opacity: 0.55; } dialog.pcs-sheet .pcs-go::after { content: "\\00a0]"; opacity: 0.55; }',
    '  dialog.pcs-sheet .pcs-go[disabled] { opacity: 0.5; }',
    '  dialog.pcs-sheet .pcs-go.is-busy { --pk-face: var(--pcs-muted); --pk-rim: var(--pcs-muted); opacity: 1; }',
    /* what the key did (saved, and under which name), said over the choices' foot for a few seconds: nothing moves for it */
    '  dialog.pcs-sheet .pcs-note {',
    '    position: absolute; left: var(--pcs-pad); right: var(--pcs-pad); bottom: 100%; z-index: 2; margin: 0 0 4px; padding: 11px 14px; border-radius: 10px;',
    '    background: var(--pcs-ink); color: var(--pcs-page); font-size: 15px; line-height: 1.35; overflow-wrap: anywhere;',
    '    box-shadow: 0 8px 16px -8px rgba(20, 17, 14, 0.6); animation: pcs-fade 180ms ease-out;',
    '  }',
    '  dialog.pcs-sheet .pcs-note:empty { display: none; }',
    /* a short phone: more choices wait under the fold, and the foot's edge says so */
    '  dialog.pcs-sheet .pcs-foot::before { content: ""; position: absolute; left: 0; right: 0; bottom: 100%; height: 20px; pointer-events: none; background: linear-gradient(rgba(250, 246, 237, 0), var(--pcs-raised)); opacity: 0; transition: opacity 160ms ease-out; }',
    '  dialog.pcs-sheet.has-more .pcs-foot::before { opacity: 1; }',

    /* typing the caption on a phone: the keyboard takes half the screen, so the sheet may use all that is left, the other
       choices wait, and the card takes what room there is over the line being typed and the key */
    '  dialog.pcs-sheet.is-kb { height: 90vh; height: 90dvh; max-height: 100vh; max-height: 100dvh; }',
    '  dialog.pcs-sheet.is-kb .pcs-g:not(.is-cap) { display: none; }',
    '  dialog.pcs-sheet.is-kb .pcs-body { flex: none; overflow: visible; }',
    '  dialog.pcs-sheet.is-kb .pcs-pv { flex: 1 1 0; min-height: 0; overflow: hidden; container-type: size; }',
    '  dialog.pcs-sheet.is-kb .pcs-pv canvas { width: min(100cqw, 100cqh * 1672 / 941); }',
    '  @media (max-height: 700px) { dialog.pcs-sheet.is-kb { height: 100vh; height: 100dvh; } }',

    '  @media (max-width: 374px) {',
    '    dialog.pcs-sheet .pcs-sw { padding: 0 8px 0 10px; font-size: 15px; }',
    '    dialog.pcs-sheet .pcs-seg button { font-size: 15px; }',
    '    dialog.pcs-sheet .pcs-look { padding: 4px 4px 5px; font-size: 12px; }',
    '  }',
    /* a phone under 820 px tall: the same sheet a little closer together, so everything is in view without a scroll from
       360 x 780 up (shorter phones scroll the choices under the card) */
    '  @media (max-height: 820px) {',
    '    dialog.pcs-sheet .pcs-pv { padding-bottom: 12px; }',
    '    dialog.pcs-sheet .pcs-body { padding-bottom: 10px; }',
    '    dialog.pcs-sheet .pcs-g { margin-top: 10px; }',
    '    dialog.pcs-sheet .pcs-label { margin-bottom: 6px; }',
    '    dialog.pcs-sheet .pcs-sw { min-height: 44px; }',
    '    dialog.pcs-sheet .pcs-look { gap: 4px; padding-bottom: 5px; }',
    '  }',
    /* a wide screen: a panel on the right, from under the bars the page keeps pinned to the top of the window to the bottom
       (--pcs-top; on the trade page that is the end panel's own place and width, so there is one panel there and not a
       sheet over the lower half of another; a page that pins no bar gets the whole height). No grab handle: nothing to pull */
    '  @media (min-width: 641px) {',
    '    dialog.pcs-sheet { left: auto; right: 0; top: var(--pcs-top, 64px); width: 380px; height: auto; max-height: none; border-top: 0; border-left: 1px solid var(--pcs-rule-strong); border-radius: 0; }',
    '    dialog.pcs-sheet[open] { animation: pcs-slide-in 200ms ease-out; }',
    '    dialog.pcs-sheet .pcs-head { min-height: 64px; padding-top: 8px; }',
    '    dialog.pcs-sheet .pcs-head::before { content: none; }',
    '    dialog.pcs-sheet .pcs-foot { padding-bottom: 16px; }',
    '  }',
    '  @media (min-width: 641px) and (max-width: 1023px) { dialog.pcs-sheet { width: 340px; } }',
    '  @media (min-width: 1280px) { dialog.pcs-sheet { width: 400px; } }',
    /* a mouse over a key lifts it a hair (a wide screen only: on a touch screen hover sticks) */
    '  @media (hover: hover) and (min-width: 641px) {',
    '    dialog.pcs-sheet button:not([disabled], .is-busy, [aria-pressed="true"], [aria-checked="true"]):hover:not(:active) { --pk-now: calc(var(--pk-lip, 3px) + 1px); transform: translateY(-1px); }',
    '  }',
    '  @media (prefers-reduced-motion: reduce) {',
    '    dialog.pcs-sheet[open], dialog.pcs-sheet.is-out, dialog.pcs-sheet.is-out.is-gone, dialog.pcs-sheet[open]::backdrop, dialog.pcs-sheet.is-out::backdrop, dialog.pcs-sheet .pcs-note { animation: none; }',
    '    dialog.pcs-sheet .pcs-pv canvas, dialog.pcs-sheet .pcs-tog, dialog.pcs-sheet .pcs-tog::after, dialog.pcs-sheet .pcs-foot::before { transition: none; }',
    '  }',
    '}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('pcsStyle')) return;
    var st = document.createElement('style');
    st.id = 'pcsStyle';
    st.textContent = PCS_CSS;
    document.head.appendChild(st);
  }

  function node(tag, cls, kids) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    (kids == null ? [] : Array.isArray(kids) ? kids : [kids]).forEach(function (k) { n.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k))); });
    return n;
  }
  function keyNode(cls, kids, fn) { var b = node('button', cls, kids); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; }
  function setText(n, s) { if (n.textContent !== s) n.textContent = s; }
  function eachKid(n, fn) { Array.prototype.forEach.call(n.children, fn); }
  function reducedMotion() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function nothing() {}

  /* state: 'wait' (the trade is being read), 'ready', 'err'. key: which trade this is (its caption goes by it). o / okey:
     the choices of the wallet whose card is up. auto: the result went to the percent by itself when the amount went off.
     sig / card / p: the PNG as last made, and the one being made */
  var SH = { d: null, R: null, isOpen: false, outT: 0, ctl: null, host: null, gen: 0, state: 'wait', raw: null, t: null, key: '', acct: '',
    o: null, okey: null, auto: false, caps: {}, sig: '', card: null, p: null, makeT: 0, raf: 0, said: '', sayT: 0, can: null };
  var READ_FAIL = 'This trade could not be read just now. Try again in a moment.';

  function sheetBuild() {
    if (SH.d) return SH.R;
    injectCss();
    var R = SH.R = {}, d = SH.d = node('dialog', 'pcs-sheet');
    R.title = node('h2', null, 'Share your trade'); R.title.id = 'pcsTitle'; R.title.tabIndex = -1;
    d.setAttribute('aria-labelledby', 'pcsTitle');
    var x = keyNode('pcs-x', '✕', function () { sheetClose(); }); x.setAttribute('aria-label', 'Close');
    R.head = node('div', 'pcs-head', [R.title, x]);
    R.cv = node('canvas'); R.cv.setAttribute('role', 'img');
    R.pv = node('div', 'pcs-pv', R.cv);
    R.body = node('div', 'pcs-body');
    R.foot = node('div', 'pcs-foot');

    var sw = function (label, k, says) {
      var b = keyNode('pcs-sw', [node('span', null, label), node('i', 'pcs-tog')], function () { sheetSet(k, b.getAttribute('aria-checked') !== 'true'); });
      b.setAttribute('role', 'switch'); b.setAttribute('aria-label', says);
      return b;
    };
    R.addr = sw('Address', 'addr', 'Address: your wallet address on the card');
    R.amount = sw('Amount in', 'amount', 'Amount in: what you put in, on the card');
    R.res = node('div', 'pcs-seg'); R.res.setAttribute('role', 'group'); R.res.setAttribute('aria-label', 'Show the result as');
    [['both', 'Both'], ['pct', 'Percent'], ['usd', 'Dollars']].forEach(function (x) {
      var b = keyNode(null, x[1], function () { SH.auto = false; sheetSet('result', x[0]); });
      b._v = x[0]; R.res.appendChild(b);
    });
    R.looks = node('div', 'pcs-looks'); R.looks.setAttribute('role', 'group'); R.looks.setAttribute('aria-label', 'Look');
    TC_LOOKS.forEach(function (l) {
      var cv = node('canvas'); cv.setAttribute('aria-hidden', 'true');
      var b = keyNode('pcs-look', [cv, node('span', null, l.name)], function () { sheetSet('look', l.id); });
      b._v = l.id; b._cv = cv; R.looks.appendChild(b);
    });
    R.cap = node('input', 'pcs-cap'); R.cap.type = 'text'; R.cap.id = 'pcsCap'; R.cap.maxLength = TC_CAP_MAX; R.cap.placeholder = 'Add a line of your own';
    R.cap.setAttribute('enterkeyhint', 'done'); R.cap.setAttribute('autocomplete', 'off'); R.cap.setAttribute('autocapitalize', 'sentences');
    R.cap.addEventListener('input', function () { if (SH.state !== 'ready') return; SH.caps[SH.key] = R.cap.value; sheetChanged(true); });
    R.cap.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); R.cap.blur(); } });
    R.cap.addEventListener('focus', function () { setTimeout(function () { sheetKbFit(); sheetKb(); }, 0); });
    R.cap.addEventListener('blur', sheetKb);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { if (SH.isOpen) { sheetKbFit(); sheetKb(); } });
      window.visualViewport.addEventListener('scroll', function () { if (SH.isOpen) sheetKbFit(); });
    }
    var capLab = node('label', 'pcs-label is-row', ['Caption', node('span', 'pcs-hint', 'Optional')]); capLab.htmlFor = 'pcsCap';
    R.hint = node('span', 'pcs-hint is-ink', '');
    [node('div', 'pcs-g', [node('div', 'pcs-label', 'Show on the card'), node('div', 'pcs-sws', [R.addr, R.amount])]),
      node('div', 'pcs-g', [node('div', 'pcs-label is-row', ['Result', R.hint]), R.res]),
      node('div', 'pcs-g', [node('div', 'pcs-label', 'Look'), R.looks]),
      node('div', 'pcs-g is-cap', [capLab, R.cap])].forEach(function (g) { R.body.appendChild(g); });
    R.say = node('p', 'pcs-note', ''); R.say.setAttribute('aria-live', 'polite');
    R.go = keyNode('pcs-go', '', sheetGo);
    R.foot.appendChild(R.say); R.foot.appendChild(R.go);
    [R.head, R.pv, R.body, R.foot].forEach(function (n) { d.appendChild(n); });
    document.body.appendChild(d);

    R.body.addEventListener('scroll', sheetMore, { passive: true });
    d.addEventListener('cancel', function (ev) { ev.preventDefault(); sheetClose(); });
    d.addEventListener('click', function (ev) { if (ev.target === d) sheetClose(); });
    /* swipe down on the head: past 90 px, or a quick flick, closes */
    var y0 = null, dy = 0, t0 = 0, head = R.head;
    head.addEventListener('pointerdown', function (ev) { if (ev.target.closest('button')) return; y0 = ev.clientY; dy = 0; t0 = Date.now(); try { head.setPointerCapture(ev.pointerId); } catch (e) { /* fine */ } });
    head.addEventListener('pointermove', function (ev) { if (y0 == null) return; dy = Math.max(0, ev.clientY - y0); d.style.setProperty('--pcs-drag', dy + 'px'); });
    var up = function () { if (y0 == null) return; var fast = dy > 24 && dy / Math.max(1, Date.now() - t0) > 0.5; y0 = null; if (dy > 90 || fast) sheetClose(); else d.style.removeProperty('--pcs-drag'); };
    head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
    SH.ctl = { dialog: d, close: sheetClose };
    return R;
  }

  /* -- on a page without sheets of its own: the phone's back closes the sheet (one history entry while it is up), and a second
     tap on the spot that closed it (a double tap on ✕ or outside it) is the same tap, not a press on the page under it -- */
  var OWN = { bound: false, entry: false, skip: 0, ptr: null, shut: null };
  function ownBind() {
    if (OWN.bound) return;
    OWN.bound = true;
    window.addEventListener('popstate', function () {
      if (OWN.skip > 0) { OWN.skip--; return; }
      if (OWN.entry) { OWN.entry = false; sheetClose(true); }
    });
    document.addEventListener('pointerdown', function (ev) { OWN.ptr = { x: ev.clientX, y: ev.clientY, t: Date.now() }; }, true);
    document.addEventListener('click', function (ev) {
      var s = OWN.shut; if (!s) return;
      OWN.shut = null;
      if (Date.now() - s.t < 450 && Math.abs(ev.clientX - s.x) < 32 && Math.abs(ev.clientY - s.y) < 32) { ev.preventDefault(); ev.stopPropagation(); }
    }, true);
  }
  function ownOpened() {
    ownBind();
    try { history.pushState({ pcs: 1 }, ''); OWN.entry = true; } catch (e) { OWN.entry = false; }
  }
  function ownClosed(fromBack) {
    if (fromBack) return;
    if (OWN.entry) { OWN.entry = false; OWN.skip++; try { history.back(); } catch (e) { OWN.skip--; } }
    var p = OWN.ptr; if (p && Date.now() - p.t < 700) OWN.shut = { x: p.x, y: p.y, t: Date.now() };
  }

  function sheetShut() {
    var d = SH.d;
    clearTimeout(SH.outT); SH.outT = 0; d.classList.remove('is-out', 'is-gone'); d.inert = false;
    try { d.close(); } catch (e) { d.removeAttribute('open'); }
  }
  /* where the page's own pinned bars end (a wide screen's panel starts there): the full-width bars stacked at the top of the
     window that stay there when the page scrolls (Simple's top bar: 64 px); 0 where the page pins none */
  function pinnedTop() {
    var y = 0, w = window.innerWidth;
    for (var i = 0; i < 3; i++) {
      var n = document.elementFromPoint(w / 2, y + 1), bar = null, stays = false;
      for (; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        var r = n.getBoundingClientRect(), p = getComputedStyle(n).position;
        if (Math.abs(r.top - y) <= 1 && r.width >= w * 0.9 && r.bottom - y >= 24 && r.bottom <= 160) bar = r;
        if (p === 'fixed' || p === 'sticky') stays = true;
      }
      if (!bar || !stays) break;
      y = Math.round(bar.bottom);
    }
    return y;
  }
  function sheetShow() {
    var d = SH.d, R = SH.R;
    if (SH.outT || d.open) sheetShut();      /* opened again while it was still sliding away */
    SH.isOpen = true; d.style.removeProperty('--pcs-drag'); d.style.setProperty('--pcs-top', pinnedTop() + 'px');
    try { d.showModal(); } catch (e) { d.setAttribute('open', ''); }
    try { R.title.focus({ preventScroll: true }); } catch (e) { /* fine */ }
    if (SH.host && SH.host.opened) SH.host.opened(SH.ctl); else ownOpened();
    R.body.scrollTop = 0; sheetKbFit();
  }
  /* Closed is closed at once: the page takes the next tap, and what closing does runs now. The slide away is only a picture:
     no longer modal, and no taps. fromBack: the phone's back (or the page's own) brought it down; now: without the slide */
  function sheetClose(fromBack, now) {
    var d = SH.d, host = SH.host;
    if (!SH.isOpen) return;
    var o = SH.state === 'ready' ? sheetO() : null;
    SH.isOpen = false; SH.gen++;
    if (!(host && host.opened)) ownClosed(fromBack === true);
    sheetShut();
    if (now !== true && !reducedMotion()) {
      /* is-gone: no taps (a class, not :modal, which older Safari does not know); inert: nothing in it takes focus, and focus
         stays on what it went back to when the sheet closed (the opener) */
      var keep = document.activeElement;
      try {
        d.classList.add('is-out', 'is-gone'); d.inert = true; d.show();
        if (keep && keep !== document.body && document.activeElement !== keep && document.contains(keep)) keep.focus({ preventScroll: true });
        SH.outT = setTimeout(sheetShut, 180);
      } catch (e) { sheetShut(); }
    }
    clearTimeout(SH.makeT); clearTimeout(SH.sayT); d.classList.remove('is-kb');
    SH.host = null; SH.raw = null; SH.t = null; SH.state = 'wait'; SH.said = ''; SH.sig = ''; SH.card = null; SH.p = null;
    if (host && host.closed) host.closed(fromBack === true, o);
  }

  /* the choices: the ones kept on this device for this wallet, and this trade's own caption */
  function sheetO() {
    var a = SH.acct;
    if (!SH.o || SH.okey !== a) { SH.o = cardPrefsGet(a); SH.okey = a; SH.auto = false; }
    var o = SH.o;
    return { addr: o.addr, amount: o.amount, result: o.result, look: o.look, caption: SH.caps[SH.key] || '' };
  }
  function sheetSig() {
    var o = sheetO(), t = SH.t;
    return [SH.key, t.sym, t.long, t.sideWord, t.lev, t.margin, t.pnl, t.addr, t.link, t.level || 0, o.addr, o.amount, o.result, o.look, o.caption].join('|');
  }
  function sheetMake() {
    if (SH.state !== 'ready') return Promise.reject(new Error('no trade'));
    var sig = sheetSig();
    if (SH.sig === sig && SH.card) return Promise.resolve(SH.card);
    if (SH.sig === sig && SH.p) return SH.p;
    SH.sig = sig; SH.card = null;
    var p = SH.p = tradeCard(SH.raw, sheetO()).then(function (c) { if (SH.p === p) { SH.card = c; SH.p = null; } return c; },
      function (e) { if (SH.p === p) SH.p = null; throw e; });
    return p;
  }

  /* more choices under the fold (a short phone): the foot's edge fades over them until the last is in view */
  function sheetMore() { var b = SH.R.body; SH.d.classList.toggle('has-more', b.scrollHeight - b.clientHeight - b.scrollTop > 6); }
  /* a choice: kept for this wallet on this device, and the card drawn again */
  function sheetSet(k, v) {
    var o = SH.o;
    if (SH.state !== 'ready' || !o) return;
    /* the dollars beside the percent give the amount away, so with the amount off the result shows as the percent, and
       comes back with the amount, unless the trader chose how it shows */
    if (k === 'amount' && !v && o.result === 'both') { o.result = 'pct'; SH.auto = true; }
    else if (k === 'amount' && v && SH.auto && o.result === 'pct') { o.result = 'both'; SH.auto = false; }
    o[k] = v;
    cardPrefsSet(SH.okey, o);
    sheetChanged(false);
  }
  function sheetChanged(typing) {
    SH.said = '';
    sheetPaint(); sheetDraw();
    clearTimeout(SH.makeT);
    SH.makeT = setTimeout(function () { if (SH.isOpen) sheetMake().catch(nothing); }, typing ? 350 : 120);
  }
  function sheetPaint() {
    var R = SH.R, ready = SH.state === 'ready', o = sheetO(), on = function (b) { return b ? 'true' : 'false'; };
    R.addr.setAttribute('aria-checked', on(o.addr)); R.amount.setAttribute('aria-checked', on(o.amount));
    R.addr.disabled = !ready || !SH.t.addr; R.amount.disabled = !ready;
    eachKid(R.res, function (b) { b.setAttribute('aria-pressed', on(b._v === o.result)); b.disabled = !ready; });
    eachKid(R.looks, function (b) { b.setAttribute('aria-pressed', on(b._v === o.look)); b.disabled = !ready; });
    R.cap.disabled = !ready;
    R.cv.setAttribute('aria-label', ready ? altOf(SH.t, o) + (o.caption.trim() ? ' ' + o.caption.trim() : '') : 'Your trade card');
    if (SH.can == null) SH.can = cardCanShare();
    setText(R.go, SH.state === 'wait' ? 'Reading your trade…' : SH.state === 'err' ? 'Close' : SH.can ? 'Share' : 'Save the picture');
    R.go.disabled = SH.state === 'wait'; R.go.classList.toggle('is-busy', SH.state === 'wait');
    /* beside the three keys, when the choice undoes the switch above it */
    setText(R.hint, ready && !o.amount && o.result === 'both' ? 'Both gives the amount away' : '');
    setText(R.say, SH.said);
  }
  /* the card and the four looks, drawn once a frame at most (while the trade is read, or could not be: the card's shapes) */
  function sheetDraw() {
    if (SH.raf) return;
    SH.raf = requestAnimationFrame(function () {
      SH.raf = 0;
      if (!SH.isOpen) return;
      var R = SH.R, t = SH.t, gen = SH.gen, w = R.pv.clientWidth ? R.cv.clientWidth : 0;
      var live = function () { return SH.gen === gen && SH.t === t; };
      if (!w) { sheetDraw(); return; }      /* the sheet is not laid out yet */
      if (SH.state !== 'ready') {
        cardHold(R.cv, w);
        eachKid(R.looks, function (b) { if (b._cv.clientWidth) cardHold(b._cv, b._cv.clientWidth); });
        return;
      }
      var o = cardOpts(sheetO());
      cardInto(R.cv, t, w, o, live).then(function () { if (live()) { R.pv.classList.add('is-in'); R.pv.classList.remove('is-wait'); } }, nothing);
      sheetMore();
      eachKid(R.looks, function (b) {
        var bw = b._cv.clientWidth;
        if (bw) cardInto(b._cv, t, bw, { addr: o.addr, amount: o.amount, result: o.result, look: b._v, caption: o.caption }, live).catch(nothing);
      });
    });
  }
  function kbHeight() { var vv = window.visualViewport; return vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0; }
  /* the keyboard: the sheet's key rides above it and the line being typed scrolls into view */
  function sheetKbFit() {
    var kb = kbHeight(), cap = SH.R.cap;
    SH.d.style.setProperty('--pcs-kb', kb + 'px');
    if (document.activeElement === cap && cap.scrollIntoView) cap.scrollIntoView({ block: kb > 0 ? 'center' : 'nearest' });
  }
  /* typing the caption with the phone's keyboard up: the card, the line being typed and the key share what is left */
  function sheetKb() {
    if (!SH.isOpen) return;
    var on = kbHeight() > 80 && document.activeElement === SH.R.cap;
    if (SH.d.classList.contains('is-kb') !== on) { SH.d.classList.toggle('is-kb', on); sheetDraw(); }
    sheetMore();
  }
  /* the sheet's one key: the PNG to the phone's share sheet, or saved; said for a few seconds where it was saved */
  function sheetGo() {
    if (SH.state === 'err') { sheetClose(); return; }
    if (SH.state !== 'ready') return;
    clearTimeout(SH.makeT);
    var gen = SH.gen;
    var told = function (s) {
      if (SH.gen !== gen) return;
      SH.said = s; sheetPaint(); clearTimeout(SH.sayT);
      if (s) SH.sayT = setTimeout(function () { if (SH.gen === gen) { SH.said = ''; sheetPaint(); } }, 6000);
    };
    var go = function (card) { return shareCardFile(card).then(function (r) { told(r === 'saved' ? 'Your card is saved: ' + card.name : ''); }); };
    var c = SH.sig === sheetSig() ? SH.card : null;
    if (c) { go(c); return; }
    sheetMake().then(go, function () { told('The card could not be made just now. Try again in a moment.'); });
  }

  /* the trade is here: its card, its choices, its PNG */
  function sheetTrade(raw) {
    var R = SH.R, t;
    try { t = cardTrade(raw); } catch (e) { sheetFail(); return; }
    SH.raw = raw; SH.t = t; SH.state = 'ready'; SH.said = '';
    SH.acct = t.account ? String(t.account).toLowerCase() : '';
    SH.key = SH.host && SH.host.key != null ? 'k:' + SH.host.key : t.id != null ? 'i:' + t.id : 'f:' + [t.sym, t.long ? 'l' : 's', t.lev, t.margin, t.pnl].join('|');
    R.cap.value = SH.caps[SH.key] || '';
    sheetPaint(); sheetDraw();
    sheetMake().catch(nothing);
  }
  /* the card's place held: last time's card and looks give way to the card's shapes */
  function sheetHold() {
    var R = SH.R;
    SH.raw = null; SH.t = null;
    R.pv.classList.remove('is-in'); R.pv.classList.add('is-wait');
    sheetDraw();
  }
  function sheetFail() {
    SH.state = 'err'; SH.said = READ_FAIL;
    sheetHold(); sheetPaint();
  }
  /* while the trade is read: the choices wait and the key says so */
  function sheetWait(host) {
    SH.state = 'wait'; SH.key = ''; SH.said = '';
    if (host && host.account) SH.acct = String(host.account).toLowerCase();
    SH.R.cap.value = '';
    sheetHold(); sheetPaint();
  }

  function open(src, host) {
    sheetBuild();
    if (SH.isOpen) sheetClose(false, true);
    host = host && typeof host === 'object' ? host : null;
    SH.host = host;
    setText(SH.R.title, host && host.title ? String(host.title) : 'Share your trade');
    var gen = ++SH.gen;
    if (src && typeof src.then === 'function') {
      sheetWait(host);
      src.then(function (raw) { if (SH.gen === gen && SH.isOpen) sheetTrade(raw); }, function () { if (SH.gen === gen && SH.isOpen) sheetFail(); });
    } else sheetTrade(src);
    sheetShow();
    sheetDraw();
    cardReady().catch(nothing);
  }

  window.ConfettiShare = {
    /* every Share on every page: the sheet with the trade's card and the trader's choices */
    open: open,
    /* the trade card (the owner's design): cardReady() loads its fonts and qr.js; tradeCard(trade, choices) the 2x PNG;
       drawCardInto(canvas, trade, cssWidth, choices) the card on a page at its own size; cardAlt(trade, choices) the card in
       words. The trader's choices: cardOpts(any) makes them whole, cardLooks names the looks, cardPrefs keeps them per wallet
       on this device */
    cardReady: cardReady,
    tradeCard: tradeCard,
    drawCardInto: drawCardInto,
    cardAlt: cardAlt,
    cardOpts: cardOpts,
    cardLooks: TC_LOOKS.map(function (l) { return { id: l.id, name: l.name }; }),
    cardPrefs: { get: cardPrefsGet, set: cardPrefsSet }
  };
})();
