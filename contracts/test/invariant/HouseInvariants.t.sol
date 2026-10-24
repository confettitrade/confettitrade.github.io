// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console} from "forge-std/console.sol";
import {IExchangeTypes} from "../../src/interfaces/IExchangeTypes.sol";
import {V4Fixture} from "./V4Fixture.sol";
import {HouseHandler} from "./HouseHandler.sol";

/// @notice Invariants of the v4 house over the real deployment, driven by `HouseHandler`.
///         Point-in-time properties (limits in the fill block, the withdrawal bound, each push's
///         split, each close's bound) are judged by the handler as they happen and asserted
///         here through its violation counters; the standing properties (USDC conservation,
///         fee conservation, queue and book accounting, FETTI supply) are recomputed here from
///         the contracts' state after every call.
contract HouseInvariantTest is V4Fixture {
    HouseHandler internal h;

    uint256 internal constant LIMITS = 0;
    uint256 internal constant MAX_PROFIT = 1;
    uint256 internal constant CLOSE_PAYS = 2;
    uint256 internal constant WITHDRAW = 3;
    uint256 internal constant OWED = 4;
    uint256 internal constant PUSH = 5;
    uint256 internal constant FETTI_SUPPLY = 6;
    uint256 internal constant WINDOW = 7;
    uint256 internal constant QUEUE = 8;

    function setUp() public {
        _deployV4();
        _unpause(0);
        _unpause(8);
        _unpause(10);
        // House money to start trading with; the handler adds and takes more at random.
        vm.prank(owner);
        ex.depositHouse(50_000e6);

        h = new HouseHandler(
            HouseHandler.Wiring({
                ex: ex,
                usdc: usdc,
                source: source,
                fetti: fetti,
                staking: d.staking,
                referrals: d.referrals,
                owner: owner,
                marketKeeper: marketKeeper,
                keeper: keeper,
                feeRecipient: feeRecipient
            })
        );

        bytes4[] memory s = new bytes4[](24);
        s[0] = HouseHandler.deposit.selector;
        s[1] = HouseHandler.withdraw.selector;
        s[2] = HouseHandler.requestOpen.selector;
        s[3] = HouseHandler.executeOpen.selector;
        s[4] = HouseHandler.cancelOpen.selector;
        s[5] = HouseHandler.requestClose.selector;
        s[6] = HouseHandler.executeClose.selector;
        s[7] = HouseHandler.cancelClose.selector;
        s[8] = HouseHandler.liquidate.selector;
        s[9] = HouseHandler.harvest.selector;
        s[10] = HouseHandler.pushFees.selector;
        s[11] = HouseHandler.depositHouse.selector;
        s[12] = HouseHandler.withdrawHouse.selector;
        s[13] = HouseHandler.movePrice.selector;
        s[14] = HouseHandler.skipTime.selector;
        s[15] = HouseHandler.clearBreaker.selector;
        s[16] = HouseHandler.tune.selector;
        s[17] = HouseHandler.setHouseWallet.selector;
        s[18] = HouseHandler.receiveFetti.selector;
        s[19] = HouseHandler.stake.selector;
        s[20] = HouseHandler.unstake.selector;
        s[22] = HouseHandler.openNow.selector;
        s[23] = HouseHandler.settle.selector;
        s[21] = HouseHandler.claim.selector;
        targetContract(address(h));
        targetSelector(StdInvariant.FuzzSelector({addr: address(h), selectors: s}));
    }

    // ----------------------------------------------------------- invariants

    /// @notice (1) The exchange's USDC is exactly the traders' available balances, the margins
    ///         of open positions and pending open requests, and house cash. The fee pool and
    ///         the queue are claims on house cash, not extra cash. Position and request margins
    ///         are summed from the objects themselves and must match the per-account tallies.
    function invariant_usdcConservation() public view {
        address[] memory accts = h.accounts();
        uint256 available;
        uint256 inUse;
        uint256 pending;
        for (uint256 i = 0; i < accts.length; i++) {
            available += ex.balanceOf(accts[i]);
            inUse += ex.marginInUse(accts[i]);
            pending += ex.pendingOf(accts[i]);
        }
        uint256 positionMargins;
        uint256 nextPos = ex.nextPositionId();
        for (uint256 pid = 1; pid < nextPos; pid++) {
            positionMargins += ex.positions(pid).marginUsdc;
        }
        uint256 requestMargins;
        uint256 nextReq = ex.nextRequestId();
        for (uint256 rid = 1; rid < nextReq; rid++) {
            requestMargins += ex.openRequest(rid).marginUsdc;
        }
        assertEq(inUse, positionMargins, "marginInUse != open position margins");
        assertEq(pending, requestMargins, "pending != open request margins");
        assertEq(
            usdc.balanceOf(address(ex)),
            available + positionMargins + requestMargins + ex.lpBalance(),
            "USDC held != available + margins + pending + house cash"
        );
    }

    /// @notice (2) Free cash is lp - queue - fee pool floored at 0; a withdrawal never takes
    ///         more than it, always succeeds up to it, and leaves cash covering what is owed.
    function invariant_houseCashCoversOwed() public view {
        assertEq(h.bad(WITHDRAW), 0, h.firstBad());
        assertEq(h.bad(OWED), 0, h.firstBad());
        uint256 owed = ex.queuedTotal() + ex.feePool();
        uint256 lp = ex.lpBalance();
        assertEq(ex.houseFreeUsdc(), lp > owed ? lp - owed : 0, "houseFreeUsdc != lp - owed floored");
    }

    /// @notice (3) Every fill respected the house-sized and static limits on the free cash of
    ///         its block and stamped max profit = min(margin * payoutCapX, free * maxWinBps);
    ///         every open position still carries a max profit within its payout cap.
    function invariant_openLimits() public view {
        assertEq(h.bad(LIMITS), 0, h.firstBad());
        assertEq(h.bad(MAX_PROFIT), 0, h.firstBad());
        uint256 nextPos = ex.nextPositionId();
        for (uint256 pid = 1; pid < nextPos; pid++) {
            IExchangeTypes.Position memory p = ex.positions(pid);
            if (p.owner == address(0)) continue;
            assertLe(p.maxProfitUsdc, uint256(p.marginUsdc) * p.payoutCapX, "max profit above payout cap");
        }
    }

    /// @notice (4) Each push splits exactly into the stakers' and the fee recipient's parts, and
    ///         every fee charged is accounted for: pushed, still pooled, or paid to a referrer.
    function invariant_feeConservation() public view {
        assertEq(h.bad(PUSH), 0, h.firstBad());
        assertEq(
            h.ghostFeesCharged(),
            h.ghostFeesPushed() + ex.feePool() + d.referrals.referralEarned(h.referrer()),
            "fees charged != pushed + pool + referral payouts"
        );
    }

    /// @notice (5) No close credits or queues more than margin + stamped max profit.
    function invariant_closeBounded() public view {
        assertEq(h.bad(CLOSE_PAYS), 0, h.firstBad());
    }

    /// @notice (6) v4 never mints or burns FETTI: the supply is exactly what came from outside
    ///         v4 (checked after every call), and Staking holds no FETTI beyond the stakes.
    function invariant_fettiSupplyNeverMovesInsideV4() public view {
        assertEq(fetti.totalSupply(), h.ghostFettiIn(), "FETTI supply moved inside v4");
        assertEq(h.bad(FETTI_SUPPLY), 0, h.firstBad());
    }

    /// @notice Queue, book and window accounting: the queue total is the sum of unpaid entries,
    ///         the OI, exposure and open max payout match the open positions, harvest moves
    ///         exactly what it pays and only a fill keeper fills in the grace window.
    function invariant_bookkeeping() public view {
        assertEq(h.bad(QUEUE), 0, h.firstBad());
        assertEq(h.bad(WINDOW), 0, h.firstBad());

        uint256 queued;
        uint256 len = ex.queueLength();
        for (uint256 i = ex.queueHead(); i < len; i++) {
            (, uint256 owedUsdc) = ex.queueEntry(i);
            queued += owedUsdc;
        }
        assertEq(ex.queuedTotal(), queued, "queuedTotal != unpaid entries");

        uint32[3] memory m = h.markets();
        uint256[3] memory longOi;
        uint256[3] memory shortOi;
        uint256 maxPayout;
        uint256 nextPos = ex.nextPositionId();
        for (uint256 pid = 1; pid < nextPos; pid++) {
            IExchangeTypes.Position memory p = ex.positions(pid);
            if (p.owner == address(0)) continue;
            maxPayout += p.maxProfitUsdc;
            for (uint256 k = 0; k < 3; k++) {
                if (m[k] != p.instrumentId) continue;
                if (p.isLong) longOi[k] += uint256(p.marginUsdc) * p.leverage;
                else shortOi[k] += uint256(p.marginUsdc) * p.leverage;
            }
        }
        assertEq(ex.openMaxPayoutUsdc(), maxPayout, "openMaxPayoutUsdc != sum of max profits");
        uint256 exposure;
        for (uint256 k = 0; k < 3; k++) {
            (uint256 l, uint256 s) = ex.openInterest(m[k]);
            assertEq(l, longOi[k], "long OI != open longs");
            assertEq(s, shortOi[k], "short OI != open shorts");
            IExchangeTypes.Instrument memory inst = ex.instrument(m[k]);
            uint256 oi = l > s ? l : s;
            exposure += oi * inst.stressBps * (10_000 - inst.baseRateBps) / 1e8;
        }
        assertEq(ex.houseExposureUsdc(), exposure, "book exposure != sum of market terms");
    }

    /// @notice Staking holds exactly the rewards notified minus what was claimed, and exactly
    ///         the FETTI staked.
    function invariant_stakingCustody() public view {
        assertEq(
            usdc.balanceOf(address(d.staking)),
            d.staking.totalRewardsUsdc() - h.ghostStakerClaimed(),
            "Staking USDC != notified - claimed"
        );
        assertEq(fetti.balanceOf(address(d.staking)), d.staking.totalStake(), "Staking FETTI != total stake");
    }

    /// @dev Coverage of the last run (shown with -vv).
    function afterInvariant() public view {
        console.log("opens", h.nOpens(), "keeper fills", h.nKeeperFills());
        console.log("self fills", h.nSelfFills(), "refunds", h.nRefunds());
        console.log("closes", h.nCloses(), "wins", h.nWins());
        console.log("liquidations", h.nLiquidations(), "queued wins", h.nQueued());
        console.log("harvests", h.nHarvests(), "pushes", h.nPushes());
        console.log("withdrawHouse ok", h.nWithdrawHouse(), "refused", h.nWithdrawRefused());
        console.log("breaker trips", h.nBreakerTrips(), "forfeits", h.nForfeits());
        console.log("borrow charged", h.nBorrowCharged(), "cancels", h.nCancels());
        console.log("requests", h.nRequests(), "no room", h.nNoRoom());
    }
}
