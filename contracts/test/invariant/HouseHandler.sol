// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";

import {IExchange} from "../../src/interfaces/IExchange.sol";
import {IExchangeTypes} from "../../src/interfaces/IExchangeTypes.sol";
import {Staking} from "../../src/Staking.sol";
import {Referrals} from "../../src/Referrals.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockPriceSource} from "../mocks/MockPriceSource.sol";
import {MockFetti} from "../mocks/MockFetti.sol";

/// @notice Drives the real v4 deployment through every money path (trader collateral, delayed
///         opens and closes with keeper / self / third-party fills, cancels and expiry, price
///         moves, liquidations, harvest, fee pushes, house money in and out, the owner and
///         market-keeper setters, house wallets, time across borrow hours and breaker windows,
///         staking on the existing FETTI) and records, per call, every property that can only
///         be judged at the moment it happens (limits in the fill block, the withdrawal bound,
///         the exact fee split of each push, the close bound). A broken property bumps a
///         counter in `bad` and keeps the first reason; the invariant contract asserts them.
contract HouseHandler is CommonBase, StdCheats, StdUtils {
    // ------------------------------------------------------------ violations

    uint256 internal constant LIMITS = 0; // (3) house-sized and static limits at the fill
    uint256 internal constant MAX_PROFIT = 1; // (3) stamped max profit at the fill
    uint256 internal constant CLOSE_PAYS = 2; // (5) close bounded by margin + max profit
    uint256 internal constant WITHDRAW = 3; // (2) withdrawHouse bound and effects
    uint256 internal constant OWED = 4; // (2) cash covers what is owed after a withdrawal
    uint256 internal constant PUSH = 5; // (4) exact split of each fee push
    uint256 internal constant FETTI_SUPPLY = 6; // (6) no v4 call moves the FETTI supply
    uint256 internal constant WINDOW = 7; // fill windows: keeper-only grace
    uint256 internal constant QUEUE = 8; // harvest moves exactly what it pays
    uint256 internal constant KINDS = 9;

    uint256[KINDS] public bad;
    string public firstBad;

    // --------------------------------------------------------------- wiring

    struct Wiring {
        IExchange ex;
        MockUSDC usdc;
        MockPriceSource source;
        MockFetti fetti;
        Staking staking;
        Referrals referrals;
        address owner;
        address marketKeeper;
        address keeper;
        address feeRecipient;
    }

    IExchange public immutable ex;
    MockUSDC public immutable usdc;
    MockPriceSource public immutable source;
    MockFetti public immutable fetti;
    Staking public immutable staking;
    Referrals public immutable referrals;
    address public immutable owner;
    address public immutable marketKeeper;
    address public immutable keeper;
    address public immutable feeRecipient;
    address public immutable referrer;

    /// @dev DOGE (tier 0, 1000x), TRUMP (tier 1, 250x), BTC (stress 5%).
    uint32[3] internal _markets = [uint32(0), uint32(8), uint32(10)];
    uint64 internal constant BASE_RAW_PX = 1_000_000;
    uint64 internal constant MIN_RAW_PX = 200_000;
    uint64 internal constant MAX_RAW_PX = 5_000_000;

    address[] internal _traders;
    address[] internal _stakers;
    /// @dev Every address that can hold an exchange balance: traders (also the liquidators),
    ///      the referrer and the fee recipient.
    address[] internal _accounts;

    uint256[] internal _openReqs;
    uint256[] internal _posIds;

    // ---------------------------------------------------------------- ghosts

    /// @dev Fees carved by closes and liquidations (PositionClosed / PositionLiquidated).
    uint256 public ghostFeesCharged;
    /// @dev Everything fee pushes moved out of the pool (FeesPushed, both parts).
    uint256 public ghostFeesPushed;
    /// @dev The stakers' earmark left in the pool by the last push (0 after a full push).
    uint256 public ghostHeld;
    /// @dev USDC claimed out of Staking.
    uint256 public ghostStakerClaimed;
    /// @dev FETTI that reached the stakers from outside v4 (a v3 mint or a pool buy): the
    ///      whole FETTI supply, since no v4 contract mints or burns it.
    uint256 public ghostFettiIn;

    bool internal _pushSeen;
    uint256 internal _pushS;
    uint256 internal _pushR;

    // -------------------------------------------------------------- coverage

    uint256 public nOpens;
    uint256 public nKeeperFills;
    uint256 public nSelfFills;
    uint256 public nRefunds;
    uint256 public nCloses;
    uint256 public nWins;
    uint256 public nLiquidations;
    uint256 public nQueued;
    uint256 public nHarvests;
    uint256 public nPushes;
    uint256 public nWithdrawHouse;
    uint256 public nWithdrawRefused;
    uint256 public nBreakerTrips;
    uint256 public nForfeits;
    uint256 public nBorrowCharged;
    uint256 public nCancels;
    uint256 public nRequests;
    uint256 public nNoRoom;

    constructor(Wiring memory w) {
        ex = w.ex;
        usdc = w.usdc;
        source = w.source;
        fetti = w.fetti;
        staking = w.staking;
        referrals = w.referrals;
        owner = w.owner;
        marketKeeper = w.marketKeeper;
        keeper = w.keeper;
        feeRecipient = w.feeRecipient;
        referrer = makeAddr("referrer");

        _traders.push(makeAddr("alice"));
        _traders.push(makeAddr("bob"));
        _traders.push(makeAddr("carol"));
        _stakers.push(makeAddr("staker1"));
        _stakers.push(makeAddr("staker2"));

        for (uint256 i = 0; i < _traders.length; i++) {
            _accounts.push(_traders[i]);
            vm.prank(_traders[i]);
            usdc.approve(address(ex), type(uint256).max);
        }
        _accounts.push(referrer);
        _accounts.push(feeRecipient);
        for (uint256 i = 0; i < _stakers.length; i++) {
            vm.startPrank(_stakers[i]);
            fetti.approve(address(staking), type(uint256).max);
            vm.stopPrank();
        }
        vm.prank(referrer);
        referrals.registerCode("house_ref");
    }

    // ----------------------------------------------------------- read helpers

    function traders() external view returns (address[] memory) {
        return _traders;
    }

    function accounts() external view returns (address[] memory) {
        return _accounts;
    }

    function stakers() external view returns (address[] memory) {
        return _stakers;
    }

    function markets() external view returns (uint32[3] memory) {
        return _markets;
    }

    // ------------------------------------------------------------- modifier

    /// @dev Record the call's logs, tally fees from them, and check the FETTI supply is still
    ///      exactly what came from outside v4.
    modifier tracked() {
        vm.recordLogs();
        _;
        _tallyLogs(vm.getRecordedLogs());
        if (fetti.totalSupply() != ghostFettiIn) _bad(FETTI_SUPPLY, "FETTI supply moved inside v4");
    }

    // ------------------------------------------------------- trader collateral

    function deposit(uint256 a, uint256 amount) external tracked {
        address t = _pick(_traders, a);
        _fund(t, bound(amount, 1, 50_000e6));
    }

    function withdraw(uint256 a, uint256 amount) external tracked {
        address who = _pick(_accounts, a);
        uint256 available = ex.balanceOf(who);
        if (available == 0) return;
        amount = bound(amount, 1, available);
        vm.prank(who);
        ex.withdraw(amount);
    }

    // ---------------------------------------------------------------- opens

    function requestOpen(uint256 a, uint256 m, bool isLong, uint256 margin, uint256 lev, uint256 flags)
        external
        tracked
    {
        _requestOpen(a, m, isLong, margin, lev, flags, (flags >> 4) % 2 == 1);
    }

    /// @dev A request filled in the same call (keeper, self or third-party fill by `flags`),
    ///      so opens are frequent next to the step-by-step paths.
    function openNow(uint256 a, uint256 m, bool isLong, uint256 margin, uint256 lev, uint256 flags)
        external
        tracked
    {
        _requestOpen(a, m, isLong, margin, lev, flags, true);
    }

    function _requestOpen(
        uint256 a,
        uint256 m,
        bool isLong,
        uint256 margin,
        uint256 lev,
        uint256 flags,
        bool fillNow
    ) internal {
        address t = _pick(_traders, a);
        uint32 id = _market(m);
        uint256 minMargin = ex.minMarginUsdc();
        lev = bound(lev, 1, ex.instrument(id).maxLeverage);
        if (flags % 8 != 0) {
            // Shaped to what the house admits right now; one call in eight goes in raw.
            uint256 maxPos = ex.maxPositionUsd(id, isLong);
            if (maxPos < minMargin && (flags >> 2) % 2 == 0) {
                // The owner refills (and clears a trip) the way ops would; else no room.
                vm.prank(owner);
                ex.depositHouse(bound(margin, 1_000e6, 100_000e6));
                if (ex.breakerTripped()) {
                    vm.prank(owner);
                    ex.clearBreaker();
                }
                maxPos = ex.maxPositionUsd(id, isLong);
            }
            if (maxPos < minMargin) {
                nNoRoom++;
                return;
            }
            if (lev > maxPos / minMargin) lev = maxPos / minMargin;
            uint256 marginCap = maxPos / lev;
            if (marginCap > 20_000e6) marginCap = 20_000e6;
            margin = bound(margin, minMargin, marginCap);
        } else {
            margin = bound(margin, 0, 50_000e6);
        }
        uint256 available = ex.balanceOf(t);
        if (available < margin) _fund(t, margin - available);
        address ref = flags % 3 == 0 ? referrer : address(0);
        vm.prank(t);
        try ex.requestOpen(id, isLong, uint128(margin), uint32(lev), ref) returns (uint256 rid) {
            _openReqs.push(rid);
            nRequests++;
            if (fillNow) _executeOpen(_openReqs.length - 1, flags >> 8, flags >> 32);
        } catch {
            _discardLogs();
        }
    }

    struct OpenSnap {
        uint256 free;
        uint256 lp;
        uint256 sideOi;
        uint256 rhoBps;
        uint256 maxWinBps;
        IExchangeTypes.Instrument inst;
    }

    function executeOpen(uint256 r, uint256 mode, uint256 wait) external tracked {
        if (_openReqs.length == 0) return;
        _executeOpen(r % _openReqs.length, mode, wait);
    }

    function _executeOpen(uint256 idx, uint256 mode, uint256 wait) internal {
        uint256 rid = _openReqs[idx];
        IExchangeTypes.OpenRequest memory req = ex.openRequest(rid);
        if (req.trader == address(0)) {
            _dropReq(idx);
            return;
        }
        (address caller, bool keeperWindow, bool expired) = _enterWindow(req.requestedAt, mode, wait, req.trader);
        if (expired) {
            vm.prank(_pick(_accounts, wait));
            ex.cancelOpen(rid);
            _dropReq(idx);
            nCancels++;
            return;
        }

        OpenSnap memory s;
        s.free = ex.houseFreeUsdc();
        s.lp = ex.lpBalance();
        (uint256 longOi, uint256 shortOi) = ex.openInterest(req.instrumentId);
        s.sideOi = req.isLong ? longOi : shortOi;
        s.rhoBps = ex.rhoBps();
        s.maxWinBps = ex.maxWinBps();
        s.inst = ex.instrument(req.instrumentId);

        vm.prank(caller);
        try ex.executeOpen(rid) returns (uint256 pid) {
            if (keeperWindow && caller != keeper) _bad(WINDOW, "non-keeper filled in the grace window");
            _dropReq(idx);
            if (pid == 0) {
                nRefunds++;
                return;
            }
            _checkOpen(pid, req, s);
            _posIds.push(pid);
            nOpens++;
            if (keeperWindow) nKeeperFills++;
            else if (caller == req.trader) nSelfFills++;
        } catch {
            _discardLogs();
            if (keeperWindow && caller == keeper) _bad(WINDOW, "keeper fill refused in the grace window");
        }
    }

    /// @dev (3): the fill block's free cash bounds the notional, the side, the book and the
    ///      stamped maximum profit; an open moves no house cash.
    function _checkOpen(uint256 pid, IExchangeTypes.OpenRequest memory req, OpenSnap memory s) internal {
        uint256 notional = uint256(req.marginUsdc) * req.leverage;
        (uint256 longOi, uint256 shortOi) = ex.openInterest(req.instrumentId);
        uint256 sideAfter = req.isLong ? longOi : shortOi;
        if (sideAfter != s.sideOi + notional) _bad(LIMITS, "side OI not booked by the notional");
        if (notional > s.free * s.inst.posX10 / 10) _bad(LIMITS, "notional above free * posX10");
        if (sideAfter > s.free * s.inst.sideX10 / 10) _bad(LIMITS, "side OI above free * sideX10");
        if (ex.houseExposureUsdc() > s.free * s.rhoBps / 10_000) _bad(LIMITS, "book exposure above free * rho");
        if (notional > s.inst.maxNotionalUsd) _bad(LIMITS, "notional above static cap");
        if (sideAfter > (req.isLong ? s.inst.longOiCapUsd : s.inst.shortOiCapUsd)) _bad(LIMITS, "side above static cap");

        IExchangeTypes.Position memory p = ex.positions(pid);
        uint256 byHouse = s.free * s.maxWinBps / 10_000;
        uint256 byCap = uint256(req.marginUsdc) * s.inst.payoutCapX;
        if (p.maxProfitUsdc > byHouse) _bad(MAX_PROFIT, "max profit above free * maxWinBps");
        if (p.maxProfitUsdc > byCap) _bad(MAX_PROFIT, "max profit above margin * payoutCapX");
        if (p.maxProfitUsdc != (byHouse < byCap ? byHouse : byCap)) _bad(MAX_PROFIT, "max profit not the smaller bound");
        if (ex.lpBalance() != s.lp || ex.houseFreeUsdc() != s.free) _bad(LIMITS, "an open moved house cash");
    }

    function cancelOpen(uint256 r, uint256 who) external tracked {
        if (_openReqs.length == 0) return;
        uint256 idx = r % _openReqs.length;
        uint256 rid = _openReqs[idx];
        IExchangeTypes.OpenRequest memory req = ex.openRequest(rid);
        if (req.trader == address(0)) {
            _dropReq(idx);
            return;
        }
        uint256 deadline = uint256(req.requestedAt) + ex.expiry() + 1;
        if (vm.getBlockTimestamp() < deadline) vm.warp(deadline);
        uint256 before = ex.balanceOf(req.trader);
        vm.prank(_pick(_accounts, who));
        ex.cancelOpen(rid);
        if (ex.balanceOf(req.trader) != before + req.marginUsdc) _bad(WINDOW, "cancelOpen did not refund the margin");
        _dropReq(idx);
        nCancels++;
    }

    // --------------------------------------------------------------- closes

    function requestClose(uint256 p) external tracked {
        (, uint256 pid, IExchangeTypes.Position memory pos) = _livePosition(p);
        if (pid == 0) return;
        if (ex.closeRequest(pid).requestedAt != 0) return;
        vm.prank(pos.owner);
        ex.requestClose(pid);
    }

    function executeClose(uint256 p, uint256 mode, uint256 wait) external tracked {
        (uint256 idx, uint256 pid, IExchangeTypes.Position memory pos) = _livePosition(p);
        if (pid == 0) return;
        _executeClose(idx, pid, pos, mode, wait);
    }

    /// @dev Move a live position's market in its favour or against it, then close it: wins
    ///      (paid, queued, capped at max profit, forfeited for house wallets) and losses.
    function settle(uint256 p, uint256 bps, bool inFavour, uint256 mode, uint256 wait) external tracked {
        (uint256 idx, uint256 pid, IExchangeTypes.Position memory pos) = _livePosition(p);
        if (pid == 0) return;
        uint32 asset = ex.instrument(pos.instrumentId).hlAssetIndex;
        (,,, uint64 cur) = source.quotes(asset);
        uint256 move = bound(bps, 1, 1500);
        bool up = pos.isLong == inFavour;
        _setRaw(asset, up ? uint256(cur) * (10_000 + move) / 10_000 : uint256(cur) * (10_000 - move) / 10_000);
        _executeClose(idx, pid, pos, mode, wait);
    }

    function _executeClose(
        uint256 idx,
        uint256 pid,
        IExchangeTypes.Position memory pos,
        uint256 mode,
        uint256 wait
    ) internal {
        uint64 requestedAt = ex.closeRequest(pid).requestedAt;
        if (requestedAt == 0) {
            vm.prank(pos.owner);
            ex.requestClose(pid);
            requestedAt = uint64(vm.getBlockTimestamp());
        }
        (address caller, bool keeperWindow, bool expired) = _enterWindow(requestedAt, mode, wait, pos.owner);
        if (expired) {
            vm.prank(_pick(_accounts, wait));
            ex.cancelClose(pid);
            nCancels++;
            return;
        }
        uint256 availableBefore = ex.balanceOf(pos.owner);
        bool house = ex.isHouseWallet(pos.owner);
        bool covered = ex.lpBalance() >= ex.queuedTotal() + ex.feePool();
        vm.prank(caller);
        try ex.executeClose(pid) returns (uint256 payout, uint256 queued) {
            if (keeperWindow && caller != keeper) _bad(WINDOW, "non-keeper closed in the grace window");
            _dropPos(idx);
            nCloses++;
            if (payout + queued > uint256(pos.marginUsdc) + pos.maxProfitUsdc) {
                _bad(CLOSE_PAYS, "close paid above margin + max profit");
            }
            if (ex.balanceOf(pos.owner) != availableBefore + payout) _bad(CLOSE_PAYS, "payout not credited exactly");
            // A house wallet's close never queues and never takes the house below what it owes.
            if (house && queued > 0) _bad(CLOSE_PAYS, "house wallet win queued");
            if (house && covered && ex.lpBalance() < ex.queuedTotal() + ex.feePool()) {
                _bad(CLOSE_PAYS, "house wallet close left the house below what it owes");
            }
            if (queued > 0) nQueued++;
        } catch {
            _discardLogs();
            if (keeperWindow && caller == keeper) _bad(WINDOW, "keeper close refused in the grace window");
        }
    }

    function cancelClose(uint256 p, uint256 who) external tracked {
        (, uint256 pid,) = _livePosition(p);
        if (pid == 0) return;
        uint64 requestedAt = ex.closeRequest(pid).requestedAt;
        if (requestedAt == 0) return;
        uint256 deadline = uint256(requestedAt) + ex.expiry() + 1;
        if (vm.getBlockTimestamp() < deadline) vm.warp(deadline);
        vm.prank(_pick(_accounts, who));
        ex.cancelClose(pid);
        nCancels++;
    }

    function liquidate(uint256 p, uint256 who, bool forceBust) external tracked {
        (uint256 idx, uint256 pid, IExchangeTypes.Position memory pos) = _livePosition(p);
        if (pid == 0) return;
        if (forceBust) _priceToBust(pid, pos);
        address liquidator = _pick(_accounts, who);
        if (liquidator == feeRecipient) liquidator = referrer;
        vm.prank(liquidator);
        try ex.liquidate(pid) {
            _dropPos(idx);
            nLiquidations++;
        } catch {
            _discardLogs();
        }
    }

    // ------------------------------------------------------ queue and fees

    function harvest(uint256 n) external tracked {
        if (ex.queueHead() == ex.queueLength()) return;
        uint256 lpBefore = ex.lpBalance();
        uint256 queuedBefore = ex.queuedTotal();
        (, uint256 paid) = ex.harvest(bound(n, 1, 8));
        if (ex.lpBalance() + paid != lpBefore) _bad(QUEUE, "harvest moved other than it paid (lp)");
        if (ex.queuedTotal() + paid != queuedBefore) _bad(QUEUE, "harvest moved other than it paid (queue)");
        nHarvests++;
    }

    struct PushSnap {
        uint256 pool;
        uint256 lp;
        uint256 queued;
        bool queueEmpty;
        uint256 recipientAvailable;
        uint256 stakingUsdc;
        uint256 active;
        uint256 shareBps;
    }

    function pushFees() external tracked {
        PushSnap memory s = _snapPush();
        try ex.pushFees() returns (uint256 toStakers, uint256 toRecipient) {
            _checkPush(s, true, toStakers, toRecipient, 0);
        } catch {
            _discardLogs();
            _checkPush(s, false, 0, 0, 0);
        }
    }

    // ---------------------------------------------------------- house money

    function depositHouse(uint256 amount) external tracked {
        amount = bound(amount, 1, 100_000e6);
        uint256 lpBefore = ex.lpBalance();
        vm.prank(owner);
        ex.depositHouse(amount);
        if (ex.lpBalance() != lpBefore + amount) _bad(WITHDRAW, "depositHouse not booked to lp");
    }

    /// @dev (2): exactly the free cash, one above it, far above it, or anything up to it.
    function withdrawHouse(uint256 mode, uint256 amount) external tracked {
        uint256 free = ex.houseFreeUsdc();
        mode = mode % 4;
        if (mode == 0) amount = free;
        else if (mode == 1) amount = free + 1;
        else if (mode == 2) amount = free + bound(amount, 2, 1e12);
        else amount = bound(amount, 0, free);

        PushSnap memory s = _snapPush();
        uint256 ownerBefore = usdc.balanceOf(owner);
        _tallyLogs(vm.getRecordedLogs());
        _pushSeen = false;
        vm.prank(owner);
        try ex.withdrawHouse(amount) {
            nWithdrawHouse++;
            if (amount == 0 || amount > free) _bad(WITHDRAW, "withdrawHouse succeeded above houseFreeUsdc");
            if (ex.lpBalance() < ex.queuedTotal() + ex.feePool()) _bad(OWED, "lp below queue + fee pool after withdraw");
            if (usdc.balanceOf(owner) != ownerBefore + amount) _bad(WITHDRAW, "owner not paid the amount");
            if (ex.houseFreeUsdc() != free - amount) _bad(WITHDRAW, "free cash not lowered by the amount");
            _tallyLogs(vm.getRecordedLogs());
            _checkPush(s, _pushSeen, _pushS, _pushR, amount);
        } catch {
            _discardLogs();
            if (amount != 0 && amount <= free) _bad(WITHDRAW, "withdrawHouse refused within houseFreeUsdc");
            nWithdrawRefused++;
        }
    }

    // --------------------------------------------------------------- market

    function movePrice(uint256 m, uint256 bps, bool up, bool big) external tracked {
        uint32 asset = ex.instrument(_market(m)).hlAssetIndex;
        (,,, uint64 cur) = source.quotes(asset);
        uint256 move = big ? bound(bps, 300, 3000) : bound(bps, 1, 150);
        _setRaw(asset, up ? uint256(cur) * (10_000 + move) / 10_000 : uint256(cur) * (10_000 - move) / 10_000);
    }

    /// @dev Set a feed's print, kept within [MIN_RAW_PX, MAX_RAW_PX].
    function _setRaw(uint32 asset, uint256 next) internal {
        if (next < MIN_RAW_PX) next = MIN_RAW_PX;
        if (next > MAX_RAW_PX) next = MAX_RAW_PX;
        source.setQuote(asset, uint64(next), uint64(next), uint64(next));
    }

    function skipTime(uint256 mode, uint256 secs) external tracked {
        mode = mode % 3;
        uint256 nowTs = vm.getBlockTimestamp();
        uint256 target;
        if (mode == 0) {
            target = nowTs + bound(secs, 1, 90);
        } else if (mode == 1) {
            // Across whole borrow hours (and beyond the 24 h free ceiling).
            target = nowTs + bound(secs, 1 hours - 5, 30 hours);
        } else {
            // To either side of the breaker window's end.
            (uint64 windowStart,,) = ex.breakerWindow();
            target = uint256(windowStart) + 1 hours - 2 + bound(secs, 0, 4);
            if (target <= nowTs) target = nowTs + bound(secs, 1, 1 hours);
        }
        vm.warp(target);
    }

    function clearBreaker() external tracked {
        if (!ex.breakerTripped()) return;
        vm.prank(owner);
        ex.clearBreaker();
    }

    // ------------------------------------------------------------- settings

    function tune(uint256 which, uint256 a, uint256 b, uint256 c, uint256 m) external tracked {
        uint32 id = _market(m);
        which = which % 11;
        if (which == 0) {
            vm.prank(c % 2 == 0 ? owner : marketKeeper);
            ex.setHouseSizing(id, uint16(bound(a, 10, 200)), uint16(bound(b, 10, 500)), uint16(bound(c, 10, 5000)));
        } else if (which == 1) {
            vm.prank(owner);
            ex.setRhoBps(uint16(bound(a, 500, 10_000)));
        } else if (which == 2) {
            vm.prank(owner);
            ex.setMaxWinBps(uint16(bound(a, 500, 5000)));
        } else if (which == 3) {
            vm.prank(owner);
            ex.setFeeBps(uint16(bound(a, 0, 1000)), uint16(bound(b, 0, 500)));
        } else if (which == 4) {
            vm.prank(owner);
            ex.setMarketFees(id, uint16(bound(a, 0, 50)), uint16(bound(b, 0, 50)));
        } else if (which == 5) {
            vm.prank(owner);
            ex.setBorrowFreeHours(uint16(bound(a, 0, 24)));
        } else if (which == 6) {
            vm.prank(owner);
            ex.setStakerFeeShare(uint16(bound(a, 0, 10_000)));
        } else if (which == 7) {
            vm.prank(owner);
            ex.setPositionCaps(id, uint128(bound(b, 1_000e6, 1_000_000e6)), uint16(bound(a, 10, 50)));
        } else if (which == 8) {
            vm.prank(owner);
            ex.setReferralShare(uint16(bound(a, 0, 5000)));
        } else if (which == 9) {
            vm.prank(owner);
            ex.setMinMargin(uint64(bound(a, 1e6, 10e6)));
        } else {
            vm.prank(owner);
            ex.setBreakerBps(uint16(bound(a, 200, 10_000)));
        }
    }

    function setHouseWallet(uint256 a, bool isHouse) external tracked {
        vm.prank(owner);
        ex.setHouseWallet(_pick(_traders, a), isHouse);
    }

    // ------------------------------------------------------ staking and FETTI

    /// @dev FETTI reaches a staker from outside v4 (a v3 mint, a pool buy, a transfer).
    function receiveFetti(uint256 a, uint256 amount, bool toOther) external tracked {
        amount = bound(amount, 1, 1e24);
        fetti.mint(toOther ? _pick(_stakers, a ^ 1) : _pick(_stakers, a), amount);
        ghostFettiIn += amount;
    }

    /// @dev Stake part of the wallet's FETTI, or (`fresh`) FETTI that just arrived.
    function stake(uint256 a, uint256 amount, bool fresh) external tracked {
        address s = _pick(_stakers, a);
        if (fresh) {
            amount = bound(amount, 1, 1e24);
            fetti.mint(s, amount);
            ghostFettiIn += amount;
        } else {
            uint256 balance = fetti.balanceOf(s);
            if (balance == 0) return;
            amount = bound(amount, 1, balance);
        }
        vm.prank(s);
        staking.stake(amount);
    }

    function unstake(uint256 a, uint256 amount) external tracked {
        address s = _pick(_stakers, a);
        uint256 staked = staking.stakedOf(s);
        if (staked == 0) return;
        amount = bound(amount, 1, staked);
        vm.prank(s);
        staking.unstake(amount);
    }

    function claim(uint256 a) external tracked {
        address s = _pick(_stakers, a);
        uint256 before = usdc.balanceOf(s);
        vm.prank(s);
        uint256 got = staking.claim();
        if (usdc.balanceOf(s) != before + got) _bad(PUSH, "staking claim paid other than reported");
        ghostStakerClaimed += got;
    }

    // ------------------------------------------------------------- internal

    function _bad(uint256 kind, string memory why) internal {
        if (bytes(firstBad).length == 0) firstBad = why;
        bad[kind]++;
    }

    function _pick(address[] storage list, uint256 seed) internal view returns (address) {
        return list[seed % list.length];
    }

    function _market(uint256 seed) internal view returns (uint32) {
        return _markets[seed % _markets.length];
    }

    function _fund(address t, uint256 amount) internal {
        if (amount == 0) return;
        usdc.mint(t, amount);
        vm.prank(t);
        ex.deposit(amount);
    }

    function _dropReq(uint256 idx) internal {
        _openReqs[idx] = _openReqs[_openReqs.length - 1];
        _openReqs.pop();
    }

    function _dropPos(uint256 idx) internal {
        _posIds[idx] = _posIds[_posIds.length - 1];
        _posIds.pop();
    }

    /// @dev A tracked position still open (stale entries are dropped on the way).
    function _livePosition(uint256 seed)
        internal
        returns (uint256 idx, uint256 pid, IExchangeTypes.Position memory pos)
    {
        while (_posIds.length != 0) {
            idx = seed % _posIds.length;
            pid = _posIds[idx];
            pos = ex.positions(pid);
            if (pos.owner != address(0)) return (idx, pid, pos);
            _dropPos(idx);
        }
        return (0, 0, pos);
    }

    /// @dev Move time into a fill window for a request filed at `requestedAt`. Mode 0: the
    ///      keeper inside the grace window; 1: the trader after it (self fill); 2: a third
    ///      party after it; 3: a non-keeper inside the grace window (must be refused).
    function _enterWindow(uint64 requestedAt, uint256 mode, uint256 wait, address trader)
        internal
        returns (address caller, bool keeperWindow, bool expired)
    {
        uint256 elapsed = vm.getBlockTimestamp() - requestedAt;
        uint256 minDelay = ex.minDelay();
        uint256 graceEnd = minDelay + ex.grace();
        uint256 expiry = ex.expiry();
        if (elapsed > expiry) return (address(0), false, true);
        mode = mode % 4;
        uint256 lo;
        uint256 hi;
        if ((mode == 0 || mode == 3) && elapsed < graceEnd) {
            keeperWindow = true;
            lo = elapsed > minDelay ? elapsed : minDelay;
            hi = graceEnd - 1;
            caller = mode == 0 ? keeper : trader;
        } else {
            lo = elapsed > graceEnd ? elapsed : graceEnd;
            hi = expiry;
            caller = mode == 2 ? _pick(_accounts, wait) : trader;
        }
        uint256 target = bound(wait, lo, hi);
        if (target > elapsed) vm.warp(uint256(requestedAt) + target);
    }

    /// @dev Put the market's print exactly on (or one tick past) `pos`'s bust price.
    function _priceToBust(uint256 pid, IExchangeTypes.Position memory pos) internal {
        IExchangeTypes.Instrument memory inst = ex.instrument(pos.instrumentId);
        uint256 scale = 10 ** (12 + uint256(inst.szDecimals));
        uint256 bust18 = ex.bustPrice(pid);
        uint256 raw = pos.isLong ? bust18 / scale : (bust18 + scale - 1) / scale;
        if (raw == 0 || raw > type(uint64).max) return;
        source.setQuote(inst.hlAssetIndex, uint64(raw), uint64(raw), uint64(raw));
    }

    function _snapPush() internal view returns (PushSnap memory s) {
        s.pool = ex.feePool();
        s.lp = ex.lpBalance();
        s.queued = ex.queuedTotal();
        s.queueEmpty = ex.queueHead() == ex.queueLength();
        s.recipientAvailable = ex.balanceOf(feeRecipient);
        s.stakingUsdc = usdc.balanceOf(address(staking));
        s.active = staking.totalStake();
        s.shareBps = ex.stakerFeeShareBps();
    }

    /// @dev (4): a push happens exactly when the queue is empty and the cash covers a non-empty
    ///      pool with something new to move; the stakers' part is the earmark plus their share
    ///      of the rest, held back whole while nobody is active; the two parts are exactly what
    ///      left the pool and the house cash, and land with Staking and the fee recipient.
    function _checkPush(PushSnap memory s, bool pushed, uint256 toStakers, uint256 toRecipient, uint256 alsoOut)
        internal
    {
        uint256 held = ghostHeld;
        if (s.pool < held) {
            _bad(PUSH, "fee pool below the stakers' earmark");
            return;
        }
        bool canPush = s.queueEmpty && s.pool != 0 && s.lp >= s.pool;
        uint256 stakersPart = held + (s.pool - held) * s.shareBps / 10_000;
        uint256 expStakers = stakersPart;
        uint256 newHeld = 0;
        if (stakersPart != 0 && s.active == 0) {
            if (s.pool == held) canPush = false;
            expStakers = 0;
            newHeld = stakersPart;
        }
        if (pushed != canPush) {
            _bad(PUSH, pushed ? "fees pushed when nothing was pushable" : "pushable fees refused");
            return;
        }
        if (!pushed) {
            if (ex.feePool() != s.pool) _bad(PUSH, "refused push moved the pool");
            return;
        }
        nPushes++;
        if (toStakers != expStakers) _bad(PUSH, "stakers' part off");
        if (toRecipient != s.pool - stakersPart) _bad(PUSH, "recipient's part off");
        if (toStakers + toRecipient != s.pool - ex.feePool()) _bad(PUSH, "parts != what left the pool");
        if (ex.feePool() != newHeld) _bad(PUSH, "earmark left in the pool off");
        if (s.lp - ex.lpBalance() != toStakers + toRecipient + alsoOut) _bad(PUSH, "parts != what left house cash");
        if (ex.balanceOf(feeRecipient) != s.recipientAvailable + toRecipient) _bad(PUSH, "recipient not credited");
        if (usdc.balanceOf(address(staking)) != s.stakingUsdc + toStakers) _bad(PUSH, "Staking not paid its part");
        ghostHeld = newHeld;
    }

    /// @dev A reverted call's logs may still be recorded: drop them so nothing is tallied.
    function _discardLogs() internal {
        vm.getRecordedLogs();
    }

    function _tallyLogs(Vm.Log[] memory logs) internal {
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(ex) || l.topics.length == 0) continue;
            bytes32 t0 = l.topics[0];
            if (t0 == IExchangeTypes.PositionClosed.selector) {
                (, int256 pnl, uint256 fee,,, uint256 borrow,) =
                    abi.decode(l.data, (uint256, int256, uint256, uint256, uint256, uint256, bool));
                ghostFeesCharged += fee;
                if (borrow != 0) nBorrowCharged++;
                if (pnl > 0) nWins++;
            } else if (t0 == IExchangeTypes.PositionLiquidated.selector) {
                (,,, uint256 fee) = abi.decode(l.data, (uint256, uint128, uint256, uint256));
                ghostFeesCharged += fee;
            } else if (t0 == IExchangeTypes.FeesPushed.selector) {
                (uint256 s, uint256 r) = abi.decode(l.data, (uint256, uint256));
                ghostFeesPushed += s + r;
                _pushSeen = true;
                _pushS = s;
                _pushR = r;
            } else if (t0 == IExchangeTypes.LpBreakerTripped.selector) {
                nBreakerTrips++;
            } else if (t0 == IExchangeTypes.HouseWinForfeited.selector) {
                nForfeits++;
            }
        }
    }
}
