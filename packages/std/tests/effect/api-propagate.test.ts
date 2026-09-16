/**
 * `Api.around` across scopes: an ancestor that decorates AFTER a child already did composes each
 * layer exactly once in the child — the ancestor's local layers reach the child through its
 * total, never by seeding the child's own local.
 */
import { createApi, run, sleep, spawn } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

const tag = (label: string) => ({
  hello: (args: [string], next: (name: string) => string) => `${label}(${next(...args)})`,
})

describe('api — decoration across scopes', () => {
  it('a later ancestor decoration is composed once in a child that decorated first', async () => {
    const Greeter = createApi('test:Greeter', { hello: (name: string) => `hi ${name}` })

    unwrap(
      await run(function* () {
        yield* Greeter.around(tag('A1'))

        const child = yield* spawn(function* () {
          yield* Greeter.around(tag('C'))
          yield* sleep(5)
          return yield* Greeter.actions.hello('x')
        })

        yield* sleep(1)
        yield* Greeter.around(tag('A2'))

        // outermost = earliest install on the max side: A1, then A2, then the child's own
        expect(yield* child).toBe('A1(A2(C(hi x)))')
        // the ancestor itself never sees the child's layer
        expect(yield* Greeter.actions.hello('y')).toBe('A1(A2(hi y))')
      }),
    )
  })

  it('a child that never decorated follows the ancestor live', async () => {
    const Greeter = createApi('test:Greeter2', { hello: (name: string) => `hi ${name}` })

    unwrap(
      await run(function* () {
        yield* Greeter.around(tag('A1'))

        const child = yield* spawn(function* () {
          yield* sleep(5)
          return yield* Greeter.actions.hello('x')
        })

        yield* sleep(1)
        yield* Greeter.around(tag('A2'))

        expect(yield* child).toBe('A1(A2(hi x))')
      }),
    )
  })

  it('min-side layers fold in once as well', async () => {
    const Greeter = createApi('test:Greeter3', { hello: (name: string) => `hi ${name}` })

    unwrap(
      await run(function* () {
        yield* Greeter.around(tag('m1'), { at: 'min' })

        const child = yield* spawn(function* () {
          yield* Greeter.around(tag('c'), { at: 'min' })
          yield* sleep(5)
          return yield* Greeter.actions.hello('x')
        })

        yield* sleep(1)
        yield* Greeter.around(tag('m2'), { at: 'min' })

        const seen = yield* child
        expect((seen.match(/m1\(/gu) ?? []).length).toBe(1)
        expect((seen.match(/m2\(/gu) ?? []).length).toBe(1)
        expect((seen.match(/c\(/gu) ?? []).length).toBe(1)
      }),
    )
  })
})
