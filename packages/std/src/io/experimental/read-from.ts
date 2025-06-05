import { $gen, $safe } from '../../results'

import { ioTags } from '../tag'
import { $stats } from '../utils/stats'
import { $openFile } from './open-file'

const DEFAULT_CHUNK_SIZE = 64 * 1024

/**
 * @experimental
 *
 * The $readFrom function reads a file from the specified path and
 * returns a AsyncGenerator<Buffer, number, unknown> in AsyncResult.
 * Don't store the buffer yielded by the generator. It's not a copy.
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

  const reader = $gen(async function* () {
    try {
      while (pointer < stats.size) {
        const { bytesRead } = await fd.read(buffer, 0, chunkSize, pointer)
        if (bytesRead === 0) {
          break
        }

        pointer += bytesRead
        yield buffer.subarray(0, bytesRead)
      }
    } finally {
      await fd.close()
    }

    return 1
  }, ioTags.get('read-from-gen'))

  return reader()
}, ioTags.get('read-from'))
