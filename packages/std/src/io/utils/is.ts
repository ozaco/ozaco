import { isObject } from 'std:shared'
import { CH_COLON, FILE, HANDLE, STATS, WIN_SEP } from '../const'
import type { Api } from '../types'

export const isStats = (result: unknown): result is Api.Stats => {
  return isObject(result) && result._t === STATS
}

export const isHandle = (result: unknown): result is Api.Handle => {
  return isObject(result) && result._t === HANDLE
}

export const isFile = (result: unknown): result is Api.File => {
  return isObject(result) && result._t === FILE
}

// Platform never changes at runtime — compute once
let _isWindows: boolean | undefined
export const isWindows = (): boolean => {
  if (_isWindows !== undefined) return _isWindows
  if (typeof globalThis.process !== 'undefined' && globalThis.process.platform) {
    _isWindows = globalThis.process.platform === 'win32'
  } else if (typeof navigator !== 'undefined' && navigator.userAgent) {
    _isWindows = navigator.userAgent.includes('Windows')
  } else {
    _isWindows = false
  }
  return _isWindows
}

const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)

export const isUrl = (path?: string): path is string => {
  if (!path) return false
  const colonIdx = path.indexOf(':', 0)
  if (colonIdx < 2 || colonIdx > 5) return false
  const prefix = path.slice(0, colonIdx + 1)
  return (
    prefix === 'http:' ||
    prefix === 'https:' ||
    prefix === 'file:' ||
    prefix === 'ftp:' ||
    prefix === 'ws:' ||
    prefix === 'wss:'
  )
}

export const isWindowsPath = (path?: string): boolean => {
  if (!path) return false
  if (path.length >= 2 && path.charCodeAt(1) === CH_COLON && isAlpha(path.charCodeAt(0))) return true
  return path.indexOf(WIN_SEP) !== -1
}

export const hasDriveLetter = (path: string): boolean => {
  if (path.length < 2 || path.charCodeAt(1) !== CH_COLON) return false
  return isAlpha(path.charCodeAt(0))
}
