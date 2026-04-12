/**
 * On-chain constants for ALMM.
 *
 * These addresses are immutable and come from the Four.meme protocol
 * documentation (docs/API-Documents.03-03-2026.md) and public BSC infrastructure.
 *
 * DO NOT read them from config — hardcoding catches misconfiguration at
 * import time instead of at runtime.
 */

import { bsc, bscTestnet } from 'viem/chains'
import type { Address } from 'viem'

// ============================================================
// Four.meme (BSC mainnet)
// ============================================================

/** Legacy TokenManager (V1) — only for tokens created before 2024-09-05 */
export const TOKEN_MANAGER_V1: Address =
  '0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC'

/** Current TokenManager (V2) — the default path for all new tokens */
export const TOKEN_MANAGER_V2: Address =
  '0x5c952063c7fc8610FFDB798152D69F0B9550762b'

/**
 * TokenManagerHelper3 — wrapper around V1/V2 that normalizes queries.
 * Always prefer this for reads. Do not hardcode V1/V2 directly in commands.
 */
export const TOKEN_MANAGER_HELPER3: Address =
  '0xF251F83e40a78868FcfA3FA4599Dad6494E46034'

/**
 * AgentIdentifier — checks whether an address holds an Agent NFT.
 * Tokens created by Agent wallets get aiCreator=true automatically.
 */
export const AGENT_IDENTIFIER: Address =
  '0x09B44A633de9F9EBF6FB9Bdd5b5629d3DD2cef13'

// ============================================================
// PancakeSwap (post-graduation)
// ============================================================

/** PancakeSwap V2 Router on BSC mainnet */
export const PANCAKE_V2_ROUTER: Address =
  '0x10ED43C718714eb63d5aA57B78B54704E256024E'

/** PancakeSwap V2 Factory */
export const PANCAKE_V2_FACTORY: Address =
  '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'

// ============================================================
// ALMM contracts
// ============================================================

/**
 * FourmemeMmRouter v2 — atomic router with reentrancy guard + approval hygiene.
 *
 * v2 changes: nonReentrant modifier, approval reset to 0 after sell,
 * fee-on-transfer compat in volumePancake. BSCScan verified.
 *
 * v1 (0x5A3A9981...) is deprecated but still on-chain.
 */
export const FOURMEME_MM_ROUTER: Address =
  '0xd62c2fd94176f98424af83e4b9a333d454b2216c'

/**
 * Get the router address.
 *
 * Now that the router is deployed, this is a simple passthrough.
 * Kept as a function (not direct import) so commands have a single
 * call site to update if we ever redeploy.
 */
export function requireRouter(): Address {
  return FOURMEME_MM_ROUTER
}

// ============================================================
// BSC chain configs
// ============================================================

export const CHAINS = {
  bsc,
  'bsc-testnet': bscTestnet,
} as const

export type SupportedChainName = keyof typeof CHAINS

// ============================================================
// Common tokens
// ============================================================

/**
 * Sentinel "address" for native BNB in ALMM's DataStore and routing layers.
 *
 * Important: BNB is the native currency of BSC and has no contract address.
 * We use the zero address as a convention. This matches:
 *   1. Four.meme's own usage — Helper3.getTokenInfo.quote returns address(0)
 *      when the token is priced in BNB (confirmed via BSC mainnet reads)
 *   2. The broader EVM convention for "native token placeholder"
 *
 * DO NOT confuse this with WBNB (0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c),
 * which is a REAL ERC20 contract wrapping BNB. Using WBNB here would conflate
 * native BNB transfers with WBNB token trades.
 */
export const NATIVE_BNB: Address = '0x0000000000000000000000000000000000000000'

/** Wrapped BNB on BSC mainnet */
export const WBNB: Address = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

/** BUSD on BSC mainnet */
export const BUSD: Address = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'

/** USDT (BEP-20) on BSC mainnet */
export const USDT: Address = '0x55d398326f99059fF775485246999027B3197955'

// ============================================================
// Four.meme convention: all native tokens end in 4444
// ============================================================

/**
 * Return true if an address has the Four.meme native-token signature.
 * Four.meme deploys all protocol-native tokens at addresses ending in `4444`.
 * This is a cheap sanity check before making an RPC call.
 */
export function isFourmemeNativeAddress(address: string): boolean {
  return address.toLowerCase().endsWith('4444')
}
