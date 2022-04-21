import { loadPlugins, Plugin } from '@tradle/lambda-plugins'
import * as dbg from 'debug'

const debug = dbg('lambda')

async function main (event: any, plugins: { [key: string]: Plugin }) {
  debug(event)
  const loaded: { [key: string]: any } = {}
  for (const plugin of Object.values(plugins)) {
    const [data, pkg] = await Promise.all([
      plugin.data(),
      plugin.package()
    ])
    loaded[plugin.name] = { data, pkg }
  }
  return {
    names: Object.keys(plugins),
    plugin: loaded
  }
}

export async function hello (event: any): Promise<any> {
  const plugins = await loadPlugins(
    JSON.parse(process.env.PLUGINS ?? '{}')
  )
  return {
    statusCode: 200,
    body: await main(event, plugins)
  }
}
