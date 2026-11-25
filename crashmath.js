/* confetti_ — crashmath.js
   The crash game's arithmetic, in one place for the page (crash.js), its demo round server and the check page
   (crash_vectors.html). The same numbers the contract works out (contracts/src/crash/CrashMath.sol) and the round server
   (ops/crash): the vectors page holds this file against the kit's own test vectors.

   - the multiplier t milliseconds into a flight: m(t) = e^(0.00006 t), shown floored to hundredths;
   - the crash point of a round from its revealed seed and the salt: h = keccak256(seed ++ salt), r = the top 52 bits of h,
     crashX100 = max(100, floor((10000 - edgeBps) * 2^52 / (2^52 - r) / 100));
   - the chain: keccak256(this round's seed) is the seed of the round before it (the committed end of the chain for round 1);
   - what a cash-out pays, and the multiplier at which a bet's profit reaches the most one bet may win.

   Multipliers are whole hundredths everywhere (x100: 100 = 1.00x). Money is USDC with 6 decimals, as BigInt.
   keccak256 is written out here (no library), so a round can be checked with nothing but this file. */
(function (root) {
  'use strict';

  var K = 0.00006;                 /* the curve's rate, per millisecond */
  var TWO_52 = 1n << 52n, MASK = (1n << 64n) - 1n;

  /* ---- keccak256 (Keccak-f[1600], rate 136, the 0x01 pad Ethereum uses) ---- */
  var RC = [0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
    0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
    0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n];
  var ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt);
  function rotl(v, n) { return n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK; }
  function permute(A) {
    var C = new Array(5), B = new Array(25), x, y, i, d, r;
    for (r = 0; r < 24; r++) {
      for (x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
      for (x = 0; x < 5; x++) { d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n); for (y = 0; y < 25; y += 5) A[x + y] ^= d; }
      for (x = 0; x < 5; x++) for (y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
      for (y = 0; y < 25; y += 5) for (x = 0; x < 5; x++) A[x + y] = B[x + y] ^ ((~B[(x + 1) % 5 + y] & MASK) & B[(x + 2) % 5 + y]);
      A[0] ^= RC[r];
    }
  }
  function keccak256(bytes) {
    var rate = 136, n = bytes.length, padded = new Uint8Array((Math.floor(n / rate) + 1) * rate), A = new Array(25), i, j, off, lane;
    padded.set(bytes); padded[n] ^= 0x01; padded[padded.length - 1] ^= 0x80;
    for (i = 0; i < 25; i++) A[i] = 0n;
    for (off = 0; off < padded.length; off += rate) {
      for (i = 0; i < rate / 8; i++) { lane = 0n; for (j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]); A[i] ^= lane; }
      permute(A);
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 4; i++) { lane = A[i]; for (j = 0; j < 8; j++) { out[i * 8 + j] = Number(lane & 0xffn); lane >>= 8n; } }
    return out;
  }

  /* ---- bytes and hex ---- */
  function isHex32(s) { return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s); }
  function bytesOf(hex) {
    var s = String(hex).replace(/^0x/, ''), out = new Uint8Array(s.length / 2), i;
    for (i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  function hexOf(bytes) { var s = '0x', i; for (i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }
  function keccakHex(hex) { return hexOf(keccak256(bytesOf(hex))); }

  /* ---- the crash point ---- */
  /* h = keccak256(seed ++ salt), as 0x + 64 hex */
  function roundHash(seed, salt) { var b = new Uint8Array(64); b.set(bytesOf(seed), 0); b.set(bytesOf(salt), 32); return hexOf(keccak256(b)); }
  /* the top 52 bits of h */
  function r52(h) { return BigInt(h) >> 204n; }
  function crashFromR(r, edgeBps) {
    var x = (10000n - BigInt(edgeBps)) * TWO_52 / (TWO_52 - r) / 100n;
    return Number(x < 100n ? 100n : x);
  }
  function crashX100(seed, salt, edgeBps) { return crashFromR(r52(roundHash(seed, salt)), edgeBps == null ? 100 : edgeBps); }
  /* the chain: a round's seed, hashed once for every round number since the seed before it (1 for the round right before;
     more when a round number was never played), is that earlier seed; for the chain's first round, its committed end */
  function chainOk(seed, prev, gap) {
    if (!isHex32(seed) || !isHex32(prev)) return false;
    var b = bytesOf(seed), n = gap == null ? 1 : Number(gap), i;
    if (!(n >= 1 && n <= 4096)) return false;
    for (i = 0; i < n; i++) b = keccak256(b);
    return hexOf(b) === prev.toLowerCase();
  }

  /* ---- the curve ---- */
  function multAt(ms) { return Math.exp(K * Math.max(0, ms)); }
  /* the multiplier on show at ms, times 100, floored (the round server's own multAt) */
  function x100At(ms) { return ms <= 0 ? 100 : Math.floor(100 * Math.exp(K * ms)); }
  /* the first whole millisecond of flight at which the multiplier on show is at least x100 (the round server's timeFor) */
  function msFor(x100) {
    if (x100 <= 100) return 0;
    var t = Math.max(0, Math.ceil(Math.log(x100 / 100) / K));
    while (x100At(t) < x100) t += 1;
    while (t > 0 && x100At(t - 1) >= x100) t -= 1;
    return t;
  }

  /* ---- money (USDC, 6 decimals, BigInt) ---- */
  /* the multiplier at which a bet's profit reaches maxWin: the bet is cashed out there for its player */
  function capX100(stake, maxWin) { stake = BigInt(stake); maxWin = BigInt(maxWin); return Number(100n + (100n * maxWin + stake - 1n) / stake); }
  /* what a cash-out at x100 pays: never more than the stake plus maxWin (maxWin null: no cap known) */
  function payout(stake, x100, maxWin) {
    stake = BigInt(stake);
    var p = stake * BigInt(x100) / 100n;
    if (maxWin != null && p > stake + BigInt(maxWin)) p = stake + BigInt(maxWin);
    return p;
  }
  /* the largest profit a bet can make: what the contract sets aside for it when it is locked (the room it takes in a round) */
  function maxProfit(stake, autoX100, maxWin) {
    stake = BigInt(stake); maxWin = BigInt(maxWin);
    var a = BigInt(autoX100);
    return a !== 0n && a < BigInt(capX100(stake, maxWin)) ? stake * a / 100n - stake : maxWin;
  }
  /* the multiplier a bet is paid at, 0 when it lost: the lowest of its manual cash-out, its auto target and its cap that the
     round reached */
  function payMult(manualX100, autoX100, cap, crash) {
    var best = 0;
    manualX100 = Number(manualX100); autoX100 = Number(autoX100); cap = Number(cap); crash = Number(crash);
    if (cap <= crash) best = cap;
    if (autoX100 !== 0 && autoX100 <= crash && (best === 0 || autoX100 < best)) best = autoX100;
    if (manualX100 !== 0 && manualX100 <= crash && (best === 0 || manualX100 < best)) best = manualX100;
    return best;
  }

  /* ---- the signed messages (EIP-712, as the contract hashes them): domain "ConfettiCrash" version "1" ---- */
  function utf8(s) { return new TextEncoder().encode(s); }
  function typeHash(s) { return hexOf(keccak256(utf8(s))).slice(2); }
  function word(v) { var s = BigInt(v).toString(16); while (s.length < 64) s = '0' + s; return s; }
  var T_DOMAIN = typeHash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
  var T_BET = typeHash('Bet(uint64 round,address player,uint256 stake,uint32 autoX100,uint64 nonce)');
  var T_OUT = typeHash('CashOut(uint64 round,address player,uint32 multX100)');
  var T_CANCEL = typeHash('CancelBet(uint64 round,address player,uint64 nonce)');
  var H_NAME = typeHash('ConfettiCrash'), H_VERSION = typeHash('1');
  function domainSeparator(chainId, contract) { return keccakHex('0x' + T_DOMAIN + H_NAME + H_VERSION + word(chainId) + word(contract)); }
  function digest(dom, struct) { return keccakHex('0x1901' + dom.slice(2) + keccakHex('0x' + struct).slice(2)); }
  /* what the session key signs: a bet, a cash-out, and (for the socket only) a cancel */
  function betDigest(dom, b) { return digest(dom, T_BET + word(b.round) + word(b.player) + word(b.stake) + word(b.autoX100) + word(b.nonce)); }
  function cashOutDigest(dom, o) { return digest(dom, T_OUT + word(o.round) + word(o.player) + word(o.multX100)); }
  function cancelBetDigest(dom, c) { return digest(dom, T_CANCEL + word(c.round) + word(c.player) + word(c.nonce)); }

  var api = {
    K: K, keccak256: keccak256, keccakHex: keccakHex, bytesOf: bytesOf, hexOf: hexOf, isHex32: isHex32,
    roundHash: roundHash, r52: r52, crashFromR: crashFromR, crashX100: crashX100, chainOk: chainOk,
    multAt: multAt, x100At: x100At, msFor: msFor, capX100: capX100, payout: payout, maxProfit: maxProfit, payMult: payMult,
    domainSeparator: domainSeparator, betDigest: betDigest, cashOutDigest: cashOutDigest, cancelBetDigest: cancelBetDigest
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ConfettiCrashMath = api;
})(typeof window !== 'undefined' ? window : this);
