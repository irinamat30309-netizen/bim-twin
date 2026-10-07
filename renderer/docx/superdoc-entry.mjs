// Bundled by scripts/build-superdoc.mjs (esbuild) -> renderer/vendor/superdoc.bundle.js
// Exposes window.DOCXEditor: a real, editable Word (.docx) editor powered by
// SuperDoc (https://github.com/superdoc-dev/superdoc, AGPL-3.0). SuperDoc is
// built on OOXML, so it edits actual .docx files (pagination, tables, styles)
// and can export a real .docx back out. If this bundle is missing, app.js
// falls back to the read-only docx-preview viewer, then to plain text.
import 'superdoc/style.css'
import { SuperDoc } from 'superdoc'

function b64ToBytes(b64) {
	const bin = atob(b64)
	const len = bin.length
	const bytes = new Uint8Array(len)
	for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
	return bytes
}

if (typeof window !== 'undefined') {
	window.DOCXEditor = {
		available: true,
		engine: 'superdoc',
		// opts: { editor: HTMLElement, toolbar: HTMLElement, base64, name }
		async mount(opts) {
			opts = opts || {}
			const bytes = b64ToBytes(opts.base64)
			const file = new File([bytes], opts.name || 'document.docx', {
				type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			})
			let resolveReady
			const ready = new Promise((res) => { resolveReady = res })
			// Support both SuperDoc v2 (`document`) and v1 (`documents` array).
			// Unknown keys are ignored by each version, so passing both is safe.
			const sd = new SuperDoc({
				selector: opts.editor,
				toolbar: opts.toolbar,
				document: file,
				documents: [{ id: 'bim-doc-' + Date.now(), type: 'docx', data: file }],
				documentMode: 'editing',
				pagination: true,
				rulers: false,
				onReady: () => { try { resolveReady() } catch (_) {} },
			})
			// Never hang the UI if onReady doesn't fire on some build.
			setTimeout(() => { try { resolveReady() } catch (_) {} }, 5000)
			await ready
			return {
				superdoc: sd,
				// Returns a Blob of the edited .docx, or null if export is unavailable.
				async exportDocx() {
					const attempts = [
						async () => sd.exportEditorsToDOCX && (await sd.exportEditorsToDOCX()),
						async () => sd.export && (await sd.export({ type: 'docx' })),
						async () => sd.export && (await sd.export()),
						async () => sd.activeEditor && sd.activeEditor.exportDocx && (await sd.activeEditor.exportDocx()),
						async () => sd.activeEditor && sd.activeEditor.exportToDocx && (await sd.activeEditor.exportToDocx()),
					]
					for (const fn of attempts) {
						try {
							const r = await fn()
							if (!r) continue
							const blob = Array.isArray(r) ? r[0] : r
							if (blob instanceof Blob) return blob
							if (blob && blob.buffer) return new Blob([blob], { type: file.type })
						} catch (_) { /* try next */ }
					}
					return null
				},
				destroy() { try { sd.destroy && sd.destroy() } catch (_) {} },
			}
		},
	}
}
