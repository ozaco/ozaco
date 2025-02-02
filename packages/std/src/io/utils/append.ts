import { appendFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { $safe, err } from '../../results'

import { ioTags } from '../tag'
import { $exists, $existsSync } from './exists'
import { $mkdir, $mkdirSync } from './mkdir'

/**
 * The append function appends data to a file at the specified path and
 * returns true in AsyncResult.
 */
export const $append = $safe(async function* (
  path: string,
  data: string | ArrayBuffer,
  create = true
) {
  const exists = yield* $exists(path, 'file')

  if (!(exists || create)) {
    yield* err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  if (!exists) {
    yield* $mkdir(dirname(path))
  }

  await appendFile(path, data.toString())

  return true
}, ioTags.get('append'))

/**
 * The appendSync function appends data to a file at the specified path and
 * returns true in Result.
 */
export const $appendSync = $safe(function* (
  path: string,
  data: string | ArrayBuffer,
  create = true
) {
  const exists = yield* $existsSync(path, 'file')

  if (!(exists || create)) {
    yield* err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  if (!exists) {
    yield* $mkdirSync(dirname(path))
  }

  appendFileSync(path, data.toString())

  return true
}, ioTags.get('append-sync'))
