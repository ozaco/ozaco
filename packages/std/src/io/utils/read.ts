import { $safe, err } from '../../results'

import { ioTags } from '../tag'
import { $exists } from './exists'

/**
 * The $read function reads a file from the specified path and
 * returns its contents as a ArrayBuffer in AsyncResult.
 */
export const $read = $safe(async function* (path: string) {
  const file = Bun.file(path)
  const exists = yield* $exists(path, 'file')

  if (!exists) {
    yield* err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  return await file.arrayBuffer()
}, ioTags.get('read'))

/**
 * The $readJson function reads a file from the specified path and
 * returns its contents as a object in AsyncResult.
 */
export const $readJson = $safe(async function* <T>(path: string) {
  const file = Bun.file(path)
  const exists = yield* $exists(path, 'file')

  if (!exists) {
    yield* err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  if (!file.type.includes('application/json')) {
    yield* err(
      ioTags.get('invalid-mime'),
      `file: ${path} file type: ${file.type} cannot be read with this method`
    )
  }

  return (await file.json()) as T
}, ioTags.get('read-json'))
