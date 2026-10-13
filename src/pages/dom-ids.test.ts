import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * A page module resolves its elements at load with `qs`, which throws on a
 * missing id. One absent element therefore stops the whole page: no wire-up, no
 * gate, no flow. That is how the launch page lost its pool-parameters form and
 * silently refused to deploy anything, so the two files are checked against each
 * other here rather than at runtime.
 */
const PAGES = [
  ['src/pages/home.ts', 'index.html'],
  ['src/pages/pool.ts', 'pool.html'],
  ['src/pages/create.ts', 'create.html'],
  ['src/pages/about.ts', 'about.html'],
] as const

/** Ids a module asks the DOM for, without the palette colours that look like ids. */
function askedIds(source: string): string[] {
  const ids = new Set<string>()
  for (const match of source.matchAll(/['"]#([a-zA-Z0-9_-]+)['"]/g)) {
    ids.add(match[1])
  }
  for (const match of source.matchAll(/getElementById\(\s*['"]([a-zA-Z0-9_-]+)['"]/g)) {
    ids.add(match[1])
  }
  // `#00f239` and `#5f574f` are colours; every id in these pages is a word.
  return [...ids].filter((id) => !/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(id))
}

function presentIds(html: string): Set<string> {
  return new Set([...html.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((match) => match[1]))
}

describe('page modules and their markup', () => {
  it.each(PAGES)('%s finds every id it asks for in %s', (module, page) => {
    const asked = askedIds(readFileSync(module, 'utf8'))
    const present = presentIds(readFileSync(page, 'utf8'))
    expect(asked.filter((id) => !present.has(id))).toEqual([])
  })
})
