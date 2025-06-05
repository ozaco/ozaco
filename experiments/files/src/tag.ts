import { Tags } from '@ozaco/std/results'

export const filesTags = Tags.create('experiments/files')
  // causes
  .add('not-file')

  // read-from
  .add('open-file', '$openFile')
  .add('read-from', '$readFrom')
