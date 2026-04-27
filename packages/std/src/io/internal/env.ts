import type { Future } from 'std:effect'
import { operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

const readEnvImpl = operation(function* (
  mapper: (data: Record<string, string | undefined>) => Record<string, unknown>,
  optional?: readonly string[],
) {
  const data = process.env as Record<string, string | undefined>
  const result = mapper(data)
  const optionalKeys = new Set<string>(optional)

  for (const key of Object.keys(result)) {
    if (!optionalKeys.has(key) && (result as AnyType)[key] === undefined) {
      return yield* fail('missing-env', `missing required env variable: "${key}"`)
    }
  }

  return result
})

export const readEnv = <R extends Record<string, unknown>, K extends keyof R = never>(
  mapper: (data: Record<string, string | undefined>) => R,
  optional?: readonly K[],
): Future<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }, unknown> =>
  readEnvImpl(mapper, optional as readonly string[] | undefined) as AnyType
