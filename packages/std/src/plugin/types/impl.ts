import type { BlobType, EmptyType, Expand, Merge, Writable } from 'std:shared'

import type { Context } from './context'
import type { Definition } from './definition'
import type { DependencyList, DependencyListOptions } from './dependency-list'
import type { Extendable } from './extendable'
import type { Helpers } from './helpers'
import type { Plugin } from './plugin'

export namespace Impl {
  export type CreateContext = <const Data extends EmptyType>(
    data: Data | (() => Data),
    cloneAlgorithm?: () => Data,
  ) => Context<Data>

  export interface CreateDefinition {
    <Value extends EmptyType>(
      value?: (utils: { use: Helpers.DefinitionUse; event: Helpers.AnyPlugin['event'] }) => Value,
    ): Definition<unknown, Value>
    <Value>(value?: Value): Definition<unknown, Value>
  }

  export type CreateExtendable = <const Meta extends Helpers.AnyMetadata>(
    meta: Meta,
  ) => Extendable<Expand<Writable<Meta>>, EmptyType>

  export type CreateDependencyList = <Deps extends EmptyType = EmptyType>(
    dependencies: DependencyListOptions<Deps>,
    shared?: boolean,
  ) => DependencyList<Deps>

  export type CreatePlugin = <
    Ext extends Helpers.AnyExtendable,
    const NewMeta extends Helpers.InferIncompleteMetadata<Ext>,
    Constructor extends Definition<BlobType, (...args: BlobType[]) => BlobType>,
  >(
    extendable: Ext,
    options: NewMeta,
    con?: Constructor,
  ) => (
    ...args: Parameters<Helpers.InferDefinitionValue<Constructor>>
  ) => Plugin<Expand<Merge<Helpers.InferMetadata<Ext>, NewMeta>>, Helpers.InferDefinitions<Ext>>
}
