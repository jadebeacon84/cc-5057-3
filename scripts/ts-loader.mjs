import { transformSync } from 'esbuild';

// Node's ESM resolver requires extensions; the app source is extensionless so
// Vite's resolver (and tsc) stay happy. Retry failed relative resolutions with
// a .ts suffix.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return await nextResolve(`${specifier}.ts`, context);
      } catch {
        throw err;
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const result = await nextLoad(url, { ...context, format: 'module' });
    const source =
      typeof result.source === 'string'
        ? result.source
        : Buffer.from(result.source).toString('utf8');
    const { code } = transformSync(source, { loader: 'ts', format: 'esm', target: 'node20' });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
