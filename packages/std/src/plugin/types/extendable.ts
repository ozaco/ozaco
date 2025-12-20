import type { EventEmitter } from 'std:event'
import type { EmptyType } from 'std:shared'

import type { EXTENDABLE } from '../const'

import type { Helpers } from './helpers'

export type ExtendableEvents = {
  definition: Helpers.AnyDefinition
  context: Helpers.AnyContext
  'dependency-list': Helpers.AnyDependencyList

  plugin: Helpers.AnyPlugin
}

export interface Metadata<Namespace extends string, Name extends string = never, Version extends string = never> {
  namespace: Namespace
  name?: Name
  version?: Version
}

export type Extendable<Meta extends Helpers.AnyMetadata, Defs = EmptyType> = {
  _t: typeof EXTENDABLE
  _m: Meta

  event: EventEmitter<ExtendableEvents>

  getDefinitions: () => Helpers.AnyDefinition[]
  define: <NewDefs extends (Helpers.AnyDefinition | Helpers.AnyContext | Helpers.AnyDependencyList)[]>(
    ...args: NewDefs
  ) => Extendable<Meta, Helpers.MergeDefinitons<Defs, NewDefs>>
}
