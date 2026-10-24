// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ConfettiDeployer, LaunchMarkets} from "../../script/Deploy.s.sol";
import {IExchange} from "../../src/interfaces/IExchange.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockPriceSource} from "../mocks/MockPriceSource.sol";
import {MockFetti} from "../mocks/MockFetti.sol";

/// @notice The real v4 deployment (ConfettiDeployer) over mock USDC, a mock HyperCore price
///         source and a mock FETTI (the existing token), with the five roles distinct and accepted by `owner`.
///         Shared by the invariant suite and the house fuzz tests.
abstract contract V4Fixture is Test, ConfettiDeployer {
    MockUSDC internal usdc;
    MockPriceSource internal source;
    MockFetti internal fetti;
    Deployment internal d;
    IExchange internal ex;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal marketKeeper = makeAddr("marketKeeper");
    address internal keeper = makeAddr("keeper");
    address internal feeRecipient = makeAddr("feeRecipient");

    /// @dev Every launch market quoted at raw 1_000_000 (DOGE $1, BTC $100K: the raw quote
    ///      carries 6 - szDecimals implied decimals).
    uint64 internal constant LAUNCH_RAW_PX = 1_000_000;

    function _deployV4() internal {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        source = new MockPriceSource();
        fetti = new MockFetti();
        LaunchMarkets.Market[] memory m = LaunchMarkets.all();
        for (uint256 i = 0; i < m.length; i++) {
            source.setQuote(m[i].hlAssetIndex, LAUNCH_RAW_PX, LAUNCH_RAW_PX, LAUNCH_RAW_PX);
        }
        Config memory cfg;
        cfg.usdc = address(usdc);
        cfg.owner = owner;
        cfg.guardian = guardian;
        cfg.marketKeeper = marketKeeper;
        cfg.keeper = keeper;
        cfg.feeRecipient = feeRecipient;
        cfg.priceSource = address(source);
        cfg.stakerFeeShareBps = DEFAULT_STAKER_FEE_SHARE_BPS;
        cfg.stakingWarmupS = DEFAULT_STAKING_WARMUP_S;
        cfg.winFeeBps = DEFAULT_WIN_FEE_BPS;
        cfg.lossFeeBps = DEFAULT_LOSS_FEE_BPS;
        cfg.rhoBps = DEFAULT_RHO_BPS;
        cfg.maxWinBps = DEFAULT_MAX_WIN_BPS;
        cfg.fetti = address(fetti);
        cfg.v3Referrals = address(0);
        d = _deploy(cfg, address(this));
        ex = IExchange(address(d.exchange));
        vm.startPrank(owner);
        d.exchange.acceptOwnership();
        d.staking.acceptOwnership();
        d.oracle.acceptOwnership();
        vm.stopPrank();
        usdc.mint(owner, 1e15);
        vm.prank(owner);
        usdc.approve(address(ex), type(uint256).max);
    }

    function _unpause(uint32 id) internal {
        vm.prank(owner);
        ex.setMarketOpensPaused(id, false);
    }
}
