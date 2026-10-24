// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IExchangeTypes} from "../../src/interfaces/IExchangeTypes.sol";
import {V4Fixture} from "./V4Fixture.sol";

/// @notice Fuzz tests of the two house-money boundaries the invariant suite samples only at
///         random: the `withdrawHouse` bound (exactly the free cash, with fees pooled or wins
///         queued) and the borrow fee (whole hours beyond the stamped free hours, capped at
///         the payout, kept by the house).
contract HouseFuzzTest is V4Fixture {
    address internal alice = makeAddr("alice");
    uint32 internal constant DOGE = 0;
    uint32 internal constant DOGE_ASSET = 12;

    function setUp() public {
        _deployV4();
        _unpause(DOGE);
        usdc.mint(alice, 1e15);
        vm.prank(alice);
        usdc.approve(address(ex), type(uint256).max);
    }

    // ------------------------------------------------------------- helpers

    function _setPx(uint256 raw) internal {
        source.setQuote(DOGE_ASSET, uint64(raw), uint64(raw), uint64(raw));
    }

    function _open(bool isLong, uint256 margin, uint256 lev) internal returns (uint256 pid) {
        vm.prank(alice);
        ex.deposit(margin);
        vm.prank(alice);
        uint256 rid = ex.requestOpen(DOGE, isLong, uint128(margin), uint32(lev), address(0));
        skip(5);
        vm.prank(keeper);
        pid = ex.executeOpen(rid);
        assertGt(pid, 0, "open refunded");
    }

    function _close(uint256 pid) internal returns (uint256 payout, uint256 queued) {
        vm.prank(alice);
        ex.requestClose(pid);
        skip(5);
        vm.prank(keeper);
        return ex.executeClose(pid);
    }

    /// @dev The spec, restated: `rateX10` tenths of a bps of notional per WHOLE hour held
    ///      beyond `freeHours`; a part hour is free.
    function _spec(uint256 notional, uint256 rateX10, uint256 held, uint256 freeHours) internal pure returns (uint256) {
        if (held < (freeHours + 1) * 1 hours) return 0;
        uint256 hours_ = (held - freeHours * 1 hours) / 1 hours;
        return notional * rateX10 * hours_ / 100_000;
    }

    // ------------------------------------------------------- withdrawHouse

    /// @notice With nothing owed, fees pooled by a win, or a win queued behind empty cash,
    ///         `withdrawHouse` succeeds for every amount in (0, houseFreeUsdc] and refuses
    ///         everything above it; after a success the cash still covers the queue and the pool.
    function testFuzz_withdrawHouseBoundary(uint256 houseIn, uint256 amount, uint8 scenario, uint8 mode) public {
        houseIn = bound(houseIn, 1e6, 1e12);
        vm.prank(owner);
        ex.depositHouse(houseIn);

        scenario = scenario % 3;
        if (scenario != 0) {
            uint256 maxPos = ex.maxPositionUsd(DOGE, true);
            vm.assume(maxPos >= 100 * 5e6);
            uint256 pid = _open(true, 5e6, 100);
            if (scenario == 2) {
                // Leave the house a dollar so the win queues.
                uint256 free = ex.houseFreeUsdc();
                vm.prank(owner);
                ex.withdrawHouse(free - 1e6);
            }
            _setPx(1_020_000); // +2%: a win at 100x
            (, uint256 queued) = _close(pid);
            assertGt(ex.feePool(), 0, "win fee pooled");
            if (scenario == 2) assertGt(queued, 0, "win queued");
        }

        uint256 freeNow = ex.houseFreeUsdc();
        mode = mode % 4;
        if (mode == 0) amount = freeNow;
        else if (mode == 1) amount = freeNow + 1;
        else if (mode == 2) amount = freeNow + bound(amount, 1, 1e12);
        else amount = bound(amount, 0, freeNow);

        uint256 ownerBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        if (amount == 0) {
            vm.expectRevert(IExchangeTypes.ZeroAmount.selector);
            ex.withdrawHouse(amount);
            return;
        }
        if (amount > freeNow) {
            vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, freeNow, amount));
            ex.withdrawHouse(amount);
            return;
        }
        ex.withdrawHouse(amount);
        assertEq(usdc.balanceOf(owner), ownerBefore + amount, "owner paid the amount");
        assertEq(ex.houseFreeUsdc(), freeNow - amount, "free cash lowered by the amount");
        assertGe(ex.lpBalance(), ex.queuedTotal() + ex.feePool(), "cash covers what is owed");
        if (amount == freeNow) {
            vm.prank(owner);
            vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 0, 1));
            ex.withdrawHouse(1);
        }
    }

    // ---------------------------------------------------------------- borrow

    /// @notice A flat close pays margin - min(borrow, margin), where borrow follows the spec on
    ///         the rate and free hours stamped at open (later setting changes do not reach it);
    ///         the house keeps exactly the borrow and the fee pool does not see it.
    function testFuzz_borrowFee(
        uint256 margin,
        uint256 lev,
        uint16 rateX10,
        uint16 freeHours,
        uint256 held,
        uint16 laterRate,
        uint16 laterFree,
        bool isLong
    ) public {
        vm.prank(owner);
        ex.depositHouse(1e12);
        rateX10 = uint16(bound(rateX10, 0, 50));
        freeHours = uint16(bound(freeHours, 0, 24));
        vm.startPrank(owner);
        ex.setMarketFees(DOGE, 0, rateX10); // no entry spread: a flat close is exactly flat
        ex.setBorrowFreeHours(freeHours);
        vm.stopPrank();

        margin = bound(margin, 5e6, 10_000e6);
        uint256 maxPos = ex.maxPositionUsd(DOGE, isLong);
        uint256 levCap = maxPos / margin;
        if (levCap > 1000) levCap = 1000;
        vm.assume(levCap >= 1);
        lev = bound(lev, 1, levCap);
        uint256 notional = margin * lev;

        uint256 pid = _open(isLong, margin, lev);
        uint256 openedAt = vm.getBlockTimestamp();
        assertEq(ex.positions(pid).borrowRateX10, rateX10, "rate stamped");
        assertEq(ex.positions(pid).borrowFreeHours, freeHours, "free hours stamped");

        vm.startPrank(owner);
        ex.setMarketFees(DOGE, 0, uint16(bound(laterRate, 0, 50)));
        ex.setBorrowFreeHours(uint16(bound(laterFree, 0, 24)));
        vm.stopPrank();

        held = bound(held, 5, 72 hours);
        vm.warp(openedAt + held - 5);
        assertEq(ex.borrowOwed(pid), _spec(notional, rateX10, held - 5, freeHours), "borrowOwed follows the spec");

        vm.prank(alice);
        ex.requestClose(pid);
        vm.warp(openedAt + held);
        uint256 lpBefore = ex.lpBalance();
        uint256 poolBefore = ex.feePool();
        vm.prank(keeper);
        (uint256 payout, uint256 queued) = ex.executeClose(pid);

        uint256 borrow = _spec(notional, rateX10, held, freeHours);
        if (borrow > margin) borrow = margin;
        assertEq(queued, 0, "flat close queues nothing");
        assertEq(payout, margin - borrow, "payout = margin - capped borrow");
        assertEq(ex.lpBalance(), lpBefore + borrow, "house keeps the borrow");
        assertEq(ex.feePool(), poolBefore, "borrow is not a pooled fee");
        assertEq(ex.balanceOf(alice), margin - borrow, "trader credited the payout");
    }

    /// @notice Whole hours only: $10K notional at 0.5 bps/h with 1 free hour owes nothing up to
    ///         2 h - 1 s, $0.50 from 2 h, $1.00 from 3 h.
    function test_borrowChargesWholeHoursOnly() public {
        vm.prank(owner);
        ex.depositHouse(100_000e6);
        uint256 pid = _open(true, 100e6, 100);
        uint256 openedAt = vm.getBlockTimestamp();
        vm.warp(openedAt + 2 hours - 1);
        assertEq(ex.borrowOwed(pid), 0);
        vm.warp(openedAt + 2 hours);
        assertEq(ex.borrowOwed(pid), 0.5e6);
        vm.warp(openedAt + 3 hours - 1);
        assertEq(ex.borrowOwed(pid), 0.5e6);
        vm.warp(openedAt + 3 hours);
        assertEq(ex.borrowOwed(pid), 1e6);
    }
}
