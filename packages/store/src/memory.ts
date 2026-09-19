import { err, ok, type Result } from "@bungohan/result"
import { StoreError } from "./errors"
import { checkTtl, fromJson, toJson } from "./json"
import type { IStore } from "./store"

export interface MemoryStoreOptions {
  /** Time source in ms, for TTLs. Default `Date.now`; pass a manual clock in tests. */
  now?: () => number
}

interface Entry {
  json: string
  /** Absolute expiry in ms, if any. */
  expiresAt: number | undefined
}

/**
 * In-process `IStore`: the single-process default and a test double. Values
 * are stored as JSON, exactly like `RedisStore`, so a value that works here
 * works there (and mutating an object after `set` doesn't change the stored
 * copy).
 */
export class MemoryStore implements IStore {
  private readonly _entries = new Map<string, Entry>()
  private readonly _now: () => number
  private _closed = false

  public constructor(options: MemoryStoreOptions = {}) {
    this._now = options.now ?? Date.now
  }

  public async set(
    key: string,
    value: unknown,
    ttl?: number,
  ): Promise<Result<void, Error>> {
    if (this._closed) return err(closed())
    const valid = checkTtl(ttl)
    if (valid.isErr()) return valid
    const json = toJson(value)
    if (json.isErr()) return json
    this._entries.set(key, {
      json: json.value,
      expiresAt: ttl === undefined ? undefined : this._now() + ttl * 1000,
    })
    return ok(undefined)
  }

  public async get(key: string): Promise<Result<unknown, Error>> {
    if (this._closed) return err(closed())
    const entry = this._live(key)
    return entry === undefined ? ok(undefined) : fromJson(key, entry.json)
  }

  public async delete(key: string): Promise<Result<void, Error>> {
    if (this._closed) return err(closed())
    this._entries.delete(key)
    return ok(undefined)
  }

  public async exists(key: string): Promise<Result<boolean, Error>> {
    if (this._closed) return err(closed())
    return ok(this._live(key) !== undefined)
  }

  public async close(): Promise<Result<void, Error>> {
    this._closed = true
    this._entries.clear()
    return ok(undefined)
  }

  /** The entry for `key`, evicting it if it has expired. */
  private _live(key: string): Entry | undefined {
    const entry = this._entries.get(key)
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this._now()) {
      this._entries.delete(key)
      return undefined
    }
    return entry
  }
}

function closed(): StoreError {
  return new StoreError("CONNECTION_FAILED", "store is closed")
}
