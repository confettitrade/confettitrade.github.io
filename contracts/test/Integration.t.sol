// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ConfettiDeployer, LaunchMarkets} from "../script/Deploy.s.sol";
import {Confetti} from "../src/Confetti.sol";
import {Tokenomics} from "../src/Tokenomics.sol";
import {Staking} from "../src/Staking.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {Exchange} from "../src/Exchange.sol";
import {Referrals} from "../src/Referrals.sol";
import {ImpactLib} from "../src/lib/ImpactLib.sol";
import {IExchange} from "../src/interfaces/IExchange.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {IConfetti} from "../src/interfaces/IConfetti.sol";
import {ITokenomics} from "../src/interfaces/ITokenomics.sol";
import {IStaking} from "../src/interfaces/IStaking.sol";
import {IReferrals} from "../src/interfaces/IReferrals.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPriceSource} from "./mocks/MockPriceSource.sol";

/*//////////////////////////////////////////////////////////////////////////
                                  fixture
//////////////////////////////////////////////////////////////////////////*/

/// @dev The whole system, deployed through the same `ConfettiDeployer` steps as mainnet, with
///      a mock USDC and a mock feed quoting every launch market. Opens and closes go through
///      the request / keeper-fill path: `_open` and `_close` request, step 5 s into the keeper
///      window and execute as the fill keeper the deployer set.
abstract contract IntegrationBase is Test, ConfettiDeployer {
    MockUSDC usdc;
    MockPriceSource source;
    Confetti confetti;
    Tokenomics tok;
    Staking staking;
    PriceOracle oracle;
    Exchange ex;
    Referrals refs;
    uint256[] launchPrices18;

    address guardian = makeAddr("guardian");
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
    /// @dev Team share of each CONFETTI mint, restated here so the tests do not read it back
    ///      from the contract under test.
    uint256 constant TEAM_SHARE_BPS = 1000;
    /// @dev The default request windows.
    uint256 constant DELAY = 5;
    uint256 constant GRACE = 3;
    uint256 constant EXPIRY = 60;

    /// @dev Expected team CONFETTI from closes and liquidations made through `_close` and
    ///      `_liquidate`: the sum over mints of floor(mint x 10%).
    uint256 teamMintedGhost;

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

    /// @dev Raw launch quotes (10^(6 - szDecimals) implied decimals): DOGE $0.085, FARTCOIN
    ///      $0.164, VIRTUAL $1.20, WIF $0.45, MELANIA $0.20, kFLOKI $0.06, PENGU $0.02,
    ///      PEOPLE $0.015, TRUMP $8.00, kPEPE $0.007.
    uint64[10] rawLaunch = [85_000, 16_400, 120_000, 450_000, 20_000, 60_000, 20_000, 15_000, 800_000, 7_000];

    function setUp() public virtual {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        source = new MockPriceSource();
        LaunchMarkets.Market[] memory ms = LaunchMarkets.all();
        for (uint256 i = 0; i < ms.length; i++) {
            source.setQuote(ms[i].hlAssetIndex, rawLaunch[i], rawLaunch[i], rawLaunch[i]);
        }

        Deployment memory d = _deploy(_config(address(this)), address(this));
        confetti = d.confetti;
        tok = d.tokenomics;
        staking = d.staking;
        oracle = d.oracle;
        ex = d.exchange;
        refs = d.referrals;
        launchPrices18 = d.launchPrices18;

        traders = [alice, bob, carol, dave];
        actors = [alice, bob, carol, dave, liquidator];
        for (uint256 i = 0; i < traders.length; i++) {
            _fund(traders[i], FUNDING);
        }
    }

    // ------------------------------------------------------------- deploying

    function _config(address owner) internal view returns (Config memory cfg) {
        cfg.usdc = address(usdc);
        cfg.owner = owner;
        cfg.guardian = guardian;
        cfg.keeper = keeper;
        cfg.feeRecipient = feeRecipient;
        cfg.priceSource = address(source);
        cfg.launchPrices18 = new uint256[](0);
        cfg.flatThresholdUsd = DEFAULT_FLAT_THRESHOLD_USD;
        cfg.tailDecayScaleUsd = DEFAULT_TAIL_DECAY_SCALE_USD;
        cfg.stakerCapUsd = DEFAULT_STAKER_CAP_USD;
        cfg.flatRateE18 = DEFAULT_FLAT_RATE_E18;
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

    // --------------------------------------------------------------- trading

    function _fund(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(ex), type(uint256).max);
        ex.deposit(amount);
        vm.stopPrank();
    }

    /// @dev Into the keeper window of a request filed right now.
    function _tick() internal {
        vm.warp(vm.getBlockTimestamp() + DELAY);
    }

    /// @dev Request as `user` and let the keeper fill in its first eligible second. The LP
    ///      breaker can trip in the scenarios here (net-winning hours past the $5K floor, or
    ///      with the floor lowered; DESIGN 3b); the guardian clears it first so a scenario can
    ///      keep opening positions.
    function _open(address user, uint32 id, bool isLong, uint128 margin, uint32 lev) internal returns (uint256) {
        return _openReferred(user, id, isLong, margin, lev, address(0));
    }

    function _openReferred(address user, uint32 id, bool isLong, uint128 margin, uint32 lev, address referrer)
        internal
        returns (uint256 positionId)
    {
        if (ex.breakerTripped()) {
            vm.prank(guardian);
            ex.clearBreaker();
        }
        vm.prank(user);
        uint256 req = ex.requestOpen(id, isLong, margin, lev, referrer);
        _tick();
        vm.prank(keeper);
        positionId = ex.executeOpen(req);
        assertGt(positionId, 0, "open request refunded");
    }

    function _close(address user, uint256 id) internal returns (uint256 paid, uint256 queued) {
        uint256 mintedBefore = tok.totalMinted();
        vm.prank(user);
        ex.requestClose(id);
        _tick();
        vm.prank(keeper);
        (paid, queued) = ex.executeClose(id);
        teamMintedGhost += (tok.totalMinted() - mintedBefore) * TEAM_SHARE_BPS / 10_000;
    }

    function _liquidate(address by, uint256 id) internal returns (uint256 bounty) {
        uint256 mintedBefore = tok.totalMinted();
        vm.prank(by);
        bounty = ex.liquidate(id);
        teamMintedGhost += (tok.totalMinted() - mintedBefore) * TEAM_SHARE_BPS / 10_000;
    }

    function _stake(address user, uint256 amount) internal {
        vm.startPrank(user);
        confetti.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function _queueEmpty() internal view returns (bool) {
        return ex.queueHead() == ex.queueLength();
    }

    // ---------------------------------------------------------- expectations

    function _curve(IExchange.Instrument memory inst) internal pure returns (ImpactLib.Curve memory) {
        return ImpactLib.Curve({
            baseRateBps: inst.baseRateBps,
            rateMultiplier: inst.rateMultiplier,
            referenceNotionalUsd: inst.referenceNotionalUsd,
            positionMultiplierE6: inst.positionMultiplierE6
        });
    }

    /// @dev What DESIGN section 6 says a winning close of `posId` settles to at the current
    ///      oracle price (the keeper's fill), on the deadband, payout cap and fee rate stamped
    ///      on the position at open (DESIGN 5); only the impact curve is the market's live one.
    function _expectWin(uint256 posId) internal view returns (uint256 adjusted, uint256 fee, uint256 profit) {
        IExchange.Position memory pos = ex.positions(posId);
        IExchange.Instrument memory inst = ex.instrument(pos.instrumentId);
        uint256 exit =
            ImpactLib.deadbandExit(ex.execPrice(pos.instrumentId, pos.isLong, false), pos.isLong, pos.deadbandBps);
        (uint256 gain, uint256 move) =
            ImpactLib.rawGain(uint256(pos.marginUsdc) * pos.leverage, pos.entryPx18, exit, pos.isLong);
        adjusted = ImpactLib.adjustedGain(gain, move, _curve(inst));
        uint256 cap = uint256(pos.marginUsdc) * pos.payoutCapX;
        if (adjusted > cap) adjusted = cap;
        fee = ImpactLib.winFee(adjusted, pos.feeBps);
        profit = adjusted - fee;
    }

    /// @dev What a losing close of `posId` settles to: capped loss, fee (the position's stamped
    ///      rate, only while the queue is empty) and the CONFETTI mint basis.
    function _expectLoss(uint256 posId) internal view returns (uint256 loss, uint256 fee, uint256 basis) {
        IExchange.Position memory pos = ex.positions(posId);
        loss = ImpactLib.cappedLoss(
            uint256(pos.marginUsdc) * pos.leverage,
            pos.marginUsdc,
            pos.entryPx18,
            ex.execPrice(pos.instrumentId, pos.isLong, false),
            pos.isLong
        );
        (fee, basis) = ImpactLib.splitLoss(loss, _queueEmpty() ? pos.feeBps : 0);
    }

    function _expectMint(uint256 basis) internal view returns (uint256) {
        return basis * tok.currentRateE18() / 1e6;
    }

    // ----------------------------------------------------------- invariants

    /// @dev Team CONFETTI expected from mints the scenario helpers did not see (the invariant
    ///      suite's handler overrides this).
    function _otherTeamMinted() internal view virtual returns (uint256) {
        return 0;
    }

    /// @dev CONFETTI supply == trader mints (Tokenomics' `totalMinted`) + the team share, which
    ///      is floor(10% x mint) per mint and sits with the fee recipient (it never stakes here).
    function _assertConfettiSupply() internal view {
        uint256 team = teamMintedGhost + _otherTeamMinted();
        assertEq(confetti.balanceOf(feeRecipient), team, "team share != sum of floor(10% x mint)");
        assertEq(confetti.totalSupply(), tok.totalMinted() + team, "confetti supply != trader mints + team");
        assertLe(team * 10, tok.totalMinted(), "team share above 10%");
    }

    /// @dev The accounting identities that must hold after every action:
    ///        1. Exchange cash == available balances + open margins + pending request margins
    ///           + LP cash;
    ///        2. tokenomics tally == LP cash - fee pool - queue (the claims on the LP);
    ///        3. CONFETTI supply == what Tokenomics says was minted to traders plus the 10%
    ///           team share of each mint;
    ///        4. no USDC leaks: every unit minted is in a wallet, the Exchange or Staking.
    function _assertConserved() internal view {
        uint256 claims =
            ex.lpBalance() + ex.balanceOf(feeRecipient) + ex.marginInUse(feeRecipient) + ex.pendingOf(feeRecipient);
        uint256 wallets = usdc.balanceOf(feeRecipient);
        for (uint256 i = 0; i < actors.length; i++) {
            claims += ex.balanceOf(actors[i]) + ex.marginInUse(actors[i]) + ex.pendingOf(actors[i]);
            wallets += usdc.balanceOf(actors[i]);
        }
        assertEq(usdc.balanceOf(address(ex)), claims, "exchange cash != buckets");
        assertEq(
            tok.trackedLpUsd(),
            int256(ex.lpBalance()) - int256(ex.feePool()) - int256(ex.queuedTotal()),
            "tally != lp - fees - queue"
        );
        _assertConfettiSupply();
        assertEq(
            usdc.totalSupply(), usdc.balanceOf(address(ex)) + usdc.balanceOf(address(staking)) + wallets, "usdc leaked"
        );
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

        assertEq(confetti.exchange(), address(ex));
        assertEq(confetti.staking(), address(staking));
        assertFalse(confetti.transfersEnabled());
        assertEq(confetti.owner(), address(this));

        assertEq(tok.exchange(), address(ex));
        assertEq(tok.owner(), address(this));
        (uint256 t, uint256 s, uint256 c, uint256 r) = tok.params();
        assertEq(t, tok.DEFAULT_FLAT_THRESHOLD_USD());
        assertEq(s, tok.DEFAULT_TAIL_DECAY_SCALE_USD());
        assertEq(c, tok.DEFAULT_STAKER_CAP_USD());
        assertEq(r, tok.DEFAULT_FLAT_RATE_E18());
        // The deployer's mirrored defaults must not drift from the contract's.
        assertEq(t, DEFAULT_FLAT_THRESHOLD_USD);
        assertEq(s, DEFAULT_TAIL_DECAY_SCALE_USD);
        assertEq(c, DEFAULT_STAKER_CAP_USD);
        assertEq(r, DEFAULT_FLAT_RATE_E18);

        assertEq(staking.exchange(), address(ex));
        assertEq(staking.tokenomics(), address(tok));
        assertEq(staking.confetti(), address(confetti));
        assertEq(staking.usdc(), address(usdc));
        assertEq(staking.owner(), address(this));

        assertEq(ex.usdc(), address(usdc));
        assertEq(ex.oracle(), address(oracle));
        assertEq(ex.confetti(), address(confetti));
        assertEq(ex.tokenomics(), address(tok));
        assertEq(ex.staking(), address(staking));
        assertEq(ex.referrals(), address(refs));
        assertEq(refs.exchange(), address(ex));
        assertEq(refs.referralShareBps(), 1500);
        assertEq(ex.owner(), address(this));
        assertEq(ex.pauseGuardian(), guardian);
        assertEq(ex.marketKeeper(), keeper);
        assertTrue(ex.isKeeper(keeper)); // the fill keeper
        assertFalse(ex.isKeeper(address(this)));
        assertEq(ex.feeRecipient(), feeRecipient);
        assertEq(ex.stakerFeeShareBps(), 0);
        assertEq(ex.minDelay(), 5);
        assertEq(ex.grace(), 3);
        assertEq(ex.expiry(), 60);
        assertEq(ex.maxJumpBps(), 1000);

        LaunchMarkets.Market[] memory ms = LaunchMarkets.all();
        assertEq(ex.instrumentCount(), uint32(ms.length));
        assertEq(launchPrices18.length, ms.length);
        for (uint256 i = 0; i < ms.length; i++) {
            uint32 id = uint32(i);
            IExchange.Instrument memory inst = ex.instrument(id);
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
            assertEq(inst.longOiCapUsd, LaunchMarkets.oiCapUsd(ms[i].tier));
            assertEq(inst.shortOiCapUsd, LaunchMarkets.oiCapUsd(ms[i].tier));
            assertEq(inst.maxNotionalUsd, LaunchMarkets.maxNotionalUsd(ms[i].tier), ms[i].name);
            assertEq(inst.maxNotionalUsd, ms[i].tier == 0 ? 25_000e6 : 10_000e6);
            assertEq(inst.payoutCapX, 50);
            assertFalse(inst.opensPaused);
            assertFalse(inst.retired);
            assertEq(inst.frozenPx18, 0);
            // The clamp only shapes the oracle's display price; the table keeps tier A's band
            // (5 bps, the Exchange's floor) at the 1000x bust move (5 bps), tier B's (25) under 35.
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
        assertEq(ex.breakerBps(), 1000);
        assertFalse(ex.breakerTripped());
        _assertConserved();
    }

    function test_deploy_handOverIsTwoStep() public {
        address newOwner = makeAddr("newOwner");
        Deployment memory d = _deploy(_config(newOwner), address(this));

        // Markets were added before the handover; the deployer still owns, newOwner is pending.
        assertEq(d.exchange.instrumentCount(), uint32(LaunchMarkets.COUNT));
        assertEq(d.confetti.owner(), address(this));
        assertEq(d.tokenomics.owner(), address(this));
        assertEq(d.staking.owner(), address(this));
        assertEq(d.oracle.owner(), address(this));
        assertEq(d.exchange.owner(), address(this));
        assertEq(d.confetti.pendingOwner(), newOwner);
        assertEq(d.tokenomics.pendingOwner(), newOwner);
        assertEq(d.staking.pendingOwner(), newOwner);
        assertEq(d.oracle.pendingOwner(), newOwner);
        assertEq(d.exchange.pendingOwner(), newOwner);
        // The referral registry has no owner of its own: the Exchange is its only writer.
        assertEq(d.referrals.exchange(), address(d.exchange));

        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        d.exchange.setFeeRecipient(newOwner);

        vm.startPrank(newOwner);
        d.confetti.acceptOwnership();
        d.tokenomics.acceptOwnership();
        d.staking.acceptOwnership();
        d.oracle.acceptOwnership();
        d.exchange.acceptOwnership();
        vm.stopPrank();

        assertEq(d.confetti.owner(), newOwner);
        assertEq(d.tokenomics.owner(), newOwner);
        assertEq(d.staking.owner(), newOwner);
        assertEq(d.oracle.owner(), newOwner);
        assertEq(d.exchange.owner(), newOwner);
        assertEq(d.exchange.pendingOwner(), address(0));

        // The deployer is locked out of every admin surface, the referral share included.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        d.confetti.enableTransfers();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        d.tokenomics.setParams(1, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        d.oracle.setRegistrar(address(this));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        d.exchange.setKeepers(address(this), address(this));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        d.exchange.setReferralShare(0);
        vm.expectRevert(IReferrals.NotExchange.selector);
        d.referrals.setShareBps(0);
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
        assertEq(d.exchange.instrumentCount(), uint32(LaunchMarkets.COUNT));

        // Reading from the feed with that dead quote aborts on DOGE (index 12).
        cfg.launchPrices18 = new uint256[](0);
        vm.expectRevert(abi.encodeWithSelector(LaunchPriceZero.selector, uint32(12)));
        this.deployExternal(cfg);
    }

    /// @dev The mainnet path: Confetti, Tokenomics, Staking and PriceOracle already exist and
    ///      are not wired (a deploy that stopped after those creates). A config that names them
    ///      creates only the Exchange (which creates its Referrals), wires the four to it, adds
    ///      the launch markets and starts the handover on all five.
    function test_deploy_reusePath_createsOnlyTheExchange_wiresAndAddsMarkets() public {
        // The four contracts as the stopped deploy left them: owned by the deployer, unwired.
        Confetti c = new Confetti(address(this));
        Tokenomics t = new Tokenomics(
            address(this),
            DEFAULT_FLAT_THRESHOLD_USD,
            DEFAULT_TAIL_DECAY_SCALE_USD,
            DEFAULT_STAKER_CAP_USD,
            DEFAULT_FLAT_RATE_E18
        );
        Staking s = new Staking(address(this), address(c), address(usdc));
        PriceOracle o = new PriceOracle(source, address(this));
        assertEq(c.exchange(), address(0));
        assertEq(t.exchange(), address(0));
        assertEq(s.exchange(), address(0));
        assertEq(o.registrar(), address(0));

        address newOwner = makeAddr("newOwner");
        Config memory cfg = _config(newOwner);
        cfg.reuseConfetti = address(c);
        cfg.reuseTokenomics = address(t);
        cfg.reuseStaking = address(s);
        cfg.reuseOracle = address(o);
        vm.startStateDiffRecording();
        Deployment memory d = _deploy(cfg, address(this));
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        // Exactly two creates: the Exchange and, from its constructor, its Referrals. Everything
        // else is what the config named.
        uint256 creates;
        for (uint256 i = 0; i < accesses.length; i++) {
            if (accesses[i].kind != VmSafe.AccountAccessKind.Create) continue;
            creates++;
            assertTrue(
                accesses[i].account == address(d.exchange) || accesses[i].account == address(d.referrals),
                "created something besides the Exchange and its Referrals"
            );
        }
        assertEq(creates, 2, "exactly the Exchange and its Referrals are created");
        assertEq(address(d.source), address(source));
        assertEq(address(d.confetti), address(c));
        assertEq(address(d.tokenomics), address(t));
        assertEq(address(d.staking), address(s));
        assertEq(address(d.oracle), address(o));
        assertTrue(address(d.exchange) != address(ex));
        assertGt(address(d.exchange).code.length, 0);
        assertGt(address(d.referrals).code.length, 0);
        assertEq(d.referrals.exchange(), address(d.exchange));

        // The four now point at the new exchange, and it at them.
        assertEq(o.registrar(), address(d.exchange));
        assertEq(c.exchange(), address(d.exchange));
        assertEq(c.staking(), address(s));
        assertEq(t.exchange(), address(d.exchange));
        assertEq(s.exchange(), address(d.exchange));
        assertEq(s.tokenomics(), address(t));
        assertEq(d.exchange.usdc(), address(usdc));
        assertEq(d.exchange.oracle(), address(o));
        assertEq(d.exchange.confetti(), address(c));
        assertEq(d.exchange.tokenomics(), address(t));
        assertEq(d.exchange.staking(), address(s));
        assertEq(d.exchange.feeRecipient(), feeRecipient);
        assertEq(d.exchange.pauseGuardian(), guardian);
        assertEq(d.exchange.marketKeeper(), keeper);
        assertTrue(d.exchange.isKeeper(keeper));

        // All ten launch markets, mirrored into the reused oracle at the feed's launch mid.
        LaunchMarkets.Market[] memory ms = LaunchMarkets.all();
        assertEq(d.exchange.instrumentCount(), uint32(ms.length));
        assertEq(d.launchPrices18.length, ms.length);
        for (uint256 i = 0; i < ms.length; i++) {
            uint32 id = uint32(i);
            assertEq(d.exchange.instrument(id).hlAssetIndex, ms[i].hlAssetIndex, ms[i].name);
            assertEq(d.exchange.instrument(id).maxLeverage, ms[i].maxLeverage, ms[i].name);
            (uint32 asset, uint8 sz, uint16 clamp) = o.instrumentConfig(id);
            assertEq(asset, ms[i].hlAssetIndex, ms[i].name);
            assertEq(sz, ms[i].szDecimals, ms[i].name);
            assertEq(clamp, LaunchMarkets.clampBps(ms[i].tier), ms[i].name);
            assertEq(d.launchPrices18[i], o.rawMid(id), ms[i].name);
            assertEq(d.launchPrices18[i], launchPrices18[i], ms[i].name);
        }

        // The handover is the usual two-step on all five, the reused four included.
        assertEq(c.owner(), address(this));
        assertEq(t.owner(), address(this));
        assertEq(s.owner(), address(this));
        assertEq(o.owner(), address(this));
        assertEq(d.exchange.owner(), address(this));
        assertEq(c.pendingOwner(), newOwner);
        assertEq(t.pendingOwner(), newOwner);
        assertEq(s.pendingOwner(), newOwner);
        assertEq(o.pendingOwner(), newOwner);
        assertEq(d.exchange.pendingOwner(), newOwner);

        // The reused contracts serve the new exchange: a 1% DOGE loss at 10x mints through the
        // reused Confetti (basis 0.95 x 100/$ = 95 CONFETTI, 9.5 to the team) and tallies in
        // the reused Tokenomics.
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(d.exchange), 100e6);
        d.exchange.deposit(100e6);
        uint256 req = d.exchange.requestOpen(DOGE, true, 10e6, 10, address(0));
        vm.stopPrank();
        _tick();
        vm.prank(keeper);
        uint256 pid = d.exchange.executeOpen(req);
        source.setQuote(ms[0].hlAssetIndex, 84_150, 84_150, 84_150); // 85_000 - 1%
        vm.prank(alice);
        d.exchange.requestClose(pid);
        _tick();
        vm.prank(keeper);
        (uint256 paid,) = d.exchange.executeClose(pid);
        assertEq(paid, 9e6);
        assertEq(d.exchange.lpBalance(), 1e6);
        assertEq(d.exchange.feePool(), 50_000);
        assertEq(c.balanceOf(alice), 95e18);
        assertEq(c.balanceOf(feeRecipient), 9.5e18);
        assertEq(t.totalMinted(), 95e18);
        assertEq(t.trackedLpUsd(), 950_000);
        // The original system from setUp is untouched by any of this.
        assertEq(oracle.registrar(), address(ex));
        assertEq(confetti.exchange(), address(ex));
        assertEq(confetti.totalSupply(), 0);
    }

    /// @dev The reuse path works once: each contract wires in one shot and refuses a second
    ///      exchange, so a config that names an already-wired contract reverts on that contract
    ///      with its own error, before anything else changes. The oracle is wired first.
    function test_deploy_reusePath_revertsOnAlreadyWiredContracts() public {
        Config memory cfg = _config(address(this));
        cfg.reuseConfetti = address(confetti);
        cfg.reuseTokenomics = address(tok);
        cfg.reuseStaking = address(staking);
        cfg.reuseOracle = address(oracle);
        vm.expectRevert(IPriceOracle.RegistrarAlreadySet.selector);
        this.deployExternal(cfg);

        // One wired contract among fresh ones: each refuses with its own error.
        cfg = _config(address(this));
        cfg.reuseConfetti = address(confetti);
        vm.expectRevert(IConfetti.AlreadyWired.selector);
        this.deployExternal(cfg);
        cfg = _config(address(this));
        cfg.reuseTokenomics = address(tok);
        vm.expectRevert(ITokenomics.AlreadyWired.selector);
        this.deployExternal(cfg);
        cfg = _config(address(this));
        cfg.reuseStaking = address(staking);
        vm.expectRevert(IStaking.AlreadyWired.selector);
        this.deployExternal(cfg);

        // The wired set still points at the first exchange.
        assertEq(oracle.registrar(), address(ex));
        assertEq(confetti.exchange(), address(ex));
        assertEq(tok.exchange(), address(ex));
        assertEq(staking.exchange(), address(ex));
        assertEq(ex.instrumentCount(), uint32(LaunchMarkets.COUNT));
    }

    // ------------------------------------------------------------- settling

    function test_loss_mintsAtCurrentRate_andTalliesNetOfFee() public {
        uint256 id = _open(bob, DOGE, true, 100e6, 10);
        _moveBps(DOGE, -200);

        // loss = 1000 x 2% = 20; fee = 5% x 20 = 1; basis = 20 - 1 = 19.
        (uint256 loss, uint256 fee, uint256 basis) = _expectLoss(id);
        assertEq(loss, 20e6);
        assertEq(fee, 1e6);
        assertEq(basis, 19e6);
        uint256 rate = tok.currentRateE18();
        assertEq(rate, 100e18);
        (int256 pnl, uint256 pfee, uint256 ppayout) = ex.previewClose(id);
        assertEq(pnl, -20e6);
        assertEq(pfee, fee);
        assertEq(ppayout, 80e6);

        // 19 x 100 = 1,900 CONFETTI to bob; the team share 10% x 1,900 = 190 to the recipient.
        vm.prank(bob);
        ex.requestClose(id);
        _tick();
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true, address(ex));
        emit IExchange.TeamMinted(feeRecipient, 190e18);
        (uint256 paid, uint256 queued) = ex.executeClose(id);
        teamMintedGhost += 190e18;
        assertEq(paid, 80e6);
        assertEq(queued, 0);
        assertEq(ex.balanceOf(bob), FUNDING - 20e6);
        assertEq(ex.lpBalance(), 20e6);
        assertEq(ex.feePool(), 1e6);
        assertEq(tok.trackedLpUsd(), 19e6);
        assertEq(tok.tailProgressUsd(), 0);
        assertEq(confetti.balanceOf(bob), basis * rate / 1e6);
        assertEq(confetti.balanceOf(bob), 1900e18);
        assertEq(confetti.balanceOf(feeRecipient), 190e18);
        // Tokenomics' totalMinted is the trader's mint only; the supply carries the team share.
        assertEq(tok.totalMinted(), 1900e18);
        assertEq(confetti.totalSupply(), 2090e18);
        _assertConserved();
    }

    function test_liquidations_acrossTiers_mintOnFullMargin() public {
        // carol shorts FARTCOIN at 1000x with the tier A maximum notional ($25K): bust is a
        // 5 bps rise (the gap rule). One dollar more of margin is over the per-position cap.
        vm.prank(carol);
        vm.expectRevert(IExchange.PositionTooLarge.selector);
        ex.requestOpen(FARTCOIN, false, 26e6, 1000, address(0));
        uint256 cid = _open(carol, FARTCOIN, false, 25e6, 1000);
        uint256 entry = ex.positions(cid).entryPx18;
        assertEq(entry, 16_400 * 1e13); // szDecimals 1
        assertEq(ex.bustPrice(cid), entry * 10_005 / 10_000);

        _moveBps(FARTCOIN, 3); // +2.4 bps after the raw-tick floor: short of bust
        uint256 px = ex.execPrice(FARTCOIN, false, true);
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(IExchange.NotLiquidatable.selector, cid, px, ex.bustPrice(cid)));
        ex.liquidate(cid);

        _moveBps(FARTCOIN, 10);
        assertTrue(ImpactLib.isBusted(ex.execPrice(FARTCOIN, false, true), ex.bustPrice(cid), false));
        uint256 rate = tok.currentRateE18();
        // bounty = 0.5% x 25 = 0.125; fee = 5% x 25 = 1.25; LP cash = 25 - 0.125 = 24.875;
        // tally = 25 - 0.125 - 1.25 = 23.625. Mint on the full margin: 25 x 100 = 2,500,
        // team 250.
        uint256 bounty = _liquidate(liquidator, cid);
        assertEq(bounty, 125_000);
        assertEq(ex.balanceOf(liquidator), 125_000);
        assertEq(ex.balanceOf(carol), FUNDING - 25e6);
        assertEq(ex.marginInUse(carol), 0);
        assertEq(ex.feePool(), 1_250_000);
        assertEq(ex.lpBalance(), 24_875_000);
        assertEq(tok.trackedLpUsd(), 23_625_000);
        assertEq(confetti.balanceOf(carol), 25e6 * rate / 1e6);
        assertEq(confetti.balanceOf(carol), 2500e18);
        assertEq(confetti.balanceOf(feeRecipient), 250e18);
        (, uint256 shortOi) = ex.openInterest(FARTCOIN);
        assertEq(shortOi, 0);
        _assertConserved();

        // dave longs TRUMP (tier B, 250x) at its $10K cap: bust is a 38 bps drop. alice
        // liquidates. bounty 0.5% x 40 = 0.2; fee 5% x 40 = 2; LP cash +39.8; tally
        // +(40 - 0.2 - 2) = +37.8; mint 4,000, team 400.
        uint256 did = _open(dave, TRUMP, true, 40e6, 250);
        _moveBps(TRUMP, -40);
        assertEq(_liquidate(alice, did), 200_000);
        assertEq(ex.balanceOf(alice), FUNDING + 200_000);
        assertEq(ex.feePool(), 1_250_000 + 2_000_000);
        assertEq(ex.lpBalance(), 24_875_000 + 39_800_000);
        assertEq(tok.trackedLpUsd(), 23_625_000 + 37_800_000);
        assertEq(confetti.balanceOf(dave), 4000e18);
        assertEq(confetti.balanceOf(feeRecipient), 250e18 + 400e18);
        _assertConserved();

        // bob longs DOGE at 1000x: a 10 bps drop busts it. Mint 20 x 100 = 2,000, team 200.
        uint256 bid = _open(bob, DOGE, true, 20e6, 1000);
        _moveBps(DOGE, -10);
        assertTrue(ImpactLib.isBusted(ex.execPrice(DOGE, true, true), ex.bustPrice(bid), true));
        assertEq(_liquidate(liquidator, bid), 100_000);
        assertEq(confetti.balanceOf(bob), 2000e18);
        // Trader mints 2,500 + 4,000 + 2,000 = 8,500; with the team's 850 the supply is 9,350.
        assertEq(tok.totalMinted(), 8_500e18);
        assertEq(confetti.balanceOf(feeRecipient), 850e18);
        assertEq(confetti.totalSupply(), 9_350e18);
        _assertConserved();
    }

    function test_oracleOnly_bookPushNeverPays() public {
        // The launch-day vector: push Hyperliquid's own DOGE book 10% up. Mark follows the
        // book, the oracle price (external median) does not. The long closes on the unmoved
        // oracle: flat, nothing to collect.
        uint256 aid = _open(alice, DOGE, true, 25e6, 1000);
        uint32 asset = _asset(DOGE);
        uint64 raw = _raw(DOGE);
        uint64 pushed = uint64(uint256(raw) * 110 / 100);
        source.setQuote(asset, pushed, pushed, pushed, raw);
        assertEq(oracle.markPrice(DOGE), uint256(pushed) * 1e12);
        assertEq(oracle.rawMid(DOGE), uint256(pushed) * 1e12);
        assertEq(ex.execPrice(DOGE, true, false), launchPrices18[DOGE]);
        (int256 pnl, uint256 fee, uint256 payout) = ex.previewClose(aid);
        assertEq(pnl, 0);
        assertEq(fee, 0);
        assertEq(payout, 25e6);
        // Had the fill followed the book, the same push would have paid roughly 90x the margin.
        uint256 exit = ImpactLib.deadbandExit(uint256(pushed) * 1e12, true, 1);
        (uint256 gain, uint256 move) = ImpactLib.rawGain(25_000e6, launchPrices18[DOGE], exit, true);
        assertGt(ImpactLib.adjustedGain(gain, move, _curve(ex.instrument(DOGE))), 2_000e6);
        (uint256 paid, uint256 queued) = _close(alice, aid);
        assertEq(paid, 25e6);
        assertEq(queued, 0);
        _assertConserved();
    }

    function test_oracleOnly_bookPushNeverLiquidates() public {
        // A push against the position cannot liquidate: a 1000x long busts 5 bps under
        // entry; with the book 10% under and the oracle unmoved, the settlement price is the
        // oracle, still at entry.
        uint256 bid = _open(bob, DOGE, true, 25e6, 1000);
        uint32 asset = _asset(DOGE);
        uint64 raw = _raw(DOGE);
        uint64 dumped = uint64(uint256(raw) * 90 / 100);
        source.setQuote(asset, dumped, dumped, dumped, raw);
        assertEq(ex.execPrice(DOGE, true, true), launchPrices18[DOGE]);
        vm.prank(liquidator);
        vm.expectRevert(
            abi.encodeWithSelector(IExchange.NotLiquidatable.selector, bid, launchPrices18[DOGE], ex.bustPrice(bid))
        );
        ex.liquidate(bid);
        // The oracle 10 bps down (85_000 -> 84_915, under the 84_957.5 bust) is enough, book
        // or no book. Bounty 0.5% x 25 = 0.125.
        uint64 oracleDown = uint64(uint256(raw) * 9_990 / 10_000);
        source.setOraclePx(asset, oracleDown);
        assertEq(ex.execPrice(DOGE, true, true), uint256(oracleDown) * 1e12);
        assertTrue(ImpactLib.isBusted(uint256(oracleDown) * 1e12, ex.bustPrice(bid), true));
        assertEq(_liquidate(liquidator, bid), 125_000);
        _assertConserved();
    }

    /// @dev A request filed, then executed by anyone after the keeper window, fills at the
    ///      worse of the two prints on a live launch market with real decimals.
    function test_requestFlow_fallbackWorstOf_onLaunchMarket() public {
        // kPEPE (szDecimals 0, $0.007): a long requested at 7_000, the oracle at 6_930 (-1%)
        // when a stranger executes 8 s later: the fill is max(7_000, 6_930) = 7_000.
        vm.prank(alice);
        uint256 req = ex.requestOpen(KPEPE, true, 100e6, 10, address(0));
        _moveBps(KPEPE, -100);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(bob);
        uint256 id = ex.executeOpen(req);
        assertEq(ex.positions(id).entryPx18, 7_000 * 1e12);
        // The close requested at 6_930 with the oracle back at 7_000 by the fallback window
        // fills at min(6_930, 7_000) = 6_930: the loss the trader asked for, 1% of $1000 = $10
        // (fee 5% = 0.5, basis 9.5 -> 950 CONFETTI).
        vm.prank(alice);
        ex.requestClose(id);
        _setRaw(KPEPE, 7_000);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        uint256 mintedBefore = tok.totalMinted();
        vm.prank(carol);
        (uint256 paid,) = ex.executeClose(id);
        teamMintedGhost += (tok.totalMinted() - mintedBefore) * TEAM_SHARE_BPS / 10_000;
        assertEq(paid, 90e6);
        assertEq(ex.feePool(), 500_000);
        assertEq(confetti.balanceOf(alice), 950e18);
        _assertConserved();
    }

    function test_retireAtPrice_afterDelisting_releasesMargin() public {
        uint256 aid = _open(alice, DOGE, true, 100e6, 10);
        uint256 bid = _open(bob, DOGE, false, 50e6, 10);
        // Hyperliquid delists DOGE: the precompiles return zero for good.
        source.setQuote(_asset(DOGE), 0, 0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, DOGE));
        ex.requestClose(aid);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.ZeroPrice.selector, DOGE));
        ex.retire(DOGE);
        // The owner (behind the timelock in production) freezes the last known price.
        ex.retireAtPrice(DOGE, launchPrices18[DOGE]);
        assertTrue(ex.instrument(DOGE).retired);
        (uint256 paid, uint256 queued) = _close(alice, aid);
        assertEq(paid, 100e6);
        assertEq(queued, 0);
        (paid,) = _close(bob, bid);
        assertEq(paid, 50e6);
        assertEq(ex.marginInUse(alice) + ex.marginInUse(bob), 0);
        (uint256 l, uint256 s) = ex.openInterest(DOGE);
        assertEq(l + s, 0);
        _assertConserved();
    }

    function test_wins_paidFromLp_queuedWhenShort_drainedByHarvest_thenFeesPush() public {
        ex.setBreakerFloor(0); // this walkthrough checks the bare 10% share on small numbers
        // 1. bob's full loss seeds the LP: $100 cash, fee pool 5% x 100 = $5, tally $95.
        uint256 bid = _open(bob, DOGE, true, 100e6, 10);
        _moveBps(DOGE, -1000);
        _close(bob, bid);
        assertEq(ex.lpBalance(), 100e6);
        assertEq(ex.feePool(), 5e6);
        assertEq(tok.trackedLpUsd(), 95e6);

        // 2. alice wins 1% on kPEPE (tier B, 3 bps deadband): the LP pays in full.
        (uint256 adjusted, uint256 fee) = _aliceWinsPaidInFull();

        // 3. dave wins 2% on $25K of DOGE (the tier A position cap): far more than the LP
        //    holds -> paid what there is, the rest queued.
        (uint256 adjusted2, uint256 fee2, uint256 queued) = _daveWinsIntoTheQueue();
        assertEq(ex.feePool(), 5e6 + fee + fee2);
        assertEq(tok.trackedLpUsd(), 95e6 - int256(adjusted) - int256(adjusted2));
        _assertConserved();

        // 4. Nothing distributes while the queue is owed.
        vm.expectRevert(IExchange.NothingToPush.selector);
        ex.pushFees();
        vm.expectRevert(ITokenomics.NothingToSweep.selector);
        tok.pushStakerFees();

        // 5. carol loses her whole $1000 margin with the queue active: no fee carved, CONFETTI
        //    on the full loss, cash lands in the LP but is not paid out automatically.
        _carolLosesWhileQueued(queued);

        // 6. Anyone harvests: dave is paid in full and the queue empties.
        uint256 daveBefore = ex.balanceOf(dave);
        vm.prank(liquidator);
        (uint256 n, uint256 paidOut) = ex.harvest(10);
        assertEq(n, 1);
        assertEq(paidOut, queued);
        assertEq(ex.balanceOf(dave), daveBefore + queued);
        assertEq(ex.queueHead(), ex.queueLength());
        assertEq(ex.queuedTotal(), 0);
        assertEq(ex.lpBalance(), 1000e6 - queued);
        _assertConserved();

        // 7. Fees now push: at the launch setting of a 0% staker share everything goes to the
        //    recipient and Staking is never called; at 40% the split is 40 / 60.
        uint256 pool = ex.feePool();
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 0);
        assertEq(toRecipient, pool);
        assertEq(ex.feePool(), 0);
        assertEq(ex.balanceOf(feeRecipient), pool);
        assertEq(usdc.balanceOf(address(staking)), 0);
        assertEq(staking.totalRewardsUsdc(), 0);
        assertEq(ex.lpBalance(), 1000e6 - queued - pool);
        _assertConserved();

        ex.setStakerFeeShare(4000);
        uint256 eid = _open(bob, DOGE, true, 100e6, 10);
        _moveBps(DOGE, -200);
        (, uint256 lfee,) = _expectLoss(eid);
        _close(bob, eid);
        (toStakers, toRecipient) = ex.pushFees();
        assertEq(toStakers, lfee * 4000 / 10_000);
        assertEq(toRecipient, lfee - toStakers);
        assertEq(usdc.balanceOf(address(staking)), toStakers);
        assertEq(staking.carryUsdc(), toStakers); // held as carry, nobody is staked
        _assertConserved();
    }

    /// @dev Step 2 of the win test: a small win the LP can pay on the spot.
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
        assertEq(ex.lpBalance(), 100e6 - profit);
        assertEq(ex.feePool(), 5e6 + fee);
        assertEq(tok.trackedLpUsd(), 95e6 - int256(adjusted));
        assertEq(ex.queueLength(), 0);
        assertEq(confetti.balanceOf(alice), 0);
        _assertConserved();
    }

    /// @dev Step 3 of the win test: a win larger than LP cash, paid partly and queued.
    function _daveWinsIntoTheQueue() internal returns (uint256 adjusted, uint256 fee, uint256 queued) {
        uint256 did = _open(dave, DOGE, true, 250e6, 100);
        _moveBps(DOGE, 200);
        uint256 profit;
        (adjusted, fee, profit) = _expectWin(did);
        uint256 lpBefore = ex.lpBalance();
        assertGt(profit, lpBefore);
        uint256 paid;
        (paid, queued) = _close(dave, did);
        assertEq(paid, 250e6 + lpBefore);
        assertEq(queued, profit - lpBefore);
        assertEq(ex.balanceOf(dave), FUNDING + lpBefore);
        assertEq(ex.lpBalance(), 0);
        assertEq(ex.queueLength(), 1);
        assertEq(ex.queueHead(), 0);
        (address recipient, uint256 owed) = ex.queueEntry(0);
        assertEq(recipient, dave);
        assertEq(owed, queued);
        assertEq(ex.queuedTotal(), queued);
        // The window started at bob's loss with an empty LP; dave's win alone is more than the
        // $95 of LP gain before it, so with the floor at 0 the breaker trips and blocks opens
        // until cleared.
        assertTrue(ex.breakerTripped());
        vm.prank(carol);
        vm.expectRevert(IExchange.OpensPausedByBreaker.selector);
        ex.requestOpen(FARTCOIN, true, 10e6, 1, address(0));
    }

    /// @dev Step 5 of the win test: a full-margin loss while the queue is active.
    function _carolLosesWhileQueued(uint256 queued) internal {
        uint256 cid = _open(carol, FARTCOIN, true, 1000e6, 10);
        _moveBps(FARTCOIN, -1000);
        (uint256 loss, uint256 lfee, uint256 basis) = _expectLoss(cid);
        assertEq(loss, 1000e6);
        assertEq(lfee, 0);
        assertEq(basis, 1000e6);
        uint256 poolBefore = ex.feePool();
        uint256 teamBefore = confetti.balanceOf(feeRecipient);
        _close(carol, cid);
        assertEq(confetti.balanceOf(carol), 100_000e18);
        // The team share is minted while the queue is active too: 10% x 100,000.
        assertEq(confetti.balanceOf(feeRecipient), teamBefore + 10_000e18);
        assertEq(ex.lpBalance(), 1000e6);
        assertEq(ex.feePool(), poolBefore);
        assertEq(ex.queuedTotal(), queued);
        _assertConserved();
    }

    // ------------------------------------------------------------- referrals

    /// @dev A referred trader on the deployed system: the code resolves, the first executed
    ///      open locks the referrer, and 15% of a fee lands in the referrer's exchange balance
    ///      on the spot while the pool keeps 85%.
    function test_referral_codeResolves_lockAtFirstOpen_shareOnDeployedSystem() public {
        vm.prank(carol);
        refs.registerCode("carol_x");
        address referrer = refs.codeToReferrer("carol_x");
        assertEq(referrer, carol);

        uint256 id = _openReferred(alice, DOGE, true, 100e6, 10, referrer);
        assertEq(refs.referrerOf(alice), carol);
        assertTrue(refs.referrerLocked(alice));
        _moveBps(DOGE, -200);
        // loss 20, fee 1; share 15% = 0.15 to carol now; pool 0.85; mint basis still 19.
        (uint256 loss, uint256 fee, uint256 basis) = _expectLoss(id);
        assertEq(loss, 20e6);
        assertEq(fee, 1e6);
        assertEq(basis, 19e6);
        _close(alice, id);
        assertEq(ex.balanceOf(carol), FUNDING + 150_000);
        assertEq(ex.feePool(), 850_000);
        assertEq(ex.lpBalance(), 20e6 - 150_000);
        assertEq(tok.trackedLpUsd(), 19e6);
        assertEq(refs.referralEarned(carol), 150_000);
        assertEq(confetti.balanceOf(alice), 1900e18);
        _assertConserved();
        // Fees still push in full (the pool is the 85%).
        (uint256 a, uint256 b) = ex.pushFees();
        assertEq(a + b, 850_000);
        _assertConserved();
    }

    // ------------------------------------------------------------- staking

    function test_fees_flowToStakersAndRecipient_claimLandsInExchangeBalance() public {
        ex.setStakerFeeShare(4000);
        // bob and carol lose $20 and $40 on DOGE. Fees 5% x 20 = 1 and 5% x 40 = 2, $3 in all;
        // mints (20 - 1) x 100 = 1,900 and (40 - 2) x 100 = 3,800 CONFETTI.
        uint256 bid = _open(bob, DOGE, true, 100e6, 10);
        _moveBps(DOGE, -200);
        _close(bob, bid);
        uint256 cid = _open(carol, DOGE, true, 100e6, 10);
        _moveBps(DOGE, -400);
        _close(carol, cid);
        assertEq(confetti.balanceOf(bob), 1900e18);
        assertEq(confetti.balanceOf(carol), 3800e18);
        assertEq(confetti.balanceOf(feeRecipient), 190e18 + 380e18);
        assertEq(ex.feePool(), 3_000_000);

        // CONFETTI cannot move between holders, only to and from Staking.
        vm.prank(bob);
        vm.expectRevert(IConfetti.TransfersDisabled.selector);
        confetti.transfer(alice, 1);
        _stake(bob, 1900e18);
        _stake(carol, 3800e18);
        assertEq(staking.totalStaked(), 5700e18);
        assertEq(confetti.balanceOf(address(staking)), 5700e18);
        assertEq(confetti.balanceOf(bob), 0);

        // Push: 40% x 3 = $1.20 to stakers pro rata, 60% x 3 = $1.80 to the recipient's
        // exchange balance.
        (uint256 toStakers, uint256 toRecipient) = ex.pushFees();
        assertEq(toStakers, 1_200_000);
        assertEq(toRecipient, 1_800_000);
        assertEq(ex.balanceOf(feeRecipient), 1_800_000);
        assertEq(usdc.balanceOf(address(staking)), 1_200_000);
        // Pro rata by stake (1:2): 0.40 and 0.80. The accumulator floors, so each staker can be
        // one unit short; that dust stays in Staking (see Staking's reward notes).
        uint256 bobEarned = staking.earned(bob);
        uint256 carolEarned = staking.earned(carol);
        assertApproxEqAbs(bobEarned, 400_000, 1);
        assertApproxEqAbs(carolEarned, 800_000, 1);
        assertLe(bobEarned + carolEarned, 1_200_000);
        _assertConserved();

        // Claim moves USDC from Staking into bob's exchange balance, not his wallet.
        uint256 walletBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        assertEq(staking.claim(), bobEarned);
        assertEq(ex.balanceOf(bob), FUNDING - 20e6 + bobEarned);
        assertEq(usdc.balanceOf(bob), walletBefore);
        assertEq(usdc.balanceOf(address(staking)), 1_200_000 - bobEarned);
        assertEq(staking.earned(bob), 0);
        _assertConserved();

        // A second round of fees splits by the same stakes; unstaking keeps what was earned.
        uint256 aid = _open(alice, DOGE, true, 100e6, 10);
        _moveBps(DOGE, -100);
        (, uint256 fee,) = _expectLoss(aid);
        _close(alice, aid);
        (uint256 toStakers2,) = ex.pushFees();
        assertEq(toStakers2, fee * 4000 / 10_000);
        uint256 bobShare = staking.earned(bob);
        uint256 carolShare = staking.earned(carol) - carolEarned;
        assertLe(bobShare + carolShare, toStakers2);
        assertGe(bobShare + carolShare + 2, toStakers2); // at most one unit of dust each
        assertApproxEqAbs(carolShare, bobShare * 2, 2);

        vm.prank(carol);
        staking.unstake(3800e18);
        assertEq(confetti.balanceOf(carol), 3800e18);
        assertEq(staking.earned(carol), carolEarned + carolShare);
        vm.prank(carol);
        assertEq(staking.claim(), carolEarned + carolShare);
        assertEq(ex.balanceOf(carol), FUNDING - 40e6 + carolEarned + carolShare);
        _assertConserved();
    }

    function test_stakerOverflow_aboveCap_sweptToStakers() public {
        tok.setParams(100e6, 15_000_000e6, 300e6);

        // bob loses $20 and stakes his 1900 CONFETTI ((20 - 5% x 20) x 100); alice then loses a
        // whole $600 margin. Fees 1 + 5% x 600 = 31; tally 19 + 570 = 589; LP cash 620.
        uint256 bid = _open(bob, DOGE, true, 100e6, 10);
        _moveBps(DOGE, -200);
        _close(bob, bid);
        _stake(bob, 1900e18);
        uint256 aid = _open(alice, FARTCOIN, true, 600e6, 10);
        _moveBps(FARTCOIN, -1000);
        _close(alice, aid);
        assertEq(ex.lpBalance(), 620e6);
        assertEq(ex.feePool(), 31e6);
        assertEq(tok.trackedLpUsd(), 589e6);
        // Overflow above the $300 cap: 589 - 300 = 289. Tail progress: the part of the tally
        // above the $100 threshold, 589 - 100 = 489.
        assertEq(tok.stakerOverflowUsd(), 289e6);
        uint256 progressBefore = tok.tailProgressUsd();
        assertEq(progressBefore, 489e6);

        // Anyone sweeps the overflow; it lands in Staking and bob, the only staker, earns it all.
        vm.prank(liquidator);
        uint256 swept = tok.pushStakerFees();
        assertEq(swept, 289e6);
        assertEq(tok.trackedLpUsd(), 300e6);
        assertEq(tok.tailProgressUsd(), progressBefore);
        assertEq(ex.lpBalance(), 620e6 - 289e6);
        assertEq(usdc.balanceOf(address(staking)), 289e6);
        assertEq(staking.totalRewardsUsdc(), 289e6);
        uint256 bobEarned = staking.earned(bob); // sole staker, less at most one unit of dust
        assertApproxEqAbs(bobEarned, 289e6, 1);
        _assertConserved();

        vm.expectRevert(ITokenomics.NothingToSweep.selector);
        tok.pushStakerFees();

        vm.prank(bob);
        assertEq(staking.claim(), bobEarned);
        assertEq(ex.balanceOf(bob), FUNDING - 20e6 + bobEarned);

        // Fees were never part of the tally, so they still push after the sweep.
        (uint256 a, uint256 b) = ex.pushFees();
        assertEq(a + b, 31e6);
        assertEq(ex.lpBalance(), 300e6);
        assertEq(tok.trackedLpUsd(), 300e6);
        _assertConserved();
    }

    // ----------------------------------------------------------- tokenomics

    function test_tailRegion_reachedAfterEnoughLosses_decaysMintRate() public {
        tok.setParams(1_000e6, 10_000e6, 2_000e6);
        uint256 s = 10_000e6;

        // Two $600 full-margin losses: 600 - 5% x 600 = $570 each net of fee. The first stays
        // in the flat region, the second crosses the $1000 threshold by 1140 - 1000 = $140.
        uint256 aid = _open(alice, DOGE, true, 600e6, 10);
        _moveBps(DOGE, -1000);
        _close(alice, aid);
        assertEq(tok.trackedLpUsd(), 570e6);
        assertEq(tok.currentRateE18(), 100e18);
        assertEq(tok.tailProgressUsd(), 0);
        assertEq(confetti.balanceOf(alice), 57_000e18);

        uint256 bid = _open(bob, FARTCOIN, true, 600e6, 10);
        _moveBps(FARTCOIN, -1000);
        _close(bob, bid);
        assertEq(tok.trackedLpUsd(), 1140e6);
        assertEq(tok.tailProgressUsd(), 140e6);
        assertEq(confetti.balanceOf(bob), 57_000e18); // minted at the rate before this loss
        // 100 x (10000 / 10140)^2 = 97.26 CONFETTI per $1.
        uint256 decayed = 100e18 * s * s / ((s + 140e6) * (s + 140e6));
        assertEq(tok.currentRateE18(), decayed);
        assertLt(decayed, 100e18);
        assertGt(decayed, 97e18);

        // carol's $100 loss mints at the decayed rate and advances the tail by its full basis
        // 100 - 5% x 100 = 95.
        uint256 cid = _open(carol, VIRTUAL, true, 100e6, 10);
        _moveBps(VIRTUAL, -1000);
        (uint256 loss, uint256 fee, uint256 basis) = _expectLoss(cid);
        assertEq(loss, 100e6);
        assertEq(fee, 5e6);
        assertEq(basis, 95e6);
        uint256 expectedMint = basis * decayed / 1e6;
        uint256 teamBefore = confetti.balanceOf(feeRecipient);
        _close(carol, cid);
        assertEq(confetti.balanceOf(carol), expectedMint);
        assertLt(expectedMint, 9500e18);
        // At a decayed rate the mint is not a multiple of 10 wei: 95 x 97.257721290493252259 =
        // 9239.483522596858964605, so the team share 923.9483522596858964605 is floored to
        // ...460.
        assertEq(expectedMint, 9_239_483_522_596_858_964_605);
        assertEq(confetti.balanceOf(feeRecipient) - teamBefore, 923_948_352_259_685_896_460);
        assertEq(tok.tailProgressUsd(), 140e6 + 95e6);
        assertEq(tok.trackedLpUsd(), 1235e6);
        assertEq(ex.feePool(), 30e6 + 30e6 + fee);
        _assertConserved();

        // dave's win pulls the tally back under the threshold (it needs an adjusted gain over
        // 1235 - 1000 = $235): the rate is flat again, but the tail progress is kept for when
        // the LP recovers.
        uint256 did = _open(dave, WIF, true, 200e6, 100);
        _moveBps(WIF, 300);
        (uint256 adjusted,, uint256 profit) = _expectWin(did);
        assertGt(adjusted, 235e6);
        assertLt(profit, ex.lpBalance());
        _close(dave, did);
        assertLt(tok.trackedLpUsd(), 1_000e6);
        assertEq(tok.currentRateE18(), 100e18);
        assertEq(tok.tailProgressUsd(), 140e6 + 95e6);
        _assertConserved();
    }

    // -------------------------------------------------------- multi-trader

    function test_multiTrader_scriptedSequenceAcrossMarkets_staysConserved() public {
        uint256 seed = 7;
        uint256 opens;
        uint256 closes;
        uint256 liquidations;
        for (uint256 step = 0; step < 80; step++) {
            seed = uint256(keccak256(abi.encode(seed)));
            uint32 id = uint32(seed % LaunchMarkets.COUNT);
            address t = traders[(seed >> 8) % traders.length];
            uint8 action = uint8((seed >> 16) % 5);
            uint256[] memory mine = ex.positionIdsOf(t);

            if (action == 0 || (action == 2 && mine.length == 0)) {
                // Under $50 at up to 200x: notional stays under the $10K tier B position cap.
                uint128 margin = uint128(10e6 + (seed >> 32) % 40e6);
                uint32 lev = uint32(1 + (seed >> 96) % 200);
                _open(t, id, (seed >> 24) % 2 == 0, margin, lev);
                opens++;
            } else if (action == 1) {
                int256 bps = int256((seed >> 40) % 150);
                _moveBps(id, (seed >> 56) % 2 == 0 ? bps : -bps);
            } else if (action == 2) {
                _close(t, mine[(seed >> 64) % mine.length]);
                closes++;
            } else if (action == 3) {
                for (uint256 i = 0; i < mine.length; i++) {
                    IExchange.Position memory pos = ex.positions(mine[i]);
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
                try tok.pushStakerFees() {} catch {}
            }
            _assertConserved();
        }
        assertGt(opens, 10);
        assertGt(closes, 5);
        assertGt(liquidations, 0);
        emit log_named_uint("opens", opens);
        emit log_named_uint("closes", closes);
        emit log_named_uint("liquidations", liquidations);
        emit log_named_uint("confetti minted", tok.totalMinted());
    }
}

/*//////////////////////////////////////////////////////////////////////////
                                invariants
//////////////////////////////////////////////////////////////////////////*/

/// @dev Random, bounded actions against the full system, through the request / execute /
///      cancel path with time warps. Every function keeps its inputs legal so a revert means a
///      real bug, which lets the invariant run with fail-on-revert.
contract Handler is Test {
    Exchange immutable ex;
    MockUSDC immutable usdc;
    MockPriceSource immutable source;
    PriceOracle immutable oracle;
    Confetti immutable confetti;
    Tokenomics immutable tok;
    Staking immutable staking;
    Referrals immutable refs;
    address immutable keeper;
    address immutable guardian;
    uint32 immutable marketCount;

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
    uint256 public ghostDepositedUsdc;
    uint256 public ghostWithdrawnUsdc;
    /// @dev Sum over this handler's mints of floor(trader mint x 10%), the expected team share.
    uint256 public ghostTeamMinted;
    mapping(bytes32 => uint256) public calls;

    constructor(
        Exchange ex_,
        MockUSDC usdc_,
        MockPriceSource source_,
        PriceOracle oracle_,
        Confetti confetti_,
        Tokenomics tok_,
        Staking staking_,
        address keeper_,
        address guardian_,
        address[] memory actors_
    ) {
        ex = ex_;
        usdc = usdc_;
        source = source_;
        oracle = oracle_;
        confetti = confetti_;
        tok = tok_;
        staking = staking_;
        refs = Referrals(ex_.referrals());
        keeper = keeper_;
        guardian = guardian_;
        actors = actors_;
        marketCount = ex_.instrumentCount();
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
        ghostDepositedUsdc += amount;
        calls["deposit"]++;
    }

    function withdraw(uint256 a, uint256 amount) external {
        address who = _actor(a);
        uint256 bal = ex.balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(who);
        ex.withdraw(amount);
        ghostWithdrawnUsdc += amount;
        calls["withdraw"]++;
    }

    // ------------------------------------------------------------- trading

    /// @dev File an open request within every rule as of now; the rules are re-checked at
    ///      execution, where a failure is a refund, not a revert. Every other actor is named as
    ///      referrer now and then so the referral share is exercised.
    function requestOpen(uint256 a, uint32 id, bool isLong, uint256 margin, uint256 lev, uint256 r) external {
        id = uint32(bound(id, 0, marketCount - 1));
        address who = _actor(a);
        uint256 bal = ex.balanceOf(who);
        if (bal < 10e6) return;
        IExchange.Instrument memory inst = ex.instrument(id);
        if (inst.retired || inst.opensPaused || ex.globalOpensPaused()) return;
        margin = bound(margin, 10e6, bal < 2_000e6 ? bal : 2_000e6);
        lev = bound(lev, 1, inst.maxLeverage);

        (uint256 longOi, uint256 shortOi) = ex.openInterest(id);
        uint256 cap = isLong ? inst.longOiCapUsd : inst.shortOiCapUsd;
        uint256 used = isLong ? longOi : shortOi;
        uint256 headroom = cap > used ? cap - used : 0;
        uint256 limit = headroom < inst.maxNotionalUsd ? headroom : inst.maxNotionalUsd;
        if (margin * lev > limit) {
            lev = limit / margin;
            if (lev == 0) return;
        }
        if (ex.breakerTripped()) {
            vm.prank(guardian);
            ex.clearBreaker();
            calls["clearBreaker"]++;
        }
        address referrer = r % 3 == 0 ? _actor(r >> 8) : address(0);

        vm.prank(who);
        openReqs.push(ex.requestOpen(id, isLong, uint128(margin), uint32(lev), referrer));
        calls["requestOpen"]++;
    }

    /// @dev Step to a point in a pending request's life and act as the windows allow: the
    ///      keeper in the grace window, any actor afterwards, a cancel past expiry. A refund at
    ///      execution (a rule or the jump guard) is a normal outcome.
    function executeOpen(uint256 i, uint256 dt, uint256 a) external {
        if (openReqs.length == 0) return;
        i %= openReqs.length;
        uint256 req = openReqs[i];
        IExchange.OpenRequest memory r = ex.openRequest(req);
        uint256 elapsed = _warpInto(r.requestedAt, dt);
        if (elapsed > EXPIRY) {
            vm.prank(_actor(a));
            ex.cancelOpen(req);
            calls["cancelOpen"]++;
        } else {
            if (ex.breakerTripped()) {
                vm.prank(guardian);
                ex.clearBreaker();
                calls["clearBreaker"]++;
            }
            vm.prank(elapsed < DELAY + GRACE ? keeper : _actor(a));
            uint256 pid = ex.executeOpen(req);
            if (pid != 0) {
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

    /// @dev Same windows as `executeOpen`. A request whose position was liquidated since is
    ///      gone (`UnknownRequest`); that is the only revert this path ever sees.
    function executeClose(uint256 i, uint256 dt, uint256 a) external {
        if (closeReqs.length == 0) return;
        i %= closeReqs.length;
        uint256 pid = closeReqs[i];
        IExchange.CloseRequest memory r = ex.closeRequest(pid);
        if (r.requestedAt == 0) {
            // Voided by a liquidation: the close path has nothing to act on.
            try ex.executeClose(pid) returns (uint256, uint256) {
                revert("voided close executed");
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), IExchange.UnknownRequest.selector);
            }
            try ex.cancelClose(pid) {
                revert("voided close cancelled");
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), IExchange.UnknownRequest.selector);
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
            uint256 mintedBefore = tok.totalMinted();
            vm.prank(elapsed < DELAY + GRACE ? keeper : _actor(a));
            ex.executeClose(pid);
            _recordTeamShare(mintedBefore);
            _dropOpen(pid);
            calls["executeClose"]++;
        }
        _dropCloseReq(i);
    }

    function liquidate(uint256 p, uint256 a) external {
        if (openIds.length == 0) return;
        uint256 pid = openIds[p % openIds.length];
        // Liquidatable once the oracle price is past bust, pending close or not. When the
        // random pick is not busted, take a busted position with a pending close instead, so
        // the close path meets a voided request (`voidedClose`) within the walk: the
        // born-busted refund thins the 1000x positions a walk books in the fallback window.
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
        uint256 mintedBefore = tok.totalMinted();
        vm.prank(_actor(a));
        ex.liquidate(pid);
        _recordTeamShare(mintedBefore);
        _dropOpen(pid);
        calls["liquidate"]++;
    }

    /// @dev Whether a live position is at or past bust (a position gone since is not).
    function _busted(uint256 pid) internal view returns (bool) {
        IExchange.Position memory pos = ex.positions(pid);
        if (pos.owner == address(0)) return false;
        return ImpactLib.isBusted(ex.execPrice(pos.instrumentId, pos.isLong, true), ex.bustPrice(pid), pos.isLong);
    }

    /// @dev The guardian pauses a market's opens, or the owner resumes them: a request pending
    ///      on a paused market is refunded at execution.
    function togglePause(uint32 id) external {
        id = uint32(bound(id, 0, marketCount - 1));
        if (ex.instrument(id).opensPaused) {
            vm.prank(ex.owner());
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
        ex.harvest(bound(n, 1, 8));
        calls["harvest"]++;
    }

    function pushFees() external {
        try ex.pushFees() {
            calls["pushFees"]++;
        } catch {}
    }

    function pushStakerFees() external {
        try tok.pushStakerFees() {
            calls["pushStakerFees"]++;
        } catch {}
    }

    // ------------------------------------------------------------- staking

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

    // ------------------------------------------------------------ internals

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

    /// @dev A close or liquidation mints at most once; its team share is 10% of that mint,
    ///      floored.
    function _recordTeamShare(uint256 mintedBefore) internal {
        ghostTeamMinted += (tok.totalMinted() - mintedBefore) * 1000 / 10_000;
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

    function setUp() public override {
        super.setUp();
        handler = new Handler(ex, usdc, source, oracle, confetti, tok, staking, keeper, guardian, actors);

        bytes4[] memory selectors = new bytes4[](16);
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
        selectors[10] = Handler.pushStakerFees.selector;
        selectors[11] = Handler.stake.selector;
        selectors[12] = Handler.unstake.selector;
        selectors[13] = Handler.claim.selector;
        selectors[14] = Handler.executeOpen.selector; // weighted: requests must get filled
        selectors[15] = Handler.togglePause.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Deterministic drive of the handler through every action, checking the invariants
    ///      after each call, and proof that each path (request, keeper and fallback fills,
    ///      refunds, expiry cancels, a close voided by a liquidation, harvest, fee push, sweep,
    ///      staking) was actually reached. The staker cap is lowered so sweeps happen.
    function test_handlerReachesEveryPath_andInvariantsHold() public {
        tok.setParams(100e6, 15_000_000e6, 1_000e6);
        uint256 seed = 42;
        for (uint256 i = 0; i < 1500; i++) {
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 k = seed % 17;
            uint256 a = seed >> 8;
            uint256 b = seed >> 72;
            uint256 c = seed >> 136;
            if (k == 0) {
                handler.deposit(a, b);
            } else if (k == 1) {
                handler.withdraw(a, b);
            } else if (k == 16) {
                handler.togglePause(uint32(a));
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
                handler.pushFees();
                handler.pushStakerFees();
            } else if (k == 14) {
                handler.stake(a, b);
            } else {
                handler.unstake(a, b);
                handler.claim(a);
            }
            invariant_exchangeCashEqualsItsBuckets();
            invariant_tallyEqualsLpMinusClaims();
            invariant_confettiSupplyEqualsMinted();
            if (i % 50 == 0) {
                invariant_stakingHoldsWhatItOwes();
                invariant_queueAndOpenInterestMatchTheirEntries();
                invariant_pendingMarginMatchesOpenRequests();
                invariant_noUsdcLeaks();
            }
        }
        // Random trading with 1000x wins keeps the LP short and the queue live, which correctly
        // gates fee pushes and sweeps. Settle it the way the design expects: whole-margin losses
        // refill the LP, harvest drains the queue, then fees push and the overflow sweeps.
        _settleQueue();
        handler.pushFees();
        handler.pushStakerFees();
        invariant_exchangeCashEqualsItsBuckets();
        invariant_tallyEqualsLpMinusClaims();
        invariant_confettiSupplyEqualsMinted();
        invariant_stakingHoldsWhatItOwes();
        invariant_queueAndOpenInterestMatchTheirEntries();
        invariant_pendingMarginMatchesOpenRequests();
        invariant_noUsdcLeaks();
        assertTrue(_queueEmpty(), "queue not drained");
        assertEq(ex.feePool(), 0, "fees not pushed");
        assertLe(tok.trackedLpUsd(), int256(1_000e6), "overflow not swept");
        string[20] memory paths = [
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
            "pushFees",
            "pushStakerFees",
            "stake",
            "unstake",
            "claim"
        ];
        for (uint256 i = 0; i < paths.length; i++) {
            uint256 n = handler.calls(bytes32(bytes(paths[i])));
            emit log_named_uint(paths[i], n);
            assertGt(n, 0, paths[i]);
        }
    }

    /// @dev Feed the LP with whole-margin losses (on whichever side has OI headroom) and harvest
    ///      until the queue is empty, LP cash covers the fee pool and the tally sits well above
    ///      the $1000 staker cap set by the coverage test.
    function _settleQueue() internal {
        for (uint256 guard = 0; guard < 60; guard++) {
            bool done = _queueEmpty() && ex.lpBalance() >= ex.feePool() && tok.trackedLpUsd() >= int256(1_500e6);
            if (done) return;
            (uint32 id, bool isLong, uint256 headroom) = _mostHeadroom();
            uint256 maxNotional = ex.instrument(id).maxNotionalUsd;
            uint256 room = headroom < maxNotional ? headroom : maxNotional;
            uint128 margin = uint128(room / 10 < 5_000e6 ? room / 10 : 5_000e6);
            if (margin < 10e6) margin = 10e6;
            handler.deposit(0, margin); // actor 0 is alice; keeps the handler's mint ledger exact
            uint256 pid = _open(alice, id, isLong, margin, room / 10 < 10e6 ? 1 : 10);
            _moveBps(id, isLong ? int256(-1500) : int256(1500)); // 15% against a 10x position
            _close(alice, pid);
            if (!_queueEmpty()) ex.harvest(100);
        }
        revert("could not settle the queue");
    }

    function _mostHeadroom() internal view returns (uint32 best, bool isLong, uint256 headroom) {
        for (uint32 id = 0; id < LaunchMarkets.COUNT; id++) {
            IExchange.Instrument memory inst = ex.instrument(id);
            (uint256 l, uint256 s) = ex.openInterest(id);
            uint256 longRoom = inst.longOiCapUsd > l ? inst.longOiCapUsd - l : 0;
            uint256 shortRoom = inst.shortOiCapUsd > s ? inst.shortOiCapUsd - s : 0;
            if (longRoom > headroom) (best, isLong, headroom) = (id, true, longRoom);
            if (shortRoom > headroom) (best, isLong, headroom) = (id, false, shortRoom);
        }
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_exchangeCashEqualsItsBuckets() public view {
        uint256 claims =
            ex.lpBalance() + ex.balanceOf(feeRecipient) + ex.marginInUse(feeRecipient) + ex.pendingOf(feeRecipient);
        for (uint256 i = 0; i < actors.length; i++) {
            claims += ex.balanceOf(actors[i]) + ex.marginInUse(actors[i]) + ex.pendingOf(actors[i]);
        }
        assertEq(usdc.balanceOf(address(ex)), claims, "exchange cash != available + margins + pending + lp");
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_tallyEqualsLpMinusClaims() public view {
        assertEq(
            tok.trackedLpUsd(),
            int256(ex.lpBalance()) - int256(ex.feePool()) - int256(ex.queuedTotal()),
            "tally != lp - fees - queue"
        );
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_confettiSupplyEqualsMinted() public view {
        // supply == trader mints + sum of floor(10% x mint); the team share is never staked or
        // moved here, so it is exactly the fee recipient's balance.
        _assertConfettiSupply();
        assertEq(confetti.balanceOf(address(staking)), staking.totalStaked(), "staked != held");
    }

    function _otherTeamMinted() internal view override returns (uint256) {
        return handler.ghostTeamMinted();
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_stakingHoldsWhatItOwes() public view {
        uint256 owed = staking.carryUsdc();
        for (uint256 i = 0; i < actors.length; i++) {
            owed += staking.earned(actors[i]);
        }
        uint256 held = usdc.balanceOf(address(staking));
        assertLe(owed, held, "staking owes more than it holds");
        assertEq(held + handler.ghostClaimedUsdc(), staking.totalRewardsUsdc(), "rewards != held + claimed");
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_queueAndOpenInterestMatchTheirEntries() public view {
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
        for (uint256 i = 0; i < n; i++) {
            IExchange.Position memory pos = ex.positions(handler.openIds(i));
            assertTrue(pos.owner != address(0), "tracked position is gone");
            uint256 notional = uint256(pos.marginUsdc) * pos.leverage;
            if (pos.isLong) longOi[pos.instrumentId] += notional;
            else shortOi[pos.instrumentId] += notional;
            margins += pos.marginUsdc;
        }
        // Pending requests reserve no OI and no margin in use.
        for (uint32 id = 0; id < LaunchMarkets.COUNT; id++) {
            (uint256 l, uint256 s) = ex.openInterest(id);
            assertEq(l, longOi[id], "long OI");
            assertEq(s, shortOi[id], "short OI");
        }
        uint256 inUse;
        for (uint256 i = 0; i < actors.length; i++) {
            inUse += ex.marginInUse(actors[i]);
        }
        assertEq(inUse, margins, "margin in use != open positions");
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_pendingMarginMatchesOpenRequests() public view {
        uint256 n = handler.openReqCount();
        uint256 pending;
        for (uint256 i = 0; i < n; i++) {
            IExchange.OpenRequest memory r = ex.openRequest(handler.openReqs(i));
            assertTrue(r.trader != address(0), "tracked request is gone");
            pending += r.marginUsdc;
        }
        uint256 held;
        for (uint256 i = 0; i < actors.length; i++) {
            held += ex.pendingOf(actors[i]);
        }
        assertEq(held, pending, "pending margin != open requests");
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUsdcLeaks() public view {
        uint256 wallets = usdc.balanceOf(feeRecipient);
        for (uint256 i = 0; i < actors.length; i++) {
            wallets += usdc.balanceOf(actors[i]);
        }
        assertEq(
            usdc.totalSupply(), usdc.balanceOf(address(ex)) + usdc.balanceOf(address(staking)) + wallets, "usdc leaked"
        );
        assertEq(usdc.totalSupply(), FUNDING * traders.length + handler.ghostDepositedUsdc(), "mint ledger");
    }
}
