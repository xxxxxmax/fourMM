/**
 * `almm tools` command group — market-making bots.
 *
 * - volume:   multi-wallet, multi-round Router.volume() loop
 * - turnover: two-group wallet pairing via Router.turnover()
 * - robot-price: (Week 4)
 */

import { Cli, z } from 'incur'
import {
  formatEther,
  getAddress,
  isAddress,
  parseEther,
  type Address,
  type Hash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc, bscTestnet } from 'viem/chains'
import { requireRouter, TOKEN_MANAGER_HELPER3 } from '../lib/const.js'
import { loadConfig } from '../lib/config.js'
import { fourmemeMmRouterAbi } from '../contracts/fourmemeMmRouter.js'
import { tokenManager2Abi } from '../contracts/tokenManager2.js'
import { tokenManagerHelper3Abi } from '../contracts/tokenManagerHelper3.js'
import { erc20Abi } from '../contracts/erc20.js'
import { computeVolumeSlippage, computeTurnoverSlippage } from '../lib/slippage.js'
import { getTokenPrice } from '../lib/pricing.js'
import {
  assertSupportedToken,
  TokenNotFoundError,
  UnsupportedTokenError,
} from '../lib/guards.js'
import { resolveAlmmPassword } from '../lib/env.js'
import { resolveTradingPath } from '../lib/routing.js'
import { trackInBackground } from '../lib/tracker.js'
import { getPublicClient } from '../lib/viem.js'
import { decryptPrivateKey, getGroup } from '../wallets/groups/store.js'

import { makeWalletClient } from '../lib/walletClient.js'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const tools = Cli.create('tools', {
  description: 'Market-making bots (volume, turnover, robot-price)',
})
  // ============================================================
  // almm tools volume
  // ============================================================
  .command('volume', {
    description:
      'Volume bot: loop over wallets, each calls Router.volume() (atomic buy+sell). Generates on-chain volume with minimal net loss.',
    options: z.object({
      group: z.coerce.number().int().positive().describe('Wallet group ID'),
      token: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Token CA'),
      amount: z.coerce.number().positive().default(0.01).describe('BNB per round-trip'),
      slippage: z.coerce.number().int().min(1).max(5_000).default(300).describe('Max slippage bps (protection against sandwich attacks)'),
      rounds: z.coerce.number().int().min(1).default(1).describe('Number of rounds (each round iterates all wallets)'),
      interval: z.coerce.number().int().min(0).default(5000).describe('Delay between wallets (ms)'),
      dryRun: z.boolean().default(false),
      password: z.string().optional(),
    }),
    output: z.object({
      token: z.string(),
      group: z.number(),
      router: z.string(),
      totalRounds: z.number(),
      dryRun: z.boolean(),
      roundResults: z.array(
        z.object({
          round: z.number(),
          walletCount: z.number(),
          success: z.number(),
          failed: z.number(),
        }),
      ),
    }),
    async run(c) {
      const ca = getAddress(c.options.token) as Address
      const password = resolveAlmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'Password required' })

      const group = getGroup(password, c.options.group)
      if (!group || group.wallets.length === 0) {
        return c.error({ code: 'GROUP_NOT_FOUND', message: 'Group not found or empty' })
      }

      try { await assertSupportedToken(ca) } catch (err: any) {
        return c.error({ code: err.code ?? 'UNSUPPORTED', message: err.message })
      }

      const client = getPublicClient()
      const routerAddr = requireRouter()
      const config = loadConfig()
      const bnbWei = parseEther(c.options.amount.toString())

      let routing
      try { routing = await resolveTradingPath(client, ca) } catch (err: any) {
        return c.error({ code: 'ROUTING_FAILED', message: err.message })
      }
      const routerFn = routing.tradingPath.path === 'pancake' ? 'volumePancake' : 'volume'

      // Compute slippage-protected minimums ONCE per session
      const { minTokenOut, minBnbBack } = await computeVolumeSlippage(
        client, ca, bnbWei, c.options.slippage,
      )

      const roundResults: Array<{ round: number; walletCount: number; success: number; failed: number; errors: string[] }> = []

      for (let round = 1; round <= c.options.rounds; round++) {
        let success = 0
        let failed = 0
        const errors: string[] = []

        for (let i = 0; i < group.wallets.length; i++) {
          const w = group.wallets[i]!

          if (c.options.dryRun) {
            success++
            continue
          }

          try {
            const pk = decryptPrivateKey(w, password)
            const account = privateKeyToAccount(pk)
            const wc = makeWalletClient(account, config)

            const hash = await wc.writeContract({
              address: routerAddr,
              abi: fourmemeMmRouterAbi,
              functionName: routerFn,
              args: [ca, minTokenOut, minBnbBack],
              value: bnbWei,
              chain: wc.chain!,
              account,
            })

            trackInBackground(client, hash as Hash, {
              ca,
              groupId: c.options.group,
              walletAddress: account.address,
              txType: 'buy',
            })

            success++
          } catch (err: any) {
            failed++
            errors.push(`${w.address}: ${err.message ?? String(err)}`)
          }

          // Delay between wallets (not after last)
          if (c.options.interval > 0 && i < group.wallets.length - 1) {
            await sleep(c.options.interval)
          }
        }

        roundResults.push({
          round,
          walletCount: group.wallets.length,
          success,
          failed,
          errors,
        })

        // Delay between rounds (not after last)
        if (round < c.options.rounds && c.options.interval > 0) {
          await sleep(c.options.interval)
        }
      }

      return c.ok(
        {
          token: ca,
          group: c.options.group,
          router: routerAddr,
          totalRounds: c.options.rounds,
          dryRun: c.options.dryRun,
          roundResults,
        },
        {
          cta: {
            commands: [
              {
                command: 'query monitor',
                options: { group: c.options.group, token: ca },
                description: 'Check PnL after volume session',
              },
              {
                command: 'trade sell',
                options: { group: c.options.group, token: ca, amount: 'all' },
                description: 'Exit all positions',
              },
            ],
          },
        },
      )
    },
  })
  // ============================================================
  // almm tools turnover
  // ============================================================
  .command('turnover', {
    description:
      'Turnover: pair group-A wallets with group-B wallets. Each A[i] calls Router.turnover() to buy tokens for B[i].',
    options: z.object({
      fromGroup: z.coerce.number().int().positive().describe('Source group (pays BNB)'),
      toGroup: z.coerce.number().int().positive().describe('Target group (receives tokens)'),
      token: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Token CA'),
      amount: z.coerce.number().positive().default(0.01).describe('BNB per turnover pair'),
      slippage: z.coerce.number().int().min(1).max(5_000).default(300).describe('Max slippage bps'),
      dryRun: z.boolean().default(false),
      password: z.string().optional(),
    }),
    output: z.object({
      token: z.string(),
      fromGroup: z.number(),
      toGroup: z.number(),
      router: z.string(),
      dryRun: z.boolean(),
      pairCount: z.number(),
      results: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          status: z.string(),
          txHash: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
    async run(c) {
      const ca = getAddress(c.options.token) as Address
      const password = resolveAlmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'Password required' })

      const fromGroup = getGroup(password, c.options.fromGroup)
      const toGroup = getGroup(password, c.options.toGroup)
      if (!fromGroup || fromGroup.wallets.length === 0) {
        return c.error({ code: 'FROM_GROUP_NOT_FOUND', message: 'Source group not found or empty' })
      }
      if (!toGroup || toGroup.wallets.length === 0) {
        return c.error({ code: 'TO_GROUP_NOT_FOUND', message: 'Target group not found or empty' })
      }

      try { await assertSupportedToken(ca) } catch (err: any) {
        return c.error({ code: err.code ?? 'UNSUPPORTED', message: err.message })
      }

      const client = getPublicClient()
      const routerAddr = requireRouter()
      const config = loadConfig()
      const bnbWei = parseEther(c.options.amount.toString())
      const pairCount = Math.min(fromGroup.wallets.length, toGroup.wallets.length)

      // Compute slippage-protected minimum
      const { minTokenOut } = await computeTurnoverSlippage(
        client, ca, bnbWei, c.options.slippage,
      )

      const results: Array<{ from: string; to: string; status: string; txHash?: string; error?: string }> = []

      for (let i = 0; i < pairCount; i++) {
        const fromWallet = fromGroup.wallets[i]!
        const toWallet = toGroup.wallets[i]!

        if (c.options.dryRun) {
          results.push({ from: fromWallet.address, to: toWallet.address, status: 'ready' })
          continue
        }

        try {
          const pk = decryptPrivateKey(fromWallet, password)
          const account = privateKeyToAccount(pk)
          const wc = makeWalletClient(account, config)

          const hash = await wc.writeContract({
            address: routerAddr,
            abi: fourmemeMmRouterAbi,
            functionName: 'turnover',
            args: [ca, toWallet.address, minTokenOut],
            value: bnbWei,
            chain: wc.chain!,
            account,
          })

          trackInBackground(client, hash as Hash, {
            ca,
            groupId: c.options.fromGroup,
            walletAddress: account.address,
            txType: 'turnover',
          })

          results.push({
            from: fromWallet.address,
            to: toWallet.address,
            status: 'broadcast',
            txHash: hash,
          })
        } catch (err: any) {
          results.push({
            from: fromWallet.address,
            to: toWallet.address,
            status: 'failed',
            error: err.message,
          })
        }
      }

      return c.ok(
        {
          token: ca,
          fromGroup: c.options.fromGroup,
          toGroup: c.options.toGroup,
          router: routerAddr,
          dryRun: c.options.dryRun,
          pairCount,
          results,
        },
        {
          cta: {
            commands: [
              {
                command: 'query monitor',
                options: { group: c.options.toGroup, token: ca },
                description: 'Check target group holdings',
              },
            ],
          },
        },
      )
    },
  })
  // ============================================================
  // almm tools robot-price
  // ============================================================
  .command('robot-price', {
    description: 'Auto buy (up) or sell (down) until target price. Rotates wallets in group.',
    options: z.object({
      group: z.coerce.number().int().positive().describe('Wallet group ID'),
      token: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Token CA'),
      direction: z.enum(['up', 'down']).describe('up = buy, down = sell'),
      targetPrice: z.coerce.number().positive().describe('Target price in BNB per token'),
      amount: z.coerce.number().positive().default(0.01).describe('BNB per trade'),
      maxCost: z.coerce.number().positive().optional().describe('Max BNB to spend'),
      interval: z.coerce.number().int().min(1000).default(5000).describe('Delay between trades (ms)'),
      maxRounds: z.coerce.number().int().min(1).default(100).describe('Max trades'),
      slippage: z.coerce.number().int().min(1).max(5_000).default(500),
      dryRun: z.boolean().default(false),
      password: z.string().optional(),
    }),
    output: z.object({
      token: z.string(), direction: z.string(), targetPrice: z.number(),
      currentPrice: z.number(), reached: z.boolean(),
      totalTradesExecuted: z.number(), totalBnbSpent: z.number(),
      results: z.array(z.object({ round: z.number(), price: z.number(), status: z.string(), error: z.string().optional() })),
    }),
    async run(c) {
      const ca = getAddress(c.options.token) as Address
      const password = resolveAlmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'Password required' })
      const group = getGroup(password, c.options.group)
      if (!group || group.wallets.length === 0) return c.error({ code: 'GROUP_NOT_FOUND', message: 'Group not found' })
      try { await assertSupportedToken(ca) } catch (err: any) { return c.error({ code: err.code ?? 'UNSUPPORTED', message: err.message }) }
      const client = getPublicClient()
      const config = loadConfig()
      let totalSpent = 0
      const results: Array<{ round: number; price: number; status: string; error?: string }> = []
      for (let round = 1; round <= c.options.maxRounds; round++) {
        let currentPrice: number
        try { const p = await getTokenPrice(client, ca); currentPrice = p.priceBnb } catch { results.push({ round, price: 0, status: 'price-fetch-failed' }); break }
        if (c.options.direction === 'up' && currentPrice >= c.options.targetPrice) { results.push({ round, price: currentPrice, status: 'target-reached' }); break }
        if (c.options.direction === 'down' && currentPrice <= c.options.targetPrice) { results.push({ round, price: currentPrice, status: 'target-reached' }); break }
        if (c.options.maxCost && totalSpent >= c.options.maxCost) { results.push({ round, price: currentPrice, status: 'max-cost-reached' }); break }
        if (c.options.dryRun) { results.push({ round, price: currentPrice, status: 'dry-run-would-trade' }); if (round < c.options.maxRounds) await sleep(Math.min(c.options.interval, 1000)); continue }
        const walletIdx = (round - 1) % group.wallets.length
        const w = group.wallets[walletIdx]!
        try {
          const pk = decryptPrivateKey(w, password); const account = privateKeyToAccount(pk); const wc = makeWalletClient(account, config)
          let routing; try { routing = await resolveTradingPath(client, ca) } catch (err: any) { results.push({ round, price: currentPrice, status: 'routing-failed', error: err.message }); break }
          if (c.options.direction === 'up') {
            const bnbWei = parseEther(c.options.amount.toString())
            const tryR = await client.readContract({ address: TOKEN_MANAGER_HELPER3, abi: tokenManagerHelper3Abi, functionName: 'tryBuy', args: [ca, 0n, bnbWei] })
            const minAmount = (tryR[2] * (10_000n - BigInt(c.options.slippage))) / 10_000n
            await wc.writeContract({ address: routing.tradingPath.router, abi: tokenManager2Abi, functionName: 'buyTokenAMAP', args: [ca, bnbWei, minAmount], value: bnbWei, chain: wc.chain!, account })
            totalSpent += c.options.amount
          } else {
            const balance = await client.readContract({ address: ca, abi: erc20Abi, functionName: 'balanceOf', args: [w.address] })
            if (balance === 0n) { results.push({ round, price: currentPrice, status: 'no-balance' }); continue }
            const sellFrac = Math.min(c.options.amount, 1)
            const sellAmount = (balance * BigInt(Math.round(sellFrac * 10000))) / 10_000n
            if (sellAmount === 0n) { results.push({ round, price: currentPrice, status: 'sell-amount-zero' }); continue }
            const approveHash = await wc.writeContract({ address: ca, abi: erc20Abi, functionName: 'approve', args: [routing.tradingPath.router, sellAmount], chain: wc.chain!, account })
            await client.waitForTransactionReceipt({ hash: approveHash as `0x${string}`, timeout: 30_000 })
            await wc.writeContract({ address: routing.tradingPath.router, abi: tokenManager2Abi, functionName: 'sellToken', args: [ca, sellAmount], chain: wc.chain!, account })
          }
          results.push({ round, price: currentPrice, status: 'executed' })
        } catch (err: any) { results.push({ round, price: currentPrice, status: 'failed', error: err.message }) }
        if (round < c.options.maxRounds) await sleep(c.options.interval)
      }
      const lastPrice = results.length > 0 ? results[results.length - 1]!.price : 0
      const reached = c.options.direction === 'up' ? lastPrice >= c.options.targetPrice : lastPrice <= c.options.targetPrice
      return c.ok({ token: ca, direction: c.options.direction, targetPrice: c.options.targetPrice, currentPrice: lastPrice, reached, totalTradesExecuted: results.filter(r => r.status === 'executed').length, totalBnbSpent: totalSpent, results }, { cta: { commands: [{ command: 'query monitor', options: { group: c.options.group, token: ca }, description: 'Check PnL' }] } })
    },
  })
