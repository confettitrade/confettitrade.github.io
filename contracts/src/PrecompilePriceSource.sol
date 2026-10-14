// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPriceSource} from "./interfaces/IPriceSource.sol";

/// @title PrecompilePriceSource
/// @notice Reads HyperCore quotes through the HyperEVM price precompiles (DESIGN section 3).
/// @dev All three precompiles take `abi.encode(uint32 assetIndex)` and return ABI-encoded
///      integers in HyperCore's native scale (the oracle rescales by 10^(12 + szDecimals)). A
///      failed call or a short return reverts `PrecompileCallFailed`; the oracle maps that to
///      `FeedUnavailable`. Stateless and immutable: nothing to configure.
contract PrecompilePriceSource is IPriceSource {
    /// @notice Best bid / best ask precompile: returns (uint64 bid, uint64 ask).
    address public constant BBO_PRECOMPILE = 0x000000000000000000000000000000000000080e;
    /// @notice Oracle price precompile (validator median of external venues): returns uint64.
    address public constant ORACLE_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    /// @notice Mark price precompile: returns uint64 mark. Informational only.
    address public constant MARK_PRECOMPILE = 0x0000000000000000000000000000000000000806;

    /// @notice The precompile reverted or returned fewer bytes than expected.
    error PrecompileCallFailed(address precompile, uint32 assetIndex);

    /// @inheritdoc IPriceSource
    function bbo(uint32 assetIndex) external view returns (uint64 bid, uint64 ask) {
        bytes memory ret = _read(BBO_PRECOMPILE, assetIndex, 64);
        (bid, ask) = abi.decode(ret, (uint64, uint64));
    }

    /// @inheritdoc IPriceSource
    function oraclePx(uint32 assetIndex) external view returns (uint64) {
        bytes memory ret = _read(ORACLE_PRECOMPILE, assetIndex, 32);
        return abi.decode(ret, (uint64));
    }

    /// @inheritdoc IPriceSource
    function mark(uint32 assetIndex) external view returns (uint64) {
        bytes memory ret = _read(MARK_PRECOMPILE, assetIndex, 32);
        return abi.decode(ret, (uint64));
    }

    /// @dev Staticcall `precompile` with the encoded index; require success and `minLength` bytes.
    function _read(address precompile, uint32 assetIndex, uint256 minLength) private view returns (bytes memory ret) {
        bool ok;
        (ok, ret) = precompile.staticcall(abi.encode(assetIndex));
        if (!ok || ret.length < minLength) revert PrecompileCallFailed(precompile, assetIndex);
    }
}
