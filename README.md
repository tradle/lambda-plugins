# @tradle/lambda-plugins

Loader for additional npm packages based on configuration in lamdba function.

## How it works

Given a **list of npm packages** to load, this script will use npm install to
install the packages in the temporary directory and provide an accessor to the plugins to load.

## Usage with serverless

In this example we load the plugins from the envionment variable `PLUGINS` defined
in the lambda settings. In your project you can load definitions from DynamoDB/S3/etc.

```js
import { loadPlugins } from '@tradle/lambda-plugins'

export async function example (event) {
  const plugins = await loadPlugins(
    JSON.parse(process.env.PLUGINS ?? '{}')
  )

  for (const pluginName in plugins) {
    const plugin = plugins[pluginName]
    plugin.name === pluginName
    plugin.path // File path where the package is loaded from
    await plugin.package() // Loads the package.json for the package
    await plugin.data() // Loads the data
  }

  // ... the rest of your lambda code.
}
```

In this example the [npm packages][] are separated by a ` `, examples could be:

- `PLUGINS={}` ... to load nothing
- `PLUGINS={"moment":"2.29.1"}` ... to load the [`moment`][] package.
- `PLUGINS={"moment":"2.29.1", "lodash":"4.17.17"}` ... to load both the `moment` and
    the [`lodash`][] package.
- `PLUGINS={"moment":"https://github.com/lodash/lodash/archive/refs/tags/4.0.0.tar.gz"}`
    ... to load the _(old)_ `lodash` package via https.
- `PLUGINS={"quick-lru":"github:sindresorhus/quick-lru#771392878fc0e2325b1172d04260e87afe94c8f7"}`
    ... to load the `quick-lru` package directly from github.
- `PLUGINS={"moment":"s3://private-bucket/lodash-4.0.0.tar.gz"}` ... to load the `lodash`
    package from a secret, _ficitional_ s3 bucket.

etc.

[moment]: https://npmjs.com/package/moment
[lodash]: https://npmjs.com/package/lodash
[quick-lru]: https://github.com/sindresorhus/quick-lru
[npm packages]: https://docs.npmjs.com/cli/v7/commands/npm-install#description

## S3 Bucket loading

You can publish private packages to s3. These s3 packages get downloaded directly,
bypassing npm. In order for this to work you need to make sure that the lambda
has permission to access this bucket:

```yml
- Effect: 'Allow'
  Action:
    - "s3:GetObject"
  Resource:
    'arn:aws:s3:::private-bucket/*'
```

## Implementation details

By default it will install the packages in the `/tmp` folder. You can override
this by using the `{ tmpDir }` option:

```js
await loadPlugins(plugins, { tmpDir: '/other/tmp/dir' })
```

The `/tmp` folder persists between requests and every time `loadPlugins` is called,
it checks the timestamp of the previous run and only checks if new plugins need to
be installed if the last run was more than 2 minutes ago. You can override this by
using the `{ maxAge: 1000 }` option:

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
