import { $fn, $safe, Tags, capsule } from '../../results'
import type { BlobType, EmptyType } from '../../shared'

import { pluginTags } from '../tag'
import { mergeArgs } from './internal/merge-args'

export const createPlugin = capsule(
  <const M extends Std.Plugin.Meta<BlobType, BlobType>, O extends BlobType[]>(
    meta: M,
    ...defaultOptions: O
  ): Std.Plugin.Plugin<M, O, EmptyType, Tags<never, `${M['name']}@${M['version']}`>, []> => {
    const actions: BlobType[] = []
    const tags = new Tags(`${meta.name}@${meta.version}`)

    const plugin = (async (...options: Partial<O>) => {
      const api: BlobType = {}

      const instance = {
        meta,
        options: mergeArgs(defaultOptions, options),
        dependencies: [],
        tags,
      }

      for (const action of actions) {
        const actionName = (action as BlobType).$name as string
        const actionContext = {
          name: actionName,

          $fn: (name: string, cb: BlobType) => {
            if (!tags.has(`${actionName}/${name}`)) {
              tags.add(`${actionName}/${name}`)
            }

            return $fn(cb, tags.get(`${actionName}/${name}` as BlobType))
          },
          $safe: (name: string, cb: BlobType) => {
            if (!tags.has(`${actionName}/${name}`)) {
              tags.add(`${actionName}/${name}`)
            }

            return $safe(cb, tags.get(`${actionName}/${name}` as BlobType))
          },

          apply: (actions: BlobType) => {
            return Object.assign(actionContext, actions)
          },

          tags: tags,
          meta: instance.meta,
          options: instance.options,
          dependencies: instance.dependencies,
        }

        const actionResult = await action(actionContext).unwrap()

        Reflect.deleteProperty(actionResult, 'name')
        Reflect.deleteProperty(actionResult, '$fn')
        Reflect.deleteProperty(actionResult, '$safe')
        Reflect.deleteProperty(actionResult, 'apply')
        Reflect.deleteProperty(actionResult, 'meta')
        Reflect.deleteProperty(actionResult, 'options')
        Reflect.deleteProperty(actionResult, 'dependencies')
        Reflect.deleteProperty(actionResult, 'tags')

        api[(action as BlobType).$name] = actionResult
      }

      Object.assign(instance, api)

      return instance
    }) as Std.Plugin.Plugin<M, O, EmptyType, Tags<never, `${M['name']}@${M['version']}`>, []>

    plugin.meta = Object.seal(meta)
    plugin.defaultOptions = Object.seal(defaultOptions)

    plugin.action = (name, cb) => {
      if (!tags.has(name)) {
        tags.add(name)
      }

      const action = $fn(cb, tags.get(name as BlobType) as BlobType) as BlobType
      action.$name = name

      return action
    }

    plugin.register = cb => {
      actions.push(cb as Std.Plugin.Action<Std.Plugin.AnyActionContext>)

      return plugin as BlobType
    }

    return plugin
  },
  pluginTags.get('create')
)
