import { Tags } from '../results'

export const loggerTags = Tags.create('std/logger')
  // ------------ Errors ------------
  .add('create')
  .add('trace')
  .add('debug')
  .add('log')
  .add('info')
  .add('success')
  .add('err')
  .add('warn')
  .add('transport')
  .add('call-transports')

  // ------------ Transports ------------
  .add('file-transport')
