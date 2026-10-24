// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IExchange} from "../interfaces/IExchange.sol";

/// @notice HyperEVM system contract that queues HyperCore actions (docs/HYPERCORE-DEPOSITS.md 3).
interface ICoreWriter {
    function sendRawAction(bytes calldata data) external;
}

/// @notice Circle's CoreDepositWallet, the HyperEVM contract HyperCore USDC is linked to.
interface ICoreDepositWallet {
    function paused() external view returns (bool);
}

/// @title DepositProxy
/// @notice One per trader, deployed by `DepositProxyFactory` with CREATE2 at an address the site
///         can show before it exists. The trader sends USDC on HyperCore (Hyperliquid) to this
///         address; anyone calls `sweep()` until the money sits in the trader's Exchange balance.
/// @dev The path, verified on mainnet (docs/HYPERCORE-DEPOSITS.md):
///        1. Core USDC on this address's perp balance (standard account mode, `usdSend`) is
///           moved to its own spot balance with a CoreWriter `sendAsset` (action 13).
///        2. Core spot USDC is sent to the USDC system address `0x2000…0000` with a CoreWriter
///           `spotSend` (action 6). HyperCore then runs a system transaction from that address
///           calling `CoreDepositWallet.transfer(this, wei / 100)`, which pays native Circle
///           USDC (`0xb883…630f`, the Exchange's token) to this contract, in the next EVM block
///           on the observed mainnet sample.
///        3. USDC held here on HyperEVM goes to `exchange.depositFor(trader, balance)`.
///      One `sweep()` runs every step that has something to do, so a deposit from spot takes two
///      sweeps (steps 2 then 3, a block apart) and one from perp takes three. CoreWriter actions
///      fail silently on HyperCore (for example when the Core gas fee spikes past the reserve);
///      the money then stays where it was and the next sweep retries. The bridge step is skipped
///      while CoreDepositWallet is paused: its `transfer` would revert, and what HyperCore does
///      with an amount it already debited for a failed system transaction is not documented.
///      The Core steps (1 and 2) run in a self-call (`coreSteps`) under try/catch, so a
///      reverting CoreWriter call skips them for this sweep and USDC already on HyperEVM is
///      still deposited (step 3). Inside, the two legs are independent: each read returns
///      (ok, value) instead of reverting, so a failed, short or over-cap spot read (or a
///      failing `paused()`) only skips the bridge and a failed perp read only skips the
///      perp-to-spot move. Answers are read by the leading words used, as uint256 clamped to
///      uint64. Gas is bounded so a Core failure that burns all it gets cannot starve step 3
///      either: the self-call gets at most `CORE_STEPS_GAS`, the spot read `SPOT_BALANCE_GAS`,
///      the perp read `WITHDRAWABLE_GAS`, `paused()` `PAUSED_GAS`.
///      Core gas fee: the spot send to the system address charges the sender about 200k EVM gas
///      in USDC on top of the amount (0.0016 to 0.014 USDC over 7 days on mainnet). The proxy
///      therefore always leaves `CORE_FEE_RESERVE_WEI` on its Core spot balance; each later
///      deposit refills what the fee took, so the trader pays the actual fee per bridge and the
///      reserve itself stays retrievable with `returnToCore`.
///      Funds can only ever go to the trader: to their Exchange balance (sweep), back to their
///      own HyperCore address (`returnToCore`, from spot), to this address's own spot balance
///      (`perpToSpot`, then `returnToCore` or a sweep) or to their wallet (`rescue`). The last
///      three are trader-only escape hatches for a paused CoreDepositWallet, a precompile read
///      that keeps failing, a token sent by mistake or an Exchange that refuses deposits. No
///      owner, no upgrade.
contract DepositProxy {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------- HyperCore constants

    /// @notice CoreWriter system contract.
    address public constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    /// @notice Circle's CoreDepositWallet, the `evmContract` HyperCore token 0 (USDC) is linked
    ///         to (spotMeta and the token-info precompile 0x80C, checked on mainnet).
    address public constant CORE_DEPOSIT_WALLET = 0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24;
    /// @notice Read precompile: `abi.encode(address user, uint64 token)` ->
    ///         `(uint64 total, uint64 hold, uint64 entryNtl)`, amounts in Core token wei.
    address public constant SPOT_BALANCE_PRECOMPILE = 0x0000000000000000000000000000000000000801;
    /// @notice Read precompile: `abi.encode(address user)` -> `uint64 withdrawable`, perp USD
    ///         with 6 decimals (verified: 7_762_880 read for an account the info API shows at
    ///         7.76288 withdrawable).
    address public constant WITHDRAWABLE_PRECOMPILE = 0x0000000000000000000000000000000000000803;
    /// @notice System address of Core token 0 (USDC): 0x20 followed by the big-endian index.
    address public constant USDC_SYSTEM_ADDRESS = 0x2000000000000000000000000000000000000000;
    /// @notice Core token index of USDC (spotMeta `index`).
    uint64 public constant USDC_TOKEN = 0;
    /// @notice `sendAsset` dex id for the spot balance.
    uint32 public constant SPOT_DEX = type(uint32).max;
    /// @notice `sendAsset` dex id for the default (validator-operated) perp dex.
    uint32 public constant PERP_DEX = 0;
    /// @notice Core USDC wei per EVM USDC unit: Core weiDecimals 8, EVM decimals 6,
    ///         spotMeta `evm_extra_wei_decimals` -2, so 10^(8-6) = 100.
    uint64 public constant WEI_PER_EVM_UNIT = 100;
    /// @notice Core spot USDC left behind on every bridge to pay the Core gas fee:
    ///         0.05 USDC = 5 * 10^6 wei at 8 decimals. 3.5x the largest USDC-paid fee seen over
    ///         7 days (0.013996) and the same buffer a live contract keeps on this path.
    uint64 public constant CORE_FEE_RESERVE_WEI = 5_000_000;
    /// @notice Smallest spot amount bridged, above the reserve: 1 USDC = 10^8 wei.
    uint64 public constant MIN_BRIDGE_WEI = 100_000_000;
    /// @notice Smallest perp balance moved to spot: 1 USDC = 10^6 perp units.
    uint64 public constant MIN_PERP_USD = 1_000_000;

    uint24 private constant ACTION_SPOT_SEND = 6;
    uint24 private constant ACTION_SEND_ASSET = 13;
    uint8 private constant ACTION_VERSION = 1;

    /// @notice Gas cap of the spot-balance read: about 16x its measured mainnet cost of 6,280.
    uint256 public constant SPOT_BALANCE_GAS = 100_000;
    /// @notice Gas cap of the withdrawable read: about 19x its measured mainnet cost of 3,112.
    uint256 public constant WITHDRAWABLE_GAS = 60_000;
    /// @notice Gas cap of `CoreDepositWallet.paused()`, an upgradeable proxy: about 10x its
    ///         mainnet cost of about 10,400 from a contract (eth_estimateGas 28,858 for the
    ///         bare call, less 21,064 intrinsic, plus 2,600 for the cold account).
    uint256 public constant PAUSED_GAS = 100_000;
    /// @notice Gas cap of the Core steps: the three capped calls (260,000 at their caps), the
    ///         block mark and two CoreWriter actions (the whole step measured 99,254 on
    ///         mainnet) fit inside it.
    uint256 public constant CORE_STEPS_GAS = 400_000;

    // ------------------------------------------------------------------------ state

    /// @notice The only beneficiary.
    address public immutable trader;
    /// @notice Exchange credited by `sweep`.
    IExchange public immutable exchange;
    /// @notice HyperEVM USDC (the Exchange's token).
    IERC20 public immutable usdc;
    /// @notice Block of the last sweep that queued a Core action. Core balances read through
    ///         the precompiles do not reflect actions queued in the same block, so a second
    ///         sweep in that block would queue the same send again; it skips the Core steps.
    uint256 public lastCoreActionBlock;

    // ----------------------------------------------------------------------- events

    /// @param depositedUsdc HyperEVM USDC credited to the trader on the Exchange (6-dec).
    /// @param bridgedWei Core spot USDC queued to HyperEVM (8-dec wei; arrives as wei / 100).
    /// @param perpToSpotWei Core perp USDC queued to this address's spot balance (8-dec wei).
    event Swept(uint256 depositedUsdc, uint64 bridgedWei, uint64 perpToSpotWei);
    event ReturnedToCore(uint64 indexed token, uint64 weiAmount);
    /// @param weiAmount Core perp USDC the trader queued to this address's spot balance (8-dec).
    event PerpMovedToSpot(uint64 weiAmount);
    event Rescued(address indexed token, uint256 amount);

    // ----------------------------------------------------------------------- errors

    error NotTrader();
    error NotSelf();

    constructor(address trader_, IExchange exchange_, IERC20 usdc_) {
        trader = trader_;
        exchange = exchange_;
        usdc = usdc_;
    }

    // -------------------------------------------------------------------- external

    /// @notice Move whatever this address holds one step closer to the trader's Exchange
    ///         balance. Anyone may call; calling with nothing to do is a no-op.
    /// @return depositedUsdc See `Swept`.
    /// @return bridgedWei See `Swept`.
    /// @return perpToSpotWei See `Swept`.
    function sweep() external returns (uint256 depositedUsdc, uint64 bridgedWei, uint64 perpToSpotWei) {
        // Core legs, isolated: whatever fails there must not hold up the HyperEVM leg.
        if (lastCoreActionBlock != block.number) {
            try this.coreSteps{gas: CORE_STEPS_GAS}() returns (uint64 bridged, uint64 perpToSpot) {
                bridgedWei = bridged;
                perpToSpotWei = perpToSpot;
            } catch {}
        }

        // HyperEVM leg.
        depositedUsdc = usdc.balanceOf(address(this));
        if (depositedUsdc != 0) {
            usdc.forceApprove(address(exchange), depositedUsdc);
            exchange.depositFor(trader, depositedUsdc);
        }

        if (depositedUsdc != 0 || bridgedWei != 0 || perpToSpotWei != 0) {
            emit Swept(depositedUsdc, bridgedWei, perpToSpotWei);
        }
    }

    /// @notice Self only (`sweep`'s try/catch): decide each Core leg from its own read, record
    ///         the block, then queue the CoreWriter actions. A failed read skips only its leg.
    /// @return bridgedWei See `Swept`.
    /// @return perpToSpotWei See `Swept`.
    function coreSteps() external returns (uint64 bridgedWei, uint64 perpToSpotWei) {
        if (msg.sender != address(this)) revert NotSelf();
        (bool spotOk, uint64 free) = _spotUsdcFree();
        if (spotOk && free >= CORE_FEE_RESERVE_WEI + MIN_BRIDGE_WEI && _depositWalletOpen()) {
            bridgedWei = free - CORE_FEE_RESERVE_WEI;
            // Whole EVM units only: Core burns a remainder below 1 EVM unit.
            bridgedWei -= bridgedWei % WEI_PER_EVM_UNIT;
        }
        (bool perpOk, uint64 perpUsd) = _perpWithdrawable();
        if (perpOk && perpUsd >= MIN_PERP_USD) perpToSpotWei = _u64(uint256(perpUsd) * WEI_PER_EVM_UNIT);

        if (bridgedWei != 0 || perpToSpotWei != 0) {
            lastCoreActionBlock = block.number;
            if (bridgedWei != 0) {
                _coreAction(ACTION_SPOT_SEND, abi.encode(USDC_SYSTEM_ADDRESS, USDC_TOKEN, bridgedWei));
            }
            if (perpToSpotWei != 0) {
                _coreAction(
                    ACTION_SEND_ASSET,
                    abi.encode(address(this), address(0), PERP_DEX, SPOT_DEX, USDC_TOKEN, perpToSpotWei)
                );
            }
        }
    }

    /// @notice Trader only: send `weiAmount` of Core spot token `token` from this address back
    ///         to the trader's own HyperCore address (`spotSend`). Recovers the fee reserve, a
    ///         wrong token, or USDC that cannot be bridged (for example a paused
    ///         CoreDepositWallet).
    /// @param token Core token index (0 = USDC).
    /// @param weiAmount Amount in that token's Core wei.
    function returnToCore(uint64 token, uint64 weiAmount) external {
        if (msg.sender != trader) revert NotTrader();
        _coreAction(ACTION_SPOT_SEND, abi.encode(trader, token, weiAmount));
        emit ReturnedToCore(token, weiAmount);
    }

    /// @notice Trader only: move `weiAmount` of Core perp USDC on this address to its own spot
    ///         balance (`sendAsset`, the action `sweep` queues), without reading any precompile.
    ///         Core perp USDC can always leave this way: then `returnToCore(0, …)` or a sweep.
    /// @param weiAmount Core USDC wei (8-dec; 1 USDC = 10^8).
    function perpToSpot(uint64 weiAmount) external {
        if (msg.sender != trader) revert NotTrader();
        _coreAction(ACTION_SEND_ASSET, abi.encode(address(this), address(0), PERP_DEX, SPOT_DEX, USDC_TOKEN, weiAmount));
        emit PerpMovedToSpot(weiAmount);
    }

    /// @notice Trader only: send `amount` of a HyperEVM ERC-20 held here to the trader's wallet.
    /// @param token Token to send (USDC included, for an Exchange that refuses deposits).
    /// @param amount Token units.
    function rescue(IERC20 token, uint256 amount) external {
        if (msg.sender != trader) revert NotTrader();
        token.safeTransfer(trader, amount);
        emit Rescued(address(token), amount);
    }

    // -------------------------------------------------------------------- internal

    /// @dev Header: version byte 1, then the action id as 3 big-endian bytes, then the raw ABI
    ///      encoding of the action's fields (Hyperliquid docs, "Interacting with HyperCore").
    function _coreAction(uint24 actionId, bytes memory fields) private {
        ICoreWriter(CORE_WRITER).sendRawAction(abi.encodePacked(ACTION_VERSION, actionId, fields));
    }

    /// @dev Free Core spot USDC of this address (total minus hold, the two leading words of
    ///      the answer), 8-dec wei clamped to uint64. Not ok: the read failed or answered short.
    function _spotUsdcFree() private view returns (bool ok, uint64 free) {
        bytes memory out;
        (ok, out) = SPOT_BALANCE_PRECOMPILE.staticcall{gas: SPOT_BALANCE_GAS}(abi.encode(address(this), USDC_TOKEN));
        if (!ok || out.length < 64) return (false, 0);
        (uint256 total, uint256 hold) = abi.decode(out, (uint256, uint256));
        free = _u64(total > hold ? total - hold : 0);
    }

    /// @dev Withdrawable Core perp USDC of this address, 6-dec (the leading word of the
    ///      answer) clamped to uint64. Not ok: the read failed or answered short.
    function _perpWithdrawable() private view returns (bool ok, uint64 usd) {
        bytes memory out;
        (ok, out) = WITHDRAWABLE_PRECOMPILE.staticcall{gas: WITHDRAWABLE_GAS}(abi.encode(address(this)));
        if (!ok || out.length < 32) return (false, 0);
        usd = _u64(abi.decode(out, (uint256)));
    }

    /// @dev True only when `CoreDepositWallet.paused()` answers false: a revert, a short answer
    ///      or a call over `PAUSED_GAS` counts as paused and skips only the bridge.
    function _depositWalletOpen() private view returns (bool) {
        (bool ok, bytes memory out) =
            CORE_DEPOSIT_WALLET.staticcall{gas: PAUSED_GAS}(abi.encodeCall(ICoreDepositWallet.paused, ()));
        return ok && out.length >= 32 && abi.decode(out, (uint256)) == 0;
    }

    function _u64(uint256 x) private pure returns (uint64) {
        return x > type(uint64).max ? type(uint64).max : uint64(x);
    }
}
