# @tradle/lambda-plugins

Loader for additional npm packages based on configuration in lamdba function.

## How it works

Given a **list of npm packages** to load, this script will use npm install to
install the packages in the temporary directory and provide an accessor to the plugins to load.

## Usage with serverless

In this example we load the plugins from the envionment variable `PLUGINS` defined
in the lambda settings. You can also load the definitions from DynamoDB/S3/etc.

```js
import { loadPlugins } from '@tradle/lambda-plugins'

export async function example (event) {
  const plugins = await loadPlugins(
    (process.env.PLUGINS ?? '').split(' ')
  )

  for (const pluginName in plugins) {
      const plugin = plugins[pluginName] // Note that the plugins are loaded on-demand!
  }

  // ... the rest of your lambda code.
}
```

In this example the [npm packages][] are separated by a ` `, examples could be:

- `PLUGINS=` ... to load nothing
- `PLUGINS=moment` ... to load the [`moment`](https://npmjs.com/package/moment)
- `PLUGINS=moment lodash` ... to load both `moment` and [`lodash`](https://npmjs.com/package/lodash)
- `PLUGINS=moment@2.29.1` ... to load version 2.29.1 of `moment`
- `PLUGINS=github:tradle/constants` ... to load the [`tradle/constants`](https://github.com/tradle/constants)

etc.

[npm packages]: https://docs.npmjs.com/cli/v7/commands/npm-install#description

## Implementation details

By default it will install the packages in the `/tmp` folder. You can override
this by using the `{ tmpDir }` option:

```js
await loadPlugins(plugins, { tmpDir: '/other/tmp/dir' })
```

The `/tmp` folder persists between requests and every time `loadPlugins` is called,
it checks the timestamp of the previous run and only checks if new plugins need to
be installed if the last run was more than 2 minutes ago. You can override this by
using the `{ maxAge: 1000 }`
option:

```js
await loadPlugins(plugins, { maxAge: 1000 })
```

Here is a flow explanation:

```
[request]
→ does /tmp/plugins exist?
 Yes → was updated within the last 2 minutes?
 |  Yes → start
 |  No  → is /tmp/plugins is up-to-date?
 |     Yes → start
 |     No -\  
 |         |→ load plugins
 |         \→ start
 No -\
     |→ load plugins
     \→ start
```

Furthermore, this package uses `debug` and by adding the `DEBUG=*` environment
variable you can get insight on what happens.

## License

[MIT](./LICENSE)
