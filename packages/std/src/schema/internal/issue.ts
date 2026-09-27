import type { StandardSchemaV1 } from 'std:shared'

/** `a.b.0: message` — one issue as a cause line (path-less issues are the bare message). */
export const describeIssue = (issue: StandardSchemaV1.Issue): string => {
  const path = (issue.path ?? [])
    .map(segment =>
      typeof segment === 'object' ? String((segment as { key: PropertyKey }).key) : String(segment),
    )
    .join('.')

  return path === '' ? issue.message : `${path}: ${issue.message}`
}
