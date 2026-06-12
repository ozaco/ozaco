import { defineAction, Gateway } from 'server:core'
import { createContext } from 'std:effect'

import type { CorsDef } from '../types'

import {
  DEFAULT_ALLOWED_HEADERS,
  DEFAULT_MAX_AGE,
  DEFAULT_METHODS,
  DEFAULT_PREFLIGHT_STATUS,
} from './const'

export const normalizeOptions = (options: CorsDef.Options = {}): CorsDef.Context => {
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

export const CorsCtxRef = createContext<CorsDef.Context>('server:cors:ctx')

export const preflightAction = defineAction(
  {
    title: 'cors-preflight',
    settings: [Gateway.actions.rest({ method: 'OPTIONS', path: '/**' })],
  },

  function* () {
    return undefined
  },
)
