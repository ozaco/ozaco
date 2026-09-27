/**
 * A `util.parseArgs` rejection (its `ERR_PARSE_ARGS_*` code) and its message: the first sentence
 * of the parser's text (`Unknown option '--bogus'`), without the error name or the
 * `-- "--bogus"` hint that follows.
 */
export const parseArgsFault = (value: unknown): false | string => {
  const { code, message } = (value ?? {}) as { code?: unknown; message?: unknown }

  if (typeof code !== 'string' || !code.startsWith('ERR_PARSE_ARGS_')) {
    return false
  }

  const text = typeof message === 'string' ? message : ''
  const [first] = text.split(/\.\s/u)

  return (first ?? text).replace(/\.$/u, '') || code
}
