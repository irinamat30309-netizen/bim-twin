// Builds an offline bundle of the SuperDoc editable Word (.docx) editor with
// esbuild. Runs automatically before `npm start` (prestart). NEVER fails the
// app: if superdoc/esbuild are missing or offline, it leaves a no-op stub and
// the app falls back to the read-only docx viewer (docx-preview) or plain text.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const OUT = 'renderer/vendor/superdoc.bundle.js'

async function main() {
	try { mkdirSync('renderer/vendor', { recursive: true }) } catch (_) {}
	try {
		const esbuild = await import('esbuild')
		await esbuild.build({
			entryPoints: ['renderer/docx/superdoc-entry.mjs'],
			bundle: true,
			format: 'iife',
			platform: 'browser',
			target: ['chrome110'],
			outfile: OUT,
			logLevel: 'silent',
			legalComments: 'none',
			loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.eot': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
			define: { 'process.env.NODE_ENV': '"production"' },
		})
		console.log('[superdoc] SuperDoc Word editor bundle built -> ' + OUT)
	} catch (e) {
		const msg = e && e.message ? String(e.message).split('\n')[0] : 'unknown error'
		if (!existsSync(OUT)) {
			try { writeFileSync(OUT, '/* SuperDoc bundle not built; app uses the read-only Word viewer. */\n') } catch (_) {}
		}
		console.log('[superdoc] SuperDoc bundle not built (' + msg + '); using read-only Word viewer.')
	}
	process.exit(0)
}

main()
