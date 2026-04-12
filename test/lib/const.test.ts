import { describe, expect, it } from 'vitest'
import {
  FOURMEME_MM_ROUTER,
  isFourmemeNativeAddress,
  requireRouter,
} from '../../src/lib/const.js'

describe('isFourmemeNativeAddress', () => {
  it('matches addresses ending in 4444 (case insensitive)', () => {
    expect(
      isFourmemeNativeAddress('0x802CF8e2673f619c486a2950feE3D24f8A074444'),
    ).toBe(true)
    expect(
      isFourmemeNativeAddress('0x802cf8e2673f619c486a2950fee3d24f8a074444'),
    ).toBe(true)
  })

  it('rejects non-4444 suffixes', () => {
    expect(
      isFourmemeNativeAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'),
    ).toBe(false)
    expect(
      isFourmemeNativeAddress('0x0000000000000000000000000000000000000000'),
    ).toBe(false)
    expect(
      isFourmemeNativeAddress('0x0000000000000000000000000000000000004445'),
    ).toBe(false)
  })
})

describe('requireRouter', () => {
  it('returns the deployed Router address', () => {
    const addr = requireRouter()
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(addr).toBe(FOURMEME_MM_ROUTER)
  })
})
