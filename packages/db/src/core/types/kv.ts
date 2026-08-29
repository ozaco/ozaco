import type { Operation } from 'std:effect'

/**
 * The `Kv` protocol surface: a namespaced key/value store with TTLs, tags and atomic counters
 * over any backend (`db:impl/kv/{memory,redis}`). Impls are thin drivers over bytes
 * ({@link KvDef.Driver}); value codec, key namespacing, `wrap` singleflight and the batch
 * fallbacks are built once in core (`kvActions`).
 */
export namespace KvDef {
  /** What a backend can do beyond get/set/del. Core fails the matching actions with
   * `kv.unsupported` when a capability is missing. */

  export interface Capabilities {
    /** values survive the process (redis) — a memory store says false. */
    readonly persistent: boolean

    /** `incr` is atomic across processes (redis INCRBY); memory is atomic in-process only. */
    readonly atomic: boolean

    /** `keys()` can enumerate a namespace. */
    readonly scan: boolean
  }

  /** The protocol context — what a store's `setup()` resolves. */
  export interface Options {
    readonly store: string

    /** every key of this install lives under `<prefix>:` on the backend. */
    readonly prefix: string
    readonly capabilities: Capabilities
  }

  /** The install options every backend shares. */
  export interface CommonOptions {
    /** The key namespace (`<prefix>:<key>` on the backend). Default `'kv'`. Several applications
     * share one redis through it; two installs with different prefixes never see each other. */
    readonly prefix?: string | undefined
  }

  export interface SetOptions {
    /** Expire after this many milliseconds. Default: never. */
    readonly ttlMs?: number | undefined

    /** Tag the key so `invalidate(tag)` drops it (and every other key carrying the tag). */
    readonly tags?: readonly string[] | undefined
  }

  export interface IncrOptions {
    /** TTL applied when the counter is CREATED by this call (a window counter). */
    readonly ttlMs?: number | undefined
  }

  export interface KeysOptions {
    /** Page size. Default 100. */
    readonly limit?: number | undefined

    /** Continue a previous page (backend-opaque). */
    readonly cursor?: string | undefined
  }

  export interface KeysPage {
    /** application-relative keys (the install prefix stripped). */
    readonly keys: readonly string[]
    readonly cursor: string | null
  }

  export interface WrapOptions extends SetOptions {
    readonly ttlMs: number
  }

  export interface Actions {
    get<T>(key: string): Operation<T | undefined>
    set<T>(key: string, value: T, options?: SetOptions): Operation<void>

    /** Delete keys; resolves how many existed. */
    del(...keys: readonly string[]): Operation<number>
    has(key: string): Operation<boolean>

    /** Remaining lifetime in ms, `null` when the key has no expiry or does not exist. */
    ttl(key: string): Operation<number | null>

    /** (Re)set a key's lifetime; resolves false when the key does not exist. */
    expire(key: string, ttlMs: number): Operation<boolean>

    /** Atomic counter: add `by` (default 1) and resolve the new value. */
    incr(key: string, by?: number, options?: IncrOptions): Operation<number>

    mget<T>(keys: readonly string[]): Operation<readonly (T | undefined)[]>

    mset<T>(
      entries: readonly (readonly [key: string, value: T])[],
      options?: SetOptions,
    ): Operation<void>

    /** Enumerate keys under a sub-prefix of this install (requires the `scan` capability). */
    keys(prefix?: string, options?: KeysOptions): Operation<KeysPage>

    /** Drop every key carrying any of the tags; resolves how many were removed. */
    invalidate(...tags: readonly string[]): Operation<number>

    /** Cache-aside with singleflight: the value under `key`, or `compute` it once — concurrent
     * callers in this process share the one computation — and store it with the options. */
    wrap<T>(key: string, options: WrapOptions, compute: () => Operation<T>): Operation<T>

    /** Remove every key of this install's namespace; resolves how many were removed. */
    clear(): Operation<number>
  }

  // --- driver ---------------------------------------------------------------------------------

  export interface RawKeys {
    readonly limit: number
    readonly cursor?: string | undefined
  }

  export interface RawSet {
    readonly key: string
    readonly data: Uint8Array
    readonly ttlMs: number | null
    readonly tags: readonly string[]
  }

  /**
   * The backend contract an impl fulfils; everything else is core. Keys arrive fully namespaced
   * (`<prefix>:<key>`), values are bytes. Tag bookkeeping is the driver's (it knows how to make it
   * atomic on its backend).
   */

  export interface Driver {
    readonly capabilities: Capabilities
    get(key: string): Operation<Uint8Array | null>
    set(entry: RawSet): Operation<void>
    del(keys: readonly string[]): Operation<number>
    has(key: string): Operation<boolean>
    ttl(key: string): Operation<number | null>
    expire(key: string, ttlMs: number): Operation<boolean>
    incr(key: string, by: number, ttlMs: number | null): Operation<number>

    /** keys under a namespaced prefix, paged. */
    keys(prefix: string, options: RawKeys): Operation<KeysPage>

    /** drop the keys of every given (namespaced) tag set and the tag sets themselves. */
    invalidate(tags: readonly string[]): Operation<number>

    /** drop everything under a namespaced prefix. */
    clear(prefix: string): Operation<number>
  }
}
