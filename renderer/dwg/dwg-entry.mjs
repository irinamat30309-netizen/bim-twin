// Bundled by scripts/build-dwg-viewer.mjs (esbuild) -> renderer/vendor/dwg.bundle.js
// Exposes window.DWGViewer: parses binary AutoCAD .dwg files fully in the
// browser (offline, no server, no external converter) using libredwg-web
// (GNU LibreDWG compiled to WebAssembly). It converts the parsed drawing into
// standard DXF text so the app can render it with the existing three-dxf /
// built-in CAD viewer. If this bundle (or the wasm) is missing, app.js falls
// back to an external LibreOffice/ODA conversion, then to a helpful notice.
import { LibreDwg, Dwg_File_Type } from '@mlightcad/libredwg-web'

function b64ToBytes(b64) {
	const bin = atob(b64)
	const len = bin.length
	const bytes = new Uint8Array(len)
	for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
	return bytes
}

function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : (d || 0) }
function pt(p) {
	if (!p) return null
	if (Array.isArray(p)) return { x: num(p[0]), y: num(p[1]) }
	if (typeof p === 'object') return { x: num(p.x), y: num(p.y) }
	return null
}

// Build minimal, universally-parseable DXF (R12 ENTITIES) text from a
// libredwg-web DwgDatabase. Handles the common geometry entities; unknown
// entity types are skipped gracefully.
function dbToDxf(db) {
	const ents = (db && (db.entities || (db.modelSpace && db.modelSpace.entities))) || []
	if (!ents.length) return null
	const out = ['0', 'SECTION', '2', 'ENTITIES']
	const put = (code, val) => { out.push(String(code), String(val)) }
	const layerOf = (e) => (e && (e.layer || e.layerName)) || '0'
	const line = (x1, y1, x2, y2, layer) => { put(0, 'LINE'); put(8, layer); put(10, x1); put(20, y1); put(11, x2); put(21, y2) }
	let count = 0
	for (const e of ents) {
		try {
			const t = String(e.type || e.entityType || '').toUpperCase()
			const L = layerOf(e)
			if (t === 'LINE') {
				const a = pt(e.startPoint || e.start || e.p1)
				const b = pt(e.endPoint || e.end || e.p2)
				if (a && b) { line(a.x, a.y, b.x, b.y, L); count++ }
			} else if (t === 'CIRCLE') {
				const c = pt(e.center)
				if (c) { put(0, 'CIRCLE'); put(8, L); put(10, c.x); put(20, c.y); put(40, num(e.radius, 1)); count++ }
			} else if (t === 'ARC') {
				const c = pt(e.center)
				if (c) { put(0, 'ARC'); put(8, L); put(10, c.x); put(20, c.y); put(40, num(e.radius, 1)); put(50, num(e.startAngle)); put(51, num(e.endAngle, 360)); count++ }
			} else if (t === 'LWPOLYLINE' || t === 'POLYLINE') {
				const vs = (e.vertices || e.points || []).map(pt).filter(Boolean)
				if (vs.length >= 2) {
					for (let i = 0; i < vs.length - 1; i++) { line(vs[i].x, vs[i].y, vs[i + 1].x, vs[i + 1].y, L); count++ }
					const closed = e.closed || e.isClosed || (e.shape === true) || (num(e.flag) & 1)
					if (closed && vs.length > 2) { line(vs[vs.length - 1].x, vs[vs.length - 1].y, vs[0].x, vs[0].y, L); count++ }
				}
			} else if (t === 'ELLIPSE') {
				const c = pt(e.center)
				const maj = pt(e.majorAxisEndPoint || e.endPoint)
				if (c && maj) {
					const rx = Math.hypot(maj.x, maj.y)
					const ratio = num(e.axisRatio || e.ratio, 1)
					const ry = rx * ratio
					const rot = Math.atan2(maj.y, maj.x)
					const N = 48
					let px = null, py = null
					for (let i = 0; i <= N; i++) {
						const a = (i / N) * Math.PI * 2
						const ex = rx * Math.cos(a), ey = ry * Math.sin(a)
						const x = c.x + ex * Math.cos(rot) - ey * Math.sin(rot)
						const y = c.y + ex * Math.sin(rot) + ey * Math.cos(rot)
						if (px !== null) { line(px, py, x, y, L); count++ }
						px = x; py = y
					}
				}
			} else if (t === 'SPLINE') {
				const vs = (e.controlPoints || e.fitPoints || []).map(pt).filter(Boolean)
				for (let i = 0; i < vs.length - 1; i++) { line(vs[i].x, vs[i].y, vs[i + 1].x, vs[i + 1].y, L); count++ }
			}
		} catch (_) { /* skip bad entity */ }
	}
	out.push('0', 'ENDSEC', '0', 'EOF')
	return count ? out.join('\n') : null
}

// Create the LibreDwg wrapper. The Emscripten module locates its .wasm relative
// to the loading script (renderer/vendor/), so no path is needed in the common
// case. We still try a few call signatures defensively across library versions.
async function makeLib() {
	const attempts = [
		() => LibreDwg.create(),
		() => LibreDwg.create('vendor/'),
		() => LibreDwg.create({ locateFile: (p) => 'vendor/' + p }),
	]
	let lastErr = null
	for (const a of attempts) {
		try { const l = await a(); if (l) return l } catch (e) { lastErr = e }
	}
	throw lastErr || new Error('LibreDwg.create() failed')
}

if (typeof window !== 'undefined') {
	let _lib = null
	window.DWGViewer = {
		available: true,
		engine: 'libredwg-web',
		// Returns DXF text (string) parsed from the DWG, or null if nothing usable.
		async toDxf(base64) {
			const bytes = b64ToBytes(base64)
			if (!_lib) _lib = await makeLib()
			const libredwg = _lib
			let dwg = null
			try {
				dwg = libredwg.dwg_read_data(bytes.buffer, Dwg_File_Type.DWG)
				const db = libredwg.convert(dwg)
				return dbToDxf(db)
			} finally {
				try { if (dwg != null) libredwg.dwg_free(dwg) } catch (_) {}
			}
		},
	}
}
