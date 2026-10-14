# Contracts

The Solidity behind confetti.trade on HyperEVM (chain 999): the Exchange and the Referrals book it creates, the PriceOracle and its precompile source, the CONFETTI token, Tokenomics and Staking. All seven are verified on Sourcify as exact matches of both creation and runtime bytecode, metadata hash included, so the code at each address is this code byte for byte. Built with Foundry on solc 0.8.26 (commit 8a97fa7a), optimizer on at 200 runs, via_ir, evm cancun, OpenZeppelin v5.1.0 and forge-std v1.17.0 under lib/ (paths in remappings.txt). PrecompilePriceSource went out on 12 Oct from the same source compiled without via_ir. The 13 Oct deploy record with constructor arguments and transaction hashes is broadcast/Deploy.s.sol/999/run-latest.json, script/Deploy.s.sol produced it, and test/ holds the suites.

Exchange 0x257d667a52b282ac0b4c001fd437522bf6b9cbe2
https://repo.sourcify.dev/999/0x257d667a52b282ac0b4c001fd437522bf6b9cbe2/

Referrals 0x0879fe6298a6b987173b29693af4ade6d63c19da (created by the Exchange constructor)
https://repo.sourcify.dev/999/0x0879fe6298a6b987173b29693af4ade6d63c19da/

PriceOracle 0x7a5eff5e2288e53ed78de6cdc7f08c68ed4400cc
https://repo.sourcify.dev/999/0x7a5eff5e2288e53ed78de6cdc7f08c68ed4400cc/

PrecompilePriceSource 0xFaF573187824D176fc74d1de91a072eb6ffa8494
https://repo.sourcify.dev/999/0xFaF573187824D176fc74d1de91a072eb6ffa8494/

Confetti 0x665c84fbf77629c8ba6bfe76d9fedd2d9a7b2b75
https://repo.sourcify.dev/999/0x665c84fbf77629c8ba6bfe76d9fedd2d9a7b2b75/

Tokenomics 0xb9dc9c1271732067aed0068d81b118a638764c0a
https://repo.sourcify.dev/999/0xb9dc9c1271732067aed0068d81b118a638764c0a/

Staking 0x318535af817913fd33cd4088f2c56fc5ddcab50d
https://repo.sourcify.dev/999/0x318535af817913fd33cd4088f2c56fc5ddcab50d/

Machine-readable: https://sourcify.dev/server/v2/contract/999/ followed by the address. USDC is Circle's 0xb88339CB7199b77E23DB6E890353E22632Ba630f.
