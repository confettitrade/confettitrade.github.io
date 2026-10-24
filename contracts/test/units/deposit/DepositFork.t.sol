// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DepositProxy} from "../../../src/deposit/DepositProxy.sol";
import {DepositProxyFactory} from "../../../src/deposit/DepositProxyFactory.sol";
import {IExchange} from "../../../src/interfaces/IExchange.sol";
import {ConfettiDeployer, LaunchMarkets} from "../../../script/Deploy.s.sol";
import {MockPriceSource} from "../../../test/mocks/MockPriceSource.sol";
import {MockFetti} from "../../../test/mocks/MockFetti.sol";

/// @notice The parts of Circle's CoreDepositWallet the fork test touches.
interface ICoreDepositWallet {
    function token() external view returns (address);
    function tokenSystemAddress() external view returns (address);
    function paused() external view returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title DepositForkTest
/// @notice HyperEVM mainnet fork of the HyperCore -> Exchange deposit path, against a v4
///         Exchange deployed on the fork on live USDC, the live CoreWriter bytecode and
///         Circle's live CoreDepositWallet.
/// @dev What runs for real on the fork: the HyperCore token link read from the token-info
///      precompile (via `vm.rpc`), the CoreWriter system contract (it has bytecode, 544 B, and
///      emits `RawAction`), CoreDepositWallet paying native USDC when called by the USDC system
///      address, USDC itself, and the v4 Exchange's `depositFor` (the price source and FETTI
///      behind that Exchange are local mocks: the deposit path never reads them).
///      What cannot run on a fork, because it happens inside HyperCore and not in the EVM:
///        - executing the queued actions (that HyperCore accepts the spotSend / sendAsset,
///          charges the gas fee, and debits the proxy's Core balance);
///        - the system transaction from `0x2000…0000` that follows a spotSend to it; the test
///          sends that call itself with `vm.prank`;
///        - read precompiles reflecting Core state (they have no bytecode; the test pins them
///          with `vm.mockCall`, using the live return data where a live value exists);
///        - account activation (a never-funded Core address cannot send CoreWriter actions) and
///          where a `usdSend` lands for this address (perp or spot, by account mode).
///      Mainnet history covers the first two: the fixtures below are the raw CoreWriter actions
///      of a live contract running the same two steps, and the test proves the proxy emits the
///      same bytes for the same amounts.
///      Skipped (no RPC call at all) unless FORK_URL is set:
///        FORK_URL=https://rpc.hyperliquid.xyz/evm forge test --match-contract DepositForkTest
///          --no-isolate --disable-block-gas-limit
contract DepositForkTest is Test, ConfettiDeployer {
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant CORE_DEPOSIT_WALLET = 0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24;
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address constant USDC_SYSTEM = 0x2000000000000000000000000000000000000000;
    address constant SPOT_BALANCE = 0x0000000000000000000000000000000000000801;
    address constant WITHDRAWABLE = 0x0000000000000000000000000000000000000803;
    address constant TOKEN_INFO = 0x000000000000000000000000000000000000080C;
    string constant FALLBACK_RPC = "https://hyperliquid.drpc.org";

    /// @dev Live contract that bridges Core USDC to itself on HyperEVM through CoreWriter.
    address constant LIVE_BRIDGER = 0x1A284A8A9BB9738928DB9ee866072B56a2982451;

    /// @dev `RawAction.data` of HyperEVM tx 0x74cf74eef8181e560addcad8656eaf2d5e0e3073759e5f71b3936cfc09583a4d
    ///      (block 48755031): spotSend(0x2000…0000, token 0, 53_308_918_300 wei) from LIVE_BRIDGER.
    ///      HyperCore ledger: spotTransfer 533.089183 USDC to 0x2000…0000, fee 0.001593 USDC.
    ///      Next block (48755032), tx 0xed1131a6230bb3dde6d32af264cb7f9990a69d9e2311e9e7d5ff47b11a7addaf:
    ///      CoreDepositWallet `Withdraw(LIVE_BRIDGER, 533_089_183)`.
    bytes constant LIVE_SPOT_SEND = hex"01000006" hex"0000000000000000000000002000000000000000000000000000000000000000"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"0000000000000000000000000000000000000000000000000000000c69758a1c";

    /// @dev `RawAction.data` of HyperEVM tx 0xc2a18c81339e674b6de776ae100017f5196ad26dcdff9fda777ce057b496451d
    ///      (block 48754946): sendAsset(LIVE_BRIDGER, sub 0, perp dex 0 -> spot dex 2^32-1,
    ///      token 0, 53_313_918_300 wei). HyperCore ledger: send 533.139183 USDC, sourceDex "",
    ///      destinationDex "spot", fee 0.
    bytes constant LIVE_SEND_ASSET = hex"0100000d" hex"0000000000000000000000001a284a8a9bb9738928db9ee866072b56a2982451"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"00000000000000000000000000000000000000000000000000000000ffffffff"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"0000000000000000000000000000000000000000000000000000000c69c1d55c";

    /// @dev Return shape of the token-info precompile (0x80C).
    struct TokenInfo {
        string name;
        uint64[] spots;
        uint64 deployerTradingFeeShare;
        address deployer;
        address evmContract;
        uint8 szDecimals;
        uint8 weiDecimals;
        int8 evmExtraWeiDecimals;
    }

    bool forked;
    DepositProxyFactory factory;
    IExchange exchange;
    address trader = makeAddr("trader");
    address proxy;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        _selectFork(url);
        assertEq(block.chainid, 999, "not HyperEVM");
        exchange = _deployV4();
        factory = new DepositProxyFactory(exchange);
        proxy = factory.proxyOf(trader);
        // A never-seen address: pin the live answers (zeros, but the live length and shape).
        _pin(SPOT_BALANCE, abi.encode(proxy, uint64(0)));
        _pin(WITHDRAWABLE, abi.encode(proxy));
        forked = true;
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// @notice HyperCore's USDC (token 0) is linked to Circle's CoreDepositWallet, which pays out
    ///         exactly the token the Exchange holds.
    function test_fork_coreUsdcIsLinkedToTheExchangeToken() public onlyFork {
        TokenInfo memory info = abi.decode(_ethCall(TOKEN_INFO, abi.encode(uint32(0))), (TokenInfo));
        assertEq(info.name, "USDC");
        assertEq(info.evmContract, CORE_DEPOSIT_WALLET, "Core USDC linked elsewhere");
        assertEq(info.weiDecimals, 8);
        assertEq(int256(info.evmExtraWeiDecimals), -2, "Core 8 dec -> EVM 6 dec");

        ICoreDepositWallet cdw = ICoreDepositWallet(CORE_DEPOSIT_WALLET);
        assertEq(cdw.token(), USDC);
        assertEq(cdw.tokenSystemAddress(), USDC_SYSTEM);
        assertFalse(cdw.paused());
        assertEq(exchange.usdc(), USDC);
        assertEq(address(factory.usdc()), USDC);
    }

    /// @notice A fresh proxy reads zero on Core and a sweep queues nothing.
    function test_fork_freshProxySweepIsANoOp() public onlyFork {
        vm.recordLogs();
        (uint256 deposited, uint64 bridged, uint64 perp) = factory.sweep(trader);
        assertEq(deposited + bridged + perp, 0);
        assertEq(_rawActions().length, 0);
        assertGt(proxy.code.length, 0, "not deployed");
    }

    /// @notice End to end on the fork: Core spot USDC -> spotSend through the live CoreWriter
    ///         (byte-identical to the live fixture) -> CoreDepositWallet pays the proxy -> the
    ///         v4 Exchange credits the trader.
    function test_fork_spotDepositReachesTheLiveExchange() public onlyFork {
        // The live bridger held 533.139183 USDC on spot and sent 533.089183: the bridged amount
        // plus exactly this proxy's 0.05 USDC reserve (53_308_918_300 + 5_000_000 wei).
        uint64 spotWei = 53_313_918_300;
        vm.mockCall(SPOT_BALANCE, abi.encode(proxy, uint64(0)), abi.encode(spotWei, uint64(0), uint64(0)));

        vm.recordLogs();
        (, uint64 bridged,) = factory.sweep(trader);
        assertEq(bridged, 53_308_918_300);
        Vm.Log[] memory actions = _rawActions();
        assertEq(actions.length, 1);
        assertEq(address(uint160(uint256(actions[0].topics[1]))), proxy, "action not from the proxy");
        assertEq(abi.decode(actions[0].data, (bytes)), LIVE_SPOT_SEND, "differs from the live spotSend");

        // HyperCore's system transaction: CoreDepositWallet pays wei / 100 = 533_089_183.
        uint256 credit = uint256(bridged) / 100;
        vm.prank(USDC_SYSTEM);
        assertTrue(ICoreDepositWallet(CORE_DEPOSIT_WALLET).transfer(proxy, credit));
        assertEq(IERC20(USDC).balanceOf(proxy), credit);

        // Next block; Core now shows only the reserve minus the 0.001593 USDC fee.
        vm.roll(vm.getBlockNumber() + 1);
        vm.mockCall(
            SPOT_BALANCE, abi.encode(proxy, uint64(0)), abi.encode(uint64(5_000_000 - 159_300), uint64(0), uint64(0))
        );
        uint256 traderBefore = exchange.balanceOf(trader);
        uint256 vaultBefore = IERC20(USDC).balanceOf(address(exchange));

        vm.recordLogs();
        (uint256 deposited, uint64 bridgedAgain,) = factory.sweep(trader);
        assertEq(deposited, credit);
        assertEq(bridgedAgain, 0);
        assertEq(_rawActions().length, 0, "reserve bridged");
        assertEq(exchange.balanceOf(trader) - traderBefore, credit, "trader not credited");
        assertEq(IERC20(USDC).balanceOf(address(exchange)) - vaultBefore, credit);
        assertEq(IERC20(USDC).balanceOf(proxy), 0);
    }

    /// @notice Perp -> own spot through the live CoreWriter, same bytes as the live sendAsset but
    ///         for the proxy's own address.
    function test_fork_perpMoveMatchesTheLiveSendAsset() public onlyFork {
        // 533.139183 USDC withdrawable on perp = 533_139_183 at 6 decimals.
        vm.mockCall(WITHDRAWABLE, abi.encode(proxy), abi.encode(uint64(533_139_183)));

        vm.recordLogs();
        (,, uint64 perp) = factory.sweep(trader);
        assertEq(perp, 53_313_918_300); // 533_139_183 * 100
        Vm.Log[] memory actions = _rawActions();
        assertEq(actions.length, 1);

        // The live fixture with its first field (destination = sender) set to the proxy.
        bytes memory expected = LIVE_SEND_ASSET;
        bytes32 dest;
        assembly {
            dest := mload(add(expected, 36)) // 32 (length word) + 4 (header)
        }
        assertEq(address(uint160(uint256(dest))), LIVE_BRIDGER, "fixture is not the live bridger's own move");
        dest = bytes32(uint256(uint160(proxy)));
        assembly {
            mstore(add(expected, 36), dest)
        }
        assertEq(abi.decode(actions[0].data, (bytes)), expected, "differs from the live sendAsset");
    }

    // ------------------------------------------------------------------- helpers

    /// @dev CoreWriter `RawAction(address indexed user, bytes data)` logs recorded since the last
    ///      `vm.recordLogs()`.
    function _rawActions() internal view returns (Vm.Log[] memory out) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("RawAction(address,bytes)");
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == CORE_WRITER && logs[i].topics[0] == topic) n++;
        }
        out = new Vm.Log[](n);
        n = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == CORE_WRITER && logs[i].topics[0] == topic) out[n++] = logs[i];
        }
    }

    function _pin(address precompile, bytes memory input) internal {
        vm.mockCall(precompile, input, _ethCall(precompile, input));
    }

    /// @dev `eth_call` against the fork's RPC; vm.rpc decodes the hex result into raw bytes.
    function _ethCall(address to, bytes memory data) internal returns (bytes memory) {
        string memory params =
            string.concat('[{"to":"', vm.toString(to), '","data":"', vm.toString(data), '"},"latest"]');
        return vm.rpc("eth_call", params);
    }

    /// @dev A v4 system on live USDC; this contract is every role but the deposit path needs
    ///      none of them.
    function _deployV4() internal returns (IExchange) {
        MockPriceSource source = new MockPriceSource();
        LaunchMarkets.Market[] memory m = LaunchMarkets.all();
        for (uint256 i = 0; i < m.length; i++) {
            source.setQuote(m[i].hlAssetIndex, 1_000_000, 1_000_000, 1_000_000);
        }
        Config memory cfg;
        cfg.usdc = USDC;
        cfg.owner = address(this);
        cfg.guardian = makeAddr("guardian");
        cfg.marketKeeper = makeAddr("marketKeeper");
        cfg.keeper = makeAddr("keeper");
        cfg.feeRecipient = makeAddr("feeRecipient");
        cfg.priceSource = address(source);
        cfg.stakerFeeShareBps = DEFAULT_STAKER_FEE_SHARE_BPS;
        cfg.stakingWarmupS = DEFAULT_STAKING_WARMUP_S;
        cfg.winFeeBps = DEFAULT_WIN_FEE_BPS;
        cfg.lossFeeBps = DEFAULT_LOSS_FEE_BPS;
        cfg.rhoBps = DEFAULT_RHO_BPS;
        cfg.maxWinBps = DEFAULT_MAX_WIN_BPS;
        cfg.fetti = address(new MockFetti());
        Deployment memory dep = _deploy(cfg, address(this));
        return IExchange(address(dep.exchange));
    }

    function _selectFork(string memory url) internal {
        if (_tryFork(url)) return;
        if (_tryFork(FALLBACK_RPC)) return;
        revert("DepositForkTest: no RPC reachable");
    }

    function _tryFork(string memory url) internal returns (bool) {
        for (uint256 attempt = 0; attempt < 3; attempt++) {
            try vm.createSelectFork(url) returns (uint256) {
                return true;
            } catch {}
        }
        return false;
    }
}
