import type { ClientDef } from '../types/client'
import { wireFailureOf } from '../utils/failure'

/** `client.$text(failure, fallback)`: the first string cause `messages` names, else the tag's
 * entry, else `fallback`, else the failure's own message. */
export const textOf = (
  options: Pick<ClientDef.Options, 'messages'>,
  failure: unknown,
  fallback?: string,
): string => {
  const wire = wireFailureOf(failure)
  const messages = options.messages ?? {}
  const specific = wire.causes.find(cause => Object.hasOwn(messages, cause))

  if (specific !== undefined) {
    return messages[specific]!
  }

  return Object.hasOwn(messages, wire.tag) ? messages[wire.tag]! : (fallback ?? wire.message)
}
