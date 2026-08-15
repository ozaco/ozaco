import { operation, until } from 'std:effect'
import { fail } from 'std:result'
import { isPromise } from 'std:shared'

import { DbErrors } from '../errors'
import type { Doc } from '../types/common'
import type { ColumnSpec, StandardSchemaV1, TableDef } from '../types/schema'

/** Kind-level type check for one present, non-null value; returns an error description or null. */
const kindError = (column: ColumnSpec, value: unknown): string | null => {
  switch (column.kind) {
    case 'text': {
      return typeof value === 'string' ? null : `"${column.name}" expects a string`
    }
    case 'enum': {
      if (typeof value !== 'string') {
        return `"${column.name}" expects a string`
      }
      return (column.enumValues ?? []).includes(value)
        ? null
        : `"${column.name}" must be one of ${(column.enumValues ?? []).join(', ')}`
    }
    case 'int': {
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : `"${column.name}" expects an integer`
    }
    case 'float': {
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `"${column.name}" expects a finite number`
    }
    case 'boolean': {
      return typeof value === 'boolean' ? null : `"${column.name}" expects a boolean`
    }
    case 'timestamp': {
      return value instanceof Date && !Number.isNaN(value.getTime())
        ? null
        : `"${column.name}" expects a valid Date`
    }
    case 'json': {
      return null
    }
    default: {
      return null
    }
  }
}

/** Run a table's Standard Schema validator (sync or async) over the prepared value. */
const runValidate = operation(function* (schema: StandardSchemaV1, table: string, value: unknown) {
  const verdict = schema['~standard'].validate(value)
  const result = isPromise(verdict) ? yield* until(verdict) : verdict
  if (result.issues) {
    const issues = result.issues.slice(0, 5).map(issue => issue.message)
    return yield* fail(DbErrors.Validation, `value rejected by the "${table}" validator`, ...issues)
  }
  return result.value
})

const objectOf = (table: string, value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * Validate + normalize an insert/replace value: unknown keys are stripped, defaults applied,
 * required columns enforced, kinds checked, optional omissions normalized to `null`, and the
 * table's Standard Schema validator (when declared) run over the result.
 */
export const prepareInsert = operation(function* (def: TableDef, value: unknown) {
  const input = objectOf(def.name, value)
  if (!input) {
    return yield* fail(DbErrors.Validation, `insert into "${def.name}" expects an object`)
  }
  const data: Record<string, unknown> = {}
  const problems: string[] = []
  for (const column of def.columns) {
    let entry = input[column.name]
    if (entry === undefined && column.hasDefault) {
      entry = def.defaults[column.name]?.()
    }
    if (entry === undefined || entry === null) {
      if (!column.optional) {
        problems.push(`missing required column "${column.name}"`)
        continue
      }
      data[column.name] = null
      continue
    }
    const problem = kindError(column, entry)
    if (problem) {
      problems.push(problem)
      continue
    }
    data[column.name] = entry
  }
  if (problems.length > 0) {
    return yield* fail(DbErrors.Validation, `invalid insert into "${def.name}"`, ...problems)
  }
  if (def.validate) {
    return (yield* runValidate(def.validate, def.name, data)) as Doc
  }
  return data as Doc
})

/** Validate a patch: unknown keys stripped, present values kind-checked, `null` only allowed on
 * optional columns. The table validator is NOT applied (it validates whole documents). */
export const preparePatch = operation(function* (def: TableDef, value: unknown) {
  const input = objectOf(def.name, value)
  if (!input) {
    return yield* fail(DbErrors.Validation, `patch of "${def.name}" expects an object`)
  }
  const data: Record<string, unknown> = {}
  const problems: string[] = []
  for (const column of def.columns) {
    const entry = input[column.name]
    if (entry === undefined) {
      continue
    }
    if (entry === null) {
      if (!column.optional) {
        problems.push(`"${column.name}" is required and cannot be null`)
        continue
      }
      data[column.name] = null
      continue
    }
    const problem = kindError(column, entry)
    if (problem) {
      problems.push(problem)
      continue
    }
    data[column.name] = entry
  }
  if (problems.length > 0) {
    return yield* fail(DbErrors.Validation, `invalid patch of "${def.name}"`, ...problems)
  }
  return data as Doc
})
