import { $fn, $safe, Tags, capsule, err } from '../../results'
import { type BlobType, isPromise } from '../../shared'

import { pluginTags } from '../tag'
import { mergeArgs } from './internal/merge-args'

export const createPlugin = capsule(
  <const M extends Std.Plugin.Meta<BlobType, BlobType, BlobType>>(
    meta: M
  ): Std.Plugin.BasePlugin<M> => {
    let actions: Std.Plugin.Actions.AnyAction[] = []

    const plugin = capsule(
      (...options: Std.Plugin.InferOptions<M>) => {
        const instance: Std.Plugin.Instance<M> = {
          meta: {
            ...meta,
            options: mergeArgs(meta.options ?? [], options),
          },

          dependencies: {},

          tags: new Tags(`${meta.name}@${meta.version}`).add('not-found') as Std.Plugin.BaseTags<M>,

          use: (name, dependency) => {
            instance.dependencies[name] = dependency

            return instance
          },
        }

        const promises: Promise<BlobType>[] = []

        for (const action of actions) {
          let api: BlobType = {}

          const ctx = {} as Std.Plugin.Actions.Context<BlobType, M, BlobType, BlobType, BlobType>

          Object.assign(ctx, instance, {
            apply: value => {
              if (value) {
                api = Object.assign(api, value ?? {})
              }

              return ctx
            },

            tag: (key, value) => {
              ctx.tags.add(`${action.$name}/${key}`, value)

              return ctx as BlobType
            },

            $peek: $fn(action => {
              if (Reflect.has(instance, action.$name)) {
                return (instance as BlobType)[action.$name]
              }

              return err(
                `${meta.name}@${meta.version}#${action.$name}/not-registered`,
                `action (${action.$name}) not registered`
              )
            }, `${meta.name}@${meta.version}#${action.$name}/peek`) as BlobType,

            $get: $fn(name => {
              if (Reflect.has(ctx.dependencies, name)) {
                return (ctx.dependencies as BlobType)[name]
              }

              return err(`${meta.name}@${meta.version}#not-found`, `plugin (${name}) not found`)
            }, `${meta.name}@${meta.version}#${action.$name}/get`) as BlobType,

            $fn: (name: string, cb: BlobType) => {
              ctx.tags.add(`${action.$name}/${name}`)

              return $fn(cb, ctx.tags.get(`${action.$name}/${name}` as BlobType)) as BlobType
            },

            $safe: (name: string, cb: BlobType) => {
              ctx.tags.add(`${action.$name}/${name}`)

              return $safe(cb, ctx.tags.get(`${action.$name}/${name}` as BlobType)) as BlobType
            },

            $capsule: (name, cb) => {
              ctx.tags.add(`${action.$name}/${name}`)

              return capsule(cb, ctx.tags.get(`${action.$name}/${name}`))
            },
          } satisfies Pick<
            Std.Plugin.Actions.Context<BlobType, M, BlobType, BlobType, BlobType>,
            'apply' | 'tag' | '$peek' | '$get' | '$fn' | '$safe' | '$capsule'
          >)

          const actionResult = action(ctx)

          // async action
          if (isPromise(actionResult)) {
            promises.push(
              actionResult.then(resultCtx => {
                Object.assign(instance, { [action.$name]: api })

                if (action.$direct) {
                  Object.assign(instance, instance[action.$name as keyof typeof instance])
                }

                instance.tags = resultCtx.tags
              })
            )

            continue
          }

          Object.assign(instance, { [action.$name]: api })

          if (action.$direct) {
            Object.assign(instance, instance[action.$name as keyof typeof instance])
          }

          instance.tags = actionResult.tags
        }

        actions = []

        if (promises.length > 0) {
          return Promise.all(promises).then(() => instance)
        }

        return Object.seal(instance)
      },
      `${meta.name as string}@${meta.version as string}#init`
    ) as Std.Plugin.BasePlugin<M>

    plugin.action = (name, cb) => {
      const action = capsule(
        cb,
        `${meta.name}@${meta.version}#${name}/init`
      ) as unknown as Std.Plugin.Actions.AnyAction

      action.$name = name
      action.$direct = false

      return action as BlobType
    }

    plugin.direct = (name, cb) => {
      const action = capsule(
        cb,
        `${meta.name}@${meta.version}#${name}/init`
      ) as unknown as Std.Plugin.Actions.AnyAction

      action.$name = name
      action.$direct = true

      return action as BlobType
    }

    plugin.register = action => {
      actions.push(action)

      return plugin as BlobType
    }

    plugin.depends = () => plugin as BlobType

    return Object.freeze(plugin)
  },
  pluginTags.get('create')
)
