
import { spawn } from 'child_process'
import { access } from 'fs/promises'
import { Readable } from 'stream'
import { isEmptyString, Opts } from './lambda-plugin'

async function listFiles (file: string, stdin: Readable): Promise<string[]> {
  if (file !== '-') {
    return [file] // already trimmed
  }
  stdin.resume()
  let buffer: string = ''
  let files: string[] = []
  for await (const chunk of stdin) {
    buffer += (chunk as string | Buffer).toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    files = files.concat(lines)
  }
  files.push(buffer)
  return files
    .map(file => file.trim())
    .filter(file => !(file === '' || file.startsWith('#')))
}

/* eslint-disable-next-line @typescript-eslint/promise-function-async */
function simpleSpawn (cmd: string, args: string[]): Promise<{ code: number, out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args)
    const chunks: Buffer[] = []
    p.stderr.on('data', out => chunks.push(out))
    p.stdout.on('data', out => chunks.push(out))
    p.on('error', error => resolve({ code: 1, out: error.stack ?? String(error) }))
    p.on('exit', code => {
      resolve({ code: code ?? 0, out: Buffer.concat(chunks).toString() })
    })
  })
}

interface FoundFile {
  date: string
  time: string
  size: string
  file: string
}

async function findFile (file: string, bucket: string): Promise<FoundFile | undefined> {
  const location = `${bucket}/${file}`
  const { out, code } = await simpleSpawn('aws', ['s3', 'ls', location])
  if (code === 0) {
    for (const s3Line of out.split('\n')) {
      const [date, time, size, foundFile] = s3Line.split(/\s+/)
      if (foundFile === file) {
        return { date, time, size, file }
      }
    }
  }
}

async function upload (file: string, bucket: string): Promise<string> {
  const { out, code } = await simpleSpawn('aws', ['s3', 'cp', file, bucket])
  if (code !== 0) {
    throw new Error(`Error while uploading ${file} to ${bucket}: ${out}`)
  }
  return `${bucket}/${file}`
}

export default async function s3 (args: string[], opts: Opts, stdin: Readable): Promise<number> {
  const { force, error, out } = opts
  const [input, bucket] = args
  if (isEmptyString(input)) {
    error('Argument Error: first command line argument - input - needs to be defined.')
    return 2
  }
  if (isEmptyString(bucket)) {
    error('Argument Error: second command line argument - bucket - needs to be defined.')
    return 3
  }
  const files = await listFiles(input, stdin)
  if (files.length === 0) {
    error('No files to deploy')
    return 4
  }
  if (!force) {
    const foundFiles = (await Promise.all(files.map(async file => await findFile(file, bucket)))).filter(Boolean) as FoundFile[]
    if (foundFiles.length === files.length) {
      out(
        { files: foundFiles },
        ({ files }) => 'pre-existing: ' + files.map(file => `${bucket}/${file.file}`).join('\n'),
        ({ files }) => `Already deployed, no redeploy with -f flag:
 - ${files.map(({ date, time, file }) => `${date} ${time} ${file}`).join('\n - ')}
`
      )
      return 0
    }
    if (foundFiles.length > 0) {
      out(
        { files: foundFiles },
        ({ files }) => 'unchanged: ' + files.map(file => `${bucket}/${file.file}`).join('\n'),
        ({ files }) => `Deploy to s3 cancelled. Already deployed file found!

Every deploy should have an unique file name (maybe update the package version?)
If you wish to deploy anyways: pass in the -f option.

Following files already deployed:

 - ${files.map(({ date, time, size, file }) => `${date} ${time} ${size} ${bucket}/${file}`).join('\n - ')}
`
      )
      return 5
    }
  }
  await Promise.all(files.map(async file => await access(file)))
  const uploaded = await Promise.all(files.map(async file => await upload(file, bucket)))
  out(
    { files: uploaded },
    ({ files }) => 'uploaded: ' + files.join('\n'),
    ({ files }) => `Uploaded following plugins:

 - ${files.join('\n - ')}
`
  )
  return 0
}
