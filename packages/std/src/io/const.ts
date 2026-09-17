// oxlint-disable typescript/prefer-literal-enum-member

/** Filesystem bitflags: combine with `|`, test with `hasFlag`. Bits are allocated from bit 0. */
export enum IO_FLAGS {
  none = 0,
  /** `walk`: follow symlinks (`stat` instead of `lstat`). */
  followSymlinks = 1 << 0,
  /** `walk`: collect files. */
  files = 1 << 1,
  /** `walk`: collect directories. */
  dirs = 1 << 2,
  /** `write`/`writeFlow`: append instead of truncating. */
  append = 1 << 3,
  /** `write`/`writeFlow`/`copy`/`rename`: fail if the target already exists. */
  exclusive = 1 << 4,
}
