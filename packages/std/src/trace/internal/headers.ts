/** HTTP optional whitespace (space / tab) around a field value or list member. */
export const trimOws = (text: string): string => text.replaceAll(/^[\t ]+|[\t ]+$/gu, '')

/** The one value of a header: several `traceparent` fields make it invalid. */
export const single = (value: string | readonly string[] | null | undefined): string | null => {
  if (typeof value === 'string') {
    return value
  }

  return Array.isArray(value) && value.length === 1 && typeof value[0] === 'string'
    ? value[0]
    : null
}

/** Several `tracestate` fields are one list (RFC 9110 field order). */
export const joined = (value: string | readonly string[] | null | undefined): string | null => {
  if (typeof value === 'string') {
    return value
  }

  return Array.isArray(value) ? value.join(',') : null
}
