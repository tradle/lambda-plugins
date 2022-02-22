import * as path from 'path'

interface Package {
  main?: string
  type?: string
  module?: string
  exports?: Definition | { [pattern: string]: Definition }
}

function isDefinition (map: any): map is Definition {
  if (map === 'string') {
    return true
  }
  if (typeof map !== 'object' || map === null) {
    return false
  }
  return (
    'default' in map ||
    'import' in map ||
    'node' in map ||
    'require' in map
  )
}

type Definition = string | null | {
  default?: string | null
  'import'?: string | null
  node?: string | null
  require?: string | null
}

interface Cause {
  cause: string
}

interface Import extends Cause {
  location: string | null
}

type Type = 'module' | 'commonjs'
type Matcher = (path: string, type: Type) => Import | undefined

function createLegacyMatcher (pkgPth: string, pkg: Package): Matcher {
  const pkgType = pkg.type === 'module' ? 'module' : 'commonjs'
  return (name, type) => {
    if (pkg.main !== undefined && type === pkgType) {
      return {
        cause: type === 'module' ? '.main and .type=module' : '.main',
        location: path.resolve(pkgPth, pkg.main)
      }
    }
    if (type === 'module' && pkg.module !== undefined) {
      return {
        cause: '.module',
        location: path.resolve(pkgPth, pkg.module)
      }
    }
    return undefined
  }
}

type PatternMatcher = (input: string) => string | undefined

function createPatternMatcher (pattern: string): PatternMatcher {
  const star = pattern.indexOf('*')
  let obj: { [name: string]: PatternMatcher } = {}
  if (star !== -1) {
    const prefix = pattern.substring(0, star)
    const start = prefix.length
    if (star !== pattern.length - 1) {
      const suffix = pattern.substring(star + 1)
      const end = suffix.length
      obj = {
        [pattern] (test) {
          if (test.startsWith(prefix) && test.endsWith(suffix)) {
            return test.substring(start, test.length - end)
          }
        }
      }
    } else {
      obj = {
        [pattern] (test) {
          if (test.startsWith(prefix)) {
            return test.substring(start)
          }
        }
      }
    }
  } else {
    obj = {
      [pattern] (test) {
        if (test === pattern) {
          return ''
        }
      }
    }
  }
  return obj[pattern]
}

function lookup (cause: string, pattern: string | null | undefined): ((input: string) => { cause: string, location: string | null }) | undefined {
  if (pattern === undefined) {
    return undefined
  }
  if (pattern === null) {
    return () => ({ cause, location: null })
  }
  const star = pattern.indexOf('*')
  if (star !== -1) {
    const prefix = pattern.substring(0, star)
    if (star !== pattern.length - 1) {
      const suffix = pattern.substring(star + 1)
      return input => ({ cause, location: prefix + input + suffix })
    }
    return input => ({ cause, location: prefix + input })
  } else {
    return () => ({ cause, location: pattern })
  }
}

type Resolver = (match: string) => Import

function createResolver (type: Type, cause: string, part: Definition): Resolver | undefined {
  if (part === null) {
    return () => ({ cause, location: null })
  }
  if (typeof part === 'string') {
    return () => ({ cause, location: part })
  }
  const directLookup = (type === 'module')
    ? lookup(`${cause}.import`, part.import)
    : lookup(`${cause}.node`, part.node) ?? lookup(`${cause}.require`, part.require)
  return directLookup ?? lookup(`${cause}.default`, part.default)
}

interface DefMatcher {
  match: (input: string) => string | undefined
  resolve: Resolver
}

function longerMatchFirst ([a]: [string, Definition], [b]: [string, Definition]): 1 | -1 | 0 {
  if (a.length > b.length) return -1
  if (a.length < b.length) return 1
  return 0
}

function createExportsMatcher (pkgPth: string, exports: { [key: string]: Definition }): Matcher {
  const matchers: {
    commonjs: DefMatcher[]
    module: DefMatcher[]
  } = {
    commonjs: [],
    module: []
  }
  for (const [match, definition] of Object.entries(exports).sort(longerMatchFirst)) {
    const cause = `.exports['${match}']`
    const matcher = createPatternMatcher(match)
    const cjs = createResolver('commonjs', cause, definition)
    if (cjs !== undefined) {
      matchers.commonjs.push({
        match: matcher,
        resolve: cjs
      })
    }
    const mjs = createResolver('module', cause, definition)
    if (mjs !== undefined) {
      matchers.module.push({
        match: matcher,
        resolve: mjs
      })
    }
  }
  return (name, type) => {
    const typeMatchers = matchers[type]
    for (const matcher of typeMatchers) {
      const lookup = matcher.match(name)
      if (lookup === undefined) {
        continue
      }
      const result = matcher.resolve(lookup)
      const location = result.location
      if (location !== undefined && location !== null) {
        result.location = path.resolve(pkgPth, location)
      }
      return result
    }
  }
}

export function createMatcher (pkgPth: string, pkg: Package): Matcher {
  const exports = isDefinition(pkg.exports) ? { '.': pkg.exports } : pkg.exports
  return (typeof exports === 'object' && exports !== null)
    ? createExportsMatcher(pkgPth, exports)
    : createLegacyMatcher(pkgPth, pkg)
}

export function normalize (name: string | undefined | null): string {
  if (name === undefined || name === null) {
    name = ''
  }
  name = name.trim()
  if (!name.startsWith('./')) {
    name = `./${name}`
  }
  if (name.endsWith('/')) {
    name = name.substring(0, name.length - 1)
  }
  return name
}

const cache = new WeakMap<Object, Matcher>()

export function getMatcher (depPath: string, pkg: Package): Matcher {
  let matcher = cache.get(pkg)
  if (matcher === undefined) {
    matcher = createMatcher(depPath, pkg)
    cache.set(pkg, matcher)
  }
  return matcher
}
