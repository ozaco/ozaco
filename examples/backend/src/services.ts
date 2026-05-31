import { GreeterService } from './services/greeter'
import { UserService } from './services/user'

/** The app's API surface — `createAppClient` infers its types straight from `typeof services`. */
export const services = { users: UserService, greeter: GreeterService }
export type Services = typeof services
