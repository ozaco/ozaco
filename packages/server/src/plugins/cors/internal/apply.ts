import { resolveAllowOrigin } from './origin'
import type { CorsContext } from './types'

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
  ctx: CorsContext,
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
