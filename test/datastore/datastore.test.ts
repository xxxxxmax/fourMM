import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DataStore, MemoryCache } from '../../src/datastore/index.js'
import {
  balancesPath,
  bnbPricePath,
  holdingsPath,
  poolInfoPath,
  tokenInfoPath,
  transactionsPath,
} from '../../src/datastore/paths.js'
import type {
  HoldingsFile,
  PoolInfoFile,
  TokenInfoFile,
  TransactionRecord,
  WalletBalance,
} from '../../src/datastore/types.js'

const CA = '0x0000000000000000000000000000000000004444' as const
const CA_B = '0x0000000000000000000000000000000000005555' as const
const WALLET_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as const
const WALLET_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as const

let tmpHome: string
let realHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fourmm-datastore-'))
  realHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

// ============================================================
// MemoryCache
// ============================================================

describe('MemoryCache', () => {
  it('returns undefined for unknown keys', () => {
    const cache = new MemoryCache()
    expect(cache.get('nothing')).toBeUndefined()
  })

  it('stores and retrieves within TTL', () => {
    const cache = new MemoryCache(1000)
    cache.set('k', { v: 1 })
    expect(cache.get<{ v: number }>('k')?.v).toBe(1)
  })

  it('expires entries past TTL', async () => {
    const cache = new MemoryCache(10)
    cache.set('k', 42)
    await new Promise((r) => setTimeout(r, 20))
    expect(cache.get('k')).toBeUndefined()
    // Expired entries are dropped from the store on read
    expect(cache.size()).toBe(0)
  })

  it('invalidate drops a single key', () => {
    const cache = new MemoryCache()
    cache.set('a', 1)
    cache.set('b', 2)
    cache.invalidate('a')
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
  })

  it('invalidatePrefix drops matching keys', () => {
    const cache = new MemoryCache()
    cache.set('token:0xaaa', 1)
    cache.set('token:0xbbb', 2)
    cache.set('pool:0xaaa', 3)
    cache.invalidatePrefix('token:')
    expect(cache.get('token:0xaaa')).toBeUndefined()
    expect(cache.get('token:0xbbb')).toBeUndefined()
    expect(cache.get('pool:0xaaa')).toBe(3)
  })
})

// ============================================================
// DataStore — token info / pool info
// ============================================================

describe('DataStore.tokenInfo', () => {
  it('returns null for unknown tokens', () => {
    const ds = new DataStore()
    expect(ds.getTokenInfo(CA)).toBeNull()
  })

  it('persists and reads back token info', () => {
    const ds = new DataStore()
    const info: TokenInfoFile = {
      ca: CA,
      symbol: 'HACK',
      name: 'Hackathon',
      decimals: 18,
      creatorAddress: WALLET_A,
      version: 2,
      variant: 'standard',
      tokenManager: '0x5c952063c7fc8610FFDB798152D69F0B9550762b',
      quote: '0x0000000000000000000000000000000000000000',
      pairAddress: '',
      liquidityAdded: false,
      updatedAt: Date.now(),
    }
    ds.saveTokenInfo(info)
    // Reload via a fresh DataStore to bypass cache
    const fresh = new DataStore()
    expect(fresh.getTokenInfo(CA)).toEqual(info)
  })

  it('caches reads (second get does not touch disk)', () => {
    const ds = new DataStore()
    const info: TokenInfoFile = {
      ca: CA,
      symbol: 'HACK',
      name: 'Hackathon',
      decimals: 18,
      creatorAddress: '',
      version: 2,
      variant: 'standard',
      tokenManager: '0x5c952063c7fc8610FFDB798152D69F0B9550762b',
      quote: '0x0000000000000000000000000000000000000000',
      pairAddress: '',
      liquidityAdded: false,
      updatedAt: Date.now(),
    }
    ds.saveTokenInfo(info)
    // Manually remove the file — a cached read should still succeed
    fs.rmSync(tokenInfoPath(CA))
    expect(ds.getTokenInfo(CA)).toEqual(info)
  })

  it('rejects CAs with path traversal characters', () => {
    const ds = new DataStore()
    expect(() =>
      ds.getTokenInfo('../secret' as `0x${string}`),
    ).toThrow(/Invalid CA/)
  })
})

describe('DataStore.poolInfo', () => {
  it('persists and reads back pool info', () => {
    const ds = new DataStore()
    const info: PoolInfoFile = {
      ca: CA,
      pairAddress: '',
      path: 'bonding-curve',
      priceBnb: 0.000123,
      priceUsd: 0.04,
      graduationProgress: 0.1,
      updatedAt: Date.now(),
    }
    ds.savePoolInfo(info)
    expect(new DataStore().getPoolInfo(CA)).toEqual(info)
  })
})

// ============================================================
// DataStore — transactions
// ============================================================

describe('DataStore.transactions', () => {
  const base: TransactionRecord = {
    txHash:
      '0xaaaa000000000000000000000000000000000000000000000000000000000001',
    txType: 'buy',
    walletAddress: WALLET_A,
    tokenCA: CA,
    amountBnb: -0.1,
    amountToken: 1000,
    pricePerToken: 0.0001,
    fee: 0.001,
    blockNumber: 12345,
    blockTime: 1_700_000_000,
    status: 'confirmed',
  }

  it('returns null when nothing has been written', () => {
    const ds = new DataStore()
    expect(ds.getTransactions(CA, 1)).toBeNull()
  })

  it('appends a new transaction', () => {
    const ds = new DataStore()
    ds.appendTransaction(CA, 1, base)
    const out = ds.getTransactions(CA, 1)
    expect(out?.transactions).toHaveLength(1)
    expect(out?.transactions[0]?.txHash).toBe(base.txHash)
  })

  it('dedupes by txHash on repeat append', () => {
    const ds = new DataStore()
    ds.appendTransaction(CA, 1, base)
    ds.appendTransaction(CA, 1, base)
    ds.appendTransaction(CA, 1, { ...base })
    expect(ds.getTransactions(CA, 1)?.transactions).toHaveLength(1)
  })

  it('keeps separate lists per (ca, groupId)', () => {
    const ds = new DataStore()
    ds.appendTransaction(CA, 1, base)
    ds.appendTransaction(CA, 2, { ...base, txHash: '0xbbbb' as `0x${string}` })
    ds.appendTransaction(CA_B, 1, base)
    expect(ds.getTransactions(CA, 1)?.transactions).toHaveLength(1)
    expect(ds.getTransactions(CA, 2)?.transactions).toHaveLength(1)
    expect(ds.getTransactions(CA_B, 1)?.transactions).toHaveLength(1)
  })
})

// ============================================================
// DataStore — holdings
// ============================================================

describe('DataStore.holdings', () => {
  it('creates a blank holding on first update', () => {
    const ds = new DataStore()
    ds.updateHolding(CA, 1, WALLET_A, { tokenBalance: 100 })
    const h = ds.getHoldings(CA, 1)
    expect(h?.wallets).toHaveLength(1)
    expect(h?.wallets[0]?.walletAddress).toBe(WALLET_A)
    expect(h?.wallets[0]?.tokenBalance).toBe(100)
    expect(h?.wallets[0]?.avgBuyPrice).toBe(0)
  })

  it('upserts existing wallet in place', () => {
    const ds = new DataStore()
    ds.updateHolding(CA, 1, WALLET_A, { tokenBalance: 100 })
    ds.updateHolding(CA, 1, WALLET_A, { tokenBalance: 250, avgBuyPrice: 0.01 })
    const h = ds.getHoldings(CA, 1)
    expect(h?.wallets).toHaveLength(1)
    expect(h?.wallets[0]?.tokenBalance).toBe(250)
    expect(h?.wallets[0]?.avgBuyPrice).toBe(0.01)
  })

  it('tracks multiple wallets independently', () => {
    const ds = new DataStore()
    ds.updateHolding(CA, 1, WALLET_A, { tokenBalance: 100 })
    ds.updateHolding(CA, 1, WALLET_B, { tokenBalance: 200 })
    const h = ds.getHoldings(CA, 1)
    expect(h?.wallets).toHaveLength(2)
  })
})

// ============================================================
// DataStore — balances
// ============================================================

describe('DataStore.balances', () => {
  it('updateBalance creates a row with defaults when wallet is new', () => {
    const ds = new DataStore()
    ds.updateBalance(CA, 1, WALLET_A, { bnbBalance: 1, tokenBalance: 100 })
    const out = ds.getBalances(CA, 1)
    expect(out?.balances).toHaveLength(1)
    const row = out?.balances[0]
    expect(row?.walletAddress).toBe(WALLET_A)
    expect(row?.bnbBalance).toBe(1)
    expect(row?.tokenBalance).toBe(100)
  })

  it('updateBalance patch preserves fields not in the patch', () => {
    const ds = new DataStore()
    // First: write a full row with both balances
    ds.updateBalance(CA, 1, WALLET_A, { bnbBalance: 1, tokenBalance: 1_000_000 })
    // Then: patch only bnbBalance — tokenBalance must survive
    ds.updateBalance(CA, 1, WALLET_A, { bnbBalance: 2 })
    const row = ds.getBalances(CA, 1)?.balances[0]
    expect(row?.bnbBalance).toBe(2)
    expect(row?.tokenBalance).toBe(1_000_000)
  })

  it('updateBalance on the same wallet upserts, not appends', () => {
    const ds = new DataStore()
    ds.updateBalance(CA, 1, WALLET_A, { bnbBalance: 1 })
    ds.updateBalance(CA, 1, WALLET_A, { bnbBalance: 2 })
    ds.updateBalance(CA, 1, WALLET_A, { bnbBalance: 3 })
    expect(ds.getBalances(CA, 1)?.balances).toHaveLength(1)
    expect(ds.getBalances(CA, 1)?.balances[0]?.bnbBalance).toBe(3)
  })

  it('updateBalancesBatch merges multiple wallets and preserves per-field patch semantics', () => {
    const ds = new DataStore()
    // Seed: wallet A with token balance
    ds.updateBalance(CA, 1, WALLET_A, { tokenBalance: 500 })
    // Batch patch: A gets new bnbBalance (preserve tokenBalance); B is new
    ds.updateBalancesBatch(CA, 1, [
      { walletAddress: WALLET_A, bnbBalance: 5 },
      { walletAddress: WALLET_B, bnbBalance: 3, tokenBalance: 200 },
    ])
    const out = ds.getBalances(CA, 1)
    expect(out?.balances).toHaveLength(2)
    const a = out?.balances.find((b) => b.walletAddress === WALLET_A)
    expect(a?.bnbBalance).toBe(5)
    expect(a?.tokenBalance).toBe(500) // preserved through batch patch
    const b = out?.balances.find((b) => b.walletAddress === WALLET_B)
    expect(b?.bnbBalance).toBe(3)
    expect(b?.tokenBalance).toBe(200)
  })

  it('updateBalancesBatch is a no-op on empty array', () => {
    const ds = new DataStore()
    ds.updateBalancesBatch(CA, 1, [])
    expect(fs.existsSync(balancesPath(CA, 1))).toBe(false)
  })
})

// ============================================================
// DataStore — global BNB price
// ============================================================

describe('DataStore.bnbPrice', () => {
  it('writes and reads back', () => {
    const ds = new DataStore()
    ds.saveBnbPrice(650.42)
    expect(fs.existsSync(bnbPricePath())).toBe(true)
    expect(ds.getBnbPrice()?.priceUsd).toBe(650.42)
  })
})

// ============================================================
// DataStore — directory listing
// ============================================================

describe('DataStore listing', () => {
  it('listTokens returns empty when no tokens yet', () => {
    expect(new DataStore().listTokens()).toEqual([])
  })

  it('listTokens returns CAs that have data on disk', () => {
    const ds = new DataStore()
    ds.saveTokenInfo({
      ca: CA,
      symbol: 'A',
      name: 'A',
      decimals: 18,
      creatorAddress: '',
      version: 2,
      variant: 'standard',
      tokenManager: '0x5c952063c7fc8610FFDB798152D69F0B9550762b',
      quote: '0x0000000000000000000000000000000000000000',
      pairAddress: '',
      liquidityAdded: false,
      updatedAt: Date.now(),
    })
    ds.saveTokenInfo({
      ca: CA_B,
      symbol: 'B',
      name: 'B',
      decimals: 18,
      creatorAddress: '',
      version: 2,
      variant: 'standard',
      tokenManager: '0x5c952063c7fc8610FFDB798152D69F0B9550762b',
      quote: '0x0000000000000000000000000000000000000000',
      pairAddress: '',
      liquidityAdded: false,
      updatedAt: Date.now(),
    })
    expect(new DataStore().listTokens().sort()).toEqual([CA, CA_B].sort())
  })

  it('listGroups returns sorted numeric group IDs', () => {
    const ds = new DataStore()
    ds.appendTransaction(CA, 2, {
      txHash:
        '0xaaaa000000000000000000000000000000000000000000000000000000000001',
      txType: 'buy',
      walletAddress: WALLET_A,
      tokenCA: CA,
      amountBnb: 0,
      amountToken: 0,
      pricePerToken: 0,
      fee: 0,
      blockNumber: 0,
      blockTime: 0,
      status: 'confirmed',
    })
    ds.appendTransaction(CA, 5, {
      txHash:
        '0xbbbb000000000000000000000000000000000000000000000000000000000001',
      txType: 'buy',
      walletAddress: WALLET_A,
      tokenCA: CA,
      amountBnb: 0,
      amountToken: 0,
      pricePerToken: 0,
      fee: 0,
      blockNumber: 0,
      blockTime: 0,
      status: 'confirmed',
    })
    ds.appendTransaction(CA, 1, {
      txHash:
        '0xcccc000000000000000000000000000000000000000000000000000000000001',
      txType: 'buy',
      walletAddress: WALLET_A,
      tokenCA: CA,
      amountBnb: 0,
      amountToken: 0,
      pricePerToken: 0,
      fee: 0,
      blockNumber: 0,
      blockTime: 0,
      status: 'confirmed',
    })
    expect(new DataStore().listGroups(CA)).toEqual([1, 2, 5])
  })
})
