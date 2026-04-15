/**
 * `fourmm trade` command group — buy, sell, sniper, batch.
 *
 * Week 3: Router deployed at 0x5A3A...84C1. Live broadcast enabled for
 * buy / sell on bonding-curve tokens. PancakeSwap graduated path uses
 * Router.volumePancake() for batch commands.
 *
 * All trade commands enforce:
 *   - assertSupportedToken (refuses TaxToken / X Mode)
 *   - resolveTradingPath (bonding-curve vs pancake)
 *   - tradeable check (launchTime <= now)
 */

import { Cli, z } from 'incur'
import {
  createWalletClient,
  fallback,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseEther,
  parseUnits,
  type Address,
  type Hash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc, bscTestnet } from 'viem/chains'
import { PANCAKE_V2_ROUTER, TOKEN_MANAGER_HELPER3, WBNB, requireRouter } from '../lib/const.js'
import { loadConfig, type CliConfig } from '../lib/config.js'
import { tokenManagerHelper3Abi } from '../contracts/tokenManagerHelper3.js'
import { tokenManager2Abi } from '../contracts/tokenManager2.js'
import { erc20Abi } from '../contracts/erc20.js'
import { pancakeRouterAbi } from '../contracts/pancakeRouter.js'
import { fourmemeMmRouterAbi } from '../contracts/fourmemeMmRouter.js'
import { computeVolumeSlippage } from '../lib/slippage.js'
import {
  assertSupportedToken,
  TokenNotFoundError,
  UnsupportedTokenError,
} from '../lib/guards.js'
import { resolveFourmmPassword } from '../lib/env.js'
import { resolveTradingPath } from '../lib/routing.js'
import { trackInBackground } from '../lib/tracker.js'
import { getPublicClient } from '../lib/viem.js'
import { decryptPrivateKey, getGroup } from '../wallets/groups/store.js'

import { makeWalletClient } from '../lib/walletClient.js'

export const trade = Cli.create('trade', {
  description: 'Execute or simulate trades (buy, sell, sniper, batch)',
})
  // ============================================================
  // fourmm trade buy
  // ============================================================
  .command('buy', {
    description:
      'Batch buy tokens for every wallet in a group. Uses TokenManager2.buyTokenAMAP on the bonding curve.',
    options: z.object({
      group: z
        .coerce.number()
        .int()
        .positive()
        .describe('Wallet group ID'),
      token: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, 'Expected a 40-hex-char 0x-prefixed address')
        .describe('Token contract address'),
      amount: z
        .coerce.number()
        .positive()
        .describe('BNB amount to spend per wallet'),
      slippage: z
        .coerce.number()
        .int()
        .min(1)
        .max(5_000)
        .default(300)
        .describe('Max slippage in basis points (300 = 3%, max 5000)'),
      dryRun: z
        .boolean()
        .default(false)
        .describe('Simulate without broadcasting'),
      password: z
        .string()
        .optional()
        .describe('In-house master password (or FOURMM_PASSWORD env)'),
    }),
    examples: [
      {
        options: {
          group: 1,
          token: '0x802CF8e2673f619c486a2950feE3D24f8A074444',
          amount: 0.01,
        },
        description: 'Dry-run: simulate 0.01 BNB buy from every wallet in group 1',
      },
      {
        options: {
          group: 1,
          token: '0x802CF8e2673f619c486a2950feE3D24f8A074444',
          amount: 0.05,
          slippage: 500,
        },
        description: 'Simulate with 5% slippage',
      },
    ],
    output: z.object({
      token: z.string(),
      variant: z.string(),
      path: z.string(),
      tokenManager: z.string(),
      tradeable: z.boolean(),
      group: z.number(),
      walletCount: z.number(),
      amountPerWallet: z.string(),
      totalSpend: z.string(),
      slippageBps: z.number(),
      dryRun: z.boolean(),
      estimate: z.object({
        estimatedTokens: z.string(),
        estimatedCost: z.string(),
        estimatedFee: z.string(),
        minAmountOut: z.string(),
      }),
      wallets: z.array(z.string()),
      warnings: z.array(z.string()),
      /** Per-wallet broadcast results (empty for dry-run) */
      results: z.array(
        z.object({
          wallet: z.string(),
          status: z.string(),
          txHash: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
    async run(c) {
      if (!isAddress(c.options.token)) {
        return c.error({
          code: 'INVALID_ADDRESS',
          message: `"${c.options.token}" is not a valid address`,
        })
      }
      const ca = getAddress(c.options.token) as Address

      const password = resolveFourmmPassword(c.options.password)
      if (!password) {
        return c.error({
          code: 'NO_PASSWORD',
          message:
            'fourMM master password required (--password or FOURMM_PASSWORD env)',
        })
      }

      // ---- Resolve group ----
      const group = getGroup(password, c.options.group)
      if (!group) {
        return c.error({
          code: 'GROUP_NOT_FOUND',
          message: `Group ${c.options.group} does not exist`,
        })
      }
      if (group.wallets.length === 0) {
        return c.error({
          code: 'EMPTY_GROUP',
          message: `Group ${c.options.group} has no wallets`,
        })
      }

      // ---- Core invariants ----
      let supported
      try {
        supported = await assertSupportedToken(ca)
      } catch (err) {
        if (err instanceof UnsupportedTokenError) {
          return c.error({
            code: 'UNSUPPORTED_TOKEN',
            message: err.message,
          })
        }
        if (err instanceof TokenNotFoundError) {
          return c.error({
            code: 'TOKEN_NOT_FOUND',
            message: err.message,
          })
        }
        return c.error({
          code: 'IDENTIFY_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      const client = getPublicClient()

      // resolveTradingPath now returns the full Helper3.getTokenInfo tuple
      // so we can reuse fields (launchTime, etc.) without a second RPC call.
      let routing
      try {
        routing = await resolveTradingPath(client, ca)
      } catch (err) {
        return c.error({
          code: 'ROUTING_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }
      const tradingPath = routing.tradingPath
      const tokenInfo = routing.rawInfo

      // ---- Verify launch has happened (reuses rawInfo from resolveTradingPath) ----
      const launchTime = tokenInfo[6]
      const nowUnix = BigInt(Math.floor(Date.now() / 1000))
      const tradeable = launchTime > 0n && launchTime <= nowUnix
      // Graduated tokens are always tradeable
      if (!tradeable && tradingPath.path !== 'pancake') {
        return c.error({
          code: 'NOT_TRADEABLE',
          message:
            launchTime === 0n
              ? `Token ${ca} has no launchTime set — protocol would revert on buy`
              : `Token ${ca} launches at ${new Date(Number(launchTime) * 1000).toISOString()} — too early to trade`,
        })
      }

      // ---- Estimate tokens out ----
      const perWalletBnbWei = parseEther(c.options.amount.toString())
      let estimate
      const slippageBps = BigInt(c.options.slippage)

      if (tradingPath.path === 'pancake') {
        // PancakeSwap: use getAmountsOut for estimation
        try {
          const amounts = await client.readContract({
            address: PANCAKE_V2_ROUTER,
            abi: pancakeRouterAbi,
            functionName: 'getAmountsOut',
            args: [perWalletBnbWei, [WBNB, ca]],
          })
          const estimatedAmount = amounts[1]!
          const minAmountOut = (estimatedAmount * (10_000n - slippageBps)) / 10_000n
          estimate = {
            estimatedTokens: formatUnits(estimatedAmount, 18),
            estimatedCost: `${c.options.amount} BNB`,
            estimatedFee: '0 BNB',
            minAmountOut: formatUnits(minAmountOut, 18),
          }
        } catch (err) {
          return c.error({
            code: 'ESTIMATE_FAILED',
            message: err instanceof Error
              ? `PancakeSwap getAmountsOut failed: ${err.message}`
              : 'getAmountsOut failed',
          })
        }
      } else {
        // Bonding curve: use Helper3.tryBuy
        try {
          const result = await client.readContract({
            address: TOKEN_MANAGER_HELPER3,
            abi: tokenManagerHelper3Abi,
            functionName: 'tryBuy',
            args: [ca, 0n, perWalletBnbWei],
          })
          const [, , estimatedAmount, estimatedCost, estimatedFee] = result
          const minAmountOut = (estimatedAmount * (10_000n - slippageBps)) / 10_000n
          estimate = {
            estimatedTokens: formatUnits(estimatedAmount, 18),
            estimatedCost: `${formatEther(estimatedCost)} BNB`,
            estimatedFee: `${formatEther(estimatedFee)} BNB`,
            minAmountOut: formatUnits(minAmountOut, 18),
          }
        } catch (err) {
          return c.error({
            code: 'TRYBUY_FAILED',
            message: err instanceof Error
              ? `tryBuy(${ca}, ${c.options.amount} BNB) failed: ${err.message}`
              : 'tryBuy failed',
          })
        }
      }

      const totalSpend = c.options.amount * group.wallets.length

      // Surface warnings the agent should see before proceeding.
      const warnings: string[] = []
      if (supported.variant === 'anti-sniper-fee') {
        warnings.push(
          'anti-sniper-fee token: dynamic fee decreases block-by-block after launch. ' +
            'First few blocks can charge 10–20% — consider raising --slippage to 1000+ bps.',
        )
      }
      if (supported.source === 'fallback-network') {
        warnings.push(
          'Four.meme API was unreachable; variant classification defaulted to standard. ' +
            'If the token is actually TaxToken or X Mode, the downstream RPC layer will still catch it.',
        )
      }

      // ---- Dry run: return estimates only ----
      if (c.options.dryRun) {
        return c.ok(
          {
            token: ca,
            variant: supported.variant,
            path: tradingPath.path,
            tokenManager: tradingPath.router,
            tradeable,
            group: c.options.group,
            walletCount: group.wallets.length,
            amountPerWallet: `${c.options.amount} BNB`,
            totalSpend: `${totalSpend} BNB`,
            slippageBps: c.options.slippage,
            dryRun: true,
            estimate,
            wallets: group.wallets.map((w) => w.address),
            warnings,
            results: [],
          },
          {
            cta: {
              commands: [
                {
                  command: 'trade buy',
                  options: {
                    group: c.options.group,
                    token: ca,
                    amount: c.options.amount,
                  },
                  description: 'Execute this buy for real (remove --dry-run)',
                },
              ],
            },
          },
        )
      }

      // ---- Live: sign + send buy for each wallet ----
      const config = loadConfig()
      const results: Array<{
        wallet: string
        status: string
        txHash?: string
        error?: string
      }> = []
      // Track the latest confirmed block so subsequent readContract calls
      // read post-buy state (RPC "latest" can lag 1-2 blocks behind).
      let lastConfirmedBlock: bigint | undefined
      const walletCount = group.wallets.length

      for (let wi = 0; wi < walletCount; wi++) {
        const w = group.wallets[wi]!
        try {
          const pk = decryptPrivateKey(w, password)
          const account = privateKeyToAccount(pk)
          const wc = makeWalletClient(account, config)

          let hash: string
          const readAt = lastConfirmedBlock ? { blockNumber: lastConfirmedBlock } : {}

          if (tradingPath.path === 'pancake') {
            const amounts = await client.readContract({
              address: PANCAKE_V2_ROUTER,
              abi: pancakeRouterAbi,
              functionName: 'getAmountsOut',
              args: [perWalletBnbWei, [WBNB, ca]],
              ...readAt,
            })
            const minAmount = (amounts[1]! * (10_000n - slippageBps)) / 10_000n
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)

            hash = await wc.writeContract({
              address: PANCAKE_V2_ROUTER,
              abi: pancakeRouterAbi,
              functionName: 'swapExactETHForTokens',
              args: [minAmount, [WBNB, ca], account.address, deadline],
              value: perWalletBnbWei,
              chain: wc.chain!,
              account,
            })
          } else {
            const tryResult = await client.readContract({
              address: TOKEN_MANAGER_HELPER3,
              abi: tokenManagerHelper3Abi,
              functionName: 'tryBuy',
              args: [ca, 0n, perWalletBnbWei],
              ...readAt,
            })
            const minAmount = (tryResult[2] * (10_000n - slippageBps)) / 10_000n

            hash = await wc.writeContract({
              address: tradingPath.router,
              abi: tokenManager2Abi,
              functionName: 'buyTokenAMAP',
              args: [ca, perWalletBnbWei, minAmount],
              value: perWalletBnbWei,
              chain: wc.chain!,
              account,
            })
          }

          // Always wait for receipt — report confirmed/failed, not just broadcast
          let receipt: any
          let status = 'broadcast'
          try {
            receipt = await client.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 30_000 })
            lastConfirmedBlock = receipt.blockNumber
            status = receipt.status === 'success' ? 'confirmed' : 'failed (reverted)'
          } catch {
            status = 'broadcast (receipt timeout)'
          }

          trackInBackground(client, hash as Hash, {
            ca,
            groupId: c.options.group,
            walletAddress: account.address,
            txType: 'buy',
            knownAmountBnb: -c.options.amount,
          }, 30_000, receipt)

          results.push({ wallet: w.address, status, txHash: hash })
        } catch (err) {
          results.push({
            wallet: w.address,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      const successCount = results.filter((r) => r.status === 'broadcast').length

      return c.ok(
        {
          token: ca,
          variant: supported.variant,
          path: tradingPath.path,
          tokenManager: tradingPath.router,
          tradeable,
          group: c.options.group,
          walletCount: group.wallets.length,
          amountPerWallet: `${c.options.amount} BNB`,
          totalSpend: `${totalSpend} BNB`,
          slippageBps: c.options.slippage,
          dryRun: false,
          estimate,
          wallets: group.wallets.map((w) => w.address),
          warnings,
          results,
        },
        {
          cta: {
            commands: [
              {
                command: 'query monitor',
                options: { group: c.options.group, token: ca },
                description: `${successCount}/${group.wallets.length} buys broadcast — check holdings`,
              },
              {
                command: 'trade sell',
                options: {
                  group: c.options.group,
                  token: ca,
                  amount: 'all',
                },
                description: 'Sell everything when ready',
              },
            ],
          },
        },
      )
    },
  })
  // ============================================================
  // fourmm trade sell
  // ============================================================
  .command('sell', {
    description:
      'Batch sell tokens from every wallet in a group. Supports amount modes: all / NN% / fixed number.',
    options: z.object({
      group: z
        .coerce.number()
        .int()
        .positive()
        .describe('Wallet group ID'),
      token: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .describe('Token contract address'),
      amount: z
        .string()
        .default('all')
        .describe('Sell amount: "all", "50%", or a fixed token count'),
      slippage: z
        .coerce.number()
        .int()
        .min(1)
        .max(5_000)
        .default(300)
        .describe('Max slippage in basis points'),
      dryRun: z
        .boolean()
        .default(false)
        .describe('Simulate without broadcasting'),
      password: z
        .string()
        .optional()
        .describe('In-house master password (or FOURMM_PASSWORD env)'),
    }),
    examples: [
      {
        options: {
          group: 1,
          token: '0x802CF8e2673f619c486a2950feE3D24f8A074444',
          amount: 'all',
          dryRun: true,
        },
        description: 'Dry-run: sell all tokens from group 1',
      },
      {
        options: {
          group: 1,
          token: '0x802CF8e2673f619c486a2950feE3D24f8A074444',
          amount: '50%',
        },
        description: 'Sell 50% of holdings',
      },
    ],
    output: z.object({
      token: z.string(),
      group: z.number(),
      mode: z.string(),
      dryRun: z.boolean(),
      walletCount: z.number(),
      results: z.array(
        z.object({
          wallet: z.string(),
          tokenBalance: z.string(),
          sellAmount: z.string(),
          status: z.string(),
          txHash: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
    async run(c) {
      if (!isAddress(c.options.token)) {
        return c.error({
          code: 'INVALID_ADDRESS',
          message: `"${c.options.token}" is not a valid address`,
        })
      }
      const ca = getAddress(c.options.token) as Address

      const password = resolveFourmmPassword(c.options.password)
      if (!password) {
        return c.error({
          code: 'NO_PASSWORD',
          message: 'fourMM master password required',
        })
      }

      const group = getGroup(password, c.options.group)
      if (!group || group.wallets.length === 0) {
        return c.error({
          code: 'GROUP_NOT_FOUND',
          message: `Group ${c.options.group} does not exist or is empty`,
        })
      }

      // Core invariants
      try {
        await assertSupportedToken(ca)
      } catch (err) {
        if (err instanceof UnsupportedTokenError || err instanceof TokenNotFoundError) {
          return c.error({ code: err.code, message: err.message })
        }
        return c.error({ code: 'IDENTIFY_FAILED', message: String(err) })
      }

      const client = getPublicClient()
      let routing
      try {
        routing = await resolveTradingPath(client, ca)
      } catch (err) {
        return c.error({
          code: 'ROUTING_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      const isPancake = routing.tradingPath.path === 'pancake'

      // Parse amount mode
      const amountRaw = c.options.amount
      const isAll = amountRaw === 'all'
      const isPercent = amountRaw.endsWith('%')
      const pctValue = isPercent ? Number(amountRaw.replace('%', '')) : 0
      if (isPercent && (pctValue <= 0 || pctValue > 100)) {
        return c.error({
          code: 'INVALID_AMOUNT',
          message: `Percentage must be 1-100, got ${amountRaw}`,
        })
      }

      const config = loadConfig()

      // Read token decimals once (Four.meme tokens are 18, but we don't assume)
      let tokenDecimals = 18
      try {
        const d = await client.readContract({ address: ca, abi: erc20Abi, functionName: 'decimals' })
        tokenDecimals = Number(d)
      } catch { /* fall back to 18 */ }

      const results: Array<{
        wallet: string
        tokenBalance: string
        sellAmount: string
        status: string
        txHash?: string
        error?: string
      }> = []
      let lastConfirmedBlock: bigint | undefined

      for (const w of group.wallets) {
        try {
          // Read token balance at confirmed block for sequential consistency
          const readAt = lastConfirmedBlock ? { blockNumber: lastConfirmedBlock } : {}
          const balance = await client.readContract({
            address: ca,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [w.address],
            ...readAt,
          })

          if (balance === 0n) {
            results.push({
              wallet: w.address,
              tokenBalance: '0',
              sellAmount: '0',
              status: 'no-balance',
            })
            continue
          }

          // Compute sell amount
          let sellAmount: bigint
          if (isAll) {
            sellAmount = balance
          } else if (isPercent) {
            sellAmount = (balance * BigInt(Math.round(pctValue * 100))) / 10_000n
          } else {
            // Fixed amount: validate it's a number before parsing
            const numVal = Number(amountRaw)
            if (Number.isNaN(numVal) || numVal <= 0) {
              return c.error({
                code: 'INVALID_AMOUNT',
                message: `Expected a positive number, "all", or "NN%", got "${amountRaw}"`,
              })
            }
            sellAmount = parseUnits(amountRaw, tokenDecimals)
            if (sellAmount > balance) {
              results.push({
                wallet: w.address,
                tokenBalance: formatUnits(balance, tokenDecimals),
                sellAmount: formatUnits(sellAmount, tokenDecimals),
                status: 'insufficient-balance',
              })
              continue
            }
          }

          if (sellAmount === 0n) {
            results.push({
              wallet: w.address,
              tokenBalance: formatUnits(balance, tokenDecimals),
              sellAmount: '0',
              status: 'nothing-to-sell',
            })
            continue
          }

          if (c.options.dryRun) {
            // Estimate via trySell (bonding curve) or getAmountsOut (pancake)
            try {
              if (isPancake) {
                const amounts = await client.readContract({
                  address: PANCAKE_V2_ROUTER,
                  abi: pancakeRouterAbi,
                  functionName: 'getAmountsOut',
                  args: [sellAmount, [ca, WBNB]],
                })
                results.push({
                  wallet: w.address,
                  tokenBalance: formatUnits(balance, tokenDecimals),
                  sellAmount: formatUnits(sellAmount, tokenDecimals),
                  status: `ready (est: ${formatEther(amounts[1]!)} BNB via PancakeSwap)`,
                })
              } else {
                const est = await client.readContract({
                  address: TOKEN_MANAGER_HELPER3,
                  abi: tokenManagerHelper3Abi,
                  functionName: 'trySell',
                  args: [ca, sellAmount],
                })
                results.push({
                  wallet: w.address,
                  tokenBalance: formatUnits(balance, tokenDecimals),
                  sellAmount: formatUnits(sellAmount, tokenDecimals),
                  status: `ready (est: ${formatEther(est[2])} BNB, fee: ${formatEther(est[3])} BNB)`,
                })
              }
            } catch {
              results.push({
                wallet: w.address,
                tokenBalance: formatUnits(balance, tokenDecimals),
                sellAmount: formatUnits(sellAmount, tokenDecimals),
                status: 'ready (estimate unavailable)',
              })
            }
            continue
          }

          // Live: approve + sell
          const pk = decryptPrivateKey(w, password)
          const account = privateKeyToAccount(pk)
          const wc = makeWalletClient(account, config)
          const sellTarget = isPancake ? PANCAKE_V2_ROUTER : routing.tradingPath.router

          // Approve — MUST wait for confirmation before selling, otherwise
          // the sell tx can land before the approve and revert.
          const approveHash = await wc.writeContract({
            address: ca,
            abi: erc20Abi,
            functionName: 'approve',
            args: [sellTarget, sellAmount],
            chain: wc.chain!,
            account,
          })
          await client.waitForTransactionReceipt({
            hash: approveHash as Hash,
            timeout: 30_000,
          })

          let hash: string
          if (isPancake) {
            // PancakeSwap: swapExactTokensForETHSupportingFeeOnTransferTokens
            const amounts = await client.readContract({
              address: PANCAKE_V2_ROUTER,
              abi: pancakeRouterAbi,
              functionName: 'getAmountsOut',
              args: [sellAmount, [ca, WBNB]],
              ...readAt,
            })
            const minBnbOut = (amounts[1]! * (10_000n - BigInt(c.options.slippage))) / 10_000n
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)

            hash = await wc.writeContract({
              address: PANCAKE_V2_ROUTER,
              abi: pancakeRouterAbi,
              functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
              args: [sellAmount, minBnbOut, [ca, WBNB], account.address, deadline],
              chain: wc.chain!,
              account,
            })
          } else {
            // Bonding curve: TokenManager2.sellToken
            hash = await wc.writeContract({
              address: sellTarget,
              abi: tokenManager2Abi,
              functionName: 'sellToken',
              args: [ca, sellAmount],
              chain: wc.chain!,
              account,
            })
          }

          // Post-sell verification: wait for receipt then check if balance changed.
          let sellVerified = 'broadcast'
          let sellReceipt: any
          try {
            sellReceipt = await client.waitForTransactionReceipt({ hash: hash as Hash, timeout: 30_000 })
            lastConfirmedBlock = sellReceipt.blockNumber
            const postBalance = await client.readContract({
              address: ca, abi: erc20Abi, functionName: 'balanceOf', args: [w.address],
            })
            if (postBalance === balance) {
              sellVerified = 'WARNING: tx succeeded but token balance unchanged — possible protocol cooldown after buy. Try again in a few blocks.'
            } else {
              sellVerified = 'confirmed'
            }
          } catch {
            sellVerified = 'broadcast (verification timeout)'
          }

          // Pass pre-fetched receipt so tracker doesn't re-wait
          trackInBackground(client, hash as Hash, {
            ca,
            groupId: c.options.group,
            walletAddress: account.address,
            txType: 'sell',
          }, 30_000, sellReceipt)

          results.push({
            wallet: w.address,
            tokenBalance: formatUnits(balance, tokenDecimals),
            sellAmount: formatUnits(sellAmount, tokenDecimals),
            status: sellVerified,
            txHash: hash,
          })
        } catch (err) {
          results.push({
            wallet: w.address,
            tokenBalance: '?',
            sellAmount: '?',
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      return c.ok(
        {
          token: ca,
          group: c.options.group,
          mode: amountRaw,
          dryRun: c.options.dryRun,
          walletCount: group.wallets.length,
          results,
        },
        {
          cta: {
            commands: [
              {
                command: 'query monitor',
                options: { group: c.options.group, token: ca },
                description: 'Check updated holdings + PnL',
              },
              {
                command: 'transfer in',
                options: {
                  to: '<your-address>',
                  fromGroup: c.options.group,
                  amount: 'all',
                },
                description: 'Collect remaining BNB',
              },
            ],
          },
        },
      )
    },
  })
  // ============================================================
  // fourmm trade sniper
  // ============================================================
  .command('sniper', {
    description: 'Sniper buy: each wallet uses its own BNB amount. Count must match wallet count.',
    options: z.object({
      group: z.coerce.number().int().positive().describe('Wallet group ID'),
      token: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Token CA'),
      amounts: z.string().describe('Comma-separated BNB amounts per wallet'),
      slippage: z.coerce.number().int().min(1).max(5_000).default(500),
      dryRun: z.boolean().default(false),
      password: z.string().optional(),
    }),
    output: z.object({
      token: z.string(), group: z.number(), dryRun: z.boolean(),
      results: z.array(z.object({ wallet: z.string(), amount: z.string(), status: z.string(), txHash: z.string().optional(), error: z.string().optional() })),
    }),
    async run(c) {
      const ca = getAddress(c.options.token) as Address
      const password = resolveFourmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'Password required' })
      const group = getGroup(password, c.options.group)
      if (!group || group.wallets.length === 0) return c.error({ code: 'GROUP_NOT_FOUND', message: 'Group not found or empty' })
      const amountStrs = c.options.amounts.split(',').map((s) => s.trim())
      if (amountStrs.length !== group.wallets.length) return c.error({ code: 'AMOUNT_MISMATCH', message: `${amountStrs.length} amounts for ${group.wallets.length} wallets` })
      const amounts = amountStrs.map(Number)
      if (amounts.some((a) => Number.isNaN(a) || a <= 0)) return c.error({ code: 'INVALID_AMOUNT', message: 'All amounts must be positive' })
      try { await assertSupportedToken(ca) } catch (err: any) { return c.error({ code: err.code ?? 'UNSUPPORTED', message: err.message }) }
      const client = getPublicClient()
      let routing; try { routing = await resolveTradingPath(client, ca) } catch (err: any) { return c.error({ code: 'ROUTING_FAILED', message: err.message }) }
      if (routing.tradingPath.path === 'pancake') return c.error({ code: 'PANCAKE_NOT_YET', message: 'Graduated tokens not supported for sniper' })
      const config = loadConfig()
      const slippageBps = BigInt(c.options.slippage)
      const results: Array<{ wallet: string; amount: string; status: string; txHash?: string; error?: string }> = []
      let lastConfirmedBlock: bigint | undefined
      for (let i = 0; i < group.wallets.length; i++) {
        const w = group.wallets[i]!; const bnb = amounts[i]!; const bnbWei = parseEther(bnb.toString())
        if (c.options.dryRun) { results.push({ wallet: w.address, amount: `${bnb} BNB`, status: 'ready' }); continue }
        try {
          const pk = decryptPrivateKey(w, password); const account = privateKeyToAccount(pk); const wc = makeWalletClient(account, config)
          // Read at the confirmed block so tryBuy sees post-buy state
          const readAt = lastConfirmedBlock ? { blockNumber: lastConfirmedBlock } : {}
          const tryR = await client.readContract({ address: TOKEN_MANAGER_HELPER3, abi: tokenManagerHelper3Abi, functionName: 'tryBuy', args: [ca, 0n, bnbWei], ...readAt })
          const min = (tryR[2] * (10_000n - slippageBps)) / 10_000n
          const hash = await wc.writeContract({ address: routing.tradingPath.router, abi: tokenManager2Abi, functionName: 'buyTokenAMAP', args: [ca, bnbWei, min], value: bnbWei, chain: wc.chain!, account })
          let receipt: any; let status = 'broadcast'
          try { receipt = await client.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 30_000 }); lastConfirmedBlock = receipt.blockNumber; status = receipt.status === 'success' ? 'confirmed' : 'failed (reverted)' } catch { status = 'broadcast (receipt timeout)' }
          trackInBackground(client, hash as Hash, { ca, groupId: c.options.group, walletAddress: account.address, txType: 'buy', knownAmountBnb: -bnb }, 30_000, receipt)
          results.push({ wallet: w.address, amount: `${bnb} BNB`, status, txHash: hash })
        } catch (err: any) { results.push({ wallet: w.address, amount: `${bnb} BNB`, status: 'failed', error: err.message }) }
      }
      return c.ok({ token: ca, group: c.options.group, dryRun: c.options.dryRun, results }, { cta: { commands: [{ command: 'query monitor', options: { group: c.options.group, token: ca }, description: 'Check holdings' }] } })
    },
  })
  // ============================================================
  // fourmm trade batch (Router.volume — atomic buy+sell)
  // ============================================================
  .command('batch', {
    description: 'Atomic buy+sell via Router. Each wallet does a round-trip in one tx (zero net position).',
    options: z.object({
      group: z.coerce.number().int().positive().describe('Wallet group ID'),
      token: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Token CA'),
      amount: z.coerce.number().positive().describe('BNB per round-trip'),
      slippage: z.coerce.number().int().min(1).max(5_000).default(300).describe('Max slippage bps'),
      dryRun: z.boolean().default(false),
      password: z.string().optional(),
    }),
    output: z.object({
      token: z.string(), group: z.number(), dryRun: z.boolean(), router: z.string(),
      slippageBps: z.number(),
      results: z.array(z.object({ wallet: z.string(), status: z.string(), txHash: z.string().optional(), error: z.string().optional() })),
    }),
    async run(c) {
      const ca = getAddress(c.options.token) as Address
      const password = resolveFourmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'Password required' })
      const group = getGroup(password, c.options.group)
      if (!group || group.wallets.length === 0) return c.error({ code: 'GROUP_NOT_FOUND', message: 'Group not found or empty' })
      try { await assertSupportedToken(ca) } catch (err: any) { return c.error({ code: err.code ?? 'UNSUPPORTED', message: err.message }) }
      const client = getPublicClient()
      const routerAddr = requireRouter()
      const config = loadConfig()
      const bnbWei = parseEther(c.options.amount.toString())
      let routing; try { routing = await resolveTradingPath(client, ca) } catch (err: any) { return c.error({ code: 'ROUTING_FAILED', message: err.message }) }
      const routerFn = routing.tradingPath.path === 'pancake' ? 'volumePancake' : 'volume'

      // Compute slippage-protected minimums ONCE (pure function of token + amount)
      const { minTokenOut, minBnbBack } = await computeVolumeSlippage(
        client, ca, bnbWei, c.options.slippage,
      )

      const results: Array<{ wallet: string; status: string; txHash?: string; error?: string }> = []
      for (const w of group.wallets) {
        if (c.options.dryRun) { results.push({ wallet: w.address, status: 'ready' }); continue }
        try {
          const pk = decryptPrivateKey(w, password); const account = privateKeyToAccount(pk); const wc = makeWalletClient(account, config)
          const hash = await wc.writeContract({ address: routerAddr, abi: fourmemeMmRouterAbi, functionName: routerFn, args: [ca, minTokenOut, minBnbBack], value: bnbWei, chain: wc.chain!, account })
          trackInBackground(client, hash as Hash, { ca, groupId: c.options.group, walletAddress: account.address, txType: 'volume' })
          results.push({ wallet: w.address, status: 'broadcast', txHash: hash })
        } catch (err: any) { results.push({ wallet: w.address, status: 'failed', error: err.message }) }
      }
      return c.ok({ token: ca, group: c.options.group, dryRun: c.options.dryRun, router: routerAddr, slippageBps: c.options.slippage, results }, { cta: { commands: [{ command: 'tools volume', options: { group: c.options.group, token: ca, rounds: 10 }, description: 'Run volume bot' }] } })
    },
  })
