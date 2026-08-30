// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt, until } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import { ServerErrors } from '../../errors'

const NONE: ReadonlySet<string> = new Set()

/** Whether a JSON-schema property (or any branch of its unions/wrappers) is an array. */
const isArrayProperty = (property: AnyType): boolean => {
  if (!property || typeof property !== 'object') {
    return false
  }

  if (property.type === 'array') {
    return true
  }

  const branches = [...(property.anyOf ?? []), ...(property.oneOf ?? []), ...(property.allOf ?? [])]

  return branches.some(branch => isArrayProperty(branch))
}

/** The fields the DECLARED input types as arrays — so a single query-string pass `?v=a` can be
 * read as `['a']`. Read through zod's PUBLIC `z.toJSONSchema` (not private internals): a
 * non-zod Standard Schema, or one it cannot render, simply answers no array fields. */
export const arrayFields = (schema: unknown): ReadonlySet<string> => {
  let json: AnyType

  try {
    json = z.toJSONSchema(schema as AnyType, { unrepresentable: 'any', io: 'input' })
  } catch {
    return NONE
  }

  if (json?.type !== 'object' || !json.properties) {
    return NONE
  }

  const out = new Set<string>()

  for (const [key, property] of Object.entries(json.properties)) {
    if (isArrayProperty(property)) {
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
