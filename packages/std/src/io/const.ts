// TODO: add deno support

export const STATS = Symbol.for('std:io:stats')
export const HANDLE = Symbol.for('std:io:handle')
export const FILE = Symbol.for('std:io:file')

import type { BlobType } from 'std:shared'

export const POSIX_SEP = '/'
export const WIN_SEP = '\\'
export const URL_PROTOCOLS = [
  'http:',
  'https:',
  'file:',
  'ftp:',
  'ws:',
  'wss:',
]

export enum PathType {
  url = 'url',
  file = 'file',
  ftp = 'ftp',
  ws = 'ws',
  wss = 'wss',

  path = 'path',
}

export enum Runtime {
  browser = 'browser',
  node = 'node',
  bun = 'bun',
  unknown = 'unknown',
}

export enum IOErrors {
  stats = 'io.stats.async',
  statsSync = 'io.stats.sync',
  handle = 'io.handle',
  open = 'io.open',
  read = 'io.open.read',

  // errors
  unsupported = 'unsupported',
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
