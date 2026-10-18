// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IReferrals
/// @notice Referral codes, referrer locks and the referrer share tally of the Confetti
///         exchange, kept in a contract the Exchange creates and owns.
/// @dev Codes: 3..16 characters of [a-z0-9_], unique, one per address, never changed. A code
///      only resolves to an address (`codeToReferrer`) for the front end: the Exchange takes
///      the referrer as an address on `requestOpen`.
///      Referrer lock: the Exchange calls `lockReferrer` when a trader's open executes; the
///      first call fixes the trader's referrer for good (zero included, so a first open
///      without a referrer locks "none"; a self-referral is stored as zero). Later calls are
///      ignored.
///      Share: on every fee a referred trader pays (win, loss or liquidation fee) the Exchange
///      calls `onFee`, which returns the referrer and `fee * referralShareBps / 10000`, tallies
///      it in `referralEarned` and emits `ReferralPaid`; the Exchange credits that amount to the
///      referrer's exchange balance (from LP cash when it has it, through the FIFO queue
///      otherwise) and pools the rest. The share is owner-set through the Exchange
///      (`IExchange.setReferralShare`), 0..5000 bps, 1500 at launch.
interface IReferrals {
    // ----------------------------------------------------------------- events

    event ReferralCodeRegistered(string code, address indexed owner);
    /// @notice `trader`'s referrer was fixed for good (zero = none).
    event ReferrerSet(address indexed trader, address indexed referrer);
    /// @notice `amountUsdc` of a fee paid by `trader` was credited to `referrer`.
    event ReferralPaid(address indexed referrer, address indexed trader, uint256 amountUsdc);
    event ReferralShareSet(uint16 shareBps);

    // ----------------------------------------------------------------- errors

    error NotExchange();
    /// @notice Not 3..16 characters of [a-z0-9_].
    error InvalidCode(string code);
    error CodeTaken(string code);
    error AlreadyRegistered(address account);
    error ShareOutOfBounds(uint16 shareBps);

    // ---------------------------------------------------------------- actions

    /// @notice Register `code` for the caller. Once per address; the code must be unused and
    ///         3..16 characters of [a-z0-9_].
    function registerCode(string calldata code) external;

    /// @notice Fix `trader`'s referrer if not fixed yet. Exchange only.
    /// @param trader Trader whose open just executed.
    /// @param referrer Referrer from the request (zero = none; `trader` itself counts as zero).
    function lockReferrer(address trader, address referrer) external;

    /// @notice Account for a fee `trader` is paying. Exchange only.
    /// @param trader Fee payer.
    /// @param feeUsdc The whole fee, USDC 6-dec.
    /// @return referrer `trader`'s referrer (zero when none, and then `shareUsdc` is 0).
    /// @return shareUsdc `feeUsdc * referralShareBps / 10000`, already added to
    ///         `referralEarned(referrer)`.
    function onFee(address trader, uint256 feeUsdc) external returns (address referrer, uint256 shareUsdc);

    /// @notice Set the referrer share, 0..5000 bps. Exchange only (its owner calls
    ///         `IExchange.setReferralShare`).
    function setShareBps(uint16 newShareBps) external;

    // ------------------------------------------------------------------ views

    /// @notice Owner of `code`, zero when unregistered.
    function codeToReferrer(string calldata code) external view returns (address);

    /// @notice `account`'s code, empty when it has none.
    function codeOf(address account) external view returns (string memory);

    /// @notice `trader`'s referrer, zero when none (locked or not: see `referrerLocked`).
    function referrerOf(address trader) external view returns (address);

    /// @notice True once `trader`'s referrer is fixed (after their first executed open).
    function referrerLocked(address trader) external view returns (bool);

    /// @notice Running total of fee shares credited to `referrer`, USDC 6-dec.
    function referralEarned(address referrer) external view returns (uint256);

    /// @notice Referrer share of a referred trader's fees, in bps.
    function referralShareBps() external view returns (uint16);

    /// @notice The Exchange that owns this registry.
    function exchange() external view returns (address);
}
