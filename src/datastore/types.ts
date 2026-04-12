/**
 * DataStore type definitions.
 *
 * File formats for ~/.almm/data/. Each type corresponds to a JSON file on
 * disk. All timestamps are Unix milliseconds unless otherwise noted.
 */

import type { Address, Hash, Hex } from 'viem'

// ============================================================
// tokens/<CA>/token-info.json
// ============================================================

export type TokenVariant = 'standard' | 'anti-sniper-fee' | 'tax-token' | 'x-mode'

export type TokenInfoFile = {
  ca: Address
  symbol: string
  name: string
  decimals: number
  creatorAddress: Address | ''
  /** Four.meme internal version (1 or 2) */
  version: 1 | 2
  /** Variant detected from template / feeSetting */
  variant: TokenVariant
  /** Address of the TokenManager that owns this token (V1 or V2) */
  tokenManager: Address
  /** Quote token — 0x0000... for BNB, else BEP20 address */
  quote: Address
  /** Bonding curve top-pair or PancakeSwap LP after graduation */
  pairAddress: Address | ''
  /** Set once the bonding curve has graduated */
  liquidityAdded: boolean
  /** Last update (Unix ms) */
  updatedAt: number
}

// ============================================================
// tokens/<CA>/pool-info.json
// ============================================================

/** Trading path a token is currently on */
export type TradingPathKind = 'bonding-curve' | 'pancake'

export type PoolInfoFile = {
  ca: Address
  pairAddress: Address | ''
  /** Which trading path this data describes */
  path: TradingPathKind
  /** BNB-denominated price (float) */
  priceBnb: number
  /** USD price (may be 0 when BNB→USD oracle unavailable) */
  priceUsd: number
  /** Bonding curve progress 0..1 (null after graduation) */
  graduationProgress: number | null
  updatedAt: number
}

// ============================================================
// tokens/<CA>/groups/<groupId>/transactions.json
// ============================================================

export type TxType = 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'turnover'

export type TransactionRecord = {
  txHash: Hash
  txType: TxType
  /** Wallet that signed / was the primary subject */
  walletAddress: Address
  tokenCA: Address
  /** Signed BNB delta: positive for buy, negative for sell */
  amountBnb: number
  /** Signed token delta */
  amountToken: number
  /** Derived execution price (BNB per token) */
  pricePerToken: number
  /** Gas fee (BNB) */
  fee: number
  blockNumber: number
  /** Block timestamp (Unix seconds) */
  blockTime: number
  status: 'confirmed' | 'failed' | 'pending'
}

export type TransactionsFile = {
  ca: Address
  groupId: number
  transactions: TransactionRecord[]
  updatedAt: number
}

// ============================================================
// tokens/<CA>/groups/<groupId>/holdings.json
// ============================================================

export type WalletHolding = {
  walletAddress: Address
  tokenBalance: number
  avgBuyPrice: number
  totalBought: number
  totalSold: number
  totalCostBnb: number
  totalRevenueBnb: number
  realizedPnl: number
}

export type HoldingsFile = {
  ca: Address
  groupId: number
  wallets: WalletHolding[]
  updatedAt: number
}

// ============================================================
// tokens/<CA>/groups/<groupId>/balances.json
// ============================================================

export type WalletBalance = {
  walletAddress: Address
  bnbBalance: number
  tokenBalance: number
  updatedAt: number
}

export type BalancesFile = {
  ca: Address
  groupId: number
  balances: WalletBalance[]
  updatedAt: number
}

// ============================================================
// global/bnb-price.json
// ============================================================

export type BnbPriceFile = {
  priceUsd: number
  updatedAt: number
}

// ============================================================
// Opaque type helpers
// ============================================================

/** Hex-encoded raw transaction input data (kept for audit / replay) */
export type RawTxData = Hex
