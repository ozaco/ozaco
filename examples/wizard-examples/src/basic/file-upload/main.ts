import {
  Broker,
  DataType,
  DefaultBroker,
  Gateway,
  defineAction,
  defineService,
  parts,
  useSource,
  value,
} from 'server:core'
import { action, mutation, resource } from 'server:wizard'
import { each, ensure, main } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { createClient } from '@ozaco/client'
import { pull } from '@ozaco/client/codegen'
import { BunGateway } from 'server:gateway/bun'
import { Docs } from 'server:plugin/docs'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

const result = z.object({
  files: z.number(),
  bytes: z.number(),
})

/** Drain every part of a multipart body, counting files and bytes. Uploads are byte lanes, always —
 * the handler pulls the parts itself and streams each file to its destination. */
function* drainUpload() {
  const upload = yield* useSource(DataType.multistream)
  const uploadParts = upload?.parts
  let files = 0
  let bytes = 0

  if (!uploadParts) {
    return { files, bytes }
  }

  for (const part of yield* each(uploadParts)) {
    if (part.kind === 'file') {
      files += 1
      for (const chunk of yield* each(part.stream)) {
        bytes += chunk.byteLength
        yield* each.next()
      }
    }
    yield* each.next()
  }

  return { files, bytes }
}

const single = mutation({
  args: z.object({ label: z.string() }),
  returns: result,
  upload: { files: ['file'] },
  *handler() {
    const drained = yield* drainUpload()
    if (drained.files === 0) {
      return yield* fail('upload.no-file', 'missing multipart field "file"')
    }
    return drained
  },
})

const streaming = action({
  returns: result,
  upload: { files: { file: { multiple: true } } },
  *handler() {
    return yield* drainUpload()
  },
})

const uploads = resource('uploads', { single, streaming })

// The same Gateway upload path remains available to ordinary server services: any multipart body
// arrives as a multistream source, no per-route option needed.
const nativeUploads = defineService({
  name: 'nativeUploads',
  version: '0.0.0',
  actions: {
    save: defineAction(
      {
        input: [value(z.object({ label: z.string() })), parts()],
        output: result,
        settings: [Gateway.actions.rest({ method: 'POST', path: '/save' })],
      },
      function* () {
        const drained = yield* drainUpload()
        if (drained.files === 0) {
          return yield* fail('upload.no-file', 'missing multipart field "file"')
        }
        return drained
      },
    ),
  },
})

type UploadApi = {
  uploads: {
    single: {
      kind: 'mutation'
      args: { label: string; file: Blob }
      result: { files: number; bytes: number }
    }
    streaming: {
      kind: 'action'
      args: { file: Blob[] }
      result: { files: number; bytes: number }
    }
  }
  nativeUploads: {
    save: {
      kind: 'mutation'
      args: { label: string; file: Blob }
      result: { files: number; bytes: number }
    }
  }
}

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultBroker)
  yield* install(BunGateway, {})
  yield* install(Docs, { silent: true })
  yield* uploads.actions.install()
  yield* nativeUploads.actions.install()
  yield* Broker.actions.register(nativeUploads)
  yield* Gateway.actions.mount('/nativeUploads', nativeUploads)
  yield* Docs.actions.from(uploads, nativeUploads)
  yield* Broker.actions.start()

  const { host, port } = yield* Gateway.actions.start({ port: 0, host: '127.0.0.1' })
  yield* ensure(function* () {
    yield* Gateway.actions.destroy()
    yield* Broker.actions.destroy()
  })

  const url = `http://${host}:${port}`
  const client = createClient<UploadApi>({ url })
  // the FILE deliberately precedes the field: the client must reorder plain fields ahead of blobs,
  // or `label` would arrive after the file part and never reach the validated body
  const singleResult = yield* client.uploads.single({
    file: new File(['wizard-streamed'], 'single.txt', { type: 'text/plain' }),
    label: 'avatar',
  })
  const streamingResult = yield* client.uploads.streaming({
    file: [
      new File(['wizard'], 'one.txt', { type: 'text/plain' }),
      new File(['stream'], 'two.txt', { type: 'text/plain' }),
    ],
  })
  const nativeResult = yield* client.nativeUploads.save({
    label: 'server-service',
    file: new File(['native'], 'native.txt', { type: 'text/plain' }),
  })
  const generated = yield* pull(url)

  if (
    singleResult.bytes !== 15 ||
    streamingResult.files !== 2 ||
    streamingResult.bytes !== 12 ||
    nativeResult.bytes !== 6 ||
    !generated.includes('file: Blob') ||
    !generated.includes('file: (Blob)[]')
  ) {
    return yield* fail('upload.smoke', 'Wizard upload, streaming, or generated client mismatch')
  }

  console.log('single:', singleResult)
  console.log('streaming:', streamingResult)
  console.log('native service:', nativeResult)
  console.log('client types: Blob + Blob[]')
})
