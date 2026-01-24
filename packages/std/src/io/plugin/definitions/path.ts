import { createDefinition } from 'std:plugin'

import { PathType, POSIX_SEP, Runtime } from '../../const'
import type { Impl } from '../../types'
import {
  detectRuntime,
  dirnamePosix,
  isUrl,
  isWindowsPath,
  normalize,
  normalizePosix,
  toNative,
  toUniversal,
} from '../../utils'

export const path = createDefinition((): Impl.Path => {
  const runtime = detectRuntime()

  const cwd = (): string => {
    switch (runtime) {
      case Runtime.bun:
      case Runtime.node:
        return globalThis.process?.cwd?.() ?? POSIX_SEP
      case Runtime.browser:
        if (typeof location !== 'undefined') {
          return location.href.replace(/\/[^/]*$/, '') || location.origin
        }
        return POSIX_SEP
      default:
        return POSIX_SEP
    }
  }

  // FIX: cannot join cwd with file urls
  const join = (...segments: string[]): string => {
    if (segments.length === 0) return '.'

    const filtered = segments.filter(s => s.length > 0)
    if (filtered.length === 0) return '.'

    const first = filtered[0]

    if (isUrl(first)) {
      try {
        const url = new URL(first)
        const restPath = filtered.slice(1).map(toUniversal).join(POSIX_SEP)
        url.pathname = normalizePosix(url.pathname + POSIX_SEP + restPath)
        return url.href
      } catch {
        return normalize(filtered.join(POSIX_SEP))
      }
    }

    const useWindowsSep = filtered.some(isWindowsPath)
    const universal = filtered.map(toUniversal).join(POSIX_SEP)
    const normalized = normalize(universal)

    return useWindowsSep ? toNative(normalized, true) : normalized
  }

  const resolve = (...segments: string[]): string => {
    let resolved = ''
    let hasWindowsPath = false

    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i]
      if (!segment || segment.length === 0) continue

      if (isUrl(segment)) {
        if (resolved.length === 0) {
          return normalize(segment, true)
        }
        try {
          const url = new URL(segment)
          url.pathname = normalizePosix(url.pathname + POSIX_SEP + resolved)
          return url.href
        } catch {
          continue
        }
      }

      if (isWindowsPath(segment)) {
        hasWindowsPath = true
      }

      const universal = toUniversal(segment)
      resolved = resolved.length > 0 ? `${universal}${POSIX_SEP}${resolved}` : universal

      if (universal.charCodeAt(0) === 47 || /^[a-zA-Z]:/.test(segment)) {
        const normalized = normalize(resolved)
        return hasWindowsPath ? toNative(normalized, true) : normalized
      }
    }

    const currentDir = cwd()

    if (isUrl(currentDir)) {
      try {
        const url = new URL(currentDir)
        url.pathname = normalizePosix(url.pathname + POSIX_SEP + resolved)
        return url.href
      } catch {
        return normalize(resolved)
      }
    }

    const full = `${toUniversal(currentDir)}${POSIX_SEP}${resolved}`
    const normalized = normalize(full)
    return hasWindowsPath || isWindowsPath(currentDir) ? toNative(normalized, true) : normalized
  }

  const basename = (inputPath: string, suffix?: string): string => {
    if (inputPath.length === 0) return ''

    let workPath = inputPath

    if (isUrl(inputPath)) {
      try {
        const url = new URL(inputPath)
        workPath = url.pathname
      } catch {
        return ''
      }
    }

    workPath = toUniversal(workPath)

    let end = workPath.length
    while (end > 0 && workPath.charCodeAt(end - 1) === 47) {
      end--
    }

    let start = end
    while (start > 0 && workPath.charCodeAt(start - 1) !== 47) {
      start--
    }

    let base = workPath.slice(start, end)

    if (suffix && base.endsWith(suffix)) {
      base = base.slice(0, base.length - suffix.length)
    }

    return base
  }

  const dirname = (inputPath: string): string => {
    if (inputPath.length === 0) return '.'

    if (isUrl(inputPath)) {
      try {
        const url = new URL(inputPath)
        const pathDir = dirnamePosix(url.pathname)
        url.pathname = pathDir
        return url.href
      } catch {
        return '.'
      }
    }

    const hadWindowsSep = isWindowsPath(inputPath)
    const workPath = toUniversal(inputPath)

    let prefix = ''
    let pathPart = workPath

    const driveMatch = workPath.match(/^([a-zA-Z]:)(.*)$/)
    if (driveMatch) {
      prefix = driveMatch[1] || ''
      pathPart = driveMatch[2] || POSIX_SEP
    }

    const result = prefix + dirnamePosix(pathPart)
    return hadWindowsSep ? toNative(result, true) : result
  }

  const extname = (inputPath: string): string | null => {
    const base = basename(inputPath)
    if (!base || base.startsWith('.')) {
      const dotIndex = base.indexOf('.', 1)
      if (dotIndex === -1) return null
      return base.slice(dotIndex)
    }

    const dotIndex = base.lastIndexOf('.')
    if (dotIndex === -1 || dotIndex === 0) return null

    return base.slice(dotIndex)
  }

  const type = (inputPath: string): PathType => {
    if (inputPath.startsWith('http:') || inputPath.startsWith('https:')) return PathType.url
    if (inputPath.startsWith('file:')) return PathType.file
    if (inputPath.startsWith('ftp:')) return PathType.ftp
    if (inputPath.startsWith('ws:')) return PathType.ws
    if (inputPath.startsWith('wss:')) return PathType.wss
    return PathType.path
  }

  const relative = (from: string, to: string): string => {
    const fromResolved = normalizePosix(toUniversal(resolve(from)))
    const toResolved = normalizePosix(toUniversal(resolve(to)))

    if (fromResolved === toResolved) return '.'

    const fromParts = fromResolved.split(POSIX_SEP).filter(Boolean)
    const toParts = toResolved.split(POSIX_SEP).filter(Boolean)

    let commonLength = 0
    const minLength = Math.min(fromParts.length, toParts.length)

    for (let i = 0; i < minLength; i++) {
      if (fromParts[i] === toParts[i]) {
        commonLength++
      } else {
        break
      }
    }

    const upCount = fromParts.length - commonLength
    const downParts = toParts.slice(commonLength)

    const result = [
      ...Array(upCount).fill('..'),
      ...downParts,
    ].join(POSIX_SEP)
    return result || '.'
  }

  return {
    join,
    resolve,
    basename,
    dirname,
    extname,
    type,
    relative,
    cwd,
  }
}).key('path')
