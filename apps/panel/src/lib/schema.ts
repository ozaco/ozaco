/**
 * JSON-Schema walker + skeleton generator for the docs renderer. Manifest schema documents are
 * reference-free zod exports (`type`/`properties`/`items`/`enum`/`anyOf`/`required`/`const`) or
 * the opaque `{ declared: true }` marker for non-zod schemas.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const childNodes = (schema: Record<string, unknown>): SchemaNode[] => {
  const required = Array.isArray(schema['required']) ? schema['required'] : []
  const properties = schema['properties']

  if (isRecord(properties)) {
    return Object.entries(properties).map(([key, child]) =>
      walkSchema(child, key, required.includes(key)),
    )
  }

  const items = schema['items']

  if (isRecord(items)) {
    return [walkSchema(items, 'items', false)]
  }

  const variants = schema['anyOf'] ?? schema['oneOf']

  if (Array.isArray(variants)) {
    return variants.map((variant, index) => walkSchema(variant, `#${index}`, false))
  }

  return []
}

const primitiveSkeleton = (schema: Record<string, unknown>, type: string): unknown => {
  switch (type) {
    case 'string': {
      return ''
    }
    case 'number':
    case 'integer': {
      return 0
    }
    case 'boolean': {
      return false
    }
    case 'null': {
      return null
    }
    case 'array': {
      return []
    }
    case 'object': {
      const skeleton: Record<string, unknown> = {}
      const required = Array.isArray(schema['required']) ? schema['required'] : []
      const properties = schema['properties']

      if (isRecord(properties)) {
        for (const [key, child] of Object.entries(properties)) {
          if (required.includes(key)) {
            skeleton[key] = skeletonOf(child)
          }
        }
      }

      return skeleton
    }
    default: {
      return null
    }
  }
}

/** The display label of a schema — mirrors the classic panel's `schemaType`. */
export const schemaTypeLabel = (schema: unknown): string => {
  if (!isRecord(schema)) {
    return 'any'
  }

  if (schema['declared'] === true) {
    return 'declared'
  }

  if (schema['const'] !== undefined) {
    return JSON.stringify(schema['const'])
  }

  if (Array.isArray(schema['enum'])) {
    return schema['enum'].map(value => JSON.stringify(value)).join(' | ')
  }

  if (Array.isArray(schema['anyOf'])) {
    return 'anyOf'
  }

  if (Array.isArray(schema['oneOf'])) {
    return 'oneOf'
  }

  if (schema['type'] !== undefined) {
    return Array.isArray(schema['type']) ? schema['type'].join(' | ') : String(schema['type'])
  }

  return 'any'
}

export interface SchemaNode {
  readonly name: string | undefined
  readonly type: string
  readonly required: boolean
  /** The opaque `{ declared: true }` marker (schema unknown to the manifest). */
  readonly declared: boolean
  readonly description: string | undefined
  readonly children: readonly SchemaNode[]
}

/** Resolve one schema document into a render tree (tolerates opaque/malformed entries). */
export const walkSchema = (schema: unknown, name?: string, required = false): SchemaNode => {
  if (!isRecord(schema)) {
    return {
      name,
      type: 'any',
      required,
      declared: false,
      description: undefined,
      children: [],
    }
  }

  if (schema['declared'] === true) {
    return {
      name,
      type: 'declared',
      required,
      declared: true,
      description: undefined,
      children: [],
    }
  }

  return {
    name,
    type: schemaTypeLabel(schema),
    required,
    declared: false,
    description: typeof schema['description'] === 'string' ? schema['description'] : undefined,
    children: childNodes(schema),
  }
}

/**
 * Example/skeleton generator used to prefill the try-it editor: objects carry their REQUIRED keys
 * only, primitives get sensible zero values, `default`/`const`/first `enum`/first `anyOf` win.
 */
export const skeletonOf = (schema: unknown): unknown => {
  if (!isRecord(schema) || schema['declared'] === true) {
    return {}
  }

  if (schema['default'] !== undefined) {
    return schema['default']
  }

  if (schema['const'] !== undefined) {
    return schema['const']
  }

  if (Array.isArray(schema['enum']) && schema['enum'].length > 0) {
    return schema['enum'][0]
  }

  const variants = schema['anyOf'] ?? schema['oneOf']

  if (Array.isArray(variants) && variants.length > 0) {
    return skeletonOf(variants[0])
  }

  const type = schema['type']

  if (Array.isArray(type)) {
    return primitiveSkeleton(schema, String(type[0] ?? 'null'))
  }

  if (typeof type === 'string') {
    return primitiveSkeleton(schema, type)
  }

  return isRecord(schema['properties']) ? primitiveSkeleton(schema, 'object') : {}
}
