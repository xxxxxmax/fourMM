/**
 * Treasury / OWS integration smoke test.
 *
 * Goal: catch signature-encoding bugs BEFORE we submit a real BSC tx.
 *
 * Flow:
 *   1. Create a fresh OWS wallet in a temp vault
 *   2. Build a viem LocalAccount via treasuryToViemAccount
 *   3. Sign a dummy EIP-1559 transaction
 *   4. Recover the signer from the serialized tx
 *   5. Assert recovered address == account address
 *
 * This exercises the full OWS → viem pipeline including our yParity /
 * signature parsing. A mismatch here would cause BSC to reject our first
 * real `trade buy` in Week 2.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseTransaction, recoverAddress, type Hex } from 'viem'
import {
  BSC_CHAIN_ID,
  createTreasuryWallet,
  getBscAddress,
  treasuryToViemAccount,
} from '../../src/wallets/treasury.js'

let tmpVault: string
let realVault: string | undefined
let realHome: string | undefined
let walletAddress: Hex
const walletName = 'smoke-test-treasury'
const passphrase = 'smoke-pass'

beforeEach(() => {
  // Redirect both OWS vault and HOME so nothing touches real state
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'almm-treasury-smoke-'))
  realVault = process.env.ALMM_VAULT_PATH
  realHome = process.env.HOME
  process.env.ALMM_VAULT_PATH = tmpVault
  process.env.HOME = tmpVault

  const wallet = createTreasuryWallet({
    name: walletName,
    passphrase,
    words: 12,
  })
  walletAddress = getBscAddress(wallet)
})

afterEach(() => {
  if (realVault === undefined) delete process.env.ALMM_VAULT_PATH
  else process.env.ALMM_VAULT_PATH = realVault
  process.env.HOME = realHome
  fs.rmSync(tmpVault, { recursive: true, force: true })
})

describe('treasuryToViemAccount — signature roundtrip', () => {
  it('returns an account whose address matches the wallet address', () => {
    const account = treasuryToViemAccount({
      wallet: walletName,
      passphrase,
      chainId: BSC_CHAIN_ID,
    })
    expect(account.address.toLowerCase()).toBe(walletAddress.toLowerCase())
  })

  it('signs a message and the signature is hex-encoded', async () => {
    const account = treasuryToViemAccount({
      wallet: walletName,
      passphrase,
    })
    const sig = await account.signMessage({ message: 'hello' })
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/)
  })

  it('produces deterministic message signatures', async () => {
    const account = treasuryToViemAccount({
      wallet: walletName,
      passphrase,
    })
    const a = await account.signMessage({ message: 'deterministic' })
    const b = await account.signMessage({ message: 'deterministic' })
    expect(a).toBe(b)
  })

  it('signs an EIP-1559 transaction and the recovered signer matches', async () => {
    const account = treasuryToViemAccount({
      wallet: walletName,
      passphrase,
      chainId: BSC_CHAIN_ID,
    })

    // Dummy BSC transaction (we're not sending it — just signing)
    const tx = {
      to: '0x0000000000000000000000000000000000000001' as const,
      value: 0n,
      chainId: 56,
      type: 'eip1559' as const,
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 5_000_000_000n, // 5 gwei
      maxPriorityFeePerGas: 1_000_000_000n, // 1 gwei
    }

    const serialized = await account.signTransaction(tx)
    expect(serialized).toMatch(/^0x02/) // EIP-1559 envelope byte

    const parsed = parseTransaction(serialized)
    expect(parsed.r).toBeDefined()
    expect(parsed.s).toBeDefined()
    // yParity is 0 or 1 for typed transactions
    expect(parsed.yParity === 0 || parsed.yParity === 1).toBe(true)

    // Recover the signer from the signed tx and compare to our address.
    // We reconstruct the sighash the same way viem does internally:
    // parseTransaction gives us the decoded fields; recoverTransactionAddress
    // would redo the work, but viem doesn't export that helper for typed tx
    // in all versions. Instead we use recoverAddress with the hash of the
    // unsigned serialization.
    const { serializeTransaction, keccak256 } = await import('viem')
    const unsignedSerialized = serializeTransaction(tx)
    const hash = keccak256(unsignedSerialized)

    const recovered = await recoverAddress({
      hash,
      signature: {
        r: parsed.r!,
        s: parsed.s!,
        yParity: parsed.yParity as 0 | 1,
      },
    })

    expect(recovered.toLowerCase()).toBe(walletAddress.toLowerCase())
  })

  it('signs EIP-712 typed data and returns a hex signature', async () => {
    const account = treasuryToViemAccount({
      wallet: walletName,
      passphrase,
    })
    const sig = await account.signTypedData({
      domain: {
        name: 'ALMM',
        version: '1',
        chainId: 56,
        verifyingContract: '0x0000000000000000000000000000000000000001',
      },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        Mail: [{ name: 'contents', type: 'string' }],
      },
      primaryType: 'Mail',
      message: { contents: 'Hello' },
    })
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/)
  })
})
