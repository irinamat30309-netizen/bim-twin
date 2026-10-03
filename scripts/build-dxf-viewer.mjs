// Builds an offline bundle of the three-dxf CAD viewer with esbuild.
// Runs automatically before `npm start` (prestart). NEVER fails the app:
// if three-dxf/esbuild are missing or offline, it leaves a no-op stub and the
// app falls back to the built-in interactive DXF viewer.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const OUT = 'renderer/vendor/dxf.bundle.js'

async function main() {
	try {
		mkdirSync('renderer/vendor', { recursive: true })
	} catch (_) {}
	try {
		const esbuild = await import('esbuild')
		await esbuild.build({
			entryPoints: ['renderer/dxf/three-dxf-entry.mjs'],
			bundle: true,
			format: 'iife',
			platform: 'browser',
			target: ['chrome110'],
			outfile: OUT,
			logLevel: 'silent',
			legalComments: 'none',
			define: { 'process.env.NODE_ENV': '"production"' },
		})
		console.log('[dxf-viewer] three-dxf bundle built -> ' + OUT)
	} catch (e) {
		const msg = e && e.message ? String(e.message).split('\n')[0] : 'unknown error'
		if (!existsSync(OUT)) {
			try {
				writeFileSync(
					OUT,
					'/* three-dxf bundle not built; app uses the built-in interactive DXF viewer. */\n',
				)
			} catch (_) {}
		}
		console.log(
			'[dxf-viewer] three-dxf bundle not built (' + msg + '); using built-in DXF viewer.',
		)
	}
	process.exit(0)
}

main()
