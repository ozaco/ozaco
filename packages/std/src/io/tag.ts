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
  .add('write-json', '$writeJson')

  // exists
  .add('exists', '$exists')
  .add('exists-sync', '$existsSync')

  // append
  .add('append', '$append')
  .add('append-sync', '$appendSync')

  // mkdir
  .add('mkdir', '$mkdir')
  .add('mkdir-sync', '$mkdirSync')

  // stats
  .add('stats', '$stats')
  .add('stats-sync', '$statsSync')
