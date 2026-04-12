/**
 * Four.meme token creation (REST API side).
 *
 * POST /v1/private/token/create → returns { createArg, signature }
 * which are then passed to TokenManager2.createToken() on-chain.
 */

import { loadConfig } from '../lib/config.js'

export type CreateTokenParams = {
  name: string
  symbol: string
  description: string
  imageUrl: string
  launchTime?: number | undefined
  category?: string | undefined
  twitter?: string | undefined
  website?: string | undefined
  telegram?: string | undefined
}

export type CreateTokenResult = {
  createArg: string
  signature: string
}

/**
 * Register a new token with Four.meme's REST API.
 * Returns the createArg + signature needed for the on-chain createToken call.
 */
export async function createTokenOnApi(
  params: CreateTokenParams,
  accessToken: string,
  options: { fetchImpl?: typeof fetch | undefined } = {},
): Promise<CreateTokenResult> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const config = loadConfig()
  const apiBase = config.fourmemeApiUrl

  const body = {
    tokenName: params.name,
    tokenSymbol: params.symbol,
    description: params.description,
    image: params.imageUrl,
    launchTime: params.launchTime ?? Math.floor(Date.now() / 1000),
    label: params.category ?? 'Meme',
    twitterUrl: params.twitter ?? '',
    websiteUrl: params.website ?? '',
    telegramUrl: params.telegram ?? '',
    // Fixed Four.meme params
    totalSupply: '1000000000',
    raisedAmount: '24',
    saleRatio: '80',
    tradingFee: '0.0025',
    // BNB as quote
    raisedToken: 'BNB',
  }

  const res = await fetchFn(`${apiBase}/v1/private/token/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Four.meme token/create failed: HTTP ${res.status}`)
  }

  const json = (await res.json()) as {
    code: number
    msg: string
    data: {
      createArg?: string
      signature?: string
    } | null
  }

  if (json.code !== 0 || !json.data) {
    throw new Error(`Four.meme token/create error: ${json.msg || JSON.stringify(json)}`)
  }

  if (!json.data.createArg || !json.data.signature) {
    throw new Error('Four.meme token/create: missing createArg or signature in response')
  }

  return {
    createArg: json.data.createArg,
    signature: json.data.signature,
  }
}
