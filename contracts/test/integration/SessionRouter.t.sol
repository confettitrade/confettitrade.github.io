// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IntegrationBase} from "./Integration.t.sol";
import {IExchange} from "../../src/interfaces/IExchange.sol";
import {IExchangeTypes} from "../../src/interfaces/IExchangeTypes.sol";
import {ISessionRouter} from "../../src/interfaces/ISessionRouter.sol";
import {ImpactLib} from "../../src/lib/ImpactLib.sol";

/// @dev Session-key trading on the deployed v4 system: the router files requests for the
///      trader that authorized the key, the fills keep the keeper-first windows, and the key
///      can do nothing else.
contract SessionRouterTest is IntegrationBase {
    uint256 keyPk = uint256(keccak256("aliceKey"));
    address key = vm.addr(keyPk);
    uint256 bobKeyPk = uint256(keccak256("bobKey"));
    address bobKey = vm.addr(bobKeyPk);
    uint128 constant CAP = 500e6;
    address stranger = makeAddr("stranger");

    /// @dev The key's consent: its EIP-191 signature over the router's authorization digest.
    function _sig(uint256 pk, address trader, uint64 expiry, uint128 cap, address referrer)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = router.authorizationDigest(trader, vm.addr(pk), expiry, cap, referrer);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v);
    }

    function _authorizeRef(address trader, uint256 pk, uint64 expiry, address referrer) internal {
        bytes memory sig = _sig(pk, trader, expiry, CAP, referrer);
        vm.prank(trader);
        router.authorize(vm.addr(pk), expiry, CAP, referrer, sig);
    }

    function _authorize(address trader, uint256 pk, uint64 expiry) internal {
        _authorizeRef(trader, pk, expiry, address(0));
    }

    function _day() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp() + 1 days);
    }

    // ------------------------------------------------------------- authorize

    function test_authorize_bindsKey_forwardsGas() public {
        vm.deal(alice, 1 ether);
        uint64 expiry = _day();
        // The digest the key signs, as the site computes it.
        assertEq(
            router.authorizationDigest(alice, key, expiry, CAP, address(0)),
            keccak256(abi.encode(block.chainid, address(router), alice, key, expiry, CAP, address(0)))
        );
        bytes memory sig = _sig(keyPk, alice, expiry, CAP, address(0));
        vm.expectEmit(true, true, false, true);
        emit ISessionRouter.SessionAuthorized(alice, key, expiry, CAP, address(0), 0.01 ether);
        vm.prank(alice);
        router.authorize{value: 0.01 ether}(key, expiry, CAP, address(0), sig);

        assertEq(key.balance, 0.01 ether);
        assertEq(address(router).balance, 0);
        assertEq(alice.balance, 0.99 ether);
        ISessionRouter.Session memory s = router.sessionOf(alice);
        assertEq(s.key, key);
        assertEq(s.expiry, expiry);
        assertEq(s.maxMarginPerTrade, CAP);
        assertEq(s.referrer, address(0));
        assertEq(router.traderOf(key), alice);
        assertEq(router.MAX_SESSION(), 30 days);
    }

    function test_authorize_rejectsBadInput() public {
        uint64 nowTs = uint64(vm.getBlockTimestamp());
        bytes memory none;
        vm.startPrank(alice);
        vm.expectRevert(ISessionRouter.ZeroAddress.selector);
        router.authorize(address(0), _day(), CAP, address(0), none);
        vm.expectRevert(abi.encodeWithSelector(ISessionRouter.BadExpiry.selector, nowTs));
        router.authorize(key, nowTs, CAP, address(0), none);
        vm.expectRevert(abi.encodeWithSelector(ISessionRouter.BadExpiry.selector, nowTs + 30 days + 1));
        router.authorize(key, nowTs + 30 days + 1, CAP, address(0), none);
        vm.expectRevert(ISessionRouter.ZeroMarginCap.selector);
        router.authorize(key, _day(), 0, address(0), none);
        vm.stopPrank();
        _authorize(alice, keyPk, nowTs + 30 days); // the longest session is allowed

        // A key serves one trader, even with its own signature for the second one.
        bytes memory sig = _sig(keyPk, bob, _day(), CAP, address(0));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ISessionRouter.KeyInUse.selector, key));
        router.authorize(key, _day(), CAP, address(0), sig);
    }

    /// @dev Review fix 4: binding needs the key's own signature over this exact binding, so a
    ///      stranger cannot squat the address a trader is about to authorize: the stranger's
    ///      own signature, alice's signature (made for alice, not the stranger), a signature
    ///      over other terms and garbage all revert, and alice's binding then goes through.
    function test_authorize_onlyTheKeyHolderCanBind_squatReverts() public {
        uint64 expiry = _day();
        uint256 strangerPk = uint256(keccak256("stranger"));
        bytes memory aliceSig = _sig(keyPk, alice, expiry, CAP, address(0));
        bytes memory strangerSig = _sig(strangerPk, stranger, expiry, CAP, address(0));

        vm.startPrank(stranger);
        vm.expectRevert(ISessionRouter.BadKeySignature.selector);
        router.authorize(key, expiry, CAP, address(0), strangerSig);
        vm.expectRevert(ISessionRouter.BadKeySignature.selector);
        router.authorize(key, expiry, CAP, address(0), aliceSig);
        vm.expectRevert(ISessionRouter.BadKeySignature.selector);
        router.authorize(key, expiry, CAP, address(0), new bytes(65));
        vm.stopPrank();
        assertEq(router.traderOf(key), address(0));

        // The key's signature covers every term: alice cannot stretch the cap or the expiry.
        vm.startPrank(alice);
        vm.expectRevert(ISessionRouter.BadKeySignature.selector);
        router.authorize(key, expiry, CAP + 1, address(0), aliceSig);
        vm.expectRevert(ISessionRouter.BadKeySignature.selector);
        router.authorize(key, expiry + 1, CAP, address(0), aliceSig);
        vm.expectRevert(ISessionRouter.BadKeySignature.selector);
        router.authorize(key, expiry, CAP, dave, aliceSig);
        router.authorize(key, expiry, CAP, address(0), aliceSig);
        vm.stopPrank();
        assertEq(router.traderOf(key), alice);
    }

    /// @dev The gas top-up must reach the key; a key that refuses HYPE (an EOA with delegated
    ///      code, emulated by etching a reverting body on it) fails the authorize.
    function test_authorize_revertsWhenTheKeyRefusesGas() public {
        uint256 refuserPk = uint256(keccak256("refuser"));
        address refuser = vm.addr(refuserPk);
        vm.etch(refuser, hex"5f5ffd"); // PUSH0 PUSH0 REVERT
        uint64 expiry = _day();
        bytes memory sig = _sig(refuserPk, alice, expiry, CAP, address(0));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(ISessionRouter.GasForwardFailed.selector);
        router.authorize{value: 1}(refuser, expiry, CAP, address(0), sig);
        vm.prank(alice);
        router.authorize(refuser, expiry, CAP, address(0), sig); // nothing to forward: fine
        assertEq(router.traderOf(refuser), alice);
    }

    /// @dev Re-authorizing replaces the session: the old key stops at once.
    function test_authorize_replacesTheOldKey() public {
        _authorize(alice, keyPk, _day());
        uint256 key2Pk = uint256(keccak256("aliceKey2"));
        address key2 = vm.addr(key2Pk);
        vm.expectEmit(true, true, false, true);
        emit ISessionRouter.SessionRevoked(alice, key);
        _authorize(alice, key2Pk, _day());
        assertEq(router.traderOf(key), address(0));
        assertEq(router.traderOf(key2), alice);
        vm.prank(key);
        vm.expectRevert(ISessionRouter.NoSession.selector);
        router.requestOpen(DOGE, true, 100e6, 10);
    }

    function test_revoke_endsTheSession() public {
        vm.prank(alice);
        vm.expectRevert(ISessionRouter.NoSession.selector);
        router.revoke();
        _authorize(alice, keyPk, _day());
        vm.expectEmit(true, true, false, true);
        emit ISessionRouter.SessionRevoked(alice, key);
        vm.prank(alice);
        router.revoke();
        assertEq(router.sessionOf(alice).key, address(0));
        vm.prank(key);
        vm.expectRevert(ISessionRouter.NoSession.selector);
        router.requestOpen(DOGE, true, 100e6, 10);
    }

    // -------------------------------------------------------------- referrer

    /// @dev Review fix 3: the wallet names the referrer in `authorize`, and the key's first
    ///      open locks it like a wallet open would. Named bob first, re-authorized with dave
    ///      before any open: dave is what the open carries and what gets locked (both own a
    ///      code, which a v4 referrer must, S11). With a 5% loss fee and no DOGE entry spread, a
    ///      2% DOGE loss on 100 x 10 is $20, its fee $1, and dave is credited 15% of it, $0.15.
    ///      After the lock a re-authorize naming bob changes the session but not the locked
    ///      referrer.
    function test_sessionOpen_locksTheWalletChosenReferrer_creditsOnClose() public {
        _classicFees();
        vm.prank(bob);
        refs.registerCode("bob_ref");
        vm.prank(dave);
        refs.registerCode("dave_ref");
        _authorizeRef(alice, keyPk, _day(), bob);
        assertEq(router.sessionOf(alice).referrer, bob);
        vm.expectEmit(true, true, false, true);
        emit ISessionRouter.SessionAuthorized(alice, key, _day(), CAP, dave, 0);
        _authorizeRef(alice, keyPk, _day(), dave);
        assertEq(router.sessionOf(alice).referrer, dave);

        vm.prank(key);
        uint256 req = router.requestOpen(DOGE, true, 100e6, 10);
        assertEq(ex.openRequest(req).referrer, dave);
        _tick();
        vm.prank(keeper);
        uint256 pid = ex.executeOpen(req);
        assertTrue(refs.referrerLocked(alice));
        assertEq(refs.referrerOf(alice), dave);

        _moveBps(DOGE, -200);
        vm.prank(key);
        router.requestClose(pid);
        _tick();
        vm.prank(keeper);
        ex.executeClose(pid);
        assertEq(refs.referralEarned(dave), 0.15e6);
        assertEq(ex.balanceOf(dave), FUNDING + 0.15e6);

        _authorizeRef(alice, keyPk, _day(), bob);
        assertEq(router.sessionOf(alice).referrer, bob);
        _setRaw(DOGE, rawLaunch[DOGE]);
        vm.prank(key);
        req = router.requestOpen(DOGE, true, 100e6, 10);
        _tick();
        vm.prank(keeper);
        ex.executeOpen(req);
        assertEq(refs.referrerOf(alice), dave);
    }

    /// @dev Only the wallet picks the referrer: the key's open has no referrer input, and the
    ///      key authorizing on its own account binds a session for itself, never for alice. A
    ///      wallet naming itself is stored as none, and its first open locks none.
    function test_session_keyCannotSetReferrer_selfReferralIgnored() public {
        vm.expectEmit(true, true, false, true);
        emit ISessionRouter.SessionAuthorized(alice, key, _day(), CAP, address(0), 0);
        _authorizeRef(alice, keyPk, _day(), alice);
        assertEq(router.sessionOf(alice).referrer, address(0));

        // The key signs up a second key under its own account, naming stranger: that session
        // belongs to the key, and alice's stays as it was.
        uint256 key2Pk = uint256(keccak256("aliceKey2"));
        _authorizeRef(key, key2Pk, _day(), stranger);
        assertEq(router.traderOf(vm.addr(key2Pk)), key);
        assertEq(router.sessionOf(key).referrer, stranger);
        assertEq(router.sessionOf(alice).referrer, address(0));
        assertEq(router.traderOf(key), alice);

        vm.prank(key);
        uint256 req = router.requestOpen(DOGE, true, 100e6, 10);
        assertEq(ex.openRequest(req).trader, alice);
        assertEq(ex.openRequest(req).referrer, address(0));
        _tick();
        vm.prank(keeper);
        ex.executeOpen(req);
        assertTrue(refs.referrerLocked(alice));
        assertEq(refs.referrerOf(alice), address(0));
    }

    // ----------------------------------------------------------------- trade

    /// @dev Open and close through the key: the request is alice's (her balance, her pending
    ///      margin, no referrer), only the keeper fills in the grace window, and the position
    ///      and its payout are alice's. The price never moves, so the close gives back only the
    ///      1 bps entry spread.
    function test_sessionTrade_openAndCloseForTheTrader_keeperFirst() public {
        _authorize(alice, keyPk, _day());
        uint256 p0 = ex.execPrice(DOGE, true, true);
        vm.prank(key);
        uint256 req = router.requestOpen(DOGE, true, 100e6, 10);
        IExchangeTypes.OpenRequest memory r = ex.openRequest(req);
        assertEq(r.trader, alice);
        assertEq(r.referrer, address(0));
        assertEq(r.px0, p0);
        assertEq(ex.balanceOf(alice), FUNDING - 100e6);
        assertEq(ex.pendingOf(alice), 100e6);
        assertEq(ex.pendingOf(key), 0);

        _tick();
        vm.prank(stranger);
        vm.expectRevert(IExchangeTypes.KeeperWindow.selector);
        ex.executeOpen(req);
        vm.prank(keeper);
        uint256 pid = ex.executeOpen(req);
        assertEq(ex.positions(pid).owner, alice);
        assertEq(ex.positions(pid).entryPx18, p0 * 10_001 / 10_000);
        assertEq(ex.marginInUse(alice), 100e6);

        vm.prank(key);
        router.requestClose(pid);
        assertEq(ex.closeRequest(pid).px0, p0);
        _tick();
        uint256 spreadLoss = ImpactLib.cappedLoss(1_000e6, 100e6, ex.positions(pid).entryPx18, p0, true);
        assertGt(spreadLoss, 0);
        vm.prank(keeper);
        (uint256 paid,) = ex.executeClose(pid);
        assertEq(paid, 100e6 - spreadLoss);
        assertEq(ex.balanceOf(alice), FUNDING - spreadLoss);
        assertEq(ex.balanceOf(key), 0);
        _assertConserved();
    }

    /// @dev A session request falls to the worse-of fallback like any other: kPEPE long at
    ///      7,000 raw, the oracle 1% up at 7,070 when a stranger fills 8 s later: the long
    ///      books max(7,000, 7,070) = 7,070 (szDecimals 0: 7,070e12), entered 3 bps higher.
    function test_sessionTrade_fallbackFillIsWorseOf() public {
        _authorize(alice, keyPk, _day());
        vm.prank(key);
        uint256 req = router.requestOpen(KPEPE, true, 100e6, 10);
        _setRaw(KPEPE, 7_070);
        vm.warp(vm.getBlockTimestamp() + DELAY + GRACE);
        vm.prank(stranger);
        uint256 pid = ex.executeOpen(req);
        assertEq(ex.positions(pid).entryPx18, 7_070e12 * 10_003 / 10_000);
        assertEq(ex.positions(pid).owner, alice);
    }

    function test_sessionTrade_marginCapAndExpiry() public {
        uint64 expiry = _day();
        _authorize(alice, keyPk, expiry);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(ISessionRouter.MarginAboveSessionCap.selector, CAP + 1, CAP));
        router.requestOpen(DOGE, true, CAP + 1, 10);
        vm.prank(key);
        router.requestOpen(DOGE, true, CAP, 10); // at the cap is fine

        vm.warp(expiry); // the last second still works
        vm.prank(key);
        router.requestOpen(DOGE, true, 10e6, 10);
        vm.warp(uint256(expiry) + 1);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(ISessionRouter.SessionExpired.selector, expiry));
        router.requestOpen(DOGE, true, 10e6, 10);
    }

    /// @dev The Exchange's own rules still apply to the trader through the router.
    function test_sessionTrade_exchangeRulesBubble() public {
        _authorize(alice, keyPk, _day());
        vm.prank(key);
        vm.expectRevert(IExchangeTypes.MarginBelowMinimum.selector);
        router.requestOpen(DOGE, true, 5e6 - 1, 10);
        vm.prank(key);
        vm.expectRevert(IExchangeTypes.LeverageOutOfRange.selector);
        router.requestOpen(TRUMP, true, 100e6, 251);
    }

    /// @dev Expired requests cancel through the key, for the trader's own requests only.
    function test_sessionCancel_ownRequestsOnly() public {
        _authorize(alice, keyPk, _day());
        _authorize(bob, bobKeyPk, _day());
        vm.prank(key);
        uint256 req = router.requestOpen(DOGE, true, 100e6, 10);
        vm.prank(bobKey);
        uint256 bobReq = router.requestOpen(DOGE, true, 100e6, 10);
        uint256 pid = _open(alice, DOGE, false, 100e6, 10);
        vm.prank(key);
        router.requestClose(pid);

        vm.warp(vm.getBlockTimestamp() + EXPIRY + 1);
        vm.prank(key);
        vm.expectRevert(ISessionRouter.NotYours.selector);
        router.cancelOpen(bobReq);
        vm.prank(bobKey);
        vm.expectRevert(ISessionRouter.NotYours.selector);
        router.cancelClose(pid);

        vm.prank(key);
        router.cancelOpen(req);
        assertEq(ex.pendingOf(alice), 0);
        vm.prank(key);
        router.cancelClose(pid);
        assertEq(ex.closeRequest(pid).requestedAt, 0);
        assertEq(ex.balanceOf(alice), FUNDING - 100e6); // the short is still open
        _assertConserved();
    }

    // ------------------------------------------------------------- isolation

    /// @dev A key acts for its own trader only and never with their money outside a request.
    function test_isolation_keyCannotActForOthersOrMoveFunds() public {
        _authorize(alice, keyPk, _day());
        uint256 bobPid = _open(bob, DOGE, true, 100e6, 10);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotPositionOwner.selector, bobPid, alice));
        router.requestClose(bobPid);

        // Straight to the Exchange the key is just an empty account.
        vm.startPrank(key);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 0, 1));
        ex.withdraw(1);
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 0, 100e6));
        ex.requestOpen(DOGE, true, 100e6, 10, address(0));
        vm.expectRevert(abi.encodeWithSelector(IExchangeTypes.NotPositionOwner.selector, bobPid, key));
        ex.requestClose(bobPid);
        vm.stopPrank();
        assertEq(ex.balanceOf(alice), FUNDING);
    }

    /// @dev Only the router's calls carry an appended trader: anyone else appending alice's
    ///      address to `requestOpen` / `requestClose` still acts for themselves.
    function test_isolation_appendedTraderIgnoredUnlessRouter() public {
        uint256 alicePid = _open(alice, DOGE, true, 100e6, 10);
        bytes memory open = abi.encodePacked(
            abi.encodeCall(IExchange.requestOpen, (DOGE, true, uint128(100e6), uint32(10), address(0))), alice
        );
        vm.prank(stranger);
        (bool ok, bytes memory ret) = address(ex).call(open);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IExchangeTypes.InsufficientBalance.selector, 0, 100e6));

        bytes memory close = abi.encodePacked(abi.encodeCall(IExchange.requestClose, (alicePid)), alice);
        vm.prank(stranger);
        (ok, ret) = address(ex).call(close);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IExchangeTypes.NotPositionOwner.selector, alicePid, stranger));
        assertEq(ex.pendingOf(alice), 0);
        assertEq(ex.closeRequest(alicePid).requestedAt, 0);
    }
}
