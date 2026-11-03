// Bundled by scripts/build-docx-viewer.mjs (esbuild) -> renderer/vendor/docx.bundle.js
// Exposes window.DOCXViewer: high-fidelity Word rendering via docx-preview
// (renders real page layout, styles, tables, images). If this bundle is
// missing, app.js falls back to the extracted plain text.
import { renderAsync } from 'docx-preview'

function b64ToBytes(b64) {
	const bin = atob(b64)
	const len = bin.length
	const bytes = new Uint8Array(len)
	for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
	return bytes
}

if (typeof window !== 'undefined') {
	window.DOCXViewer = {
		available: true,
		engine: 'docx-preview',
		async render(container, base64) {
			container.classList.add('docxpv-root')
			container.innerHTML = ''
			const bytes = b64ToBytes(base64)
			const blob = new Blob([bytes], {
				type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			})
			await renderAsync(blob, container, null, {
				className: 'docx',
				inWrapper: true,
				breakPages: true,
				experimental: true,
				useBase64URL: true,
				renderHeaders: true,
				renderFooters: true,
				renderFootnotes: true,
				renderEndnotes: true,
			})
			return { ok: true }
		},
	}
}
