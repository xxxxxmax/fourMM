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
import { formatEther } from 'viem'
import { getDataStore } from '../datastore/index.js'
import type { TxType } from '../datastore/types.js'

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
 */
export async function trackTransaction(
  client: PublicClient,
  txHash: Hash,
  context: TrackContext,
  timeoutMs = 90_000,
): Promise<TrackingResult> {
  try {
    const receipt = await client.waitForTransactionReceipt({
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
  timeoutMs = 90_000,
): void {
  trackTransaction(client, txHash, context, timeoutMs).catch(() => {
    /* never throw */
  })
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
