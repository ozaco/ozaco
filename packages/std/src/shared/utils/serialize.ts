import type { AnyType } from '../types/common'

export const serializeError = (error: unknown): string => {
  if (typeof error === 'string') {
    return error
  }

  if (error instanceof Error) {
    // a foreign Error's getters may throw: rendering an error never does
    try {
      const code = (error as AnyType).code

      return code
        ? `${error.name}: ${error.message} (${String(code)})`
        : `${error.name}: ${error.message}`
    } catch {
      return Object.prototype.toString.call(error)
    }
  }

  if (error === null || error === undefined) {
    return String(error)
  }

  if (typeof error === 'object') {
    try {
      return JSON.stringify(error)
    } catch {
      return Object.prototype.toString.call(error)
    }
  }

  return String(error)
}
