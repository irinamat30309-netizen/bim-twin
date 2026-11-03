// Builds an offline bundle of the docx-preview Word viewer with esbuild.
// Runs automatically before `npm start` (prestart). NEVER fails the app:
// if docx-preview/esbuild are missing or offline, it leaves a no-op stub and
// the app falls back to the extracted plain-text preview.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const OUT = 'renderer/vendor/docx.bundle.js'

async function main() {
	try { mkdirSync('renderer/vendor', { recursive: true }) } catch (_) {}
	try {
		const esbuild = await import('esbuild')
		await esbuild.build({
			entryPoints: ['renderer/docx/docx-entry.mjs'],
			bundle: true,
			format: 'iife',
			platform: 'browser',
			target: ['chrome110'],
			outfile: OUT,
			logLevel: 'silent',
			legalComments: 'none',
			define: { 'process.env.NODE_ENV': '"production"' },
		})
		console.log('[docx-viewer] docx-preview bundle built -> ' + OUT)
	} catch (e) {
		const msg = e && e.message ? String(e.message).split('\n')[0] : 'unknown error'
		if (!existsSync(OUT)) {
			try { writeFileSync(OUT, '/* docx-preview bundle not built; app uses extracted text. */\n') } catch (_) {}
		}
		console.log('[docx-viewer] docx-preview bundle not built (' + msg + '); using text fallback.')
	}
	process.exit(0)
}

main()
