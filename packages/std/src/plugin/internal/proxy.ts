import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

/**
 * Build the `.actions` surface of a handle: every property path becomes a callable action —
 * `Db.actions.find(1)` → `call('find', [1])`, `Db.actions.fs.read(p)` → `call('fs.read', [p])` —
 * and every path is also yieldable (`yield* Db.actions.someValue`), mirroring api value members.
 */
export const createActionProxy = <T>(
  call: (key: string, args: unknown[]) => Operation<unknown>,
): T => {
  const child = (prefix: string): AnyType => {
    const invoke = (...args: unknown[]) => call(prefix, args)

    return new Proxy(invoke, {
      get(_, key) {
        if (key === Symbol.iterator) {
          return () => call(prefix, [])[Symbol.iterator]()
        }
        // `then` stays undefined so an action path is never mistaken for a thenable
        if (typeof key === 'symbol' || key === 'then') {
          return undefined
        }
        return child(`${prefix}.${String(key)}`)
      },
    })
  }

  return new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key === 'symbol' || key === 'then') {
          return undefined
        }
        return child(String(key))
      },
    },
  ) as T
}
