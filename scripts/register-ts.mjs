// Minimal loader so the core solver (plain .ts, no framework imports) can run in Node
// without pulling in a TypeScript toolchain.
import { register } from 'node:module';
register('./ts-loader.mjs', import.meta.url);
