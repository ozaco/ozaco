import { Palette, Terminal } from 'cli:core'
import type { Operation } from 'std:effect'
import { scoped, until, useContext } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'
import { isPromise } from 'std:shared'

import { CommandErrors, HELP_FLAGS, VERSION_FLAGS } from '../const'
import type { CommandDef } from '../types/command'
import type { ActionHelp, RuntimeNode } from '../types/internal'

import { build } from './build'
import { renderActionHelp, renderCommandHelp } from './help'
import { optionsFromSchema } from './schema'
import { tokenize } from './tokenize'

const hasFlag = (argv: string[], flags: string[]): boolean =>
  argv.some(token => flags.includes(token))

const validate = function* (input: StandardSchemaV1, value: unknown) {
  const result = input['~standard'].validate(value)
  return (
    isPromise(result) ? yield* until(result) : result
  ) as StandardSchemaV1.ValidationResult<unknown>
}

const formatIssues = (issues: readonly StandardSchemaV1.Issue[]): string =>
  issues
    .map(issue => {
      const path = (issue.path ?? [])
        .map(seg =>
          typeof seg === 'object' ? String((seg as { key: PropertyKey }).key) : String(seg),
        )
        .join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('\n')

function* descend(node: RuntimeNode, rest: string[], path: string[]): Operation<void, unknown> {
  const token = rest[0]

  if (token !== undefined && !token.startsWith('-') && node.children[token] !== undefined) {
    return yield* scoped(function* () {
      for (const child of Object.values(node.children)) {
        yield* install(child.plugin as AnyType)
      }
      return yield* descend(node.children[token]!, rest.slice(1), [...path, token])
    })
  }

  return yield* dispatch(node, rest, path)
}

function* dispatch(node: RuntimeNode, rest: string[], path: string[]): Operation<void, unknown> {
  const palette = yield* useContext(Palette)
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
  const infos = optionsFromSchema(meta.input)
  const short = meta.short ?? {}
  const argsOrder = meta.args ?? []
  const actionHelp: ActionHelp = {
    path: actionPath,
    description: meta.description,
    infos,
    short,
    args: argsOrder,
  }

  if (hasFlag(actionArgv, HELP_FLAGS)) {
    yield* Terminal.actions.write(`${renderActionHelp(actionHelp, palette)}\n`)
    return
  }

  const raw = yield* tokenize(actionArgv, infos, short)
  const built = build(infos, raw, argsOrder)
  const errors = [...raw.errors]
  let ctx: unknown = built

  if (meta.input !== undefined && errors.length === 0) {
    const result = yield* validate(meta.input, built)
    if (result.issues) {
      errors.push(formatIssues(result.issues))
    } else {
      ctx = result.value
    }
  }

  if (errors.length > 0) {
    const text = errors.join('\n')
    const help = renderActionHelp(actionHelp, palette)
    yield* Terminal.actions.write(`${palette.colors.error(text)}\n\n${help}\n`)
    return yield* fail(CommandErrors.Parse, text)
  }

  yield* command.actions[actionKey]!(ctx)
}

/**
 * Parse argv against a command tree and dispatch the matched action (the CLI analog of `Broker.call`).
 *
 * Walks `subcommands` LAZILY: to descend into a child, it opens the current node's child scope and
 * installs that node's direct children there — their `setup`s run then, the CLI analog of "entering" a
 * command — so only the commands on the invoked path are ever set up, and each level's context is
 * visible to the levels below (child scopes inherit their parent). When no child token matches, the
 * current node's leaf action is resolved, its argv built + validated, and dispatched.
 *
 * Requires Terminal + Palette installed, and the root node installed (done by `register`).
 */
export function* runCommand(root: RuntimeNode, argv?: string[]): Operation<void, unknown> {
  const fromProcess = typeof process === 'undefined' ? [] : process.argv.slice(2)
  const args = (argv ?? fromProcess).slice()
  return yield* descend(root, args, [root.name])
}
