import { createPlugin } from '../../plugin'

export const loggerPluginBase = createPlugin({
  name: 'logger',

  options: [] as unknown as Std.Logger.Options,
  version: '0.0.0',
}).depends<string, Std.Logger.AnyTransport>()
