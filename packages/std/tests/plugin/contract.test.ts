/**
 * The plugin module's control surface agrees with its runtime: tags carry the declared version,
 * `getKeys` names every dispatchable key once, a cloneable implementation's definition and built
 * handle share ONE context, a standalone plugin exposes no hook surface while a protocol's hooks
 * still install lazily, `use()` writes the context once, and a masked failure is described.
 */
import { attempt, run, scoped } from 'std:effect'
import type { Operation } from 'std:effect'
import { definePlugin, defineProtocol } from 'std:plugin'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

interface Actions {
  work(): Operation<string>
  fallback?(): Operation<string>
}

describe('plugin — control surface', () => {
  it('tags are exactly name@version', () => {
    const P = defineProtocol<unknown, Actions>({ name: 'tagged', version: '2.1.0' })
    const Impl = P.implement({
      name: 'tagged-impl',
      version: '0.3.0',
      *setup() {
        return {}
      },
    }).build({
      *work() {
        return 'w'
      },
    })

    expect(P.tag).toBe('tagged@2.1.0')
    expect(Impl.tag).toBe('tagged-impl@0.3.0')
  })

  it('getKeys names handlers, defaults and impl actions once each, even when they overlap', () => {
    const P = defineProtocol<unknown, Actions, { handled(): Operation<string> }>({
      name: 'keys',
      version: '1.0.0',
      handlers: {
        *handled() {
          return 'h'
        },
      },
      defaults: {
        *work() {
          return 'default'
        },
        *fallback() {
          return 'f'
        },
      },
    })
    const Impl = P.implement({
      name: 'keys-impl',
      version: '1.0.0',
      *setup() {
        return {}
      },
    }).build({
      *work() {
        return 'impl'
      },
    })

    expect(Impl.getKeys().toSorted()).toEqual(['fallback', 'handled', 'work'])
  })

  it('a cloneable implementation: the definition and the built plugin share one context', async () => {
    const Cl = defineProtocol<{ n: number }, Actions>({
      name: 'cloneable',
      version: '1.0.0',
      cloneable: true,
    })
    const Def = Cl.implement({
      name: 'cloneable-impl',
      version: '1.0.0',
      *setup() {
        return { n: 7 }
      },
    })
    const Built = Def.build({
      *work() {
        return 'w'
      },
    })

    expect(Def.context).toBe(Built.context)
    expect(Built.context.name).toBe('cloneable-impl@1.0.0')

    // the definition's context reads what the install wrote
    const seen = await run(function* () {
      yield* Built.use()
      return yield* Def.context.expect()
    })
    expect(unwrap(seen)).toEqual({ n: 7 })

    const Plain = defineProtocol<{ n: number }, Actions>({ name: 'plain', version: '1.0.0' })
    const PlainDef = Plain.implement({
      name: 'plain-impl',
      version: '1.0.0',
      *setup() {
        return { n: 1 }
      },
    })
    expect(PlainDef.context).toBe(
      PlainDef.build({
        *work() {
          return 'w'
        },
      }).context,
    )
  })

  it('a standalone plugin has no hook surface; a protocol installs its hooks lazily and they work', async () => {
    const Standalone = definePlugin({
      name: 'standalone',
      version: '1.0.0',
      *setup() {
        return { ready: true }
      },
    })
    expect(Object.keys(Standalone)).toEqual(['context', 'build'])
    const built = Standalone.build({
      *ping() {
        return 'pong'
      },
    })
    expect('around' in built).toBe(false)

    const P = defineProtocol<unknown, Actions>({ name: 'lazy-hooks', version: '1.0.0' })
    const Impl = P.implement({
      name: 'lazy-hooks-impl',
      version: '1.0.0',
      *setup() {
        return {}
      },
    }).build({
      *work() {
        return 'core'
      },
    })

    const seen = await run(function* () {
      yield* Impl.use()
      yield* P.around({
        *work(args, next) {
          return `wrapped(${yield* next(...args)})`
        },
      })
      return yield* P.actions.work()
    })
    expect(unwrap(seen)).toBe('wrapped(core)')
  })

  it('use() installs into the current scope once; a child scope inherits, a sibling does not', async () => {
    const P = definePlugin<{ id: number }, [id: number]>({
      name: 'once',
      version: '1.0.0',
      *setup(id) {
        return { id }
      },
    }).build()

    const seen = await run(function* () {
      const value = yield* P.use(1)
      const inner = yield* scoped(function* () {
        return yield* P.context.expect()
      })
      return { value, own: yield* P.context.expect(), inner }
    })
    expect(unwrap(seen)).toEqual({ value: { id: 1 }, own: { id: 1 }, inner: { id: 1 } })
  })

  it('a throwing error hook records what it masked — tag and message, never "undefined"', async () => {
    const P = defineProtocol<unknown, { bare(): Operation<void>; tagged(): Operation<void> }>({
      name: 'masking',
      version: '1.0.0',
      defaults: {
        *bare() {
          return yield* fail()
        },
        *tagged() {
          return yield* fail('op.failed', 'the operation failed')
        },
      },
    })

    const seen = await run(function* () {
      yield* P.error({
        *bare() {
          return yield* fail('hook.threw')
        },
        *tagged() {
          return yield* fail('hook.threw')
        },
      })
      const bare = yield* attempt(() => P.actions.bare())
      const tagged = yield* attempt(() => P.actions.tagged())
      return {
        bare: isFailure(bare) ? bare.causes[0] : 'ok',
        tagged: isFailure(tagged) ? tagged.causes[0] : 'ok',
      }
    })
    expect(unwrap(seen)).toEqual({
      bare: 'masked: untagged failure',
      tagged: 'masked: op.failed: the operation failed',
    })
  })
})
