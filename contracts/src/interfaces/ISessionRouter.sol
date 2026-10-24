// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IExchange} from "./IExchange.sol";

/// @title ISessionRouter
/// @notice Session keys for one-click trading (v3 spec 2). A trader's wallet calls
///         `authorize` once; the session key then calls `requestOpen`, `requestClose`,
///         `cancelOpen` and `cancelClose` here, which act on the Exchange for that trader only.
/// @dev The Exchange creates this router and treats it as the one trusted forwarder of
///      `requestOpen` / `requestClose` (trader appended to the calldata, ERC-2771 layout).
///      Cancels go to the Exchange's own permissionless `cancelOpen` / `cancelClose` after a
///      check that the request is the trader's.
interface ISessionRouter {
    /// @notice A trader's session.
    /// @param key The session key (zero = none).
    /// @param expiry Last second the key may act (inclusive).
    /// @param maxMarginPerTrade Largest margin one open request may carry, USDC 6-dec.
    /// @param referrer Referrer every session open forwards (zero = none), chosen by the wallet.
    struct Session {
        address key;
        uint64 expiry;
        uint128 maxMarginPerTrade;
        address referrer;
    }

    // ----------------------------------------------------------------- events

    /// @param referrer The stored referrer (zero when none, or when the wallet named itself).
    /// @param gasFundedWei `msg.value` forwarded to the session key.
    event SessionAuthorized(
        address indexed trader,
        address indexed sessionKey,
        uint64 expiry,
        uint128 maxMarginPerTrade,
        address referrer,
        uint256 gasFundedWei
    );
    /// @notice The trader revoked the session, or replaced it with another key.
    event SessionRevoked(address indexed trader, address indexed sessionKey);

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    /// @notice Expiry is not in (now, now + MAX_SESSION].
    error BadExpiry(uint64 expiry);
    error ZeroMarginCap();
    /// @notice The key is bound to another trader.
    error KeyInUse(address sessionKey);
    /// @notice Forwarding `msg.value` to the session key failed.
    error GasForwardFailed();
    /// @notice `keySig` is not the session key's signature over `authorizationDigest`.
    error BadKeySignature();
    /// @notice The caller is not a session key, or the trader has no session.
    error NoSession();
    error SessionExpired(uint64 expiry);
    error MarginAboveSessionCap(uint128 marginUsdc, uint128 maxMarginPerTrade);
    /// @notice The request or position belongs to another trader.
    error NotYours();

    // ---------------------------------------------------------------- wallet

    /// @notice Authorize `sessionKey` to trade for the caller until `expiry`, at most
    ///         `maxMarginPerTrade` per open, with `referrer` forwarded on every session open.
    ///         Forwards `msg.value` to the key for gas.
    /// @dev The key must consent: `keySig` is its EIP-191 signature (`personal_sign` of the
    ///      32 bytes) over `authorizationDigest(msg.sender, sessionKey, expiry,
    ///      maxMarginPerTrade, referrer)`. A referrer equal to the caller is stored as zero.
    ///      Replaces any existing session of the caller (the old key stops at once,
    ///      `SessionRevoked`). Reverts `ZeroAddress`, `BadExpiry` unless now < expiry <= now +
    ///      30 days, `ZeroMarginCap`, `BadKeySignature`, `KeyInUse` when the key serves another
    ///      trader, and `GasForwardFailed`.
    function authorize(
        address sessionKey,
        uint64 expiry,
        uint128 maxMarginPerTrade,
        address referrer,
        bytes calldata keySig
    ) external payable;

    /// @notice End the caller's session now. Reverts `NoSession` when there is none.
    function revoke() external;

    // ----------------------------------------------------------- session key

    /// @notice File an open request for the caller's trader (forwarded `requestOpen` with the
    ///         session's referrer).
    /// @dev Reverts `NoSession`, `SessionExpired`, `MarginAboveSessionCap`, and whatever
    ///      `requestOpen` would revert with for the trader.
    function requestOpen(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage)
        external
        returns (uint256 requestId);

    /// @notice File a close request on the trader's position (forwarded `requestClose`).
    function requestClose(uint256 positionId) external;

    /// @notice Cancel the trader's expired open request (`NotYours` for another's).
    function cancelOpen(uint256 requestId) external;

    /// @notice Cancel the expired close request on the trader's position (`NotYours` for
    ///         another's position).
    function cancelClose(uint256 positionId) external;

    // ------------------------------------------------------------------ views

    /// @notice Longest session: 30 days.
    function MAX_SESSION() external view returns (uint64);

    /// @notice The Exchange this router files requests on.
    function exchange() external view returns (IExchange);

    /// @notice The trader's session (zero key = none; check `expiry` for liveness).
    function sessionOf(address trader) external view returns (Session memory);

    /// @notice The trader a session key acts for (zero = none).
    function traderOf(address sessionKey) external view returns (address);

    /// @notice What a session key signs to consent to `authorize`: keccak256(abi.encode(
    ///         block.chainid, this router, trader, sessionKey, expiry, maxMarginPerTrade,
    ///         referrer)), signed EIP-191 style (`personal_sign` of these 32 bytes).
    function authorizationDigest(
        address trader,
        address sessionKey,
        uint64 expiry,
        uint128 maxMarginPerTrade,
        address referrer
    ) external view returns (bytes32);
}
