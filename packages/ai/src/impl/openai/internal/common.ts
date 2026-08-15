// oxlint-disable import/exports-last
import { AiErrors, RETRY_AFTER_CAUSE } from 'ai:core'
import type { Context } from 'std:effect'
import { attempt, createContext, operation } from 'std:effect'
import type { FetchDef } from 'std:fetch'
import { Fetch } from 'std:fetch'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { DEFAULT_BASE_URL } from '../const'
import type { OpenAIProviderOptions } from '../types'

export interface OpenAIState {
  readonly base: string
  /** Lower-cased user headers with the auth header computed OVER them. */
  readonly headers: Record<string, string>
  readonly timeoutMs: number | undefined
}

export const StateRef: Context<OpenAIState> = createContext<OpenAIState>('ai:openai')

export const createState = (options: OpenAIProviderOptions): OpenAIState => {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name.toLowerCase()] = value
  }
  const auth = options.auth ?? { kind: 'bearer' }
  if (auth.kind === 'bearer') {
    headers.authorization = `Bearer ${options.apiKey}`
  } else {
    headers[auth.name.toLowerCase()] = options.apiKey
  }
  return {
    base: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, ''),
    headers,
    timeoutMs: options.timeoutMs,
  }
}

/** Init for a JSON request: state headers with `content-type` pinned, the body encoded through
 * the installed `JsonCodec`, deadline. */
export const jsonInit = operation(function* (
  state: OpenAIState,
  body: Record<string, unknown>,
): Generator<AnyType, FetchDef.MethodInit, AnyType> {
  return {
    headers: { ...state.headers, 'content-type': 'application/json' },
    body: yield* JsonCodec.actions.stringify(body),
    ...(state.timeoutMs === undefined ? {} : { timeoutMs: state.timeoutMs }),
  }
})

/** Init for a multipart request: `content-type` stays unset so the platform writes the boundary. */
export const formInit = (state: OpenAIState, form: FormData): FetchDef.MethodInit => {
  const headers = { ...state.headers }
  Reflect.deleteProperty(headers, 'content-type')
  return {
    headers,
    body: form,
    ...(state.timeoutMs === undefined ? {} : { timeoutMs: state.timeoutMs }),
  }
}

/** The OpenAI structured error envelope. */
interface ProviderError {
  readonly message?: string | undefined
  readonly type?: string | undefined
  readonly code?: string | undefined
}

/** Classify a response into an `ai.*` tag: the structured `error.code`/`type` refines where it
 * disambiguates (quota'd 429s stay rate-limited, key/permission codes map to auth), then the
 * status decides. Also classifies mid-stream error frames (pass `status: 0`). */
export const classifyError = (status: number, error?: ProviderError | undefined): string => {
  const hint = `${error?.code ?? ''} ${error?.type ?? ''}`
  if (hint.includes('api_key') || hint.includes('authentication') || hint.includes('permission')) {
    return AiErrors.Auth
  }
  if (hint.includes('quota') || hint.includes('rate_limit')) {
    return AiErrors.RateLimit
  }
  if (status === 401 || status === 403) {
    return AiErrors.Auth
  }
  if (status === 429) {
    return AiErrors.RateLimit
  }
  if (status === 408) {
    return AiErrors.Timeout
  }
  return AiErrors.Request
}

/** Parse a `retry-after` header into whole seconds (numeric or HTTP-date form). */
const retryAfterSeconds = (header: string | null): number | undefined => {
  if (!header) {
    return undefined
  }
  const numeric = Number(header)
  if (Number.isFinite(numeric)) {
    return Math.max(0, numeric)
  }
  const date = Date.parse(header)
  if (Number.isNaN(date)) {
    return undefined
  }
  return Math.max(0, Math.round((date - Date.now()) / 1000))
}

/** Best-effort decode of the provider's error envelope — any parse failure degrades to
 * `undefined` so classification falls back to the status and raw body. */
const decodeErrorBody = operation(function* (
  body: string,
): Generator<AnyType, ProviderError | undefined, AnyType> {
  const outcome = yield* attempt(JsonCodec.actions.parse<AnyType>(body))
  if (isFailure(outcome)) {
    return undefined
  }
  const error = outcome.value?.error
  return error && typeof error === 'object' ? (error as ProviderError) : undefined
})

/** Read a non-2xx response and raise the matching `ai.*` failure. Rate limits carry the provider's
 * retry-after hint as a `retry-after:<seconds>` cause so the client's retry can honor it. */
const failResponse = operation(function* (
  response: FetchDef.Response,
): Generator<AnyType, never, AnyType> {
  const read = yield* attempt(response.text())
  const body = isFailure(read) ? '' : read.value
  const error = yield* decodeErrorBody(body)
  const tag = classifyError(response.status, error)
  const detail = error?.message ?? (body || response.statusText)
  const message = `${response.url}: ${response.status} ${detail}`
  if (tag === AiErrors.RateLimit) {
    const seconds = retryAfterSeconds(response.headers.get('retry-after'))
    if (seconds !== undefined) {
      return yield* fail(tag, message, `${RETRY_AFTER_CAUSE}:${seconds}`)
    }
  }
  return yield* fail(tag, message)
})

/**
 * POST to an endpoint through the `Fetch` plugin (the ONLY transport this provider uses) and
 * resolve the ok response. Transport faults classify as `ai.timeout`/`ai.request`; non-2xx
 * statuses classify via {@link failResponse}.
 */
export const send = operation(function* (
  state: OpenAIState,
  path: string,
  init: FetchDef.MethodInit,
): Generator<AnyType, FetchDef.Response, AnyType> {
  const outcome = yield* attempt(Fetch.actions.post(`${state.base}/${path}`, init))
  if (isFailure(outcome)) {
    if (outcome.error === 'timeout') {
      return yield* fail(AiErrors.Timeout, outcome.message)
    }
    return yield* fail(
      AiErrors.Request,
      `openai request to ${path} failed: ${outcome.message || String(outcome.error)}`,
    )
  }
  const response = outcome.value as FetchDef.Response
  if (!response.ok) {
    return yield* failResponse(response)
  }
  return response
})

/** Read an ok response's JSON body; an unparseable 2xx body fails `ai.bad-response`. */
export const readJson = operation(function* (
  response: FetchDef.Response,
): Generator<AnyType, unknown, AnyType> {
  const outcome = yield* attempt(response.json<unknown>())
  if (isFailure(outcome)) {
    return yield* fail(
      AiErrors.BadResponse,
      `openai returned an undecodable body from ${response.url}`,
    )
  }
  return outcome.value
})

/** Read an ok response's bytes; a read fault classifies as `ai.request`. */
export const readBytes = operation(function* (
  response: FetchDef.Response,
): Generator<AnyType, Uint8Array, AnyType> {
  const outcome = yield* attempt(response.bytes())
  if (isFailure(outcome)) {
    return yield* fail(AiErrors.Request, `reading the response body from ${response.url} failed`)
  }
  return outcome.value as Uint8Array
})
