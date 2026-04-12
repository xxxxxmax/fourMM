/**
 * Shared viem WalletClient factory for trade / tools / transfer commands.
 *
 * Previously duplicated as tradeWalletClient / toolsWalletClient / walletClientFor
 * across 3 command files. Extracted here so changes (nonce management, gas
 * settings) are made in one place.
 */

import {
  createWalletClient,
  fallback,
  http,
  type WalletClient,
} from 'viem'
import { type PrivateKeyAccount } from 'viem/accounts'
import { bsc, bscTestnet } from 'viem/chains'
import type { CliConfig } from './config.js'

/**
 * Build a viem WalletClient for the given account + pre-loaded config.
 * Rebuilt per wallet (signer identity changes) but RPC list is stable.
 */
export function makeWalletClient(
  account: PrivateKeyAccount,
  config: CliConfig,
): WalletClient {
  const chain = config.network === 'bsc-testnet' ? bscTestnet : bsc
  const transports = [config.rpcUrl, ...config.fallbackRpcUrls]
    .filter((url): url is string => Boolean(url))
    .map((url) => http(url, { timeout: 15_000 }))
  return createWalletClient({
    account,
    chain,
    transport: fallback(transports, { rank: false }),
  })
}
