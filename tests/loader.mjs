/**
 * The test loader: JSX, and the `@/…` alias, and nothing else.
 *
 * `npm test` is `node --test` over this directory. Node strips types from
 * `.ts` on its own, which is why this repository needed no loader until now.
 * Two things it will not do, and both are needed before a real component can be
 * rendered in a test:
 *
 *   1. **JSX.** Node's type stripping does not transform it, and the root
 *      `tsconfig.json` sets `"jsx": "preserve"` because Next compiles JSX
 *      itself -- and rewrites that setting back if it is changed.
 *   2. **The `@/…` alias and extensionless imports.** Those are bundler
 *      conventions. The application is full of them; Node resolves neither.
 *
 * ## Why this is hand-written rather than `tsx`
 *
 * `tsx` was installed, tried, and removed. It is an excellent loader, but it
 * decides a module's format from the nearest `package.json`, and this project
 * has no `"type": "module"` -- so every `.ts` in the suite compiled to
 * CommonJS. That is not a detail: `tests/admin-route-boundary.test.ts` imports
 * the real admin route handlers through its own `module.register()` resolve
 * hook, which substitutes two modules for doubles. An ESM resolve hook does not
 * see a `require`, so the doubles were never injected and thirteen tests that
 * pass today failed. A harness whose cost is thirteen real tests is not a
 * harness.
 *
 * So this hook does strictly less. It transforms **`.tsx` only**, leaving every
 * `.ts` file to Node exactly as before -- same stripping, same ESM detection,
 * same custom hooks -- and it resolves the two specifier shapes Node cannot,
 * only after Node has already failed to resolve them itself. Every test that
 * renders nothing takes the same path through this loader that it took without
 * it.
 *
 * The transform is `typescript`, which is already a devDependency and is the
 * same compiler `npm run typecheck` runs, at the same version. It reads its
 * options from `tsconfig.tests.json`, so the one setting that differs from the
 * application's -- the automatic React JSX runtime -- is written down in a
 * configuration file rather than buried in a loader.
 *
 * Deliberately `.mjs`: it is the thing that makes TypeScript loadable, so it
 * cannot itself need loading. It also does not match `tests/**\/*.test.ts`, so
 * the runner never treats it as a test.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ROOT = new URL('../', import.meta.url)
/** TypeScript normalises to forward slashes and asserts that its input already is. */
const slashes = (path) => path.split('\\').join('/')

const TSCONFIG = slashes(fileURLToPath(new URL('../tsconfig.tests.json', import.meta.url)))

/** The options the tests compile under, read from the file that states them. */
function testCompilerOptions() {
  const read = ts.readConfigFile(TSCONFIG, (path) => readFileSync(path, 'utf8'))
  if (read.error) {
    throw new Error(
      `tsconfig.tests.json could not be read: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`,
    )
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    slashes(fileURLToPath(ROOT)),
    {},
    TSCONFIG,
  )

  return {
    ...parsed.options,
    /*
     * The two the loader owns rather than the configuration. `module` is what
     * this hook promises Node when it answers `format: 'module'`; `sourceMap`
     * is inline so a stack trace from a rendered test points at the `.tsx`
     * line that caused it rather than at the compiled one.
     */
    module: ts.ModuleKind.ESNext,
    inlineSourceMap: true,
    inlineSources: true,
    sourceMap: false,
    declaration: false,
    declarationMap: false,
    composite: false,
    incremental: false,
    noEmit: false,
  }
}

const OPTIONS = testCompilerOptions()

/* The extensions a bundler would try, in the order it would try them. */
const CANDIDATES = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']

/**
 * Is this URL a *file* on disk?
 *
 * `existsSync` is true for a directory, and a directory is not a module: Node
 * answers a directory URL with `ERR_UNSUPPORTED_DIR_IMPORT`. Asking the
 * narrower question is what lets the two `/index.*` candidates below actually
 * be reached when an alias names a directory -- which is exactly what a bundler
 * does with it.
 */
function isFileOnDisk(url) {
  const path = fileURLToPath(url)
  if (!existsSync(path)) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The first of `base` + each candidate suffix that is actually a file on disk. */
function firstOnDisk(base) {
  for (const suffix of CANDIDATES) {
    const candidate = new URL(base + suffix, ROOT)
    if (isFileOnDisk(candidate)) return candidate.href
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  /*
   * `@/x` is the alias, and it is unambiguous: Node has no other meaning for
   * it, so it is resolved here first rather than after a failure.
   */
  if (specifier.startsWith('@/')) {
    const rest = specifier.slice(2)
    const direct = new URL(rest, ROOT)
    /*
     * A *file* hit short-circuits. A directory does not: `@/components/reader`
     * naming a folder with an `index.ts` in it is a barrel import, which a
     * bundler resolves and Node refuses, so it has to fall through to the
     * `/index.*` candidates rather than hand Node a directory URL.
     */
    if (isFileOnDisk(direct)) return nextResolve(direct.href, context)

    const found = firstOnDisk(rest)
    if (found) return nextResolve(found, context)
  }

  /*
   * A relative specifier with no extension. Node is asked first and this runs
   * only if Node said no, so nothing that already resolves changes meaning.
   */
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && context.parentURL) {
      const base = new URL(specifier, context.parentURL)
      for (const suffix of CANDIDATES) {
        const candidate = new URL(base.href + suffix)
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
      }
      throw error
    }

    /*
     * A package subpath a bundler would have completed: `next/link` is the file
     * `next/link.js`, and Node will not guess the extension. Exactly the
     * redirect `tests/helpers/admin-route-hooks.mjs` already makes by hand for
     * `next/server`, generalised so it does not have to be listed per module.
     * Tried only after Node itself has refused the specifier.
     */
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && specifier.includes('/')) {
      try {
        return await nextResolve(`${specifier}.js`, context)
      } catch {
        throw error
      }
    }

    throw error
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.endsWith('.tsx')) return nextLoad(url, context)

  const path = fileURLToPath(url)
  const emitted = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: OPTIONS,
    fileName: slashes(path),
    reportDiagnostics: false,
  })

  return { format: 'module', shortCircuit: true, source: emitted.outputText }
}

