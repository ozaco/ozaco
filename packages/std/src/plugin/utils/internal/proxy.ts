import type { Future } from 'std:effect'

export const createProxy = <T>(
  prefix: string,
  resolveAction: (key: string, ...args: unknown[]) => Future<unknown, unknown>,
): T => {
  const invoke = (...args: unknown[]) => resolveAction(prefix, ...args)

  return new Proxy(invoke, {
    get(_, key: string | symbol) {
      if (typeof key === 'symbol' || key === 'then') {
        return undefined
      }

      return createProxy(prefix ? `${prefix}.${key}` : key, resolveAction)
    },
    apply(_, __, args: unknown[]) {
      return invoke(...args)
    },
  }) as T
}
