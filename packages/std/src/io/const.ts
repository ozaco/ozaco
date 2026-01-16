// TODO: add deno support

import type { BlobType } from 'std:shared'

export enum Runtime {
  browser = 'browser',
  node = 'node',
  bun = 'bun',
  unknown = 'unknown',
}

export enum IOErrors {
  dirExists = 'io.dir.exists',
  dirCreate = 'io.dir.create',
  stats = 'io.stats',
  unexpectedRuntime = 'io.unexpected-runtime',
  unsupported = 'io.unsupported-operation',
}

export class FSError extends Error {
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
