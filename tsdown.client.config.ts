import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'comem/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    alwaysBundle: (specifier: string) =>
      !['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'].includes(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "comem", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
