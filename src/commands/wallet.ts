/**
 * `almm wallet` command group — manage in-house wallet groups.
 *
 * These wallets are NOT stored in OWS. They live in ~/.almm/wallets/,
 * encrypted with a master password, and are designed for batch operations
 * (sniper groups, volume bots) where OWS's single-wallet model is too heavy.
 *
 * Week 1 scope: create-group, list-groups. The other 9 wallet commands
 * (generate, group-info, add, import, export, etc.) are Week 2.
 */

import fs from 'node:fs'
import { Cli, z } from 'incur'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { resolveAlmmPassword } from '../lib/env.js'
import { getDataStore } from '../datastore/index.js'
import { getTokenPrice } from '../lib/pricing.js'
import { getPublicClient } from '../lib/viem.js'
import { encrypt, decrypt } from '../wallets/groups/encrypt.js'
import {
  addGeneratedWallets,
  addWalletFromPrivateKey,
  createGroup as createGroupInStore,
  decryptPrivateKey,
  deleteGroup as deleteGroupFromStore,
  getGroup,
  listGroups as listGroupsFromStore,
  loadStore,
  removeWalletFromGroup as removeWalletFromStore,
} from '../wallets/groups/store.js'

export const wallet = Cli.create('wallet', {
  description: 'Manage in-house wallet groups (sniper / volume bot wallets)',
})
  // ============================================================
  // almm wallet create-group
  // ============================================================
  .command('create-group', {
    description:
      'Create a new wallet group and populate it with freshly-generated wallets.',
    options: z.object({
      name: z.string().min(1).describe('Group name (human-readable label)'),
      count: z
        .coerce.number()
        .int()
        .min(1)
        .max(100)
        .default(5)
        .describe('Number of wallets to generate (max 100 per group)'),
      note: z.string().optional().describe('Free-form group description'),
      password: z
        .string()
        .optional()
        .describe('Master password (or set ALMM_PASSWORD env var)'),
    }),
    examples: [
      {
        options: { name: 'snipers', count: 10, password: '***' },
        description: 'Create a 10-wallet sniper group',
      },
      {
        options: { name: 'volume', count: 20, note: 'volume bot group' },
        description: 'With note, password from env',
      },
    ],
    output: z.object({
      groupId: z.number(),
      name: z.string(),
      walletCount: z.number(),
      addresses: z.array(z.string()),
      message: z.string(),
    }),
    run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) {
        return c.error({
          code: 'NO_PASSWORD',
          message:
            'No master password. Pass --password or set ALMM_PASSWORD env var.',
        })
      }

      let group
      try {
        group = createGroupInStore(password, {
          name: c.options.name,
          count: c.options.count,
          note: c.options.note,
        })
      } catch (err) {
        return c.error({
          code: 'WALLET_CREATE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      return c.ok(
        {
          groupId: group.groupId,
          name: group.name,
          walletCount: group.wallets.length,
          addresses: group.wallets.map((w) => w.address),
          message: `Created group ${group.groupId} "${group.name}" with ${group.wallets.length} wallets`,
        },
        {
          cta: {
            commands: [
              {
                command: 'wallet group-info',
                options: { id: group.groupId },
                description: 'View full group details',
              },
              {
                command: 'transfer out',
                options: {
                  from: 'treasury',
                  toGroup: group.groupId,
                  value: 0.1,
                },
                description: `Fund the group from the treasury (0.1 BNB each)`,
              },
            ],
          },
        },
      )
    },
  })
  // ============================================================
  // almm wallet generate
  // ============================================================
  .command('generate', {
    description:
      'Append freshly-generated wallets to an existing group. Private keys are encrypted at rest with the master password.',
    options: z.object({
      group: z
        .coerce.number()
        .int()
        .positive()
        .describe('Target group ID (see `wallet list-groups`)'),
      count: z
        .coerce.number()
        .int()
        .min(1)
        .max(100)
        .default(1)
        .describe('Number of wallets to add (max 100)'),
      password: z
        .string()
        .optional()
        .describe('Master password (or set ALMM_PASSWORD env var)'),
    }),
    examples: [
      {
        options: { group: 1, count: 5 },
        description: 'Append 5 wallets to group 1',
      },
      {
        options: { group: 2, count: 20, password: '***' },
        description: 'Append 20 wallets with explicit password',
      },
    ],
    output: z.object({
      groupId: z.number(),
      added: z.number(),
      totalAfter: z.number(),
      addresses: z.array(z.string()),
      message: z.string(),
    }),
    run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) {
        return c.error({
          code: 'NO_PASSWORD',
          message:
            'No master password. Pass --password or set ALMM_PASSWORD env var.',
        })
      }

      // Validate group exists up front for a clean error
      const existing = getGroup(password, c.options.group)
      if (!existing) {
        return c.error({
          code: 'GROUP_NOT_FOUND',
          message: `Group ${c.options.group} does not exist. Run \`almm wallet create-group\` first.`,
        })
      }

      let added
      try {
        added = addGeneratedWallets(password, c.options.group, c.options.count)
      } catch (err) {
        return c.error({
          code: 'WALLET_GENERATE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      const totalAfter = existing.wallets.length + added.length
      return c.ok(
        {
          groupId: c.options.group,
          added: added.length,
          totalAfter,
          addresses: added.map((w) => w.address),
          message: `Added ${added.length} wallets to group ${c.options.group} (total ${totalAfter})`,
        },
        {
          cta: {
            commands: [
              {
                command: 'wallet group-info',
                options: { id: c.options.group },
                description: 'Inspect the updated group',
              },
            ],
          },
        },
      )
    },
  })
  // ============================================================
  // almm wallet add
  // ============================================================
  .command('add', {
    description:
      'Import an existing private key into a wallet group. Validates via viem and dedupes by address.',
    options: z.object({
      group: z
        .coerce.number()
        .int()
        .positive()
        .describe('Target group ID'),
      privateKey: z
        .string()
        .regex(/^(0x)?[0-9a-fA-F]{64}$/, 'Expected a 32-byte hex private key')
        .describe('Hex private key (with or without 0x prefix)'),
      note: z
        .string()
        .optional()
        .describe('Free-form note attached to this wallet'),
      password: z
        .string()
        .optional()
        .describe('Master password (or set ALMM_PASSWORD env var)'),
    }),
    examples: [
      {
        options: {
          group: 1,
          privateKey:
            '0x0000000000000000000000000000000000000000000000000000000000000001',
          note: 'main wallet',
        },
        description: 'Import a private key into group 1',
      },
    ],
    output: z.object({
      groupId: z.number(),
      address: z.string(),
      note: z.string(),
      message: z.string(),
    }),
    outputPolicy: 'all',
    run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) {
        return c.error({
          code: 'NO_PASSWORD',
          message:
            'No master password. Pass --password or set ALMM_PASSWORD env var.',
        })
      }

      const existing = getGroup(password, c.options.group)
      if (!existing) {
        return c.error({
          code: 'GROUP_NOT_FOUND',
          message: `Group ${c.options.group} does not exist`,
        })
      }

      // Normalise to 0x prefix for viem
      const rawKey = c.options.privateKey.startsWith('0x')
        ? c.options.privateKey
        : `0x${c.options.privateKey}`

      let stored
      try {
        stored = addWalletFromPrivateKey(
          password,
          c.options.group,
          rawKey as Hex,
          c.options.note ?? '',
        )
      } catch (err) {
        return c.error({
          code: 'WALLET_ADD_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      return c.ok(
        {
          groupId: c.options.group,
          address: stored.address,
          note: stored.note,
          message: `Added wallet ${stored.address} to group ${c.options.group}`,
        },
        {
          cta: {
            commands: [
              {
                command: 'wallet group-info',
                options: { id: c.options.group },
                description: 'Verify the group now includes this wallet',
              },
              {
                command: 'query balance',
                options: { address: stored.address },
                description: 'Check the new wallet balance',
              },
            ],
          },
        },
      )
    },
  })
  // ============================================================
  // almm wallet group-info
  // ============================================================
  .command('group-info', {
    description:
      'Show all wallets in a group. --show-keys decrypts private keys (dangerous — never pipe to a file in an unsafe environment).',
    options: z.object({
      id: z
        .coerce.number()
        .int()
        .positive()
        .describe('Group ID'),
      showKeys: z
        .boolean()
        .default(false)
        .describe('Include decrypted private keys (outputs are suppressed for human TTY)'),
      password: z
        .string()
        .optional()
        .describe('Master password (or set ALMM_PASSWORD env var)'),
    }),
    examples: [
      {
        options: { id: 1 },
        description: 'Show wallet addresses for group 1',
      },
      {
        options: { id: 1, showKeys: true },
        description: 'Also reveal private keys (agent-only output)',
      },
    ],
    output: z.object({
      groupId: z.number(),
      name: z.string(),
      note: z.string(),
      walletCount: z.number(),
      createdAt: z.string(),
      updatedAt: z.string(),
      wallets: z.array(
        z.object({
          address: z.string(),
          note: z.string(),
          privateKey: z.string().optional(),
        }),
      ),
    }),
    run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) {
        return c.error({
          code: 'NO_PASSWORD',
          message:
            'No master password. Pass --password or set ALMM_PASSWORD env var.',
        })
      }

      // Security: refuse to print private keys to a human TTY.
      // incur's c.agent is `true` when stdout is not a TTY (piped / MCP /
      // agent context), `false` on interactive terminals. `outputPolicy`
      // can't be made conditional on an option, so we enforce it here.
      if (c.options.showKeys && !c.agent) {
        return c.error({
          code: 'REFUSE_SHOW_KEYS_TTY',
          message:
            'Refusing to print private keys to a terminal. Pipe through an ' +
            'agent (e.g. `... --format json | your-tool`) or run this from an ' +
            'MCP / skill context where stdout is not a TTY.',
        })
      }

      let group
      try {
        group = getGroup(password, c.options.id)
      } catch (err) {
        return c.error({
          code: 'WALLET_READ_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      if (!group) {
        return c.error({
          code: 'GROUP_NOT_FOUND',
          message: `Group ${c.options.id} does not exist`,
        })
      }

      const wallets = group.wallets.map((w) => {
        const row: { address: string; note: string; privateKey?: string } = {
          address: w.address,
          note: w.note,
        }
        if (c.options.showKeys) {
          try {
            row.privateKey = decryptPrivateKey(w, password)
          } catch (err) {
            row.privateKey = '<decrypt failed>'
          }
        }
        return row
      })

      return c.ok(
        {
          groupId: group.groupId,
          name: group.name,
          note: group.note,
          walletCount: group.wallets.length,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
          wallets,
        },
        {
          cta: {
            commands: [
              {
                command: 'transfer out',
                options: { from: 'treasury', toGroup: group.groupId, value: 0.1 },
                description: 'Fund this group from the treasury',
              },
              {
                command: 'query balance',
                options: { address: group.wallets[0]?.address ?? '' },
                description: 'Check a wallet balance',
              },
            ],
          },
        },
      )
    },
  })
  // ============================================================
  // almm wallet list-groups
  // ============================================================
  .command('list-groups', {
    description: 'List all wallet groups in the in-house vault.',
    options: z.object({
      password: z
        .string()
        .optional()
        .describe('Master password (or set ALMM_PASSWORD env var)'),
    }),
    examples: [{ description: 'List every wallet group' }],
    output: z.object({
      count: z.number(),
      groups: z.array(
        z.object({
          groupId: z.number(),
          name: z.string(),
          note: z.string(),
          walletCount: z.number(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
    }),
    run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) {
        return c.error({
          code: 'NO_PASSWORD',
          message:
            'No master password. Pass --password or set ALMM_PASSWORD env var.',
        })
      }

      let groups
      try {
        groups = listGroupsFromStore(password)
      } catch (err) {
        return c.error({
          code: 'WALLET_LIST_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      return c.ok({
        count: groups.length,
        groups,
      })
    },
  })
  // ============================================================
  // almm wallet delete-group
  // ============================================================
  .command('delete-group', {
    description: 'Delete an entire wallet group from the store.',
    options: z.object({
      id: z.coerce.number().int().positive().describe('Group ID to delete'),
      force: z.boolean().default(false).describe('Skip confirmation (required for non-interactive)'),
      password: z.string().optional().describe('Master password (or ALMM_PASSWORD env)'),
    }),
    output: z.object({ groupId: z.number(), message: z.string() }),
    run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'No master password.' })

      const group = getGroup(password, c.options.id)
      if (!group) return c.error({ code: 'GROUP_NOT_FOUND', message: `Group ${c.options.id} does not exist` })

      if (!c.options.force) {
        return c.error({ code: 'CONFIRM_REQUIRED', message: `Group ${c.options.id} "${group.name}" has ${group.wallets.length} wallets. Pass --force to confirm deletion.` })
      }

      try { deleteGroupFromStore(password, c.options.id) } catch (err) {
        return c.error({ code: 'DELETE_FAILED', message: err instanceof Error ? err.message : String(err) })
      }

      return c.ok(
        { groupId: c.options.id, message: `Deleted group ${c.options.id} "${group.name}"` },
        { cta: { commands: [{ command: 'wallet list-groups', options: {}, description: 'View remaining groups' }] } },
      )
    },
  })
  // ============================================================
  // almm wallet remove
  // ============================================================
  .command('remove', {
    description: 'Remove a single wallet from a group by address.',
    options: z.object({
      group: z.coerce.number().int().positive().describe('Group ID'),
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Expected 0x-prefixed address').describe('Wallet address to remove'),
      password: z.string().optional().describe('Master password (or ALMM_PASSWORD env)'),
    }),
    output: z.object({ groupId: z.number(), address: z.string(), message: z.string() }),
    run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'No master password.' })

      const addr = getAddress(c.options.address) as Address
      try { removeWalletFromStore(password, c.options.group, addr) } catch (err) {
        return c.error({ code: 'REMOVE_FAILED', message: err instanceof Error ? err.message : String(err) })
      }

      return c.ok(
        { groupId: c.options.group, address: addr, message: `Removed ${addr} from group ${c.options.group}` },
        { cta: { commands: [{ command: 'wallet group-info', options: { id: c.options.group }, description: 'Verify wallet removed' }] } },
      )
    },
  })
  // ============================================================
  // almm wallet import
  // ============================================================
  .command('import', {
    description: 'Import wallets from a CSV file (address,privateKey,note per line) into a group.',
    options: z.object({
      group: z.coerce.number().int().positive().describe('Target group ID'),
      file: z.string().describe('Path to CSV file'),
      password: z.string().optional().describe('Master password (or ALMM_PASSWORD env)'),
    }),
    output: z.object({ groupId: z.number(), imported: z.number(), skipped: z.number(), message: z.string() }),
    run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'No master password.' })

      const group = getGroup(password, c.options.group)
      if (!group) return c.error({ code: 'GROUP_NOT_FOUND', message: `Group ${c.options.group} does not exist` })

      if (!fs.existsSync(c.options.file)) {
        return c.error({ code: 'FILE_NOT_FOUND', message: `File not found: ${c.options.file}` })
      }

      const raw = fs.readFileSync(c.options.file, 'utf-8')
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)

      let imported = 0
      let skipped = 0

      for (const line of lines) {
        // Skip header row
        if (line.toLowerCase().startsWith('address,')) continue

        const parts = line.split(',').map((p) => p.trim())
        const pk = parts[1]
        const note = parts[2] ?? ''
        if (!pk || !pk.match(/^(0x)?[0-9a-fA-F]{64}$/)) { skipped++; continue }

        const rawKey = pk.startsWith('0x') ? pk : `0x${pk}`
        try {
          addWalletFromPrivateKey(password, c.options.group, rawKey as Hex, note)
          imported++
        } catch {
          skipped++ // duplicate or invalid
        }
      }

      return c.ok(
        { groupId: c.options.group, imported, skipped, message: `Imported ${imported} wallets, skipped ${skipped}` },
        { cta: { commands: [{ command: 'wallet group-info', options: { id: c.options.group }, description: 'View updated group' }] } },
      )
    },
  })
  // ============================================================
  // almm wallet export
  // ============================================================
  .command('export', {
    description: 'Export wallets from a group to a CSV file (address,privateKey,note).',
    options: z.object({
      group: z.coerce.number().int().positive().describe('Source group ID'),
      file: z.string().describe('Output CSV path'),
      password: z.string().optional().describe('Master password (or ALMM_PASSWORD env)'),
    }),
    output: z.object({ groupId: z.number(), count: z.number(), file: z.string(), message: z.string() }),
    run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'No master password.' })

      const group = getGroup(password, c.options.group)
      if (!group) return c.error({ code: 'GROUP_NOT_FOUND', message: `Group ${c.options.group} does not exist` })

      const rows = ['address,privateKey,note']
      for (const w of group.wallets) {
        let pk: string
        try { pk = decryptPrivateKey(w, password) } catch { pk = '<decrypt-failed>' }
        rows.push(`${w.address},${pk},${w.note.replace(/,/g, ';')}`)
      }

      fs.writeFileSync(c.options.file, rows.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })

      return c.ok(
        { groupId: c.options.group, count: group.wallets.length, file: c.options.file, message: `Exported ${group.wallets.length} wallets to ${c.options.file}` },
        { cta: { commands: [{ command: 'wallet group-info', options: { id: c.options.group }, description: 'View group' }] } },
      )
    },
  })
  // ============================================================
  // almm wallet export-group
  // ============================================================
  .command('export-group', {
    description: 'Export all groups as JSON, optionally AES encrypted.',
    options: z.object({
      file: z.string().describe('Output file path'),
      encrypt: z.boolean().default(false).describe('AES-encrypt the output with master password'),
      password: z.string().optional().describe('Master password (or ALMM_PASSWORD env)'),
    }),
    output: z.object({ groupCount: z.number(), encrypted: z.boolean(), file: z.string(), message: z.string() }),
    run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'No master password.' })

      const store = loadStore(password)
      if (!store) return c.error({ code: 'NO_STORE', message: 'No wallet store found.' })

      const groupCount = Object.keys(store.groups).length
      const json = JSON.stringify(store, null, 2)

      if (c.options.encrypt) {
        const encrypted = encrypt(json, password)
        fs.writeFileSync(c.options.file, encrypted, { encoding: 'utf-8', mode: 0o600 })
      } else {
        fs.writeFileSync(c.options.file, json, { encoding: 'utf-8', mode: 0o600 })
      }

      return c.ok(
        { groupCount, encrypted: c.options.encrypt, file: c.options.file, message: `Exported ${groupCount} groups to ${c.options.file}${c.options.encrypt ? ' (encrypted)' : ''}` },
        { cta: { commands: [{ command: 'wallet list-groups', options: {}, description: 'View groups' }] } },
      )
    },
  })
  // ============================================================
  // almm wallet overview
  // ============================================================
  .command('overview', {
    description: 'Aggregate PnL across wallet groups from DataStore.',
    options: z.object({
      groups: z.string().describe('Comma-separated group IDs (e.g. "1,2")'),
      token: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().describe('Filter by token CA'),
      password: z.string().optional().describe('Master password (or ALMM_PASSWORD env)'),
    }),
    output: z.object({
      groupIds: z.array(z.number()),
      tokenFilter: z.string(),
      totalRealizedPnl: z.number(),
      totalUnrealizedPnl: z.number(),
      totalValueBnb: z.number(),
      groups: z.array(z.object({
        groupId: z.number(), realizedPnl: z.number(), unrealizedPnl: z.number(), valueBnb: z.number(),
      })),
    }),
    async run(c) {
      const password = resolveAlmmPassword(c.options.password)
      if (!password) return c.error({ code: 'NO_PASSWORD', message: 'No master password.' })

      const groupIds = c.options.groups.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0)
      if (groupIds.length === 0) return c.error({ code: 'NO_GROUPS', message: 'Provide at least one group ID' })

      const ds = getDataStore()
      const client = getPublicClient()
      const tokens = c.options.token ? [getAddress(c.options.token) as Address] : ds.listTokens()

      let totalRealized = 0
      let totalUnrealized = 0
      let totalValue = 0
      const groupSummaries: Array<{ groupId: number; realizedPnl: number; unrealizedPnl: number; valueBnb: number }> = []

      for (const gid of groupIds) {
        let gRealized = 0; let gUnrealized = 0; let gValue = 0
        for (const ca of tokens) {
          let priceBnb = 0
          try { const p = await getTokenPrice(client, ca); priceBnb = p.priceBnb } catch { /* skip */ }
          const holdings = ds.getHoldings(ca, gid)
          if (!holdings) continue
          for (const w of holdings.wallets) {
            const currentVal = w.tokenBalance * priceBnb
            const unrealized = currentVal - w.tokenBalance * w.avgBuyPrice
            gRealized += w.realizedPnl
            gUnrealized += unrealized
            gValue += currentVal
          }
        }
        totalRealized += gRealized; totalUnrealized += gUnrealized; totalValue += gValue
        groupSummaries.push({ groupId: gid, realizedPnl: gRealized, unrealizedPnl: gUnrealized, valueBnb: gValue })
      }

      return c.ok(
        {
          groupIds, tokenFilter: c.options.token ?? 'all',
          totalRealizedPnl: totalRealized, totalUnrealizedPnl: totalUnrealized, totalValueBnb: totalValue,
          groups: groupSummaries,
        },
        { cta: { commands: [
          { command: 'query transactions', options: { group: groupIds[0]! }, description: 'View transaction history' },
        ] } },
      )
    },
  })
