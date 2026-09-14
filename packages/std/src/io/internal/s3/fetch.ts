import type { S3ListOptions, S3Options, S3PresignOptions } from '../../types/common'
import type { Helpers } from '../../types/helpers'

import { resolveConfig } from './config'
import { uploadStream } from './multipart'
import { presignUrl } from './sign'
import { createTransport, ensureOk } from './transport'
import { parseListing } from './xml'

// A dependency-free S3 client over `fetch` for runtimes without Bun's native `S3Client`. It
// produces the same native surface (`Helpers.S3Native`) that `createS3` wraps, so one effect
// wrapper serves both. Pieces: `config` (options over env), `sign` (SigV4), `transport` (URLs +
// one signed `send`), `xml` (the three documents), `multipart` (streaming uploads).

const DEFAULT_EXPIRES_IN = 86_400

const toBytes = async (data: Uint8Array | string | Blob): Promise<Uint8Array | string> =>
  data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data

const byteLength = (data: Uint8Array | string): number =>
  typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength

export const fetchS3Client = (options: S3Options): Helpers.S3Native => {
  const config = resolveConfig(options)
  const transport = createTransport(config)

  /** GET the object and hand the response to `read` — every body reader goes through here. */
  const get = async <T>(key: string, read: (response: Response) => Promise<T>): Promise<T> => {
    const response = await transport.send({ method: 'GET', url: transport.objectUrl(key) })
    ensureOk(response, key)

    return read(response)
  }

  const presign = (key: string, presignOptions: S3PresignOptions = {}): string =>
    presignUrl(config, {
      method: presignOptions.method ?? 'GET',
      url: transport.objectUrl(key),
      expiresIn: presignOptions.expiresIn ?? DEFAULT_EXPIRES_IN,
    })

  const file = (key: string): Helpers.S3NativeFile => ({
    text: () => get(key, response => response.text()),
    json: () => get(key, response => response.json()),
    arrayBuffer: () => get(key, response => response.arrayBuffer()),
    bytes: () => get(key, async response => new Uint8Array(await response.arrayBuffer())),

    // the body is handed over untouched: chunks reach the consumer as they arrive from the network
    stream: () =>
      get(key, response => Promise.resolve(response.body ?? new ReadableStream<Uint8Array>())),

    write: async (data: Uint8Array | string | Blob | ReadableStream<Uint8Array>) => {
      if (data instanceof ReadableStream) {
        return uploadStream(transport, key, data)
      }

      const body = await toBytes(data)
      const response = await transport.send({ method: 'PUT', url: transport.objectUrl(key), body })
      ensureOk(response, key)

      return byteLength(body)
    },

    exists: async () => {
      const response = await transport.send({ method: 'HEAD', url: transport.objectUrl(key) })

      return response.ok
    },

    delete: async () => {
      const response = await transport.send({ method: 'DELETE', url: transport.objectUrl(key) })
      ensureOk(response, key)
    },

    stat: async () => {
      const response = await transport.send({ method: 'HEAD', url: transport.objectUrl(key) })
      ensureOk(response, key)
      const lastModified = response.headers.get('last-modified')

      return {
        size: Number(response.headers.get('content-length') ?? 0),
        etag: response.headers.get('etag') ?? undefined,
        lastModified: lastModified ? new Date(lastModified) : undefined,
        type: response.headers.get('content-type') ?? undefined,
      }
    },

    presign: presignOptions => presign(key, presignOptions),
  })

  const list = async (listOptions: S3ListOptions = {}) => {
    const url = transport.bucketUrl()
    url.searchParams.set('list-type', '2')
    if (listOptions.prefix) {
      url.searchParams.set('prefix', listOptions.prefix)
    }
    if (listOptions.maxKeys) {
      url.searchParams.set('max-keys', String(listOptions.maxKeys))
    }
    if (listOptions.continuationToken) {
      url.searchParams.set('continuation-token', listOptions.continuationToken)
    }
    if (listOptions.startAfter) {
      url.searchParams.set('start-after', listOptions.startAfter)
    }

    const response = await transport.send({ method: 'GET', url })
    ensureOk(response, config.bucket)

    return parseListing(await response.text())
  }

  return {
    file,
    write: (key, data) => file(key).write(data),
    exists: key => file(key).exists(),
    delete: key => file(key).delete(),
    stat: key => file(key).stat(),
    list,
    presign,
  }
}
