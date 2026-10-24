// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {Exchange} from "../../src/Exchange.sol";
import {ExchangeExt} from "../../src/ExchangeExt.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {Referrals} from "../../src/Referrals.sol";
import {ImpactLib} from "../../src/lib/ImpactLib.sol";
import {IExchange} from "../../src/interfaces/IExchange.sol";
import {IExchangeTypes} from "../../src/interfaces/IExchangeTypes.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";
import {IReferrals} from "../../src/interfaces/IReferrals.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockPriceSource} from "../mocks/MockPriceSource.sol";
import {StubStaking} from "../mocks/StubStaking.sol";

/// @title ExchangeFixture
/// @notice Shared setup for the exchange unit suites: the v4 core and its extension built
///         directly (extension first, then the core, which creates Referrals, MarketRules and
///         the SessionRouter), a real PriceOracle on a mock HyperCore source and a Staking stub.
/// @dev Roles are all distinct here so a test catches a mix-up between them: owner, pause
///      guardian, market keeper, fill keeper, fee recipient. The owner puts `HOUSE` of house money in at setUp.
///      The suite runs on a neutral configuration so the settlement arithmetic stays easy to
///      check by hand: fees 5% / 5% (`setFeeBps(500, 500)`), no entry spread, no borrow, the
///      breaker off (10000), and house-sized limits wide open (posX10 200, sideX10 500, stress
///      10 bps) so only the static caps bind. Each v4 mechanism's own tests switch it on.
abstract contract ExchangeFixture is Test {
    MockUSDC usdc;
    MockPriceSource source;
    PriceOracle oracle;
    StubStaking staking;
    ExchangeExt ext;
    Exchange core;
    IExchange ex;
    Referrals refs;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address marketKeeper = makeAddr("marketKeeper");
    address keeper = makeAddr("keeper");
    address feeRecipient = makeAddr("feeRecipient");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address liquidator = makeAddr("liquidator");
    address stranger = makeAddr("stranger");

    // Instruments: 0 = tier A (DOGE-like, HL index 12), 1 = tier B (174), 2 = tier C (176).
    uint32 constant TIER_A = 0;
    uint32 constant TIER_B = 1;
    uint32 constant TIER_C = 2;
    uint32 constant ASSET_A = 12;
    uint32 constant ASSET_B = 174;
    uint32 constant ASSET_C = 176;

    /// @dev Raw quote with szDecimals 0: 1_000_000 -> $1.000000 -> 1e18.
    uint64 constant RAW_ONE = 1_000_000;
    uint256 constant ONE = 1e18;
    uint128 constant MARGIN = 100e6;
    uint32 constant LEV = 10; // notional $1000

    /// @dev House money the owner deposits at setUp.
    uint256 constant HOUSE = 100_000e6;

    /// @dev The default request windows: keeper only in [5, 8), anyone in [8, 60], cancel after.
    uint256 constant DELAY = 5;
    uint256 constant GRACE = 3;
    uint256 constant EXPIRY = 60;

    bytes32 constant POSITION_CLOSED_TOPIC =
        keccak256("PositionClosed(uint256,address,uint256,int256,uint256,uint256,uint256,uint256,bool)");

    function setUp() public virtual {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        source = new MockPriceSource();
        oracle = new PriceOracle(source, address(this));
        staking = new StubStaking(address(usdc));
        (ext, core) = _build(owner);
        ex = IExchange(address(core));
        refs = Referrals(ex.referrals());
        oracle.setRegistrar(address(ex));

        vm.startPrank(owner);
        ex.setKeepers(guardian, marketKeeper);
        ex.setKeeper(keeper, true);
        ex.setFeeBps(500, 500);
        ex.setBreakerBps(10_000);
        ex.addInstrument(_spec(0, ASSET_A, 1, 10, 250_000e6));
        ex.addInstrument(_spec(1, ASSET_B, 3, 25, 100_000e6));
        ex.addInstrument(_spec(2, ASSET_C, 10, 50, 25_000e6));
        vm.stopPrank();

        _setPx(ASSET_A, RAW_ONE);
        _setPx(ASSET_B, RAW_ONE);
        _setPx(ASSET_C, RAW_ONE);

        _depositHouse(HOUSE);
        _fund(alice, 1000e6);
        _fund(bob, 1000e6);
        _fund(carol, 1000e6);
        _fund(dave, 1000e6);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Extension first (same USDC / oracle / Staking), then the core.
    function _build(address owner_) internal returns (ExchangeExt e, Exchange c) {
        e = new ExchangeExt(usdc, oracle, IStaking(address(staking)), owner_);
        c = new Exchange(usdc, oracle, IStaking(address(staking)), e, IReferrals(address(0)), owner_, feeRecipient);
    }

    /// @dev Fixture spec: the tier's old leverage ladder (1000 / 250 / 50) as the per-coin cap,
    ///      no entry spread, no borrow, house-sized limits at their widest.
    function _spec(uint8 tier, uint32 asset, uint16 deadband, uint16 clamp, uint128 cap)
        internal
        pure
        returns (IExchangeTypes.Instrument memory)
    {
        return IExchangeTypes.Instrument({
            hlAssetIndex: asset,
            szDecimals: 0,
            tier: tier,
            maxLeverage: tier == 0 ? 1000 : (tier == 1 ? 250 : 50),
            deadbandBps: deadband,
            clampBps: clamp,
            baseRateBps: 1000,
            rateMultiplier: 15_000,
            referenceNotionalUsd: 20_000e6,
            positionMultiplierE6: 130_000_000e6,
            longOiCapUsd: cap,
            shortOiCapUsd: cap,
            maxNotionalUsd: 100_000e6,
            payoutCapX: 50,
            posX10: 200,
            sideX10: 500,
            stressBps: 10,
            entryDeadbandBps: 0,
            borrowRateX10: 0,
            opensPaused: true, // must be ignored
            retired: true, // must be ignored
            lastPx18: 123 // must be ignored
        });
    }

    function _launchCurve() internal pure returns (ImpactLib.Curve memory) {
        return ImpactLib.Curve({
            baseRateBps: 1000,
            rateMultiplier: 15_000,
            referenceNotionalUsd: 20_000e6,
            positionMultiplierE6: 130_000_000e6
        });
    }

    function _setPx(uint32 asset, uint64 raw) internal {
        source.setQuote(asset, raw, raw, raw);
    }

    /// @dev Book (bid = ask = mark) and oracle set apart, raw units of $1e-6 (szDecimals 0).
    function _setQuotes(uint32 asset, uint64 book, uint64 oraclePx) internal {
        source.setQuote(asset, book, book, book, oraclePx);
    }

    function _fund(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(ex), type(uint256).max);
        ex.deposit(amount);
        vm.stopPrank();
    }

    /// @dev The owner adds `amount` of fresh house money.
    function _depositHouse(uint256 amount) internal {
        usdc.mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(ex), amount);
        ex.depositHouse(amount);
        vm.stopPrank();
    }

    /// @dev The owner takes every dollar of free house cash out (pushing earned fees first, as
    ///      `withdrawHouse` does), so the next win finds an empty house and queues.
    function _drainHouse() internal {
        uint256 free = ex.houseFreeUsdc();
        if (free == 0) return;
        vm.prank(owner);
        ex.withdrawHouse(free);
    }

    /// @dev Move into the keeper window of a request filed right now.
    function _tick() internal {
        vm.warp(vm.getBlockTimestamp() + DELAY);
    }

    function _requestOpen(address user, uint32 id, bool isLong, uint128 margin, uint32 lev)
        internal
        returns (uint256 requestId)
    {
        vm.prank(user);
        return ex.requestOpen(id, isLong, margin, lev, address(0));
    }

    /// @dev The keeper fills a request filed right now in its first eligible second.
    function _executeOpen(uint256 requestId) internal returns (uint256 positionId) {
        _tick();
        vm.prank(keeper);
        positionId = ex.executeOpen(requestId);
        assertGt(positionId, 0, "open request refunded");
    }

    /// @dev Request as `user`, keeper fills. A tripped breaker is cleared by the owner first so
    ///      a scenario can keep opening positions.
    function _open(address user, uint32 id, bool isLong, uint128 margin, uint32 lev) internal returns (uint256) {
        if (ex.breakerTripped()) {
            vm.prank(owner);
            ex.clearBreaker();
        }
        return _executeOpen(_requestOpen(user, id, isLong, margin, lev));
    }

    function _requestClose(address user, uint256 id) internal {
        vm.prank(user);
        ex.requestClose(id);
    }

    function _executeClose(uint256 id) internal returns (uint256 payout, uint256 queued) {
        _tick();
        vm.prank(keeper);
        return ex.executeClose(id);
    }

    function _close(address user, uint256 id) internal returns (uint256 payout, uint256 queued) {
        _requestClose(user, id);
        return _executeClose(id);
    }

    /// @dev The exchange's USDC balance must always equal every claim on it: available
    ///      balances, open margins, pending request margins and the house cash; and the free
    ///      house cash is what is left of it after the queue and the fee pool.
    function _assertSolvent() internal view {
        address[8] memory users = [alice, bob, carol, dave, liquidator, feeRecipient, stranger, owner];
        uint256 claims = ex.lpBalance();
        for (uint256 i = 0; i < users.length; i++) {
            claims += ex.balanceOf(users[i]) + ex.marginInUse(users[i]) + ex.pendingOf(users[i]);
        }
        assertEq(usdc.balanceOf(address(ex)), claims, "insolvent");
        uint256 owed = ex.queuedTotal() + ex.feePool();
        uint256 lp = ex.lpBalance();
        assertEq(ex.houseFreeUsdc(), lp > owed ? lp - owed : 0, "free cash");
    }

    /// @dev Net house outflow booked in the current breaker window.
    function _windowNet() internal view returns (int256 net) {
        (,, net) = ex.breakerWindow();
    }

    /// @dev `previewClose` must say exactly what the keeper's close pays: requests the close of
    ///      `id` as `user`, lets the keeper fill it, checks the returned payout and the
    ///      `PositionClosed` event (price, pnl, fee, payout) against the preview taken just
    ///      before, and returns the settled figures.
    function _closeMatchesPreview(address user, uint256 id, uint256 expectedExitPx18)
        internal
        returns (int256 pnl, uint256 fee, uint256 paid)
    {
        uint256 payout;
        (pnl, fee, payout) = ex.previewClose(id);
        _requestClose(user, id);
        _tick();
        vm.recordLogs();
        vm.prank(keeper);
        uint256 queued;
        (paid, queued) = ex.executeClose(id);
        assertEq(paid, payout, "close paid != preview");
        assertEq(queued, 0, "queued");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(ex) || logs[i].topics[0] != POSITION_CLOSED_TOPIC) continue;
            (uint256 exitPx18, int256 ePnl, uint256 eFee, uint256 ePayout,,,) =
                abi.decode(logs[i].data, (uint256, int256, uint256, uint256, uint256, uint256, bool));
            assertEq(exitPx18, expectedExitPx18, "exit price");
            assertEq(ePnl, pnl, "event pnl != preview");
            assertEq(eFee, fee, "event fee != preview");
            assertEq(ePayout, payout, "event payout != preview");
            return (pnl, fee, paid);
        }
        revert("PositionClosed not emitted");
    }

    function _oob(IExchangeTypes.Param p, uint256 v) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IExchangeTypes.ParamOutOfBounds.selector, p, v);
    }

    function _unauthorized(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", who);
    }
}
