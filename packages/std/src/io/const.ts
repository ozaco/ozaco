// oxlint-disable typescript/prefer-literal-enum-member

export enum IO_FLAGS {
  NONE = 0,
  FOLLOW_SYMLINKS = 1 << 2,
  FILES = 1 << 3,
  DIRS = 1 << 4,
  APPEND = 1 << 5,
  EXCLUSIVE = 1 << 6,
}
