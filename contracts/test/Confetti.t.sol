// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Confetti} from "../src/Confetti.sol";
import {IConfetti} from "../src/interfaces/IConfetti.sol";

contract ConfettiTest is Test {
    Confetti internal token;

    address internal owner = address(this);
    address internal exchange = makeAddr("exchange");
    address internal staking = makeAddr("staking");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new Confetti(owner);
    }

    function _wire() internal {
        token.wire(exchange, staking);
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(exchange);
        token.mint(to, amount);
    }

    // ------------------------------------------------------------- metadata

    function test_metadata() public view {
        assertEq(token.name(), "Confetti");
        assertEq(token.symbol(), "CONFETTI");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 0);
        assertEq(token.owner(), owner);
        assertFalse(token.transfersEnabled());
        assertEq(token.exchange(), address(0));
        assertEq(token.staking(), address(0));
    }

    // --------------------------------------------------------------- wiring

    function test_wire_setsAddressesAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit IConfetti.Wired(exchange, staking);
        _wire();
        assertEq(token.exchange(), exchange);
        assertEq(token.staking(), staking);
    }

    function test_wire_revertsSecondTime() public {
        _wire();
        vm.expectRevert(IConfetti.AlreadyWired.selector);
        token.wire(exchange, staking);
    }

    function test_wire_revertsOnZeroAddress() public {
        vm.expectRevert(IConfetti.ZeroAddress.selector);
        token.wire(address(0), staking);
        vm.expectRevert(IConfetti.ZeroAddress.selector);
        token.wire(exchange, address(0));
    }

    function test_wire_revertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.wire(exchange, staking);
    }

    // -------------------------------------------------------------- minting

    function test_mint_byExchange() public {
        _wire();
        _mint(alice, 1_000e18);
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(token.totalSupply(), 1_000e18);
    }

    function test_mint_revertsForNonExchange() public {
        _wire();
        vm.prank(alice);
        vm.expectRevert(IConfetti.NotExchange.selector);
        token.mint(alice, 1e18);

        // The owner is not the minter either.
        vm.expectRevert(IConfetti.NotExchange.selector);
        token.mint(alice, 1e18);
    }

    function test_mint_revertsBeforeWiring() public {
        vm.prank(exchange);
        vm.expectRevert(IConfetti.NotExchange.selector);
        token.mint(alice, 1e18);
    }

    // ---------------------------------------------------- transfer gating

    function test_transfer_betweenHoldersBlocked() public {
        _wire();
        _mint(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(IConfetti.TransfersDisabled.selector);
        token.transfer(bob, 10e18);
        assertEq(token.balanceOf(alice), 100e18);
    }

    function test_transfer_toStakingAllowed() public {
        _wire();
        _mint(alice, 100e18);
        vm.prank(alice);
        token.transfer(staking, 40e18);
        assertEq(token.balanceOf(alice), 60e18);
        assertEq(token.balanceOf(staking), 40e18);
    }

    function test_transfer_fromStakingAllowed() public {
        _wire();
        _mint(staking, 100e18);
        vm.prank(staking);
        token.transfer(alice, 25e18);
        assertEq(token.balanceOf(alice), 25e18);
        assertEq(token.balanceOf(staking), 75e18);
    }

    function test_transferFrom_followsSameRule() public {
        _wire();
        _mint(alice, 100e18);
        vm.startPrank(alice);
        token.approve(bob, 100e18);
        token.approve(staking, 100e18);
        vm.stopPrank();

        // Pulling to a plain holder is blocked ...
        vm.prank(bob);
        vm.expectRevert(IConfetti.TransfersDisabled.selector);
        token.transferFrom(alice, bob, 10e18);

        // ... pulling into Staking (what Staking.stake does) is fine.
        vm.prank(staking);
        token.transferFrom(alice, staking, 10e18);
        assertEq(token.balanceOf(staking), 10e18);
        assertEq(token.balanceOf(alice), 90e18);
    }

    function test_transfer_blockedBeforeWiring() public {
        // An unwired token has no exemption address at all, so even a zero-value transfer
        // towards the future Staking address is refused before any balance check.
        vm.prank(alice);
        vm.expectRevert(IConfetti.TransfersDisabled.selector);
        token.transfer(staking, 0);
    }

    function test_transfer_toZeroStillRejectedByERC20() public {
        _wire();
        _mint(staking, 10e18);
        vm.prank(staking);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.transfer(address(0), 1e18);
    }

    // ---------------------------------------------------- enableTransfers

    function test_enableTransfers_opensTransfers() public {
        _wire();
        _mint(alice, 100e18);

        vm.expectEmit(false, false, false, true);
        emit IConfetti.TransfersEnabled();
        token.enableTransfers();
        assertTrue(token.transfersEnabled());

        vm.prank(alice);
        token.transfer(bob, 30e18);
        assertEq(token.balanceOf(bob), 30e18);
        assertEq(token.balanceOf(alice), 70e18);
    }

    function test_enableTransfers_revertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.enableTransfers();
    }

    function test_enableTransfers_isOneWayAndIdempotent() public {
        token.enableTransfers();
        // A second call changes nothing and emits nothing.
        vm.recordLogs();
        token.enableTransfers();
        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(token.transfersEnabled());
    }

    function test_mint_stillExchangeOnlyAfterEnable() public {
        _wire();
        token.enableTransfers();
        vm.prank(alice);
        vm.expectRevert(IConfetti.NotExchange.selector);
        token.mint(alice, 1e18);
    }
}
