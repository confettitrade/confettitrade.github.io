// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ConfettiDeployer, LaunchMarkets} from "../../script/Deploy.s.sol";
import {IExchange} from "../../src/interfaces/IExchange.sol";
import {IExchangeTypes} from "../../src/interfaces/IExchangeTypes.sol";
import {ExchangeExt} from "../../src/ExchangeExt.sol";
import {MockUSDC} from "../../test/mocks/MockUSDC.sol";
import {MockPriceSource} from "../../test/mocks/MockPriceSource.sol";

/// @notice End-to-end smoke of the v4 architecture through the real deployer: the core answers
///         trading, the extension answers everything else through the fallback, house money
///         flows, house-sized limits bind, and the extension refuses direct calls.
contract V4SmokeTest is Test, ConfettiDeployer {
    MockUSDC usdc;
    MockPriceSource source;
    MockUSDC fetti;
    Deployment d;
    IExchange ex;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address marketKeeper = makeAddr("marketKeeper");
    address keeper = makeAddr("keeper");
    address feeRecipient = makeAddr("feeRecipient");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        source = new MockPriceSource();
        fetti = new MockUSDC();
        LaunchMarkets.Market[] memory m = LaunchMarkets.all();
        for (uint256 i = 0; i < m.length; i++) {
            source.setQuote(m[i].hlAssetIndex, 1_000_000, 1_000_000, 1_000_000);
        }
        Config memory cfg;
        cfg.usdc = address(usdc);
        cfg.owner = owner;
        cfg.guardian = guardian;
        cfg.marketKeeper = marketKeeper;
        cfg.keeper = keeper;
        cfg.feeRecipient = feeRecipient;
        cfg.priceSource = address(source);
        cfg.stakerFeeShareBps = DEFAULT_STAKER_FEE_SHARE_BPS;
        cfg.stakingWarmupS = DEFAULT_STAKING_WARMUP_S;
        cfg.winFeeBps = DEFAULT_WIN_FEE_BPS;
        cfg.lossFeeBps = DEFAULT_LOSS_FEE_BPS;
        cfg.rhoBps = DEFAULT_RHO_BPS;
        cfg.maxWinBps = DEFAULT_MAX_WIN_BPS;
        cfg.fetti = address(fetti);
        cfg.v3Referrals = address(0);
        d = _deploy(cfg, address(this));
        ex = IExchange(address(d.exchange));
        vm.startPrank(owner);
        d.exchange.acceptOwnership();
        d.staking.acceptOwnership();
        d.oracle.acceptOwnership();
        ex.setMarketOpensPaused(0, false);
        vm.stopPrank();

        usdc.mint(owner, 100_000e6);
        usdc.mint(alice, 10_000e6);
        vm.prank(owner);
        usdc.approve(address(ex), type(uint256).max);
        vm.prank(alice);
        usdc.approve(address(ex), type(uint256).max);
    }

    function test_rolesAndWiring() public view {
        assertEq(ex.owner(), owner);
        assertEq(ex.pauseGuardian(), guardian);
        assertEq(ex.marketKeeper(), marketKeeper);
        assertEq(ex.feeRecipient(), feeRecipient);
        assertTrue(ex.isKeeper(keeper));
        assertEq(ex.extension(), address(d.ext));
        assertEq(ex.instrumentCount(), 12);
        assertEq(ex.winFeeBps(), 500);
        assertEq(ex.lossFeeBps(), 500);
        assertEq(ex.rhoBps(), 2000);
        assertEq(ex.minMarginUsdc(), 5e6);
        assertEq(ex.breakerBps(), 2500);
    }

    function test_extensionRefusesDirectCalls() public {
        vm.prank(owner);
        vm.expectRevert(IExchangeTypes.DirectCall.selector);
        d.ext.setFeeBps(100, 0);
        vm.prank(owner);
        vm.expectRevert(IExchangeTypes.DirectCall.selector);
        d.ext.depositHouse(1);
        vm.prank(guardian);
        vm.expectRevert(IExchangeTypes.DirectCall.selector);
        d.ext.setGlobalOpensPaused(true);
    }

    function test_houseMoneyAndLimits() public {
        // No free cash: every open is refused as too large.
        vm.prank(alice);
        ex.deposit(1_000e6);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        ex.requestOpen(0, true, 10e6, 10, address(0));
        assertEq(ex.maxPositionUsd(0, true), 0);

        vm.prank(owner);
        ex.depositHouse(10_000e6);
        assertEq(ex.houseFreeUsdc(), 10_000e6);
        // posX10 50: 5x free cash = $50K; rho 2000 at stress 10%, base 10%: exposure term =
        // oi * 0.1 * 0.9 = 0.09 oi <= 0.2 * 10K -> oi <= $22.2K, which binds first.
        uint256 maxPos = ex.maxPositionUsd(0, true);
        assertApproxEqAbs(maxPos, 22_222e6, 2e6);

        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.HouseExposureExceeded.selector);
        ex.requestOpen(0, true, 100e6, 250, address(0));

        vm.prank(alice);
        uint256 rid = ex.requestOpen(0, true, 100e6, 100, address(0));
        skip(5);
        vm.prank(keeper);
        uint256 pid = ex.executeOpen(rid);
        assertEq(pid, 1);
        IExchangeTypes.Position memory p = ex.positions(pid);
        // Entry spread 1 bps on a $1 print, long: 1.0001.
        assertEq(p.entryPx18, 1.0001e18);
        assertEq(p.maxProfitUsdc, 2_500e6); // 25% of $10K free, below 50x margin
        assertEq(p.winFeeBps, 500);
        assertEq(p.borrowRateX10, 5);
        assertEq(ex.houseExposureUsdc(), 10_000e6 * 1000 * 9000 / 1e8);

        // The owner can take everything not owed; the fee pool is empty, nothing queued.
        vm.prank(owner);
        ex.withdrawHouse(10_000e6);
        assertEq(ex.lpBalance(), 0);
        assertEq(usdc.balanceOf(owner), 100_000e6);

        // Price up 1%: the win queues since the house has nothing.
        source.setQuote(12, 1_010_000, 1_010_000, 1_010_000);
        vm.prank(alice);
        ex.requestClose(pid);
        skip(5);
        vm.prank(keeper);
        (uint256 payout, uint256 queued) = ex.executeClose(pid);
        assertEq(payout, 100e6);
        assertGt(queued, 0);
        assertEq(ex.queuedTotal(), queued);
        assertEq(ex.houseFreeUsdc(), 0);

        // A deposit refills; harvest pays the queue; the owner cannot withdraw what is owed.
        vm.prank(owner);
        ex.depositHouse(50e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 0, 1));
        ex.withdrawHouse(1);
        ex.harvest(10);
        assertEq(ex.queuedTotal(), queued - 50e6);
        assertEq(ex.balanceOf(alice), 1_000e6 + 50e6);
        vm.prank(owner);
        ex.depositHouse(1_000e6);
        ex.harvest(10);
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.balanceOf(alice), 1_000e6 + queued);
        // Fees earned leave first on a withdrawal: the pool goes to stakers' earmark and the
        // fee recipient, the rest is free.
        uint256 pool = ex.feePool();
        assertGt(pool, 0);
        vm.prank(owner);
        ex.withdrawHouse(1);
        assertEq(ex.balanceOf(feeRecipient), pool - pool * 2000 / 10000);
        assertEq(ex.feePool(), pool * 2000 / 10000); // nobody staked: 20% held back
    }

    function test_lossAndBorrowAndFees() public {
        vm.prank(owner);
        ex.depositHouse(10_000e6);
        vm.prank(alice);
        ex.deposit(1_000e6);
        vm.prank(alice);
        uint256 rid = ex.requestOpen(0, false, 100e6, 100, address(0));
        skip(5);
        vm.prank(keeper);
        uint256 pid = ex.executeOpen(rid);
        // Held 3 hours at $10K notional, 0.5 bps/h after the first: 2 h * 0.5 bps * 10_000 = $1.
        skip(3 hours);
        assertEq(ex.borrowOwed(pid), 1e6);
        // Price up 0.5%: a short loses 50% of margin on 100x.
        source.setQuote(12, 1_005_000, 1_005_000, 1_005_000);
        vm.prank(alice);
        ex.requestClose(pid);
        skip(5);
        uint256 lpBefore = ex.lpBalance();
        vm.prank(keeper);
        (uint256 payout,) = ex.executeClose(pid);
        // Short entered at 0.9999 (1 bps spread down), exit 1.005: loss = 10_000 * 0.0051/0.9999.
        assertApproxEqAbs(payout, 100e6 - 51e6 - 1e6, 0.02e6);
        // Loss fee 5% of the loss, from the house's side: the trader paid the loss and the borrow.
        uint256 loss = 100e6 - 1e6 - payout;
        assertEq(ex.feePool(), loss * 500 / 10_000);
        assertApproxEqAbs(ex.lpBalance() - lpBefore, 52e6, 0.02e6);
    }
}
