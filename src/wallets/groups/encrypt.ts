/**
 * AES encryption primitives for in-house wallet groups.
 *
 * We use crypto-js AES because:
 *   1. It's pure JS — no native binaries — so the build stays portable
 *   2. `CryptoJS.AES.encrypt(text, passphrase)` bakes salt + IV into the
 *      ciphertext output, so we don't have to manage those ourselves
 *
 * These in-house keys are short-lived sniper/volume wallets; the threat
 * model is "local disk + master password, encrypted at rest".
 *
 * Note: this format is NOT wire-compatible with ForgeX. The password-check
 * marker is "ALMM_PASSWORD_OK" (kept for backward compat; ForgeX used "FORGEX_PASSWORD_OK").
 */

import CryptoJS from 'crypto-js'

// Marker plaintext used to verify the master password without needing to
// decrypt an entire wallet's private key first.
const PASSWORD_CHECK_PLAINTEXT = 'ALMM_PASSWORD_OK'

/** Encrypt a value with AES using the master password */
export function encrypt(plaintext: string, password: string): string {
  if (!password) throw new Error('encrypt: password is empty')
  return CryptoJS.AES.encrypt(plaintext, password).toString()
}

/**
 * Decrypt an AES ciphertext with the master password.
 * Throws if decryption yields an empty string (wrong password or corrupt data).
 */
export function decrypt(ciphertext: string, password: string): string {
  if (!password) throw new Error('decrypt: password is empty')
  const bytes = CryptoJS.AES.decrypt(ciphertext, password)
  const result = bytes.toString(CryptoJS.enc.Utf8)
  if (!result) {
    throw new Error('decrypt: wrong password or corrupt data')
  }
  return result
}

/** Generate a password check string for vault verification */
export function generatePasswordCheck(password: string): string {
  return encrypt(PASSWORD_CHECK_PLAINTEXT, password)
}

/** Verify a password against a stored check string */
export function verifyPassword(password: string, check: string): boolean {
  try {
    return decrypt(check, password) === PASSWORD_CHECK_PLAINTEXT
  } catch {
    return false
  }
}
