# @tradle/lambda-plugins

Loader for additional npm packages based on configuration in lamdba function.

## How it works

Given a list of npm packages to load, this script will use npm install to
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

## Implementation details

By default it will install the packages in the `/tmp` folder. You can override
this by using the `{ tmpDir }` option:

```js
await loadPlugins(plugins, { tmpDir: '/other/tmp/dir' })
```

It also memorizes when the last install was and only checks if the packages are
up-to-date every 2 minutes. You can override this by using the `{ maxAge: 1000 }`
option:

```js
await loadPlugins(plugins, { maxAge: 2000 })
```

Furthermore, this package uses `debug` and by adding the `DEBUG=*` environment
variable you can get insight on what happens.

## License

[MIT](./LICENSE)
