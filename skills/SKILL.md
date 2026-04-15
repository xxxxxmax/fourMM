---
name: fourmm
description: fourMM — Agent-first market-making CLI for Four.meme on BSC. Create tokens, trade (buy/sell/sniper), pump/dump via Flashbot bundles, generate volume, manage wallets, transfer funds.
requires_bin: fourmm
install: pnpm install && pnpm build && npx fourmm skills add
---

# fourMM

Market-making CLI for [Four.meme](https://four.meme) on BNB Smart Chain.

## Setup

```sh
# Clone & build
git clone <repo-url> && cd fourMM
pnpm install && pnpm build

# Install skills for your agent
npx fourmm skills add

# Or start as MCP server
npx fourmm --mcp

# Initialize config (BlockRazor MEV-protected RPC)
fourmm config init

# Create wallets
fourmm wallet create-group --name main --count 5

# Fund wallets
fourmm transfer out --from <your-funded-wallet> --to-group 1 --value 0.01
```

**Environment:** Set `FOURMM_PASSWORD` to avoid `--password` on every command.

---

## Intent Routing

### I want to create a token
```sh
fourmm token create --name "Name" --symbol "SYM" --image logo.png --dev-wallet <groupId> [--preset-buy 0.01]
```

### I want to buy tokens
```sh
# All wallets in group buy the same amount
fourmm trade buy --group <id> --token <CA> --amount <BNB> [--slippage 500]

# Each wallet buys a different amount
fourmm trade sniper --group <id> --token <CA> --amounts "0.01,0.02,0.05"
```

### I want to sell tokens
```sh
# Sell everything
fourmm trade sell --group <id> --token <CA> --amount all

# Sell 50%
fourmm trade sell --group <id> --token <CA> --amount 50%

# Sell fixed amount
fourmm trade sell --group <id> --token <CA> --amount 1000000
```

### I want to pump the price
```sh
fourmm tools robot-price --group <id> --token <CA> --direction up --target-price <BNB_PER_TOKEN> --amount <BNB_PER_ROUND>
```
All wallets' buys are bundled via Flashbot (`eth_sendBundle`) — atomic, same block, no MEV.

### I want to dump the price
```sh
fourmm tools robot-price --group <id> --token <CA> --direction down --target-price <BNB_PER_TOKEN> --amount <BNB_PER_ROUND>
```

### I want to generate volume
```sh
# Atomic buy+sell per wallet (zero net position, generates on-chain volume)
fourmm tools volume --group <id> --token <CA> --amount <BNB> --rounds 10

# Single atomic round-trip per wallet
fourmm trade batch --group <id> --token <CA> --amount <BNB>
```

### I want to distribute holder count
```sh
# Group A pays BNB, Group B receives tokens (via Router.turnover)
fourmm tools turnover --from-group <A> --to-group <B> --token <CA> --amount <BNB>
```

### I want to check my positions
```sh
fourmm query monitor --group <id> --token <CA>    # Holdings + PnL
fourmm query balance --address <ADDR>               # BNB balance
fourmm query price --token <CA>                     # Live price
fourmm query transactions --group <id>              # Trade history
```

### I want to manage wallets
```sh
fourmm wallet create-group --name <NAME> --count <N>  # Create group
fourmm wallet list-groups                              # List all groups
fourmm wallet group-info --id <ID>                     # View wallets
fourmm wallet generate --group <ID> --count <N>        # Add wallets
fourmm wallet add --group <ID> --private-key <KEY>     # Import key
fourmm wallet remove --group <ID> --address <ADDR>     # Remove wallet
fourmm wallet import --group <ID> --file wallets.csv   # Bulk import
fourmm wallet export --group <ID> --file out.csv       # Export keys
fourmm wallet delete-group --id <ID> --force           # Delete group
fourmm wallet overview                                 # Aggregate PnL
```

### I want to move funds
```sh
fourmm transfer out --from <ADDR> --to-group <ID> --value <BNB>           # Distribute
fourmm transfer in --to <ADDR> --from-group <ID> --amount all             # Collect all
fourmm transfer in --to <ADDR> --from-group <ID> --amount reserve --value 0.002  # Keep reserve
fourmm transfer many-to-many --from-group <A> --to-group <B>              # Pair transfer
```

### I want to check a token
```sh
fourmm token info --ca <CA>              # Full on-chain metadata
fourmm token identify --ca <CA>          # Variant: standard / anti-sniper / tax / x-mode
fourmm token graduate-status --ca <CA>   # Graduation progress
fourmm token pool --ca <CA>              # Pool / liquidity info
fourmm query kline --token <CA>          # K-line candles (graduated only)
```

### I want to change config
```sh
fourmm config get                           # View all
fourmm config get --key rpcUrl              # View one
fourmm config set rpcUrl <URL>              # Change RPC
fourmm config set defaultSlippageBps 500    # Change slippage
fourmm config init                          # Reset to defaults
```

---

## Key Concepts

**Wallet Groups:** Wallets are organized in numbered groups (1, 2, 3...). Each group has N wallets. Trade/volume/transfer commands operate on entire groups.

**Bonding Curve vs PancakeSwap:** Tokens start on Four.meme's bonding curve. After raising 18 BNB, they "graduate" to PancakeSwap. fourMM auto-detects and routes accordingly.

**Token Variants:**
- `standard` — normal token, fully supported
- `anti-sniper-fee` — dynamic fee decreasing block-by-block, supported (use higher slippage)
- `tax-token` — fourMM refuses (round-trip loss too high)
- `x-mode` — fourMM refuses (special buy interface)

**Slippage:** In basis points. 300 = 3%, 500 = 5%, 1500 = 15%. Higher = more tolerance for price movement.

**Flashbot Bundle:** `robot-price` signs all wallets' txs offline and submits via `eth_sendBundle`. All execute in the same block or none do. No public mempool exposure.

**Router Contract:** `0xd62c2fd94176f98424af83e4b9a333d454b2216c` — atomic `volume()` (buy+sell), `turnover()` (buy for another wallet), `volumePancake()` (graduated tokens).

---

## Common Workflows

### Launch + Market Make
```sh
fourmm wallet create-group --name launch --count 10
fourmm transfer out --from <funded-wallet> --to-group 1 --value 0.05
fourmm token create --name "My Token" --symbol "MTK" --image logo.png --dev-wallet 1 --preset-buy 0.01
# Wait for CA in output, then:
fourmm tools volume --group 1 --token <CA> --amount 0.01 --rounds 20
fourmm tools robot-price --group 1 --token <CA> --direction up --target-price 0.00001 --amount 0.01
```

### Snipe + Dump
```sh
fourmm trade sniper --group 1 --token <CA> --amounts "0.05,0.03,0.02,0.01,0.01"
fourmm query monitor --group 1 --token <CA>
# When ready:
fourmm trade sell --group 1 --token <CA> --amount all
fourmm transfer in --to <your-wallet> --from-group 1 --amount all
```

### Volume Bot
```sh
fourmm tools volume --group 1 --token <CA> --amount 0.01 --rounds 50 --interval 3000
```
