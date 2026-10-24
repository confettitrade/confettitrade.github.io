// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IExchange} from "../interfaces/IExchange.sol";
import {DepositProxy} from "./DepositProxy.sol";

/// @title DepositProxyFactory
/// @notice Deploys one `DepositProxy` per trader with CREATE2 (salt = trader address) and
///         sweeps it. `proxyOf(trader)` is the address the site shows as "send USDC on
///         Hyperliquid here"; it is fixed by this factory's address, the proxy bytecode, the
///         trader and the Exchange, and holds before the proxy is deployed.
/// @dev One factory per Exchange: a new Exchange needs a new factory, so every trader gets a
///      new deposit address with it, and an old proxy keeps depositing into the old Exchange.
///      No owner, no settings.
contract DepositProxyFactory {
    /// @notice Exchange every proxy deposits into.
    IExchange public immutable exchange;
    /// @notice The Exchange's USDC, read once at deploy.
    IERC20 public immutable usdc;

    event ProxyDeployed(address indexed trader, address indexed proxy);

    error ZeroAddress();

    constructor(IExchange exchange_) {
        if (address(exchange_) == address(0)) revert ZeroAddress();
        address usdc_ = exchange_.usdc();
        if (usdc_ == address(0)) revert ZeroAddress();
        exchange = exchange_;
        usdc = IERC20(usdc_);
    }

    /// @notice Deterministic deposit address of `trader`, deployed or not.
    function proxyOf(address trader) public view returns (address) {
        return Create2.computeAddress(_salt(trader), keccak256(_initCode(trader)));
    }

    /// @notice Deploy `trader`'s proxy if it has no code yet. Anyone may call.
    /// @return proxy The proxy address (equals `proxyOf(trader)`).
    function deploy(address trader) public returns (address proxy) {
        if (trader == address(0)) revert ZeroAddress();
        proxy = proxyOf(trader);
        if (proxy.code.length == 0) {
            new DepositProxy{salt: _salt(trader)}(trader, exchange, usdc);
            emit ProxyDeployed(trader, proxy);
        }
    }

    /// @notice Deploy `trader`'s proxy if needed, then `sweep()` it. Anyone may call.
    function sweep(address trader) external returns (uint256 depositedUsdc, uint64 bridgedWei, uint64 perpToSpotWei) {
        return DepositProxy(deploy(trader)).sweep();
    }

    function _salt(address trader) private pure returns (bytes32) {
        return bytes32(uint256(uint160(trader)));
    }

    function _initCode(address trader) private view returns (bytes memory) {
        return abi.encodePacked(type(DepositProxy).creationCode, abi.encode(trader, exchange, usdc));
    }
}
