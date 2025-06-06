import { $gen, $safe } from '../../results'

import { ioTags } from '../tag'
import { $stats } from '../utils/stats'
import { $openFile } from './open-file'

const DEFAULT_CHUNK_SIZE = 64 * 1024

/**
 * @experimental
 *
 * The $readFrom function reads a file from the specified path and
 * returns a AsyncGenerator<ArrayBuffer, number, unknown> in AsyncResult.
 * Don't store the buffer yielded by the generator. It's not a copy.
 *
 * @example
 * await using reader = (await $readFrom(path)).unwrap()
 *
 * for await (const chunk of reader) {
 *   console.log(chunk)
 * }
 */
// biome-ignore lint/suspicious/useAwait: <explanation>
export const $readFrom = $safe(async function* (
  path: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  position = 0
) {
  const fd = yield* $openFile(path)
  const stats = yield* $stats(path)

  const buffer = Buffer.allocUnsafe(chunkSize)
  let pointer = position

  const readerFn = $gen(async function* () {
    try {
      while (pointer < stats.size) {
        const { bytesRead } = await fd.read(buffer, 0, chunkSize, pointer)
        if (bytesRead === 0) {
          break
        }

        pointer += bytesRead
        yield buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead)
      }
    } finally {
      await fd.close()
    }
  }, ioTags.get('read-from-gen'))

  const reader = readerFn()

  Reflect.defineProperty(reader, Symbol.asyncDispose, {
    value: async () => {
      pointer = stats.size
      await fd.close()
    },
  })

  return reader
}, ioTags.get('read-from'))
