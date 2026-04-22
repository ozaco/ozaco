export const DEFAULT_METHODS: readonly string[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]

export const DEFAULT_ALLOWED_HEADERS: readonly string[] = [
  'Authorization',
  'Content-Type',
  'Accept',
  'X-Requested-With',
]

export const DEFAULT_MAX_AGE = 86_400
export const DEFAULT_PREFLIGHT_STATUS = 204
