/**
 * `almm query` command group — read-only data queries.
 *
 * Week 2 scope: balance, price.
 * Week 2 later: kline, transactions, monitor (deferred).
 */

import { Cli, z } from 'incur'
import {
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  type Address,
} from 'viem'
import { erc20Abi } from '../contracts/erc20.js'
import { loadConfig } from '../lib/config.js'
import { getDataStore } from '../datastore/index.js'
import { getTokenPrice } from '../lib/pricing.js'
import { getPublicClient } from '../lib/viem.js'

export const query = Cli.create('query', {
  description: 'Read-only data queries (balance, price, etc.)',
})
  // ============================================================
  // almm query balance
  // ============================================================
  .command('balance', {
    description:
      'Query BNB or BEP20 token balance for an arbitrary address.',
    options: z.object({
      address: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, 'Expected a 40-hex-char 0x-prefixed address')
        .describe('Wallet address to query'),
      token: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, 'Expected a 40-hex-char 0x-prefixed address')
        .optional()
        .describe('Token contract (omit for BNB balance)'),
    }),
    examples: [
      {
        options: { address: '0x802CF8e2673f619c486a2950feE3D24f8A074444' },
        description: 'Check BNB balance of any address',
      },
      {
        options: {
          address: '0xfBCCeE34bF2a8cc561482bcABe0fFE6081E7cEE6',
          token: '0x802CF8e2673f619c486a2950feE3D24f8A074444',
        },
        description: 'Check BEP20 balance for a wallet+token',
      },
    ],
    output: z.object({
      address: z.string(),
      token: z.string(),
      symbol: z.string(),
      decimals: z.number(),
      balance: z.string(),
      raw: z.string(),
    }),
    async run(c) {
      if (!isAddress(c.options.address)) {
        return c.error({
          code: 'INVALID_ADDRESS',
          message: `"${c.options.address}" is not a valid address`,
        })
      }

      const address = getAddress(c.options.address) as Address
      const client = getPublicClient()

      // ---- BNB ----
      if (!c.options.token) {
        try {
          const wei = await client.getBalance({ address })
          return c.ok({
            address,
            token: 'BNB',
            symbol: 'BNB',
            decimals: 18,
            balance: formatEther(wei),
            raw: wei.toString(),
          })
        } catch (err) {
          return c.error({
            code: 'RPC_READ_FAILED',
            message:
              err instanceof Error ? err.message : `getBalance(${address}) failed`,
          })
        }
      }

      // ---- BEP20 ----
      const token = getAddress(c.options.token) as Address
      try {
        const [raw, decimals, symbol] = await Promise.all([
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
          }),
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'decimals',
          }),
          client
            .readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'symbol',
            })
            .catch(() => 'UNKNOWN'),
        ])
        return c.ok({
          address,
          token,
          symbol,
          decimals: Number(decimals),
          balance: formatUnits(raw, Number(decimals)),
          raw: raw.toString(),
        })
      } catch (err) {
        return c.error({
          code: 'RPC_READ_FAILED',
          message:
            err instanceof Error
              ? `balanceOf(${token}, ${address}) failed: ${err.message}`
              : `balanceOf failed`,
        })
      }
    },
  })
  // ============================================================
  // almm query price
  // ============================================================
  .command('price', {
    description:
      'Get live price for a Four.meme token (bonding curve or graduated PancakeSwap).',
    options: z.object({
      token: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, 'Expected a 40-hex-char 0x-prefixed address')
        .describe('Token contract address'),
    }),
    examples: [
      {
        options: { token: '0x802CF8e2673f619c486a2950feE3D24f8A074444' },
        description: 'Query price of a live Four.meme token',
      },
    ],
    output: z.object({
      token: z.string(),
      path: z.string(),
      origin: z.string(),
      priceBnb: z.number(),
      priceUsd: z.number(),
      liquidityAdded: z.boolean(),
      updatedAt: z.number(),
    }),
    async run(c) {
      if (!isAddress(c.options.token)) {
        return c.error({
          code: 'INVALID_ADDRESS',
          message: `"${c.options.token}" is not a valid address`,
        })
      }

      const token = getAddress(c.options.token) as Address
      const client = getPublicClient()

      try {
        const price = await getTokenPrice(client, token)
        return c.ok(
          {
            token: price.ca,
            path: price.path,
            origin: price.origin,
            priceBnb: price.priceBnb,
            priceUsd: price.priceUsd,
            liquidityAdded: price.liquidityAdded,
            updatedAt: price.updatedAt,
          },
          {
            cta: {
              commands: [
                {
                  command: 'token info',
                  options: { ca: token },
                  description: 'See full token metadata',
                },
                {
                  command: 'token graduate-status',
                  options: { ca: token },
                  description: 'Check bonding curve progress',
                },
              ],
            },
          },
        )
      } catch (err) {
        return c.error({
          code: 'PRICE_READ_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })
  // ============================================================
  // almm query transactions
  // ============================================================
  .command('transactions', {
    description: 'Show local transaction history for a wallet group (from DataStore).',
    options: z.object({
      group: z.coerce.number().int().positive().describe('Wallet group ID'),
      token: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().describe('Filter by token CA'),
      limit: z.coerce.number().int().min(1).default(20).describe('Max rows'),
    }),
    output: z.object({
      group: z.number(), count: z.number(),
      transactions: z.array(z.object({
        txHash: z.string(), txType: z.string(), wallet: z.string(),
        amountBnb: z.number(), amountToken: z.number(), status: z.string(), blockTime: z.number(),
      })),
    }),
    run(c) {
      const ds = getDataStore()
      if (c.options.token) {
        const ca = getAddress(c.options.token) as Address
        const file = ds.getTransactions(ca, c.options.group)
        const txs = (file?.transactions ?? []).sort((a, b) => b.blockTime - a.blockTime).slice(0, c.options.limit)
        return c.ok({ group: c.options.group, count: txs.length, transactions: txs.map((t) => ({ txHash: t.txHash, txType: t.txType, wallet: t.walletAddress, amountBnb: t.amountBnb, amountToken: t.amountToken, status: t.status, blockTime: t.blockTime })) })
      }
      const allTokens = ds.listTokens()
      const allTxs: any[] = []
      for (const ca of allTokens) {
        const file = ds.getTransactions(ca, c.options.group)
        if (!file) continue
        for (const t of file.transactions) allTxs.push({ txHash: t.txHash, txType: t.txType, wallet: t.walletAddress, token: ca, amountBnb: t.amountBnb, amountToken: t.amountToken, status: t.status, blockTime: t.blockTime })
      }
      allTxs.sort((a, b) => b.blockTime - a.blockTime)
      return c.ok({ group: c.options.group, count: Math.min(allTxs.length, c.options.limit), transactions: allTxs.slice(0, c.options.limit) })
    },
  })
  // ============================================================
  // almm query monitor
  // ============================================================
  .command('monitor', {
    description: 'Show holdings + real-time PnL for a wallet group on a specific token.',
    options: z.object({
      group: z.coerce.number().int().positive().describe('Wallet group ID'),
      token: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Token CA'),
    }),
    output: z.object({
      group: z.number(), token: z.string(), priceBnb: z.number(), priceUsd: z.number(),
      wallets: z.array(z.object({
        address: z.string(), tokenBalance: z.number(), avgBuyPrice: z.number(),
        totalCostBnb: z.number(), realizedPnl: z.number(), unrealizedPnl: z.number(), currentValueBnb: z.number(),
      })),
      totalRealizedPnl: z.number(), totalUnrealizedPnl: z.number(), totalValueBnb: z.number(),
    }),
    async run(c) {
      const ca = getAddress(c.options.token) as Address
      const client = getPublicClient()
      const ds = getDataStore()
      let priceBnb = 0; let priceUsd = 0
      try { const price = await getTokenPrice(client, ca); priceBnb = price.priceBnb; priceUsd = price.priceUsd } catch { /* price unavailable */ }
      const holdings = ds.getHoldings(ca, c.options.group)
      const walletHoldings = holdings?.wallets ?? []
      let totalRealizedPnl = 0; let totalUnrealizedPnl = 0; let totalValueBnb = 0
      const wallets = walletHoldings.map((w) => {
        const currentValue = w.tokenBalance * priceBnb
        const unrealized = currentValue - w.tokenBalance * w.avgBuyPrice
        totalRealizedPnl += w.realizedPnl; totalUnrealizedPnl += unrealized; totalValueBnb += currentValue
        return { address: w.walletAddress, tokenBalance: w.tokenBalance, avgBuyPrice: w.avgBuyPrice, totalCostBnb: w.totalCostBnb, realizedPnl: w.realizedPnl, unrealizedPnl: unrealized, currentValueBnb: currentValue }
      })
      return c.ok({ group: c.options.group, token: ca, priceBnb, priceUsd, wallets, totalRealizedPnl, totalUnrealizedPnl, totalValueBnb }, {
        cta: { commands: [
          { command: 'trade sell', options: { group: c.options.group, token: ca, amount: 'all' }, description: 'Exit all positions' },
          { command: 'query transactions', options: { group: c.options.group, token: ca }, description: 'View trade history' },
        ] },
      })
    },
  })
  // ============================================================
  // almm query kline
  // ============================================================
  .command('kline', {
    description: 'Fetch OHLCV candle data from GeckoTerminal for a graduated token.',
    options: z.object({
      token: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Token contract address'),
      pool: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().describe('Pool address (auto-resolved from DataStore if omitted)'),
      interval: z.enum(['1m', '5m', '15m', '1h', '4h', '12h', '1d']).default('1h').describe('Candle interval'),
      count: z.coerce.number().int().min(1).max(1000).default(50).describe('Number of candles'),
    }),
    output: z.object({
      token: z.string(),
      pool: z.string(),
      interval: z.string(),
      count: z.number(),
      candles: z.array(z.object({
        timestamp: z.number(),
        open: z.number(),
        high: z.number(),
        low: z.number(),
        close: z.number(),
        volume: z.number(),
      })),
    }),
    async run(c) {
      const ca = getAddress(c.options.token) as Address
      const config = loadConfig()
      const ds = getDataStore()

      // Resolve pool address
      let poolAddr = c.options.pool
      if (!poolAddr) {
        const poolInfo = ds.getPoolInfo(ca)
        if (poolInfo?.pairAddress) {
          poolAddr = poolInfo.pairAddress
        }
      }
      if (!poolAddr) {
        return c.error({
          code: 'NO_POOL',
          message: 'No pool address known. Pass --pool or run `query price` first to populate DataStore.',
        })
      }

      // Map interval to GeckoTerminal timeframe
      const timeframeMap: Record<string, string> = { '1m': 'minute', '5m': 'minute', '15m': 'minute', '1h': 'hour', '4h': 'hour', '12h': 'hour', '1d': 'day' }
      const aggregateMap: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 1, '4h': 4, '12h': 12, '1d': 1 }
      const timeframe = timeframeMap[c.options.interval] ?? 'hour'
      const aggregate = aggregateMap[c.options.interval] ?? 1

      const url = `${config.geckoTerminalUrl}/networks/bsc/pools/${poolAddr}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${c.options.count}`

      type OhlcvResponse = { data?: { attributes?: { ohlcv_list?: number[][] } } }
      let candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> = []

      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } })
        if (!res.ok) return c.error({ code: 'GECKO_FETCH_FAILED', message: `GeckoTerminal returned ${res.status}` })
        const json = (await res.json()) as OhlcvResponse
        const raw = json.data?.attributes?.ohlcv_list ?? []
        candles = raw.map((r) => ({
          timestamp: r[0]!,
          open: r[1]!,
          high: r[2]!,
          low: r[3]!,
          close: r[4]!,
          volume: r[5]!,
        }))
      } catch (err) {
        return c.error({ code: 'GECKO_FETCH_FAILED', message: err instanceof Error ? err.message : String(err) })
      }

      return c.ok(
        { token: ca, pool: poolAddr, interval: c.options.interval, count: candles.length, candles },
        { cta: { commands: [
          { command: 'query price', options: { token: ca }, description: 'Current price' },
          { command: 'token info', options: { ca }, description: 'Token metadata' },
        ] } },
      )
    },
  })
