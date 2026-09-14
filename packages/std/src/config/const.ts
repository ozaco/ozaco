// oxlint-disable typescript/prefer-literal-enum-member

/**
 * Config discovery/merge features. IO-style bitflags: combine with `|`, test with `hasFlag`. Each
 * flag toggles one discovery layer (`VARIANT` needs an explicit `variant` option or `ENV` to know the
 * active variant); `Features.ALL` (the default) enables every layer. Bits are allocated from bit 0.
 */
export enum Features {
  NONE = 0,
  /** Read the base config file `.<name>.<ext>` (`<name>.<ext>` when `dot` is `false`) at each level. */
  FILE = 1 << 0,
  /** Walk parent directories from `cwd` up to `home`, merging outer → inner. */
  CHAIN = 1 << 1,
  /** Apply the active-variant overlay `.<variant>.<name>.<ext>` (wins within its level). */
  VARIANT = 1 << 2,
  /** Read the variant from `STD_CONFIG` and overlay `<NAME>_A_B` env vars as the top source. */
  ENV = 1 << 3,
  /** Also look inside a `.<name>/` directory at each level and merge its `*.<ext>` files recursively. */
  DIR = 1 << 4,

  ALL = FILE | CHAIN | VARIANT | ENV | DIR,
}

/** Default config name (basename of the discovered files). */
export const DEFAULT_NAME = 'ozaco'

/** Key inside a config file listing other files to inherit from (resolved relative to the file). */
export const EXTENDS_KEY = 'extends'

/** Env var naming the active variant when the `ENV` feature is on. */
export const VARIANT_ENV_KEY = 'STD_CONFIG'
