import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { $fn, $safe } from '../../results'

import { ioTags } from '../tag'
import { $exists, $existsSync } from './exists'
import { $mkdirSync } from './mkdir'

/**
 * The touch function touches a file at the specified path and
 * returns true in AsyncResult.
 */
export const $touch = $fn(async (path: string) => {
  const exists = await $exists(path, 'file')

  if (exists.isErr()) {
    await Bun.write(path, '')
  }

  return true
}, ioTags.get('touch'))

/**
 * The touchSync function touches a file at the specified path and
 * returns true in Result.
 */
export const $touchSync = $safe(function* (path: string) {
  const exists = $existsSync(path, 'file')

  if (exists.isErr()) {
    const dirPath = dirname(path)
    const dirExists = $existsSync(dirPath, 'dir')

    if (dirExists.isErr()) {
      yield* $mkdirSync(dirPath)
    }

    writeFileSync(path, '')
  }

  return true
}, ioTags.get('touch'))
