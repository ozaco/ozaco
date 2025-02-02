import { $safe } from '../../results'

import { ioTags } from '../tag'
import { $stats, $statsSync } from './stats'

/**
 * The exists function checks if a file exists at the specified path and
 * returns true in AsyncResult.
 */

// biome-ignore lint/suspicious/useAwait: Redundant
export const $exists = $safe(async function* (
  path: string,
  type: 'file' | 'dir' | 'auto' = 'auto'
) {
  const stat = yield* $stats(path)

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

/**
 * The existsSync function checks if a file exists at the specified path and
 * returns true in Result.
 */
export const $existsSync = $safe(function* (path: string, type: 'file' | 'dir' | 'auto' = 'auto') {
  const stat = yield* $statsSync(path)

  if (!stat) {
    return false
  }

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
}, ioTags.get('exists-sync'))
