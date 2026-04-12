export const IO_VERSION = '0.0.1'

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
  enureDir = 'io:ensure-dir',
  enureFile = 'io:ensure-file',
  emptyDir = 'io:empty-dir',
  walk = 'io:walk',
  stream = 'io:stream',
}
