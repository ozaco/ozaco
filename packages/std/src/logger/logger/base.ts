import { createPlugin } from '../../plugin'

export const loggerPluginBase = createPlugin({
  name: 'logger',
  version: '0.0.0',

  options: [] as unknown as Std.Logger.Options,
}).depends<string, Std.Logger.AnyTransport>()
