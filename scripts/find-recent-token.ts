/**
 * One-off: find the most recent Four.meme token via TokenManager2.TokenCreate event.
 * Used during Week 1 to pick a real CA for `fourmm token info` verification.
 *
 * Run: pnpm tsx scripts/find-recent-token.mts
 */

import { createPublicClient, http, parseAbiItem } from 'viem'
import { bsc } from 'viem/chains'
import { TOKEN_MANAGER_V2 } from '../src/lib/const.js'

const RPC_CANDIDATES = [
  'https://bsc.publicnode.com',
  'https://rpc.ankr.com/bsc',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
  'https://bsc-dataseed.binance.org/',
]

// Try candidates in sequence until one responds
let client: ReturnType<typeof createPublicClient> | null = null
for (const url of RPC_CANDIDATES) {
  const candidate = createPublicClient({
    chain: bsc,
    transport: http(url, { timeout: 10_000, retryCount: 0 }),
  })
  try {
    const n = await candidate.getBlockNumber()
    console.log(`Using RPC ${url} (head=${n})`)
    client = candidate
    break
  } catch {
    console.log(`  skip ${url}`)
  }
}
if (!client) throw new Error('All candidate RPCs failed')

// V2 TokenCreate signature from docs/API-Documents.03-03-2026.md
const tokenCreateEvent = parseAbiItem(
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)',
)

const latest = await client.getBlockNumber()
const fromBlock = latest - 2000n // ~1.5 hours of BSC blocks (3s each)

console.log(`Scanning blocks ${fromBlock}..${latest} for TokenCreate events...`)

const logs = await client.getLogs({
  address: TOKEN_MANAGER_V2,
  event: tokenCreateEvent,
  fromBlock,
  toBlock: latest,
})

console.log(`Found ${logs.length} TokenCreate events.`)

for (const log of logs.slice(-5)) {
  const args = log.args
  if (!args.token) continue
  console.log(
    `  block=${log.blockNumber}  token=${args.token}  symbol=${args.symbol}  name="${args.name}"`,
  )
}

if (logs.length === 0) {
  console.log('No events found in scan window. Try widening fromBlock.')
}
