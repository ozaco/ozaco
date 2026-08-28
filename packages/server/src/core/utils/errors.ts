import type { Operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ErrorsDef } from '../types/errors'

/**
 * Declare a service's failures ONCE — the tag, its HTTP status and the way to raise it:
 *
 *   const media = serviceErrors('media', { 'not-found': 404, 'too-large': 413 })
 *
 *   upload: action.mutation({ errors: media.statuses, … }, function* () {
 *     return yield* media.tooLarge('over 10MB')          // raises `media.too-large` → 413
 *   })
 *
 * `media.notFound.tag` is the tag string wherever one is wanted (`retry: { when: [...] }`,
 * `cache: { tags: [...] }`, comparing against `failure.error`). Without this the tag lives in
 * two places — the `errors` map and every `fail()` — and they drift apart silently: an
 * undeclared tag answers 500, whatever the handler meant.
 */
export const serviceErrors = <
  const TPrefix extends string,
  const TMap extends Record<string, number>,
>(
  prefix: TPrefix,
  statuses: TMap,
): ErrorsDef.Catalog<TPrefix, TMap> => {
  const out: Record<string, unknown> = { statuses: {} }

  for (const [key, status] of Object.entries(statuses)) {
    const tag = `${prefix}.${key}`
    const camel = key.replaceAll(/-(?<letter>[a-z])/gu, (_match, letter: string) =>
      letter.toUpperCase(),
    )

    const failer = (message?: string, ...causes: string[]): Operation<never> =>
      fail(tag, message ?? tag, ...causes) as Operation<never>

    out[camel] = Object.assign(failer, { tag, toString: () => tag })
    ;(out['statuses'] as Record<string, number>)[tag] = status
  }

  return out as AnyType
}
