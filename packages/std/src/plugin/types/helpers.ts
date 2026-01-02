import type { BlobType, Expand, Merge, MergeObjectUnion, ObjectFromKeyValue } from 'std:shared'

import type { Context } from './context'
import type { Definition } from './definition'
import type { Dependencies, DependencyList } from './dependency-list'
import type { Extendable, Metadata } from './extendable'
import type { Plugin } from './plugin'

export namespace Helpers {
  // Context

  export type AnyContext = Context<BlobType>

  export type InferContextData<Type> = Type extends Context<infer Data> ? Data : never
  export type InferExistingContextData<Type> = [
    Type,
  ] extends [
    never,
  ]
    ? unknown
    : Type extends Context<infer Data>
      ? Data
      : unknown

  // Definition

  export type DefinitionUse = <T>(
    target: T,
  ) => T extends AnyContext
    ? InferContextData<T>
    : T extends AnyDependencyList
      ? InferExistingDependencies<T>
      : T extends AnyDefinition
        ? InferDefinitionValue<T>
        : T extends AnyExtendable
          ? InferDefinitions<T>
          : T

  export type AnyDefinition = Definition<BlobType, BlobType>

  export type InferDefinitionKey<Type> =
    Type extends Definition<infer Key, BlobType> ? (Key extends PropertyKey ? Key : never) : never
  export type InferDefinitionValue<Type> = Type extends Definition<BlobType, infer Value> ? Value : never

  // Definition Merger

  export type ApplyDefinition<Type extends AnyDefinition> = Type extends infer U
    ? [
        InferDefinitionKey<U>,
      ] extends [
        never,
      ]
      ? InferDefinitionValue<U>
      : ObjectFromKeyValue<InferDefinitionKey<U>, InferDefinitionValue<U>>
    : never

  export type ToApplied<Type extends AnyDefinition[]> = MergeObjectUnion<ApplyDefinition<Type[number]>>

  export type MergeDefinitons<Defs, NewDefs extends (AnyDefinition | AnyContext | AnyDependencyList)[]> = Expand<
    Merge<Defs, ToApplied<NewDefs extends Array<infer D> ? Extract<D, AnyDefinition>[] : []>>
  >

  // Dependency List

  export type AnyDependencyList = DependencyList<BlobType>

  export type InferDependencyListData<Deps> = Deps extends DependencyList<infer D> ? D : never
  export type InferExistingDependencies<Deps> = [
    Deps,
  ] extends [
    never,
  ]
    ? unknown
    : Deps extends DependencyList<infer D>
      ? Dependencies<D>
      : unknown

  // Extendable

  export type AnyMetadata = Metadata<BlobType, BlobType, BlobType>
  export type AnyExtendable = Extendable<AnyMetadata, BlobType>

  export type InferMetadata<T> = T extends Extendable<infer Meta, BlobType> ? Meta : never
  export type InferDefinitions<T> = T extends Extendable<BlobType, infer Definitions> ? Definitions : never
  export type InferIncompleteMetadata<T> = Expand<Required<Omit<AnyMetadata, keyof InferMetadata<T>>>>

  // Plugin

  export type AnyPlugin = Plugin<BlobType, BlobType>
  export type UseAnyDependency = {
    [name: string]: AnyPlugin
  }

  export type InferPluginFromExtendable<T> = [
    T,
  ] extends [
    AnyExtendable,
  ]
    ? Plugin<InferMetadata<T>, InferDefinitions<T>>
    : T extends AnyPlugin
      ? T
      : T extends Array<infer U>
        ? InferPluginFromExtendable<U>[]
        : never

  export type InferUseFromDependencies<Deps> = [
    Deps,
  ] extends [
    never,
  ]
    ? UseAnyDependency
    : Deps extends DependencyList<infer D>
      ? Dependencies<D>
      : UseAnyDependency
}
