// Builds an offline bundle of the Univer spreadsheet viewer with esbuild.
// Runs automatically before `npm start` (prestart). NEVER fails the app:
// if Univer/esbuild are missing or offline, it leaves a no-op stub and the
// app falls back to the built-in Excel table renderer.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const OUT = 'renderer/vendor/univer.bundle.js'

async function main() {
  try {
    mkdirSync('renderer/vendor', { recursive: true })
  } catch (_) {}
  try {
    const esbuild = await import('esbuild')
    await esbuild.build({
      entryPoints: ['renderer/xls/univer-entry.mjs'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome110'],
      outfile: OUT,
      logLevel: 'silent',
      legalComments: 'none',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
    })
    console.log('[xls-viewer] Univer bundle built -> ' + OUT)
  } catch (e) {
    const msg = (e && e.message) ? String(e.message).split('\n')[0] : 'unknown error'
    if (!existsSync(OUT)) {
      try { writeFileSync(OUT, '/* Univer bundle not built; app uses the built-in Excel viewer. */\n') } catch (_) {}
    }
    console.log('[xls-viewer] Univer bundle not built (' + msg + '); using built-in Excel viewer.')
  }
  process.exit(0)
}

main()
