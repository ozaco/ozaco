import { POSIX_SEP, Runtime, URL_PROTOCOLS, WIN_SEP } from './const'

export const detectRuntime = (): Runtime => {
  if (typeof globalThis.process !== 'undefined' && globalThis.process.versions) {
    if ((globalThis.process.versions as Record<string, unknown>).bun) {
      return Runtime.bun
    }
    if (globalThis.process.versions.node) {
      return Runtime.node
    }
  }
  if (typeof window !== 'undefined' || typeof self !== 'undefined') {
    return Runtime.browser
  }
  return Runtime.unknown
}

export const isWindows = (): boolean => {
  if (typeof globalThis.process !== 'undefined' && globalThis.process.platform) {
    return globalThis.process.platform === 'win32'
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    return navigator.userAgent.includes('Windows')
  }
  return false
}

export const isUrl = (path?: string): path is string => {
  return !!path && URL_PROTOCOLS.some(protocol => path.startsWith(protocol))
}

export const isWindowsPath = (path?: string): boolean => {
  return !!path && (/^[a-zA-Z]:/.test(path) || path.includes(WIN_SEP))
}

export const toUniversal = (path?: string): string => {
  return path?.replace(/\\/g, POSIX_SEP) ?? ''
}

export const toNative = (rawPath?: string, forceWindows = false): string => {
  const path = rawPath ?? ''

  if (forceWindows || isWindows()) {
    return path.replace(/\//g, WIN_SEP)
  }

  return path
}

export const normalizePosix = (path?: string): string => {
  if (!path || path.length === 0) return '.'

  const isAbsolute = path.charCodeAt(0) === 47
  const segments = path.split(POSIX_SEP)
  const result: string[] = []

  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') {
        result.pop()
      } else if (!isAbsolute) {
        result.push('..')
      }
    } else {
      result.push(segment)
    }
  }

  const normalized = result.join(POSIX_SEP)
  if (isAbsolute) {
    return POSIX_SEP + normalized
  }
  return normalized || '.'
}

export const normalize = (path?: string, preserveUrl = false): string => {
  if (!path || path.length === 0) return '.'

  if (preserveUrl && isUrl(path)) {
    try {
      const url = new URL(path)
      const normalizedPath = normalizePosix(url.pathname)
      url.pathname = normalizedPath
      return url.href
    } catch {
      return path
    }
  }

  const hadWindowsSep = isWindowsPath(path)
  const universal = toUniversal(path)

  let prefix = ''
  let workPath = universal

  const driveMatch = universal.match(/^([a-zA-Z]:)(.*)$/)
  if (driveMatch) {
    prefix = driveMatch[1] ?? ''
    workPath = driveMatch[2] || POSIX_SEP
  }

  const normalized = normalizePosix(workPath)
  const result = prefix + normalized

  return hadWindowsSep ? toNative(result, true) : result
}

export const dirnamePosix = (path?: string): string => {
  if (!path || path.length === 0) return '.'

  const isAbsolute = path.charCodeAt(0) === 47
  let end = path.length

  while (end > 0 && path.charCodeAt(end - 1) === 47) {
    end--
  }

  while (end > 0 && path.charCodeAt(end - 1) !== 47) {
    end--
  }

  while (end > 0 && path.charCodeAt(end - 1) === 47) {
    end--
  }

  if (end === 0) {
    return isAbsolute ? POSIX_SEP : '.'
  }

  return path.slice(0, end)
}
