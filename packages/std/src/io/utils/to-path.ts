import type { PathLike } from '../types/common'

const fileUrlToPath = (url: string): string => {
  const stripped = url.replace(/^file:\/\/\//, '/')
  return decodeURIComponent(stripped)
}

export const toPath = (pathOrUrl: PathLike): string => {
  if (typeof pathOrUrl === 'string') {
    if (!pathOrUrl.startsWith('file:')) {
      return pathOrUrl
    }
    return fileUrlToPath(pathOrUrl)
  }
  return fileUrlToPath(pathOrUrl.href)
}
