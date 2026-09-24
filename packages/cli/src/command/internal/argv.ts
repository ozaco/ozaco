/** The single place the package reads `process.argv` (everything else receives argv explicitly). */
export const processArgv = (): string[] =>
  typeof process === 'undefined' ? [] : process.argv.slice(2)

/** The working directory, read when a command runs (`'.'` on hosts without `process`). */
export const processCwd = (): string =>
  typeof process === 'undefined' || typeof process.cwd !== 'function' ? '.' : process.cwd()

/** Whether any of `flags` appears in `argv` BEFORE a `--` separator (tokens after it are data). */
export const hasFlag = (argv: readonly string[], flags: readonly string[]): boolean => {
  const end = argv.indexOf('--')

  return (end === -1 ? argv : argv.slice(0, end)).some(token => flags.includes(token))
}
