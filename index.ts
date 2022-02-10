import type { SpawnOptions } from 'child_process'
import { spawn } from 'child_process'
import { mkdir, readFile, writeFile, stat, utimes } from 'fs/promises'
import dbg from 'debug'
import * as path from 'path'

const debug = dbg('@tradle/lambda-plugins')

const DEFAULT_TMP_DIR = '/tmp'
const DEFAULT_MAX_AGE = 1000 * 60 * 2 // two minutes

const PLUGINS_FOLDER = 'plugins'
const PLUGINS_CACHE_FOLDER = 'plugins_cache'
const PLUGINS_FILE = '.plugins.installed'

function consumeOutput (data: Out[], type: number, binary: boolean): Buffer | string {
  const bin = Buffer.concat(
    data
      .filter(entry => (entry.type & type) !== 0)
      .map(({ data }) => data)
  )
  return binary ? bin : bin.toString()
}

interface SpawnOpts<T extends boolean> extends Pick<SpawnOptions, 'timeout' | 'env' | 'cwd'> {
  signal?: AbortSignal
  binary?: T
}

type StrBufPromise <T extends boolean> = T extends true ? Promise<Buffer> : Promise<string>

interface Out {
  type: number
  data: Buffer
}

function asyncSpawn <T extends boolean = false> (cmd: string, args: string[], opts: SpawnOpts<T>): StrBufPromise<T> {
  return new Promise((resolve, reject) => {
    const { timeout, env, cwd, signal, binary } = opts
    const out: Out[] = []

    const exit = (exitCode: number | null, err?: Error): void => {
      const stdout = consumeOutput(out, 0b01, binary ?? false)
      if (exitCode === 0) {
        resolve(stdout)
      } else {
        const stderr = consumeOutput(out, 0b10, binary ?? false)
        reject(Object.assign(
          err ?? new Error(`"${cmd} exited with code [${exitCode ?? 'null'}]: ${consumeOutput(out, 0b11, false).toString()}`),
          { exitCode, stdout, stderr, cmd, args }
        ))
      }
    }

    const p = spawn(cmd, args, { env, timeout, cwd, stdio: ['ignore', 'pipe', 'pipe'], signal })
      .on('error', err => exit(null, err))
      .on('close', exit)

    p.stdout.on('data', data => out.push({ type: 0b01, data }))
    p.stderr.on('data', data => out.push({ type: 0b10, data }))
  }) as StrBufPromise<T>
}

function execNpm <T extends boolean = false> (args: string[], opts: SpawnOpts<T> & { home: string, tmpDir: string }): StrBufPromise<T> {
  const { tmpDir, home } = opts
  const cache = path.join(tmpDir, PLUGINS_CACHE_FOLDER)
  return asyncSpawn('npm', [
    '--global', // By using global install we make sure that no additional cache is used
    '--no-fund', // We don't have output so we don't need fund messages
    '--no-audit', // Using audit could reveal plugins to Microsoft
    '--no-bin-links', // Installing binaries could be dangerous for the execution
    `--cache=${cache}`, // The installation process may need a writable cache
    `--prefix=${home}`, // Location where the eventual models are installed.
    '--prefer-offline', // if offline version is available, that should be used
    '--loglevel=error', // Minimum necessary log level
    '--no-package-lock', // We don't have a package-lock, no need to look for it
    '--no-update-notifier', // It doesn't matter if the npm version is old, we will not install a new one.
    ...args
  ], opts)
}

const isEmptyString = (input: string): boolean => /^\s*$/.test(input)

async function npmPkgExec (pkgs: Set<string>, op: 'remove' | 'install', tmpDir: string, home: string): Promise<void> {
  try {
    debug('Running %s for %s', op, pkgs)
    const result = await execNpm([op, ...pkgs], { binary: true, tmpDir, home })
    debug('Npm %s output: %s', op, result)
  } catch (err) {
    debug('Error while %s: %s', op, err)
    throw err
  }
}

type FNOrResult <T> = T | Promise<T> | (() => T) | (() => Promise<T>)

async function toPromise <T> (input: FNOrResult<T>): Promise<T> {
  if (typeof input === 'function') {
    const p = (input as Function)()
    return await Promise.resolve(p)
  }
  return await Promise.resolve(input)
}

async function assertInstalled (plugins: FNOrResult<string[]>, { tmpDir, maxAge }: { tmpDir: string, maxAge: number }): Promise<{ home: string }> {
  const home = path.join(tmpDir, PLUGINS_FOLDER)
  const statePath = path.join(tmpDir, PLUGINS_FILE)
  const toInstall = new Set<string>()
  const toRemove = new Set<string>()
  let pluginList: string[] = []
  let writeState: boolean = false
  try {
    const now = Date.now()
    const stats = await stat(statePath)
    const max = now - maxAge
    if (stats.mtimeMs > max) {
      debug('State is too fresh (%s > %s), skip checking plugins.', stats.mtimeMs, max)
      return { home }
    }
    const [installed, pluginsRaw] = await Promise.all([
      readFile(statePath, 'utf8'),
      toPromise(plugins),
      utimes(statePath, now, now)
    ])
    pluginList = pluginsRaw.filter(entry => !isEmptyString(entry)).sort()
    writeState = true
    const state = pluginList.join(' ')
    if (installed === state) {
      debug('All required plugins installed, nothing to do.')
      return { home }
    }
    for (const installedPlugin of installed.split(' ')) {
      if (toInstall.has(installedPlugin)) {
        toInstall.delete(installedPlugin)
      } else {
        toRemove.add(installedPlugin)
      }
    }
    writeState = toInstall.size > 0 || toRemove.size > 0
  } catch (err) {
    debug('Error while accessing state at %s', statePath)
  }
  await mkdir(home, { recursive: true })

  // Remove first to free space as the space is limited.
  if (toRemove.size > 0) await npmPkgExec(toRemove, 'remove', tmpDir, home)
  if (toInstall.size > 0) await npmPkgExec(toInstall, 'install', tmpDir, home)

  if (writeState) {
    await writeFile(statePath, pluginList.join(' '))
  }
  return { home }
}

async function createPluginProxy ({ tmpDir, home }: { tmpDir: string, home: string }): Promise<{ [key: string]: Promise<any> }> {
  const { dependencies } = JSON.parse(await execNpm(['ls', '--depth=0', '--json'], { tmpDir, home }))

  const properties: { [key: string]: { get: () => any, enumerable: true } } = {}
  const inMemCache: { [key: string]: Promise<any> } = {}

  for (const name in dependencies) {
    if (typeof name === 'symbol') {
      // This should never occur as JSON.parse only returns key typed properties
      throw new Error(`${String(name)} is a Symbol, symbols are not supported as plugin names.`)
    }
    properties[name] = {
      enumerable: true,
      async get () {
        // Note: lib/node_modules is used when installing with --global
        const depPath = path.resolve(...[tmpDir, PLUGINS_FOLDER, 'lib', 'node_modules', ...name.split('/')])
        if (debug.enabled) debug(`Loading dependency ${name} from ${depPath}`)
        let loaded = inMemCache[name]
        if (loaded === undefined) {
          try {
            loaded = require(depPath)
          } catch (err) {
            try {
              loaded = await import(depPath)
            } catch (err2) {
              debug('After requiring failed, tried to import the module and that didnt work as well with following error', err)
              throw err
            }
          }
          inMemCache[name] = loaded
        }
        return await loaded
      }
    }
  }
  const result: { [key: string]: Promise<any> } = {}
  Object.defineProperties(result, properties)
  return result
}

export async function loadPlugins (plugins: FNOrResult<string[]>, { tmpDir, maxAge }: { tmpDir?: string, maxAge?: number } = {}): Promise<{ [key: string]: Promise<any> }> {
  tmpDir ??= DEFAULT_TMP_DIR
  maxAge ??= DEFAULT_MAX_AGE
  const { home } = await assertInstalled(plugins, { tmpDir, maxAge })
  return await createPluginProxy({ tmpDir, home })
}
