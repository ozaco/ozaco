export const DEFAULT_ACCESS_TTL = '15m'
export const DEFAULT_REFRESH_TTL = '7d'
export const DEFAULT_SESSION_TTL = '7d'
export const DEFAULT_VERIFICATION_TTL = '30m'

export const DEFAULT_ALGORITHM = 'HS256' as const

export const TOKEN_TYPE_ACCESS = 'access'
export const TOKEN_TYPE_REFRESH = 'refresh'
export const TOKEN_TYPE_SESSION = 'session'

export const BEARER_PREFIX = 'Bearer '

export const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}
