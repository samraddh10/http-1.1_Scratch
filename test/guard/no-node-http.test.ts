// module 0.1  test/guard/no-node-http.test.ts -- enforces CLAUDE.md rule 4
//
// `server/` is a from-scratch HTTP/1.1 implementation. Importing Node's `http` module
// into it as a VALUE would defeat the entire point of the project, and it is the kind of
// mistake that is easy to make and easy to miss in review -- one `import { STATUS_CODES }`
// for convenience and the claim "this is mine" stops being true.
//
// `import type` is fine and encouraged: type-only imports are erased at compile time, so
// nothing from Node's implementation reaches the runtime, and borrowing the real type
// definitions means the compiler checks the module 5 shims against the true interface.
//
// The one file allowed to import the implementation is test/parity/node-vs-custom.test.ts,
// whose whole job is comparing my server against Node's. It lives outside server/ and is
// therefore not scanned.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER_DIR = join(ROOT, 'server')

// Node's HTTP implementations, in every spelling. http2 and https are included because
// they are explicit non-goals -- there is no legitimate reason for either inside server/.
const MODULE = String.raw`(?:node:)?(?:http|https|http2)`

// `[^'"]*?` rather than `[\s\S]*?` so a match can span the newlines of a multi-line
// import but can never run past a quote into a *different* import's specifier.
const VALUE_IMPORT = new RegExp(
  String.raw`^[ \t]*import\s+(?!type\s)[^'"]*?from\s*['"]${MODULE}['"]`,
  'gm',
)
const SIDE_EFFECT_IMPORT = new RegExp(String.raw`^[ \t]*import\s*['"]${MODULE}['"]`, 'gm')
const DYNAMIC_LOAD = new RegExp(
  String.raw`\b(?:require|import)\s*\(\s*['"]${MODULE}['"]`,
  'g',
)

/** Comments are stripped so that prose mentioning `from 'node:http'` does not trip the guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function typeScriptFilesIn(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...typeScriptFilesIn(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

test('server/ never imports node:http as a value', () => {
  const files = typeScriptFilesIn(SERVER_DIR)

  // If the walk silently returns nothing the guard would "pass" while checking nothing,
  // which is worse than failing. Assert it actually found source to scan.
  assert.ok(files.length > 0, `no .ts files found under ${SERVER_DIR} -- guard is not scanning anything`)

  const violations: string[] = []

  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'))
    const shown = relative(ROOT, file).split(sep).join('/')

    for (const [pattern, what] of [
      [VALUE_IMPORT, 'value import'],
      [SIDE_EFFECT_IMPORT, 'side-effect import'],
      [DYNAMIC_LOAD, 'require()/import() call'],
    ] as const) {
      pattern.lastIndex = 0
      for (const match of source.matchAll(pattern)) {
        violations.push(
          `${shown}:${lineOf(source, match.index)} -- ${what}: ${match[0].trim().replace(/\s+/g, ' ')}`,
        )
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `server/ must not import Node's http implementation. Use \`import type\` instead.\n\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      `\n`,
  )
})

test('type-only imports of node:http are allowed', () => {
  // Guards the guard: the module 5 shims will legitimately do this, and a rule that
  // banned it too would be unusable.
  const allowed = `import type { IncomingMessage, ServerResponse } from 'node:http'\n`
  const stripped = stripComments(allowed)

  assert.equal(stripped.match(VALUE_IMPORT), null)
  assert.equal(stripped.match(SIDE_EFFECT_IMPORT), null)
  assert.equal(stripped.match(DYNAMIC_LOAD), null)
})

test('the guard actually catches a value import', () => {
  // Without this, a broken regex would make the guard pass silently forever.
  const offenders = [
    `import { createServer } from 'node:http'\n`,
    `import http from 'http'\n`,
    `import {\n  STATUS_CODES,\n} from 'node:http'\n`,
    `import 'node:http'\n`,
    `const http = require('node:http')\n`,
    `const { createServer } = await import('node:http')\n`,
  ]

  for (const source of offenders) {
    const hit =
      source.match(VALUE_IMPORT) ?? source.match(SIDE_EFFECT_IMPORT) ?? source.match(DYNAMIC_LOAD)
    assert.notEqual(hit, null, `guard failed to catch: ${source.trim()}`)
  }
})
