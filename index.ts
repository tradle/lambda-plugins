import type { SpawnOptions } from 'child_process'
import { spawn } from 'child_process'
import { mkdir, readFile, writeFile, stat, utimes } from 'fs/promises'
import dbg from 'debug'
import * as path from 'path'
import { getMatcher, normalize } from './util'

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

interface State {
  path: string
  hash: string
  timeMs: number | undefined
  installed: string[]
  names: string[]
}

interface StateFs {
  hash: string
  installed: string[]
  names: string[]
}

async function readState ({ tmpDir }: { tmpDir: string }): Promise<State> {
  const statePath = path.join(tmpDir, PLUGINS_FILE)
  try {
    const [stats, stateRaw] = await Promise.all([
      stat(statePath),
      readFile(statePath, 'utf-8')
    ])
    try {
      const plugins = JSON.parse(stateRaw) as StateFs
      return {
        ...plugins,
        path: statePath,
        timeMs: stats.mtime.getTime()
      }
    } catch (err) {
      debug('Error while parsing json at %s: %s \n(raw: %s)', statePath, err, stateRaw)
    }
  } catch (err) {
    debug('Error while accessing state at %s: %s', statePath, err)
  }
  return {
    path: statePath,
    hash: '',
    timeMs: undefined,
    installed: [],
    names: []
  }
}

async function assertInstalled (plugins: FNOrResult<string[]>, { tmpDir, maxAge }: { tmpDir: string, maxAge: number }): Promise<string[]> {
  const home = path.join(tmpDir, PLUGINS_FOLDER)
  const state = await readState({ tmpDir })
  const max = Date.now() - maxAge
  if (state.timeMs !== undefined && state.timeMs >= max) {
    debug('State is too fresh (%s > %s), skip checking plugins assuming all installed.', state.timeMs, max)
    return state.names
  }
  const pluginList = (await toPromise(plugins)).filter(entry => !isEmptyString(entry)).sort()
  const toInstall = new Set<string>(pluginList)
  const toRemove = new Set<string>()
  const hash = pluginList.join(' ')
  if (state.hash === hash) {
    debug('All required plugins (%s) installed, nothing to do.', plugins)
    return state.names
  }
  for (const installedPlugin of state.installed) {
    if (toInstall.has(installedPlugin)) {
      toInstall.delete(installedPlugin)
    } else {
      toRemove.add(installedPlugin)
    }
  }
  if (toInstall.size === 0 && toRemove.size === 0) {
    state.timeMs = Date.now()
    try {
      await utimes(state.path, state.timeMs, state.timeMs)
    } catch (err) {
      debug('Cant update time of state at %s: %s', state.path, err)
    }
    return state.names
  }
  try {
    await mkdir(home, { recursive: true })

    // Remove first to free space as the space is limited.
    if (toRemove.size > 0) await npmPkgExec(toRemove, 'remove', tmpDir, home)
    if (toInstall.size > 0) await npmPkgExec(toInstall, 'install', tmpDir, home)

    const { dependencies } = JSON.parse(await execNpm(['ls', '--depth=0', '--json'], { tmpDir, home }))
    const names = Object.keys(dependencies)
    const stateFs: StateFs = {
      hash,
      installed: pluginList,
      names
    }
    await writeFile(state.path, JSON.stringify(stateFs))
    return names
  } catch (err) {
    debug('Error while installing the current plugins: %s, %s', pluginList)
    return []
  }
}

async function loadPackage (name: string, depPath: string): Promise<any> {
  const pkgPath = path.join(depPath, 'package.json')
  let raw = '{}'
  try {
    raw = await readFile(pkgPath, 'utf-8')
    debug('Using package.json for %s from %s', name, pkgPath)
  } catch (err) {
    // Package json is optional
    debug('No package.json found at %s, using regular lookup', pkgPath)
  }
  return JSON.parse(raw)
}

export class Plugin {
  readonly name: string
  readonly path: string

  #data: { [child: string]: Promise<any> } | undefined
  #pkg: Promise<any> | undefined

  constructor (name: string, path: string) {
    this.name = name
    this.path = path
  }

  /* eslint-disable-next-line @typescript-eslint/promise-function-async */
  package ({ force }: { force?: boolean } = {}): Promise<any> {
    let pkg = this.#pkg
    if (pkg === undefined || force !== true) {
      pkg = loadPackage(this.name, this.path)
      this.#pkg = pkg
    }
    return pkg
  }

  async #loadData (child: string, force: boolean): Promise<any> {
    const pkg = await this.package({ force })
    const matcher = getMatcher(this.path, pkg)
    const mjs = matcher(child, 'module')
    /* eslint-disable-next-line @typescript-eslint/prefer-optional-chain */
    if (mjs !== undefined && mjs.location !== null) {
      debug('Importing package for %s from %s (%s)', this.name, mjs.location, mjs.cause)
      return await import(mjs.location)
    }
    const cjs = matcher(child, 'commonjs')
    /* eslint-disable-next-line @typescript-eslint/prefer-optional-chain */
    if (cjs !== undefined && cjs.location !== null) {
      debug('Requiring package for %s from %s (%s)', this.name, cjs.location, cjs.cause)
      return require(cjs.location)
    }
    throw new Error(`Can not require or import a package for ${this.name} at ${this.path}`)
  }

  /* eslint-disable-next-line @typescript-eslint/promise-function-async */
  data (opts?: { force?: boolean, child?: string }): Promise<any> {
    const all = this.#data ?? (this.#data = {})
    const child = normalize(opts?.child)
    return all[child] ?? (all[child] = this.#loadData(child, opts?.force ?? false))
  }
}

async function prepare ({ tmpDir, names }: { tmpDir: string, names: string[] }): Promise<{ [key: string]: Plugin }> {
  const pluginBase = path.join(tmpDir, PLUGINS_FOLDER, 'lib', 'node_modules')
  const plugins: { [key: string]: Plugin } = {}
  for (const name of names) {
    // Note: lib/node_modules is used when installing with --global
    const depPath = path.resolve(pluginBase, ...name.split('/'))
    plugins[name] = new Plugin(name, depPath)
  }
  return plugins
}

export async function loadPlugins (plugins: FNOrResult<string[]>, { tmpDir, maxAge }: { tmpDir?: string, maxAge?: number } = {}): Promise<{ [key: string]: Plugin }> {
  tmpDir ??= DEFAULT_TMP_DIR
  maxAge ??= DEFAULT_MAX_AGE
  const names = await assertInstalled(plugins, { tmpDir, maxAge })
  return await prepare({ tmpDir, names })
}
