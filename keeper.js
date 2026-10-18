/* ==========================================================================
   confetti_  —  keeper.js
   The fill keeper's heartbeat, read from chain: the newest Exchange fill
   (PositionOpened, PositionClosed, or an execution that refunded a request,
   OpenRequestCancelled) whose transaction a keeper sent (isKeeper(tx.from)).
   Its age on the chain clock is the keeper's last-fill age; over 5 minutes
   the keeper counts as offline. Used by trade.js (Status tab) and tabs.js
   (House tab). Read-only: eth_blockNumber, eth_getLogs, eth_getTransaction,
   eth_call. No build step; needs ethers v6 objects from the caller.
   ========================================================================== */
(function () {
  'use strict';

  var OFFLINE_AFTER_S = 300;
  var FIRST_LOOKBACK_BLOCKS = 3600;   /* about an hour of HyperEVM small blocks (~1 s each) */
  var CHUNK_BLOCKS = 2000;
  var MAX_TX_LOOKUPS = 20;            /* senders checked per refresh, newest first */
  var FILL_EVENTS = ['PositionOpened', 'PositionClosed', 'OpenRequestCancelled'];

  function fmtAge(s) {
    s = Math.max(0, Math.floor(s));
    if (s < 90) return s + 's';
    if (s < 90 * 60) return Math.round(s / 60) + 'm';
    if (s < 48 * 3600) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  /* opts: { provider (eth_call / blocks / txs), logProvider (eth_getLogs), exchange (ethers.Contract
     with isKeeper), iface (ethers.Interface with the fill events) } */
  function create(opts) {
    var topics = FILL_EVENTS.map(function (n) { return opts.iface.getEvent(n).topicHash; });
    var address = String(opts.exchange.target);
    var keeperOf = {};
    var st = {
      last: null,          /* { block, ts, tx, from } of the newest keeper fill seen */
      scannedTo: null,     /* newest block whose logs were checked */
      since: null, sinceTs: null,   /* first block scanned and its timestamp */
      headTs: null, headAt: 0,
      busy: false, ok: false
    };

    function isKeeper(a) {
      var k = a.toLowerCase();
      if (keeperOf[k] != null) return Promise.resolve(keeperOf[k]);
      return opts.exchange.isKeeper(a).then(function (v) { keeperOf[k] = !!v; return keeperOf[k]; });
    }

    function logsBetween(from, to) {
      var out = [];
      function step(end) {
        if (end < from) return Promise.resolve(out);
        var start = Math.max(from, end - CHUNK_BLOCKS + 1);
        return opts.logProvider.getLogs({ address: address, topics: [topics], fromBlock: start, toBlock: end }).then(function (logs) {
          out = out.concat(logs || []);
          return step(start - 1);
        });
      }
      return step(to);
    }

    /* The newest keeper-sent fill among these logs, or null. */
    function newestKeeperFill(logs) {
      logs.sort(function (a, b) { return b.blockNumber - a.blockNumber || b.index - a.index; });
      var seen = {}, txs = [];
      logs.forEach(function (l) { if (!seen[l.transactionHash]) { seen[l.transactionHash] = true; txs.push(l); } });
      txs = txs.slice(0, MAX_TX_LOOKUPS);
      var i = 0;
      function next() {
        if (i >= txs.length) return Promise.resolve(null);
        var l = txs[i++];
        return opts.provider.getTransaction(l.transactionHash).then(function (tx) {
          if (!tx || !tx.from) return next();
          return isKeeper(tx.from).then(function (yes) {
            return yes ? { block: Number(l.blockNumber), tx: l.transactionHash, from: tx.from } : next();
          });
        });
      }
      return next();
    }

    function refresh() {
      if (st.busy) return Promise.resolve(st);
      st.busy = true;
      var head;
      return opts.provider.getBlock('latest').then(function (b) {
        head = Number(b.number);
        st.headTs = Number(b.timestamp); st.headAt = Date.now();
        if (st.since == null) {
          var since = Math.max(0, head - FIRST_LOOKBACK_BLOCKS);
          return opts.provider.getBlock(since).then(function (sb) { st.since = since; st.sinceTs = Number(sb.timestamp); });
        }
      }).then(function () {
        var from = st.scannedTo != null ? st.scannedTo + 1 : st.since;
        if (from > head) return null;
        return logsBetween(from, head).then(newestKeeperFill);
      }).then(function (hit) {
        if (!hit || (st.last && hit.block <= st.last.block)) return null;
        return opts.provider.getBlock(hit.block).then(function (blk) {
          hit.ts = Number(blk.timestamp);
          st.last = hit;
        });
      }).then(function () {
        st.scannedTo = head;
        st.ok = true;
      }).catch(function () { /* transient RPC trouble: keep the last reading */ }).then(function () {
        st.busy = false;
        return st;
      });
    }

    function chainNow() { return st.headTs + (Date.now() - st.headAt) / 1000; }

    /* Seconds since the last keeper fill on the chain clock, or null when none was seen. */
    function age() {
      if (!st.last || st.headTs == null) return null;
      return chainNow() - st.last.ts;
    }

    /* { text, offline, title } for a kv cell; text is '—' until the first read lands. */
    function view() {
      if (!st.ok) return { text: '—', offline: false, title: '' };
      var a = age();
      if (a == null) {
        return { text: 'no fill in ' + fmtAge(chainNow() - st.sinceTs), offline: false, title: 'no keeper-sent fill since block ' + st.since };
      }
      var off = a > OFFLINE_AFTER_S;
      return {
        text: 'last fill ' + fmtAge(a) + ' ago',
        offline: false,
        title: 'block ' + st.last.block + ' · ' + st.last.tx + ' · from ' + st.last.from
      };
    }

    return { refresh: refresh, age: age, view: view, state: function () { return st; } };
  }

  window.ConfettiKeeper = { create: create, OFFLINE_AFTER_S: OFFLINE_AFTER_S, fmtAge: fmtAge };
})();
