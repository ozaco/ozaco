import type { EventEmitter } from 'std:event'
import type { LiteralUnion } from 'std:shared'

import type { DEFINITION } from '../const'

import type { ContextEvents } from './context'
import type { Helpers } from './helpers'

export type DefinitionEvents = ContextEvents & {
  extended: Helpers.AnyDefinition
  plugin: Helpers.AnyPlugin
}

export interface Definition<Key, Value> {
  _t: typeof DEFINITION

  extend: <NewValue>(
    cb: (options: {
      def: Value
      use: Helpers.DefinitionUse
      event: Helpers.AnyPlugin['event']
    }) => NewValue,
  ) => Definition<Key, NewValue>

  event: EventEmitter<DefinitionEvents>

  getKey: () => Key
  getValue: (options: {
    use: Helpers.DefinitionUse
    event: Helpers.AnyPlugin['event']
    rebind: Helpers.Rebind
  }) => Value
  getRequired: () => (keyof Value)[]

  key: <const NewKey extends LiteralUnion<Key, string>>(key: NewKey) => Definition<NewKey, Value>
  require: (...keys: (keyof Value)[]) => Definition<Key, Value>
  optional: (...keys: (keyof Value)[]) => Definition<Key, Value>
}
