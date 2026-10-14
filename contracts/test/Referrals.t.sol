// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Referrals} from "../src/Referrals.sol";
import {IReferrals} from "../src/interfaces/IReferrals.sol";

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
        refs = new Referrals(address(this));
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

    function test_onFee_onlyExchange_talliesShare_dustPaysNothing() public {
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
