import { $fn, $safe } from '../../results'

import { ioTags } from '../tag'
import { $touch } from '../utils/touch'
import { $openFile } from './open-file'

/**
 * @experimental
 *
 * The $writeTo function writes an AsyncIterable<Buffer> to a file at the given path.
 * Each chunk from the iterable is written sequentially to the file.
 *
 * Returns an object with a `write` method to write to the file and a `close` method to close the file.
 *
 * The `write` method returns the number of bytes written.
 *
 * The `close` method returns true if the file was closed successfully.
 *
 * @example
 * await using writer = (await $writeTo(path)).unwrap()
 *
 * await writer.write(Buffer.from('hi'))
 */

// biome-ignore lint/suspicious/useAwait: <explanation>
export const $writeTo = $safe(async function* (path: string, position = 0) {
  yield* $touch(path)

  const fd = yield* $openFile(path, 'w+')
  let pointer = position

  const write = $fn(async (chunk: Buffer) => {
    const { bytesWritten } = await fd.write(chunk, 0, chunk.length, pointer)

    pointer += bytesWritten

    return bytesWritten
  }, ioTags.get('write-to#write'))

  const close = $fn(async () => {
    return await fd.close()
  }, ioTags.get('write-to#close'))

  const api = {
    write,
    close,

    [Symbol.asyncDispose]: async () => {
      await close()
    },
  }

  return api
}, ioTags.get('write-to'))
