// oxlint-disable import/exports-last
import type { KvDef } from 'db:core'
import { Kv, KvErrors } from 'db:core'
import type { Operation } from 'std:effect'
import {
  all,
  attempt,
  createQueue,
  fork,
  race,
  run,
  scoped,
  sleep,
  suspend,
  useContext,
  withResolvers,
} from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

/** One Kv backend under end-to-end test. */
export interface KvTarget {
  /** Must equal the impl's `info.store`. */
  readonly label: string
  /** false → the whole suite is skipped (e.g. no live redis configured). */
  readonly enabled: boolean
  /** Install a store into the current scope under a key prefix (default `'suite'`). Every call
   * must join the SAME backend (a shared memory link, one redis). */
  readonly use: (prefix?: string) => Operation<unknown>
  readonly expect: {
    readonly persistent: boolean
    readonly atomic: boolean
  }
}

const unique = (name: string): string => `${name}.${crypto.randomUUID().slice(0, 8)}`

/**
 * The suite every Kv store must pass: values through the codec, TTLs, tags, counters, scans,
 * `wrap` singleflight, namespace isolation and the cross-scope case (two installs sharing one
 * backend).
 */
export const runKvSuite = (target: KvTarget): void => {
  describe.skipIf(!target.enabled)(`kv — ${target.label}`, () => {
    it('reports identity, prefix and capabilities', async () => {
      unwrap(
        await run(function* () {
          yield* target.use()
          const info = yield* useContext(Kv)
          expect(info.store).toBe(target.label)
          expect(info.prefix).toBe('suite')
          expect(info.capabilities.persistent).toBe(target.expect.persistent)
          expect(info.capabilities.atomic).toBe(target.expect.atomic)
        }),
      )
    })

    it('get/set/has/del round-trip codec values of every shape; missing keys are undefined', async () => {
      unwrap(
        await run(function* () {
          yield* target.use()
          const key = unique('v')
          expect(yield* Kv.actions.get<AnyType>(key)).toBeUndefined()
          expect(yield* Kv.actions.has(key)).toBe(false)
          const value = { n: 1, s: 'x', list: [1, 2, 3], nested: { ok: true }, nil: null }
          yield* Kv.actions.set(key, value)
          expect(yield* Kv.actions.get<AnyType>(key)).toEqual(value)
          expect(yield* Kv.actions.has(key)).toBe(true)
          yield* Kv.actions.set(`${key}.str`, 'plain')
          yield* Kv.actions.set(`${key}.num`, 42)
          yield* Kv.actions.set(`${key}.bool`, false)
          expect(yield* Kv.actions.get<AnyType>(`${key}.str`)).toBe('plain')
          expect(yield* Kv.actions.get<AnyType>(`${key}.num`)).toBe(42)
          expect(yield* Kv.actions.get<AnyType>(`${key}.bool`)).toBe(false)
          expect(yield* Kv.actions.del(key, `${key}.str`, `${key}.none`)).toBe(2)
          expect(yield* Kv.actions.get<AnyType>(key)).toBeUndefined()
          expect(yield* Kv.actions.del()).toBe(0)
        }),
      )
    })

    it('ttl: values expire; ttl() reports remaining lifetime; expire() resets it', async () => {
      unwrap(
        await run(function* () {
          yield* target.use()
          const key = unique('ttl')
          yield* Kv.actions.set(key, 'soon', { ttlMs: 120 })
          const left = yield* Kv.actions.ttl(key)
          expect(left).not.toBeNull()
          expect(left!).toBeLessThanOrEqual(120)
          expect(left!).toBeGreaterThan(0)
          yield* Kv.actions.set(`${key}.forever`, 'stays')
          expect(yield* Kv.actions.ttl(`${key}.forever`)).toBeNull()
          expect(yield* Kv.actions.ttl(`${key}.missing`)).toBeNull()
          expect(yield* Kv.actions.expire(`${key}.missing`, 100)).toBe(false)
          // extend the short one: it must outlive its original deadline
          expect(yield* Kv.actions.expire(key, 600)).toBe(true)
          yield* sleep(200)
          expect(yield* Kv.actions.get<AnyType>(key)).toBe('soon')
          yield* Kv.actions.set(`${key}.gone`, 'bye', { ttlMs: 50 })
          yield* sleep(120)
          expect(yield* Kv.actions.get<AnyType>(`${key}.gone`)).toBeUndefined()
          expect(yield* Kv.actions.has(`${key}.gone`)).toBe(false)
        }),
      )
    })

    it('tags: invalidate drops every key carrying the tag, nothing else', async () => {
      unwrap(
        await run(function* () {
          yield* target.use()
          const base = unique('tag')
          const tagA = unique('a')
          const tagB = unique('b')
          yield* Kv.actions.set(`${base}.1`, 1, { tags: [tagA] })
          yield* Kv.actions.set(`${base}.2`, 2, { tags: [tagA, tagB] })
          yield* Kv.actions.set(`${base}.3`, 3, { tags: [tagB] })
          yield* Kv.actions.set(`${base}.4`, 4)
          expect(yield* Kv.actions.invalidate(tagA)).toBe(2)
          expect(
            yield* Kv.actions.mget<AnyType>([`${base}.1`, `${base}.2`, `${base}.3`, `${base}.4`]),
          ).toEqual([undefined, undefined, 3, 4])
          // a re-set key drops its old tags: invalidating tagB must not touch the re-set one
          yield* Kv.actions.set(`${base}.3`, 33)
          expect(yield* Kv.actions.invalidate(tagB, unique('never'))).toBe(0)
          expect(yield* Kv.actions.get<AnyType>(`${base}.3`)).toBe(33)
          expect(yield* Kv.actions.invalidate()).toBe(0)
        }),
      )
    })

    it('incr: counters start at zero, add atomically, and a window TTL applies on creation only', async () => {
      unwrap(
        await run(function* () {
          yield* target.use()
          const key = unique('n')
          expect(yield* Kv.actions.incr(key)).toBe(1)
          expect(yield* Kv.actions.incr(key, 5)).toBe(6)
          expect(yield* Kv.actions.incr(key, -2)).toBe(4)
          // the counter reads back as a number through get
          expect(yield* Kv.actions.get<AnyType>(key)).toBe(4)
          const windowed = unique('w')
          yield* Kv.actions.incr(windowed, 1, { ttlMs: 150 })
          yield* Kv.actions.incr(windowed, 1, { ttlMs: 10_000 }) // not the creator: ttl untouched
          const left = yield* Kv.actions.ttl(windowed)
          expect(left).not.toBeNull()
          expect(left!).toBeLessThanOrEqual(150)
          // concurrent increments never lose an update
          const results = yield* all(
            Array.from({ length: 20 }, () => Kv.actions.incr(`${key}.race`)),
          )
          expect(new Set(results).size).toBe(20)
          expect(yield* Kv.actions.get<AnyType>(`${key}.race`)).toBe(20)
        }),
      )
    })

    it('mset/mget and keys(): a namespace scan pages through in order', async () => {
      unwrap(
        await run(function* () {
          yield* target.use()
          const base = unique('scan')
          yield* Kv.actions.mset(
            Array.from({ length: 7 }, (_, index) => [`${base}.${index}`, index] as const),
          )
          expect(yield* Kv.actions.mget<AnyType>([`${base}.0`, `${base}.6`, `${base}.9`])).toEqual([
            0,
            6,
            undefined,
          ])
          const seen: string[] = []
          let cursor: string | undefined = undefined
          for (;;) {
            const page: KvDef.KeysPage = yield* Kv.actions.keys(`${base}.`, { limit: 3, cursor })
            seen.push(...page.keys)
            if (page.cursor === null) {
              break
            }
            cursor = page.cursor
          }
          // keys come back application-relative (no install prefix)
          expect(seen.toSorted()).toEqual(
            Array.from({ length: 7 }, (_, index) => `${base}.${index}`),
          )
        }),
      )
    })

    it('wrap: cache-aside computes once per key, shares one in-flight computation, re-raises failures', async () => {
      unwrap(
        await run(function* () {
          yield* target.use()
          const key = unique('wrap')
          let computed = 0
          const compute = function* () {
            computed += 1
            yield* sleep(50)
            return { at: computed }
          }
          const fanned = yield* all(
            Array.from({ length: 5 }, () => Kv.actions.wrap(key, { ttlMs: 10_000 }, compute)),
          )
          expect(computed).toBe(1)
          expect(fanned.every(value => (value as AnyType).at === 1)).toBe(true)
          // already cached: no computation at all
          expect(yield* Kv.actions.wrap(key, { ttlMs: 10_000 }, compute)).toEqual({ at: 1 })
          expect(computed).toBe(1)
          // a failing compute caches nothing and reaches the caller intact
          const broken = yield* attempt(
            Kv.actions.wrap(`${key}.bad`, { ttlMs: 1000 }, function* () {
              return yield* fail('compute.broken', 'nope')
            }),
          )
          expect((broken as AnyType).error).toBe('compute.broken')
          expect(yield* Kv.actions.get<AnyType>(`${key}.bad`)).toBeUndefined()
          // tags given to wrap apply to the stored value
          const tag = unique('t')
          yield* Kv.actions.wrap(`${key}.tagged`, { ttlMs: 1000, tags: [tag] }, function* () {
            return 'v'
          })
          expect(yield* Kv.actions.invalidate(tag)).toBe(1)
        }),
      )
    })

    it('wrap onSource: miss computes, a concurrent caller is coalesced, the stored value is a hit', async () => {
      unwrap(
        await run(function* () {
          yield* target.use()
          const key = unique('source')
          const sources: string[] = []
          const onSource = (source: KvDef.Source) => {
            sources.push(source)
          }
          let computed = 0
          const compute = function* () {
            // what the callback said is known BEFORE a miss computes
            expect(sources.at(-1)).toBe('miss')
            computed += 1
            yield* sleep(30)
            return computed
          }

          const answers = yield* all([
            Kv.actions.wrap(key, { ttlMs: 10_000, onSource }, compute),
            Kv.actions.wrap(key, { ttlMs: 10_000, onSource }, compute),
          ])
          expect(answers).toEqual([1, 1])
          expect(sources).toEqual(['miss', 'coalesced'])

          expect(yield* Kv.actions.wrap(key, { ttlMs: 10_000, onSource }, compute)).toBe(1)
          expect(sources).toEqual(['miss', 'coalesced', 'hit'])
          expect(computed).toBe(1)

          // a throwing callback is ignored: the answer still comes back
          const throwing = () => {
            throw new Error('telemetry hook')
          }
          expect(yield* Kv.actions.wrap(key, { ttlMs: 10_000, onSource: throwing }, compute)).toBe(
            1,
          )
        }),
      )
    })

    it('wrap: a halted leader releases the callers that joined it — one goes round and leads', async () => {
      unwrap(
        await run(function* () {
          yield* target.use()
          const key = unique('halt')
          const sources: string[] = []
          const onSource = (source: KvDef.Source) => {
            sources.push(source)
          }
          const computing = withResolvers<void>()

          const leader = yield* fork(() =>
            Kv.actions.wrap(key, { ttlMs: 10_000 }, function* () {
              computing.resolve()
              yield* suspend()
              return -1
            }),
          )
          yield* computing.operation

          const follower = yield* fork(() =>
            Kv.actions.wrap(key, { ttlMs: 10_000, onSource }, function* () {
              return 2
            }),
          )
          // the follower has joined the leader's flight
          while (sources.length === 0) {
            yield* sleep(1)
          }
          expect(sources).toEqual(['coalesced'])

          yield* leader.halt()

          const answer = yield* race([
            follower,
            (function* () {
              yield* sleep(1000)
              return 'hung' as const
            })(),
          ])
          expect(answer).toBe(2)
          // it went round again: nothing stored, no flight left — it led itself
          expect(sources).toEqual(['coalesced', 'miss'])
          expect(yield* Kv.actions.get<number>(key)).toBe(2)

          // no stale flight either: the next caller reads the stored value
          expect(
            yield* Kv.actions.wrap(key, { ttlMs: 10_000, onSource }, function* () {
              return 3
            }),
          ).toBe(2)
          expect(sources.at(-1)).toBe('hit')
        }),
      )
    })

    it('wrap: a leader halted with nobody waiting leaves no stale flight behind', async () => {
      unwrap(
        await run(function* () {
          yield* target.use()
          const key = unique('stale')
          const computing = withResolvers<void>()

          const leader = yield* fork(() =>
            Kv.actions.wrap(key, { ttlMs: 10_000 }, function* () {
              computing.resolve()
              yield* suspend()
              return -1
            }),
          )
          yield* computing.operation
          yield* leader.halt()

          const answer = yield* race([
            Kv.actions.wrap(key, { ttlMs: 10_000 }, function* () {
              return 'fresh'
            }),
            (function* () {
              yield* sleep(1000)
              return 'hung' as const
            })(),
          ])
          expect(answer).toBe('fresh')
        }),
      )
    })

    it('prefix: installs under different prefixes never see each other; clear() empties only its own', async () => {
      unwrap(
        await run(function* () {
          const key = unique('iso')
          yield* scoped(function* () {
            yield* target.use('other')
            yield* Kv.actions.set(key, 'theirs')
          })
          yield* target.use()
          expect(yield* Kv.actions.get<AnyType>(key)).toBeUndefined()
          yield* Kv.actions.set(key, 'mine')
          yield* Kv.actions.set(`${key}.2`, 'mine too')
          expect(yield* Kv.actions.clear()).toBeGreaterThanOrEqual(2)
          expect(yield* Kv.actions.get<AnyType>(key)).toBeUndefined()
          yield* scoped(function* () {
            yield* target.use('other')
            expect(yield* Kv.actions.get<AnyType>(key)).toBe('theirs')
            yield* Kv.actions.clear()
          })
        }),
      )
    })

    it('two installs in separate scopes share the backend', async () => {
      unwrap(
        await run(function* () {
          const key = unique('cross')
          const ready = createQueue<void, void>()
          const reader = yield* fork(() =>
            scoped(function* () {
              yield* target.use()
              ready.add(undefined)
              for (;;) {
                const value = yield* Kv.actions.get<string>(key)
                if (value !== undefined) {
                  return value
                }
                yield* sleep(10)
              }
            }),
          )
          yield* ready.next()
          yield* scoped(function* () {
            yield* target.use()
            yield* Kv.actions.set(key, 'shared')
          })
          expect(yield* reader).toBe('shared')
        }),
      )
    })

    it('an invalid prefix fails kv.configuration', async () => {
      const outcome = await run(() => target.use('bad:prefix'))
      expect(isFailure(outcome)).toBe(true)
      expect((outcome as AnyType).error).toBe(KvErrors.Configuration)
    })
  })
}
