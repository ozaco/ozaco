import { $fn } from '../../results'

import { ioTags } from '../tag'
import { $stats, $statsSync } from './stats'

/**
 * The exists function checks if a file exists at the specified path and
 * returns true in AsyncResult.
 */
export const $exists = $fn(async (path: string, type: 'file' | 'dir' | 'auto' = 'auto') => {
  const stat = (await $stats(path)).unwrap()

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
export const $existsSync = $fn((path: string, type: 'file' | 'dir' | 'auto' = 'auto') => {
  const stat = $statsSync(path).unwrap()

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
