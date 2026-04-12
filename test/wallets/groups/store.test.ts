import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGroup,
  decryptPrivateKey,
  getGroup,
  initStore,
  listGroups,
  loadStore,
  loadOrInitStore,
  storeExists,
} from '../../../src/wallets/groups/store.js'

/**
 * Store tests redirect HOME so they write to a tempdir.
 */

let tmpHome: string
let realHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'almm-store-test-'))
  realHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

const storeFile = () => path.join(tmpHome, '.almm', 'wallets', 'wallet-store.json')

describe('loadStore', () => {
  it('returns null when the file does not exist and does NOT write', () => {
    expect(storeExists()).toBe(false)
    expect(loadStore('pw')).toBeNull()
    // Crucially: loadStore must not create the file as a side-effect.
    expect(fs.existsSync(storeFile())).toBe(false)
  })

  it('reads back a store with the right password', () => {
    initStore('pw')
    const store = loadStore('pw')
    expect(store).not.toBeNull()
    expect(store!.encrypted).toBe(true)
    expect(store!.groups).toEqual({})
  })

  it('throws on wrong password', () => {
    initStore('right')
    expect(() => loadStore('wrong')).toThrow(/wrong master password/i)
  })

  it('throws on empty password', () => {
    initStore('any')
    expect(() => loadStore('')).toThrow(/password is empty/)
  })
})

describe('initStore', () => {
  it('writes a new empty store', () => {
    const store = initStore('pw')
    expect(store.groups).toEqual({})
    expect(fs.existsSync(storeFile())).toBe(true)
  })

  it('refuses to overwrite an existing store', () => {
    initStore('pw')
    expect(() => initStore('pw')).toThrow(/already exists/)
  })
})

describe('loadOrInitStore', () => {
  it('creates a new store when none exists', () => {
    const store = loadOrInitStore('pw')
    expect(store.groups).toEqual({})
    expect(fs.existsSync(storeFile())).toBe(true)
  })

  it('loads an existing store instead of reinitializing', () => {
    initStore('pw')
    const store = loadOrInitStore('pw')
    expect(store.groups).toEqual({})
  })
})

describe('createGroup + listGroups', () => {
  it('creates a group with freshly generated wallets', () => {
    const group = createGroup('pw', { name: 'snipers', count: 3 })
    expect(group.groupId).toBe(1)
    expect(group.name).toBe('snipers')
    expect(group.wallets).toHaveLength(3)
    // Addresses are valid, private keys are encrypted (not raw hex)
    for (const w of group.wallets) {
      expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(w.encryptedPrivateKey).not.toMatch(/^0x/)
    }
  })

  it('assigns incrementing group IDs', () => {
    createGroup('pw', { name: 'a', count: 1 })
    const second = createGroup('pw', { name: 'b', count: 1 })
    const third = createGroup('pw', { name: 'c', count: 1 })
    expect(second.groupId).toBe(2)
    expect(third.groupId).toBe(3)
  })

  it('listGroups returns summaries sorted by ID', () => {
    createGroup('pw', { name: 'a', count: 1 })
    createGroup('pw', { name: 'b', count: 2 })
    const summaries = listGroups('pw')
    expect(summaries).toHaveLength(2)
    expect(summaries[0]!.groupId).toBe(1)
    expect(summaries[0]!.walletCount).toBe(1)
    expect(summaries[1]!.groupId).toBe(2)
    expect(summaries[1]!.walletCount).toBe(2)
  })

  it('listGroups on an empty vault returns an empty array without writing', () => {
    expect(listGroups('pw')).toEqual([])
    // Critical: read-only call must not create the store file
    expect(fs.existsSync(storeFile())).toBe(false)
  })

  it('createGroup on first run initializes the store', () => {
    expect(storeExists()).toBe(false)
    createGroup('pw', { name: 'first', count: 2 })
    expect(storeExists()).toBe(true)
  })
})

describe('getGroup', () => {
  it('returns the requested group', () => {
    createGroup('pw', { name: 'snipers', count: 2 })
    const group = getGroup('pw', 1)
    expect(group).toBeDefined()
    expect(group!.name).toBe('snipers')
  })

  it('returns undefined for missing groups', () => {
    expect(getGroup('pw', 999)).toBeUndefined()
  })
})

describe('decryptPrivateKey', () => {
  it('decrypts back to a valid hex private key', () => {
    const group = createGroup('pw', { name: 'test', count: 1 })
    const wallet = group.wallets[0]!
    const pk = decryptPrivateKey(wallet, 'pw')
    expect(pk).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('throws on wrong password', () => {
    const group = createGroup('pw', { name: 'test', count: 1 })
    const wallet = group.wallets[0]!
    expect(() => decryptPrivateKey(wallet, 'wrong')).toThrow()
  })
})
