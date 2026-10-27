import type { Future } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { IOErrors } from '../errors'
import type { IODef } from '../types/io'

const TRUE = new Set(['1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off'])
const INTEGER = /^-?\d+$/u

/**
 * The typed readers the mapper gets beside the raw map. An unset or EMPTY variable answers the
 * fallback (an empty value is how a compose file leaves a variable blank); one that does not parse
 * is noted in `issues` and answers `undefined` — the read fails once the mapper has returned, so
 * every bad variable is named at once.
 */
interface Parser<T> {
  kind: string
  parse(raw: string): T | null
}

const STRING: Parser<string> = { kind: 'a string', parse: raw => raw }

const INT: Parser<number> = {
  kind: 'an integer',
  parse: raw => (INTEGER.test(raw.trim()) ? Number(raw) : null),
}

const BOOL: Parser<boolean> = {
  kind: 'a boolean',
  parse: raw => {
    const word = raw.trim().toLowerCase()

    return TRUE.has(word) ? true : FALSE.has(word) ? false : null
  },
}

const LIST: Parser<readonly string[]> = {
  kind: 'a list',
  parse: raw =>
    raw
      .split(',')
      .map(item => item.trim())
      .filter(item => item !== ''),
}

/**
 * The typed readers the mapper gets beside the raw map. An unset or EMPTY variable answers the
 * fallback (an empty value is how a compose file leaves a variable blank); one that does not parse
 * is noted in `issues` and answers `undefined` — the read fails once the mapper has returned, so
 * every bad variable is named at once.
 */
const makeReader = (
  source: Record<string, string | undefined>,
  issues: string[],
): IODef.EnvReader => {
  const read = <T>(name: string, fallback: T | undefined, parser: Parser<T>): T | undefined => {
    const raw = source[name]

    if (raw === undefined || raw === '') {
      return fallback
    }

    const parsed = parser.parse(raw)

    if (parsed === null) {
      issues.push(`${name}: not ${parser.kind}: "${raw}"`)

      return undefined
    }

    return parsed
  }

  const reader = {
    str: (name: string, fallback?: string) => read(name, fallback, STRING),
    int: (name: string, fallback?: number) => read(name, fallback, INT),
    bool: (name: string, fallback?: boolean) => read(name, fallback, BOOL),
    list: (name: string, fallback?: readonly string[]) => read(name, fallback, LIST),
  }

  return reader as IODef.EnvReader
}

const makeReadEnv = (getSource: () => Record<string, string | undefined>) =>
  function* (
    mapper: (
      data: Record<string, string | undefined>,
      env: IODef.EnvReader,
    ) => Record<string, unknown>,
    optional?: readonly string[],
  ) {
    const source = getSource()
    const issues: string[] = []
    const result = mapper(source, makeReader(source, issues))

    if (issues.length > 0) {
      return yield* fail(
        IOErrors.InvalidEnv,
        `invalid env variable${issues.length > 1 ? 's' : ''}: ${issues.join('; ')}`,
        ...issues,
      )
    }

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
  mapper: (data: Record<string, string | undefined>, env: IODef.EnvReader) => R,
  optional?: readonly K[],
): Future<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }> =>
  readEnvImpl(mapper, optional as readonly string[] | undefined) as AnyType

/** Like {@link readEnv} but reads from a best-effort web source (`globalThis.process?.env ?? {}`). */
export const readWebEnv = <R extends Record<string, unknown>, K extends keyof R = never>(
  mapper: (data: Record<string, string | undefined>, env: IODef.EnvReader) => R,
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
