// Entry bundled by scripts/build-dxf-viewer.mjs (esbuild) into
// renderer/vendor/dxf.bundle.js. Exposes window.DXFViewer, a thin wrapper
// around three-dxf (MIT) + dxf-parser for precise CAD rendering of DXF files.
// If this bundle is missing (offline / not built), app.js falls back to the
// built-in interactive canvas DXF viewer — no regression.
import * as THREE from 'three'
import * as DxfParserNS from 'dxf-parser'
import * as ThreeDxfNS from 'three-dxf'

const DxfParser =
	DxfParserNS.default || DxfParserNS.DxfParser || DxfParserNS
const Viewer =
	ThreeDxfNS.Viewer ||
	(ThreeDxfNS.default && (ThreeDxfNS.default.Viewer || ThreeDxfNS.default)) ||
	ThreeDxfNS

if (typeof window !== 'undefined') {
	window.THREE = window.THREE || THREE
	window.DXFViewer = {
		available: true,
		engine: 'three-dxf',
		// Parse `text` and mount a full three.js CAD view into `container`.
		// Returns a handle object on success, or null on empty/parse failure
		// so the caller can fall back to the built-in viewer.
		render(container, text, opts) {
			opts = opts || {}
			const parser = new DxfParser()
			let dxf
			try {
				dxf =
					typeof parser.parseSync === 'function'
						? parser.parseSync(text)
						: parser.parse(text)
			} catch (e) {
				console.warn('[dxf] parse failed', e)
				return null
			}
			if (!dxf || !dxf.entities || !dxf.entities.length) return null
			const w = opts.width || container.clientWidth || 820
			const h = opts.height || 520
			if (!container.style.position) container.style.position = 'relative'
			const viewer = new Viewer(dxf, container, w, h, opts.font)
			return { viewer, entities: dxf.entities.length, engine: 'three-dxf' }
		},
	}
}
