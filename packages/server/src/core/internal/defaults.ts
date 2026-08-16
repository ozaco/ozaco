import { operation } from 'std:effect'
import { fail } from 'std:result'

import { CoreErrors } from '../errors'

/**
 * Failing fallback actions for protocols whose implementations live in other modules (or later
 * phases) — the definition exists in core, calling it without an install fails cleanly instead of
 * `missing-action`.
 */
export const unsupportedDefaults = <T>(protocol: string, keys: readonly string[]): Partial<T> => {
  const defaults: Record<string, unknown> = {}

  for (const key of keys) {
    defaults[key] = operation(function* () {
      return yield* fail(
        CoreErrors.Unsupported,
        `${protocol}.${key} has no installed implementation`,
      )
    })
  }

  return defaults as Partial<T>
}

/** Succeeding no-op fallbacks (e.g. TraceExporter without an exporter = zero-cost path). */
export const noopDefaults = <T>(keys: readonly string[]): Partial<T> => {
  const defaults: Record<string, unknown> = {}

  for (const key of keys) {
    defaults[key] = operation(function* () {
      // deliberately empty — the zero-cost path when nothing is installed
    })
  }

  return defaults as Partial<T>
}
