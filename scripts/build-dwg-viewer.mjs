// Builds an offline bundle of the libredwg-web DWG parser (GNU LibreDWG → WASM)
// with esbuild, and copies the libredwg.wasm binary next to the bundle. Runs
// automatically before `npm start` (prestart). NEVER fails the app: if the
// package/esbuild is missing or offline, it leaves a no-op stub and the app
// falls back to an external LibreOffice/ODA conversion for .dwg files.
import { mkdirSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, basename } from 'node:path'

const OUT = 'renderer/vendor/dwg.bundle.js'
const require = createRequire(import.meta.url)

// Copy every .wasm shipped by libredwg-web into renderer/vendor/ PRESERVING the
// original file name. The Emscripten runtime fetches the wasm by its own file
// name relative to the loading script (renderer/vendor/dwg.bundle.js), so the
// name must match exactly. We also drop a `libredwg.wasm` alias for safety.
function copyWasm() {
	let pkgDir = null
	try { pkgDir = dirname(require.resolve('@mlightcad/libredwg-web/package.json')) } catch (_) {}
	const dirs = []
	if (pkgDir) { dirs.push(join(pkgDir, 'wasm'), join(pkgDir, 'dist'), pkgDir) }
	const copied = []
	for (const dir of dirs) {
		try {
			if (!existsSync(dir)) continue
			for (const f of readdirSync(dir)) {
				if (!f.toLowerCase().endsWith('.wasm')) continue
				try {
					copyFileSync(join(dir, f), join('renderer/vendor', basename(f)))
					copied.push(f)
					// Alias so older locate logic that expects libredwg.wasm still works.
					try { copyFileSync(join(dir, f), 'renderer/vendor/libredwg.wasm') } catch (_) {}
				} catch (_) {}
			}
		} catch (_) {}
	}
	return copied.length > 0
}

async function main() {
	try { mkdirSync('renderer/vendor', { recursive: true }) } catch (_) {}
	try {
		const esbuild = await import('esbuild')
		await esbuild.build({
			entryPoints: ['renderer/dwg/dwg-entry.mjs'],
			bundle: true,
			format: 'iife',
			platform: 'browser',
			target: ['chrome110'],
			outfile: OUT,
			logLevel: 'silent',
			legalComments: 'none',
			loader: { '.wasm': 'file' },
			define: { 'process.env.NODE_ENV': '"production"' },
		})
		const wasmOk = copyWasm()
		console.log('[dwg-viewer] libredwg-web bundle built -> ' + OUT + (wasmOk ? ' (+ wasm)' : ' (wasm missing!)'))
	} catch (e) {
		const msg = e && e.message ? String(e.message).split('\n')[0] : 'unknown error'
		if (!existsSync(OUT)) {
			try { writeFileSync(OUT, '/* libredwg-web bundle not built; app uses external DWG conversion. */\n') } catch (_) {}
		}
		console.log('[dwg-viewer] libredwg-web bundle not built (' + msg + '); using external DWG conversion.')
	}
	process.exit(0)
}

main()
