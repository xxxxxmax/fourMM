import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getConfigValue,
  initConfig,
  loadConfig,
  setConfigValue,
  saveConfig,
} from '../../src/lib/config.js'

/**
 * These tests mutate ~/.fourmm. We redirect HOME to a tempdir for the duration
 * of each test so we never touch the real user config.
 */

let tmpHome: string
let realHome: string | undefined
let realFourmmPassword: string | undefined
let realBscRpc: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fourmm-config-test-'))
  realHome = process.env.HOME
  realFourmmPassword = process.env.FOURMM_PASSWORD
  realBscRpc = process.env.BSC_RPC_URL
  process.env.HOME = tmpHome
  delete process.env.FOURMM_PASSWORD
  delete process.env.BSC_RPC_URL
})

afterEach(() => {
  process.env.HOME = realHome
  if (realFourmmPassword !== undefined)
    process.env.FOURMM_PASSWORD = realFourmmPassword
  if (realBscRpc !== undefined) process.env.BSC_RPC_URL = realBscRpc
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('config.loadConfig', () => {
  it('returns defaults when no file exists', () => {
    const config = loadConfig()
    expect(config.network).toBe('bsc')
    expect(config.defaultSlippageBps).toBe(300)
    expect(config.outputFormat).toBe('toon')
    expect(config.rpcUrl).toMatch(/^https?:\/\//)
  })

  it('applies BSC_RPC_URL env override on top of defaults', () => {
    process.env.BSC_RPC_URL = 'https://custom-rpc.example/'
    const config = loadConfig()
    expect(config.rpcUrl).toBe('https://custom-rpc.example/')
  })

  it('reads and merges a file config with defaults', () => {
    initConfig({ defaultSlippageBps: 500 })
    const config = loadConfig()
    expect(config.defaultSlippageBps).toBe(500)
    // Unset fields still come from defaults
    expect(config.network).toBe('bsc')
  })

  it('falls back to defaults on corrupt JSON', () => {
    const fourmDir = path.join(tmpHome, '.fourmm')
    fs.mkdirSync(fourmDir, { recursive: true })
    fs.writeFileSync(path.join(fourmDir, 'config.json'), 'not json{')
    const config = loadConfig()
    expect(config.defaultSlippageBps).toBe(300)
  })
})

describe('config.initConfig', () => {
  it('writes a config file with overrides merged in', () => {
    const config = initConfig({
      rpcUrl: 'https://foo/',
      network: 'bsc-testnet',
    })
    expect(config.rpcUrl).toBe('https://foo/')
    expect(config.network).toBe('bsc-testnet')
    const path1 = path.join(tmpHome, '.fourmm', 'config.json')
    expect(fs.existsSync(path1)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(path1, 'utf-8'))
    expect(raw.rpcUrl).toBe('https://foo/')
  })

  it('creates ~/.fourmm subdirs with 0700 mode', () => {
    initConfig({})
    const stat = fs.statSync(path.join(tmpHome, '.fourmm', 'wallets'))
    expect(stat.isDirectory()).toBe(true)
    // On Linux, we set mode 0o700 explicitly
    expect(stat.mode & 0o777).toBe(0o700)
  })
})

describe('config.setConfigValue + getConfigValue', () => {
  beforeEach(() => {
    initConfig({})
  })

  it('persists a string value', () => {
    setConfigValue('rpcUrl', 'https://test/')
    expect(getConfigValue('rpcUrl')).toBe('https://test/')
  })

  it('coerces numeric fields', () => {
    setConfigValue('defaultSlippageBps', '777')
    expect(getConfigValue('defaultSlippageBps')).toBe(777)
  })

  it('rejects invalid enum values', () => {
    expect(() => setConfigValue('network', 'eth')).toThrow(/network must be/)
  })

  it('rejects unknown keys', () => {
    expect(() => setConfigValue('unknownKey', 'v')).toThrow(/Unknown config key/)
  })

  it('rejects negative slippage', () => {
    expect(() => setConfigValue('defaultSlippageBps', '-1')).toThrow(
      /non-negative integer/,
    )
  })

  it('parses comma-separated fallbackRpcUrls', () => {
    setConfigValue('fallbackRpcUrls', 'https://a/, https://b/')
    expect(getConfigValue('fallbackRpcUrls')).toEqual([
      'https://a/',
      'https://b/',
    ])
  })
})

describe('config.saveConfig', () => {
  it('writes the config file with mode 0600', () => {
    const base = loadConfig()
    saveConfig(base)
    const file = path.join(tmpHome, '.fourmm', 'config.json')
    const stat = fs.statSync(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})
