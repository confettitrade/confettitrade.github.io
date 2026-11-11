/* confetti_ — simple-boot.js
   Decides, before the first paint, whether this phone opens in Simple (simple.js / simple.css) or in Pro, so the
   page never shows one and then jumps to the other. It only sets <html data-mode="simple"> (and with it the browser
   bar's colour, since Simple is always the cream paper look), or leaves the page exactly as it was. It asks nothing
   of the network and holds nothing back: it reads the address, the saved choice and the flag simple.js cached on the
   last visit. simple.js takes over from there.
   The rule (config.json ui.simplePhones): "off" never; "optin" (or absent) only with ?mode=simple or a saved choice;
   "default" phones open in Simple unless the visitor chose Pro. ?mode=simple / ?mode=pro force it and are remembered. */
(function () {
  'use strict';
  var root = document.documentElement, MODE = 'confetti.trade.mode', FLAG = 'confetti.trade.simpleFlag';
  /* What a first visit gets (no flag cached yet, no choice). 'pro': the page as it always was, right while config.json's
     ui.simplePhones is absent, "optin" or "off". Set it to 'simple' on the day that flag becomes "default": a new visitor
     then opens in Simple, in cream, from the first frame. (simple.js caches the real flag on every visit; "off" always
     wins there.) */
  var FIRST = 'pro';
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: the choice lasts this visit */ } }
  var phone = false;
  try { phone = window.matchMedia('(max-width: 640px)').matches; } catch (e) { phone = false; }
  var param = null;
  try { param = new URLSearchParams(location.search).get('mode'); } catch (e) { param = null; }
  if (param === 'simple' || param === 'pro') set(MODE, param); else param = null;
  if (!phone) return;
  var saved = param || get(MODE), flag = get(FLAG), mode;
  if (flag === 'off') mode = 'pro';
  else if (saved === 'simple' || saved === 'pro') mode = saved;
  else mode = flag === 'default' || (flag == null && FIRST === 'simple') ? 'simple' : 'pro';
  if (mode !== 'simple') return;
  root.setAttribute('data-mode', 'simple');
  /* Simple's one look is the cream paper (simple.css sets it under data-mode="simple"); the browser bar goes with it */
  var bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.setAttribute('content', '#f4ecd8');
})();
