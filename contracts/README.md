# ALMM Contracts

Solidity contracts for [ALMM](../README.md) — the Four.meme market-maker CLI.

## What's in here

- `src/FourmemeMmRouter.sol` — Atomic router for create+devBuy, volume round-trip, turnover, and PancakeSwap-routed volume (Week 3 deliverable, not yet implemented).
- `src/interfaces/` — External contract interfaces (TokenManager2, PancakeRouter02, IERC20).
- `test/` — Foundry tests (fork BSC mainnet).
- `script/Deploy.s.sol` — Deployment script for BSC mainnet.

## Build

```bash
cd contracts
forge build
```

## Test

```bash
forge test -vvv --fork-url $BSC_RPC_URL
```

## Deploy

```bash
forge script script/Deploy.s.sol --rpc-url bsc --broadcast --verify
```
