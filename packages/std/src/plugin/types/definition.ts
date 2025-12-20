import type { EventEmitter } from 'std:event'
import type { Expand, LiteralUnion, ToPartialObect } from 'std:shared'

import type { DEFINITION } from '../const'

import type { ContextEvents } from './context'
import type { Helpers } from './helpers'

export type DefinitionEvents = ContextEvents & {
  extended: Helpers.AnyDefinition

  // TODO: onInit
}

export interface Definition<Key, Value> {
  _t: typeof DEFINITION

  extend: <NewValue extends Expand<ToPartialObect<Value>>>(
    cb: (options: { def: Value; use: Helpers.DefinitionUse }) => NewValue,
  ) => Definition<Key, NewValue>

  event: EventEmitter<DefinitionEvents>

  getKey: () => Key
  getValue: (options: { use: Helpers.DefinitionUse }) => Value
  getRequired: () => (keyof Value)[]

  key: <NewKey extends LiteralUnion<Key, string>>(key: NewKey) => Definition<NewKey, Value>
  require: (...keys: (keyof Value)[]) => Definition<Key, Value>
  optional: (...keys: (keyof Value)[]) => Definition<Key, Value>
}
