// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IReferrals} from "./interfaces/IReferrals.sol";

/// @title Referrals
/// @notice Referral codes, referrer locks and the referrer share tally (see IReferrals). Created
///         by the Exchange in its constructor; only the Exchange may lock referrers, account fees
///         or set the share. Holds no USDC: the Exchange pays what `onFee` returns.
/// @dev v4 carries v3 over: a code registered on the v3 registry still resolves and cannot be
///      taken here, an account with a v3 code cannot register a second one, and a trader whose
///      referrer v3 already locked keeps that referrer on their first v4 open. Earnings tally
///      v4 fees only. A referrer must own a code (here or on v3); a first open naming an
///      address without one locks "none".
contract Referrals is IReferrals {
    uint16 public constant MAX_SHARE_BPS = 5000;
    uint16 public constant DEFAULT_SHARE_BPS = 1500;
    uint256 public constant MIN_CODE_LENGTH = 3;
    uint256 public constant MAX_CODE_LENGTH = 16;
    uint256 private constant BPS = 10_000;

    struct Referral {
        address referrer;
        bool locked;
    }

    address private immutable _exchange;
    /// @dev The v3 registry whose codes and locks carry over (zero: none).
    IReferrals private immutable _v3;
    uint16 private _shareBps;
    mapping(string => address) private _codeOwner;
    mapping(address => string) private _codeOf;
    mapping(address => Referral) private _referral;
    mapping(address => uint256) private _earned;

    modifier onlyExchange() {
        if (msg.sender != _exchange) revert NotExchange();
        _;
    }

    /// @param exchange_ The Exchange that owns this registry.
    /// @param v3_ The v3 Referrals registry to carry over, or zero for a fresh one.
    constructor(address exchange_, IReferrals v3_) {
        _exchange = exchange_;
        _v3 = v3_;
        _shareBps = DEFAULT_SHARE_BPS;
        emit ReferralShareSet(DEFAULT_SHARE_BPS);
    }

    // ---------------------------------------------------------------- actions

    /// @inheritdoc IReferrals
    function registerCode(string calldata code) external {
        if (!_validCode(bytes(code))) revert InvalidCode(code);
        if (_codeOwnerOf(code) != address(0)) revert CodeTaken(code);
        if (bytes(_codeOfAccount(msg.sender)).length != 0) revert AlreadyRegistered(msg.sender);
        _codeOwner[code] = msg.sender;
        _codeOf[msg.sender] = code;
        emit ReferralCodeRegistered(code, msg.sender);
    }

    /// @inheritdoc IReferrals
    function lockReferrer(address trader, address referrer) external onlyExchange {
        Referral storage r = _referral[trader];
        if (r.locked) return;
        if (address(_v3) != address(0) && _v3.referrerLocked(trader)) {
            referrer = _v3.referrerOf(trader);
        } else if (referrer == trader || (referrer != address(0) && bytes(_codeOfAccount(referrer)).length == 0)) {
            referrer = address(0);
        }
        r.referrer = referrer;
        r.locked = true;
        emit ReferrerSet(trader, referrer);
    }

    /// @inheritdoc IReferrals
    function onFee(address trader, uint256 feeUsdc)
        external
        onlyExchange
        returns (address referrer, uint256 shareUsdc)
    {
        referrer = _referral[trader].referrer;
        if (referrer == address(0)) return (address(0), 0);
        shareUsdc = feeUsdc * _shareBps / BPS;
        if (shareUsdc == 0) return (referrer, 0);
        _earned[referrer] += shareUsdc;
        emit ReferralPaid(referrer, trader, shareUsdc);
    }

    /// @inheritdoc IReferrals
    function setShareBps(uint16 newShareBps) external onlyExchange {
        if (newShareBps > MAX_SHARE_BPS) revert ShareOutOfBounds(newShareBps);
        _shareBps = newShareBps;
        emit ReferralShareSet(newShareBps);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IReferrals
    function codeToReferrer(string calldata code) external view returns (address) {
        return _codeOwnerOf(code);
    }

    /// @inheritdoc IReferrals
    function codeOf(address account) external view returns (string memory) {
        return _codeOfAccount(account);
    }

    /// @inheritdoc IReferrals
    function referrerOf(address trader) external view returns (address) {
        if (_referral[trader].locked || address(_v3) == address(0)) return _referral[trader].referrer;
        return _v3.referrerLocked(trader) ? _v3.referrerOf(trader) : address(0);
    }

    /// @inheritdoc IReferrals
    function referrerLocked(address trader) external view returns (bool) {
        return _referral[trader].locked || (address(_v3) != address(0) && _v3.referrerLocked(trader));
    }

    /// @inheritdoc IReferrals
    function v3Referrals() external view returns (address) {
        return address(_v3);
    }

    /// @inheritdoc IReferrals
    function referralEarned(address referrer) external view returns (uint256) {
        return _earned[referrer];
    }

    /// @inheritdoc IReferrals
    function referralShareBps() external view returns (uint16) {
        return _shareBps;
    }

    /// @inheritdoc IReferrals
    function exchange() external view returns (address) {
        return _exchange;
    }

    // --------------------------------------------------------------- internal

    /// @dev Owner of `code` here, else on v3, else zero.
    function _codeOwnerOf(string memory code) private view returns (address owner_) {
        owner_ = _codeOwner[code];
        if (owner_ == address(0) && address(_v3) != address(0)) owner_ = _v3.codeToReferrer(code);
    }

    /// @dev `account`'s code here, else on v3, else empty.
    function _codeOfAccount(address account) private view returns (string memory code) {
        code = _codeOf[account];
        if (bytes(code).length == 0 && address(_v3) != address(0)) code = _v3.codeOf(account);
    }

    /// @dev 3..16 bytes, each one of a-z, 0-9 or underscore.
    function _validCode(bytes memory code) private pure returns (bool) {
        uint256 n = code.length;
        if (n < MIN_CODE_LENGTH || n > MAX_CODE_LENGTH) return false;
        for (uint256 i = 0; i < n; i++) {
            bytes1 c = code[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || c == 0x5f;
            if (!ok) return false;
        }
        return true;
    }
}
