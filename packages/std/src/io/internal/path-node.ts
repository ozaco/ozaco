import { basename, dirname, extname, isAbsolute, join } from 'node:path'

/** Platform-aware path actions (via `node:path`), shared by the Bun and Node IO impls. */
export const nodePath = {
  *join(...segments: string[]) {
    return join(...segments)
  },
  *dirname(path: string) {
    return dirname(path)
  },
  *basename(path: string, suffix?: string) {
    return basename(path, suffix)
  },
  *extname(path: string) {
    return extname(path)
  },
  *isAbsolute(path: string) {
    return isAbsolute(path)
  },
}
