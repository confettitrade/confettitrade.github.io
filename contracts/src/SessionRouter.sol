// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IExchange} from "./interfaces/IExchange.sol";
import {ISessionRouter} from "./interfaces/ISessionRouter.sol";

/// @title SessionRouter
/// @notice One-click trading with session keys, no server (v3 spec 2). A trader authorizes a
///         browser-held key once from their wallet; the key then files open and close
///         requests, and cancels expired ones, for that trader alone, with no wallet popup.
/// @dev Created by the Exchange's constructor, which records this address as its only trusted
///      forwarder: `requestOpen` and `requestClose` called from here are filed for the trader
///      appended as the last 20 bytes of the calldata (ERC-2771 layout). The Exchange reads the
///      appended trader in those two functions alone.
///      What a session key can do: `requestOpen` (margin at most the trader's per-trade cap),
///      `requestClose`, `cancelOpen`, `cancelClose`, all for the trader that authorized it,
///      until the session expires or the trader revokes it. What it cannot do: deposit,
///      withdraw, transfer, register a referral code, choose a referrer, or change any
///      setting; this contract calls nothing else. Fills keep the v2 rules: the keeper-first
///      window and the worse-of fallback apply to session requests exactly as to wallet
///      requests.
///      Referrer: the wallet names it in `authorize` (the trader's own address or zero means
///      none) and every session open forwards it, so a session key's first open locks the
///      referrer the wallet chose, exactly like a wallet open. Re-authorizing before the lock
///      may change it; once locked, Referrals ignores it.
///      Key consent: `authorize` binds a key only with the key's own signature over the
///      binding (`authorizationDigest`, signed EIP-191 style), so nobody can squat a key
///      address another trader is about to bind.
///      One session per trader and one trader per key. Re-authorizing replaces the trader's
///      session (the old key stops working at once). A key bound to another trader is
///      refused (`KeyInUse`) so a key always resolves to a single account.
///      Gas: `authorize` forwards `msg.value` to the session key so a fresh browser key can pay
///      for its own transactions. The router keeps no HYPE and has no owner.
///      Gasless relaying (not built; design note): a `requestOpenWithSig(trader, params,
///      nonce, deadline, sig)` path would verify an EIP-712 `SessionOpen(address trader,
///      uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage, uint256 nonce,
///      uint256 deadline)` signed by the trader's session key (domain: name "Confetti
///      SessionRouter", version "1", chainId, this address), check the key's session, the
///      per-trade cap, a per-trader nonce and the deadline, then forward exactly as
///      `requestOpen` does. Any relayer could submit it, so the session key would need no
///      gas; nothing in the Exchange would change.
contract SessionRouter is ISessionRouter {
    /// @inheritdoc ISessionRouter
    uint64 public constant MAX_SESSION = 30 days;

    /// @inheritdoc ISessionRouter
    IExchange public immutable exchange;

    mapping(address trader => Session) private _sessions;
    mapping(address key => address trader) private _traderOf;

    /// @param exchange_ The Exchange creating this router (its `sessionRouter`).
    constructor(IExchange exchange_) {
        exchange = exchange_;
    }

    // ---------------------------------------------------------------- wallet

    /// @inheritdoc ISessionRouter
    function authorize(
        address sessionKey,
        uint64 expiry,
        uint128 maxMarginPerTrade,
        address referrer,
        bytes calldata keySig
    ) external payable {
        if (sessionKey == address(0)) revert ZeroAddress();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_SESSION) revert BadExpiry(expiry);
        if (maxMarginPerTrade == 0) revert ZeroMarginCap();
        bytes32 digest = authorizationDigest(msg.sender, sessionKey, expiry, maxMarginPerTrade, referrer);
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(digest), keySig);
        if (err != ECDSA.RecoverError.NoError || signer != sessionKey) revert BadKeySignature();
        address boundTo = _traderOf[sessionKey];
        if (boundTo != address(0) && boundTo != msg.sender) revert KeyInUse(sessionKey);

        address oldKey = _sessions[msg.sender].key;
        if (oldKey != address(0) && oldKey != sessionKey) {
            delete _traderOf[oldKey];
            emit SessionRevoked(msg.sender, oldKey);
        }
        if (referrer == msg.sender) referrer = address(0);
        _sessions[msg.sender] =
            Session({key: sessionKey, expiry: expiry, maxMarginPerTrade: maxMarginPerTrade, referrer: referrer});
        _traderOf[sessionKey] = msg.sender;
        emit SessionAuthorized(msg.sender, sessionKey, expiry, maxMarginPerTrade, referrer, msg.value);

        if (msg.value != 0) {
            (bool ok,) = sessionKey.call{value: msg.value}("");
            if (!ok) revert GasForwardFailed();
        }
    }

    /// @inheritdoc ISessionRouter
    function revoke() external {
        address key = _sessions[msg.sender].key;
        if (key == address(0)) revert NoSession();
        delete _sessions[msg.sender];
        delete _traderOf[key];
        emit SessionRevoked(msg.sender, key);
    }

    // ----------------------------------------------------------- session key

    /// @inheritdoc ISessionRouter
    function requestOpen(uint32 instrumentId, bool isLong, uint128 marginUsdc, uint32 leverage)
        external
        returns (uint256 requestId)
    {
        (address trader, Session storage s) = _live();
        if (marginUsdc > s.maxMarginPerTrade) revert MarginAboveSessionCap(marginUsdc, s.maxMarginPerTrade);
        bytes memory ret = _forward(
            abi.encodeCall(IExchange.requestOpen, (instrumentId, isLong, marginUsdc, leverage, s.referrer)), trader
        );
        return abi.decode(ret, (uint256));
    }

    /// @inheritdoc ISessionRouter
    function requestClose(uint256 positionId) external {
        (address trader,) = _live();
        _forward(abi.encodeCall(IExchange.requestClose, (positionId)), trader);
    }

    /// @inheritdoc ISessionRouter
    function cancelOpen(uint256 requestId) external {
        (address trader,) = _live();
        if (exchange.openRequest(requestId).trader != trader) revert NotYours();
        exchange.cancelOpen(requestId);
    }

    /// @inheritdoc ISessionRouter
    function cancelClose(uint256 positionId) external {
        (address trader,) = _live();
        if (exchange.positions(positionId).owner != trader) revert NotYours();
        exchange.cancelClose(positionId);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ISessionRouter
    function sessionOf(address trader) external view returns (Session memory) {
        return _sessions[trader];
    }

    /// @inheritdoc ISessionRouter
    function traderOf(address sessionKey) external view returns (address) {
        return _traderOf[sessionKey];
    }

    /// @inheritdoc ISessionRouter
    function authorizationDigest(
        address trader,
        address sessionKey,
        uint64 expiry,
        uint128 maxMarginPerTrade,
        address referrer
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(this), trader, sessionKey, expiry, maxMarginPerTrade, referrer)
        );
    }

    // -------------------------------------------------------------- internal

    /// @dev The trader the calling key acts for, with that trader's live session.
    function _live() private view returns (address trader, Session storage s) {
        trader = _traderOf[msg.sender];
        if (trader == address(0)) revert NoSession();
        s = _sessions[trader];
        if (block.timestamp > s.expiry) revert SessionExpired(s.expiry);
    }

    /// @dev Call the Exchange with `trader` appended to `data` (the layout the Exchange reads
    ///      from its trusted forwarder) and bubble any revert unchanged.
    function _forward(bytes memory data, address trader) private returns (bytes memory ret) {
        bool ok;
        (ok, ret) = address(exchange).call(abi.encodePacked(data, trader));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
