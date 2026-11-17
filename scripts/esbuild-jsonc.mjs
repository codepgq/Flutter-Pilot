import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * jsonc-parser's package main is a UMD build. esbuild leaves its
 * require("./impl/format") calls unresolved, so the extension host fails
 * while loading the bundle and never registers commands.
 */
export const jsoncParserEsm = {
  name: 'jsonc-parser-esm',
  setup(build) {
    build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
      path: require.resolve('jsonc-parser/lib/esm/main.js'),
    }));
  },
};
