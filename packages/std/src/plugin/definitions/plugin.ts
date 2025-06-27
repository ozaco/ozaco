import type { Tags } from '../../results'
import type { BlobType, EmptyType, Fn, Merge, Promisify } from '../../shared'

import type { pluginTags } from '../tag'

declare global {
  namespace Std {
    // ------------- Errors -------------
    interface Error {
      'std/plugin': typeof pluginTags
    }

    namespace Plugin {
      interface Signal<T> {
        (): T
        (cb: Fn<[curr: T], T>): T
        (newValue: T): T
      }

      interface Meta<N extends string, V extends string, O extends BlobType[] = BlobType[]> {
        name: N
        version: V
        options?: O
      }

      type Instance<
        M extends Std.Plugin.AnyMeta,
        R = EmptyType,
        T = Std.Plugin.BaseTags<M>,
        D extends Std.Plugin.AnyDependency = EmptyType,
      > = {
        meta: M
        tags: T
        dependencies: D

        use: <N extends keyof D>(name: N, dependency: D[N]) => Instance<M, R, T, D>
      } & R

      interface Base<
        M extends Std.Plugin.AnyMeta,
        R = EmptyType,
        T = Std.Plugin.BaseTags<M>,
        D extends Std.Plugin.AnyDependency = EmptyType,
      > {
        readonly meta: M
        readonly tags: T

        direct: <N extends string, C extends Promisify<Std.Plugin.Actions.Context<N, M, BlobType, T, D>>>(
          name: N,

          cb: Fn<[context: Std.Plugin.Actions.Context<N, M, R, T, D>], C>,
        ) => Awaited<C> extends C
          ? Std.Plugin.Actions.Sync<N, M, Std.Plugin.Actions.InferResult<C>, Std.Plugin.Actions.InferTags<C>, D, true>
          : Std.Plugin.Actions.Async<
              N,
              M,
              Std.Plugin.Actions.InferResult<Awaited<C>>,
              Std.Plugin.Actions.InferTags<Awaited<C>>,
              D,
              true
            >

        action: <N extends string, C extends Promisify<Std.Plugin.Actions.Context<N, M, BlobType, T, D>>>(
          name: N,

          cb: Fn<[context: Std.Plugin.Actions.Context<N, M, R, T, D>], C>,
        ) => Awaited<C> extends C
          ? Std.Plugin.Actions.Sync<N, M, Std.Plugin.Actions.InferResult<C>, Std.Plugin.Actions.InferTags<C>, D, false>
          : Std.Plugin.Actions.Async<
              N,
              M,
              Std.Plugin.Actions.InferResult<Awaited<C>>,
              Std.Plugin.Actions.InferTags<Awaited<C>>,
              D,
              false
            >
      }

      interface Sync<
        M extends Std.Plugin.AnyMeta,
        R = EmptyType,
        T = Std.Plugin.BaseTags<M>,
        D extends Std.Plugin.AnyDependency = EmptyType,
      > extends Std.Plugin.Base<M, R, T, D> {
        (...args: Std.Plugin.InferOptions<M>): Std.Plugin.Instance<M, R, T, D>

        // always returns async
        register: <A extends Std.Plugin.Actions.AnyAction>(
          action: A,
        ) => A extends Std.Plugin.Actions.Sync<infer N, BlobType, infer R2, infer T2, BlobType, infer Di>
          ? Std.Plugin.Sync<
              M,
              Merge<
                R,
                Di extends true
                  ? R2
                  : {
                      [K in N]: R2
                    }
              >,
              Std.MergeTags<T, T2>,
              D
            >
          : A extends Std.Plugin.Actions.Async<infer N, BlobType, infer R2, infer T2, BlobType, infer Di>
            ? Std.Plugin.Async<
                M,
                Merge<
                  R,
                  Di extends true
                    ? R2
                    : {
                        [K in N]: R2
                      }
                >,
                Std.MergeTags<T, T2>,
                D
              >
            : never

        depends: <N extends string, P>() => Std.Plugin.Sync<
          M,
          R,
          T,
          Merge<
            D,
            {
              [K in N]: Std.Plugin.InferInstance<P>
            }
          >
        >
      }

      interface Async<
        M extends Std.Plugin.AnyMeta,
        R = EmptyType,
        T = Std.Plugin.BaseTags<M>,
        D extends Std.Plugin.AnyDependency = EmptyType,
      > extends Std.Plugin.Base<M, R, T, D> {
        (...args: Std.Plugin.InferOptions<M>): Promise<Std.Plugin.Instance<M, R, T, D>>

        // always returns async
        register: <A extends Std.Plugin.Actions.AnyAction>(
          action: A,
        ) => A extends Std.Plugin.Actions.Sync<infer N, BlobType, infer R2, infer T2, BlobType, infer Di>
          ? Std.Plugin.Async<
              M,
              Merge<
                R,
                Di extends true
                  ? R2
                  : {
                      [K in N]: R2
                    }
              >,
              Std.MergeTags<T, T2>,
              D
            >
          : A extends Std.Plugin.Actions.Async<infer N, BlobType, infer R2, infer T2, BlobType, infer Di>
            ? Std.Plugin.Async<
                M,
                Merge<
                  R,
                  Di extends true
                    ? R2
                    : {
                        [K in N]: R2
                      }
                >,
                Std.MergeTags<T, T2>,
                D
              >
            : never

        depends: <N extends string, P extends Std.Plugin.AnyPlugin>() => Std.Plugin.Async<
          M,
          R,
          T,
          Merge<
            D,
            {
              [K in N]: Std.Plugin.InferInstance<P>
            }
          >
        >
      }

      // Meta Shortcuts

      type AnyMeta = Std.Plugin.Meta<BlobType, BlobType, BlobType>
      type InferName<M> = M extends Std.Plugin.Meta<infer N, BlobType, BlobType> ? N : never
      type InferVersion<M> = M extends Std.Plugin.Meta<BlobType, infer V, BlobType> ? V : never
      type InferOptions<M> = M extends Std.Plugin.Meta<BlobType, BlobType, infer O> ? O : never

      // Tag Shortcuts

      type $BaseTags<N extends string, V extends string> = Tags<['not-found', never], `${N}@${V}`>

      type BaseTags<M extends Std.Plugin.Meta<BlobType, BlobType, BlobType>> = Std.Plugin.$BaseTags<
        Std.Plugin.InferName<M>,
        Std.Plugin.InferVersion<M>
      >

      // Plugin Shortcuts

      type AnyDependency = Record<string, Std.Plugin.AnyInstance>

      type AnyPlugin =
        | Std.Plugin.Sync<BlobType, BlobType, BlobType, BlobType>
        | Std.Plugin.Async<BlobType, BlobType, BlobType, BlobType>

      type BasePlugin<M extends Std.Plugin.Meta<BlobType, BlobType, BlobType>> = Std.Plugin.Sync<
        M,
        EmptyType,
        Std.Plugin.BaseTags<M>,
        EmptyType
      >

      type InferInstance<P> = P extends Std.Plugin.Sync<infer M, infer R, infer T, infer D>
        ? Std.Plugin.Instance<M, R, T, D>
        : P extends Std.Plugin.Async<infer M, infer R, infer T, infer D>
          ? Std.Plugin.Instance<M, R, T, D>
          : never

      type AnyInstance = Std.Plugin.Instance<BlobType, BlobType, BlobType, BlobType>
    }
  }
}
