import type { RouteDoc } from './manifest'
import type { UploadFile } from './upload'

/**
 * Try-it request builder + executor against the gateway edge contract:
 * `:param` route segments fill from args, leftover args go to the query string on GET/HEAD and to
 * a JSON body otherwise; attached files ALWAYS switch the request to multipart form-data with
 * fields FIRST (the edge merges leading fields into the action params) and files after.
 */

const fieldValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value)

export interface BuildInput {
  readonly args: Readonly<Record<string, unknown>>
  readonly files?: readonly UploadFile[]
  readonly token?: string
  readonly base?: string
}

export type BodyKind = 'none' | 'json' | 'multipart'

export interface BuiltRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | FormData | undefined
  readonly bodyKind: BodyKind
}

/** Fill `:param` segments from args; returns the path and the consumed arg names. */
export const fillPath = (
  path: string,
  args: Readonly<Record<string, unknown>>,
): { path: string; used: ReadonlySet<string> } => {
  const used = new Set<string>()
  const filled = path.replaceAll(/:([A-Za-z0-9_]+)/gu, (_whole, name: string) => {
    used.add(name)

    const value = args[name]

    return encodeURIComponent(value === undefined ? '' : String(value))
  })

  return { path: filled, used }
}

export const buildRequest = (
  route: RouteDoc,
  { args, files = [], token, base = '' }: BuildInput,
): BuiltRequest => {
  const { path, used } = fillPath(route.path, args)
  const rest: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(args)) {
    if (!used.has(key)) {
      rest[key] = value
    }
  }

  const headers: Record<string, string> = {}

  if (token !== undefined && token !== '') {
    headers['authorization'] = `Bearer ${token}`
  }

  let url = `${base}${path}`
  const method = route.method.toUpperCase()

  if (files.length > 0) {
    // fields FIRST — the edge treats fields before the first file as action params
    const form = new FormData()

    for (const [key, value] of Object.entries(rest)) {
      form.append(key, fieldValue(value))
    }

    for (const upload of files) {
      form.append(upload.field, upload.file, upload.file.name)
    }

    return { url, method, headers, body: form, bodyKind: 'multipart' }
  }

  if (method === 'GET' || method === 'HEAD') {
    const query = new URLSearchParams()

    for (const [key, value] of Object.entries(rest)) {
      query.set(key, fieldValue(value))
    }

    const qs = query.toString()

    if (qs !== '') {
      url += `?${qs}`
    }

    return { url, method, headers, body: undefined, bodyKind: 'none' }
  }

  return {
    url,
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(rest),
    bodyKind: 'json',
  }
}

export type ResponseKind = 'json' | 'ndjson' | 'sse' | 'bytes' | 'text'

/** Classify a response by content-type (the edge emits json / x-ndjson / event-stream / bytes). */
export const classifyContentType = (contentType: string | null): ResponseKind => {
  const type = (contentType ?? '').toLowerCase()

  if (type.includes('ndjson')) {
    return 'ndjson'
  }

  if (type.includes('text/event-stream')) {
    return 'sse'
  }

  if (type.includes('json')) {
    return 'json'
  }

  if (type.startsWith('text/')) {
    return 'text'
  }

  return 'bytes'
}

export interface Executed {
  readonly status: number
  readonly ok: boolean
  readonly statusText: string
  readonly headers: Headers
  /** The gateway's `x-request-id` echo. */
  readonly requestId: string | null
  readonly kind: ResponseKind
  /** The raw response — body NOT consumed, streams stay readable. */
  readonly response: Response
}

/** Execute a built request; classification only reads headers so streaming bodies stay intact. */
export const execute = async (
  built: BuiltRequest,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Executed> => {
  const response = await fetch(built.url, {
    method: built.method,
    headers: built.headers,
    ...(built.body === undefined ? {} : { body: built.body }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  return {
    status: response.status,
    ok: response.ok,
    statusText: response.statusText,
    headers: response.headers,
    requestId: response.headers.get('x-request-id'),
    kind: classifyContentType(response.headers.get('content-type')),
    response,
  }
}
