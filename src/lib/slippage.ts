/**
 * Slippage calculation helpers for Router calls.
 *
 * The Router's volume() / turnover() / volumePancake() functions accept
 * minTokenOut and minBnbBack as slippage guards. These helpers compute
 * meaningful minimums using Helper3.tryBuy estimates.
 *
 * Without these, passing 0n makes every tx fully sandwichable.
 */

import type { Address, PublicClient } from 'viem'
import { TOKEN_MANAGER_HELPER3 } from './const.js'
import { tokenManagerHelper3Abi } from '../contracts/tokenManagerHelper3.js'

/**
 * Compute minTokenOut for a buy of `bnbWei` with `slippageBps` tolerance.
 *
 * Uses Helper3.tryBuy to estimate how many tokens we'd get, then applies
 * the slippage discount: minTokenOut = estimated * (10000 - slippageBps) / 10000
 *
 * For the sell leg (minBnbBack), we use a simple heuristic:
 *   minBnbBack = bnbWei * (10000 - slippageBps - feeBps) / 10000
 * where feeBps accounts for the bonding curve's ~1% round-trip fee × 2.
 */
export async function computeVolumeSlippage(
  client: PublicClient,
  token: Address,
  bnbWei: bigint,
  slippageBps: number,
): Promise<{ minTokenOut: bigint; minBnbBack: bigint }> {
  const slipBig = BigInt(slippageBps)

  // Estimate buy output
  let minTokenOut = 0n
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
    // If tryBuy fails, fall back to 0 (no protection). Better than crashing.
    minTokenOut = 0n
  }

  // For round-trip (volume), the sell returns less than we paid due to:
  //   - bonding curve spread
  //   - 1% trading fee on buy + 1% on sell ≈ 200 bps total
  // We apply slippage on top of the estimated fee to compute minBnbBack.
  const estimatedFeeBps = 250n // ~2.5% for round-trip (generous)
  const totalDiscountBps = slipBig + estimatedFeeBps
  const effectiveBps = totalDiscountBps > 10_000n ? 10_000n : totalDiscountBps
  const minBnbBack = (bnbWei * (10_000n - effectiveBps)) / 10_000n

  return { minTokenOut, minBnbBack }
}

/**
 * Compute minTokenOut for a turnover (buy-only, no sell leg).
 */
export async function computeTurnoverSlippage(
  client: PublicClient,
  token: Address,
  bnbWei: bigint,
  slippageBps: number,
): Promise<{ minTokenOut: bigint }> {
  const slipBig = BigInt(slippageBps)

  try {
    const result = await client.readContract({
      address: TOKEN_MANAGER_HELPER3,
      abi: tokenManagerHelper3Abi,
      functionName: 'tryBuy',
      args: [token, 0n, bnbWei],
    })
    const estimatedTokens = result[2]
    return { minTokenOut: (estimatedTokens * (10_000n - slipBig)) / 10_000n }
  } catch {
    return { minTokenOut: 0n }
  }
}
