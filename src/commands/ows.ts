/**
 * `almm ows` command group — manage the OWS-backed treasury wallet.
 *
 * Subcommand tree (note: nested groups are separate Cli instances mounted
 * onto the parent — this is how incur handles multi-word paths like
 * `ows policy setup`):
 *
 *   almm ows init
 *   almm ows policy setup
 *   almm ows key create
 *
 * The real work lives in src/wallets/treasury.ts. The reason we wrap OWS here
 * at all is to bake ALMM's defaults in (BSC chain, 24h expiry, ALMM-shaped
 * policy names), so agents don't need to know OWS's JSON schema to get going.
 */

import { Cli, z } from 'incur'
import { resolveOwsPassphrase } from '../lib/env.js'
import {
  BSC_CHAIN_ID,
  BSC_TESTNET_CHAIN_ID,
  createTreasuryApiKey,
  createTreasuryPolicy,
  createTreasuryWallet,
  listTreasuryWallets,
} from '../wallets/treasury.js'

// ============================================================
// almm ows policy <...>
// ============================================================

const policy = Cli.create('policy', {
  description: 'Manage OWS policies (chain allowlists + expiry rules)',
}).command('setup', {
  description:
    'Register an OWS policy: allowed chains + optional expiry. Default is BSC-only, 24h expiry.',
  options: z.object({
    id: z
      .string()
      .min(1)
      .default('almm-bsc-only')
      .describe('Policy ID (unique within the vault)'),
    name: z
      .string()
      .optional()
      .describe('Human-readable policy name'),
    chain: z
      .enum(['bsc', 'bsc-testnet'])
      .default('bsc')
      .describe('Allowed chain (ALMM only supports BSC variants)'),
    expiresIn: z
      .string()
      .optional()
      .describe('Expiry duration (e.g. 24h, 7d, 0 for never). Default: 24h'),
  }),
  examples: [
    { description: 'Default policy: BSC only, 24h expiry' },
    {
      options: { id: 'bsc-week', expiresIn: '7d' },
      description: 'BSC-only for 7 days',
    },
    {
      options: { id: 'testnet-forever', chain: 'bsc-testnet', expiresIn: '0' },
      description: 'Testnet only, no expiry',
    },
  ],
  output: z.object({
    id: z.string(),
    name: z.string(),
    allowedChains: z.array(z.string()),
    expiresAt: z.string().nullable(),
    message: z.string(),
  }),
  run(c) {
    const chainId =
      c.options.chain === 'bsc-testnet' ? BSC_TESTNET_CHAIN_ID : BSC_CHAIN_ID
    const policyName =
      c.options.name ?? `ALMM ${c.options.chain} policy (${c.options.id})`

    const expiresAt = resolveExpiresAt(c.options.expiresIn ?? '24h')

    try {
      createTreasuryPolicy({
        id: c.options.id,
        name: policyName,
        allowedChains: [chainId],
        ...(expiresAt ? { expiresAt } : {}),
      })
    } catch (err) {
      return c.error({
        code: 'OWS_POLICY_FAILED',
        message: err instanceof Error ? err.message : String(err),
      })
    }

    return c.ok(
      {
        id: c.options.id,
        name: policyName,
        allowedChains: [chainId],
        expiresAt,
        message: `Policy "${c.options.id}" registered`,
      },
      {
        cta: {
          commands: [
            {
              command: 'ows key create',
              args: { name: 'agent' },
              description: 'Mint an agent API key bound to this policy',
            },
          ],
        },
      },
    )
  },
})

// ============================================================
// almm ows key <...>
// ============================================================

const key = Cli.create('key', {
  description: 'Manage OWS API keys (agent access tokens)',
}).command('create', {
  description:
    'Create an OWS API key that an agent can use to sign transactions under a policy.',
  options: z.object({
    name: z.string().min(1).describe('API key name (human-readable)'),
    wallet: z
      .string()
      .default('treasury')
      .describe('Treasury wallet name (created via `almm ows init`)'),
    policy: z
      .string()
      .default('almm-bsc-only')
      .describe('Policy ID (created via `almm ows policy setup`)'),
    passphrase: z
      .string()
      .optional()
      .describe(
        'Vault passphrase needed to re-encrypt wallet secrets for the key. ' +
          'Or set OWS_PASSPHRASE env var.',
      ),
    expiresAt: z
      .string()
      .optional()
      .describe('ISO 8601 expiry (e.g. 2026-12-31T23:59:59Z)'),
  }),
  examples: [
    {
      options: { name: 'claude-agent' },
      description: 'Create a default-policy agent key (passphrase via OWS_PASSPHRASE env var)',
    },
    {
      options: {
        name: 'ops-bot',
        wallet: 'treasury',
        policy: 'bsc-week',
        expiresAt: '2026-12-31T23:59:59Z',
      },
      description: 'Custom policy + explicit expiry',
    },
  ],
  output: z.object({
    token: z.string(),
    id: z.string(),
    name: z.string(),
    message: z.string(),
  }),
  outputPolicy: 'agent-only',
  run(c) {
    const passphrase = resolveOwsPassphrase(c.options.passphrase)
    if (!passphrase) {
      return c.error({
        code: 'NO_OWS_PASSPHRASE',
        message:
          'No vault passphrase. Pass --passphrase or set OWS_PASSPHRASE env var.',
      })
    }

    // Resolve wallet name → known wallets (early failure instead of NAPI error)
    const wallets = listTreasuryWallets()
    const match = wallets.find(
      (w) => w.name === c.options.wallet || w.id === c.options.wallet,
    )
    if (!match) {
      return c.error({
        code: 'OWS_WALLET_NOT_FOUND',
        message: `No OWS wallet found named "${c.options.wallet}". Run \`almm ows init\` first.`,
      })
    }

    let apiKey
    try {
      apiKey = createTreasuryApiKey({
        name: c.options.name,
        walletIds: [match.id],
        policyIds: [c.options.policy],
        passphrase,
        ...(c.options.expiresAt ? { expiresAt: c.options.expiresAt } : {}),
      })
    } catch (err) {
      return c.error({
        code: 'OWS_KEY_FAILED',
        message: err instanceof Error ? err.message : String(err),
      })
    }

    return c.ok({
      token: apiKey.token,
      id: apiKey.id,
      name: apiKey.name,
      message:
        'Save this token now — it is shown only once. Use it as OWS_PASSPHRASE in your agent environment.',
    })
  },
})

// ============================================================
// almm ows (root)
// ============================================================

export const ows = Cli.create('ows', {
  description: 'Manage the OWS-backed treasury wallet (policy-gated signing)',
})
  // ---- almm ows init ----
  .command('init', {
    description:
      'Create an OWS-managed treasury wallet. Fails if a wallet with the same name already exists.',
    options: z.object({
      name: z
        .string()
        .min(1)
        .default('treasury')
        .describe('Wallet name (used by later ALMM commands)'),
      passphrase: z
        .string()
        .optional()
        .describe('Encryption passphrase (omit to be prompted at signing time)'),
      words: z
        .union([z.literal(12), z.literal(24)])
        .default(12)
        .describe('BIP-39 word count'),
    }),
    examples: [
      { description: 'Create a wallet named "treasury"' },
      {
        options: { name: 'my-treasury', words: 24 },
        description: 'Create a 24-word wallet with a custom name',
      },
    ],
    output: z.object({
      id: z.string(),
      name: z.string(),
      bscAddress: z.string(),
      createdAt: z.string(),
      message: z.string(),
    }),
    run(c) {
      let walletInfo
      try {
        walletInfo = createTreasuryWallet({
          name: c.options.name,
          ...(c.options.passphrase
            ? { passphrase: c.options.passphrase }
            : {}),
          words: c.options.words,
        })
      } catch (err) {
        return c.error({
          code: 'OWS_CREATE_FAILED',
          message:
            err instanceof Error
              ? err.message
              : `Failed to create wallet "${c.options.name}"`,
        })
      }

      const bscAccount =
        walletInfo.accounts.find((a) => a.chainId === BSC_CHAIN_ID) ??
        walletInfo.accounts.find((a) => a.chainId.startsWith('eip155:'))
      if (!bscAccount) {
        return c.error({
          code: 'OWS_NO_BSC_ACCOUNT',
          message: 'Wallet created but no EVM account derived',
        })
      }

      return c.ok(
        {
          id: walletInfo.id,
          name: walletInfo.name,
          bscAddress: bscAccount.address,
          createdAt: walletInfo.createdAt,
          message: `Treasury wallet "${walletInfo.name}" ready. Fund it at: ${bscAccount.address}`,
        },
        {
          cta: {
            commands: [
              {
                command: 'ows policy setup',
                args: { id: 'almm-bsc-only' },
                description: 'Create a BSC-only, 24h-expiring policy',
              },
              {
                command: 'query balance',
                options: { address: bscAccount.address },
                description: 'Check the treasury BNB balance',
              },
            ],
          },
        },
      )
    },
  })
  // ---- almm ows policy ... ----
  .command(policy)
  // ---- almm ows key ... ----
  .command(key)

// ============================================================
// Helpers
// ============================================================

/**
 * Parse a duration string like "24h", "7d", "30m" into an absolute ISO 8601 timestamp.
 * Returns null when the input is "0" or "never" (= no expiry).
 */
function resolveExpiresAt(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (trimmed === '0' || trimmed === 'never' || trimmed === '') return null

  const match = /^(\d+)\s*([mhd])$/.exec(trimmed)
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Use e.g. 30m / 24h / 7d / 0 (never).`,
    )
  }
  const amount = Number.parseInt(match[1]!, 10)
  const unit = match[2]!

  const ms =
    unit === 'm' ? amount * 60_000 : unit === 'h' ? amount * 3_600_000 : amount * 86_400_000

  return new Date(Date.now() + ms).toISOString()
}
