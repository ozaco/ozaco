const p = process || {},
  argv = p.argv || [],
  env = p.env || {}

export const isColorSupported =
  !(!!env.NO_COLOR || argv.includes('--no-color')) &&
  (!!env.FORCE_COLOR ||
    argv.includes('--color') ||
    p.platform === 'win32' ||
    (p.stdout?.isTTY && env.TERM !== 'dumb') ||
    !!env.CI)
