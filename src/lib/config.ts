/**
 * fourMM configuration management.
 *
 * Stored at ~/.fourmm/config.json. Supports env var overrides for RPC and
 * sensitive values (so users don't have to write secrets to disk).
 *
 * Precedence: env var > config file > default.
 *
 * Paths are exposed as functions (not constants) so that tests can redirect
 * HOME via `process.env.HOME = tmpDir` before each test — `os.homedir()`
 * re-reads the HOME env var on each call, so lazy functions see the change.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ============================================================
// Types
// ============================================================

export type Network = 'bsc' | 'bsc-testnet'

export type CliConfig = {
  /** BSC RPC endpoint URL */
  rpcUrl: string
  /** Fallback RPC endpoints (tried on primary failure) */
  fallbackRpcUrls: string[]
  /** Network selection */
  network: Network
  /** Default slippage in basis points (100 = 1%) */
  defaultSlippageBps: number
  /** Default gas price multiplier applied to RPC estimate (1.0 = no multiplier) */
  gasPriceMultiplier: number
  /** Default priority fee in gwei */
  defaultPriorityFeeGwei: number
  /** Output format default */
  outputFormat: 'toon' | 'json' | 'yaml' | 'md' | 'jsonl'
  /** BSCScan API key (optional, for verification workflows) */
  bscscanApiKey: string
  /** GeckoTerminal base URL (override for rate limit bypass) */
  geckoTerminalUrl: string
  /** Four.meme REST API base URL (used for token variant identification) */
  fourmemeApiUrl: string
}

// ============================================================
// Defaults
// ============================================================

const DEFAULT_CONFIG: CliConfig = {
  // bsc.publicnode.com tends to be faster and more stable than Binance's own
  // hosted nodes during our Week-1 testing. Users can override via config or
  // BSC_RPC_URL env var.
  rpcUrl: 'https://meme.bsc.blockrazor.xyz',
  fallbackRpcUrls: [
    'https://bsc.publicnode.com',
  ],
  network: 'bsc',
  defaultSlippageBps: 300,
  gasPriceMultiplier: 1.1,
  defaultPriorityFeeGwei: 1,
  outputFormat: 'toon',
  bscscanApiKey: '',
  geckoTerminalUrl: 'https://api.geckoterminal.com/api/v2',
  fourmemeApiUrl: 'https://four.meme/meme-api',
}

// ============================================================
// Paths (lazy — respect HOME env var changes)
// ============================================================

/** Root directory for fourMM state */
export function fourmDir(): string {
  return path.join(os.homedir(), '.fourmm')
}

/** Config file location */
export function configFile(): string {
  return path.join(fourmDir(), 'config.json')
}

/** Encrypted wallet groups store directory */
export function walletsDir(): string {
  return path.join(fourmDir(), 'wallets')
}

/** DataStore root (token info, holdings, balances, transactions) */
export function dataDir(): string {
  return path.join(fourmDir(), 'data')
}

/** Logs directory */
export function logsDir(): string {
  return path.join(fourmDir(), 'logs')
}

/** Ensure ~/.fourmm and subdirs exist with tight permissions */
export function ensureFourmmDirs(): void {
  for (const dir of [fourmDir(), walletsDir(), dataDir(), logsDir()]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }
}

// ============================================================
// Load / Save
// ============================================================

/** Apply environment variable overrides */
function applyEnvOverrides(config: CliConfig): CliConfig {
  const envRpc = process.env.BSC_RPC_URL
  const envBscscan = process.env.BSCSCAN_API_KEY
  const envGecko = process.env.GECKOTERMINAL_URL

  return {
    ...config,
    ...(envRpc ? { rpcUrl: envRpc } : {}),
    ...(envBscscan ? { bscscanApiKey: envBscscan } : {}),
    ...(envGecko ? { geckoTerminalUrl: envGecko } : {}),
  }
}

/** Load config from ~/.fourmm/config.json (or defaults if absent) */
export function loadConfig(): CliConfig {
  ensureFourmmDirs()

  const file = configFile()
  if (!fs.existsSync(file)) {
    return applyEnvOverrides({ ...DEFAULT_CONFIG })
  }

  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const fileConfig = JSON.parse(raw) as Partial<CliConfig>
    const merged: CliConfig = { ...DEFAULT_CONFIG, ...fileConfig }
    return applyEnvOverrides(merged)
  } catch {
    return applyEnvOverrides({ ...DEFAULT_CONFIG })
  }
}

/** Save config to disk */
export function saveConfig(config: CliConfig): void {
  ensureFourmmDirs()
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
}

/** Initialize config (write defaults + any overrides) */
export function initConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  ensureFourmmDirs()
  const config: CliConfig = { ...DEFAULT_CONFIG, ...overrides }
  saveConfig(config)
  return config
}

// ============================================================
// Key / Value helpers
// ============================================================

const VALID_KEYS = new Set<keyof CliConfig>([
  'rpcUrl',
  'fallbackRpcUrls',
  'network',
  'defaultSlippageBps',
  'gasPriceMultiplier',
  'defaultPriorityFeeGwei',
  'outputFormat',
  'bscscanApiKey',
  'geckoTerminalUrl',
  'fourmemeApiUrl',
])

/** Get a single config value by key */
export function getConfigValue(key: string): unknown {
  const config = loadConfig()
  if (!VALID_KEYS.has(key as keyof CliConfig)) return undefined
  return config[key as keyof CliConfig]
}

/** Set a single config value with type coercion */
export function setConfigValue(key: string, rawValue: string): void {
  if (!VALID_KEYS.has(key as keyof CliConfig)) {
    throw new Error(
      `Unknown config key "${key}". Valid keys: ${[...VALID_KEYS].join(', ')}`,
    )
  }

  const config = loadConfig()
  const coerced = coerceValue(key as keyof CliConfig, rawValue)
  ;(config as Record<string, unknown>)[key] = coerced
  saveConfig(config)
}

function coerceValue(key: keyof CliConfig, raw: string): unknown {
  // Number fields
  if (key === 'defaultSlippageBps' || key === 'defaultPriorityFeeGwei') {
    const n = Number.parseInt(raw, 10)
    if (Number.isNaN(n) || n < 0) {
      throw new Error(`${key} must be a non-negative integer, got "${raw}"`)
    }
    return n
  }

  if (key === 'gasPriceMultiplier') {
    const n = Number.parseFloat(raw)
    if (Number.isNaN(n) || n <= 0) {
      throw new Error(`${key} must be a positive number, got "${raw}"`)
    }
    return n
  }

  // Enum fields
  if (key === 'network') {
    if (raw !== 'bsc' && raw !== 'bsc-testnet') {
      throw new Error(`network must be "bsc" or "bsc-testnet", got "${raw}"`)
    }
    return raw
  }

  if (key === 'outputFormat') {
    const valid = ['toon', 'json', 'yaml', 'md', 'jsonl']
    if (!valid.includes(raw)) {
      throw new Error(
        `outputFormat must be one of ${valid.join(', ')}, got "${raw}"`,
      )
    }
    return raw
  }

  // Array fields
  if (key === 'fallbackRpcUrls') {
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  }

  // String fields
  return raw
}
