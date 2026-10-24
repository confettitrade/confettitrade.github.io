// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Referrals} from "../../src/Referrals.sol";
import {IReferrals} from "../../src/interfaces/IReferrals.sol";

/// @title ReferralsTest
/// @notice The registry on its own, with this contract standing in as the Exchange: code
///         rules, the one-shot referrer lock, the fee tally and the access rules. The USDC flows
///         the Exchange builds on `onFee` are covered in Exchange.t.sol.
contract ReferralsTest is Test {
    Referrals refs;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.expectEmit(false, false, false, true);
        emit IReferrals.ReferralShareSet(1500);
        refs = new Referrals(address(this), IReferrals(address(0)));
    }

    function test_constructor_defaults() public view {
        assertEq(refs.exchange(), address(this));
        assertEq(refs.referralShareBps(), 1500);
        assertEq(refs.MAX_SHARE_BPS(), 5000);
        assertEq(refs.DEFAULT_SHARE_BPS(), 1500);
        assertEq(refs.MIN_CODE_LENGTH(), 3);
        assertEq(refs.MAX_CODE_LENGTH(), 16);
        assertEq(refs.referrerOf(alice), address(0));
        assertFalse(refs.referrerLocked(alice));
        assertEq(refs.codeToReferrer("abc"), address(0));
        assertEq(bytes(refs.codeOf(alice)).length, 0);
        assertEq(refs.v3Referrals(), address(0));
    }

    function test_registerCode_lengthAndCharset() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IReferrals.InvalidCode.selector, "ab"));
        refs.registerCode("ab");
        vm.expectRevert(abi.encodeWithSelector(IReferrals.InvalidCode.selector, ""));
        refs.registerCode("");
        vm.expectRevert(abi.encodeWithSelector(IReferrals.InvalidCode.selector, "abcdefghijklmnopq"));
        refs.registerCode("abcdefghijklmnopq"); // 17
        vm.expectRevert(abi.encodeWithSelector(IReferrals.InvalidCode.selector, "ABC"));
        refs.registerCode("ABC"); // upper case
        vm.expectRevert(abi.encodeWithSelector(IReferrals.InvalidCode.selector, "a-b"));
        refs.registerCode("a-b");
        vm.expectRevert(abi.encodeWithSelector(IReferrals.InvalidCode.selector, "a b"));
        refs.registerCode("a b");
        vm.expectRevert(abi.encodeWithSelector(IReferrals.InvalidCode.selector, "ab."));
        refs.registerCode("ab.");
        vm.expectRevert(abi.encodeWithSelector(IReferrals.InvalidCode.selector, unicode"abé"));
        refs.registerCode(unicode"abé");
        // The edges: 3 and 16 characters, digits and underscores anywhere.
        vm.expectEmit(false, true, false, true);
        emit IReferrals.ReferralCodeRegistered("a_1", alice);
        refs.registerCode("a_1");
        vm.stopPrank();
        vm.prank(bob);
        refs.registerCode("0123456789abcd_z");
        vm.prank(carol);
        refs.registerCode("___");
        assertEq(refs.codeToReferrer("a_1"), alice);
        assertEq(refs.codeToReferrer("0123456789abcd_z"), bob);
        assertEq(refs.codeToReferrer("___"), carol);
        assertEq(refs.codeOf(alice), "a_1");
        assertEq(refs.codeOf(bob), "0123456789abcd_z");
    }

    function test_registerCode_uniqueAndOncePerAddress() public {
        vm.prank(alice);
        refs.registerCode("confetti");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IReferrals.CodeTaken.selector, "confetti"));
        refs.registerCode("confetti");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IReferrals.AlreadyRegistered.selector, alice));
        refs.registerCode("another");
        assertEq(refs.codeOf(alice), "confetti");
        assertEq(refs.codeToReferrer("another"), address(0));
        // Case matters only in that upper case is invalid: "Confetti" is not the same code.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IReferrals.InvalidCode.selector, "Confetti"));
        refs.registerCode("Confetti");
    }

    function test_lockReferrer_onlyExchange_once_selfIsNone() public {
        vm.prank(bob);
        refs.registerCode("bobby");
        vm.prank(carol);
        refs.registerCode("carol");
        vm.prank(stranger);
        vm.expectRevert(IReferrals.NotExchange.selector);
        refs.lockReferrer(alice, bob);

        vm.expectEmit(true, true, false, true);
        emit IReferrals.ReferrerSet(alice, bob);
        refs.lockReferrer(alice, bob);
        assertEq(refs.referrerOf(alice), bob);
        assertTrue(refs.referrerLocked(alice));
        // A second lock is ignored, whatever it names.
        refs.lockReferrer(alice, carol);
        refs.lockReferrer(alice, address(0));
        assertEq(refs.referrerOf(alice), bob);

        // Self is none, and locks.
        vm.expectEmit(true, true, false, true);
        emit IReferrals.ReferrerSet(carol, address(0));
        refs.lockReferrer(carol, carol);
        assertTrue(refs.referrerLocked(carol));
        assertEq(refs.referrerOf(carol), address(0));
        refs.lockReferrer(carol, bob);
        assertEq(refs.referrerOf(carol), address(0));
    }

    /// @dev A referrer must own a code: an address without one locks "none", for good, even if
    ///      it registers a code afterwards.
    function test_lockReferrer_referrerWithoutCodeLocksNone() public {
        vm.expectEmit(true, true, false, true);
        emit IReferrals.ReferrerSet(alice, address(0));
        refs.lockReferrer(alice, bob);
        assertTrue(refs.referrerLocked(alice));
        assertEq(refs.referrerOf(alice), address(0));
        vm.prank(bob);
        refs.registerCode("bobby");
        refs.lockReferrer(alice, bob);
        assertEq(refs.referrerOf(alice), address(0));
        (address referrer, uint256 share) = refs.onFee(alice, 1_000_000);
        assertEq(referrer, address(0));
        assertEq(share, 0);
        assertEq(refs.referralEarned(bob), 0);
        // A trader locking after the registration does get bob.
        refs.lockReferrer(carol, bob);
        assertEq(refs.referrerOf(carol), bob);
    }

    function test_onFee_onlyExchange_talliesShare_dustPaysNothing() public {
        vm.prank(bob);
        refs.registerCode("bobby");
        vm.prank(stranger);
        vm.expectRevert(IReferrals.NotExchange.selector);
        refs.onFee(alice, 1000);

        // Unreferred: nothing.
        (address referrer, uint256 share) = refs.onFee(alice, 1_000_000);
        assertEq(referrer, address(0));
        assertEq(share, 0);

        refs.lockReferrer(alice, bob);
        // 15% of 1.000000 = 0.150000.
        vm.expectEmit(true, true, false, true);
        emit IReferrals.ReferralPaid(bob, alice, 150_000);
        (referrer, share) = refs.onFee(alice, 1_000_000);
        assertEq(referrer, bob);
        assertEq(share, 150_000);
        assertEq(refs.referralEarned(bob), 150_000);
        // 15% of 7 units = 1.05 -> 1; of 6 = 0.9 -> 0, no event, no tally.
        (, share) = refs.onFee(alice, 7);
        assertEq(share, 1);
        vm.recordLogs();
        (referrer, share) = refs.onFee(alice, 6);
        assertEq(referrer, bob);
        assertEq(share, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(refs.referralEarned(bob), 150_001);
        // The share follows the live setting.
        refs.setShareBps(5000);
        (, share) = refs.onFee(alice, 1_000_000);
        assertEq(share, 500_000);
        refs.setShareBps(0);
        (, share) = refs.onFee(alice, 1_000_000);
        assertEq(share, 0);
        assertEq(refs.referralEarned(bob), 650_001);
    }

    function test_setShareBps_onlyExchange_bounds_event() public {
        vm.prank(stranger);
        vm.expectRevert(IReferrals.NotExchange.selector);
        refs.setShareBps(100);
        vm.expectRevert(abi.encodeWithSelector(IReferrals.ShareOutOfBounds.selector, uint16(5001)));
        refs.setShareBps(5001);
        vm.expectEmit(false, false, false, true);
        emit IReferrals.ReferralShareSet(5000);
        refs.setShareBps(5000);
        assertEq(refs.referralShareBps(), 5000);
        refs.setShareBps(0);
        assertEq(refs.referralShareBps(), 0);
    }
}

/// @title ReferralsV3CarryOverTest
/// @notice v4 registry built on a v3 registry (a second `Referrals` standing in for v3, with
///         this contract as the exchange of both): v3 codes resolve and cannot be retaken, a
///         v3 lock carries over on the first v4 open, and v4 earnings start from zero.
contract ReferralsV3CarryOverTest is Test {
    Referrals v3;
    Referrals refs;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    function setUp() public {
        v3 = new Referrals(address(this), IReferrals(address(0)));
        vm.prank(bob);
        v3.registerCode("bobv3");
        vm.prank(carol);
        v3.registerCode("carolv3");
        // On v3: alice locked to bob and earned bob something; dave locked "none".
        v3.lockReferrer(alice, bob);
        v3.onFee(alice, 1_000_000);
        v3.lockReferrer(dave, address(0));
        refs = new Referrals(address(this), IReferrals(address(v3)));
    }

    function test_v3CodesResolveAndCannotBeRetaken() public {
        assertEq(refs.v3Referrals(), address(v3));
        assertEq(refs.codeToReferrer("bobv3"), bob);
        assertEq(refs.codeOf(bob), "bobv3");
        // Nobody can take a v3 code on v4.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IReferrals.CodeTaken.selector, "bobv3"));
        refs.registerCode("bobv3");
        // A v3 code owner already has their code: no second one on v4.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IReferrals.AlreadyRegistered.selector, bob));
        refs.registerCode("bobv4");
        // A fresh code on v4 resolves from v4, and v3 does not see it.
        vm.prank(alice);
        refs.registerCode("alicev4");
        assertEq(refs.codeToReferrer("alicev4"), alice);
        assertEq(v3.codeToReferrer("alicev4"), address(0));
        assertEq(refs.codeToReferrer("nobody"), address(0));
    }

    /// @dev alice locked to bob on v3: before any v4 open the views already show it, and the
    ///      first v4 open locks bob whatever referrer the v4 request names.
    function test_v3LockCarriesOverOnFirstOpen() public {
        assertTrue(refs.referrerLocked(alice));
        assertEq(refs.referrerOf(alice), bob);

        vm.prank(alice);
        refs.registerCode("alicev4");
        vm.expectEmit(true, true, false, true);
        emit IReferrals.ReferrerSet(alice, bob);
        refs.lockReferrer(alice, carol);
        assertEq(refs.referrerOf(alice), bob);
        refs.lockReferrer(alice, carol);
        assertEq(refs.referrerOf(alice), bob);

        // v4 fees pay bob; v4 earnings count v4 fees only (v3's tally is not imported).
        assertEq(v3.referralEarned(bob), 150_000);
        assertEq(refs.referralEarned(bob), 0);
        (address referrer, uint256 share) = refs.onFee(alice, 2_000_000);
        assertEq(referrer, bob);
        assertEq(share, 300_000);
        assertEq(refs.referralEarned(bob), 300_000);
    }

    /// @dev A v3 "none" lock carries over as none: the v4 request cannot add a referrer.
    function test_v3NoneLockCarriesOver() public {
        assertTrue(refs.referrerLocked(dave));
        refs.lockReferrer(dave, carol);
        assertTrue(refs.referrerLocked(dave));
        assertEq(refs.referrerOf(dave), address(0));
        (address referrer,) = refs.onFee(dave, 1_000_000);
        assertEq(referrer, address(0));
    }

    /// @dev A trader with no v3 lock is free on v4; a v3 code owner counts as a referrer.
    function test_unlockedOnV3_locksFreshOnV4() public {
        address eve = makeAddr("eve");
        assertFalse(refs.referrerLocked(eve));
        assertEq(refs.referrerOf(eve), address(0));
        refs.lockReferrer(eve, carol); // carol's code lives on v3 only
        assertEq(refs.referrerOf(eve), carol);
        // The v3 registry is never written by v4.
        assertFalse(v3.referrerLocked(eve));
        // An address with no code on either registry locks none.
        address frank = makeAddr("frank");
        refs.lockReferrer(frank, makeAddr("codeless"));
        assertTrue(refs.referrerLocked(frank));
        assertEq(refs.referrerOf(frank), address(0));
    }
}
