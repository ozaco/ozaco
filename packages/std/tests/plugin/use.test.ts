import type { Operation } from 'std:effect'
import { run, scoped } from 'std:effect'
import { definePlugin, defineProtocol, isUse } from 'std:plugin'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

const Counter = definePlugin<{ start: number }, [options?: { start?: number }]>({
  name: 'counter',
  version: '0.0.0',
  *setup(options) {
    return { start: options?.start ?? 0 }
  },
}).build({
  *next() {
    const ctx = yield* Counter.context.expect()
    ctx.start += 1
    return ctx.start
  },
})

describe('plugin — use', () => {
  it('installs the plugin into the current scope with its arguments and names the plugin', async () => {
    const use = Counter.use({ start: 10 })
    expect(isUse(use)).toBe(true)
    expect(use.plugin).toBe(Counter)
    expect(use.args).toEqual([{ start: 10 }])
    unwrap(
      await run(function* () {
        const ctx = yield* Counter.use({ start: 10 })
        expect(ctx.start).toBe(10)
        expect(yield* Counter.actions.next()).toBe(11)
        // a child scope sees it; a sibling install replaces it there only
        yield* scoped(function* () {
          expect(yield* Counter.actions.next()).toBe(12)
          yield* Counter.use({ start: 100 })
          expect(yield* Counter.actions.next()).toBe(101)
        })
        expect(yield* Counter.actions.next()).toBe(13)
      }),
    )
  })

  it('works for protocol implementations too', async () => {
    const Greeter = defineProtocol<{ who: string }, { greet(): Operation<string> }>({
      name: 'greeter',
      version: '0.0.0',
    })
    const Hello = Greeter.implement<{ who: string }, [who: string]>({
      name: 'hello',
      version: '0.0.0',
      *setup(who) {
        return { who }
      },
    }).build({
      *greet(): Operation<string> {
        return `hello ${(yield* Greeter.context.expect()).who}`
      },
    })
    unwrap(
      await run(function* () {
        yield* Hello.use('ada')
        expect(yield* Greeter.actions.greet()).toBe('hello ada')
        expect(yield* Hello.actions.greet()).toBe('hello ada')
      }),
    )
  })
})
