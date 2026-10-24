// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title StubExchange
/// @notice Minimal stand-in for the Exchange, covering only what the deposit proxy calls:
///         `usdc()` (the factory reads it) and `depositFor` (the proxy's last step), with the
///         credited balances readable through `balanceOf`.
/// @dev Not an IExchange implementation; it deliberately does not touch trading.
contract StubExchange {
    IERC20 public immutable usdc;

    /// @notice Exchange balances credited by `depositFor`.
    mapping(address => uint256) public balanceOf;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    /// @notice Pull USDC from the caller and credit `beneficiary`, like the real `depositFor`.
    function depositFor(address beneficiary, uint256 amountUsdc) external {
        require(usdc.transferFrom(msg.sender, address(this), amountUsdc), "stub: pull failed");
        balanceOf[beneficiary] += amountUsdc;
    }
}
