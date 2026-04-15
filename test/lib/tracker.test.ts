/**
 * Tracker integration tests.
 *
 * Uses a hand-rolled mock PublicClient so we don't touch BSC. Goals:
 *   - trackTransaction writes a record to the CORRECT ca directory (regression
 *     for blocker #1: transfer ca was accidentally the signer address)
 *   - refreshBalanceSnapshot PATCHES bnbBalance without clobbering tokenBalance
 *     (regression for blocker #2: tokenBalance was overwritten with 0)
 *   - trackInBackground swallows errors and never throws
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'
import { DataStore, resetDataStore, getDataStore } from '../../src/datastore/index.js'
import { NATIVE_BNB } from '../../src/lib/const.js'
import { trackInBackground, trackTransaction } from '../../src/lib/tracker.js'
import { transactionsPath } from '../../src/datastore/paths.js'

// ============================================================
// Fixture: minimal PublicClient surface the tracker actually calls
// ============================================================

type MockedReceipt = {
  status: 'success' | 'reverted'
  blockNumber: bigint
  gasUsed: bigint
  effectiveGasPrice: bigint
}

/**
 * Just the PublicClient methods trackTransaction touches. Keeping this
 * narrow means TypeScript can tell us if tracker.ts ever grows a new
 * dependency on a PublicClient method we haven't mocked.
 */
type TrackerClient = Pick<
  PublicClient,
  'waitForTransactionReceipt' | 'getBlock' | 'getBalance' | 'readContract'
>

type MockOpts = {
  /** Successful receipt to return */
  receipt?: MockedReceipt
  /** Error to throw from waitForTransactionReceipt (e.g. timeout) */
  receiptError?: Error
  /** Raw BNB balance (wei) that getBalance returns */
  bnbBalance?: bigint
  /** Raw token balance (smallest units) returned for balanceOf */
  tokenBalance?: bigint
  /** Token decimals returned by decimals() */
  tokenDecimals?: number
  /** Block timestamp (Unix seconds bigint) */
  blockTimestamp?: bigint
}

function makeMockClient(opts: MockOpts): PublicClient {
  const mock: TrackerClient = {
    waitForTransactionReceipt: (async () => {
      if (opts.receiptError) throw opts.receiptError
      if (!opts.receipt) throw new Error('no receipt configured')
      return opts.receipt
    }) as TrackerClient['waitForTransactionReceipt'],
    getBlock: (async () => ({
      timestamp: opts.blockTimestamp ?? 1_700_000_000n,
    })) as TrackerClient['getBlock'],
    getBalance: (async () => opts.bnbBalance ?? 0n) as TrackerClient['getBalance'],
    readContract: (async ({ functionName }) => {
      if (functionName === 'balanceOf') return opts.tokenBalance ?? 0n
      if (functionName === 'decimals') return BigInt(opts.tokenDecimals ?? 18)
      throw new Error(`unexpected readContract(${String(functionName)})`)
    }) as TrackerClient['readContract'],
  }
  // Single cast point — keeps the internal type narrow but lets call sites
  // pass the mock directly to trackTransaction(client, ...).
  return mock as unknown as PublicClient
}

/**
 * Force all pending microtasks + one macrotask to run.
 * Deterministic replacement for `await new Promise(r => setTimeout(r, N))`
 * when we need to wait on a fire-and-forget promise chain.
 */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
}

// ============================================================
// Fixture: isolate HOME per test
// ============================================================

let tmpHome: string
let realHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fourmm-tracker-test-'))
  realHome = process.env.HOME
  process.env.HOME = tmpHome
  resetDataStore() // force a fresh singleton keyed to the new HOME
})

afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
  resetDataStore()
})

// ============================================================
// Tests
// ============================================================

const CA_STANDARD = '0x0000000000000000000000000000000000004444' as const
const WALLET_A = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' as const
const WALLET_B = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF' as const
const TX_HASH =
  '0xaaaa000000000000000000000000000000000000000000000000000000000001' as const

describe('trackTransaction — DataStore writes', () => {
  it('writes the record under the correct CA (token tx)', async () => {
    const client = makeMockClient({
      receipt: {
        status: 'success',
        blockNumber: 123_456n,
        gasUsed: 21_000n,
        effectiveGasPrice: 3_000_000_000n,
      },
    })

    const result = await trackTransaction(client, TX_HASH, {
      ca: CA_STANDARD,
      groupId: 1,
      walletAddress: WALLET_A,
      txType: 'buy',
      knownAmountBnb: -0.01,
    })

    expect(result.status).toBe('confirmed')
    // Critical: file must be under tokens/<CA_STANDARD>/, NOT tokens/<wallet>/
    expect(fs.existsSync(transactionsPath(CA_STANDARD, 1))).toBe(true)
    // And NOT under the signer address (regression guard for blocker #1)
    expect(fs.existsSync(transactionsPath(WALLET_A, 1))).toBe(false)

    const txFile = getDataStore().getTransactions(CA_STANDARD, 1)
    expect(txFile?.transactions).toHaveLength(1)
    expect(txFile?.transactions[0]?.txHash).toBe(TX_HASH)
    expect(txFile?.transactions[0]?.amountBnb).toBe(-0.01)
    expect(txFile?.transactions[0]?.status).toBe('confirmed')
  })

  it('writes native BNB transfers under NATIVE_BNB', async () => {
    const client = makeMockClient({
      receipt: {
        status: 'success',
        blockNumber: 100n,
        gasUsed: 21_000n,
        effectiveGasPrice: 3_000_000_000n,
      },
    })

    await trackTransaction(client, TX_HASH, {
      ca: NATIVE_BNB,
      groupId: 1,
      walletAddress: WALLET_A,
      txType: 'transfer_out',
      knownAmountBnb: -0.1,
    })

    // Regression: transfer records must live under NATIVE_BNB, NOT the signer
    expect(fs.existsSync(transactionsPath(NATIVE_BNB, 1))).toBe(true)
    expect(fs.existsSync(transactionsPath(WALLET_A, 1))).toBe(false)

    const ds = getDataStore()
    const txs = ds.getTransactions(NATIVE_BNB, 1)?.transactions
    expect(txs).toHaveLength(1)
    expect(txs?.[0]?.txType).toBe('transfer_out')
    expect(txs?.[0]?.amountBnb).toBe(-0.1)
  })

  it('marks reverted transactions as failed', async () => {
    const client = makeMockClient({
      receipt: {
        status: 'reverted',
        blockNumber: 1n,
        gasUsed: 21_000n,
        effectiveGasPrice: 3_000_000_000n,
      },
    })

    const result = await trackTransaction(client, TX_HASH, {
      ca: CA_STANDARD,
      groupId: 1,
      walletAddress: WALLET_A,
      txType: 'buy',
    })
    expect(result.status).toBe('failed')
    const stored = getDataStore().getTransactions(CA_STANDARD, 1)
    expect(stored?.transactions[0]?.status).toBe('failed')
  })

  it('returns timeout when waitForTransactionReceipt throws', async () => {
    const client = makeMockClient({
      receiptError: new Error('timeout'),
    })
    const result = await trackTransaction(client, TX_HASH, {
      ca: CA_STANDARD,
      groupId: 1,
      walletAddress: WALLET_A,
      txType: 'buy',
    })
    expect(result.status).toBe('timeout')
  })
})

describe('trackTransaction — balance snapshot patch semantics', () => {
  it('preserves tokenBalance when refreshing BNB on a confirmed tx', async () => {
    // Seed: wallet has a pre-existing tokenBalance (e.g. from a prior trade)
    const ds = new DataStore()
    ds.updateBalance(CA_STANDARD, 1, WALLET_A, {
      bnbBalance: 0.5,
      tokenBalance: 1_000_000,
    })
    expect(ds.getBalances(CA_STANDARD, 1)?.balances[0]?.tokenBalance).toBe(
      1_000_000,
    )

    // Drive a confirmed tx through the tracker
    const client = makeMockClient({
      receipt: {
        status: 'success',
        blockNumber: 200n,
        gasUsed: 21_000n,
        effectiveGasPrice: 3_000_000_000n,
      },
      bnbBalance: 750_000_000_000_000_000n, // 0.75 BNB in wei
      tokenBalance: 1_000_000n * 10n ** 18n,
    })

    await trackTransaction(client, TX_HASH, {
      ca: CA_STANDARD,
      groupId: 1,
      walletAddress: WALLET_A,
      txType: 'buy',
    })

    // Critical: tokenBalance MUST survive the bnbBalance patch
    // (regression guard for blocker #2: refreshBalanceSnapshot used to write
    //  `tokenBalance: 0` unconditionally, destroying prior trade data)
    const after = getDataStore().getBalances(CA_STANDARD, 1)?.balances[0]
    expect(after?.bnbBalance).toBe(0.75)
    expect(after?.tokenBalance).toBe(1_000_000)
  })

  it('creates a holdings row for confirmed token buys', async () => {
    const client = makeMockClient({
      receipt: {
        status: 'success',
        blockNumber: 201n,
        gasUsed: 21_000n,
        effectiveGasPrice: 3_000_000_000n,
      },
      bnbBalance: 500_000_000_000_000_000n,
      tokenBalance: 1_000n * 10n ** 18n,
      tokenDecimals: 18,
    })

    await trackTransaction(client, TX_HASH, {
      ca: CA_STANDARD,
      groupId: 1,
      walletAddress: WALLET_A,
      txType: 'buy',
      knownAmountBnb: -0.01,
    })

    const holding = getDataStore().getHoldings(CA_STANDARD, 1)?.wallets[0]
    expect(holding).toBeDefined()
    expect(holding?.walletAddress).toBe(WALLET_A)
    expect(holding?.tokenBalance).toBe(1000)
    expect(holding?.totalBought).toBe(1000)
    expect(holding?.totalCostBnb).toBe(0.01)
    expect(holding?.avgBuyPrice).toBe(0.00001)
  })

  it('refreshes counterparty balance when provided', async () => {
    const client = makeMockClient({
      receipt: {
        status: 'success',
        blockNumber: 300n,
        gasUsed: 21_000n,
        effectiveGasPrice: 3_000_000_000n,
      },
      bnbBalance: 500_000_000_000_000_000n, // 0.5 BNB
    })

    await trackTransaction(client, TX_HASH, {
      ca: NATIVE_BNB,
      groupId: 1,
      walletAddress: WALLET_A,
      txType: 'transfer_out',
      counterparty: WALLET_B,
    })

    const balances = getDataStore().getBalances(NATIVE_BNB, 1)?.balances ?? []
    const addresses = balances.map((b) => b.walletAddress)
    expect(addresses).toContain(WALLET_A)
    expect(addresses).toContain(WALLET_B)
  })
})

describe('trackInBackground', () => {
  it('never throws even if the tracker would fail', async () => {
    const client = makeMockClient({ receiptError: new Error('boom') })
    // trackInBackground must not throw synchronously
    expect(() =>
      trackInBackground(client, TX_HASH, {
        ca: CA_STANDARD,
        groupId: 1,
        walletAddress: WALLET_A,
        txType: 'buy',
      }),
    ).not.toThrow()
    // Deterministic: flush pending microtasks + one macrotask tick to let
    // the fire-and-forget chain resolve before the test exits.
    await flushPromises()
  })
})
