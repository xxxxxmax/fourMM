/**
 * Shared row types for commands that iterate over a wallet group.
 *
 * `transfer in / out`, Week-3's `tools volume / turnover`, and anything else
 * that "for each wallet in a group, do X with status" benefit from a common
 * shape so the output schemas stay uniform.
 */

import type { Hash } from 'viem'
import type { StoredWallet } from '../wallets/groups/store.js'

/**
 * Per-wallet planning result produced during the dry-run phase.
 * `insufficient` is distinct from `sendBnb === 0` so fixed-mode transfers can
 * tell the user "this wallet can't cover the fixed amount + gas".
 */
export type WalletRow = {
  wallet: StoredWallet
  balanceBnb: number
  sendBnb: number
  /** Explicit flag — true when fixed mode wanted more than the wallet holds */
  insufficient: boolean
}

/** Per-wallet execution result (after broadcast or simulation attempt) */
export type WalletResult = {
  from: string
  sendBnb: string
  status:
    | 'ready'
    | 'broadcast'
    | 'skipped'
    | 'nothing-to-send'
    | 'insufficient-funds'
    | 'decrypt-failed'
    | 'failed'
  txHash?: Hash | undefined
  error?: string | undefined
}
