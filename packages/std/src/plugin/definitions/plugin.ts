import type { Tags } from '../../results'
import type { BlobType, EmptyType, Fn, Merge } from '../../shared'
import type { pluginTags } from '../tag'

declare global {
  namespace Std {
    // ------------- Errors -------------
    interface Error {
      'std/plugin': typeof pluginTags
    }

    namespace Plugin {
      interface Meta<N extends string, V extends string> {
        name: N
        version: V
      }

      interface PluginContext<M extends Std.Plugin.Meta<string, string>> {
        actions: Std.Plugin.Action<Std.Plugin.AnyActionContext>[]
        tags: Std.Plugin.BasePluginTags<M>
      }

      type PluginInstance<
        M extends Std.Plugin.Meta<string, string>,
        O extends BlobType[],
        R = EmptyType,
        T = Std.Plugin.BasePluginTags<M>,
        D extends Std.Plugin.AnyDependencies = EmptyType,
      > = {
        meta: M
        options: O
        dependencies: {
          [K in keyof D]: ReturnType<D[K]>
        }
        tags: T

        plug: <N extends keyof D, P extends D[N]>(
          name: N,
          plugin: ReturnType<P>
        ) => Std.Plugin.PluginInstance<M, O, R, T, D>
        wait: Fn<
          [],
          Std.ResultAsync<true, 'std/results.invalid-usage', `${M['name']}@${M['version']}#wait`[]>
        >
      } & R

      interface Plugin<
        M extends Std.Plugin.Meta<string, string>,
        O extends BlobType[],
        R = EmptyType,
        T = Std.Plugin.BasePluginTags<M>,
        D extends Std.Plugin.AnyDependencies = EmptyType,
      > {
        meta: Readonly<M>
        defaultOptions: Readonly<O>

        (): Std.Plugin.PluginInstance<M, O, R, T, D>
        (...options: O): Std.Plugin.PluginInstance<M, O, R, T, D>

        action: Std.Plugin.CreateActionHandler<M, O, R, T, D>
        register: Std.Plugin.CreateRegisterHandler<M, O, R, T, D>
        depends: <N extends string, P extends Std.Plugin.AnyPlugin>() => Std.Plugin.Plugin<
          M,
          O,
          R,
          T,
          Merge<D, { [K in N]: P }>
        >
      }

      type AnyPlugin = Std.Plugin.Plugin<BlobType, BlobType, BlobType, BlobType, BlobType>
      type AnyDependencies = Record<string, Std.Plugin.AnyPlugin>
      type BasePluginTags<M extends Std.Plugin.Meta<string, string>> = Tags<
        ['not-found', never] | ['wait', never] | ['get', never],
        `${M['name']}@${M['version']}`
      >
    }
  }
}
