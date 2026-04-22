import type { CorsOrigin } from '../types'

const matchOrigin = (origin: string, rule: CorsOrigin): boolean => {
  if (rule === '*' || rule === true) {
    return true
  }
  if (typeof rule === 'string') {
    return rule === origin
  }
  if (rule instanceof RegExp) {
    return rule.test(origin)
  }
  if (Array.isArray(rule)) {
    return rule.includes(origin)
  }
  if (typeof rule === 'function') {
    return rule(origin)
  }
  return false
}

export interface ResolvedOrigin {
  allow: string | null
  vary: boolean
}

export const resolveAllowOrigin = (
  requestOrigin: string | undefined,
  rule: CorsOrigin,
  credentials: boolean,
): ResolvedOrigin => {
  if (rule === '*' && !credentials) {
    return { allow: '*', vary: false }
  }

  if (!requestOrigin) {
    return { allow: null, vary: rule !== '*' }
  }

  if (!matchOrigin(requestOrigin, rule)) {
    return { allow: null, vary: true }
  }

  return { allow: requestOrigin, vary: true }
}
