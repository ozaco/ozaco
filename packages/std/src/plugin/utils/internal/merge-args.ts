import type { BlobType } from '../../../shared'

export const mergeArgs = <O extends BlobType[]>(defaultArgs: O, args: Partial<O>): O => {
  const $args = [] as unknown as O

  for (let i = 0; i < args.length; i++) {
    if (args[i] === undefined) {
      $args.push(defaultArgs[i])

      continue
    }

    $args.push(args[i])
  }

  if (args.length < defaultArgs.length) {
    $args.push(...defaultArgs.slice(args.length))
  }

  return $args
}
