// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt, until } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { ServerErrors } from '../../errors'

const NONE: ReadonlySet<string> = new Set()

/** The fields the DECLARED input types as arrays (zod object shapes, `optional`/`default`
 * wrappers unwrapped) — so a single query-string pass `?v=a` can be read as `['a']`. */
export const arrayFields = (schema: unknown): ReadonlySet<string> => {
  const def = (schema as AnyType)?._zod?.def

  if (!def || def.type !== 'object') {
    return NONE
  }

  const out = new Set<string>()

  for (const [key, field] of Object.entries(def.shape ?? {})) {
    let inner = (field as AnyType)?._zod?.def

    while (inner?.innerType) {
      inner = inner.innerType._zod?.def
    }

    if (inner?.type === 'array') {
      out.add(key)
    }
  }

  return out
}

/** A single query-string pass into a DECLARED array field is that array's one element — the
 * scalar/array duality of repeated keys ends at the declaration. */
const wrapArrays = (
  value: Record<string, unknown>,
  arrays: ReadonlySet<string>,
): Record<string, unknown> => {
  if (arrays.size === 0) {
    return value
  }

  const out = { ...value }

  for (const key of arrays) {
    const entry = out[key]

    if (entry !== undefined && !Array.isArray(entry)) {
      out[key] = [entry]
    }
  }

  return out
}

/** `"true"` → true, `"3"` → 3, `"[1,2]"` → [1,2], anything else stays a string: what a query
 * string or a form field can say, read with the schema's eyes. */
export const coerce = (text: string): unknown => {
  if (text === '') {
    return text
  }

  const first = text[0]

  if (
    text === 'true' ||
    text === 'false' ||
    text === 'null' ||
    first === '{' ||
    first === '[' ||
    first === '"' ||
    /^-?\d+(\.\d+)?$/u.test(text)
  ) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  return text
}

/** Query-string / form fields as an object: repeated keys become arrays. */
export const objectOf = (entries: Iterable<[string, string]>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}

  for (const [key, value] of entries) {
    const coerced = coerce(value)

    if (key in out) {
      const prior = out[key]
      out[key] = Array.isArray(prior) ? [...prior, coerced] : [prior, coerced]
    } else {
      out[key] = coerced
    }
  }

  return out
}

/** The value-plane input of a request: path params + query (GET) or body (JSON / form) —
 * query/form fields read with the DECLARED schema's eyes (single passes into array fields
 * wrap; a JSON body stays literal). */
export function* valueBody(
  request: Request,
  params: Readonly<Record<string, string>>,
  declared?: unknown,
): Operation<unknown> {
  const url = new URL(request.url)
  const fromParams = objectOf(Object.entries(params))
  const arrays = arrayFields(declared)

  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'DELETE') {
    return wrapArrays({ ...objectOf(url.searchParams.entries()), ...fromParams }, arrays)
  }

  const type = request.headers.get('content-type') ?? ''

  if (type.includes('application/x-www-form-urlencoded')) {
    const text = yield* until(request.text())
    return wrapArrays({ ...objectOf(new URLSearchParams(text).entries()), ...fromParams }, arrays)
  }

  const text = yield* until(request.text())

  if (text.trim() === '') {
    return wrapArrays({ ...objectOf(url.searchParams.entries()), ...fromParams }, arrays)
  }

  const parsed = yield* attempt(() => until(Promise.resolve().then(() => JSON.parse(text))))

  if (isFailure(parsed)) {
    return yield* fail(ServerErrors.BadRequest, 'request body is not valid JSON')
  }

  const body = parsed.value

  return body && typeof body === 'object' && !Array.isArray(body)
    ? { ...body, ...fromParams }
    : body
}
