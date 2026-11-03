// Entry bundled by scripts/build-pcsplat.mjs (esbuild) into
// renderer/vendor/pcsplat.bundle.js. Exposes window.PCSplat, a high-quality
// 3D Gaussian Splatting viewer built on the PlayCanvas engine (MIT).
//
// PlayCanvas ships a compute/vertex Gaussian-splat renderer with GPU sorting
// and WebGL2 support, giving crisp results and smooth performance even on
// weaker machines. If this bundle is missing (offline / not built), app.js
// falls back to the built-in SplatViewer — no regression.
import * as pc from 'playcanvas'

function el(tag, css) {
	var e = document.createElement(tag)
	if (css) e.style.cssText = css
	return e
}

var S = {
	host: null, wrap: null, canvas: null, hud: null,
	app: null, device: null, camera: null, splat: null,
	open: false, ready: false,
	// orbit state
	target: null, dist: 6, yaw: 0, pitch: -0.2,
	dragging: 0, lastX: 0, lastY: 0,
}

function placeCamera() {
	if (!S.camera) return
	var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch)
	var cy = Math.cos(S.yaw), sy = Math.sin(S.yaw)
	var t = S.target
	var x = t.x + S.dist * cp * sy
	var y = t.y + S.dist * sp
	var z = t.z + S.dist * cp * cy
	S.camera.setPosition(x, y, z)
	S.camera.lookAt(t.x, t.y, t.z)
}

function bindControls() {
	var c = S.canvas
	c.addEventListener('contextmenu', function (e) { e.preventDefault() })
	c.addEventListener('pointerdown', function (e) {
		S.dragging = e.button === 2 || e.shiftKey ? 2 : 1
		S.lastX = e.clientX; S.lastY = e.clientY
		try { c.setPointerCapture(e.pointerId) } catch (_) {}
	})
	c.addEventListener('pointerup', function (e) {
		S.dragging = 0
		try { c.releasePointerCapture(e.pointerId) } catch (_) {}
	})
	c.addEventListener('pointermove', function (e) {
		if (!S.dragging) return
		var dx = e.clientX - S.lastX, dy = e.clientY - S.lastY
		S.lastX = e.clientX; S.lastY = e.clientY
		if (S.dragging === 1) {
			S.yaw -= dx * 0.005
			S.pitch = Math.max(-1.5, Math.min(1.5, S.pitch - dy * 0.005))
		} else {
			// pan in camera plane
			var cy = Math.cos(S.yaw), sy = Math.sin(S.yaw)
			var panK = S.dist * 0.0015
			S.target.x -= (cy * dx) * panK
			S.target.z += (sy * dx) * panK
			S.target.y += dy * panK
		}
		placeCamera()
	})
	c.addEventListener('wheel', function (e) {
		e.preventDefault()
		var f = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.12)
		S.dist = Math.max(0.05, Math.min(1000, S.dist * f))
		placeCamera()
	}, { passive: false })
}

async function ensureApp() {
	if (S.app) return S.app
	var gfxOptions = { deviceTypes: ['webgl2'], antialias: true }
	S.device = await pc.createGraphicsDevice(S.canvas, gfxOptions)
	var opts = new pc.AppOptions()
	opts.graphicsDevice = S.device
	opts.componentSystems = [pc.CameraComponentSystem, pc.GSplatComponentSystem]
	opts.resourceHandlers = [pc.GSplatHandler]
	var app = new pc.AppBase(S.canvas)
	app.init(opts)
	app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW)
	app.setCanvasResolution(pc.RESOLUTION_AUTO)
	S.app = app
	// camera
	S.target = new pc.Vec3(0, 0, 0)
	S.camera = new pc.Entity('camera')
	S.camera.addComponent('camera', {
		clearColor: new pc.Color(0.04, 0.05, 0.07, 1),
		farClip: 5000,
		nearClip: 0.02,
	})
	app.root.addChild(S.camera)
	placeCamera()
	app.start()
	bindControls()
	return app
}

function frameToSplat() {
	try {
		var aabb = S.splat && S.splat.gsplat && S.splat.gsplat.instance &&
			S.splat.gsplat.instance.meshInstance && S.splat.gsplat.instance.meshInstance.aabb
		if (aabb) {
			S.target.copy(aabb.center)
			var r = aabb.halfExtents.length()
			if (isFinite(r) && r > 0) S.dist = r * 2.2
		}
	} catch (_) {}
	placeCamera()
}

var api = {
	available: true,
	engine: 'playcanvas',
	onTour: null,
	mount: function (hostEl) {
		if (S.wrap && S.host === hostEl) return
		S.host = hostEl
		var wrap = el('div', 'position:absolute;inset:0;z-index:46;display:none;background:#0a0d12')
		var canvas = el('canvas', 'width:100%;height:100%;display:block;outline:none;cursor:grab')
		wrap.appendChild(canvas)
		// minimal HUD
		var hud = el('div', 'position:absolute;top:10px;right:10px;display:flex;gap:8px;align-items:center;pointer-events:none;font:13px system-ui,sans-serif;color:#e6edf3')
		var hint = el('span', 'opacity:.8;background:rgba(10,14,20,.7);padding:6px 10px;border-radius:8px')
		hint.textContent = 'ЛКМ — вращение · ПКМ/Shift — панорама · колесо — зум'
		var exit = el('button', 'pointer-events:auto;display:inline-flex;align-items:center;gap:6px;background:#b3402f;color:#fff;border:1px solid rgba(255,180,170,.45);border-radius:9px;padding:6px 10px;font:600 12.5px system-ui,sans-serif;cursor:pointer')
		exit.textContent = 'Выйти'
		exit.onclick = function () { api.exit() }
		var tourBtn = el('button', 'pointer-events:auto;display:inline-flex;align-items:center;gap:6px;background:#1f6feb;color:#fff;border:1px solid rgba(150,190,255,.5);border-radius:9px;padding:6px 10px;font:600 12.5px system-ui,sans-serif;cursor:pointer')
		tourBtn.textContent = 'Тур'
		tourBtn.title = 'Открыть обход по станциям (ходьба W/S/A/D, маркеры)'
		tourBtn.onclick = function () { if (typeof api.onTour === 'function') { try { api.onTour() } catch (e) {} } }
		hud.appendChild(hint); hud.appendChild(tourBtn); hud.appendChild(exit)
		wrap.appendChild(hud)
		hostEl.appendChild(wrap)
		S.wrap = wrap; S.canvas = canvas; S.hud = hud
		window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open) api.exit() })
	},
	load: async function (arrayBuffer, name) {
		if (!S.wrap) return false
		api.enter()
		try {
			await ensureApp()
		} catch (e) {
			console.warn('[pcsplat] device/app init failed', e)
			api.exit()
			return false
		}
		// remove previous splat
		if (S.splat) { try { S.splat.destroy() } catch (_) {} S.splat = null }
		var fname = name || 'scene.ply'
		if (!/\.(ply|splat|ksplat|sog|json)$/i.test(fname)) fname += '.ply'
		var blob = new Blob([arrayBuffer])
		var url = URL.createObjectURL(blob)
		return await new Promise(function (resolve) {
			try {
				var asset = new pc.Asset(fname, 'gsplat', { url: url, filename: fname })
				asset.once('load', function () {
					try {
						var ent = new pc.Entity('splat')
						ent.addComponent('gsplat', { asset: asset })
						S.app.root.addChild(ent)
						S.splat = ent
						setTimeout(frameToSplat, 60)
						resolve(true)
					} catch (e2) { console.warn('[pcsplat] add gsplat failed', e2); resolve(false) }
					try { URL.revokeObjectURL(url) } catch (_) {}
				})
				asset.once('error', function (err) {
					console.warn('[pcsplat] asset error', err)
					try { URL.revokeObjectURL(url) } catch (_) {}
					resolve(false)
				})
				S.app.assets.add(asset)
				S.app.assets.load(asset)
			} catch (e) {
				console.warn('[pcsplat] load threw', e)
				resolve(false)
			}
		})
	},
	enter: function () {
		if (!S.wrap) return
		S.wrap.style.display = 'block'
		S.open = true
		if (S.app) { S.app.autoRender = true; try { S.app.resizeCanvas() } catch (_) {} }
	},
	exit: function () {
		S.open = false
		if (S.wrap) S.wrap.style.display = 'none'
		if (S.app) S.app.autoRender = false
	},
	isOpen: function () { return !!S.open },
}

if (typeof window !== 'undefined') window.PCSplat = api
export default api
