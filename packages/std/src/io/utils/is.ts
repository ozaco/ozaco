import { URL_PROTOCOLS, WIN_SEP } from '../const'

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
