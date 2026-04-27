import { createContext } from 'std:effect'

import type { CorsContext, CorsOptions } from '../types'

const DEFAULT_METHODS: readonly string[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]

const DEFAULT_ALLOWED_HEADERS: readonly string[] = [
  'Authorization',
  'Content-Type',
  'Accept',
  'X-Requested-With',
]

const DEFAULT_MAX_AGE = 86_400
const DEFAULT_PREFLIGHT_STATUS = 204

const normalizeOptions = (options: CorsOptions = {}): CorsContext => {
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

const CorsCtxRef = createContext<CorsContext>('server:cors:ctx')

export { CorsCtxRef, normalizeOptions }
