/* ==========================================================================
   confetti_  —  settle.js
   What the exchange settles a position to, worked exactly as the contracts work it: integer
   arithmetic on the same units (prices 1e18, USDC 6-decimal integers, bps), the same order of
   operations and the same rounding as ImpactLib, MarketRules.quote and ExchangeExt.previewClose
   (contracts/src, verified on Sourcify), so a figure from here equals the contract's to the last
   1e-6 USDC. The trade page's P&L cards price every position through it; test/settle.test.js holds
   it against previewClose answers recorded from the live chain and against the Solidity itself.
   BigInt only, no dependencies; in a browser it is window.ConfettiSettle, in node a module.
   ========================================================================== */
(function (root) {
  'use strict';

  var ONE = 1000000000000000000n;   /* 1e18 */
  var BPS = 10000n;
  var HOUR = 3600n;
  /* ImpactLib constants */
  var BUST_BUFFER_PCT = 95n;
  var BUST_GAP_BPS = 5n;
  var BOUNTY_BPS = 50n;

  function big(x) { return typeof x === 'bigint' ? x : BigInt(x); }

  /* OpenZeppelin Math.mulDiv: floor(a * b / d), plus one when rounding up and there is a remainder. */
  function mulDiv(a, b, d, up) {
    var p = a * b, q = p / d;
    if (up && q * d !== p) q += 1n;
    return q;
  }

  /* ------------------------------------------------------------------ ImpactLib: price */

  /* The exit moved deadbandBps against the trader: a long settles lower (down), a short higher (up). */
  function deadbandExit(exitPx18, isLong, deadbandBps) {
    var db = big(deadbandBps);
    if (isLong) return exitPx18 * (BPS - db) / BPS;
    return mulDiv(exitPx18, BPS + db, BPS, true);
  }

  /* The entry moved spreadBps against the trader: a long enters higher (up), a short lower (down). */
  function spreadEntry(px18, isLong, spreadBps) {
    var s = big(spreadBps);
    if (isLong) return mulDiv(px18, BPS + s, BPS, true);
    return px18 * (BPS - s) / BPS;
  }

  /* The raw print an entry was spread from (the bust is measured from it). */
  function rawEntry(entryPx18, isLong, spreadBps) {
    var s = big(spreadBps);
    if (s === 0n) return entryPx18;
    if (isLong) return entryPx18 * BPS / (BPS + s);
    return mulDiv(entryPx18, BPS, BPS - s, true);
  }

  /* Borrow owed: rateX10 tenths of a bps of notional per whole hour held beyond freeHours. */
  function borrowFee(notionalUsdc, rateX10, heldSeconds, freeHours) {
    var rate = big(rateX10), held = big(heldSeconds), free = big(freeHours) * HOUR;
    if (rate === 0n || held < free + HOUR) return 0n;
    return notionalUsdc * rate * ((held - free) / HOUR) / (BPS * 10n);
  }

  /* Bust price: the move is min(95% of 1/leverage, 1/leverage - 5 bps), long rounded up, short down. */
  function bustPrice(entryPx18, isLong, leverage) {
    var lev = big(leverage);
    var den = lev * BPS;
    var pct = BUST_BUFFER_PCT * 100n;
    var gap = BUST_GAP_BPS * lev;
    var gapped = gap < BPS ? BPS - gap : 0n;
    var move = pct < gapped ? pct : gapped;
    if (isLong) return mulDiv(entryPx18, den - move, den, true);
    return mulDiv(entryPx18, den + move, den, false);
  }

  function isBusted(px18, bustPx18, isLong) { return isLong ? px18 <= bustPx18 : px18 >= bustPx18; }

  /* ------------------------------------------------------------------- ImpactLib: wins */

  function rawGain(notionalUsdc, entryPx18, exitPx18, isLong) {
    if (isLong ? exitPx18 <= entryPx18 : exitPx18 >= entryPx18) return { gain: 0n, move: 0n };
    var diff = isLong ? exitPx18 - entryPx18 : entryPx18 - exitPx18;
    return { gain: mulDiv(notionalUsdc, diff, entryPx18, false), move: mulDiv(diff, ONE, entryPx18, false) };
  }

  /* curve: { baseRateBps, rateMultiplier, referenceNotionalUsd, positionMultiplierE6 } (the instrument's live one) */
  function impactScaleE18(moveE18, c) {
    if (moveE18 === 0n) return 0n;
    var rateTerm = mulDiv(ONE, ONE, moveE18 * big(c.rateMultiplier), true);
    var sizeTerm = mulDiv(big(c.referenceNotionalUsd), ONE * ONE, moveE18 * big(c.positionMultiplierE6), true);
    var denominator = ONE + rateTerm + sizeTerm;
    var numerator = ONE - big(c.baseRateBps) * 100000000000000n;   /* bps * 1e14 */
    return mulDiv(numerator, ONE, denominator, false);
  }

  function adjustedGain(gainUsdc, moveE18, c) {
    if (gainUsdc === 0n) return 0n;
    return mulDiv(gainUsdc, impactScaleE18(moveE18, c), ONE, false);
  }

  function winFee(adjustedUsdc, feeBps) { return adjustedUsdc * big(feeBps) / BPS; }

  /* ----------------------------------------------------------------- ImpactLib: losses */

  function cappedLoss(notionalUsdc, marginUsdc, entryPx18, exitPx18, isLong) {
    if (isLong ? exitPx18 >= entryPx18 : exitPx18 <= entryPx18) return 0n;
    var diff = isLong ? entryPx18 - exitPx18 : exitPx18 - entryPx18;
    var raw = mulDiv(notionalUsdc, diff, entryPx18, true);
    return raw < marginUsdc ? raw : marginUsdc;
  }

  function splitLoss(lossUsdc, feeBps) { var fee = lossUsdc * big(feeBps) / BPS; return { fee: fee, lp: lossUsdc - fee }; }

  function splitLiquidation(marginUsdc, feeBps) {
    var bounty = marginUsdc * BOUNTY_BPS / BPS, fee = marginUsdc * big(feeBps) / BPS;
    return { bounty: bounty, fee: fee, lp: marginUsdc - bounty - fee };
  }

  /* --------------------------------------------------------------- the position, as stored */

  /* A position in the contract's units from the positions(id) tuple (ethers Result or a plain object). */
  function position(t) {
    return {
      isLong: !!t.isLong, marginUsdc: big(t.marginUsdc), leverage: big(t.leverage), maxProfitUsdc: big(t.maxProfitUsdc),
      entryPx18: big(t.entryPx18), openedAt: big(t.openedAt), deadbandBps: big(t.deadbandBps),
      winFeeBps: big(t.winFeeBps), lossFeeBps: big(t.lossFeeBps), entryDeadbandBps: big(t.entryDeadbandBps),
      borrowRateX10: big(t.borrowRateX10), borrowFreeHours: big(t.borrowFreeHours)
    };
  }

  /* The impact curve from the instrument(id) tuple. */
  function curve(t) {
    return {
      baseRateBps: big(t.baseRateBps), rateMultiplier: big(t.rateMultiplier),
      referenceNotionalUsd: big(t.referenceNotionalUsd), positionMultiplierE6: big(t.positionMultiplierE6)
    };
  }

  function notional(pos) { return pos.marginUsdc * pos.leverage; }

  /* MarketRules.quote: what closing pos at exitPx18 is worth before fees, the payout cap applied. */
  function quote(pos, c, exitPx18) {
    var n = notional(pos);
    var isWin = pos.isLong ? exitPx18 > pos.entryPx18 : exitPx18 < pos.entryPx18;
    var amount = 0n, forfeited = 0n;
    if (isWin) {
      var adjustedExit = deadbandExit(exitPx18, pos.isLong, pos.deadbandBps);
      var g = rawGain(n, pos.entryPx18, adjustedExit, pos.isLong);
      amount = adjustedGain(g.gain, g.move, c);
      if (amount > pos.maxProfitUsdc) { forfeited = amount - pos.maxProfitUsdc; amount = pos.maxProfitUsdc; }
    } else {
      amount = cappedLoss(n, pos.marginUsdc, pos.entryPx18, exitPx18, pos.isLong);
    }
    return { isWin: isWin, amount: amount, forfeited: forfeited };
  }

  /* ExchangeExt.previewClose at price px18 and block time nowTs: { pnl, fee, payout } exactly as the
     contract returns them (pnl signed, payout after the borrow), plus the borrow taken and the parts.
     queueEmpty: the payout queue is empty (a loss fee is carved only then). */
  function previewClose(pos, c, px18, nowTs, queueEmpty) {
    var q = quote(pos, c, px18);
    var margin = pos.marginUsdc;
    var held = big(nowTs) - pos.openedAt;
    var borrow = borrowFee(notional(pos), pos.borrowRateX10, held < 0n ? 0n : held, pos.borrowFreeHours);
    var pnl = 0n, fee = 0n, payout;
    if (q.amount === 0n) {
      payout = margin;
    } else if (q.isWin) {
      fee = winFee(q.amount, pos.winFeeBps);
      pnl = q.amount - fee;
      payout = margin + pnl;
    } else {
      fee = splitLoss(q.amount, queueEmpty === false ? 0n : pos.lossFeeBps).fee;
      pnl = -q.amount;
      payout = margin - q.amount;
    }
    if (borrow > payout) borrow = payout;
    payout -= borrow;
    return { pnl: pnl, fee: fee, payout: payout, borrow: borrow, isWin: q.isWin, amount: q.amount, forfeited: q.forfeited, flat: q.amount === 0n };
  }

  /* The position's liquidation price, as bustPrice(positionId) works it. */
  function positionBust(pos) {
    return bustPrice(rawEntry(pos.entryPx18, pos.isLong, pos.entryDeadbandBps), pos.isLong, pos.leverage);
  }

  /* What the position is worth to its owner at px18: previewClose, except at or past the
     liquidation price, where liquidate(positionId) is open to anyone and takes the whole margin
     (the owner gets nothing back). */
  function value(pos, c, px18, nowTs, queueEmpty) {
    var bust = positionBust(pos);
    if (isBusted(px18, bust, pos.isLong)) {
      var lf = splitLiquidation(pos.marginUsdc, queueEmpty === false ? 0n : pos.lossFeeBps);
      return { pnl: -pos.marginUsdc, fee: lf.fee, payout: 0n, borrow: 0n, isWin: false, amount: pos.marginUsdc, forfeited: 0n, flat: false, liquidated: true, bust: bust };
    }
    var r = previewClose(pos, c, px18, nowTs, queueEmpty);
    r.liquidated = false; r.bust = bust;
    return r;
  }

  /* Exchange._fill: the keeper's fill is p1; anyone else's is the trader-worse of p0 and p1
     (takeMax: a long entry or a short exit takes the higher). */
  function fill(keeperFill, px0, px1, takeMax) {
    if (keeperFill) return px1;
    return (px1 > px0) === takeMax ? px1 : px0;
  }

  /* The entry executeOpen books for a fill at fillPx18 on a market with this entry spread. */
  function openEntry(fillPx18, isLong, entryDeadbandBps) { return spreadEntry(fillPx18, isLong, entryDeadbandBps); }

  /* ------------------------------------------------------------- the oracle price itself */

  /* PriceOracle._scale18: the precompile's integer carries 6 - szDecimals decimals. */
  function oracle18(rawPx, szDecimals) { return big(rawPx) * 10n ** BigInt(12 + Number(szDecimals)); }

  /* Hyperliquid's oraclePx string ("0.16234", "67123.0") as the precompile's integer, or null when it
     carries more decimals than the precompile can (then it is not the same number). */
  function parseOracle(s, szDecimals) {
    if (typeof s !== 'string' && typeof s !== 'number') return null;
    var str = String(s).trim();
    var m = /^(\d+)(?:\.(\d+))?$/.exec(str);
    if (!m) return null;
    var dec = 6 - Number(szDecimals);
    if (dec < 0) return null;
    var frac = (m[2] || '').replace(/0+$/, '');
    if (frac.length > dec) return null;
    var raw = BigInt(m[1] + (frac + '0'.repeat(dec)).slice(0, dec));
    return raw > 0n ? raw : null;
  }

  /* A 6-decimal USDC integer as a number of dollars (display only). */
  function usd(x) { return Number(x) / 1e6; }
  function px(x18) { return Number(x18) / 1e18; }

  var S = {
    ONE: ONE, BPS: BPS, mulDiv: mulDiv,
    deadbandExit: deadbandExit, spreadEntry: spreadEntry, rawEntry: rawEntry, borrowFee: borrowFee,
    bustPrice: bustPrice, isBusted: isBusted, rawGain: rawGain, impactScaleE18: impactScaleE18,
    adjustedGain: adjustedGain, winFee: winFee, cappedLoss: cappedLoss, splitLoss: splitLoss, splitLiquidation: splitLiquidation,
    position: position, curve: curve, quote: quote, previewClose: previewClose, positionBust: positionBust, value: value,
    fill: fill, openEntry: openEntry, oracle18: oracle18, parseOracle: parseOracle, usd: usd, px: px
  };
  if (typeof module === 'object' && module && module.exports) module.exports = S;
  else root.ConfettiSettle = S;
})(typeof self !== 'undefined' ? self : this);
