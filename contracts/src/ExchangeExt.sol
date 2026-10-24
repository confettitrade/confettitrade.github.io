// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {ExchangeBase} from "./ExchangeBase.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {ImpactLib} from "./lib/ImpactLib.sol";

/// @title ExchangeExt
/// @notice The admin extension of the Confetti v4 exchange: the house money functions, every
///         owner and keeper setter and every view. It is never called directly: the core
///         (`Exchange`) delegatecalls it from its fallback, so this code runs on the core's
///         storage and `msg.sender` is the core's caller. Its own storage is nobody's: a direct
///         call to any state-changing function reverts `DirectCall` (the guard sits in
///         `_checkOwner`, `onlyKeeperOrOwner` and `_checkPauseAuthority`), and a direct view
///         returns zeros.
/// @dev Immutable, not upgradeable: the core holds this address as an immutable it cannot
///      change. Built with the same USDC, oracle and Staking addresses as the core, which the
///      core verifies through `extensionImmutables` at construction.
contract ExchangeExt is ExchangeBase {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    constructor(IERC20 usdc_, IPriceOracle oracle_, IStaking staking_, address owner_)
        ExchangeBase(usdc_, oracle_, staking_, owner_, true)
    {}

    /// @notice The three immutables this extension was built with. The one function meant to
    ///         be called directly: the core compares them with its own at construction.
    function extensionImmutables() external view returns (address usdc_, address oracle_, address staking_) {
        return (address(_usdc), address(_oracle), address(_staking));
    }

    // ------------------------------------------------------------ house money

    function depositHouse(uint256 amountUsdc) external onlyOwner nonReentrant {
        if (amountUsdc == 0) revert ZeroAmount();
        _usdc.safeTransferFrom(msg.sender, address(this), amountUsdc);
        uint256 lpAfter = _lpUsdc + amountUsdc;
        _lpUsdc = lpAfter;
        // Counts toward the breaker at once; a stale window resamples at its next settlement.
        _windowStartLp += amountUsdc;
        emit HouseDeposited(amountUsdc, lpAfter);
    }

    function withdrawHouse(uint256 amountUsdc) external onlyOwner nonReentrant {
        if (amountUsdc == 0) revert ZeroAmount();
        // Fees already earned leave first, so the pool never freezes behind a withdrawal.
        _pushFees();
        uint256 free = _freeCash();
        if (amountUsdc > free) revert InsufficientBalance(free, amountUsdc);
        _lpOut(amountUsdc);
        _usdc.safeTransfer(owner(), amountUsdc);
        emit HouseWithdrawn(amountUsdc, _lpUsdc);
    }

    // ------------------------------------------------------------------ views

    function balanceOf(address user) external view returns (uint256) {
        return _available[user];
    }

    function marginInUse(address user) external view returns (uint256) {
        return _marginInUse[user];
    }

    function pendingOf(address user) external view returns (uint256) {
        return _pending[user];
    }

    function positions(uint256 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    function positionIdsOf(address user) external view returns (uint256[] memory) {
        return _positionIds[user].values();
    }

    function openRequest(uint256 requestId) external view returns (OpenRequest memory) {
        return _openRequests[requestId];
    }

    function closeRequest(uint256 positionId) external view returns (CloseRequest memory) {
        return _closeRequests[positionId];
    }

    function bustPrice(uint256 positionId) external view returns (uint256) {
        return _bustPrice(_position(positionId));
    }

    function borrowOwed(uint256 positionId) external view returns (uint256) {
        return _borrowOwed(_position(positionId));
    }

    function isHouseWallet(address wallet) external view returns (bool) {
        return _houseWallets[wallet];
    }

    function previewClose(uint256 positionId)
        external
        view
        returns (int256 pnlUsdc, uint256 feeUsdc, uint256 payoutUsdc)
    {
        Position memory pos = _position(positionId);
        Instrument storage inst = _instruments[pos.instrumentId];
        (bool isWin, uint256 amount,) = _quote(pos, inst, _execPrice(pos.instrumentId, inst));
        uint256 margin = pos.marginUsdc;
        uint256 borrow = _borrowOwed(pos);
        if (amount == 0) {
            payoutUsdc = margin;
        } else if (isWin) {
            feeUsdc = ImpactLib.winFee(amount, pos.winFeeBps);
            uint256 profit = amount - feeUsdc;
            pnlUsdc = int256(profit);
            payoutUsdc = margin + profit;
        } else {
            (feeUsdc,) = ImpactLib.splitLoss(amount, _lossFeeNow(pos.lossFeeBps));
            pnlUsdc = -int256(amount);
            payoutUsdc = margin - amount;
        }
        if (borrow > payoutUsdc) borrow = payoutUsdc;
        payoutUsdc -= borrow;
    }

    function execPrice(uint32 instrumentId, bool, bool) external view returns (uint256) {
        return _execPrice(instrumentId, _instrument(instrumentId));
    }

    function nextRequestId() external view returns (uint256) {
        return _nextRequestId;
    }

    function nextPositionId() external view returns (uint256) {
        return _nextPositionId;
    }

    function instrument(uint32 instrumentId) external view returns (Instrument memory) {
        return _instrument(instrumentId);
    }

    function instrumentCount() external view returns (uint32) {
        return uint32(_instruments.length);
    }

    function openInterest(uint32 instrumentId) external view returns (uint256 longUsd, uint256 shortUsd) {
        return (_longOiUsd[instrumentId], _shortOiUsd[instrumentId]);
    }

    function lpBalance() external view returns (uint256) {
        return _lpUsdc;
    }

    function feePool() external view returns (uint256) {
        return _feePoolUsdc;
    }

    function houseFreeUsdc() external view returns (uint256) {
        return _freeCash();
    }

    function houseExposureUsdc() external view returns (uint256) {
        return _bookExposureUsdc;
    }

    /// @dev The largest notional that passes `_openCheck` right now, by binary search over the
    ///      static ceiling (the check is monotone in the notional). 0 while any pause or the
    ///      breaker blocks opens.
    function maxPositionUsd(uint32 instrumentId, bool isLong) external view returns (uint256) {
        Instrument storage inst = _instrument(instrumentId);
        uint256 lo = 0;
        uint256 hi = inst.maxNotionalUsd;
        if (_openCheck(instrumentId, inst, isLong, 1, hi) == 0) return hi;
        while (hi - lo > 1e6) {
            uint256 mid = (lo + hi) / 2;
            if (_openCheck(instrumentId, inst, isLong, 1, mid) == 0) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    function openMaxPayoutUsdc() external view returns (uint256) {
        return _openMaxPayoutUsdc;
    }

    function sessionRouter() external view returns (address) {
        return _router;
    }

    function marketRules() external view returns (address) {
        return address(_rules);
    }

    function extension() external view returns (address) {
        return _ext;
    }

    function queueLength() external view returns (uint256) {
        return _queue.length;
    }

    function queueHead() external view returns (uint256) {
        return _queueHead;
    }

    function queueEntry(uint256 index) external view returns (address recipient, uint256 owedUsdc) {
        QueueEntry storage entry = _queue[index];
        return (entry.recipient, entry.owedUsdc);
    }

    function queuedTotal() external view returns (uint256) {
        return _queuedTotal;
    }

    function globalOpensPaused() external view returns (bool) {
        return _globalOpensPaused;
    }

    function breakerBps() external view returns (uint16) {
        return _breakerBps;
    }

    function breakerTripped() external view returns (bool) {
        return _breakerBlocks();
    }

    function breakerFloorUsdc() external view returns (uint128) {
        return _breakerFloorUsdc;
    }

    function winFeeBps() external view returns (uint16) {
        return _winFeeBps;
    }

    function lossFeeBps() external view returns (uint16) {
        return _lossFeeBps;
    }

    function borrowFreeHours() external view returns (uint16) {
        return _borrowFreeHours;
    }

    function stakerFeeShareBps() external view returns (uint16) {
        return _stakerFeeShareBps;
    }

    function minMarginUsdc() external view returns (uint64) {
        return _minMarginUsdc;
    }

    function rhoBps() external view returns (uint16) {
        return _rhoBps;
    }

    function maxWinBps() external view returns (uint16) {
        return _maxWinBps;
    }

    function minDelay() external view returns (uint32) {
        return _minDelay;
    }

    function grace() external view returns (uint32) {
        return _grace;
    }

    function expiry() external view returns (uint32) {
        return _expiry;
    }

    function maxJumpBps() external view returns (uint16) {
        return _maxJumpBps;
    }

    function isKeeper(address account) external view returns (bool) {
        return _keepers[account];
    }

    function breakerWindow() external view returns (uint64, uint256, int256) {
        return (_windowStart, _windowStartLp, _windowNetOutflow);
    }

    function usdc() external view returns (address) {
        return address(_usdc);
    }

    function oracle() external view returns (address) {
        return address(_oracle);
    }

    function staking() external view returns (address) {
        return address(_staking);
    }

    function referrals() external view returns (address) {
        return address(_referrals);
    }

    function pauseGuardian() external view returns (address) {
        return _pauseGuardian;
    }

    function marketKeeper() external view returns (address) {
        return _marketKeeper;
    }

    function feeRecipient() external view returns (address) {
        return _feeRecipient;
    }

    // ------------------------------------------------------------------ admin

    function addInstrument(Instrument calldata spec) external onlyOwner returns (uint32 instrumentId) {
        _rules.checkInstrument(spec);

        instrumentId = uint32(_instruments.length);
        Instrument storage inst = _instruments.push();
        inst.hlAssetIndex = spec.hlAssetIndex;
        inst.szDecimals = spec.szDecimals;
        inst.tier = spec.tier;
        inst.maxLeverage = spec.maxLeverage;
        inst.deadbandBps = spec.deadbandBps;
        inst.clampBps = spec.clampBps;
        inst.baseRateBps = spec.baseRateBps;
        inst.rateMultiplier = spec.rateMultiplier;
        inst.referenceNotionalUsd = spec.referenceNotionalUsd;
        inst.positionMultiplierE6 = spec.positionMultiplierE6;
        inst.longOiCapUsd = spec.longOiCapUsd;
        inst.shortOiCapUsd = spec.shortOiCapUsd;
        inst.maxNotionalUsd = spec.maxNotionalUsd;
        inst.payoutCapX = spec.payoutCapX;
        inst.posX10 = spec.posX10;
        inst.sideX10 = spec.sideX10;
        inst.stressBps = spec.stressBps;
        inst.entryDeadbandBps = spec.entryDeadbandBps;
        inst.borrowRateX10 = spec.borrowRateX10;
        _oracle.setInstrument(instrumentId, spec.hlAssetIndex, spec.szDecimals, spec.clampBps);

        emit InstrumentAdded(instrumentId, spec.hlAssetIndex, spec.szDecimals, spec.tier, spec.maxLeverage);
        emit HouseSizingSet(instrumentId, spec.posX10, spec.sideX10, spec.stressBps);
        emit MarketFeesSet(instrumentId, spec.entryDeadbandBps, spec.borrowRateX10);
    }

    function setInstrumentParams(
        uint32 instrumentId,
        uint16 deadbandBps,
        uint16 clampBps,
        uint16 baseRateBps,
        uint64 rateMultiplier,
        uint128 referenceNotionalUsd,
        uint128 positionMultiplierE6
    ) external onlyOwner {
        Instrument storage inst = _instrument(instrumentId);
        _rules.checkParams(
            deadbandBps, clampBps, baseRateBps, rateMultiplier, referenceNotionalUsd, positionMultiplierE6
        );

        bool clampChanged = inst.clampBps != clampBps;
        bool baseChanged = inst.baseRateBps != baseRateBps;
        inst.deadbandBps = deadbandBps;
        inst.clampBps = clampBps;
        inst.baseRateBps = baseRateBps;
        inst.rateMultiplier = rateMultiplier;
        inst.referenceNotionalUsd = referenceNotionalUsd;
        inst.positionMultiplierE6 = positionMultiplierE6;
        if (clampChanged) _oracle.setInstrument(instrumentId, inst.hlAssetIndex, inst.szDecimals, clampBps);
        if (baseChanged) _refreshExposure(instrumentId, inst);

        emit InstrumentParamsSet(
            instrumentId, deadbandBps, clampBps, baseRateBps, rateMultiplier, referenceNotionalUsd, positionMultiplierE6
        );
    }

    function setMaxLeverage(uint32 instrumentId, uint32 maxLeverage) external onlyOwner {
        _rules.checkLeverage(maxLeverage);
        _instrument(instrumentId).maxLeverage = maxLeverage;
        emit MaxLeverageSet(instrumentId, maxLeverage);
    }

    function setOiCaps(uint32 instrumentId, uint128 longOiCapUsd, uint128 shortOiCapUsd) external onlyKeeperOrOwner {
        Instrument storage inst = _instrument(instrumentId);
        _rules.checkOiCaps(inst.tier, longOiCapUsd, shortOiCapUsd);
        inst.longOiCapUsd = longOiCapUsd;
        inst.shortOiCapUsd = shortOiCapUsd;
        emit OiCapsSet(instrumentId, longOiCapUsd, shortOiCapUsd);
    }

    function setHouseSizing(uint32 instrumentId, uint16 posX10, uint16 sideX10, uint16 stressBps)
        external
        onlyKeeperOrOwner
    {
        Instrument storage inst = _instrument(instrumentId);
        _rules.checkHouseSizing(posX10, sideX10, stressBps);
        inst.posX10 = posX10;
        inst.sideX10 = sideX10;
        bool stressChanged = inst.stressBps != stressBps;
        inst.stressBps = stressBps;
        if (stressChanged) _refreshExposure(instrumentId, inst);
        emit HouseSizingSet(instrumentId, posX10, sideX10, stressBps);
    }

    function setPositionCaps(uint32 instrumentId, uint128 maxNotionalUsd, uint16 payoutCapX) external onlyOwner {
        Instrument storage inst = _instrument(instrumentId);
        _rules.checkPositionCaps(maxNotionalUsd, payoutCapX);
        inst.maxNotionalUsd = maxNotionalUsd;
        inst.payoutCapX = payoutCapX;
        emit PositionCapsSet(instrumentId, maxNotionalUsd, payoutCapX);
    }

    function setMarketFees(uint32 instrumentId, uint16 entryDeadbandBps, uint16 borrowRateX10) external onlyOwner {
        Instrument storage inst = _instrument(instrumentId);
        _rules.checkMarketFees(entryDeadbandBps, borrowRateX10);
        inst.entryDeadbandBps = entryDeadbandBps;
        inst.borrowRateX10 = borrowRateX10;
        emit MarketFeesSet(instrumentId, entryDeadbandBps, borrowRateX10);
    }

    function setBorrowFreeHours(uint16 newFreeHours) external onlyOwner {
        if (newFreeHours > MAX_BORROW_FREE_HOURS) revert ParamOutOfBounds(Param.BorrowFreeHours, newFreeHours);
        _borrowFreeHours = newFreeHours;
        emit BorrowFreeHoursSet(newFreeHours);
    }

    function setHouseWallet(address wallet, bool isHouse) external onlyOwner {
        if (wallet == address(0)) revert ZeroAddress();
        _houseWallets[wallet] = isHouse;
        emit HouseWalletSet(wallet, isHouse);
    }

    function setRhoBps(uint16 newRhoBps) external onlyOwner {
        if (newRhoBps < MIN_RHO_BPS || newRhoBps > BPS) revert ParamOutOfBounds(Param.RhoBps, newRhoBps);
        _rhoBps = newRhoBps;
        emit RhoBpsSet(newRhoBps);
    }

    function setMaxWinBps(uint16 newMaxWinBps) external onlyOwner {
        if (newMaxWinBps < MIN_MAX_WIN_BPS || newMaxWinBps > MAX_MAX_WIN_BPS) {
            revert ParamOutOfBounds(Param.MaxWinBps, newMaxWinBps);
        }
        _maxWinBps = newMaxWinBps;
        emit MaxWinBpsSet(newMaxWinBps);
    }

    function setMinMargin(uint64 newMinMarginUsdc) external onlyOwner {
        if (newMinMarginUsdc < MIN_MIN_MARGIN_USDC || newMinMarginUsdc > MAX_MIN_MARGIN_USDC) {
            revert ParamOutOfBounds(Param.MinMarginUsdc, newMinMarginUsdc);
        }
        _minMarginUsdc = newMinMarginUsdc;
        emit MinMarginSet(newMinMarginUsdc);
    }

    function setMarketOpensPaused(uint32 instrumentId, bool paused) external {
        _checkPauseAuthority(paused);
        _instrument(instrumentId).opensPaused = paused;
        emit MarketOpensPausedSet(instrumentId, paused);
    }

    function setGlobalOpensPaused(bool paused) external {
        _checkPauseAuthority(paused);
        _globalOpensPaused = paused;
        emit GlobalOpensPausedSet(paused);
    }

    function retire(uint32 instrumentId) external onlyOwner {
        Instrument storage inst = _liveInstrument(instrumentId);
        _freeze(instrumentId, inst, _oracle.oraclePrice(instrumentId));
    }

    function retireDead(uint32 instrumentId) external onlyOwner {
        Instrument storage inst = _liveInstrument(instrumentId);
        uint256 px18 = inst.lastPx18;
        if (px18 == 0) revert NoLastPrice(instrumentId);
        try _oracle.oraclePrice(instrumentId) returns (uint256) {
            revert FeedAlive(instrumentId);
        } catch {}
        _freeze(instrumentId, inst, px18);
    }

    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        if (newFeeRecipient == address(0)) revert ZeroAddress();
        _feeRecipient = newFeeRecipient;
        emit FeeRecipientSet(newFeeRecipient);
    }

    function setKeepers(address newPauseGuardian, address newMarketKeeper) external onlyOwner {
        _pauseGuardian = newPauseGuardian;
        _marketKeeper = newMarketKeeper;
        emit KeepersSet(newPauseGuardian, newMarketKeeper);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        _keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setDelays(uint32 newMinDelay, uint32 newGrace, uint32 newExpiry) external onlyOwner {
        _rules.checkDelays(newMinDelay, newGrace, newExpiry);
        _minDelay = newMinDelay;
        _grace = newGrace;
        _expiry = newExpiry;
        emit DelaysSet(newMinDelay, newGrace, newExpiry);
    }

    function setMaxJumpBps(uint16 newMaxJumpBps) external onlyOwner {
        if (newMaxJumpBps < MIN_MAX_JUMP_BPS || newMaxJumpBps > BPS) {
            revert ParamOutOfBounds(Param.MaxJumpBps, newMaxJumpBps);
        }
        _maxJumpBps = newMaxJumpBps;
        emit MaxJumpBpsSet(newMaxJumpBps);
    }

    function setBreakerBps(uint16 newBreakerBps) external onlyOwner {
        if (newBreakerBps < MIN_BREAKER_BPS || newBreakerBps > MAX_BREAKER_BPS) {
            revert ParamOutOfBounds(Param.BreakerBps, newBreakerBps);
        }
        _breakerBps = newBreakerBps;
        emit BreakerBpsSet(newBreakerBps);
    }

    function setBreakerFloor(uint128 newFloorUsdc) external onlyOwner {
        if (newFloorUsdc > MAX_BREAKER_FLOOR_USDC) revert ParamOutOfBounds(Param.BreakerFloorUsdc, newFloorUsdc);
        _breakerFloorUsdc = newFloorUsdc;
        emit BreakerFloorSet(newFloorUsdc);
    }

    function setFeeBps(uint16 newWinFeeBps, uint16 newLossFeeBps) external onlyOwner {
        if (newWinFeeBps > MAX_WIN_FEE_BPS) revert ParamOutOfBounds(Param.WinFeeBps, newWinFeeBps);
        if (newLossFeeBps > MAX_LOSS_FEE_BPS) revert ParamOutOfBounds(Param.LossFeeBps, newLossFeeBps);
        _winFeeBps = newWinFeeBps;
        _lossFeeBps = newLossFeeBps;
        emit FeeBpsSet(newWinFeeBps, newLossFeeBps);
    }

    function setStakerFeeShare(uint16 newShareBps) external onlyOwner {
        if (newShareBps > BPS) revert ParamOutOfBounds(Param.StakerFeeShareBps, newShareBps);
        _stakerFeeShareBps = newShareBps;
        emit StakerFeeShareSet(newShareBps);
    }

    function setReferralShare(uint16 newShareBps) external onlyOwner {
        _referrals.setShareBps(newShareBps);
    }

    function clearBreaker() external onlyOwner {
        if (!_breakerBlocks()) revert BreakerNotTripped();
        _startWindow();
        emit BreakerCleared(msg.sender);
    }

    // ------------------------------------------------------- internal: markets

    /// @dev A market that is not retired (yet).
    function _liveInstrument(uint32 instrumentId) private view returns (Instrument storage inst) {
        inst = _instrument(instrumentId);
        if (inst.retired) revert MarketRetired();
    }

    /// @dev Retire a market at `px18`: closes only, settled at that price from now on.
    function _freeze(uint32 instrumentId, Instrument storage inst, uint256 px18) private {
        inst.retired = true;
        inst.lastPx18 = px18;
        emit InstrumentRetired(instrumentId, px18);
    }
}
