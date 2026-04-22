const DEFAULT_STATUS_MAP: Record<string, number> = {
  validation: 400,
  'unknown-provider': 400,

  'invalid-credentials': 401,
  'invalid-token': 401,
  'expired-token': 401,
  'revoked-token': 401,
  'missing-token': 401,

  forbidden: 403,

  'not-found': 404,

  exists: 409,

  'verification-consumed': 410,

  'server-paused': 503,
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
