// Builds an offline bundle of the Potree (@pnext/three-loader) point-cloud
// renderer with esbuild. Runs automatically before `npm start` (prestart).
// NEVER fails the app: if deps are missing / offline / version-incompatible, it
// leaves a no-op stub and the app falls back to the built-in octree viewer.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const OUT = 'renderer/vendor/potree.bundle.js'

async function main() {
	try { mkdirSync('renderer/vendor', { recursive: true }) } catch (_) {}
	try {
		const esbuild = await import('esbuild')
		await esbuild.build({
			entryPoints: ['renderer/potree/potree-entry.mjs'],
			bundle: true,
			format: 'iife',
			platform: 'browser',
			target: ['chrome110'],
			outfile: OUT,
			logLevel: 'silent',
			legalComments: 'none',
			define: { 'process.env.NODE_ENV': '"production"' },
		})
		console.log('[potree] Potree point-cloud bundle built -> ' + OUT)
	} catch (e) {
		const msg = e && e.message ? String(e.message).split('\n')[0] : 'unknown error'
		if (!existsSync(OUT)) {
			try {
				writeFileSync(
					OUT,
					'/* Potree bundle not built; app uses the built-in octree cloud viewer. */\n',
				)
			} catch (_) {}
		}
		console.log(
			'[potree] Potree bundle not built (' + msg + '); using built-in octree viewer.',
		)
	}
	process.exit(0)
}

main()
