import { CH_SLASH, POSIX_SEP, WIN_SEP } from '../const'
import { hasDriveLetter, isUrl, isWindows, isWindowsPath } from './is'

export const toUniversal = (path?: string): string => {
  if (!path) return ''
  if (path.indexOf(WIN_SEP) === -1) return path
  return path.replaceAll(WIN_SEP, POSIX_SEP)
}

export const toNative = (path?: string, forceWindows = false): string => {
  if (!path) return ''
  if (!(forceWindows || isWindows())) return path
  if (path.indexOf(POSIX_SEP) === -1) return path
  return path.replaceAll(POSIX_SEP, WIN_SEP)
}

export const normalizePosix = (path?: string): string => {
  if (!path || path.length === 0) return '.'

  const isAbsolute = path.charCodeAt(0) === CH_SLASH

  // Fast path: no '.', '..', or '//' → already clean
  if (path.indexOf('..') === -1 && path.indexOf('//') === -1) {
    const hasDot = path.indexOf('/./') !== -1 || path === '.' || path.endsWith('/.')
    if (!hasDot) {
      if (path.length > 1 && path.charCodeAt(path.length - 1) === CH_SLASH) {
        return path.slice(0, path.length - 1)
      }
      return path
    }
  }

  const parts = path.split(POSIX_SEP)
  const result: string[] = []

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') result.pop()
      else if (!isAbsolute) result.push('..')
    } else {
      result.push(part)
    }
  }

  const normalized = result.join(POSIX_SEP)
  if (isAbsolute) return POSIX_SEP + normalized
  return normalized || '.'
}

export const normalize = (path?: string, preserveUrl = false): string => {
  if (!path || path.length === 0) return '.'

  if (preserveUrl && isUrl(path)) {
    try {
      const url = new URL(path)
      url.pathname = normalizePosix(url.pathname)
      return url.href
    } catch {
      return path
    }
  }

  const useWindows = isWindowsPath(path)
  const universal = toUniversal(path)

  let prefix = ''
  let workPath = universal

  if (hasDriveLetter(universal)) {
    prefix = universal.slice(0, 2)
    workPath = universal.length > 2 ? universal.slice(2) : POSIX_SEP
  }

  const result = prefix + normalizePosix(workPath)
  return useWindows ? toNative(result, true) : result
}

export const dirnamePosix = (path?: string): string => {
  if (!path || path.length === 0) return '.'

  const isAbsolute = path.charCodeAt(0) === CH_SLASH

  // Strip trailing slashes
  let end = path.length
  while (end > 0 && path.charCodeAt(end - 1) === CH_SLASH) end--

  // Strip last segment (basename)
  while (end > 0 && path.charCodeAt(end - 1) !== CH_SLASH) end--

  // Strip trailing slashes of the dirname
  while (end > 0 && path.charCodeAt(end - 1) === CH_SLASH) end--

  if (end === 0) return isAbsolute ? POSIX_SEP : '.'
  return path.slice(0, end)
}
