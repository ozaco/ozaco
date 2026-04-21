import type { DocsAuthOptions, DocsOptions } from '../types'

import type { SecurityScheme } from './types'

const DEFAULT_AUTH: DocsAuthOptions = {
  type: 'bearer',
  bearerFormat: 'JWT',
}

export const normalizeAuth = (auth: DocsOptions['auth']): DocsAuthOptions | null => {
  if (!auth) {
    return null
  }
  if (auth === true) {
    // oxlint-disable-next-line oxc/no-rest-spread-properties
    return { ...DEFAULT_AUTH }
  }
  // oxlint-disable-next-line oxc/no-rest-spread-properties
  return { ...DEFAULT_AUTH, ...auth }
}

export const buildSecurityScheme = (auth: DocsAuthOptions): SecurityScheme => {
  const type = auth.type ?? 'bearer'

  const scheme: SecurityScheme =
    type === 'apiKey'
      ? {
          type: 'apiKey',
          name: auth.name ?? 'Authorization',
          in: auth.in ?? 'header',
        }
      : { type: 'http', scheme: type === 'basic' ? 'basic' : 'bearer' }

  if (type === 'bearer' && auth.bearerFormat) {
    scheme.bearerFormat = auth.bearerFormat
  }
  if (auth.description) {
    scheme.description = auth.description
  }

  return scheme
}
