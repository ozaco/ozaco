import { formatFailure, isFailure } from 'std:result'

/** A cause on the causes line: a string as is, a nested failure inline as `(<formatFailure>)`. */
export const causeText = (cause: unknown): string =>
  isFailure(cause) ? `(${formatFailure(cause)})` : String(cause)
