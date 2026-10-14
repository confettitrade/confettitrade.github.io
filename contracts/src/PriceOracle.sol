// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IPriceSource} from "./interfaces/IPriceSource.sol";

/// @title PriceOracle
/// @notice Price oracle (DESIGN section 3): the HyperCore oracle price the Exchange settles on,
///         the raw BBO mid, and the mid clamped to within `clampBps` of the oracle price (both
///         display only), all in 1e18 fixed point.
/// @dev Reads raw quotes from an `IPriceSource` (the precompile adapter in production, a mock
///      in tests). Keeps a small registry instrumentId -> (asset index, szDecimals, clampBps)
///      that the Exchange (the `registrar`) mirrors its markets into; once mapped, an
///      instrument's asset index and szDecimals cannot change. Reverts rather than returning
///      stale or zero prices, so a dead BBO or oracle feed makes its market untradeable.
///      The mark price is exposed for display only and never bounds execution: it follows a
///      push on Hyperliquid's own book, the oracle price (a validator median of external
///      venues) does not. Ownership is two-step.
contract PriceOracle is IPriceOracle, Ownable2Step {
    /// @notice szDecimals is outside [0, 6].
    error SzDecimalsOutOfBounds(uint8 szDecimals);

    struct Config {
        uint32 hlAssetIndex;
        uint8 szDecimals;
        uint16 clampBps;
        bool set;
    }

    uint256 private constant BPS = 10_000;
    uint16 private constant MIN_CLAMP_BPS = 5;
    uint16 private constant MAX_CLAMP_BPS = 100;
    uint8 private constant MAX_SZ_DECIMALS = 6;

    IPriceSource private immutable _source;
    address private _registrar;
    mapping(uint32 => Config) private _configs;

    /// @param source_ Raw feed, non-zero.
    /// @param initialOwner First owner (the deployer, which hands over two-step).
    constructor(IPriceSource source_, address initialOwner) Ownable(initialOwner) {
        if (address(source_) == address(0)) revert ZeroAddress();
        _source = source_;
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IPriceOracle
    function price(uint32 instrumentId) external view returns (uint256 px18) {
        Config memory c = _config(instrumentId);
        uint256 mid18 = _mid18(instrumentId, c);
        uint256 ref18 = _oracle18(instrumentId, c);
        uint256 lo = ref18 * (BPS - c.clampBps) / BPS;
        uint256 hi = ref18 * (BPS + c.clampBps) / BPS;
        if (mid18 < lo) return lo;
        if (mid18 > hi) return hi;
        return mid18;
    }

    /// @inheritdoc IPriceOracle
    function rawMid(uint32 instrumentId) external view returns (uint256) {
        return _mid18(instrumentId, _config(instrumentId));
    }

    /// @inheritdoc IPriceOracle
    function oraclePrice(uint32 instrumentId) external view returns (uint256) {
        return _oracle18(instrumentId, _config(instrumentId));
    }

    /// @inheritdoc IPriceOracle
    function markPrice(uint32 instrumentId) external view returns (uint256) {
        Config memory c = _config(instrumentId);
        uint64 markPx = _mark(instrumentId, c.hlAssetIndex);
        if (markPx == 0) revert ZeroPrice(instrumentId);
        return _scale18(markPx, c.szDecimals);
    }

    /// @inheritdoc IPriceOracle
    function instrumentConfig(uint32 instrumentId)
        external
        view
        returns (uint32 hlAssetIndex, uint8 szDecimals, uint16 clampBps)
    {
        Config memory c = _config(instrumentId);
        return (c.hlAssetIndex, c.szDecimals, c.clampBps);
    }

    /// @inheritdoc IPriceOracle
    function source() external view returns (address) {
        return address(_source);
    }

    /// @inheritdoc IPriceOracle
    function registrar() external view returns (address) {
        return _registrar;
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc IPriceOracle
    function setInstrument(uint32 instrumentId, uint32 hlAssetIndex, uint8 szDecimals, uint16 clampBps) external {
        if (msg.sender != owner() && msg.sender != _registrar) revert Unauthorized();
        if (clampBps < MIN_CLAMP_BPS || clampBps > MAX_CLAMP_BPS) revert ClampOutOfBounds(clampBps);
        if (szDecimals > MAX_SZ_DECIMALS) revert SzDecimalsOutOfBounds(szDecimals);
        Config storage c = _configs[instrumentId];
        if (c.set && (c.hlAssetIndex != hlAssetIndex || c.szDecimals != szDecimals)) {
            revert AssetMappingLocked(instrumentId);
        }
        _configs[instrumentId] =
            Config({hlAssetIndex: hlAssetIndex, szDecimals: szDecimals, clampBps: clampBps, set: true});
        emit InstrumentSet(instrumentId, hlAssetIndex, szDecimals, clampBps);
    }

    /// @inheritdoc IPriceOracle
    function setRegistrar(address newRegistrar) external onlyOwner {
        if (_registrar != address(0)) revert RegistrarAlreadySet();
        if (newRegistrar == address(0)) revert ZeroAddress();
        _registrar = newRegistrar;
        emit RegistrarSet(newRegistrar);
    }

    // --------------------------------------------------------------- internal

    function _config(uint32 instrumentId) private view returns (Config memory c) {
        c = _configs[instrumentId];
        if (!c.set) revert UnknownInstrument(instrumentId);
    }

    /// @dev Raw quotes carry 10^(6 - szDecimals) implied decimals, so 10^(12 + szDecimals)
    ///      brings them to 1e18.
    function _scale18(uint64 raw, uint8 szDecimals) private pure returns (uint256) {
        return uint256(raw) * 10 ** (12 + uint256(szDecimals));
    }

    /// @dev The mid is (bid + ask) / 2, scaled to 1e18.
    function _mid18(uint32 instrumentId, Config memory c) private view returns (uint256) {
        (uint64 bid, uint64 ask) = _bbo(instrumentId, c.hlAssetIndex);
        if (bid == 0 || ask == 0) revert ZeroPrice(instrumentId);
        return (uint256(bid) + uint256(ask)) * 10 ** (12 + uint256(c.szDecimals)) / 2;
    }

    function _oracle18(uint32 instrumentId, Config memory c) private view returns (uint256) {
        uint64 px = _oraclePx(instrumentId, c.hlAssetIndex);
        if (px == 0) revert ZeroPrice(instrumentId);
        return _scale18(px, c.szDecimals);
    }

    function _bbo(uint32 instrumentId, uint32 assetIndex) private view returns (uint64 bid, uint64 ask) {
        try _source.bbo(assetIndex) returns (uint64 b, uint64 a) {
            return (b, a);
        } catch {
            revert FeedUnavailable(instrumentId);
        }
    }

    function _oraclePx(uint32 instrumentId, uint32 assetIndex) private view returns (uint64) {
        try _source.oraclePx(assetIndex) returns (uint64 o) {
            return o;
        } catch {
            revert FeedUnavailable(instrumentId);
        }
    }

    function _mark(uint32 instrumentId, uint32 assetIndex) private view returns (uint64) {
        try _source.mark(assetIndex) returns (uint64 m) {
            return m;
        } catch {
            revert FeedUnavailable(instrumentId);
        }
    }
}
