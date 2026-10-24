// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {ConfettiDeployer, LaunchMarkets} from "../../script/Deploy.s.sol";
import {Staking} from "../../src/Staking.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {Exchange} from "../../src/Exchange.sol";
import {ExchangeExt} from "../../src/ExchangeExt.sol";
import {Referrals} from "../../src/Referrals.sol";
import {MarketRules} from "../../src/MarketRules.sol";
import {SessionRouter} from "../../src/SessionRouter.sol";
import {ISessionRouter} from "../../src/interfaces/ISessionRouter.sol";
import {ImpactLib} from "../../src/lib/ImpactLib.sol";
import {IExchange} from "../../src/interfaces/IExchange.sol";
import {IExchangeTypes} from "../../src/interfaces/IExchangeTypes.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {IReferrals} from "../../src/interfaces/IReferrals.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockFetti} from "../mocks/MockFetti.sol";
import {MockPriceSource} from "../mocks/MockPriceSource.sol";

/*//////////////////////////////////////////////////////////////////////////
                                  fixture
//////////////////////////////////////////////////////////////////////////*/

/// @dev The whole v4 system, deployed through the same `ConfettiDeployer` steps as mainnet,
///      with a mock USDC, a mock FETTI (the existing token) and a mock feed quoting every launch market. This
///      contract is the deployer and keeps ownership (owner = address(this); guardian, market keeper,
///      fill keeper and fee recipient are separate addresses so a mix-up shows). setUp opens every
///      market and puts `HOUSE` of house money in, since v4 sizes every open from free house
///      cash. Opens and closes go through the request / keeper-fill path: `_open` and `_close`
///      request, step 5 s into the keeper window and execute as the fill keeper.
abstract contract IntegrationBase is Test, ConfettiDeployer {
    MockUSDC usdc;
    MockPriceSource source;
    /// @dev The existing FETTI token (mock): v4 deploys none and never mints it.
    MockFetti confetti;
    /// @dev FETTI the test minted (FETTI arriving from outside v4): its whole supply.
    uint256 fettiMinted;
    Staking staking;
    PriceOracle oracle;
    ExchangeExt ext;
    /// @dev The core, for the Ownable2Step surface; everything else goes through `ex`.
    Exchange core;
    IExchange ex;
    Referrals refs;
    MarketRules rules;
    SessionRouter router;
    uint256[] launchPrices18;

    address guardian = makeAddr("guardian");
    address marketKeeper = makeAddr("marketKeeper");
    address keeper = makeAddr("keeper");
    address feeRecipient = makeAddr("feeRecipient");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address liquidator = makeAddr("liquidator");
    address[] traders;
    /// @dev Everyone who can hold an exchange balance besides the fee recipient.
    address[] actors;

    uint256 constant FUNDING = 10_000e6;
    /// @dev House money the owner deposits in setUp.
    uint256 constant HOUSE = 10_000e6;
    /// @dev The default request windows.
    uint256 constant DELAY = 5;
    uint256 constant GRACE = 3;
    uint256 constant EXPIRY = 60;

    // Instrument ids in LaunchMarkets order.
    uint32 constant DOGE = 0;
    uint32 constant FARTCOIN = 1;
    uint32 constant VIRTUAL = 2;
    uint32 constant WIF = 3;
    uint32 constant MELANIA = 4;
    uint32 constant KFLOKI = 5;
    uint32 constant PENGU = 6;
    uint32 constant PEOPLE = 7;
    uint32 constant TRUMP = 8;
    uint32 constant KPEPE = 9;
    uint32 constant BTC = 10;
    uint32 constant ETH = 11;

    /// @dev Raw launch quotes (10^(6 - szDecimals) implied decimals): DOGE $0.085, FARTCOIN
    ///      $0.164, VIRTUAL $1.20, WIF $0.45, MELANIA $0.20, kFLOKI $0.06, PENGU $0.02,
    ///      PEOPLE $0.015, TRUMP $8.00, kPEPE $0.007, BTC $100,000 (szDecimals 5: x10 =
    ///      1,000,000), ETH $4,000 (szDecimals 4: x100 = 400,000).
    uint64[12] rawLaunch =
        [85_000, 16_400, 120_000, 450_000, 20_000, 60_000, 20_000, 15_000, 800_000, 7_000, 1_000_000, 400_000];

    function setUp() public virtual {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        source = new MockPriceSource();
        confetti = new MockFetti();
        LaunchMarkets.Market[] memory ms = LaunchMarkets.all();
        for (uint256 i = 0; i < ms.length; i++) {
            source.setQuote(ms[i].hlAssetIndex, rawLaunch[i], rawLaunch[i], rawLaunch[i]);
        }

        Deployment memory d = _deploy(_config(address(this)), address(this));
        assertEq(address(d.fetti), address(confetti));
        staking = d.staking;
        oracle = d.oracle;
        ext = d.ext;
        core = d.exchange;
        ex = IExchange(address(d.exchange));
        refs = d.referrals;
        rules = d.rules;
        router = d.router;
        launchPrices18 = d.launchPrices18;
        _launch(ex);
        _depositHouse(HOUSE);

        traders = [alice, bob, carol, dave];
        actors = [alice, bob, carol, dave, liquidator];
        for (uint256 i = 0; i < traders.length; i++) {
            _fund(traders[i], FUNDING);
        }
    }

    // ------------------------------------------------------------- deploying

    /// @dev What the owner does after the deploy and the pre-open check: unpause every market.
    function _launch(IExchange e) internal {
        for (uint32 i = 0; i < e.instrumentCount(); i++) {
            e.setMarketOpensPaused(i, false);
        }
    }

    function _config(address owner) internal view virtual returns (Config memory cfg) {
        cfg.usdc = address(usdc);
        cfg.owner = owner;
        cfg.guardian = guardian;
        cfg.marketKeeper = marketKeeper;
        cfg.keeper = keeper;
        cfg.feeRecipient = feeRecipient;
        cfg.priceSource = address(source);
        cfg.launchPrices18 = new uint256[](0);
        cfg.stakerFeeShareBps = DEFAULT_STAKER_FEE_SHARE_BPS;
        cfg.stakingWarmupS = DEFAULT_STAKING_WARMUP_S;
        cfg.winFeeBps = DEFAULT_WIN_FEE_BPS;
        cfg.lossFeeBps = DEFAULT_LOSS_FEE_BPS;
        cfg.rhoBps = DEFAULT_RHO_BPS;
        cfg.maxWinBps = DEFAULT_MAX_WIN_BPS;
        cfg.fetti = address(confetti);
        cfg.v3Referrals = address(0);
    }

    /// @dev External wrapper so a test can `expectRevert` a deploy. The caller is this contract.
    function deployExternal(Config memory cfg) external returns (Deployment memory) {
        return _deploy(cfg, address(this));
    }

    // ------------------------------------------------------------------ feed

    function _asset(uint32 id) internal view returns (uint32) {
        return ex.instrument(id).hlAssetIndex;
    }

    function _raw(uint32 id) internal view returns (uint64 bid) {
        (bid,,,) = source.quotes(_asset(id));
    }

    function _setRaw(uint32 id, uint64 raw) internal {
        source.setQuote(_asset(id), raw, raw, raw);
    }

    /// @dev Move a market's quote (bid = ask = mark = oracle) by `bps`, truncating to whole raw
    ///      units.
    function _moveBps(uint32 id, int256 bps) internal {
        int256 raw = int256(uint256(_raw(id)));
        _setRaw(id, uint64(uint256(raw * (10_000 + bps) / 10_000)));
    }

    // ----------------------------------------------------------------- money

    function _fund(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(ex), type(uint256).max);
        ex.deposit(amount);
        vm.stopPrank();
    }

    /// @dev The owner (this contract) puts `amount` of fresh USDC into house cash.
    function _depositHouse(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(ex), amount);
        ex.depositHouse(amount);
    }

    /// @dev `who` receives `amount` FETTI from outside v4 (a v3 mint or a pool buy).
    function _fetti(address who, uint256 amount) internal {
        confetti.mint(who, amount);
        fettiMinted += amount;
    }

    /// @dev Stake FETTI `who` already holds; it warms for `minStakeDuration`.
    function _stake(address who, uint256 amount) internal {
        vm.startPrank(who);
        confetti.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    /// @dev Give FETTI, stake, wait out the warm-up and activate, so the stake earns from now on.
    function _stakeActive(address who, uint256 amount) internal {
        _fetti(who, amount);
        _stake(who, amount);
        vm.warp(vm.getBlockTimestamp() + staking.minStakeDuration());
        staking.activate(who);
    }

    /// @dev The v3 arithmetic several scenarios are written in: a 5% fee carved from losses
    ///      (launch: 0) and no entry spread on DOGE (launch: 1 bps), so a 2% DOGE loss on
    ///      100 x 10 from the launch quote is exactly $20 with a $1 fee.
    function _classicFees() internal {
        ex.setFeeBps(750, 500);
        ex.setMarketFees(DOGE, 0, ex.instrument(DOGE).borrowRateX10);
    }

    // --------------------------------------------------------------- trading

    /// @dev Into the keeper window of a request filed right now.
    function _tick() internal {
        vm.warp(vm.getBlockTimestamp() + DELAY);
    }

    /// @dev Request as `user` and let the keeper fill in its first eligible second. A tripped
    ///      breaker is cleared first (owner only in v4) so a scenario can keep opening.
    function _open(address user, uint32 id, bool isLong, uint128 margin, uint32 lev) internal returns (uint256) {
        return _openReferred(user, id, isLong, margin, lev, address(0));
    }

    function _openReferred(address user, uint32 id, bool isLong, uint128 margin, uint32 lev, address referrer)
        internal
        returns (uint256 positionId)
    {
        if (ex.breakerTripped()) ex.clearBreaker();
        vm.prank(user);
        uint256 req = ex.requestOpen(id, isLong, margin, lev, referrer);
        _tick();
        vm.prank(keeper);
        positionId = ex.executeOpen(req);
        assertGt(positionId, 0, "open request refunded");
    }

    /// @dev File a close as `user` and step into the keeper window; the caller executes.
    function _requestAndTick(address user, uint256 id) internal {
        vm.prank(user);
        ex.requestClose(id);
        _tick();
    }

    function _close(address user, uint256 id) internal returns (uint256 paid, uint256 queued) {
        _requestAndTick(user, id);
        vm.prank(keeper);
        (paid, queued) = ex.executeClose(id);
    }

    function _liquidate(address by, uint256 id) internal returns (uint256 bounty) {
        vm.prank(by);
        bounty = ex.liquidate(id);
    }

    function _queueEmpty() internal view returns (bool) {
        return ex.queueHead() == ex.queueLength();
    }

    // ---------------------------------------------------------- expectations

    function _curve(IExchangeTypes.Instrument memory inst) internal pure returns (ImpactLib.Curve memory) {
        return ImpactLib.Curve({
            baseRateBps: inst.baseRateBps,
            rateMultiplier: inst.rateMultiplier,
            referenceNotionalUsd: inst.referenceNotionalUsd,
            positionMultiplierE6: inst.positionMultiplierE6
        });
    }

    /// @dev What a winning close of `posId` settles to at the current oracle price (the
    ///      keeper's fill), on the terms stamped at open (entry after the spread, deadband,
    ///      maximum profit, win fee); only the impact curve is the market's live one.
    function _expectWin(uint256 posId) internal view returns (uint256 adjusted, uint256 fee, uint256 profit) {
        IExchangeTypes.Position memory pos = ex.positions(posId);
        IExchangeTypes.Instrument memory inst = ex.instrument(pos.instrumentId);
        uint256 exit =
            ImpactLib.deadbandExit(ex.execPrice(pos.instrumentId, pos.isLong, false), pos.isLong, pos.deadbandBps);
        (uint256 gain, uint256 move) =
            ImpactLib.rawGain(uint256(pos.marginUsdc) * pos.leverage, pos.entryPx18, exit, pos.isLong);
        adjusted = ImpactLib.adjustedGain(gain, move, _curve(inst));
        if (adjusted > pos.maxProfitUsdc) adjusted = pos.maxProfitUsdc;
        fee = ImpactLib.winFee(adjusted, pos.winFeeBps);
        profit = adjusted - fee;
    }

    /// @dev Raise market `id` from its launch quote one bp at a time from `fromBps` until the
    ///      long `posId` would close with an adjusted gain above `above`, and return that gain.
    ///      A step moves $10,000 of notional by $1 of raw gain, less after the impact curve, so
    ///      the gain lands within $1 above `above`.
    function _winAbove(uint256 posId, uint32 id, int256 fromBps, uint256 above) internal returns (uint256 adjusted) {
        int256 launch = int256(uint256(rawLaunch[id]));
        for (int256 bps = fromBps;; bps++) {
            _setRaw(id, uint64(uint256(launch * (10_000 + bps) / 10_000)));
            (adjusted,,) = _expectWin(posId);
            if (bps == fromBps) assertLe(adjusted, above, "search starts below the target");
            if (adjusted > above) return adjusted;
        }
    }

    /// @dev What a losing close of `posId` settles to: capped loss, fee (the position's stamped
    ///      loss rate, only while the queue is empty) and what the house keeps.
    function _expectLoss(uint256 posId) internal view returns (uint256 loss, uint256 fee, uint256 lpGain) {
        IExchangeTypes.Position memory pos = ex.positions(posId);
        loss = ImpactLib.cappedLoss(
            uint256(pos.marginUsdc) * pos.leverage,
            pos.marginUsdc,
            pos.entryPx18,
            ex.execPrice(pos.instrumentId, pos.isLong, false),
            pos.isLong
        );
        (fee, lpGain) = ImpactLib.splitLoss(loss, _queueEmpty() ? pos.lossFeeBps : 0);
    }

    // ----------------------------------------------------------- invariants

    /// @dev The accounting identities that must hold after every action:
    ///        1. Exchange cash == available balances + open margins + pending request margins
    ///           + house cash (the fee pool and the queue are claims on house cash);
    ///        2. no USDC leaks: every unit minted is in a wallet (the owner's included, where
    ///           house withdrawals land), the Exchange or Staking;
    ///        3. FETTI supply is only what came from outside v4 (v4 never mints or burns it),
    ///           and Staking holds exactly the stake.
    function _assertConserved() internal view {
        uint256 claims =
            ex.lpBalance() + ex.balanceOf(feeRecipient) + ex.marginInUse(feeRecipient) + ex.pendingOf(feeRecipient);
        uint256 wallets = usdc.balanceOf(feeRecipient) + usdc.balanceOf(address(this));
        for (uint256 i = 0; i < actors.length; i++) {
            claims += ex.balanceOf(actors[i]) + ex.marginInUse(actors[i]) + ex.pendingOf(actors[i]);
            wallets += usdc.balanceOf(actors[i]);
        }
        assertEq(usdc.balanceOf(address(ex)), claims, "exchange cash != buckets");
        assertEq(
            usdc.totalSupply(), usdc.balanceOf(address(ex)) + usdc.balanceOf(address(staking)) + wallets, "usdc leaked"
        );
        assertEq(confetti.totalSupply(), fettiMinted, "fetti supply moved inside v4");
        assertEq(confetti.balanceOf(address(staking)), staking.totalStake(), "staking fetti != stake");
    }
}

/*//////////////////////////////////////////////////////////////////////////
                               scenarios
//////////////////////////////////////////////////////////////////////////*/

contract IntegrationTest is IntegrationBase {
    // ---------------------------------------------------------------- deploy

    function test_deploy_wiresEverything_andAddsLaunchMarkets() public view {
        assertEq(oracle.registrar(), address(ex));
        assertEq(oracle.source(), address(source));
        assertEq(oracle.owner(), address(this));

        // FETTI: the existing token; the deploy creates none and holds no role on it.
        assertEq(confetti.totalSupply(), 0);

        assertEq(staking.confetti(), address(confetti));
        assertEq(staking.usdc(), address(usdc));
        assertEq(staking.owner(), address(this));
        assertEq(staking.minStakeDuration(), DEFAULT_STAKING_WARMUP_S);
        assertEq(staking.minStakeDuration(), 1 hours);

        // The core and the extension: built on the same three immutables, the core points at it
        // for good.
        assertEq(ex.usdc(), address(usdc));
        assertEq(ex.oracle(), address(oracle));
        assertEq(ex.staking(), address(staking));
        assertEq(ex.extension(), address(ext));
        (address u, address o, address s) = ext.extensionImmutables();
        assertEq(u, address(usdc));
        assertEq(o, address(oracle));
        assertEq(s, address(staking));
        assertEq(ex.referrals(), address(refs));
        assertEq(refs.exchange(), address(ex));
        assertEq(refs.referralShareBps(), 1500);
        assertEq(refs.v3Referrals(), address(0));

        // Roles (M5): this suite gives owner, guardian, market keeper, fill keeper, fee recipient separate addresses.
        assertEq(ex.owner(), address(this));
        assertEq(core.pendingOwner(), address(0));
        assertEq(ex.pauseGuardian(), guardian);
        assertEq(ex.marketKeeper(), marketKeeper);
        assertTrue(ex.isKeeper(keeper));
        assertFalse(ex.isKeeper(address(this)));
        assertFalse(ex.isKeeper(marketKeeper));
        assertEq(ex.feeRecipient(), feeRecipient);

        // Launch parameters (PROFIT.md V4-2, V4-4, V4-5; S1, S2).
        assertEq(ex.stakerFeeShareBps(), 2000);
        assertEq(ex.winFeeBps(), 500);
        assertEq(ex.lossFeeBps(), 500);
        assertEq(ex.rhoBps(), 2000);
        assertEq(ex.maxWinBps(), 2500);
        assertEq(ex.minMarginUsdc(), 5e6);
        assertEq(ex.borrowFreeHours(), 1);
        assertEq(ex.breakerBps(), 2500);
        assertEq(ex.breakerFloorUsdc(), 0);
        assertEq(ex.minDelay(), 5);
        assertEq(ex.grace(), 3);
        assertEq(ex.expiry(), 60);
        assertEq(ex.maxJumpBps(), 1000);

        // The modules the core created.
        assertEq(ex.sessionRouter(), address(router));
        assertEq(address(router.exchange()), address(ex));
        assertEq(ex.marketRules(), address(rules));
        assertGt(address(rules).code.length, 0);

        // House money: only what setUp deposited; nothing owed, nothing open.
        assertEq(ex.lpBalance(), HOUSE);
        assertEq(ex.houseFreeUsdc(), HOUSE);
        assertEq(ex.feePool(), 0);
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.openMaxPayoutUsdc(), 0);
        assertEq(ex.houseExposureUsdc(), 0);

        LaunchMarkets.Market[] memory ms = LaunchMarkets.all();
        assertEq(ex.instrumentCount(), uint32(ms.length));
        assertEq(launchPrices18.length, ms.length);
        // Static caps (now ceilings), in id order: OI a side, then max notional = min($1M, OI).
        uint128[12] memory oiCap = [
            uint128(10_000_000e6), // DOGE
            150_000e6, // FARTCOIN
            1_000_000e6, // VIRTUAL
            500_000e6, // WIF
            150_000e6, // MELANIA
            150_000e6, // kFLOKI
            2_000_000e6, // PENGU
            150_000e6, // PEOPLE
            500_000e6, // TRUMP
            500_000e6, // kPEPE
            10_000_000e6, // BTC
            10_000_000e6 // ETH
        ];
        for (uint256 i = 0; i < ms.length; i++) {
            uint32 id = uint32(i);
            IExchangeTypes.Instrument memory inst = ex.instrument(id);
            assertEq(inst.hlAssetIndex, ms[i].hlAssetIndex, ms[i].name);
            assertEq(inst.szDecimals, ms[i].szDecimals, ms[i].name);
            assertEq(inst.tier, ms[i].tier, ms[i].name);
            // Per-coin leverage from the table: 1000x on tier A, 250x on TRUMP and kPEPE.
            assertEq(inst.maxLeverage, ms[i].maxLeverage, ms[i].name);
            assertEq(inst.maxLeverage, ms[i].tier == 0 ? 1000 : 250, ms[i].name);
            assertEq(inst.deadbandBps, LaunchMarkets.marketDeadbandBps(ms[i]), ms[i].name);
            // Tier A's 1 bps, except the three coins whose oracle still carries the book's lead
            // at the fill (3 bps); tier B's 3.
            if (id == WIF || id == MELANIA || id == PEOPLE) assertEq(inst.deadbandBps, 3, ms[i].name);
            else assertEq(inst.deadbandBps, ms[i].tier == 0 ? 1 : 3, ms[i].name);
            assertEq(inst.clampBps, LaunchMarkets.clampBps(ms[i].tier));
            assertEq(inst.baseRateBps, 1000);
            assertEq(inst.rateMultiplier, 15_000);
            assertEq(inst.referenceNotionalUsd, 20_000e6);
            assertEq(inst.positionMultiplierE6, LAUNCH_POSITION_MULTIPLIER_E6);
            assertEq(inst.longOiCapUsd, oiCap[i], ms[i].name);
            assertEq(inst.shortOiCapUsd, oiCap[i], ms[i].name);
            assertEq(inst.longOiCapUsd, ms[i].oiCapUsd, ms[i].name);
            assertEq(inst.maxNotionalUsd, ms[i].maxNotionalUsd, ms[i].name);
            assertEq(inst.maxNotionalUsd, oiCap[i] < 1_000_000e6 ? oiCap[i] : 1_000_000e6, ms[i].name);
            assertEq(inst.payoutCapX, 50);
            // House-sized limits: a position 5x free cash, a side 10x; stress 10% on memes and
            // 5% on BTC / ETH.
            assertEq(inst.posX10, 50);
            assertEq(inst.sideX10, 100);
            assertEq(inst.stressBps, id == BTC || id == ETH ? 500 : 1000, ms[i].name);
            // Entry spread = the market's deadband; borrow 0.5 bps an hour.
            assertEq(inst.entryDeadbandBps, inst.deadbandBps, ms[i].name);
            assertEq(inst.borrowRateX10, 5);
            assertFalse(inst.opensPaused);
            assertFalse(inst.retired);
            assertEq(inst.lastPx18, 0);
            // The clamp only shapes the oracle's display price; the table keeps tier A's band
            // (5 bps) at the 1000x bust move (5 bps), tier B's (25) under 35.
            uint256 bustMoveBps = 9_500 / inst.maxLeverage; // 0.95 / leverage in bps ...
            uint256 gapped = 10_000 / inst.maxLeverage - 5; // ... or 1 / leverage - 5 bps
            if (gapped < bustMoveBps) bustMoveBps = gapped;
            assertLe(inst.clampBps, bustMoveBps, "clamp band past the bust move");

            (uint32 idx, uint8 sz, uint16 clamp) = oracle.instrumentConfig(id);
            assertEq(idx, ms[i].hlAssetIndex);
            assertEq(sz, ms[i].szDecimals);
            assertEq(clamp, inst.clampBps);

            uint256 expected18 = uint256(rawLaunch[i]) * 10 ** (12 + uint256(sz));
            assertEq(oracle.price(id), expected18, ms[i].name);
            assertEq(oracle.oraclePrice(id), expected18, ms[i].name);
            assertEq(ex.execPrice(id, true, true), expected18, ms[i].name);
            assertEq(launchPrices18[i], expected18, ms[i].name);

            // The curve keeps about 88% at a 1% move and 74% at 0.1% on every market.
            assertApproxEqRel(ImpactLib.impactScaleE18(1e16, _curve(inst)), 0.8806e18, 0.001e18);
            assertApproxEqRel(ImpactLib.impactScaleE18(1e15, _curve(inst)), 0.7374e18, 0.001e18);
        }
        assertFalse(ex.breakerTripped());
        _assertConserved();
    }

    function test_deploy_handOverIsTwoStep() public {
        address newOwner = makeAddr("newOwner");
        Deployment memory d = _deploy(_config(newOwner), address(this));
        IExchange dex = IExchange(address(d.exchange));

        // Markets were added (paused) before the handover; the deployer still owns the three
        // owned contracts, newOwner is pending on each. FETTI is the existing token: untouched.
        assertEq(dex.instrumentCount(), uint32(LaunchMarkets.COUNT));
        for (uint32 i = 0; i < LaunchMarkets.COUNT; i++) {
            assertTrue(dex.instrument(i).opensPaused);
        }
        assertEq(d.staking.owner(), address(this));
        assertEq(d.oracle.owner(), address(this));
        assertEq(d.exchange.owner(), address(this));
        assertEq(d.staking.pendingOwner(), newOwner);
        assertEq(d.oracle.pendingOwner(), newOwner);
        assertEq(d.exchange.pendingOwner(), newOwner);
        // The referral registry has no owner of its own: the Exchange is its only writer.
        assertEq(d.referrals.exchange(), address(d.exchange));

        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        dex.setFeeRecipient(newOwner);

        vm.startPrank(newOwner);
        d.staking.acceptOwnership();
        d.oracle.acceptOwnership();
        d.exchange.acceptOwnership();
        vm.stopPrank();

        assertEq(d.staking.owner(), newOwner);
        assertEq(d.oracle.owner(), newOwner);
        assertEq(d.exchange.owner(), newOwner);
        assertEq(dex.owner(), newOwner);
        assertEq(d.exchange.pendingOwner(), address(0));

        // The deployer is locked out of every admin surface, house money and the referral
        // share included.
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        vm.expectRevert(notOwner);
        d.oracle.setRegistrar(address(this));
        vm.expectRevert(notOwner);
        d.staking.setMinStakeDuration(2 hours);
        vm.expectRevert(notOwner);
        dex.setKeepers(address(this), address(this));
        vm.expectRevert(notOwner);
        dex.setReferralShare(0);
        vm.expectRevert(notOwner);
        dex.depositHouse(1);
        vm.expectRevert(notOwner);
        dex.withdrawHouse(1);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        dex.setMarketOpensPaused(DOGE, false);
        vm.expectRevert(IReferrals.NotExchange.selector);
        d.referrals.setShareBps(0);
    }

    /// @dev M5 at launch: the deploy refuses a zero role and a fill keeper that is the owner;
    ///      the launch wiring (the owner wallet deploys and is also guardian, market keeper and
    ///      fee recipient, the fill keeper its own wallet) deploys with no hand-over pending.
    function test_deploy_rolesSet_keeperNotOwner() public {
        Config memory cfg = _config(address(this));
        cfg.guardian = address(0);
        vm.expectRevert(RoleUnset.selector);
        this.deployExternal(cfg);

        cfg = _config(address(this));
        cfg.feeRecipient = address(0);
        vm.expectRevert(RoleUnset.selector);
        this.deployExternal(cfg);

        cfg = _config(address(this));
        cfg.keeper = address(0);
        vm.expectRevert(RoleUnset.selector);
        this.deployExternal(cfg);

        cfg = _config(address(this));
        cfg.keeper = address(this);
        vm.expectRevert(KeeperIsOwner.selector);
        this.deployExternal(cfg);

        cfg = _config(address(this));
        cfg.guardian = address(this);
        cfg.marketKeeper = address(this);
        cfg.feeRecipient = address(this);
        Deployment memory d = this.deployExternal(cfg);
        IExchange dex = IExchange(address(d.exchange));
        assertEq(d.exchange.owner(), address(this));
        assertEq(d.staking.owner(), address(this));
        assertEq(d.oracle.owner(), address(this));
        assertEq(d.exchange.pendingOwner(), address(0));
        assertEq(dex.pauseGuardian(), address(this));
        assertEq(dex.marketKeeper(), address(this));
        assertEq(dex.feeRecipient(), address(this));
        assertTrue(dex.isKeeper(keeper));
        assertFalse(dex.isKeeper(address(this)));

        // One wallet in every owner-side role: it pauses and resumes, moves caps, and the fill
        // keeper still cannot touch any of it.
        dex.setGlobalOpensPaused(true);
        dex.setGlobalOpensPaused(false);
        dex.setMarketOpensPaused(DOGE, false);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        dex.setGlobalOpensPaused(true);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        dex.setFeeRecipient(keeper);
    }

    function test_deploy_launchPricesFromEnv_orFeed_andRejectsBadOnes() public {
        Config memory cfg = _config(address(this));

        cfg.launchPrices18 = new uint256[](3);
        vm.expectRevert(abi.encodeWithSelector(LaunchPriceCountMismatch.selector, 3, LaunchMarkets.COUNT));
        this.deployExternal(cfg);

        cfg.launchPrices18 = new uint256[](LaunchMarkets.COUNT);
        for (uint256 i = 0; i < cfg.launchPrices18.length; i++) {
            cfg.launchPrices18[i] = 1e18;
        }
        cfg.launchPrices18[1] = 0;
        vm.expectRevert(abi.encodeWithSelector(LaunchPriceZero.selector, uint32(165)));
        this.deployExternal(cfg);

        // Explicit prices bypass the feed entirely: a dead DOGE quote does not matter.
        source.setQuote(12, 0, 0, 0);
        cfg.launchPrices18[1] = 1e18;
        Deployment memory d = this.deployExternal(cfg);
        assertEq(d.launchPrices18[0], 1e18);
        assertEq(IExchange(address(d.exchange)).instrumentCount(), uint32(LaunchMarkets.COUNT));

        // Reading from the feed with that dead quote aborts on DOGE (index 12).
        cfg.launchPrices18 = new uint256[](0);
        vm.expectRevert(abi.encodeWithSelector(LaunchPriceZero.selector, uint32(12)));
        this.deployExternal(cfg);
    }

    /// @dev The contracts a deploy creates, and nothing else: Staking, PriceOracle,
    ///      the ExchangeExt, the Exchange core (whose constructor creates Referrals,
    ///      MarketRules and SessionRouter) and the core's DepositProxyFactory; plus the
    ///      PrecompilePriceSource when no price source is given. The core is bound to that
    ///      extension for good and the extension refuses direct calls. No token is created and
    ///      the deploy writes nothing on FETTI.
    function test_deploy_createsExactlyTheSystem_extensionIncluded() public {
        vm.startStateDiffRecording();
        Deployment memory d = _deploy(_config(address(this)), address(this));
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        address[] memory expected = new address[](8);
        expected[0] = address(d.staking);
        expected[1] = address(d.oracle);
        expected[2] = address(d.ext);
        expected[3] = address(d.exchange);
        expected[4] = address(d.referrals);
        expected[5] = address(d.rules);
        expected[6] = address(d.router);
        expected[7] = address(d.depositFactory);
        _assertCreatesExactly(accesses, expected);
        _assertNoWrites(accesses, address(confetti));
        assertEq(address(d.fetti), address(confetti));
        assertEq(d.staking.confetti(), address(confetti));
        assertEq(address(d.source), address(source));

        IExchange dex = IExchange(address(d.exchange));
        assertEq(dex.extension(), address(d.ext));
        assertEq(dex.referrals(), address(d.referrals));
        assertEq(dex.marketRules(), address(d.rules));
        assertEq(dex.sessionRouter(), address(d.router));
        assertEq(address(d.depositFactory.exchange()), address(d.exchange));
        assertTrue(address(d.ext) != address(ext), "a fresh extension per deploy");
        vm.expectRevert(IExchangeTypes.DirectCall.selector);
        d.ext.depositHouse(1);
        vm.expectRevert(IExchangeTypes.DirectCall.selector);
        d.ext.setFeeBps(0, 0);

        // No price source given: the deploy creates a PrecompilePriceSource too (the launch
        // prices come from the config, since the test chain has no precompile).
        Config memory cfg = _config(address(this));
        cfg.priceSource = address(0);
        cfg.launchPrices18 = new uint256[](LaunchMarkets.COUNT);
        for (uint256 i = 0; i < LaunchMarkets.COUNT; i++) {
            cfg.launchPrices18[i] = launchPrices18[i];
        }
        vm.startStateDiffRecording();
        d = _deploy(cfg, address(this));
        accesses = vm.stopAndReturnStateDiff();
        address[] memory withSource = new address[](9);
        withSource[0] = address(d.source);
        withSource[1] = address(d.staking);
        withSource[2] = address(d.oracle);
        withSource[3] = address(d.ext);
        withSource[4] = address(d.exchange);
        withSource[5] = address(d.referrals);
        withSource[6] = address(d.rules);
        withSource[7] = address(d.router);
        withSource[8] = address(d.depositFactory);
        _assertCreatesExactly(accesses, withSource);
        assertEq(d.oracle.source(), address(d.source));

        // A FETTI address with no code (wrong address or wrong chain) is refused.
        cfg = _config(address(this));
        cfg.fetti = makeAddr("notFetti");
        vm.expectRevert(abi.encodeWithSelector(FettiNotAContract.selector, cfg.fetti));
        this.deployExternal(cfg);
    }

    /// @dev No storage write on `account` anywhere in `accesses`.
    function _assertNoWrites(Vm.AccountAccess[] memory accesses, address account) internal pure {
        for (uint256 i = 0; i < accesses.length; i++) {
            Vm.StorageAccess[] memory s = accesses[i].storageAccesses;
            for (uint256 j = 0; j < s.length; j++) {
                if (s[j].account == account) assertFalse(s[j].isWrite, "deploy wrote on FETTI");
            }
        }
    }

    /// @dev Every create in `accesses` is one of `expected`, each exactly once.
    function _assertCreatesExactly(Vm.AccountAccess[] memory accesses, address[] memory expected) internal view {
        bool[] memory seen = new bool[](expected.length);
        uint256 creates;
        for (uint256 i = 0; i < accesses.length; i++) {
            if (accesses[i].kind != VmSafe.AccountAccessKind.Create) continue;
            creates++;
            bool known;
            for (uint256 j = 0; j < expected.length; j++) {
                if (accesses[i].account != expected[j]) continue;
                assertFalse(seen[j], "created twice");
                seen[j] = true;
                known = true;
            }
            assertTrue(known, "created something outside the system");
            assertGt(accesses[i].account.code.length, 0, "created without code");
        }
        assertEq(creates, expected.length, "number of contracts created");
    }

    /// @dev Not upgradeable, not re-pointable: a core refuses an extension built on other
    ///      immutables (a different Staking here) and a zero extension.
    function test_deploy_coreRefusesAForeignExtension() public {
        ExchangeExt foreign =
            new ExchangeExt(IERC20(address(usdc)), oracle, IStaking(makeAddr("otherStaking")), address(this));
        vm.expectRevert(IExchangeTypes.ExtensionMismatch.selector);
        new Exchange(
            IERC20(address(usdc)),
            oracle,
            IStaking(address(staking)),
            foreign,
            IReferrals(address(0)),
            address(this),
            feeRecipient
        );
        vm.expectRevert(IExchangeTypes.ZeroAddress.selector);
        new Exchange(
            IERC20(address(usdc)),
            oracle,
            IStaking(address(staking)),
            ExchangeExt(address(0)),
            IReferrals(address(0)),
            address(this),
            feeRecipient
        );
    }

    // ----------------------------------------------------------------- launch

    /// @dev The deploy leaves every market paused; only the owner opens them, one by one. With
    ///      no house money nothing fits (every limit is sized from free house cash, M4); once
    ///      the owner deposits, opens fill. The guardian can pause globally but never resume.
    function test_launch_marketsPausedUntilTheOwnerOpensEach_andHouseMoneySizesThem() public {
        Deployment memory d = _deploy(_config(address(this)), address(this));
        IExchange dex = IExchange(address(d.exchange));
        for (uint32 i = 0; i < dex.instrumentCount(); i++) {
            assertTrue(dex.instrument(i).opensPaused);
        }

        address outsider = makeAddr("outsider");
        usdc.mint(outsider, 100e6);
        vm.startPrank(outsider);
        usdc.approve(address(dex), 100e6);
        dex.deposit(100e6);
        vm.expectRevert(IExchangeTypes.OpensPausedForMarket.selector);
        dex.requestOpen(DOGE, true, 10e6, 10, address(0));
        vm.stopPrank();

        // Neither the guardian nor the market keeper can resume a market.
        vm.prank(guardian);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        dex.setMarketOpensPaused(DOGE, false);
        vm.prank(marketKeeper);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        dex.setMarketOpensPaused(DOGE, false);

        // Open, but no house money: no notional fits.
        dex.setMarketOpensPaused(DOGE, false);
        assertEq(dex.maxPositionUsd(DOGE, true), 0);
        vm.prank(outsider);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        dex.requestOpen(DOGE, true, 10e6, 10, address(0));

        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(dex), 1_000e6);
        dex.depositHouse(1_000e6);
        vm.prank(outsider);
        uint256 req = dex.requestOpen(DOGE, true, 10e6, 10, address(0));
        _tick();
        vm.prank(keeper);
        assertGt(dex.executeOpen(req), 0);

        // Markets the owner has not opened stay shut.
        vm.prank(outsider);
        vm.expectRevert(IExchangeTypes.OpensPausedForMarket.selector);
        dex.requestOpen(FARTCOIN, true, 10e6, 10, address(0));

        // The guardian's global pause; only the owner lifts it.
        vm.prank(guardian);
        dex.setGlobalOpensPaused(true);
        vm.prank(outsider);
        vm.expectRevert(IExchangeTypes.OpensPausedGlobally.selector);
        dex.requestOpen(DOGE, true, 10e6, 1, address(0));
        vm.prank(guardian);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        dex.setGlobalOpensPaused(false);
        dex.setGlobalOpensPaused(false);
        assertFalse(dex.globalOpensPaused());
    }

    // ------------------------------------------------------------ house money

    /// @dev M1, house money: only the owner moves it, in one transaction, at any time
    ///      (paused or not), for any amount down to what is owed. Open positions reserve
    ///      nothing; queued wins and earned fees do. A deposit made while winners wait goes to
    ///      them first, and a withdrawal pushes earned fees out before it takes anything.
    function test_house_ownerOnly_anyTime_withdrawsDownToWhatIsOwed() public {
        address[3] memory others = [alice, guardian, marketKeeper];
        for (uint256 i = 0; i < others.length; i++) {
            bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]);
            vm.prank(others[i]);
            vm.expectRevert(notOwner);
            ex.depositHouse(1);
            vm.prank(others[i]);
            vm.expectRevert(notOwner);
            ex.withdrawHouse(1);
        }
        vm.expectRevert(IExchangeTypes.ZeroAmount.selector);
        ex.depositHouse(0);
        vm.expectRevert(IExchangeTypes.ZeroAmount.selector);
        ex.withdrawHouse(0);

        // In and out with no notice, even with every opening paused; the owner's wallet gets
        // the money back at once.
        usdc.mint(address(this), 500e6);
        usdc.approve(address(ex), 500e6);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.HouseDeposited(500e6, HOUSE + 500e6);
        ex.depositHouse(500e6);
        vm.prank(guardian);
        ex.setGlobalOpensPaused(true);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.HouseWithdrawn(500e6, HOUSE);
        ex.withdrawHouse(500e6);
        assertEq(usdc.balanceOf(address(this)), 500e6);
        assertEq(ex.lpBalance(), HOUSE);
        ex.setGlobalOpensPaused(false);

        // carol's open stamps a maximum profit of min(50 x 100, 25% x 10,000) = 2,500, yet the
        // owner may still take all of the house but $50: open positions reserve nothing.
        uint256 cid = _open(carol, KPEPE, true, 100e6, 10);
        assertEq(ex.positions(cid).maxProfitUsdc, 2_500e6);
        assertEq(ex.openMaxPayoutUsdc(), 2_500e6);
        assertEq(ex.houseFreeUsdc(), HOUSE);
        ex.withdrawHouse(HOUSE - 50e6);
        assertEq(ex.lpBalance(), 50e6);

        // A 10% kPEPE win outruns the house: $50 now, the rest queued. The window opened at
        // this close on $50 of free cash, so the win also trips the breaker.
        _moveBps(KPEPE, 1000);
        (, uint256 fee, uint256 profit) = _expectWin(cid);
        assertGt(profit, 50e6);
        (uint256 paid, uint256 queued) = _close(carol, cid);
        assertEq(paid, 100e6 + 50e6);
        assertEq(queued, profit - 50e6);
        assertEq(ex.lpBalance(), 0);
        assertEq(ex.feePool(), fee);
        assertTrue(ex.breakerTripped());

        // Nothing is free while anything is owed: no withdrawal, no open.
        assertEq(ex.houseFreeUsdc(), 0);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 0, 1));
        ex.withdrawHouse(1);
        ex.clearBreaker();
        assertEq(ex.maxPositionUsd(DOGE, true), 0);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        ex.requestOpen(DOGE, true, 10e6, 1, address(0));

        // A deposit while winners wait: the queue and the pool stay owed out of it.
        _depositHouse(1_000e6);
        uint256 free = 1_000e6 - queued - fee;
        assertEq(ex.houseFreeUsdc(), free);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, free, free + 1));
        ex.withdrawHouse(free + 1);
        ex.harvest(10);
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.balanceOf(carol), FUNDING + profit);
        assertEq(ex.houseFreeUsdc(), free);

        // Earned fees leave first: 80% to the fee recipient, the stakers' 20% stays in the pool
        // (nobody staked); the rest is the owner's.
        uint256 held = fee * 2000 / 10_000;
        vm.expectEmit(address(ex));
        emit IExchangeTypes.FeesPushed(0, fee - held);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.HouseWithdrawn(free, held);
        ex.withdrawHouse(free);
        assertEq(ex.lpBalance(), held);
        assertEq(ex.feePool(), held);
        assertEq(ex.balanceOf(feeRecipient), fee - held);
        assertEq(usdc.balanceOf(address(this)), 500e6 + (HOUSE - 50e6) + free);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 0, 1));
        ex.withdrawHouse(1);
        _assertConserved();
    }

    // ---------------------------------------------------------- staker fees

    /// @dev A 2% DOGE loss on 100 x 10 from the launch quote under `_classicFees`: loss $20,
    ///      fee $1. The quote goes back afterwards so every call carves exactly $1.
    function _dogeLoss(address user) internal {
        uint256 id = _open(user, DOGE, true, 100e6, 10);
        _moveBps(DOGE, -200);
        _close(user, id);
        _setRaw(DOGE, rawLaunch[DOGE]);
    }

    /// @dev Review fix 9 under the v4 rule, with a 7-day warm-up armed (launch: 1 hour): the
    ///      stakers' part of a push is held back in the fee pool (not in Staking's carry) only
    ///      while nothing at all is staked. Share 50%; dave's loss carves $1 with nobody staked:
    ///      the push pays the recipient 0.5 and earmarks 0.5, and a second push has nothing to
    ///      move. bob stakes 300 converted FETTI and carol 100; both warm, yet the next push
    ///      hands the 0.5 to Staking at once, all of it to the warming bucket, split 300 : 100 =
    ///      0.375 / 0.125 (1.25e15 per share at 1e30, exact). Neither has earned it until the
    ///      warm-up ends; activation pays exactly that.
    function test_stakerFees_earmarkOnlyWhileNothingStaked_warmingStakeIsPaidOnActivation() public {
        _classicFees();
        staking.setMinStakeDuration(7 days);
        ex.setStakerFeeShare(5000);

        _dogeLoss(dave);
        assertEq(ex.feePool(), 1e6);
        assertEq(staking.totalStake(), 0);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 0.5e6);
        assertEq(ex.feePool(), 0.5e6);
        assertEq(staking.carryUsdc(), 0);
        assertEq(staking.totalRewardsUsdc(), 0);
        // Only the stakers' part is left and nothing is staked: nothing to push.
        vm.expectRevert(IExchangeTypes.NothingToPush.selector);
        ex.pushFees();

        _fetti(bob, 300e18);
        _fetti(carol, 100e18);
        uint256 t0 = vm.getBlockTimestamp();
        _stake(bob, 300e18);
        _stake(carol, 100e18);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.totalWarming(), 400e18);

        // Warming stake counts: the earmark leaves the pool for Staking now.
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, 0.5e6);
        assertEq(toRecipient, 0);
        assertEq(ex.feePool(), 0);
        assertEq(staking.totalRewardsUsdc(), 0.5e6);
        assertEq(staking.carryUsdc(), 0);
        assertEq(usdc.balanceOf(address(staking)), 0.5e6);
        assertEq(staking.warmingRewardOf(bob), 0.375e6);
        assertEq(staking.warmingRewardOf(carol), 0.125e6);
        assertEq(staking.earned(bob), 0);
        assertEq(staking.earned(carol), 0);
        vm.prank(bob);
        assertEq(staking.claim(), 0, "a warming stake's share is not claimable before activation");

        vm.warp(t0 + 7 days);
        staking.activate(bob);
        staking.activate(carol);
        assertEq(staking.earned(bob), 0.375e6);
        assertEq(staking.earned(carol), 0.125e6);
        vm.prank(carol);
        assertEq(staking.claim(), 0.125e6);
        _assertConserved();
    }

    /// @dev Round 2 under the v4 rule, with a 7-day warm-up armed: a push while every stake is
    ///      warming is shared by warming stake, not taken by whoever activates first. bob
    ///      stakes 1 FETTI, carol 1,800 an hour later; dave's loss carves $1 at share 50% and
    ///      the push sends 0.5 to Staking at once, all to the warming bucket of 1,801: per
    ///      share floor(5e35 / 1,801e18) = 277,623,542,476,401, so bob accrues floor(277.6) =
    ///      277 and carol floor(499,722.37) = 499,722 (one unit of dust stays in the
    ///      accumulator). bob activates first and is paid only his 277; carol is paid hers when
    ///      she activates an hour later.
    function test_stakerFees_warmingOnlyPush_splitByWarmingStake_notFirstActivator() public {
        _classicFees();
        staking.setMinStakeDuration(7 days);
        ex.setStakerFeeShare(5000);
        _fetti(bob, 1e18);
        _fetti(carol, 1_800e18);

        uint256 t0 = vm.getBlockTimestamp();
        _stake(bob, 1e18);
        vm.warp(t0 + 1 hours);
        _stake(carol, 1_800e18);

        _dogeLoss(dave);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0.5e6);
        assertEq(toRecipient, 0.5e6);
        assertEq(ex.feePool(), 0);
        assertEq(staking.accWarmingRewardPerShareE30(), 277_623_542_476_401);
        assertEq(staking.accRewardPerShareE30(), 0);
        assertEq(staking.warmingRewardOf(bob), 277);
        assertEq(staking.warmingRewardOf(carol), 499_722);
        assertEq(staking.carryUsdc(), 0);

        vm.warp(t0 + 7 days);
        staking.activate(bob);
        assertEq(staking.earned(bob), 277);
        assertEq(staking.earned(carol), 0);
        assertEq(staking.warmingRewardOf(carol), 499_722);

        vm.warp(t0 + 1 hours + 7 days);
        staking.activate(carol);
        assertEq(staking.earned(carol), 499_722);
        assertEq(staking.earned(bob), 277);
        assertLe(staking.earned(bob) + staking.earned(carol), 0.5e6);
        _assertConserved();
    }

    /// @dev Round 2 (disclosed in DESIGN 13), with a 7-day warm-up armed: the earmarked staker
    ///      share is part of the fee pool and so of house cash, and waits behind winners.
    ///      Share 100%; with nothing staked dave's loss carves $1, kept back whole. dave and
    ///      carol then open; the owner takes every free dollar (the withdrawal's push has
    ///      nothing to move), so carol's 10% kPEPE win eats the cash and queues the rest (its
    ///      7.5% win fee joins the pool). bob now stakes, yet the pool cannot be pushed while
    ///      carol waits. dave's loss with the queue active carves no fee (and his day-long
    ///      hold pays borrow to the house); a harvest pays part of the queue, the owner's
    ///      deposit the rest, and then the whole pool, earmark included, goes to Staking while
    ///      bob still warms, and is his when he activates.
    function test_stakerFees_earmarkWaitsBehindWinners_thenPushed() public {
        _classicFees();
        staking.setMinStakeDuration(7 days);
        ex.setStakerFeeShare(10_000);
        _dogeLoss(dave);
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 0);
        assertEq(ex.feePool(), 1e6);

        uint256 did = _open(dave, DOGE, true, 100e6, 10);
        uint256 cid = _open(carol, KPEPE, true, 100e6, 10);
        // Only the earmark is in the pool and nothing is staked: the withdrawal pushes nothing.
        ex.withdrawHouse(ex.houseFreeUsdc());
        assertEq(ex.lpBalance(), 1e6);
        assertEq(ex.feePool(), 1e6);

        _moveBps(KPEPE, 1000);
        (, uint256 feeC, uint256 profit) = _expectWin(cid);
        (uint256 paid, uint256 queued) = _close(carol, cid);
        assertEq(paid, 100e6 + 1e6, "the win takes the cash the pool is a claim on");
        assertEq(queued, profit - 1e6);
        assertEq(ex.lpBalance(), 0);

        uint256 tStake = vm.getBlockTimestamp();
        _fetti(bob, 300e18);
        _stake(bob, 300e18);
        assertEq(staking.totalStake(), 300e18);
        vm.expectRevert(IExchangeTypes.NothingToPush.selector);
        ex.pushFees();

        vm.warp(tStake + 1 days);
        _moveBps(DOGE, -200);
        (uint256 loss, uint256 lfee,) = _expectLoss(did);
        assertEq(loss, 20e6);
        assertEq(lfee, 0, "no fee carved while winners wait");
        uint256 borrow = ex.borrowOwed(did);
        assertGt(borrow, 0);
        _close(dave, did);
        assertEq(ex.feePool(), 1e6 + feeC);
        assertEq(ex.lpBalance(), 20e6 + borrow);
        (, uint256 harvested) = ex.harvest(10);
        assertEq(harvested, 20e6 + borrow);
        assertEq(ex.queuedTotal(), queued - harvested);

        _depositHouse(1_000e6);
        ex.harvest(10);
        assertTrue(_queueEmpty());
        uint256 pool = 1e6 + feeC;
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, pool);
        assertEq(toRecipient, 0);
        assertEq(ex.feePool(), 0);
        assertEq(staking.totalRewardsUsdc(), pool);
        assertEq(staking.totalStaked(), 0, "bob still warming");
        assertApproxEqAbs(staking.warmingRewardOf(bob), pool, 1);
        assertEq(staking.earned(bob), 0);

        vm.warp(tStake + 7 days);
        staking.activate(bob);
        assertApproxEqAbs(staking.earned(bob), pool, 1);
        assertLe(staking.earned(bob), pool);
        _assertConserved();
    }

    // ------------------------------------------------------------- settling

    /// @dev No loser mint (owner's decision): a loss goes to house cash, less the loss fee
    ///      stamped at open, and FETTI supply does not move. A rate change after the open does
    ///      not touch the position; the next one carries the new rate.
    function test_loss_toTheHouse_feeAtTheStampedRate_noFettiMinted() public {
        ex.setMarketFees(DOGE, 0, 5);
        ex.setFeeBps(750, 500);
        uint256 id = _open(bob, DOGE, true, 100e6, 10);
        ex.setFeeBps(750, 0);
        assertEq(ex.positions(id).lossFeeBps, 500);
        _moveBps(DOGE, -200);

        // loss = 1000 x 2% = 20; fee = 5% x 20 = 1; the house keeps 19 of it outside the pool.
        (uint256 loss, uint256 fee, uint256 lpGain) = _expectLoss(id);
        assertEq(loss, 20e6);
        assertEq(fee, 1e6);
        assertEq(lpGain, 19e6);
        (int256 pnl, uint256 pfee, uint256 ppayout) = ex.previewClose(id);
        assertEq(pnl, -20e6);
        assertEq(pfee, fee);
        assertEq(ppayout, 80e6);

        _requestAndTick(bob, id);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.PositionClosed(id, bob, 83_300e12, -20e6, 1e6, 80e6, 0, 0, true);
        vm.prank(keeper);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        assertEq(paid, 80e6);
        assertEq(queued, 0);
        assertEq(ex.balanceOf(bob), FUNDING - 20e6);
        assertEq(ex.lpBalance(), HOUSE + 20e6);
        assertEq(ex.feePool(), 1e6);
        assertEq(ex.positions(id).owner, address(0));
        assertEq(confetti.totalSupply(), 0);

        // Opened after the change: stamped 0, so the whole loss stays with the house.
        _setRaw(DOGE, rawLaunch[DOGE]);
        uint256 id2 = _open(bob, DOGE, true, 100e6, 10);
        assertEq(ex.positions(id2).lossFeeBps, 0);
        _moveBps(DOGE, -200);
        _close(bob, id2);
        assertEq(ex.feePool(), 1e6);
        assertEq(ex.lpBalance(), HOUSE + 40e6);
        assertEq(confetti.totalSupply(), 0);
        _assertConserved();
    }

    function test_liquidations_acrossTiers_marginToTheHouse() public {
        // FARTCOIN's static position cap is $150,000: 151 x 1000x is refused before any house
        // check. $30K fits the static caps and 5x free cash but not the book: 30,000 x 10%
        // stress x 90% = 2,700 > 20% x 10,000.
        vm.startPrank(carol);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        ex.requestOpen(FARTCOIN, false, 151e6, 1000, address(0));
        vm.expectRevert(IExchangeTypes.HouseExposureExceeded.selector);
        ex.requestOpen(FARTCOIN, false, 30e6, 1000, address(0));
        vm.stopPrank();

        // carol shorts $10K at 1000x. The entry carries the 1 bps spread (short: lower); the
        // bust is measured from the raw print: a 5 bps rise (the gap rule).
        uint256 cid = _open(carol, FARTCOIN, false, 10e6, 1000);
        assertEq(ex.positions(cid).entryPx18, 16_400e13 * 9_999 / 10_000);
        assertEq(ex.bustPrice(cid), 16_400e13 * 10_005 / 10_000);
        assertEq(ex.houseExposureUsdc(), 10_000e6 * 1000 * 9000 / 1e8);

        _moveBps(FARTCOIN, 3); // +2.4 bps after the raw-tick floor: short of bust
        uint256 px = ex.execPrice(FARTCOIN, false, true);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, cid, px, ex.bustPrice(cid)));
        ex.liquidate(cid);

        // At launch the loss fee is 5%: bounty 0.5% x 10 = 0.05, the house keeps 9.95 of which
        // 5% x 10 = 0.5 is the fee pool's.
        _moveBps(FARTCOIN, 10);
        px = ex.execPrice(FARTCOIN, false, true);
        assertTrue(ImpactLib.isBusted(px, ex.bustPrice(cid), false));
        assertEq(_liquidate(liquidator, cid), 50_000);
        assertEq(ex.balanceOf(liquidator), 50_000);
        assertEq(ex.balanceOf(carol), FUNDING - 10e6);
        assertEq(ex.marginInUse(carol), 0);
        assertEq(ex.feePool(), 500_000);
        assertEq(ex.lpBalance(), HOUSE + 9_950_000);
        assertEq(ex.instrument(FARTCOIN).lastPx18, px);
        (, uint256 shortOi) = ex.openInterest(FARTCOIN);
        assertEq(shortOi, 0);
        assertEq(ex.houseExposureUsdc(), 0);
        assertEq(ex.openMaxPayoutUsdc(), 0);
        _assertConserved();

        // dave longs TRUMP (tier B, 250x) at $10K: bust is a 35 bps drop from the raw print
        // (his entry is 3 bps above it). alice liquidates: bounty 0.5% x 40 = 0.2; fee 5% x 40
        // = 2; house +39.8.
        uint256 did = _open(dave, TRUMP, true, 40e6, 250);
        assertEq(ex.bustPrice(did), 8e18 * 9_965 / 10_000);
        _moveBps(TRUMP, -40);
        assertEq(_liquidate(alice, did), 200_000);
        assertEq(ex.balanceOf(alice), FUNDING + 200_000);
        assertEq(ex.feePool(), 2_500_000);
        assertEq(ex.lpBalance(), HOUSE + 9_950_000 + 39_800_000);
        _assertConserved();

        // bob longs DOGE at 1000x: a 10 bps drop busts it. Bounty 0.1, fee 1, house +19.9.
        uint256 bid = _open(bob, DOGE, true, 20e6, 1000);
        _moveBps(DOGE, -10);
        assertTrue(ImpactLib.isBusted(ex.execPrice(DOGE, true, true), ex.bustPrice(bid), true));
        assertEq(_liquidate(liquidator, bid), 100_000);
        assertEq(ex.feePool(), 3_500_000);
        assertEq(ex.lpBalance(), HOUSE + 9_950_000 + 39_800_000 + 19_900_000);
        // Nothing was minted for any of it.
        assertEq(confetti.totalSupply(), 0);
        _assertConserved();
    }

    function test_oracleOnly_bookPushNeverPays() public {
        // The launch-day vector: push Hyperliquid's own DOGE book 10% up. Mark follows the
        // book, the oracle price (external median) does not. The long closes on the unmoved
        // oracle: all it pays is its own 1 bps entry spread.
        uint256 aid = _open(alice, DOGE, true, 20e6, 1000);
        uint32 asset = _asset(DOGE);
        uint64 raw = _raw(DOGE);
        uint64 pushed = uint64(uint256(raw) * 110 / 100);
        source.setQuote(asset, pushed, pushed, pushed, raw);
        assertEq(oracle.markPrice(DOGE), uint256(pushed) * 1e12);
        assertEq(oracle.rawMid(DOGE), uint256(pushed) * 1e12);
        assertEq(ex.execPrice(DOGE, true, false), launchPrices18[DOGE]);
        uint256 entry = ex.positions(aid).entryPx18;
        assertEq(entry, launchPrices18[DOGE] * 10_001 / 10_000);
        uint256 spreadLoss = ImpactLib.cappedLoss(20_000e6, 20e6, entry, launchPrices18[DOGE], true);
        assertGt(spreadLoss, 0);
        assertLe(spreadLoss, 2e6); // 1 bps of $20K
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(aid);
        assertEq(pnl, -int256(spreadLoss));
        assertEq(fee, spreadLoss * 500 / 10_000); // the launch loss fee, from the house's side
        assertEq(payout, 20e6 - spreadLoss);
        // Had the fill followed the book, the same push would have paid far more than the margin.
        uint256 exit = ImpactLib.deadbandExit(uint256(pushed) * 1e12, true, 1);
        (uint256 gain, uint256 move) = ImpactLib.rawGain(20_000e6, entry, exit, true);
        assertGt(ImpactLib.adjustedGain(gain, move, _curve(ex.instrument(DOGE))), 1_500e6);
        (uint256 paid, uint256 queued) = _close(alice, aid);
        assertEq(paid, 20e6 - spreadLoss);
        assertEq(queued, 0);
        _assertConserved();
    }

    function test_oracleOnly_bookPushNeverLiquidates() public {
        // A push against the position cannot liquidate: a 1000x long busts 5 bps under the raw
        // entry print; with the book 10% under and the oracle unmoved, the settlement price is
        // the oracle, still at entry.
        uint256 bid = _open(bob, DOGE, true, 20e6, 1000);
        uint32 asset = _asset(DOGE);
        uint64 raw = _raw(DOGE);
        uint64 dumped = uint64(uint256(raw) * 90 / 100);
        source.setQuote(asset, dumped, dumped, dumped, raw);
        assertEq(ex.execPrice(DOGE, true, true), launchPrices18[DOGE]);
        vm.prank(liquidator);
        vm.expectRevert(
            abi.encodeWithSelector(IExchangeTypes.NotLiquidatable.selector, bid, launchPrices18[DOGE], ex.bustPrice(bid))
        );
        ex.liquidate(bid);
        // The oracle 10 bps down (85_000 -> 84_915, under the 84_957.5 bust) is enough, book
        // or no book. Bounty 0.5% x 20 = 0.1.
        uint64 oracleDown = uint64(uint256(raw) * 9_990 / 10_000);
        source.setOraclePx(asset, oracleDown);
        assertEq(ex.execPrice(DOGE, true, true), uint256(oracleDown) * 1e12);
        assertEq(ex.bustPrice(bid), 84_957.5e12);
        assertTrue(ImpactLib.isBusted(uint256(oracleDown) * 1e12, ex.bustPrice(bid), true));
        assertEq(_liquidate(liquidator, bid), 100_000);
        _assertConserved();
    }

    /// @dev A request filed, then executed by anyone after the keeper window, fills at the
    ///      worse of the two prints on a live launch market with real decimals, and the events
    ///      say it was not a keeper fill.
    function test_requestFlow_fallbackWorstOf_onLaunchMarket() public {
        // kPEPE (szDecimals 0, $0.007): a long requested at 7_000, the oracle at 6_930 (-1%)
        // when a stranger executes 8 s later: the fill is max(7_000, 6_930) = 7_000, entered at
        // 7_000 + 3 bps of spread = 7_002.1.
        vm.prank(alice);
        uint256 req = ex.requestOpen(KPEPE, true, 100e6, 10, address(0));
        _moveBps(KPEPE, -100);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        uint256 pid = ex.nextPositionId();
        vm.expectEmit(address(ex));
        emit IExchangeTypes.PositionOpened(pid, alice, KPEPE, true, 100e6, 10, 7_002.1e12, req, false);
        vm.prank(bob);
        assertEq(ex.executeOpen(req), pid);
        assertEq(ex.positions(pid).entryPx18, 7_002.1e12);
        // The close requested at 6_930 with the oracle back at 7_000 by the fallback window
        // fills at min(6_930, 7_000) = 6_930: the loss the trader asked for, on the spread
        // entry; the 5% loss fee comes from the house's side.
        vm.prank(alice);
        ex.requestClose(pid);
        _setRaw(KPEPE, 7_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        uint256 loss = ImpactLib.cappedLoss(1_000e6, 100e6, 7_002.1e12, 6_930e12, true);
        assertApproxEqAbs(loss, 10.3e6, 0.01e6);
        vm.expectEmit(address(ex));
        uint256 lfee = loss * 500 / 10_000;
        emit IExchangeTypes.PositionClosed(pid, alice, 6_930e12, -int256(loss), lfee, 100e6 - loss, 0, 0, false);
        vm.prank(carol);
        (uint256 paid,) = ex.executeClose(pid);
        assertEq(paid, 100e6 - loss);
        assertEq(ex.feePool(), lfee);
        assertEq(ex.lpBalance(), HOUSE + loss);
        _assertConserved();
    }

    /// @dev S4: a delisted market can only be retired at the last price the venue settled on
    ///      (`lastPx18`, the last fill or liquidation print), and only by the owner.
    function test_retireDead_afterDelisting_releasesMarginAtTheLastPrint() public {
        uint256 aid = _open(alice, DOGE, true, 100e6, 10);
        uint256 bid = _open(bob, DOGE, false, 50e6, 10);
        assertEq(ex.instrument(DOGE).lastPx18, launchPrices18[DOGE]);
        // A live feed cannot be retired dead; a market that never settled has no price.
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.FeedAlive.selector, DOGE));
        ex.retireDead(DOGE);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NoLastPrice.selector, ETH));
        ex.retireDead(ETH);

        // Hyperliquid delists DOGE: the precompiles return zero for good.
        source.setQuote(_asset(DOGE), 0, 0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, DOGE));
        ex.requestClose(aid);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        ex.retireDead(DOGE);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, DOGE));
        ex.retire(DOGE);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.InstrumentRetired(DOGE, launchPrices18[DOGE]);
        ex.retireDead(DOGE);
        assertTrue(ex.instrument(DOGE).retired);

        // Both settle at the last print: each gives back only its entry spread.
        uint256 lossA = ImpactLib.cappedLoss(1_000e6, 100e6, ex.positions(aid).entryPx18, launchPrices18[DOGE], true);
        uint256 lossB = ImpactLib.cappedLoss(500e6, 50e6, ex.positions(bid).entryPx18, launchPrices18[DOGE], false);
        assertGt(lossA, 0);
        assertGt(lossB, 0);
        (uint256 paid, uint256 queued) = _close(alice, aid);
        assertEq(paid, 100e6 - lossA);
        assertEq(queued, 0);
        (paid,) = _close(bob, bid);
        assertEq(paid, 50e6 - lossB);
        assertEq(ex.marginInUse(alice) + ex.marginInUse(bob), 0);
        (uint256 l, uint256 s) = ex.openInterest(DOGE);
        assertEq(l + s, 0);
        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.MarketRetired.selector);
        ex.requestOpen(DOGE, true, 10e6, 1, address(0));
        vm.expectRevert(IExchangeTypes.MarketRetired.selector);
        ex.retireDead(DOGE);
        _assertConserved();
    }

    /// @dev The cash waterfall end to end: wins paid from house cash, queued when it runs
    ///      short, losses with the queue active carve no fee, harvest drains the queue, then
    ///      fees push.
    function test_wins_paidFromHouse_queuedWhenShort_drainedByHarvest_thenFeesPush() public {
        ex.setFeeBps(750, 500);
        ex.setStakerFeeShare(0);
        // carol's long is booked while nothing is owed, with the 5% loss fee stamped.
        uint256 cid = _open(carol, FARTCOIN, true, 100e6, 10);

        // 1. alice wins 1% on kPEPE (tier B, 3 bps deadband and spread): paid in full.
        (uint256 adjA, uint256 feeA) = _aliceWinsPaidInFull();

        // 2. dave longs $10K of DOGE; the owner then takes all free cash but $100. The
        //    withdrawal pushes alice's fee out first (share 0: all to the recipient). The hour
        //    opened at alice's close on 10,000 of free cash and has no credit (alice won), so
        //    the base drops by the whole withdrawal.
        uint256 did = _open(dave, DOGE, true, 250e6, 40);
        uint256 free = ex.houseFreeUsdc();
        assertEq(free, HOUSE - adjA);
        ex.withdrawHouse(free - 100e6);
        assertEq(ex.balanceOf(feeRecipient), feeA);
        assertEq(ex.feePool(), 0);
        assertEq(ex.lpBalance(), 100e6);
        (, uint256 base, int256 net) = ex.breakerWindow();
        assertEq(base, adjA + 100e6);
        assertEq(net, int256(adjA));

        // 3. dave wins 2%: more than the house holds -> paid what there is, the rest queued;
        //    the hour's outflow passes 25% of the base, so the breaker trips.
        (uint256 adjD, uint256 feeD, uint256 queued) = _daveWinsIntoTheQueue(did, adjA);
        assertEq(ex.feePool(), feeD);

        // 4. Nothing leaves while the queue is owed, and nothing opens: the owner clears the
        //    breaker, yet no notional fits zero free cash.
        vm.expectRevert(IExchangeTypes.NothingToPush.selector);
        ex.pushFees();
        assertEq(ex.houseFreeUsdc(), 0);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 0, 1));
        ex.withdrawHouse(1);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.BreakerCleared(address(this));
        ex.clearBreaker();
        vm.prank(bob);
        vm.expectRevert(IExchangeTypes.PositionTooLarge.selector);
        ex.requestOpen(DOGE, true, 10e6, 1, address(0));

        // 5. carol loses her whole $100 with the queue active: no fee carved despite the
        //    stamped 5%; the cash lands in the house but is not paid out automatically.
        _moveBps(FARTCOIN, -1000);
        (uint256 lossC, uint256 lfee,) = _expectLoss(cid);
        assertEq(lossC, 100e6);
        assertEq(lfee, 0);
        _close(carol, cid);
        assertEq(ex.lpBalance(), 100e6);
        assertEq(ex.feePool(), feeD);
        assertEq(ex.queuedTotal(), queued);
        _assertConserved();

        // 6. Anyone harvests: dave is paid in full and the queue empties.
        uint256 daveBefore = ex.balanceOf(dave);
        vm.prank(liquidator);
        (uint256 n, uint256 paidOut) = ex.harvest(10);
        assertEq(n, 1);
        assertEq(paidOut, queued);
        assertEq(ex.balanceOf(dave), daveBefore + queued);
        assertTrue(_queueEmpty());
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.lpBalance(), 100e6 - queued);
        _assertConserved();

        // 7. Fees now push: at a 0% staker share everything goes to the recipient and Staking
        //    is never called.
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, feeD);
        assertEq(ex.feePool(), 0);
        assertEq(ex.balanceOf(feeRecipient), feeA + feeD);
        assertEq(usdc.balanceOf(address(staking)), 0);
        assertEq(staking.totalRewardsUsdc(), 0);
        assertEq(ex.lpBalance(), 100e6 - queued - feeD);
        assertGt(adjD, 0);
        _assertConserved();

        // At the launch share with nothing staked at all, the stakers' 20% stays in the fee
        // pool for a later push instead of waiting in Staking's carry.
        ex.setStakerFeeShare(2000);
        _depositHouse(1_000e6);
        uint256 eid = _open(bob, DOGE, true, 100e6, 10);
        _moveBps(DOGE, -200);
        (, uint256 lfee2,) = _expectLoss(eid);
        assertGt(lfee2, 0);
        _close(bob, eid);
        (toStakers, toRecipient) = ex.pushFees();
        uint256 held = lfee2 * 2000 / 10_000;
        assertEq(toStakers, 0);
        assertEq(toRecipient, lfee2 - held);
        assertEq(ex.feePool(), held);
        assertEq(usdc.balanceOf(address(staking)), 0);
        assertEq(staking.carryUsdc(), 0);
        _assertConserved();
    }

    /// @dev Step 1 of the waterfall: a small win the house pays on the spot.
    function _aliceWinsPaidInFull() internal returns (uint256 adjusted, uint256 fee) {
        uint256 aid = _open(alice, KPEPE, true, 100e6, 10);
        _moveBps(KPEPE, 100);
        uint256 profit;
        (adjusted, fee, profit) = _expectWin(aid);
        assertGt(profit, 0);
        assertLt(profit, ex.lpBalance());
        (int256 pnl, uint256 pfee, uint256 ppayout) = ex.previewClose(aid);
        assertEq(pnl, int256(profit));
        assertEq(pfee, fee);
        assertEq(ppayout, 100e6 + profit);
        (uint256 paid, uint256 queued) = _close(alice, aid);
        assertEq(paid, 100e6 + profit);
        assertEq(queued, 0);
        assertEq(ex.balanceOf(alice), FUNDING + profit);
        assertEq(ex.lpBalance(), HOUSE - profit);
        assertEq(ex.feePool(), fee);
        assertEq(ex.queueLength(), 0);
        assertEq(confetti.totalSupply(), 0);
        _assertConserved();
    }

    /// @dev Step 3 of the waterfall: a win larger than house cash, paid partly and queued, and
    ///      the breaker trip it causes on the base the withdrawal left.
    function _daveWinsIntoTheQueue(uint256 did, uint256 adjA)
        internal
        returns (uint256 adjusted, uint256 fee, uint256 queued)
    {
        _moveBps(DOGE, 200);
        uint256 profit;
        (adjusted, fee, profit) = _expectWin(did);
        assertGt(profit, 100e6);
        _requestAndTick(dave, did);
        uint256 base = adjA + 100e6;
        vm.expectEmit(address(ex));
        emit IExchangeTypes.LpBreakerTripped(adjA + adjusted, base * 2500 / 10_000, base);
        vm.prank(keeper);
        uint256 paid;
        (paid, queued) = ex.executeClose(did);
        assertEq(paid, 250e6 + 100e6);
        assertEq(queued, profit - 100e6);
        assertEq(ex.balanceOf(dave), FUNDING + 100e6);
        assertEq(ex.lpBalance(), 0);
        assertEq(ex.queueLength(), 1);
        assertEq(ex.queueHead(), 0);
        (address recipient, uint256 owed) = ex.queueEntry(0);
        assertEq(recipient, dave);
        assertEq(owed, queued);
        assertEq(ex.queuedTotal(), queued);
        assertTrue(ex.breakerTripped());
        vm.prank(carol);
        vm.expectRevert(IExchangeTypes.OpensPausedByBreaker.selector);
        ex.requestOpen(FARTCOIN, true, 10e6, 1, address(0));
    }

    // ------------------------------------------------------------- referrals

    /// @dev A referred trader on the deployed system: the code resolves, the first executed
    ///      open locks the referrer, and 15% of a fee lands in the referrer's exchange balance
    ///      on the spot while the pool keeps 85%. Naming a wallet with no code locks none (S11).
    function test_referral_codeResolves_lockAtFirstOpen_shareOnDeployedSystem() public {
        _classicFees();
        vm.prank(carol);
        refs.registerCode("carol_x");
        assertEq(refs.codeToReferrer("carol_x"), carol);

        // bob owns no code: dave's open naming him locks no referrer, and dave's $1 fee is
        // pooled whole.
        uint256 did = _openReferred(dave, DOGE, true, 100e6, 10, bob);
        assertTrue(refs.referrerLocked(dave));
        assertEq(refs.referrerOf(dave), address(0));
        _moveBps(DOGE, -200);
        _close(dave, did);
        assertEq(ex.feePool(), 1e6);
        _setRaw(DOGE, rawLaunch[DOGE]);

        uint256 id = _openReferred(alice, DOGE, true, 100e6, 10, carol);
        assertEq(refs.referrerOf(alice), carol);
        assertTrue(refs.referrerLocked(alice));
        _moveBps(DOGE, -200);
        // loss 20, fee 1; share 15% = 0.15 to carol now; pool +0.85.
        (uint256 loss, uint256 fee,) = _expectLoss(id);
        assertEq(loss, 20e6);
        assertEq(fee, 1e6);
        _close(alice, id);
        assertEq(ex.balanceOf(carol), FUNDING + 150_000);
        assertEq(ex.feePool(), 1e6 + 850_000);
        assertEq(ex.lpBalance(), HOUSE + 40e6 - 150_000);
        assertEq(refs.referralEarned(carol), 150_000);
        _assertConserved();
        // At the launch share (20%) with nobody staked the recipient gets 80% of the 1.85 and
        // the stakers' 0.37 stays in the pool, earmarked.
        (uint256 a, uint256 b) = ex.pushFees();
        assertEq(a, 0);
        assertEq(b, 1_480_000);
        assertEq(ex.feePool(), 370_000);
        _assertConserved();
    }

    // ------------------------------------------------------------- staking

    /// @dev FETTI is the existing token (v4 never mints it); stakers earn the fee
    ///      share pro rata and `claim` pays their wallet (S9).
    function test_fees_flowToStakersAndRecipient_claimPaysTheWallet() public {
        _classicFees();
        ex.setStakerFeeShare(4000);
        // bob and carol lose $20 and $40 on DOGE: fees 1 and 2, $3 in all.
        uint256 bid = _open(bob, DOGE, true, 100e6, 10);
        _setRaw(DOGE, 83_300);
        _close(bob, bid);
        _setRaw(DOGE, rawLaunch[DOGE]);
        uint256 cid = _open(carol, DOGE, true, 100e6, 10);
        _setRaw(DOGE, 81_600);
        _close(carol, cid);
        assertEq(ex.feePool(), 3e6);
        assertEq(confetti.totalSupply(), 0, "losses mint nothing");

        _fetti(bob, 1_900e18);
        _fetti(carol, 3_800e18);
        assertEq(confetti.totalSupply(), 5_700e18);
        _stake(bob, 1_900e18);
        _stake(carol, 3_800e18);
        vm.warp(vm.getBlockTimestamp() + staking.minStakeDuration());
        staking.activate(bob);
        staking.activate(carol);
        assertEq(staking.totalStaked(), 5_700e18);
        assertEq(confetti.balanceOf(address(staking)), 5_700e18);
        assertEq(confetti.balanceOf(bob), 0);

        // Push: 40% x 3 = $1.20 to stakers pro rata, 60% x 3 = $1.80 to the recipient's
        // exchange balance.
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 1_200_000);
        assertEq(toRecipient, 1_800_000);
        assertEq(ex.balanceOf(feeRecipient), 1_800_000);
        assertEq(usdc.balanceOf(address(staking)), 1_200_000);
        // Pro rata by stake (1:2): 0.40 and 0.80, each at most one unit short (the accumulator
        // floors; the dust stays in Staking).
        uint256 bobEarned = staking.earned(bob);
        uint256 carolEarned = staking.earned(carol);
        assertApproxEqAbs(bobEarned, 400_000, 1);
        assertApproxEqAbs(carolEarned, 800_000, 1);
        assertLe(bobEarned + carolEarned, 1_200_000);
        _assertConserved();

        // Claim pays bob's wallet; his exchange balance does not move.
        uint256 walletBefore = usdc.balanceOf(bob);
        uint256 exBefore = ex.balanceOf(bob);
        vm.prank(bob);
        assertEq(staking.claim(), bobEarned);
        assertEq(usdc.balanceOf(bob), walletBefore + bobEarned);
        assertEq(ex.balanceOf(bob), exBefore);
        assertEq(usdc.balanceOf(address(staking)), 1_200_000 - bobEarned);
        assertEq(staking.earned(bob), 0);
        _assertConserved();

        // A second round of fees splits by the same stakes; unstaking keeps what was earned.
        _setRaw(DOGE, rawLaunch[DOGE]);
        uint256 aid = _open(alice, DOGE, true, 100e6, 10);
        _setRaw(DOGE, 84_150);
        (, uint256 fee,) = _expectLoss(aid);
        assertEq(fee, 0.5e6);
        _close(alice, aid);
        (uint256 toStakers2,) = ex.pushFees();
        assertEq(toStakers2, fee * 4000 / 10_000);
        uint256 bobShare = staking.earned(bob);
        uint256 carolShare = staking.earned(carol) - carolEarned;
        assertLe(bobShare + carolShare, toStakers2);
        assertGe(bobShare + carolShare + 2, toStakers2); // at most one unit of dust each
        assertApproxEqAbs(carolShare, bobShare * 2, 2);

        vm.prank(carol);
        staking.unstake(3_800e18);
        assertEq(confetti.balanceOf(carol), 3_800e18);
        assertEq(staking.earned(carol), carolEarned + carolShare);
        walletBefore = usdc.balanceOf(carol);
        vm.prank(carol);
        assertEq(staking.claim(), carolEarned + carolShare);
        assertEq(usdc.balanceOf(carol), walletBefore + carolEarned + carolShare);
        _assertConserved();
    }

    /// @dev Launch economics: 20% of every pushed fee to stakers. Fees come from both sides at
    ///      5%: a loss carves 5% of the loss from the house's side into the pool (the trader
    ///      pays the loss and nothing more), a win pays 5% of the adjusted gain. dave, referred
    ///      by carol, wins 5% on DOGE: carol's 15% of his fee is paid at once, the pool keeps
    ///      85%, and the push splits the pool 20 / 80 with alice the only active staker.
    function test_pushFees_launchSplitIsTwentyPercent_feesFromBothSides() public {
        assertEq(ex.stakerFeeShareBps(), 2000);
        assertEq(ex.winFeeBps(), 500);
        assertEq(ex.lossFeeBps(), 500);
        _stakeActive(alice, 1e18);
        assertEq(staking.totalStaked(), 1e18);

        uint256 bid = _open(bob, DOGE, true, 100e6, 10);
        _moveBps(DOGE, -200);
        (uint256 lossB, uint256 lfee,) = _expectLoss(bid);
        // fee = 5% of the loss (rounded down), carved from the house's side.
        assertGt(lossB, 20e6); // 2% of $1,000 plus the launch entry spread
        assertEq(lfee, lossB * 500 / 10_000);
        (uint256 paidB,) = _close(bob, bid);
        assertEq(paidB, 100e6 - lossB);
        assertEq(ex.feePool(), lfee);
        assertEq(ex.lpBalance(), HOUSE + lossB);
        _setRaw(DOGE, rawLaunch[DOGE]);

        vm.prank(carol);
        refs.registerCode("carol_y");
        uint256 did = _openReferred(dave, DOGE, true, 100e6, 10, carol);
        _moveBps(DOGE, 500);
        (, uint256 fee, uint256 profit) = _expectWin(did);
        uint256 share = fee * 1500 / 10_000;
        assertGt(share, 0);
        (uint256 paid,) = _close(dave, did);
        assertEq(paid, 100e6 + profit);
        assertEq(ex.balanceOf(carol), FUNDING + share);
        uint256 pool = lfee + fee - share;
        assertEq(ex.feePool(), pool);

        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, pool * 2000 / 10_000);
        assertEq(toRecipient, pool - toStakers);
        assertEq(staking.totalRewardsUsdc(), toStakers);
        assertApproxEqAbs(staking.earned(alice), toStakers, 1);
        assertEq(ex.balanceOf(feeRecipient), toRecipient);
        _assertConserved();
    }

    // -------------------------------------------------------- multi-trader

    /// @dev 80 seeded steps over every launch market: opens sized to the live house limits,
    ///      price moves, closes, liquidations, harvests and pushes, with the cash conserved
    ///      after each.
    function test_multiTrader_scriptedSequenceAcrossMarkets_staysConserved() public {
        (uint256 opens, uint256 closes, uint256 liquidations) = _scriptedWalk(4);
        assertGt(opens, 10);
        assertGt(closes, 5);
        assertGt(liquidations, 0);
        emit log_named_uint("opens", opens);
        emit log_named_uint("closes", closes);
        emit log_named_uint("liquidations", liquidations);
    }

    function _scriptedWalk(uint256 seed) internal returns (uint256 opens, uint256 closes, uint256 liquidations) {
        for (uint256 step = 0; step < 80; step++) {
            seed = uint256(keccak256(abi.encode(seed)));
            uint32 id = uint32(seed % LaunchMarkets.COUNT);
            address t = traders[(seed >> 8) % traders.length];
            uint8 action = uint8((seed >> 16) % 5);
            uint256[] memory mine = ex.positionIdsOf(t);

            if (action == 0 || (action == 2 && mine.length == 0)) {
                if (_walkOpen(t, id, seed)) opens++;
            } else if (action == 1) {
                int256 bps = int256((seed >> 40) % 150);
                _moveBps(id, (seed >> 56) % 2 == 0 ? bps : -bps);
            } else if (action == 2) {
                _close(t, mine[(seed >> 64) % mine.length]);
                closes++;
            } else if (action == 3) {
                for (uint256 i = 0; i < mine.length; i++) {
                    IExchangeTypes.Position memory pos = ex.positions(mine[i]);
                    if (ImpactLib.isBusted(
                            ex.execPrice(pos.instrumentId, pos.isLong, true), ex.bustPrice(mine[i]), pos.isLong
                        )) {
                        _liquidate(liquidator, mine[i]);
                        liquidations++;
                        break;
                    }
                }
            } else {
                if (!_queueEmpty()) ex.harvest(5);
                try ex.pushFees() {} catch {}
            }
            _assertConserved();
        }
    }

    /// @dev Under $50 at up to 200x, cut down to what the house limits allow right now.
    function _walkOpen(address t, uint32 id, uint256 seed) internal returns (bool) {
        if (ex.breakerTripped()) ex.clearBreaker();
        bool isLong = (seed >> 24) % 2 == 0;
        uint128 margin = uint128(10e6 + (seed >> 32) % 40e6);
        uint32 lev = uint32(1 + (seed >> 96) % 200);
        uint32 maxLev = ex.instrument(id).maxLeverage;
        if (lev > maxLev) lev = maxLev;
        uint256 limit = ex.maxPositionUsd(id, isLong);
        if (uint256(margin) * lev > limit) lev = uint32(limit / margin);
        if (lev == 0) return false;
        _open(t, id, isLong, margin, lev);
        return true;
    }

    // ------------------------------------------------------------- breaker

    /// @dev Round 4 item 1 (review finding 1) setup, breaker armed at 10% (launch 25%), 5% loss
    ///      fee. alice opens $1,000 x10 VIRTUAL ($10,000; maximum profit 25% x 10,000 = 2,500).
    ///      bob's $1,000 x10 DOGE closes at -10%, his whole margin: that first settlement opens
    ///      the window on free cash 10,000, so base 10,000; it books net -(1,000 - 50) = -950;
    ///      house cash 11,000 of which pool 50. With `push`, a stranger pushes the pool mid-hour
    ///      at the launch share (20%) with nobody staked: 40 to the recipient, the stakers' 10
    ///      kept in the pool, house cash 10,960, base still 10,000 and net still -950 (the pool
    ///      was never in the base).
    function _hourWithFees(bool push) internal returns (uint256 aid) {
        ex.setBreakerBps(1000);
        ex.setFeeBps(750, 500);
        aid = _open(alice, VIRTUAL, true, 1_000e6, 10);
        assertEq(ex.positions(aid).maxProfitUsdc, 2_500e6);
        uint256 bid = _open(bob, DOGE, true, 1_000e6, 10);
        _moveBps(DOGE, -1000);
        _close(bob, bid);
        (, uint256 base, int256 net) = ex.breakerWindow();
        assertEq(base, HOUSE);
        assertEq(net, -950e6);
        assertEq(ex.lpBalance(), HOUSE + 1_000e6);
        assertEq(ex.feePool(), 50e6);
        if (!push) return aid;
        vm.prank(makeAddr("stranger"));
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 40e6);
        assertEq(ex.feePool(), 10e6);
        assertEq(ex.lpBalance(), HOUSE + 960e6);
        (, base, net) = ex.breakerWindow();
        assertEq(base, HOUSE, "a fee push leaves the base");
        assertEq(net, -950e6);
    }

    /// @dev alice's win is sized to adjusted in (1,946, 1,947]: net = adjusted - 950 in
    ///      (996, 997], under the 10% x 10,000 = 1,000 threshold, but over the 996 a base cut
    ///      by the pushed 40 would give. Search from 20% (adjusted about 1,800).
    function _midHourWinUnder10Pct(uint256 aid) internal {
        uint256 adjusted = _winAbove(aid, VIRTUAL, 2000, 1_946e6);
        assertLe(adjusted, 1_947e6);
        _close(alice, aid);
        (, uint256 base, int256 net) = ex.breakerWindow();
        assertEq(base, HOUSE);
        assertEq(net, int256(adjusted) - 950e6);
        assertGt(net, 996e6, "would have tripped on a base cut by the pushed pool");
        assertFalse(ex.breakerTripped());
        _assertConserved();
    }

    function test_breaker_noPush_winUnder10Pct_noTrip() public {
        _midHourWinUnder10Pct(_hourWithFees(false));
    }

    function test_breaker_strangerPushMidHour_baseUnchanged_noFalseTrip() public {
        _midHourWinUnder10Pct(_hourWithFees(true));
    }

    /// @dev A real drawdown with a push in the middle still trips: alice's adjusted gain just
    ///      above 1,950 makes net = adjusted - 950 just above 1,000 = 10% of the 10,000 base.
    function test_breaker_pushMidHour_real10PctDrawdownTrips() public {
        uint256 aid = _hourWithFees(true);
        uint256 adjusted = _winAbove(aid, VIRTUAL, 2000, 1_950e6);
        assertLe(adjusted, 1_951e6);
        _requestAndTick(alice, aid);
        vm.prank(keeper);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.LpBreakerTripped(adjusted - 950e6, 1_000e6, HOUSE);
        ex.executeClose(aid);
        assertTrue(ex.breakerTripped());
        _assertConserved();
    }

    /// @dev Round 4 item 2 for a house withdrawal, breaker armed at 10%, 5% loss fee. dave's
    ///      $500 x10 FARTCOIN at -10% opens the window on free cash 10,000: base 10,000, net
    ///      -(500 - 25) = -475, house cash 10,500, pool 25. The owner withdraws 500: the pool
    ///      pushes first (20 to the recipient, the stakers' 5 kept), then the withdrawal takes
    ///      the 475 of credit first (net 0) and lowers the base by the other 25, to 9,975: the
    ///      free cash still there. alice's $1,000 x10 VIRTUAL win then trips just past
    ///      10% x 9,975 = 997.5. (Without the credit rule the base would be 9,500 with net
    ///      -475, and the hour could pay out 950 + 475 untripped.)
    function test_withdrawHouseMidHour_usesCreditFirst_winsTripAt10PctOfCashLeft() public {
        ex.setBreakerBps(1000);
        ex.setFeeBps(750, 500);
        uint256 did = _open(dave, FARTCOIN, true, 500e6, 10);
        _moveBps(FARTCOIN, -1000);
        _close(dave, did);
        (, uint256 base, int256 net) = ex.breakerWindow();
        assertEq(base, HOUSE);
        assertEq(net, -475e6);
        assertEq(ex.lpBalance(), HOUSE + 500e6);
        assertEq(ex.feePool(), 25e6);

        vm.expectEmit(address(ex));
        emit IExchangeTypes.FeesPushed(0, 20e6);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.HouseWithdrawn(500e6, HOUSE - 20e6);
        ex.withdrawHouse(500e6);
        (, base, net) = ex.breakerWindow();
        assertEq(base, HOUSE - 25e6);
        assertEq(net, 0);
        assertEq(ex.feePool(), 5e6);
        assertEq(ex.houseFreeUsdc(), HOUSE - 25e6);

        uint256 aid = _open(alice, VIRTUAL, true, 1_000e6, 10);
        uint256 adjusted = _winAbove(aid, VIRTUAL, 1000, 997.5e6);
        assertLe(adjusted, 998.5e6);
        _requestAndTick(alice, aid);
        vm.prank(keeper);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.LpBreakerTripped(adjusted, 997.5e6, HOUSE - 25e6);
        ex.executeClose(aid);
        assertTrue(ex.breakerTripped());
        _assertConserved();
    }

    /// @dev Round 4 item 1: a fee push leaves the window base alone. bob's whole $1,000 DOGE
    ///      loss opens the window (base 10,000, net -950, pool 50); carol's small FARTCOIN loss
    ///      adds to the pool and the credit; at staker share 0 the push sends the whole pool to
    ///      the recipient and moves only house cash.
    function test_pushFees_leavesBreakerBase() public {
        _classicFees();
        ex.setStakerFeeShare(0);
        uint256 bid = _open(bob, DOGE, true, 1_000e6, 10);
        _moveBps(DOGE, -1000);
        _close(bob, bid);
        uint256 cid = _open(carol, FARTCOIN, true, 10e6, 1);
        _moveBps(FARTCOIN, -100);
        (uint256 lossC, uint256 feeC, uint256 gainC) = _expectLoss(cid);
        assertGt(feeC, 0);
        _close(carol, cid);

        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, 50e6 + feeC);
        assertEq(ex.lpBalance(), HOUSE + 1_000e6 + lossC - 50e6 - feeC);
        (, uint256 startLp, int256 net) = ex.breakerWindow();
        assertEq(startLp, HOUSE);
        assertEq(net, -950e6 - int256(gainC));
        _assertConserved();
    }

    /// @dev S1: the breaker is on at launch, 25% of the window's free cash, floor 0. alice and
    ///      bob each long $10,000 of DOGE, both stamped with a 2,500 maximum profit (25% of
    ///      10,000). DOGE +30% caps both. The first close books net 2,500 = the threshold:
    ///      nothing trips. The second makes 5,000 > 2,500: it trips. Opens stop; closes and
    ///      house withdrawals keep working; neither the guardian nor the market keeper can
    ///      clear it (owner only, M5), and the trip ends by itself when the hour is up.
    function test_breaker_onAtLaunch_tripsPast25Pct_closesStillWork_endsWithTheHour() public {
        assertEq(ex.breakerBps(), 2500);
        assertEq(ex.breakerFloorUsdc(), 0);
        uint256 cid = _open(carol, VIRTUAL, true, 10e6, 10);
        uint256 a1 = _open(alice, DOGE, true, 1_000e6, 10);
        uint256 a2 = _open(bob, DOGE, true, 1_000e6, 10);
        assertEq(ex.positions(a1).maxProfitUsdc, 2_500e6);
        assertEq(ex.positions(a2).maxProfitUsdc, 2_500e6);
        assertEq(ex.openMaxPayoutUsdc(), 500e6 + 5_000e6);

        _moveBps(DOGE, 3000);
        (uint256 adjusted,,) = _expectWin(a1);
        assertEq(adjusted, 2_500e6, "capped at the stamped maximum profit");
        _requestAndTick(alice, a1);
        vm.expectEmit(true, false, false, false, address(ex));
        emit IExchangeTypes.PayoutCapped(a1, 0, 0);
        vm.prank(keeper);
        ex.executeClose(a1);
        assertFalse(ex.breakerTripped());
        (uint64 start, uint256 base, int256 net) = ex.breakerWindow();
        assertEq(base, HOUSE);
        assertEq(net, 2_500e6);

        _requestAndTick(bob, a2);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.LpBreakerTripped(5_000e6, 2_500e6, HOUSE);
        vm.prank(keeper);
        ex.executeClose(a2);
        assertTrue(ex.breakerTripped());

        vm.prank(alice);
        vm.expectRevert(IExchangeTypes.OpensPausedByBreaker.selector);
        ex.requestOpen(DOGE, true, 10e6, 1, address(0));
        assertEq(ex.maxPositionUsd(DOGE, true), 0);
        _close(carol, cid);
        ex.withdrawHouse(100e6);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        ex.clearBreaker();
        vm.prank(marketKeeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, marketKeeper));
        ex.clearBreaker();

        vm.warp(uint256(start) + 1 hours);
        assertFalse(ex.breakerTripped());
        vm.expectRevert(IExchangeTypes.BreakerNotTripped.selector);
        ex.clearBreaker();
        _open(alice, DOGE, true, 10e6, 1);
        _assertConserved();
    }

    // ---------------------------------------------------------------- roles

    /// @dev M5: the market keeper is its own wallet; it moves OI caps and house sizing (a
    ///      stress change re-prices the book exposure at once) and nothing owner-only. The
    ///      fill key and the guardian cannot move caps; the guardian pauses and nothing more.
    function test_roles_marketKeeperMovesCapsAndSizingOnly_guardianOnlyPauses() public {
        assertTrue(marketKeeper != ex.owner() && marketKeeper != keeper && marketKeeper != guardian);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setOiCaps(DOGE, 9_000_000e6, 9_000_000e6);
        vm.prank(keeper);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setHouseSizing(DOGE, 40, 80, 800);
        vm.prank(guardian);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setOiCaps(DOGE, 9_000_000e6, 9_000_000e6);

        _open(alice, DOGE, true, 100e6, 10);
        assertEq(ex.houseExposureUsdc(), 1_000e6 * 1000 * 9000 / 1e8);

        vm.startPrank(marketKeeper);
        ex.setOiCaps(DOGE, 9_000_000e6, 8_000_000e6);
        assertEq(ex.instrument(DOGE).longOiCapUsd, 9_000_000e6);
        assertEq(ex.instrument(DOGE).shortOiCapUsd, 8_000_000e6);
        vm.expectEmit(address(ex));
        emit IExchangeTypes.HouseSizingSet(DOGE, 40, 80, 800);
        ex.setHouseSizing(DOGE, 40, 80, 800);
        assertEq(ex.instrument(DOGE).posX10, 40);
        assertEq(ex.instrument(DOGE).sideX10, 80);
        assertEq(ex.instrument(DOGE).stressBps, 800);
        assertEq(ex.houseExposureUsdc(), 1_000e6 * 800 * 9000 / 1e8);
        // Up to the tier A ceiling of $10M a side, not past it.
        vm.expectRevert(
            abi.encodeWithSelector(
                IExchangeTypes.ParamOutOfBounds.selector, IExchangeTypes.Param.LongOiCapUsd, uint256(10_000_000e6 + 1)
            )
        );
        ex.setOiCaps(DOGE, 10_000_000e6 + 1, 0);
        // Owner-only stays owner-only.
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, marketKeeper);
        vm.expectRevert(notOwner);
        ex.setPositionCaps(DOGE, 1_000_000e6, 50);
        vm.expectRevert(notOwner);
        ex.setRhoBps(3000);
        vm.expectRevert(notOwner);
        ex.setMaxWinBps(3000);
        vm.expectRevert(notOwner);
        ex.setFeeBps(0, 0);
        vm.expectRevert(notOwner);
        ex.setMarketFees(DOGE, 0, 0);
        vm.expectRevert(notOwner);
        ex.setHouseWallet(alice, true);
        vm.expectRevert(notOwner);
        ex.retire(DOGE);
        vm.expectRevert(notOwner);
        ex.withdrawHouse(1);
        vm.stopPrank();

        vm.prank(guardian);
        ex.setMarketOpensPaused(DOGE, true);
        assertTrue(ex.instrument(DOGE).opensPaused);
        vm.prank(guardian);
        vm.expectRevert(IExchangeTypes.Unauthorized.selector);
        ex.setMarketOpensPaused(DOGE, false);
        bytes memory guardianNotOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian);
        vm.prank(guardian);
        vm.expectRevert(guardianNotOwner);
        ex.retire(DOGE);
        vm.prank(guardian);
        vm.expectRevert(guardianNotOwner);
        ex.withdrawHouse(1);
        ex.setMarketOpensPaused(DOGE, false);
        assertFalse(ex.instrument(DOGE).opensPaused);
    }
}

/*//////////////////////////////////////////////////////////////////////////
                                invariants
//////////////////////////////////////////////////////////////////////////*/

/// @dev Random, bounded actions against the full system, through the request / execute /
///      cancel path with time warps. Every function keeps its inputs legal so a revert means a
///      real bug, which lets the invariant run with fail-on-revert. The ghosts measure house
///      cash from the outside: what the owner put in and took out, what settlements credited
///      traders, liquidators and referrers against the margin they forfeited, what harvests
///      paid and what fee pushes sent away.
contract Handler is Test {
    IExchange immutable ex;
    MockUSDC immutable usdc;
    MockPriceSource immutable source;
    MockFetti immutable confetti;
    Staking immutable staking;
    Referrals immutable refs;
    address immutable keeper;
    address immutable guardian;
    /// @dev The Exchange owner (the test contract): house money, fees, pauses.
    address immutable owner;
    SessionRouter immutable router;
    uint32 immutable marketCount;
    /// @dev Session cap per trade the handler authorizes; the open bounds keep margins under it.
    uint128 constant SESSION_CAP = 2_000e6;

    uint256 constant DELAY = 5;
    uint256 constant GRACE = 3;
    uint256 constant EXPIRY = 60;

    address[] public actors;
    /// @dev Executed, still-open positions.
    uint256[] public openIds;
    /// @dev Pending open request ids.
    uint256[] public openReqs;
    /// @dev Positions with a pending close request (may have been liquidated since).
    uint256[] public closeReqs;
    uint256 public ghostClaimedUsdc;
    /// @dev USDC this handler minted (actor deposits and the owner's house deposits).
    uint256 public ghostMintedUsdc;
    /// @dev FETTI that reached the actors from outside v4 (a v3 mint or a pool buy).
    uint256 public ghostFettiIn;
    /// @dev House money in (from setUp on) and out through `depositHouse` / `withdrawHouse`.
    uint256 public ghostHouseIn;
    uint256 public ghostHouseOut;
    /// @dev What fee pushes took out of house cash (the pushed part of the pool).
    uint256 public ghostFeesPushed;
    /// @dev The house's trading result: margin forfeited minus what each settlement credited
    ///      at once (payout or bounty, and the referrer's share paid on the spot), minus what
    ///      harvests paid the queue.
    int256 public ghostTradingResult;
    /// @dev Successful pushes (direct or inside a withdrawal); each leaves earmark == pool.
    uint256 public pushes;
    mapping(bytes32 => uint256) public calls;

    constructor(
        IExchange ex_,
        MockUSDC usdc_,
        MockPriceSource source_,
        MockFetti confetti_,
        Staking staking_,
        address keeper_,
        address guardian_,
        address[] memory actors_,
        uint256 houseIn_
    ) {
        ex = ex_;
        usdc = usdc_;
        source = source_;
        confetti = confetti_;
        staking = staking_;
        refs = Referrals(ex_.referrals());
        keeper = keeper_;
        guardian = guardian_;
        owner = ex_.owner();
        router = SessionRouter(ex_.sessionRouter());
        actors = actors_;
        marketCount = ex_.instrumentCount();
        ghostHouseIn = houseIn_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function openCount() external view returns (uint256) {
        return openIds.length;
    }

    function openReqCount() external view returns (uint256) {
        return openReqs.length;
    }

    function closeReqCount() external view returns (uint256) {
        return closeReqs.length;
    }

    // ---------------------------------------------------------------- cash

    function deposit(uint256 a, uint256 amount) external {
        address who = _actor(a);
        amount = bound(amount, 1e6, 5_000e6);
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(ex), amount);
        ex.deposit(amount);
        vm.stopPrank();
        ghostMintedUsdc += amount;
        calls["deposit"]++;
    }

    function withdraw(uint256 a, uint256 amount) external {
        address who = _actor(a);
        uint256 bal = ex.balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(who);
        ex.withdraw(amount);
        calls["withdraw"]++;
    }

    // ---------------------------------------------------------- house money

    /// @dev The owner adds house money from their wallet (USDC minted to them first; the mint
    ///      ledger counts it).
    function depositHouse(uint256 amount) external {
        _depositHouse(bound(amount, 1e6, 5_000e6));
        calls["depositHouse"]++;
    }

    /// @dev The settle phase: an exact deposit.
    function depositHouseExact(uint256 amount) external {
        _depositHouse(amount);
    }

    /// @dev The owner withdraws: one time in eight more than is free (refused with
    ///      `InsufficientBalance(free, amount)`, nothing changes), one in eight everything
    ///      that is free (so open positions' wins can outrun the house and queue), otherwise
    ///      a slice of up to a quarter of the free cash.
    function withdrawHouse(uint256 seed) external {
        uint256 free = ex.houseFreeUsdc();
        uint256 pick = seed % 8;
        uint256 amount;
        if (pick == 0) amount = free + 1 + (seed >> 8) % 1_000e6;
        else if (pick == 1) amount = free;
        else amount = 1 + (seed >> 8) % (free / 4 + 1);
        if (amount == 0) amount = 1;
        _withdrawHouse(amount);
    }

    /// @dev The settle phase: an exact withdrawal.
    function withdrawHouseExact(uint256 amount) external {
        _withdrawHouse(amount);
    }

    function _depositHouse(uint256 amount) internal {
        usdc.mint(owner, amount);
        uint256 lpBefore = ex.lpBalance();
        vm.startPrank(owner);
        usdc.approve(address(ex), amount);
        ex.depositHouse(amount);
        vm.stopPrank();
        assertEq(ex.lpBalance(), lpBefore + amount);
        ghostMintedUsdc += amount;
        ghostHouseIn += amount;
    }

    /// @dev Postconditions of every withdrawal (M1): it leaves house cash covering the queue
    ///      and the fee pool, takes exactly `amount` off the free cash (the fee push inside
    ///      moves pool and cash together), pays the owner's wallet, and never counts as
    ///      trading outflow: the window keeps its start, the trip flag does not change, and the
    ///      net outflow only moves from a credit toward 0.
    function _withdrawHouse(uint256 amount) internal {
        uint256 free = ex.houseFreeUsdc();
        if (amount > free) {
            vm.prank(owner);
            vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, free, amount));
            ex.withdrawHouse(amount);
            calls["withdrawHouseRefused"]++;
            return;
        }
        uint256 poolBefore = ex.feePool();
        uint256 lpBefore = ex.lpBalance();
        uint256 walletBefore = usdc.balanceOf(owner);
        (uint64 startBefore,, int256 netBefore) = ex.breakerWindow();
        bool trippedBefore = ex.breakerTripped();

        vm.prank(owner);
        ex.withdrawHouse(amount);

        uint256 pushed = poolBefore - ex.feePool();
        if (pushed != 0) pushes++;
        ghostFeesPushed += pushed;
        ghostHouseOut += amount;
        assertEq(usdc.balanceOf(owner), walletBefore + amount, "owner not paid");
        assertEq(ex.lpBalance(), lpBefore - pushed - amount, "withdrawal moved other cash");
        assertGe(ex.lpBalance(), ex.queuedTotal() + ex.feePool(), "withdrawal took owed cash");
        assertEq(ex.houseFreeUsdc(), free - amount, "free cash off by other than the amount");
        (uint64 startAfter,, int256 netAfter) = ex.breakerWindow();
        assertEq(startAfter, startBefore, "withdrawal moved the window");
        assertGe(netAfter, netBefore, "withdrawal added credit");
        assertLe(netAfter, netBefore < 0 ? int256(0) : netBefore, "withdrawal counted as outflow");
        assertEq(ex.breakerTripped(), trippedBefore, "withdrawal changed the trip");
        calls["withdrawHouse"]++;
    }

    // ------------------------------------------------------------- trading

    /// @dev File an open request within every rule as of now; the rules are re-checked at
    ///      execution, where a failure is a refund, not a revert. Every other actor is named as
    ///      referrer now and then so the referral share is exercised.
    function requestOpen(uint256 a, uint32 id, bool isLong, uint256 margin, uint256 lev, uint256 r) external {
        address who = _actor(a);
        bool ok;
        (ok, id, margin, lev) = _legalOpen(who, id, isLong, margin, lev);
        if (!ok) return;
        address referrer = r % 3 == 0 ? _actor(r >> 8) : address(0);

        vm.prank(who);
        openReqs.push(ex.requestOpen(id, isLong, uint128(margin), uint32(lev), referrer));
        calls["requestOpen"]++;
    }

    /// @dev The same open, filed by the actor's session key through the router (authorizing
    ///      a session first when the actor has no live one). The request is the actor's: same
    ///      pending margin, same execute / cancel paths afterwards, never a referrer.
    function sessionOpen(uint256 a, uint32 id, bool isLong, uint256 margin, uint256 lev) external {
        address who = _actor(a);
        bool ok;
        (ok, id, margin, lev) = _legalOpen(who, id, isLong, margin, lev);
        if (!ok) return;
        address key = _liveKey(who);
        uint256 pendingBefore = ex.pendingOf(who);
        vm.prank(key);
        uint256 req = router.requestOpen(id, isLong, uint128(margin), uint32(lev));
        IExchangeTypes.OpenRequest memory r = ex.openRequest(req);
        assertEq(r.trader, who, "session request filed for someone else");
        assertEq(r.referrer, address(0), "session request carried a referrer");
        assertEq(ex.pendingOf(who), pendingBefore + margin, "session margin not the trader's");
        assertEq(ex.pendingOf(key), 0, "session key holds margin");
        openReqs.push(req);
        calls["sessionOpen"]++;
    }

    /// @dev Bound an open to every rule as of now (the house-sized limits through
    ///      `maxPositionUsd`); `ok` false when none fits. A tripped breaker is cleared first by
    ///      the owner (v4: owner only).
    function _legalOpen(address who, uint32 id, bool isLong, uint256 margin, uint256 lev)
        internal
        returns (bool ok, uint32, uint256, uint256)
    {
        id = uint32(bound(id, 0, marketCount - 1));
        uint256 bal = ex.balanceOf(who);
        if (bal < 10e6) return (false, id, margin, lev);
        IExchangeTypes.Instrument memory inst = ex.instrument(id);
        if (inst.retired || inst.opensPaused || ex.globalOpensPaused()) return (false, id, margin, lev);
        _clearBreaker();
        // Half the time a small margin, so the house limits leave room for high leverage.
        uint256 cap = bal < SESSION_CAP ? bal : SESSION_CAP;
        if (margin % 2 == 0 && cap > 50e6) cap = 50e6;
        margin = bound(margin >> 1, 10e6, cap);
        lev = bound(lev, 1, inst.maxLeverage);
        uint256 limit = ex.maxPositionUsd(id, isLong);
        if (margin * lev > limit) {
            lev = limit / margin;
            if (lev == 0) return (false, id, margin, lev);
        }
        return (true, id, margin, lev);
    }

    function _clearBreaker() internal {
        if (!ex.breakerTripped()) return;
        vm.prank(owner);
        ex.clearBreaker();
        calls["clearBreaker"]++;
    }

    /// @dev Step to a point in a pending request's life and act as the windows allow: the
    ///      keeper in the grace window, any actor afterwards, a cancel past expiry. A refund at
    ///      execution (a rule, the jump guard, the born-busted guard) is a normal outcome.
    function executeOpen(uint256 i, uint256 dt, uint256 a) external {
        if (openReqs.length == 0) return;
        i %= openReqs.length;
        uint256 req = openReqs[i];
        IExchangeTypes.OpenRequest memory r = ex.openRequest(req);
        uint256 elapsed = _warpInto(r.requestedAt, dt);
        if (elapsed > EXPIRY) {
            vm.prank(_actor(a));
            ex.cancelOpen(req);
            calls["cancelOpen"]++;
        } else {
            _clearBreaker();
            vm.prank(elapsed < DELAY + GRACE ? keeper : _actor(a));
            uint256 pid = ex.executeOpen(req);
            if (pid != 0) {
                IExchangeTypes.Position memory pos = ex.positions(pid);
                assertLe(pos.maxProfitUsdc, uint256(pos.marginUsdc) * pos.payoutCapX, "max profit above the cap");
                openIds.push(pid);
                calls["executeOpen"]++;
            } else {
                calls["refundOpen"]++;
            }
        }
        _dropReq(i);
    }

    function requestClose(uint256 p) external {
        if (openIds.length == 0) return;
        uint256 pid = openIds[p % openIds.length];
        if (ex.closeRequest(pid).requestedAt != 0) return;
        vm.prank(ex.positions(pid).owner);
        ex.requestClose(pid);
        closeReqs.push(pid);
        calls["requestClose"]++;
    }

    /// @dev A close filed by the owner's session key. First, another actor's live key tries
    ///      the same position and must be refused: a key acts for its own trader only.
    function sessionClose(uint256 p) external {
        if (openIds.length == 0) return;
        uint256 pid = openIds[p % openIds.length];
        if (ex.closeRequest(pid).requestedAt != 0) return;
        address who = ex.positions(pid).owner;
        address other = _actor(p >> 8);
        if (other != who) {
            address otherKey = _liveKey(other);
            vm.prank(otherKey);
            vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotPositionOwner.selector, pid, other));
            router.requestClose(pid);
            calls["sessionCloseRefused"]++;
        }
        address key = _liveKey(who);
        vm.prank(key);
        router.requestClose(pid);
        assertGt(ex.closeRequest(pid).requestedAt, 0);
        closeReqs.push(pid);
        calls["sessionClose"]++;
    }

    /// @dev The actor authorizes their session key again (replacing the session, with some
    ///      HYPE for gas that must arrive at the key), or revokes it.
    function rotateSession(uint256 a, uint256 wei_, bool revoke) external {
        address who = _actor(a);
        address key = _keyOf(who);
        if (revoke) {
            if (router.sessionOf(who).key == address(0)) return;
            vm.prank(who);
            router.revoke();
            assertEq(router.traderOf(key), address(0));
            vm.prank(key);
            vm.expectRevert(ISessionRouter.NoSession.selector);
            router.requestClose(1);
            calls["revoke"]++;
            return;
        }
        wei_ = bound(wei_, 0, 1 ether);
        vm.deal(who, wei_);
        uint256 keyBefore = key.balance;
        _authorize(who, key, wei_);
        assertEq(key.balance, keyBefore + wei_, "gas not forwarded to the key");
        assertEq(address(router).balance, 0, "router kept HYPE");
        calls["authorize"]++;
    }

    /// @dev Same windows as `executeOpen`. A request whose position was liquidated since is
    ///      gone (`UnknownRequest`); that is the only revert this path ever sees.
    function executeClose(uint256 i, uint256 dt, uint256 a) external {
        if (closeReqs.length == 0) return;
        i %= closeReqs.length;
        uint256 pid = closeReqs[i];
        IExchangeTypes.CloseRequest memory r = ex.closeRequest(pid);
        if (r.requestedAt == 0) {
            // Voided by a liquidation: the close path has nothing to act on.
            try ex.executeClose(pid) returns (uint256, uint256) {
                revert("voided close executed");
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), IExchangeTypes.UnknownRequest.selector);
            }
            try ex.cancelClose(pid) {
                revert("voided close cancelled");
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), IExchangeTypes.UnknownRequest.selector);
            }
            calls["voidedClose"]++;
            _dropCloseReq(i);
            return;
        }
        uint256 elapsed = _warpInto(r.requestedAt, dt);
        if (elapsed > EXPIRY) {
            vm.prank(_actor(a));
            ex.cancelClose(pid);
            calls["cancelClose"]++;
        } else {
            _settleClose(pid, elapsed < DELAY + GRACE ? keeper : _actor(a));
            calls["executeClose"]++;
        }
        _dropCloseReq(i);
    }

    /// @dev The settle phase: close a position now at the keeper's fill (no close pending).
    function closeNow(uint256 pid) external {
        vm.prank(ex.positions(pid).owner);
        ex.requestClose(pid);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _settleClose(pid, keeper);
    }

    /// @dev Execute the pending close of `pid` as `caller` and book the house's side of it:
    ///      the margin comes in, the payout (after any borrow) and the referrer's spot share
    ///      go out; anything queued is still the house's cash until a harvest pays it.
    function _settleClose(uint256 pid, address caller) internal {
        IExchangeTypes.Position memory pos = ex.positions(pid);
        address ref = refs.referrerOf(pos.owner);
        uint256 refBefore = ex.balanceOf(ref);
        vm.prank(caller);
        (uint256 payout, uint256 queued) = ex.executeClose(pid);
        uint256 refPaid = ex.balanceOf(ref) - refBefore;
        ghostTradingResult += int256(uint256(pos.marginUsdc)) - int256(payout) - int256(refPaid);
        if (queued != 0) calls["queuedWin"]++;
        _dropOpen(pid);
    }

    function liquidate(uint256 p, uint256 a) external {
        if (openIds.length == 0) return;
        uint256 pid = openIds[p % openIds.length];
        // Liquidatable once the oracle price is past bust, pending close or not. When the
        // random pick is not busted, take a busted position with a pending close instead, so
        // the close path meets a voided request (`voidedClose`) within the walk.
        if (!_busted(pid)) {
            pid = 0;
            for (uint256 j = 0; j < closeReqs.length; j++) {
                if (_busted(closeReqs[j])) {
                    pid = closeReqs[j];
                    break;
                }
            }
            if (pid == 0) return;
        }
        _liquidate(pid, _actor(a));
        calls["liquidate"]++;
    }

    /// @dev The settle phase: liquidate a busted position now.
    function liquidateNow(uint256 pid, address by) external {
        _liquidate(pid, by);
    }

    /// @dev The whole margin comes in; the bounty and the referrer's spot share go out.
    function _liquidate(uint256 pid, address by) internal {
        IExchangeTypes.Position memory pos = ex.positions(pid);
        address ref = refs.referrerOf(pos.owner);
        uint256 refBefore = ex.balanceOf(ref);
        vm.prank(by);
        uint256 bounty = ex.liquidate(pid);
        uint256 refPaid = ex.balanceOf(ref) - refBefore - (ref == by ? bounty : 0);
        ghostTradingResult += int256(uint256(pos.marginUsdc)) - int256(bounty) - int256(refPaid);
        _dropOpen(pid);
    }

    /// @dev Whether a live position is at or past bust (a position gone since is not).
    function _busted(uint256 pid) internal view returns (bool) {
        IExchangeTypes.Position memory pos = ex.positions(pid);
        if (pos.owner == address(0)) return false;
        return ImpactLib.isBusted(ex.execPrice(pos.instrumentId, pos.isLong, true), ex.bustPrice(pid), pos.isLong);
    }

    /// @dev The guardian pauses a market's opens, or the owner resumes them: a request pending
    ///      on a paused market is refunded at execution.
    function togglePause(uint32 id) external {
        id = uint32(bound(id, 0, marketCount - 1));
        if (ex.instrument(id).opensPaused) {
            vm.prank(owner);
            ex.setMarketOpensPaused(id, false);
            calls["unpause"]++;
        } else {
            vm.prank(guardian);
            ex.setMarketOpensPaused(id, true);
            calls["pause"]++;
        }
    }

    /// @dev Move the BBO by up to 3%. When `lagRef` the oracle price (and mark) stay put, like
    ///      a push on Hyperliquid's own book, which must settle nothing.
    function movePrice(uint32 id, uint256 bps, bool up, bool lagRef) external {
        id = uint32(bound(id, 0, marketCount - 1));
        uint32 asset = ex.instrument(id).hlAssetIndex;
        (uint64 bid,,,) = source.quotes(asset);
        bps = bound(bps, 0, 300);
        uint256 next = up ? uint256(bid) * (10_000 + bps) / 10_000 : uint256(bid) * (10_000 - bps) / 10_000;
        if (next < 1_000) next = 1_000;
        if (next > 1e15) next = 1e15;
        source.setBbo(asset, uint64(next), uint64(next));
        if (!lagRef) {
            source.setMark(asset, uint64(next));
            source.setOraclePx(asset, uint64(next));
        }
        calls["movePrice"]++;
    }

    // ------------------------------------------------------- distributions

    function harvest(uint256 n) external {
        if (ex.queueHead() == ex.queueLength()) return;
        (, uint256 paid) = ex.harvest(bound(n, 1, 8));
        ghostTradingResult -= int256(paid);
        calls["harvest"]++;
    }

    /// @dev A push either moves money or reverts `NothingToPush`, nothing else.
    function pushFees() external {
        try ex.pushFees() returns (uint256 toStakers, uint256 toRecipient) {
            ghostFeesPushed += toStakers + toRecipient;
            pushes++;
            calls["pushFees"]++;
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), IExchangeTypes.NothingToPush.selector);
        }
    }

    /// @dev Owner action: a random staker fee share (0..100%), so pushes run the earmark path
    ///      (the stakers' part kept back while nothing at all is staked, active or warming).
    function setStakerFeeShare(uint256 bps) external {
        vm.prank(owner);
        ex.setStakerFeeShare(uint16(bound(bps, 0, 10_000)));
        calls["setStakerFeeShare"]++;
    }

    /// @dev Owner action: random win and loss fee rates, stamped on positions opened from now
    ///      on (a loss fee is carved only while the queue is empty).
    function setFeeBps(uint256 winBps, uint256 lossBps) external {
        vm.prank(owner);
        ex.setFeeBps(uint16(bound(winBps, 0, 1000)), uint16(bound(lossBps, 0, 500)));
        calls["setFeeBps"]++;
    }

    /// @dev Owner action: list or unlist an actor as a house wallet (wins beyond spot cash
    ///      forfeited, fees pay no referrer).
    function toggleHouseWallet(uint256 a) external {
        address who = _actor(a);
        bool listed = !ex.isHouseWallet(who);
        vm.prank(owner);
        ex.setHouseWallet(who, listed);
        calls[listed ? bytes32("houseWalletOn") : bytes32("houseWalletOff")]++;
    }

    // ------------------------------------------------------------- staking

    /// @dev An actor receives FETTI from outside v4 (a v3 mint or a pool buy): the only way the
    ///      FETTI supply moves in this suite.
    function receiveFetti(uint256 a, uint256 amount) external {
        address who = _actor(a);
        amount = bound(amount, 1e18, 1_000e18);
        confetti.mint(who, amount);
        ghostFettiIn += amount;
        calls["receiveFetti"]++;
    }

    /// @dev One actor sends FETTI to another (the existing token moves freely).
    function transferFetti(uint256 a, uint256 b, uint256 amount) external {
        address from = _actor(a);
        uint256 bal = confetti.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        confetti.transfer(_actor(b), amount);
        calls["transferFetti"]++;
    }

    function stake(uint256 a, uint256 amount) external {
        address who = _actor(a);
        uint256 bal = confetti.balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.startPrank(who);
        confetti.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
        calls["stake"]++;
    }

    function unstake(uint256 a, uint256 amount) external {
        address who = _actor(a);
        uint256 staked = staking.stakedOf(who);
        if (staked == 0) return;
        amount = bound(amount, 1, staked);
        vm.prank(who);
        staking.unstake(amount);
        calls["unstake"]++;
    }

    function claim(uint256 a) external {
        vm.prank(_actor(a));
        ghostClaimedUsdc += staking.claim();
        calls["claim"]++;
    }

    /// @dev Owner action: the warm-up for new stakes, 1 hour (launch) or 7 days.
    function setMinStakeDuration(uint256 pick) external {
        vm.prank(owner);
        staking.setMinStakeDuration(pick % 2 == 0 ? 1 hours : 7 days);
        calls["setMinStakeDuration"]++;
    }

    /// @dev Let an actor's warm-up run out (its stamped activation time) and activate the
    ///      warming stake. Activation pays exactly what the warming stake vested: `earned`
    ///      already counts a bucket that is due, so the vested part is added only while it is
    ///      not.
    function warpAndActivate(uint256 a) external {
        address who = _actor(a);
        (uint256 warming, uint64 at) = staking.warmingOf(who);
        if (warming == 0) return;
        uint256 earnedBefore = staking.earned(who) + (vm.getBlockTimestamp() < at ? staking.warmingRewardOf(who) : 0);
        uint256 activeBefore = staking.activeStakeOf(who);
        if (vm.getBlockTimestamp() < at) vm.warp(at);
        staking.activate(who);
        assertEq(staking.activeStakeOf(who), activeBefore + warming);
        assertEq(staking.earned(who), earnedBefore, "activation paid other than the vested warm-up");
        calls["activate"]++;
    }

    // ------------------------------------------------------------ internals

    /// @dev The actor's session key (one per actor, fixed): its private key and address.
    function _keyPk(address who) internal pure returns (uint256) {
        // Any value in [1, n - 1] is a valid secp256k1 private key.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        return uint256(keccak256(abi.encode("session key", who))) % (n - 1) + 1;
    }

    function _keyOf(address who) internal pure returns (address) {
        return vm.addr(_keyPk(who));
    }

    /// @dev `who` authorizes their key for 30 days at `SESSION_CAP`, no referrer, with the
    ///      key's consent signature and `wei_` of gas.
    function _authorize(address who, address key, uint256 wei_) internal {
        uint64 expiry = uint64(vm.getBlockTimestamp() + 30 days);
        bytes32 digest = router.authorizationDigest(who, key, expiry, SESSION_CAP, address(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_keyPk(who), MessageHashUtils.toEthSignedMessageHash(digest));
        vm.prank(who);
        router.authorize{value: wei_}(key, expiry, SESSION_CAP, address(0), abi.encodePacked(r, s, v));
    }

    /// @dev The actor's key with a live session, authorizing one first when needed.
    function _liveKey(address who) internal returns (address key) {
        key = _keyOf(who);
        ISessionRouter.Session memory s = router.sessionOf(who);
        if (s.key == key && s.expiry >= vm.getBlockTimestamp()) return key;
        _authorize(who, key, 0);
        calls["authorize"]++;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev Warp to `requestedAt + dt` (dt bounded to 1..EXPIRY + 5), never backwards, and
    ///      return the elapsed seconds the request sees.
    function _warpInto(uint64 requestedAt, uint256 dt) internal returns (uint256 elapsed) {
        dt = bound(dt, 1, EXPIRY + 5);
        uint256 target = requestedAt + dt;
        if (target < vm.getBlockTimestamp()) target = vm.getBlockTimestamp();
        vm.warp(target);
        elapsed = target - requestedAt;
        if (elapsed < DELAY) {
            // Too early to act on: wait out the minimum delay.
            vm.warp(requestedAt + DELAY);
            elapsed = DELAY;
        }
    }

    function _dropReq(uint256 i) internal {
        openReqs[i] = openReqs[openReqs.length - 1];
        openReqs.pop();
    }

    function _dropCloseReq(uint256 i) internal {
        closeReqs[i] = closeReqs[closeReqs.length - 1];
        closeReqs.pop();
    }

    function _dropOpen(uint256 pid) internal {
        for (uint256 i = 0; i < openIds.length; i++) {
            if (openIds[i] != pid) continue;
            openIds[i] = openIds[openIds.length - 1];
            openIds.pop();
            return;
        }
    }
}

contract IntegrationInvariantTest is IntegrationBase {
    Handler handler;
    /// @dev Storage slot of the Exchange's private `_stakerHeldUsdc`, derived in setUp (see
    ///      `_findStakerHeldSlot`), never hard-coded.
    uint256 stakerHeldSlot;

    function setUp() public override {
        super.setUp();
        // Every actor owns a code, so a named referrer locks (S11) and the share is exercised.
        for (uint256 i = 0; i < actors.length; i++) {
            vm.prank(actors[i]);
            refs.registerCode(string.concat("actor", vm.toString(i)));
        }
        handler = new Handler(ex, usdc, source, confetti, staking, keeper, guardian, actors, HOUSE);
        stakerHeldSlot = _findStakerHeldSlot();

        bytes4[] memory selectors = new bytes4[](30);
        selectors[0] = Handler.deposit.selector;
        selectors[1] = Handler.withdraw.selector;
        selectors[2] = Handler.requestOpen.selector;
        selectors[3] = Handler.executeOpen.selector;
        selectors[4] = Handler.requestClose.selector;
        selectors[5] = Handler.executeClose.selector;
        selectors[6] = Handler.liquidate.selector;
        selectors[7] = Handler.movePrice.selector;
        selectors[8] = Handler.harvest.selector;
        selectors[9] = Handler.pushFees.selector;
        selectors[10] = Handler.stake.selector;
        selectors[11] = Handler.unstake.selector;
        selectors[12] = Handler.claim.selector;
        selectors[13] = Handler.executeOpen.selector; // weighted: requests must get filled
        selectors[14] = Handler.togglePause.selector;
        selectors[15] = Handler.depositHouse.selector;
        selectors[16] = Handler.withdrawHouse.selector;
        selectors[17] = Handler.sessionOpen.selector;
        selectors[18] = Handler.sessionClose.selector;
        selectors[19] = Handler.rotateSession.selector;
        selectors[20] = Handler.warpAndActivate.selector;
        selectors[21] = Handler.executeClose.selector; // weighted: session closes must fill
        selectors[22] = Handler.setStakerFeeShare.selector;
        selectors[23] = Handler.setMinStakeDuration.selector;
        selectors[24] = Handler.receiveFetti.selector;
        selectors[25] = Handler.transferFetti.selector;
        selectors[26] = Handler.setFeeBps.selector;
        selectors[27] = Handler.toggleHouseWallet.selector;
        selectors[28] = Handler.requestOpen.selector; // weighted: keep the book busy
        selectors[29] = Handler.withdrawHouse.selector; // weighted: wins must outrun the house
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev `_stakerHeldUsdc` is declared right after `_openMaxPayoutUsdc` in `ExchangeBase`
    ///      (the only contract with storage on either side of the core / extension split), and
    ///      `openMaxPayoutUsdc()` reads exactly that variable. Record the slots the getter
    ///      reads on the core, less the core's own read of `_ext` in its fallback (what
    ///      `extension()` reads too), and take the next slot. The coverage walk checks the
    ///      derived slot against behaviour: after every successful push it equals the fee pool.
    function _findStakerHeldSlot() internal returns (uint256) {
        vm.record();
        ex.extension();
        (bytes32[] memory extReads,) = vm.accesses(address(ex));
        vm.record();
        ex.openMaxPayoutUsdc();
        (bytes32[] memory reads,) = vm.accesses(address(ex));
        vm.stopRecord();
        for (uint256 i = 0; i < reads.length; i++) {
            bool fallbackRead;
            for (uint256 j = 0; j < extReads.length; j++) {
                if (reads[i] == extReads[j]) fallbackRead = true;
            }
            if (!fallbackRead) return uint256(reads[i]) + 1;
        }
        revert("openMaxPayoutUsdc slot not found");
    }

    /// @dev A win that outruns the house, driven through the handler's own paths: the owner
    ///      tops up, alice files a small-margin DOGE long at up to 1000x (cut to the house
    ///      limits) that the keeper fills, the owner then withdraws every free dollar, DOGE
    ///      rises 3% and the keeper closes: what is left of house cash (the owed fee pool and
    ///      queue) cannot cover the win, so it queues. A later deposit lets `harvest` pay it.
    function _queueEpisode() internal {
        // A house wallet's win beyond spot cash is forfeited, never queued: alice must not be one.
        if (ex.isHouseWallet(alice)) handler.toggleHouseWallet(0);
        if (ex.instrument(DOGE).opensPaused) handler.togglePause(DOGE);
        handler.depositHouseExact(20_000e6);
        handler.deposit(0, 1_000e6);
        uint256 opens = handler.openCount();
        handler.requestOpen(0, DOGE, true, 100e6, 1000, 1);
        handler.executeOpen(handler.openReqCount() - 1, DELAY, 0);
        assertEq(handler.openCount(), opens + 1, "episode open not filled");
        handler.withdrawHouseExact(ex.houseFreeUsdc());
        handler.movePrice(DOGE, 300, true, false);
        uint256 queuedWins = handler.calls("queuedWin");
        handler.requestClose(handler.openCount() - 1);
        handler.executeClose(handler.closeReqCount() - 1, DELAY, 0);
        assertEq(handler.calls("queuedWin"), queuedWins + 1, "episode win did not queue");
        handler.depositHouse(5_000e6);
        handler.harvest(8);
    }

    /// @dev After every successful push: the derived slot is the earmark (a push leaves
    ///      earmark == pool), and the stakers' share is held back only while nothing at all
    ///      is staked (active or warming).
    function _checkPushed() internal view {
        assertEq(_stakerHeldUsdc(), ex.feePool(), "derived earmark slot is not the earmark");
        if (_stakerHeldUsdc() != 0) assertEq(staking.totalStake(), 0, "earmarked while stake exists");
    }

    /// @dev Deterministic drive of the handler through every action, checking the invariants
    ///      after each call, and proof that each path (request, keeper and fallback fills,
    ///      refunds, expiry cancels, a close voided by a liquidation, queued wins, harvest, fee
    ///      push, receiving, moving and staking FETTI, house money in and out and a refused
    ///      withdrawal, fee rate changes, house wallets, session-key trading) was actually
    ///      reached. Then everything is settled the way the design expects and the owner takes
    ///      back every dollar not owed: house cash ends at exactly 0.
    function test_handlerReachesEveryPath_andInvariantsHold() public {
        // Nobody stakes in the first 300 steps (staking slots push instead), so pushes run the
        // earmark path with nothing staked at all, the only time the stakers' share is held
        // back. The walk keeps a 7-day warm-up for the first half and activates nobody before
        // step 300, so later pushes also reach warming-only stake; the second half switches
        // between 1 hour and 7 days. Twice a win is driven to outrun the house
        // (`_queueEpisode`).
        handler.setMinStakeDuration(1);
        uint256 seed = 42;
        uint256 maxEarmark;
        for (uint256 i = 0; i < 1200; i++) {
            if (i == 400 || i == 800) _queueEpisode();
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 k = seed % 26;
            uint256 a = seed >> 8;
            uint256 b = seed >> 72;
            uint256 c = seed >> 136;
            if (k == 0) {
                handler.deposit(a, b);
            } else if (k == 1) {
                handler.withdraw(a, b);
            } else if (k == 2 || k == 3) {
                handler.requestOpen(a, uint32(b), c % 2 == 0, c, seed >> 200, b >> 16);
            } else if (k == 4 || k == 5) {
                handler.executeOpen(a, b, c);
            } else if (k == 6) {
                handler.requestClose(a);
            } else if (k == 7 || k == 8) {
                handler.executeClose(a, b, c);
            } else if (k == 9) {
                handler.liquidate(a, b);
            } else if (k == 10 || k == 11) {
                handler.movePrice(uint32(a), b, c % 2 == 0, c % 5 == 0);
            } else if (k == 12) {
                handler.harvest(a);
            } else if (k == 13) {
                handler.setStakerFeeShare(c);
                uint256 pushesBefore = handler.pushes();
                handler.pushFees();
                if (handler.pushes() > pushesBefore) _checkPushed();
            } else if (k == 14) {
                if (i < 300) {
                    handler.setStakerFeeShare(b);
                    uint256 pushesBefore = handler.pushes();
                    handler.pushFees();
                    if (handler.pushes() > pushesBefore) _checkPushed();
                } else {
                    handler.receiveFetti(a, b);
                    handler.stake(a, c);
                }
            } else if (k == 15) {
                handler.unstake(a, b);
                handler.claim(a);
            } else if (k == 16) {
                handler.togglePause(uint32(a));
            } else if (k == 17) {
                handler.depositHouse(b);
            } else if (k == 18) {
                uint256 pushesBefore = handler.pushes();
                handler.withdrawHouse(b);
                if (handler.pushes() > pushesBefore) _checkPushed();
            } else if (k == 19) {
                if (i < 300) handler.harvest(a);
                else handler.transferFetti(a, b, c);
            } else if (k == 20) {
                handler.sessionOpen(a, uint32(b), c % 2 == 0, c, seed >> 200);
            } else if (k == 21) {
                handler.sessionClose(a);
            } else if (k == 22) {
                handler.rotateSession(a, b, c % 3 == 0);
            } else if (k == 23) {
                handler.setMinStakeDuration(i < 600 ? 1 : b);
                if (i >= 300) handler.warpAndActivate(a);
            } else if (k == 24) {
                handler.setFeeBps(b, c);
            } else {
                // Rare: toggle a house wallet one time in four.
                if (c % 4 == 0) handler.toggleHouseWallet(a);
                else handler.harvest(a);
            }
            invariant_exchangeCashEqualsItsBuckets();
            invariant_lpEqualsHouseMoneyPlusTradingResultLessFeesPushed();
            invariant_fettiSupplyNeverMovesInsideV4();
            invariant_earmarkWithinFeePool();
            if (_stakerHeldUsdc() > maxEarmark) maxEarmark = _stakerHeldUsdc();
            if (i % 50 == 0) {
                invariant_stakingHoldsWhatItOwes();
                invariant_queueOpenInterestAndExposureMatchTheirEntries();
                invariant_pendingMarginMatchesOpenRequests();
                invariant_noUsdcLeaks();
                invariant_sessionKeysBindOneTrader();
            }
        }
        // The handler's position list is checked against the Exchange first; then close
        // everything, pay the queue out of a deposit, push the fees to an active staker and
        // let the owner take back all that is free.
        invariant_queueOpenInterestAndExposureMatchTheirEntries();
        _closeAll();
        _settle();

        invariant_exchangeCashEqualsItsBuckets();
        invariant_lpEqualsHouseMoneyPlusTradingResultLessFeesPushed();
        invariant_fettiSupplyNeverMovesInsideV4();
        invariant_stakingHoldsWhatItOwes();
        invariant_queueOpenInterestAndExposureMatchTheirEntries();
        invariant_pendingMarginMatchesOpenRequests();
        invariant_noUsdcLeaks();
        invariant_sessionKeysBindOneTrader();
        invariant_earmarkWithinFeePool();
        string[36] memory paths = [
            "deposit",
            "withdraw",
            "requestOpen",
            "executeOpen",
            "refundOpen",
            "cancelOpen",
            "requestClose",
            "executeClose",
            "cancelClose",
            "voidedClose",
            "liquidate",
            "movePrice",
            "pause",
            "unpause",
            "harvest",
            "queuedWin",
            "pushFees",
            "receiveFetti",
            "transferFetti",
            "stake",
            "unstake",
            "claim",
            "activate",
            "depositHouse",
            "withdrawHouse",
            "withdrawHouseRefused",
            "authorize",
            "sessionOpen",
            "sessionClose",
            "sessionCloseRefused",
            "revoke",
            "setStakerFeeShare",
            "setMinStakeDuration",
            "setFeeBps",
            "houseWalletOn",
            "clearBreaker"
        ];
        for (uint256 i = 0; i < paths.length; i++) {
            emit log_named_uint(paths[i], handler.calls(bytes32(bytes(paths[i]))));
        }
        emit log_named_uint("max earmark", maxEarmark);
        emit log_named_uint("successful pushes", handler.pushes());
        assertGt(maxEarmark, 0, "no push ever earmarked the stakers' share");
        assertEq(_stakerHeldUsdc(), 0, "earmark left after the final push");
        assertTrue(_queueEmpty(), "queue not drained");
        assertEq(ex.openMaxPayoutUsdc(), 0, "positions left open");
        assertEq(ex.houseExposureUsdc(), 0, "exposure left");
        for (uint32 id = 0; id < LaunchMarkets.COUNT; id++) {
            (uint256 l, uint256 s) = ex.openInterest(id);
            assertEq(l + s, 0, "open interest left");
        }
        assertGt(staking.totalStaked(), 0, "nobody actively staked");
        assertEq(ex.feePool(), 0, "fees not pushed");
        assertEq(ex.lpBalance(), 0, "the owner could not take back every free dollar");
        for (uint256 i = 0; i < paths.length; i++) {
            assertGt(handler.calls(bytes32(bytes(paths[i]))), 0, paths[i]);
        }
    }

    /// @dev Close every open position at the keeper's fill (liquidate what is already busted),
    ///      after letting every pending close request expire and cancelling it.
    function _closeAll() internal {
        vm.warp(vm.getBlockTimestamp() + EXPIRY + 1);
        for (uint256 a = 0; a < actors.length; a++) {
            uint256[] memory ids = ex.positionIdsOf(actors[a]);
            for (uint256 k = 0; k < ids.length; k++) {
                uint256 pid = ids[k];
                if (ex.closeRequest(pid).requestedAt != 0) ex.cancelClose(pid);
                IExchangeTypes.Position memory pos = ex.positions(pid);
                uint256 px = ex.execPrice(pos.instrumentId, pos.isLong, true);
                if (ImpactLib.isBusted(px, ex.bustPrice(pid), pos.isLong)) handler.liquidateNow(pid, liquidator);
                else handler.closeNow(pid);
            }
        }
    }

    /// @dev The owner tops house cash up to what is owed, harvests drain the queue, an active
    ///      staker is made sure of, the fees push (earmark included), and the owner withdraws
    ///      every free dollar: nothing is owed, so nothing stays.
    function _settle() internal {
        uint256 owed = ex.queuedTotal() + ex.feePool();
        if (ex.lpBalance() < owed) handler.depositHouseExact(owed - ex.lpBalance());
        for (uint256 guard = 0; !_queueEmpty(); guard++) {
            require(guard < 1_000, "could not drain the queue");
            handler.harvest(8);
        }
        if (staking.totalStaked() == 0) {
            handler.receiveFetti(0, 1e18);
            handler.stake(0, 1e18);
            handler.warpAndActivate(0);
        }
        handler.pushFees();
        uint256 free = ex.houseFreeUsdc();
        if (free != 0) handler.withdrawHouseExact(free);
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: b.invariant.fail-on-revert = true
    function invariant_exchangeCashEqualsItsBuckets() public view {
        uint256 claims =
            ex.lpBalance() + ex.balanceOf(feeRecipient) + ex.marginInUse(feeRecipient) + ex.pendingOf(feeRecipient);
        for (uint256 i = 0; i < actors.length; i++) {
            claims += ex.balanceOf(actors[i]) + ex.marginInUse(actors[i]) + ex.pendingOf(actors[i]);
        }
        assertEq(usdc.balanceOf(address(ex)), claims, "exchange cash != available + margins + pending + lp");
    }

    /// @dev v4 has no tally (Tokenomics is gone). House cash is exactly what the owner
    ///      deposited, less what the owner withdrew, plus the house's trading result (margins
    ///      forfeited at settlements less what they credited at once, borrow included, less
    ///      what harvests paid), less what fee pushes sent to the fee recipient and Staking.
    ///      The trading result is measured from the credits, never from house cash itself.
    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: b.invariant.fail-on-revert = true
    function invariant_lpEqualsHouseMoneyPlusTradingResultLessFeesPushed() public view {
        int256 expected = int256(handler.ghostHouseIn()) - int256(handler.ghostHouseOut())
            + handler.ghostTradingResult() - int256(handler.ghostFeesPushed());
        assertEq(int256(ex.lpBalance()), expected, "lp != deposits - withdrawals + trading - fees pushed");
    }

    /// @dev v4 never mints or burns FETTI: its supply is exactly what reached the actors from
    ///      outside v4, and Staking holds exactly the stakes.
    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: b.invariant.fail-on-revert = true
    function invariant_fettiSupplyNeverMovesInsideV4() public view {
        assertEq(confetti.totalSupply(), handler.ghostFettiIn(), "fetti supply moved inside v4");
        assertEq(confetti.balanceOf(address(staking)), staking.totalStaked() + staking.totalWarming(), "staked != held");
        uint256 perUser;
        for (uint256 i = 0; i < actors.length; i++) {
            perUser += staking.stakedOf(actors[i]);
        }
        assertEq(perUser, staking.totalStaked() + staking.totalWarming(), "stakes != totals");
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: b.invariant.fail-on-revert = true
    function invariant_stakingHoldsWhatItOwes() public view {
        uint256 owed = staking.carryUsdc();
        for (uint256 i = 0; i < actors.length; i++) {
            owed += staking.earned(actors[i]);
            // `earned` already counts a warming accrual whose warm-up is over.
            (uint256 warming, uint64 activatesAt) = staking.warmingOf(actors[i]);
            if (warming != 0 && vm.getBlockTimestamp() < activatesAt) owed += staking.warmingRewardOf(actors[i]);
        }
        uint256 held = usdc.balanceOf(address(staking));
        assertLe(owed, held, "staking owes more than it holds");
        assertEq(held + handler.ghostClaimedUsdc(), staking.totalRewardsUsdc(), "rewards != held + claimed");
    }

    /// @dev The queue total is its live entries; open interest, margin in use and the open
    ///      payout liability are the open positions'; and the book exposure (M4) is the sum
    ///      over markets of max(long, short) x stress x (1 - base rate).
    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: b.invariant.fail-on-revert = true
    function invariant_queueOpenInterestAndExposureMatchTheirEntries() public view {
        uint256 sum;
        for (uint256 i = ex.queueHead(); i < ex.queueLength(); i++) {
            (, uint256 owed) = ex.queueEntry(i);
            assertGt(owed, 0, "retired entry still live");
            sum += owed;
        }
        assertEq(sum, ex.queuedTotal(), "queue total != entries");

        uint256 n = handler.openCount();
        uint256[] memory longOi = new uint256[](LaunchMarkets.COUNT);
        uint256[] memory shortOi = new uint256[](LaunchMarkets.COUNT);
        uint256 margins;
        uint256 maxPayout;
        for (uint256 i = 0; i < n; i++) {
            IExchangeTypes.Position memory pos = ex.positions(handler.openIds(i));
            assertTrue(pos.owner != address(0), "tracked position is gone");
            uint256 notional = uint256(pos.marginUsdc) * pos.leverage;
            if (pos.isLong) longOi[pos.instrumentId] += notional;
            else shortOi[pos.instrumentId] += notional;
            margins += pos.marginUsdc;
            maxPayout += pos.maxProfitUsdc;
        }
        assertEq(ex.openMaxPayoutUsdc(), maxPayout, "openMaxPayout != sum of stamped maximum profits");
        // Pending requests reserve no OI and no margin in use.
        uint256 exposure;
        for (uint32 id = 0; id < LaunchMarkets.COUNT; id++) {
            (uint256 l, uint256 s) = ex.openInterest(id);
            assertEq(l, longOi[id], "long OI");
            assertEq(s, shortOi[id], "short OI");
            IExchangeTypes.Instrument memory inst = ex.instrument(id);
            exposure += (l > s ? l : s) * inst.stressBps * (10_000 - inst.baseRateBps) / 1e8;
        }
        assertEq(ex.houseExposureUsdc(), exposure, "book exposure != sum of market terms");
        uint256 inUse;
        for (uint256 i = 0; i < actors.length; i++) {
            inUse += ex.marginInUse(actors[i]);
        }
        assertEq(inUse, margins, "margin in use != open positions");
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: b.invariant.fail-on-revert = true
    function invariant_pendingMarginMatchesOpenRequests() public view {
        uint256 n = handler.openReqCount();
        uint256 pending;
        for (uint256 i = 0; i < n; i++) {
            IExchangeTypes.OpenRequest memory r = ex.openRequest(handler.openReqs(i));
            assertTrue(r.trader != address(0), "tracked request is gone");
            pending += r.marginUsdc;
        }
        uint256 held;
        for (uint256 i = 0; i < actors.length; i++) {
            held += ex.pendingOf(actors[i]);
        }
        assertEq(held, pending, "pending margin != open requests");
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: b.invariant.fail-on-revert = true
    function invariant_noUsdcLeaks() public view {
        // The owner's wallet is where house withdrawals land.
        uint256 wallets = usdc.balanceOf(feeRecipient) + usdc.balanceOf(ex.owner());
        for (uint256 i = 0; i < actors.length; i++) {
            wallets += usdc.balanceOf(actors[i]);
        }
        assertEq(
            usdc.totalSupply(), usdc.balanceOf(address(ex)) + usdc.balanceOf(address(staking)) + wallets, "usdc leaked"
        );
        assertEq(usdc.totalSupply(), FUNDING * traders.length + HOUSE + handler.ghostMintedUsdc(), "mint ledger");
        assertEq(usdc.balanceOf(ex.owner()), handler.ghostHouseOut(), "owner wallet != house withdrawn");
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: b.invariant.fail-on-revert = true
    function invariant_sessionKeysBindOneTrader() public view {
        for (uint256 i = 0; i < actors.length; i++) {
            ISessionRouter.Session memory s = router.sessionOf(actors[i]);
            if (s.key == address(0)) continue;
            assertEq(router.traderOf(s.key), actors[i], "key resolves to another trader");
            assertLe(s.expiry, vm.getBlockTimestamp() + router.MAX_SESSION(), "session longer than 30 days");
            assertEq(ex.balanceOf(s.key) + ex.pendingOf(s.key) + ex.marginInUse(s.key), 0, "key holds funds");
        }
        assertEq(address(router).balance, 0, "router kept HYPE");
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: b.invariant.fail-on-revert = true
    function invariant_earmarkWithinFeePool() public view {
        assertLe(_stakerHeldUsdc(), ex.feePool(), "earmarked staker share above the fee pool");
    }

    function _stakerHeldUsdc() internal view returns (uint256) {
        return uint256(vm.load(address(ex), bytes32(stakerHeldSlot)));
    }
}
