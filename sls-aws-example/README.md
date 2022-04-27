# Serverless Plugin Loading Example

This folder contains a simple [serverless][] setup that can be deployed to your AWS account.

[serverless]: https://serverless.com

## Deploy Process

1. Run `npm install` in this folder. _(~2 min)_
2. Run `npx sls deploy` in this folder. _(~3 min)_
3. Run `npx sls invoke --function=hello` in this folder.

    It will show an output like:

    ```json
    {
        "statusCode": 200,
        "body": {
            "names": [],
            "plugin": {}
        }
    }
    ```

4. Go into your AWS console and add the environment variable `PLUGINS` to the new `plugin-example-main-dev-hello` function. You should find it at [this link][sls-fn]. You can specify [npm][] package definitions like `{"@tradle/constants": "2.5.1", "@tradle/errors": "2.0.1"}`. Dont forget to `SAVE`.

[sls-fn]: https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/plugin-example-main-dev-hello?tab=configure
[npm]: https://npmjs.com

5. Run `npx sls invoke --function=hello` again.

    The output should now be something like:

    ```js
    {
        "statusCode": 200,
        "body": {
            "names": [
                "@tradle/constants",
                "@tradle/errors"
            ],
            "plugin": {
                "@tradle/constants": {
                    "data": {
                        // ...
                    },
                    "pkg": {
                        // ...
                    }
                },
                "@tradle/errors": {
                    "data": {
                        // ...
                    },
                    "pkg": {
                        // ...
                    }
                }
            }
        }
    }
    ```

    Indicating that the new Plugins are available.
6. Optional: To try out private dependencies in s3 buckets, you can also upload a dependency to s3 using: `curl https://registry.npmjs.org/@tradle/errors/-/errors-2.0.1.tgz | aws s3 cp - s3://plugin-example-bucket/errors-2.0.1.tgz`
7. (continue) Then you can change the environment variable to: `{"@tradle/constants": "2.5.1", "@tradle/errors": "s3://plugin-example-bucket/errors-2.0.1.tgz"}`
8. (continue) Invoking `npx sls invoke --function=hello` will now download the dependency from s3!
9. Optional: Besides `PLUGINS` this example also allows to configure other options using the `PLUGIN_OPTS`
    environment variable. We can use this to test options. One particularly interesting is the installation
    of private packages from npm.
    
    _Note:_ In order to test [private packages][], you will be needing a paid-user or organization
    account!
10. (continue) [Publish a private package](https://docs.npmjs.com/creating-and-publishing-private-packages).
11. (continue) First we will be needing an [npm access token][access-token].
12. (continue) Then we set the environment variable `PLUGIN_OPTS`

    ```json
    { "registryTokens": { "registry.npmjs.org/": "<TOKEN_HERE>" } }
    ```
13. (continue) Change the `PLUGINS` variable to contain the private package to be loaded.
14. (continue) Now invoking `npx sls invoke --function=hello` will now show the private package.

[access-token]: https://docs.npmjs.com/creating-and-viewing-access-tokens
[private packages]: https://docs.npmjs.com/about-private-packages

---

Find all the code in [`./handler.ts`](./handler.ts).

