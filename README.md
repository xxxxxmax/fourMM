# fourMM — Four.meme Market Maker

> Agent-first CLI for Four.meme market making on BSC.

## What it does

fourMM is a command-line tool for running market-making strategies on [Four.meme](https://four.meme) tokens on BNB Smart Chain, designed to be driven by AI agents (Claude Code, MCP clients) or used directly.

### Key Features

1. **Flashbot Bundle Execution** — Pump/dump commands sign all wallets' txs offline and submit via `eth_sendBundle` (BlockRazor), atomically executing in the same block. No MEV, no sandwich.
2. **Atomic Router Contract** — A Solidity router on BSC does `buy + sell round-trip` in a single tx (`volume()`), `buy for another wallet` (`turnover()`), and `PancakeSwap round-trip` (`volumePancake()`).
3. **Bonding Curve + PancakeSwap Auto-Routing** — Every trade command detects whether the token has graduated and routes through the correct contract. Your volume bot doesn't break at graduation.
4. **Token Creation** — Full Four.meme REST API integration: auth, image upload, token registration, on-chain `createToken`, optional dev-buy.
5. **Refuses TaxToken / X Mode** — Because the round-trip math doesn't work. fourMM knows what real market making means.

## Install

### From npm (recommended)

```bash
npm install -g fourmm
fourmm config init
```

Or run without installing:

```bash
npx fourmm config init
```

### From source

```bash
pnpm install
pnpm build
```

Requires Node.js >= 22.

## Quick Start

```bash
# Initialize config (BlockRazor MEV-protected RPC by default)
fourmm config init

# Create wallet group with 5 wallets
fourmm wallet create-group --name snipers --count 5

# Fund wallets from your main wallet
fourmm transfer out --from 0xYourWallet --to-group 1 --value 0.01

# Create a token on Four.meme
fourmm token create --name "My Token" --symbol "MTK" --image logo.png --dev-wallet 1

# Buy
fourmm trade buy --group 1 --token 0x...4444 --amount 0.01

# Sell all
fourmm trade sell --group 1 --token 0x...4444 --amount all

# Pump price (Flashbot bundle, all wallets buy atomically each round)
fourmm tools robot-price --group 1 --token 0x...4444 --direction up --target-price 0.00001 --amount 0.01

# Dump price
fourmm tools robot-price --group 1 --token 0x...4444 --direction down --target-price 0.000001 --amount 0.01

# Generate volume (atomic buy+sell per wallet, zero net position)
fourmm tools volume --group 1 --token 0x...4444 --amount 0.01 --rounds 10

# Check PnL
fourmm query monitor --group 1 --token 0x...4444
```

## Agent Integration

```bash
# Option 1: Install skills globally (any agent can discover them)
pnpm install && pnpm build
npx fourmm skills add

# Option 2: MCP server (Claude Desktop / Cursor / etc.)
npx fourmm --mcp
```

Skills are in the `skills/` directory. The top-level `skills/SKILL.md` is a routing table that maps user intents to commands. Sub-skills (`skills/fourmm-*/SKILL.md`) contain detailed parameter schemas and output types.

## Commands (34)

```
config    (3)  init, set, get
wallet   (11)  create-group, generate, list-groups, group-info,
               add, import, export, export-group, overview,
               delete-group, remove
token     (5)  create, info, pool, identify, graduate-status
trade     (4)  buy, sell, sniper, batch
tools     (3)  volume, turnover, robot-price
transfer  (3)  in, out, many-to-many
query     (5)  balance, price, kline, transactions, monitor
```

See [skills/SKILL.md](./skills/SKILL.md) for the full routing guide with all options.

## Architecture

```
┌─────────────────────────────────────────────┐
│  AI Agent (Claude Code / MCP)               │
│  reads skills/SKILL.md → picks command      │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  fourmm CLI (incur framework)               │
│  34 commands, TOON/JSON/YAML output         │
│  zod schemas for agent-safe I/O             │
└──────────────┬──────────────────────────────┘
               │
    ┌──────────┼──────────────┐
    │          │              │
┌───▼───┐ ┌───▼────┐  ┌─────▼──────┐
│Bonding│ │Pancake │  │ Flashbot   │
│ Curve │ │  Swap  │  │  Bundle    │
│(V1/V2)│ │(Router)│  │(eth_send   │
│       │ │        │  │  Bundle)   │
└───┬───┘ └───┬────┘  └─────┬──────┘
    │         │              │
┌───▼─────────▼──────────────▼──────┐
│  BSC Mainnet                       │
│  TokenManager2    PancakeRouter02  │
│  FourmemeMmRouter v2               │
│  (0xd62c...216c)                   │
└────────────────────────────────────┘
```

## On-Chain Contracts

| Contract | Address | Description |
|----------|---------|-------------|
| FourmemeMmRouter v2 | `0xd62c2fd94176f98424af83e4b9a333d454b2216c` | Atomic volume/turnover/volumePancake |
| TokenManager2 | `0x5c952063c7fc8610FFDB798152D69F0B9550762b` | Four.meme V2 (buy/sell/create) |
| TokenManagerHelper3 | `0xF251F83e40a78868FcfA3FA4599Dad6494E46034` | Unified query interface |
| PancakeSwap V2 Router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` | Graduated token trading |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `FOURMM_PASSWORD` | Master password for wallet encryption |
| `BSC_RPC_URL` | Override primary RPC endpoint |
| `BSCSCAN_API_KEY` | BSCScan API key |

## Tech Stack

- **CLI Framework**: [incur](https://github.com/nicholasgasior/incur) — agent-first with TOON output, CTAs, skills/MCP auto-generation
- **EVM Client**: [viem](https://viem.sh) — TypeScript EVM interactions
- **Contracts**: [Foundry](https://getfoundry.sh) — Solidity development + fork testing
- **Encryption**: crypto-js AES — wallet-at-rest encryption
- **Bundle**: BlockRazor `eth_sendBundle` — Flashbot-style atomic execution

## License

MIT
