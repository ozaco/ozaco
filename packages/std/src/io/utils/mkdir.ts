import { mkdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { $fn } from '../../results'
import { ioTags } from '../tag'

/**
 * The mkdir function creates a directory at the specified path asynchronously.
 * Returns true in AsyncResult.
 */
export const $mkdir = $fn(async (path: string) => {
  await mkdir(path, { recursive: true })

  return true as const
}, ioTags.get('mkdir'))

/**
 * The mkdirSync function creates a directory at the specified path synchronously.
 * Returns true in Result.
 */
export const $mkdirSync = $fn((path: string) => {
  mkdirSync(path, { recursive: true })

  return true as const
}, ioTags.get('mkdir'))
