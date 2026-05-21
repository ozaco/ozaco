import { IO } from 'std:io'

import { GreeterService } from './services/greeter'
import { UserService } from './services/user'

export const ENV = IO.actions.env(data => ({
  service: data.SERVICE,

  services: {
    user: UserService,
    greeter: GreeterService,
  },
}))
