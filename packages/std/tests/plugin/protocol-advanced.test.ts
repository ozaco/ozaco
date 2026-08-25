import type { Operation } from 'std:effect'
import { attempt, run, scoped } from 'std:effect'
import type { Protocol } from 'std:plugin'
import { defineProtocol, install } from 'std:plugin'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

let uniq = 0
const name = (base: string) => `${base}-${++uniq}`

interface StoreContext {
  label: string
  priority: number
  rows: Map<string, string>
}

interface StoreActions {
  get(key: string): Operation<string | undefined>
  label(): Operation<string>
}

/** The codec-style selection contract: run the highest-priority impl, ties go to the newest. */
const prioritySelect: Protocol.Exec = function* (entries, dispatch) {
  let best: (typeof entries)[number] | undefined

  for (const entry of entries) {
    if (!best || (entry.value as StoreContext).priority >= (best.value as StoreContext).priority) {
      best = entry
    }
  }

  return yield* dispatch(best)
}

const makeStore = (options?: { exec?: Protocol.Exec; defaults?: boolean }) => {
  const Store = defineProtocol<StoreContext, StoreActions>({
    name: name('store'),
    version: '1.0.0',
    cloneable: true,
    exec: options?.exec,
    ...(options?.defaults
      ? {
          defaults: {
            *label() {
              return 'default-label'
            },
          },
        }
      : {}),
  })

  const impl = (label: string, priority: number, seed: [string, string][] = []) =>
    Store.implement({
      name: label,
      version: '1.0.0',
      *setup(): Operation<StoreContext> {
        return { label, priority, rows: new Map(seed) }
      },
    }).build({
      *get(key) {
        const ctx = yield* Store.context.expect()
        return ctx.rows.get(key)
      },
      *label() {
        const ctx = yield* Store.context.expect()
        return ctx.label
      },
    })

  return { Store, impl }
}

describe('custom exec: priority selection over Install.value', () => {
  it('routes protocol calls to the highest-priority impl regardless of install order', async () => {
    const { Store, impl } = makeStore({ exec: prioritySelect })

    const outcome = await run(function* () {
      yield* install(impl('high', 1000))
      yield* install(impl('low', 1))

      return yield* Store.actions.label()
    })

    expect(unwrap(outcome)).toBe('high')
  })

  it('breaks priority ties toward the most recently installed impl', async () => {
    const { Store, impl } = makeStore({ exec: prioritySelect })

    const outcome = await run(function* () {
      yield* install(impl('older', 500))
      yield* install(impl('newer', 500))

      return yield* Store.actions.label()
    })

    expect(unwrap(outcome)).toBe('newer')
  })

  it('leaves pinned plugin calls untouched by the selection', async () => {
    const { Store, impl } = makeStore({ exec: prioritySelect })
    const Low = impl('low', 1)

    const outcome = await run(function* () {
      yield* install(impl('high', 1000))
      yield* install(Low)

      return { routed: yield* Store.actions.label(), pinned: yield* Low.actions.label() }
    })

    expect(unwrap(outcome)).toEqual({ routed: 'high', pinned: 'low' })
  })

  it('with no installs the exec receives an empty list and dispatch(undefined) falls back to defaults', async () => {
    let observed = -1
    const spyingSelect: Protocol.Exec = function* (entries, dispatch) {
      observed = entries.length
      return yield* dispatch(entries.at(-1))
    }

    const { Store } = makeStore({ exec: spyingSelect, defaults: true })

    const outcome = await run(function* () {
      return yield* Store.actions.label()
    })

    expect(unwrap(outcome)).toBe('default-label')
    expect(observed).toBe(0)
  })

  it('a fan-out exec runs every impl while hooks fire ONCE around the whole dispatch', async () => {
    const fanout: Protocol.Exec = function* (entries, dispatch) {
      const results: unknown[] = []
      for (const entry of entries) {
        results.push(yield* dispatch(entry))
      }
      return results
    }

    const { Store, impl } = makeStore({ exec: fanout })
    const trace: string[] = []

    const outcome = await run(function* () {
      yield* install(impl('a', 1))
      yield* install(impl('b', 2))

      yield* Store.before({
        *label() {
          trace.push('before')
        },
      })
      yield* Store.after({
        *label(result) {
          trace.push(`after:${JSON.stringify(result)}`)
        },
      })

      return (yield* Store.actions.label()) as unknown
    })

    expect(unwrap(outcome)).toEqual(['a', 'b'])
    // one dispatch → one before + one after (seeing the aggregated array), not one per impl
    expect(trace).toEqual(['before', 'after:["a","b"]'])
  })
})

describe('dispatch resolution edge cases', () => {
  it('protocol-level handlers win over an impl action with the same key and run without impl context', async () => {
    interface DualActions {
      info(): Operation<string>
    }

    const Dual = defineProtocol<{ label: string }, DualActions>({
      name: name('dual'),
      version: '1.0.0',
      handlers: {
        *info() {
          return 'from-handler'
        },
      },
    })

    const Impl = Dual.implement({
      name: name('dual-impl'),
      version: '1.0.0',
      *setup() {
        return { label: 'impl' }
      },
    }).build({
      *info() {
        return 'from-impl'
      },
    })

    const outcome = await run(function* () {
      yield* install(Impl)
      return yield* Dual.actions.info()
    })

    expect(unwrap(outcome)).toBe('from-handler')
  })

  it('keys colliding with Object.prototype resolve to own actions only', async () => {
    interface ProtoActions {
      toString(): Operation<string>
    }

    const Proto = defineProtocol<unknown, ProtoActions>({
      name: name('proto'),
      version: '1.0.0',
    })

    const Impl = Proto.implement({
      name: name('proto-impl'),
      version: '1.0.0',
      *setup() {
        return {}
      },
    }).build({
      *toString() {
        return 'own-action'
      },
    })

    const outcome = await run(function* () {
      yield* install(Impl)

      const owned = yield* Proto.actions.toString()

      // `valueOf` exists on Object.prototype but is NOT an own action → must be missing-action,
      // never the inherited function (the cast bypasses the contract type to reach the proxy)
      const dispatchValueOf = Proto.actions as unknown as { valueOf(): Operation<unknown> }
      const missing = yield* attempt(() => dispatchValueOf.valueOf())

      return { owned, missing: isFailure(missing) && missing.error }
    })

    expect(unwrap(outcome)).toEqual({ owned: 'own-action', missing: 'missing-action' })
  })

  it('re-installing the same plugin replaces its registry entry instead of duplicating it', async () => {
    let seen = -1
    const countingExec: Protocol.Exec = function* (entries, dispatch) {
      seen = entries.length
      return yield* dispatch(entries.at(-1))
    }

    const { impl, Store } = makeStore({ exec: countingExec })
    const Same = impl('same', 1, [['k', 'first-value']])

    const outcome = await run(function* () {
      yield* install(Same)
      yield* install(Same)

      return yield* Store.actions.get('k')
    })

    expect(unwrap(outcome)).toBe('first-value')
    expect(seen).toBe(1)
  })

  it('a failing setup aborts the install and leaves the registry untouched', async () => {
    interface FlakyActions {
      ping(): Operation<string>
    }

    const Flaky = defineProtocol<unknown, FlakyActions>({
      name: name('flaky'),
      version: '1.0.0',
    })

    const Broken = Flaky.implement({
      name: name('flaky-impl'),
      version: '1.0.0',
      *setup() {
        return yield* fail('setup-exploded', 'nope')
      },
    }).build({
      *ping() {
        return 'pong'
      },
    })

    const outcome = await run(function* () {
      const installAttempt = yield* attempt(() => install(Broken))
      const dispatchAttempt = yield* attempt(() => Flaky.actions.ping())

      return {
        install: isFailure(installAttempt) && installAttempt.error,
        dispatch: isFailure(dispatchAttempt) && dispatchAttempt.error,
      }
    })

    expect(unwrap(outcome)).toEqual({ install: 'setup-exploded', dispatch: 'missing-action' })
  })

  it('a protocol call made INSIDE a pinned action dispatches normally (pin does not stick)', async () => {
    interface ComboContext {
      label: string
    }
    interface ComboActions {
      who(): Operation<string>
      viaProtocol(): Operation<string>
    }

    const Combo = defineProtocol<ComboContext, ComboActions>({
      name: name('combo'),
      version: '1.0.0',
      cloneable: true,
    })

    const impl = (label: string) =>
      Combo.implement({
        name: label,
        version: '1.0.0',
        *setup() {
          return { label }
        },
      }).build({
        *who() {
          const ctx = yield* Combo.context.expect()
          return ctx.label
        },
        *viaProtocol() {
          // dispatched through the PROTOCOL: default exec must pick the last install,
          // not the impl this action was pinned to
          return yield* Combo.actions.who()
        },
      })

    const First = impl('first')
    const Second = impl('second')

    const outcome = await run(function* () {
      yield* install(First)
      yield* install(Second)

      return {
        pinnedWho: yield* First.actions.who(),
        innerDispatch: yield* First.actions.viaProtocol(),
      }
    })

    expect(unwrap(outcome)).toEqual({ pinnedWho: 'first', innerDispatch: 'second' })
  })
})

describe('cloneable contexts + metadata', () => {
  it('each cloneable impl keeps its own context; the protocol context tracks the dispatched impl', async () => {
    const { Store, impl } = makeStore()
    const First = impl('first', 1)
    const Second = impl('second', 2)

    const outcome = await run(function* () {
      const firstValue = yield* install(First)
      const secondValue = yield* install(Second)

      return {
        firstCtx: (yield* First.context.expect()).label,
        secondCtx: (yield* Second.context.expect()).label,
        distinct: firstValue !== secondValue,
        // default exec: last install answers protocol calls
        dispatched: yield* Store.actions.label(),
      }
    })

    expect(unwrap(outcome)).toEqual({
      firstCtx: 'first',
      secondCtx: 'second',
      distinct: true,
      dispatched: 'second',
    })
  })

  it('getKeys merges defaults with impl actions and getMeta exposes static action props', async () => {
    interface MetaActions {
      work(): Operation<string>
      // optional in the contract: impls may omit it, the protocol default fills the gap
      fallback?(): Operation<string>
    }

    const Meta = defineProtocol<unknown, MetaActions>({
      name: name('meta'),
      version: '1.0.0',
      defaults: {
        *fallback() {
          return 'fallback'
        },
      },
    })

    const workFn = Object.assign(
      function* (): Generator<never, string, never> {
        return 'worked'
      },
      { description: 'does the work', weight: 3 },
    )

    const Impl = Meta.implement({
      name: name('meta-impl'),
      version: '1.0.0',
      *setup() {
        return {}
      },
    }).build({
      work: workFn,
    })

    expect(Impl.getKeys().toSorted()).toEqual(['fallback', 'work'])
    expect(Impl.getMeta('work')).toEqual({ description: 'does the work', weight: 3 })
    expect(Impl.getMeta('fallback')).toBeUndefined()

    const outcome = await run(function* () {
      yield* install(Impl)
      return [yield* Meta.actions.work(), yield* Meta.actions.fallback!()]
    })

    expect(unwrap(outcome)).toEqual(['worked', 'fallback'])
  })
})

describe('hook layering', () => {
  it('stacked error hooks all observe the failure, innermost first', async () => {
    interface BoomActions {
      boom(): Operation<never>
    }

    const Boom = defineProtocol<unknown, BoomActions>({
      name: name('boom'),
      version: '1.0.0',
      defaults: {
        *boom() {
          return yield* fail('original-boom', 'kaput')
        },
      },
    })

    const seen: string[] = []

    const outcome = await run(function* () {
      yield* Boom.error({
        *boom() {
          seen.push('outer-hook')
        },
      })
      yield* Boom.error({
        *boom() {
          seen.push('inner-hook')
        },
      })

      return yield* Boom.actions.boom()
    })

    expect(isFailure(outcome)).toBe(true)
    expect(seen).toEqual(['inner-hook', 'outer-hook'])
  })

  it('hooks decorate PINNED plugin calls too', async () => {
    const { Store, impl } = makeStore()
    const Impl = impl('solo', 1, [['k', 'v']])
    const trace: string[] = []

    const outcome = await run(function* () {
      yield* install(Impl)

      yield* Store.before({
        *get(args) {
          trace.push(`before:${args[0]}`)
        },
      })

      return yield* Impl.actions.get('k')
    })

    expect(unwrap(outcome)).toBe('v')
    expect(trace).toEqual(['before:k'])
  })

  it('before/after hooks reach nested dot-path actions', async () => {
    interface TreeActions {
      fs: {
        read(path: string): Operation<string>
      }
    }

    const Tree = defineProtocol<{ prefix: string }, TreeActions>({
      name: name('tree'),
      version: '1.0.0',
    })

    const Impl = Tree.implement({
      name: name('tree-impl'),
      version: '1.0.0',
      *setup() {
        return { prefix: 'mem:' }
      },
    }).build({
      fs: {
        *read(path: string) {
          const ctx = yield* Tree.context.expect()
          return `${ctx.prefix}${path}`
        },
      },
    })

    const trace: string[] = []

    const outcome = await run(function* () {
      yield* install(Impl)

      yield* Tree.before({
        fs: {
          *read(args) {
            trace.push(`before:${args[0]}`)
          },
        },
      })
      yield* Tree.after({
        fs: {
          *read(result) {
            trace.push(`after:${result}`)
            return `${result}!`
          },
        },
      })

      return yield* Tree.actions.fs.read('/x')
    })

    expect(unwrap(outcome)).toBe('mem:/x!')
    expect(trace).toEqual(['before:/x', 'after:mem:/x'])
  })

  it('hook layers installed in a child scope disappear when the scope closes, keeping parent layers', async () => {
    const { Store, impl } = makeStore()
    const trace: string[] = []

    const outcome = await run(function* () {
      yield* install(impl('solo', 1, [['k', 'v']]))

      yield* Store.before({
        *get() {
          trace.push('parent')
        },
      })

      yield* scoped(function* () {
        yield* Store.before({
          *get() {
            trace.push('child')
          },
        })
        yield* Store.actions.get('k')
      })

      yield* Store.actions.get('k')
      return trace
    })

    expect(unwrap(outcome)).toEqual(['parent', 'child', 'parent'])
  })
})
