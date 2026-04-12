/**
 * In-process memory cache with TTL.
 *
 * Used by DataStore to avoid re-reading JSON from disk on every call.
 * Entry is invalidated on write and expires after `ttlMs`.
 */

type Entry<T> = {
  value: T
  /** Unix ms when this entry becomes stale */
  expiresAt: number
}

export class MemoryCache {
  private store = new Map<string, Entry<unknown>>()
  constructor(private readonly ttlMs: number = 30_000) {}

  get<T>(key: string): T | undefined {
    const e = this.store.get(key)
    if (!e) return undefined
    if (Date.now() >= e.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return e.value as T
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    const ttl = ttlMs ?? this.ttlMs
    this.store.set(key, { value, expiresAt: Date.now() + ttl })
  }

  invalidate(key: string): void {
    this.store.delete(key)
  }

  /** Drop all entries whose key starts with prefix (e.g. "token:<ca>:") */
  invalidatePrefix(prefix: string): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k)
    }
  }

  clear(): void {
    this.store.clear()
  }

  /** Test helper: number of live (not yet expired) entries */
  size(): number {
    return this.store.size
  }
}
