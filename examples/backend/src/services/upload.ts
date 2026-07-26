import {
  chunks,
  DataType,
  defineAction,
  defineService,
  Gateway,
  parts,
  useResponse,
  useSource,
  value,
} from 'server:core'
import { each } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'

import { z } from 'zod'

/**
 * File uploads are byte lanes, always: the action takes the parts source itself and pipes each file
 * straight to its destination (disk here; S3, hashing, transforms elsewhere) with zero spill —
 * never the whole file in RAM, and nothing that cannot cross a wire to another pod.
 *
 * Try it (server on :3000):
 *   curl -F note=hi -F file=@./big.zip  http://127.0.0.1:3000/upload/stream
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
    // Pull every part and stream each file straight to disk — nothing buffered
    stream: defineAction(
      {
        title: 'Upload files (streaming)',
        description: 'multipart/form-data; each file is streamed to disk as it arrives.',
        // declared, not discovered: the parts lane is on the wire contract, so policies know this
        // call streams, docs emit multipart, and a carrier opens the lane before dispatching
        input: [value(z.record(z.string(), z.unknown())), parts()],
        settings: [Gateway.actions.rest({ method: 'POST', path: '/stream' })],
      },
      function* (body) {
        const upload = yield* useSource(DataType.multistream)
        const dir = yield* uploadDir()

        if (!upload) {
          return yield* fail(
            'upload.not-multipart',
            'this route expects a multipart/form-data body',
          )
        }

        const uploadParts = upload.parts

        const saved: { name: string | undefined; savedTo: string }[] = []
        // fields ahead of the first file arrive as the BODY; anything after a file stays a part
        const fields: Record<string, string> = { ...(body as unknown as Record<string, string>) }

        for (const part of yield* each(uploadParts)) {
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

    /**
     * C (download): the counterpart — hand the bytes back as a LANE.
     *
     * `output: chunks()` is the whole declaration. The edge reads it at mount time and knows to keep
     * the response open and pump, so the file never lands in memory on the way out either; nothing
     * here inspects the value to decide that.
     */
    read: defineAction(
      {
        title: 'Download a file',
        input: z.object({ name: z.string() }),
        output: chunks(),
        settings: [Gateway.actions.rest({ method: 'GET', path: '/:name' })],
      },
      function* (body) {
        const dir = yield* uploadDir()
        const path = yield* IO.actions.join(dir, body.name)

        const res = yield* useResponse()

        if (!(yield* IO.actions.exists(path))) {
          // the status is set BEFORE failing, so the fault carries it home — see `Outcome.Fault`
          res.status = 404
          return yield* fail('upload.missing', `no file "${body.name}"`)
        }

        res.meta['content-type'] = 'application/octet-stream'
        res.meta['content-disposition'] = `attachment; filename="${body.name}"`

        return IO.actions.readStream(path) as never
      },
    ),
  },
})
