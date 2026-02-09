// TODO: add deno support
export const STATS = Symbol.for('std:io:stats')
export const HANDLE = Symbol.for('std:io:handle')
export const FILE = Symbol.for('std:io:file')

export const POSIX_SEP = '/'
export const WIN_SEP = '\\'

export const CH_SLASH = 47 // '/'
export const CH_COLON = 58 // ':'
export const URL_PROTOCOLS = [
  'http:',
  'https:',
  'file:',
  'ftp:',
  'ws:',
  'wss:',
]

export enum Flags {
  none = 0,

  read = 1 << 0,
  append = 1 << 1,
  write = 1 << 2,

  truncate = 1 << 3,
  create = 1 << 4,
  exclude = 1 << 5,
  sync = 1 << 6,

  Moderator = Flags.read | Flags.write | Flags.create,
  Recreate = Flags.Moderator | Flags.truncate,
}

export enum PathType {
  url,
  file,
  ftp,
  ws,
  wss,

  path,
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
  unsupported = 'io.unsupported',
  missingFlag = 'io.missing-flag',
  create = 'io.create',
}
