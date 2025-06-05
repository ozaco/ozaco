import { open } from 'node:fs/promises'

import { $safe } from '../../results'
import { $existsSync } from '../utils/exists'
import { ioTags } from '../tag'

/**
 * @experimental
 *
 * The $openFile function opens a file at the specified path and
 * returns a FileHandle in AsyncResult.
 */
export const $openFile = $safe(async function* (path: string, flags = 'r') {
  yield* $existsSync(path, 'file')

  return await open(path, flags)
}, ioTags.get('open-file'))
