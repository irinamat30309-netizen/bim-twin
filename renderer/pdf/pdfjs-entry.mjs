// Bundled by scripts/build-pdf-viewer.mjs (esbuild) -> renderer/vendor/pdf.bundle.js
// Exposes window.PDFViewer: a continuous-scroll PDF renderer built on PDF.js
// (Mozilla, Apache-2.0). If this bundle is missing, app.js falls back to the
// native Electron/Chromium PDF viewer via a Blob URL.
import * as pdfjsLib from 'pdfjs-dist'

try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.bundle.js' } catch (_) {}

function b64ToBytes(b64) {
	const bin = atob(b64)
	const len = bin.length
	const bytes = new Uint8Array(len)
	for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
	return bytes
}

if (typeof window !== 'undefined') {
	window.PDFViewer = {
		available: true,
		engine: 'pdf.js',
		async render(container, base64, opts) {
			opts = opts || {}
			container.classList.add('pdfjs-root')
			container.innerHTML = ''
			const data = b64ToBytes(base64)
			const task = pdfjsLib.getDocument({ data, disableStream: true, disableAutoFetch: true })
			const pdf = await task.promise
			const pages = []
			const canvases = []
			for (let n = 1; n <= pdf.numPages; n++) {
				const wrap = document.createElement('div')
				wrap.className = 'pdfjs-page'
				const canvas = document.createElement('canvas')
				wrap.appendChild(canvas)
				container.appendChild(wrap)
				pages.push(await pdf.getPage(n))
				canvases.push(canvas)
			}
			let scale = opts.scale || 1.15
			const dpr = Math.min(window.devicePixelRatio || 1, 2)
			async function renderAll() {
				for (let i = 0; i < pages.length; i++) {
					const page = pages[i]
					const canvas = canvases[i]
					const vp = page.getViewport({ scale: scale * dpr })
					const vpCss = page.getViewport({ scale })
					canvas.width = Math.floor(vp.width)
					canvas.height = Math.floor(vp.height)
					canvas.style.width = Math.floor(vpCss.width) + 'px'
					canvas.style.height = Math.floor(vpCss.height) + 'px'
					const ctx = canvas.getContext('2d')
					await page.render({ canvasContext: ctx, viewport: vp }).promise
				}
			}
			await renderAll()
			return {
				pageCount: pdf.numPages,
				setScale(s) { scale = Math.max(0.4, Math.min(4, s)); renderAll() },
				fitWidth() {
					const avail = (container.clientWidth || 800) - 28
					const vp1 = pages[0].getViewport({ scale: 1 })
					scale = Math.max(0.4, Math.min(4, avail / vp1.width))
					renderAll()
					return scale
				},
				destroy() { try { pdf.destroy && pdf.destroy() } catch (_) {} },
			}
		},
	}
}
