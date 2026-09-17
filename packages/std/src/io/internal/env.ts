import type { Future } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { IOErrors } from '../errors'

const makeReadEnv = (getSource: () => Record<string, string | undefined>) =>
  function* (
    mapper: (data: Record<string, string | undefined>) => Record<string, unknown>,
    optional?: readonly string[],
  ) {
    const result = mapper(getSource())
    const optionalKeys = new Set<string>(optional)

    for (const key of Object.keys(result)) {
      if (!optionalKeys.has(key) && (result as AnyType)[key] === undefined) {
        return yield* fail(IOErrors.MissingEnv, `missing required env variable: "${key}"`)
      }
    }

    return result
  }

const readEnvImpl = makeReadEnv(() => process.env as Record<string, string | undefined>)

const readWebEnvImpl = makeReadEnv(
  () =>
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
)

export const readEnv = <R extends Record<string, unknown>, K extends keyof R = never>(
  mapper: (data: Record<string, string | undefined>) => R,
  optional?: readonly K[],
): Future<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }> =>
  readEnvImpl(mapper, optional as readonly string[] | undefined) as AnyType

/** Like {@link readEnv} but reads from a best-effort web source (`globalThis.process?.env ?? {}`). */
export const readWebEnv = <R extends Record<string, unknown>, K extends keyof R = never>(
  mapper: (data: Record<string, string | undefined>) => R,
  optional?: readonly K[],
): Future<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }> =>
  readWebEnvImpl(mapper, optional as readonly string[] | undefined) as AnyType

/** A browser's working directory: the page's directory from `location.pathname` (up to its last
 * `/`), `/` when there is no location. `globals` is injectable for tests. */
export const readWebCwd = (globals: typeof globalThis = globalThis): string => {
  const pathname = (globals as { location?: { pathname?: string } }).location?.pathname

  if (pathname) {
    return pathname.slice(0, pathname.lastIndexOf('/') + 1) || '/'
  }

  return '/'
}
