import type { Future } from 'std:effect'
import { operation } from 'std:effect'
import { IO } from 'std:io'
import { isArray, isString } from 'std:shared'

import { EXTENDS_KEY } from '../const'
import type { ConfigDef } from '../types'

/**
 * Read and parse one config file into a `Source`, resolving its `extends` (a path or list of paths,
 * relative to the file) into nested sources. `seen` guards against cycles and double-reads. Returns
 * `undefined` when the file is absent or already visited; a malformed file fails via the codec.
 */
export const readSource: (
  ctx: ConfigDef.Context,
  path: string,
  seen: Set<string>,
) => Future<ConfigDef.Source | undefined, unknown> = operation(function* (
  ctx: ConfigDef.Context,
  path: string,
  seen: Set<string>,
) {
  if (seen.has(path)) {
    return undefined
  }

  const present = yield* IO.actions.exists(path)
  if (!present) {
    return undefined
  }
  seen.add(path)

  const text = yield* IO.actions.readText(path)
  const parsed = yield* ctx.codec.actions.parse<ConfigDef.Object>(text)

  const { [EXTENDS_KEY]: spec, ...data } = parsed
  const targets = isString(spec) ? [spec] : isArray<string>(spec) ? spec : []
  const inherited: ConfigDef.Source[] = []

  for (const target of targets) {
    const absolute = yield* IO.actions.isAbsolute(target)
    const resolved = absolute
      ? target
      : yield* IO.actions.join(yield* IO.actions.dirname(path), target)

    const source = yield* readSource(ctx, resolved, seen)
    if (source) {
      inherited.push(source)
    }
  }

  return { path, data, extends: inherited }
})
