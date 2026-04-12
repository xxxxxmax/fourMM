import { describe, expect, it } from 'vitest'
import { isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  generateWallets,
  walletFromPrivateKey,
} from '../../../src/wallets/groups/generate.js'

describe('generateWallets', () => {
  it('returns the requested number of wallets', () => {
    const ws = generateWallets(5)
    expect(ws).toHaveLength(5)
  })

  it('produces valid checksummed addresses', () => {
    const ws = generateWallets(3)
    for (const w of ws) {
      expect(isAddress(w.address)).toBe(true)
      expect(w.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })

  it('private keys round-trip back to the same address via viem', () => {
    const ws = generateWallets(4)
    for (const w of ws) {
      const recovered = privateKeyToAccount(w.privateKey)
      expect(recovered.address).toBe(w.address)
    }
  })

  it('produces unique wallets on each call', () => {
    const a = generateWallets(10)
    const b = generateWallets(10)
    const set = new Set([...a, ...b].map((w) => w.address))
    expect(set.size).toBe(20)
  })

  it('rejects non-positive counts', () => {
    expect(() => generateWallets(0)).toThrow()
    expect(() => generateWallets(-1)).toThrow()
    expect(() => generateWallets(1.5)).toThrow()
  })
})

describe('walletFromPrivateKey', () => {
  it('recovers the address from a raw private key', () => {
    const pk = generateWallets(1)[0]!.privateKey
    const recovered = walletFromPrivateKey(pk, 'my wallet')
    expect(recovered.privateKey).toBe(pk)
    expect(isAddress(recovered.address)).toBe(true)
    expect(recovered.note).toBe('my wallet')
  })
})
