// oxlint-disable import/exports-last
import { until } from 'std:effect'
import { fail } from 'std:result'
import type { StandardSchemaV1 } from 'std:shared'
import { isPromise } from 'std:shared'

import { CLEAR, FIELDS } from '../const'
import { DbErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { Schema } from '../types/schema'
import type { Spec } from '../types/spec'

/** Kind-level type check for one present, non-null value; returns a problem description or null. */
const kindProblem = (column: Spec.Column, value: unknown): string | null => {
  switch (column.kind) {
    case 'text': {
      return typeof value === 'string' ? null : `"${column.name}" expects a string`
    }

    case 'enum': {
      const allowed = column.enumValues ?? []

      if (typeof value !== 'string') {
        return `"${column.name}" expects a string`
      }

      return allowed.includes(value)
        ? null
        : `"${column.name}" must be one of ${allowed.join(', ')}`
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

    case 'blob': {
      return value instanceof Uint8Array ? null : `"${column.name}" expects a Uint8Array`
    }

    default: {
      return null
    }
  }
}

const objectOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** Run a table's Standard Schema validator (sync or async) over the prepared value. */
function* runValidator(schema: StandardSchemaV1, table: string, value: unknown) {
  const verdict = schema['~standard'].validate(value)
  const result = isPromise(verdict) ? yield* until(verdict) : verdict

  if (result.issues) {
    const issues = result.issues.slice(0, 5).map(issue => issue.message)
    return yield* fail(DbErrors.Validation, `value rejected by the "${table}" validator`, ...issues)
  }

  return result.value as Spec.Doc
}

/** Walk the declared columns over an input object: `full` mode (insert/replace) applies defaults
 * and enforces required columns, normalizing omissions to `null`; partial mode (patch) only
 * checks the keys present. Unknown keys are stripped in both. */
const normalize = (
  def: Schema.Table,
  input: Record<string, unknown>,
  full: boolean,
): Helpers.Normalized => {
  const data: Record<string, unknown> = {}
  const problems: string[] = []

  for (const column of def.columns) {
    let entry = input[column.name]

    if (entry === undefined && full && column.hasDefault) {
      entry = def.defaults[column.name]?.()
    }

    if (entry === undefined) {
      if (!full) {
        continue
      }

      if (!column.optional) {
        problems.push(`missing required column "${column.name}"`)
        continue
      }

      data[column.name] = null
      continue
    }

    if (entry === null) {
      if (!column.optional) {
        problems.push(
          full
            ? `missing required column "${column.name}"`
            : `"${column.name}" is required and cannot be null`,
        )
        continue
      }

      data[column.name] = null
      continue
    }

    const problem = kindProblem(column, entry)

    if (problem) {
      problems.push(problem)
      continue
    }

    data[column.name] = entry
  }

  return { data, problems }
}

/**
 * Validate + normalize an insert/replace value: unknown keys stripped, defaults applied, required
 * columns enforced, kinds checked, optional omissions normalized to `null`, and the table's
 * Standard Schema validator (when declared) run over the result.
 */
export function* prepareInsert(def: Schema.Table, value: unknown) {
  const input = objectOf(value)

  if (!input) {
    return yield* fail(DbErrors.Validation, `insert into "${def.name}" expects an object`)
  }

  const { data, problems } = normalize(def, input, true)

  if (problems.length > 0) {
    return yield* fail(DbErrors.Validation, `invalid insert into "${def.name}"`, ...problems)
  }

  return def.validate ? yield* runValidator(def.validate, def.name, data) : data
}

/** Validate a patch: unknown keys stripped, present values kind-checked, `null` (and the
 * `CLEAR` sentinel, which is the typed way to null a field) only allowed on optional columns.
 * The table validator is NOT applied (it validates whole documents). */
export function* preparePatch(def: Schema.Table, value: unknown) {
  const input = objectOf(value)

  if (!input) {
    return yield* fail(DbErrors.Validation, `patch of "${def.name}" expects an object`)
  }

  const cleared = Object.fromEntries(
    Object.entries(input).map(([key, entry]) => [key, entry === CLEAR ? null : entry]),
  )

  const { data, problems } = normalize(def, cleared, false)

  if (problems.length > 0) {
    return yield* fail(DbErrors.Validation, `invalid patch of "${def.name}"`, ...problems)
  }

  return data
}

/** An HLC change token: 22 Crockford base32 characters. */
const TOKEN = /^[0-9A-HJKMNP-TV-Z]{22}$/u

const isStamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * The system fields an `import` row carries, validated: `_id` a non-empty string (required),
 * `_created_at`/`_updated_at` non-negative integer epoch millis, `_version` a change token.
 * Missing timestamps/version are left out for the stamp to fill (`_updated_at` then follows
 * `_created_at`).
 */
export function* systemOf(table: string, value: unknown) {
  const input = objectOf(value)

  if (!input) {
    return yield* fail(DbErrors.Validation, `import into "${table}" expects objects`)
  }

  const problems: string[] = []
  const out: Record<string, unknown> = {}
  const id = input[FIELDS.id]

  if (typeof id === 'string' && id.length > 0) {
    out[FIELDS.id] = id
  } else {
    problems.push(`"${FIELDS.id}" must be a non-empty string`)
  }

  for (const field of [FIELDS.created, FIELDS.updated]) {
    const stamp = input[field]

    if (stamp === undefined) {
      continue
    }

    if (isStamp(stamp)) {
      out[field] = stamp
    } else {
      problems.push(`"${field}" must be a non-negative integer (epoch millis)`)
    }
  }

  if (out[FIELDS.updated] === undefined && out[FIELDS.created] !== undefined) {
    out[FIELDS.updated] = out[FIELDS.created]
  }

  const version = input[FIELDS.version]

  if (version !== undefined) {
    if (typeof version === 'string' && TOKEN.test(version)) {
      out[FIELDS.version] = version
    } else {
      problems.push(`"${FIELDS.version}" must be a change token (22 Crockford base32 chars)`)
    }
  }

  if (problems.length > 0) {
    return yield* fail(DbErrors.Validation, `invalid import into "${table}"`, ...problems)
  }

  return out as Spec.Doc
}
