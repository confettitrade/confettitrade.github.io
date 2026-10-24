# Confetti v4 contracts

HyperEVM (chain 999), deployed from block 48983821. Not upgradeable: no proxy, no settable
extension. The Exchange answers the whole combined ABI (`verify/abi/IExchange.json`): the core runs the
trading entry points and delegatecalls ExchangeExt for house money, setters and views.

| Contract | Address | Sourcify | hyperevmscan |
|---|---|---|---|
| PriceOracle | `0x1fa6c831868527c65c33e14fd2456855458e03ba` | https://repo.sourcify.dev/999/0x1fa6c831868527c65c33e14fd2456855458e03ba/ | https://hyperevmscan.io/address/0x1fa6c831868527c65c33e14fd2456855458e03ba#code |
| Staking | `0x2bf4976eb70cdcc03871ab60977fc4292587ce9a` | https://repo.sourcify.dev/999/0x2bf4976eb70cdcc03871ab60977fc4292587ce9a/ | https://hyperevmscan.io/address/0x2bf4976eb70cdcc03871ab60977fc4292587ce9a#code |
| ExchangeExt | `0xd23f1c74a64a5fb6f6a68da854d33d736918cbb0` | https://repo.sourcify.dev/999/0xd23f1c74a64a5fb6f6a68da854d33d736918cbb0/ | https://hyperevmscan.io/address/0xd23f1c74a64a5fb6f6a68da854d33d736918cbb0#code |
| Exchange | `0x533d0bc51bafeb1519f1bac93d48c175b1496063` | https://repo.sourcify.dev/999/0x533d0bc51bafeb1519f1bac93d48c175b1496063/ | https://hyperevmscan.io/address/0x533d0bc51bafeb1519f1bac93d48c175b1496063#code |
| Referrals | `0x1dCDBe02568169A777Ad6D2b3C5edcF5058780dA` | https://repo.sourcify.dev/999/0x1dCDBe02568169A777Ad6D2b3C5edcF5058780dA/ | https://hyperevmscan.io/address/0x1dCDBe02568169A777Ad6D2b3C5edcF5058780dA#code |
| MarketRules | `0xE1E48BF50B8aF7D44e7f1ED3422598E381aAb72d` | https://repo.sourcify.dev/999/0xE1E48BF50B8aF7D44e7f1ED3422598E381aAb72d/ | https://hyperevmscan.io/address/0xE1E48BF50B8aF7D44e7f1ED3422598E381aAb72d#code |
| SessionRouter | `0x5477ab941a551874596AeEB16D3bCf79A120351d` | https://repo.sourcify.dev/999/0x5477ab941a551874596AeEB16D3bCf79A120351d/ | https://hyperevmscan.io/address/0x5477ab941a551874596AeEB16D3bCf79A120351d#code |
| DepositProxyFactory | `0xe5bb8b4703787f428aaa6a3755add72b9c82fb75` | https://repo.sourcify.dev/999/0xe5bb8b4703787f428aaa6a3755add72b9c82fb75/ | https://hyperevmscan.io/address/0xe5bb8b4703787f428aaa6a3755add72b9c82fb75#code |
| PrecompilePriceSource | `0xFaF573187824D176fc74d1de91a072eb6ffa8494` | https://repo.sourcify.dev/999/0xFaF573187824D176fc74d1de91a072eb6ffa8494/ | https://hyperevmscan.io/address/0xFaF573187824D176fc74d1de91a072eb6ffa8494#code |

Owner of Exchange, Staking and PriceOracle: the owner wallet `0x028e6bc799cab8c42a6f78a30b2c6d901e8a4161` (it deployed them). FETTI is the existing token
`0x995b36d7e33680fc6fa1db6fa4dc8e475b5233a2` (v4 deploys no token and holds no role on it); Staking stakes it.
Build: solc 0.8.26, optimizer 200 runs, via_ir, OpenZeppelin 5.1.0 (`foundry.toml`).
