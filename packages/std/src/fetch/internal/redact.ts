// one lowercased set per list, built on first use
const sets = new WeakMap<readonly string[], ReadonlySet<string>>()

/** A query key as the server reads it (`+` is a space, percent-decoded), lowercased. */
export const keyOf = (raw: string): string => {
  const spaced = raw.replaceAll('+', ' ')

  try {
    return decodeURIComponent(spaced).toLowerCase()
  } catch {
    return spaced.toLowerCase()
  }
}

/** `keys` as the lowercased set a lookup reads. */
export const setOf = (keys: readonly string[]): ReadonlySet<string> => {
  let set = sets.get(keys)

  if (!set) {
    set = new Set(keys.map(key => key.toLowerCase()))
    sets.set(keys, set)
  }

  return set
}
