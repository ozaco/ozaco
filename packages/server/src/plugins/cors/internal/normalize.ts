import type { CorsOptions } from '../types'

import {
  DEFAULT_ALLOWED_HEADERS,
  DEFAULT_MAX_AGE,
  DEFAULT_METHODS,
  DEFAULT_PREFLIGHT_STATUS,
} from './const'
import type { CorsContext } from './types'

export const normalizeOptions = (options: CorsOptions = {}): CorsContext => {
  const maxAge =
    options.maxAge === undefined
      ? DEFAULT_MAX_AGE
      : typeof options.maxAge === 'number'
        ? options.maxAge
        : Number(options.maxAge)

  return {
    origin: options.origin ?? '*',
    methods: (options.methods ?? DEFAULT_METHODS).join(', '),
    allowedHeaders: (options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS).join(', '),
    exposedHeaders: options.exposedHeaders?.length ? options.exposedHeaders.join(', ') : null,
    credentials: Boolean(options.credentials),
    maxAge: String(maxAge),
    preflightStatus: options.preflightStatus ?? DEFAULT_PREFLIGHT_STATUS,
  }
}
