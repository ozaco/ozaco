import type { Tags } from '../../results'
import type { BlobType, EmptyType, Fn } from '../../shared'

declare global {
  namespace Std {
    namespace Plugin {
      type $Fn<N extends string, M extends Std.Plugin.Meta<BlobType, BlobType>> = <
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

      interface $Safe<N extends string, M extends Std.Plugin.Meta<BlobType, BlobType>> {
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

      interface ActionContext<
        An extends string,
        M extends Std.Plugin.Meta<string, string>,
        O extends BlobType[],
        R = EmptyType,
        T = Tags<never, `${M['name']}@${M['version']}`>,
        D = [],
      > {
        name: An
        meta: M
        options: O
        tags: Std.MergeTags<T, Tags<[An, never], `${M['name']}@${M['version']}`>>
        dependencies: D

        $fn: Std.Plugin.$Fn<An, M>
        $safe: Std.Plugin.$Safe<An, M>
        $throw: <N extends string>(
          name: N,
          message: string
        ) => Std.Plugin.ActionContext<
          An,
          M,
          O,
          R,
          Std.MergeTags<T, Tags<[`${An}/${N}`, never], `${M['name']}@${M['version']}`>>,
          D
        >

        apply: <C extends EmptyType>(
          actions: C
        ) => Std.Plugin.ActionContext<
          An,
          M,
          O,
          R & C,
          Std.MergeTags<
            T,
            Tags<
              {
                [K in keyof C]: K extends string ? [`${An}/${K}`, never] : never
              }[keyof C],
              `${M['name']}@${M['version']}`
            >
          >,
          D
        >
      }

      type Action<Ac extends Std.Plugin.AnyActionContext> = Fn<
        [context: Ac],
        Std.InjectedResult<
          Ac,
          'std/results.invalid-usage',
          `${Ac['meta']['name']}@${Ac['meta']['version']}#${Ac['name']}`[]
        >
      >

      type CreateActionHandler<
        M extends Std.Plugin.Meta<string, string>,
        O extends BlobType[],
        R = EmptyType,
        T = Tags<never, `${M['name']}@${M['version']}`>,
        D = [],
      > = <N extends string, R2 extends BlobType>(
        name: N,
        cb: Fn<[context: Std.Plugin.ActionContext<N, M, O, R, T, D>], R2>
      ) => R2 extends Std.Plugin.ActionContext<
        N,
        BlobType,
        BlobType[],
        infer R3,
        infer T2,
        BlobType[]
      >
        ? Std.Plugin.Action<
            Std.Plugin.ActionContext<
              N,
              M,
              O,
              R3,
              Std.MergeTags<Std.MergeTags<T, T2>, Tags<[N, never], `${M['name']}@${M['version']}`>>,
              D
            >
          >
        : never

      type CreateRegisterHandler<
        M extends Std.Plugin.Meta<string, string>,
        O extends BlobType[],
        R = EmptyType,
        T = Tags<never, `${M['name']}@${M['version']}`>,
        D = [],
      > = <Ac>(action: Ac) => Ac extends Std.Plugin.Action<
        Std.Plugin.ActionContext<infer An, BlobType, BlobType, infer R2, infer T2, BlobType>
      >
        ? Std.Plugin.Plugin<
            M,
            O,
            R & {
              [K in An]: R2
            },
            Std.MergeTags<T, T2>,
            D
          >
        : Std.Plugin.Plugin<M, O, R, T, D>

      type AnyActionContext = Std.Plugin.ActionContext<
        BlobType,
        BlobType,
        BlobType,
        BlobType,
        BlobType,
        BlobType
      >
    }
  }
}
