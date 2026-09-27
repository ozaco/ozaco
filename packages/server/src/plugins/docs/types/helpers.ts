/** The shapes this plugin passes around inside itself. */
export namespace Helpers {
  /** What the plugin resolved about its install: the mount path, whether the observe console is
   * mounted, and the `Auth` install's `default` requirement (an action that sets no `auth` of its
   * own is documented as THAT, not as open). */
  export interface ManifestOptions {
    readonly path: string
    readonly console: boolean
    readonly defaultAuth: unknown
  }
}
