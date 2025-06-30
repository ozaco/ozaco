import { unlinkSync } from 'node:fs'
import { unlink } from 'node:fs/promises'

import { $safe } from '../../results'

import { ioTags } from '../tag'
import { $exists, $existsSync } from './exists'

/**
 * The $rm function removes a file or directory at the specified path and
 * returns true in AsyncResult.
 */
// biome-ignore lint/correctness/useYield: Redundant
export const $rm = $safe(async function* (path: string, type: 'file' | 'dir' | 'auto' = 'auto') {
  const stats = await $exists(path, type)

  if (stats.isErr()) {
    return true
  }

  await unlink(path)

  return true
}, ioTags.get('exists'))

/**
 * The $rmSync function removes a file or directory at the specified path and
 * returns true in Result.
 */
// biome-ignore lint/correctness/useYield: Redundant
export const $rmSync = $safe(function* (path: string, type: 'file' | 'dir' | 'auto' = 'auto') {
  const stats = $existsSync(path, type)

  if (stats.isErr()) {
    return true
  }

  unlinkSync(path)

  return true
}, ioTags.get('exists'))
