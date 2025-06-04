import { readdir } from 'node:fs/promises'
import { readdirSync } from 'node:fs'

import { $safe, err } from '../../results'

import { ioTags } from '../tag'
import { $exists, $existsSync } from './exists'

/**
 * The $readdir function reads a directory from the specified path and
 * returns its contents as a string[] in AsyncResult.
 */
export const $readdir = $safe(async function* (path: string, recursive = false) {
  const exists = yield* $exists(path, 'dir')

  if (!exists) {
    yield* err(ioTags.get('not-found'), `dir: ${path} not found`)
  }

  return (await readdir(path, {
    recursive,
  })) as string[]
}, ioTags.get('readdir'))

/**
 * The $readdirSync function reads a directory from the specified path and
 * returns its contents as a string[] in Result.
 */
export const $readdirSync = $safe(function* (path: string, recursive = false) {
  const exists = yield* $existsSync(path, 'dir')

  if (!exists) {
    yield* err(ioTags.get('not-found'), `dir: ${path} not found`)
  }

  return readdirSync(path, {
    recursive,
  }) as string[]
}, ioTags.get('readdir-sync'))
