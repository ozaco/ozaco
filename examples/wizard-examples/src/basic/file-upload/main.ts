import {
  Broker,
  DefaultBroker,
  defineAction,
  defineService,
  Gateway,
  useRequest,
} from 'server:core'
import { action, mutation, resource, useMultipart, useUploadFiles } from 'server:wizard'
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
  mode: z.enum(['buffer', 'stream']),
  files: z.number(),
  bytes: z.number(),
})

const buffered = mutation({
  args: z.object({ label: z.string() }),
  returns: result,
  upload: { files: ['file'] },
  *handler() {
    const files = yield* useUploadFiles()
    const file = files.file?.[0]
    if (!file) {
      return yield* fail('upload.no-file', 'missing multipart field "file"')
    }
    return { mode: 'buffer' as const, files: 1, bytes: file.size }
  },
})

const streaming = action({
  returns: result,
  upload: { mode: 'stream', files: { file: { multiple: true } } },
  *handler() {
    const parts = yield* useMultipart()
    let files = 0
    let bytes = 0

    for (const part of yield* each(parts)) {
      if (part.kind === 'file') {
        files += 1
        for (const chunk of yield* each(part.stream)) {
          bytes += chunk.byteLength
          yield* each.next()
        }
      }
      yield* each.next()
    }

    return { mode: 'stream' as const, files, bytes }
  },
})

const uploads = resource('uploads', { buffered, streaming })

// The same Gateway upload path remains available to ordinary server services.
const nativeUploads = defineService({
  name: 'nativeUploads',
  version: '0.0.0',
  actions: {
    save: defineAction(
      {
        input: z.object({ label: z.string() }),
        output: result,
        settings: [
          Gateway.actions.rest({
            method: 'POST',
            path: '/save',
            multipart: 'buffer',
            files: ['file'],
          }),
        ],
      },
      function* () {
        const file = (yield* useRequest()).files.file?.[0]
        if (!file) {
          return yield* fail('upload.no-file', 'missing multipart field "file"')
        }
        return { mode: 'buffer' as const, files: 1, bytes: file.size }
      },
    ),
  },
})

type UploadApi = {
  uploads: {
    buffered: {
      kind: 'mutation'
      args: { label: string; file: Blob }
      result: { mode: 'buffer' | 'stream'; files: number; bytes: number }
    }
    streaming: {
      kind: 'action'
      args: { file: Blob[] }
      result: { mode: 'buffer' | 'stream'; files: number; bytes: number }
    }
  }
  nativeUploads: {
    save: {
      kind: 'mutation'
      args: { label: string; file: Blob }
      result: { mode: 'buffer' | 'stream'; files: number; bytes: number }
    }
  }
}

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultBroker)
  yield* install(BunGateway, {})
  yield* install(Docs, { silent: true })
  yield* install(uploads)
  yield* install(nativeUploads)
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
  const bufferedResult = yield* client.uploads.buffered({
    label: 'avatar',
    file: new File(['wizard-buffered'], 'buffered.txt', { type: 'text/plain' }),
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
    bufferedResult.bytes !== 15 ||
    streamingResult.files !== 2 ||
    streamingResult.bytes !== 12 ||
    nativeResult.bytes !== 6 ||
    !generated.includes('file: Blob') ||
    !generated.includes('file: (Blob)[]')
  ) {
    return yield* fail('upload.smoke', 'Wizard upload, streaming, or generated client mismatch')
  }

  console.log('buffered:', bufferedResult)
  console.log('streaming:', streamingResult)
  console.log('native service:', nativeResult)
  console.log('client types: Blob + Blob[]')
})
