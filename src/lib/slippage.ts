/**
 * Slippage calculation helpers for Router calls.
 *
 * Two paths:
 *   - Bonding curve: uses Helper3.tryBuy to estimate output
 *   - PancakeSwap (graduated): uses PancakeRouter.getAmountsOut
 *
 * Without proper minimums, passing 0n makes every tx fully sandwichable.
 */

import type { Address, PublicClient } from 'viem'
import { TOKEN_MANAGER_HELPER3, PANCAKE_V2_ROUTER, WBNB } from './const.js'
import { tokenManagerHelper3Abi } from '../contracts/tokenManagerHelper3.js'

// PancakeSwap getAmountsOut ABI (just what we need)
const pancakeGetAmountsOutAbi = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const

/**
 * Compute slippage-protected minimums for volume (buy+sell round-trip).
 *
 * Tries bonding-curve estimation first (tryBuy). If that fails (token has
 * graduated), falls back to PancakeSwap getAmountsOut. If both fail,
 * returns 0n (no protection — last resort).
 */
export async function computeVolumeSlippage(
  client: PublicClient,
  token: Address,
  bnbWei: bigint,
  slippageBps: number,
): Promise<{ minTokenOut: bigint; minBnbBack: bigint }> {
  const slipBig = BigInt(slippageBps)

  // --- Try bonding curve first ---
  let minTokenOut = 0n
  let usedPancake = false

  try {
    const result = await client.readContract({
      address: TOKEN_MANAGER_HELPER3,
      abi: tokenManagerHelper3Abi,
      functionName: 'tryBuy',
      args: [token, 0n, bnbWei],
    })
    const estimatedTokens = result[2]
    minTokenOut = (estimatedTokens * (10_000n - slipBig)) / 10_000n
  } catch {
    // tryBuy failed — token is likely graduated. Try PancakeSwap.
    try {
      const amounts = await client.readContract({
        address: PANCAKE_V2_ROUTER,
        abi: pancakeGetAmountsOutAbi,
        functionName: 'getAmountsOut',
        args: [bnbWei, [WBNB, token]],
      })
      if (amounts.length >= 2) {
        const estimatedTokens = amounts[1]!
        minTokenOut = (estimatedTokens * (10_000n - slipBig)) / 10_000n
        usedPancake = true
      }
    } catch {
      // Both paths failed — 0n fallback (no protection, but won't crash)
      minTokenOut = 0n
    }
  }

  // For the sell leg: estimate how much BNB we'd get back after a round-trip.
  // Bonding curve: ~2.5% round-trip fee. PancakeSwap: ~0.5% LP fee × 2 = 1%.
  const estimatedFeeBps = usedPancake ? 150n : 250n
  const totalDiscountBps = slipBig + estimatedFeeBps
  const effectiveBps = totalDiscountBps > 10_000n ? 10_000n : totalDiscountBps
  const minBnbBack = (bnbWei * (10_000n - effectiveBps)) / 10_000n

  return { minTokenOut, minBnbBack }
}

/**
 * Compute minTokenOut for a turnover (buy-only, no sell leg).
 * Same dual-path logic as computeVolumeSlippage but only the buy side.
 */
export async function computeTurnoverSlippage(
  client: PublicClient,
  token: Address,
  bnbWei: bigint,
  slippageBps: number,
): Promise<{ minTokenOut: bigint }> {
  const slipBig = BigInt(slippageBps)

  // Try bonding curve
  try {
    const result = await client.readContract({
      address: TOKEN_MANAGER_HELPER3,
      abi: tokenManagerHelper3Abi,
      functionName: 'tryBuy',
      args: [token, 0n, bnbWei],
    })
    return { minTokenOut: (result[2] * (10_000n - slipBig)) / 10_000n }
  } catch {
    // Fallback: PancakeSwap
    try {
      const amounts = await client.readContract({
        address: PANCAKE_V2_ROUTER,
        abi: pancakeGetAmountsOutAbi,
        functionName: 'getAmountsOut',
        args: [bnbWei, [WBNB, token]],
      })
      if (amounts.length >= 2) {
        return { minTokenOut: (amounts[1]! * (10_000n - slipBig)) / 10_000n }
      }
    } catch {
      // both failed
    }
    return { minTokenOut: 0n }
  }
}
