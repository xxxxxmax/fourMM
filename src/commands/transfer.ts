/**
 * `almm transfer` command group — fund flow between treasury and wallet groups.
 *
 * Week 2 scope: `transfer out` and `transfer in`.
 *
 * Signing routes:
 *   --from treasury              → OWS (policy-gated) signing
 *   --from <in-house address>    → in-house wallet store signing
 *                                  (address must live in some wallet group)
 *
 * For Week 2 `trade buy`, dry-run is the only live path. `transfer` commands
 * do broadcast real BSC txs because (a) they're small, (b) they don't touch
 * the Router (not yet deployed) so there's no Week-3 dependency.
 */

import { Cli, z } from 'incur'
import {
  createWalletClient,
  fallback,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc, bscTestnet } from 'viem/chains'
import { loadConfig, type CliConfig } from '../lib/config.js'
import { NATIVE_BNB } from '../lib/const.js'
import { resolveAlmmPassword, resolveOwsPassphrase } from '../lib/env.js'
import { trackInBackground } from '../lib/tracker.js'
import { getPublicClient } from '../lib/viem.js'
import type { WalletRow, WalletResult } from '../lib/wallet-rows.js'
import {
  decryptPrivateKey,
  getGroup,
  listGroups,
  type WalletGroup,
} from '../wallets/groups/store.js'
import {
  BSC_CHAIN_ID,
  treasuryToViemAccount,
} from '../wallets/treasury.js'

// ============================================================
// Helpers
// ============================================================

/**
 * Build a viem WalletClient for the given account + pre-loaded config.
 *
 * We take the config as a parameter (rather than calling `loadConfig()`
 * internally) to avoid re-reading ~/.almm/config.json on every call.
 * The signer identity changes per wallet so we rebuild the client each
 * time, but the RPC list is stable within a command invocation.
 */
function walletClientFor(
  account: ReturnType<typeof privateKeyToAccount>,
  config: CliConfig,
): WalletClient {
  const chain = config.network === 'bsc-testnet' ? bscTestnet : bsc
  const transports = [config.rpcUrl, ...config.fallbackRpcUrls]
    .filter((url): url is string => Boolean(url))
    .map((url) => http(url, { timeout: 15_000 }))
  return createWalletClient({
    account,
    chain,
    transport: fallback(transports, { rank: false }),
  })
}

/** Apply a safety buffer to a gas price so insufficient-funds checks don't strand mid-batch */
function bufferedGasPrice(raw: bigint): bigint {
  // +50% over the spot price.
  return (raw * 150n) / 100n
}

/** Find the in-house group that contains the given from address */
function findGroupForAddress(
  password: string,
  fromAddress: Address,
): { group: WalletGroup; walletIndex: number } | null {
  const groups = listGroups(password)
  for (const summary of groups) {
    const group = getGroup(password, summary.groupId)
    if (!group) continue
    const idx = group.wallets.findIndex(
      (w) => w.address.toLowerCase() === fromAddress.toLowerCase(),
    )
    if (idx >= 0) return { group, walletIndex: idx }
  }
  return null
}

// ============================================================
// Sub-command: transfer out (treasury / wallet → group)
// ============================================================

export const transfer = Cli.create('transfer', {
  description: 'Fund flow: treasury ↔ wallet groups and group ↔ group',
})
  .command('out', {
    description:
      'Distribute BNB from a source wallet to every wallet in a target group.',
    options: z.object({
      from: z
        .string()
        .describe('Source wallet: "treasury" (OWS) or an in-house wallet address'),
      toGroup: z
        .coerce.number()
        .int()
        .positive()
        .describe('Target in-house wallet group ID'),
      value: z
        .coerce.number()
        .positive()
        .describe('BNB amount to send to EACH wallet in the target group'),
      password: z
        .string()
        .optional()
        .describe('In-house master password (or ALMM_PASSWORD env)'),
      owsPassphrase: z
        .string()
        .optional()
        .describe('OWS vault passphrase / ows_key_... (or OWS_PASSPHRASE env)'),
      dryRun: z
        .boolean()
        .default(false)
        .describe('Estimate gas + total cost without broadcasting'),
    }),
    examples: [
      {
        options: { from: 'treasury', toGroup: 1, value: 0.1, dryRun: true },
        description: 'Dry-run: send 0.1 BNB to every wallet in group 1',
      },
      {
        options: { from: 'treasury', toGroup: 1, value: 0.05 },
        description: 'Live: distribute 0.05 BNB to every wallet in group 1',
      },
    ],
    output: z.object({
      from: z.string(),
      toGroup: z.number(),
      perWallet: z.string(),
      count: z.number(),
      totalBnb: z.string(),
      estimatedFeeBnb: z.string(),
      dryRun: z.boolean(),
      results: z.array(
        z.object({
          to: z.string(),
          status: z.string(),
          txHash: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
    async run(c) {
      // Load config once; pass through to walletClientFor and the treasury
      // branch so we don't re-read ~/.almm/config.json multiple times.
      const config = loadConfig()
      const publicClient = getPublicClient()

      // ---- Resolve master passwords ----
      const almmPassword = resolveAlmmPassword(c.options.password)
      if (!almmPassword) {
        return c.error({
          code: 'NO_PASSWORD',
          message: 'ALMM master password required (--password or ALMM_PASSWORD env)',
        })
      }

      // ---- Resolve target group ----
      const targetGroup = getGroup(almmPassword, c.options.toGroup)
      if (!targetGroup) {
        return c.error({
          code: 'GROUP_NOT_FOUND',
          message: `Target group ${c.options.toGroup} does not exist`,
        })
      }
      if (targetGroup.wallets.length === 0) {
        return c.error({
          code: 'EMPTY_GROUP',
          message: `Target group ${c.options.toGroup} has no wallets`,
        })
      }

      // ---- Resolve signer ----
      const isTreasury = c.options.from.toLowerCase() === 'treasury'
      let signerAddress: Address
      let walletClient: WalletClient

      if (isTreasury) {
        const owsPassphrase = resolveOwsPassphrase(c.options.owsPassphrase)
        if (!owsPassphrase) {
          return c.error({
            code: 'NO_OWS_PASSPHRASE',
            message:
              'Treasury signing requires OWS passphrase (--ows-passphrase or OWS_PASSPHRASE env)',
          })
        }
        try {
          const account = treasuryToViemAccount({
            wallet: config.treasuryWallet,
            passphrase: owsPassphrase,
            chainId: BSC_CHAIN_ID,
          })
          signerAddress = account.address
          const chain = config.network === 'bsc-testnet' ? bscTestnet : bsc
          const transports = [config.rpcUrl, ...config.fallbackRpcUrls]
            .filter((url): url is string => Boolean(url))
            .map((url) => http(url, { timeout: 15_000 }))
          walletClient = createWalletClient({
            account,
            chain,
            transport: fallback(transports, { rank: false }),
          })
        } catch (err) {
          return c.error({
            code: 'TREASURY_ADAPTER_FAILED',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        if (!isAddress(c.options.from)) {
          return c.error({
            code: 'INVALID_ADDRESS',
            message: `"${c.options.from}" is not "treasury" nor a valid address`,
          })
        }
        const fromAddress = getAddress(c.options.from) as Address
        const match = findGroupForAddress(almmPassword, fromAddress)
        if (!match) {
          return c.error({
            code: 'FROM_NOT_FOUND',
            message: `Address ${fromAddress} is not in any in-house wallet group`,
          })
        }
        const stored = match.group.wallets[match.walletIndex]!
        let privateKey
        try {
          privateKey = decryptPrivateKey(stored, almmPassword)
        } catch (err) {
          return c.error({
            code: 'DECRYPT_FAILED',
            message: err instanceof Error ? err.message : String(err),
          })
        }
        const account = privateKeyToAccount(privateKey)
        signerAddress = account.address
        walletClient = walletClientFor(account, config)
      }

      // ---- Pre-flight checks: sender balance, estimated cost ----
      const perWalletWei = parseEther(c.options.value.toString())
      const targets = targetGroup.wallets.map((w) => w.address)
      const totalNeededBnb = c.options.value * targets.length

      let senderBalanceBnb = 0
      try {
        const balWei = await publicClient.getBalance({ address: signerAddress })
        senderBalanceBnb = Number(formatEther(balWei))
      } catch (err) {
        return c.error({
          code: 'RPC_READ_FAILED',
          message: err instanceof Error ? err.message : 'getBalance failed',
        })
      }

      // Estimate gas once; BNB-to-EOA transfers are always 21000. We apply a
      // +50% buffer on gas price so the sufficient-funds check doesn't
      // strand half the batch if gas spikes between here and broadcast.
      const gasEstimate = 21_000n
      const gasPriceRaw = await publicClient
        .getGasPrice()
        .catch(() => 3_000_000_000n)
      const gasPrice = bufferedGasPrice(gasPriceRaw)
      const feePerTxBnb = Number(gasEstimate * gasPrice) / 1e18
      const estimatedFeeTotalBnb = feePerTxBnb * targets.length

      const sufficient =
        senderBalanceBnb >= totalNeededBnb + estimatedFeeTotalBnb

      // ---- Dry run ----
      if (c.options.dryRun) {
        return c.ok(
          {
            from: signerAddress,
            toGroup: c.options.toGroup,
            perWallet: `${c.options.value} BNB`,
            count: targets.length,
            totalBnb: `${totalNeededBnb} BNB`,
            estimatedFeeBnb: `${estimatedFeeTotalBnb.toFixed(6)} BNB`,
            dryRun: true,
            results: targets.map((to) => ({
              to,
              status: sufficient ? 'ready' : 'insufficient-funds',
            })),
          },
          {
            cta: sufficient
              ? {
                  commands: [
                    {
                      command: 'transfer out',
                      options: {
                        from: c.options.from,
                        toGroup: c.options.toGroup,
                        value: c.options.value,
                      },
                      description: 'Execute the transfer for real',
                    },
                  ],
                }
              : {
                  commands: [
                    {
                      command: 'query balance',
                      options: { address: signerAddress },
                      description: 'Check sender balance',
                    },
                  ],
                },
          },
        )
      }

      // ---- Live broadcast ----
      if (!sufficient) {
        return c.error({
          code: 'INSUFFICIENT_FUNDS',
          message: `Sender ${signerAddress} has ${senderBalanceBnb.toFixed(6)} BNB; needs ≈${(totalNeededBnb + estimatedFeeTotalBnb).toFixed(6)} BNB`,
        })
      }

      const results: Array<{
        to: string
        status: string
        txHash?: string
        error?: string
      }> = []

      for (const to of targets) {
        try {
          const hash = (await walletClient.sendTransaction({
            account: walletClient.account!,
            chain: walletClient.chain!,
            to,
            value: perWalletWei,
          })) as Hash

          trackInBackground(publicClient, hash, {
            // Native BNB transfers are keyed under NATIVE_BNB so they don't
            // pollute tokens/<wallet-address>/ directories. See const.ts.
            ca: NATIVE_BNB,
            groupId: c.options.toGroup,
            walletAddress: signerAddress,
            txType: 'transfer_out',
            knownAmountBnb: -c.options.value,
            counterparty: to,
          })

          results.push({ to, status: 'broadcast', txHash: hash })
        } catch (err) {
          results.push({
            to,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      const successCount = results.filter((r) => r.status === 'broadcast').length

      return c.ok(
        {
          from: signerAddress,
          toGroup: c.options.toGroup,
          perWallet: `${c.options.value} BNB`,
          count: targets.length,
          totalBnb: `${totalNeededBnb} BNB`,
          estimatedFeeBnb: `${estimatedFeeTotalBnb.toFixed(6)} BNB`,
          dryRun: false,
          results,
        },
        {
          cta: {
            commands: [
              {
                command: 'query balance',
                options: { address: targets[0]! },
                description: 'Verify one of the recipients',
              },
              {
                command: 'wallet group-info',
                options: { id: c.options.toGroup },
                description: `${successCount} / ${targets.length} broadcast succeeded`,
              },
            ],
          },
        },
      )
    },
  })

  // ============================================================
  // Sub-command: transfer in (group wallets → single destination)
  // ============================================================
  .command('in', {
    description:
      'Collect BNB from every wallet in a source group into a single destination. Supports amount modes: all / reserve / fixed.',
    options: z.object({
      to: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, 'Expected a 40-hex-char 0x-prefixed address')
        .describe('Destination address (often the treasury address)'),
      fromGroup: z
        .coerce.number()
        .int()
        .positive()
        .describe('Source wallet group ID'),
      amount: z
        .enum(['all', 'reserve', 'fixed'])
        .default('all')
        .describe(
          'all = send (balance - gas - tiny buffer); ' +
            'reserve = keep --value BNB, send rest; ' +
            'fixed = send exactly --value BNB from each wallet',
        ),
      value: z
        .coerce.number()
        .min(0)
        .optional()
        .describe('Amount in BNB (required for reserve/fixed modes)'),
      password: z
        .string()
        .optional()
        .describe('In-house master password (or ALMM_PASSWORD env)'),
      dryRun: z
        .boolean()
        .default(false)
        .describe('Compute amounts + gas estimates without broadcasting'),
    }),
    examples: [
      {
        options: { to: '0xabcd...', fromGroup: 1, amount: 'all', dryRun: true },
        description: 'Dry-run: drain every wallet in group 1 (minus gas)',
      },
      {
        options: { to: '0xabcd...', fromGroup: 1, amount: 'reserve', value: 0.002 },
        description: 'Collect everything but leave 0.002 BNB per wallet',
      },
      {
        options: { to: '0xabcd...', fromGroup: 1, amount: 'fixed', value: 0.05 },
        description: 'Pull exactly 0.05 BNB from each wallet',
      },
    ],
    output: z.object({
      to: z.string(),
      fromGroup: z.number(),
      mode: z.string(),
      count: z.number(),
      totalBnb: z.string(),
      estimatedFeeBnb: z.string(),
      dryRun: z.boolean(),
      results: z.array(
        z.object({
          from: z.string(),
          sendBnb: z.string(),
          status: z.string(),
          txHash: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
    async run(c) {
      const config = loadConfig()
      const publicClient = getPublicClient()

      // ---- Validate inputs ----
      if (c.options.amount !== 'all' && c.options.value === undefined) {
        return c.error({
          code: 'VALUE_REQUIRED',
          message: `amount=${c.options.amount} requires --value`,
        })
      }

      const toAddress = getAddress(c.options.to) as Address

      const almmPassword = resolveAlmmPassword(c.options.password)
      if (!almmPassword) {
        return c.error({
          code: 'NO_PASSWORD',
          message:
            'ALMM master password required (--password or ALMM_PASSWORD env)',
        })
      }

      // ---- Load source group ----
      const group = getGroup(almmPassword, c.options.fromGroup)
      if (!group) {
        return c.error({
          code: 'GROUP_NOT_FOUND',
          message: `Source group ${c.options.fromGroup} does not exist`,
        })
      }
      if (group.wallets.length === 0) {
        return c.error({
          code: 'EMPTY_GROUP',
          message: `Source group ${c.options.fromGroup} has no wallets`,
        })
      }

      // ---- Gas prep (with buffer — see bufferedGasPrice comment above) ----
      const gasEstimate = 21_000n
      const gasPriceRaw = await publicClient
        .getGasPrice()
        .catch(() => 3_000_000_000n)
      const gasPrice = bufferedGasPrice(gasPriceRaw)
      const feePerTxBnb = Number(gasEstimate * gasPrice) / 1e18
      // Leave a tiny buffer for future gas fluctuations when in "all" mode
      const bufferBnb = feePerTxBnb * 2

      // ---- Per-wallet amount + balance read ----
      // Using the shared WalletRow type so Week-3 tools/volume can reuse
      // the same dry-run planning shape.
      const rows: WalletRow[] = []

      for (const w of group.wallets) {
        let balanceBnb = 0
        try {
          const wei = await publicClient.getBalance({ address: w.address })
          balanceBnb = Number(formatEther(wei))
        } catch {
          balanceBnb = 0
        }

        let sendBnb = 0
        let insufficient = false
        if (c.options.amount === 'all') {
          sendBnb = Math.max(0, balanceBnb - bufferBnb - feePerTxBnb)
        } else if (c.options.amount === 'reserve') {
          const reserve = c.options.value!
          sendBnb = Math.max(0, balanceBnb - reserve - feePerTxBnb)
        } else {
          // fixed: need value + gas; mark row as insufficient if wallet
          // can't cover both, so dry-run shows the problem before broadcast.
          const required = c.options.value! + feePerTxBnb
          if (balanceBnb < required) {
            insufficient = true
            sendBnb = 0
          } else {
            sendBnb = c.options.value!
          }
        }
        rows.push({ wallet: w, balanceBnb, sendBnb, insufficient })
      }

      const totalBnb = rows.reduce((sum, r) => sum + r.sendBnb, 0)
      const estimatedFeeTotalBnb = feePerTxBnb * rows.length

      // ---- Dry-run ----
      if (c.options.dryRun) {
        return c.ok(
          {
            to: toAddress,
            fromGroup: c.options.fromGroup,
            mode: c.options.amount,
            count: rows.length,
            totalBnb: `${totalBnb.toFixed(6)} BNB`,
            estimatedFeeBnb: `${estimatedFeeTotalBnb.toFixed(6)} BNB`,
            dryRun: true,
            results: rows.map((r) => ({
              from: r.wallet.address,
              sendBnb: `${r.sendBnb.toFixed(6)} BNB`,
              status: r.insufficient
                ? 'insufficient-funds'
                : r.sendBnb > 0
                  ? 'ready'
                  : 'nothing-to-send',
            })),
          },
          {
            cta: {
              commands: [
                {
                  command: 'transfer in',
                  options: {
                    to: toAddress,
                    fromGroup: c.options.fromGroup,
                    amount: c.options.amount,
                    ...(c.options.value !== undefined
                      ? { value: c.options.value }
                      : {}),
                  },
                  description: 'Run the collection for real',
                },
              ],
            },
          },
        )
      }

      // ---- Live ----
      const results: Array<{
        from: string
        sendBnb: string
        status: string
        txHash?: string
        error?: string
      }> = []

      for (const row of rows) {
        if (row.insufficient) {
          results.push({
            from: row.wallet.address,
            sendBnb: '0 BNB',
            status: 'insufficient-funds',
          })
          continue
        }
        if (row.sendBnb <= 0) {
          results.push({
            from: row.wallet.address,
            sendBnb: '0 BNB',
            status: 'skipped',
          })
          continue
        }

        let privateKey
        try {
          privateKey = decryptPrivateKey(row.wallet, almmPassword)
        } catch (err) {
          results.push({
            from: row.wallet.address,
            sendBnb: `${row.sendBnb.toFixed(6)} BNB`,
            status: 'decrypt-failed',
            error: err instanceof Error ? err.message : String(err),
          })
          continue
        }

        const account = privateKeyToAccount(privateKey)
        const walletClient = walletClientFor(account, config)

        try {
          const hash = (await walletClient.sendTransaction({
            account,
            chain: walletClient.chain!,
            to: toAddress,
            value: parseEther(row.sendBnb.toFixed(18)),
          })) as Hash

          trackInBackground(publicClient, hash, {
            ca: NATIVE_BNB,
            groupId: c.options.fromGroup,
            walletAddress: account.address,
            txType: 'transfer_in',
            knownAmountBnb: -row.sendBnb,
            counterparty: toAddress,
          })

          results.push({
            from: row.wallet.address,
            sendBnb: `${row.sendBnb.toFixed(6)} BNB`,
            status: 'broadcast',
            txHash: hash,
          })
        } catch (err) {
          results.push({
            from: row.wallet.address,
            sendBnb: `${row.sendBnb.toFixed(6)} BNB`,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      return c.ok(
        {
          to: toAddress,
          fromGroup: c.options.fromGroup,
          mode: c.options.amount,
          count: rows.length,
          totalBnb: `${totalBnb.toFixed(6)} BNB`,
          estimatedFeeBnb: `${estimatedFeeTotalBnb.toFixed(6)} BNB`,
          dryRun: false,
          results,
        },
        {
          cta: {
            commands: [
              {
                command: 'query balance',
                options: { address: toAddress },
                description: 'Verify the destination received funds',
              },
            ],
          },
        },
      )
    },
  })

  // ============================================================
  // Sub-command: transfer many-to-many (group → group, paired)
  // ============================================================
  .command('many-to-many', {
    description:
      'Pair from-group[i] to to-group[i], compute BNB amount per wallet, send sequentially.',
    options: z.object({
      fromGroup: z.coerce.number().int().positive().describe('Source wallet group ID'),
      toGroup: z.coerce.number().int().positive().describe('Target wallet group ID'),
      amount: z.enum(['all', 'reserve', 'fixed']).default('all')
        .describe('all = send (balance - gas - buffer); reserve = keep --value BNB; fixed = send exactly --value BNB'),
      value: z.coerce.number().min(0).optional().describe('BNB amount (required for reserve/fixed)'),
      password: z.string().optional().describe('Master password (or ALMM_PASSWORD env)'),
      dryRun: z.boolean().default(false).describe('Estimate without broadcasting'),
    }),
    output: z.object({
      fromGroup: z.number(),
      toGroup: z.number(),
      mode: z.string(),
      pairCount: z.number(),
      totalBnb: z.string(),
      estimatedFeeBnb: z.string(),
      dryRun: z.boolean(),
      results: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          sendBnb: z.string(),
          status: z.string(),
          txHash: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
    async run(c) {
      if (c.options.amount !== 'all' && c.options.value === undefined) {
        return c.error({ code: 'VALUE_REQUIRED', message: `amount=${c.options.amount} requires --value` })
      }

      const config = loadConfig()
      const publicClient = getPublicClient()
      const almmPassword = resolveAlmmPassword(c.options.password)
      if (!almmPassword) {
        return c.error({ code: 'NO_PASSWORD', message: 'ALMM master password required (--password or ALMM_PASSWORD env)' })
      }

      const srcGroup = getGroup(almmPassword, c.options.fromGroup)
      if (!srcGroup || srcGroup.wallets.length === 0) {
        return c.error({ code: 'FROM_GROUP_NOT_FOUND', message: `Source group ${c.options.fromGroup} not found or empty` })
      }
      const dstGroup = getGroup(almmPassword, c.options.toGroup)
      if (!dstGroup || dstGroup.wallets.length === 0) {
        return c.error({ code: 'TO_GROUP_NOT_FOUND', message: `Target group ${c.options.toGroup} not found or empty` })
      }

      const pairCount = Math.min(srcGroup.wallets.length, dstGroup.wallets.length)

      // Gas prep
      const gasEstimate = 21_000n
      const gasPriceRaw = await publicClient.getGasPrice().catch(() => 3_000_000_000n)
      const gasPrice = bufferedGasPrice(gasPriceRaw)
      const feePerTxBnb = Number(gasEstimate * gasPrice) / 1e18
      const bufferBnb = feePerTxBnb * 2

      type PairRow = { fromWallet: (typeof srcGroup.wallets)[number]; toWallet: (typeof dstGroup.wallets)[number]; balanceBnb: number; sendBnb: number; insufficient: boolean }
      const rows: PairRow[] = []

      for (let i = 0; i < pairCount; i++) {
        const fromW = srcGroup.wallets[i]!
        const toW = dstGroup.wallets[i]!
        let balanceBnb = 0
        try { const wei = await publicClient.getBalance({ address: fromW.address }); balanceBnb = Number(formatEther(wei)) } catch { /* 0 */ }

        let sendBnb = 0
        let insufficient = false
        if (c.options.amount === 'all') {
          sendBnb = Math.max(0, balanceBnb - bufferBnb - feePerTxBnb)
        } else if (c.options.amount === 'reserve') {
          sendBnb = Math.max(0, balanceBnb - c.options.value! - feePerTxBnb)
        } else {
          if (balanceBnb < c.options.value! + feePerTxBnb) { insufficient = true } else { sendBnb = c.options.value! }
        }
        rows.push({ fromWallet: fromW, toWallet: toW, balanceBnb, sendBnb, insufficient })
      }

      const totalBnb = rows.reduce((s, r) => s + r.sendBnb, 0)
      const estimatedFeeTotalBnb = feePerTxBnb * pairCount

      if (c.options.dryRun) {
        return c.ok(
          {
            fromGroup: c.options.fromGroup, toGroup: c.options.toGroup, mode: c.options.amount,
            pairCount, totalBnb: `${totalBnb.toFixed(6)} BNB`,
            estimatedFeeBnb: `${estimatedFeeTotalBnb.toFixed(6)} BNB`, dryRun: true,
            results: rows.map((r) => ({
              from: r.fromWallet.address, to: r.toWallet.address, sendBnb: `${r.sendBnb.toFixed(6)} BNB`,
              status: r.insufficient ? 'insufficient-funds' : r.sendBnb > 0 ? 'ready' : 'nothing-to-send',
            })),
          },
          { cta: { commands: [{ command: 'transfer many-to-many', options: { fromGroup: c.options.fromGroup, toGroup: c.options.toGroup, amount: c.options.amount, ...(c.options.value !== undefined ? { value: c.options.value } : {}) }, description: 'Execute for real' }] } },
        )
      }

      // Live broadcast
      const results: Array<{ from: string; to: string; sendBnb: string; status: string; txHash?: string; error?: string }> = []

      for (const row of rows) {
        if (row.insufficient) { results.push({ from: row.fromWallet.address, to: row.toWallet.address, sendBnb: '0 BNB', status: 'insufficient-funds' }); continue }
        if (row.sendBnb <= 0) { results.push({ from: row.fromWallet.address, to: row.toWallet.address, sendBnb: '0 BNB', status: 'skipped' }); continue }

        let privateKey
        try { privateKey = decryptPrivateKey(row.fromWallet, almmPassword) } catch (err) {
          results.push({ from: row.fromWallet.address, to: row.toWallet.address, sendBnb: `${row.sendBnb.toFixed(6)} BNB`, status: 'decrypt-failed', error: err instanceof Error ? err.message : String(err) })
          continue
        }

        const account = privateKeyToAccount(privateKey)
        const wc = walletClientFor(account, config)
        try {
          const hash = (await wc.sendTransaction({ account, chain: wc.chain!, to: row.toWallet.address, value: parseEther(row.sendBnb.toFixed(18)) })) as Hash
          trackInBackground(publicClient, hash, { ca: NATIVE_BNB, groupId: c.options.fromGroup, walletAddress: account.address, txType: 'transfer_out', knownAmountBnb: -row.sendBnb, counterparty: row.toWallet.address })
          results.push({ from: row.fromWallet.address, to: row.toWallet.address, sendBnb: `${row.sendBnb.toFixed(6)} BNB`, status: 'broadcast', txHash: hash })
        } catch (err) {
          results.push({ from: row.fromWallet.address, to: row.toWallet.address, sendBnb: `${row.sendBnb.toFixed(6)} BNB`, status: 'failed', error: err instanceof Error ? err.message : String(err) })
        }
      }

      return c.ok(
        {
          fromGroup: c.options.fromGroup, toGroup: c.options.toGroup, mode: c.options.amount,
          pairCount, totalBnb: `${totalBnb.toFixed(6)} BNB`,
          estimatedFeeBnb: `${estimatedFeeTotalBnb.toFixed(6)} BNB`, dryRun: false, results,
        },
        { cta: { commands: [
          { command: 'wallet group-info', options: { id: c.options.toGroup }, description: 'Verify target group' },
          { command: 'query balance', options: { address: dstGroup.wallets[0]?.address ?? '' }, description: 'Check a recipient' },
        ] } },
      )
    },
  })
