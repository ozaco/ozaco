import { operation } from 'std:effect'

/**
 * Pure POSIX path helpers for the web IO impl. Path manipulation is not filesystem access, so these
 * work in the browser (unlike the other web fs actions) — they just assume `/` separators.
 */
const normalize = (path: string): string => {
  const absolute = path.startsWith('/')
  const out: string[] = []

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (out.length > 0 && out.at(-1) !== '..') {
        out.pop()
      } else if (!absolute) {
        out.push('..')
      }
      continue
    }
    out.push(segment)
  }

  const body = out.join('/')
  return absolute ? `/${body}` : body || '.'
}

const dirname = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  if (index === -1) {
    return '.'
  }
  return index === 0 ? '/' : trimmed.slice(0, index)
}

const basename = (path: string, suffix?: string): string => {
  const trimmed = path.replace(/\/+$/u, '')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return suffix && base !== suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base
}

const extname = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

/** Pure POSIX path actions for the web IO impl. */
export const webPath = {
  join: operation(function* (...segments: string[]) {
    const joined = segments.filter(segment => segment.length > 0).join('/')
    return joined ? normalize(joined) : '.'
  }),
  dirname: operation(function* (path: string) {
    return dirname(path)
  }),
  basename: operation(function* (path: string, suffix?: string) {
    return basename(path, suffix)
  }),
  extname: operation(function* (path: string) {
    return extname(path)
  }),
  isAbsolute: operation(function* (path: string) {
    return path.startsWith('/')
  }),
}
