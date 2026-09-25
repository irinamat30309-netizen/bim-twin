// Potree point-cloud renderer (CloudCompare-like LOD/EDL) built into an isolated
// esbuild IIFE bundle. Exposes window.PotreeView. NEVER throws at load time: any
// failure leaves available:false and the app falls back to the built-in octree.
//
// Data pipeline: the main process converts LAS/LAZ into Potree 2.0 format with an
// external PotreeConverter (optional, dropped by the user into
// vendor/potree-converter/). This module only renders an already-converted
// dataset given the file:// URL of its metadata.json.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Potree } from '@pnext/three-loader'

let host = null
let renderer = null
let scene = null
let camera = null
let controls = null
let potree = null
let clouds = []
let raf = 0
let hud = null
let onExitCb = null

function stopLoop() {
	if (raf) { cancelAnimationFrame(raf); raf = 0 }
}

function resize() {
	if (!renderer || !camera || !host) return
	const w = host.clientWidth || host.offsetWidth || 800
	const h = host.clientHeight || host.offsetHeight || 600
	renderer.setSize(w, h, false)
	camera.aspect = w / Math.max(1, h)
	camera.updateProjectionMatrix()
}

function buildHud() {
	const bar = document.createElement('div')
	bar.style.cssText =
		'position:absolute;top:10px;right:10px;z-index:60;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;max-width:100%'
	const mk = (label, bg, title) => {
		const b = document.createElement('button')
		b.textContent = label
		b.title = title || label
		b.style.cssText =
			'padding:7px 12px;border:none;border-radius:9px;color:#fff;font:600 13px system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;background:' +
			bg
		return b
	}
	const exit = mk('Выйти', '#b3402f', 'Закрыть Potree (Esc)')
	exit.onclick = () => api.exit()
	bar.appendChild(exit)
	return bar
}

function ensureScene() {
	if (renderer) return true
	const canvas = document.createElement('canvas')
	canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
	renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
	renderer.setClearColor(0x0a0d12, 1)
	scene = new THREE.Scene()
	camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100000)
	camera.position.set(0, 0, 10)
	controls = new OrbitControls(camera, renderer.domElement)
	controls.enableDamping = true
	controls.dampingFactor = 0.08
	potree = new Potree()
	potree.pointBudget = 3000000
	return true
}

function loop() {
	raf = requestAnimationFrame(loop)
	if (controls) controls.update()
	if (potree && clouds.length) {
		try { potree.updatePointClouds(clouds, camera, renderer) } catch (_) {}
	}
	renderer.render(scene, camera)
}

function frameTo(pco) {
	const box = pco.boundingBox || (pco.pcoGeometry && pco.pcoGeometry.boundingBox)
	if (!box) return
	const c = new THREE.Vector3(); box.getCenter(c)
	const s = new THREE.Vector3(); box.getSize(s)
	const r = Math.max(s.x, s.y, s.z) || 10
	controls.target.copy(c)
	camera.position.set(c.x, c.y, c.z + r * 1.6)
	camera.near = r / 1000; camera.far = r * 100
	camera.updateProjectionMatrix()
	controls.update()
}

function onKey(e) { if (e.key === 'Escape') api.exit() }

const api = {
	available: true,
	engine: 'potree',
	mount(hostEl, opts) {
		host = hostEl
		onExitCb = (opts && opts.onExit) || null
		ensureScene()
		if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
		if (renderer.domElement.parentNode !== host) host.appendChild(renderer.domElement)
		if (!hud) hud = buildHud()
		if (hud.parentNode !== host) host.appendChild(hud)
		host.style.display = ''
		resize()
		window.addEventListener('resize', resize)
		document.addEventListener('keydown', onKey)
		if (!raf) loop()
	},
	// url: file:// URL to the converted dataset's metadata.json
	async loadPotree(url) {
		try {
			ensureScene()
			const i = String(url).lastIndexOf('/')
			const base = String(url).slice(0, i)
			const name = String(url).slice(i + 1)
			const pco = await potree.loadPointCloud(name, (rel) => base + '/' + rel)
			if (!pco) return false
			const m = pco.material
			if (m) {
				m.size = 1.0
				if ('pointSizeType' in m) m.pointSizeType = 2 // adaptive
				if ('shape' in m) m.shape = 1 // circle
				if ('activeAttributeName' in m) m.activeAttributeName = 'rgba'
			}
			scene.add(pco)
			clouds = [pco]
			try { frameTo(pco) } catch (_) {}
			return true
		} catch (e) {
			console.warn('[potree] load failed', e)
			return false
		}
	},
	isOpen() { return !!(host && host.style.display !== 'none' && clouds.length) },
	exit() {
		stopLoop()
		window.removeEventListener('resize', resize)
		document.removeEventListener('keydown', onKey)
		try { for (const c of clouds) scene.remove(c) } catch (_) {}
		clouds = []
		if (host) host.style.display = 'none'
		if (typeof onExitCb === 'function') { try { onExitCb() } catch (_) {} }
	},
}

if (typeof window !== 'undefined') window.PotreeView = api
export default api
