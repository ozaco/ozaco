export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || String(error).includes('abort'))

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
