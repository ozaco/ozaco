import { $safe, err } from '../../results'
import type { JsonValue } from '../../shared'

import { ioTags } from '../tag'
import { $exists } from './exists'

/**
 * The $write function writes a file to the specified path and
 * returns true in AsyncResult.
 */
export const $write = $safe(async function* (
  path: string,
  data: string | ArrayBuffer,
  create = true
) {
  const exists = yield* $exists(path, 'file')

  if (!(exists || create)) {
    yield* err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  await Bun.write(path, data)

  return true
}, ioTags.get('write'))

/**
 * The $writeJson function writes a object (as JSON) to the specified path and
 * returns true in AsyncResult.
 */
export const $writeJson = $safe(async function* (path: string, data: JsonValue, create = true) {
  const file = Bun.file(path)
  const exists = yield* $exists(path, 'file')

  if (!(exists || create)) {
    yield* err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  if (!file.type.includes('application/json')) {
    yield* err(
      ioTags.get('invalid-mime'),
      `file: ${path} file type: ${file.type} cannot be read with this method`
    )
  }

  const stringified = JSON.stringify(data)

  await Bun.write(path, stringified)

  return true
}, ioTags.get('write-json'))
