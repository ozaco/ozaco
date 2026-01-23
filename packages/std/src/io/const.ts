// TODO: add deno support

export const STATS = Symbol.for('std:io:stats')
export const HANDLE = Symbol.for('std:io:handle')
export const FILE = Symbol.for('std:io:file')

import { constants as FSConst } from 'node:fs'
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
  read = 'io.read',
  write = 'io.write',
  // errors
  unsupported = 'unsupported',
}

export const FSFlags = {
  APPEND: FSConst.O_APPEND | FSConst.O_RDWR,
  READ: FSConst.O_RDONLY,
  WRITE: FSConst.O_RDWR,
} as const

export type FSFlags = (typeof FSFlags)[keyof typeof FSFlags]

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
