import type { DocsDef } from '../types'

export const SECURITY_SCHEME_NAME = 'auth'

export const DEFAULT_AUTH: DocsDef.AuthOptions = {
  type: 'bearer',
  bearerFormat: 'JWT',
}
