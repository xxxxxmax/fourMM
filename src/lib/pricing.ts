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
import { TOKEN_MANAGER_HELPER3 } from './const.js'
import { tokenManagerHelper3Abi } from '../contracts/tokenManagerHelper3.js'
import { getDataStore } from '../datastore/index.js'
import { loadConfig } from './config.js'

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
    const bnbUsd = await getBnbUsdPrice(options.fetchImpl).catch(() => 0)
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

  const bnbUsd = await getBnbUsdPrice(options.fetchImpl).catch(() => 0)
  const priceUsd = gecko.priceUsd
  // Convert USD → BNB when we know the BNB price
  const priceBnb = bnbUsd > 0 ? priceUsd / bnbUsd : 0

  ds.savePoolInfo({
    ca,
    pairAddress: '',
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
export async function getBnbUsdPrice(
  fetchImpl: typeof fetch | undefined = globalThis.fetch,
): Promise<number> {
  const ds = getDataStore()
  const cached = ds.getBnbPrice()
  const now = Date.now()
  if (cached && now - cached.updatedAt < BNB_PRICE_TTL_MS) {
    return cached.priceUsd
  }

  try {
    const res = await fetchImpl(
      'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd',
    )
    if (!res.ok) {
      return cached?.priceUsd ?? 0
    }
    const json = (await res.json()) as { binancecoin?: { usd?: number } }
    const price = json.binancecoin?.usd
    if (typeof price === 'number' && price > 0) {
      ds.saveBnbPrice(price)
      return price
    }
    return cached?.priceUsd ?? 0
  } catch {
    return cached?.priceUsd ?? 0
  }
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
  fetchImpl: typeof fetch | undefined = globalThis.fetch,
): Promise<{ priceUsd: number } | null> {
  const config = loadConfig()
  const url = `${config.geckoTerminalUrl}/networks/bsc/tokens/${ca}`
  try {
    const res = await fetchImpl(url, {
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
