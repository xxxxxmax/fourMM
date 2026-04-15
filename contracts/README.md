# fourMM Contracts

Solidity contracts for [fourMM](../README.md) — the Four.meme market-maker CLI on BSC.

## Deployed

| Contract | Address | Verified |
|----------|---------|----------|
| FourmemeMmRouter v2 | [`0xd62c2fd94176f98424af83e4b9a333d454b2216c`](https://bscscan.com/address/0xd62c2fd94176f98424af83e4b9a333d454b2216c) | Yes |

## FourmemeMmRouter v2

Stateless pass-through router with reentrancy guard. Three functions:

### `volume(token, minTokenOut, minBnbBack)` payable
Atomic buy+sell on the bonding curve in a single tx. Generates on-chain volume with zero net token position. Slippage-protected on both legs.

### `turnover(token, recipient, minTokenOut)` payable
Buy tokens on the bonding curve and deliver them to a different wallet. Used for cross-group holder distribution (wallet A pays BNB, wallet B receives tokens).

### `volumePancake(token, minTokenOut, minBnbBack)` payable
Same as `volume()` but for graduated tokens on PancakeSwap V2. Uses `swapExactTokensForETHSupportingFeeOnTransferTokens` for fee-on-transfer compatibility.

### Security
- `nonReentrant` modifier on all external functions
- ERC20 approval reset to 0 after every sell (no dangling allowance)
- Remaining BNB refunded to `msg.sender` after each call
- No admin, no fees, no upgradability

## Interfaces

- `ITokenManager2` — Four.meme V2 (buyTokenAMAP, sellToken, createToken)
- `ITokenManagerHelper3` — Unified query (getTokenInfo, tryBuy, trySell)
- `IPancakeRouter02` — PancakeSwap V2 (swapExactETHForTokens, getAmountsOut, etc.)
- `IERC20` — Standard ERC20 (approve, balanceOf, transfer)

## Build

```bash
cd contracts
forge build
```

## Test

```bash
forge test -vvv --fork-url https://meme.bsc.blockrazor.xyz
```

## Deploy

```bash
forge script script/Deploy.s.sol --rpc-url https://meme.bsc.blockrazor.xyz --broadcast --verify
```
