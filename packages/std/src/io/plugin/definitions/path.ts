import { createDefinition } from 'std:plugin'

import { CH_SLASH, PathType, POSIX_SEP, Runtime } from '../../const'
import type { Impl } from '../../types'
import {
  detectRuntime,
  dirnamePosix,
  hasDriveLetter,
  isUrl,
  isWindowsPath,
  normalize,
  normalizePosix,
  toNative,
  toUniversal,
} from '../../utils'

export const pathDefinition = createDefinition((): Impl.Path => {
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

  const join = (...segments: string[]): string => {
    const len = segments.length
    if (len === 0) return '.'

    // Single pass: filter empties, detect first URL, detect windows, build universal joined string
    let hasWindows = false
    let firstNonEmpty = -1
    let count = 0

    for (let i = 0; i < len; i++) {
      const seg = segments[i]
      if (seg && seg.length > 0) {
        if (firstNonEmpty === -1) firstNonEmpty = i
        count++
      }
    }

    if (count === 0) return '.'

    const first = segments[firstNonEmpty]

    if (isUrl(first)) {
      try {
        const url = new URL(first)
        let rest = ''
        for (let i = firstNonEmpty + 1; i < len; i++) {
          const s = segments[i] ?? ''
          if (s.length === 0) continue
          if (rest.length > 0) rest += POSIX_SEP
          rest += toUniversal(s)
        }
        url.pathname = normalizePosix(`${url.pathname}${POSIX_SEP}${rest}`)
        return url.href
      } catch {
        // fall through to path-based join
      }
    }

    // Build joined string + detect windows in one pass
    let joined = ''
    for (let i = 0; i < len; i++) {
      const s = segments[i] ?? ''
      if (s.length === 0) continue
      if (!hasWindows && isWindowsPath(s)) hasWindows = true
      if (joined.length > 0) joined += POSIX_SEP
      joined += toUniversal(s)
    }

    const normalized = normalize(joined)
    return hasWindows ? toNative(normalized, true) : normalized
  }

  const resolve = (...segments: string[]): string => {
    let resolved = ''
    let hasWindows = false

    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i]
      if (!segment || segment.length === 0) continue

      if (isUrl(segment)) {
        if (resolved.length === 0) return normalize(segment, true)
        try {
          const url = new URL(segment)
          url.pathname = normalizePosix(`${url.pathname}${POSIX_SEP}${resolved}`)
          return url.href
        } catch {
          continue
        }
      }

      if (isWindowsPath(segment)) hasWindows = true

      const universal = toUniversal(segment)
      resolved = resolved.length > 0 ? `${universal}${POSIX_SEP}${resolved}` : universal

      // If we hit an absolute path, we're done
      if (universal.charCodeAt(0) === CH_SLASH || hasDriveLetter(segment)) {
        const normalized = normalize(resolved)
        return hasWindows ? toNative(normalized, true) : normalized
      }
    }

    // No absolute path found — resolve against cwd
    const currentDir = cwd()

    if (isUrl(currentDir)) {
      try {
        const url = new URL(currentDir)
        url.pathname = normalizePosix(`${url.pathname}${POSIX_SEP}${resolved}`)
        return url.href
      } catch {
        return normalize(resolved)
      }
    }

    const full = `${toUniversal(currentDir)}${POSIX_SEP}${resolved}`
    const normalized = normalize(full)
    return hasWindows || isWindowsPath(currentDir) ? toNative(normalized, true) : normalized
  }

  const basename = (inputPath: string, suffix?: string): string => {
    if (inputPath.length === 0) return ''

    let workPath = inputPath

    if (isUrl(inputPath)) {
      try {
        workPath = new URL(inputPath).pathname
      } catch {
        return ''
      }
    } else {
      const hasBackslash = workPath.indexOf('\\') !== -1
      if (hasBackslash) workPath = toUniversal(inputPath)
    }

    // Strip trailing slashes
    let end = workPath.length
    while (end > 0 && workPath.charCodeAt(end - 1) === CH_SLASH) end--

    // Find start of basename
    let start = end
    while (start > 0 && workPath.charCodeAt(start - 1) !== CH_SLASH) start--

    if (start === end) return ''

    if (!suffix) return workPath.slice(start, end)

    const baseLen = end - start
    const suffLen = suffix.length
    if (suffLen >= baseLen) return workPath.slice(start, end)

    // Check suffix match via charCodeAt to avoid slice allocation on mismatch
    let match = true
    for (let i = 0; i < suffLen; i++) {
      if (workPath.charCodeAt(end - suffLen + i) !== suffix.charCodeAt(i)) {
        match = false
        break
      }
    }

    return match ? workPath.slice(start, end - suffLen) : workPath.slice(start, end)
  }

  const dirname = (inputPath: string): string => {
    if (inputPath.length === 0) return '.'

    if (isUrl(inputPath)) {
      try {
        const url = new URL(inputPath)
        url.pathname = dirnamePosix(url.pathname)
        return url.href
      } catch {
        return '.'
      }
    }

    const useWindows = isWindowsPath(inputPath)
    const workPath = toUniversal(inputPath)

    let prefix = ''
    let pathPart = workPath

    if (hasDriveLetter(workPath)) {
      prefix = workPath.slice(0, 2)
      pathPart = workPath.length > 2 ? workPath.slice(2) : POSIX_SEP
    }

    const result = prefix + dirnamePosix(pathPart)
    return useWindows ? toNative(result, true) : result
  }

  const extname = (inputPath: string): string | null => {
    const base = basename(inputPath)
    if (!base) return null

    const dotIndex = base.lastIndexOf('.')
    if (dotIndex <= 0) return null

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
    const fromNormalized = normalizePosix(toUniversal(resolve(from)))
    const toNormalized = normalizePosix(toUniversal(resolve(to)))

    if (fromNormalized === toNormalized) return '.'

    const fromParts = fromNormalized.split(POSIX_SEP).filter(Boolean)
    const toParts = toNormalized.split(POSIX_SEP).filter(Boolean)

    let common = 0
    const limit = Math.min(fromParts.length, toParts.length)
    while (common < limit && fromParts[common] === toParts[common]) common++

    const ups = fromParts.length - common

    // Build result without intermediate Array(n).fill + spread
    const parts: string[] = []
    for (let i = 0; i < ups; i++) parts.push('..')
    for (let i = common; i < toParts.length; i++) parts.push(toParts[i] ?? '')

    return parts.length > 0 ? parts.join(POSIX_SEP) : '.'
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
