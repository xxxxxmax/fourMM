/**
 * Trading path resolution.
 *
 * Every trade / tools command MUST call `resolveTradingPath(client, ca)`
 * before any on-chain write. The result tells the caller which contract
 * interface to use (bonding-curve TokenManager2 vs graduated PancakeSwap
 * router) AND exposes the raw Helper3.getTokenInfo result so downstream
 * code can reuse fields (launchTime, offers, funds, etc.) without firing
 * another RPC call.
 *
 * This is the single source of truth for routing — do NOT hardcode
 * TOKEN_MANAGER_V2 anywhere else.
 */

import type { Address, PublicClient, ReadContractReturnType } from 'viem'
import { PANCAKE_V2_ROUTER, TOKEN_MANAGER_HELPER3 } from './const.js'
import { tokenManagerHelper3Abi } from '../contracts/tokenManagerHelper3.js'

// ============================================================
// Types
// ============================================================

/** The raw tuple that Helper3.getTokenInfo returns */
export type GetTokenInfoResult = ReadContractReturnType<
  typeof tokenManagerHelper3Abi,
  'getTokenInfo'
>

export type BondingCurvePath = {
  path: 'bonding-curve'
  /** The V1 or V2 TokenManager that owns this token — use this, not a hardcoded address */
  router: Address
  version: 1 | 2
  /** Quote token (address(0) = BNB) */
  quote: Address
}

export type PancakePath = {
  path: 'pancake'
  /** PancakeSwap V2 router on BSC mainnet */
  router: Address
  /** LP pair address if known (0x0 for now; Week 3 will resolve from factory) */
  pairAddress: Address | '0x0000000000000000000000000000000000000000'
  /** Quote token — always BNB for Four.meme graduated tokens */
  quote: Address
}

export type TradingPath = BondingCurvePath | PancakePath

/**
 * Full result of a routing call: the chosen path PLUS the raw Helper3 info
 * tuple the caller can reuse. Downstream code reads:
 *   - `rawInfo[6]`  launchTime  (for tradeable check)
 *   - `rawInfo[7]`  offers
 *   - `rawInfo[8]`  maxOffers
 *   - `rawInfo[9]`  funds
 *   - `rawInfo[10]` maxFunds
 */
export type ResolveResult = {
  tradingPath: TradingPath
  rawInfo: GetTokenInfoResult
}

// ============================================================
// Public API
// ============================================================

/**
 * Inspect a token's on-chain state and pick the correct trading path.
 *
 * Throws on a malformed / unknown token (version 0). Callers should wrap
 * this in the command's error handler so the agent gets a structured error
 * instead of a viem revert trace.
 */
export async function resolveTradingPath(
  client: PublicClient,
  ca: Address,
): Promise<ResolveResult> {
  let info: GetTokenInfoResult
  try {
    info = await client.readContract({
      address: TOKEN_MANAGER_HELPER3,
      abi: tokenManagerHelper3Abi,
      functionName: 'getTokenInfo',
      args: [ca],
    })
  } catch (err) {
    throw new Error(
      `resolveTradingPath(${ca}): Helper3 read failed${
        err instanceof Error ? `: ${err.message}` : ''
      }`,
    )
  }

  const version = info[0]
  const tokenManager = info[1]
  const quote = info[2]
  const liquidityAdded = info[11]

  if (version === 0n) {
    throw new Error(
      `resolveTradingPath(${ca}): token not registered with Four.meme TokenManager`,
    )
  }

  let tradingPath: TradingPath
  if (liquidityAdded) {
    tradingPath = {
      path: 'pancake',
      router: PANCAKE_V2_ROUTER,
      // Pair lookup is Week 3 — Router uses factory.getPair at tx build time
      pairAddress: '0x0000000000000000000000000000000000000000',
      quote,
    }
  } else {
    const normalized: 1 | 2 = version === 1n ? 1 : 2
    tradingPath = {
      path: 'bonding-curve',
      router: tokenManager,
      version: normalized,
      quote,
    }
  }

  return { tradingPath, rawInfo: info }
}
