import { operation } from 'std:effect'

import { basename, dirname, extname, isAbsolute, join } from 'node:path'

/** Platform-aware path actions (via `node:path`), shared by the Bun and Node IO impls. */
export const nodePath = {
  join: operation(function* (...segments: string[]) {
    return join(...segments)
  }),
  dirname: operation(function* (path: string) {
    return dirname(path)
  }),
  basename: operation(function* (path: string, suffix?: string) {
    return basename(path, suffix)
  }),
  extname: operation(function* (path: string) {
    return extname(path)
  }),
  isAbsolute: operation(function* (path: string) {
    return isAbsolute(path)
  }),
}
