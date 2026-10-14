// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice Six-decimal ERC-20 with open minting, standing in for HyperEVM USDC in tests.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    /// @notice Six decimals, like the real token.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint `amount` (6-dec) to `to`. Anyone may call.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
