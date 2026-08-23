// oxlint-disable import/exports-last
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import type { CacheDef } from './types'

/** The action options this plugin owns (validated by the kernel at createServer). */
export const options = {
  cache: z.object({
    ttlMs: z.number().positive(),
    vary: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }),

  /** tags a (mutating) action drops once it succeeds. */
  invalidate: z.array(z.string()).min(1),
}

export const pick = (root: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((at, key) => (at as AnyType)?.[key], root)

export const hash = (value: unknown): string => {
  const text = JSON.stringify(value) ?? 'undefined'
  let code = 0

  for (let index = 0; index < text.length; index += 1) {
    code = (code * 31 + (text.codePointAt(index) ?? 0)) | 0
  }

  return (code >>> 0).toString(36)
}

export const keyOf = ({ prefix, call, ctx, cache }: CacheDef.KeyInput): string => {
  const root = { input: call.input, auth: ctx.auth, headers: call.headers } as Record<
    string,
    unknown
  >
  const material = cache.vary ? cache.vary.map(path => pick(root, path)) : call.input

  return `${prefix}:${call.service}.${call.action}:${hash(material)}`
}
