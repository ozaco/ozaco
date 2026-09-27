const decode = (text: string): string | null => {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

/**
 * `OTEL_RESOURCE_ATTRIBUTES` (`key1=value1,key2=value2`, values percent-encoded) as resource
 * attributes; a malformed member is skipped, never fatal. The kernel lays them UNDER its own
 * node-level resource, so every sink (store, exporters) carries the same set.
 */
export const envResource = (raw: string | undefined): Record<string, string> => {
  const attributes: Record<string, string> = {}

  for (const member of raw?.split(',') ?? []) {
    const at = member.indexOf('=')

    if (at <= 0) {
      continue
    }

    const key = decode(member.slice(0, at).trim())
    const value = decode(member.slice(at + 1).trim())

    if (key && value !== null) {
      attributes[key] = value
    }
  }

  return attributes
}
