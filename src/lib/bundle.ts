/**
 * BSC bundle submission via BlockRazor / Flashbots-compatible API.
 *
 * Bundles multiple signed transactions into a single atomic submission.
 * All txs in a bundle execute in the same block, or none do.
 *
 * Requires an RPC that supports `eth_sendBundle` (e.g. BlockRazor).
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  serializeTransaction,
  parseEther,
} from 'viem'
import { type PrivateKeyAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'
import { loadConfig } from './config.js'

export type BundleTx = {
  /** Signed raw transaction hex */
  signedTx: Hex
}

export type BundleResult = {
  success: boolean
  bundleHash?: string | undefined
  error?: string | undefined
}

/**
 * Sign a transaction offline without broadcasting.
 * Returns the raw signed tx hex for bundle inclusion.
 */
export async function signRawTx(
  account: PrivateKeyAccount,
  params: {
    to: Address
    data: Hex
    value: bigint
    nonce: number
    gasLimit: bigint
    gasPrice: bigint
    chainId?: number
  },
): Promise<Hex> {
  const serialized = serializeTransaction(
    {
      to: params.to,
      data: params.data,
      value: params.value,
      nonce: params.nonce,
      gas: params.gasLimit,
      gasPrice: params.gasPrice,
      chainId: params.chainId ?? bsc.id,
      type: 'legacy' as const,
    },
  )
  const signature = await account.signTransaction({
    to: params.to,
    data: params.data,
    value: params.value,
    nonce: params.nonce,
    gas: params.gasLimit,
    gasPrice: params.gasPrice,
    chainId: params.chainId ?? bsc.id,
    type: 'legacy' as const,
  })
  return signature
}

/**
 * Submit a bundle of signed transactions to the RPC's eth_sendBundle endpoint.
 *
 * @param signedTxs  Array of signed raw tx hex strings
 * @param targetBlock  Target block number (bundle valid for this block only)
 * @param rpcUrl  RPC endpoint that supports eth_sendBundle (defaults to config.rpcUrl)
 */
export async function sendBundle(
  signedTxs: Hex[],
  targetBlock: bigint,
  rpcUrl?: string,
): Promise<BundleResult> {
  const config = loadConfig()
  const url = rpcUrl ?? config.rpcUrl

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendBundle',
      params: [{
        txs: signedTxs,
        blockNumber: `0x${targetBlock.toString(16)}`,
      }],
    }),
  })

  const json = (await res.json()) as {
    result?: { bundleHash?: string }
    error?: { code: number; message: string }
  }

  if (json.error) {
    return { success: false, error: json.error.message }
  }

  return {
    success: true,
    bundleHash: json.result?.bundleHash,
  }
}

/**
 * Convenience: sign multiple buy txs from different wallets and submit as bundle.
 */
export async function sendBundledBuys(
  client: PublicClient,
  accounts: PrivateKeyAccount[],
  params: {
    tokenManager: Address
    token: Address
    bnbPerWallet: bigint
    minAmounts: bigint[]
    buyFunctionData: Hex[]
  },
): Promise<BundleResult> {
  const gasPrice = await client.getGasPrice()
  const currentBlock = await client.getBlockNumber()
  const targetBlock = currentBlock + 2n // target 2 blocks ahead

  const signedTxs: Hex[] = []

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]!
    const nonce = await client.getTransactionCount({ address: account.address })

    const signed = await signRawTx(account, {
      to: params.tokenManager,
      data: params.buyFunctionData[i]!,
      value: params.bnbPerWallet,
      nonce,
      gasLimit: 300_000n,
      gasPrice,
    })
    signedTxs.push(signed)
  }

  return sendBundle(signedTxs, targetBlock)
}
