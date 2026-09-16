const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/**
 * The names of the contexts marked with `markContextAsSnapshot`: a child scope takes a COPY of
 * their value when it is created (a plain object is spread, anything else is captured as-is)
 * instead of reading the parent's through the prototype chain — so a later `set` in the parent,
 * or a mutation on either side, stays on its side. Every other context is inherited live.
 */
export const snapshots = new Set<string>()

/** The value a child scope starts with for a snapshot context. */
export const snapshotOf = (value: unknown): unknown => (isPlainObject(value) ? { ...value } : value)
