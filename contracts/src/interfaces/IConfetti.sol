// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title IConfetti
/// @notice The CONFETTI token: ERC-20, 18 decimals, minted to losers by the Exchange.
/// @dev Transfer rule (DESIGN section 7): until `enableTransfers()` is called, the only
///      allowed movements are mints (from the zero address) and transfers where either side
///      is the Staking contract. `enableTransfers()` is one-way.
///      Deploy order: Confetti is deployed before the Exchange and Staking, so the owner wires
///      those two addresses once with `wire`.
interface IConfetti is IERC20Metadata {
    // ----------------------------------------------------------------- events

    event Wired(address indexed exchange, address indexed staking);
    event TransfersEnabled();

    // ----------------------------------------------------------------- errors

    error NotExchange();
    error TransfersDisabled();
    error AlreadyWired();
    error ZeroAddress();

    // ---------------------------------------------------------------- actions

    /// @notice Mint `amount` CONFETTI to `to`. Exchange only.
    /// @param to Recipient.
    /// @param amount 18-dec amount.
    function mint(address to, uint256 amount) external;

    /// @notice Make CONFETTI freely transferable. Owner only, one-way.
    function enableTransfers() external;

    /// @notice One-time: set the Exchange (minter) and Staking (transfer exemption). Owner only.
    /// @param exchange Exchange address.
    /// @param staking Staking address.
    function wire(address exchange, address staking) external;

    // ------------------------------------------------------------------ views

    /// @notice True once `enableTransfers` has been called.
    function transfersEnabled() external view returns (bool);

    /// @notice The only address allowed to mint; zero until wired.
    function exchange() external view returns (address);

    /// @notice Transfers to and from this address are always allowed; zero until wired.
    function staking() external view returns (address);
}
