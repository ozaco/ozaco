/** The single place the package reads `process.argv` (everything else receives argv explicitly). */
export const processArgv = (): string[] =>
  typeof process === 'undefined' ? [] : process.argv.slice(2)
