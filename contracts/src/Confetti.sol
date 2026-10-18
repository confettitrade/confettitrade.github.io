// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IConfetti} from "./interfaces/IConfetti.sol";

/// @title Confetti
/// @notice The CONFETTI token (DESIGN section 7). Losers of synthetic trades receive it from
///         the Exchange; it can be staked for USDC dividends but not traded until the owner
///         opens transfers.
/// @dev Movement rules before `enableTransfers()`:
///        - minting (from the zero address) is always allowed, only by the Exchange;
///        - a transfer is allowed only when one side is the Staking contract;
///        - anything else reverts `TransfersDisabled`.
///      After `enableTransfers()` it is an ordinary ERC-20. The flag is one-way.
///      The Exchange and Staking addresses are set once by the owner (`wire`) because both
///      are deployed after this token. Ownership is two-step (`Ownable2Step`) so a handover
///      to a wrong address cannot strand the contract.
contract Confetti is IConfetti, ERC20, Ownable2Step {
    // ------------------------------------------------------------------ state

    /// @inheritdoc IConfetti
    address public exchange;

    /// @inheritdoc IConfetti
    address public staking;

    /// @inheritdoc IConfetti
    bool public transfersEnabled;

    // ------------------------------------------------------------ constructor

    /// @param initialOwner Account that may wire the contract and open transfers.
    constructor(address initialOwner) ERC20("Confetti", "CONFETTI") Ownable(initialOwner) {}

    // ---------------------------------------------------------------- actions

    /// @inheritdoc IConfetti
    function wire(address exchange_, address staking_) external onlyOwner {
        if (exchange != address(0)) revert AlreadyWired();
        if (exchange_ == address(0) || staking_ == address(0)) revert ZeroAddress();
        exchange = exchange_;
        staking = staking_;
        emit Wired(exchange_, staking_);
    }

    /// @inheritdoc IConfetti
    function mint(address to, uint256 amount) external {
        if (msg.sender != exchange) revert NotExchange();
        _mint(to, amount);
    }

    /// @inheritdoc IConfetti
    /// @dev Calling it again once enabled is a harmless no-op (no second event).
    function enableTransfers() external onlyOwner {
        if (transfersEnabled) return;
        transfersEnabled = true;
        emit TransfersEnabled();
    }

    // -------------------------------------------------------------- internals

    /// @dev Every balance change passes through here. Mints are always allowed; before
    ///      transfers are enabled, only moves that touch the Staking contract go through.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && !transfersEnabled) {
            address staking_ = staking;
            if (staking_ == address(0) || (from != staking_ && to != staking_)) revert TransfersDisabled();
        }
        super._update(from, to, value);
    }
}
