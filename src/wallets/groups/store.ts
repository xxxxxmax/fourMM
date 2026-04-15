/**
 * In-house wallet group store.
 *
 * Storage: ~/.fourmm/wallets/wallet-store.json (mode 0600), JSON-encoded.
 * Each wallet's privateKey is AES-encrypted with the master password.
 *
 * File shape:
 *   {
 *     encrypted: true,
 *     passwordCheck: "...",  // AES('ALMM_PASSWORD_OK', password)
 *     groups: {
 *       "1": { groupId, name, wallets: [...], note, createdAt, updatedAt },
 *       ...
 *     }
 *   }
 *
 * All public functions take the master password as an explicit first argument.
 * There is NO module-level password state: that makes testing easier, hides
 * fewer dependencies, and lets Week-2 code pass different passwords in the
 * same process (e.g. import + decrypt two different vaults).
 *
 * Write path is atomic (write .tmp, rename) to avoid half-written files.
 */

import fs from 'node:fs'
import path from 'node:path'
import { walletsDir, ensureFourmmDirs } from '../../lib/config.js'
import type { Address, Hex } from 'viem'
import {
  decrypt,
  encrypt,
  generatePasswordCheck,
  verifyPassword,
} from './encrypt.js'
import { generateWallets, walletFromPrivateKey } from './generate.js'

// ============================================================
// Types
// ============================================================

/** A single wallet inside a group */
export type StoredWallet = {
  /** EVM checksummed address */
  address: Address
  /** AES-encrypted hex private key (with 0x prefix before encryption) */
  encryptedPrivateKey: string
  /** Free-form note */
  note: string
}

/** A wallet group (collection of wallets under a shared name) */
export type WalletGroup = {
  /** Numeric group ID (auto-assigned) */
  groupId: number
  /** Group name */
  name: string
  /** Free-form description */
  note: string
  /** Wallets in this group */
  wallets: StoredWallet[]
  /** ISO 8601 timestamps */
  createdAt: string
  updatedAt: string
}

/** Root file format */
export type WalletStoreFile = {
  encrypted: true
  passwordCheck: string
  groups: Record<number, WalletGroup>
}

/** Group summary (what `list-groups` returns — no wallet contents) */
export type WalletGroupSummary = Omit<WalletGroup, 'wallets'> & {
  walletCount: number
}

// ============================================================
// Paths
// ============================================================

const STORE_FILE = 'wallet-store.json'

function storePath(): string {
  return path.join(walletsDir(), STORE_FILE)
}

// ============================================================
// Atomic file ops
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

// ============================================================
// Load / init
// ============================================================

/** Does a wallet store file already exist? */
export function storeExists(): boolean {
  return fs.existsSync(storePath())
}

/**
 * Load the wallet store.
 *
 * - Returns `null` if the store doesn't exist yet. Read-only callers
 *   (e.g. `list-groups`) should treat this as "no groups".
 * - Throws if the store exists but the password doesn't match.
 * - **Never writes to disk.** Callers that want to create a new store
 *   must call `initStore(password)` explicitly.
 */
export function loadStore(password: string): WalletStoreFile | null {
  if (!password) throw new Error('loadStore: password is empty')

  const file = storePath()
  if (!fs.existsSync(file)) return null

  let parsed: WalletStoreFile
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    parsed = JSON.parse(raw) as WalletStoreFile
  } catch {
    throw new Error(`Wallet store at ${file} is corrupt (not valid JSON)`)
  }

  if (!parsed.encrypted || !parsed.passwordCheck) {
    throw new Error(
      `Wallet store at ${file} is missing encrypted/passwordCheck fields`,
    )
  }

  if (!verifyPassword(password, parsed.passwordCheck)) {
    throw new Error('Wrong master password: unable to decrypt wallet store')
  }

  if (!parsed.groups) parsed.groups = {}
  return parsed
}

/**
 * Create a new empty wallet store, encrypted with the given password.
 *
 * Throws if a store file already exists. Callers should check `storeExists()`
 * or use `loadOrInitStore()` if they want idempotent creation.
 */
export function initStore(password: string): WalletStoreFile {
  if (!password) throw new Error('initStore: password is empty')

  ensureFourmmDirs()
  const file = storePath()
  if (fs.existsSync(file)) {
    throw new Error(
      `Wallet store at ${file} already exists. Refusing to overwrite.`,
    )
  }

  const store: WalletStoreFile = {
    encrypted: true,
    passwordCheck: generatePasswordCheck(password),
    groups: {},
  }
  atomicWriteJson(file, store)
  return store
}

/**
 * Convenience: load the store, or init an empty one if it doesn't exist.
 * Used by write operations (`createGroup`, etc.).
 */
export function loadOrInitStore(password: string): WalletStoreFile {
  return loadStore(password) ?? initStore(password)
}

/** Persist the wallet store atomically */
export function saveStore(store: WalletStoreFile): void {
  atomicWriteJson(storePath(), store)
}

// ============================================================
// Group operations
// ============================================================

/** List all groups (summary form). Returns empty array if no store. */
export function listGroups(password: string): WalletGroupSummary[] {
  const store = loadStore(password)
  if (!store) return []
  return Object.values(store.groups)
    .sort((a, b) => a.groupId - b.groupId)
    .map((g) => ({
      groupId: g.groupId,
      name: g.name,
      note: g.note,
      walletCount: g.wallets.length,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    }))
}

/** Get a single group by ID. Returns undefined if store or group missing. */
export function getGroup(
  password: string,
  groupId: number,
): WalletGroup | undefined {
  const store = loadStore(password)
  if (!store) return undefined
  return store.groups[groupId]
}

/**
 * Create a new wallet group with N freshly-generated wallets.
 * Private keys are encrypted at rest immediately.
 */
export function createGroup(
  password: string,
  options: {
    name: string
    count: number
    note?: string | undefined
  },
): WalletGroup {
  const store = loadOrInitStore(password)

  const nextId =
    Object.values(store.groups).reduce((max, g) => Math.max(max, g.groupId), 0) +
    1

  const fresh = generateWallets(options.count)
  const now = new Date().toISOString()

  const group: WalletGroup = {
    groupId: nextId,
    name: options.name,
    note: options.note ?? '',
    wallets: fresh.map((w) => ({
      address: w.address,
      encryptedPrivateKey: encrypt(w.privateKey, password),
      note: w.note,
    })),
    createdAt: now,
    updatedAt: now,
  }

  store.groups[nextId] = group
  saveStore(store)
  return group
}

/** Add newly-generated wallets to an existing group */
export function addGeneratedWallets(
  password: string,
  groupId: number,
  count: number,
): StoredWallet[] {
  const store = loadStore(password)
  if (!store) {
    throw new Error(
      `No wallet store found. Create a group first with \`fourmm wallet create-group\`.`,
    )
  }
  const group = store.groups[groupId]
  if (!group) throw new Error(`Group ${groupId} does not exist`)

  const fresh = generateWallets(count)
  const stored: StoredWallet[] = fresh.map((w) => ({
    address: w.address,
    encryptedPrivateKey: encrypt(w.privateKey, password),
    note: w.note,
  }))

  group.wallets.push(...stored)
  group.updatedAt = new Date().toISOString()
  saveStore(store)
  return stored
}

/** Add a wallet from an existing private key */
export function addWalletFromPrivateKey(
  password: string,
  groupId: number,
  privateKey: Hex,
  note = '',
): StoredWallet {
  const store = loadStore(password)
  if (!store) {
    throw new Error(
      `No wallet store found. Create a group first with \`fourmm wallet create-group\`.`,
    )
  }
  const group = store.groups[groupId]
  if (!group) throw new Error(`Group ${groupId} does not exist`)

  const w = walletFromPrivateKey(privateKey, note)

  // Dedupe by address
  if (group.wallets.some((existing) => existing.address === w.address)) {
    throw new Error(`Wallet ${w.address} already exists in group ${groupId}`)
  }

  const stored: StoredWallet = {
    address: w.address,
    encryptedPrivateKey: encrypt(privateKey, password),
    note: w.note,
  }

  group.wallets.push(stored)
  group.updatedAt = new Date().toISOString()
  saveStore(store)
  return stored
}

/** Delete an entire wallet group by ID. */
export function deleteGroup(password: string, groupId: number): void {
  const store = loadStore(password)
  if (!store) throw new Error('No wallet store found.')
  if (!store.groups[groupId]) throw new Error(`Group ${groupId} does not exist`)
  delete store.groups[groupId]
  saveStore(store)
}

/** Remove a single wallet from a group by address. */
export function removeWalletFromGroup(
  password: string,
  groupId: number,
  address: Address,
): void {
  const store = loadStore(password)
  if (!store) throw new Error('No wallet store found.')
  const group = store.groups[groupId]
  if (!group) throw new Error(`Group ${groupId} does not exist`)
  const before = group.wallets.length
  group.wallets = group.wallets.filter(
    (w) => w.address.toLowerCase() !== address.toLowerCase(),
  )
  if (group.wallets.length === before) {
    throw new Error(`Address ${address} not found in group ${groupId}`)
  }
  group.updatedAt = new Date().toISOString()
  saveStore(store)
}

/** Decrypt a wallet's private key (only for in-process signing — never log) */
export function decryptPrivateKey(stored: StoredWallet, password: string): Hex {
  const pk = decrypt(stored.encryptedPrivateKey, password)
  if (!pk.startsWith('0x')) {
    throw new Error(
      `Decrypted private key for ${stored.address} is malformed (missing 0x prefix)`,
    )
  }
  return pk as Hex
}
