/* confetti_ — simple-boot.js
   Decides, before the first paint, whether this screen opens in Simple (simple.js / simple.css) or in Pro, so the
   page never shows one and then jumps to the other. It only sets <html data-mode="simple"> (and with it the browser
   bar's colour, since Simple is always the cream paper look), or leaves the page exactly as it was. It asks nothing
   of the network and holds nothing back: it reads the address, the saved choice and the flag simple.js cached on the
   last visit. simple.js takes over from there.
   The rule:
   - Phones (config.json ui.simplePhones): "off" never; "optin" (or absent) only with ?mode=simple or a saved choice;
     "default" phones open in Simple unless the visitor chose Pro. ?mode=simple / ?mode=pro force it and are remembered.
   - Desktop (config.json ui.simpleDesktop): same rule, separate flag and cache key. Desktop defaults to Pro. */
(function () {
  'use strict';
  var root = document.documentElement, MODE = 'confetti.trade.mode', FLAG_PH = 'confetti.trade.simpleFlag2', FLAG_DK = 'confetti.trade.simpleDesktopFlag';
  /* What a first visit gets (no flag cached yet, no choice). Phones: 'simple' since config.json's ui.simplePhones became "default".
     Desktop: 'pro' since desktop Simple is opt-in at launch.
     Put it back to 'pro' on the day the phone flag goes back to "optin" or "off". */
  var FIRST_PH = 'simple', FIRST_DK = 'pro';
  /* The address and the title as they came, before trade.js writes its coin into both: a shared trade.html#BTC opens BTC
     in Simple, and Simple's Home goes back to the page's own title. */
  window.ConfettiSimpleBoot = { hash: location.hash || '', title: document.title };
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: the choice lasts this visit */ } }
  var phone = false, desktop = false;
  try { phone = window.matchMedia('(max-width: 640px)').matches; desktop = !phone; } catch (e) { phone = false; desktop = false; }
  var param = null;
  try { param = new URLSearchParams(location.search).get('mode'); } catch (e) { param = null; }
  if (param === 'simple' || param === 'pro') set(MODE, param); else param = null;
  var saved = param || get(MODE), flagKey = phone ? FLAG_PH : FLAG_DK, first = phone ? FIRST_PH : FIRST_DK;
  var flag = get(flagKey), mode;
  if (flag === 'off') mode = 'pro';
  else if (saved === 'simple' || saved === 'pro') mode = saved;
  else mode = flag === 'default' || (flag == null && first === 'simple') ? 'simple' : 'pro';
  if (mode !== 'simple') return;
  root.setAttribute('data-mode', 'simple');
  /* Simple's one look is the cream paper (simple.css sets it under data-mode="simple"); the browser bar goes with it */
  var bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.setAttribute('content', '#f4ecd8');
})();
