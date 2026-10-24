// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {Exchange} from "../../src/Exchange.sol";
import {ExchangeExt} from "../../src/ExchangeExt.sol";
import {ImpactLib} from "../../src/lib/ImpactLib.sol";
import {IExchange} from "../../src/interfaces/IExchange.sol";
import {IExchangeTypes} from "../../src/interfaces/IExchangeTypes.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";
import {IReferrals} from "../../src/interfaces/IReferrals.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {ExchangeFixture} from "./ExchangeFixture.sol";

/// @notice The exchange's trading behaviour, ported from v3 onto the v4 core + extension: the
///         collateral ledger, the request windows and fill prices, the re-checks at execution,
///         oracle-only pricing, wins / losses / liquidations to the unit, the FIFO queue, the
///         fee pool and its push, stamped terms, pauses, retirement, the breaker, the admin
///         surface and referrals. The fixture (`ExchangeFixture`) holds $100K of house money
///         and runs the neutral configuration (5% / 5% fees, no spread, no borrow); the v4
///         mechanisms themselves are tested in `ExchangeV4.t.sol`.
contract ExchangeTest is ExchangeFixture {
    /// @dev Seed the house with a loss: `user` loses a whole $100 margin on a 10% drop. At
    ///      the fixture's 5% loss fee: house cash +$100, fee pool +$5.
    function _seedLpWithFullLoss(address user) internal returns (uint256 lossUsdc) {
        _setPx(ASSET_A, RAW_ONE);
        uint256 id = _open(user, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        _close(user, id);
        _setPx(ASSET_A, RAW_ONE);
        return MARGIN;
    }

    // ------------------------------------------------------------- collateral

    function test_deposit_and_withdraw() public {
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(usdc.balanceOf(address(ex)), 4000e6 + HOUSE);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.Withdrawn(alice, 400e6);
        ex.withdraw(400e6);
        assertEq(ex.balanceOf(alice), 600e6);
        assertEq(usdc.balanceOf(alice), 400e6);

        usdc.mint(alice, 50e6);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.Deposited(alice, alice, 50e6);
        ex.deposit(50e6);
        assertEq(ex.balanceOf(alice), 650e6);
        // Trader deposits and withdrawals never touch the house.
        assertEq(ex.lpBalance(), HOUSE);
        _assertSolvent();
    }

    function test_deposit_withdraw_rejectInvalidAmounts() public {
        vm.startPrank(alice);
        vm.expectRevert(IExchangeTypes.ZeroAmount.selector);
        ex.deposit(0);
        vm.expectRevert(IExchangeTypes.ZeroAmount.selector);
        ex.withdraw(0);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 1000e6, 1000e6 + 1));
        ex.withdraw(1000e6 + 1);
        vm.stopPrank();
    }

    function test_depositFor_creditsBeneficiary_pullsFromPayer() public {
        usdc.mint(bob, 25e6);
        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.Deposited(alice, bob, 25e6);
        ex.depositFor(alice, 25e6);
        assertEq(ex.balanceOf(alice), 1025e6);
        assertEq(ex.balanceOf(bob), 1000e6);
        assertEq(usdc.balanceOf(bob), 0);

        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.ZeroAddress.selector);
        ex.depositFor(address(0), 1);
        _assertSolvent();
    }

    // --------------------------------------------------------- open requests

    function test_requestOpen_recordsRequest_movesMarginToPending() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.OpenRequested(1, alice, TIER_A, true, MARGIN, LEV, ONE, address(0));
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        assertEq(req, 1);
        assertEq(ex.nextRequestId(), 2);
        assertEq(ex.nextPositionId(), 1); // nothing opened yet

        IExchangeTypes.OpenRequest memory r = ex.openRequest(req);
        assertEq(r.trader, alice);
        assertEq(r.instrumentId, TIER_A);
        assertTrue(r.isLong);
        assertEq(r.marginUsdc, MARGIN);
        assertEq(r.leverage, LEV);
        assertEq(r.requestedAt, t0);
        assertEq(r.px0, ONE);
        assertEq(r.referrer, address(0));

        // The margin is neither available nor in use: it waits in `pendingOf`.
        assertEq(ex.balanceOf(alice), 900e6);
        assertEq(ex.pendingOf(alice), MARGIN);
        assertEq(ex.marginInUse(alice), 0);
        (uint256 longOi,) = ex.openInterest(TIER_A);
        assertEq(longOi, 0);
        assertEq(ex.houseExposureUsdc(), 0);
        assertEq(ex.positionIdsOf(alice).length, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 900e6, 900e6 + 1));
        ex.withdraw(900e6 + 1);
        _assertSolvent();
    }

    function test_executeOpen_storesPositionAndUpdatesAccounting() public {
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        uint256 t0 = vm.getBlockTimestamp();
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionOpened(1, alice, TIER_A, true, MARGIN, LEV, ONE, req, true);
        uint256 id = ex.executeOpen(req);
        assertEq(id, 1);
        assertEq(ex.nextPositionId(), 2);

        IExchangeTypes.Position memory p = ex.positions(id);
        assertEq(p.owner, alice);
        assertEq(p.instrumentId, TIER_A);
        assertTrue(p.isLong);
        assertEq(p.marginUsdc, MARGIN);
        assertEq(p.leverage, LEV);
        assertEq(p.entryPx18, ONE);
        assertEq(p.openedAt, t0 + DELAY); // the execution block, not the request
        // The settlement terms are stamped at execution: the market's 1 bps deadband, 50x
        // payout cap, entry spread and borrow rate, the exchange's fee rates and free hours,
        // and the maximum profit min(100 x 50, 25% x $100K free) = 5,000.
        assertEq(p.deadbandBps, 1);
        assertEq(p.payoutCapX, 50);
        assertEq(p.winFeeBps, 500);
        assertEq(p.lossFeeBps, 500);
        assertEq(p.entryDeadbandBps, 0);
        assertEq(p.borrowRateX10, 0);
        assertEq(p.borrowFreeHours, 1);
        assertEq(p.maxProfitUsdc, 5_000e6);

        assertEq(ex.balanceOf(alice), 900e6);
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.marginInUse(alice), MARGIN);
        assertEq(ex.openRequest(req).trader, address(0)); // consumed
        (uint256 longOi, uint256 shortOi) = ex.openInterest(TIER_A);
        assertEq(longOi, 1000e6);
        assertEq(shortOi, 0);
        // Book exposure: 1000 x 10 bps stress x (1 - 10% base) = 0.9.
        assertEq(ex.houseExposureUsdc(), 900_000);
        assertEq(ex.openMaxPayoutUsdc(), 5_000e6);
        assertEq(ex.instrument(TIER_A).lastPx18, ONE);
        uint256[] memory ids = ex.positionIdsOf(alice);
        assertEq(ids.length, 1);
        assertEq(ids[0], 1);
        assertEq(ex.bustPrice(id), 0.905e18);
        // The first executed open fixed alice's referrer (none).
        assertTrue(refs.referrerLocked(alice));
        assertEq(refs.referrerOf(alice), address(0));
        _assertSolvent();
    }

    function test_requestOpen_minMargin() public {
        assertEq(ex.minMarginUsdc(), 5e6);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.MarginBelowMinimum.selector);
        ex.requestOpen(TIER_A, true, 5e6 - 1, 1, address(0));
        _open(alice, TIER_A, true, 5e6, 1);
        // The owner raises it to the $10 ceiling: $9.999999 is refused, $10 fills.
        vm.prank(owner);
        ex.setMinMargin(10e6);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.MarginBelowMinimum.selector);
        ex.requestOpen(TIER_A, true, 10e6 - 1, 1, address(0));
        _open(alice, TIER_A, true, 10e6, 1);
    }

    function test_requestOpen_perCoinLeverageCaps() public {
        vm.startPrank(alice);
        vm.expectRevert(IExchangeTypes.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_A, true, MARGIN, 1001, address(0));
        vm.expectRevert(IExchangeTypes.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_A, true, MARGIN, 0, address(0));
        vm.expectRevert(IExchangeTypes.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_B, true, MARGIN, 251, address(0));
        vm.expectRevert(IExchangeTypes.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_C, true, MARGIN, 51, address(0));
        vm.stopPrank();
        // The caps themselves are allowed (margin sized so notional stays under the OI cap).
        _open(alice, TIER_A, true, 100e6, 1000);
        _open(alice, TIER_B, true, 100e6, 250);
        _open(alice, TIER_C, true, 100e6, 50);
        assertEq(ex.instrument(TIER_A).maxLeverage, 1000);
        assertEq(ex.instrument(TIER_B).maxLeverage, 250);
        assertEq(ex.instrument(TIER_C).maxLeverage, 50);
    }

    function test_open_oiCapsPerSide() public {
        // Tier A's static cap is $250K per side. Two 1000x $100 = $100K longs fit, the third
        // does not.
        _open(alice, TIER_A, true, 100e6, 1000);
        _open(bob, TIER_A, true, 100e6, 1000);
        vm.prank(carol);
        vm.expectRevert(IExchangeTypes.OiCapExceeded.selector);
        ex.requestOpen(TIER_A, true, 100e6, 1000, address(0));
        // A $50K long fits exactly; the short side is independent.
        _open(carol, TIER_A, true, 50e6, 1000);
        _open(dave, TIER_A, false, 100e6, 1000);
        (uint256 longOi, uint256 shortOi) = ex.openInterest(TIER_A);
        assertEq(longOi, 250_000e6);
        assertEq(shortOi, 100_000e6);
        vm.prank(dave);
        vm.expectRevert(IExchangeTypes.OiCapExceeded.selector);
        ex.requestOpen(TIER_A, true, 10e6, 1, address(0));

        // Closing frees headroom.
        _close(alice, 1);
        _open(dave, TIER_A, true, 100e6, 1000);

        // The market keeper lowering the cap below current OI blocks opens without touching
        // positions.
        vm.prank(marketKeeper);
        ex.setOiCaps(TIER_A, 1000e6, 1000e6);
        vm.prank(dave);
        vm.expectRevert(IExchangeTypes.OiCapExceeded.selector);
        ex.requestOpen(TIER_A, true, 10e6, 1, address(0));
        assertEq(ex.positions(2).owner, bob);
        _assertSolvent();
    }

    function test_requestOpen_insufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 1000e6, 1000e6 + 1));
        ex.requestOpen(TIER_A, true, 1000e6 + 1, 1, address(0));
        // Pending margin counts as spent: a second $600 request on $400 of available fails.
        _requestOpen(alice, TIER_A, true, 600e6, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 400e6, 600e6));
        ex.requestOpen(TIER_A, true, 600e6, 1, address(0));
    }

    function test_requestOpen_unknownInstrument() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.requestOpen(9, true, MARGIN, 1, address(0));
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.instrument(9);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.execPrice(9, true, true);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.maxPositionUsd(9, true);
    }

    function test_requestOpen_oracleFeedDownBlocks_bookFeedDownDoesNot() public {
        // Pricing is oracle only: a dead oracle feed stops requests, a dead book changes nothing.
        source.setOracleReverts(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        source.setOracleReverts(false);
        source.setReverts(true, false); // BBO down
        assertEq(ex.execPrice(TIER_A, true, true), ONE);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(id).entryPx18, ONE);
        source.setReverts(false, false);
    }

    function test_open_notionalCapPerPosition() public {
        // One position may not take the whole side cap. The fixture allows $100K; set $25K and
        // probe both sides of it.
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.PositionCapsSet(TIER_A, 25_000e6, 50);
        ex.setPositionCaps(TIER_A, 25_000e6, 50);
        IExchangeTypes.Instrument memory inst = ex.instrument(TIER_A);
        assertEq(inst.maxNotionalUsd, 25_000e6);
        assertEq(inst.payoutCapX, 50);

        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        ex.requestOpen(TIER_A, true, 26e6, 1000, address(0));
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        ex.requestOpen(TIER_A, false, 250e6, 1000, address(0));
        _open(alice, TIER_A, true, 25e6, 1000); // exactly the cap is allowed
        (uint256 longOi,) = ex.openInterest(TIER_A);
        assertEq(longOi, 25_000e6);

        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setPositionCaps(TIER_A, 25_000e6, 50);
        vm.prank(marketKeeper);
        vm.expectRevert(_unauthorized(marketKeeper));
        ex.setPositionCaps(TIER_A, 25_000e6, 50);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxNotionalUsd, 0));
        ex.setPositionCaps(TIER_A, 0, 50);
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxNotionalUsd, 1_000_000e6 + 1));
        ex.setPositionCaps(TIER_A, 1_000_000e6 + 1, 50);
        // The v4 ceiling itself ($1M) is accepted, and so is $1.
        ex.setPositionCaps(TIER_A, 1_000_000e6, 50);
        assertEq(ex.instrument(TIER_A).maxNotionalUsd, 1_000_000e6);
        ex.setPositionCaps(TIER_A, 1, 50);
        vm.expectRevert(_oob(IExchangeTypes.Param.PayoutCapX, 9));
        ex.setPositionCaps(TIER_A, 25_000e6, 9);
        vm.expectRevert(_oob(IExchangeTypes.Param.PayoutCapX, 51));
        ex.setPositionCaps(TIER_A, 25_000e6, 51);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.setPositionCaps(9, 25_000e6, 50);
        ex.setPositionCaps(TIER_A, 100_000e6, 10); // the edges are accepted
        ex.setPositionCaps(TIER_A, 25_000e6, 50);
        // addInstrument applies the same bounds.
        IExchangeTypes.Instrument memory spec = _spec(0, 165, 1, 10, 250_000e6);
        spec.maxNotionalUsd = 0;
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxNotionalUsd, 0));
        ex.addInstrument(spec);
        spec.maxNotionalUsd = 25_000e6;
        spec.payoutCapX = 51;
        vm.expectRevert(_oob(IExchangeTypes.Param.PayoutCapX, 51));
        ex.addInstrument(spec);
        vm.stopPrank();
    }

    // ------------------------------------------------------- request windows

    /// @dev The three windows, measured from the request: nobody before 5 s, keepers only in
    ///      [5, 8), anyone in [8, 60], cancel only after 60 s.
    function test_windows_openRequest_minDelay_keeperFirst_thenAnyone_thenCancelOnly() public {
        uint256 t0 = vm.getBlockTimestamp();
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);

        // Before minDelay nobody can execute, the keeper included.
        vm.warp(t0 + DELAY - 1);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.TooEarly.selector);
        ex.executeOpen(req);
        // In the keeper window only a fill keeper may: not a stranger, not the requester, not
        // the owner, the guardian or the market keeper by virtue of their roles.
        vm.warp(t0 + DELAY);
        address[5] memory notKeeper = [stranger, alice, owner, guardian, marketKeeper];
        for (uint256 i = 0; i < notKeeper.length; i++) {
            vm.prank(notKeeper[i]);
            vm.expectRevert(IExchangeTypes.KeeperWindow.selector);
            ex.executeOpen(req);
        }
        vm.warp(t0 + DELAY + GRACE - 1);
        vm.prank(stranger);
        vm.expectRevert(IExchangeTypes.KeeperWindow.selector);
        ex.executeOpen(req);
        // Nobody can cancel before expiry, the requester least of all.
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.RequestNotExpired.selector);
        ex.cancelOpen(req);
        // From minDelay + grace anyone executes, up to and including the expiry second.
        vm.warp(t0 + DELAY + GRACE);
        vm.prank(stranger);
        assertEq(ex.executeOpen(req), 1);

        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        t0 = vm.getBlockTimestamp();
        vm.warp(t0 + EXPIRY);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.RequestNotExpired.selector);
        ex.cancelOpen(req);
        vm.prank(alice); // the requester may self-execute in the fallback window
        assertEq(ex.executeOpen(req), 2);

        // Past expiry: execution reverts for everyone, anyone cancels and the margin returns.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        t0 = vm.getBlockTimestamp();
        assertEq(ex.balanceOf(alice), 700e6);
        assertEq(ex.pendingOf(alice), MARGIN);
        vm.warp(t0 + EXPIRY + 1);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.RequestExpired.selector);
        ex.executeOpen(req);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.RequestExpired.selector);
        ex.cancelOpen(req);
        assertEq(ex.balanceOf(alice), 800e6);
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.openRequest(req).trader, address(0));
        assertEq(ex.positionIdsOf(alice).length, 2);
        // Gone for good.
        vm.prank(stranger);
        vm.expectRevert(IExchangeTypes.UnknownRequest.selector);
        ex.cancelOpen(req);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.UnknownRequest.selector);
        ex.executeOpen(req);
        vm.expectRevert(IExchangeTypes.UnknownRequest.selector);
        ex.executeOpen(99);
        _assertSolvent();
    }

    /// @dev Same windows for a close request; a cancelled close leaves the position open and
    ///      can be requested again.
    function test_windows_closeRequest_sameRules_cancelLeavesPositionOpen() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotPositionOwner.selector, id, bob));
        ex.requestClose(id);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.CloseRequested(id, alice, ONE);
        ex.requestClose(id);
        IExchangeTypes.CloseRequest memory r = ex.closeRequest(id);
        assertEq(r.requestedAt, t0);
        assertEq(r.px0, ONE);

        vm.warp(t0 + DELAY - 1);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.TooEarly.selector);
        ex.executeClose(id);
        vm.warp(t0 + DELAY);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.KeeperWindow.selector);
        ex.executeClose(id);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.RequestNotExpired.selector);
        ex.cancelClose(id);
        vm.warp(t0 + EXPIRY + 1);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.RequestExpired.selector);
        ex.executeClose(id);
        vm.prank(stranger);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.CloseRequestCancelled(id, IExchangeTypes.RequestExpired.selector);
        ex.cancelClose(id);
        assertEq(ex.closeRequest(id).requestedAt, 0);
        assertEq(ex.positions(id).owner, alice); // still open
        assertEq(ex.marginInUse(alice), MARGIN);
        vm.expectRevert(IExchangeTypes.UnknownRequest.selector);
        ex.executeClose(id);
        vm.expectRevert(IExchangeTypes.UnknownRequest.selector);
        ex.cancelClose(id);

        // Requested again, the fallback window lets the requester close it (keeperFill false).
        _requestClose(alice, id);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(id, alice, ONE, 0, 0, MARGIN, 0, 0, false);
        (uint256 paid,) = ex.executeClose(id);
        assertEq(paid, MARGIN);
        assertEq(ex.positions(id).owner, address(0));
        _assertSolvent();
    }

    function test_requestClose_onePendingPerPosition_andGoneAfterClose() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _requestClose(alice, id);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.CloseAlreadyPending.selector);
        ex.requestClose(id);
        _executeClose(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownPosition.selector, id));
        ex.requestClose(id);
        vm.expectRevert(IExchangeTypes.UnknownRequest.selector);
        ex.executeClose(id);
    }

    // ------------------------------------------------------------ fill price

    /// @dev Keeper window: the fill is the live print p1, better or worse. Fallback window: the
    ///      trader-worse of p0 and p1, so a later, better print never reaches the trader and a
    ///      later, worse one does.
    function test_fill_open_keeperTakesLivePrint_fallbackTakesWorseOfRequestAndLive() public {
        // Keeper, long: requested at 1.000, executed at 0.990 -> 0.990 (the live print).
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 990_000);
        uint256 id = _executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 0.99e18);

        // Fallback, long: requested at 1.000, executed at 0.990 -> max = 1.000 (no gift) ...
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 990_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionOpened(2, alice, TIER_A, true, MARGIN, LEV, ONE, req, false);
        id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, ONE);
        // ... and executed at 1.010 -> max = 1.010 (the later, worse print).
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(alice); // self-executing changes nothing
        id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 1.01e18);

        // Short mirror: requested at 1.000, executed at 1.010 -> min = 1.000; at 0.990 -> 0.990.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(bob, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, ONE);
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(bob, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 990_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 0.99e18);
        // Keeper, short: the live 1.010 print, though better for the short, is the fill.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(bob, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        id = _executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 1.01e18);
        _assertSolvent();
    }

    function test_fill_close_fallbackTakesWorseOfRequestAndLive_exactNumbers() public {
        // Long at 1.000. Close requested at 1.010 (p0); the oracle prints 1.030 by the fallback
        // window: the fill is min(1.010, 1.030) = 1.010, the 1% vector (deadband exit 1.009899,
        // adjusted 8.714963, fee 5% = 0.435748, profit 8.279215). The later, better print is
        // not the trader's.
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 1_030_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(id, alice, 1.01e18, 8_279_215, 435_748, 108_279_215, 0, 0, false);
        (uint256 paid,) = ex.executeClose(id);
        assertEq(paid, 108_279_215);
        // The settlement print is the live one, whatever the fill.
        assertEq(ex.instrument(TIER_A).lastPx18, 1.03e18);

        // The same request with the print at 1.005 by then fills at 1.005: exactly what the
        // preview says at 1.005, and less than the 1.010 the trader asked at.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_005_000);
        (int256 pnlAt1005,, uint256 payoutAt1005) = ex.previewClose(id);
        assertGt(pnlAt1005, 0);
        assertLt(pnlAt1005, 8_279_215);
        _setPx(ASSET_A, 1_010_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 1_005_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        (paid,) = ex.executeClose(id);
        assertEq(paid, payoutAt1005);

        // Keeper window: the live print, even when better. Requested at 1.010, filled at 1.030.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 1_030_000);
        (int256 pnlAt1030,,) = ex.previewClose(id);
        assertGt(pnlAt1030, 8_279_215);
        _tick();
        vm.recordLogs();
        vm.prank(keeper);
        ex.executeClose(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(ex) || logs[i].topics[0] != POSITION_CLOSED_TOPIC) continue;
            (uint256 exitPx18, int256 pnl,,,,, bool keeperFill) =
                abi.decode(logs[i].data, (uint256, int256, uint256, uint256, uint256, uint256, bool));
            assertEq(exitPx18, 1.03e18);
            assertEq(pnl, pnlAt1030);
            assertTrue(keeperFill);
            seen = true;
        }
        assertTrue(seen);

        // Short mirror: at 1.000, requested at 0.990, the print at 0.980 by the fallback: fill
        // max(0.990, 0.980) = 0.990, the short 1% vector (exit rounded up 0.990099, adjusted
        // 8.716762, fee 0.435838, profit 8.280924); at 0.995 by then: 0.995, the worse print.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 990_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 980_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(id, alice, 0.99e18, 8_280_924, 435_838, 108_280_924, 0, 0, false);
        ex.executeClose(id);
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        (,, uint256 payoutAt995) = ex.previewClose(id);
        _setPx(ASSET_A, 990_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 995_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        (paid,) = ex.executeClose(id);
        assertEq(paid, payoutAt995);
        assertLt(paid, 108_280_924);
        _assertSolvent();
    }

    // ------------------------------------------------ re-checks at execution

    /// @dev Every open-time rule runs again when the request executes; a rule that fails by
    ///      then refunds the request (event with the rule) instead of reverting.
    function test_executeOpen_refundsWhenARuleFailsAtExecution() public {
        // Market paused by the guardian between request and execution.
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(guardian);
        ex.setMarketOpensPaused(TIER_A, true);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.OpensPausedForMarket.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.openRequest(req).trader, address(0));
        assertEq(ex.positionIdsOf(alice).length, 0);
        assertEq(ex.nextPositionId(), 1);
        assertEq(ex.instrument(TIER_A).lastPx18, 0); // a refund settles on nothing
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.UnknownRequest.selector);
        ex.executeOpen(req);
        vm.prank(owner);
        ex.setMarketOpensPaused(TIER_A, false);

        // Global pause.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(guardian);
        ex.setGlobalOpensPaused(true);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.OpensPausedGlobally.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(owner);
        ex.setGlobalOpensPaused(false);

        // Per-position cap shrunk under the request's $1000 notional.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(owner);
        ex.setPositionCaps(TIER_A, 500e6, 50);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.PositionTooLarge.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(owner);
        ex.setPositionCaps(TIER_A, 100_000e6, 50);

        // OI cap moved under it by the market keeper.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(marketKeeper);
        ex.setOiCaps(TIER_A, 500e6, 500e6);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.OiCapExceeded.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(marketKeeper);
        ex.setOiCaps(TIER_A, 250_000e6, 250_000e6);

        // Leverage cap lowered under the request's 10x.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(owner);
        ex.setMaxLeverage(TIER_A, 5);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.LeverageOutOfRange.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(owner);
        ex.setMaxLeverage(TIER_A, 1000);

        // Breaker tripped by a win in between: the owner arms it at its 2% floor and takes the
        // house down to $1,000, so bob's $44.71 win beats 2% x 1,000 = 20.
        vm.prank(owner);
        ex.setBreakerBps(200);
        uint256 wid = _open(bob, TIER_A, true, MARGIN, LEV);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(owner);
        ex.withdrawHouse(HOUSE - 1_000e6);
        _setPx(ASSET_A, 1_050_000);
        _close(bob, wid);
        assertTrue(ex.breakerTripped());
        _setPx(ASSET_A, RAW_ONE);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.OpensPausedByBreaker.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(owner);
        ex.clearBreaker();

        // Market retired (by the owner) in between.
        req = _requestOpen(alice, TIER_B, true, MARGIN, LEV);
        vm.prank(owner);
        ex.retire(TIER_B);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.MarketRetired.selector);
        assertEq(ex.executeOpen(req), 0);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.MarketRetired.selector);
        ex.requestOpen(TIER_B, true, MARGIN, LEV, address(0));

        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.positionIdsOf(alice).length, 0);
        _assertSolvent();
    }

    /// @dev The jump guard: an oracle move of more than `maxJumpBps` (10%) between request and
    ///      execution refunds the open; exactly 10% fills. The owner tunes it within 10..10000.
    function test_executeOpen_jumpGuard_refundsBrokenPrints_ownerSetsIt() public {
        assertEq(ex.maxJumpBps(), 1000);
        // 10.1% up: |1.101 - 1.000| x 10000 = 1010 bps > 1000 -> refund.
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_101_000);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.PriceJumped.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(ex.instrument(TIER_A).lastPx18, 0); // a broken print is never recorded
        // 10.1% down likewise.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 899_000);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.PriceJumped.selector);
        assertEq(ex.executeOpen(req), 0);
        // Exactly 10% (1000 bps, not over): fills at the live 1.100.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_100_000);
        uint256 id = _executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 1.1e18);

        // Owner only, 10..10000, announced; a tighter guard (5%) refunds a 5.01% move.
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setMaxJumpBps(500);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxJumpBps, 9));
        ex.setMaxJumpBps(9);
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxJumpBps, 10_001));
        ex.setMaxJumpBps(10_001);
        ex.setMaxJumpBps(10_000);
        ex.setMaxJumpBps(10);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.MaxJumpBpsSet(500);
        ex.setMaxJumpBps(500);
        vm.stopPrank();
        assertEq(ex.maxJumpBps(), 500);
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_050_100);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.PriceJumped.selector);
        assertEq(ex.executeOpen(req), 0);
        // A close is never jump-guarded: the position opened at 1.100 closes after a 20% drop.
        _setPx(ASSET_A, 1_100_000);
        _requestClose(alice, id);
        _setPx(ASSET_A, 880_000);
        (uint256 paid,) = _executeClose(id);
        assertEq(paid, 0); // -20% at 10x: the whole margin
        _assertSolvent();
    }

    /// @dev The born-busted guard. A fallback fill is the trader-worse of p0 and p1, so p1 can
    ///      already sit past the bust price of a position booked at p0 (5 bps at 1000x, 200x
    ///      inside the 10% jump guard); without the guard the executor liquidates it in the
    ///      same transaction for the bounty and the trader loses the whole margin on a position
    ///      that was never live. Such a request is refunded with `EntryBusted`. One tick short
    ///      of bust still fills at p0, a favourable move still fills at p1 (worse-of kept), and
    ///      a keeper fill at p1 is untouched.
    function test_executeOpen_fallbackFillBornBusted_refundsInsteadOfOpening() public {
        // Long 1000x asked at 1.000; the oracle is 0.998 (-20 bps) when a stranger executes
        // in the fallback window: refund, no position, no bounty for anyone.
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 998_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.EntryBusted.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.marginInUse(alice), 0);
        assertEq(ex.positionIdsOf(alice).length, 0);
        // Short mirror at +20 bps.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, false, MARGIN, 1000);
        _setPx(ASSET_A, 1_002_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.EntryBusted.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        // Exactly at bust (-5 bps) refunds too: the position would be liquidatable at once.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 999_500);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.EntryBusted.selector);
        assertEq(ex.executeOpen(req), 0);
        // The keeper itself one second late (elapsed == minDelay + grace) gets the worse-of
        // fill and the same guard.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 998_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.OpenRequestCancelled(req, alice, IExchangeTypes.EntryBusted.selector);
        assertEq(ex.executeOpen(req), 0);
        assertEq(ex.balanceOf(alice), 1000e6);

        // One tick short of bust (-4.99 bps): fills at p0 = 1.000 and is not liquidatable.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(alice, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 999_501);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        uint256 id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, ONE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, id, 999_501e12, 0.9995e18));
        ex.liquidate(id);
        // A favourable move still fills at the later, worse-for-nobody p1 (worse-of kept).
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(bob, TIER_A, true, MARGIN, 1000);
        _setPx(ASSET_A, 1_002_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 1.002e18);
        // The keeper window is unaffected: the same -20 bps print fills at p1 = 0.998 and the
        // position is not liquidatable there.
        _setPx(ASSET_A, RAW_ONE);
        req = _requestOpen(carol, TIER_A, true, 20e6, 1000);
        _setPx(ASSET_A, 998_000);
        id = _executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 0.998e18);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, id, 0.998e18, 0.997501e18));
        ex.liquidate(id);
        _assertSolvent();
    }

    /// @dev The settlement terms are stamped when the open executes, not when it is requested.
    function test_executeOpen_stampsTermsAtExecution_notAtRequest() public {
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        vm.startPrank(owner);
        ex.setFeeBps(100, 50);
        ex.setInstrumentParams(TIER_A, 7, 10, 1000, 15_000, 20_000e6, 130_000_000e6);
        ex.setPositionCaps(TIER_A, 100_000e6, 20);
        ex.setMarketFees(TIER_A, 3, 7);
        ex.setBorrowFreeHours(5);
        ex.setMaxWinBps(1000);
        vm.stopPrank();
        uint256 id = _executeOpen(req);
        IExchangeTypes.Position memory p = ex.positions(id);
        assertEq(p.winFeeBps, 100);
        assertEq(p.lossFeeBps, 50);
        assertEq(p.deadbandBps, 7);
        assertEq(p.payoutCapX, 20);
        assertEq(p.entryDeadbandBps, 3);
        assertEq(p.borrowRateX10, 7);
        assertEq(p.borrowFreeHours, 5);
        // min(100 x 20, 10% x 100,000 free) = 2,000.
        assertEq(p.maxProfitUsdc, 2_000e6);
        // The 3 bps spread: 1.000 x 1.0003.
        assertEq(p.entryPx18, 1.0003e18);
    }

    /// @dev A dead oracle at execution time reverts (nothing is refunded); the request waits for
    ///      the feed or for expiry.
    function test_executeOpen_feedDeadAtExecution_requestStaysPending() public {
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        source.setOracleReverts(true);
        _tick();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.executeOpen(req);
        assertEq(ex.openRequest(req).trader, alice);
        assertEq(ex.pendingOf(alice), MARGIN);
        // Cancelling after expiry needs no feed.
        vm.warp(vm.getBlockTimestamp() + EXPIRY);
        vm.prank(stranger);
        ex.cancelOpen(req);
        assertEq(ex.pendingOf(alice), 0);
        source.setOracleReverts(false);
        _assertSolvent();
    }

    // ---------------------------------------- pending close vs liquidation

    /// @dev A pending close never holds up a liquidation; the liquidation voids it and the
    ///      close path then has nothing to act on.
    function test_pendingClose_liquidationWins_closeRequestVoided() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _requestClose(alice, id);
        _setPx(ASSET_A, 905_000); // at bust
        vm.prank(liquidator);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.CloseRequestCancelled(id, IExchangeTypes.UnknownPosition.selector);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionLiquidated(id, alice, liquidator, 0.905e18, MARGIN, 500_000, 5_000_000);
        assertEq(ex.liquidate(id), 500_000);
        assertEq(ex.closeRequest(id).requestedAt, 0);
        assertEq(ex.positions(id).owner, address(0));
        // The liquidation print is the market's last settlement price.
        assertEq(ex.instrument(TIER_A).lastPx18, 0.905e18);

        // The keeper's late executeClose and anyone's cancelClose find nothing and change nothing.
        _tick();
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.UnknownRequest.selector);
        ex.executeClose(id);
        vm.warp(vm.getBlockTimestamp() + EXPIRY);
        vm.expectRevert(IExchangeTypes.UnknownRequest.selector);
        ex.cancelClose(id);
        assertEq(ex.balanceOf(alice), 900e6);
        assertEq(ex.marginInUse(alice), 0);
        assertEq(ex.balanceOf(liquidator), 500_000);
        _assertSolvent();

        // Without a pending close the liquidation emits no cancellation.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(bob, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 1_095_000);
        vm.recordLogs();
        vm.prank(liquidator);
        ex.liquidate(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("CloseRequestCancelled(uint256,bytes4)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != topic, "spurious cancellation");
        }
    }

    // ------------------------------------------------------------ pricing

    /// @dev Oracle only: the book mid, pushed either way, settles nothing. Opens, previews,
    ///      closes and the view all read the oracle price.
    function test_pricing_oracleOnly_bookNeverSettles() public {
        // Book 1% under the oracle: every flag of execPrice is the oracle.
        _setQuotes(ASSET_A, 990_000, RAW_ONE);
        assertEq(oracle.rawMid(TIER_A), 0.99e18);
        assertEq(ex.execPrice(TIER_A, true, true), ONE);
        assertEq(ex.execPrice(TIER_A, false, true), ONE);
        assertEq(ex.execPrice(TIER_A, true, false), ONE);
        assertEq(ex.execPrice(TIER_A, false, false), ONE);
        uint256 lid = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 sid = _open(alice, TIER_A, false, MARGIN, LEV);
        assertEq(ex.positions(lid).entryPx18, ONE);
        assertEq(ex.positions(sid).entryPx18, ONE);

        // Book pushed 1% over, oracle unmoved: the long (and the short) are flat; the clamped
        // display price (1.001 with the 10 bps band) is not the settlement price either.
        _setQuotes(ASSET_A, 1_010_000, RAW_ONE);
        assertEq(oracle.price(TIER_A), 1.001e18);
        assertEq(ex.execPrice(TIER_A, true, false), ONE);
        (int256 pnl, uint256 fee, uint256 payout) = _closeMatchesPreview(alice, lid, ONE);
        assertEq(pnl, 0);
        assertEq(fee, 0);
        assertEq(payout, MARGIN);
        _setQuotes(ASSET_A, 990_000, RAW_ONE);
        (pnl,, payout) = _closeMatchesPreview(alice, sid, ONE);
        assertEq(pnl, 0);
        assertEq(payout, MARGIN);

        // The oracle moving is what pays. Long at 1.000; book 1.010, oracle 1.002 -> exit
        // 1.002; after the 1 bps deadband 1.0018998; raw gain = 1000 x 0.0018998 = 1.899800;
        // scale(move 0.18998%) = 0.806399...; adjusted 1.531998; fee 5% = 0.076599; profit
        // 1.455399.
        _setPx(ASSET_A, RAW_ONE);
        lid = _open(alice, TIER_A, true, MARGIN, LEV);
        _setQuotes(ASSET_A, 1_010_000, 1_002_000);
        (pnl, fee, payout) = _closeMatchesPreview(alice, lid, 1.002e18);
        assertEq(pnl, 1_455_399);
        assertEq(fee, 76_599);
        assertEq(payout, 101_455_399);
        // Short mirror: at 1.000; book 0.990, oracle 0.998 -> exit 0.998; deadband (rounded
        // up) 0.9980998; raw gain 1.900200; scale 0.806417...; adjusted 1.532354; fee
        // 0.076617; profit 1.455737.
        _setPx(ASSET_A, RAW_ONE);
        sid = _open(alice, TIER_A, false, MARGIN, LEV);
        _setQuotes(ASSET_A, 990_000, 998_000);
        (pnl, fee, payout) = _closeMatchesPreview(alice, sid, 0.998e18);
        assertEq(pnl, 1_455_737);
        assertEq(fee, 76_617);
        assertEq(payout, 101_455_737);
        _assertSolvent();
    }

    /// @dev A dead or zero oracle blocks every settlement path and the view; a dead book changes
    ///      nothing; a request filed before an outage waits it out; `retire` freezes the oracle
    ///      price, not the clamped mid.
    function test_feeds_oracleDeadBlocks_bookDeadDoesNot_retireFreezesOracle() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);

        source.setOracleReverts(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.requestClose(id);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.liquidate(id);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.previewClose(id);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.execPrice(TIER_A, true, false);
        source.setOracleReverts(false);

        // A close requested before an outage cannot execute during it and stays pending.
        _requestClose(alice, id);
        source.setOracleReverts(true);
        _tick();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.executeClose(id);
        assertGt(ex.closeRequest(id).requestedAt, 0);
        source.setOracleReverts(false);

        // A zero oracle quote: ZeroPrice. A zero or dead book: nothing changes.
        _setQuotes(ASSET_A, RAW_ONE, 0);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, TIER_A));
        ex.execPrice(TIER_A, false, true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, TIER_A));
        ex.requestOpen(TIER_A, false, MARGIN, LEV, address(0));
        source.setQuote(ASSET_A, 0, 0, RAW_ONE, RAW_ONE);
        assertEq(ex.execPrice(TIER_A, true, true), ONE);
        source.setReverts(true, false);
        assertEq(ex.execPrice(TIER_A, true, true), ONE);
        vm.prank(keeper);
        (uint256 paid,) = ex.executeClose(id); // the pending close settles, flat, on the oracle
        assertEq(paid, MARGIN);
        source.setReverts(false, false);

        // `retire` freezes the ORACLE price: book 1.020, oracle 1.010 (clamped mid 1.011) ->
        // 1.010. Afterwards the frozen price serves every side, feeds dead or not.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setQuotes(ASSET_A, 1_020_000, 1_010_000);
        assertEq(oracle.price(TIER_A), 1.01101e18); // 1.010 x (1 + 10 bps)
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.InstrumentRetired(TIER_A, 1.01e18);
        ex.retire(TIER_A);
        source.setReverts(true, true);
        assertEq(ex.execPrice(TIER_A, true, true), 1.01e18);
        assertEq(ex.execPrice(TIER_A, false, false), 1.01e18);
        // alice's long settles at 1.01: the 1% vector (8.714963 - fee 0.435748 = 8.279215).
        (int256 pnl,, uint256 payout) = _closeMatchesPreview(alice, id, 1.01e18);
        assertEq(pnl, 8_279_215);
        assertEq(payout, 108_279_215);
        // A close on a retired market leaves the frozen price alone.
        assertEq(ex.instrument(TIER_A).lastPx18, 1.01e18);
        _assertSolvent();
    }
    // ------------------------------------------------------------ close: wins

    function test_close_longWin_onePercent_exactNumbers() public {
        _seedLpWithFullLoss(bob);
        uint256 lpBefore = ex.lpBalance();
        uint256 poolBefore = ex.feePool();
        int256 netBefore = _windowNet();
        uint256 supplyBefore = usdc.totalSupply();

        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        // exit after 1 bps deadband = 1.009899; rawGain = 1000 * 0.009899 = 9.899000
        // scale(move 0.9899%) = 0.880388...; adjusted = 8.714963;
        // fee = 5% x 8.714963 = 0.43574815 -> 0.435748; profit = 8.714963 - 0.435748 = 8.279215.
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(id);
        assertEq(pnl, 8_279_215);
        assertEq(fee, 435_748);
        assertEq(payout, 108_279_215);

        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(id, alice, 1.01e18, 8_279_215, 435_748, 108_279_215, 0, 0, true);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, 108_279_215);
        assertEq(queued, 0);

        assertEq(ex.balanceOf(alice), 1000e6 + 8_279_215);
        assertEq(ex.lpBalance(), lpBefore - 8_279_215);
        assertEq(ex.feePool(), poolBefore + 435_748);
        // The breaker carries the whole adjusted gain, fee included.
        assertEq(_windowNet() - netBefore, 8_714_963);
        // A win creates nothing: no token, no USDC, just a move from house cash to the trader.
        assertEq(usdc.totalSupply(), supplyBefore);
        assertEq(ex.positions(id).owner, address(0));
        assertEq(ex.positionIdsOf(alice).length, 0);
        assertEq(ex.marginInUse(alice), 0);
        assertEq(ex.closeRequest(id).requestedAt, 0);
        assertEq(ex.openMaxPayoutUsdc(), 0);
        assertEq(ex.houseExposureUsdc(), 0);
        // About 88% of the raw gain survives the impact curve at a 1% move.
        assertApproxEqRel(uint256(8_714_963), uint256(9_899_000) * 88 / 100, 0.01e18);
        _assertSolvent();
    }

    function test_close_longWin_tenthPercent_exactNumbers() public {
        _seedLpWithFullLoss(bob);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_001_000);
        // exit after deadband = 1.0008999; rawGain = 0.899900; scale = 0.722867...;
        // adjusted = 0.650508; fee = 5% x 0.650508 = 0.0325254 -> 0.032525;
        // profit = 0.650508 - 0.032525 = 0.617983.
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, 100_617_983);
        assertEq(queued, 0);
        assertEq(ex.feePool(), 5_000_000 + 32_525); // seed fee 5% x 100 = 5, plus this win's
        // Pure 0.1% move keeps ~74%; after the deadband eats 1 bps of it, ~72%.
        assertApproxEqRel(uint256(650_508), uint256(899_900) * 7229 / 10_000, 0.001e18);
        _assertSolvent();
    }

    function test_close_shortWin_exactNumbers() public {
        _seedLpWithFullLoss(bob);
        uint256 id = _open(alice, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 990_000);
        // exit after deadband (rounded up) = 0.990099; rawGain = 9.901000; adjusted = 8.716762;
        // fee = 5% x 8.716762 = 0.4358381 -> 0.435838; profit = 8.716762 - 0.435838 = 8.280924.
        (int256 pnl, uint256 fee,) = ex.previewClose(id);
        assertEq(pnl, 8_280_924);
        assertEq(fee, 435_838);
        int256 netBefore = _windowNet();
        (uint256 paid,) = _close(alice, id);
        assertEq(paid, 108_280_924);
        assertEq(_windowNet() - netBefore, 8_716_762);
        _assertSolvent();
    }

    function test_close_deadbandKillsTinyGain() public {
        _seedLpWithFullLoss(bob);
        uint256 lpBefore = ex.lpBalance();
        uint256 poolBefore = ex.feePool();
        int256 netBefore = _windowNet();
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_000_050); // +0.5 bps, inside the 1 bps deadband
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(id);
        assertEq(pnl, 0);
        assertEq(fee, 0);
        assertEq(payout, MARGIN);
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, MARGIN);
        assertEq(queued, 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(ex.lpBalance(), lpBefore);
        assertEq(ex.feePool(), poolBefore);
        assertEq(_windowNet(), netBefore);
    }

    function test_close_flatPriceReturnsMargin() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, MARGIN);
        assertEq(queued, 0);
        assertEq(ex.balanceOf(alice), 1000e6);
        assertEq(ex.lpBalance(), HOUSE);
        assertEq(ex.feePool(), 0);
    }

    function test_close_winCappedAtPayoutCapX_excessStaysInLp() public {
        // $100 at 1000x ($100K notional) and a 10% move. The curve keeps about $8,970 of the
        // $9,989 raw gain (after the 1 bps deadband), far above the stamped maximum profit
        // min(50 x 100, 25% x 100,000) = $5,000; the cap applies before the win fee and the
        // excess never leaves the house.
        uint256 id = _open(alice, TIER_A, true, MARGIN, 1000);
        assertEq(ex.positions(id).maxProfitUsdc, 5_000e6);
        _setPx(ASSET_A, 1_100_000);
        uint256 exit = ImpactLib.deadbandExit(1.1e18, true, 1);
        (uint256 gain, uint256 move) = ImpactLib.rawGain(100_000e6, ONE, exit, true);
        uint256 uncapped = ImpactLib.adjustedGain(gain, move, _launchCurve());
        assertGt(uncapped, 8_900e6);
        assertLt(uncapped, 9_000e6);
        uint256 cap = 50 * uint256(MARGIN);
        uint256 fee = ImpactLib.winFee(cap, ex.winFeeBps());
        uint256 profit = cap - fee;
        // fee = 5% x 5,000 = 250; profit = 5,000 - 250 = 4,750.
        assertEq(fee, 250e6);
        assertEq(profit, 4_750e6);

        (int256 pnl, uint256 pfee, uint256 payout) = ex.previewClose(id);
        assertEq(pnl, int256(profit));
        assertEq(pfee, fee);
        assertEq(payout, MARGIN + profit);

        int256 netBefore = _windowNet();
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.PayoutCapped(id, cap, uncapped - cap);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(id, alice, 1.1e18, int256(profit), fee, MARGIN + profit, 0, 0, true);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, MARGIN + profit); // the house pays the capped profit on the spot
        assertEq(queued, 0);
        assertEq(ex.feePool(), fee);
        assertEq(ex.lpBalance(), HOUSE - profit);
        assertEq(_windowNet() - netBefore, int256(cap)); // the house's liability is the capped gain
        _assertSolvent();

        // A win under the cap is untouched: 1% at 10x is 0.087x margin (adjusted 8.714963,
        // less the 5% fee of 0.435748 = 8.279215, as in the exact-numbers test).
        _setPx(ASSET_A, RAW_ONE);
        id = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        (pnl,,) = ex.previewClose(id);
        assertEq(pnl, 8_279_215);
    }

    // ---------------------------------------------------------- close: losses

    function test_close_longLoss_exactNumbers() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        // loss = 1000 * 0.005 = 5.000000; fee = 5% x 5 = 0.250000 (queue empty); the house
        // keeps 4.75 net of the fee claim.
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(id);
        assertEq(pnl, -5_000_000);
        assertEq(fee, 250_000);
        assertEq(payout, 95_000_000);

        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(id, alice, 0.995e18, -5_000_000, 250_000, 95_000_000, 0, 0, true);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, 95_000_000);
        assertEq(queued, 0);

        assertEq(ex.balanceOf(alice), 995e6);
        assertEq(ex.lpBalance(), HOUSE + 5_000_000);
        assertEq(ex.feePool(), 250_000);
        assertEq(ex.houseFreeUsdc(), HOUSE + 4_750_000);
        assertEq(_windowNet(), -4_750_000); // the breaker counts the house's net gain
        _assertSolvent();
    }

    function test_close_shortLoss() public {
        uint256 id = _open(alice, TIER_A, false, MARGIN, LEV);
        _setPx(ASSET_A, 1_005_000);
        (uint256 paid,) = _close(alice, id);
        // Same $5 loss as the long: fee 0.25, the house keeps 4.75 net.
        assertEq(paid, 95_000_000);
        assertEq(ex.feePool(), 250_000);
        assertEq(ex.lpBalance(), HOUSE + 5_000_000);
        _assertSolvent();
    }

    function test_close_lossCappedAtMargin() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 800_000); // -20% at 10x would be -$200; capped at the $100 margin
        (uint256 paid,) = _close(alice, id);
        // loss capped at 100; fee = 5% x 100 = 5.
        assertEq(paid, 0);
        assertEq(ex.balanceOf(alice), 900e6);
        assertEq(ex.lpBalance(), HOUSE + 100e6);
        assertEq(ex.feePool(), 5e6);
        _assertSolvent();
    }

    function test_close_onlyOwner_andUnknown() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotPositionOwner.selector, id, bob));
        ex.requestClose(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownPosition.selector, 42));
        ex.requestClose(42);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownPosition.selector, 42));
        ex.previewClose(42);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownPosition.selector, 42));
        ex.bustPrice(42);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownPosition.selector, 42));
        ex.borrowOwed(42);
        // Closing twice fails: the position is gone.
        _close(alice, id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownPosition.selector, id));
        ex.requestClose(id);
    }

    // ------------------------------------------------------------ liquidation

    function test_liquidate_longAtBustPrice_withBounty() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        assertEq(ex.bustPrice(id), 0.905e18);

        // One wei above bust: not liquidatable.
        _setPx(ASSET_A, 905_001);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, id, 905_001e12, 0.905e18));
        ex.liquidate(id);

        // bounty = 0.5% x 100 = 0.5; fee = 5% x 100 = 5; house gain = 100 - 0.5 - 5 = 94.5.
        _setPx(ASSET_A, 905_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionLiquidated(id, alice, liquidator, 0.905e18, MARGIN, 500_000, 5_000_000);
        uint256 bounty = ex.liquidate(id);
        assertEq(bounty, 500_000);

        assertEq(ex.balanceOf(liquidator), 500_000);
        assertEq(ex.balanceOf(alice), 900e6);
        assertEq(ex.marginInUse(alice), 0);
        assertEq(ex.lpBalance(), HOUSE + 99_500_000); // margin minus bounty; the fee is a claim on it
        assertEq(ex.feePool(), 5_000_000);
        assertEq(_windowNet(), -94_500_000);
        assertEq(ex.positions(id).owner, address(0));
        (uint256 longOi,) = ex.openInterest(TIER_A);
        assertEq(longOi, 0);
        assertEq(ex.openMaxPayoutUsdc(), 0);
        _assertSolvent();
    }

    function test_liquidate_short() public {
        uint256 id = _open(alice, TIER_A, false, MARGIN, LEV);
        assertEq(ex.bustPrice(id), 1.095e18);
        _setPx(ASSET_A, 1_094_999);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, id, 1_094_999e12, 1.095e18));
        ex.liquidate(id);
        _setPx(ASSET_A, 1_095_000);
        vm.prank(liquidator);
        assertEq(ex.liquidate(id), 500_000);
        _assertSolvent();
    }

    function test_liquidate_thousandX_fiveBpsMove() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, 1000);
        assertEq(ex.bustPrice(id), 0.9995e18);
        _setPx(ASSET_A, 999_501); // -4.99 bps: one tick short of bust
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, id, 999_501e12, 0.9995e18));
        ex.liquidate(id);
        _setPx(ASSET_A, 999_500); // -5 bps busts a 1000x long
        vm.prank(liquidator);
        ex.liquidate(id);
        assertEq(ex.lpBalance(), HOUSE + 99_500_000);
    }

    function test_liquidate_whileQueueActive_noFee() public {
        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV);
        _queueOneWin(); // alice is owed; queue non-empty, house empty
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionLiquidated(id, bob, liquidator, 0.9e18, MARGIN, 500_000, 0);
        ex.liquidate(id);
        assertEq(ex.feePool(), 2_235_395); // only alice's win fee, no liquidation fee
        assertEq(ex.lpBalance(), 99_500_000); // 100 - 0.5 bounty, nothing carved
        _assertSolvent();
    }

    function test_liquidate_unknownPosition() public {
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownPosition.selector, 5));
        ex.liquidate(5);
    }

    /// @dev Oracle only: a book pushed past bust never liquidates, the oracle at bust always
    ///      does, whatever the book shows.
    function test_liquidate_oracleOnly_pushedBookNeverLiquidates_oracleAtBustDoes() public {
        // 1000x long at 1.000: bust = 1.000 x (1 - 5 bps) = 0.9995 (the gap rule, not 0.95 / L).
        uint256 id = _open(alice, TIER_A, true, MARGIN, 1000);
        assertEq(ex.bustPrice(id), 0.9995e18);
        _setQuotes(ASSET_A, 900_000, RAW_ONE); // book 10% under, oracle unmoved
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, id, ONE, 0.9995e18));
        ex.liquidate(id);
        // Oracle exactly on bust with the book 10% over: liquidates at the oracle. Same split as
        // any liquidation: bounty 0.5, fee 5.
        _setQuotes(ASSET_A, 1_100_000, 999_500);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionLiquidated(id, alice, liquidator, 0.9995e18, MARGIN, 500_000, 5_000_000);
        assertEq(ex.liquidate(id), 500_000);
        assertEq(ex.lpBalance(), HOUSE + 99_500_000);

        // Short mirror: bust 1.0005; book 10% over and oracle flat holds; oracle at bust busts.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, false, MARGIN, 1000);
        assertEq(ex.bustPrice(id), 1.0005e18);
        _setQuotes(ASSET_A, 1_100_000, RAW_ONE);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, id, ONE, 1.0005e18));
        ex.liquidate(id);
        _setQuotes(ASSET_A, 900_000, 1_000_500);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionLiquidated(id, alice, liquidator, 1.0005e18, MARGIN, 500_000, 5_000_000);
        assertEq(ex.liquidate(id), 500_000);
        _assertSolvent();
    }

    // ------------------------------------------------------------------ queue

    /// @dev alice opens, the owner takes all free house cash out, and alice wins on a 5% move
    ///      of $1000: adjusted gain 44.707911; fee = 5% x 44.707911 = 2.23539555 -> 2.235395;
    ///      profit = 44.707911 - 2.235395 = 42.472516, all queued; margin back now. Positions
    ///      a test needs later must be opened before this (nothing opens on an empty house).
    function _queueOneWin() internal returns (uint256 queued) {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _drainHouse();
        assertEq(ex.lpBalance(), 0);
        _setPx(ASSET_A, 1_050_000);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.QueueAppended(0, alice, 42_472_516);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(id, alice, 1.05e18, 42_472_516, 2_235_395, MARGIN, 42_472_516, 0, true);
        (uint256 paid, uint256 q) = ex.executeClose(id);
        assertEq(paid, MARGIN);
        assertEq(q, 42_472_516);
        _setPx(ASSET_A, RAW_ONE);
        return q;
    }

    function test_win_queuedWhenHouseEmpty() public {
        _queueOneWin();
        assertEq(ex.balanceOf(alice), 1000e6); // margin returned immediately
        assertEq(ex.queueLength(), 1);
        assertEq(ex.queueHead(), 0);
        assertEq(ex.queuedTotal(), 42_472_516);
        (address recipient, uint256 owed) = ex.queueEntry(0);
        assertEq(recipient, alice);
        assertEq(owed, 42_472_516);
        assertEq(ex.feePool(), 2_235_395);
        assertEq(ex.lpBalance(), 0);
        assertEq(ex.houseFreeUsdc(), 0);
        // Nothing opens on an empty house: the house-sized position cap is 0.
        assertEq(ex.maxPositionUsd(TIER_A, true), 0);
        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        ex.requestOpen(TIER_A, true, 5e6, 1, address(0));
        _assertSolvent();
    }

    function test_win_partialPayThenQueueRemainder() public {
        // House drained with both positions open; bob's small loss leaves $5 of cash; alice's
        // $42.47 profit (5% move, as in _queueOneWin) is paid $5 now, the rest queued:
        // 42.472516 - 5 = 37.472516.
        uint256 lid = _open(bob, TIER_A, true, MARGIN, LEV);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _drainHouse();
        _setPx(ASSET_A, 995_000);
        _close(bob, lid);
        assertEq(ex.lpBalance(), 5_000_000);
        _setPx(ASSET_A, 1_050_000);
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, MARGIN + 5_000_000);
        assertEq(queued, 42_472_516 - 5_000_000);
        assertEq(ex.lpBalance(), 0);
        assertEq(ex.queuedTotal(), 37_472_516);
        _assertSolvent();
    }

    function test_win_queuedWhileQueueActiveEvenIfLpHasCash() public {
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV);
        _queueOneWin();
        // carol's loss puts $50 in the house but the queue is still owed, so bob's win is
        // queued too.
        _setPx(ASSET_A, 950_000);
        _close(carol, cid);
        assertEq(ex.lpBalance(), 50e6);
        _setPx(ASSET_A, 1_020_000);
        // 2% move: adjusted 17.711913; fee = 5% x 17.711913 = 0.88559565 -> 0.885595;
        // profit = 17.711913 - 0.885595 = 16.826318, queued behind alice despite the $50.
        _requestClose(bob, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.QueueAppended(1, bob, 16_826_318);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, MARGIN);
        assertEq(queued, 16_826_318);
        assertEq(ex.lpBalance(), 50e6);
        assertEq(ex.queueLength(), 2);
        // A fresh deposit does not jump the queue either: it waits for a harvest.
        _depositHouse(1_000e6);
        assertEq(ex.queuedTotal(), 42_472_516 + 16_826_318);
        _assertSolvent();
    }

    function test_loss_whileQueueActive_noFee() public {
        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV);
        _queueOneWin();
        _setPx(ASSET_A, 995_000);
        (uint256 paid,) = _close(bob, id);
        assertEq(paid, 95_000_000);
        assertEq(ex.feePool(), 2_235_395); // alice's win fee only: no loss fee carved
        assertEq(ex.lpBalance(), 5_000_000); // the whole loss refills the house
        _assertSolvent();
    }

    /// @dev `previewClose` carves the loss fee exactly as the close would at that moment: none
    ///      while the queue is owed, the stamped rate once it is drained.
    function test_previewClose_lossFee_followsQueueState_matchesClose() public {
        uint256 bid = _open(bob, TIER_A, true, MARGIN, LEV);
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        uint256 cid = _open(carol, TIER_B, true, MARGIN, LEV);
        _queueOneWin(); // alice is owed 42.472516; the house is empty
        _setPx(ASSET_A, 995_000);

        // Queue active: no fee in the preview, none in the close.
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(bid);
        assertEq(pnl, -5_000_000);
        assertEq(fee, 0);
        assertEq(payout, 95_000_000);
        _requestClose(bob, bid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(bid, bob, 0.995e18, -5_000_000, 0, 95_000_000, 0, 0, true);
        (uint256 paid,) = ex.executeClose(bid);
        assertEq(paid, 95_000_000);
        assertEq(ex.feePool(), 2_235_395); // alice's win fee only
        (, fee,) = ex.previewClose(did);
        assertEq(fee, 0);

        // carol's $50 loss on another market refills the house (no fee either) and a harvest
        // drains the queue; the same open position now previews and closes with the 5% fee.
        _setPx(ASSET_B, 950_000);
        _close(carol, cid);
        assertEq(ex.lpBalance(), 55_000_000);
        ex.harvest(1);
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.lpBalance(), 55_000_000 - 42_472_516);
        (pnl, fee, payout) = ex.previewClose(did);
        assertEq(pnl, -5_000_000);
        assertEq(fee, 250_000);
        assertEq(payout, 95_000_000);
        _requestClose(dave, did);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(did, dave, 0.995e18, -5_000_000, 250_000, 95_000_000, 0, 0, true);
        (paid,) = ex.executeClose(did);
        assertEq(paid, 95_000_000);
        assertEq(ex.feePool(), 2_235_395 + 250_000);
        _assertSolvent();
    }

    function test_harvest_fifoOrderAndPartialPayments() public {
        // Every position opens on a funded house; then the house is drained. Two queued
        // winners (profits after the 5% fee): alice $42.472516 (5% move), bob $16.826318 (2%).
        uint256 bid = _open(bob, TIER_A, true, MARGIN, LEV);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        _queueOneWin();
        _setPx(ASSET_A, 1_020_000);
        _close(bob, bid);
        _setPx(ASSET_A, RAW_ONE);
        assertEq(ex.queuedTotal(), 42_472_516 + 16_826_318);

        // carol loses $50 (queue active: no fee).
        _setPx(ASSET_A, 950_000);
        _close(carol, cid);
        assertEq(ex.lpBalance(), 50e6);

        // harvest(1): alice is paid in full and retired; bob untouched. House 50 - 42.472516 =
        // 7.527484.
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.QueuePaid(0, alice, 42_472_516, 0);
        (uint256 n, uint256 paid) = ex.harvest(1);
        assertEq(n, 1);
        assertEq(paid, 42_472_516);
        assertEq(ex.balanceOf(alice), 1000e6 + 42_472_516);
        assertEq(ex.queueHead(), 1);
        assertEq(ex.lpBalance(), 7_527_484);

        // harvest(5): bob gets the remaining $7.527484 and is still owed 16.826318 - 7.527484 =
        // 9.298834; the entry stays at the head and the house empties.
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.QueuePaid(1, bob, 7_527_484, 9_298_834);
        (n, paid) = ex.harvest(5);
        assertEq(n, 1);
        assertEq(paid, 7_527_484);
        assertEq(ex.queueHead(), 1);
        (, uint256 owed) = ex.queueEntry(1);
        assertEq(owed, 9_298_834);
        assertEq(ex.queuedTotal(), 9_298_834);
        assertEq(ex.lpBalance(), 0);

        // Nothing to pay with: no revert, nothing happens.
        (n, paid) = ex.harvest(5);
        assertEq(n, 0);
        assertEq(paid, 0);

        // dave loses $50 (bob is still owed, so no fee); the rest of bob's entry is paid and
        // the queue empties: house 50 - 9.298834 = 40.701166.
        _close(dave, did);
        (n, paid) = ex.harvest(5);
        assertEq(n, 1);
        assertEq(paid, 9_298_834);
        assertEq(ex.balanceOf(bob), 1000e6 + 16_826_318);
        assertEq(ex.queueHead(), ex.queueLength());
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.lpBalance(), 40_701_166);
        _assertSolvent();

        vm.expectRevert(IExchangeTypes.QueueEmpty.selector);
        ex.harvest(1);
    }

    function test_harvest_emptyQueueReverts() public {
        vm.expectRevert(IExchangeTypes.QueueEmpty.selector);
        ex.harvest(10);
    }
    // ------------------------------------------------------------------- fees

    /// @dev The constructor's staker share is 0, so a push hands the whole pool to the fee
    ///      recipient and never calls Staking; the owner may set any share up to 100%.
    function test_pushFees_defaultAllToRecipient_stakerShareSettable() public {
        assertEq(ex.stakerFeeShareBps(), 0);
        _seedLpWithFullLoss(bob); // house +$100, pool 5% x 100 = $5
        uint256 lpBefore = ex.lpBalance();
        uint256 freeBefore = ex.houseFreeUsdc();

        vm.prank(stranger);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.FeesPushed(0, 5_000_000);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 5_000_000);
        assertEq(ex.feePool(), 0);
        assertEq(ex.lpBalance(), lpBefore - 5_000_000);
        assertEq(ex.houseFreeUsdc(), freeBefore); // the pool was never free cash
        assertEq(ex.balanceOf(feeRecipient), 5_000_000);
        assertEq(staking.notifyCalls(), 0);
        assertEq(usdc.balanceOf(address(staking)), 0);
        _assertSolvent();

        // Owner only, at most 100%, announced.
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setStakerFeeShare(4000);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.StakerFeeShareBps, 10_001));
        ex.setStakerFeeShare(10_001);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.StakerFeeShareSet(4000);
        ex.setStakerFeeShare(4000);
        vm.stopPrank();
        assertEq(ex.stakerFeeShareBps(), 4000);

        // At 40%: stakers = 40% x 5 = 2; recipient = 5 - 2 = 3.
        _seedLpWithFullLoss(carol);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.FeesPushed(2_000_000, 3_000_000);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 2_000_000);
        assertEq(toRecipient, 3_000_000);
        assertEq(ex.balanceOf(feeRecipient), 8_000_000);
        assertEq(usdc.balanceOf(address(staking)), 2_000_000);
        assertEq(staking.notifyCalls(), 1);
        assertEq(staking.lastNotifier(), address(ex));
        assertEq(staking.lastNotifiedUsdc(), 2_000_000);
        assertEq(usdc.allowance(address(ex), address(staking)), 0);

        // Rounding favours the recipient. A 25-tick drop on $10 at 1x loses 250 units
        // (0.000250 USDC); fee = 5% x 250 = 12.5 -> 12; stakers 40% x 12 = 4.8 -> 4,
        // recipient 12 - 4 = 8.
        uint256 id = _open(alice, TIER_A, true, 10e6, 1);
        _setPx(ASSET_A, 999_975);
        _close(alice, id);
        assertEq(ex.feePool(), 12);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 4);
        assertEq(toRecipient, 8);

        // 100%: everything to stakers.
        vm.prank(owner);
        ex.setStakerFeeShare(10_000);
        _seedLpWithFullLoss(dave);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 5_000_000);
        assertEq(toRecipient, 0);
        _assertSolvent();
    }

    function test_pushFees_dustPool_allToRecipient_skipsZeroStakerReward() public {
        vm.prank(owner);
        ex.setStakerFeeShare(4000);
        // $10 at 1x loses 10 units per raw tick: 2 ticks -> loss 20, fee 5% x 20 = 1.
        uint256 id = _open(alice, TIER_A, true, 10e6, 1);
        _setPx(ASSET_A, 999_998);
        _close(alice, id);
        assertEq(ex.feePool(), 1);
        // Pool 1: stakers 40% x 1 = 0.4 -> 0, recipient 1; Staking (which rejects a zero
        // reward) is never called.
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.FeesPushed(0, 1);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 1);
        assertEq(staking.notifyCalls(), 0);
        assertEq(usdc.balanceOf(address(staking)), 0);
        assertEq(usdc.allowance(address(ex), address(staking)), 0);
        assertEq(ex.balanceOf(feeRecipient), 1);
        assertEq(ex.feePool(), 0);
        assertEq(ex.lpBalance(), HOUSE + 20 - 1);
        _assertSolvent();

        // Pool 2: 4 ticks -> loss 40, fee 2; stakers 40% x 2 = 0.8 -> 0, recipient 2.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, 10e6, 1);
        _setPx(ASSET_A, 999_996);
        _close(alice, id);
        assertEq(ex.feePool(), 2);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 2);
        assertEq(staking.notifyCalls(), 0);
        assertEq(ex.balanceOf(feeRecipient), 1 + 2);

        // Pool 7: 14 ticks -> loss 140, fee 7; stakers 40% x 7 = 2.8 -> 2, recipient 7 - 2 = 5.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, 10e6, 1);
        _setPx(ASSET_A, 999_986);
        _close(alice, id);
        assertEq(ex.feePool(), 7);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.FeesPushed(2, 5);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 2);
        assertEq(toRecipient, 5);
        assertEq(staking.notifyCalls(), 1);
        assertEq(staking.lastNotifiedUsdc(), 2);
        assertEq(usdc.balanceOf(address(staking)), 2);
        assertEq(ex.balanceOf(feeRecipient), 1 + 2 + 5);
        assertEq(ex.lpBalance(), HOUSE + (20 - 1) + (40 - 2) + (140 - 7));
        _assertSolvent();
    }

    function test_pushFees_gatedByQueueAndLpCash() public {
        vm.prank(owner);
        ex.setStakerFeeShare(4000);
        vm.expectRevert(IExchangeTypes.NothingToPush.selector); // empty pool
        ex.pushFees();

        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV);
        _queueOneWin(); // pool 2.235395 but queue active
        vm.expectRevert(IExchangeTypes.NothingToPush.selector);
        ex.pushFees();

        // bob loses $50: house $50, queue still owed $42.47 -> still gated.
        _setPx(ASSET_A, 950_000);
        _close(bob, id);
        vm.expectRevert(IExchangeTypes.NothingToPush.selector);
        ex.pushFees();

        // Harvest clears the queue; house 50 - 42.472516 = $7.527484 covers the $2.235395 pool.
        // stakers = 40% x 2.235395 = 0.894158; recipient = 2.235395 - 0.894158 = 1.341237.
        ex.harvest(10);
        assertEq(ex.lpBalance(), 7_527_484);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 894_158);
        assertEq(toRecipient, 1_341_237);
        assertEq(ex.lpBalance(), 7_527_484 - 2_235_395);
        _assertSolvent();
    }

    function test_pushFees_revertsWhenLpCannotCoverPool() public {
        // alice's $9,000 long and bob's $1,000 long on another market open on a funded house;
        // the house is drained; bob's full loss builds $100 of cash and a $5 pool; alice's win
        // then drains the cash below the pool.
        uint256 id = _open(alice, TIER_A, true, 900e6, 10);
        uint256 lid = _open(bob, TIER_B, true, MARGIN, LEV);
        _drainHouse();
        _setPx(ASSET_B, 900_000);
        _close(bob, lid);
        assertEq(ex.lpBalance(), 100e6);
        assertEq(ex.feePool(), 5e6);
        _setPx(ASSET_A, 1_020_000);
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, 900e6 + 100e6); // every dollar of house cash goes to alice
        assertGt(queued, 0);
        assertEq(ex.lpBalance(), 0);
        ex.harvest(10); // nothing to pay with, but keeps the queue non-empty
        vm.expectRevert(IExchangeTypes.NothingToPush.selector);
        ex.pushFees();

        // A house deposit refills, a harvest clears the queue, then a push works.
        _depositHouse(1_000e6);
        ex.harvest(10);
        assertEq(ex.queuedTotal(), 0);
        assertGe(ex.lpBalance(), ex.feePool());
        (uint256 a, uint256 b) = ex.pushFees();
        assertGt(a + b, 0);
        _assertSolvent();
    }

    // ------------------------------------------------------ fee rate setter

    function test_setFeeBps_ownerOnly_boundsPerSide_emits() public {
        // A fresh core starts at the v4 defaults (5% win, 5% loss) and announces them.
        ExchangeExt e2 = new ExchangeExt(usdc, oracle, IStaking(address(staking)), owner);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.FeeBpsSet(500, 500);
        Exchange c2 = new Exchange(usdc, oracle, IStaking(address(staking)), e2, IReferrals(address(0)), owner, feeRecipient);
        assertEq(IExchange(address(c2)).winFeeBps(), 500);
        assertEq(IExchange(address(c2)).lossFeeBps(), 500);
        // The fixture runs 5% / 5%.
        assertEq(ex.winFeeBps(), 500);
        assertEq(ex.lossFeeBps(), 500);

        // Owner only: the guardian, both keepers and strangers are refused.
        address[4] memory notOwner = [stranger, guardian, keeper, marketKeeper];
        for (uint256 i = 0; i < notOwner.length; i++) {
            vm.prank(notOwner[i]);
            vm.expectRevert(_unauthorized(notOwner[i]));
            ex.setFeeBps(100, 100);
        }

        // Win never above 10%, loss never above 5%; the win side is checked first.
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.WinFeeBps, 1001));
        ex.setFeeBps(1001, 0);
        vm.expectRevert(_oob(IExchangeTypes.Param.LossFeeBps, 501));
        ex.setFeeBps(0, 501);
        vm.expectRevert(_oob(IExchangeTypes.Param.WinFeeBps, 1001));
        ex.setFeeBps(1001, 501);
        vm.expectRevert(_oob(IExchangeTypes.Param.WinFeeBps, type(uint16).max));
        ex.setFeeBps(type(uint16).max, 0);
        assertEq(ex.winFeeBps(), 500);
        assertEq(ex.lossFeeBps(), 500);

        // Anything in range is accepted and announced, the ceilings included.
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.FeeBpsSet(1000, 500);
        ex.setFeeBps(1000, 500);
        assertEq(ex.winFeeBps(), 1000);
        assertEq(ex.lossFeeBps(), 500);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.FeeBpsSet(0, 0);
        ex.setFeeBps(0, 0);
        assertEq(ex.winFeeBps(), 0);
        assertEq(ex.lossFeeBps(), 0);
        vm.stopPrank();
    }

    function test_setFeeBps_lowerRate_appliesToNextWinLossAndLiquidation() public {
        vm.prank(owner);
        ex.setFeeBps(100, 100); // 1% / 1%

        // Loss: bob loses his whole $100. fee = 1% x 100 = 1.
        uint256 bid = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        (, uint256 fee,) = ex.previewClose(bid);
        assertEq(fee, 1_000_000);
        _requestClose(bob, bid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(bid, bob, 0.9e18, -100e6, 1_000_000, 0, 0, 0, true);
        ex.executeClose(bid);
        assertEq(ex.feePool(), 1_000_000);
        assertEq(_windowNet(), -99e6);
        _setPx(ASSET_A, RAW_ONE);

        // Win: alice's 1% move, adjusted 8.714963; fee = 1% x 8.714963 = 0.08714963 ->
        // 0.087149; profit = 8.714963 - 0.087149 = 8.627814.
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        _requestClose(alice, aid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(aid, alice, 1.01e18, 8_627_814, 87_149, 108_627_814, 0, 0, true);
        ex.executeClose(aid);
        assertEq(ex.feePool(), 1_000_000 + 87_149);
        _setPx(ASSET_A, RAW_ONE);

        // Liquidation: dave's $100 margin. bounty 0.5% x 100 = 0.5; fee = 1% x 100 = 1;
        // house gain = 100 - 0.5 - 1 = 98.5.
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        int256 netBefore = _windowNet();
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionLiquidated(did, dave, liquidator, 0.9e18, MARGIN, 500_000, 1_000_000);
        ex.liquidate(did);
        assertEq(ex.feePool(), 1_000_000 + 87_149 + 1_000_000);
        assertEq(_windowNet() - netBefore, -98_500_000);
        _setPx(ASSET_A, RAW_ONE);

        // Raised back to 5%, the next loss carves 5% again: 5% x 5 = 0.25 on carol's $5.
        vm.prank(owner);
        ex.setFeeBps(500, 500);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        (, fee,) = ex.previewClose(cid);
        assertEq(fee, 250_000);
        _close(carol, cid);
        assertEq(ex.feePool(), 2_087_149 + 250_000);
        _assertSolvent();
    }

    function test_setFeeBps_zero_noFeeAnywhere_nothingToPush() public {
        vm.prank(owner);
        ex.setFeeBps(0, 0);

        // Loss: bob's whole $100 stays with the house.
        _seedLpWithFullLoss(bob);
        assertEq(ex.feePool(), 0);
        assertEq(ex.lpBalance(), HOUSE + 100e6);

        // Win: the whole adjusted gain 8.714963 is profit.
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(aid);
        assertEq(pnl, 8_714_963);
        assertEq(fee, 0);
        assertEq(payout, 108_714_963);
        (uint256 paid,) = _close(alice, aid);
        assertEq(paid, 108_714_963);
        _setPx(ASSET_A, RAW_ONE);

        // Liquidation: the bounty is unaffected; no fee, so the house gain is 100 - 0.5 = 99.5.
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionLiquidated(did, dave, liquidator, 0.9e18, MARGIN, 500_000, 0);
        ex.liquidate(did);
        _setPx(ASSET_A, RAW_ONE);

        // The pool never filled: there is nothing to push.
        assertEq(ex.feePool(), 0);
        vm.expectRevert(IExchangeTypes.NothingToPush.selector);
        ex.pushFees();
        _assertSolvent();

        // Raised back to 5%: carol's $5 loss carves 0.25, which pushes wholly to the recipient
        // at the default zero staker share.
        vm.prank(owner);
        ex.setFeeBps(500, 500);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _close(carol, cid);
        assertEq(ex.feePool(), 250_000);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 250_000);
        _assertSolvent();
    }

    // ------------------------------------------------- terms stamped at open

    /// @dev The owner lowers the payout cap after alice opened. Her close still pays the 50x
    ///      she opened at; bob, who opens after the change, gets the new 10x. The preview
    ///      agrees with the close in both cases.
    function test_stamp_payoutCapLoweredAfterOpen_closeKeepsOpenTimeCap() public {
        // $100 at 1000x and a 10% move: the curve keeps 8,970.297561 of the 9,989 raw gain
        // (after the 1 bps deadband); capped at 50 x 100 = 5,000; fee 5% = 250; profit 4,750.
        uint256 aid = _open(alice, TIER_A, true, MARGIN, 1000);
        assertEq(ex.positions(aid).payoutCapX, 50);
        vm.prank(owner);
        ex.setPositionCaps(TIER_A, 100_000e6, 10);
        assertEq(ex.instrument(TIER_A).payoutCapX, 10);
        assertEq(ex.positions(aid).payoutCapX, 50); // the stamp is untouched
        assertEq(ex.positions(aid).maxProfitUsdc, 5_000e6);
        _setPx(ASSET_A, 1_100_000);

        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(aid);
        assertEq(pnl, 4_750e6);
        assertEq(fee, 250e6);
        assertEq(payout, MARGIN + 4_750e6);
        _requestClose(alice, aid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.PayoutCapped(aid, 5_000e6, 3_970_297_561);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(aid, alice, 1.1e18, 4_750e6, 250e6, MARGIN + 4_750e6, 0, 0, true);
        (uint256 paid, uint256 queued) = ex.executeClose(aid);
        assertEq(paid, MARGIN + 4_750e6);
        assertEq(queued, 0);

        // Bob opens after the change: capped at 10 x 100 = 1,000; fee 50; profit 950.
        _setPx(ASSET_A, RAW_ONE);
        uint256 bid = _open(bob, TIER_A, true, MARGIN, 1000);
        assertEq(ex.positions(bid).payoutCapX, 10);
        assertEq(ex.positions(bid).maxProfitUsdc, 1_000e6);
        _setPx(ASSET_A, 1_100_000);
        (pnl, fee, payout) = ex.previewClose(bid);
        assertEq(pnl, 950e6);
        assertEq(fee, 50e6);
        assertEq(payout, MARGIN + 950e6);
        _requestClose(bob, bid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.PayoutCapped(bid, 1_000e6, 7_970_297_561);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(bid, bob, 1.1e18, 950e6, 50e6, MARGIN + 950e6, 0, 0, true);
        (paid, queued) = ex.executeClose(bid);
        assertEq(paid, MARGIN + 950e6);
        assertEq(queued, 0);
        assertEq(ex.feePool(), 250e6 + 50e6);
        assertEq(ex.lpBalance(), HOUSE - 4_750e6 - 950e6);
        _assertSolvent();
    }

    /// @dev The owner widens the deadband after alice opened. Her win settles on the 1 bps she
    ///      opened at; carol, who opens after the change, settles on 50 bps.
    function test_stamp_deadbandRaisedAfterOpen_closeKeepsOpenTimeDeadband() public {
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(aid).deadbandBps, 1);
        // Same curve, deadband 1 -> 50 bps (the owner bound).
        vm.prank(owner);
        ex.setInstrumentParams(TIER_A, 50, 10, 1000, 15_000, 20_000e6, 130_000_000e6);
        assertEq(ex.instrument(TIER_A).deadbandBps, 50);
        assertEq(ex.positions(aid).deadbandBps, 1); // the stamp is untouched
        _setPx(ASSET_A, 1_010_000);

        // 1 bps: exit 1.009899, adjusted 8.714963, fee 0.435748, profit 8.279215.
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(aid);
        assertEq(pnl, 8_279_215);
        assertEq(fee, 435_748);
        assertEq(payout, 108_279_215);
        _requestClose(alice, aid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(aid, alice, 1.01e18, 8_279_215, 435_748, 108_279_215, 0, 0, true);
        (uint256 paid, uint256 queued) = ex.executeClose(aid);
        assertEq(paid, 108_279_215);
        assertEq(queued, 0);

        // Carol opens after the change: exit = 1.01 x 0.995 = 1.00495; rawGain = 1000 x 0.00495
        // = 4.950000; scale(0.495%) = 0.9 / (1 + 1/(0.00495 x 15000) + 20000/(0.00495 x 130e6))
        // = 0.9 / 1.044548 = 0.861616...; adjusted = 4.265002; fee = 5% x 4.265002 = 0.2132501
        // -> 0.213250; profit = 4.265002 - 0.213250 = 4.051752.
        _setPx(ASSET_A, RAW_ONE);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(cid).deadbandBps, 50);
        _setPx(ASSET_A, 1_010_000);
        (pnl, fee, payout) = ex.previewClose(cid);
        assertEq(pnl, 4_051_752);
        assertEq(fee, 213_250);
        assertEq(payout, 104_051_752);
        _requestClose(carol, cid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(cid, carol, 1.01e18, 4_051_752, 213_250, 104_051_752, 0, 0, true);
        (paid, queued) = ex.executeClose(cid);
        assertEq(paid, 104_051_752);
        assertEq(queued, 0);
        _assertSolvent();
    }

    /// @dev The owner lowers both fees to 1% after three positions opened at 5%. The win, the
    ///      loss and the liquidation all carve 5%, and previewClose agrees; dave, who opens
    ///      after the change, pays 1%.
    function test_stamp_feeChangedAfterOpen_closeLossAndLiquidationKeepOpenTimeRate() public {
        _seedLpWithFullLoss(bob); // pool $5
        uint256 win = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 loss = _open(carol, TIER_A, true, MARGIN, LEV);
        uint256 liq = _open(bob, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(win).winFeeBps, 500);
        vm.prank(owner);
        ex.setFeeBps(100, 100);
        assertEq(ex.winFeeBps(), 100);
        assertEq(ex.lossFeeBps(), 100);
        // The stamps are untouched.
        assertEq(ex.positions(win).winFeeBps, 500);
        assertEq(ex.positions(loss).lossFeeBps, 500);
        assertEq(ex.positions(liq).lossFeeBps, 500);

        // Win at 5%: adjusted 8.714963, fee 0.435748 (1% would be 0.087149), profit 8.279215.
        _setPx(ASSET_A, 1_010_000);
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(win);
        assertEq(pnl, 8_279_215);
        assertEq(fee, 435_748);
        assertEq(payout, 108_279_215);
        _requestClose(alice, win);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(win, alice, 1.01e18, 8_279_215, 435_748, 108_279_215, 0, 0, true);
        (uint256 paid,) = ex.executeClose(win);
        assertEq(paid, 108_279_215);
        assertEq(ex.feePool(), 5_000_000 + 435_748);

        // Loss at 5%: carol loses $5; fee 0.25 (1% would be 0.05).
        _setPx(ASSET_A, 995_000);
        (pnl, fee, payout) = ex.previewClose(loss);
        assertEq(pnl, -5e6);
        assertEq(fee, 250_000);
        assertEq(payout, 95e6);
        _requestClose(carol, loss);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(loss, carol, 0.995e18, -5e6, 250_000, 95e6, 0, 0, true);
        ex.executeClose(loss);
        assertEq(ex.feePool(), 5_000_000 + 435_748 + 250_000);

        // Liquidation at 5%: bounty 0.5; fee 5 (1% would be 1); house gain 100 - 0.5 - 5 = 94.5.
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionLiquidated(liq, bob, liquidator, 0.9e18, MARGIN, 500_000, 5_000_000);
        ex.liquidate(liq);
        assertEq(ex.feePool(), 5_000_000 + 435_748 + 250_000 + 5_000_000);

        // Dave opens after the change: 1% on the same 1% win, fee 0.087149, profit 8.627814.
        _setPx(ASSET_A, RAW_ONE);
        uint256 did = _open(dave, TIER_A, true, MARGIN, LEV);
        assertEq(ex.positions(did).winFeeBps, 100);
        assertEq(ex.positions(did).lossFeeBps, 100);
        _setPx(ASSET_A, 1_010_000);
        (pnl, fee, payout) = ex.previewClose(did);
        assertEq(pnl, 8_627_814);
        assertEq(fee, 87_149);
        assertEq(payout, 108_627_814);
        _requestClose(dave, did);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.PositionClosed(did, dave, 1.01e18, 8_627_814, 87_149, 108_627_814, 0, 0, true);
        (paid,) = ex.executeClose(did);
        assertEq(paid, 108_627_814);
        assertEq(ex.feePool(), 10_685_748 + 87_149);
        _assertSolvent();
    }

    /// @dev A stamped rate is still gated by the queue: a liquidation while the queue is
    ///      active carves nothing, whatever the position was opened at.
    function test_stamp_liquidationWhileQueueActive_stillCarvesNoFee() public {
        uint256 id = _open(bob, TIER_A, true, MARGIN, LEV); // stamped at 5%
        _queueOneWin(); // alice is owed; queue non-empty, house empty
        assertEq(ex.positions(id).lossFeeBps, 500);
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        vm.expectEmit(true, true, true, true);
        emit IExchangeTypes.PositionLiquidated(id, bob, liquidator, 0.9e18, MARGIN, 500_000, 0);
        ex.liquidate(id);
        assertEq(ex.feePool(), 2_235_395); // only alice's win fee
        _assertSolvent();
    }

    /// @dev Only the settlement terms are frozen. The impact curve is still read live (bounded
    ///      by `checkParams`, which keeps at least 50% of a 1% win).
    function test_stamp_impactCurveStaysLive() public {
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        vm.prank(owner);
        ex.setInstrumentParams(TIER_A, 1, 10, 1500, 15_000, 20_000e6, 130_000_000e6); // base 10% -> 15%
        _setPx(ASSET_A, 1_010_000);
        // Same 1 bps exit 1.009899 and raw gain 9.899000; scale = 0.85 / 1.022051 = 0.831481...;
        // adjusted = 8.230798; fee = 5% = 0.411539; profit = 7.819259 (8.279215 on the old curve).
        (int256 pnl, uint256 fee,) = ex.previewClose(aid);
        assertEq(pnl, 7_819_259);
        assertEq(fee, 411_539);
        (uint256 paid,) = _close(alice, aid);
        assertEq(paid, 107_819_259);
    }

    // --------------------------------------------------------- pause / retire

    function test_pause_market_guardianPausesOwnerResumes() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);

        vm.prank(guardian);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.MarketOpensPausedSet(TIER_A, true);
        ex.setMarketOpensPaused(TIER_A, true);
        assertTrue(ex.instrument(TIER_A).opensPaused);
        assertEq(ex.maxPositionUsd(TIER_A, true), 0);

        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.OpensPausedForMarket.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        _open(bob, TIER_B, true, MARGIN, LEV); // other markets unaffected

        // Closes and liquidations still work while paused.
        _setPx(ASSET_A, 1_010_000);
        _close(alice, id);
        uint256 id2 = _open(bob, TIER_B, false, MARGIN, LEV);
        vm.prank(guardian);
        ex.setMarketOpensPaused(TIER_B, true);
        _setPx(ASSET_B, 1_095_000);
        vm.prank(liquidator);
        ex.liquidate(id2);

        // Resuming is the owner's alone.
        address[4] memory notOwner = [guardian, marketKeeper, keeper, stranger];
        for (uint256 i = 0; i < notOwner.length; i++) {
            vm.prank(notOwner[i]);
            vm.expectRevert(IExchangeTypes.Unauthorized.selector);
            ex.setMarketOpensPaused(TIER_A, false);
        }
        // Pausing is the guardian's and the owner's only.
        vm.prank(stranger);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setMarketOpensPaused(TIER_C, true);
        vm.prank(marketKeeper);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setMarketOpensPaused(TIER_C, true);
        vm.prank(owner);
        ex.setMarketOpensPaused(TIER_A, false);
        _setPx(ASSET_A, RAW_ONE);
        _open(bob, TIER_A, true, MARGIN, LEV);
    }

    function test_pause_global() public {
        vm.prank(guardian);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.GlobalOpensPausedSet(true);
        ex.setGlobalOpensPaused(true);
        assertTrue(ex.globalOpensPaused());
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.OpensPausedGlobally.selector);
        ex.requestOpen(TIER_C, true, MARGIN, 2, address(0));

        vm.prank(guardian);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setGlobalOpensPaused(false);
        vm.prank(owner);
        ex.setGlobalOpensPaused(false);
        assertFalse(ex.globalOpensPaused());
        _open(alice, TIER_C, true, MARGIN, 2);
        // The owner may also pause.
        vm.prank(owner);
        ex.setGlobalOpensPaused(true);
        assertTrue(ex.globalOpensPaused());
    }

    function test_retire_ownerOnly_freezesPrice_closesOnly_irreversible() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 1_010_000);

        // Retiring is the owner's alone: not the guardian's, not either keeper's.
        address[4] memory notOwner = [stranger, guardian, marketKeeper, keeper];
        for (uint256 i = 0; i < notOwner.length; i++) {
            vm.prank(notOwner[i]);
            vm.expectRevert(_unauthorized(notOwner[i]));
            ex.retire(TIER_A);
        }

        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.InstrumentRetired(TIER_A, 1.01e18);
        ex.retire(TIER_A);
        IExchangeTypes.Instrument memory inst = ex.instrument(TIER_A);
        assertTrue(inst.retired);
        assertEq(inst.lastPx18, 1.01e18);

        vm.prank(owner);
        vm.expectRevert(IExchangeTypes.MarketRetired.selector);
        ex.retire(TIER_A);
        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.MarketRetired.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        assertEq(ex.maxPositionUsd(TIER_A, true), 0);

        // The live feed moves (and even dies); settlement still uses the frozen 1.01, and a
        // close request needs no feed.
        _setPx(ASSET_A, 2_000_000);
        source.setReverts(true, true);
        // Same 1% win as the exact-numbers test: 8.714963 - 5% fee 0.435748 = 8.279215.
        (int256 pnl,,) = ex.previewClose(id);
        assertEq(pnl, 8_279_215);
        (uint256 paid,) = _close(alice, id);
        assertEq(paid, 108_279_215);
        _assertSolvent();
    }

    function test_retire_allowsLiquidationAtFrozenPrice() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        vm.prank(owner);
        ex.retire(TIER_A);
        _setPx(ASSET_A, RAW_ONE); // feed recovers upward, but the frozen 0.90 still busts
        vm.prank(liquidator);
        assertEq(ex.liquidate(id), 500_000);
        assertEq(ex.instrument(TIER_A).lastPx18, 0.9e18); // the frozen price stays put
    }

    /// @dev The owner's escape hatch for a dead feed: `retireDead` freezes the market at the
    ///      last price the venue itself settled on (the last fill or liquidation print), and
    ///      only while the oracle is dead; nobody can state a price.
    function test_retireDead_ownerOnly_atLastPrint_onlyWhileFeedDead() public {
        _seedLpWithFullLoss(bob); // a close at 0.90: the last print is 0.90 ...
        assertEq(ex.instrument(TIER_A).lastPx18, 0.9e18);
        uint256 id = _open(alice, TIER_A, true, MARGIN, LEV); // ... then this fill at 1.00 ...
        assertEq(ex.instrument(TIER_A).lastPx18, ONE);
        _setPx(ASSET_A, 1_010_000);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV); // ... then this one at 1.01.
        assertEq(ex.instrument(TIER_A).lastPx18, 1.01e18);
        // A print the venue never settled on is not recorded: the oracle drifts to 1.02.
        _setPx(ASSET_A, 1_020_000);
        assertEq(ex.instrument(TIER_A).lastPx18, 1.01e18);
        source.setReverts(true, true);

        // A dead feed blocks close requests, liquidations and the plain retire alike.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.requestClose(id);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.liquidate(id);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.FeedUnavailable.selector, TIER_A));
        ex.retire(TIER_A);
        assertEq(ex.marginInUse(alice), MARGIN);

        // Owner only.
        vm.prank(guardian);
        vm.expectRevert(_unauthorized(guardian));
        ex.retireDead(TIER_A);
        // A market that never settled anything has no price to freeze at.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NoLastPrice.selector, TIER_C));
        ex.retireDead(TIER_C);
        // Only while the oracle is dead: a dead book alone leaves the market live.
        source.setReverts(true, false);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.FeedAlive.selector, TIER_A));
        ex.retireDead(TIER_A);
        source.setReverts(false, false);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.FeedAlive.selector, TIER_A));
        ex.retireDead(TIER_A);
        assertFalse(ex.instrument(TIER_A).retired);

        // A zero quote (a delisted perp) counts as dead too.
        source.setQuote(ASSET_A, 0, 0, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, TIER_A));
        ex.retire(TIER_A);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.InstrumentRetired(TIER_A, 1.01e18);
        ex.retireDead(TIER_A);
        IExchangeTypes.Instrument memory inst = ex.instrument(TIER_A);
        assertTrue(inst.retired);
        assertEq(inst.lastPx18, 1.01e18);
        vm.prank(owner);
        vm.expectRevert(IExchangeTypes.MarketRetired.selector);
        ex.retireDead(TIER_A);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.retireDead(9);

        // alice settles at 1.01 exactly as after a retire at 1.01 (margin + 8.714963 - 5% fee
        // 0.435748); carol, filled at 1.01, is flat.
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, 108_279_215);
        assertEq(queued, 0);
        (paid,) = _close(carol, cid);
        assertEq(paid, MARGIN);
        assertEq(ex.marginInUse(alice), 0);
        _assertSolvent();
    }

    // ---------------------------------------------------------------- breaker

    /// @dev Every position opens on the funded house, then the house is drained so the
    ///      breaker's base (free cash at the window start) is small enough to see.
    function test_breaker_tripsOnNetOutflow_pausesOpens_ownerClears() public {
        vm.prank(owner);
        ex.setBreakerBps(1000);
        assertEq(ex.breakerFloorUsdc(), 0);
        assertFalse(ex.breakerTripped());
        uint256 s = _open(bob, TIER_A, true, MARGIN, LEV);
        uint256 a = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 c = _open(carol, TIER_A, true, MARGIN, LEV);
        uint256 d = _open(dave, TIER_B, true, MARGIN, LEV);
        uint256 b = _open(bob, TIER_C, true, MARGIN, LEV);
        _drainHouse();

        // bob's $100 loss opens the first window (at the settlement block): free cash was 0,
        // net outflow is -(100 - 5% x 100) = -95 (the fee is carved before the gain counts).
        vm.warp(1_700_000_000);
        _setPx(ASSET_A, 900_000);
        _close(bob, s);
        (uint64 start, uint256 startLp, int256 net) = ex.breakerWindow();
        assertEq(start, vm.getBlockTimestamp());
        assertEq(startLp, 0);
        assertEq(net, -95e6);

        // An hour later the next settlement opens a new window on the free cash: $100 of house
        // cash less the $5 fee pool: base 95, threshold 10% x 95 = 9.5.
        vm.warp(start + 1 hours);
        _setPx(ASSET_A, 1_010_000);
        _close(alice, a); // adjusted gain 8.714963, under the $9.5 threshold
        (start, startLp, net) = ex.breakerWindow();
        assertEq(start, vm.getBlockTimestamp());
        assertEq(startLp, 95e6);
        assertEq(net, 8_714_963);
        assertFalse(ex.breakerTripped());

        // A second win takes the window past 10% of $95: the breaker trips.
        _requestClose(carol, c);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.LpBreakerTripped(17_429_926, 9.5e6, 95e6);
        ex.executeClose(c);
        assertTrue(ex.breakerTripped());
        assertEq(ex.maxPositionUsd(TIER_A, true), 0);

        // Opens are blocked on every market (before any sizing rule); closes, liquidations,
        // withdrawals and house deposits are not.
        vm.prank(dave);
        vm.expectRevert(IExchangeTypes.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_B, true, MARGIN, LEV, address(0));
        vm.prank(dave);
        vm.expectRevert(IExchangeTypes.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_C, false, 10e6, 1, address(0));
        (uint256 paid,) = _close(dave, d); // flat
        assertEq(paid, MARGIN);
        _setPx(ASSET_C, 900_000);
        vm.prank(liquidator);
        ex.liquidate(b);
        (,, net) = ex.breakerWindow();
        // The liquidation's house gain (100 - 0.5 bounty - 5% x 100 fee = 94.5) nets against
        // the wins.
        assertEq(net, 17_429_926 - 94_500_000);
        assertTrue(ex.breakerTripped()); // a trip holds for the hour, whatever comes after
        vm.prank(alice);
        ex.withdraw(100e6);
        _depositHouse(500e6);

        // Only the owner clears it: not the guardian, not either keeper.
        address[4] memory notOwner = [stranger, guardian, marketKeeper, keeper];
        for (uint256 i = 0; i < notOwner.length; i++) {
            vm.prank(notOwner[i]);
            vm.expectRevert(_unauthorized(notOwner[i]));
            ex.clearBreaker();
        }
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.BreakerCleared(owner);
        ex.clearBreaker();
        assertFalse(ex.breakerTripped());
        // Clearing starts a fresh window on the free cash (the fee pool left out).
        (start, startLp, net) = ex.breakerWindow();
        assertEq(start, vm.getBlockTimestamp());
        assertEq(startLp, ex.lpBalance() - ex.feePool());
        assertEq(startLp, ex.houseFreeUsdc());
        assertEq(net, 0);
        vm.prank(owner);
        vm.expectRevert(IExchangeTypes.BreakerNotTripped.selector);
        ex.clearBreaker();
        _setPx(ASSET_A, RAW_ONE);
        _open(dave, TIER_A, true, MARGIN, LEV);
        _assertSolvent();
    }

    /// @dev A trip ends when the next hour starts: opens resume without anyone clearing it.
    function test_breaker_selfClearsWhenTheNextHourStarts() public {
        vm.prank(owner);
        ex.setBreakerBps(1000);
        uint256 a = _open(alice, TIER_A, true, MARGIN, LEV);
        _drainHouse();
        vm.warp(1_700_000_000);
        // An empty house: threshold 0, so the first net win trips.
        _setPx(ASSET_A, 1_050_000);
        _requestClose(alice, a);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.LpBreakerTripped(44_707_911, 0, 0);
        ex.executeClose(a);
        _setPx(ASSET_A, RAW_ONE);
        (uint64 start,,) = ex.breakerWindow();
        _depositHouse(10_000e6); // house money arrives while tripped

        vm.warp(start + 1 hours - 1);
        assertTrue(ex.breakerTripped());
        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));

        vm.warp(start + 1 hours);
        assertFalse(ex.breakerTripped());
        uint256 req = _requestOpen(bob, TIER_A, true, MARGIN, LEV);
        assertGt(_executeOpen(req), 0);
        vm.prank(owner);
        vm.expectRevert(IExchangeTypes.BreakerNotTripped.selector);
        ex.clearBreaker();
        _assertSolvent();
    }

    function test_breaker_emptyHouseTripsOnFirstNetWin_lossesOffset_ownerSetsShare() public {
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setBreakerBps(2000);
        vm.prank(guardian);
        vm.expectRevert(_unauthorized(guardian));
        ex.setBreakerBps(2000);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.BreakerBps, 199));
        ex.setBreakerBps(199);
        vm.expectRevert(_oob(IExchangeTypes.Param.BreakerBps, 10_001));
        ex.setBreakerBps(10_001);
        // 10000 is off and 9999 the highest armed share; 200 the lowest; all accepted.
        ex.setBreakerBps(10_000);
        assertEq(ex.breakerBps(), 10_000);
        ex.setBreakerBps(9_999);
        assertEq(ex.breakerBps(), 9_999);
        ex.setBreakerBps(200);
        assertEq(ex.breakerBps(), 200);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.BreakerBpsSet(5000);
        ex.setBreakerBps(5000);
        vm.stopPrank();
        assertEq(ex.breakerBps(), 5000);

        uint256 wid = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 id = _open(carol, TIER_A, true, MARGIN, LEV);
        uint256 lid = _open(bob, TIER_B, true, MARGIN, LEV);
        _drainHouse();

        // With an empty house the threshold is zero, so the first queued win trips the breaker
        // whatever the share: there is nothing to bleed, but the queue is growing.
        _setPx(ASSET_A, 1_050_000);
        _requestClose(alice, wid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.LpBreakerTripped(44_707_911, 0, 0);
        ex.executeClose(wid);
        assertTrue(ex.breakerTripped());
        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        vm.prank(owner);
        ex.clearBreaker();

        // Losses offset wins inside a window: $100 in (no fee while the queue is owed), then
        // $44.71 out leaves the window net negative, so nothing trips.
        _setPx(ASSET_B, 900_000);
        _close(bob, lid);
        _close(carol, id);
        assertFalse(ex.breakerTripped());
        assertEq(_windowNet(), -100e6 + 44_707_911);
        _assertSolvent();
    }

    function test_breaker_floor_youngHouseDoesNotPauseOnSmallWins_boundsAndAuth() public {
        vm.startPrank(owner);
        ex.setBreakerBps(1000);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.BreakerFloorSet(5_000e6);
        ex.setBreakerFloor(5_000e6);
        vm.stopPrank();
        uint256 wid = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 cid = _open(carol, TIER_A, true, MARGIN, LEV);
        _drainHouse();

        // Empty house, $5K floor: a $44.71 queued win does not pause opens.
        _setPx(ASSET_A, 1_050_000);
        _close(alice, wid);
        assertFalse(ex.breakerTripped());
        (, uint256 startLp, int256 net) = ex.breakerWindow();
        assertEq(startLp, 0);
        assertEq(net, 44_707_911);

        // Lowering the floor below the window's outflow trips on the next win.
        vm.prank(owner);
        ex.setBreakerFloor(50e6);
        _requestClose(carol, cid);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.LpBreakerTripped(89_415_822, 50e6, 0);
        ex.executeClose(cid);
        assertTrue(ex.breakerTripped());

        // Owner only, at most $10K (inclusive).
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setBreakerFloor(0);
        vm.prank(guardian);
        vm.expectRevert(_unauthorized(guardian));
        ex.setBreakerFloor(0);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.BreakerFloorUsdc, 10_000e6 + 1));
        ex.setBreakerFloor(10_000e6 + 1);
        ex.setBreakerFloor(10_000e6);
        assertEq(ex.breakerFloorUsdc(), 10_000e6);
        ex.setBreakerFloor(0);
        assertEq(ex.breakerFloorUsdc(), 0);
        vm.stopPrank();
        _assertSolvent();
    }

    /// @dev Threshold = max(share, floor). With $19K of free house cash the base is $19K and
    ///      its 10% share $1.9K, under a $5K floor, so the floor rules: a $3,031 net-winning
    ///      hour (over the share) does not pause opens, and the hour trips once its net
    ///      outflow passes $5K.
    function test_breaker_floor_floorRulesWhileShareIsSmaller() public {
        vm.startPrank(owner);
        ex.setBreakerBps(1000);
        ex.setBreakerFloor(5_000e6);
        ex.withdrawHouse(HOUSE - 19_000e6);
        vm.stopPrank();
        assertEq(ex.lpBalance(), 19_000e6);

        vm.warp(1_700_000_000);
        uint256 a = _open(alice, TIER_A, true, 1000e6, 100); // $100K notional
        uint256 c = _open(carol, TIER_A, true, 1000e6, 100);
        _setPx(ASSET_A, 1_034_000);
        // exit after deadband = 1.0338966; rawGain = 100000 x 0.0338966 = 3389.660000;
        // scale = 0.894182...; adjusted = 3030.976119: over the $1.9K share, under the $5K floor.
        _close(alice, a);
        (uint64 start, uint256 startLp, int256 net) = ex.breakerWindow();
        assertEq(start, vm.getBlockTimestamp());
        assertEq(startLp, 19_000e6);
        assertEq(net, 3_030_976_119);
        assertFalse(ex.breakerTripped());
        _requestOpen(dave, TIER_A, true, MARGIN, LEV); // opens still allowed

        // carol's 2.8% win (adjusted 2491.057489) takes the hour to 5522.033608, past the floor.
        _setPx(ASSET_A, 1_028_000);
        _requestClose(carol, c);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.LpBreakerTripped(5_522_033_608, 5_000e6, 19_000e6);
        ex.executeClose(c);
        assertTrue(ex.breakerTripped());
        vm.prank(dave);
        vm.expectRevert(IExchangeTypes.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        _assertSolvent();
    }

    /// @dev With $95K of free house cash its 10% share ($9.5K) is above the $5K floor and
    ///      rules: a $7,170 net-winning hour (over the floor) does not pause opens; the hour
    ///      trips past $9.5K.
    function test_breaker_share_shareRulesWhenAboveFloor() public {
        vm.startPrank(owner);
        ex.setBreakerBps(1000);
        ex.setBreakerFloor(5_000e6);
        ex.withdrawHouse(HOUSE - 95_000e6);
        vm.stopPrank();

        vm.warp(1_700_000_000);
        uint256 a = _open(alice, TIER_A, true, 1000e6, 100);
        uint256 c = _open(carol, TIER_A, true, 1000e6, 100);
        _setPx(ASSET_A, 1_080_000);
        // exit after deadband = 1.0798920; rawGain = 7989.200000; scale = 0.897522...;
        // adjusted = 7170.488473: over the $5K floor, under the $9.5K share.
        _close(alice, a);
        (uint64 start, uint256 startLp, int256 net) = ex.breakerWindow();
        assertEq(start, vm.getBlockTimestamp());
        assertEq(startLp, 95_000e6);
        assertEq(net, 7_170_488_473);
        assertFalse(ex.breakerTripped());
        _requestOpen(dave, TIER_A, true, MARGIN, LEV);

        // carol's 3.4% win (adjusted 3030.976119) takes the hour to 10201.464592, past $9.5K.
        _setPx(ASSET_A, 1_034_000);
        _requestClose(carol, c);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.LpBreakerTripped(10_201_464_592, 9_500e6, 95_000e6);
        ex.executeClose(c);
        assertTrue(ex.breakerTripped());
        vm.prank(dave);
        vm.expectRevert(IExchangeTypes.OpensPausedByBreaker.selector);
        ex.requestOpen(TIER_A, true, MARGIN, LEV, address(0));
        _assertSolvent();
    }

    // ------------------------------------------------------------------ admin

    function test_addInstrument_storesSpecAndMirrorsOracle() public {
        IExchangeTypes.Instrument memory inst = ex.instrument(TIER_B);
        assertEq(inst.hlAssetIndex, ASSET_B);
        assertEq(inst.tier, 1);
        assertEq(inst.maxLeverage, 250);
        assertEq(inst.deadbandBps, 3);
        assertEq(inst.clampBps, 25);
        assertEq(inst.longOiCapUsd, 100_000e6);
        assertEq(inst.shortOiCapUsd, 100_000e6);
        assertEq(inst.posX10, 200);
        assertEq(inst.sideX10, 500);
        assertEq(inst.stressBps, 10);
        assertEq(inst.entryDeadbandBps, 0);
        assertEq(inst.borrowRateX10, 0);
        assertFalse(inst.opensPaused); // forced off despite the spec saying true
        assertFalse(inst.retired);
        assertEq(inst.lastPx18, 0); // the spec's 123 is ignored
        assertEq(ex.instrumentCount(), 3);
        (uint32 idx, uint8 sz, uint16 clamp) = oracle.instrumentConfig(TIER_B);
        assertEq(idx, ASSET_B);
        assertEq(sz, 0);
        assertEq(clamp, 25);

        // Max leverage is the spec's own number, not the tier's: a tier A market at 500x.
        IExchangeTypes.Instrument memory spec = _spec(0, 165, 1, 10, 250_000e6);
        spec.maxLeverage = 500;
        spec.posX10 = 50;
        spec.sideX10 = 100;
        spec.stressBps = 1000;
        spec.entryDeadbandBps = 2;
        spec.borrowRateX10 = 5;
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.InstrumentAdded(3, 165, 0, 0, 500);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.HouseSizingSet(3, 50, 100, 1000);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.MarketFeesSet(3, 2, 5);
        uint32 id = ex.addInstrument(spec);
        assertEq(id, 3);
        assertEq(ex.instrumentCount(), 4);
        inst = ex.instrument(3);
        assertEq(inst.maxLeverage, 500);
        assertEq(inst.posX10, 50);
        assertEq(inst.sideX10, 100);
        assertEq(inst.stressBps, 1000);
        assertEq(inst.entryDeadbandBps, 2);
        assertEq(inst.borrowRateX10, 5);
    }

    function test_addInstrument_onlyOwner_invalidTier_bounds() public {
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.addInstrument(_spec(0, 165, 1, 10, 1e6));
        vm.prank(marketKeeper);
        vm.expectRevert(_unauthorized(marketKeeper));
        ex.addInstrument(_spec(0, 165, 1, 10, 1e6));

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InvalidTier.selector, uint8(3)));
        ex.addInstrument(_spec(3, 165, 1, 10, 1e6));
        vm.expectRevert(_oob(IExchangeTypes.Param.DeadbandBps, 0));
        ex.addInstrument(_spec(0, 165, 0, 10, 1e6));
        vm.expectRevert(_oob(IExchangeTypes.Param.DeadbandBps, 51));
        ex.addInstrument(_spec(0, 165, 51, 10, 1e6));
        vm.expectRevert(_oob(IExchangeTypes.Param.ClampBps, 4));
        ex.addInstrument(_spec(0, 165, 1, 4, 1e6));
        vm.expectRevert(_oob(IExchangeTypes.Param.ClampBps, 101));
        ex.addInstrument(_spec(0, 165, 1, 101, 1e6));

        IExchangeTypes.Instrument memory spec = _spec(0, 165, 1, 10, 1e6);
        spec.maxLeverage = 0;
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxLeverage, 0));
        ex.addInstrument(spec);
        spec.maxLeverage = 1001;
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxLeverage, 1001));
        ex.addInstrument(spec);
        spec.maxLeverage = 1000;
        spec.baseRateBps = 499;
        vm.expectRevert(_oob(IExchangeTypes.Param.BaseRateBps, 499));
        ex.addInstrument(spec);
        spec.baseRateBps = 2001;
        vm.expectRevert(_oob(IExchangeTypes.Param.BaseRateBps, 2001));
        ex.addInstrument(spec);
        spec.baseRateBps = 500;
        spec.rateMultiplier = 999;
        vm.expectRevert(_oob(IExchangeTypes.Param.RateMultiplier, 999));
        ex.addInstrument(spec);
        spec.rateMultiplier = 1_000_001;
        vm.expectRevert(_oob(IExchangeTypes.Param.RateMultiplier, 1_000_001));
        ex.addInstrument(spec);
        spec.rateMultiplier = 1_000;
        spec.referenceNotionalUsd = 999e6;
        vm.expectRevert(_oob(IExchangeTypes.Param.ReferenceNotionalUsd, 999e6));
        ex.addInstrument(spec);
        spec.referenceNotionalUsd = 1_000_001e6;
        vm.expectRevert(_oob(IExchangeTypes.Param.ReferenceNotionalUsd, 1_000_001e6));
        ex.addInstrument(spec);
        spec.referenceNotionalUsd = 1_000_000e6;
        spec.positionMultiplierE6 = 1e12 - 1;
        vm.expectRevert(_oob(IExchangeTypes.Param.PositionMultiplierE6, 1e12 - 1));
        ex.addInstrument(spec);
        // Each value in range, but together the curve would keep under 1% of a 1% gain: a
        // silent confiscation of every win, so the curve as a whole is rejected.
        spec.positionMultiplierE6 = 1e12;
        uint256 scale = ImpactLib.impactScaleE18(
            1e16,
            ImpactLib.Curve({
                baseRateBps: spec.baseRateBps,
                rateMultiplier: spec.rateMultiplier,
                referenceNotionalUsd: spec.referenceNotionalUsd,
                positionMultiplierE6: spec.positionMultiplierE6
            })
        );
        assertLt(scale, 0.01e18);
        vm.expectRevert(_oob(IExchangeTypes.Param.ImpactScaleOnePct, scale));
        ex.addInstrument(spec);
        spec.referenceNotionalUsd = 1_000e6;
        ex.addInstrument(spec); // the edge values are accepted: this curve keeps ~79% at 1%
        vm.stopPrank();
    }

    function test_setInstrumentParams_boundsAndOracleMirror() public {
        uint128 pm = 130_000_000e6;
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setInstrumentParams(TIER_A, 2, 20, 1500, 10_000, 10_000e6, pm);

        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.ClampBps, 200));
        ex.setInstrumentParams(TIER_A, 2, 200, 1500, 10_000, 10_000e6, pm);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.setInstrumentParams(9, 2, 20, 1500, 10_000, 10_000e6, pm);
        // In-range values whose curve keeps under 1% of a win are rejected; the fixture curve
        // is left intact.
        uint256 scale = ImpactLib.impactScaleE18(
            1e16,
            ImpactLib.Curve({
                baseRateBps: 1500, rateMultiplier: 10_000, referenceNotionalUsd: 1_000_000e6, positionMultiplierE6: 1e12
            })
        );
        vm.expectRevert(_oob(IExchangeTypes.Param.ImpactScaleOnePct, scale));
        ex.setInstrumentParams(TIER_A, 2, 20, 1500, 10_000, 1_000_000e6, 1e12);
        assertEq(ex.instrument(TIER_A).positionMultiplierE6, pm);

        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.InstrumentParamsSet(TIER_A, 2, 20, 1500, 10_000, 10_000e6, pm);
        ex.setInstrumentParams(TIER_A, 2, 20, 1500, 10_000, 10_000e6, pm);
        vm.stopPrank();

        IExchangeTypes.Instrument memory inst = ex.instrument(TIER_A);
        assertEq(inst.deadbandBps, 2);
        assertEq(inst.clampBps, 20);
        assertEq(inst.baseRateBps, 1500);
        assertEq(inst.rateMultiplier, 10_000);
        assertEq(inst.referenceNotionalUsd, 10_000e6);
        assertEq(inst.positionMultiplierE6, pm);
        assertEq(inst.maxLeverage, 1000); // untouched
        assertEq(inst.maxNotionalUsd, 100_000e6); // untouched
        assertEq(inst.payoutCapX, 50); // untouched
        assertEq(inst.posX10, 200); // untouched
        (,, uint16 clamp) = oracle.instrumentConfig(TIER_A);
        assertEq(clamp, 20);
        // The wider clamp is mirrored and shapes the oracle's display price only: a 2% BBO
        // deviation clamps to 20 bps there, while settlement reads the unmoved oracle.
        source.setQuote(ASSET_A, 1_020_000, 1_020_000, RAW_ONE);
        assertEq(oracle.price(TIER_A), 1.002e18);
        assertEq(ex.execPrice(TIER_A, true, true), ONE);
    }

    /// @dev Leverage is per coin. The owner moves it within 1..1000 at any time; requests
    ///      follow the new cap, open positions keep their leverage.
    function test_setMaxLeverage_perCoin_boundsOwnerEvent_openPositionsKeepTheirs() public {
        uint256 id = _open(alice, TIER_A, true, MARGIN, 1000);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setMaxLeverage(TIER_A, 500);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxLeverage, 0));
        ex.setMaxLeverage(TIER_A, 0);
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxLeverage, 1001));
        ex.setMaxLeverage(TIER_A, 1001);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.setMaxLeverage(9, 10);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.MaxLeverageSet(TIER_A, 500);
        ex.setMaxLeverage(TIER_A, 500);
        ex.setMaxLeverage(TIER_C, 1000); // a tier C coin may go to 1000x
        ex.setMaxLeverage(TIER_B, 1); // and any coin down to 1x
        vm.stopPrank();
        assertEq(ex.instrument(TIER_A).maxLeverage, 500);
        assertEq(ex.instrument(TIER_C).maxLeverage, 1000);
        assertEq(ex.instrument(TIER_B).maxLeverage, 1);

        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_A, true, MARGIN, 501, address(0));
        _open(bob, TIER_A, true, MARGIN, 500);
        _open(bob, TIER_C, true, 10e6, 1000);
        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.LeverageOutOfRange.selector);
        ex.requestOpen(TIER_B, true, MARGIN, 2, address(0));
        _open(bob, TIER_B, true, MARGIN, 1);

        // alice's 1000x position is untouched and still settles at 1000x: a 10 bps drop busts.
        assertEq(ex.positions(id).leverage, 1000);
        _setPx(ASSET_A, 999_000);
        vm.prank(liquidator);
        ex.liquidate(id);
        _assertSolvent();
    }

    function test_setDelays_boundsOwnerEvent_pendingRequestsFollowNewValues() public {
        assertEq(ex.minDelay(), 5);
        assertEq(ex.grace(), 3);
        assertEq(ex.expiry(), 60);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setDelays(2, 1, 20);
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.MinDelay, 1));
        ex.setDelays(1, 1, 20);
        vm.expectRevert(_oob(IExchangeTypes.Param.MinDelay, 31));
        ex.setDelays(31, 1, 60);
        vm.expectRevert(_oob(IExchangeTypes.Param.Grace, 0));
        ex.setDelays(5, 0, 60);
        vm.expectRevert(_oob(IExchangeTypes.Param.Grace, 11));
        ex.setDelays(5, 11, 60);
        vm.expectRevert(_oob(IExchangeTypes.Param.Expiry, 19));
        ex.setDelays(5, 3, 19);
        vm.expectRevert(_oob(IExchangeTypes.Param.Expiry, 301));
        ex.setDelays(5, 3, 301);
        // The fallback window must exist: minDelay + grace < expiry.
        vm.expectRevert(_oob(IExchangeTypes.Param.Expiry, 40));
        ex.setDelays(30, 10, 40);
        ex.setDelays(30, 10, 41);
        ex.setDelays(30, 10, 300);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.DelaysSet(2, 1, 20);
        ex.setDelays(2, 1, 20);
        vm.stopPrank();
        assertEq(ex.minDelay(), 2);
        assertEq(ex.grace(), 1);
        assertEq(ex.expiry(), 20);

        // A request filed under these values: keeper at 2 s, anyone at 3 s, cancel after 20 s.
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 1);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.TooEarly.selector);
        ex.executeOpen(req);
        vm.warp(t0 + 2);
        vm.prank(stranger);
        vm.expectRevert(IExchangeTypes.KeeperWindow.selector);
        ex.executeOpen(req);
        vm.warp(t0 + 3);
        vm.prank(stranger);
        assertGt(ex.executeOpen(req), 0);
        // A pending request follows a later change: filed at 2/1/20, widened to 5/3/60 before
        // execution, the keeper is early at 2 s and in its window at 5 s.
        req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        t0 = vm.getBlockTimestamp();
        vm.prank(owner);
        ex.setDelays(5, 3, 60);
        vm.warp(t0 + 2);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.TooEarly.selector);
        ex.executeOpen(req);
        vm.warp(t0 + 5);
        vm.prank(keeper);
        assertGt(ex.executeOpen(req), 0);
    }

    function test_setKeeper_ownerOnly_event_isKeeper() public {
        assertTrue(ex.isKeeper(keeper));
        assertFalse(ex.isKeeper(owner));
        assertFalse(ex.isKeeper(guardian));
        assertFalse(ex.isKeeper(marketKeeper)); // the market keeper is not a fill keeper
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setKeeper(stranger, true);
        vm.prank(keeper);
        vm.expectRevert(_unauthorized(keeper));
        ex.setKeeper(stranger, true);
        vm.prank(marketKeeper);
        vm.expectRevert(_unauthorized(marketKeeper));
        ex.setKeeper(stranger, true);
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.KeeperSet(dave, true);
        ex.setKeeper(dave, true);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.KeeperSet(keeper, false);
        ex.setKeeper(keeper, false);
        vm.stopPrank();
        assertTrue(ex.isKeeper(dave));
        assertFalse(ex.isKeeper(keeper));

        // A removed keeper is a stranger in the grace window; the new one fills.
        uint256 req = _requestOpen(alice, TIER_A, true, MARGIN, LEV);
        _tick();
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.KeeperWindow.selector);
        ex.executeOpen(req);
        vm.prank(dave);
        assertGt(ex.executeOpen(req), 0);
    }

    function test_setOiCaps_marketKeeperOrOwner() public {
        address[3] memory refused = [stranger, guardian, keeper];
        for (uint256 i = 0; i < refused.length; i++) {
            vm.prank(refused[i]);
            vm.expectRevert(IExchangeTypes.Unauthorized.selector);
            ex.setOiCaps(TIER_A, 1, 2);
        }
        vm.prank(marketKeeper);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.OiCapsSet(TIER_A, 1, 2);
        ex.setOiCaps(TIER_A, 1, 2);
        vm.prank(owner);
        ex.setOiCaps(TIER_A, 3, 4);
        IExchangeTypes.Instrument memory inst = ex.instrument(TIER_A);
        assertEq(inst.longOiCapUsd, 3);
        assertEq(inst.shortOiCapUsd, 4);
        vm.prank(marketKeeper);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.UnknownInstrument.selector, uint32(9)));
        ex.setOiCaps(9, 1, 2);
    }

    function test_setOiCaps_boundedByTierCeiling() public {
        // The market keeper may move a market's caps, never past the tier ceiling: $10M /
        // $2.5M / $500K a side (v4).
        vm.startPrank(marketKeeper);
        ex.setOiCaps(TIER_A, 10_000_000e6, 10_000_000e6);
        vm.expectRevert(_oob(IExchangeTypes.Param.LongOiCapUsd, 10_000_000e6 + 1));
        ex.setOiCaps(TIER_A, 10_000_000e6 + 1, 1);
        vm.expectRevert(_oob(IExchangeTypes.Param.ShortOiCapUsd, type(uint128).max));
        ex.setOiCaps(TIER_A, 1, type(uint128).max);
        ex.setOiCaps(TIER_B, 2_500_000e6, 2_500_000e6);
        vm.expectRevert(_oob(IExchangeTypes.Param.LongOiCapUsd, 2_500_000e6 + 1));
        ex.setOiCaps(TIER_B, 2_500_000e6 + 1, 0);
        ex.setOiCaps(TIER_C, 500_000e6, 500_000e6);
        vm.expectRevert(_oob(IExchangeTypes.Param.ShortOiCapUsd, 500_000e6 + 1));
        ex.setOiCaps(TIER_C, 0, 500_000e6 + 1);
        vm.stopPrank();
        assertEq(ex.instrument(TIER_A).longOiCapUsd, 10_000_000e6);

        // The owner is bound the same way, in setOiCaps and in addInstrument.
        vm.startPrank(owner);
        vm.expectRevert(_oob(IExchangeTypes.Param.LongOiCapUsd, 10_000_000e6 + 1));
        ex.setOiCaps(TIER_A, 10_000_000e6 + 1, 1);
        vm.expectRevert(_oob(IExchangeTypes.Param.LongOiCapUsd, 500_000e6 + 1));
        ex.addInstrument(_spec(2, 165, 10, 50, 500_000e6 + 1));
        ex.addInstrument(_spec(2, 165, 10, 50, 500_000e6));
        vm.stopPrank();
        // A zero cap closes a side.
        vm.prank(marketKeeper);
        ex.setOiCaps(TIER_A, 0, 10_000_000e6);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.OiCapExceeded.selector);
        ex.requestOpen(TIER_A, true, 5e6, 1, address(0));
        _open(alice, TIER_A, false, 5e6, 1);
    }

    function test_setFeeRecipient_and_setKeepers() public {
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setFeeRecipient(stranger);
        vm.startPrank(owner);
        vm.expectRevert(IExchangeTypes.ZeroAddress.selector);
        ex.setFeeRecipient(address(0));
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.FeeRecipientSet(dave);
        ex.setFeeRecipient(dave);
        assertEq(ex.feeRecipient(), dave);

        vm.expectEmit(true, true, false, true);
        emit IExchangeTypes.KeepersSet(address(0), address(0));
        ex.setKeepers(address(0), address(0)); // zero disables the roles
        vm.stopPrank();
        assertEq(ex.pauseGuardian(), address(0));
        assertEq(ex.marketKeeper(), address(0));
        vm.prank(guardian);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setGlobalOpensPaused(true);
        vm.prank(marketKeeper);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setOiCaps(TIER_A, 1, 1);
        assertTrue(ex.isKeeper(keeper)); // the fill keeper set is separate
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setKeepers(stranger, stranger);

        // The next push pays the new recipient.
        _seedLpWithFullLoss(bob);
        ex.pushFees();
        assertEq(ex.balanceOf(dave), 1000e6 + 5e6);
        assertEq(ex.balanceOf(feeRecipient), 0);
    }

    function test_ownership_isTwoStep_houseMoneyFollowsTheOwner() public {
        assertEq(ex.owner(), owner);
        vm.prank(owner);
        core.transferOwnership(dave);
        assertEq(ex.owner(), owner);
        assertEq(core.pendingOwner(), dave);
        vm.prank(dave);
        core.acceptOwnership();
        assertEq(ex.owner(), dave);
        // The old owner holds no role any more: neither the pause path nor onlyOwner admin,
        // nor the house money.
        vm.prank(owner);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setGlobalOpensPaused(true);
        vm.prank(owner);
        vm.expectRevert(_unauthorized(owner));
        ex.setFeeRecipient(owner);
        vm.prank(owner);
        vm.expectRevert(_unauthorized(owner));
        ex.withdrawHouse(1);
        vm.prank(dave);
        ex.setGlobalOpensPaused(true);
        assertTrue(ex.globalOpensPaused());
        // A withdrawal goes to the current owner.
        uint256 daveWallet = usdc.balanceOf(dave);
        vm.prank(dave);
        ex.withdrawHouse(1_000e6);
        assertEq(usdc.balanceOf(dave), daveWallet + 1_000e6);
        assertEq(usdc.balanceOf(owner), 0);
    }

    function test_constructor_wiringAndZeroChecks() public {
        assertEq(ex.usdc(), address(usdc));
        assertEq(ex.oracle(), address(oracle));
        assertEq(ex.staking(), address(staking));
        assertEq(ex.feeRecipient(), feeRecipient);
        assertEq(ex.pauseGuardian(), guardian);
        assertEq(ex.marketKeeper(), marketKeeper);
        assertEq(ex.extension(), address(ext));
        assertEq(ex.minMarginUsdc(), 5e6);
        assertEq(ex.breakerBps(), 10_000); // off in this suite's setUp
        assertFalse(ex.breakerTripped());
        // The referral registry, the market rules and the session router are created by the
        // core and bound to it.
        assertTrue(address(refs) != address(0));
        assertEq(refs.exchange(), address(ex));
        assertEq(refs.referralShareBps(), 1500);
        assertEq(refs.v3Referrals(), address(0));
        assertTrue(ex.marketRules() != address(0));
        assertTrue(ex.sessionRouter() != address(0));
        (address u, address o, address s) = ext.extensionImmutables();
        assertEq(u, address(usdc));
        assertEq(o, address(oracle));
        assertEq(s, address(staking));

        IStaking stk = IStaking(address(staking));
        vm.expectRevert(IExchangeTypes.ZeroAddress.selector);
        new Exchange(usdc, oracle, stk, ext, IReferrals(address(0)), owner, address(0));
        vm.expectRevert(IExchangeTypes.ZeroAddress.selector);
        new Exchange(usdc, IPriceOracle(address(0)), stk, ext, IReferrals(address(0)), owner, feeRecipient);
        vm.expectRevert(IExchangeTypes.ZeroAddress.selector);
        new Exchange(usdc, oracle, IStaking(address(0)), ext, IReferrals(address(0)), owner, feeRecipient);
        vm.expectRevert(IExchangeTypes.ZeroAddress.selector);
        new Exchange(usdc, oracle, stk, ExchangeExt(address(0)), IReferrals(address(0)), owner, feeRecipient);
        vm.expectRevert(IExchangeTypes.ZeroAddress.selector);
        new ExchangeExt(MockUSDC(address(0)), oracle, stk, owner);
        // An extension built with any other immutable is refused.
        ExchangeExt otherUsdc = new ExchangeExt(new MockUSDC(), oracle, stk, owner);
        vm.expectRevert(IExchangeTypes.ExtensionMismatch.selector);
        new Exchange(usdc, oracle, stk, otherUsdc, IReferrals(address(0)), owner, feeRecipient);
        ExchangeExt otherStaking = new ExchangeExt(usdc, oracle, IStaking(address(0xBEEF)), owner);
        vm.expectRevert(IExchangeTypes.ExtensionMismatch.selector);
        new Exchange(usdc, oracle, stk, otherStaking, IReferrals(address(0)), owner, feeRecipient);
    }

    /// @dev A fresh deployment announces every default it sets, in constructor order.
    function test_constructor_emitsDefaults() public {
        ExchangeExt e2 = new ExchangeExt(usdc, oracle, IStaking(address(staking)), owner);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.FeeRecipientSet(feeRecipient);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.BreakerBpsSet(2500);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.BreakerFloorSet(0);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.FeeBpsSet(500, 500);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.BorrowFreeHoursSet(1);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.StakerFeeShareSet(0);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.DelaysSet(5, 3, 60);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.MaxJumpBpsSet(1000);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.MinMarginSet(5e6);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.RhoBpsSet(2000);
        vm.expectEmit(false, false, false, true);
        emit IExchangeTypes.MaxWinBpsSet(2500);
        Exchange fresh =
            new Exchange(usdc, oracle, IStaking(address(staking)), e2, IReferrals(address(0)), owner, feeRecipient);
        IExchange f = IExchange(address(fresh));
        assertEq(f.breakerBps(), 2500);
        assertEq(f.breakerFloorUsdc(), 0);
        assertEq(f.winFeeBps(), 500);
        assertEq(f.lossFeeBps(), 500);
        assertEq(f.borrowFreeHours(), 1);
        assertEq(f.stakerFeeShareBps(), 0);
        assertEq(f.minDelay(), 5);
        assertEq(f.grace(), 3);
        assertEq(f.expiry(), 60);
        assertEq(f.maxJumpBps(), 1000);
        assertEq(f.minMarginUsdc(), 5e6);
        assertEq(f.rhoBps(), 2000);
        assertEq(f.maxWinBps(), 2500);
        assertEq(f.feeRecipient(), feeRecipient);
        assertEq(f.nextRequestId(), 1);
        assertEq(f.nextPositionId(), 1);
        assertEq(f.lpBalance(), 0);
        assertEq(f.houseFreeUsdc(), 0);
        assertEq(f.pauseGuardian(), address(0));
        assertEq(f.marketKeeper(), address(0));
        assertFalse(f.isKeeper(keeper));
        assertEq(f.extension(), address(e2));
    }

    // -------------------------------------------------------------- referrals

    /// @dev The referrer is fixed by the trader's FIRST EXECUTED open, from that request's
    ///      `referrer`; a refunded request fixes nothing, a self-referral is none, and later
    ///      requests cannot change it.
    function test_referral_lockedAtFirstExecutedOpen_notAtRequest_neverSelf_immutable() public {
        vm.prank(carol);
        refs.registerCode("carol");
        // A refunded request locks nothing.
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        assertEq(ex.openRequest(req).referrer, carol);
        vm.prank(guardian);
        ex.setMarketOpensPaused(TIER_A, true);
        _tick();
        vm.prank(keeper);
        assertEq(ex.executeOpen(req), 0);
        assertFalse(refs.referrerLocked(alice));
        assertEq(refs.referrerOf(alice), address(0));
        vm.prank(owner);
        ex.setMarketOpensPaused(TIER_A, false);

        // The first executed open locks the referrer named on that request.
        vm.prank(alice);
        req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferrerSet(alice, carol);
        ex.executeOpen(req);
        assertTrue(refs.referrerLocked(alice));
        assertEq(refs.referrerOf(alice), carol);

        // Later requests, with another referrer or none, change nothing.
        vm.prank(alice);
        req = ex.requestOpen(TIER_A, true, MARGIN, LEV, dave);
        _executeOpen(req);
        assertEq(refs.referrerOf(alice), carol);
        _open(alice, TIER_A, true, MARGIN, LEV);
        assertEq(refs.referrerOf(alice), carol);

        // A self-referral is stored as none and still locks: bob stays unreferred for good.
        vm.prank(bob);
        req = ex.requestOpen(TIER_A, true, MARGIN, LEV, bob);
        assertEq(ex.openRequest(req).referrer, address(0));
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferrerSet(bob, address(0));
        ex.executeOpen(req);
        assertTrue(refs.referrerLocked(bob));
        vm.prank(bob);
        req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        _executeOpen(req);
        assertEq(refs.referrerOf(bob), address(0));

        // A referrer without a code is none (v4): dave names stranger, who owns no code.
        vm.prank(dave);
        req = ex.requestOpen(TIER_A, true, MARGIN, LEV, stranger);
        _executeOpen(req);
        assertTrue(refs.referrerLocked(dave));
        assertEq(refs.referrerOf(dave), address(0));
        assertEq(refs.referralEarned(carol), 0); // nothing paid yet: no fee has been carved
    }

    /// @dev 15% of each fee kind a referred trader pays goes to the referrer at once; the pool
    ///      gets the other 85%. The house's net figures (the breaker) are unchanged.
    function test_referral_fifteenPercentOfEachFeeKind_creditedNow_poolGetsRest() public {
        vm.prank(carol);
        refs.registerCode("carol");
        _seedLpWithFullLoss(bob); // house +100, pool 5 (bob is unreferred)
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        uint256 id = _executeOpen(req);
        assertEq(ex.balanceOf(carol), 1000e6);

        // Win: fee 0.435748; share 15% = 0.0653622 -> 0.065362 to carol now; pool +0.370386.
        // The house pays the profit 8.279215 and the share.
        _setPx(ASSET_A, 1_010_000);
        int256 netBefore = _windowNet();
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferralPaid(carol, alice, 65_362);
        vm.expectEmit(true, true, false, true, address(ex));
        emit IExchangeTypes.PositionClosed(id, alice, 1.01e18, 8_279_215, 435_748, 108_279_215, 0, 0, true);
        ex.executeClose(id);
        assertEq(ex.balanceOf(carol), 1000e6 + 65_362);
        assertEq(ex.feePool(), 5_000_000 + 370_386);
        assertEq(ex.lpBalance(), HOUSE + 100e6 - 8_279_215 - 65_362);
        assertEq(refs.referralEarned(carol), 65_362);
        assertEq(_windowNet() - netBefore, 8_714_963); // the whole adjusted gain, as before
        _assertSolvent();

        // Loss: alice loses $5; fee 0.25; share 0.0375 to carol; pool +0.2125.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        uint256 lpBefore = ex.lpBalance();
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferralPaid(carol, alice, 37_500);
        vm.expectEmit(true, true, false, true, address(ex));
        emit IExchangeTypes.PositionClosed(id, alice, 0.995e18, -5_000_000, 250_000, 95_000_000, 0, 0, true);
        ex.executeClose(id);
        assertEq(ex.balanceOf(carol), 1000e6 + 65_362 + 37_500);
        assertEq(ex.feePool(), 5_370_386 + 212_500);
        assertEq(ex.lpBalance(), lpBefore + 5_000_000 - 37_500);
        _assertSolvent();

        // Liquidation: alice's $100 margin; fee 5; share 0.75 to carol; pool +4.25; bounty 0.5;
        // house cash +100 - 0.5 - 0.75 = +98.75; the house's net gain is still 94.5.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 900_000);
        lpBefore = ex.lpBalance();
        netBefore = _windowNet();
        vm.prank(liquidator);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferralPaid(carol, alice, 750_000);
        vm.expectEmit(true, true, true, true, address(ex));
        emit IExchangeTypes.PositionLiquidated(id, alice, liquidator, 0.9e18, MARGIN, 500_000, 5_000_000);
        ex.liquidate(id);
        assertEq(ex.balanceOf(carol), 1000e6 + 65_362 + 37_500 + 750_000);
        assertEq(ex.feePool(), 5_582_886 + 4_250_000);
        assertEq(ex.lpBalance(), lpBefore + 98_750_000);
        assertEq(_windowNet() - netBefore, -94_500_000);
        assertEq(refs.referralEarned(carol), 852_862);
        _assertSolvent();

        // A share that rounds to zero pays nothing and nothing is emitted: $10 at 1x, a 2-tick
        // drop, loss 20 units, fee 1, share 15% x 1 = 0.15 -> 0; the pool keeps the unit.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, 10e6, 1);
        _setPx(ASSET_A, 999_998);
        uint256 poolBefore = ex.feePool();
        uint256 carolBefore = ex.balanceOf(carol);
        _close(alice, id);
        assertEq(ex.feePool(), poolBefore + 1);
        assertEq(ex.balanceOf(carol), carolBefore);
        assertEq(refs.referralEarned(carol), 852_862);

        // An unreferred trader's fees go wholly to the pool.
        _setPx(ASSET_A, RAW_ONE);
        id = _open(bob, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        poolBefore = ex.feePool();
        _close(bob, id);
        assertEq(ex.feePool(), poolBefore + 250_000);
        assertEq(ex.balanceOf(carol), carolBefore);
        _assertSolvent();
    }

    /// @dev The one case the house cannot pay the share on the spot: a win that drains it. The
    ///      share then joins the FIFO queue behind the trader, and a loss while the queue is
    ///      owed carves no fee, so no share.
    function test_referral_shareQueuedBehindTraderWhenHouseDry_noneWhileQueueActive() public {
        vm.prank(carol);
        refs.registerCode("carol");
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        uint256 id = _executeOpen(req);
        uint256 id2 = _open(alice, TIER_A, true, MARGIN, LEV);
        uint256 bid = _open(bob, TIER_B, true, MARGIN, LEV);
        _drainHouse();
        // The 5% vector into an empty house: profit 42.472516 queued at index 0 for alice, then
        // the share 15% x 2.235395 = 0.33530925 -> 0.335309 queued at index 1 for carol; the
        // pool keeps 2.235395 - 0.335309 = 1.900086.
        _setPx(ASSET_A, 1_050_000);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(ex));
        emit IExchangeTypes.QueueAppended(0, alice, 42_472_516);
        vm.expectEmit(true, true, false, true, address(refs));
        emit IReferrals.ReferralPaid(carol, alice, 335_309);
        vm.expectEmit(true, true, false, true, address(ex));
        emit IExchangeTypes.QueueAppended(1, carol, 335_309);
        ex.executeClose(id);
        assertEq(ex.balanceOf(carol), 1000e6);
        assertEq(ex.queuedTotal(), 42_472_516 + 335_309);
        assertEq(ex.feePool(), 1_900_086);
        assertEq(ex.lpBalance(), 0);
        assertEq(refs.referralEarned(carol), 335_309); // counted when owed
        _assertSolvent();

        // Queue owed: alice's $5 loss carves nothing, so carol gets nothing.
        _setPx(ASSET_A, 995_000);
        _close(alice, id2);
        assertEq(ex.feePool(), 1_900_086);
        assertEq(refs.referralEarned(carol), 335_309);
        assertEq(ex.lpBalance(), 5_000_000);

        // bob's $100 loss refills the house (still no fee); a harvest pays alice, then carol.
        _setPx(ASSET_B, 900_000);
        _close(bob, bid);
        assertEq(ex.lpBalance(), 105_000_000);
        (uint256 n, uint256 paid) = ex.harvest(10);
        assertEq(n, 2);
        assertEq(paid, 42_472_516 + 335_309);
        assertEq(ex.balanceOf(alice), 1000e6 - 5_000_000 + 42_472_516);
        assertEq(ex.balanceOf(carol), 1000e6 + 335_309);
        assertEq(ex.queuedTotal(), 0);
        _assertSolvent();
    }

    function test_setReferralShare_ownerOnly_bounds_zeroPaysNothing() public {
        vm.prank(carol);
        refs.registerCode("carol");
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        ex.setReferralShare(1000);
        vm.prank(stranger);
        vm.expectRevert(IReferrals.NotExchange.selector);
        refs.setShareBps(1000);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IReferrals.ShareOutOfBounds.selector, uint16(5001)));
        ex.setReferralShare(5001);
        ex.setReferralShare(5000);
        assertEq(refs.referralShareBps(), 5000);
        vm.expectEmit(false, false, false, true, address(refs));
        emit IReferrals.ReferralShareSet(0);
        ex.setReferralShare(0);
        vm.stopPrank();

        // At 0% a referred trader's fee goes wholly to the pool.
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, MARGIN, LEV, carol);
        uint256 id = _executeOpen(req);
        _setPx(ASSET_A, 995_000);
        _close(alice, id);
        assertEq(ex.feePool(), 250_000);
        assertEq(ex.balanceOf(carol), 1000e6);
        assertEq(refs.referralEarned(carol), 0);
        // Raised to 50%: the next $5 loss pays carol 0.125 of the 0.25 fee.
        vm.prank(owner);
        ex.setReferralShare(5000);
        _setPx(ASSET_A, RAW_ONE);
        id = _open(alice, TIER_A, true, MARGIN, LEV);
        _setPx(ASSET_A, 995_000);
        _close(alice, id);
        assertEq(ex.feePool(), 250_000 + 125_000);
        assertEq(ex.balanceOf(carol), 1000e6 + 125_000);
        _assertSolvent();
    }

    // ------------------------------------------------------------ end to end

    function test_fullCycle_multipleTraders_staysSolvent() public {
        // A mix of wins, losses, a liquidation and a queue round trip on two markets, with a
        // referred trader and a request left pending throughout.
        vm.prank(dave);
        refs.registerCode("dave");
        vm.prank(alice);
        uint256 req = ex.requestOpen(TIER_A, true, 200e6, 50, dave);
        uint256 a = _executeOpen(req);
        uint256 b = _open(bob, TIER_A, false, 150e6, 20);
        uint256 c = _open(carol, TIER_B, true, 300e6, 100);
        uint256 pending = _requestOpen(dave, TIER_A, true, 50e6, 10);
        _setPx(ASSET_A, 1_004_000); // alice +0.4% at 50x wins; bob short loses
        _setPx(ASSET_B, 990_000); // carol -1% at 100x: busted
        _close(bob, b);
        _close(alice, a);
        vm.prank(liquidator);
        ex.liquidate(c);
        _assertSolvent();
        assertGt(refs.referralEarned(dave), 0);

        if (ex.queuedTotal() > 0) ex.harvest(10);
        if (ex.queuedTotal() == 0 && ex.feePool() > 0 && ex.lpBalance() >= ex.feePool()) ex.pushFees();
        _assertSolvent();

        // The pending request expires and is refunded by a stranger.
        vm.warp(vm.getBlockTimestamp() + EXPIRY + 1);
        vm.prank(stranger);
        ex.cancelOpen(pending);
        assertEq(ex.pendingOf(dave), 0);

        // Everyone withdraws what they can; the house cash is all that remains.
        address[6] memory users = [alice, bob, carol, dave, liquidator, feeRecipient];
        for (uint256 i = 0; i < users.length; i++) {
            uint256 bal = ex.balanceOf(users[i]);
            if (bal == 0) continue;
            vm.prank(users[i]);
            ex.withdraw(bal);
        }
        // No positions, no balances: the house cash is the only USDC left in the contract,
        // and the owner can take all of it (nothing is owed).
        assertEq(usdc.balanceOf(address(ex)), ex.lpBalance());
        _assertSolvent();
        uint256 free = ex.houseFreeUsdc();
        assertEq(free, ex.lpBalance());
        vm.prank(owner);
        ex.withdrawHouse(free);
        assertEq(usdc.balanceOf(address(ex)), 0);
    }

    /// @dev While nobody is actively staked the stakers' share stays in the pool. Share 50%;
    ///      bob's full loss carves $5: the push pays the recipient 2.5 and keeps 2.5. A second
    ///      push with only the held 2.5 has nothing to pay. carol's loss adds $5 (pool 7.5);
    ///      with a staker active the push hands the stakers 2.5 + 50% x 5 = 5 and the recipient
    ///      2.5.
    function test_pushFees_holdsStakerShareWhileNobodyStakes() public {
        vm.prank(owner);
        ex.setStakerFeeShare(5000);
        staking.setTotalStaked(0);
        _seedLpWithFullLoss(bob);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 2.5e6);
        assertEq(ex.feePool(), 2.5e6);
        assertEq(staking.notifyCalls(), 0);
        vm.expectRevert(IExchangeTypes.NothingToPush.selector);
        ex.pushFees();

        _seedLpWithFullLoss(carol);
        assertEq(ex.feePool(), 7.5e6);
        staking.setTotalStaked(1);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 5e6);
        assertEq(toRecipient, 2.5e6);
        assertEq(ex.feePool(), 0);
        assertEq(usdc.balanceOf(address(staking)), 5e6);
        _assertSolvent();
    }

    /// @dev The stakers' part is earmarked at the push even when it is all of the pool: share
    ///      100%, bob's $5 fee pushed while nobody earns pays nobody and keeps 5 earmarked; the
    ///      owner then drops the share to 0, and the next push with an active staker still hands
    ///      the earmarked 5 to the stakers (5 + 0% x 0) and nothing to the recipient.
    function test_pushFees_earmarkSurvivesAShareChange() public {
        vm.prank(owner);
        ex.setStakerFeeShare(10_000);
        staking.setTotalStaked(0);
        _seedLpWithFullLoss(bob);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers + toRecipient, 0);
        assertEq(ex.feePool(), 5e6);
        vm.expectRevert(IExchangeTypes.NothingToPush.selector);
        ex.pushFees();

        vm.prank(owner);
        ex.setStakerFeeShare(0);
        staking.setTotalStaked(1);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 5e6);
        assertEq(toRecipient, 0);
        assertEq(ex.balanceOf(feeRecipient), 0);
        _assertSolvent();
    }

    /// @dev `openMaxPayoutUsdc` books each position at its stamped maximum profit: alice
    ///      100 x 50 = 5,000; after the cap drops to 20, bob 100 x 20 = 2,000 (7,000 in all);
    ///      alice's close removes her 5,000; bob's liquidation removes his 2,000.
    function test_openMaxPayout_followsStampedCaps() public {
        uint256 aid = _open(alice, TIER_A, true, MARGIN, LEV);
        assertEq(ex.openMaxPayoutUsdc(), 5_000e6);
        vm.prank(owner);
        ex.setPositionCaps(TIER_A, 100_000e6, 20);
        uint256 bid = _open(bob, TIER_A, true, MARGIN, LEV);
        assertEq(ex.openMaxPayoutUsdc(), 7_000e6);
        _close(alice, aid);
        assertEq(ex.openMaxPayoutUsdc(), 2_000e6);
        _setPx(ASSET_A, 900_000);
        vm.prank(liquidator);
        ex.liquidate(bid);
        assertEq(ex.openMaxPayoutUsdc(), 0);
    }

    /// @dev A $1M position (margin 1,000 at 1000x) on a 1 bps market, price 1.00 -> 1.01.
    ///      Exit after the deadband 1.009899; raw gain 1e12 x 0.009899 = 9,899,000,000;
    ///      adjusted 8,714,963,107 (under the stamped 25% x 100,000 = 25,000e6, itself under
    ///      the 50x cap of 50,000e6); fee 5% = 435,748,155; profit 8,279,214,952; paid
    ///      1,000e6 + profit from house cash, nothing queued. At a 50% share the push splits
    ///      floor(435,748,155 / 2) = 217,874,077 to stakers and 217,874,078 to the recipient.
    function test_settleWin_oneMillionNotional_onePct() public {
        vm.startPrank(owner);
        ex.setOiCaps(TIER_A, 10_000_000e6, 10_000_000e6);
        ex.setPositionCaps(TIER_A, 1_000_000e6, 50);
        ex.setStakerFeeShare(5000);
        vm.stopPrank();

        uint256 id = _open(alice, TIER_A, true, 1_000e6, 1000);
        (uint256 longOi,) = ex.openInterest(TIER_A);
        assertEq(longOi, 1_000_000e6);
        assertEq(ex.openMaxPayoutUsdc(), 25_000e6); // min(1,000 x 50, 25% x 100,000)

        _setPx(ASSET_A, 1_010_000);
        (uint256 paid, uint256 queued) = _close(alice, id);
        assertEq(paid, 9_279_214_952);
        assertEq(queued, 0);
        assertEq(ex.feePool(), 435_748_155);
        assertEq(ex.lpBalance(), HOUSE - 8_279_214_952);
        (longOi,) = ex.openInterest(TIER_A);
        assertEq(longOi, 0);
        assertEq(ex.openMaxPayoutUsdc(), 0);

        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 217_874_077);
        assertEq(toRecipient, 217_874_078);
        _assertSolvent();
    }

    /// @dev The v4 position ceiling at full size: the owner lifts a tier A market to $1M per
    ///      position (the MarketRules ceiling; +1 refused) and $1M a side, one 1,000 x 1000x
    ///      long fills the whole side and leaves no headroom. With $1.1M of house cash the
    ///      house stamp (25% = 275,000) is above the 50x cap, so the cap binds: at +25% the
    ///      adjusted gain (about 224,700e6) is capped at 50,000e6, fee 2,500e6, paid
    ///      1,000e6 + 47,500e6.
    function test_requestOpen_positionCeiling_payoutCapBindsAtSize() public {
        vm.startPrank(owner);
        ex.setOiCaps(TIER_A, 1_000_000e6, 1_000_000e6);
        vm.expectRevert(_oob(IExchangeTypes.Param.MaxNotionalUsd, 1_000_000e6 + 1));
        ex.setPositionCaps(TIER_A, 1_000_000e6 + 1, 50);
        ex.setPositionCaps(TIER_A, 1_000_000e6, 50);
        vm.stopPrank();
        _depositHouse(1_000_000e6);

        uint256 id = _open(alice, TIER_A, true, 1_000e6, 1000);
        (uint256 longOi,) = ex.openInterest(TIER_A);
        assertEq(longOi, 1_000_000e6);
        assertEq(ex.openMaxPayoutUsdc(), 50_000e6);
        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.OiCapExceeded.selector);
        ex.requestOpen(TIER_A, true, 5e6, 1, address(0));

        _setPx(ASSET_A, 1_250_000);
        uint256 exit = ImpactLib.deadbandExit(1.25e18, true, 1);
        (uint256 gain, uint256 move) = ImpactLib.rawGain(1_000_000e6, ONE, exit, true);
        uint256 adjusted = ImpactLib.adjustedGain(gain, move, _launchCurve());
        assertGt(adjusted, 224_000e6);
        _requestClose(alice, id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IExchangeTypes.PayoutCapped(id, 50_000e6, adjusted - 50_000e6);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, 48_500e6);
        assertEq(queued, 0);
        assertEq(ex.feePool(), 2_500e6);
        assertEq(ex.lpBalance(), HOUSE + 1_000_000e6 - 47_500e6);
        (longOi,) = ex.openInterest(TIER_A);
        assertEq(longOi, 0);
        assertEq(ex.openMaxPayoutUsdc(), 0);
        _assertSolvent();
    }
}
