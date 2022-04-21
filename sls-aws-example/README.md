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

---

Find all the code in [`./handler.ts`](./handler.ts).

