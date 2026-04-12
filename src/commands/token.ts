/**
 * `almm token` command group — Four.meme token operations.
 *
 * Week 1 scope: `token info` only. The other 4 token commands
 * (create, pool, identify, graduate-status) arrive in Weeks 2-3.
 */

import { Cli, z } from 'incur'
import {
  createWalletClient,
  fallback,
  formatEther,
  formatUnits,
  http,
  isAddress,
  getAddress,
  parseEther,
  type Address,
  type Hash,
  type Hex,
  type ReadContractReturnType,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc, bscTestnet } from 'viem/chains'
import {
  TOKEN_MANAGER_HELPER3,
  TOKEN_MANAGER_V2,
  isFourmemeNativeAddress,
} from '../lib/const.js'
import { loadConfig } from '../lib/config.js'
import { tokenManagerHelper3Abi } from '../contracts/tokenManagerHelper3.js'
import { tokenManager2Abi } from '../contracts/tokenManager2.js'
import { identifyToken } from '../lib/identify.js'
import { resolveAlmmPassword, resolveOwsPassphrase } from '../lib/env.js'
import { trackInBackground } from '../lib/tracker.js'
import { getPublicClient } from '../lib/viem.js'
import { authenticateFourmeme } from '../fourmeme/auth.js'
import { uploadTokenImage } from '../fourmeme/upload.js'
import { createTokenOnApi } from '../fourmeme/create.js'
import { decryptPrivateKey, getGroup } from '../wallets/groups/store.js'
import {
  BSC_CHAIN_ID,
  treasuryToViemAccount,
} from '../wallets/treasury.js'

type GetTokenInfoResult = ReadContractReturnType<
  typeof tokenManagerHelper3Abi,
  'getTokenInfo'
>

export const token = Cli.create('token', {
  description: 'Four.meme token operations (info, identify, graduate-status, …)',
})
  // ============================================================
  // almm token identify
  // ============================================================
  .command('identify', {
    description:
      'Classify a token (standard / anti-sniper-fee / tax-token / x-mode) via the Four.meme REST API. ALMM will REFUSE to trade tax-token or x-mode.',
    options: z.object({
      ca: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, 'Expected a 40-hex-char 0x-prefixed address')
        .describe('Token contract address'),
    }),
    examples: [
      {
        options: { ca: '0x802CF8e2673f619c486a2950feE3D24f8A074444' },
        description: 'Classify a Four.meme token',
      },
    ],
    output: z.object({
      ca: z.string(),
      variant: z.string(),
      supported: z.boolean(),
      source: z.string(),
      aiCreator: z.boolean().optional(),
      note: z.string().optional(),
    }),
    async run(c) {
      if (!isAddress(c.options.ca)) {
        return c.error({
          code: 'INVALID_ADDRESS',
          message: `"${c.options.ca}" is not a valid address`,
        })
      }
      const ca = getAddress(c.options.ca) as Address

      const result = await identifyToken(ca)

      // A token is only "supported" when:
      //   1. The Four.meme API gave us a real classification (source === 'api')
      //   2. AND the variant is one of the two we actively trade
      //
      // If source is 'not-found', the token doesn't exist on Four.meme at
      // all — even though identifyToken returns variant='standard' as a
      // default, it's NOT a supported token. Agents that only check the
      // variant field would be misled.
      const supported =
        result.source === 'api' &&
        (result.variant === 'standard' || result.variant === 'anti-sniper-fee')

      const note = (() => {
        if (result.source === 'not-found') {
          return (
            'Token is not registered with Four.meme. The address may be ' +
            'wrong, or this token predates the API we query. ALMM will ' +
            'refuse to trade it.'
          )
        }
        if (result.source === 'fallback-network') {
          return (
            'Four.meme API is unreachable — classification defaulted to ' +
            'standard. Downstream trade commands will validate via RPC ' +
            'before signing.'
          )
        }
        if (result.variant === 'tax-token') {
          return 'TaxToken is out of scope — ALMM refuses to market-make on TaxTokens because each round-trip costs 2× the fee rate (10% on a 5% tax). This is by design.'
        }
        if (result.variant === 'x-mode') {
          return 'X Mode token uses a special encoded-args buy interface that ALMM does not implement.'
        }
        if (result.variant === 'anti-sniper-fee') {
          return 'Dynamic fee decreases block-by-block post-launch. Slippage should be set higher in the first few blocks.'
        }
        return undefined
      })()

      const aiCreator = result.raw?.data?.aiCreator ?? false

      return c.ok(
        {
          ca,
          variant: result.variant,
          supported,
          source: result.source,
          aiCreator,
          ...(note ? { note } : {}),
        },
        {
          cta: supported
            ? {
                commands: [
                  { command: 'token info', options: { ca }, description: 'See full token metadata' },
                  { command: 'query price', options: { token: ca }, description: 'Get current price' },
                ],
              }
            : {
                commands: [
                  { command: 'token info', options: { ca }, description: 'Inspect metadata anyway' },
                ],
              },
        },
      )
    },
  })
  // ============================================================
  // almm token graduate-status
  // ============================================================
  .command('graduate-status', {
    description:
      'Show bonding curve graduation progress — offers / maxOffers / funds / maxFunds / liquidityAdded. Useful for timing exits before a token graduates.',
    options: z.object({
      ca: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, 'Expected a 40-hex-char 0x-prefixed address')
        .describe('Token contract address'),
    }),
    examples: [
      {
        options: { ca: '0x802CF8e2673f619c486a2950feE3D24f8A074444' },
        description: 'Check graduation progress',
      },
    ],
    output: z.object({
      ca: z.string(),
      offers: z.string(),
      maxOffers: z.string(),
      funds: z.string(),
      maxFunds: z.string(),
      progressBps: z.number(),
      progress: z.string(),
      liquidityAdded: z.boolean(),
      tradeable: z.boolean(),
    }),
    async run(c) {
      if (!isAddress(c.options.ca)) {
        return c.error({
          code: 'INVALID_ADDRESS',
          message: `"${c.options.ca}" is not a valid address`,
        })
      }
      const ca = getAddress(c.options.ca) as Address
      const client = getPublicClient()

      let info: GetTokenInfoResult
      try {
        info = await client.readContract({
          address: TOKEN_MANAGER_HELPER3,
          abi: tokenManagerHelper3Abi,
          functionName: 'getTokenInfo',
          args: [ca],
        })
      } catch (err) {
        return c.error({
          code: 'RPC_READ_FAILED',
          message:
            err instanceof Error
              ? `getTokenInfo(${ca}) failed: ${err.message}`
              : `getTokenInfo(${ca}) failed`,
        })
      }

      const version = info[0]
      const launchTime = info[6]
      const offers = info[7]
      const maxOffers = info[8]
      const funds = info[9]
      const maxFunds = info[10]
      const liquidityAdded = info[11]

      if (version === 0n) {
        return c.error({
          code: 'NOT_FOUND',
          message: `Token ${ca} is not registered with Four.meme`,
        })
      }

      // BigInt math for graduation percentage
      const progressBps = maxFunds > 0n ? Number((funds * 10_000n) / maxFunds) : 0
      const progress = `${(progressBps / 100).toFixed(2)}%`

      const launchTimeUnix = Number(launchTime)
      const nowUnix = Math.floor(Date.now() / 1000)
      const tradeable = launchTime > 0n && launchTimeUnix <= nowUnix

      return c.ok(
        {
          ca,
          offers: formatUnits(offers, 18),
          maxOffers: formatUnits(maxOffers, 18),
          funds: `${formatEther(funds)} BNB`,
          maxFunds: `${formatEther(maxFunds)} BNB`,
          progressBps,
          progress,
          liquidityAdded,
          tradeable,
        },
        {
          cta: liquidityAdded
            ? {
                commands: [
                  {
                    command: 'query price',
                    options: { token: ca },
                    description: 'Already graduated — check PancakeSwap price',
                  },
                ],
              }
            : {
                commands: [
                  {
                    command: 'query price',
                    options: { token: ca },
                    description: 'Current bonding curve price',
                  },
                ],
              },
        },
      )
    },
  })
  // ============================================================
  // almm token info
  // ============================================================
  .command('info', {
    description:
      'Fetch live on-chain info for a Four.meme token via TokenManagerHelper3.',
    options: z.object({
      ca: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, 'Expected a 40-hex-char 0x-prefixed address')
        .describe('Token contract address'),
    }),
    examples: [
      {
        options: { ca: '0x0000000000000000000000000000000000004444' },
        description: 'Look up a specific Four.meme token',
      },
    ],
    output: z.object({
      ca: z.string(),
      fourmemeNative: z.boolean(),
      version: z.number(),
      tokenManager: z.string(),
      quote: z.string(),
      quoteSymbol: z.string(),
      lastPrice: z.string(),
      tradingFeeRate: z.string(),
      minTradingFee: z.string(),
      launchTime: z.string(),
      launchTimeUnix: z.number(),
      tradeable: z.boolean().describe(
        'True when launchTime has passed. If false, the token exists but trading is not yet open; `trade buy` will revert.',
      ),
      offers: z.string(),
      maxOffers: z.string(),
      funds: z.string(),
      maxFunds: z.string(),
      graduationProgress: z.string(),
      liquidityAdded: z.boolean(),
    }),
    async run(c) {
      if (!isAddress(c.options.ca)) {
        return c.error({
          code: 'INVALID_ADDRESS',
          message: `"${c.options.ca}" is not a valid address`,
        })
      }

      const ca = getAddress(c.options.ca) as Address

      const client = getPublicClient()
      let info: GetTokenInfoResult
      try {
        info = await client.readContract({
          address: TOKEN_MANAGER_HELPER3,
          abi: tokenManagerHelper3Abi,
          functionName: 'getTokenInfo',
          args: [ca],
        })
      } catch (err) {
        return c.error({
          code: 'RPC_READ_FAILED',
          message:
            err instanceof Error
              ? `getTokenInfo(${ca}) failed: ${err.message}`
              : `getTokenInfo(${ca}) failed`,
        })
      }

      const [
        version,
        tokenManager,
        quote,
        lastPrice,
        tradingFeeRate,
        minTradingFee,
        launchTime,
        offers,
        maxOffers,
        funds,
        maxFunds,
        liquidityAdded,
      ] = info

      // Version 0 usually means "token not registered" — no such token on Four.meme
      if (version === 0n) {
        return c.error({
          code: 'NOT_FOUND',
          message: `Token ${ca} is not registered in Four.meme's TokenManager. Either the address is wrong or the token predates TokenManager V2.`,
        })
      }

      // Quote address(0) means the token is priced in BNB
      const quoteSymbol =
        quote === '0x0000000000000000000000000000000000000000' ? 'BNB' : 'BEP20'

      // Launch time is Unix seconds. If zero, the token is registered but
      // the launchTime is unset (rare — treat as "not yet tradeable").
      const launchTimeUnix = Number(launchTime)
      const launchIso =
        launchTime > 0n ? new Date(launchTimeUnix * 1000).toISOString() : '—'

      const nowUnix = Math.floor(Date.now() / 1000)
      const tradeable = launchTime > 0n && launchTimeUnix <= nowUnix

      // Graduation progress = funds / maxFunds.
      // Both are 18-decimal bigints. At target (24 BNB = 2.4e19 wei) they exceed
      // Number.MAX_SAFE_INTEGER (~9e15), so convert to basis points with BigInt
      // math first, then coerce to Number for display.
      const progress = (() => {
        if (maxFunds === 0n) return '—'
        const bps = (funds * 10_000n) / maxFunds
        return `${(Number(bps) / 100).toFixed(2)}%`
      })()

      return c.ok(
        {
          ca,
          fourmemeNative: isFourmemeNativeAddress(ca),
          version: Number(version),
          tokenManager,
          quote,
          quoteSymbol,
          // lastPrice is in wei of quote per token smallest-unit
          lastPrice: lastPrice.toString(),
          tradingFeeRate: `${(Number(tradingFeeRate) / 100).toFixed(2)}%`,
          minTradingFee: `${formatEther(minTradingFee)} ${quoteSymbol}`,
          launchTime: launchIso,
          launchTimeUnix,
          tradeable,
          offers: formatUnits(offers, 18),
          maxOffers: formatUnits(maxOffers, 18),
          funds: `${formatEther(funds)} ${quoteSymbol}`,
          maxFunds: `${formatEther(maxFunds)} ${quoteSymbol}`,
          graduationProgress: progress,
          liquidityAdded,
        },
        {
          cta: liquidityAdded
            ? {
                commands: [
                  {
                    command: 'query price',
                    options: { token: ca },
                    description: 'This token has graduated — check PancakeSwap price',
                  },
                ],
              }
            : {
                commands: [
                  {
                    command: 'query price',
                    options: { token: ca },
                    description: 'Check bonding curve price',
                  },
                  {
                    command: 'token graduate-status',
                    options: { ca },
                    description: 'View detailed graduation progress',
                  },
                ],
              },
        },
      )
    },
  })
  // ============================================================
  // almm token create
  // ============================================================
  .command('create', {
    description:
      'Create a new Four.meme token. Authenticates via REST API, uploads image, registers token, then calls TokenManager2.createToken on-chain. Optionally does a dev-buy immediately after.',
    options: z.object({
      name: z.string().min(1).describe('Token name'),
      symbol: z.string().min(1).describe('Token symbol'),
      image: z.string().describe('Path to logo image file'),
      description: z.string().default('').describe('Token description'),
      category: z.enum(['Meme', 'AI', 'Defi', 'Games', 'Infra', 'De-Sci', 'Social', 'Depin', 'Charity', 'Others']).default('Meme'),
      twitter: z.string().optional(),
      website: z.string().optional(),
      telegram: z.string().optional(),
      presetBuy: z.coerce.number().min(0).default(0).describe('BNB for dev buy after creation. NOTE: dev buy is a separate tx (not atomic with create). Set 0 to skip.'),
      devWallet: z.coerce.number().int().positive().optional().describe('Group ID for dev wallet (uses first wallet). Required for on-chain tx.'),
      dryRun: z.boolean().default(false).describe('REST API only — skip on-chain createToken'),
      password: z.string().optional(),
      owsPassphrase: z.string().optional(),
    }),
    output: z.object({
      name: z.string(),
      symbol: z.string(),
      imageUrl: z.string(),
      dryRun: z.boolean(),
      createArg: z.string().optional(),
      txHash: z.string().optional(),
      devBuyTxHash: z.string().optional(),
      message: z.string(),
    }),
    async run(c) {
      // Resolve the dev wallet private key for signing
      const almmPassword = resolveAlmmPassword(c.options.password)
      let devPrivateKey: Hex | undefined
      let devAddress: Address | undefined

      if (c.options.devWallet) {
        if (!almmPassword) {
          return c.error({ code: 'NO_PASSWORD', message: 'Password required for dev wallet' })
        }
        const group = getGroup(almmPassword, c.options.devWallet)
        if (!group || group.wallets.length === 0) {
          return c.error({ code: 'GROUP_NOT_FOUND', message: `Dev wallet group ${c.options.devWallet} not found` })
        }
        devPrivateKey = decryptPrivateKey(group.wallets[0]!, almmPassword)
        devAddress = group.wallets[0]!.address
      } else if (!c.options.dryRun) {
        return c.error({
          code: 'DEV_WALLET_REQUIRED',
          message: 'On-chain token creation requires --dev-wallet <groupId>. Use --dry-run to test REST flow only.',
        })
      }

      // Step 1: Authenticate with Four.meme
      let auth
      try {
        if (!devPrivateKey) {
          return c.error({ code: 'NO_KEY', message: 'Dev wallet private key required for REST auth' })
        }
        auth = await authenticateFourmeme(devPrivateKey)
      } catch (err) {
        return c.error({
          code: 'AUTH_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      // Step 2: Upload image
      let imageUrl: string
      try {
        const result = await uploadTokenImage(c.options.image, auth.accessToken)
        imageUrl = result.imageUrl
      } catch (err) {
        return c.error({
          code: 'UPLOAD_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      // Step 3: Register token via REST API
      let createResult
      try {
        createResult = await createTokenOnApi(
          {
            name: c.options.name,
            symbol: c.options.symbol,
            description: c.options.description,
            imageUrl,
            category: c.options.category,
            twitter: c.options.twitter,
            website: c.options.website,
            telegram: c.options.telegram,
          },
          auth.accessToken,
        )
      } catch (err) {
        return c.error({
          code: 'CREATE_API_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      if (c.options.dryRun) {
        return c.ok({
          name: c.options.name,
          symbol: c.options.symbol,
          imageUrl,
          dryRun: true,
          createArg: createResult.createArg.slice(0, 40) + '...',
          message: 'REST API succeeded. Pass without --dry-run to submit on-chain.',
        })
      }

      // Step 4: On-chain createToken
      const config = loadConfig()
      const account = privateKeyToAccount(devPrivateKey!)
      const chain = config.network === 'bsc-testnet' ? bscTestnet : bsc
      const transports = [config.rpcUrl, ...config.fallbackRpcUrls]
        .filter((url): url is string => Boolean(url))
        .map((url) => http(url, { timeout: 15_000 }))
      const walletClient = createWalletClient({
        account,
        chain,
        transport: fallback(transports, { rank: false }),
      })
      const publicClient = getPublicClient()

      let txHash: Hash
      try {
        txHash = await walletClient.writeContract({
          address: TOKEN_MANAGER_V2,
          abi: tokenManager2Abi,
          functionName: 'createToken',
          args: [
            createResult.createArg as Hex,
            createResult.signature as Hex,
          ],
          value: parseEther('0.01'), // creation fee (~0.005 BNB + buffer)
          chain,
          account,
        })
      } catch (err) {
        return c.error({
          code: 'CREATE_TX_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      // Step 5: Optional dev buy (separate tx — not atomic with create)
      let devBuyTxHash: string | undefined
      if (c.options.presetBuy > 0) {
        // Wait for creation to confirm so we can parse the token address
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: txHash,
            timeout: 60_000,
          })

          // Parse TokenCreate event to extract the new token address.
          // The event is: TokenCreate(creator, token, requestId, name, symbol, totalSupply, launchTime, launchFee)
          // token is the second parameter (index 1).
          const createEventSig = '0x' // We match by topic — TokenCreate has no indexed params in V2
          // Look for the log from TokenManager2 that has enough data
          const tmLogs = receipt.logs.filter(
            (l) => l.address.toLowerCase() === TOKEN_MANAGER_V2.toLowerCase(),
          )
          // The token address is encoded in the event data. For simplicity,
          // try to decode the second 32-byte word as an address.
          let newTokenAddress: Address | undefined
          for (const log of tmLogs) {
            if (log.data.length >= 130) {
              // data layout: creator(32) + token(32) + ...
              const tokenWord = '0x' + log.data.slice(66, 130)
              const addr = '0x' + tokenWord.slice(26) // last 20 bytes
              if (addr.length === 42) {
                newTokenAddress = getAddress(addr) as Address
                break
              }
            }
          }

          if (newTokenAddress) {
            // Dev buy: use buyTokenAMAP on the new token
            const buyBnbWei = parseEther(c.options.presetBuy.toString())
            try {
              const buyHash = await walletClient.writeContract({
                address: TOKEN_MANAGER_V2,
                abi: tokenManager2Abi,
                functionName: 'buyTokenAMAP',
                args: [newTokenAddress, buyBnbWei, 0n], // minAmount=0 for immediate dev buy
                value: buyBnbWei,
                chain,
                account,
              })
              devBuyTxHash = buyHash

              trackInBackground(publicClient, buyHash as Hash, {
                ca: newTokenAddress,
                groupId: c.options.devWallet!,
                walletAddress: account.address,
                txType: 'buy',
                knownAmountBnb: -c.options.presetBuy,
              })
            } catch (buyErr) {
              // Dev buy failed but create succeeded — report both
              devBuyTxHash = `FAILED: ${buyErr instanceof Error ? buyErr.message : String(buyErr)}`
            }
          }
        } catch {
          // Creation not confirmed in time — skip dev buy
          devBuyTxHash = 'SKIPPED: creation receipt timeout'
        }
      }

      return c.ok(
        {
          name: c.options.name,
          symbol: c.options.symbol,
          imageUrl,
          dryRun: false,
          txHash,
          devBuyTxHash,
          message: devBuyTxHash
            ? `Token created + dev buy broadcast. Check BSCScan for details.`
            : `Token creation tx broadcast. Check BSCScan for the new token address.`,
        },
        {
          cta: {
            commands: [
              {
                command: 'query balance',
                options: { address: devAddress ?? '' },
                description: 'Check dev wallet balance after creation',
              },
            ],
          },
        },
      )
    },
  })
  // ============================================================
  // almm token pool
  // ============================================================
  .command('pool', {
    description: 'Show pool / liquidity info for a token via TokenManagerHelper3.',
    options: z.object({
      ca: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Token contract address'),
    }),
    output: z.object({
      ca: z.string(),
      version: z.number(),
      tokenManager: z.string(),
      quote: z.string(),
      quoteSymbol: z.string(),
      lastPrice: z.string(),
      tradingFeeRate: z.string(),
      funds: z.string(),
      maxFunds: z.string(),
      offers: z.string(),
      maxOffers: z.string(),
      liquidityAdded: z.boolean(),
      graduationProgress: z.string(),
    }),
    async run(c) {
      if (!isAddress(c.options.ca)) {
        return c.error({ code: 'INVALID_ADDRESS', message: `"${c.options.ca}" is not a valid address` })
      }
      const ca = getAddress(c.options.ca) as Address
      const client = getPublicClient()

      type GetTokenInfoResult = readonly [
        bigint, Address, Address,
        bigint, bigint, bigint, bigint,
        bigint, bigint, bigint, bigint, boolean,
      ]
      let info: GetTokenInfoResult
      try {
        info = await client.readContract({
          address: TOKEN_MANAGER_HELPER3,
          abi: tokenManagerHelper3Abi,
          functionName: 'getTokenInfo',
          args: [ca],
        }) as GetTokenInfoResult
      } catch (err) {
        return c.error({ code: 'RPC_READ_FAILED', message: err instanceof Error ? `getTokenInfo(${ca}) failed: ${err.message}` : `getTokenInfo(${ca}) failed` })
      }

      const [version, tokenManager, quote, lastPrice, tradingFeeRate, _minFee, _launchTime, offers, maxOffers, funds, maxFunds, liquidityAdded] = info

      if (version === 0n) {
        return c.error({ code: 'NOT_FOUND', message: `Token ${ca} is not registered with Four.meme` })
      }

      const quoteSymbol = quote === '0x0000000000000000000000000000000000000000' ? 'BNB' : 'BEP20'
      const progressBps = maxFunds > 0n ? Number((funds * 10_000n) / maxFunds) : 0
      const progress = `${(progressBps / 100).toFixed(2)}%`

      return c.ok(
        {
          ca,
          version: Number(version),
          tokenManager,
          quote,
          quoteSymbol,
          lastPrice: lastPrice.toString(),
          tradingFeeRate: `${(Number(tradingFeeRate) / 100).toFixed(2)}%`,
          funds: `${formatEther(funds)} ${quoteSymbol}`,
          maxFunds: `${formatEther(maxFunds)} ${quoteSymbol}`,
          offers: formatUnits(offers, 18),
          maxOffers: formatUnits(maxOffers, 18),
          liquidityAdded,
          graduationProgress: progress,
        },
        {
          cta: {
            commands: [
              { command: 'query price', options: { token: ca }, description: 'Get current price' },
              { command: 'token graduate-status', options: { ca }, description: 'Detailed graduation progress' },
            ],
          },
        },
      )
    },
  })
