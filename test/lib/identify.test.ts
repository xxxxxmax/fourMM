import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { identifyToken } from '../../src/lib/identify.js'
import {
  assertSupportedToken,
  TokenNotFoundError,
  UnsupportedTokenError,
} from '../../src/lib/guards.js'

const CA = '0x0000000000000000000000000000000000004444' as const

// ============================================================
// Fetch mocking
// ============================================================

function mockFetchResponse(body: unknown, ok = true) {
  return Object.assign(
    () =>
      Promise.resolve({
        ok,
        json: () => Promise.resolve(body),
      } as Response),
    { mockedResponse: body },
  ) as unknown as typeof fetch
}

function mockFetchError(err: Error) {
  return (() => Promise.reject(err)) as unknown as typeof fetch
}

// ============================================================
// identifyToken
// ============================================================

describe('identifyToken — variant classification', () => {
  it('classifies a normal token as standard', async () => {
    const fetchImpl = mockFetchResponse({
      code: 0,
      msg: 'success',
      data: { address: CA, version: 'V3', name: 'T', shortName: 'T', symbol: 'BNB' },
    })
    const result = await identifyToken(CA, { fetchImpl })
    expect(result.variant).toBe('standard')
    expect(result.source).toBe('api')
  })

  it('classifies V8 as x-mode', async () => {
    const fetchImpl = mockFetchResponse({
      code: 0,
      msg: 'success',
      data: { address: CA, version: 'V8', name: 'T', shortName: 'T', symbol: 'BNB' },
    })
    const result = await identifyToken(CA, { fetchImpl })
    expect(result.variant).toBe('x-mode')
  })

  it('classifies tokens with taxInfo as tax-token', async () => {
    const fetchImpl = mockFetchResponse({
      code: 0,
      msg: 'success',
      data: {
        address: CA,
        version: 'V3',
        name: 'T',
        shortName: 'T',
        symbol: 'BNB',
        taxInfo: {
          feeRate: 5,
          recipientRate: 0,
          burnRate: 0,
          divideRate: 100,
          liquidityRate: 0,
          recipientAddress: '',
          minSharing: 100000,
        },
      },
    })
    const result = await identifyToken(CA, { fetchImpl })
    expect(result.variant).toBe('tax-token')
  })

  it('classifies feePlan:true as anti-sniper-fee', async () => {
    const fetchImpl = mockFetchResponse({
      code: 0,
      msg: 'success',
      data: {
        address: CA,
        version: 'V3',
        name: 'T',
        shortName: 'T',
        symbol: 'BNB',
        feePlan: true,
      },
    })
    const result = await identifyToken(CA, { fetchImpl })
    expect(result.variant).toBe('anti-sniper-fee')
  })

  it('tax-token takes priority over anti-sniper-fee', async () => {
    const fetchImpl = mockFetchResponse({
      code: 0,
      msg: 'success',
      data: {
        address: CA,
        version: 'V3',
        name: 'T',
        shortName: 'T',
        symbol: 'BNB',
        feePlan: true,
        taxInfo: {
          feeRate: 5,
          recipientRate: 0,
          burnRate: 50,
          divideRate: 50,
          liquidityRate: 0,
          recipientAddress: '',
          minSharing: 100000,
        },
      },
    })
    const result = await identifyToken(CA, { fetchImpl })
    expect(result.variant).toBe('tax-token')
  })
})

describe('identifyToken — three-state source', () => {
  it('returns fallback-network on HTTP 5xx / 4xx', async () => {
    const fetchImpl = mockFetchResponse({}, false)
    const result = await identifyToken(CA, { fetchImpl })
    expect(result.variant).toBe('standard')
    expect(result.source).toBe('fallback-network')
  })

  it('returns fallback-network on connection error', async () => {
    const fetchImpl = mockFetchError(new Error('ECONNRESET'))
    const result = await identifyToken(CA, { fetchImpl })
    expect(result.variant).toBe('standard')
    expect(result.source).toBe('fallback-network')
  })

  it('returns not-found when API code != 0', async () => {
    const fetchImpl = mockFetchResponse({ code: 9999, msg: 'not found', data: null })
    const result = await identifyToken(CA, { fetchImpl })
    expect(result.variant).toBe('standard')
    expect(result.source).toBe('not-found')
  })

  it('returns not-found when API data is null', async () => {
    const fetchImpl = mockFetchResponse({ code: 0, msg: 'ok', data: null })
    const result = await identifyToken(CA, { fetchImpl })
    expect(result.source).toBe('not-found')
  })

  it('respects timeout via AbortController', async () => {
    // A fetch that never resolves — we set a 10ms timeout and expect fallback-network
    const fetchImpl = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('AbortError'))
        })
      })) as unknown as typeof fetch
    const result = await identifyToken(CA, { fetchImpl, timeoutMs: 10 })
    expect(result.variant).toBe('standard')
    expect(result.source).toBe('fallback-network')
  })

  it('honors apiBaseUrl option (overrides config)', async () => {
    let capturedUrl = ''
    const fetchImpl = ((url: string) => {
      capturedUrl = url
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            code: 0,
            msg: 'ok',
            data: {
              address: CA,
              version: 'V3',
              name: 'T',
              shortName: 'T',
              symbol: 'BNB',
            },
          }),
      } as Response)
    }) as unknown as typeof fetch
    await identifyToken(CA, {
      fetchImpl,
      apiBaseUrl: 'https://example.test/meme-api',
    })
    expect(capturedUrl).toContain('https://example.test/meme-api')
  })
})

// ============================================================
// assertSupportedToken
// ============================================================

describe('assertSupportedToken', () => {
  it('passes through for standard tokens', async () => {
    const fetchImpl = mockFetchResponse({
      code: 0,
      msg: 'success',
      data: { address: CA, version: 'V3', name: 'T', shortName: 'T', symbol: 'BNB' },
    })
    const result = await assertSupportedToken(CA, { fetchImpl })
    expect(result.variant).toBe('standard')
  })

  it('passes through for anti-sniper-fee tokens', async () => {
    const fetchImpl = mockFetchResponse({
      code: 0,
      msg: 'success',
      data: {
        address: CA,
        version: 'V3',
        name: 'T',
        shortName: 'T',
        symbol: 'BNB',
        feePlan: true,
      },
    })
    const result = await assertSupportedToken(CA, { fetchImpl })
    expect(result.variant).toBe('anti-sniper-fee')
  })

  it('throws UnsupportedTokenError for tax-token', async () => {
    const fetchImpl = mockFetchResponse({
      code: 0,
      msg: 'success',
      data: {
        address: CA,
        version: 'V3',
        name: 'T',
        shortName: 'T',
        symbol: 'BNB',
        taxInfo: {
          feeRate: 5,
          recipientRate: 0,
          burnRate: 50,
          divideRate: 50,
          liquidityRate: 0,
          recipientAddress: '',
          minSharing: 100000,
        },
      },
    })
    await expect(
      assertSupportedToken(CA, { fetchImpl }),
    ).rejects.toBeInstanceOf(UnsupportedTokenError)
    await expect(assertSupportedToken(CA, { fetchImpl })).rejects.toThrow(
      /TaxToken is not supported/,
    )
  })

  it('throws UnsupportedTokenError for x-mode', async () => {
    const fetchImpl = mockFetchResponse({
      code: 0,
      msg: 'success',
      data: { address: CA, version: 'V8', name: 'T', shortName: 'T', symbol: 'BNB' },
    })
    await expect(assertSupportedToken(CA, { fetchImpl })).rejects.toThrow(
      /X Mode token is not supported/,
    )
  })

  it('throws TokenNotFoundError when API reports code != 0', async () => {
    const fetchImpl = mockFetchResponse({
      code: 1,
      msg: 'not found',
      data: null,
    })
    await expect(
      assertSupportedToken(CA, { fetchImpl }),
    ).rejects.toBeInstanceOf(TokenNotFoundError)
    await expect(assertSupportedToken(CA, { fetchImpl })).rejects.toThrow(
      /not registered with Four.meme/,
    )
  })

  it('throws TokenNotFoundError when API returns null data', async () => {
    const fetchImpl = mockFetchResponse({
      code: 0,
      msg: 'ok',
      data: null,
    })
    await expect(
      assertSupportedToken(CA, { fetchImpl }),
    ).rejects.toBeInstanceOf(TokenNotFoundError)
  })

  it('does NOT throw on network fallback (degraded mode)', async () => {
    // network failure should leave the downstream RPC layer as the arbiter
    const fetchImpl = mockFetchError(new Error('ECONNRESET'))
    const result = await assertSupportedToken(CA, { fetchImpl })
    // Variant defaulted to standard, source is fallback-network
    expect(result.variant).toBe('standard')
    expect(result.source).toBe('fallback-network')
  })
})
