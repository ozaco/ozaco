import type { Stream } from 'std:effect'

export interface Request {
  method: string
  url: URL

  meta: Record<string, string> // headers
  files: Record<string, Stream<Uint8Array, void>[]>
  body: unknown
  rawBody: Stream<Uint8Array, void>

  raw: unknown
}

export interface Response {
  meta: Record<string, string> // headers
  fils: Record<string, Stream<Uint8Array, void>[]>
  body: unknown

  raw: unknown
}
