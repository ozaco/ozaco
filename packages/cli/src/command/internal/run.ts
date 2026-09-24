import { CliCauses, CliErrors, Terminal } from 'cli:core'
import { usePalette } from 'cli:palette'
import type { Operation } from 'std:effect'
import { scoped } from 'std:effect'
import { fail, isFailure } from 'std:result'
import { validateSync } from 'std:shared'

import { HELP_FLAGS, VERSION_FLAGS } from '../const'
import type { CommandDef } from '../types/command'
import type { Helpers } from '../types/helpers'
import type { RegistryDef } from '../types/registry'

import { hasFlag, processArgv, processCwd } from './argv'
import { build } from './build'
import { renderActionHelp, renderCommandHelp } from './help'
import { optionsFromAction } from './schema'
import { tokenize } from './tokenize'

function* descend(
  node: Helpers.RuntimeNode,
  rest: string[],
  state: Helpers.RunState,
): Operation<void> {
  const token = rest[0]

  if (token !== undefined && !token.startsWith('-') && node.children[token] !== undefined) {
    const next = node.children[token]!
    return yield* scoped(function* () {
      // Install ONLY the child on the invoked path — never its siblings. Each subcommand gets its
      // own child scope (which inherits the parent's contexts via the scope prototype chain), so
      // sibling commands stay isolated: their `setup`s don't run and their contexts never leak in.
      // This is also what lets subcommands be compiled as independent bundles (each carrying its
      // own copy of @ozaco/*) — co-installing two separate bundles into one scope would otherwise
      // collide.
      yield* next.plugin.use()
      return yield* descend(next, rest.slice(1), {
        ...state,
        path: [...state.path, token],
        chain: [...state.chain, next],
      })
    })
  }

  return yield* dispatch(node, rest, state)
}

/** Validate (or, schema-less, pass through) one source's slice of the built values. */
const resolve = (
  source: Helpers.CtxSource,
  values: Record<string, unknown>,
): { value: Record<string, unknown> } | { error: string } => {
  if (source.input === undefined) {
    const picked: Record<string, unknown> = {}
    for (const name of source.names) {
      if (values[name] !== undefined) {
        picked[name] = values[name]
      }
    }
    return { value: picked }
  }
  const result = validateSync(source.input, values)
  if (isFailure(result)) {
    return { error: result.causes.join('\n') }
  }
  const value = result.value as unknown
  return { value: typeof value === 'object' && value !== null ? { ...value } : {} }
}

function* dispatch(
  node: Helpers.RuntimeNode,
  rest: string[],
  state: Helpers.RunState,
): Operation<void> {
  const { path } = state
  const palette = yield* usePalette()
  const command = node.plugin

  const keys = command.getKeys()
  const head = rest[0]
  let actionKey: string | undefined
  let actionArgv = rest
  let actionPath = path
  if (head !== undefined && !head.startsWith('-') && keys.includes(head)) {
    actionKey = head
    actionArgv = rest.slice(1)
    actionPath = [...path, head]
  } else if (keys.includes('default')) {
    actionKey = 'default'
  }

  if (command.version !== undefined && hasFlag(rest, VERSION_FLAGS)) {
    yield* Terminal.actions.write(`${command.version}\n`)
    return
  }

  if (actionKey === undefined) {
    yield* Terminal.actions.write(`${renderCommandHelp(node, path, palette)}\n`)
    return
  }

  const meta = (command.getMeta(actionKey) ?? {}) as CommandDef.ActionMeta
  const own = yield* optionsFromAction(meta)
  const argsOrder = meta.args ?? []

  // Inherited options, root first: every level on the invoked path that declares some. An
  // action's own field shadows an inherited one of the same name (in flags and in `ctx`).
  const sources: Helpers.CtxSource[] = []
  const infos = [...own]
  const short: Record<string, string> = {}
  for (const level of state.chain) {
    if (level.inherit === undefined) {
      continue
    }
    const inherited = yield* optionsFromAction(level.inherit)
    sources.push({ input: level.inherit.input, names: inherited.map(info => info.name) })
    for (const info of inherited) {
      if (!infos.some(known => known.name === info.name)) {
        infos.push(info)
      }
    }
    Object.assign(short, level.inherit.short)
  }
  Object.assign(short, meta.short)
  sources.push({ input: meta.input, names: [...own.map(info => info.name), ...argsOrder] })

  const actionHelp: Helpers.ActionHelp = {
    path: actionPath,
    description: meta.description,
    infos,
    short,
    args: argsOrder,
    examples: meta.examples ?? [],
  }

  if (hasFlag(actionArgv, HELP_FLAGS)) {
    yield* Terminal.actions.write(`${renderActionHelp(actionHelp, palette)}\n`)
    return
  }

  const raw = yield* tokenize(actionArgv, infos, short)
  const built = build(infos, raw, argsOrder)
  const errors = [...raw.errors, ...built.errors]
  const merged: Record<string, unknown> = {}

  if (errors.length === 0) {
    for (const source of sources) {
      const resolved = resolve(source, built.values)
      if ('error' in resolved) {
        errors.push(resolved.error)
      } else {
        Object.assign(merged, resolved.value)
      }
    }
  }

  if (errors.length > 0) {
    const text = errors.join('\n')
    const help = renderActionHelp(actionHelp, palette)
    yield* Terminal.actions.write(`${palette.colors.error(text)}\n\n${help}\n`, {
      stream: 'stderr',
    })
    return yield* fail(CliErrors.Parse, text, CliCauses.Reported)
  }

  const ctx: CommandDef.Runtime & Record<string, unknown> = {
    ...merged,
    cwd: typeof merged['cwd'] === 'string' ? merged['cwd'] : state.cwd,
    '--': raw.rest,
  }

  yield* command.actions[actionKey]!(ctx)
}

/**
 * Parse argv against a command tree and dispatch the matched action (the CLI analog of
 * `Broker.call`).
 *
 * Walks `subcommands` LAZILY: the root is installed in its own scope here, then to descend into a
 * child it opens a fresh child scope and installs ONLY that child — its `setup` runs then, the CLI
 * analog of "entering" a command — so only the commands on the invoked path are ever set up,
 * siblings stay isolated, and each level's context is visible to the levels below (child scopes
 * inherit their parent). When no child token matches, the current node's leaf action is resolved,
 * its argv built + validated (together with the options every level on the path inherits to it),
 * and dispatched with the runtime `cwd` / `'--'` fields added to its `ctx`.
 *
 * Requires Terminal + Palette installed. The root node is built + stored by `register` but its
 * `setup` is NOT run there — it runs here, lazily, so registering many top-level commands never
 * collides.
 */
export function* runCommand(
  root: Helpers.RuntimeNode,
  argv?: string[],
  options: RegistryDef.RunOptions = {},
): Operation<void> {
  const args = (argv ?? processArgv()).slice()
  const cwd = options.cwd ?? processCwd()
  // Install the root command in its OWN scope (running its setup) here, not at register — the
  // top-level analog of how `descend` enters a child. Only the invoked command's setup ever runs,
  // so sibling top-level commands (e.g. two plugins that each install YamlCodec) never collide.
  return yield* scoped(function* () {
    yield* root.plugin.use()
    return yield* descend(root, args, { cwd, path: [root.name], chain: [root] })
  })
}
