/**
 * `Around<A>` / `Api<A>['actions']` over a member with a READONLY rest parameter
 * (`del(...keys: readonly string[])`): a bare `infer` in a rest position is constrained to a
 * mutable array, so such a member matched no branch — its middleware was typed as a VALUE member's
 * (`Middleware<[], A[K]>`) and its action as a non-callable `Operation<A[K]>`. The type assertions
 * fail `tsc` (`moon run std:types`) without the fix; the runtime half proves the middleware sees
 * the member's own arguments.
 */
import type { Api, Around, Middleware, Operation } from 'std:effect'
import { createApi, run, scoped } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

interface KeysApi {
  del(...keys: readonly string[]): Operation<number>
  size: number
}

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// the member's own (readonly) rest tuple and return type — not a value member's `Middleware<[], …>`
const delShape: Equals<
  Around<KeysApi>['del'],
  Middleware<readonly string[], Operation<number>>
> = true
const sizeShape: Equals<Around<KeysApi>['size'], Middleware<[], number>> = true
const actionShape: Equals<
  Api<KeysApi>['actions']['del'],
  (...keys: readonly string[]) => Operation<number>
> = true

describe('Around over a readonly rest member', () => {
  it('types the middleware with the rest tuple and runs it with the call arguments', async () => {
    expect([delShape, sizeShape, actionShape]).toEqual([true, true, true])

    const Keys = createApi<KeysApi>('keys.readonly-rest', {
      *del(...keys) {
        return keys.length
      },
      size: 3,
    })

    const outcome = await run(function* () {
      return yield* scoped(function* () {
        const seen: (readonly string[])[] = []

        yield* Keys.around({
          del: (keys, next) => {
            seen.push(keys)
            return next(...keys, 'extra')
          },
        })

        return { deleted: yield* Keys.actions.del('a', 'b'), seen }
      })
    })

    expect(unwrap(outcome)).toEqual({ deleted: 3, seen: [['a', 'b']] })
  })
})
