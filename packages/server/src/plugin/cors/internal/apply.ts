import type { CorsDef } from '../types'

const matchOrigin = (origin: string, rule: CorsDef.Origin): boolean => {
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

const resolveAllowOrigin = (
  requestOrigin: string | undefined,
  rule: CorsDef.Origin,
  credentials: boolean,
): CorsDef.ResolvedOrigin => {
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

const appendVaryOrigin = (meta: Record<string, string>) => {
  const existingKey = Object.keys(meta).find(k => k.toLowerCase() === 'vary')
  const existing = existingKey ? meta[existingKey] : undefined

  if (!existing) {
    meta.Vary = 'Origin'
    return
  }
  if (existing.split(',').some(part => part.trim().toLowerCase() === 'origin')) {
    return
  }
  meta[existingKey!] = `${existing}, Origin`
}

export const applyCorsHeaders = (
  meta: Record<string, string>,
  ctx: CorsDef.Context,
  requestOrigin: string | undefined,
): void => {
  const { allow, vary } = resolveAllowOrigin(requestOrigin, ctx.origin, ctx.credentials)

  if (vary) {
    appendVaryOrigin(meta)
  }
  if (!allow) {
    return
  }

  meta['Access-Control-Allow-Origin'] = allow
  meta['Access-Control-Allow-Methods'] = ctx.methods
  meta['Access-Control-Allow-Headers'] = ctx.allowedHeaders
  meta['Access-Control-Max-Age'] = ctx.maxAge

  if (ctx.exposedHeaders) {
    meta['Access-Control-Expose-Headers'] = ctx.exposedHeaders
  }
  if (ctx.credentials) {
    meta['Access-Control-Allow-Credentials'] = 'true'
  }
}
