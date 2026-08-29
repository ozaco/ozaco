import type { Operation } from 'std:effect'
import { run, scoped, useScope } from 'std:effect'
import type { Protocol } from 'std:plugin'
import { definePlugin, defineProtocol, install, isPlugin, isProtocol } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

interface DbContext {
  rows: Map<number, string>
}

interface DbActions {
  find(id: number): Operation<string | undefined>
  put(id: number, row: string): Operation<void>
}

const makeDb = (options?: { cloneable?: boolean; exec?: Protocol.Exec }) => {
  const Db = defineProtocol<DbContext, DbActions>({
    name: `db-${Math.random().toString(36).slice(2)}`,
    version: '1.0.0',
    cloneable: options?.cloneable,
    exec: options?.exec,
  })

  const memory = (name: string) =>
    Db.implement({
      name,
      version: '1.0.0',
      *setup(seed: [number, string][]) {
        return { rows: new Map(seed) }
      },
    }).build({
      *find(id) {
        const ctx = yield* Db.context.expect()
        return ctx.rows.get(id)
      },
      *put(id, row) {
        const ctx = yield* Db.context.expect()
        ctx.rows.set(id, row)
      },

      // extras are OUTSIDE the contract, so nothing can contextually type their params —
      // annotate them explicitly
      *put2(id: number, row: string) {
        const ctx = yield* Db.context.expect()
        ctx.rows.set(id, row)
      },
      testValue: 12,
    })

  return { Db, memory }
}

describe('protocol (flat surface)', () => {
  it('installs an impl and dispatches flat calls with its context', async () => {
    const { Db, memory } = makeDb()
    const MemoryDb = memory('memory-db')

    const outcome = await run(function* () {
      yield* install(MemoryDb, [[1, 'one']])

      yield* Db.actions.put(2, 'two')
      return [yield* Db.actions.find(1), yield* Db.actions.find(2)]
    })

    expect(unwrap(outcome)).toEqual(['one', 'two'])
  })

  it('fails with missing-action when nothing is installed', async () => {
    const { Db } = makeDb()

    const outcome = await run(function* () {
      return yield* Db.actions.find(1)
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('missing-action')
    }
  })

  it('installs are scope-local: children inherit, siblings do not', async () => {
    const { Db, memory } = makeDb()
    const MemoryDb = memory('memory-db')

    const outcome = await run(function* () {
      const inside = yield* scoped(function* () {
        yield* install(MemoryDb, [[1, 'one']])
        return yield* Db.actions.find(1)
      })

      let after: unknown
      try {
        after = yield* Db.actions.find(1)
      } catch (error) {
        after = isFailure(error) ? 'missing' : error
      }

      return { inside, after }
    })

    expect(unwrap(outcome)).toEqual({ inside: 'one', after: 'missing' })
  })

  it('plugin handles pin dispatch to their own impl', async () => {
    const { Db, memory } = makeDb({ cloneable: true })
    const First = memory('first-db')
    const Second = memory('second-db')

    const outcome = await run(function* () {
      yield* install(First, [[1, 'from-first']])
      yield* install(Second, [[1, 'from-second']])

      return {
        protocol: yield* Db.actions.find(1), // default exec: last installed wins
        first: yield* First.actions.find(1),
        second: yield* Second.actions.find(1),
      }
    })

    expect(unwrap(outcome)).toEqual({
      protocol: 'from-second',
      first: 'from-first',
      second: 'from-second',
    })
  })

  it('a custom exec can fan out over every installed impl', async () => {
    const fanout: Protocol.Exec = function* (entries, dispatch) {
      const results: unknown[] = []
      for (const entry of entries) {
        results.push(yield* dispatch(entry))
      }
      return results
    }

    const { Db, memory } = makeDb({ cloneable: true, exec: fanout })

    const outcome = await run(function* () {
      yield* install(memory('a-db'), [[1, 'a']])
      yield* install(memory('b-db'), [[1, 'b']])

      // the fan-out exec turns a single-impl result into an array of every impl's result
      return (yield* Db.actions.find(1)) as unknown
    })

    expect(unwrap(outcome)).toEqual(['a', 'b'])
  })

  it('non-cloneable protocols refuse a second different impl', async () => {
    const { Db, memory } = makeDb()

    const outcome = await run(function* () {
      yield* install(memory('one-db'), [])
      yield* install(memory('other-db'), [])
      return yield* Db.actions.find(1)
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('protocol-not-cloneable')
    }
  })
})

describe('protocol handlers + defaults', () => {
  interface MathActions {
    triple(n: number): Operation<number>
  }

  it('handlers run without an impl; defaults fill impl gaps', async () => {
    const Math_ = defineProtocol<unknown, MathActions, { label(): Operation<string> }>({
      name: `math-${Math.random().toString(36).slice(2)}`,
      version: '1.0.0',
      handlers: {
        *label() {
          return 'math protocol'
        },
      },
      defaults: {
        *triple(n: number) {
          return n * 3
        },
      },
    })

    const outcome = await run(function* () {
      // handler works without any install
      const described = yield* Math_.actions.label()

      // defaults require a dispatched entry? no — with no installs the default still runs
      const tripled = yield* Math_.actions.triple(7)

      return { described, tripled }
    })

    expect(unwrap(outcome)).toEqual({ described: 'math protocol', tripled: 21 })
  })
})

describe('hooks over the api layer', () => {
  it('before/after/around compose and revert with the scope', async () => {
    const { Db, memory } = makeDb()
    const MemoryDb = memory('memory-db')
    const trace: string[] = []

    const outcome = await run(function* () {
      yield* install(MemoryDb, [[1, 'one']])

      const decorated = yield* scoped(function* () {
        yield* Db.before({
          *find(args) {
            trace.push(`before:${args[0]}`)
          },
        })
        yield* Db.after({
          *find(result) {
            trace.push(`after:${result}`)
            return `${result}!`
          },
        })
        yield* Db.around({
          find: ([id], next) =>
            (function* () {
              trace.push('around:in')
              const result = yield* next(id)
              trace.push('around:out')
              return result
            })(),
        })

        return yield* Db.actions.find(1)
      })

      const plain = yield* Db.actions.find(1)

      return { decorated, plain }
    })

    expect(unwrap(outcome)).toEqual({ decorated: 'one!', plain: 'one' })
    // hook layers compose in installation order: earlier installs wrap later ones
    expect(trace).toEqual(['before:1', 'around:in', 'around:out', 'after:one'])
  })

  it('error hooks observe failures; a throwing hook masks with causes', async () => {
    interface BoomActions {
      boom(): Operation<never>
    }

    const Boom = defineProtocol<unknown, BoomActions>({
      name: `boom-${Math.random().toString(36).slice(2)}`,
      version: '1.0.0',
      defaults: {
        *boom() {
          throw new Error('original boom')
        },
      },
    })

    const seen: unknown[] = []

    const observed = await run(function* () {
      yield* Boom.error({
        *boom(error) {
          seen.push(error)
        },
      })
      return yield* Boom.actions.boom()
    })

    expect(isFailure(observed)).toBe(true)
    expect(seen).toHaveLength(1)

    const masked = await run(function* () {
      yield* Boom.error({
        *boom() {
          throw new Error('hook boom')
        },
      })
      return yield* Boom.actions.boom()
    })

    expect(isFailure(masked)).toBe(true)
    if (isFailure(masked)) {
      expect(masked.causes.join(' ')).toContain('masked')
    }
  })
})

describe('nested actions + standalone plugins + guards', () => {
  it('supports nested action groups via dot paths', async () => {
    interface FsActions {
      fs: {
        read(path: string): Operation<string>
      }
    }

    const Io = defineProtocol<{ prefix: string }, FsActions>({
      name: `io-${Math.random().toString(36).slice(2)}`,
      version: '1.0.0',
    })

    const MemIo = Io.implement({
      name: 'mem-io',
      version: '1.0.0',
      *setup() {
        return { prefix: 'mem:' }
      },
    }).build({
      fs: {
        *read(path: string) {
          const ctx = yield* Io.context.expect()
          return `${ctx.prefix}${path}`
        },
      },
    })

    const outcome = await run(function* () {
      yield* install(MemIo)
      return yield* Io.actions.fs.read('/tmp/x')
    })

    expect(unwrap(outcome)).toBe('mem:/tmp/x')
  })

  it('build accepts extras beyond the contract: custom actions and value members', async () => {
    const { Db, memory } = makeDb()
    void memory

    const Extended = Db.implement({
      name: 'extended-db',
      version: '1.0.0',
      *setup(seed?: [number, string][]) {
        return { rows: new Map(seed) }
      },
    }).build({
      *find(id) {
        const ctx = yield* Db.context.expect()
        return ctx.rows.get(id)
      },
      *put(id, row) {
        const ctx = yield* Db.context.expect()
        ctx.rows.set(id, row)
      },

      // extras beyond the contract
      *size() {
        const ctx = yield* Db.context.expect()
        return ctx.rows.size
      },
      testValue: 13,
    })

    const outcome = await run(function* () {
      yield* install(Extended, [[1, 'one']])

      return {
        contract: yield* Extended.actions.find(1),
        custom: yield* Extended.actions.size(),
        // api-style value member: yield it directly, no call
        value: yield* Extended.actions.testValue,
      }
    })

    expect(unwrap(outcome)).toEqual({ contract: 'one', custom: 1, value: 13 })
  })

  it('definePlugin builds a standalone pinned plugin', async () => {
    const Counter = definePlugin({
      name: `counter-${Math.random().toString(36).slice(2)}`,
      version: '1.0.0',
      *setup(start: number) {
        return { value: start }
      },
    }).build({
      *increment() {
        const ctx = (yield* Counter.context.expect()) as { value: number }
        ctx.value += 1
        return ctx.value
      },
    })

    const outcome = await run(function* () {
      yield* install(Counter, 41)
      return yield* Counter.actions.increment()
    })

    expect(unwrap(outcome)).toBe(42)
  })

  it('type guards + control members survive the proxy', async () => {
    const { Db, memory } = makeDb()
    const MemoryDb = memory('memory-db')

    expect(isProtocol(Db)).toBe(true)
    expect(isPlugin(MemoryDb)).toBe(true)
    expect(isPlugin(Db)).toBe(false)
    expect(MemoryDb.getKeys()).toEqual(['find', 'put', 'put2', 'testValue'])

    const outcome = await run(function* () {
      const scope = yield* useScope()
      const value = yield* install(MemoryDb, [[9, 'nine']])

      return scope.get(MemoryDb.context) === value
    })

    expect(unwrap(outcome)).toBe(true)
  })
})
