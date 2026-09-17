/**
 * Turn the test loader on.
 *
 * Loaded with `--import`, which `node --test` passes on to the child process it
 * runs each test file in, so every file gets the same loader. It does one
 * thing: put `tests/loader.mjs` on the module hooks chain. What that loader
 * does, and why it is hand-written rather than a package, is documented there.
 *
 * Deliberately `.mjs`: it is part of what makes TypeScript loadable, so it
 * cannot itself need loading. It also does not match `tests/**\/*.test.ts`, so
 * the runner never treats it as a test.
 */

import { register } from 'node:module'

register(new URL('./loader.mjs', import.meta.url))
