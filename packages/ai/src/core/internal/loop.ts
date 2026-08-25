import { CodecErrors } from 'std:codec'
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { AiErrors } from '../errors'
import { AiProvider } from '../provider'
import type { AiDef } from '../types/ai'
import type { Helpers } from '../types/helpers'

import { withRetry } from './retry'

/** JSON-parse a tool call's arguments through the installed `JsonCodec` into the handler's object
 * (empty string → `{}`). Garbage or a non-object payload is the MODEL's fault: `ai.bad-response`;
 * any other failure (e.g. `JsonCodec` missing from the scope) re-raises untouched. */
function* parseArguments(call: Helpers.ToolCall): Operation<Record<string, unknown>> {
  const raw = call.arguments.trim() === '' ? '{}' : call.arguments
  const outcome = yield* attempt(JsonCodec.actions.parse<AnyType>(raw))
  if (isFailure(outcome) && outcome.error !== CodecErrors.Parse) {
    return yield* outcome
  }
  const parsed: unknown = isFailure(outcome) ? undefined : outcome.value
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return yield* fail(
      AiErrors.BadResponse,
      `tool call "${call.name}" carried malformed arguments: ${call.arguments}`,
    )
  }
  return parsed as Record<string, unknown>
}

/** The `role: 'tool'` message answering one call — non-string handler results are JSON-encoded
 * through the installed `JsonCodec` (a value it serializes to nothing, e.g. `undefined`, falls
 * back to `'null'`). */
function* toolMessage(call: Helpers.ToolCall, value: unknown): Operation<Helpers.Message> {
  const encoded =
    typeof value === 'string'
      ? value
      : (((yield* JsonCodec.actions.stringify(value)) as string | undefined) ?? 'null')
  return {
    role: 'tool',
    parts: [{ kind: 'text', text: encoded }],
    name: call.name,
    toolCallId: call.id,
  }
}

function* invokeTool(
  run: Readonly<Record<string, AiDef.ToolRunner>>,
  call: Helpers.ToolCall,
): Operation<unknown> {
  const runner = Object.hasOwn(run, call.name) ? run[call.name] : undefined
  if (!runner) {
    return yield* fail(AiErrors.BadResponse, `the model called an unknown tool "${call.name}"`)
  }
  const args = yield* parseArguments(call)
  return yield* runner(args)
}

export interface ToolLoopInput {
  readonly spec: Helpers.ChatSpec
  readonly run: Readonly<Record<string, AiDef.ToolRunner>>
  readonly maxRounds: number
  readonly retries: number
}

/**
 * The core tool loop `Ai.actions.chat(messages, { run })` executes: dispatch the spec, invoke a
 * handler for every requested tool call, append the assistant message and the tool results, and
 * re-ask — until a round returns no tool calls or the round budget is exhausted (`ai.request`).
 */
export function* runToolLoop(input: ToolLoopInput): Operation<Helpers.ChatResult> {
  const messages = [...input.spec.messages]

  for (let round = 0; round < input.maxRounds; round += 1) {
    const spec: Helpers.ChatSpec = { ...input.spec, messages }
    const result: Helpers.ChatResult = yield* withRetry(input.retries, () =>
      AiProvider.actions.chat(spec),
    )

    if (result.toolCalls.length === 0) {
      return result
    }

    messages.push(result.message)

    for (const call of result.toolCalls) {
      const value = yield* invokeTool(input.run, call)
      messages.push(yield* toolMessage(call, value))
    }
  }

  return yield* fail(
    AiErrors.Request,
    `tool loop exceeded ${input.maxRounds} rounds without a final answer`,
  )
}
