import { loadPlugins } from '@tradle/lambda-plugins'
import * as dbg from 'debug'

const debug = dbg('lambda')

async function main (event: any, plugins: { [key: string]: Promise<any> }) {
  debug(event)
  const res: { [key: string]: any } = {}
  for (const key in plugins) {
    res[key] = await plugins[key]
  }
  return res
}

export async function hello (event: any): Promise<any> {
  const plugins = await loadPlugins(
    (process.env.PLUGINS ?? '').split(' ')
  )
  return {
    statusCode: 200,
    body: await main(event, plugins)
  }
}
