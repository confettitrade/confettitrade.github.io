/* The House chip on the pages that carry no trading code (docs, contracts, terms, the landing page): the house LP,
   read from the Exchange's lpBalance() on load and every 60 s, in the house page's own format. If config.json or every
   RPC fails, the chip keeps its dash. (Owner 2026-11-13: "display the house LP too".) */
(function () {
  'use strict';
  var chip = document.getElementById('houseChip');
  var b = chip && chip.querySelector('b');
  if (!b) return;
  var SEL = '0x2059f615';   /* lpBalance() */
  function fmt(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return '$' + Math.round(n).toLocaleString('en-US');
    return '$' + n.toFixed(2);
  }
  function call(url, to) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: to, data: SEL }, 'latest'] }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || typeof j.result !== 'string' || j.result.length < 3) throw new Error('no result');
        return parseInt(j.result, 16) / 1e6;
      });
  }
  function load(urls, to) {
    var i = 0;
    function next() {
      if (i >= urls.length) return;
      call(urls[i++], to).then(function (v) {
        if (isFinite(v)) {
          b.textContent = 'House ' + fmt(v);
          chip.setAttribute('aria-label', 'House LP ' + fmt(v) + '. View house stats');
        }
      }).catch(next);
    }
    next();
  }
  fetch('config.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (cfg) {
    var to = cfg && cfg.contracts && cfg.contracts.exchange;
    if (!to) return;
    var urls = [cfg.rpcUrl, 'https://rpc.hyperliquid.xyz/evm'].filter(function (u, k, a) { return u && a.indexOf(u) === k; });
    load(urls, to);
    setInterval(function () { if (!document.hidden) load(urls, to); }, 60000);
  }).catch(function () { /* the chip keeps its dash */ });
})();
