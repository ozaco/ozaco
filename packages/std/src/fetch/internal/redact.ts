/** A query key as the server reads it (`+` is a space, percent-decoded), lowercased. */
export const keyOf = (raw: string): string => {
  const spaced = raw.replaceAll('+', ' ')

  try {
    return decodeURIComponent(spaced).toLowerCase()
  } catch {
    return spaced.toLowerCase()
  }
}
