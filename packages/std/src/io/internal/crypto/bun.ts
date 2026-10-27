import type { Helpers } from '../../types/helpers'

/** `Bun.password` as the native hasher behind `IO.actions.password` (argon2id, bcrypt). */
export const bunPassword: Helpers.NativePassword = {
  hash: (plain, options) =>
    Bun.password.hash(
      plain,
      options.algorithm === 'bcrypt'
        ? { algorithm: 'bcrypt', ...(options.cost === undefined ? {} : { cost: options.cost }) }
        : {
            algorithm: 'argon2id',
            ...(options.memoryCost === undefined ? {} : { memoryCost: options.memoryCost }),
            ...(options.timeCost === undefined ? {} : { timeCost: options.timeCost }),
          },
    ),
  verify: (plain, digest) => Bun.password.verify(plain, digest),
}
