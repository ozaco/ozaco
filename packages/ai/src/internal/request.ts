import { Codec, hasCodec } from 'std:codec'
import { operation } from 'std:effect'
import type { FetchDef } from 'std:fetch'
import { fetch } from 'std:fetch'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { AiErrors } from '../errors'
import type { AiDef } from '../types'

const decoder = new TextDecoder()

/** The OpenAI structured error envelope: `{ error: { message, type?, code? } }`. */
interface ProviderError {
  error?: { message?: string; type?: string; code?: string }
}

/**
 * Refine the base status tag with the provider's structured `error.code`/`type` where it disambiguates
 * the status (e.g. an `insufficient_quota` 429 stays rate-limited; a key/permission `code` on a 4xx
 * maps to auth). Falls back to the base tag the status alone implies.
 */
const refineTag = (base: AiDef.Error, error: ProviderError['error']): AiDef.Error => {
  const hint = error?.code ?? error?.type ?? ''
  if (hint.includes('api_key') || hint.includes('authentication') || hint.includes('permission')) {
    return AiErrors.Auth
  }
  if (hint.includes('quota') || hint.includes('rate_limit')) {
    return AiErrors.RateLimit
  }
  return base
}

/**
 * A `Codec.actions.decode` failure (an undecodable body) is raised through the plugin dispatch's own
 * error boundary, so it can't be contained by an inline `try/catch` (or `attempt`) here. We therefore
 * gate the codec on a cheap synchronous decodability probe and only invoke it when it will succeed; an
 * undecodable body skips the codec and falls back to the raw text. We probe with `JSON.parse` because
 * OpenAI-compatible providers return JSON errors and the default `JsonCodec` decodes with the same
 * parser — a body that parses here decodes cleanly through the codec.
 */
const looksDecodable = (text: string): boolean => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Decode the provider's structured error body via the registered CODEC and return the refined tag and
 * a human message. When a codec is registered AND the body is decodable it surfaces `error.message`;
 * otherwise (no codec / not decodable / no `error.message`) it falls back to the body text, then
 * `statusText`.
 */
const readError = operation(function* (
  response: FetchDef.Response,
): Generator<AnyType, { tag: AiDef.Error; message: string }, AnyType> {
  const base = statusTag(response.status)
  const bytes = yield* response.bytes()
  const text = decoder.decode(bytes) || response.statusText

  if (bytes.length === 0 || !looksDecodable(text) || !(yield* hasCodec())) {
    return { tag: base, message: text }
  }

  const decoded = yield* Codec.actions.decode(bytes)
  const provider = (decoded ?? {}) as ProviderError
  const message = provider.error?.message
  return message ? { tag: refineTag(base, provider.error), message } : { tag: base, message: text }
})

/** Join a base URL and a path, tolerating a trailing slash on the base. */
export const joinUrl = (baseURL: string, path: string): string =>
  `${baseURL.replace(/\/+$/u, '')}/${path.replace(/^\/+/u, '')}`

/** Auth + content headers for a JSON request, merged over the install-time defaults. */
export const jsonHeaders = (ctx: AiDef.Context): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${ctx.apiKey}`,
  ...ctx.headers,
})

/** Auth-only headers (the platform sets the multipart boundary on `content-type`). */
export const authHeaders = (ctx: AiDef.Context): Record<string, string> => ({
  authorization: `Bearer ${ctx.apiKey}`,
  ...ctx.headers,
})

/** Map a non-2xx HTTP status to the matching `ai.*` error tag. */
export const statusTag = (status: number): AiDef.Error => {
  if (status === 401 || status === 403) {
    return AiErrors.Auth
  }
  if (status === 429) {
    return AiErrors.RateLimit
  }
  return AiErrors.Request
}

/**
 * Read a non-2xx response body and produce the matching `ai.*` failure. Surfaces the provider's
 * structured `error.message` (decoded via the codec) when present, else the body text / status text.
 * Always yields a failure — call it only for `!response.ok`.
 */
export const failStatus = operation(function* (
  url: string,
  response: FetchDef.Response,
): Generator<AnyType, never, AnyType> {
  const { tag, message } = yield* readError(response)
  return yield* fail(tag, `${url}: ${response.status} ${message}`)
})

/** POST a JSON body to `path` and return the (already status-checked) response. */
export const postJson = operation(function* (ctx: AiDef.Context, path: string, body: unknown) {
  const url = joinUrl(ctx.baseURL, path)
  const response = yield* fetch(url, {
    method: 'POST',
    headers: jsonHeaders(ctx),
    body: JSON.stringify(body),
  })
  return { url, response }
})

/** POST a multipart `FormData` body to `path` and return the (already status-checked) response. */
export const postForm = operation(function* (ctx: AiDef.Context, path: string, form: FormData) {
  const url = joinUrl(ctx.baseURL, path)
  const response = yield* fetch(url, {
    method: 'POST',
    headers: authHeaders(ctx),
    body: form,
  })
  return { url, response }
})
