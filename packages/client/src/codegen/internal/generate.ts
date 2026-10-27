// oxlint-disable import/exports-last
import type { AnyType } from 'std:shared'

import type { ManifestDef } from '../../core/types/manifest'
import type { Emit, SchemaStyle } from '../types'

import { IDENTIFIER, INDENT } from './const'
import { enumsOf, typeTextOf } from './schema'

/** A bare identifier stays bare; anything else is emitted as a quoted string literal. */
export const keyText = (key: string): string =>
  IDENTIFIER.test(key)
    ? key
    : `'${key.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`)}'`

/** The TS type of one plane: values from their schema, streams by brand. */
const planeType = (plane: ManifestDef.Plane, depth: number, emit: Emit): string => {
  if (plane.plane === 'none') {
    return 'undefined'
  }

  if (plane.plane === 'parts') {
    const streams = Object.keys(plane.streams ?? {})
      .toSorted()
      .map(name => `${keyText(name)}: Blob | Uint8Array | string`)

    return `{ fields: ${typeTextOf(plane.schema, depth + 1, emit.style)}; streams: { ${streams.join('; ')} } }`
  }

  if (plane.plane === 'stream') {
    if (plane.brand === 'ndjson' || plane.brand === 'sse') {
      emit.flow = true

      return `Flow<${typeTextOf(plane.schema, depth + 1, emit.style)}, void>`
    }

    if (plane.brand === 'text') {
      return 'string'
    }

    return 'ReadableStream<Uint8Array>'
  }

  return typeTextOf(plane.schema, depth + 1, emit.style)
}

const actionType = (action: ManifestDef.Action, depth: number, emit: Emit): string => {
  const inner = INDENT.repeat(depth + 1)

  const lines = [
    `${inner}readonly kind: '${action.kind}'`,
    `${inner}readonly input: ${planeType(action.input, depth + 1, emit)}`,
    `${inner}readonly output: ${planeType(action.output, depth + 1, emit)}`,
  ]

  return `{\n${lines.join('\n')}\n${INDENT.repeat(depth)}}`
}

/** The JSDoc line of an action (`docs`): its description, else its title. */
const actionDoc = (action: ManifestDef.Action, indent: string, emit: Emit): string[] => {
  const text = action.description || action.title

  return emit.style.docs && text ? [`${indent}/** ${text.replaceAll('*/', '* /')} */`] : []
}

export const callableOf = (service: ManifestDef.Service): readonly ManifestDef.Action[] =>
  service.actions.filter((entry): entry is ManifestDef.Action => entry.kind !== 'socket')

export const socketsOf = (service: ManifestDef.Service): readonly ManifestDef.Socket[] =>
  service.actions.filter((entry): entry is ManifestDef.Socket => entry.kind === 'socket')

export const serviceType = (service: ManifestDef.Service, depth: number, emit: Emit): string => {
  const inner = INDENT.repeat(depth + 1)
  const lines: string[] = []

  for (const action of [...callableOf(service)].toSorted((left, right) =>
    left.action.localeCompare(right.action),
  )) {
    lines.push(
      ...actionDoc(action, inner, emit),
      `${inner}readonly ${keyText(action.action)}: ${actionType(action, depth + 1, emit)}`,
    )
  }

  return `{\n${lines.join('\n')}\n${INDENT.repeat(depth)}}`
}

/** The ROW type of a resource socket, from its published `sends` schema (the `sync` frame's
 * `rows` element) — what types `$watch`/`$rows`/`$window` for codegen consumers. */
export const socketRowType = (socket: ManifestDef.Socket, style?: SchemaStyle): string | null => {
  const sends = socket.sends

  if (!sends || socket.protocol !== 'resource') {
    return null
  }

  const variants = (sends['anyOf'] ?? sends['oneOf']) as readonly Record<string, AnyType>[] | null

  const sync = variants?.find(variant => {
    const properties = variant['properties'] as Record<string, AnyType> | undefined

    return properties?.['t']?.const === 'sync'
  })
  const rows = (sync?.['properties'] as Record<string, AnyType> | undefined)?.['rows']

  return rows?.items ? typeTextOf(rows.items as Record<string, unknown>, 2, style) : null
}

/** The string enums a service's action schemas declare, by field — see `GenerateOptions.enums`. */
export const enumsOfService = (service: ManifestDef.Service): Map<string, readonly string[]> => {
  const found = new Map<string, readonly string[]>()

  for (const action of callableOf(service)) {
    const pick = (key: string) => `${key}_${action.action}`

    enumsOf(action.input.schema, found, pick)
    enumsOf(action.output.schema, found, pick)
  }

  return found
}

export const routeText = (action: ManifestDef.Action): string =>
  `{ kind: '${action.kind}', method: '${action.route.method}', path: '${action.route.path}' }`
