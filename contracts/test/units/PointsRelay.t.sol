// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {PointsRelay} from "../../src/PointsRelay.sol";

/// @title PointsRelayTest
/// @notice The relay only emits an event: the event carries the signer, the receiver and the amount,
///         and the three bad inputs revert. The balance rules live in the indexer, not here.
contract PointsRelayTest is Test {
    PointsRelay relay;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        relay = new PointsRelay();
    }

    function test_transfer_emitsFromSender() public {
        vm.expectEmit(true, true, false, true, address(relay));
        emit PointsRelay.PointsTransfer(alice, bob, 1234);
        vm.prank(alice);
        relay.sendPoints(bob, 1234);
    }

    function test_transfer_emitsEveryCall() public {
        vm.recordLogs();
        vm.startPrank(alice);
        relay.sendPoints(bob, 1);
        relay.sendPoints(bob, 1);
        relay.sendPoints(makeAddr("carol"), type(uint256).max);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        for (uint256 i; i < logs.length; i++) {
            assertEq(logs[i].emitter, address(relay));
            assertEq(logs[i].topics[0], PointsRelay.PointsTransfer.selector);
            assertEq(address(uint160(uint256(logs[i].topics[1]))), alice);
        }
        assertEq(abi.decode(logs[2].data, (uint256)), type(uint256).max);
    }

    function test_transfer_revertsOnZeroAddress() public {
        vm.prank(alice);
        vm.expectRevert(bytes("bad transfer"));
        relay.sendPoints(address(0), 1);
    }

    function test_transfer_revertsOnSelf() public {
        vm.prank(alice);
        vm.expectRevert(bytes("bad transfer"));
        relay.sendPoints(alice, 1);
    }

    function test_transfer_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(bytes("bad transfer"));
        relay.sendPoints(bob, 0);
    }

    function testFuzz_transfer_anyValidInput(address from, address to, uint256 amount) public {
        vm.assume(from != to && to != address(0) && amount > 0);
        vm.expectEmit(true, true, false, true, address(relay));
        emit PointsRelay.PointsTransfer(from, to, amount);
        vm.prank(from);
        relay.sendPoints(to, amount);
    }

    function test_hasNoStorageOrOwner() public view {
        // the deployed runtime is the one function and the event: nothing to pause, nothing to own
        assertLt(address(relay).code.length, 400);
    }
}
