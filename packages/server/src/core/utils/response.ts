/**
 * A response with mutable headers (and optionally another body), status kept. NEVER
 * `new Response(response.body, response)`: the headers a body brings along — a `Bun.file`'s
 * content-type — are not in the response's own header list until `response.headers` is READ,
 * and reading `response.body` first loses them for good. So: headers copied FIRST, body after.
 * `body` may also be a function of the original body (a pass-through wrapper) — it is called
 * only once the headers are copied.
 */
export const rewrapResponse = (
  response: Response,
  body?:
    | ReadableStream<Uint8Array>
    | null
    | ((original: ReadableStream<Uint8Array> | null) => ReadableStream<Uint8Array> | null),
): Response => {
  const headers = new Headers(response.headers)
  const next =
    body === undefined ? response.body : typeof body === 'function' ? body(response.body) : body

  return new Response(next, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
