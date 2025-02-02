import { appendFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { $fn, err } from '../../results'

import { ioTags } from '../tag'
import { $mkdir, $mkdirSync } from './mkdir'
import { $statsSync } from './stats'

/**
 * The append function appends data to a file at the specified path and
 * returns true in AsyncResult.
 */
export const $append = $fn(async (path: string, data: string | ArrayBuffer, create = true) => {
  const file = Bun.file(path)
  const exists = await file.exists()

  if (!(exists || create)) {
    return err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  if (!exists) {
    ;(await $mkdir(dirname(path))).unwrap()
  }

  await appendFile(path, data.toString())

  return true
}, ioTags.get('append'))

/**
 * The appendSync function appends data to a file at the specified path and
 * returns true in Result.
 */
export const $appendSync = $fn((path: string, data: string | ArrayBuffer, create = true) => {
  const stats = $statsSync(path)
  const exists = stats.isErr() ? false : (stats.value?.isFile() ?? false)

  if (!(exists || create)) {
    return err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  if (!exists) {
    $mkdirSync(dirname(path)).unwrap()
  }

  appendFileSync(path, data.toString())

  return true
}, ioTags.get('append-sync'))
