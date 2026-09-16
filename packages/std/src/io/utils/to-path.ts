import type { IODef } from '../types/io'

const fileUrlToPath = (url: string): string => {
  const stripped = url.replace(/^file:\/\/\//u, '/')
  return decodeURIComponent(stripped)
}

export const toPath = (pathOrUrl: IODef.PathLike): string => {
  if (typeof pathOrUrl === 'string') {
    if (!pathOrUrl.startsWith('file:')) {
      return pathOrUrl
    }
    return fileUrlToPath(pathOrUrl)
  }
  return fileUrlToPath(pathOrUrl.href)
}
