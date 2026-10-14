// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";

/// @title StubExchange
/// @notice Minimal stand-in for the Exchange, covering only the hooks the token stack calls:
///         `depositFor` (Staking.claim), `lpBalance` / `queuedTotal` / `sweepLpToStakers`
///         (Tokenomics.pushStakerFees), plus helpers so tests can act as the Exchange.
/// @dev Not an IExchange implementation; it deliberately does not touch trading.
contract StubExchange {
    IERC20 public immutable usdc;
    address public staking;

    /// @notice Settable LP cash reported to Tokenomics.
    uint256 public lpBalance;

    /// @notice Settable queue total reported to Tokenomics.
    uint256 public queuedTotal;

    /// @notice Last amount passed to `sweepLpToStakers` and how many times it was called.
    uint256 public lastSweptUsdc;
    uint256 public sweepCalls;

    /// @notice Exchange balances credited by `depositFor`.
    mapping(address => uint256) public balanceOf;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    /// @notice Point the stub at the Staking contract it forwards sweeps to.
    function setStaking(address staking_) external {
        staking = staking_;
    }

    /// @notice Set what `lpBalance()` and `queuedTotal()` report.
    function setLp(uint256 lpBalance_, uint256 queuedTotal_) external {
        lpBalance = lpBalance_;
        queuedTotal = queuedTotal_;
    }

    /// @notice Pull USDC from the caller and credit `beneficiary`, like the real `depositFor`.
    function depositFor(address beneficiary, uint256 amountUsdc) external {
        require(usdc.transferFrom(msg.sender, address(this), amountUsdc), "stub: pull failed");
        balanceOf[beneficiary] += amountUsdc;
    }

    /// @notice Record a sweep and, when a Staking address is set, hand the USDC over via `notifyReward`.
    function sweepLpToStakers(uint256 amountUsdc) external {
        require(queuedTotal == 0, "stub: queue active");
        require(amountUsdc <= lpBalance, "stub: exceeds lp");
        lpBalance -= amountUsdc;
        lastSweptUsdc = amountUsdc;
        sweepCalls += 1;
        if (staking != address(0)) _notify(amountUsdc);
    }

    /// @notice Act as the Exchange: approve and notify a staking reward from the stub's USDC.
    function notifyStaking(uint256 amountUsdc) external {
        _notify(amountUsdc);
    }

    function _notify(uint256 amountUsdc) internal {
        usdc.approve(staking, amountUsdc);
        IStaking(staking).notifyReward(amountUsdc);
    }
}
