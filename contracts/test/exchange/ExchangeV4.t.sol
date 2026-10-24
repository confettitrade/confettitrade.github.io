// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Exchange} from "../../src/Exchange.sol";
import {ExchangeExt} from "../../src/ExchangeExt.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {ImpactLib} from "../../src/lib/ImpactLib.sol";
import {IExchange} from "../../src/interfaces/IExchange.sol";
import {IExchangeTypes} from "../../src/interfaces/IExchangeTypes.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";
import {IReferrals} from "../../src/interfaces/IReferrals.sol";
import {ExchangeFixture} from "./ExchangeFixture.sol";

/// @notice The v4 mechanisms of the core and its extension, one at a time: house money,
///         house-sized limits, the stamped maximum profit, the entry spread, the split win /
///         loss fee, borrow, house wallets, the breaker's defaults, `retireDead`, the role
///         split, the extension's direct-call guard, the combined ABI and every setter bound.
contract ExchangeV4Test is ExchangeFixture {
    /// @dev Take the house down to `free` of free cash (nothing is owed at the time).
    function _tightHouse(uint256 free) internal {
        uint256 amount = ex.houseFreeUsdc() - free;
        vm.prank(owner);
        ex.withdrawHouse(amount);
        assertEq(ex.houseFreeUsdc(), free);
    }

    function _sizing(uint32 id, uint16 posX10, uint16 sideX10, uint16 stressBps) internal {
        vm.prank(marketKeeper);
        ex.setHouseSizing(id, posX10, sideX10, stressBps);
    }

    // ------------------------------------------------------------ house money

    function test_depositHouse_ownerOnly_anyTime_creditsNobody() public {
        address[5] memory notOwner = [stranger, guardian, marketKeeper, keeper, feeRecipient];
        for (uint256 i = 0; i < notOwner.length; i++) {
            usdc.mint(notOwner[i], 1e6);
            vm.startPrank(notOwner[i]);
            usdc.approve(address(ex), 1e6);
            vm.expectRevert(_unauthorized(notOwner[i]));
            ex.depositHouse(1e6);
            vm.stopPrank();
        }
        vm.prank(owner);
        vm.expectRevert(IExchangeTypes.ZeroAmount.selector);
        ex.depositHouse(0);

        // No pause gate: a global and a market pause leave house money alone.
        vm.startPrank(owner);
        ex.setGlobalOpensPaused(true);
        ex.setMarketOpensPaused(TIER_A, true);
        vm.stopPrank();
        usdc.mint(owner, 5e6);
        vm.startPrank(owner);
        usdc.approve(address(ex), 5e6);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.HouseDeposited(5e6, HOUSE + 5e6);
        ex.depositHouse(5e6);
        vm.stopPrank();
        assertEq(ex.lpBalance(), HOUSE + 5e6);
        assertEq(ex.houseFreeUsdc(), HOUSE + 5e6);
        assertEq(usdc.balanceOf(owner), 0); // pulled from the owner's wallet
        assertEq(ex.balanceOf(owner), 0); // credits nobody's trading balance
        assertEq(ex.feePool(), 0);
        _assertSolvent();
    }

    function test_withdrawHouse_ownerOnly_boundedByFreeCash_noPauseGate_nothingReservedForPositions() public {
        address[5] memory notOwner = [stranger, guardian, marketKeeper, keeper, feeRecipient];
        for (uint256 i = 0; i < notOwner.length; i++) {
            vm.prank(notOwner[i]);
            vm.expectRevert(_unauthorized(notOwner[i]));
            ex.withdrawHouse(1);
        }
        vm.startPrank(owner);
        vm.expectRevert(IExchangeTypes.ZeroAmount.selector);
        ex.withdrawHouse(0);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, HOUSE, HOUSE + 1));
        ex.withdrawHouse(HOUSE + 1);
        vm.stopPrank();

        // An open position reserves nothing: its stamped maximum profit is not owed.
        uint256 id = _open(alice, TIER_A, true, MARGIN, 1000);
        assertEq(ex.positions(id).maxProfitUsdc, 5_000e6);
        assertEq(ex.houseFreeUsdc(), HOUSE);

        // Paused or not, the owner takes any amount up to the free cash, to the owner's wallet.
        vm.startPrank(owner);
        ex.setGlobalOpensPaused(true);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.HouseWithdrawn(40_000e6, HOUSE - 40_000e6);
        ex.withdrawHouse(40_000e6);
        assertEq(usdc.balanceOf(owner), 40_000e6);
        ex.withdrawHouse(HOUSE - 40_000e6); // exactly the rest is accepted
        vm.stopPrank();
        assertEq(ex.lpBalance(), 0);
        assertEq(usdc.balanceOf(owner), HOUSE);

        // The position's win now finds an empty house and queues.
        _setPx(ASSET_A, 1_001_000);
        (, uint256 queued) = _close(alice, id);
        assertGt(queued, 0);
        assertEq(ex.queuedTotal(), queued);
        _assertSolvent();
    }

    /// @dev Fees already earned leave first: a withdrawal pushes the pool (when the queue is
    ///      empty), then measures the free cash.
    function test_withdrawHouse_pushesEarnedFeesFirst_whenQueueEmpty() public {
        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        _close(bob, id); // house +100, pool 5
        assertEq(ex.houseFreeUsdc(), HOUSE + 95e6);

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.FeesPushed(0, 5e6);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.HouseWithdrawn(1e6, HOUSE + 94e6);
        ex.withdrawHouse(1e6);
        assertEq(ex.feePool(), 0);
        assertEq(ex.balanceOf(feeRecipient), 5e6);
        assertEq(ex.lpBalance(), HOUSE + 94e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, HOUSE + 94e6, HOUSE + 94e6 + 1));
        ex.withdrawHouse(HOUSE + 94e6 + 1);

        // With nobody staked the stakers' 20% stays earmarked in the pool and stays owed.
        vm.prank(owner);
        ex.setStakerFeeShare(2000);
        staking.setTotalStaked(0);
        _setPx(ASSET_A, RAW_ONE);
        id = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        _close(carol, id); // pool 5
        vm.prank(owner);
        ex.withdrawHouse(1e6);
        assertEq(ex.feePool(), 1e6);
        assertEq(ex.balanceOf(feeRecipient), 5e6 + 4e6);
        assertEq(ex.houseFreeUsdc(), ex.lpBalance() - 1e6);
        _assertSolvent();
    }

    /// @dev While the queue is owed nothing is pushed and the owed cash stays locked; free
    ///      cash is floored at 0 when the house holds less than it owes.
    function test_withdrawHouse_whileQueueActive_owedCashLocked_freeFlooredAtZero() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _drainHouse();
        _setPx(ASSET_A, 1_050_000);
        _close(alice, id); // queued 42.472516, pool 2.235395, house 0
        assertEq(ex.houseFreeUsdc(), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 0, 1));
        ex.withdrawHouse(1);

        // $10 in: the house holds less than it owes, free stays 0 (floored, no underflow).
        _depositHouse(10e6);
        assertEq(ex.lpBalance(), 10e6);
        assertEq(ex.houseFreeUsdc(), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 0, 1));
        ex.withdrawHouse(1);

        // $90 more: free = 100 - 42.472516 - 2.235395 = 55.292089, to the unit.
        _depositHouse(90e6);
        assertEq(ex.houseFreeUsdc(), 55_292_089);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 55_292_089, 55_292_090));
        ex.withdrawHouse(55_292_090);
        vm.prank(owner);
        ex.withdrawHouse(55_292_089);
        // No push while the queue is owed: the pool and the queue are intact and covered.
        assertEq(ex.feePool(), 2_235_395);
        assertEq(ex.queuedTotal(), 42_472_516);
        assertEq(ex.lpBalance(), 42_472_516 + 2_235_395);
        assertEq(ex.houseFreeUsdc(), 0);
        ex.harvest(10);
        assertEq(ex.balanceOf(alice), 1000e6 + 42_472_516);
        ex.pushFees();
        assertEq(ex.lpBalance(), 0);
        _assertSolvent();
    }

    // ------------------------------------------------------ house-sized limits

    function test_posX10_capsEachPositionAtAMultipleOfFreeCash() public {
        _tightHouse(10_000e6);
        vm.prank(marketKeeper);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.HouseSizingSet(TIER_A, 50, 500, 10);
        ex.setHouseSizing(TIER_A, 50, 500, 10);
        // 5x of $10K free = $50K, under the $100K static cap.
        uint256 maxPos = ex.maxPositionUsd(TIER_A, true);
        assertLe(maxPos, 50_000e6);
        assertGt(maxPos, 49_000e6);

        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        ex.requestOpen(TIER_A, true, 50e6 + 1, 1000, address(0));
        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        ex.requestOpen(TIER_A, false, 50e6 + 1, 1000, address(0));
        _open(alice, TIER_A, true, 50e6, 1000); // exactly 5x is accepted

        // The cap follows free cash in the same block: $2K more lifts it to $60K.
        _depositHouse(2_000e6);
        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        ex.requestOpen(TIER_A, false, 60e6 + 1, 1000, address(0));
        _open(bob, TIER_A, false, 60e6, 1000);
        // The static cap stays a ceiling: at 20x of $12K the $100K static cap binds.
        _sizing(TIER_A, 200, 500, 10);
        assertEq(ex.maxPositionUsd(TIER_A, true), 100_000e6);
        _assertSolvent();
    }

    function test_sideX10_capsEachSideAtAMultipleOfFreeCash() public {
        _tightHouse(10_000e6);
        _sizing(TIER_A, 200, 20, 10); // a side may hold 2x free cash = $20K
        _open(alice, TIER_A, true, 10e6, 1000);
        uint256 bid = _open(bob, TIER_A, true, 10e6, 1000); // the side at exactly $20K
        vm.prank(carol);
        vm.expectRevert(IExchangeTypes.OiCapExceeded.selector);
        ex.requestOpen(TIER_A, true, 5e6, 1, address(0));
        // The short side is independent.
        _open(carol, TIER_A, false, 20e6, 1000);
        vm.prank(dave);
        vm.expectRevert(IExchangeTypes.OiCapExceeded.selector);
        ex.requestOpen(TIER_A, false, 5e6, 1, address(0));
        assertEq(ex.instrument(TIER_A).longOiCapUsd, 250_000e6); // the static cap is far above
        // A close frees headroom.
        _close(bob, bid);
        _open(dave, TIER_A, true, 5e6, 1);
        _assertSolvent();
    }

    /// @dev Book exposure: per market max(long OI, short OI) x stress x (1 - base rate), summed
    ///      over markets, at most free cash x rhoBps.
    function test_rhoBps_capsBookExposureAcrossMarkets_maxOfLongAndShort() public {
        _tightHouse(10_000e6);
        _sizing(TIER_A, 200, 500, 1000); // stress 10%: a market's term is 0.09 x its larger side
        _sizing(TIER_B, 200, 500, 1000);
        assertEq(ex.rhoBps(), 2000); // limit 20% x 10,000 = 2,000

        _open(alice, TIER_A, true, 10e6, 1000); // $10K long: term 900
        assertEq(ex.houseExposureUsdc(), 900e6);
        uint256 bid = _open(bob, TIER_A, false, 10e6, 1000); // a hedge: max(10K, 10K) unchanged
        assertEq(ex.houseExposureUsdc(), 900e6);
        _open(carol, TIER_B, true, 48e6, 250); // $12K: term 1,080, book 1,980
        assertEq(ex.houseExposureUsdc(), 1_980e6);
        // $300 more on B would make 1,107 + 900 = 2,007 > 2,000.
        vm.prank(dave);
        vm.expectRevert(IExchangeTypes.HouseExposureExceeded.selector);
        ex.requestOpen(TIER_B, true, 5e6, 60, address(0));
        _open(dave, TIER_B, true, 5e6, 40); // $200: 1,098 + 900 = 1,998
        assertEq(ex.houseExposureUsdc(), 1_998e6);

        // Closing the hedge leaves A's term (the long side) alone.
        _close(bob, bid);
        assertEq(ex.houseExposureUsdc(), 1_998e6);
        // A stress change refreshes the market's term: B at 10 bps = 12,200 x 0.0009 = 10.98.
        _sizing(TIER_B, 200, 500, 10);
        assertEq(ex.houseExposureUsdc(), 900e6 + 10_980_000);
        // So does a base-rate change: B at 20% = 12,200 x 0.001 x 0.8 = 9.76.
        vm.prank(owner);
        ex.setInstrumentParams(TIER_B, 3, 25, 2000, 15_000, 20_000e6, 130_000_000e6);
        assertEq(ex.houseExposureUsdc(), 900e6 + 9_760_000);

        // The owner moves rho within 500..10000.
        vm.prank(marketKeeper);
        vm.expectRevert(_unauthorized(marketKeeper));
        ex.setRhoBps(5000);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.RhoBps, 499));
        ex.setRhoBps(499);
        vm.expectRevert(_oob(IExchangeTypes.Param.RhoBps, 10_001));
        ex.setRhoBps(10_001);
        ex.setRhoBps(10_000);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.RhoBpsSet(1000);
        ex.setRhoBps(1000);
        vm.stopPrank();
        assertEq(ex.rhoBps(), 1000);
        // At 10% the limit is 1,000 < 909.76 + 0.09 x 1,200: a $1,200 long on A is refused.
        vm.prank(dave);
        vm.expectRevert(IExchangeTypes.HouseExposureExceeded.selector);
        ex.requestOpen(TIER_A, true, 12e6, 100, address(0));
        _assertSolvent();
    }

    /// @dev Every house-sized rule is re-run at the fill against the free cash then; a request
    ///      that no longer fits is refunded with the rule's selector.
    function test_houseLimits_recheckedAtFill_refundWhenNoLongerFits() public {
        _tightHouse(10_000e6);

        // Position cap: 5x of 10,000 = 50K at the request; the owner then takes 7,000 out,
        // 5x of 3,000 = 15K < 20K at the fill.
        _sizing(TIER_A, 50, 500, 10);
        uint256 req = _requestOpen(alice, TIER_A, true, 20e6, 1000);
        vm.prank(owner);
        ex.withdrawHouse(7_000e6);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.PositionTooLarge.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        _depositHouse(7_000e6);

        // Side cap: two $6K longs both fit a $10K side at request time; the first fill takes
        // the room and the second is refunded.
        _sizing(TIER_A, 200, 10, 10);
        uint256 ra = _requestOpen(alice, TIER_A, true, 6e6, 1000);
        uint256 rb = _requestOpen(bob, TIER_A, true, 6e6, 1000);
        _tick();
        vm.prank(keeper);
        assertGt(ex.executeOpen(ra), 0);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(rb, bob, IExchangeTypes.OiCapExceeded.selector);
        assertEq(ex.executeOpen(rb), 0);
        assertEq(ex.balanceOf(bob), 1000e6);

        // Book exposure: stress 10% makes alice's $6K a 540 term; a $20K more would be 2,340
        // > 2,000 and is refused at the request; $15K (1,890) is accepted, then the owner takes
        // 1,000 out and the limit (1,800) no longer covers it at the fill.
        _sizing(TIER_A, 200, 500, 1000);
        assertEq(ex.houseExposureUsdc(), 540e6);
        vm.prank(carol);
        vm.expectRevert(IExchangeTypes.HouseExposureExceeded.selector);
        ex.requestOpen(TIER_A, true, 20e6, 1000, address(0));
        req = _requestOpen(carol, TIER_A, true, 15e6, 1000);
        vm.prank(owner);
        ex.withdrawHouse(1_000e6);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, carol, IExchangeTypes.HouseExposureExceeded.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(carol), 1000e6);
        assertEq(ex.pendingOf(carol), 0);
        _assertSolvent();
    }

    /// @dev The sizing setters: market keeper or owner, bounds 10..200 / 10..500 / 10..5000,
    ///      checked in that order, also on addInstrument.
    function test_setHouseSizing_marketKeeperOrOwner_bounds() public {
        address[3] memory refused = [stranger, guardian, keeper];
        for (uint256 i = 0; i < refused.length; i++) {
            vm.prank(refused[i]);
            vm.expectRevert(IExchangeTypes.Unauthorized.selector);
            ex.setHouseSizing(TIER_A, 50, 100, 1000);
        }
        vm.startPrank(marketKeeper);
        vm.expectRevert(_oob(IExchangeTypes.Param.PosX10, 9));
        ex.setHouseSizing(TIER_A, 9, 100, 1000);
        vm.expectRevert(_oob(IExchangeTypes.Param.PosX10, 201));
        ex.setHouseSizing(TIER_A, 201, 100, 1000);
        vm.expectRevert(_oob(IExchangeTypes.Param.PosX10, 9));
        ex.setHouseSizing(TIER_A, 9, 9, 9); // the first failing bound is reported
        vm.expectRevert(_oob(IExchangeTypes.Param.SideX10, 9));
        ex.setHouseSizing(TIER_A, 50, 9, 1000);
        vm.expectRevert(_oob(IExchangeTypes.Param.SideX10, 501));
        ex.setHouseSizing(TIER_A, 50, 501, 1000);
        vm.expectRevert(_oob(IExchangeTypes.Param.StressBps, 9));
        ex.setHouseSizing(TIER_A, 50, 100, 9);
        vm.expectRevert(_oob(IExchangeTypes.Param.StressBps, 5001));
        ex.setHouseSizing(TIER_A, 50, 100, 5001);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.setHouseSizing(9, 50, 100, 1000);
        ex.setHouseSizing(TIER_A, 10, 10, 10); // the low edges
        ex.setHouseSizing(TIER_A, 200, 500, 5000); // the high edges
        vm.stopPrank();
        IExchangeTypes.Instrument memory inst = ex.instrument(TIER_A);
        assertEq(inst.posX10, 200);
        assertEq(inst.sideX10, 500);
        assertEq(inst.stressBps, 5000);
        vm.prank(owner);
        ex.setHouseSizing(TIER_A, 50, 100, 1000);

        IExchangeTypes.Instrument memory spec = _spec(0, 165, 1, 10, 1e6);
        spec.posX10 = 201;
        vm.prank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.PosX10, 201));
        ex.addInstrument(spec);
        spec.posX10 = 200;
        spec.sideX10 = 9;
        vm.prank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.SideX10, 9));
        ex.addInstrument(spec);
        spec.sideX10 = 500;
        spec.stressBps = 5001;
        vm.prank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.StressBps, 5001));
        ex.addInstrument(spec);
    }

    // ------------------------------------------------------ stamped max profit

    /// @dev Each position's maximum profit is stamped at the fill: min(margin x payoutCapX,
    ///      free cash x maxWinBps), and a later change in house cash never moves it.
    function test_maxProfit_stampedAtFillFromFreeCash_payoutCapped() public {
        _tightHouse(10_000e6);
        uint256 aid = _open(alice, TIER_A, true, MARGIN, 1000);
        // min(100 x 50, 25% x 10,000) = 2,500.
        assertEq(ex.positions(aid).maxProfitUsdc, 2_500e6);
        // Requested at $10K free, filled after a deposit: stamped on the cash at the fill.
        uint256 req = _requestOpen(bob, TIER_A, true, MARGIN, 1000);
        _depositHouse(90_000e6);
        uint256 bid = _executeOpen(req);
        assertEq(ex.positions(bid).maxProfitUsdc, 5_000e6); // min(5,000, 25% x 100,000)
        assertEq(ex.positions(aid).maxProfitUsdc, 2_500e6); // untouched by the deposit
        assertEq(ex.openMaxPayoutUsdc(), 7_500e6);

        // +10%: about 8,970 adjusted on each; alice is capped at 2,500, bob at 5,000.
        _setPx(ASSET_A, 1_100_000);
        uint256 exit = ImpactLib.deadbandExit(1.1e18, true, 1);
        (uint256 gain, uint256 move) = ImpactLib.rawGain(100_000e6, ONE, exit, true);
        uint256 uncapped = ImpactLib.adjustedGain(gain, move, _launchCurve());
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(aid);
        assertEq(pnl, 2_375e6); // 2,500 less 5%
        assertEq(fee, 125e6);
        assertEq(payout, MARGIN + 2_375e6);
        _requestClose(alice, aid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.PayoutCapped(aid, 2_500e6, uncapped - 2_500e6);
        (uint256 paid,) = ex.executeClose(aid);
        assertEq(paid, MARGIN + 2_375e6);
        (paid,) = _close(bob, bid);
        assertEq(paid, MARGIN + 4_750e6);
        assertEq(ex.openMaxPayoutUsdc(), 0);

        // The owner moves maxWinBps within 500..5000; a new open stamps the new share:
        // free = 100,000 - 2,375 - 4,750 - 375 pool = 92,500; 5% of it = 4,625 < 5,000.
        vm.prank(marketKeeper);
        vm.expectRevert(_unauthorized(marketKeeper));
        ex.setMaxWinBps(500);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxWinBps, 499));
        ex.setMaxWinBps(499);
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxWinBps, 5001));
        ex.setMaxWinBps(5001);
        ex.setMaxWinBps(5000);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.MaxWinBpsSet(500);
        ex.setMaxWinBps(500);
        vm.stopPrank();
        _setPx(ASSET_A, RAW_ONE);
        assertEq(ex.houseFreeUsdc(), 92_500e6);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, 1000);
        assertEq(ex.positions(cid).maxProfitUsdc, 4_625e6);
        _assertSolvent();
    }

    // ----------------------------------------------------------- entry spread

    function test_entrySpread_longUpShortDown_bustFromRawPrint_houseKeepsIt() public {
        vm.startPrank(owner);
        ex.setFeeBps(750, 0);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.MarketFeesSet(TIER_A, 10, 0);
        ex.setMarketFees(TIER_A, 10, 0);
        vm.stopPrank();

        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionOpened(1, alice, TIER_A, true, MARGIN, LEV, 1.001e18, req, true);
        uint256 lid = ex.executeOpen(req);
        IExchangeTypes.Position memory p = ex.positions(lid);
        assertEq(p.entryPx18, 1.001e18);
        assertEq(p.entryDeadbandBps, 10);
        assertEq(ex.instrument(TIER_A).lastPx18, ONE); // the raw print, not the spread entry
        assertEq(ex.bustPrice(lid), 0.905e18); // from the raw 1.000
        uint256 sid = _open(bob, TIER_A, false, MARGIN, LEV);
        assertEq(ex.positions(sid).entryPx18, 0.999e18);
        assertEq(ex.bustPrice(sid), 1.095e18);

        // Flat print: both sides pay the spread, rounded up. Long: 1000 x 0.001 / 1.001 =
        // 0.999000999 -> 0.999001; short: 1000 x 0.001 / 0.999 = 1.001001001 -> 1.001002.
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(lid);
        assertEq(pnl, -999_001);
        assertEq(fee, 0);
        assertEq(payout, 99_000_999);
        _closePays(lid, alice, 99_000_999);
        (pnl,, payout) = ex.previewClose(sid);
        assertEq(pnl, -1_001_002);
        assertEq(payout, 98_998_998);
        _closePays(sid, bob, 98_998_998);
        // The spread is the house's own take: it lands in house cash, not the fee pool.
        assertEq(ex.lpBalance(), HOUSE + 999_001 + 1_001_002);
        assertEq(ex.feePool(), 0);

        // The liquidation point is the raw print's: 0.905 for a 10x long entered at 1.001.
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 905_001);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, cid, 905_001e12, 0.905e18));
        ex.liquidate(cid);
        _setPx(ASSET_A, 905_000);
        vm.prank(liquidator);
        ex.liquidate(cid);
        _setPx(ASSET_A, RAW_ONE);

        // A later change leaves a stamped position alone; a new one takes the new spread.
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        vm.prank(owner);
        ex.setMarketFees(TIER_A, 50, 0);
        assertEq(ex.positions(did).entryDeadbandBps, 10);
        assertEq(ex.bustPrice(did), 0.905e18);
        uint256 eid = _open(alice, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(eid).entryPx18, 1.005e18);
        assertEq(ex.bustPrice(eid), 0.905e18);

        // A win is measured from the spread entry: dave at 1.001 closing at 1.01.
        _setPx(ASSET_A, 1_010_000);
        uint256 exit = ImpactLib.deadbandExit(1.01e18, true, 1);
        (uint256 gain, uint256 move) = ImpactLib.rawGain(1000e6, 1.001e18, exit, true);
        uint256 adjusted = ImpactLib.adjustedGain(gain, move, _launchCurve());
        uint256 winFee = ImpactLib.winFee(adjusted, 750);
        (pnl, fee,) = ex.previewClose(did);
        assertEq(pnl, int256(adjusted - winFee));
        assertEq(fee, winFee);
        assertLt(pnl, 8_061_341); // less than the same move from a raw 1.000 entry
        (uint256 paid,) = _close(dave, did);
        assertEq(paid, MARGIN + adjusted - winFee);
        _assertSolvent();
    }

    function _closePays(uint256 id, address who, uint256 expected) internal {
        (uint256 paid,) = _close(who, id);
        assertEq(paid, expected);
    }

    function test_setMarketFees_ownerOnly_bounds() public {
        address[3] memory refused = [marketKeeper, guardian, stranger];
        for (uint256 i = 0; i < refused.length; i++) {
            vm.prank(refused[i]);
            vm.expectRevert(_unauthorized(refused[i]));
            ex.setMarketFees(TIER_A, 1, 1);
        }
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.EntryDeadbandBps, 51));
        ex.setMarketFees(TIER_A, 51, 0);
        vm.expectRevert(_oob(IExchangeTypes.Param.BorrowRateX10, 51));
        ex.setMarketFees(TIER_A, 0, 51);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.setMarketFees(9, 0, 0);
        ex.setMarketFees(TIER_A, 50, 50);
        assertEq(ex.instrument(TIER_A).entryDeadbandBps, 50);
        assertEq(ex.instrument(TIER_A).borrowRateX10, 50);
        ex.setMarketFees(TIER_A, 0, 0);
        IExchangeTypes.Instrument memory spec = _spec(0, 165, 1, 10, 1e6);
        spec.entryDeadbandBps = 51;
        vm.expectRevert(_oob(IExchangeTypes.Param.EntryDeadbandBps, 51));
        ex.addInstrument(spec);
        spec.entryDeadbandBps = 50;
        spec.borrowRateX10 = 51;
        vm.expectRevert(_oob(IExchangeTypes.Param.BorrowRateX10, 51));
        ex.addInstrument(spec);
        vm.stopPrank();
    }

    // ------------------------------------------------------- split fee rates

    /// @dev The v4 defaults: 7.5% on a win's adjusted gain, nothing on a loss or a liquidation.
    function test_feeSplit_winFeeOnWinsOnly_lossFeeOnLossesOnly() public {
        vm.prank(owner);
        ex.setFeeBps(750, 0);
        uint256 early = _open(bob, TIER_B, true, MARGIN, LEV); // stamped at loss fee 0

        // Full loss: no fee, the whole $100 stays with the house.
        uint256 id = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        _close(carol, id);
        assertEq(ex.feePool(), 0);
        assertEq(ex.lpBalance(), HOUSE + 100e6);
        assertEq(_windowNet(), -100e6);
        _setPx(ASSET_A, RAW_ONE);

        // Win: 7.5% x 8.714963 = 0.65362222 -> 0.653622; profit 8.061341.
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(id, alice, 1.01e18, 8_061_341, 653_622, 108_061_341, 0, 0, true);
        ex.executeClose(id);
        assertEq(ex.feePool(), 653_622);
        _setPx(ASSET_A, RAW_ONE);

        // Liquidation: the bounty only.
        id = _open(dave, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionLiquidated(id, dave, liquidator, 0.9e18, MARGIN, 500_000, 0);
        ex.liquidate(id);
        assertEq(ex.feePool(), 653_622);
        _setPx(ASSET_A, RAW_ONE);

        // The owner turns the loss fee on: new positions carve 5% of a loss, bob's earlier
        // stamp of 0 holds.
        vm.prank(owner);
        ex.setFeeBps(750, 500);
        id = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _close(carol, id);
        assertEq(ex.feePool(), 653_622 + 250_000);
        _setPx(ASSET_B, 995_000);
        _close(bob, early);
        assertEq(ex.feePool(), 653_622 + 250_000);
        _assertSolvent();
    }

    /// @dev Only the loss side waits on the queue: a win is charged its fee while the queue is
    ///      owed, and the fee joins the pool behind the queue.
    function test_winFee_carvedEvenWhileQueueActive() public {
        vm.prank(owner);
        ex.setFeeBps(750, 0);
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 bid = _open(bob, TIER_A, true, MARGIN, LEV);
        _drainHouse();
        // 5%: adjusted 44.707911, fee 7.5% = 3.353093, profit 41.354818 queued.
        _setPx(ASSET_A, 1_050_000);
        (, uint256 queued) = _close(alice, aid);
        assertEq(queued, 41_354_818);
        assertEq(ex.feePool(), 3_353_093);
        // 2% while the queue is owed: adjusted 17.711913, fee 1.328393, profit 16.383520.
        _setPx(ASSET_A, 1_020_000);
        (, queued) = _close(bob, bid);
        assertEq(queued, 16_383_520);
        assertEq(ex.feePool(), 3_353_093 + 1_328_393);
        vm.expectRevert(IExchangeTypes.NothingToPush.selector);
        ex.pushFees();
        _assertSolvent();
    }

    // ------------------------------------------------------------------ borrow

    /// @dev 0.5 bps of notional per whole hour beyond the first: nothing inside the free hour
    ///      or the first part hour after it; taken from the payout at close, kept by the house.
    function test_borrow_wholeHoursBeyondFree_takenFromPayout_keptByHouse() public {
        vm.prank(owner);
        ex.setMarketFees(TIER_A, 0, 5);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV); // $1000 notional: 0.05 per hour
        IExchangeTypes.Position memory p = ex.positions(id);
        assertEq(p.borrowRateX10, 5);
        assertEq(p.borrowFreeHours, 1);
        uint256 t = p.openedAt;
        assertEq(ex.borrowOwed(id), 0);
        vm.warp(t + 1 hours);
        assertEq(ex.borrowOwed(id), 0); // inside the free hour
        vm.warp(t + 2 hours - 1);
        assertEq(ex.borrowOwed(id), 0); // inside the first part hour beyond it
        vm.warp(t + 2 hours);
        assertEq(ex.borrowOwed(id), 50_000);
        vm.warp(t + 3 hours - 1);
        assertEq(ex.borrowOwed(id), 50_000);
        vm.warp(t + 3 hours);
        assertEq(ex.borrowOwed(id), 100_000);

        // Flat close, filled 5 s later (still 2 whole hours beyond the free one).
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(id);
        assertEq(pnl, 0);
        assertEq(fee, 0);
        assertEq(payout, MARGIN - 100_000);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(id, alice, ONE, 0, 0, MARGIN - 100_000, 0, 100_000, true);
        (uint256 paid,) = ex.executeClose(id);
        assertEq(paid, MARGIN - 100_000);
        assertEq(ex.lpBalance(), HOUSE + 100_000); // house cash, not the fee pool
        assertEq(ex.feePool(), 0);
        assertEq(_windowNet(), 0); // and not the breaker
        assertEq(ex.balanceOf(alice), 1000e6 - 100_000);

        // On a win it comes out of the payout too: bob held 2 hours, one charged.
        id = _open(bob, TIER_A, true, MARGIN, LEV);
        uint256 t2 = ex.positions(id).openedAt;
        vm.warp(t2 + 2 hours);
        _setPx(ASSET_A, 1_010_000);
        _requestClose(bob, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(id, bob, 1.01e18, 8_279_215, 435_748, 108_279_215 - 50_000, 0, 50_000, true);
        (paid,) = ex.executeClose(id);
        assertEq(paid, 108_279_215 - 50_000);
        _assertSolvent();
    }

    function test_borrow_cappedAtPayout_noneOnLiquidation_termsStamped_bounds() public {
        vm.startPrank(owner);
        ex.setFeeBps(750, 0);
        ex.setMarketFees(TIER_A, 0, 50); // 5 bps/h: $0.50 an hour on $1000
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.BorrowFreeHoursSet(0);
        ex.setBorrowFreeHours(0);
        vm.stopPrank();
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 bid = _open(bob, TIER_A, true, MARGIN, LEV);
        uint256 t = ex.positions(aid).openedAt;

        // 100 hours later, a 9% drop: loss 90, payout 10; the borrow ($50) is capped at 10.
        vm.warp(t + 100 hours);
        _setPx(ASSET_A, 910_000);
        assertEq(ex.borrowOwed(aid), 50e6);
        (,, uint256 payout) = ex.previewClose(aid);
        assertEq(payout, 0);
        _requestClose(alice, aid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(aid, alice, 0.91e18, -90e6, 0, 0, 0, 10e6, true);
        (uint256 paid,) = ex.executeClose(aid);
        assertEq(paid, 0);
        assertEq(ex.lpBalance(), HOUSE + 100e6);

        // A liquidation forfeits the margin; no borrow is charged on top.
        assertGt(ex.borrowOwed(bid), 0);
        _setPx(ASSET_A, 900_000);
        uint256 lpBefore = ex.lpBalance();
        vm.prank(liquidator);
        assertEq(ex.liquidate(bid), 500_000);
        assertEq(ex.lpBalance(), lpBefore + 99_500_000);
        _setPx(ASSET_A, RAW_ONE);

        // The rate and the free hours are stamped: carol opens at 50 / 0, the owner then
        // switches to 0 / 24 and carol still owes her hour.
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        uint256 tc = ex.positions(cid).openedAt;
        vm.startPrank(owner);
        ex.setMarketFees(TIER_A, 0, 0);
        ex.setBorrowFreeHours(24);
        vm.stopPrank();
        vm.warp(tc + 1 hours);
        assertEq(ex.borrowOwed(cid), 500_000);
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV); // rate 0: never owes
        vm.warp(vm.getBlockTimestamp() + 100 hours);
        assertEq(ex.borrowOwed(did), 0);
        // 0.5 bps/h with 24 free hours: nothing until the 25th hour.
        vm.prank(owner);
        ex.setMarketFees(TIER_A, 0, 5);
        uint256 eid = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 te = ex.positions(eid).openedAt;
        assertEq(ex.positions(eid).borrowFreeHours, 24);
        vm.warp(te + 25 hours - 1);
        assertEq(ex.borrowOwed(eid), 0);
        vm.warp(te + 25 hours);
        assertEq(ex.borrowOwed(eid), 50_000);

        // Bounds: owner only, 0..24.
        vm.prank(marketKeeper);
        vm.expectRevert(_unauthorized(marketKeeper));
        ex.setBorrowFreeHours(2);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.BorrowFreeHours, 25));
        ex.setBorrowFreeHours(25);
        ex.setBorrowFreeHours(24);
        ex.setBorrowFreeHours(0);
        vm.stopPrank();
        assertEq(ex.borrowFreeHours(), 0);
        _assertSolvent();
    }

    // ------------------------------------------------------------- house wallets

    function test_houseWallet_winBeyondSpotCashForfeited_neverQueued() public {
        address[3] memory refused = [stranger, guardian, marketKeeper];
        for (uint256 i = 0; i < refused.length; i++) {
            vm.prank(refused[i]);
            vm.expectRevert(_unauthorized(refused[i]));
            ex.setHouseWallet(alice, true);
        }
        vm.startPrank(owner);
        vm.expectRevert(IExchangeTypes.ZeroAddress.selector);
        ex.setHouseWallet(address(0), true);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.HouseWalletSet(alice, true);
        ex.setHouseWallet(alice, true);
        vm.stopPrank();
        assertTrue(ex.isHouseWallet(alice));
        assertFalse(ex.isHouseWallet(bob));

        uint256 a1 = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 a2 = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 b = _open(bob, TIER_A, true, MARGIN, LEV);
        uint256 c = _open(carol, TIER_B, true, MARGIN, LEV);
        _drainHouse();
        // carol's 1% loss leaves $10 of cash (pool 0.5).
        _setPx(ASSET_B, 990_000);
        _close(carol, c);
        assertEq(ex.lpBalance(), 10e6);
        int256 netBefore = _windowNet();

        // alice (house) wins 5%: adjusted 44.707911 is cut to the free cash, 10 - 0.5 pool =
        // 9.5, before the fee (0.475): she gets 9.025, the rest is forfeited, and the house is
        // left holding exactly what it owes (the pool).
        _setPx(ASSET_A, 1_050_000);
        _requestClose(alice, a1);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.HouseWinForfeited(a1, 44_707_911 - 9_500_000);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(a1, alice, 1.05e18, 9_025_000, 475_000, MARGIN + 9_025_000, 0, 0, true);
        (uint256 paid, uint256 queued) = ex.executeClose(a1);
        assertEq(paid, MARGIN + 9_025_000);
        assertEq(queued, 0);
        assertEq(ex.queueLength(), 0);
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.lpBalance(), 975_000);
        assertEq(ex.feePool(), 975_000);
        assertEq(ex.houseFreeUsdc(), 0);
        // The breaker counts the 9.5 the house gave up (paid plus fee), not the forfeit.
        assertEq(_windowNet() - netBefore, 9_500_000);

        // bob, a trader, wins the same: the 0.975 of cash on the spot, the rest queued.
        _requestClose(bob, b);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.QueueAppended(0, bob, 42_472_516 - 975_000);
        (, queued) = ex.executeClose(b);
        assertEq(queued, 42_472_516 - 975_000);

        // While a trader is queued the house wallet gets nothing: the whole gain is forfeited.
        _requestClose(alice, a2);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.HouseWinForfeited(a2, 44_707_911);
        (paid, queued) = ex.executeClose(a2);
        assertEq(paid, MARGIN);
        assertEq(queued, 0);
        assertEq(ex.queueLength(), 1);
        assertEq(ex.queuedTotal(), 42_472_516 - 975_000);

        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.HouseWalletSet(alice, false);
        ex.setHouseWallet(alice, false);
        assertFalse(ex.isHouseWallet(alice));
        _assertSolvent();
    }

    function test_houseWallet_locksNoReferrer_paysNoReferrer() public {
        vm.prank(carol);
        refs.registerCode("carol");
        vm.prank(owner);
        ex.setHouseWallet(alice, true);
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        uint256 id = _executeOpen(req);
        assertFalse(refs.referrerLocked(alice));
        _setPx(ASSET_A, 995_000);
        _close(alice, id);
        assertEq(ex.feePool(), 250_000); // the whole fee pooled
        assertEq(ex.balanceOf(carol), 1000e6);
        assertEq(refs.referralEarned(carol), 0);

        // Unlisted, alice's next open is her first referred one: carol earns from then on.
        vm.prank(owner);
        ex.setHouseWallet(alice, false);
        _setPx(ASSET_A, RAW_ONE);
        vm.prank(alice);
        req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        id = _executeOpen(req);
        assertEq(refs.referrerOf(alice), carol);
        _setPx(ASSET_A, 995_000);
        _close(alice, id);
        assertEq(ex.balanceOf(carol), 1000e6 + 37_500);
        _assertSolvent();
    }

    // ------------------------------------------------------------------ breaker

    /// @dev A fresh core trips at its default 25% without any configuration.
    function test_breaker_defaultOn_tripsWithoutConfiguration() public {
        PriceOracle o2 = new PriceOracle(source, address(this));
        ExchangeExt e2 = new ExchangeExt(usdc, o2, IStaking(address(staking)), owner);
        Exchange c2 = new Exchange(usdc, o2, IStaking(address(staking)), e2, IReferrals(address(0)), owner, feeRecipient);
        IExchange x = IExchange(address(c2));
        o2.setRegistrar(address(c2));
        vm.startPrank(owner);
        x.setKeeper(keeper, true);
        x.addInstrument(_spec(0, ASSET_A, 1, 10, 250_000e6));
        vm.stopPrank();
        assertEq(x.breakerBps(), 2500);
        usdc.mint(owner, 1_000e6);
        vm.startPrank(owner);
        usdc.approve(address(x), 1_000e6);
        x.depositHouse(1_000e6);
        vm.stopPrank();
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(x), 100e6);
        x.deposit(100e6);
        uint256 r1 = x.requestOpen(0, true, 10e6, 1000, address(0));
        uint256 r2 = x.requestOpen(0, true, 10e6, 1000, address(0));
        vm.stopPrank();
        _tick();
        vm.startPrank(keeper);
        uint256 p1 = x.executeOpen(r1);
        uint256 p2 = x.executeOpen(r2);
        vm.stopPrank();
        // Each is stamped at min(10 x 50, 25% x 1,000) = 250.
        assertEq(x.positions(p1).maxProfitUsdc, 250e6);

        // +5%: each capped at 250. The first takes the hour to 250 = 25% of 1,000 (not over);
        // the second to 500, over: the breaker trips.
        _setPx(ASSET_A, 1_050_000);
        vm.startPrank(alice);
        x.requestClose(p1);
        x.requestClose(p2);
        vm.stopPrank();
        _tick();
        vm.prank(keeper);
        x.executeClose(p1);
        assertFalse(x.breakerTripped());
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.LpBreakerTripped(500e6, 250e6, 1_000e6);
        x.executeClose(p2);
        assertTrue(x.breakerTripped());
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.OpensPausedByBreaker.selector);
        x.requestOpen(0, true, 10e6, 1, address(0));
        _setPx(ASSET_A, RAW_ONE);
    }

    // ------------------------------------------------------------- retireDead

    /// @dev A liquidation is a settlement print too: a dead market retires at it.
    function test_retireDead_freezesAtTheLastLiquidationPrint() public {
        uint256 bid = _open(bob, TIER_B, true, MARGIN, LEV);
        uint256 aid = _open(alice, TIER_B, true, MARGIN, 100);
        assertEq(ex.instrument(TIER_B).lastPx18, ONE);
        _setPx(ASSET_B, 950_000);
        vm.prank(liquidator);
        ex.liquidate(aid);
        assertEq(ex.instrument(TIER_B).lastPx18, 0.95e18);
        source.setReverts(true, true);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.InstrumentRetired(TIER_B, 0.95e18);
        ex.retireDead(TIER_B);
        // bob settles at the frozen 0.95: loss 50.
        (uint256 paid,) = _close(bob, bid);
        assertEq(paid, 50e6);
        assertEq(ex.instrument(TIER_B).lastPx18, 0.95e18);
        _assertSolvent();
    }

    // -------------------------------------------------------------- keeperFill

    /// @dev `keeperFill` is true only for a fill keeper inside the grace window; the same
    ///      keeper one second later fills at the trader-worse price and the flag is false.
    function test_keeperFill_flagOnlyInsideTheKeeperWindow() public {
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE - 1);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionOpened(1, alice, TIER_A, true, MARGIN, LEV, ONE, req, true);
        ex.executeOpen(req);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionOpened(2, alice, TIER_A, true, MARGIN, LEV, ONE, req, false);
        ex.executeOpen(req);

        _requestClose(alice, 1);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE - 1);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(1, alice, ONE, 0, 0, MARGIN, 0, 0, true);
        ex.executeClose(1);
        _requestClose(alice, 2);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(2, alice, ONE, 0, 0, MARGIN, 0, 0, false);
        ex.executeClose(2);
    }

    // ---------------------------------------------------------- role separation

    /// @dev The guardian can only pause; the market keeper only moves OI caps and sizing; the
    ///      fill keeper only fills in its window; retire, clearBreaker, resumes, house money and
    ///      every other setter are the owner's.
    function test_roles_eachRoleOnlyItsLane() public {
        // Guardian: pauses, nothing else.
        vm.startPrank(guardian);
        ex.setMarketOpensPaused(TIER_C, true);
        ex.setGlobalOpensPaused(true);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setGlobalOpensPaused(false);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setMarketOpensPaused(TIER_C, false);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setOiCaps(TIER_A, 1, 1);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setHouseSizing(TIER_A, 50, 100, 1000);
        vm.stopPrank();
        _ownerOnlyRefuses(guardian);
        vm.prank(owner);
        ex.setGlobalOpensPaused(false);

        // Market keeper: OI caps and house sizing; no pause, no fill.
        vm.startPrank(marketKeeper);
        ex.setOiCaps(TIER_A, 200_000e6, 200_000e6);
        ex.setHouseSizing(TIER_A, 100, 200, 100);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setGlobalOpensPaused(true);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setMarketOpensPaused(TIER_A, true);
        vm.stopPrank();
        _ownerOnlyRefuses(marketKeeper);
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _tick();
        vm.prank(marketKeeper);
        vm.expectRevert(IExchangeTypes.KeeperWindow.selector);
        ex.executeOpen(req);

        // Fill keeper: fills; no pause, no caps.
        vm.prank(keeper);
        assertGt(ex.executeOpen(req), 0);
        vm.startPrank(keeper);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setGlobalOpensPaused(true);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setOiCaps(TIER_A, 1, 1);
        vm.stopPrank();
        _ownerOnlyRefuses(keeper);

        // Fee recipient: receives, nothing else.
        vm.prank(feeRecipient);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setGlobalOpensPaused(true);
        _ownerOnlyRefuses(feeRecipient);

        // The owner holds every lane.
        vm.startPrank(owner);
        ex.setMarketOpensPaused(TIER_C, false);
        ex.setOiCaps(TIER_A, 250_000e6, 250_000e6);
        ex.setHouseSizing(TIER_A, 200, 500, 10);
        ex.retire(TIER_C);
        vm.expectRevert(IExchangeTypes.BreakerNotTripped.selector);
        ex.clearBreaker();
        vm.stopPrank();
    }

    function _ownerOnlyRefuses(address who) internal {
        bytes memory err = _unauthorized(who);
        vm.startPrank(who);
        vm.expectRevert(err);
        ex.retire(TIER_A);
        vm.expectRevert(err);
        ex.retireDead(TIER_A);
        vm.expectRevert(err);
        ex.clearBreaker();
        vm.expectRevert(err);
        ex.depositHouse(1);
        vm.expectRevert(err);
        ex.withdrawHouse(1);
        vm.expectRevert(err);
        ex.setFeeBps(0, 0);
        vm.expectRevert(err);
        ex.setHouseWallet(who, true);
        vm.expectRevert(err);
        ex.setKeeper(who, true);
        vm.expectRevert(err);
        ex.setKeepers(who, who);
        vm.expectRevert(err);
        ex.setFeeRecipient(who);
        vm.expectRevert(err);
        ex.setPositionCaps(TIER_A, 1e6, 10);
        vm.expectRevert(err);
        ex.setMarketFees(TIER_A, 0, 0);
        vm.expectRevert(err);
        ex.setRhoBps(2000);
        vm.expectRevert(err);
        ex.setMinMargin(5e6);
        vm.stopPrank();
    }

    // ------------------------------------------------------ extension guard

    /// @dev The extension's storage is nobody's: every state-changing entry refuses a direct
    ///      call, whoever makes it, its views read empty storage, and it has none of the core's
    ///      trading entry points.
    function test_extension_refusesDirectCalls_viewsReadNothing() public {
        address[3] memory callers = [owner, stranger, marketKeeper];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.setFeeBps(100, 0);
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.depositHouse(1);
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.withdrawHouse(1);
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.addInstrument(_spec(0, 165, 1, 10, 1e6));
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.retire(0);
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.clearBreaker();
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.setHouseWallet(alice, true);
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.setOiCaps(0, 1, 1);
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.setHouseSizing(0, 50, 100, 1000);
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.setGlobalOpensPaused(true);
            vm.expectRevert(IExchangeTypes.DirectCall.selector);
            ext.setMarketOpensPaused(0, true);
            vm.stopPrank();
        }
        vm.prank(guardian);
        vm.expectRevert(IExchangeTypes.DirectCall.selector);
        ext.setGlobalOpensPaused(true);
        assertEq(ext.lpBalance(), 0);
        assertEq(ext.instrumentCount(), 0);
        assertEq(ext.extension(), address(0));
        assertEq(ext.winFeeBps(), 0);

        // The thirteen trading entry points live in the core only.
        bytes[13] memory coreOnly = [
            abi.encodeCall(IExchange.deposit, (1)),
            abi.encodeCall(IExchange.depositFor, (alice, 1)),
            abi.encodeCall(IExchange.withdraw, (1)),
            abi.encodeCall(IExchange.requestOpen, (0, true, MARGIN, LEV, address(0))),
            abi.encodeCall(IExchange.executeOpen, (1)),
            abi.encodeCall(IExchange.cancelOpen, (1)),
            abi.encodeCall(IExchange.requestClose, (1)),
            abi.encodeCall(IExchange.executeClose, (1)),
            abi.encodeCall(IExchange.cancelClose, (1)),
            abi.encodeCall(IExchange.liquidate, (1)),
            abi.encodeCall(IExchange.harvest, (1)),
            abi.encodeCall(IExchange.pushFees, ()),
            abi.encodeWithSignature("extensionImmutables()")
        ];
        for (uint256 i = 0; i < 12; i++) {
            (bool ok, bytes memory ret) = address(ext).call(coreOnly[i]);
            assertFalse(ok);
            assertEq(ret.length, 0, "the extension has no such function");
        }
        // The one function meant for direct calls answers on the extension.
        (bool okImm,) = address(ext).staticcall(coreOnly[12]);
        assertTrue(okImm);

        // Not upgradeable: an unknown selector (a would-be extension setter included) reverts
        // empty through the core.
        (bool okU, bytes memory retU) = address(ex).call(abi.encodeWithSignature("setExtension(address)", stranger));
        assertFalse(okU);
        assertEq(retU.length, 0);
        (okU, retU) = address(ex).call(hex"deadbeef");
        assertFalse(okU);
        assertEq(retU.length, 0);
    }

    // ------------------------------------------------------------ combined ABI

    /// @dev Every selector of `IExchange` answers on the core address: each view returns, each
    ///      state-changing call either succeeds or reverts with a real error (an unknown
    ///      selector reverts empty). The list is proven complete against the interface id.
    function test_everyIExchangeSelector_answersThroughTheCore() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        bytes[] memory views = new bytes[](55);
        views[0] = abi.encodeCall(IExchange.balanceOf, (alice));
        views[1] = abi.encodeCall(IExchange.marginInUse, (alice));
        views[2] = abi.encodeCall(IExchange.pendingOf, (alice));
        views[3] = abi.encodeCall(IExchange.positions, (id));
        views[4] = abi.encodeCall(IExchange.positionIdsOf, (alice));
        views[5] = abi.encodeCall(IExchange.openRequest, (1));
        views[6] = abi.encodeCall(IExchange.closeRequest, (id));
        views[7] = abi.encodeCall(IExchange.bustPrice, (id));
        views[8] = abi.encodeCall(IExchange.previewClose, (id));
        views[9] = abi.encodeCall(IExchange.execPrice, (TIER_A, true, true));
        views[10] = abi.encodeCall(IExchange.nextRequestId, ());
        views[11] = abi.encodeCall(IExchange.nextPositionId, ());
        views[12] = abi.encodeCall(IExchange.instrument, (TIER_A));
        views[13] = abi.encodeCall(IExchange.instrumentCount, ());
        views[14] = abi.encodeCall(IExchange.openInterest, (TIER_A));
        views[15] = abi.encodeCall(IExchange.lpBalance, ());
        views[16] = abi.encodeCall(IExchange.feePool, ());
        views[17] = abi.encodeCall(IExchange.houseFreeUsdc, ());
        views[18] = abi.encodeCall(IExchange.houseExposureUsdc, ());
        views[19] = abi.encodeCall(IExchange.maxPositionUsd, (TIER_A, true));
        views[20] = abi.encodeCall(IExchange.openMaxPayoutUsdc, ());
        views[21] = abi.encodeCall(IExchange.sessionRouter, ());
        views[22] = abi.encodeCall(IExchange.marketRules, ());
        views[23] = abi.encodeCall(IExchange.extension, ());
        views[24] = abi.encodeCall(IExchange.queueLength, ());
        views[25] = abi.encodeCall(IExchange.queueHead, ());
        views[26] = abi.encodeCall(IExchange.queuedTotal, ());
        views[27] = abi.encodeCall(IExchange.globalOpensPaused, ());
        views[28] = abi.encodeCall(IExchange.breakerBps, ());
        views[29] = abi.encodeCall(IExchange.breakerTripped, ());
        views[30] = abi.encodeCall(IExchange.breakerFloorUsdc, ());
        views[31] = abi.encodeCall(IExchange.winFeeBps, ());
        views[32] = abi.encodeCall(IExchange.lossFeeBps, ());
        views[33] = abi.encodeCall(IExchange.borrowFreeHours, ());
        views[34] = abi.encodeCall(IExchange.isHouseWallet, (alice));
        views[35] = abi.encodeCall(IExchange.borrowOwed, (id));
        views[36] = abi.encodeCall(IExchange.stakerFeeShareBps, ());
        views[37] = abi.encodeCall(IExchange.minMarginUsdc, ());
        views[38] = abi.encodeCall(IExchange.rhoBps, ());
        views[39] = abi.encodeCall(IExchange.maxWinBps, ());
        views[40] = abi.encodeCall(IExchange.minDelay, ());
        views[41] = abi.encodeCall(IExchange.grace, ());
        views[42] = abi.encodeCall(IExchange.expiry, ());
        views[43] = abi.encodeCall(IExchange.maxJumpBps, ());
        views[44] = abi.encodeCall(IExchange.isKeeper, (keeper));
        views[45] = abi.encodeCall(IExchange.breakerWindow, ());
        views[46] = abi.encodeCall(IExchange.usdc, ());
        views[47] = abi.encodeCall(IExchange.oracle, ());
        views[48] = abi.encodeCall(IExchange.staking, ());
        views[49] = abi.encodeCall(IExchange.referrals, ());
        views[50] = abi.encodeCall(IExchange.owner, ());
        views[51] = abi.encodeCall(IExchange.pauseGuardian, ());
        views[52] = abi.encodeCall(IExchange.marketKeeper, ());
        views[53] = abi.encodeCall(IExchange.feeRecipient, ());
        views[54] = abi.encodeCall(IExchange.queueEntry, (0)); // reverts with a panic: empty queue

        bytes[] memory calls = new bytes[](41);
        calls[0] = abi.encodeCall(IExchange.deposit, (1e6));
        calls[1] = abi.encodeCall(IExchange.depositFor, (alice, 1e6));
        calls[2] = abi.encodeCall(IExchange.withdraw, (1));
        calls[3] = abi.encodeCall(IExchange.requestOpen, (TIER_A, true, MARGIN, LEV, address(0)));
        calls[4] = abi.encodeCall(IExchange.executeOpen, (99));
        calls[5] = abi.encodeCall(IExchange.cancelOpen, (99));
        calls[6] = abi.encodeCall(IExchange.requestClose, (id));
        calls[7] = abi.encodeCall(IExchange.executeClose, (id));
        calls[8] = abi.encodeCall(IExchange.cancelClose, (id));
        calls[9] = abi.encodeCall(IExchange.liquidate, (id));
        calls[10] = abi.encodeCall(IExchange.harvest, (1));
        calls[11] = abi.encodeCall(IExchange.pushFees, ());
        calls[12] = abi.encodeCall(IExchange.depositHouse, (1e6));
        calls[13] = abi.encodeCall(IExchange.withdrawHouse, (1));
        calls[14] = abi.encodeCall(IExchange.addInstrument, (_spec(0, 165, 1, 10, 1e6)));
        calls[15] =
            abi.encodeCall(IExchange.setInstrumentParams, (TIER_A, 1, 10, 1000, 15_000, 20_000e6, 130_000_000e6));
        calls[16] = abi.encodeCall(IExchange.setMaxLeverage, (TIER_A, 10));
        calls[17] = abi.encodeCall(IExchange.setOiCaps, (TIER_A, 1, 1));
        calls[18] = abi.encodeCall(IExchange.setHouseSizing, (TIER_A, 200, 500, 10));
        calls[19] = abi.encodeCall(IExchange.setPositionCaps, (TIER_A, 100_000e6, 50));
        calls[20] = abi.encodeCall(IExchange.setRhoBps, (2000));
        calls[21] = abi.encodeCall(IExchange.setMaxWinBps, (2500));
        calls[22] = abi.encodeCall(IExchange.setMinMargin, (5e6));
        calls[23] = abi.encodeCall(IExchange.setBreakerBps, (2500));
        calls[24] = abi.encodeCall(IExchange.setBreakerFloor, (0));
        calls[25] = abi.encodeCall(IExchange.setFeeBps, (750, 0));
        calls[26] = abi.encodeCall(IExchange.setMarketFees, (TIER_A, 0, 0));
        calls[27] = abi.encodeCall(IExchange.setBorrowFreeHours, (1));
        calls[28] = abi.encodeCall(IExchange.setHouseWallet, (alice, true));
        calls[29] = abi.encodeCall(IExchange.setStakerFeeShare, (2000));
        calls[30] = abi.encodeCall(IExchange.setReferralShare, (1500));
        calls[31] = abi.encodeCall(IExchange.setDelays, (5, 3, 60));
        calls[32] = abi.encodeCall(IExchange.setKeeper, (dave, true));
        calls[33] = abi.encodeCall(IExchange.setMaxJumpBps, (1000));
        calls[34] = abi.encodeCall(IExchange.clearBreaker, ());
        calls[35] = abi.encodeCall(IExchange.setMarketOpensPaused, (TIER_A, true));
        calls[36] = abi.encodeCall(IExchange.setGlobalOpensPaused, (true));
        calls[37] = abi.encodeCall(IExchange.retire, (TIER_A));
        calls[38] = abi.encodeCall(IExchange.retireDead, (TIER_A));
        calls[39] = abi.encodeCall(IExchange.setFeeRecipient, (dave));
        calls[40] = abi.encodeCall(IExchange.setKeepers, (guardian, marketKeeper));

        bytes4 xor;
        for (uint256 i = 0; i < views.length; i++) {
            (bool ok, bytes memory ret) = address(ex).staticcall(views[i]);
            if (i == 54) {
                assertFalse(ok);
                assertGe(ret.length, 4, "queueEntry answered");
            } else {
                assertTrue(ok, "view failed");
                assertGt(ret.length, 0);
            }
            xor ^= bytes4(views[i]);
        }
        uint256 answeredOk;
        for (uint256 i = 0; i < calls.length; i++) {
            uint256 snap = vm.snapshotState();
            vm.prank(owner);
            (bool ok, bytes memory ret) = address(ex).call(calls[i]);
            assertTrue(ok || ret.length >= 4, "selector not answered");
            if (ok) answeredOk++;
            vm.revertToState(snap);
            xor ^= bytes4(calls[i]);
        }
        // The owner's admin calls succeed outright.
        assertGe(answeredOk, 25);
        assertEq(xor, type(IExchange).interfaceId, "selector list incomplete");
    }

    // ---------------------------------------------------------- setter bounds

    /// @dev Edges accepted, edge + 1 refused with `ParamOutOfBounds`, for the setters not
    ///      already walked in the suites above.
    function test_setterBounds_edgeAcceptedEdgePlusOneRefused() public {
        vm.startPrank(owner);
        // Min margin 1..10 USDC.
        vm.expectRevert(_oob(IExchangeTypes.Param.MinMarginUsdc, 1e6 - 1));
        ex.setMinMargin(1e6 - 1);
        vm.expectRevert(_oob(IExchangeTypes.Param.MinMarginUsdc, 10e6 + 1));
        ex.setMinMargin(10e6 + 1);
        ex.setMinMargin(10e6);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.MinMarginSet(1e6);
        ex.setMinMargin(1e6);
        vm.stopPrank();
        assertEq(ex.minMarginUsdc(), 1e6);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.MarginBelowMinimum.selector);
        ex.requestOpen(TIER_A, true, 1e6 - 1, 1, address(0));
        _open(alice, TIER_A, true, 1e6, 1);

        vm.startPrank(owner);
        // Staker share 0..10000 (edge accepted).
        ex.setStakerFeeShare(10_000);
        ex.setStakerFeeShare(0);
        // Max leverage 1..1000.
        ex.setMaxLeverage(TIER_A, 1);
        ex.setMaxLeverage(TIER_A, 1000);

        // Instrument params: each bound at its edge (the rest at the fixture curve), then +1.
        uint128 pm = 130_000_000e6;
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 15_000, 20_000e6, pm);
        ex.setInstrumentParams(TIER_A, 50, 10, 1000, 15_000, 20_000e6, pm);
        vm.expectRevert(_oob(IExchangeTypes.Param.DeadbandBps, 0));
        ex.setInstrumentParams(TIER_A, 0, 10, 1000, 15_000, 20_000e6, pm);
        vm.expectRevert(_oob(IExchangeTypes.Param.DeadbandBps, 51));
        ex.setInstrumentParams(TIER_A, 51, 10, 1000, 15_000, 20_000e6, pm);
        ex.setInstrumentParams(TIER_A, 1, 5, 1000, 15_000, 20_000e6, pm);
        ex.setInstrumentParams(TIER_A, 1, 100, 1000, 15_000, 20_000e6, pm);
        vm.expectRevert(_oob(IExchangeTypes.Param.ClampBps, 4));
        ex.setInstrumentParams(TIER_A, 1, 4, 1000, 15_000, 20_000e6, pm);
        vm.expectRevert(_oob(IExchangeTypes.Param.ClampBps, 101));
        ex.setInstrumentParams(TIER_A, 1, 101, 1000, 15_000, 20_000e6, pm);
        ex.setInstrumentParams(TIER_A, 1, 10, 500, 15_000, 20_000e6, pm);
        ex.setInstrumentParams(TIER_A, 1, 10, 2000, 15_000, 20_000e6, pm);
        vm.expectRevert(_oob(IExchangeTypes.Param.BaseRateBps, 499));
        ex.setInstrumentParams(TIER_A, 1, 10, 499, 15_000, 20_000e6, pm);
        vm.expectRevert(_oob(IExchangeTypes.Param.BaseRateBps, 2001));
        ex.setInstrumentParams(TIER_A, 1, 10, 2001, 15_000, 20_000e6, pm);
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 1_000, 20_000e6, pm);
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 1_000_000, 20_000e6, pm);
        vm.expectRevert(_oob(IExchangeTypes.Param.RateMultiplier, 999));
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 999, 20_000e6, pm);
        vm.expectRevert(_oob(IExchangeTypes.Param.RateMultiplier, 1_000_001));
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 1_000_001, 20_000e6, pm);
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 15_000, 1_000e6, pm);
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 15_000, 1_000_000e6, 1_000_000_000e6);
        vm.expectRevert(_oob(IExchangeTypes.Param.ReferenceNotionalUsd, 1_000e6 - 1));
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 15_000, 1_000e6 - 1, pm);
        vm.expectRevert(_oob(IExchangeTypes.Param.ReferenceNotionalUsd, 1_000_000e6 + 1));
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 15_000, 1_000_000e6 + 1, 1_000_000_000e6);
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 15_000, 1_000e6, 1e12);
        vm.expectRevert(_oob(IExchangeTypes.Param.PositionMultiplierE6, 1e12 - 1));
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 15_000, 1_000e6, 1e12 - 1);
        // The 50% floor on the curve: a $1M reference notional at the fixture multiplier keeps
        // 50.7% of a 1% win and is accepted; at a 100M multiplier it keeps under half.
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 15_000, 1_000_000e6, pm);
        uint256 scale = ImpactLib.impactScaleE18(
            1e16,
            ImpactLib.Curve({
                baseRateBps: 1000,
                rateMultiplier: 15_000,
                referenceNotionalUsd: 1_000_000e6,
                positionMultiplierE6: 100_000_000e6
            })
        );
        assertLt(scale, 0.5e18);
        vm.expectRevert(_oob(IExchangeTypes.Param.ImpactScaleOnePct, scale));
        ex.setInstrumentParams(TIER_A, 1, 10, 1000, 15_000, 1_000_000e6, 100_000_000e6);
        vm.stopPrank();
    }
}
