import { $fn, $safe, ResultAsync, Tags, capsule } from '../../results'
import type { BlobType, EmptyType } from '../../shared'

import { pluginTags } from '../tag'
import { mergeArgs } from './internal/merge-args'

const EXLUDED_KEYS = [
  'name',
  '$fn',
  '$safe',
  '$tag',
  '$peek',
  'apply',
  'meta',
  'options',
  'dependencies',
  'tags',
]

export const createPlugin = capsule(
  <const M extends Std.Plugin.Meta<BlobType, BlobType>, O extends BlobType[]>(
    meta: M,
    ...defaultOptions: O
  ): Std.Plugin.Plugin<M, O, EmptyType, Tags<never, `${M['name']}@${M['version']}`>, []> => {
    const actions: BlobType[] = []
    const tags = new Tags(`${meta.name}@${meta.version}`)

    type Plugin = Std.Plugin.Plugin<
      M,
      O,
      EmptyType,
      Tags<never, `${M['name']}@${M['version']}`>,
      []
    >

    const plugin = ((...options: Partial<O>) => {
      const api: BlobType = {}

      const instance = {
        meta,
        options: mergeArgs(defaultOptions, options),
        dependencies: [],
        tags,
      } as ReturnType<Plugin>

      let promises = [] as PromiseLike<BlobType>[]

      const handler = (name: string, result: Std.Result<BlobType, BlobType, BlobType[]>) => {
        const action = result.unwrap()
        const actionData: BlobType = {}

        for (const key in action) {
          if (EXLUDED_KEYS.includes(key)) {
            continue
          }

          actionData[key] = action[key]
        }

        api[name] = actionData
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

          $tag: (name: string, description: string) => {
            if (!tags.has(`${actionName}/${name}`)) {
              tags.add(`${actionName}/${name}`, description)
            }

            return actionContext
          },

          $peek: (cb: BlobType) => {
            return api[cb.$name]
          },

          apply: (actions: BlobType) => {
            return Object.assign(actionContext, actions)
          },

          tags: tags,
          meta: instance.meta,
          options: instance.options,
          dependencies: instance.dependencies,
        }

        const actionResult = action(actionContext)

        if (actionResult instanceof ResultAsync) {
          promises.push(actionResult.then(result => handler(action.$name, result)))
        } else {
          handler(action.$name, actionResult)
        }
      }

      Object.assign(instance, api)

      instance.wait = $fn(async () => {
        if (promises.length === 0) {
          return true as const
        }

        const localPromises = [...promises]
        promises = []

        await Promise.all(localPromises)

        return true as const
      }, pluginTags.get('wait'))

      return instance
    }) as Plugin

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
