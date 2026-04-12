import { describe, expect, it } from 'vitest'
import {
  decrypt,
  encrypt,
  generatePasswordCheck,
  verifyPassword,
} from '../../../src/wallets/groups/encrypt.js'

describe('encrypt / decrypt roundtrip', () => {
  it('returns original plaintext on matching password', () => {
    const cipher = encrypt('0xdeadbeef', 'secret')
    expect(decrypt(cipher, 'secret')).toBe('0xdeadbeef')
  })

  it('handles arbitrary unicode strings', () => {
    const plain = '测试 payload 🌱 emoji'
    const cipher = encrypt(plain, 'pw')
    expect(decrypt(cipher, 'pw')).toBe(plain)
  })

  it('wrong password never returns the original plaintext', () => {
    // crypto-js AES with a wrong password is non-deterministic: sometimes
    // the decrypted bytes aren't valid UTF-8 (our decrypt wrapper throws),
    // sometimes they happen to be valid UTF-8 garbage. What we actually
    // care about is the safety property: wrong password MUST NOT return
    // the original plaintext. Production code uses verifyPassword (with
    // the ALMM_PASSWORD_OK marker) to catch wrong passwords before
    // decryption, so this is an additional safety net not the primary check.
    const cipher = encrypt('secret data', 'right')
    try {
      const result = decrypt(cipher, 'wrong')
      expect(result).not.toBe('secret data')
    } catch (err) {
      // Any error is fine — crypto-js itself can throw "Malformed UTF-8 data"
      // before our decrypt wrapper sees an empty string. The safety property
      // is that wrong password MUST NOT return the original plaintext, which
      // is the try branch above.
      expect(err).toBeInstanceOf(Error)
    }
  })

  it('throws on empty password input', () => {
    expect(() => encrypt('x', '')).toThrow()
    expect(() => decrypt('x', '')).toThrow()
  })

  it('produces different ciphertexts on each call (non-deterministic IV)', () => {
    const a = encrypt('same', 'pw')
    const b = encrypt('same', 'pw')
    expect(a).not.toBe(b)
    expect(decrypt(a, 'pw')).toBe('same')
    expect(decrypt(b, 'pw')).toBe('same')
  })
})

describe('password check marker', () => {
  it('verifies the same password', () => {
    const check = generatePasswordCheck('hunter2')
    expect(verifyPassword('hunter2', check)).toBe(true)
  })

  it('rejects a different password', () => {
    const check = generatePasswordCheck('hunter2')
    expect(verifyPassword('hunter3', check)).toBe(false)
  })

  it('rejects garbage check strings', () => {
    expect(verifyPassword('any', 'not-a-real-ciphertext')).toBe(false)
  })
})
