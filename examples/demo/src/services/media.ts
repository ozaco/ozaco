/**
 * Media: INPUT planes — a multipart upload (`parts`: fields + a file stream), a raw byte body
 * (`stream.bytes`), and listing what was uploaded (with the db's uploads table).
 */
import { action, service, stream } from '@ozaco/server'
import { until } from '@ozaco/std/effect'
import { z } from 'zod'

const Upload = z.object({ id: z.string(), name: z.string(), size: z.number(), mime: z.string() })

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
        description: 'multipart/form-data: `name`, `mime` fields then a `file` part',
      },
      function* ({ input, ctx }) {
        const size = yield* sizeOf(input.streams.file as ReadableStream<Uint8Array>)
        const row = yield* ctx.db.insert('uploads', {
          name: input.fields.name,
          size,
          mime: input.fields.mime,
        })
        yield* ctx.emit('media.uploaded', { id: String(row._id), name: input.fields.name, size })
        return { id: String(row._id), name: input.fields.name, size, mime: input.fields.mime }
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
      function* ({ ctx }) {
        const rows = yield* ctx.db.query('uploads').order('_createdAt', 'desc').collect()
        return rows.map(row => ({
          id: String(row._id),
          name: String(row.name),
          size: Number(row.size),
          mime: String(row.mime),
        }))
      },
    ),
  },
  { version: '1.0.0', description: 'Uploads and raw bodies' },
)
