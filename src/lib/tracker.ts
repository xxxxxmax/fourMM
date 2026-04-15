/**
 * TxTracker — async tx confirmation + DataStore sink.
 *
 * After a command sends a transaction, it calls `trackInBackground(hash, ctx)`
 * and returns immediately. The tracker waits for the receipt in parallel and
 * writes a TransactionRecord + balance snapshot once the tx finalizes.
 *
 * Week 2 scope:
 *   - Transfer flows (transfer in/out) and dry-run trades
 *   - No on-chain event log decoding yet — we capture block info, gas,
 *     status, and a "known amount" passed from the caller
 *
 * Week 3 scope (not done here):
 *   - parseEventLogs for TokenManager2.TokenPurchase / TokenSale
 *   - Holdings re-accounting (avgBuyPrice / realizedPnl)
 *
 * Fire-and-forget: tracker failures are silent — they must never break the
 * CLI's exit path or mask the original tx hash returned to the agent.
 */

import type { Address, Hash, PublicClient } from 'viem'
import { formatEther, formatUnits } from 'viem'
import { erc20Abi } from '../contracts/erc20.js'
import { getDataStore } from '../datastore/index.js'
import type { TxType, WalletHolding } from '../datastore/types.js'
import { NATIVE_BNB } from './const.js'

// ============================================================
// Types
// ============================================================

export type TrackContext = {
  ca: Address
  groupId: number
  walletAddress: Address
  txType: TxType
  /**
   * Signed BNB delta known at submit time (positive = inbound, negative = outbound).
   * Used for transfers where the amount is part of the request, not an event.
   */
  knownAmountBnb?: number
  /**
   * Counterparty address (for BNB balance snapshot refresh).
   * Optional — if present, we also refresh their balance.
   */
  counterparty?: Address | undefined
}

export type TrackingResult = {
  txHash: Hash
  status: 'confirmed' | 'failed' | 'timeout'
  blockNumber?: number | undefined
  blockTime?: number | undefined
  fee?: number | undefined
}

// ============================================================
// Public API
// ============================================================

/**
 * Await a transaction, record it, refresh balances.
 * Always resolves — never throws.
 *
 * If `preReceipt` is provided the receipt wait is skipped entirely — use this
 * when the caller already awaited the receipt (e.g. sequential buy loop).
 */
export async function trackTransaction(
  client: PublicClient,
  txHash: Hash,
  context: TrackContext,
  timeoutMs = 30_000,
  preReceipt?: { status: string; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint } | undefined,
): Promise<TrackingResult> {
  try {
    const receipt = preReceipt ?? await client.waitForTransactionReceipt({
      hash: txHash,
      timeout: timeoutMs,
    })

    const ds = getDataStore()
    const status: 'confirmed' | 'failed' =
      receipt.status === 'success' ? 'confirmed' : 'failed'

    // Best-effort block time
    let blockTime = 0
    try {
      const block = await client.getBlock({ blockNumber: receipt.blockNumber })
      blockTime = Number(block.timestamp)
    } catch {
      // fall through — not worth retrying
    }

    const feeBnb =
      Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18

    ds.appendTransaction(context.ca, context.groupId, {
      txHash,
      txType: context.txType,
      walletAddress: context.walletAddress,
      tokenCA: context.ca,
      amountBnb: context.knownAmountBnb ?? 0,
      amountToken: 0,
      pricePerToken: 0,
      fee: feeBnb,
      blockNumber: Number(receipt.blockNumber),
      blockTime,
      status,
    })

    if (status === 'confirmed') {
      await refreshBalanceSnapshot(
        client,
        context.ca,
        context.groupId,
        context.walletAddress,
      ).catch(() => {})
      await refreshTokenPositionSnapshot(
        client,
        context.ca,
        context.groupId,
        context.walletAddress,
        context.txType,
        context.knownAmountBnb,
      ).catch(() => {})
      if (context.counterparty) {
        await refreshBalanceSnapshot(
          client,
          context.ca,
          context.groupId,
          context.counterparty,
        ).catch(() => {})
      }
    }

    return {
      txHash,
      status,
      blockNumber: Number(receipt.blockNumber),
      blockTime,
      fee: feeBnb,
    }
  } catch {
    return { txHash, status: 'timeout' }
  }
}

/**
 * Fire-and-forget variant. Does not block the caller and swallows all errors
 * so the CLI can exit immediately after returning the tx hash to the agent.
 */
export function trackInBackground(
  client: PublicClient,
  txHash: Hash,
  context: TrackContext,
  timeoutMs = 30_000,
  preReceipt?: { status: string; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint } | undefined,
): void {
  // Use unref'd setTimeout so the pending promise doesn't prevent Node.js exit.
  // The CLI can return tx hashes immediately; tracking happens if the process
  // stays alive long enough, but never blocks exit.
  const t = setTimeout(() => {
    trackTransaction(client, txHash, context, timeoutMs, preReceipt).catch(() => {})
  }, 0)
  if (typeof t.unref === 'function') t.unref()
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Read BNB balance for a wallet and PATCH the DataStore balances snapshot.
 *
 * Critical: we send `bnbBalance` only — the DataStore's patch semantics
 * preserve any existing `tokenBalance`. Overwriting tokenBalance to 0 would
 * destroy data written by previous trade tx tracking.
 */
async function refreshBalanceSnapshot(
  client: PublicClient,
  ca: Address,
  groupId: number,
  wallet: Address,
): Promise<void> {
  const bnbWei = await client.getBalance({ address: wallet })
  const bnb = Number(formatEther(bnbWei))
  const ds = getDataStore()
  ds.updateBalance(ca, groupId, wallet, { bnbBalance: bnb })
}

async function refreshTokenPositionSnapshot(
  client: PublicClient,
  ca: Address,
  groupId: number,
  wallet: Address,
  txType: TxType,
  knownAmountBnb?: number,
): Promise<void> {
  if (ca === NATIVE_BNB) return

  const [rawTokenBalance, decimalsRaw] = await Promise.all([
    client.readContract({
      address: ca,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet],
    }),
    client.readContract({
      address: ca,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
  ])

  const decimals = Number(decimalsRaw)
  const tokenBalance = Number(formatUnits(rawTokenBalance, decimals))

  const ds = getDataStore()
  ds.updateBalance(ca, groupId, wallet, { tokenBalance })

  const currentHolding =
    ds.getHoldings(ca, groupId)?.wallets.find(
      (row) => row.walletAddress === wallet,
    ) ?? null
  const previousTokenBalance = currentHolding?.tokenBalance ?? 0
  const patch: Partial<WalletHolding> = { tokenBalance }

  if (
    txType === 'buy' &&
    typeof knownAmountBnb === 'number' &&
    knownAmountBnb < 0 &&
    tokenBalance > previousTokenBalance
  ) {
    const amountBought = tokenBalance - previousTokenBalance
    const totalBought = (currentHolding?.totalBought ?? 0) + amountBought
    const totalCostBnb =
      (currentHolding?.totalCostBnb ?? 0) + Math.abs(knownAmountBnb)

    patch.totalBought = totalBought
    patch.totalCostBnb = totalCostBnb
    patch.avgBuyPrice = totalBought > 0 ? totalCostBnb / totalBought : 0
  }

  if (txType === 'sell' && previousTokenBalance > tokenBalance) {
    patch.totalSold =
      (currentHolding?.totalSold ?? 0) +
      (previousTokenBalance - tokenBalance)
  }

  ds.updateHolding(ca, groupId, wallet, patch)
}
