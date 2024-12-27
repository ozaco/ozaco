import { appendFileSync, statSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'

import { ioTags } from '../tag'

import { dirname } from 'node:path'
import { $fn, err, fromThrowable } from '../../results'
import { $mkdir, $mkdirSync } from './mkdir'

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

export const $appendSync = $fn((path: string, data: string | ArrayBuffer, create = true) => {
  const stats = fromThrowable(statSync, () =>
    err(ioTags.get('not-found'), `file: ${path} not found`)
  )(path)

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
