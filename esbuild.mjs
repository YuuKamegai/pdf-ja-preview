import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', 'mocha'],
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
  {
    ...common,
    entryPoints: ['test/integration/extension.test.ts'],
    outdir: 'out/test/integration',
  },
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
