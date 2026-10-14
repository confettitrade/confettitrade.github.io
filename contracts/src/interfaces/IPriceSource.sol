// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IPriceSource
/// @notice Raw quote feed keyed by Hyperliquid asset index, in HyperCore's native integer scale.
/// @dev Production: a thin adapter that staticcalls the HyperCore precompiles
///      (BBO at 0x...080e, oracle at 0x...0807, mark at 0x...0806) with
///      `abi.encode(uint32 assetIndex)`. Tests: `MockPriceSource` with settable quotes.
///      Values are the precompile's raw integers; the oracle scales them by
///      10^(12 + szDecimals) to reach 1e18 fixed point (DESIGN section 3).
///      Implementations must revert (not return zero) when the feed is unavailable.
interface IPriceSource {
    /// @notice Best bid and ask for an asset in raw HyperCore units.
    /// @param assetIndex Hyperliquid perp asset index (e.g. DOGE = 12).
    /// @return bid Raw best bid.
    /// @return ask Raw best ask.
    function bbo(uint32 assetIndex) external view returns (uint64 bid, uint64 ask);

    /// @notice Oracle price for an asset in raw HyperCore units: the validator median of
    ///         external venues, which a push on Hyperliquid's own book does not move.
    /// @param assetIndex Hyperliquid perp asset index.
    /// @return Raw oracle price.
    function oraclePx(uint32 assetIndex) external view returns (uint64);

    /// @notice Mark price for an asset in raw HyperCore units. Informational only: mark is
    ///         derived partly from Hyperliquid's own book, so it follows a book push.
    /// @param assetIndex Hyperliquid perp asset index.
    /// @return Raw mark price.
    function mark(uint32 assetIndex) external view returns (uint64);
}
