import type { Tags } from '../../results'
import type { BlobType, EmptyType } from '../../shared'
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
        tags: Tags<never, `${M['name']}@${M['version']}`>
      }

      type PluginInstance<
        M extends Std.Plugin.Meta<string, string>,
        O extends BlobType[],
        R = EmptyType,
        T = Tags<never, `${M['name']}@${M['version']}`>,
        D = [],
      > = {
        meta: M
        options: O
        dependencies: D
        tags: T
      } & R

      interface Plugin<
        M extends Std.Plugin.Meta<string, string>,
        O extends BlobType[],
        R = EmptyType,
        T = Tags<never, `${M['name']}@${M['version']}`>,
        D = [],
      > {
        meta: Readonly<M>
        defaultOptions: Readonly<O>

        (): Promise<Std.Plugin.PluginInstance<M, O, R, T, D>>
        (...options: O): Promise<Std.Plugin.PluginInstance<M, O, R, T, D>>

        action: Std.Plugin.CreateActionHandler<M, O, R, T, D>
        register: Std.Plugin.CreateRegisterHandler<M, O, R, T, D>
      }

      type AnyPlugin = Std.Plugin.Plugin<BlobType, BlobType, BlobType, BlobType[]>
    }
  }
}
