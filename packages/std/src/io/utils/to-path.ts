import type { IODef } from '../types/io'

// strips the literal `file:///` only — see `toPath` for what that leaves out
const fileUrlToPath = (url: string): string => {
  const stripped = url.replace(/^file:\/\/\//u, '/')
  return decodeURIComponent(stripped)
}

/**
 * Turn a {@link IODef.PathLike} into a plain path string: strings pass through, a `file:///…` URL
 * (string or `URL`) loses its scheme and is percent-decoded. Public because it is the one
 * normalization every IO impl applies — a protocol implementation outside this package (a mock, a
 * new platform) needs the same one.
 *
 * POSIX-shaped only: a Windows drive URL keeps its leading slash (`file:///C:/x` → `/C:/x`), and
 * anything that is not the empty-host triple-slash form (`file://host/share`, `file://localhost/x`,
 * `file:/x`) is returned UNCHANGED. Use `node:url`'s `fileURLToPath` when those can occur.
 */
export const toPath = (pathOrUrl: IODef.PathLike): string => {
  if (typeof pathOrUrl === 'string') {
    if (!pathOrUrl.startsWith('file:')) {
      return pathOrUrl
    }
    return fileUrlToPath(pathOrUrl)
  }
  return fileUrlToPath(pathOrUrl.href)
}
