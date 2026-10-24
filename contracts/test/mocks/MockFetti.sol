// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockFetti
/// @notice Eighteen-decimal ERC-20 standing in for the existing FETTI token (the v3 one, transfers
///         open), which v4 Staking stakes. `mint` is the test's stand-in for FETTI arriving from
///         outside v4 (a v3 mint, a pool buy); no v4 contract calls it.
contract MockFetti is ERC20 {
    constructor() ERC20("Confetti", "FETTI") {}

    /// @notice Mint `amount` (18-dec) to `to`. Anyone may call.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
