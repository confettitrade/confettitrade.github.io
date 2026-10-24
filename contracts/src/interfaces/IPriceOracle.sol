// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IPriceOracle
/// @notice Execution-price oracle for Confetti instruments (DESIGN section 3).
/// @dev All prices returned here are 1e18 fixed point USD per unit of the asset.
///      For an instrument mapped to HyperCore asset `a` with `szDecimals = d`:
///        mid18    = (bid + ask) * 10^(12 + d) / 2
///        oracle18 = oracle * 10^(12 + d)
///        price    = clamp(mid18, oracle18 * (10000 - clampBps) / 10000,
///                                oracle18 * (10000 + clampBps) / 10000)
///      The clamp reference is HyperCore's ORACLE price (precompile 0x...0807), a validator
///      median of external venues that a push on Hyperliquid's own book does not move. The
///      mark price (0x...0806) is partly derived from that book and is exposed only as an
///      informational view; it never bounds execution.
///      The Exchange settles every fill and liquidation on `oraclePrice` (oracle only, see
///      `IExchange.execPrice`); `price` and `rawMid` are display only.
///      If the BBO or the oracle feed reverts or returns zero the oracle reverts, which makes
///      the instrument untradeable until the feed recovers (no stale fallback). A dead mark
///      feed does not block trading.
///
///      The oracle keeps its own small registry (instrumentId -> asset index, szDecimals,
///      clampBps). The Exchange is the oracle's `registrar` (set once) and mirrors every
///      `addInstrument` / clamp change into it, so the two tables never drift. Once an
///      instrument is mapped, its asset index and szDecimals are locked: only the clamp
///      width can change, by the owner or the registrar.
interface IPriceOracle {
    // ----------------------------------------------------------------- events

    /// @notice Emitted when an instrument mapping is created or its clamp updated.
    event InstrumentSet(uint32 indexed instrumentId, uint32 hlAssetIndex, uint8 szDecimals, uint16 clampBps);

    /// @notice Emitted when the registrar is set.
    event RegistrarSet(address indexed registrar);

    // ----------------------------------------------------------------- errors

    /// @notice Caller is neither the owner nor the registrar.
    error Unauthorized();

    /// @notice No mapping exists for the instrument id.
    error UnknownInstrument(uint32 instrumentId);

    /// @notice A feed call reverted for the asset.
    error FeedUnavailable(uint32 instrumentId);

    /// @notice A feed returned zero for bid, ask, oracle or mark.
    error ZeroPrice(uint32 instrumentId);

    /// @notice clampBps is outside [5, 100] (DESIGN section 8 bounds).
    error ClampOutOfBounds(uint16 clampBps);

    /// @notice Zero address supplied where a contract is required.
    error ZeroAddress();

    /// @notice The instrument is already mapped to a different asset index or szDecimals.
    error AssetMappingLocked(uint32 instrumentId);

    /// @notice The registrar can only be set once.
    error RegistrarAlreadySet();

    // ------------------------------------------------------------------ views

    /// @notice BBO mid clamped to within `clampBps` of the oracle price: a display price the
    ///         front end shows. Reverts unless both the BBO and the oracle feed are live.
    /// @param instrumentId Exchange instrument id.
    /// @return px18 Clamped mid in 1e18 fixed point.
    function price(uint32 instrumentId) external view returns (uint256 px18);

    /// @notice Unclamped BBO mid. Display only; it never settles anything.
    /// @param instrumentId Exchange instrument id.
    /// @return Mid in 1e18 fixed point.
    function rawMid(uint32 instrumentId) external view returns (uint256);

    /// @notice HyperCore oracle price: the settlement price of every fill and the clamp reference.
    /// @param instrumentId Exchange instrument id.
    /// @return Oracle price in 1e18 fixed point.
    function oraclePrice(uint32 instrumentId) external view returns (uint256);

    /// @notice HyperCore mark price. Informational only; never used for settlement.
    /// @param instrumentId Exchange instrument id.
    /// @return Mark in 1e18 fixed point.
    function markPrice(uint32 instrumentId) external view returns (uint256);

    /// @notice Registry entry for an instrument.
    /// @param instrumentId Exchange instrument id.
    /// @return hlAssetIndex Hyperliquid asset index.
    /// @return szDecimals Asset size decimals used for scaling.
    /// @return clampBps Half-width of the clamp band around the oracle price, in bps.
    function instrumentConfig(uint32 instrumentId)
        external
        view
        returns (uint32 hlAssetIndex, uint8 szDecimals, uint16 clampBps);

    /// @notice The raw feed this oracle reads from.
    function source() external view returns (address);

    /// @notice The address allowed to write the registry besides the owner (the Exchange).
    function registrar() external view returns (address);

    // ------------------------------------------------------------------ admin

    /// @notice Create an instrument mapping, or update the clamp of an existing one. Owner or
    ///         registrar only.
    /// @dev Reverts `AssetMappingLocked` if the instrument is already mapped and
    ///      `hlAssetIndex` or `szDecimals` differ from the stored values.
    /// @param instrumentId Exchange instrument id.
    /// @param hlAssetIndex Hyperliquid asset index.
    /// @param szDecimals Asset size decimals (0..6).
    /// @param clampBps Clamp half-width in bps, must be within [5, 100].
    function setInstrument(uint32 instrumentId, uint32 hlAssetIndex, uint8 szDecimals, uint16 clampBps) external;

    /// @notice Set the registrar (the Exchange). Owner only, once.
    /// @param newRegistrar Non-zero address allowed to call `setInstrument`.
    function setRegistrar(address newRegistrar) external;
}
