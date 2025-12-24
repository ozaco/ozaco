import type { EmptyType } from 'std:shared'

import type { PLUGIN } from '../const'

import type { Helpers } from './helpers'

export interface Plugin<Meta extends Helpers.AnyMetadata, Api = EmptyType> {
  _t: typeof PLUGIN
  _e: Helpers.AnyExtendable

  namespace: Required<Meta>['namespace']
  name: Required<Meta>['name']
  version: Required<Meta>['version']

  api: Api

  get: Helpers.DefinitionUse

  use: <Deps extends Helpers.AnyDependencyList = never>(
    list: Deps,
    deps: Helpers.InferUseFromDependencies<Deps>,
  ) => Plugin<Meta, Api>

  unuse: <Deps extends Helpers.AnyDependencyList = never>(
    list: Deps,
    deps: Helpers.InferUseFromDependencies<Deps>,
  ) => Plugin<Meta, Api>
}
