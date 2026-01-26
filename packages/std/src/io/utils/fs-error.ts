import type { BlobType } from 'std:shared'

export class FSError extends Error {
  code?: string

  constructor(err: Error) {
    super(err.message)

    for (const key of Object.keys(err)) {
      ;(this as BlobType)[key] = (err as BlobType)[key]
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, Error)
    }
  }
}
