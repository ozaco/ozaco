import { $fn, err } from '../../results'

import { ioTags } from '../tag'

/**
 * The $read function reads a file from the specified path and
 * returns its contents as a ArrayBuffer in AsyncResult.
 */
export const $read = $fn(async (path: string) => {
  const file = Bun.file(path)
  const exists = await file.exists()

  if (!exists) {
    return err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  return await file.arrayBuffer()
}, ioTags.get('read'))

/**
 * The $readJson function reads a file from the specified path and
 * returns its contents as a object in AsyncResult.
 */
export const $readJson = $fn(async <T>(path: string) => {
  const file = Bun.file(path)
  const exists = await file.exists()

  if (!exists) {
    return err(ioTags.get('not-found'), `file: ${path} not found`)
  }

  if (!file.type.includes('application/json')) {
    return err(
      ioTags.get('invalid-mime'),
      `file: ${path} file type: ${file.type} cannot be read with this method`
    )
  }

  return (await file.json()) as T
}, ioTags.get('read-json'))
