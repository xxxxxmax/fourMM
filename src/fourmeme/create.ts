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
  /** BNB amount for preset dev-buy (creator buys at launch). "0" to skip. */
  preSale?: string | undefined
}

export type CreateTokenResult = {
  createArg: string
  signature: string
}

/**
 * Fetch the platform's raisedToken config for BSC/BNB.
 * This gives us the fixed params (b0Amount, totalBAmount, tradeLevel, etc.)
 * that must be included in the create request.
 */
async function fetchRaisedTokenConfig(
  apiBase: string,
  fetchFn: typeof fetch,
): Promise<Record<string, unknown>> {
  try {
    const res = await fetchFn(`${apiBase}/v1/public/config`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    if (res.ok) {
      const json = (await res.json()) as { code: number; data: unknown }
      if (json.code === 0 && json.data) {
        // data is an array of raisedToken configs
        if (Array.isArray(json.data)) {
          const bnb = json.data.find((t: any) => t.symbol === 'BNB' && t.networkCode === 'BSC')
          if (bnb) return bnb
        }
      }
    }
  } catch { /* use hardcoded defaults */ }

  // Hardcoded defaults from API docs (02-02-2026)
  return {
    symbol: 'BNB',
    nativeSymbol: 'BNB',
    symbolAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    deployCost: '0',
    buyFee: '0.01',
    sellFee: '0.01',
    minTradeFee: '0',
    b0Amount: '8',
    totalBAmount: '18',
    totalAmount: '1000000000',
    logoUrl: 'https://static.four.meme/market/68b871b6-96f7-408c-b8d0-388d804b34275092658264263839640.png',
    tradeLevel: ['0.1', '0.5', '1'],
    status: 'PUBLISH',
    buyTokenLink: 'https://pancakeswap.finance/swap',
    reservedNumber: 10,
    saleRate: '0.8',
    networkCode: 'BSC',
    platform: 'MEME',
  }
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

  const raisedToken = await fetchRaisedTokenConfig(apiBase, fetchFn)

  const body = {
    name: params.name,
    shortName: params.symbol,
    symbol: 'BNB',
    desc: params.description,
    imgUrl: params.imageUrl,
    launchTime: params.launchTime ?? Date.now(),
    label: params.category ?? 'Meme',
    lpTradingFee: 0.0025,
    ...(params.website ? { webUrl: params.website } : {}),
    ...(params.twitter ? { twitterUrl: params.twitter } : {}),
    ...(params.telegram ? { telegramUrl: params.telegram } : {}),
    preSale: params.preSale ?? '0',
    onlyMPC: false,
    feePlan: false,
    // Fixed platform parameters
    totalSupply: 1000000000,
    raisedAmount: 18,
    saleRate: 0.8,
    reserveRate: 0,
    funGroup: false,
    clickFun: false,
    raisedToken,
  }

  const res = await fetchFn(`${apiBase}/v1/private/token/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'meme-web-access': accessToken,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Four.meme token/create failed: HTTP ${res.status} ${text}`)
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
