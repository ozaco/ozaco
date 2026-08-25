import type { Operation } from 'std:effect'
import { attempt, until } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { ServerErrors } from '../../errors'

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

/** The value-plane input of a request: path params + query (GET) or body (JSON / form). */
export function* valueBody(
  request: Request,
  params: Readonly<Record<string, string>>,
): Operation<unknown> {
  const url = new URL(request.url)
  const fromParams = objectOf(Object.entries(params))

  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'DELETE') {
    return { ...objectOf(url.searchParams.entries()), ...fromParams }
  }

  const type = request.headers.get('content-type') ?? ''

  if (type.includes('application/x-www-form-urlencoded')) {
    const text = yield* until(request.text())
    return { ...objectOf(new URLSearchParams(text).entries()), ...fromParams }
  }

  const text = yield* until(request.text())

  if (text.trim() === '') {
    return { ...objectOf(url.searchParams.entries()), ...fromParams }
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
