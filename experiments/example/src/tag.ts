import { Tags } from '@ozaco/std/results'

export const exampleTags = Tags.create('experiments/example')
  .add('not-found')
  .add('invalid-arguments')

  // causes
  .add('get-user')
  .add('say-hi')
  .add('write')
