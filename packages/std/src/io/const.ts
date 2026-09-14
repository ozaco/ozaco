// oxlint-disable typescript/prefer-literal-enum-member

/** Filesystem bitflags: combine with `|`, test with `hasFlag`. Bits are allocated from bit 0. */
export enum IO_FLAGS {
  NONE = 0,
  /** `walk`: follow symlinks (`stat` instead of `lstat`). */
  FOLLOW_SYMLINKS = 1 << 0,
  /** `walk`: collect files. */
  FILES = 1 << 1,
  /** `walk`: collect directories. */
  DIRS = 1 << 2,
  /** `write`/`writeFlow`: append instead of truncating. */
  APPEND = 1 << 3,
  /** `write`/`writeFlow`/`copy`/`rename`: fail if the target already exists. */
  EXCLUSIVE = 1 << 4,
}
