// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";

/// @title MockPriceSource
/// @notice Test double for the HyperCore feeds: quotes are set per asset index, and each feed
///         can be switched to revert to simulate an outage.
/// @dev Unset indices return zero, which the oracle must treat as unavailable. The four-argument
///      `setQuote` sets mark and oracle to the same reference value (the common case in tests);
///      the five-argument form sets them separately so the clamp reference can be exercised.
contract MockPriceSource is IPriceSource {
    struct Quote {
        uint64 bid;
        uint64 ask;
        uint64 mark;
        uint64 oracle;
    }

    error MockFeedDown();

    mapping(uint32 => Quote) public quotes;
    bool public bboReverts;
    bool public markReverts;
    bool public oracleReverts;

    /// @notice Set best bid and ask for an asset.
    function setBbo(uint32 assetIndex, uint64 bid, uint64 ask) external {
        quotes[assetIndex].bid = bid;
        quotes[assetIndex].ask = ask;
    }

    /// @notice Set the mark price for an asset.
    function setMark(uint32 assetIndex, uint64 markPx) external {
        quotes[assetIndex].mark = markPx;
    }

    /// @notice Set the oracle price for an asset.
    function setOraclePx(uint32 assetIndex, uint64 oraclePx_) external {
        quotes[assetIndex].oracle = oraclePx_;
    }

    /// @notice Set bid and ask, with mark and oracle both at `refPx`.
    function setQuote(uint32 assetIndex, uint64 bid, uint64 ask, uint64 refPx) external {
        quotes[assetIndex] = Quote({bid: bid, ask: ask, mark: refPx, oracle: refPx});
    }

    /// @notice Set bid, ask, mark and oracle separately.
    function setQuote(uint32 assetIndex, uint64 bid, uint64 ask, uint64 markPx, uint64 oraclePx_) external {
        quotes[assetIndex] = Quote({bid: bid, ask: ask, mark: markPx, oracle: oraclePx_});
    }

    /// @notice Toggle outages: `refDown` takes both the mark and the oracle feed down.
    function setReverts(bool bboDown, bool refDown) external {
        bboReverts = bboDown;
        markReverts = refDown;
        oracleReverts = refDown;
    }

    /// @notice Toggle the mark feed alone.
    function setMarkReverts(bool down) external {
        markReverts = down;
    }

    /// @notice Toggle the oracle feed alone.
    function setOracleReverts(bool down) external {
        oracleReverts = down;
    }

    /// @inheritdoc IPriceSource
    function bbo(uint32 assetIndex) external view returns (uint64 bid, uint64 ask) {
        if (bboReverts) revert MockFeedDown();
        Quote storage q = quotes[assetIndex];
        return (q.bid, q.ask);
    }

    /// @inheritdoc IPriceSource
    function oraclePx(uint32 assetIndex) external view returns (uint64) {
        if (oracleReverts) revert MockFeedDown();
        return quotes[assetIndex].oracle;
    }

    /// @inheritdoc IPriceSource
    function mark(uint32 assetIndex) external view returns (uint64) {
        if (markReverts) revert MockFeedDown();
        return quotes[assetIndex].mark;
    }
}
