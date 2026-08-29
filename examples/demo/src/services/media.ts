import { useDb } from 'db:core'
import { action, service, serviceErrors, stream } from 'server:core'
import type { Flow } from 'std:effect'
import { until } from 'std:effect'

/**
 * Media: INPUT planes — a multipart upload (`parts`: fields + a file stream), a raw byte body
 * (`stream.bytes`), listing what was uploaded — and the way back OUT: `download` streams the
 * stored content from the db (base64 chunk rows read page by page, never the whole file at once).
 */
import { Buffer } from 'node:buffer'

import { z } from 'zod'

import { uploadChunksTable, uploadsTable } from '../tables'

/** declared once: the status the action publishes AND the failure the handler raises */
const mediaErrors = serviceErrors('media', { 'not-found': 404 })

const Upload = z.object({ id: z.string(), name: z.string(), size: z.number(), mime: z.string() })

/** One chunk row per this many raw bytes (base64 in the row, so ~341KB of text). */
const CHUNK_SIZE = 256 * 1024

function* sizeOf(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  let size = 0

  for (;;) {
    const step = yield* until(reader.read())

    if (step.done) {
      return size
    }

    size += step.value.length
  }
}

const concat = (parts: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total)
  let at = 0

  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }

  return out
}

export const media = service(
  'media',
  {
    upload: action.action(
      {
        input: stream.parts({
          fields: z.object({
            name: z.string(),
            mime: z.string().default('application/octet-stream'),
          }),
          streams: { file: stream.bytes('application/octet-stream') },
        }),
        output: Upload,
        auth: 'user',
        description:
          'multipart/form-data: `name`, `mime` fields then a `file` part — content lands in the db',
      },
      function* ({ input, ctx }) {
        const db = yield* useDb(uploadsTable, uploadChunksTable)

        const row = yield* db.insert('uploads', {
          name: input.fields.name,
          size: 0,
          mime: input.fields.mime,
        })
        const id = row._id
        const reader = (input.streams.file as ReadableStream<Uint8Array>).getReader()
        let size = 0
        let seq = 0
        let pending: Uint8Array[] = []
        let pendingSize = 0

        function* flush() {
          const data = Buffer.from(concat(pending, pendingSize)).toString('base64')
          pending = []
          pendingSize = 0
          yield* db.insert('upload_chunks', { upload_id: id, seq: seq++, data })
        }

        for (;;) {
          const step = yield* until(reader.read())

          if (step.done) {
            break
          }

          size += step.value.length
          pending.push(step.value)
          pendingSize += step.value.length

          if (pendingSize >= CHUNK_SIZE) {
            yield* flush()
          }
        }

        if (pendingSize > 0) {
          yield* flush()
        }

        yield* db.patch('uploads', id, { size })
        yield* ctx.emit('media.uploaded', { id, name: input.fields.name, size })
        return { id, name: input.fields.name, size, mime: input.fields.mime }
      },
    ),
    download: action.stream(
      {
        input: z.object({ id: z.string() }),
        output: stream.bytes('application/octet-stream'),
        route: { method: 'GET', path: '/media/download/:id' },
        errors: mediaErrors.statuses,
        description: 'The stored content, streamed back from the db one chunk page at a time',
      },
      function* ({ input }) {
        const upload = yield* (yield* useDb(uploadsTable)).get('uploads', input.id)

        if (!upload) {
          return yield* mediaErrors.notFound(`no upload ${input.id}`)
        }

        const flow: Flow<Uint8Array, void> = {
          *[Symbol.iterator]() {
            let cursor: string | null = null
            let exhausted = false
            let buffered: Uint8Array[] = []

            return {
              *next() {
                for (;;) {
                  const chunk = buffered.shift()

                  if (chunk) {
                    return { done: false as const, value: chunk }
                  }

                  if (exhausted) {
                    return { done: true as const, value: undefined }
                  }

                  const page = yield* (yield* useDb(uploadChunksTable))
                    .query('upload_chunks')
                    .filter({ op: 'eq', field: 'upload_id', value: input.id })
                    .order('seq', 'asc')
                    .paginate({ limit: 4, cursor })

                  cursor = page.pageInfo.nextCursor
                  exhausted = !page.pageInfo.hasNext

                  buffered = page.data.map(row => new Uint8Array(Buffer.from(row.data, 'base64')))
                }
              },
            }
          },
        }

        return flow
      },
    ),
    ingest: action.action(
      {
        input: stream.bytes('application/octet-stream'),
        output: z.object({ size: z.number() }),
        description: 'A raw byte body streamed into the handler (no buffering)',
      },
      function* ({ input }) {
        return { size: yield* sizeOf(input as ReadableStream<Uint8Array>) }
      },
    ),
    list: action.query(
      {
        output: z.array(Upload),
        cache: { ttlMs: 30_000, tags: ['uploads'] },
        description: 'Uploads so far (cached; the uploads table change feed invalidates it)',
      },
      function* () {
        const db = yield* useDb(uploadsTable)
        const rows = yield* db.query('uploads').order('_created_at', 'desc').collect()

        return rows.map(row => ({
          id: row._id,
          name: row.name,
          size: row.size,
          mime: row.mime,
        }))
      },
    ),
  },
  { version: '1.0.0', description: 'Uploads, raw bodies and db-backed downloads' },
)
