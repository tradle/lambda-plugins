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

## Options

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

By default the loading of plugins does not allow loose semver-version definitions.
Versions installed using semvers like `~1.0.0` or `1` or `>=1` are not allowed.
If you still want to use these, you need to pass the `strict = false` option.

```js
await loadPlugins(plugins, { strict: false })
```

By default there will be also no error if the installation of the plugins happens
to fail. In order to enable errors you need to pass `failQuietly=false`.

```js
await loadPlugins(plugins, { failQuietyl: false })
```

To install private packages you will need to specify an authentication token.

```js
await loadPlugins(plugins, { registryTokens: { 'host': 'token' } })
```

In practice it may look like:

```js
await loadPlugins(plugins, { registryTokens: { "registry.npmjs.org/": "npm_Fo2387C3auJep6agQr41NCDHXW2BDz1S07mf" } } )
```

Depending on the registry, there are different ways to get a token. Here is the
documentation for 

- [npm access token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
- [github registry token](https://docs.github.com/en/actions/publishing-packages/publishing-nodejs-packages#authenticating-to-the-destination-repository)

## Flow

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

## Development

The code here uses a pretty straightforward development model. The only thing that may not be
obvious is the example code in `sls-aws-example`. In order for that to work, we need do releases
manually. When you do a release:

1. Change the version number in the [package.json](./package.json)
2. In the `sls-aws-example` change the dependency to the same version as in the `package.json`.
3. Run `npm i` in the `sls-aws-example`.
4. Now add all files necessary should be prepared for the git commit.

Naturally when doing changes on this repo you should provide tests and expand on the example.
To test the changes you have made with the example, run the `npm run update-parent` command
in the `sls-aws-example` before deploying it to AWS.

## License

[MIT](./LICENSE)
