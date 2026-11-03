// Builds an offline bundle of the PDF.js viewer (+ its worker) with esbuild.
// Runs automatically before `npm start` (prestart). NEVER fails the app:
// if pdfjs-dist/esbuild are missing or offline, it leaves a no-op stub and the
// app falls back to the native Electron/Chromium PDF viewer.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const OUT = 'renderer/vendor/pdf.bundle.js'
const WORKER = 'renderer/vendor/pdf.worker.bundle.js'
const WORKER_ENTRIES = [
	'pdfjs-dist/build/pdf.worker.mjs',
	'pdfjs-dist/build/pdf.worker.js',
	'pdfjs-dist/legacy/build/pdf.worker.mjs',
]

async function main() {
	try { mkdirSync('renderer/vendor', { recursive: true }) } catch (_) {}
	try {
		const esbuild = await import('esbuild')
		await esbuild.build({
			entryPoints: ['renderer/pdf/pdfjs-entry.mjs'],
			bundle: true,
			format: 'iife',
			platform: 'browser',
			target: ['chrome110'],
			outfile: OUT,
			logLevel: 'silent',
			legalComments: 'none',
			define: { 'process.env.NODE_ENV': '"production"' },
		})
		let workerOk = false
		for (const entry of WORKER_ENTRIES) {
			try {
				await esbuild.build({
					entryPoints: [entry],
					bundle: true,
					format: 'iife',
					platform: 'browser',
					target: ['chrome110'],
					outfile: WORKER,
					logLevel: 'silent',
					legalComments: 'none',
				})
				workerOk = true
				break
			} catch (_) { /* try next candidate */ }
		}
		console.log('[pdf-viewer] pdf.js bundle built -> ' + OUT + (workerOk ? ' (+ worker)' : ' (worker missing)'))
	} catch (e) {
		const msg = e && e.message ? String(e.message).split('\n')[0] : 'unknown error'
		if (!existsSync(OUT)) {
			try { writeFileSync(OUT, '/* pdf.js bundle not built; app uses the native PDF viewer. */\n') } catch (_) {}
		}
		console.log('[pdf-viewer] pdf.js bundle not built (' + msg + '); using native PDF fallback.')
	}
	process.exit(0)
}

main()
