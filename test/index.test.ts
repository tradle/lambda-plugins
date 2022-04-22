import * as test from 'fresh-tape'
import { PluginDefinitions, validatePluginDefinitions } from '../index'

const valids: Array<{ input: PluginDefinitions, test?: PluginDefinitions }> = [
  { input: {} },
  {
    input: {
      a: '1.2.3'
    }
  },
  {
    input: {
      // Keys unsorted!
      b: '1.2.3',
      a: '3.2.1'
    }
  },
  {
    input: {
      a: 'https://foo'
    }
  },
  {
    input: {
      a: 's3:foo'
    }
  },
  {
    input: new Map<string, string>([['a', '1.2.3']]),
    test: { a: '1.2.3' }
  }
]

const invalids: Array<{ def: PluginDefinitions, error: string }> = [
  {
    def: null as unknown as PluginDefinitions,
    error: 'input needs to be an key/value object, is (object) null'
  },
  {
    def: '123' as unknown as PluginDefinitions,
    error: 'input needs to be an key/value object, is (string) 123'
  },
  {
    def: { '': '1.2.3' },
    error: 'Entry #0 has an empty name, but needs to be defined ""'
  },
  {
    def: { a: '*' },
    error: 'Entry #0 "a" can not be marked as "*" as a vague version is not cachable or secure!'
  },
  {
    def: { a: '^4.5' },
    error: 'Entry #0 "a" can not specify a version range "^" and needs to be just the version: 4.5'
  },
  {
    def: {
      a: '1.2.3',
      b: '~'
    },
    error: 'Entry #1 "b" can not specify a version range "~" and needs to be just the version: 1.2.3'
  },
  {
    def: {
      a: '1'
    },
    error: 'Entry #0 "a" can not specify a vague version range "1.x.x (x needs to be defined!)'
  },
  {
    def: {
      a: '1.2'
    },
    error: 'Entry #0 "a" can not specify a vague version range "1.2.x (x needs to be defined!)'
  },
  {
    def: {
      a: 'http://some.tgz'
    },
    error: 'Entry #0 "a" is specified with an unsupported protocol (http:), supported protocols: https, s3. Input: http://some.tgz'
  },
  {
    def: {
      a: { version: 1 },
      error: ''
    } as unknown as PluginDefinitions,
    error: 'Entry #0 "a" needs to be either a (semver-)version like 1.2.3 or a valid URL: [object Object]'
  },
  {
    def: {
      ' a': '1.2.3'
    },
    error: 'Entry #0 has a name with a space in it, this is not acceptable. Use names without spaces!'
  }
]

test('validatePluginDefintions fixtures', async t => {
  let index = 0
  for (const valid of valids) {
    let validated = {}
    t.doesNotThrow(() => {
      validated = validatePluginDefinitions(valid.input)
    }, `valid #${index} ${JSON.stringify(valid)}: no error thrown`)
    const validTest = valid.test ?? valid.input
    t.deepEquals(validated, validTest, `valid #${index}: equal object returned.`)
    t.deepEquals(Object.keys(validated), Object.keys(validTest).sort(), `valid #${index}: returned object keys are sorted.`)
    index += 1
  }
  index = 0
  for (const { def, error } of invalids) {
    t.throws(
      () => validatePluginDefinitions(def),
      { message: error },
      `invalid check #${index} ${JSON.stringify(def)}: ${error}`
    )
    index += 1
  }
})
