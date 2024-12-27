import { stat as fsStat } from 'node:fs/promises'

import { $fn } from '../../results'
import { ioTags } from '../tag'

/**
 * The exists function checks if a file exists at the specified path and
 * returns true in AsyncResult.
 */
export const $exists = $fn(async (path: string, type: 'file' | 'dir' | 'auto' = 'auto') => {
  const stat = await fsStat(path)

  if (type === 'auto') {
    return stat.isFile() || stat.isDirectory()
  }

  if (type === 'file') {
    return stat.isFile()
  }

  if (type === 'dir') {
    return stat.isDirectory()
  }

  return false
}, ioTags.get('exists'))
