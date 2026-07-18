import { defineAction, defineService, Gateway, useMultipart, useRequest } from 'server:core'
import { each } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'

/**
 * File uploads two ways — both backed by `std:io`, both streaming (never the whole file in RAM):
 *
 *   • POST /upload         (buffered)  — the files map is ready before the action runs; each file was
 *                                        spilled to a temp file, so `req.files.<name>[0].stream` reads
 *                                        it back. Convenient for forms + small/medium files.
 *   • POST /upload/stream  (streaming) — the action pulls parts itself via `useMultipart()` and pipes
 *                                        each file straight to disk with zero spill. For large uploads
 *                                        or piping to S3 / hashing / transforms.
 *
 * Try it (server on :3000):
 *   curl -F name=avatar -F file=@./some.png  http://127.0.0.1:3000/upload
 *   curl -F file=@./big.zip                  http://127.0.0.1:3000/upload/stream
 */

// <os-temp>/ozaco-uploads, created on demand — every OS/fs touch goes through std:io (IO-first)
const uploadDir = function* () {
  const dir = yield* IO.actions.join(yield* IO.actions.tmpdir(), 'ozaco-uploads')
  yield* IO.actions.ensureDir(dir)
  return dir
}

export const UploadService = defineService({
  name: 'upload',
  version: '0.0.0',

  actions: {
    // A (buffered): the whole files map is ready; copy the "file" field to disk by re-streaming it
    save: defineAction(
      {
        title: 'Upload a file (buffered)',
        description: 'multipart/form-data with a "file" field, plus any text fields.',
        settings: [Gateway.actions.rest({ method: 'POST', path: '/' })],
      },
      function* (fields) {
        const req = yield* useRequest()
        const file = req.files.file?.[0]
        if (!file) {
          return yield* fail('upload.no-file', 'send a multipart body with a "file" field')
        }

        const dest = yield* IO.actions.join(
          yield* uploadDir(),
          `${yield* IO.actions.ulid()}-${file.name}`,
        )
        yield* IO.actions.writeStream(dest, file.stream)

        return {
          mode: 'buffered',
          name: file.name,
          type: file.type,
          size: file.size,
          savedTo: dest,
          fields,
        }
      },
    ),

    // B (streaming): pull every part and stream each file straight to disk — nothing buffered
    stream: defineAction(
      {
        title: 'Upload files (streaming)',
        description: 'multipart/form-data; each file is streamed to disk as it arrives.',
        settings: [Gateway.actions.rest({ method: 'POST', path: '/stream', multipart: 'stream' })],
      },
      function* () {
        const parts = yield* useMultipart()
        const dir = yield* uploadDir()

        const saved: { name: string | undefined; savedTo: string }[] = []
        const fields: Record<string, string> = {}

        for (const part of yield* each(parts)) {
          if (part.kind === 'field') {
            fields[part.name] = part.value
          } else {
            const dest = yield* IO.actions.join(
              dir,
              `${yield* IO.actions.ulid()}-${part.filename ?? part.name}`,
            )
            yield* IO.actions.writeStream(dest, part.stream)
            saved.push({ name: part.filename, savedTo: dest })
          }
          yield* each.next()
        }

        return { mode: 'streaming', saved, fields }
      },
    ),
  },
})
