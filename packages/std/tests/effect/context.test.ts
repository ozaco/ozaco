import {
  createContext,
  run,
  scoped,
  sleep,
  spawn,
  useContext,
  useScope,
  withResolvers,
} from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('context inheritance across scopes', () => {
  it('a child scope sees parent writes made AFTER the child was created (live inheritance)', async () => {
    const Word = createContext<string>('ctx-test.live')

    const outcome = await run(function* () {
      const seen = withResolvers<string>()

      yield* spawn(function* () {
        yield* sleep(2)
        seen.resolve(yield* Word.expect())
      })

      yield* Word.set('written-after-spawn')
      return yield* seen.operation
    })

    expect(unwrap(outcome)).toBe('written-after-spawn')
  })

  it('a child write shadows without leaking to the parent', async () => {
    const Word = createContext<string>('ctx-test.shadow')

    const outcome = await run(function* () {
      yield* Word.set('parent')

      const inChild = yield* scoped(function* () {
        yield* Word.set('child')
        return yield* Word.expect()
      })

      return { inChild, inParent: yield* Word.expect() }
    })

    expect(unwrap(outcome)).toEqual({ inChild: 'child', inParent: 'parent' })
  })

  it('deleting a shadowing write re-exposes the inherited value', async () => {
    const Word = createContext<string>('ctx-test.delete')

    const outcome = await run(function* () {
      yield* Word.set('parent')

      return yield* scoped(function* () {
        yield* Word.set('child')
        const shadowed = yield* Word.expect()

        yield* Word.delete()
        const inherited = yield* Word.expect()

        return { shadowed, inherited }
      })
    })

    expect(unwrap(outcome)).toEqual({ shadowed: 'child', inherited: 'parent' })
  })

  it('defaultValue answers get() until a write overrides it, and returns after delete()', async () => {
    const Limit = createContext<number>('ctx-test.default', 10)

    const outcome = await run(function* () {
      const initial = yield* Limit.get()

      yield* Limit.set(99)
      const overridden = yield* Limit.get()

      yield* Limit.delete()
      const restored = yield* Limit.get()

      return { initial, overridden, restored }
    })

    expect(unwrap(outcome)).toEqual({ initial: 10, overridden: 99, restored: 10 })
  })
})

describe('Context.with', () => {
  it('restores the previous value even when nested and even on failure', async () => {
    const Word = createContext<string>('ctx-test.with-nested')
    const seen: string[] = []

    const outcome = await run(function* () {
      yield* Word.set('base')

      yield* Word.with('outer', function* () {
        seen.push(yield* Word.expect())

        yield* Word.with('inner', function* () {
          seen.push(yield* Word.expect())
        })

        seen.push(yield* Word.expect())
      })

      try {
        yield* Word.with('failing', function* () {
          throw new Error('with boom')
        })
      } catch {
        // the failure must not corrupt restoration
      }

      seen.push(yield* Word.expect())
      return seen
    })

    expect(unwrap(outcome)).toEqual(['outer', 'inner', 'outer', 'base'])
  })

  it('with() on a previously-unset context deletes the key on exit', async () => {
    const Word = createContext<string>('ctx-test.with-unset')

    const outcome = await run(function* () {
      const inside = yield* Word.with('temporary', function* (value) {
        return value
      })

      const after = yield* Word.get()
      return { inside, after: after ?? 'unset' }
    })

    expect(unwrap(outcome)).toEqual({ inside: 'temporary', after: 'unset' })
  })

  it('passes a returned Failure through as a VALUE (transparent path, no raise)', async () => {
    const Word = createContext<string>('ctx-test.with-transparent')

    const outcome = await run(function* () {
      const result = yield* Word.with('v', function* () {
        return fail('inner-failure', 'returned, not thrown')
      })

      return isFailure(result) ? `value:${String(result.error)}` : 'not-a-failure'
    })

    expect(unwrap(outcome)).toBe('value:inner-failure')
  })
})

describe('expect / useContext', () => {
  it('expect() on a missing context fails and names the context', async () => {
    const Missing = createContext<string>('ctx-test.missing')

    const outcome = await run(function* () {
      return yield* Missing.expect()
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(JSON.stringify([outcome.error, outcome.message, ...outcome.causes])).toContain(
        'ctx-test.missing',
      )
    }
  })

  it('useContext accepts both a bare context and a { context } carrier', async () => {
    const Word = createContext<string>('ctx-test.use-context')
    const carrier = { context: Word }

    const outcome = await run(function* () {
      yield* Word.set('hello')
      return [yield* useContext(Word), yield* useContext(carrier)]
    })

    expect(unwrap(outcome)).toEqual(['hello', 'hello'])
  })

  it('scope.get/hasOwn distinguish own writes from inherited ones', async () => {
    const Word = createContext<string>('ctx-test.has-own')

    const outcome = await run(function* () {
      yield* Word.set('parent')

      return yield* scoped(function* () {
        const scope = yield* useScope()
        const before = scope.hasOwn(Word)

        yield* Word.set('child')
        const after = scope.hasOwn(Word)

        return { before, after, value: scope.get(Word) }
      })
    })

    expect(unwrap(outcome)).toEqual({ before: false, after: true, value: 'child' })
  })
})
