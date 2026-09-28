// oxlint-disable import/exports-last
import type { AnyType } from 'std:shared'

import type { ManifestDef } from '../../core/types/manifest'

import { IDENTIFIER, INDENT } from './const'
import { typeTextOf } from './schema'

/** A bare identifier stays bare; anything else is emitted as a quoted string literal. */
export const keyText = (key: string): string =>
  IDENTIFIER.test(key)
    ? key
    : `'${key.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`)}'`

/** The TS type of one plane: values from their schema, streams by brand. */
const planeType = (plane: ManifestDef.Plane, depth: number, uses: { flow: boolean }): string => {
  if (plane.plane === 'none') {
    return 'undefined'
  }

  if (plane.plane === 'parts') {
    const streams = Object.keys(plane.streams ?? {})
      .toSorted()
      .map(name => `${keyText(name)}: Blob | Uint8Array | string`)

    return `{ fields: ${typeTextOf(plane.schema, depth + 1)}; streams: { ${streams.join('; ')} } }`
  }

  if (plane.plane === 'stream') {
    if (plane.brand === 'ndjson' || plane.brand === 'sse') {
      uses.flow = true

      return `Flow<${typeTextOf(plane.schema, depth + 1)}, void>`
    }

    if (plane.brand === 'text') {
      return 'string'
    }

    return 'ReadableStream<Uint8Array>'
  }

  return typeTextOf(plane.schema, depth + 1)
}

const actionType = (action: ManifestDef.Action, depth: number, uses: { flow: boolean }): string => {
  const inner = INDENT.repeat(depth + 1)

  const lines = [
    `${inner}readonly kind: '${action.kind}'`,
    `${inner}readonly input: ${planeType(action.input, depth + 1, uses)}`,
    `${inner}readonly output: ${planeType(action.output, depth + 1, uses)}`,
  ]

  return `{\n${lines.join('\n')}\n${INDENT.repeat(depth)}}`
}

export const callableOf = (service: ManifestDef.Service): readonly ManifestDef.Action[] =>
  service.actions.filter((entry): entry is ManifestDef.Action => entry.kind !== 'socket')

export const socketsOf = (service: ManifestDef.Service): readonly ManifestDef.Socket[] =>
  service.actions.filter((entry): entry is ManifestDef.Socket => entry.kind === 'socket')

export const serviceType = (
  service: ManifestDef.Service,
  depth: number,
  uses: { flow: boolean },
): string => {
  const inner = INDENT.repeat(depth + 1)
  const lines = [...callableOf(service)]
    .toSorted((left, right) => left.action.localeCompare(right.action))
    .map(
      action =>
        `${inner}readonly ${keyText(action.action)}: ${actionType(action, depth + 1, uses)}`,
    )

  return `{\n${lines.join('\n')}\n${INDENT.repeat(depth)}}`
}

/** The ROW type of a resource socket, from its published `sends` schema (the `sync` frame's
 * `rows` element) — what types `$watch`/`$rows`/`$window` for codegen consumers. */
export const socketRowType = (socket: ManifestDef.Socket): string | null => {
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

  return rows?.items ? typeTextOf(rows.items as Record<string, unknown>, 2) : null
}

export const routeText = (action: ManifestDef.Action): string =>
  `{ kind: '${action.kind}', method: '${action.route.method}', path: '${action.route.path}' }`
