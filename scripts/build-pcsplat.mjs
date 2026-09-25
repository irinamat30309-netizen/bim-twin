// Builds an offline bundle of the PlayCanvas 3D Gaussian Splatting viewer with
// esbuild. Runs automatically before `npm start` (prestart). NEVER fails the
// app: if playcanvas/esbuild are missing or offline, it leaves a no-op stub
// and the app falls back to the built-in SplatViewer.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const OUT = 'renderer/vendor/pcsplat.bundle.js'

async function main() {
	try {
		mkdirSync('renderer/vendor', { recursive: true })
	} catch (_) {}
	try {
		const esbuild = await import('esbuild')
		await esbuild.build({
			entryPoints: ['renderer/pcsplat/pc-splat-entry.mjs'],
			bundle: true,
			format: 'iife',
			platform: 'browser',
			target: ['chrome110'],
			outfile: OUT,
			logLevel: 'silent',
			legalComments: 'none',
			define: { 'process.env.NODE_ENV': '"production"' },
		})
		console.log('[pcsplat] PlayCanvas gaussian-splat bundle built -> ' + OUT)
	} catch (e) {
		const msg = e && e.message ? String(e.message).split('\n')[0] : 'unknown error'
		if (!existsSync(OUT)) {
			try {
				writeFileSync(
					OUT,
					'/* PlayCanvas splat bundle not built; app uses the built-in SplatViewer. */\n',
				)
			} catch (_) {}
		}
		console.log(
			'[pcsplat] PlayCanvas bundle not built (' + msg + '); using built-in SplatViewer.',
		)
	}
	process.exit(0)
}

main()
