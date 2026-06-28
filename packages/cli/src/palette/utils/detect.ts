import type { DetectInput, Env } from '../types'

export const detectColor = ({ env, isTTY }: DetectInput): boolean => {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    return false
  }

  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
  }

  if (env.TERM === 'dumb') {
    return false
  }

  return isTTY
}

export const detectUnicode = ({ env }: { env: Env }): boolean => {
  if (process.platform === 'win32') {
    return Boolean(
      env.WT_SESSION ||
      env.WT_PROFILE_ID ||
      env.TERM_PROGRAM === 'vscode' ||
      env.ConEmuTask ||
      env.TERM === 'xterm-256color',
    )
  }

  const locale = `${env.LC_ALL ?? ''} ${env.LC_CTYPE ?? ''} ${env.LANG ?? ''}`
  if (/UTF-?8/iu.test(locale)) {
    return true
  }

  return env.TERM !== undefined && env.TERM !== 'linux'
}
