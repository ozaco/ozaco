import type { StandardSchemaV1 } from 'cli:core'
import type { Operation } from 'std:effect'
import { attempt, call } from 'std:effect'
import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { CommandDef } from '../types/command'
import type { JsonSchema } from '../types/internal'

const baseType = (type: string | string[] | undefined): 'string' | 'number' | 'boolean' => {
  const resolved = Array.isArray(type) ? type.find(entry => entry !== 'null') : type
  if (resolved === 'boolean') {
    return 'boolean'
  }
  if (resolved === 'number' || resolved === 'integer') {
    return 'number'
  }
  return 'string'
}

const fromDecls = (decls: readonly CommandDef.OptionDecl[]): CommandDef.OptionInfo[] =>
  decls.map(decl => ({
    name: decl.name,
    type: decl.type ?? 'string',
    array: decl.array ?? false,
    enum: decl.enum,
    required: decl.required ?? false,
    hasDefault: false,
  }))

const walk = (json: JsonSchema): CommandDef.OptionInfo[] => {
  const required = new Set(json.required)
  const infos: CommandDef.OptionInfo[] = []

  for (const [name, prop] of Object.entries(json.properties ?? {})) {
    const array = Array.isArray(prop.type) ? prop.type.includes('array') : prop.type === 'array'
    infos.push({
      name,
      type: array ? baseType(prop.items?.type) : baseType(prop.type),
      array,
      enum: array ? prop.items?.enum : prop.enum,
      required: required.has(name),
      hasDefault: prop.default !== undefined,
    })
  }

  return infos
}

/**
 * Resolve an action's option metadata (drives tokenizing — boolean fields take no value — and help
 * rendering; validation/defaults stay with the schema itself). Precedence:
 *
 * 1. a manual `options` declaration on the action config — always wins,
 * 2. zod schemas (`vendor === 'zod'`) — converted via `z.toJSONSchema` behind a feature-detected
 *    DYNAMIC import guarded by `attempt` (zod is an optional peer; this module never hard-imports
 *    it, and a missing/incompatible zod degrades to no flags instead of crashing),
 * 3. anything else — no flags (non-zod Standard Schemas need the manual `options` declaration).
 */
export function* optionsFromAction(
  meta: CommandDef.ActionMeta,
): Operation<CommandDef.OptionInfo[]> {
  if (meta.options !== undefined) {
    return fromDecls(meta.options)
  }

  const input: StandardSchemaV1 | undefined = meta.input
  if (input === undefined || input['~standard'].vendor !== 'zod') {
    return []
  }

  const zod = yield* attempt(call(() => import('zod')))
  if (!isSuccess(zod)) {
    return []
  }

  const json = yield* attempt(
    call(
      () =>
        (zod.value.z as AnyType).toJSONSchema(input, {
          unrepresentable: 'any',
          io: 'input',
        }) as JsonSchema,
    ),
  )

  return isSuccess(json) ? walk(json.value) : []
}
