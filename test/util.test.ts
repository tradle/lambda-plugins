import { createMatcher, getMatcher } from '../util'
import * as test from 'fresh-tape'

test('repeat, on-demand matcher', async t => {
  const pkg = { main: 'index.js' }
  const matcher = getMatcher('/root', pkg)
  t.deepEqual(matcher('.', 'commonjs'), { cause: '.main', location: '/root/index.js' })
  t.equal(getMatcher('/root', pkg), matcher)
})
test('simple main', async t => {
  const match = createMatcher('/root', { main: './test.js' })
  for (const input of [
    '',
    '.',
    './'
  ]) {
    t.deepEqual(match(input, 'commonjs'), { cause: '.main', location: '/root/test.js' })
  }
  t.equal(match('', 'module'), undefined)
})
test('export override string', async t => {
  const a = createMatcher('/root', { main: 'a.js', exports: './b.js' })
  t.deepEqual(a('', 'commonjs'), { cause: '.exports[\'.\']', location: '/root/b.js' })
  t.deepEqual(a('', 'module'), { cause: '.exports[\'.\']', location: '/root/b.js' })
})
test('export override object', async t => {
  const a = createMatcher('/root', { main: 'a.js', exports: { import: './b.js', require: './c.js' } })
  t.deepEqual(a('', 'commonjs'), { cause: '.exports[\'.\'].require', location: '/root/c.js' })
  t.deepEqual(a('', 'module'), { cause: '.exports[\'.\'].import', location: '/root/b.js' })
})
test('export deep override', async t => {
  const match = createMatcher('/root', {
    main: 'a.js',
    exports: {
      '.': { require: './b.js', import: './c.js' },
      './c-a': { require: './d.js', import: './e.js' },
      './c-b': { default: './f.js' },
      './c-c': { node: './g.js', require: './h.js', default: './i.js' }
    }
  })
  t.deepEqual(match('c-a', 'commonjs'), { cause: '.exports[\'./c-a\'].require', location: '/root/d.js' })
  t.equals(match('c-a.js', 'commonjs'), undefined)
  t.deepEqual(match('c-a', 'module'), { cause: '.exports[\'./c-a\'].import', location: '/root/e.js' })
  t.deepEqual(match('c-b', 'commonjs'), { cause: '.exports[\'./c-b\'].default', location: '/root/f.js' })
  t.deepEqual(match('c-b', 'module'), { cause: '.exports[\'./c-b\'].default', location: '/root/f.js' })
  t.deepEqual(match('c-c', 'commonjs'), { cause: '.exports[\'./c-c\'].node', location: '/root/g.js' })
  t.deepEqual(match('c-c', 'module'), { cause: '.exports[\'./c-c\'].default', location: '/root/i.js' })
})
test('pattern', async t => {
  const match = createMatcher('/root', {
    main: 'a.js',
    exports: {
      './foo/*': null,
      './bar/*': { require: null },
      '.': { require: './b.js', import: './c.js' },
      './bak/*.ts': { require: './cjs/*.js' },
      './*': { require: './cjs/*.js', import: './mjs/*' }
    }
  })
  t.deepEqual(match('c-a', 'commonjs'), { cause: '.exports[\'./*\'].require', location: '/root/cjs/c-a.js' })
  t.deepEqual(match('foo/c-a', 'commonjs'), { cause: '.exports[\'./foo/*\']', location: null })
  t.deepEqual(match('bar/c-a', 'commonjs'), { cause: '.exports[\'./bar/*\'].require', location: null })
  t.deepEqual(match('baz/c-a', 'module'), { cause: '.exports[\'./*\'].import', location: '/root/mjs/baz/c-a' })
  t.deepEqual(match('bak/d.ts', 'commonjs'), { cause: '.exports[\'./bak/*.ts\'].require', location: '/root/cjs/d.js' })
})
test('deep require', async t => {
  const deep = createMatcher('/root', { exports: { './test': './a.js' } })
  t.deepEqual(deep('test', 'commonjs'), { cause: '.exports[\'./test\']', location: '/root/a.js' })
})
test('main and type=module', async t => {
  const match = createMatcher('/root', { main: './test.js', type: 'module' })
  t.equal(match('', 'commonjs'), undefined)
  t.deepEqual(match('', 'module'), { cause: '.main and .type=module', location: '/root/test.js' })
})
test('module', async t => {
  const match = createMatcher('/root', { main: './a.cjs', module: 'b.mjs' })
  t.deepEqual(match('', 'commonjs'), { cause: '.main', location: '/root/a.cjs' })
  t.deepEqual(match('', 'module'), { cause: '.module', location: '/root/b.mjs' })
})
test.skip('empty match', async t => {
  const match = createMatcher('/root', {})
  t.deepEqual(match('', 'commonjs'), { cause: 'fs', location: '/root/indexs.js' })
  t.equal(match('', 'module'), undefined)
})
