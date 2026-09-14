import { fail } from 'std:result'

import { IOErrors } from '../../errors'
import type { Helpers } from '../../types/helpers'

import { ensureOk } from './transport'
import { parseUploadId, renderCompletion } from './xml'

// Streaming uploads: S3 has no chunked PUT, so a `ReadableStream` body goes up as a multipart
// upload — initiate, PUT one part per `partSize` bytes as they arrive (only that much is ever held
// in memory), complete with the collected ETags; abort on any failure so no orphan parts linger.

const concat = (chunks: readonly Uint8Array[], length: number): Uint8Array => {
  const out = new Uint8Array(length)
  let offset = 0

  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }

  return out
}

/** Read the stream and hand out full parts; the final call returns whatever is left (maybe empty). */
async function* parts(
  source: ReadableStream<Uint8Array>,
  partSize: number,
): AsyncGenerator<Uint8Array, void> {
  const reader = source.getReader()
  let buffered: Uint8Array[] = []
  let length = 0

  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design: bounded memory, ordered parts
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffered.push(value)
      length += value.length

      while (length >= partSize) {
        const whole = concat(buffered, length)
        yield whole.subarray(0, partSize)
        const rest = whole.subarray(partSize)
        buffered = rest.length > 0 ? [rest] : []
        length = rest.length
      }
    }

    yield concat(buffered, length)
  } finally {
    reader.releaseLock()
  }
}

const initiate = async (transport: Helpers.S3Transport, key: string): Promise<string> => {
  const url = transport.objectUrl(key)
  url.searchParams.set('uploads', '')

  const response = await transport.send({ method: 'POST', url })
  ensureOk(response, key)

  const uploadId = parseUploadId(await response.text())
  if (!uploadId) {
    throw fail(IOErrors.S3Failed, `s3 multipart initiation returned no UploadId for "${key}"`)
  }

  return uploadId
}

/** One in-flight multipart upload: the transport plus the object and upload it belongs to. */
interface Upload {
  readonly transport: Helpers.S3Transport
  readonly key: string
  readonly uploadId: string
}

const uploadPart = async (
  upload: Upload,
  partNumber: number,
  body: Uint8Array,
): Promise<Helpers.S3Part> => {
  const { transport, key, uploadId } = upload
  const url = transport.objectUrl(key)
  url.searchParams.set('partNumber', String(partNumber))
  url.searchParams.set('uploadId', uploadId)

  const response = await transport.send({ method: 'PUT', url, body })
  ensureOk(response, key)

  return { partNumber, etag: response.headers.get('etag') ?? '' }
}

const complete = async (upload: Upload, uploaded: readonly Helpers.S3Part[]): Promise<void> => {
  const { transport, key, uploadId } = upload
  const url = transport.objectUrl(key)
  url.searchParams.set('uploadId', uploadId)

  const response = await transport.send({
    method: 'POST',
    url,
    body: renderCompletion(uploaded),
    headers: { 'content-type': 'application/xml' },
  })
  ensureOk(response, key)
}

const abort = async ({ transport, key, uploadId }: Upload) => {
  const url = transport.objectUrl(key)
  url.searchParams.set('uploadId', uploadId)

  await transport.send({ method: 'DELETE', url }).catch(() => undefined) // best effort
}

/**
 * Upload `source` as it is read. Resolves to the number of bytes written; rejects with the first
 * failure after aborting the multipart upload.
 */
export const uploadStream = async (
  transport: Helpers.S3Transport,
  key: string,
  source: ReadableStream<Uint8Array>,
): Promise<number> => {
  const upload: Upload = { transport, key, uploadId: await initiate(transport, key) }
  const uploaded: Helpers.S3Part[] = []
  let written = 0

  try {
    for await (const part of parts(source, transport.config.partSize)) {
      // oxlint-disable-next-line no-await-in-loop -- parts go up in order, one at a time
      uploaded.push(await uploadPart(upload, uploaded.length + 1, part))
      written += part.length
    }

    await complete(upload, uploaded)
  } catch (error) {
    await abort(upload)
    throw error
  }

  return written
}
