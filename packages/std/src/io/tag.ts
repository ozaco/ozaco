import { Tags } from '../results'

export const ioTags = Tags.create('std/io')
  .add('not-found')
  .add('invalid-mime')

  // ----- causes -----

  // env
  .add('extract-envs', 'extractEnvs')

  // read
  .add('read', '$read')
  .add('read-json', '$readJson')

  // write
  .add('write', '$write')
