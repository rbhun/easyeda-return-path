import esbuild from 'esbuild';

async function main() {
  await esbuild.build({
    entryPoints: {
      index: './src/index.ts',
    },
    entryNames: '[name]',
    assetNames: '[name]',
    bundle: true,
    minify: false,
    outdir: './dist/',
    sourcemap: undefined,
    platform: 'browser',
    format: 'iife',
    globalName: 'edaEsbuildExportName',
    treeShaking: true,
    ignoreAnnotations: true,
    define: {},
    external: [],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
