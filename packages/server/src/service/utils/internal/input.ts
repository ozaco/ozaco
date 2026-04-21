import type { StandardSchemaV1 } from 'std:shared'

export const formatIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  issues.map(i => `At ${i.path?.join('.') || 'root'} : ${i.message}`).join(', ')
