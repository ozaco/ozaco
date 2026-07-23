/** SQLite has no boolean/array/object types: booleans → 0/1, plain objects/arrays → JSON text (the
 * driver's storage encoding). */
export const encodeParam = (value: unknown): unknown => {
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  if (value === null || value === undefined || value instanceof Uint8Array) {
    return value ?? null
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return value
}

/** Whether a statement yields rows (SELECT / WITH / PRAGMA / `RETURNING`) — picks `.all()`/`.iterate()`
 * over `.run()`. `PRAGMA table_info(...)` is row-returning and drives SQLite schema introspection. */
export const returnsRows = (sql: string): boolean =>
  /^\s*(select|with|pragma)/iu.test(sql) || /\breturning\b/iu.test(sql)
