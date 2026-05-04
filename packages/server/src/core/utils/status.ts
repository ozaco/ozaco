import { ServerErrorCode } from '../error-codes'

const DEFAULT_STATUS_MAP: Record<string, number> = {
  [ServerErrorCode.Validation]: 400,
  'unknown-provider': 400,

  'invalid-credentials': 401,
  'invalid-token': 401,
  'expired-token': 401,
  'revoked-token': 401,
  'missing-token': 401,
  [ServerErrorCode.Unauthorized]: 401,

  [ServerErrorCode.Forbidden]: 403,

  [ServerErrorCode.NotFound]: 404,

  [ServerErrorCode.Exists]: 409,

  'verification-consumed': 410,

  [ServerErrorCode.PayloadTooLarge]: 413,

  [ServerErrorCode.ServerPaused]: 503,
}

const DEFAULT_STATUS = 500

export const statusFor = (
  code: unknown,
  ...overrides: Array<Record<string, number> | null | undefined>
): number => {
  if (typeof code !== 'string') {
    return DEFAULT_STATUS
  }
  for (const map of overrides) {
    if (map && code in map) {
      return map[code]!
    }
  }
  return DEFAULT_STATUS_MAP[code] ?? DEFAULT_STATUS
}
