// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title PointsRelay
/// @notice Signed intent to move confetti points between wallets. Holds no state, no owner and no
///         switch: it only emits `PointsTransfer`. Points are the off-chain ledger kept by the
///         points indexer (ops/points/indexer.py, rules in docs/POINTS.md); the indexer reads this
///         event in block order and applies a transfer only if the sender's balance at that point
///         covers `amount` and neither wallet is a house bot. Anything else is listed as rejected.
contract PointsRelay {
    /// @param from The wallet that signed the transfer.
    /// @param to The wallet that receives the points.
    /// @param amount Whole points.
    event PointsTransfer(address indexed from, address indexed to, uint256 amount);

    /// @notice Ask the indexer to move `amount` points from the caller to `to`.
    function sendPoints(address to, uint256 amount) external {
        require(to != address(0) && to != msg.sender && amount > 0, "bad transfer");
        emit PointsTransfer(msg.sender, to, amount);
    }
}
