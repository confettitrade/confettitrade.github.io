// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DepositProxy} from "../../../src/deposit/DepositProxy.sol";
import {DepositProxyFactory} from "../../../src/deposit/DepositProxyFactory.sol";
import {IExchange} from "../../../src/interfaces/IExchange.sol";
import {MockUSDC} from "../../../test/mocks/MockUSDC.sol";
import {StubExchange} from "../../../test/mocks/StubExchange.sol";
import {MockPriceSource} from "../../../test/mocks/MockPriceSource.sol";
import {MockFetti} from "../../../test/mocks/MockFetti.sol";
import {ConfettiDeployer, LaunchMarkets} from "../../../script/Deploy.s.sol";

/// @notice Stand-in for the CoreWriter system contract: records every raw action's sender and
///         the hash of its bytes (two slots, so a recorded action costs about what the mainnet
///         contract burns and fits the proxy's `CORE_STEPS_GAS`), and emits the same
///         `RawAction` event the mainnet contract does.
contract CoreWriterRecorder {
    event RawAction(address indexed user, bytes data);

    address[] internal _users;
    bytes32[] internal _dataHashes;

    function sendRawAction(bytes calldata data) external {
        _users.push(msg.sender);
        _dataHashes.push(keccak256(data));
        emit RawAction(msg.sender, data);
    }

    function count() external view returns (uint256) {
        return _dataHashes.length;
    }

    function actionAt(uint256 i) external view returns (address user, bytes32 dataHash) {
        return (_users[i], _dataHashes[i]);
    }
}

/// @notice Stand-in for Circle's CoreDepositWallet pause flag.
contract PausableStub {
    bool public paused;

    function setPaused(bool paused_) external {
        paused = paused_;
    }
}

/// @notice A read precompile (or `paused()`) that burns `burn` gas, then answers its first
///         `words` words of (w0, w1, w2). Etched over the real address.
contract GasBurningRead {
    uint256 internal immutable burn;
    uint256 internal immutable w0;
    uint256 internal immutable w1;
    uint256 internal immutable w2;
    uint256 internal immutable words;

    constructor(uint256 burn_, uint256 w0_, uint256 w1_, uint256 w2_, uint256 words_) {
        (burn, w0, w1, w2, words) = (burn_, w0_, w1_, w2_, words_);
    }

    fallback(bytes calldata) external returns (bytes memory out) {
        uint256 start = gasleft();
        while (start - gasleft() < burn) {}
        out = abi.encode(w0, w1, w2);
        uint256 len = 32 * words;
        assembly {
            mstore(out, len) // keep the first `words` words
        }
    }
}

/// @title DepositProxyTest
/// @notice Unit tests of the HyperCore deposit proxy against a recording CoreWriter, mocked
///         read precompiles and the Exchange stub. HyperCore itself is simulated by hand where a
///         test needs it: after a queued action the test sets the Core balances and mints the
///         USDC that CoreDepositWallet would pay out.
contract DepositProxyTest is Test {
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address constant CORE_DEPOSIT_WALLET = 0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24;
    address constant SPOT_BALANCE = 0x0000000000000000000000000000000000000801;
    address constant WITHDRAWABLE = 0x0000000000000000000000000000000000000803;
    address constant USDC_SYSTEM = 0x2000000000000000000000000000000000000000;

    // Proxy constants restated so a changed constant fails a test instead of passing silently.
    uint64 constant RESERVE = 5_000_000; // 0.05 USDC at 8 decimals
    uint64 constant MIN_BRIDGE = 100_000_000; // 1 USDC at 8 decimals
    uint64 constant MIN_PERP = 1_000_000; // 1 USDC at 6 decimals

    MockUSDC usdc;
    StubExchange exchange;
    DepositProxyFactory factory;
    CoreWriterRecorder writer;
    PausableStub cdw;

    address trader = makeAddr("trader");
    address stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new MockUSDC();
        exchange = new StubExchange(IERC20(address(usdc)));
        factory = new DepositProxyFactory(IExchange(address(exchange)));
        vm.etch(CORE_WRITER, address(new CoreWriterRecorder()).code);
        writer = CoreWriterRecorder(CORE_WRITER);
        vm.etch(CORE_DEPOSIT_WALLET, address(new PausableStub()).code);
        cdw = PausableStub(CORE_DEPOSIT_WALLET);
        _setCore(factory.proxyOf(trader), 0, 0, 0);
    }

    // ------------------------------------------------------------------ addresses

    function test_proxyOf_isTheCreate2AddressAndDeployIsIdempotent() public {
        address predicted = factory.proxyOf(trader);
        bytes32 initHash = keccak256(
            abi.encodePacked(type(DepositProxy).creationCode, abi.encode(trader, address(exchange), address(usdc)))
        );
        assertEq(predicted, vm.computeCreate2Address(bytes32(uint256(uint160(trader))), initHash, address(factory)));
        assertEq(predicted.code.length, 0, "exists before deploy");

        vm.expectEmit(address(factory));
        emit DepositProxyFactory.ProxyDeployed(trader, predicted);
        vm.prank(stranger);
        assertEq(factory.deploy(trader), predicted);

        DepositProxy p = DepositProxy(predicted);
        assertEq(p.trader(), trader);
        assertEq(address(p.exchange()), address(exchange));
        assertEq(address(p.usdc()), address(usdc));

        vm.recordLogs();
        assertEq(factory.deploy(trader), predicted);
        assertEq(vm.getRecordedLogs().length, 0, "redeployed");
    }

    function test_proxyOf_differsPerTraderAndPerExchange() public {
        address other = makeAddr("other");
        assertTrue(factory.proxyOf(trader) != factory.proxyOf(other));

        StubExchange exchange2 = new StubExchange(IERC20(address(usdc)));
        DepositProxyFactory factory2 = new DepositProxyFactory(IExchange(address(exchange2)));
        assertTrue(factory2.proxyOf(trader) != factory.proxyOf(trader));
    }

    function test_zeroAddresses_revert() public {
        vm.expectRevert(DepositProxyFactory.ZeroAddress.selector);
        factory.deploy(address(0));
        vm.expectRevert(DepositProxyFactory.ZeroAddress.selector);
        new DepositProxyFactory(IExchange(address(0)));
    }

    // ------------------------------------------------------------------- EVM leg

    function test_sweep_depositsEvmUsdcForTraderWhoeverCalls() public {
        address proxy = factory.proxyOf(trader);
        usdc.mint(proxy, 25e6);

        vm.prank(stranger);
        (uint256 deposited, uint64 bridged, uint64 perp) = factory.sweep(trader);

        assertEq(deposited, 25e6);
        assertEq(bridged, 0);
        assertEq(perp, 0);
        assertEq(exchange.balanceOf(trader), 25e6, "trader not credited");
        assertEq(exchange.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(proxy), 0);
        assertEq(usdc.allowance(proxy, address(exchange)), 0, "allowance left over");
        assertEq(writer.count(), 0, "core action without core balance");
    }

    // ------------------------------------------------------------------ Core legs

    function test_sweep_bridgesFreeSpotMinusReserveInWholeEvmUnits() public {
        address proxy = factory.proxyOf(trader);
        // 12.34567891 USDC on Core spot = 1_234_567_891 wei.
        _setCore(proxy, 1_234_567_891, 0, 0);

        (, uint64 bridged,) = factory.sweep(trader);

        // 1_234_567_891 - 5_000_000 reserve = 1_229_567_891, rounded down to a multiple of 100.
        assertEq(bridged, 1_229_567_800);
        _assertAction(
            0, proxy, abi.encodePacked(hex"01000006", abi.encode(USDC_SYSTEM, uint64(0), uint64(1_229_567_800)))
        );
        assertEq(writer.count(), 1);
    }

    function test_sweep_bridgesOnlyFromReservePlusMinimum() public {
        address proxy = factory.proxyOf(trader);
        _setCore(proxy, RESERVE + MIN_BRIDGE - 1, 0, 0);
        (, uint64 bridged,) = factory.sweep(trader);
        assertEq(bridged, 0);
        assertEq(writer.count(), 0);

        vm.roll(vm.getBlockNumber() + 1);
        _setCore(proxy, RESERVE + MIN_BRIDGE, 0, 0);
        (, bridged,) = factory.sweep(trader);
        assertEq(bridged, MIN_BRIDGE, "bridged must be exactly the minimum");
    }

    function test_sweep_neverBridgesHeldSpot() public {
        address proxy = factory.proxyOf(trader);
        _setCore(proxy, 500_000_000, 200_000_000, 0);
        (, uint64 bridged,) = factory.sweep(trader);
        // free = 500_000_000 - 200_000_000 = 300_000_000; minus the 5_000_000 reserve.
        assertEq(bridged, 295_000_000);
    }

    function test_sweep_movesPerpUsdcToOwnSpot() public {
        address proxy = factory.proxyOf(trader);
        _setCore(proxy, 0, 0, MIN_PERP - 1);
        (,, uint64 perp) = factory.sweep(trader);
        assertEq(perp, 0);
        assertEq(writer.count(), 0);

        vm.roll(vm.getBlockNumber() + 1);
        // 7.76288 USDC withdrawable on perp = 7_762_880 at 6 decimals = 776_288_000 wei at 8.
        _setCore(proxy, 0, 0, 7_762_880);
        (,, perp) = factory.sweep(trader);
        assertEq(perp, 776_288_000);
        _assertAction(
            0,
            proxy,
            abi.encodePacked(
                hex"0100000d",
                abi.encode(proxy, address(0), uint32(0), type(uint32).max, uint64(0), uint64(776_288_000))
            )
        );
    }

    function test_sweep_queuesCoreActionsOncePerBlock() public {
        address proxy = factory.proxyOf(trader);
        _setCore(proxy, 1_005_000_000, 0, 2_000_000);
        factory.sweep(trader);
        assertEq(writer.count(), 2);
        assertEq(DepositProxy(proxy).lastCoreActionBlock(), block.number);

        // Same block: the precompiles still show the old balances, so nothing is queued again,
        // while USDC that is already on HyperEVM still goes through.
        usdc.mint(proxy, 3e6);
        (uint256 deposited, uint64 bridged, uint64 perp) = factory.sweep(trader);
        assertEq(deposited, 3e6);
        assertEq(bridged, 0);
        assertEq(perp, 0);
        assertEq(writer.count(), 2);

        vm.roll(vm.getBlockNumber() + 1);
        factory.sweep(trader);
        assertEq(writer.count(), 4);
    }

    function test_sweep_holdsSpotWhileCoreDepositWalletIsPaused() public {
        address proxy = factory.proxyOf(trader);
        cdw.setPaused(true);
        // 10 USDC on spot (1_000_000_000 wei) and 2 USDC on perp (2_000_000 at 6 decimals).
        _setCore(proxy, 1_000_000_000, 0, 2_000_000);
        (, uint64 bridged, uint64 perp) = factory.sweep(trader);
        assertEq(bridged, 0, "bridged into a paused wallet");
        assertEq(perp, 200_000_000, "perp -> spot does not touch the wallet");

        vm.roll(vm.getBlockNumber() + 1);
        cdw.setPaused(false);
        _setCore(proxy, 1_000_000_000, 0, 0);
        (, bridged,) = factory.sweep(trader);
        assertEq(bridged, 995_000_000); // 1_000_000_000 - 5_000_000 reserve
    }

    /// @dev Review fix 10: a Core read that answers nothing (the unpinned precompile here) no
    ///      longer blocks the sweep: the Core steps are skipped, nothing is queued, and USDC
    ///      already on HyperEVM still reaches the Exchange.
    function test_sweep_coreReadFailure_skipsCoreSteps_stillDepositsEvmUsdc() public {
        address other = makeAddr("unpinned");
        address proxy = factory.deploy(other);
        usdc.mint(proxy, 4e6);
        (uint256 deposited, uint64 bridged, uint64 perp) = factory.sweep(other);
        assertEq(deposited, 4e6);
        assertEq(bridged + perp, 0);
        assertEq(exchange.balanceOf(other), 4e6);
        assertEq(writer.count(), 0);
        assertEq(DepositProxy(proxy).lastCoreActionBlock(), 0, "a failed Core step left its block mark");
    }

    /// @dev Review fix 10: answers longer than the expected words are read by their leading
    ///      words. Spot answers 4 words (12 USDC total, 0 hold, entryNtl, one extra word) and
    ///      perp 2 words (2 USDC, one extra): the sweep bridges 1_200_000_000 - 5_000_000 =
    ///      1_195_000_000 wei, moves 2_000_000 x 100 = 200_000_000 wei to spot, and deposits
    ///      the 25 USDC already on HyperEVM.
    function test_sweep_longerPrecompileAnswer_stillDepositsEvmUsdc() public {
        address proxy = factory.proxyOf(trader);
        vm.mockCall(
            SPOT_BALANCE,
            abi.encode(proxy, uint64(0)),
            abi.encode(uint64(1_200_000_000), uint64(0), uint64(0), uint256(7))
        );
        vm.mockCall(WITHDRAWABLE, abi.encode(proxy), abi.encode(uint64(2_000_000), uint256(7)));
        usdc.mint(proxy, 25e6);
        (uint256 deposited, uint64 bridged, uint64 perp) = factory.sweep(trader);
        assertEq(deposited, 25e6);
        assertEq(bridged, 1_195_000_000);
        assertEq(perp, 200_000_000);
        assertEq(exchange.balanceOf(trader), 25e6);
        assertEq(writer.count(), 2);
    }

    /// @dev Review fix 10, round 3: a reverting `CoreDepositWallet.paused()` counts as paused
    ///      and skips only the bridge; the perp leg (2 USDC = 200_000_000 wei) still moves and
    ///      HyperEVM USDC is still deposited.
    function test_sweep_pausedReadReverts_skipsOnlyBridge() public {
        address proxy = factory.proxyOf(trader);
        vm.etch(CORE_DEPOSIT_WALLET, hex"5f5ffd"); // PUSH0 PUSH0 REVERT
        _setCore(proxy, 1_000_000_000, 0, 2_000_000);
        usdc.mint(proxy, 6e6);
        (uint256 deposited, uint64 bridged, uint64 perp) = factory.sweep(trader);
        assertEq(deposited, 6e6);
        assertEq(bridged, 0);
        assertEq(perp, 200_000_000);
        assertEq(writer.count(), 1);
        assertEq(exchange.balanceOf(trader), 6e6);
    }

    /// @dev Round 2 fix A, round 3: a read precompile that fails by burning all the gas it
    ///      gets (the INVALID opcode 0xfe) costs at most its cap inside a self-call capped at
    ///      CORE_STEPS_GAS, so a first sweep (deploy included) at 1,200,000 gas still deposits
    ///      the EVM-side USDC; and it skips only its own leg. Spot burning: the 2 USDC perp
    ///      still moves (200_000_000 wei). Next block, perp burning: the 10 USDC spot still
    ///      bridges (1_000_000_000 - 5_000_000 reserve = 995_000_000).
    function test_sweep_gasBurningPrecompile_stillDepositsAtKeeperGasLimit() public {
        address proxy = factory.proxyOf(trader);
        vm.clearMockedCalls();
        vm.mockCall(WITHDRAWABLE, abi.encode(proxy), abi.encode(uint64(2_000_000)));
        vm.etch(SPOT_BALANCE, hex"fe");
        usdc.mint(proxy, 9e6);
        (uint256 deposited, uint64 bridged, uint64 perp) = factory.sweep{gas: 1_200_000}(trader);
        assertEq(deposited, 9e6);
        assertEq(bridged, 0);
        assertEq(perp, 200_000_000, "a failed spot read must not stop the perp leg");
        assertEq(exchange.balanceOf(trader), 9e6);
        assertEq(writer.count(), 1);

        vm.roll(vm.getBlockNumber() + 1);
        vm.clearMockedCalls();
        vm.etch(SPOT_BALANCE, "");
        vm.mockCall(SPOT_BALANCE, abi.encode(proxy, uint64(0)), abi.encode(uint64(1_000_000_000), uint64(0), uint64(0)));
        vm.etch(WITHDRAWABLE, hex"fe");
        usdc.mint(proxy, 3e6);
        (deposited, bridged, perp) = factory.sweep{gas: 1_200_000}(trader);
        assertEq(deposited, 3e6);
        assertEq(bridged, 995_000_000, "a failed perp read must not stop the bridge");
        assertEq(perp, 0);
        assertEq(exchange.balanceOf(trader), 12e6); // 9 + 3
    }

    /// @dev Round 3 item 2 (review test a): 0x801 answers 10 USDC free, but only after burning
    ///      1,000 gas past SPOT_BALANCE_GAS. The spot leg is skipped; the 2 USDC perp still
    ///      moves to spot (2_000_000 x 100 = 200_000_000 wei) with the block mark, and the 7 USDC
    ///      on HyperEVM is deposited. Control, next block: the same answer 10,000 gas under the
    ///      cap bridges 1_000_000_000 - 5_000_000 = 995_000_000.
    function test_sweep_spotReadOverCap_stillMovesPerp() public {
        DepositProxy p = DepositProxy(factory.deploy(trader));
        address proxy = address(p);
        uint256 cap = p.SPOT_BALANCE_GAS();
        vm.clearMockedCalls();
        vm.etch(SPOT_BALANCE, address(new GasBurningRead(cap + 1_000, 1_000_000_000, 0, 0, 3)).code);
        vm.mockCall(WITHDRAWABLE, abi.encode(proxy), abi.encode(uint64(2_000_000)));
        usdc.mint(proxy, 7e6);
        (uint256 deposited, uint64 bridged, uint64 perp) = p.sweep();
        assertEq(deposited, 7e6);
        assertEq(bridged, 0);
        assertEq(perp, 200_000_000);
        assertEq(writer.count(), 1);
        _assertAction(
            0,
            proxy,
            abi.encodePacked(
                hex"0100000d",
                abi.encode(proxy, address(0), uint32(0), type(uint32).max, uint64(0), uint64(200_000_000))
            )
        );
        assertEq(p.lastCoreActionBlock(), block.number);

        vm.roll(vm.getBlockNumber() + 1);
        vm.etch(SPOT_BALANCE, address(new GasBurningRead(cap - 10_000, 1_000_000_000, 0, 0, 3)).code);
        (, bridged,) = p.sweep();
        assertEq(bridged, 995_000_000);
    }

    /// @dev Round 3 item 2 (review test b): 0x803 answers 2 USDC after burning 1,000 gas past
    ///      WITHDRAWABLE_GAS. The perp leg is skipped; the 10 USDC spot still bridges
    ///      (995_000_000 wei, a spotSend to the system address).
    function test_sweep_perpReadOverCap_stillBridgesSpot() public {
        DepositProxy p = DepositProxy(factory.deploy(trader));
        address proxy = address(p);
        vm.clearMockedCalls();
        vm.etch(WITHDRAWABLE, address(new GasBurningRead(p.WITHDRAWABLE_GAS() + 1_000, 2_000_000, 0, 0, 1)).code);
        vm.mockCall(SPOT_BALANCE, abi.encode(proxy, uint64(0)), abi.encode(uint64(1_000_000_000), uint64(0), uint64(0)));
        (, uint64 bridged, uint64 perp) = p.sweep();
        assertEq(bridged, 995_000_000);
        assertEq(perp, 0);
        assertEq(writer.count(), 1);
        _assertAction(
            0, proxy, abi.encodePacked(hex"01000006", abi.encode(USDC_SYSTEM, uint64(0), uint64(995_000_000)))
        );
    }

    /// @dev Round 3 item 2: `paused()` burning past PAUSED_GAS (while answering "not paused")
    ///      counts as paused: the bridge waits, the 2 USDC perp leg still moves.
    function test_sweep_pausedReadOverCap_skipsOnlyBridge() public {
        DepositProxy p = DepositProxy(factory.deploy(trader));
        vm.etch(CORE_DEPOSIT_WALLET, address(new GasBurningRead(p.PAUSED_GAS() + 1_000, 0, 0, 0, 1)).code);
        _setCore(address(p), 1_000_000_000, 0, 2_000_000);
        (, uint64 bridged, uint64 perp) = p.sweep();
        assertEq(bridged, 0);
        assertEq(perp, 200_000_000);
    }

    /// @dev Round 3 item 2 (review test d): only the words used are read, as uint256 clamped
    ///      to uint64, so a large word never reverts the Core steps. Spot answers 12 USDC
    ///      total, 0 hold and an entryNtl of 2^200 (unused): 1_200_000_000 - 5_000_000 =
    ///      1_195_000_000 bridges, and the 2 USDC perp moves. Next block, perp answers 2^70:
    ///      clamped to 2^64 - 1, times 100 clamped again, so the move asks for 2^64 - 1 wei
    ///      (Core refuses what the account lacks) and the spot leg still bridges.
    function test_sweep_readWordsAboveUint64_clampedNeverBlock() public {
        address proxy = factory.proxyOf(trader);
        vm.mockCall(
            SPOT_BALANCE,
            abi.encode(proxy, uint64(0)),
            abi.encode(uint256(1_200_000_000), uint256(0), uint256(1) << 200)
        );
        vm.mockCall(WITHDRAWABLE, abi.encode(proxy), abi.encode(uint256(2_000_000)));
        (, uint64 bridged, uint64 perp) = factory.sweep(trader);
        assertEq(bridged, 1_195_000_000);
        assertEq(perp, 200_000_000);

        vm.roll(vm.getBlockNumber() + 1);
        vm.mockCall(WITHDRAWABLE, abi.encode(proxy), abi.encode(uint256(1) << 70));
        (, bridged, perp) = factory.sweep(trader);
        assertEq(bridged, 1_195_000_000);
        assertEq(perp, type(uint64).max);
    }

    /// @dev The Core steps are `sweep`'s alone: nobody else may call them.
    function test_coreSteps_selfOnly() public {
        DepositProxy p = DepositProxy(factory.deploy(trader));
        vm.prank(trader);
        vm.expectRevert(DepositProxy.NotSelf.selector);
        p.coreSteps();
    }

    /// @dev Perp -> spot -> HyperEVM -> Exchange, three sweeps, with HyperCore played by hand.
    ///      The Core gas fee is the mainnet sample 0.001593 USDC = 159_300 wei.
    function test_roundTrip_perpDepositReachesExchangeAndFeeComesOutOfTheNextDeposit() public {
        address proxy = factory.proxyOf(trader);
        uint64 fee = 159_300;

        // Trader sends 50 USDC to the proxy's perp balance: 50_000_000 at 6 decimals.
        _setCore(proxy, 0, 0, 50_000_000);
        (,, uint64 perp) = factory.sweep(trader);
        assertEq(perp, 5_000_000_000); // 50_000_000 * 100

        // Core moves it to spot.
        vm.roll(vm.getBlockNumber() + 1);
        _setCore(proxy, 5_000_000_000, 0, 0);
        (, uint64 bridged,) = factory.sweep(trader);
        assertEq(bridged, 4_995_000_000); // 5_000_000_000 - 5_000_000 reserve

        // Core charges the fee and CoreDepositWallet pays bridged / 100 on HyperEVM.
        vm.roll(vm.getBlockNumber() + 1);
        uint64 leftover = 5_000_000_000 - 4_995_000_000 - fee; // 4_840_700
        _setCore(proxy, leftover, 0, 0);
        usdc.mint(proxy, 49_950_000); // 4_995_000_000 / 100
        (uint256 deposited, uint64 bridgedAgain,) = factory.sweep(trader);
        assertEq(deposited, 49_950_000);
        assertEq(bridgedAgain, 0, "reserve was bridged");
        assertEq(exchange.balanceOf(trader), 49_950_000);

        // A second deposit of 20 USDC (2_000_000_000 wei) bridges 20 USDC minus the last fee,
        // which refills the reserve.
        vm.roll(vm.getBlockNumber() + 1);
        _setCore(proxy, leftover + 2_000_000_000, 0, 0);
        (, bridged,) = factory.sweep(trader);
        assertEq(bridged, 2_000_000_000 - fee); // 1_999_840_700, already a multiple of 100
    }

    // --------------------------------------------------------------- trader exits

    /// @dev Round 3 item 2 (review test c): Core perp USDC can always leave. With both read
    ///      precompiles dead (every sweep skips both Core legs), the trader alone queues the
    ///      perp -> own spot `sendAsset` for 7.76288 USDC (776_288_000 wei), then `returnToCore`
    ///      sends that spot USDC to their own Hyperliquid address. A stranger is refused.
    function test_perpToSpot_traderOnlyHatch_needsNoRead() public {
        DepositProxy p = DepositProxy(factory.deploy(trader));
        address proxy = address(p);
        vm.clearMockedCalls();
        vm.etch(SPOT_BALANCE, hex"fe");
        vm.etch(WITHDRAWABLE, hex"fe");
        (, uint64 bridged, uint64 perp) = p.sweep();
        assertEq(bridged + perp, 0);

        vm.prank(stranger);
        vm.expectRevert(DepositProxy.NotTrader.selector);
        p.perpToSpot(776_288_000);

        vm.expectEmit(proxy);
        emit DepositProxy.PerpMovedToSpot(776_288_000);
        vm.prank(trader);
        p.perpToSpot(776_288_000);
        _assertAction(
            0,
            proxy,
            abi.encodePacked(
                hex"0100000d",
                abi.encode(proxy, address(0), uint32(0), type(uint32).max, uint64(0), uint64(776_288_000))
            )
        );
        vm.prank(trader);
        p.returnToCore(0, 776_288_000);
        _assertAction(1, proxy, abi.encodePacked(hex"01000006", abi.encode(trader, uint64(0), uint64(776_288_000))));
        assertEq(writer.count(), 2);
    }

    function test_returnToCore_onlyTraderAndOnlyToTrader() public {
        DepositProxy p = DepositProxy(factory.deploy(trader));
        vm.prank(stranger);
        vm.expectRevert(DepositProxy.NotTrader.selector);
        p.returnToCore(0, RESERVE);

        // HYPE (Core token 150), 0.5 HYPE at 8 decimals.
        vm.prank(trader);
        p.returnToCore(150, 50_000_000);
        _assertAction(
            0, address(p), abi.encodePacked(hex"01000006", abi.encode(trader, uint64(150), uint64(50_000_000)))
        );
    }

    function test_rescue_onlyTraderAndOnlyToTrader() public {
        DepositProxy p = DepositProxy(factory.deploy(trader));
        usdc.mint(address(p), 7e6);
        vm.prank(stranger);
        vm.expectRevert(DepositProxy.NotTrader.selector);
        p.rescue(IERC20(address(usdc)), 7e6);

        vm.prank(trader);
        p.rescue(IERC20(address(usdc)), 7e6);
        assertEq(usdc.balanceOf(trader), 7e6);
        assertEq(usdc.balanceOf(address(p)), 0);
    }

    // ------------------------------------------------------------------- helpers

    /// @dev Pin what the read precompiles report for `who`: spot USDC (8-dec) and perp
    ///      withdrawable (6-dec).
    function _setCore(address who, uint64 spotTotal, uint64 spotHold, uint64 perpWithdrawable) internal {
        vm.mockCall(SPOT_BALANCE, abi.encode(who, uint64(0)), abi.encode(spotTotal, spotHold, uint64(0)));
        vm.mockCall(WITHDRAWABLE, abi.encode(who), abi.encode(perpWithdrawable));
    }

    function _assertAction(uint256 i, address expectedUser, bytes memory expectedData) internal view {
        (address user, bytes32 dataHash) = writer.actionAt(i);
        assertEq(user, expectedUser, "action sender");
        assertEq(dataHash, keccak256(expectedData), "action bytes");
    }
}

/// @title DepositProxyV4ExchangeTest
/// @notice The deposit proxy against the real v4 Exchange (core + extension, built by the
///         deployer): the factory the deploy makes is bound to the Exchange and its USDC, a
///         sweep credits the trader's trading balance (never house money), the trader can
///         withdraw or trade it, and the per-trader proxy address is fixed by the Exchange.
contract DepositProxyV4ExchangeTest is Test, ConfettiDeployer {
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address constant CORE_DEPOSIT_WALLET = 0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24;
    address constant SPOT_BALANCE = 0x0000000000000000000000000000000000000801;
    address constant WITHDRAWABLE = 0x0000000000000000000000000000000000000803;

    MockUSDC usdc;
    Deployment d;
    IExchange ex;
    DepositProxyFactory factory;
    CoreWriterRecorder writer;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address trader = makeAddr("trader");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        MockPriceSource source = new MockPriceSource();
        LaunchMarkets.Market[] memory m = LaunchMarkets.all();
        for (uint256 i = 0; i < m.length; i++) {
            source.setQuote(m[i].hlAssetIndex, 1_000_000, 1_000_000, 1_000_000);
        }
        Config memory cfg;
        cfg.usdc = address(usdc);
        cfg.owner = owner;
        cfg.guardian = makeAddr("guardian");
        cfg.marketKeeper = makeAddr("marketKeeper");
        cfg.keeper = keeper;
        cfg.feeRecipient = makeAddr("feeRecipient");
        cfg.priceSource = address(source);
        cfg.stakerFeeShareBps = DEFAULT_STAKER_FEE_SHARE_BPS;
        cfg.stakingWarmupS = DEFAULT_STAKING_WARMUP_S;
        cfg.winFeeBps = DEFAULT_WIN_FEE_BPS;
        cfg.lossFeeBps = DEFAULT_LOSS_FEE_BPS;
        cfg.rhoBps = DEFAULT_RHO_BPS;
        cfg.maxWinBps = DEFAULT_MAX_WIN_BPS;
        cfg.fetti = address(new MockFetti());
        d = _deploy(cfg, address(this));
        ex = IExchange(address(d.exchange));
        factory = d.depositFactory;
        vm.startPrank(owner);
        d.exchange.acceptOwnership();
        ex.setMarketOpensPaused(0, false);
        vm.stopPrank();

        vm.etch(CORE_WRITER, address(new CoreWriterRecorder()).code);
        writer = CoreWriterRecorder(CORE_WRITER);
        vm.etch(CORE_DEPOSIT_WALLET, address(new PausableStub()).code);
        _setCore(factory.proxyOf(trader), 0, 0, 0);
    }

    function _setCore(address who, uint64 spotTotal, uint64 spotHold, uint64 perpWithdrawable) internal {
        vm.mockCall(SPOT_BALANCE, abi.encode(who, uint64(0)), abi.encode(spotTotal, spotHold, uint64(0)));
        vm.mockCall(WITHDRAWABLE, abi.encode(who), abi.encode(perpWithdrawable));
    }

    function test_factoryIsBoundToTheV4Exchange() public view {
        assertEq(address(factory.exchange()), address(ex));
        assertEq(address(factory.usdc()), address(usdc));
        assertEq(address(factory.usdc()), ex.usdc());
        // The proxy address depends on the Exchange: another factory on another Exchange
        // gives another address for the same trader.
        assertTrue(factory.proxyOf(trader) != factory.proxyOf(stranger));
    }

    /// @dev A stranger sweeps; the v4 Exchange credits the trader's own balance, the USDC
    ///      lands in the Exchange, and none of it counts as house money.
    function test_sweep_creditsTheTraderOnTheV4Exchange() public {
        address proxy = factory.proxyOf(trader);
        usdc.mint(proxy, 25e6);
        vm.prank(stranger);
        (uint256 deposited, uint64 bridged, uint64 perp) = factory.sweep(trader);
        assertEq(deposited, 25e6);
        assertEq(bridged + perp, 0);
        assertEq(ex.balanceOf(trader), 25e6);
        assertEq(ex.balanceOf(stranger), 0);
        assertEq(ex.balanceOf(proxy), 0);
        assertEq(usdc.balanceOf(address(ex)), 25e6);
        assertEq(usdc.balanceOf(proxy), 0);
        assertEq(usdc.allowance(proxy, address(ex)), 0, "allowance left over");
        assertEq(ex.lpBalance(), 0);
        assertEq(ex.houseFreeUsdc(), 0);
        assertEq(writer.count(), 0);

        // The credit is the trader's to withdraw in full.
        vm.prank(trader);
        ex.withdraw(25e6);
        assertEq(usdc.balanceOf(trader), 25e6);
        assertEq(usdc.balanceOf(address(ex)), 0);
    }

    /// @dev Swept funds trade like any deposit: with house money in, the trader opens from the
    ///      credited balance and the margin leaves the available balance.
    function test_sweptFundsOpenAPosition() public {
        usdc.mint(owner, 10_000e6);
        vm.startPrank(owner);
        usdc.approve(address(ex), 10_000e6);
        ex.depositHouse(10_000e6);
        vm.stopPrank();

        usdc.mint(factory.proxyOf(trader), 30e6);
        factory.sweep(trader);
        vm.prank(trader);
        uint256 rid = ex.requestOpen(0, true, 10e6, 10, address(0));
        assertEq(ex.balanceOf(trader), 20e6);
        assertEq(ex.pendingOf(trader), 10e6);
        skip(5);
        vm.prank(keeper);
        uint256 pid = ex.executeOpen(rid);
        assertEq(ex.positions(pid).owner, trader);
        assertEq(ex.marginInUse(trader), 10e6);
        assertEq(ex.lpBalance(), 10_000e6);
    }

    /// @dev Nothing on the proxy and nothing on Core: a sweep moves nothing and credits nothing.
    function test_sweep_emptyIsANoOp() public {
        (uint256 deposited, uint64 bridged, uint64 perp) = factory.sweep(trader);
        assertEq(deposited + bridged + perp, 0);
        assertEq(ex.balanceOf(trader), 0);
        assertEq(usdc.balanceOf(address(ex)), 0);
        assertEq(writer.count(), 0);
    }

    /// @dev Repeated sweeps add up on the v4 balance.
    function test_sweep_twiceAddsUp() public {
        address proxy = factory.proxyOf(trader);
        usdc.mint(proxy, 7e6);
        factory.sweep(trader);
        vm.roll(vm.getBlockNumber() + 1);
        usdc.mint(proxy, 3e6);
        factory.sweep(trader);
        assertEq(ex.balanceOf(trader), 10e6);
        assertEq(usdc.balanceOf(address(ex)), 10e6);
    }
}
