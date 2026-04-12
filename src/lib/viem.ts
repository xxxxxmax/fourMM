/**
 * viem client factory for ALMM.
 *
 * Builds a public client from the current config — respects rpcUrl and
 * fallbackRpcUrls from ~/.almm/config.json.
 */

import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { loadConfig } from './config.js'
import { CHAINS, type SupportedChainName } from './const.js'

/**
 * Build a viem PublicClient for reads.
 *
 * Uses viem's `fallback` transport so any failing RPC is rotated out
 * automatically. Clients are cached by (network, rpcUrl, fallbackUrls) so
 * that a `config set rpcUrl` invalidates the cache automatically —
 * otherwise the process would keep the stale RPC until restart.
 */
const clientCache = new Map<string, PublicClient>()

function cacheKey(
  net: SupportedChainName,
  rpcUrl: string,
  fallbackUrls: readonly string[],
): string {
  return `${net}::${rpcUrl}::${fallbackUrls.join(',')}`
}

export function getPublicClient(
  network?: SupportedChainName | undefined,
): PublicClient {
  const config = loadConfig()
  const net: SupportedChainName = network ?? config.network
  const key = cacheKey(net, config.rpcUrl, config.fallbackRpcUrls)

  const cached = clientCache.get(key)
  if (cached) return cached

  const chain = CHAINS[net]
  const transports = [config.rpcUrl, ...config.fallbackRpcUrls]
    .filter((url): url is string => Boolean(url))
    .map((url) => http(url, { timeout: 15_000, retryCount: 2 }))

  const client = createPublicClient({
    chain,
    transport: fallback(transports, { rank: false }),
  })
  clientCache.set(key, client)
  return client
}

/** Reset all cached clients (exposed for tests) */
export function resetPublicClients(): void {
  clientCache.clear()
}
