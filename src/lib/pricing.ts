/**
 * Token pricing.
 *
 * Dual-path:
 *   1. Bonding curve (liquidityAdded=false) → read on-chain
 *      TokenManagerHelper3.getTokenInfo.lastPrice directly. No network round-trip
 *      to a third-party pricing API.
 *   2. Graduated (liquidityAdded=true) → query GeckoTerminal
 *      (`/api/v2/networks/bsc/tokens/{address}`) for PancakeSwap-derived price.
 *
 * BNB→USD conversion uses CoinGecko's free simple-price endpoint, cached for
 * 60 seconds in DataStore's global/bnb-price.json.
 *
 * All price outputs are in BNB per token (float). The raw on-chain lastPrice
 * is BNB-wei per smallest-token-unit (18 decimals); for meme tokens the price
 * is tiny (well below 1e-6 BNB), so converting via Number() is safe in
 * practice. If Week 3 bot code cares about sub-wei precision we'll switch to
 * BigInt-to-string formatting.
 */

import type { Address, PublicClient } from 'viem'
import { TOKEN_MANAGER_HELPER3, PANCAKE_V2_FACTORY, WBNB } from './const.js'
import { tokenManagerHelper3Abi } from '../contracts/tokenManagerHelper3.js'
import { getDataStore } from '../datastore/index.js'
import { loadConfig } from './config.js'

// PancakeFactory getPair — to resolve LP pair address for graduated tokens
const pancakeFactoryAbi = [
  {
    type: 'function',
    name: 'getPair',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
    ],
    outputs: [{ name: 'pair', type: 'address' }],
  },
] as const

// ============================================================
// Types
// ============================================================

import type { TradingPathKind } from '../datastore/types.js'

/**
 * Where the price value came from (freshness axis).
 *
 * - `live`  → just fetched from Helper3 or GeckoTerminal this invocation
 * - `cache` → served from DataStore pool-info within TTL
 * - `stale` → cache hit beyond TTL but upstream fetch failed (best-effort)
 */
export type PriceOrigin = 'live' | 'cache' | 'stale'

export type TokenPrice = {
  ca: Address
  priceBnb: number
  priceUsd: number
  /** Trading path: bonding-curve / pancake (static token property) */
  path: TradingPathKind
  /** Freshness of this value */
  origin: PriceOrigin
  /** Unix ms */
  updatedAt: number
  liquidityAdded: boolean
}

// ============================================================
// Constants
// ============================================================

const BNB_DECIMALS = 18
const POOL_CACHE_TTL_MS = 30_000
const BNB_PRICE_TTL_MS = 60_000

// ============================================================
// Public API
// ============================================================

/**
 * Get the current price of a Four.meme token.
 *
 * Cache-through: checks DataStore pool-info first; on miss or expiry,
 * fetches live and writes back. Network failures are surfaced via
 * throwing, but we fall back to cache if the fresh fetch fails and a stale
 * value exists.
 */
export async function getTokenPrice(
  client: PublicClient,
  ca: Address,
  options: { fetchImpl?: typeof fetch | undefined } = {},
): Promise<TokenPrice> {
  const ds = getDataStore()

  // Check cached pool-info first
  const cached = ds.getPoolInfo(ca)
  const now = Date.now()
  if (cached && now - cached.updatedAt < POOL_CACHE_TTL_MS) {
    return {
      ca,
      priceBnb: cached.priceBnb,
      priceUsd: cached.priceUsd,
      path: cached.path,
      origin: 'cache',
      updatedAt: cached.updatedAt,
      liquidityAdded: cached.path === 'pancake',
    }
  }

  // Hit Helper3 to learn graduation status + on-chain lastPrice
  let info: readonly [
    bigint, Address, Address,
    bigint, bigint, bigint, bigint,
    bigint, bigint, bigint, bigint, boolean,
  ]
  try {
    info = await client.readContract({
      address: TOKEN_MANAGER_HELPER3,
      abi: tokenManagerHelper3Abi,
      functionName: 'getTokenInfo',
      args: [ca],
    })
  } catch (err) {
    if (cached) {
      // Fresh fetch failed — return the stale cache we have
      return {
        ca,
        priceBnb: cached.priceBnb,
        priceUsd: cached.priceUsd,
        path: cached.path,
        origin: 'stale',
        updatedAt: cached.updatedAt,
        liquidityAdded: cached.path === 'pancake',
      }
    }
    throw new Error(
      `pricing.getTokenPrice(${ca}): Helper3 read failed${
        err instanceof Error ? `: ${err.message}` : ''
      }`,
    )
  }

  const version = info[0]
  const lastPrice = info[3]
  const liquidityAdded = info[11]

  if (version === 0n) {
    throw new Error(`pricing.getTokenPrice(${ca}): token not found on Four.meme`)
  }

  // ---- Branch 1: bonding curve ----
  if (!liquidityAdded) {
    const priceBnb = Number(lastPrice) / 10 ** BNB_DECIMALS
    const bnbUsd = await getBnbUsdPrice(client).catch(() => 0)
    const priceUsd = priceBnb * bnbUsd

    ds.savePoolInfo({
      ca,
      pairAddress: '',
      path: 'bonding-curve',
      priceBnb,
      priceUsd,
      graduationProgress: null,
      updatedAt: now,
    })

    return {
      ca,
      priceBnb,
      priceUsd,
      path: 'bonding-curve',
      origin: 'live',
      updatedAt: now,
      liquidityAdded: false,
    }
  }

  // ---- Branch 2: graduated → GeckoTerminal ----
  const gecko = await fetchGeckoTerminalPrice(ca, options.fetchImpl).catch(
    () => null,
  )
  if (!gecko) {
    if (cached) {
      return {
        ca,
        priceBnb: cached.priceBnb,
        priceUsd: cached.priceUsd,
        path: cached.path,
        origin: 'stale',
        updatedAt: cached.updatedAt,
        liquidityAdded: true,
      }
    }
    throw new Error(
      `pricing.getTokenPrice(${ca}): token has graduated but GeckoTerminal fetch failed`,
    )
  }

  const bnbUsd = await getBnbUsdPrice(client).catch(() => 0)
  const priceUsd = gecko.priceUsd
  // Convert USD → BNB when we know the BNB price
  const priceBnb = bnbUsd > 0 ? priceUsd / bnbUsd : 0

  // Resolve PancakeSwap LP pair address so `query kline` can auto-resolve it
  let pairAddress: Address | '' = ''
  try {
    const pair = await client.readContract({
      address: PANCAKE_V2_FACTORY,
      abi: pancakeFactoryAbi,
      functionName: 'getPair',
      args: [ca, WBNB],
    })
    if (pair && pair !== '0x0000000000000000000000000000000000000000') {
      pairAddress = pair
    }
  } catch {
    // Factory query failed — pairAddress stays empty, kline needs --pool
  }

  ds.savePoolInfo({
    ca,
    pairAddress,
    path: 'pancake',
    priceBnb,
    priceUsd,
    graduationProgress: null,
    updatedAt: now,
  })

  return {
    ca,
    priceBnb,
    priceUsd,
    path: 'pancake',
    origin: 'live',
    updatedAt: now,
    liquidityAdded: true,
  }
}

// ============================================================
// BNB / USD price (CoinGecko)
// ============================================================

/**
 * Get BNB → USD price with 60s cache.
 *
 * We use CoinGecko's public `simple/price` endpoint (no auth). If it fails
 * or is rate-limited, we return the cached value if present, else 0 (so the
 * rest of the pipeline still returns a priceBnb but priceUsd will be 0).
 */
// PancakeSwap WBNB/USDT pair — used for on-chain BNB/USD pricing
// This avoids depending on external APIs (CoinGecko/GeckoTerminal) that
// may be unreachable from certain environments (e.g. WSL2 TLS issues).
const PANCAKE_WBNB_USDT_PAIR: Address = '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae'

const pairReservesAbi = [
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'reserve0', type: 'uint112' },
      { name: 'reserve1', type: 'uint112' },
      { name: 'blockTimestampLast', type: 'uint32' },
    ],
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

/**
 * Get BNB → USD price with 60s cache.
 *
 * Primary source: on-chain PancakeSwap WBNB/USDT pair reserves (no external
 * API dependency — uses the same viem client that's already working for RPC).
 *
 * Fallback: CoinGecko simple/price endpoint (may fail in restricted networks).
 */
export async function getBnbUsdPrice(
  clientOrFetch?: PublicClient | typeof fetch | undefined,
): Promise<number> {
  const ds = getDataStore()
  const cached = ds.getBnbPrice()
  const now = Date.now()
  if (cached && now - cached.updatedAt < BNB_PRICE_TTL_MS) {
    return cached.priceUsd
  }

  // Try on-chain first: read PancakeSwap WBNB/USDT reserves
  if (clientOrFetch && typeof clientOrFetch === 'object' && 'readContract' in clientOrFetch) {
    const client = clientOrFetch as PublicClient
    try {
      const token0 = await client.readContract({
        address: PANCAKE_WBNB_USDT_PAIR,
        abi: pairReservesAbi,
        functionName: 'token0',
      })
      const [reserve0, reserve1] = await client.readContract({
        address: PANCAKE_WBNB_USDT_PAIR,
        abi: pairReservesAbi,
        functionName: 'getReserves',
      })
      // Determine which reserve is WBNB and which is USDT
      const wbnbLower = WBNB.toLowerCase()
      const isToken0Wbnb = (token0 as string).toLowerCase() === wbnbLower
      const wbnbReserve = isToken0Wbnb ? reserve0 : reserve1
      const usdtReserve = isToken0Wbnb ? reserve1 : reserve0
      // WBNB = 18 decimals, USDT = 18 decimals on BSC
      if (wbnbReserve > 0n) {
        const price = Number(usdtReserve) / Number(wbnbReserve)
        if (price > 0) {
          ds.saveBnbPrice(price)
          return price
        }
      }
    } catch {
      // On-chain query failed — try API fallback
    }
  }

  // Fallback: CoinGecko API
  try {
    const fetchFn = (typeof clientOrFetch === 'function' ? clientOrFetch : globalThis.fetch) as typeof fetch
    const res = await fetchFn(
      'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd',
    )
    if (!res.ok) return cached?.priceUsd ?? 0
    const json = (await res.json()) as { binancecoin?: { usd?: number } }
    const price = json.binancecoin?.usd
    if (typeof price === 'number' && price > 0) {
      ds.saveBnbPrice(price)
      return price
    }
  } catch {
    // API also failed
  }

  return cached?.priceUsd ?? 0
}

// ============================================================
// GeckoTerminal (PancakeSwap side)
// ============================================================

type GeckoResponse = {
  data?: {
    id?: string
    type?: string
    attributes?: {
      price_usd?: string
      name?: string
      symbol?: string
    }
  }
}

async function fetchGeckoTerminalPrice(
  ca: Address,
  fetchImpl?: typeof fetch | undefined,
): Promise<{ priceUsd: number } | null> {
  const fetchFn = fetchImpl ?? globalThis.fetch
  const config = loadConfig()
  const url = `${config.geckoTerminalUrl}/networks/bsc/tokens/${ca}`
  try {
    const res = await fetchFn(url, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const json = (await res.json()) as GeckoResponse
    const raw = json.data?.attributes?.price_usd
    if (!raw) return null
    const priceUsd = Number.parseFloat(raw)
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null
    return { priceUsd }
  } catch {
    return null
  }
}
