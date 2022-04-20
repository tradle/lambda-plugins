import { Readable } from 'stream'

export interface TargetImpl {
  default: (args: string[], opts: Opts, stream: Readable) => Promise<number>
}

export interface Opts {
  force: boolean
  json: boolean
  quiet: boolean
  error: (message: string) => void
  out: <T extends Object>(obj: T, short: (input: T) => string, long: (input: T) => string) => void
}

export function isEmptyString (input: string | null | undefined): input is null | undefined {
  return input === null || input === undefined || input === ''
}

async function getTargetImpl (target: string): Promise<TargetImpl | undefined> {
  if (target === 's3') {
    return await import('./lambda-plugins-s3')
  }
}

function help (): void {
  console.log(`lambda-plugins s3 - s3://bucket/path

CLI tool based on the "aws" cli provided by amazon.

Common usage:

$ npm pack --loglevel silent | lambda-plugins - s3://bucket/path

to deploy packages. It will warn you if a given package already
exists and return the s3 paths to be used for looking up the
plugin. It also works in combination with lerna:

$ npx lerna exec "npm pack --loglevel silent | lambda-plugins s3 - s3://bucket"

to deploy several plugins in a plugin directory at once.

It is also possible to publish only simple file using:

$ lambda-plugins s3 myplugin.tgz s3://bucket/path

Note: Currently only deploying to s3 is supported.
`)
}

;(async function main () {
  let args = process.argv.slice(2)
  const target = args.shift()
  if (isEmptyString(target)) {
    help()
    return 1
  }
  const impl = await getTargetImpl(target)
  if (impl === undefined) {
    console.log('The first cli argument needs to be "s3", the currently only supported target.')
    return 1
  }
  const opts: Opts = {
    force: false,
    quiet: false,
    json: false,
    out: () => {},
    error: () => {}
  }
  args = args.map(arg => arg.trim()).filter(arg => {
    if (arg === '-f' || arg === '--force') {
      opts.force = true
      return false
    }
    if (arg === '--json') {
      opts.json = true
      return false
    }
    if (arg === '-q' || arg === '--quiet') {
      opts.quiet = true
      return false
    }
    return true
  })
  opts.error = opts.json
    ? error => console.log(JSON.stringify({ error }))
    : error => console.log(error.toString())
  opts.out = opts.quiet
    ? (obj, short, long) => console.log(short(obj))
    : opts.json
      ? (obj, short, long) => console.log(JSON.stringify(obj))
      : (obj, short, long) => console.log(long(obj))
  return await impl.default(args, opts, process.stdin)
})().then(
  code => process.exit(code),
  err => {
    console.error(err)
    process.exit(1)
  }
)
