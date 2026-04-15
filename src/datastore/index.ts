/**
 * DataStore — local JSON store at ~/.fourmm/data/.
 *
 * Responsibilities:
 *   - Persist token metadata, pool info, transaction history, holdings, balances
 *   - Atomic writes (write .tmp, rename) to avoid half-written files
 *   - Memory cache per key with TTL (default 30s)
 *
 * What it does NOT do:
 *   - Cross-process locking. CLI is single-process; parallel invocations
 *     can race on writes. If Week 3 Router daemons need parallel writes we
 *     add a lockfile then.
 *   - Pretty printing control / schema migration (we'll version if needed).
 *
 * Public surface is a class with a singleton accessor so tests can inject
 * a fresh instance. Paths come from datastore/paths.ts which reads HOME
 * lazily, so redirecting HOME per test works.
 */

import fs from 'node:fs'
import path from 'node:path'
import { MemoryCache } from './cache.js'
import {
  balancesPath,
  bnbPricePath,
  globalDir,
  groupDir,
  holdingsPath,
  poolInfoPath,
  tokenDir,
  tokenInfoPath,
  tokensRoot,
  transactionsPath,
} from './paths.js'
import type {
  BalancesFile,
  BnbPriceFile,
  HoldingsFile,
  PoolInfoFile,
  TokenInfoFile,
  TransactionRecord,
  TransactionsFile,
  WalletBalance,
  WalletHolding,
} from './types.js'
import type { Address } from 'viem'

// Re-export types so consumers only need one import path
export * from './types.js'
export { MemoryCache } from './cache.js'

// ============================================================
// Internal helpers
// ============================================================

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
  fs.renameSync(tmpPath, filePath)
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    // Corrupt file: let the caller decide whether to rewrite or error
    return null
  }
}

function validateCa(ca: string): void {
  if (!ca || ca.includes('/') || ca.includes('\\') || ca.includes('..')) {
    throw new Error(`Invalid CA: "${ca}"`)
  }
}

// ============================================================
// DataStore
// ============================================================

export class DataStore {
  readonly cache: MemoryCache

  constructor(ttlMs = 30_000) {
    this.cache = new MemoryCache(ttlMs)
  }

  // ----- token-info.json -----

  getTokenInfo(ca: Address): TokenInfoFile | null {
    validateCa(ca)
    const key = `token:${ca}`
    const cached = this.cache.get<TokenInfoFile>(key)
    if (cached) return cached
    const data = readJson<TokenInfoFile>(tokenInfoPath(ca))
    if (data) this.cache.set(key, data)
    return data
  }

  saveTokenInfo(info: TokenInfoFile): void {
    validateCa(info.ca)
    atomicWriteJson(tokenInfoPath(info.ca), info)
    this.cache.set(`token:${info.ca}`, info)
  }

  // ----- pool-info.json -----

  getPoolInfo(ca: Address): PoolInfoFile | null {
    validateCa(ca)
    const key = `pool:${ca}`
    const cached = this.cache.get<PoolInfoFile>(key)
    if (cached) return cached
    const data = readJson<PoolInfoFile>(poolInfoPath(ca))
    if (data) this.cache.set(key, data)
    return data
  }

  savePoolInfo(info: PoolInfoFile): void {
    validateCa(info.ca)
    atomicWriteJson(poolInfoPath(info.ca), info)
    this.cache.set(`pool:${info.ca}`, info)
  }

  // ----- transactions.json -----

  getTransactions(ca: Address, groupId: number): TransactionsFile | null {
    validateCa(ca)
    return readJson<TransactionsFile>(transactionsPath(ca, groupId))
  }

  /**
   * Append a transaction to the group's history, deduped by txHash.
   * Always reads fresh from disk (no cache) to avoid losing a concurrent append.
   */
  appendTransaction(
    ca: Address,
    groupId: number,
    tx: TransactionRecord,
  ): void {
    validateCa(ca)
    const file = transactionsPath(ca, groupId)
    let current = readJson<TransactionsFile>(file)
    if (!current) {
      current = {
        ca,
        groupId,
        transactions: [],
        updatedAt: Date.now(),
      }
    }
    // Dedupe by txHash
    if (current.transactions.some((t) => t.txHash === tx.txHash)) {
      return
    }
    current.transactions.push(tx)
    current.updatedAt = Date.now()
    atomicWriteJson(file, current)
  }

  // ----- holdings.json -----

  getHoldings(ca: Address, groupId: number): HoldingsFile | null {
    validateCa(ca)
    const key = `holdings:${ca}:${groupId}`
    const cached = this.cache.get<HoldingsFile>(key)
    if (cached) return cached
    const data = readJson<HoldingsFile>(holdingsPath(ca, groupId))
    if (data) this.cache.set(key, data)
    return data
  }

  /**
   * Upsert a single wallet's holding.
   * Merges with existing (by walletAddress); creates the file if missing.
   */
  updateHolding(
    ca: Address,
    groupId: number,
    wallet: Address,
    patch: Partial<WalletHolding>,
  ): void {
    validateCa(ca)
    const file = holdingsPath(ca, groupId)
    let current = readJson<HoldingsFile>(file)
    if (!current) {
      current = { ca, groupId, wallets: [], updatedAt: Date.now() }
    }

    const idx = current.wallets.findIndex((w) => w.walletAddress === wallet)
    if (idx === -1) {
      const blank: WalletHolding = {
        walletAddress: wallet,
        tokenBalance: 0,
        avgBuyPrice: 0,
        totalBought: 0,
        totalSold: 0,
        totalCostBnb: 0,
        totalRevenueBnb: 0,
        realizedPnl: 0,
        ...patch,
      }
      current.wallets.push(blank)
    } else {
      current.wallets[idx] = { ...current.wallets[idx]!, ...patch }
    }
    current.updatedAt = Date.now()
    atomicWriteJson(file, current)
    this.cache.set(`holdings:${ca}:${groupId}`, current)
  }

  // ----- balances.json -----

  getBalances(ca: Address, groupId: number): BalancesFile | null {
    validateCa(ca)
    const key = `balances:${ca}:${groupId}`
    const cached = this.cache.get<BalancesFile>(key)
    if (cached) return cached
    const data = readJson<BalancesFile>(balancesPath(ca, groupId))
    if (data) this.cache.set(key, data)
    return data
  }

  /**
   * Partial upsert of a single wallet's balance.
   *
   * IMPORTANT: patch semantics — any field you DON'T pass keeps its previous
   * value. This avoids the bug where a BNB-only refresh would clobber a
   * stored tokenBalance. `updatedAt` is always bumped to now.
   *
   * If the wallet has no existing row, missing fields default to 0.
   */
  updateBalance(
    ca: Address,
    groupId: number,
    walletAddress: Address,
    patch: Partial<Omit<WalletBalance, 'walletAddress' | 'updatedAt'>>,
  ): void {
    validateCa(ca)
    const file = balancesPath(ca, groupId)
    let current = readJson<BalancesFile>(file)
    if (!current) {
      current = { ca, groupId, balances: [], updatedAt: Date.now() }
    }
    const idx = current.balances.findIndex(
      (b) => b.walletAddress === walletAddress,
    )
    const now = Date.now()
    const base: WalletBalance =
      idx >= 0
        ? current.balances[idx]!
        : {
            walletAddress,
            bnbBalance: 0,
            tokenBalance: 0,
            updatedAt: now,
          }
    const merged: WalletBalance = {
      ...base,
      ...patch,
      walletAddress,
      updatedAt: now,
    }
    if (idx === -1) current.balances.push(merged)
    else current.balances[idx] = merged
    current.updatedAt = now
    atomicWriteJson(file, current)
    this.cache.set(`balances:${ca}:${groupId}`, current)
  }

  /**
   * Batch variant: apply a list of patches in one file write.
   * Each patch must include `walletAddress` so we know which row to merge.
   */
  updateBalancesBatch(
    ca: Address,
    groupId: number,
    patches: Array<{ walletAddress: Address } & Partial<Omit<WalletBalance, 'walletAddress' | 'updatedAt'>>>,
  ): void {
    if (patches.length === 0) return
    validateCa(ca)
    const file = balancesPath(ca, groupId)
    let current = readJson<BalancesFile>(file)
    if (!current) {
      current = { ca, groupId, balances: [], updatedAt: Date.now() }
    }
    const now = Date.now()
    const byAddr = new Map(current.balances.map((b) => [b.walletAddress, b]))
    for (const patch of patches) {
      const base = byAddr.get(patch.walletAddress) ?? {
        walletAddress: patch.walletAddress,
        bnbBalance: 0,
        tokenBalance: 0,
        updatedAt: now,
      }
      byAddr.set(patch.walletAddress, {
        ...base,
        ...patch,
        walletAddress: patch.walletAddress,
        updatedAt: now,
      })
    }
    current.balances = Array.from(byAddr.values())
    current.updatedAt = now
    atomicWriteJson(file, current)
    this.cache.set(`balances:${ca}:${groupId}`, current)
  }

  // ----- global/bnb-price.json -----

  getBnbPrice(): BnbPriceFile | null {
    const cached = this.cache.get<BnbPriceFile>('global:bnb-price')
    if (cached) return cached
    const data = readJson<BnbPriceFile>(bnbPricePath())
    if (data) this.cache.set('global:bnb-price', data)
    return data
  }

  saveBnbPrice(priceUsd: number): void {
    const file: BnbPriceFile = { priceUsd, updatedAt: Date.now() }
    if (!fs.existsSync(globalDir())) {
      fs.mkdirSync(globalDir(), { recursive: true, mode: 0o700 })
    }
    atomicWriteJson(bnbPricePath(), file)
    this.cache.set('global:bnb-price', file)
  }

  // ----- Directory listing -----

  /**
   * List all token CA directories we have data for.
   *
   * Excludes `NATIVE_BNB` (the sentinel CA used for BNB transfer history) so
   * callers iterating "for each known token" don't hit version=0 reverts on
   * the zero address.
   */
  listTokens(): Address[] {
    const root = tokensRoot()
    if (!fs.existsSync(root)) return []
    const NATIVE_BNB = '0x0000000000000000000000000000000000000000'
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name as Address)
      .filter((addr) => addr.toLowerCase() !== NATIVE_BNB)
  }

  /**
   * List the groups that have native BNB transfer history.
   * Separate from `listTokens` so downstream monitor/PnL code can treat
   * BNB history distinctly from token holdings.
   */
  listNativeBnbGroups(): number[] {
    const NATIVE_BNB = '0x0000000000000000000000000000000000000000' as Address
    return this.listGroups(NATIVE_BNB)
  }

  listGroups(ca: Address): number[] {
    validateCa(ca)
    const groupsRoot = path.join(tokenDir(ca), 'groups')
    if (!fs.existsSync(groupsRoot)) return []
    return fs
      .readdirSync(groupsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => Number.parseInt(d.name, 10))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b)
  }

  /** Ensure the group directory exists (useful before running a session) */
  ensureGroupDir(ca: Address, groupId: number): void {
    validateCa(ca)
    const dir = groupDir(ca, groupId)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }
}

// ============================================================
// Singleton
// ============================================================

let _instance: DataStore | null = null

/** Get the global DataStore. Tests that need isolation should use `new DataStore()`. */
export function getDataStore(): DataStore {
  if (!_instance) _instance = new DataStore()
  return _instance
}

/** Reset the singleton (test helper) */
export function resetDataStore(): void {
  _instance = null
}
