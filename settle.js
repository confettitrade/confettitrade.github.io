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

  /* ImpactLib.bustPriceOf (v5): the bust of collateralUsdc of collateral backing notionalUsdc: the move is
     min(95% of collateral / notional, collateral / notional - 5 bps), worked in units of 1 / (notional x 10000);
     with the collateral the margin itself it is bustPrice at the leverage. */
  function bustPriceOf(entryPx18, isLong, collateralUsdc, notionalUsdc) {
    var coll = big(collateralUsdc), n = big(notionalUsdc);
    var den = n * BPS;
    var pct = BUST_BUFFER_PCT * 100n * coll;
    var gap = BUST_GAP_BPS * n;
    var whole = coll * BPS;
    var gapped = gap < whole ? whole - gap : 0n;
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

  /* ------------------------------------------------- the size fee (v5, V5P_SPEC section 13) */

  var SHARE_DEN = 100000n;   /* a share is in tenths of a bp of the stake */

  /* Exchange._feeShare: what one side of a trade pays, in tenths of a bp of its stake:
     min(rateX10 x leverage, capBps x 10). 0 for a house wallet and for a market without the fee. */
  function feeShare(rateX10, capBps, leverage) {
    var byRate = big(rateX10) * big(leverage), cap = big(capBps) * 10n;
    return byRate < cap ? byRate : cap;
  }

  /* Exchange._sizeFee: the fee of the share of a position that closes (marginUsdc before, restUsdc left open; an
     open or a full close: rest 0). Rounded down on both terms, so the parts of a position add up to one close. */
  function sizeFee(shareX10, marginUsdc, restUsdc) {
    var e = big(shareX10);
    if (e === 0n) return 0n;
    return big(marginUsdc) * e / SHARE_DEN - big(restUsdc || 0n) * e / SHARE_DEN;
  }

  /* The stake an amount buys when the open fee rides on top of it: the largest m with
     m + floor(m x share / 100000) <= amountUsdc, so the request takes the amount and never more. */
  function stakeFor(amountUsdc, shareX10) {
    var a = big(amountUsdc), e = big(shareX10);
    if (a <= 0n) return 0n;
    if (e === 0n) return a;
    var m = a * SHARE_DEN / (SHARE_DEN + e);
    while (m + sizeFee(e, m, 0n) > a) m -= 1n;
    while (m + 1n + sizeFee(e, m + 1n, 0n) <= a) m += 1n;
    return m;
  }

  /* The smallest amount whose stake is at least stakeUsdc: the stake plus its open fee. */
  function amountFor(stakeUsdc, shareX10) { return big(stakeUsdc) + sizeFee(shareX10, stakeUsdc, 0n); }

  /* --------------------------------------------------------------- the position, as stored */

  /* A position in the contract's units from the positions(id) tuple (ethers Result or a plain object).
     feeShareX10 (v5): its stamp, tradeFeeOf(positionId); the tuple does not carry it. None: no size fee, as on v4.
     addedMarginUsdc (v5): the margin added after the open, the tuple's 16th field; a v4 tuple has none (0). */
  function position(t, feeShareX10) {
    var added = t.addedMarginUsdc != null ? t.addedMarginUsdc : 0n;
    return {
      addedMarginUsdc: big(added),
      isLong: !!t.isLong, marginUsdc: big(t.marginUsdc), leverage: big(t.leverage), maxProfitUsdc: big(t.maxProfitUsdc),
      entryPx18: big(t.entryPx18), openedAt: big(t.openedAt), deadbandBps: big(t.deadbandBps),
      winFeeBps: big(t.winFeeBps), lossFeeBps: big(t.lossFeeBps), entryDeadbandBps: big(t.entryDeadbandBps),
      borrowRateX10: big(t.borrowRateX10), borrowFreeHours: big(t.borrowFreeHours),
      feeShareX10: feeShareX10 != null ? big(feeShareX10) : 0n
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
  /* ExchangeBase._collateral: margin plus added margin, what a loss is capped at and a liquidation forfeits */
  function collateral(pos) { return pos.marginUsdc + (pos.addedMarginUsdc || 0n); }

  /* ExchangeBase._restTerms: what a close of bps leaves open: the margin keeps its unclosed share (the closed share
     rounds down), the added margin and the maximum profit the same share of the margin, rounded down. The stamps,
     the entry and the opening time are the position's own. */
  function restTerms(pos, bps) {
    var margin = pos.marginUsdc, kept = margin - margin * big(bps) / BPS, r = {};
    Object.keys(pos).forEach(function (k) { r[k] = pos[k]; });
    r.marginUsdc = kept;
    r.addedMarginUsdc = margin > 0n ? (pos.addedMarginUsdc || 0n) * kept / margin : 0n;
    r.maxProfitUsdc = margin > 0n ? pos.maxProfitUsdc * kept / margin : 0n;
    return r;
  }

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
      amount = cappedLoss(n, collateral(pos), pos.entryPx18, exitPx18, pos.isLong);
    }
    return { isWin: isWin, amount: amount, forfeited: forfeited };
  }

  /* ExchangeExt.previewClose at price px18 and block time nowTs: { pnl, fee, payout } exactly as the
     contract returns them (pnl signed, payout after the borrow and, on v5, after the close-side size fee),
     plus the borrow taken, the size fee taken (tradeFee) and the parts.
     queueEmpty: the payout queue is empty (a loss fee is carved only then).
     bps (v5; none or 10000: the whole position): a share of it, as ExchangeExt._previewCloseAt settles one
     (ExchangeBase._closeShare: the whole position's amount, borrow and collateral less what stays open, so the parts
     of a position add up to one close; a winning share takes at most its share of the maximum profit). rest: what
     stays open (restTerms), null for the whole. The caller checks the share rules (1..10000, the rest's smallest
     collateral): the contract refuses a share it does not allow and this does not. */
  function previewClose(pos, c, px18, nowTs, queueEmpty, bps) {
    var share = bps != null && big(bps) !== BPS;
    var rest = share ? restTerms(pos, bps) : null;
    var q = quote(pos, c, px18);
    var held = big(nowTs) - pos.openedAt; if (held < 0n) held = 0n;
    var borrow = borrowFee(notional(pos), pos.borrowRateX10, held, pos.borrowFreeHours);
    var coll = collateral(pos), amount = q.amount, forfeited = q.forfeited, restAmount = 0n;
    if (rest && rest.marginUsdc > 0n) {
      var rq = quote(rest, c, px18);
      var gain = amount + forfeited - rq.amount - rq.forfeited;
      amount -= rq.amount;
      if (q.isWin) { var cap = pos.maxProfitUsdc - rest.maxProfitUsdc; if (amount > cap) amount = cap; }
      forfeited = gain > amount ? gain - amount : 0n;
      restAmount = rq.amount;
      borrow -= borrowFee(notional(rest), rest.borrowRateX10, held, rest.borrowFreeHours);
      coll -= collateral(rest);
    }
    var pnl = 0n, fee = 0n, payout;
    var lossBps = queueEmpty === false ? 0n : pos.lossFeeBps;
    if (amount === 0n) {
      payout = coll;
    } else if (q.isWin) {
      fee = winFee(amount + restAmount, pos.winFeeBps) - winFee(restAmount, pos.winFeeBps);
      pnl = amount - fee;
      payout = coll + pnl;
    } else {
      fee = splitLoss(amount + restAmount, lossBps).fee - splitLoss(restAmount, lossBps).fee;
      pnl = -amount;
      payout = coll - amount;
    }
    if (borrow > payout) borrow = payout;
    payout -= borrow;
    /* Exchange._settleClose: the close-side size fee comes after the borrow, out of the payout and never more than it */
    var tradeFee = sizeFee(pos.feeShareX10 || 0n, pos.marginUsdc, rest ? rest.marginUsdc : 0n);
    if (tradeFee > payout) tradeFee = payout;
    payout -= tradeFee;
    return { pnl: pnl, fee: fee, payout: payout, borrow: borrow, tradeFee: tradeFee, isWin: q.isWin, amount: amount, forfeited: forfeited, flat: amount === 0n, rest: rest };
  }

  /* The position's liquidation price, as bustPrice(positionId) works it. */
  function positionBust(pos) {
    var raw = rawEntry(pos.entryPx18, pos.isLong, pos.entryDeadbandBps);
    if (!(pos.addedMarginUsdc > 0n)) return bustPrice(raw, pos.isLong, pos.leverage);
    return bustPriceOf(raw, pos.isLong, collateral(pos), notional(pos));      /* ExchangeBase._bustPrice */
  }

  /* What the position is worth to its owner at px18: previewClose, except at or past the
     liquidation price, where liquidate(positionId) is open to anyone and takes the whole margin
     (the owner gets nothing back). */
  function value(pos, c, px18, nowTs, queueEmpty) {
    var bust = positionBust(pos);
    if (isBusted(px18, bust, pos.isLong)) {
      /* the collateral is forfeited: the margin and what was added to it */
      var coll = collateral(pos), lf = splitLiquidation(coll, queueEmpty === false ? 0n : pos.lossFeeBps);
      /* a liquidation has no close side: no size fee is taken (the open side was paid at the fill) */
      return { pnl: -coll, fee: lf.fee, payout: 0n, borrow: 0n, tradeFee: 0n, isWin: false, amount: coll, forfeited: 0n, flat: false, liquidated: true, bust: bust };
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
    bustPrice: bustPrice, bustPriceOf: bustPriceOf, isBusted: isBusted, rawGain: rawGain, impactScaleE18: impactScaleE18,
    adjustedGain: adjustedGain, winFee: winFee, cappedLoss: cappedLoss, splitLoss: splitLoss, splitLiquidation: splitLiquidation,
    feeShare: feeShare, sizeFee: sizeFee, stakeFor: stakeFor, amountFor: amountFor,
    position: position, curve: curve, collateral: collateral, restTerms: restTerms, quote: quote, previewClose: previewClose, positionBust: positionBust, value: value,
    fill: fill, openEntry: openEntry, oracle18: oracle18, parseOracle: parseOracle, usd: usd, px: px
  };
  if (typeof module === 'object' && module && module.exports) module.exports = S;
  else root.ConfettiSettle = S;
})(typeof self !== 'undefined' ? self : this);
