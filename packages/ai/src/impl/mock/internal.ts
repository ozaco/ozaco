// oxlint-disable import/exports-last
import type { Helpers } from 'ai:core'
import { AiErrors } from 'ai:core'
import type { Context, Flow, Operation, Queue } from 'std:effect'
import { createContext, createQueue } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { MockCalls, MockChatResult, MockResponder, MockScript, MockStream } from './types'

export interface MockState {
  readonly script: MockScript
  readonly cursors: Map<string, number>
  readonly calls: MockCalls
}

export const StateRef: Context<MockState> = createContext<MockState>('ai:mock')

/** `Operation` detection for function-responder results — none of the mock's VALUE shapes
 * (results, streams, vector arrays, bytes, strings) is a non-array iterable object, and a
 * `Result.Failure` is (it iterates to raise itself), so this cleanly routes both. */
const isOperation = (value: AnyType): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array) &&
  typeof value[Symbol.iterator] === 'function'

const isQueue = (value: AnyType): value is { readonly queue: readonly AnyType[] } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array) &&
  Object.hasOwn(value, 'queue')

interface ResolveInput<TSpec, TValue> {
  readonly state: MockState
  readonly key: keyof MockScript & string
  readonly spec: TSpec
  readonly responder: MockResponder<TSpec, TValue> | undefined
  readonly fallback: TValue
}

/** Resolve one scripted response for a call (advancing the queue cursor where applicable). */
export function* resolveResponder<TSpec, TValue>(
  input: ResolveInput<TSpec, TValue>,
): Operation<TValue> {
  const { responder } = input
  if (responder === undefined) {
    return input.fallback
  }
  if (typeof responder === 'function') {
    const value = (responder as (spec: TSpec) => AnyType)(input.spec)
    return isOperation(value) ? yield* value : value
  }
  if (isQueue(responder)) {
    const cursor = input.state.cursors.get(input.key) ?? 0
    if (cursor >= responder.queue.length) {
      return yield* fail(
        AiErrors.Configuration,
        `the mock "${input.key}" queue is exhausted after ${responder.queue.length} calls`,
      )
    }
    input.state.cursors.set(input.key, cursor + 1)
    return responder.queue[cursor] as TValue
  }
  return responder as TValue
}

/** Complete a scripted partial into a full {@link Helpers.ChatResult} against the resolved spec. */
export const completeChatResult = (
  spec: Helpers.ChatSpec,
  partial: MockChatResult,
): Helpers.ChatResult => {
  const text = partial.text ?? ''
  const toolCalls = partial.toolCalls ?? []
  return {
    message: partial.message ?? {
      role: 'assistant',
      parts: text ? [{ kind: 'text', text }] : [],
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
    text,
    toolCalls,
    finishReason: partial.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    usage: partial.usage,
    model: partial.model ?? spec.model,
  }
}

/** Materialize one scripted stream as a fresh single-consumer flow. */
export const scriptedFlow = <T>(script: MockStream<T>): Flow<T, Helpers.StreamClose> => {
  const queue: Queue<T, Helpers.StreamClose> = createQueue<T, Helpers.StreamClose>()
  for (const chunk of script.chunks) {
    queue.add(chunk)
  }
  if (!script.hang) {
    queue.close(script.close ?? true)
  }
  return {
    *[Symbol.iterator]() {
      return queue
    },
  } as Flow<T, Helpers.StreamClose>
}
