import type { Future } from 'std:effect'
import { operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

const makeReadEnv = (getSource: () => Record<string, string | undefined>) =>
  operation(function* (
    mapper: (data: Record<string, string | undefined>) => Record<string, unknown>,
    optional?: readonly string[],
  ) {
    const result = mapper(getSource())
    const optionalKeys = new Set<string>(optional)

    for (const key of Object.keys(result)) {
      if (!optionalKeys.has(key) && (result as AnyType)[key] === undefined) {
        return yield* fail('missing-env', `missing required env variable: "${key}"`)
      }
    }

    return result
  })

const readEnvImpl = makeReadEnv(() => process.env as Record<string, string | undefined>)

const readWebEnvImpl = makeReadEnv(
  () =>
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
)

export const readEnv = <R extends Record<string, unknown>, K extends keyof R = never>(
  mapper: (data: Record<string, string | undefined>) => R,
  optional?: readonly K[],
): Future<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }, unknown> =>
  readEnvImpl(mapper, optional as readonly string[] | undefined) as AnyType

/** Like {@link readEnv} but reads from a best-effort web source (`globalThis.process?.env ?? {}`). */
export const readWebEnv = <R extends Record<string, unknown>, K extends keyof R = never>(
  mapper: (data: Record<string, string | undefined>) => R,
  optional?: readonly K[],
): Future<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }, unknown> =>
  readWebEnvImpl(mapper, optional as readonly string[] | undefined) as AnyType
