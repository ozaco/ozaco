import type { EventEmitter } from 'std:event'
import type { EmptyType, Expand, Merge } from 'std:shared'

import type { DEPENDENCY_LIST } from '../const'

import type { Context } from './context'
import type { Helpers } from './helpers'

export type DependencyListEvents = {
  extendable: Helpers.AnyExtendable

  add: [
    name: string,
    version: string,
  ]
  remove: [
    name: string,
    version: string,
  ]

  // TODO: onInit
}

export type DependencyListOptions<Deps extends EmptyType> = {
  [K in keyof Deps]: string
}

export type Dependencies<Deps> = {
  [K in keyof Deps]: Helpers.InferPluginFromExtendable<Deps[K]>
}

export interface DependencyList<Deps> extends Omit<Context<Map<keyof Deps, Deps[keyof Deps]>>, '_t' | 'event'> {
  _t: typeof DEPENDENCY_LIST

  add: <NewDeps extends EmptyType>(deps: DependencyListOptions<NewDeps>) => DependencyList<Expand<Merge<Deps, NewDeps>>>
  remove: <TargetDependencies extends EmptyType, Force extends boolean = false>(
    deps: DependencyListOptions<TargetDependencies>,
    force?: Force,
  ) => DependencyList<Force extends true ? Omit<Deps, keyof TargetDependencies> : Deps>

  getRequired: () => (keyof Deps)[]
  require: (...keys: (keyof Deps)[]) => DependencyList<Deps>
  optional: (...keys: (keyof Deps)[]) => DependencyList<Deps>

  event: EventEmitter<DependencyListEvents>
}
