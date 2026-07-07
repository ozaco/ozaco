// oxlint-disable typescript/prefer-literal-enum-member

/**
 * Config discovery/merge features. IO-style bitflags: combine with `|`, test with `hasFlag`. Each
 * flag toggles one discovery layer independently; `Features.ALL` (the default) enables every layer.
 */
export enum Features {
  NONE = 0,
  /** Read the base config file `<name>.<ext>` at each level. */
  FILE = 1 << 2,
  /** Walk parent directories from `cwd` up to `home`, merging outer → inner. */
  CHAIN = 1 << 3,
  /** Apply the active-variant overlay `<name>.<variant>.<ext>` (wins within its level). */
  VARIANT = 1 << 4,
  /** Merge fragment files `<name>.<fragment>.<ext>` (later name wins) above the base file. */
  FRAGMENT = 1 << 5,
  /** Read the variant from `STD_CONFIG` and overlay `<NAME>_A_B` env vars as the top source. */
  ENV = 1 << 6,
  /** Also look inside a `<name>/` directory at each level and merge the `*.<ext>` files in it. */
  DIR = 1 << 7,

  ALL = FILE | CHAIN | VARIANT | FRAGMENT | ENV | DIR,
}

/** Default config name (basename of the discovered files). */
export const DEFAULT_NAME = 'ozaco'

/** Key inside a config file listing other files to inherit from (resolved relative to the file). */
export const EXTENDS_KEY = 'extends'

/** Env var naming the active variant when the `ENV` feature is on. */
export const VARIANT_ENV_KEY = 'STD_CONFIG'
