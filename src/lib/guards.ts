/**
 * Entry guards for trade / tools / transfer commands.
 *
 * The core invariant: every command that touches trading logic for a specific
 * token MUST call `assertSupportedToken(ca)` before doing any signing or
 * on-chain write. This is how fourMM enforces "TaxToken and X Mode are out of
 * scope" without having to repeat the check inside each command body.
 *
 * Failure mode: `assertSupportedToken` throws `UnsupportedTokenError`, which
 * command handlers can catch and return as a structured `c.error({...})`
 * with a clean error code.
 */

import type { Address } from 'viem'
import { identifyToken, type IdentifyResult } from './identify.js'
import type { TokenVariant } from '../datastore/types.js'

/** The two variants that fourMM actively supports */
export type SupportedVariant = Extract<TokenVariant, 'standard' | 'anti-sniper-fee'>

export class UnsupportedTokenError extends Error {
  readonly code = 'UNSUPPORTED_TOKEN' as const
  constructor(
    readonly variant: TokenVariant,
    readonly ca: Address,
    readonly reason: string,
  ) {
    super(`${variant} ${ca}: ${reason}`)
    this.name = 'UnsupportedTokenError'
  }
}

export class TokenNotFoundError extends Error {
  readonly code = 'TOKEN_NOT_FOUND' as const
  constructor(readonly ca: Address) {
    super(
      `Token ${ca} is not registered with Four.meme (API returned not-found). ` +
        `Either the address is wrong or the token predates the API we query.`,
    )
    this.name = 'TokenNotFoundError'
  }
}

/**
 * Throw if the token is a variant fourMM does not support OR the API says the
 * token isn't on Four.meme at all.
 *
 * Returns the identification result so callers can avoid a second API call
 * (e.g. `trade buy` can reuse `result.raw` for future slippage estimates).
 *
 * Network failures (source=fallback-network) are NOT treated as hard errors:
 * we default to `standard` and let the downstream RPC layer (Helper3) be
 * the arbiter. This keeps the CLI usable when Four.meme's API is degraded.
 */
export async function assertSupportedToken(
  ca: Address,
  options?: Parameters<typeof identifyToken>[1],
): Promise<IdentifyResult & { variant: SupportedVariant }> {
  const result = await identifyToken(ca, options)

  if (result.source === 'not-found') {
    throw new TokenNotFoundError(ca)
  }

  if (result.variant === 'tax-token') {
    throw new UnsupportedTokenError(
      result.variant,
      ca,
      'TaxToken is not supported. fourMM refuses to market-make on TaxTokens — ' +
        'each round-trip costs 2× the fee rate (e.g. 10% on a 5% tax token). ' +
        'This is by design.',
    )
  }

  if (result.variant === 'x-mode') {
    throw new UnsupportedTokenError(
      result.variant,
      ca,
      'X Mode token is not supported. fourMM does not implement the exclusive ' +
        'Binance MPC Wallet purchase path (buyToken(bytes args, uint256 time, bytes signature)).',
    )
  }

  // narrow type by returning a new object with the supported variant
  return { ...result, variant: result.variant }
}
