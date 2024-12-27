import { Tags } from '../results'

export const loggerTags = Tags.create('std/logger')
  // ------------ Errors ------------
  .add('create')
  .add('log')
  .add('err')
  .add('warn')
  .add('transport')
  .add('call-transports')

  // ------------ Transports ------------
  .add('file-transport')
