/* confetti_ — gamewallet.js
   The wallet part of a game page (flip.html, crash.html): one small script both load.

   What it does, and nothing else:
   - finds every wallet this browser offers, by its own name and icon (EIP-6963: MetaMask, Phantom, Rabby and the rest);
     window.ethereum is the last resort, named from what it says it is;
   - the sheet a Connect press opens: those wallets as rows; on a phone with none, "Open in MetaMask" and "Open in Phantom"
     (this very page, inside the wallet app); on a computer with none, where to get one;
   - connects the one that was picked (MetaMask is asked for its account list, so the account can be chosen);
   - puts the wallet on HyperEVM: wallet_switchEthereumChain, wallet_addEthereumChain when the wallet does not know the
     network, and plain words when the wallet refuses.
   It never sends a transaction and never reads a balance: the game's own script does that with the wallet it is handed.
   The wallet picked is remembered the site's own way (confetti.wallet, as tabs.js does), so every page agrees.

   The lessons in here were paid for on the trading page (trade.js): Phantom's first answer after a sleep can be -32603
   (asked once more before anything is said); a wallet that no longer counts the site as approved answers a switch with 4100
   (the site is approved again, then the switch is asked once more); the add-network prompt shows the official RPC (another
   host there reads as a scam); and after a switch the wallet is asked where it is, because some say yes and stay. */
(function () {
  'use strict';

  var WALLET_KEY = 'confetti.wallet';
  var OFFICIAL_RPC = 'https://rpc.hyperliquid.xyz/evm';
  var SITE = 'https://confetti.trade/';
  var CHAINS = { 1: 'Ethereum', 10: 'Optimism', 56: 'BNB Chain', 137: 'Polygon', 143: 'Monad', 999: 'HyperEVM', 8453: 'Base', 42161: 'Arbitrum', 43114: 'Avalanche', 59144: 'Linea' };
  var C = { chainId: 999, chainIdHex: '0x3e7', chainName: 'HyperEVM', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, explorerUrl: 'https://hyperevmscan.io' };
  var announced = [], listeners = [], started = false;

  /* ---- small things ---- */
  function add(n, kids) {
    (Array.isArray(kids) ? kids : [kids]).forEach(function (k) { if (k == null || k === false) return; n.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k))); });
    return n;
  }
  function h(tag, cls, kids) { var n = document.createElement(tag); if (cls) n.className = cls; if (kids != null) add(n, kids); return n; }
  function btn(cls, kids, fn) { var b = h('button', cls, kids); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function isPhone() { try { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); } catch (e) { return false; } }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function plain(s, code) { var e = new Error(s); e.plain = s; if (code) e.gw = code; return e; }
  function walk(err, fn) { var e = err, n = 0; while (e && n++ < 8) { if (fn(e)) return true; e = e.error || e.cause || (e.data && e.data.originalError) || (e.info && e.info.error) || null; } return false; }
  function codeOf(err, codes) { var hit = null; walk(err, function (x) { if (x && codes.indexOf(x.code) >= 0) { hit = x.code; return true; } return false; }); return hit; }
  function rejected(err) { return walk(err, function (e) { return e.code === 4001 || e.code === 'ACTION_REJECTED' || /user (rejected|denied|cancel)|rejected the request/i.test(String(e.message || '')); }); }
  function chainName(id) { return CHAINS[id] || (id ? 'network ' + id : 'another network'); }

  /* ---- the wallets this browser offers ---- */
  function start() {
    if (started) return;
    started = true;
    window.addEventListener('eip6963:announceProvider', function (ev) {
      var d = ev && ev.detail;
      if (!d || !d.provider || !d.info || typeof d.provider.request !== 'function') return;
      if (announced.some(function (x) { return x.provider === d.provider; })) return;
      announced.push(d);
      listeners.slice().forEach(function (f) { try { f(); } catch (e) { /* a listener's own trouble */ } });
    });
    ask();
  }
  function ask() { try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) { /* an old browser: window.ethereum is the list */ } }
  /* what window.ethereum says it is (only asked when no wallet announced itself) */
  function flagName(eth) {
    if (!eth) return 'Browser wallet';
    if (eth.isPhantom) return 'Phantom'; if (eth.isRabby) return 'Rabby'; if (eth.isCoinbaseWallet) return 'Coinbase Wallet'; if (eth.isBraveWallet) return 'Brave Wallet';
    if (eth.isOkxWallet || eth.isOKExWallet) return 'OKX Wallet'; if (eth.isTrust || eth.isTrustWallet) return 'Trust Wallet'; if (eth.isRainbow) return 'Rainbow'; if (eth.isMetaMask) return 'MetaMask';
    return 'Browser wallet';
  }
  function clean(s) { return String(s || '').replace(/[<>&"]/g, '').slice(0, 40); }
  function wallets() {
    var seen = {}, out = [], pref = lsGet(WALLET_KEY) || '';
    announced.forEach(function (d) {
      var k = d.info.rdns || d.info.uuid || d.info.name;
      if (!k || seen[k]) return;
      seen[k] = 1;
      out.push({ key: String(d.info.rdns || ''), name: clean(d.info.name || d.info.rdns) || 'Wallet', icon: /^data:image\//.test(String(d.info.icon || '')) ? d.info.icon : '', provider: d.provider, rdns: String(d.info.rdns || ''), last: !!pref && d.info.rdns === pref });
    });
    if (out.length) return out;
    /* nobody announced: the old way. A browser with several of the old kind lists each. */
    var eth = window.ethereum, many = eth && Array.isArray(eth.providers) && eth.providers.length ? eth.providers : eth ? [eth] : [];
    many.forEach(function (p, i) {
      if (!p || typeof p.request !== 'function') return;
      var n = flagName(p);
      if (seen[n]) return;
      seen[n] = 1;
      out.push({ key: '', name: n, icon: '', provider: p, rdns: '', last: false });
    });
    return out;
  }
  function has() { return wallets().length > 0; }
  function entryOf(eth) { return wallets().filter(function (w) { return w.provider === eth; })[0] || null; }
  function nameOf(eth) { var w = entryOf(eth), n = w ? w.name : flagName(eth); return n === 'Browser wallet' ? 'Your wallet' : n; }
  function isMetaMask(eth) {
    var w = entryOf(eth);
    if (w && w.rdns) return /^io\.metamask/.test(w.rdns);
    return !!(eth && eth.isMetaMask && !eth.isPhantom && !eth.isRabby && !eth.isBraveWallet && !eth.isCoinbaseWallet && !eth.isOkxWallet && !eth.isOKExWallet && !eth.isTrust && !eth.isTrustWallet);
  }

  /* ---- the sheet: Simple's own (simple.css dialog.sm-sheet), as the game pages open it ---- */
  var sheets = [], styled = false;
  function style() {
    if (styled) return;
    styled = true;
    var s = document.createElement('style');
    s.id = 'gwStyle';
    s.textContent = '@media screen{'
      + 'dialog.sm-sheet.gw-sheet{max-width:520px;margin:0 auto}'
      + '.gw-list{padding-top:6px}'
      + ':is(.sm-root,.sm-sheet) .gw-list :is(button,a){justify-content:flex-start;gap:12px;min-height:56px;font-weight:600}'
      + '.gw-list :is(button,a) i{margin-left:auto}'
      + '.gw-ico{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:8px;overflow:hidden}'
      + '.gw-ico img{display:block;width:32px;height:32px}'
      + '.gw-ico svg{display:block;width:32px;height:32px}'
      + '.gw-say{margin:0 0 4px !important;text-wrap:pretty}'
      + '.gw-more{margin-top:14px !important}'
      + '}'
      + '@media screen and (min-width:641px){'
      + 'dialog.sm-sheet.gw-sheet{inset:64px 0 0 auto;width:420px;max-width:100%;height:auto;max-height:none;margin:0;border-top:0;border-left:1px solid var(--rule-strong)}'
      + 'dialog.sm-sheet.gw-sheet[open]{animation:gw-in 200ms ease-out}'
      + 'dialog.sm-sheet.gw-sheet.is-out{animation:gw-out 160ms ease-in forwards}'
      + 'dialog.sm-sheet.gw-sheet .sm-sh-head::before{content:none}'
      + '@keyframes gw-in{from{transform:translateX(100%)}}@keyframes gw-out{to{transform:translateX(100%)}}'
      + '}'
      + '@media screen and (min-width:641px) and (prefers-reduced-motion:reduce){dialog.sm-sheet.gw-sheet[open],dialog.sm-sheet.gw-sheet.is-out{animation:none}}';
    document.head.appendChild(s);
  }
  function sheet(name, cls) {
    style();
    var d = h('dialog', 'sm-sheet gw-sheet' + (cls ? ' ' + cls : ''));
    var title = h('h2'); title.id = 'gwSheet' + name; title.tabIndex = -1; d.setAttribute('aria-labelledby', title.id);
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
        try { history.pushState({ gwSheet: sheets.length }, ''); } catch (e) { /* fine */ }
      },
      close: function (fromPop) {
        if (!sh.isOpen) return;
        sh.isOpen = false; sheets = sheets.filter(function (s) { return s !== sh; });
        if (!fromPop) { try { if (history.state && history.state.gwSheet) history.back(); } catch (e) { /* fine */ } }
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

  /* a wallet with no picture of its own: a small paper wallet in the page's ink */
  function plainIcon() {
    var s = h('span', 'gw-ico');
    s.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect x="1" y="1" width="30" height="30" rx="7" fill="#e8dec8" stroke="#8a7f66"/><path d="M8 12.5h14.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H9.5A1.5 1.5 0 0 1 8 21.5v-9Zm0 0V11a2 2 0 0 1 2-2h10.5" fill="none" stroke="#2a2520" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20.2" cy="17.8" r="1.4" fill="#2a2520"/></svg>';
    return s;
  }
  function iconOf(w) {
    if (!w.icon) return plainIcon();
    var s = h('span', 'gw-ico'), img = h('img');
    img.alt = ''; img.width = 32; img.height = 32; img.src = w.icon;
    img.addEventListener('error', function () { var p = plainIcon(); if (s.parentNode) s.parentNode.replaceChild(p, s); });
    s.appendChild(img);
    return s;
  }
  /* this very page as a link a wallet app can open (a preview on another host points at the real site) */
  function pageUrl() {
    var file = (location.pathname.split('/').pop() || 'trade.html');
    return /^https:$/.test(location.protocol) ? location.origin + location.pathname : SITE + file;
  }
  function copyText(s, b) {
    var done = function () { if (b._was == null) b._was = b.textContent; b.textContent = 'Copied'; clearTimeout(b._t); b._t = setTimeout(function () { b.textContent = b._was; b._was = null; }, 1400); };
    function old() { try { var t = h('textarea'); t.value = s; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; (b.closest('dialog') || document.body).appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done(); } catch (e) { /* the link is on the screen */ } }
    try { navigator.clipboard.writeText(s).then(done, old); } catch (e) { old(); }
  }

  /* ---- the sheet a Connect press opens ----
     Resolves with the wallet picked ({ key, name, provider }) or null when the sheet was closed. opts.note: one line of the
     page's own about what the wallet is for. */
  var PICK = null;
  function pick(opts) {
    opts = opts || {};
    start(); ask();
    return new Promise(function (resolve) {
      var sh = PICK || (PICK = sheet('Wallet')), done = false;
      function finish(w) { if (done) return; done = true; listeners = listeners.filter(function (f) { return f !== fill; }); sh.onClose = null; sh.close(); resolve(w); }
      function link(label, href, hint) { var a = h('a', null, [label, h('i', null, hint || '›')]); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; }
      function fill() {
        var list = wallets(), phone = isPhone(), page = pageUrl(), enc = encodeURIComponent, origin = page.replace(/^(https:\/\/[^/]+).*$/, '$1');
        sh.body.textContent = ''; sh.foot.textContent = '';
        var box = h('div', 'sm-menu gw-list');
        if (list.length) {
          sh.title.textContent = 'Connect a wallet';
          add(sh.body, h('p', 'sm-fine gw-say', opts.note || 'Pick the wallet to play from.'));
          list.forEach(function (w) {
            var b = btn(null, [iconOf(w), w.name, h('i', null, w.last && list.length > 1 ? 'last used ›' : '›')], function () { lsSet(WALLET_KEY, w.rdns || null); finish(w); });
            b.setAttribute('data-wallet', w.rdns || w.name);
            add(box, b);
          });
          add(sh.body, box);
          add(sh.body, h('p', 'sm-fine gw-more', 'It is asked to connect, and to use the HyperEVM network. Nothing is paid by connecting.'));
        } else if (phone) {
          sh.title.textContent = 'Open in your wallet';
          add(sh.body, h('p', 'sm-fine gw-say', 'This browser has no wallet in it. Open this page inside your wallet app: it comes up there, ready to connect.'));
          add(box, [link('Open in MetaMask', 'https://metamask.app.link/dapp/' + page.replace(/^https:\/\//, '')), link('Open in Phantom', 'https://phantom.app/ul/browse/' + enc(page) + '?ref=' + enc(origin)),
            link('Open in Coinbase Wallet', 'https://go.cb-w.com/dapp?cb_url=' + enc(page)), link('Open in OKX Wallet', 'okx://wallet/dapp/url?dappUrl=' + enc(page))]);
          add(sh.body, box);
          var copy = btn('sm-btn is-ghost', 'Copy this page\'s link', function () { copyText(page, copy); });
          add(sh.foot, copy);
        } else {
          sh.title.textContent = 'Get a wallet';
          add(sh.body, h('p', 'sm-fine gw-say', 'This browser has no wallet yet. Add one, then come back to this page and press Connect.'));
          add(box, [link('Get MetaMask', 'https://metamask.io/download/'), link('Get Phantom', 'https://phantom.com/download'), link('Get Rabby', 'https://rabby.io/')]);
          add(sh.body, box);
        }
      }
      fill();
      listeners.push(fill);          /* a wallet that announces itself late joins the list while it is open */
      sh.onClose = function () { finish(null); };
      sh.open();
    });
  }

  /* ---- connecting ---- */
  function requestAccounts(eth) {
    return eth.request({ method: 'eth_requestAccounts', params: [] }).catch(function (e) {
      if (codeOf(e, [-32603]) == null) throw e;
      return wait(1200).then(function () { return eth.request({ method: 'eth_requestAccounts', params: [] }); });
    });
  }
  function pickAccounts(eth) {
    if (!isMetaMask(eth)) return requestAccounts(eth);
    return eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }).then(function () { return eth.request({ method: 'eth_accounts', params: [] }); }, function (e) {
      if (rejected(e) || codeOf(e, [-32002]) != null) throw e;
      return requestAccounts(eth);      /* a MetaMask without the account list */
    });
  }
  function connectWords(e, name) {
    var code = codeOf(e, [-32603, -32002, 4100]);
    if (rejected(e)) return 'You closed the request in ' + name + '. Nothing was connected.';
    if (code === -32002) return name + ' already has a request waiting. Open ' + name + ' and answer it there.';
    if (code === 4100) return name + ' is locked or has not allowed this site yet. Open ' + name + ', unlock it, then press Connect again.';
    if (code === -32603) return name + ' did not open its connect window. Reload this page, make sure ' + name + ' is unlocked, then press Connect again.';
    return name + ' did not connect. Open ' + name + ', make sure it is unlocked, then press Connect again.';
  }
  function chainOf(eth) { return eth.request({ method: 'eth_chainId', params: [] }).then(function (hex) { return parseInt(hex, 16); }); }

  /* ---- HyperEVM: switch, add when the wallet does not know it, and say so plainly when the wallet refuses ---- */
  function switchOnce(eth) {
    return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: C.chainIdHex }] }).catch(function (err) {
      var code = err && (err.code != null ? err.code : (err.data && err.data.originalError && err.data.originalError.code)), msg = String((err && err.message) || '');
      if (!(code === 4902 || code === -32603 || /4902|unrecognized|not added|unknown chain|not supported|unsupported/i.test(msg))) throw err;
      return eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: C.chainIdHex, chainName: C.chainName, rpcUrls: [OFFICIAL_RPC], nativeCurrency: C.nativeCurrency, blockExplorerUrls: C.explorerUrl ? [C.explorerUrl] : [] }] });
    }).then(function () { return chainOf(eth); }).then(function (id) {
      if (id !== C.chainId) { var e = new Error('still on ' + id); e.stayed = id; throw e; }
      return id;
    });
  }
  function switchWords(e, name, was) {
    var where = chainName(e && e.stayed ? e.stayed : was);
    if (codeOf(e, [4100]) != null) return name + ' says this site is not allowed for the account it is on. Open ' + name + ', connect this site to that account, then press Switch to HyperEVM.';
    if (codeOf(e, [-32002]) != null) return name + ' already has a request waiting. Open ' + name + ' and answer it there.';
    if (rejected(e)) return name + ' stayed on ' + where + '. The game runs on HyperEVM: press Switch to HyperEVM and allow it.';
    return name + ' could not move to HyperEVM by itself. In ' + name + ', pick or add the network HyperEVM (chain ID 999, RPC ' + OFFICIAL_RPC + ', currency HYPE), then press again.';
  }
  /* resolves once the wallet is on HyperEVM; rejects with plain words (e.plain) when it is not */
  function toChain(eth) {
    var name = nameOf(eth), was = null;
    return chainOf(eth).catch(function () { return null; }).then(function (id) {
      was = id;
      if (id === C.chainId) return id;
      return switchOnce(eth).catch(function (err) {
        if (codeOf(err, [4100]) == null) throw err;
        return eth.request({ method: 'eth_requestAccounts', params: [] }).then(function () { return switchOnce(eth); });
      });
    }).catch(function (e) { throw plain(switchWords(e, name, was), 'chain'); });
  }

  /* ---- a Connect press, whole ----
     opts.always: show the sheet even when the browser offers one wallet (Switch wallet). opts.note: the sheet's own line.
     opts.onStep('accounts' | 'chain', name): the page says whose turn it is.
     Resolves null when nothing was picked; else { eth, account, name, chainId, chainOk, say } (say: plain words when the wallet
     would not move to HyperEVM: it is connected all the same, and the page's key offers the switch again).
     Rejects with plain words (e.plain) when the wallet refused to connect. */
  function connect(opts) {
    opts = opts || {};
    start();
    var list = wallets(), step = opts.onStep || function () {};
    var chosen = list.length === 1 && !opts.always ? Promise.resolve(list[0]) : pick(opts);
    return chosen.then(function (w) {
      if (!w) return null;
      var eth = w.provider, name = w.name;
      step('accounts', name);
      return pickAccounts(eth).then(function (accounts) {
        if (!accounts || !accounts.length) throw new Error('no account');
        return accounts[0];
      }, function (e) { throw plain(connectWords(e, name), 'connect'); }).then(function (account) {
        var out = { eth: eth, account: account, name: name, chainId: null, chainOk: false, say: '' };
        return chainOf(eth).catch(function () { return null; }).then(function (id) {
          out.chainId = id;
          if (id === C.chainId) { out.chainOk = true; return out; }
          step('chain', name);
          return toChain(eth).then(function () { out.chainId = C.chainId; out.chainOk = true; return out; }, function (e) { out.say = e.plain || switchWords(e, name, id); return out; });
        });
      }, function (e) { throw e.plain ? e : plain(connectWords(e, name), 'connect'); });
    });
  }
  /* a wallet that was connected before: asked quietly (eth_accounts opens nothing). The one picked last, else the only one. */
  function restore() {
    start();
    var list = wallets(), pref = lsGet(WALLET_KEY) || '';
    var w = (pref && list.filter(function (x) { return x.rdns === pref; })[0]) || (list.length === 1 ? list[0] : null);
    if (!w) return Promise.resolve(null);
    return w.provider.request({ method: 'eth_accounts', params: [] }).then(function (accounts) {
      if (!accounts || !accounts.length) return null;
      return chainOf(w.provider).catch(function () { return null; }).then(function (id) { return { eth: w.provider, account: accounts[0], name: w.name, chainId: id, chainOk: id === C.chainId, say: '' }; });
    }, function () { return null; });
  }
  /* the signer for the account the page shows (never "the wallet's first account, whichever that is by now") */
  function signer(eth, account) { var E = window.ethers; return new E.JsonRpcSigner(new E.BrowserProvider(eth), E.getAddress(account)); }

  window.ConfettiGameWallet = {
    /* the page's config.json (chain id, name, currency, explorer); without it HyperEVM's own values stand */
    init: function (cfg) {
      if (cfg && Number(cfg.chainId) > 0) { C.chainId = Number(cfg.chainId); C.chainIdHex = cfg.chainIdHex || '0x' + C.chainId.toString(16); }
      if (cfg && cfg.chainName) C.chainName = String(cfg.chainName);
      if (cfg && cfg.nativeCurrency) C.nativeCurrency = cfg.nativeCurrency;
      if (cfg && cfg.explorerUrl) C.explorerUrl = String(cfg.explorerUrl);
      start();
    },
    wallets: wallets, has: has, nameOf: nameOf, pick: pick, connect: connect, restore: restore, toChain: toChain, chainOf: chainOf, chainName: chainName,
    signer: signer, sheet: sheet, isPhone: isPhone, rejected: rejected, copyText: copyText, pageUrl: pageUrl
  };
})();
