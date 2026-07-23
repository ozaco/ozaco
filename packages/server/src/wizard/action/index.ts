export * from './define'
// the CRUD builder stays internal, but its result types must be nameable in resource type emit
export type { CrudListArgs, CrudModule } from './crud'
