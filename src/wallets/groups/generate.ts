/**
 * In-house wallet generation (batch private keys for sniper / volume groups).
 *
 * We use viem's generatePrivateKey — cryptographically secure random secp256k1 keys.
 * No HD derivation here: each wallet is independent, no shared seed.
 * That's intentional for sniper groups — if one key leaks, the blast radius
 * is bounded to that single wallet.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'

export type GeneratedWallet = {
  address: Address
  privateKey: Hex
  note: string
}

/** Generate N fresh wallets */
export function generateWallets(count: number, notePrefix = ''): GeneratedWallet[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`generateWallets: count must be a positive integer, got ${count}`)
  }
  const wallets: GeneratedWallet[] = []
  for (let i = 0; i < count; i++) {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    wallets.push({
      address: account.address,
      privateKey: pk,
      note: notePrefix ? `${notePrefix} #${i + 1}` : '',
    })
  }
  return wallets
}

/** Import a wallet from an existing private key */
export function walletFromPrivateKey(
  privateKey: Hex,
  note = '',
): GeneratedWallet {
  const account = privateKeyToAccount(privateKey)
  return {
    address: account.address,
    privateKey,
    note,
  }
}
