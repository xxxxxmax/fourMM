/**
 * OWS treasury adapter.
 *
 * Wraps @open-wallet-standard/core's NAPI bindings into:
 *  - Convenience creators for ALMM-specific wallets / policies / API keys
 *  - A viem Account factory that routes all signing operations through OWS,
 *    so `walletClient.writeContract({ account, ... })` transparently goes
 *    through the OWS policy engine.
 *
 * We deliberately do NOT expose raw private keys from this module. All signing
 * goes through OWS, and OWS decides (via its policy engine) whether to sign.
 */

import {
  createWallet as owsCreateWallet,
  createPolicy as owsCreatePolicy,
  createApiKey as owsCreateApiKey,
  getWallet as owsGetWallet,
  listWallets as owsListWallets,
  signMessage as owsSignMessage,
  signTransaction as owsSignTransaction,
  signTypedData as owsSignTypedData,
  type WalletInfo,
  type ApiKeyResult,
} from '@open-wallet-standard/core'
import { serializeTransaction, toHex, type Address, type Hex } from 'viem'
import { toAccount, type LocalAccount } from 'viem/accounts'

/**
 * Resolve the OWS vault path.
 * Defaults to undefined (OWS uses ~/.ows/). Override via ALMM_VAULT_PATH env
 * var for testing or isolated multi-env setups.
 */
function vaultPath(): string | undefined {
  return process.env.ALMM_VAULT_PATH || undefined
}

// ============================================================
// Constants
// ============================================================

/** CAIP-2 identifier OWS expects for BSC */
export const BSC_CHAIN_ID = 'eip155:56' as const

/** CAIP-2 for BSC testnet */
export const BSC_TESTNET_CHAIN_ID = 'eip155:97' as const

// ============================================================
// Types
// ============================================================

export type TreasuryWalletOptions = {
  /** Wallet name (ALMM convention: "treasury") */
  name: string
  /** Encryption passphrase (optional; if omitted, OWS asks interactively when signing) */
  passphrase?: string | undefined
  /** Number of BIP-39 words (12 or 24) */
  words?: 12 | 24 | undefined
}

export type TreasuryPolicyOptions = {
  /** Policy identifier (ALMM convention: "almm-bsc-only") */
  id: string
  /** Human-readable name */
  name: string
  /** Allowed chain IDs (defaults to ["eip155:56"] for BSC) */
  allowedChains?: string[] | undefined
  /** ISO 8601 expiry timestamp */
  expiresAt?: string | undefined
}

export type TreasuryApiKeyOptions = {
  /** Key name */
  name: string
  /** Wallet IDs or names this key can access */
  walletIds: string[]
  /** Policy IDs attached to this key */
  policyIds: string[]
  /** Vault passphrase needed to re-encrypt secrets for the key */
  passphrase: string
  /** ISO 8601 expiry timestamp */
  expiresAt?: string | undefined
}

// ============================================================
// Wallet management
// ============================================================

/**
 * Create a new OWS wallet for ALMM treasury use.
 * Derives addresses for every OWS-supported chain; we only use the BSC one.
 */
export function createTreasuryWallet(options: TreasuryWalletOptions): WalletInfo {
  return owsCreateWallet(
    options.name,
    options.passphrase,
    options.words ?? 12,
    vaultPath(),
  )
}

/** List all wallets in the OWS vault */
export function listTreasuryWallets(): WalletInfo[] {
  return owsListWallets(vaultPath())
}

/**
 * Extract the EVM address usable for BSC signing.
 *
 * OWS convention: a wallet stores ONE secp256k1 EVM account (derivation path
 * `m/44'/60'/0'/0/0`) labeled `eip155:1`. The same keypair is usable for all
 * EVM chains — ETH, BSC, Base, Polygon, etc. — because they share both the
 * curve and the derivation path. OWS takes the target chain ID as an
 * argument at signing time, not at derivation time.
 *
 * So we look for the *exact* BSC label first (future-proofing in case OWS
 * ever derives per-chain) and fall back to any eip155 account (today's
 * reality). We throw only if no EVM account exists at all.
 */
export function getBscAddress(wallet: WalletInfo): Address {
  const exact = wallet.accounts.find((a) => a.chainId === BSC_CHAIN_ID)
  if (exact) return exact.address as Address

  const anyEvm = wallet.accounts.find((a) => a.chainId.startsWith('eip155:'))
  if (anyEvm) return anyEvm.address as Address

  const found = wallet.accounts.map((a) => a.chainId).join(', ')
  throw new Error(
    `Wallet "${wallet.name}" has no EVM account. Found chains: ${found}. ` +
      `OWS should derive EVM accounts automatically — try recreating the wallet.`,
  )
}

// ============================================================
// Policy + API key management
// ============================================================

/**
 * Register a policy with OWS.
 *
 * ALMM's default policy is "BSC-only, expires in 24h, deny otherwise".
 * This lets an agent API key sign only BSC transactions, for a limited window.
 */
export function createTreasuryPolicy(options: TreasuryPolicyOptions): void {
  const allowed = options.allowedChains ?? [BSC_CHAIN_ID]

  const policy: {
    id: string
    name: string
    version: number
    created_at: string
    rules: Array<Record<string, unknown>>
    action: 'deny'
  } = {
    id: options.id,
    name: options.name,
    version: 1,
    created_at: new Date().toISOString(),
    rules: [{ type: 'allowed_chains', chain_ids: allowed }],
    action: 'deny',
  }

  if (options.expiresAt) {
    policy.rules.push({ type: 'expires_at', timestamp: options.expiresAt })
  }

  owsCreatePolicy(JSON.stringify(policy), vaultPath())
}

/** Create an API key that an agent can use to sign via OWS */
export function createTreasuryApiKey(
  options: TreasuryApiKeyOptions,
): ApiKeyResult {
  return owsCreateApiKey(
    options.name,
    options.walletIds,
    options.policyIds,
    options.passphrase,
    options.expiresAt,
    vaultPath(),
  )
}

// ============================================================
// viem account adapter
// ============================================================

export type TreasuryViemOptions = {
  /** Wallet name or ID */
  wallet: string
  /** Decryption passphrase or OWS API key (`ows_key_...`) */
  passphrase?: string | undefined
  /** CAIP chain ID (defaults to BSC mainnet) */
  chainId?: string | undefined
}

/**
 * Build a viem LocalAccount backed by OWS signing.
 *
 * Every `signMessage` / `signTransaction` / `signTypedData` call goes through
 * the OWS binary (and its policy engine) — no raw keys ever enter this process.
 *
 * The returned account is a standard viem Account and can be handed to
 * `createWalletClient({ account, ... })` for `writeContract` usage.
 */
export function treasuryToViemAccount(
  options: TreasuryViemOptions,
): LocalAccount {
  const { wallet, passphrase } = options
  const chainId = options.chainId ?? BSC_CHAIN_ID

  const vault = vaultPath()
  const walletInfo = owsGetWallet(wallet, vault)
  const address = getBscAddress(walletInfo)

  return toAccount({
    address,

    async signMessage({ message }) {
      // viem's SignableMessage is either a string or { raw: Hex | ByteArray }
      const { payload, encoding } =
        typeof message === 'string'
          ? { payload: message, encoding: 'utf8' as const }
          : {
              payload:
                typeof message.raw === 'string'
                  ? stripHexPrefix(message.raw)
                  : toHex(message.raw).slice(2),
              encoding: 'hex' as const,
            }

      const result = owsSignMessage(
        wallet,
        chainId,
        payload,
        passphrase,
        encoding,
        0,
        vault,
      )
      return ensureHex(result.signature)
    },

    async signTransaction(transaction) {
      // Serialize without signature to get the pre-image for OWS
      const serialized = serializeTransaction(transaction)
      const txHex = stripHexPrefix(serialized)

      const result = owsSignTransaction(
        wallet,
        chainId,
        txHex,
        passphrase,
        0,
        vault,
      )
      const sig = stripHexPrefix(result.signature)

      // secp256k1 signatures come back as r(64) + s(64) + v(2) = 130 hex chars
      const r = `0x${sig.slice(0, 64)}` as Hex
      const s = `0x${sig.slice(64, 128)}` as Hex
      const yParity = resolveYParity(sig, result.recoveryId)

      return serializeTransaction(transaction, { r, s, yParity })
    },

    async signTypedData(typedData) {
      const result = owsSignTypedData(
        wallet,
        chainId,
        JSON.stringify(typedData),
        passphrase,
        0,
        vault,
      )
      return ensureHex(result.signature)
    },
  })
}

// ============================================================
// Helpers
// ============================================================

function stripHexPrefix(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value
}

function ensureHex(value: string): Hex {
  return (value.startsWith('0x') ? value : `0x${value}`) as Hex
}

function resolveYParity(sig: string, recoveryId: number | undefined): 0 | 1 {
  if (recoveryId !== undefined) {
    // EVM y-parity is 0 or 1; legacy recoveryId may come as 27/28
    const normalized = recoveryId >= 27 ? recoveryId - 27 : recoveryId
    return (normalized & 1) as 0 | 1
  }
  // Fallback: parse trailing v byte
  const v = Number.parseInt(sig.slice(128, 130), 16)
  if (Number.isNaN(v)) return 0
  return ((v >= 27 ? v - 27 : v) & 1) as 0 | 1
}
