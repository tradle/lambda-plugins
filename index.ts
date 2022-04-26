import { spawn, SpawnOptions } from 'child_process'
import { mkdir, readFile, writeFile, stat, utimes } from 'fs/promises'
import dbg from 'debug'
import * as path from 'path'
import PQueue from 'p-queue'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

const debug = dbg('@tradle/lambda-plugins')

const DEFAULT_TMP_DIR = '/tmp'
const DEFAULT_MAX_AGE = 1000 * 60 * 2 // two minutes

const PLUGINS_FOLDER = 'plugins'
const PLUGINS_CACHE_FOLDER = 'plugins_cache'
const PLUGINS_FILE = '.plugins.installed'

const S3_DOWNLOAD_CONCURRENCY = 10

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

async function npmPkgExec (pkgs: Iterable<string>, op: 'remove' | 'install', tmpDir: string, home: string): Promise<void> {
  try {
    const pkgArray = Array.from(pkgs)
    debug('Running %s for %s', op, pkgArray)
    const result = await execNpm([op, ...pkgArray], { binary: true, tmpDir, home })
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
  pluginsMap: { [key: string]: string }
}

interface StateFs {
  hash: string
  pluginsMap: { [key: string]: string }
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
    pluginsMap: {}
  }
}

interface ValidatedPluginDefinitions {
  [name: string]: string
}

export type PluginDefinitions = ValidatedPluginDefinitions | Map<string, string>

async function assertInstalled (plugins: FNOrResult<PluginDefinitions>, { tmpDir, maxAge, strict }: { tmpDir: string, maxAge: number, strict: boolean }): Promise<string[]> {
  const home = path.join(tmpDir, PLUGINS_FOLDER)
  const state = await readState({ tmpDir })
  const max = Date.now() - maxAge
  const stateNames = Object.keys(state.pluginsMap)
  if (state.timeMs !== undefined && state.timeMs >= max) {
    debug('State is too fresh (%s > %s), skip checking plugins assuming all installed.', state.timeMs, max)
    return stateNames
  }
  const pluginsMap = validatePluginDefinitions(await toPromise(plugins), strict)
  const hash = JSON.stringify(pluginsMap)
  if (state.hash === hash) {
    debug('All required plugins (%s) installed, nothing to do.', plugins)
    return stateNames
  }
  const installedNames = Object.keys(pluginsMap)
  const toInstall = new Map(Object.entries(pluginsMap))
  const toRemove = new Map(Object.entries(state.pluginsMap))
  for (const [name, version] of toRemove.entries()) {
    if (toInstall.get(name) === version) {
      toRemove.delete(name)
      toInstall.delete(name)
    }
  }
  if (toInstall.size === 0 && toRemove.size === 0) {
    state.timeMs = Date.now()
    try {
      await utimes(state.path, state.timeMs, state.timeMs)
    } catch (err) {
      debug('Cant update time of state at %s: %s', state.path, err)
    }
    return installedNames
  }
  try {
    await mkdir(home, { recursive: true })

    // Remove first to free space as the space is limited.
    if (toRemove.size > 0) await npmPkgExec(toRemove.keys(), 'remove', tmpDir, home)
    if (toInstall.size > 0) await npmPkgExec(await toInstallKeys(toInstall, strict), 'install', tmpDir, home)

    const stateFs: StateFs = {
      hash,
      pluginsMap
    }
    await writeFile(state.path, JSON.stringify(stateFs))
    return installedNames
  } catch (err) {
    debug('Error while installing the current plugins: %s, %s', installedNames, err)
    return []
  }
}

interface Cause {
  useImport: boolean
  cause: string
}

const CAUSE_FALLBACK: Cause = { cause: 'require', useImport: false }
const CAUSE_TYPE: Cause = { cause: 'import because of type=module', useImport: true }
const CAUSE_MODULE: Cause = { cause: 'import because of a defined module', useImport: true }
const CAUSE_DOT_EXPORT: Cause = { cause: 'import because of exports["."]', useImport: true }
const CAUSE_DOT_ANY: Cause = { cause: 'import because of exports["./*"]', useImport: true }

function fuzzyChooseImport (pkg: any): Cause {
  if (pkg.type === 'module') return CAUSE_TYPE
  if (pkg.module !== undefined) return CAUSE_MODULE
  if (typeof pkg.exports === 'object' && pkg.exports !== null) {
    if (pkg.exports['.']?.import !== undefined) {
      return CAUSE_DOT_EXPORT
    }
    if (pkg.exports['./*']?.import !== undefined) {
      return CAUSE_DOT_ANY
    }
  }
  return CAUSE_FALLBACK
}

async function loadData (name: string, depPath: string, pkg: any): Promise<any> {
  const { cause, useImport } = fuzzyChooseImport(pkg)
  debug('Loading package for %s from %s (%s)', name, depPath, cause)
  return useImport ? await import(depPath) : require(depPath)
}

async function loadPackage (name: string, depPath: string): Promise<any> {
  const pkgPath = path.join(depPath, 'package.json')
  debug('Loading package.json for %s from %s', name, pkgPath)
  const data = await readFile(pkgPath, 'utf-8')
  return JSON.parse(data)
}

export class Plugin {
  readonly name: string
  readonly path: string

  _data: Promise<any> | undefined
  _pkg: Promise<any> | undefined

  constructor (name: string, path: string) {
    this.name = name
    this.path = path
  }

  /* eslint-disable-next-line @typescript-eslint/promise-function-async */
  package ({ force }: { force?: boolean } = {}): Promise<any> {
    let pkg = this._pkg
    if (pkg === undefined || force !== true) {
      pkg = loadPackage(this.name, this.path)
      this._pkg = pkg
    }
    return pkg
  }

  /* eslint-disable-next-line @typescript-eslint/promise-function-async */
  data (opts?: { force?: boolean }): Promise<any> {
    let data = this._data
    if (data === undefined || opts?.force !== true) {
      /* eslint-disable-next-line @typescript-eslint/promise-function-async */
      data = this.package(opts).then(pkg => loadData(this.name, this.path, pkg))
      this._data = data
    }
    return data
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

export async function loadPlugins (plugins: FNOrResult<PluginDefinitions>, { tmpDir, maxAge, strict }: { tmpDir?: string, maxAge?: number, strict?: boolean } = {}): Promise<{ [key: string]: Plugin }> {
  tmpDir = tmpDir ?? DEFAULT_TMP_DIR
  maxAge = maxAge ?? DEFAULT_MAX_AGE
  strict = strict ?? true
  const names = await assertInstalled(plugins, { tmpDir, maxAge, strict })
  return await prepare({ tmpDir, names })
}

function validatePluginDefinition (key: string, value: string, index: number, strict: boolean): string {
  const e = `Entry #${index}`
  if (/\s/.test(key)) {
    throw new Error(`${e} has a name with a space in it, this is not acceptable. Use names without spaces!`)
  }
  if (/^\s*$/.test(key)) {
    throw new Error(`${e} has an empty name, but needs to be defined "${String(key)}"`)
  }
  if (value === '*' || value === '') {
    throw new Error(`${e} "${key}" can not be marked as "${value}" as a vague version is not cachable or secure!`)
  }
  const parts = /^(\^|~|>=|<|>|<=|==)?((\d+)(\.([0-9]+|x))?(\.([0-9]+|x))?(-[a-z0-9.]+)?(\+[a-z0-9.]+)?)?$/i.exec(value)
  if (parts !== null) {
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
    const [range, version, major, minor, _minorNum, patch, _patchNum] = parts.slice(1)
    if (strict) {
      if (range !== undefined || range === '') {
        throw new Error(`${e} "${key}" can not specify a version range "${range}" and needs to be just the version: ${version ?? '1.2.3'}`)
      }
      if (minor === undefined || patch === undefined) {
        throw new Error(`${e} "${key}" can not specify a vague version range "${major}${minor ?? '.x'}${patch ?? '.x'} (x needs to be defined!)`)
      }
    }
    return `${key}@${value}`
  } else {
    let url: URL
    try {
      url = new URL(value)
    } catch (err) {
      throw new Error(`${e} "${key}" needs to be either a (semver-)version like 1.2.3 or a valid URL: ${value}`)
    }
    if (url.protocol === 'github:') {
      if (!/^#[a-f0-9]{40}$/i.test(url.hash)) {
        const prevHash = url.hash
        url.hash = 'abcdef0123456789abcdef0123456789abcdef01'
        throw new Error(`${e} "${key}" is pointing to a github repository but it needs to specify a version hash like "${url.toString()}" instead of "${prevHash}"`)
      }
      return value
    }
    if (!(url.protocol === 'https:' || url.protocol === 's3:')) {
      throw new Error(`${e} "${key}" is specified with an unsupported protocol (${url.protocol}), supported protocols: https, s3, github. Input: ${value}`)
    }
    return value
  }
}

function sortByFirst ([a]: [string, string], [b]: [string, string]): number {
  if (a > b) return 1
  if (a < b) return -1
  return 0
}

export function validatePluginDefinitions (input: any, strict: boolean): ValidatedPluginDefinitions {
  const inputType = typeof input
  if (inputType !== 'object' || input === null) {
    throw new Error(`input needs to be an key/value object, is (${inputType}) ${String(input)}`)
  }
  const entries = Array.from(input instanceof Map ? input.entries() : Object.entries(input)).sort(sortByFirst)
  let index = 0
  const result: { [key: string]: string } = {}
  for (const [key, value] of entries) {
    validatePluginDefinition(key, value, index, strict)
    result[key] = value
    index += 1
  }
  return result
}

function isS3URL (input: string): boolean {
  return /^s3:/.test(input)
}

async function toInstallKeys (toInstall: Map<string, string>, strict: boolean): Promise<string[]> {
  let index = 0
  const installKeys: string[] = []
  const queue = new PQueue({
    concurrency: S3_DOWNLOAD_CONCURRENCY
  })
  for (const [name, version] of toInstall.entries()) {
    const key = validatePluginDefinition(name, version, index, strict)
    if (isS3URL(key)) {
      await queue.add(async (): Promise<void> => {
        installKeys.push(await resolveS3Target(key))
      })
    } else {
      installKeys.push(key)
    }
    index += 1
  }
  await queue.onEmpty()
  return installKeys
}

let tmpStorage: string | null = null

async function resolveS3Target (s3Path: string): Promise<string> {
  if (tmpStorage === null) {
    tmpStorage = mkdtempSync(path.join(tmpdir(), 'lambda-s3-download-'))
  }
  const localPath = path.join(tmpStorage, `${randomBytes(16).toString('hex')}.tgz`)
  debug('Downloading "%s" from s3 to "%s"', s3Path, localPath)
  const download = await import('./s3-download')
  await download.default(s3Path, localPath)
  return localPath
}
