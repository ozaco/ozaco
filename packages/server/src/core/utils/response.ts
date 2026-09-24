/**
 * A response with mutable headers (and optionally another body), status kept. NEVER
 * `new Response(response.body, response)`: the headers a body brings along — a `Bun.file`'s
 * content-type — are not in the response's own header list until `response.headers` is READ,
 * and reading `response.body` first loses them for good. So: headers copied FIRST, body after.
 */
export const rewrapResponse = (
  response: Response,
  body?: ReadableStream<Uint8Array> | null,
): Response => {
  const headers = new Headers(response.headers)

  return new Response(body === undefined ? response.body : body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
