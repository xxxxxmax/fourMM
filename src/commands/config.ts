/**
 * `almm config` command group — manage ~/.almm/config.json.
 *
 * Subcommands:
 *   - init: create config file with defaults (or overrides)
 *   - set <key> <value>: update a single value
 *   - get [key]: read one value or the whole config
 */

import { Cli, z } from 'incur'
import {
  configFile,
  getConfigValue,
  initConfig,
  loadConfig,
  setConfigValue,
} from '../lib/config.js'

export const config = Cli.create('config', {
  description: 'Manage ALMM configuration (~/.almm/config.json)',
})
  // ============================================================
  // almm config init
  // ============================================================
  .command('init', {
    description: 'Initialize config file with defaults (optionally override key fields)',
    options: z.object({
      rpcUrl: z.string().url().optional().describe('BSC RPC endpoint URL'),
      network: z
        .enum(['bsc', 'bsc-testnet'])
        .optional()
        .describe('Network selection'),
      slippageBps: z
        .coerce.number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe('Default slippage in basis points (100 = 1%)'),
      treasuryWallet: z
        .string()
        .optional()
        .describe('OWS treasury wallet name'),
    }),
    examples: [
      { description: 'Initialize with defaults' },
      {
        options: { rpcUrl: 'https://bsc-dataseed.binance.org/' },
        description: 'Initialize with a custom RPC URL',
      },
      {
        options: { slippageBps: 500, treasuryWallet: 'my-treasury' },
        description: 'Initialize with 5% default slippage and a treasury wallet name',
      },
    ],
    output: z.object({
      configFile: z.string(),
      config: z.record(z.string(), z.unknown()),
      message: z.string(),
    }),
    run(c) {
      const overrides: Record<string, unknown> = {}
      if (c.options.rpcUrl) overrides.rpcUrl = c.options.rpcUrl
      if (c.options.network) overrides.network = c.options.network
      if (c.options.slippageBps !== undefined)
        overrides.defaultSlippageBps = c.options.slippageBps
      if (c.options.treasuryWallet)
        overrides.treasuryWallet = c.options.treasuryWallet

      const config = initConfig(overrides)
      return c.ok(
        {
          configFile: configFile(),
          config: config as unknown as Record<string, unknown>,
          message: `Config written to ${configFile()}`,
        },
        {
          cta: {
            commands: [
              {
                command: 'config get',
                description: 'View the full config',
              },
              {
                command: 'ows init',
                args: { name: config.treasuryWallet },
                description: 'Create your OWS treasury wallet',
              },
            ],
          },
        },
      )
    },
  })
  // ============================================================
  // almm config set <key> <value>
  // ============================================================
  .command('set', {
    description: 'Set a single configuration value',
    args: z.object({
      key: z.string().describe('Config key (e.g. rpcUrl, network, defaultSlippageBps)'),
      value: z.string().describe('New value (string, number, or comma-separated list)'),
    }),
    examples: [
      {
        args: { key: 'rpcUrl', value: 'https://bsc-dataseed.binance.org/' },
        description: 'Change BSC RPC endpoint',
      },
      {
        args: { key: 'defaultSlippageBps', value: '500' },
        description: 'Set default slippage to 5%',
      },
      {
        args: { key: 'treasuryWallet', value: 'my-treasury' },
        description: 'Pin the treasury wallet name',
      },
    ],
    output: z.object({
      key: z.string(),
      value: z.unknown(),
      message: z.string(),
    }),
    run(c) {
      try {
        setConfigValue(c.args.key, c.args.value)
      } catch (err) {
        return c.error({
          code: 'INVALID_CONFIG',
          message: err instanceof Error ? err.message : String(err),
        })
      }
      return c.ok({
        key: c.args.key,
        value: getConfigValue(c.args.key),
        message: `Updated ${c.args.key}`,
      })
    },
  })
  // ============================================================
  // almm config get [key]
  // ============================================================
  .command('get', {
    description: 'Read a single configuration value, or the entire config when called without --key',
    options: z.object({
      key: z
        .string()
        .optional()
        .describe('Config key to read (omit to dump the whole config)'),
    }),
    examples: [
      { description: 'Dump the whole config' },
      { options: { key: 'rpcUrl' }, description: 'Read a single key' },
    ],
    run(c) {
      if (c.options.key) {
        const value = getConfigValue(c.options.key)
        if (value === undefined) {
          return c.error({
            code: 'UNKNOWN_KEY',
            message: `Unknown config key "${c.options.key}"`,
          })
        }
        return c.ok({ key: c.options.key, value })
      }
      const config = loadConfig()
      return c.ok({ configFile: configFile(), config })
    },
  })
