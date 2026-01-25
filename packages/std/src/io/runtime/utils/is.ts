import type { BlobType } from 'std:shared'
import type { BunFile } from 'bun'

export const isBunFile = (file: unknown): file is BunFile => {
  return file instanceof Blob && 'name' in file && (file.name as BlobType)?.length > 0
}
