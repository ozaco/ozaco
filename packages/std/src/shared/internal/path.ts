/** A dotted key's segments (`a.b.c` → `a`, `b`, `c`; empty ones dropped). */
export const segments = (path: string): string[] => path.split('.').filter(Boolean)
