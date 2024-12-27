import { $fn, err } from '../../results'
import type { JsonValue } from '../../shared'

import { ioTags } from '../tag'

/**
 * The $write function writes a file to the specified path and
 * returns true in AsyncResult.
 */
export const $write = $fn(async (path: string, data: string | ArrayBuffer, create = true) => {
  const file = Bun.file(path)
  const exists = await file.exists()

  if (!(exists || create)) {
    return err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  await Bun.write(path, data)

  return true
}, ioTags.get('write'))

/**
 * The $writeJson function writes a object (as JSON) to the specified path and
 * returns true in AsyncResult.
 */
export const $writeJson = $fn(async (path: string, data: JsonValue, create = true) => {
  const file = Bun.file(path)
  const exists = await file.exists()

  if (!(exists || create)) {
    return err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  if (!file.type.includes('application/json')) {
    return err(
      ioTags.get('invalid-mime'),
      `file: ${path} file type: ${file.type} cannot be read with this method`
    )
  }

  const stringified = JSON.stringify(data)

  await Bun.write(path, stringified)

  return true
}, ioTags.get('write-json'))
