"""Cloud2BIM-style geometric reconstruction (pure NumPy, optional SciPy).

Inspired by the open-source Cloud2BIM pipeline (Zbirovsky & Nezerka, Automation
in Construction 2025, MIT): density rasterisation + morphology to extract slabs,
walls and openings, with strict density gating so unsupported (phantom) walls are
not emitted. Extended here with:
  * per-wall opening detection (doors vs windows) with an 'uncertain' flag,
  * a support ratio per wall (drops phantom walls like a mid-corridor ghost),
  * cylinder pipes with estimated diameter + material (see pipes.py),
  * hanging cables as polylines (see cables.py).

Everything degrades gracefully: if SciPy is missing we fall back to NumPy-only
morphology. The output dict matches app/geom.py so ifc_writer/pipeline stay
simple. Coordinates are IFC convention: X,Y plan, Z up, floor at Z=0.
"""
import numpy as np

from . import geom

try:
    from scipy import ndimage as _ndi
    _HAVE_SCIPY = True
except Exception:  # pragma: no cover - scipy optional
    _ndi = None
    _HAVE_SCIPY = False


# ----------------------------------------------------------------------------
# Level (slab) detection
# ----------------------------------------------------------------------------
def detect_levels(v, expect_h=(2.0, 6.0)):
    """Given the up-axis coordinate array v, return (floor, ceil) via histogram
    peaks. Robust to clutter: floor = strongest peak in the lower third, ceil =
    strongest peak in the upper third."""
    lo, hi = float(v.min()), float(v.max())
    span = hi - lo
    nb = max(24, int(span / 0.03))
    h, edges = np.histogram(v, bins=nb)
    centers = (edges[:-1] + edges[1:]) / 2
    third = max(1, nb // 3)
    fi = int(np.argmax(h[:third]))
    ci = int(2 * third + np.argmax(h[2 * third:]))
    floor = float(centers[fi])
    ceil = float(centers[ci])
    # refine by local median
    fm = np.abs(v - floor) < 0.10
    cm = np.abs(v - ceil) < 0.10
    if fm.any():
        floor = float(np.median(v[fm]))
    if cm.any():
        ceil = float(np.median(v[cm]))
    return floor, ceil


# ----------------------------------------------------------------------------
# Wall support helpers
# ----------------------------------------------------------------------------
def _wall_support(P_band, up_band, a, b, floor, ceil, halfw=0.20):
    """Return (support_ratio, coverage) of a candidate wall using the band point
    cloud. support_ratio = fraction of 0.5 m length bins that hold >=5 points;
    coverage = distinct vertical-fraction the wall spans. Used to reject phantom
    walls that have little real point evidence."""
    d = b - a
    L = float(np.hypot(*d))
    if L < 1e-6:
        return 0.0, 0.0
    u = d / L
    n = np.array([-u[1], u[0]])
    rel = P_band - a
    along = rel @ u
    perp = np.abs(rel @ n)
    sel = (perp < halfw) & (along > -0.1) & (along < L + 0.1)
    if sel.sum() < 5:
        return 0.0, 0.0
    nb = max(1, int(np.ceil(L / 0.5)))
    binidx = np.clip((along[sel] / 0.5).astype(np.int64), 0, nb - 1)
    filled = np.unique(binidx).size
    support = filled / nb
    height = max(1e-6, ceil - floor)
    vfrac = (up_band[sel] - floor) / height
    vb = np.clip((vfrac * 10).astype(np.int64), 0, 9)
    coverage = np.unique(vb).size / 10.0
    return float(support), float(coverage)


# ----------------------------------------------------------------------------
# Collinear wall merging
# ----------------------------------------------------------------------------
def _merge_collinear(raw_walls, ang_tol_deg=8.0, perp_tol=0.25):
    """Merge wall segments that lie on the same infinite line and overlap or are
    close end-to-end. Returns a reduced list with extended endpoints."""
    items = []
    for w in raw_walls:
        a = np.asarray(w['p0'], dtype=np.float64)
        b = np.asarray(w['p1'], dtype=np.float64)
        d = b - a
        L = float(np.hypot(*d))
        if L < 1e-6:
            continue
        u = d / L
        ang = np.arctan2(u[1], u[0]) % np.pi
        items.append({'a': a, 'b': b, 'u': u, 'ang': ang, 'len': L,
                      'thickness': w['thickness']})
    items.sort(key=lambda x: -x['len'])
    used = [False] * len(items)
    out = []
    ang_tol = np.deg2rad(ang_tol_deg)
    for i, it in enumerate(items):
        if used[i]:
            continue
        used[i] = True
        a, u, ang = it['a'], it['u'], it['ang']
        n = np.array([-u[1], u[0]])
        pts_t = [(it['a'] - a) @ u, (it['b'] - a) @ u]
        thick = [it['thickness']]
        for j in range(i + 1, len(items)):
            if used[j]:
                continue
            jt = items[j]
            da = abs(jt['ang'] - ang)
            da = min(da, np.pi - da)
            if da > ang_tol:
                continue
            # perpendicular distance of segment j to line i (both endpoints)
            pd0 = abs((jt['a'] - a) @ n)
            pd1 = abs((jt['b'] - a) @ n)
            if max(pd0, pd1) > perp_tol:
                continue
            t0 = (jt['a'] - a) @ u
            t1 = (jt['b'] - a) @ u
            lo, hi = min(pts_t), max(pts_t)
            # overlap or small gap (<0.6 m) along the line
            if min(t0, t1) > hi + 0.6 or max(t0, t1) < lo - 0.6:
                continue
            used[j] = True
            pts_t.extend([t0, t1])
            thick.append(jt['thickness'])
        lo, hi = min(pts_t), max(pts_t)
        p0 = a + u * lo
        p1 = a + u * hi
        out.append({'p0': p0.tolist(), 'p1': p1.tolist(),
                    'thickness': float(np.median(thick)),
                    'length': float(hi - lo)})
    return out


def _corridor_walls_from_grid(xyz, up, plan_ax, floor, ceil, voxel=0.03):
    """Find real vertical planes in elongated interiors without diagonal RANSAC ghosts."""
    xyz = np.asarray(xyz, dtype=np.float64)
    P = xyz[:, plan_ax]; v = xyz[:, up]
    pmin = P.min(0); pmax = P.max(0); spans = pmax - pmin
    short_ax = int(np.argmin(spans)); long_ax = 1 - short_ax
    if spans[long_ax] < 3.5 * max(spans[short_ax], 1e-6):
        return []
    cell = max(0.05, voxel * 1.5); vcell = 0.10
    height = max(0.1, ceil - floor)
    mid = (v > floor + 0.12 * height) & (v < ceil - 0.12 * height)
    PP = P[mid]; vv = v[mid]
    if PP.shape[0] < 1000:
        return []
    q = np.floor((PP - pmin) / cell).astype(np.int32)
    qv = np.floor((vv - floor) / vcell).astype(np.int32)
    dims = np.ceil(spans / cell).astype(np.int64) + 1
    nv = int(np.ceil(height / vcell)) + 1
    key = (q[:, 0].astype(np.int64) * dims[1] + q[:, 1]) * nv + qv
    plan = np.unique(key) // nv
    plan_keys, vertical_bins = np.unique(plan, return_counts=True)
    structural = plan_keys[vertical_bins >= max(7, int(height / vcell * 0.20))]
    qa = structural // dims[1]; qb = structural % dims[1]; coords = [qa, qb]
    score = np.bincount(coords[long_ax], minlength=int(dims[long_ax]))
    # A transverse wall must occupy at least a third of the corridor width.
    # The former 17% threshold promoted a rack/diagonal floor clutter cluster
    # to the user's false "Wall 7".
    threshold = max(10, int(np.ceil(dims[short_ax] * 0.33)))
    candidate = np.where(score >= threshold)[0]
    if candidate.size < 2:
        return []
    groups, cur = [], [int(candidate[0])]
    max_gap = max(1, int(round(0.35 / cell)))
    for idx in candidate[1:]:
        idx = int(idx)
        if idx - cur[-1] <= max_gap: cur.append(idx)
        else: groups.append(cur); cur = [idx]
    groups.append(cur)
    cross = []
    for g in groups:
        lo = pmin[long_ax] + (min(g) + 0.5) * cell
        hi = pmin[long_ax] + (max(g) + 0.5) * cell
        item = (float((lo + hi) * 0.5),
                float(np.clip((max(g) - min(g) + 1) * cell, 0.10, 0.35)))
        if not cross or item[0] - cross[-1][0] >= 0.45: cross.append(item)
    if len(cross) < 2:
        return []
    slo = float(np.quantile(P[:, short_ax], 0.001)); shi = float(np.quantile(P[:, short_ax], 0.999))
    llo, lhi = cross[0][0], cross[-1][0]
    def pt(s, l):
        out = np.zeros(2); out[short_ax] = s; out[long_ax] = l; return out
    walls = []
    for side in (slo, shi):
        walls.append({'p0': pt(side, llo), 'p1': pt(side, lhi), 'thickness': 0.12,
                      'length': lhi-llo, 'corridor_grid': True, 'envelope': True})
    for pos, thick in cross:
        walls.append({'p0': pt(slo, pos), 'p1': pt(shi, pos), 'thickness': thick,
                      'length': shi-slo, 'corridor_grid': True, 'envelope': False})
    return walls


# ----------------------------------------------------------------------------
# Opening detection
# ----------------------------------------------------------------------------
def detect_openings(P_wallband, up_wallband, a, b, floor, ceil, thickness):
    """Detect door/window openings on one wall.

    We take points close to the wall plane across the FULL height, bin them along
    the wall length, and look for spans whose vertical occupancy collapses -
    those are holes (doors reach the floor, windows are elevated).
    Returns a list of {along, width, kind, sill, head, uncertain}.
    """
    d = b - a
    L = float(np.hypot(*d))
    if L < 0.8:
        return []
    u = d / L
    n = np.array([-u[1], u[0]])
    rel = P_wallband - a
    along = rel @ u
    perp = np.abs(rel @ n)
    halfw = max(0.12, thickness * 0.75)
    sel = (perp < halfw) & (along > 0) & (along < L)
    if sel.sum() < 40:
        return []
    al = along[sel]
    vv = up_wallband[sel]
    height = max(1e-6, ceil - floor)
    binw = 0.12
    nb = max(4, int(np.ceil(L / binw)))
    # vertical occupancy per length bin (distinct 0.1*H vertical cells)
    lb = np.clip((al / binw).astype(np.int64), 0, nb - 1)
    vf = np.clip(((vv - floor) / height * 12).astype(np.int64), 0, 11)
    occ = np.zeros(nb, dtype=np.float64)
    counts = np.zeros(nb, dtype=np.int64)
    for i in range(nb):
        m = lb == i
        counts[i] = int(m.sum())
        if counts[i]:
            occ[i] = np.unique(vf[m]).size
    med = float(np.median(occ[occ > 0])) if np.any(occ > 0) else 0.0
    if med <= 0:
        return []
    guard = counts < max(1, int(np.median(counts[counts > 0]) * 0.15))
    hole = (occ < med * 0.5) | guard  # collapsed vertical column = hole
    # group consecutive hole bins into spans
    openings = []
    i = 0
    while i < nb:
        if not hole[i]:
            i += 1
            continue
        j = i
        while j < nb and hole[j]:
            j += 1
        span_bins = j - i
        width = span_bins * binw
        # ignore holes at the very ends (likely wall end, not an opening)
        at_end = (i <= 0) or (j >= nb)
        if 0.5 <= width <= 3.0 and not at_end:
            center = (i + j) / 2 * binw
            # sill/head: vertical range of points flanking the hole
            left = lb == max(0, i - 1)
            right = lb == min(nb - 1, j)
            flank = left | right
            if flank.sum() >= 5:
                fv = (vv[flank] - floor)
                sill = float(np.percentile(fv, 5))
                head = float(np.percentile(fv, 95))
            else:
                sill, head = 0.0, height
            # door reaches (near) the floor; else window
            # Construction clutter and an unfinished threshold often leave
            # points 0.3-0.7 m above the floor inside a real doorway.
            kind = 'door' if sill < 0.75 else 'window'
            # uncertain if narrow flanks / partial evidence
            leftS = counts[max(0, i - 1)] > 0
            rightS = counts[min(nb - 1, j)] > 0
            uncertain = not (leftS and rightS) or width > 2.6
            openings.append({
                'along': float(center), 'width': float(width), 'kind': kind,
                'sill': sill, 'head': head, 'uncertain': bool(uncertain),
            })
        i = j
    return openings


def detect_door_voids(P_wallband, up_wallband, a, b, floor, ceil, thickness):
    """Detect actual low-level void rectangles with a supported header.

    This complements the coarse whole-column detector above. It is especially
    effective on the short cross walls in this scan, where doors are obvious
    empty rectangles but the lintel keeps total vertical occupancy high.
    """
    d = b-a; length = float(np.hypot(*d)); height = float(ceil-floor)
    if length < 0.8: return []
    u=d/length; n=np.array([-u[1],u[0]]); rel=P_wallband-a
    al=rel@u; per=np.abs(rel@n)
    sel=(per<max(.14,thickness*.75))&(al>=0)&(al<=length)
    if int(sel.sum())<80: return []
    bw=.06; bh=.08; nx=max(4,int(np.ceil(length/bw))); ny=max(8,int(np.ceil(height/bh)))
    ix=np.clip((al[sel]/bw).astype(np.int64),0,nx-1)
    iy=np.clip(((up_wallband[sel]-floor)/bh).astype(np.int64),0,ny-1)
    hist=np.zeros((nx,ny),dtype=np.int32); np.add.at(hist,(ix,iy),1)
    occ=(hist>=2).astype(np.float64)
    low=occ[:,int(.15/bh):max(int(.2/bh)+1,int(2.05/bh))].mean(1)
    head=occ[:,int(2.10/bh):max(int(2.2/bh)+1,int(min(3.15,height-.1)/bh))].mean(1)
    kernel=np.ones(3)/3.; low=np.convolve(low,kernel,'same'); head=np.convolve(head,kernel,'same')
    lr=float(np.percentile(low[low>0],70)) if np.any(low>0) else 0.
    hr=float(np.percentile(head[head>0],50)) if np.any(head>0) else 0.
    # Sparse longitudinal surfaces must not manufacture openings in unscanned areas.
    if length>8 and (lr<.55 or hr<.45): return []
    hole=(low<max(.06,lr*.32))&(head>max(.04,hr*.20))
    for _ in range(2): hole[1:-1]|=hole[:-2]&hole[2:]
    out=[]; i=0
    while i<nx:
        if not hole[i]: i+=1; continue
        j=i+1
        while j<nx and hole[j]: j+=1
        width=(j-i)*bw
        if .45<=width<=2.2:
            # Snap to common construction increments without shrinking the void.
            width=float(np.ceil(width/.06)*.06)
            center=float((i+j)*.5*bw)
            out.append({'along':center,'width':width,'kind':'door','sill':0.0,
                        'head':float(min(height,2.20)),'uncertain':False,
                        'source':'void-rectangle'})
        i=j
    return out


def _merge_openings(primary, rectangles):
    out=list(primary)
    for r in rectangles:
        match=-1
        for i,o in enumerate(out):
            if abs(float(o['along'])-float(r['along'])) < max(.35,(o['width']+r['width'])*.35):
                match=i; break
        if match>=0:
            # Geometric void rectangle gives better width/sill/head than flanks.
            out[match]=r
        else: out.append(r)
    return sorted(out,key=lambda o:o['along'])


def _wall_appearance(P, v, rgb, a, b, floor, ceil, thickness):
    """Compact colour atlas projected from scan points onto a wall surface."""
    if rgb is None:
        return None
    d = b - a; length = float(np.hypot(*d)); height = float(ceil - floor)
    if length < 0.2 or height < 0.2:
        return None
    u = d / length; n = np.array([-u[1], u[0]])
    rel = P - a; along = rel @ u; perp = np.abs(rel @ n)
    sel = (perp < max(0.16, thickness)) & (along >= 0) & (along <= length) & (v >= floor) & (v <= ceil)
    if int(sel.sum()) < 40:
        return None
    al = along[sel]; yy = v[sel] - floor
    cc = np.asarray(rgb)[sel].astype(np.float64)
    if cc.size == 0:
        return None
    if float(np.nanmax(cc)) <= 1.0001:
        cc *= 255.0
    # 8 cm texels preserve brick courses and service markings while keeping
    # the browser mesh comfortably below one million vertices for this scan.
    cols = int(np.clip(np.ceil(length / 0.08), 8, 384))
    rows = int(np.clip(np.ceil(height / 0.08), 8, 64))
    ix = np.clip((al / length * cols).astype(np.int64), 0, cols - 1)
    iy = np.clip((yy / height * rows).astype(np.int64), 0, rows - 1)
    k = iy * cols + ix
    cnt = np.bincount(k, minlength=rows * cols).astype(np.float64)
    sums = np.zeros((rows * cols, 3), dtype=np.float64)
    for ch in range(3):
        sums[:, ch] = np.bincount(k, weights=cc[:, ch], minlength=rows * cols)
    base = np.nanmedian(cc, axis=0)
    colors = np.tile(base, (rows * cols, 1))
    good = cnt > 0
    colors[good] = sums[good] / cnt[good, None]
    # Fill empty texels from immediate neighbours, retaining the wall median as fallback.
    grid = colors.reshape(rows, cols, 3); valid = good.reshape(rows, cols)
    for _ in range(3):
        if valid.all(): break
        old = grid.copy(); oldv = valid.copy()
        for y in range(rows):
            for x in range(cols):
                if oldv[y, x]: continue
                vals = []
                for dy, dx in ((-1,0),(1,0),(0,-1),(0,1)):
                    yy2, xx2 = y + dy, x + dx
                    if 0 <= yy2 < rows and 0 <= xx2 < cols and oldv[yy2, xx2]: vals.append(old[yy2, xx2])
                if vals: grid[y, x] = np.mean(vals, axis=0); valid[y, x] = True
    return {'cols': cols, 'rows': rows,
            'colors': np.clip(np.rint(grid), 0, 255).astype(np.uint8).reshape(-1).tolist(),
            'coverage': round(float(good.mean()), 3)}


# ----------------------------------------------------------------------------
# Main reconstruction
# ----------------------------------------------------------------------------
def reconstruct(xyz, rgb=None, voxel=0.03, min_support=0.45, min_coverage=0.5):
    """Full Cloud2BIM-style reconstruction. Returns a model dict."""
    rng = np.random.default_rng(12345)
    xyz = np.asarray(xyz, dtype=np.float64)
    if xyz.shape[0] > 1_500_000:
        # keep rgb aligned if we downsample
        idx = rng.choice(xyz.shape[0], 1_500_000, replace=False)
        xyz = xyz[idx]
        if rgb is not None:
            rgb = np.asarray(rgb)[idx]
    up, floor0, ceil0 = geom.detect_up_axis(xyz)
    plan_ax = [i for i in range(3) if i != up]
    v = xyz[:, up]
    P = xyz[:, plan_ax]
    floor, ceil = detect_levels(v)
    height = max(0.1, ceil - floor)

    pmin = P.min(0)
    pmax = P.max(0)
    footprint = [[0.0, 0.0], [float(pmax[0] - pmin[0]), float(pmax[1] - pmin[1])]]
    floor_area = float((pmax[0] - pmin[0]) * (pmax[1] - pmin[1]))

    # --- walls from mid-height band + RANSAC (reuse geom), then gate by support
    bmask = (v > floor + 0.15 * height) & (v < ceil - 0.15 * height)
    cell = max(voxel * 2, 0.05)
    raw_walls = geom.detect_walls(P[bmask], cell, floor, ceil, v[bmask], rng)
    Pb = P[bmask]
    vb = v[bmask]
    # full-height band for opening detection (exclude only floor/ceiling slabs)
    omask = (v > floor + 0.05) & (v < ceil - 0.05)
    Po_all = P[omask]
    vo_all = v[omask]

    # merge near-collinear duplicate wall segments (RANSAC finds a long wall as
    # several parallel lines) before gating so we do not keep 7 ghosts of 1 wall
    raw_walls = _merge_collinear(raw_walls)
    corridor_walls = _corridor_walls_from_grid(xyz, up, plan_ax, floor, ceil, voxel)
    if corridor_walls:
        raw_walls = corridor_walls

    walls = []
    for w in raw_walls:
        a = np.asarray(w['p0'], dtype=np.float64)
        b = np.asarray(w['p1'], dtype=np.float64)
        support, coverage = _wall_support(Pb, vb, a, b, floor, ceil)
        # phantom rejection: a real wall has both length support and vertical coverage
        if not w.get('corridor_grid') and (support < min_support or coverage < min_coverage):
            continue
        openings = detect_openings(Po_all, vo_all, a, b, floor, ceil, w['thickness'])
        openings = _merge_openings(openings, detect_door_voids(
            Po_all, vo_all, a, b, floor, ceil, w['thickness']))
        appearance = _wall_appearance(P, v, rgb, a, b, floor, ceil, w['thickness'])
        walls.append({
            'p0': [float(a[0] - pmin[0]), float(a[1] - pmin[1])],
            'p1': [float(b[0] - pmin[0]), float(b[1] - pmin[1])],
            'thickness': float(min(max(w['thickness'], 0.08), 0.6)),
            'length': float(w['length']),
            'support': round(support, 3),
            'coverage': round(coverage, 3),
            'source': 'vertical-grid' if w.get('corridor_grid') else 'ransac',
            'inferred_envelope': bool(w.get('envelope') and support < min_support),
            'openings': openings,
            'appearance': appearance,
        })

    return {
        'up_axis': int(up), 'floor': 0.0, 'ceil': float(height), 'height': float(height),
        'floor_abs': float(floor), 'ceil_abs': float(ceil),
        'pmin': [float(pmin[0]), float(pmin[1])], 'plan_ax': plan_ax,
        'walls': walls,
        'slabs': [
            {'kind': 'floor', 'z': 0.0, 'thickness': 0.15, 'footprint': footprint},
            {'kind': 'ceiling', 'z': float(height), 'thickness': 0.15, 'footprint': footprint},
        ],
        'pipes': [], 'cables': [], 'objects': [],
        'floor_area': floor_area, 'footprint': footprint,
        'stats': {
            'wall_count': len(walls),
            'opening_count': int(sum(len(w['openings']) for w in walls)),
            'pipe_count': 0, 'cable_count': 0, 'object_count': 0,
        },
        'engine': 'cloud2bim',
    }
