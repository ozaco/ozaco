import type { Helpers } from './types/helpers'

/** Normalize one {@link Helpers.MessageLike}: strings become user messages, `content` sugar
 * becomes parts, already-normalized messages pass through. */
export const normalizeMessage = (message: Helpers.MessageLike): Helpers.Message => {
  if (typeof message === 'string') {
    return { role: 'user', parts: [{ kind: 'text', text: message }] }
  }
  if ('parts' in message) {
    return message
  }
  return {
    role: message.role,
    parts:
      typeof message.content === 'string'
        ? [{ kind: 'text', text: message.content }]
        : message.content,
    name: message.name,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
  }
}

/** Normalize the client's message input into the spec shape. */
export const normalizeMessages = (input: Helpers.MessagesInit): readonly Helpers.Message[] =>
  typeof input === 'string' ? [normalizeMessage(input)] : input.map(normalizeMessage)

/** Flatten a message's text parts into one string. */
export const textOf = (message: Helpers.Message): string =>
  message.parts
    .filter(part => part.kind === 'text')
    .map(part => part.text)
    .join('')

/**
 * Create a {@link Helpers.ToolCallAccumulator} — the streaming counterpart of the `run:` loop's
 * built-in accumulation. Fragments sharing an `index` merge into one call: the first non-empty
 * `id`/`name` wins, `arguments` fragments concatenate in arrival order.
 *
 * ```ts
 * const calls = accumulateToolCalls()
 * for (;;) {
 *   const step = yield* subscription.next()
 *   if (step.done) break
 *   calls.add(step.value.toolCalls)
 * }
 * calls.collect() // → readonly ToolCall[]
 * ```
 */
export const accumulateToolCalls = (): Helpers.ToolCallAccumulator => {
  interface Slot {
    id: string
    name: string
    arguments: string
  }
  const slots = new Map<number, Slot>()

  return {
    add(fragments) {
      if (!fragments) {
        return
      }
      for (const fragment of fragments) {
        const slot = slots.get(fragment.index) ?? { id: '', name: '', arguments: '' }
        if (!slot.id && fragment.id) {
          slot.id = fragment.id
        }
        if (!slot.name && fragment.name) {
          slot.name = fragment.name
        }
        if (fragment.arguments !== undefined) {
          slot.arguments += fragment.arguments
        }
        slots.set(fragment.index, slot)
      }
    },
    collect: () =>
      [...slots.entries()]
        .toSorted((left, right) => left[0] - right[0])
        .map(([, slot]) => ({ id: slot.id, name: slot.name, arguments: slot.arguments })),
  }
}
