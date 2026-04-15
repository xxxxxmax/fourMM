/**
 * Four.meme REST API authentication.
 *
 * Flow:
 *   1. POST /v1/private/user/nonce/generate  → get nonce
 *   2. Sign message "You are sign in Meme {nonce}" with wallet private key
 *   3. POST /v1/private/user/login/dex       → get access_token
 *
 * The access_token is used for subsequent API calls (upload, create).
 */

import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { loadConfig } from '../lib/config.js'

export type AuthResult = {
  accessToken: string
  walletAddress: string
}

/**
 * Authenticate with Four.meme and return an access token.
 */
export async function authenticateFourmeme(
  privateKey: Hex,
  options: { fetchImpl?: typeof fetch | undefined } = {},
): Promise<AuthResult> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const config = loadConfig()
  const apiBase = config.fourmemeApiUrl

  const account = privateKeyToAccount(privateKey)
  const walletAddress = account.address

  // Step 1: Get nonce
  const nonceRes = await fetchFn(`${apiBase}/v1/private/user/nonce/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountAddress: walletAddress,
      verifyType: 'LOGIN',
      networkCode: 'BSC',
    }),
  })
  if (!nonceRes.ok) {
    throw new Error(`Four.meme nonce/generate failed: HTTP ${nonceRes.status}`)
  }
  const nonceJson = (await nonceRes.json()) as { code: number; data: string }
  if (nonceJson.code !== 0 || !nonceJson.data) {
    throw new Error(`Four.meme nonce/generate error: ${JSON.stringify(nonceJson)}`)
  }
  const nonce = nonceJson.data

  // Step 2: Sign the nonce message
  const message = `You are sign in Meme ${nonce}`
  const signature = await account.signMessage({ message })

  // Step 3: Login (nested verifyInfo format per API docs 02-02-2026)
  const loginRes = await fetchFn(`${apiBase}/v1/private/user/login/dex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      region: 'WEB',
      langType: 'EN',
      loginIp: '',
      inviteCode: '',
      verifyInfo: {
        address: walletAddress,
        networkCode: 'BSC',
        signature,
        verifyType: 'LOGIN',
      },
      walletName: 'MetaMask',
    }),
  })
  if (!loginRes.ok) {
    const body = await loginRes.text().catch(() => '')
    throw new Error(`Four.meme login/dex failed: HTTP ${loginRes.status} ${body}`)
  }
  const loginJson = (await loginRes.json()) as {
    code: number
    data: string | { access_token?: string; accessToken?: string }
  }
  if (loginJson.code !== 0) {
    throw new Error(`Four.meme login error: ${JSON.stringify(loginJson)}`)
  }

  // API may return token as a plain string or as an object with access_token
  const accessToken =
    typeof loginJson.data === 'string'
      ? loginJson.data
      : (loginJson.data.access_token ?? loginJson.data.accessToken ?? '')
  if (!accessToken) {
    throw new Error('Four.meme login succeeded but no access_token returned')
  }

  return { accessToken, walletAddress }
}
