import type { ActionRequest, ActionResponse } from 'server:core'
import { CoreErrors, DataType, EdgeSourcesContext, Gateway, statusFor } from 'server:core'
import { Codec } from 'std:codec'
import { operation, until, useContext } from 'std:effect'
import { fail, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { parseMultipart } from '../external/multipart'

import { coerceParams, paramCoercions } from './coerce'
import { BODY_METHODS, FORM_DATA, FORM_URLENCODED, JSON_CONTENT, RAW_BINARY } from './const'
import { appendField, splitLeadingFields } from './form-data'

/** A byte-like success body, normalized: the raw audio/image/file responses an action returns
 * directly (`Uint8Array`, `ArrayBuffer`, or a `Blob` — including `Bun.file(...)`). */
interface ByteBody {
  readonly size: number
  readonly type: string | null
  readonly whole: BodyInit
  slice(start: number, endExclusive: number): BodyInit
}

const asByteBody = (value: unknown): ByteBody | null => {
  if (value instanceof Uint8Array) {
    // `BodyInit` refuses `ArrayBufferLike` views (a SharedArrayBuffer-backed view is not a body);
    // action-returned bytes are always plain ArrayBuffer-backed
    const bytes = value as Uint8Array<ArrayBuffer>
    return {
      size: bytes.byteLength,
      type: null,
      whole: bytes,
      slice: (start, end) => bytes.subarray(start, end),
    }
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value)
    return {
      size: bytes.byteLength,
      type: null,
      whole: bytes,
      slice: (start, end) => bytes.subarray(start, end),
    }
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return {
      size: value.size,
      type: value.type === '' ? null : value.type,
      whole: value,
      slice: (start, end) => value.slice(start, end),
    }
  }
  return null
}

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/u

/**
 * Serve a byte body: verbatim 200 normally; a single-range `Range` request gets its 206 slice
 * (`content-range` set) and an unsatisfiable one 416 — so `<audio>`/`<video>` seeking works against
 * action-returned bytes. Multi-range and malformed headers are ignored (full 200), which RFC 9110
 * permits. An action-set explicit status opts out of range handling (the action owns the exchange).
 */
// oxlint-disable-next-line max-params
const respondBytes = (
  req: ActionRequest | null,
  res: ActionResponse | null,
  headers: Headers,
  body: ByteBody,
  declaredType: string | null,
): Response => {
  if (!declaredType) {
    headers.set('content-type', body.type ?? RAW_BINARY)
  }
  headers.set('accept-ranges', 'bytes')

  const explicit = res?.status ?? null
  const range = explicit === null ? req?.meta.range : undefined
  const match = range ? RANGE_PATTERN.exec(range) : null
  if (!match || (match[1] === '' && match[2] === '')) {
    return new Response(body.whole, { status: explicit ?? 200, headers })
  }

  const size = body.size
  const start = match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1])
  const end = match[1] !== '' && match[2] !== '' ? Math.min(Number(match[2]), size - 1) : size - 1
  if (start >= size || start > end) {
    headers.set('content-range', `bytes */${size}`)
    return new Response(undefined, { status: 416, headers })
  }
  headers.set('content-range', `bytes ${start}-${end}/${size}`)
  return new Response(body.slice(start, end + 1), { status: 206, headers })
}

// the `rest` action is the per-route REST settings constructor (was Rest.actions.settings)
export const restSettingsAction = operation(function* (options: AnyType) {
  return {
    ...options,
    method: options.method ?? 'GET',
    path: options.path ?? '/',

    transformer: Gateway,
  }
})

export const toInternalAction = operation(function* (req: AnyType, _res: unknown, meta: AnyType) {
  const ctx = yield* useContext(Gateway.context)
  const maxBytes = ctx.maxBodyBytes

  const url = new URL(req.url)
  const headers = Object.fromEntries(req.headers.entries())

  /**
   * `EventSource` cannot set a single header, so a guarded SSE route is unreachable from a browser
   * unless the token may travel in the query — the same promotion the WS upgrade already does, and
   * for the same reason.
   *
   * Two guards, both load-bearing. Only for SSE routes: an ordinary REST client CAN send a header,
   * and a token in a URL ends up in access logs, referrers and browser history. And only when no
   * `authorization` header is present, so a query param can never override a real credential.
   */
  if (meta.setting?.sse === true && !headers.authorization) {
    const token = url.searchParams.get('token') ?? url.searchParams.get('access_token')
    if (token) {
      headers.authorization = `Bearer ${token}`
    }
  }
  let parsedBody: unknown = null

  if (BODY_METHODS.has(String(req.method).toUpperCase())) {
    const contentType = req.headers.get('content-type') ?? ''

    if (maxBytes !== undefined) {
      const declared = req.headers.get('content-length')
      if (declared && Number(declared) > maxBytes) {
        return yield* fail(
          CoreErrors.PayloadTooLarge,
          `body exceeds ${maxBytes} bytes (Content-Length: ${declared})`,
        )
      }
    }

    if (contentType.includes(JSON_CONTENT)) {
      // route JSON through the registered codec (JsonCodec) so HTTP bodies and the broker's transport
      // wire share one serializer (bad JSON → CodecErrors.Decode)
      const buffer = new Uint8Array(yield* until(req.arrayBuffer()))
      if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
        return yield* fail(CoreErrors.PayloadTooLarge, `body exceeds ${maxBytes} bytes`)
      }
      parsedBody = buffer.byteLength === 0 ? null : yield* JsonCodec.actions.decode(buffer)
    } else if (contentType.includes(FORM_DATA)) {
      const limits = maxBytes === undefined ? undefined : { fileSize: maxBytes }

      // A multipart body is a byte-lane source, always: the parts are handed over as-is — the action
      // takes them with `useSource(DataType.multistream)` and streams each file straight to its
      // destination (S3, hashing, …) with zero spill. There is no buffered mode: a mode that spills
      // whole files before the action runs cannot cross a wire, so it existed only until the first
      // service moved to another pod. The fields AHEAD of the first file still become the validated
      // body — see `splitLeadingFields` — so an upload route keeps its schema without buffering.
      const fields: Record<string, unknown> = {}
      const parts = yield* splitLeadingFields(parseMultipart(req, limits), fields)

      yield* EdgeSourcesContext.set([
        ...((yield* EdgeSourcesContext.get()) ?? []),
        { type: DataType.multistream, parts },
      ])
      parsedBody = fields
    } else if (contentType.includes(FORM_URLENCODED)) {
      // urlencoded carries no files and is small — parse it directly, no streaming parser needed
      const text = (yield* until(req.text())) as string
      const fields: Record<string, unknown> = {}

      for (const [key, value] of new URLSearchParams(text)) {
        appendField(fields, key, value)
      }
      parsedBody = fields
    }
  }

  // Query/path params arrive as strings; coerce the ones whose arg schema says number/boolean —
  // otherwise `args: z.object({ limit: z.number() })` on a GET route 400s every request and every
  // author has to remember `z.coerce`. The table is schema-derived, so string-accepting keys and
  // unparseable values pass through untouched.
  const entry = meta.sym === undefined ? undefined : ctx.handlers.get(meta.sym as symbol)
  const coercions = entry === undefined ? null : paramCoercions(entry)

  const queryParams = coerceParams(Object.fromEntries(url.searchParams.entries()), coercions)
  const rawPathParams = meta.params as Record<string, unknown> | undefined
  const pathParams =
    rawPathParams === undefined ? undefined : coerceParams(rawPathParams, coercions)

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)

  const hasParamsOrQuery =
    (pathParams !== undefined && Object.keys(pathParams).length > 0) ||
    Object.keys(queryParams).length > 0

  let body: unknown
  if (isPlainObject(parsedBody)) {
    body = { ...pathParams, ...queryParams, ...parsedBody }
  } else if (parsedBody === null || parsedBody === undefined) {
    body = { ...pathParams, ...queryParams }
  } else {
    body = hasParamsOrQuery ? { ...pathParams, ...queryParams } : parsedBody
  }

  return [
    {
      type: 'http' as const,
      method: req.method,
      url,
      meta: headers,
      // the envelope's params stay the raw wire strings; only the validated body sees coercion
      params: (rawPathParams ?? {}) as Record<string, string>,
    },
    {
      status: null,
      body: undefined,
      meta: {},
    },
    body,
  ] as [ActionRequest, ActionResponse, unknown]
})

// oxlint-disable-next-line max-params
export const fromInternalAction = operation(function* (
  req: ActionRequest | null,
  res: ActionResponse | null,
  actionResponse: AnyType,
  meta: AnyType,
) {
  const ctx = yield* useContext(Gateway.context)
  const actionStatusMap = meta?.setting?.statusMap as Record<string, number> | undefined

  const headers = new Headers(res?.meta)
  const declaredType = headers.get('content-type')
  if (!declaredType) {
    headers.set('content-type', JSON_CONTENT)
  }

  const isJSON = headers.get('content-type') === JSON_CONTENT

  if (isFailure(actionResponse)) {
    if (actionResponse.error instanceof Error) {
      ;(actionResponse as AnyType).error = String(actionResponse.error)
    }

    const status = res?.status ?? statusFor(actionResponse.error, ctx.statusMap, actionStatusMap)
    const encoded = (yield* Codec.actions.encode(actionResponse)) as BodyInit
    return new Response(encoded, { headers, status })
  }

  const body = isSuccess(actionResponse) ? (actionResponse.value ?? res?.body) : res?.body
  const status = res?.status ?? (body === undefined ? 204 : 200)

  if (body === undefined) {
    return new Response(undefined, { status, headers })
  }

  // a streaming body (the gateway converts an action's byte Stream into a ReadableStream) goes out
  // verbatim — never through the codec — so it streams to the client instead of being buffered/encoded
  if (body instanceof ReadableStream) {
    return new Response(body, { status, headers })
  }

  // raw bytes (audio, images, files — incl. `Bun.file(...)` Blobs) also skip the codec, and get
  // single-range `Range` semantics so media elements can seek — see `respondBytes`
  const byteBody = asByteBody(body)
  if (byteBody) {
    return respondBytes(req, res, headers, byteBody, declaredType)
  }

  // JSON responses go back out through the same codec; other content-types pass through verbatim
  if (isJSON) {
    const encoded = (yield* Codec.actions.encode(body)) as BodyInit
    return new Response(encoded, { headers, status })
  }
  return new Response(body as AnyType, { headers, status })
})
