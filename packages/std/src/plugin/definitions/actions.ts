import type { Tags } from '../../results'
import type { BlobType, EmptyType, Fn, Merge } from '../../shared'

declare global {
  namespace Std {
    namespace Plugin {
      namespace Actions {
        type $Capsule = <A extends BlobType[], R>(name: string, fn: (...args: A) => R) => Fn<A, R>

        type $Fn<N extends string, M extends Std.Plugin.AnyMeta> = <
          T extends string,
          A extends BlobType[],
          R,
        >(
          name: T,
          cb: Fn<A, R>
        ) => Fn<
          A,
          Std.InjectedResult<
            R,
            'std/results.invalid-usage',
            `${M['name']}@${M['version']}#${N}/${T}`[]
          >
        >

        interface $Safe<N extends string, M extends Std.Plugin.AnyMeta> {
          <T extends string, A extends BlobType[], R, R2>(
            name: T,
            body: (...args: A) => Generator<R, R2>
          ): Fn<
            A,
            Std.InjectedResult<
              R | R2,
              'std/results.invalid-usage',
              `${M['name']}@${M['version']}#${N}/${T}`[]
            >
          >
          <T extends string, A extends BlobType[], R, R2>(
            name: T,
            body: (...args: A) => AsyncGenerator<R, R2>
          ): Fn<
            A,
            Std.InjectedResult<
              (R extends never ? never : Promise<R>) | (R2 extends never ? never : Promise<R2>),
              'std/results.invalid-usage',
              `${M['name']}@${M['version']}#${N}/${T}`[]
            >
          >
          <T extends string, A extends BlobType[], R, R2, R3, R4>(
            name: T,
            body: ((...args: A) => AsyncGenerator<R, R2>) | ((...args: A) => Generator<R3, R4>)
          ): Fn<
            A,
            Std.InjectedResult<
              | (R extends never ? never : Promise<R>)
              | (R2 extends never ? never : Promise<R2>)
              | R3
              | R4,
              'std/results.invalid-usage',
              `${M['name']}@${M['version']}#${N}/${T}`[]
            >
          >
        }

        interface Context<
          N extends string,
          M extends Std.Plugin.AnyMeta,
          R = EmptyType,
          T = Std.Plugin.BaseTags<M>,
          D extends Std.Plugin.AnyDependency = EmptyType,
        > {
          meta: M
          tags: T
          dependencies: D

          tag: <K extends string>(
            key: K,
            value?: string
          ) => Std.Plugin.Actions.Context<
            N,
            M,
            R,
            Std.MergeTags<T, Tags<[`${N}/${K}`, never], `${M['name']}@${M['version']}`>>,
            D
          >

          apply: <V>(value: V) => Std.Plugin.Actions.Context<
            N,
            M,
            Merge<R, V>,
            Std.MergeTags<
              T,
              Tags<
                {
                  [K in keyof V]: K extends string ? [`${N}/${K}`, never] : never
                }[keyof V],
                `${M['name']}@${M['version']}`
              >
            >,
            D
          >

          $peek: <A extends Std.Plugin.Actions.AnyAction>(
            action: A
          ) => Std.Plugin.Actions.CheckIsSync<A> extends true
            ? Std.Result<
                Std.Plugin.Actions.InferActionResult<A>,
                `${M['name']}@${M['version']}#${Std.Plugin.Actions.InferActionName<A>}/not-registerd`,
                `${M['name']}@${M['version']}#${N}/peek`[]
              >
            : Std.ResultAsync<
                Std.Plugin.Actions.InferActionResult<A>,
                `${M['name']}@${M['version']}#${Std.Plugin.Actions.InferActionName<A>}/not-registered`,
                `${M['name']}@${M['version']}#${N}/peek`[]
              >

          $get: <Pn extends keyof D>(
            name: Pn
          ) => Std.Result<
            D[Pn],
            `${M['name']}@${M['version']}#not-found`,
            `${M['name']}@${M['version']}#${N}/get`[]
          >

          $fn: Std.Plugin.Actions.$Fn<N, M>
          $safe: Std.Plugin.Actions.$Safe<N, M>
          $capsule: Std.Plugin.Actions.$Capsule
        }

        interface Sync<
          N extends string,
          M extends Std.Plugin.AnyMeta,
          R = EmptyType,
          T = Std.Plugin.BaseTags<M>,
          D extends Std.Plugin.AnyDependency = EmptyType,
          Di extends boolean = false,
        > {
          $name: N
          $direct: Di

          (
            ctx: Std.Plugin.Actions.Context<N, M, EmptyType, T, D>
          ): Std.Plugin.Actions.Context<N, M, R, T, D>
        }

        interface Async<
          N extends string,
          M extends Std.Plugin.AnyMeta,
          R = EmptyType,
          T = Std.Plugin.BaseTags<M>,
          D extends Std.Plugin.AnyDependency = EmptyType,
          Di extends boolean = false,
        > {
          $name: N
          $direct: Di

          (
            ctx: Std.Plugin.Actions.Context<N, M, EmptyType, T, D>
          ): Promise<Std.Plugin.Actions.Context<N, M, R, T, D>>
        }

        // Context shortcuts

        type InferResult<C> = C extends Std.Plugin.Actions.Context<
          BlobType,
          BlobType,
          infer R,
          BlobType,
          BlobType
        >
          ? R
          : never

        type InferTags<C> = C extends Std.Plugin.Actions.Context<
          BlobType,
          BlobType,
          BlobType,
          infer T,
          BlobType
        >
          ? T
          : never

        // Action Shortcuts

        type AnySyncAction = Std.Plugin.Actions.Sync<
          BlobType,
          BlobType,
          BlobType,
          BlobType,
          BlobType,
          BlobType
        >
        type AnyAsyncAction = Std.Plugin.Actions.Async<
          BlobType,
          BlobType,
          BlobType,
          BlobType,
          BlobType,
          BlobType
        >
        type AnyAction = Std.Plugin.Actions.AnySyncAction | Std.Plugin.Actions.AnyAsyncAction

        type InferDirect<A> = A extends Std.Plugin.Actions.Sync<
          BlobType,
          BlobType,
          BlobType,
          BlobType,
          BlobType,
          infer Di
        >
          ? Di
          : A extends Std.Plugin.Actions.Async<
                BlobType,
                BlobType,
                BlobType,
                BlobType,
                BlobType,
                infer Di
              >
            ? Di
            : never

        type InferActionResult<A> = A extends Std.Plugin.Actions.Sync<
          BlobType,
          BlobType,
          infer R,
          BlobType,
          BlobType,
          BlobType
        >
          ? R
          : A extends Std.Plugin.Actions.Async<
                BlobType,
                BlobType,
                infer R,
                BlobType,
                BlobType,
                BlobType
              >
            ? R
            : never

        type CheckIsSync<A extends Std.Plugin.Actions.AnyAction> = ReturnType<A> extends Awaited<
          ReturnType<A>
        >
          ? true
          : false

        type InferContext<A> = A extends Std.Plugin.Actions.AnyAction
          ? Awaited<ReturnType<A>>
          : never

        type InferActionName<A extends Std.Plugin.Actions.AnyAction> = Awaited<
          ReturnType<A>
        > extends Std.Plugin.Actions.Context<infer N, BlobType, BlobType, BlobType, BlobType>
          ? N
          : never
      }
    }
  }
}
