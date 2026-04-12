/**
 * DataStore path construction.
 *
 * All functions are lazy (read HOME on each call) so tests can redirect
 * without resetting modules. Lives under ~/.almm/data/.
 */

import path from 'node:path'
import { dataDir } from '../lib/config.js'

export function tokensRoot(): string {
  return path.join(dataDir(), 'tokens')
}

export function tokenDir(ca: string): string {
  return path.join(tokensRoot(), ca)
}

export function tokenInfoPath(ca: string): string {
  return path.join(tokenDir(ca), 'token-info.json')
}

export function poolInfoPath(ca: string): string {
  return path.join(tokenDir(ca), 'pool-info.json')
}

export function groupDir(ca: string, groupId: number): string {
  return path.join(tokenDir(ca), 'groups', String(groupId))
}

export function transactionsPath(ca: string, groupId: number): string {
  return path.join(groupDir(ca, groupId), 'transactions.json')
}

export function holdingsPath(ca: string, groupId: number): string {
  return path.join(groupDir(ca, groupId), 'holdings.json')
}

export function balancesPath(ca: string, groupId: number): string {
  return path.join(groupDir(ca, groupId), 'balances.json')
}

export function globalDir(): string {
  return path.join(dataDir(), 'global')
}

export function bnbPricePath(): string {
  return path.join(globalDir(), 'bnb-price.json')
}
