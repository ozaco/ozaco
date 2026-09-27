/**
 * Hooks over members with a READONLY rest parameter (`invalidate(...tags: readonly string[])`,
 * the shape of Kv's `del` / `invalidate`): the hook shapes must type them (a bare `infer A` in a
 * rest position is constrained to a mutable array, so they were `never`). The type assertions
 * fail `tsc` (`moon run std:types`) without the fix; the runtime half proves the hooks compose.
 */
import type { Operation } from 'std:effect'
import { run } from 'std:effect'
import type { Helpers } from 'std:plugin'
import { defineProtocol } from 'std:plugin'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

interface TagsContext {
  tags: Set<string>
}

interface TagsActions {
  invalidate(...tags: readonly string[]): Operation<number>
  del(keys: readonly string[]): Operation<number>
}

/** `'ok'` for a real hook shape, `'never'` for the broken mapping. */
type Shape<T> = [T] extends [never] ? 'never' : 'ok'

const aroundShape: Shape<NonNullable<Helpers.Around<TagsActions>['invalidate']>> = 'ok'
const beforeShape: Shape<NonNullable<Helpers.Before<TagsActions>['invalidate']>> = 'ok'
const afterShape: Shape<NonNullable<Helpers.After<TagsActions>['invalidate']>> = 'ok'
const errorShape: Shape<NonNullable<Helpers.OnError<TagsActions>['invalidate']>> = 'ok'
const aroundFn: Shape<Helpers.AroundFn<TagsActions['invalidate']>> = 'ok'

/** The hook's `args` is the member's own rest tuple — readonly, never widened. */
const argsOf = (hook: Helpers.AroundFn<TagsActions['invalidate']>) => hook
const typedArgs: Parameters<typeof argsOf>[0] extends (
  args: readonly string[],
  next: (...tags: readonly string[]) => Operation<number>,
) => Operation<number>
  ? true
  : false = true

let uniq = 0

const makeTags = () => {
  const Tags = defineProtocol<TagsContext, TagsActions>({
    name: `tags-${++uniq}`,
    version: '1.0.0',
  })

  const MemoryTags = Tags.implement({
    name: `memory-tags-${uniq}`,
    version: '1.0.0',
    *setup(): Operation<TagsContext> {
      return { tags: new Set(['a', 'b', 'c']) }
    },
  }).build({
    *invalidate(...tags) {
      const ctx = yield* Tags.context.expect()
      return tags.filter(tag => ctx.tags.delete(tag)).length
    },
    *del(keys) {
      return keys.length
    },
  })

  return { Tags, MemoryTags }
}

describe('hooks over readonly rest members', () => {
  it('the hook shapes are real functions, not never', () => {
    expect([aroundShape, beforeShape, afterShape, errorShape, aroundFn, typedArgs]).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      true,
    ])
  })

  it('around / before / after / error type-check without casts and compose', async () => {
    const { Tags, MemoryTags } = makeTags()
    const trace: string[] = []

    const outcome = await run(function* () {
      yield* MemoryTags.use()

      yield* Tags.before({
        *invalidate(args) {
          trace.push(`before:${args.join(',')}`)
        },
      })
      yield* Tags.after({
        *invalidate(result, args) {
          trace.push(`after:${result}:${args.length}`)
        },
      })
      yield* Tags.around({
        *invalidate(args, next) {
          trace.push('around')
          // the rest tuple forwards as-is: `next(...args)`
          return yield* next(...args, 'c')
        },
        *del(args, next) {
          return (yield* next(...args)) * 10
        },
      })

      const removed = yield* Tags.actions.invalidate('a', 'b')
      const deleted = yield* Tags.actions.del(['x', 'y'])

      return { removed, deleted }
    })

    expect(unwrap(outcome)).toEqual({ removed: 3, deleted: 20 })
    expect(trace).toEqual(['before:a,b', 'around', 'after:3:2'])
  })

  it('an error hook sees the readonly rest args of the failed call', async () => {
    const { Tags, MemoryTags } = makeTags()
    const seen: (readonly string[])[] = []

    const outcome = await run(function* () {
      yield* MemoryTags.use()

      // a later hook runs INSIDE an earlier one: the error hook first, the failing layer inside it
      yield* Tags.error({
        *invalidate(_error, args) {
          seen.push(args)
        },
      })
      yield* Tags.around({
        *invalidate() {
          return yield* fail('test.tags-down', 'the tag store is down')
        },
      })

      return yield* Tags.actions.invalidate('a')
    })

    expect(isFailure(outcome)).toBe(true)
    expect(seen).toEqual([['a']])
  })
})
