/** A JSON object (arrays are not). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The type a schema declares (a nullable union's non-null one), else what its shape implies. */
export const typeOf = (schema: Record<string, unknown>): string | null => {
  const type = schema['type']

  if (typeof type === 'string') {
    return type
  }

  if (Array.isArray(type)) {
    return (type.find(entry => entry !== 'null') as string | undefined) ?? null
  }

  if ('properties' in schema) {
    return 'object'
  }

  if ('items' in schema) {
    return 'array'
  }

  return null
}
