// oxlint-disable typescript/prefer-literal-enum-member
export const IO_VERSION = '0.0.1'

export enum IO_FLAGS {
  NONE = 0,
  FOLLOW_SYMLINKS = 1 << 2,
  FILES = 1 << 3,
  DIRS = 1 << 4,
  APPEND = 1 << 5,
  EXCLUSIVE = 1 << 6,
}

export enum IO_TAGS {
  read = 'io:read',
  readText = 'io:read-text',
  write = 'io:write',
  append = 'io:append',
  copy = 'io:copy',
  rename = 'io:rename',
  rm = 'io:rm',
  exists = 'io:exists',
  stat = 'io:stat',
  lstat = 'io:lstat',
  readdir = 'io:readdir',
  ensureDir = 'io:ensure-dir',
  ensureFile = 'io:ensure-file',
  emptyDir = 'io:empty-dir',
  walk = 'io:walk',
  stream = 'io:stream',
  writeStream = 'io:write-stream',
}
