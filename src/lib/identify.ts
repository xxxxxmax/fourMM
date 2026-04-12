/**
 * Token variant identification.
 *
 * Four.meme has four variants: standard / anti-sniper-fee / tax-token / x-mode.
 *
 * We detect the variant via Four.meme's public REST API
 * (`https://four.meme/meme-api/v1/private/token/get?address=...`). The endpoint
 * is public despite its "/private/" path segment — it's a read API for token
 * metadata and requires no auth.
 *
 * Why not on-chain? The documented method is to read
 * `TokenManager2._tokenInfos[token].template` and check specific bits
 * (creatorType == 5 → tax-token, bit 0x10000 → x-mode). But the full
 * TokenInfo + TokenInfoEx1 struct layout isn't published, and reverse-
 * engineering struct encoding is fragile. The REST API gives us the same
 * signals with documented field names and typed JSON.
 *
 * Three response states (carried in `IdentifyResult.source`):
 *
 *   - `api`                → got a real classification from the API
 *   - `not-found`          → API responded with code != 0 or data === null,
 *                             meaning the token isn't on Four.meme at all
 *   - `fallback-network`   → HTTP / timeout / connection error, couldn't tell
 *
 * Commands that need strict guarantees (`trade buy`, `tools volume`) should
 * reject `not-found` explicitly — that's a malformed input, not a valid
 * standard token. `fallback-network` is the degraded case where we couldn't
 * reach the API but the token may still be valid; typically we default to
 * `standard` and let Helper3 be the arbiter.
 */

import type { Address } from 'viem'
import { loadConfig } from './config.js'
import type { TokenVariant } from '../datastore/types.js'

// ============================================================
// Types
// ============================================================

export type IdentifySource = 'api' | 'not-found' | 'fallback-network'

export type IdentifyResult = {
  variant: TokenVariant
  /** Where the verdict came from */
  source: IdentifySource
  /** Optional raw API payload for debugging / downstream use */
  raw?: FourmemeTokenResponse | undefined
}

/** Shape of the Four.meme token/get API response (fields we care about) */
export type FourmemeTokenResponse = {
  code: number
  msg: string
  data: {
    address: string
    name: string
    shortName: string
    symbol: string
    totalAmount: string
    saleAmount: string
    launchTime: number
    /** "V3" standard, "V8" X Mode exclusive */
    version: string
    /** PANCAKE_SWAP | ... */
    dexType: string
    /** Present only on AntiSniperFee tokens */
    feePlan?: boolean
    /** Present only on TaxTokens */
    taxInfo?: {
      feeRate: number
      recipientRate: number
      burnRate: number
      divideRate: number
      liquidityRate: number
      recipientAddress: string
      minSharing: number
    }
    /** Present only when created by an agent wallet */
    aiCreator?: boolean
  } | null
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_TIMEOUT_MS = 8_000

// ============================================================
// Public API
// ============================================================

/**
 * Identify a Four.meme token's variant.
 *
 * Never throws: on network or API errors this returns `{ variant: 'standard',
 * source: 'fallback' }`. Callers that want a hard guard should wrap this in
 * `assertSupportedToken` (see guards.ts) which re-checks `source` semantics.
 */
export async function identifyToken(
  ca: Address,
  options: {
    timeoutMs?: number | undefined
    fetchImpl?: typeof fetch | undefined
    apiBaseUrl?: string | undefined
  } = {},
): Promise<IdentifyResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const apiBase = options.apiBaseUrl ?? loadConfig().fourmemeApiUrl

  const url = `${apiBase}/v1/private/token/get?address=${ca}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetchFn(url, { signal: controller.signal })
    if (!res.ok) {
      return { variant: 'standard', source: 'fallback-network' }
    }
    const json = (await res.json()) as FourmemeTokenResponse
    if (json.code !== 0 || !json.data) {
      return { variant: 'standard', source: 'not-found', raw: json }
    }
    return { variant: classify(json.data), source: 'api', raw: json }
  } catch {
    return { variant: 'standard', source: 'fallback-network' }
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================
// Classification rules
// ============================================================

function classify(data: NonNullable<FourmemeTokenResponse['data']>): TokenVariant {
  // Priority:
  //   1. tax-token (most specific)
  //   2. x-mode (protocol-level exclusivity gate)
  //   3. anti-sniper-fee (dynamic fee)
  //   4. standard (default)
  if (data.taxInfo) return 'tax-token'
  if (data.version === 'V8') return 'x-mode'
  if (data.feePlan === true) return 'anti-sniper-fee'
  return 'standard'
}
