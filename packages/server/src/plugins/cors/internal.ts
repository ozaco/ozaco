import type { CorsDef } from './types'

/** The origin to echo for a request, or null when it is not allowed. */
export const allowed = (config: CorsDef.Config, origin: string | null): string | null => {
  if (config.origins === '*') {
    return config.credentials ? origin : '*'
  }

  return origin !== null && config.origins.includes(origin) ? origin : null
}
