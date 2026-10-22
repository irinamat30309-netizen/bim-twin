"""Geometric scan-to-BIM pipeline (pure numpy, CPU).

Used as the deterministic fallback of the AI server and to convert deep-learning
semantic labels into BIM primitives. Detects up-axis, floor/ceiling slabs, walls
(vertical-density grid + line RANSAC + merge), overhead pipes (RANSAC cylinders),
and free-standing objects (voxel clustering). Coordinates are returned already in
IFC convention: X,Y horizontal, Z up with floor at Z=0.
"""
import numpy as np


def _voxel_downsample(xyz, vs):
    keys = np.floor(xyz / vs).astype(np.int64)
    order = np.lexsort((keys[:, 2], keys[:, 1], keys[:, 0]))
    ks = keys[order]
    xs = xyz[order]
    diff = np.any(ks[1:] != ks[:-1], axis=1)
    bounds = np.concatenate([[0], np.nonzero(diff)[0] + 1, [len(ks)]])
    cent = np.add.reduceat(xs, bounds[:-1], axis=0) / np.diff(bounds)[:, None]
    return cent


def detect_up_axis(xyz):
    """Up axis = the one whose two extremes both host dense planar peaks (floor+ceiling)."""
    best = None
    for a in range(3):
        c = xyz[:, a]
        lo, hi = c.min(), c.max()
        span = hi - lo
        if span < 1.5 or span > 12:  # room height plausibility
            plausible = False
        else:
            plausible = True
        nb = max(12, int(span / 0.05))
        h, edges = np.histogram(c, bins=nb)
        centers = (edges[:-1] + edges[1:]) / 2
        third = max(1, nb // 3)
        low_i = int(np.argmax(h[:third]))
        high_i = int(2 * third + np.argmax(h[2 * third:]))
        score = min(int(h[low_i]), int(h[high_i]))
        if plausible:
            score = int(score * 1.5)
        if best is None or score > best[0]:
            best = (score, a, centers[low_i], centers[high_i])
    _, axis, floor, ceil = best
    return axis, float(floor), float(ceil)


def _ransac_line(P, thr, iters, min_inliers, rng):
    """P: (M,2) points. Returns (inlier_mask, p0, dir) for the best line, or None."""
    M = P.shape[0]
    if M < min_inliers:
        return None
    best_cnt = 0
    best = None
    for _ in range(iters):
        i, j = rng.integers(0, M, size=2)
        if i == j:
            continue
        a = P[i]; b = P[j]
        d = b - a
        L = np.hypot(*d)
        if L < 1e-6:
            continue
        d = d / L
        nrm = np.array([-d[1], d[0]])
        dist = np.abs((P - a) @ nrm)
        inl = dist < thr
        cnt = int(inl.sum())
        if cnt > best_cnt:
            best_cnt = cnt
            best = (inl, a, d)
    if best is None or best_cnt < min_inliers:
        return None
    return best


def _fit_segment(P_inl, a, d):
    t = (P_inl - a) @ d
    tmin, tmax = t.min(), t.max()
    p0 = a + d * tmin
    p1 = a + d * tmax
    nrm = np.array([-d[1], d[0]])
    perp = (P_inl - a) @ nrm
    thickness = float(np.percentile(perp, 90) - np.percentile(perp, 10))
    return p0, p1, max(0.05, thickness)


def detect_walls(band_plan, cell, floor, ceil, band_up, rng):
    """band_plan: (M,2) plan coords; band_up: (M,) up coords. Density grid then RANSAC lines."""
    height = ceil - floor
    mins = band_plan.min(0)
    keys = np.floor((band_plan - mins) / cell).astype(np.int64)
    hbin = np.floor((band_up - floor) / max(0.15, height * 0.05)).astype(np.int64)
    nhb = int(hbin.max() - hbin.min() + 1)
    cov_thr = max(3, int(nhb * 0.35))
    # group by cell key -> distinct height bins count
    order = np.lexsort((keys[:, 1], keys[:, 0]))
    ks = keys[order]; hs = hbin[order]
    diff = np.any(ks[1:] != ks[:-1], axis=1)
    bounds = np.concatenate([[0], np.nonzero(diff)[0] + 1, [len(ks)]])
    cells = []
    for s, e in zip(bounds[:-1], bounds[1:]):
        cov = np.unique(hs[s:e]).size
        if cov >= cov_thr:
            k = ks[s]
            cells.append([mins[0] + (k[0] + 0.5) * cell, mins[1] + (k[1] + 0.5) * cell])
    if len(cells) < 8:
        return []
    C = np.array(cells)
    walls = []
    thr = max(0.03, cell * 1.2)
    remaining = C
    for _ in range(80):
        if remaining.shape[0] < max(5, int(C.shape[0] * 0.02)):
            break
        res = _ransac_line(remaining, thr, 600, max(5, int(remaining.shape[0] * 0.02)), rng)
        if res is None:
            break
        inl, a, d = res
        P_inl = remaining[inl]
        p0, p1, thk = _fit_segment(P_inl, a, d)
        length = float(np.hypot(*(p1 - p0)))
        if length >= 0.6:
            walls.append({'p0': p0, 'p1': p1, 'thickness': min(thk, 0.6), 'length': length})
        remaining = remaining[~inl]
    return walls


def _cluster_voxels(P, vc):
    """26-neighbour connected components on a voxel grid. Returns list of point-index arrays."""
    keys = np.floor(P / vc).astype(np.int64)
    lut = {}
    for idx, k in enumerate(map(tuple, keys)):
        lut.setdefault(k, []).append(idx)
    visited = set()
    clusters = []
    neigh = [(dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
             if not (dx == 0 and dy == 0 and dz == 0)]
    for start in lut:
        if start in visited:
            continue
        stack = [start]
        visited.add(start)
        comp = []
        while stack:
            c = stack.pop()
            comp.extend(lut[c])
            for dn in neigh:
                nb = (c[0] + dn[0], c[1] + dn[1], c[2] + dn[2])
                if nb in lut and nb not in visited:
                    visited.add(nb)
                    stack.append(nb)
        clusters.append(np.array(comp))
    return clusters


def reconstruct(xyz, voxel=0.03, detect_objects=True, detect_pipes=True):
    rng = np.random.default_rng(12345)
    if xyz.shape[0] > 1_200_000:
        xyz = _voxel_downsample(xyz, voxel)
    up, floor, ceil = detect_up_axis(xyz)
    plan_ax = [i for i in range(3) if i != up]
    height = ceil - floor
    v = xyz[:, up]
    P = xyz[:, plan_ax]
    # floor/ceiling refine
    fmask = np.abs(v - floor) < 0.12
    cmask = np.abs(v - ceil) < 0.12
    floor = float(np.median(v[fmask])) if fmask.any() else floor
    ceil = float(np.median(v[cmask])) if cmask.any() else ceil
    height = ceil - floor
    # wall band
    bmask = (v > floor + 0.15 * height) & (v < ceil - 0.15 * height)
    cell = max(voxel * 2, 0.05)
    walls = detect_walls(P[bmask], cell, floor, ceil, v[bmask], rng)
    # footprint extent
    pmin = P.min(0); pmax = P.max(0)
    footprint = [pmin.tolist(), pmax.tolist()]
    floor_area = float((pmax[0] - pmin[0]) * (pmax[1] - pmin[1]))
    # pipes: near-ceiling band, away from walls, linear clusters
    pipes = []
    if detect_pipes and walls:
        zhi = ceil - max(0.05, height * 0.02)
        zlo = ceil - min(1.4, height * 0.42)
        pm = (v > zlo) & (v < zhi)
        Pp = P[pm]
        if Pp.shape[0] > 30:
            def near_wall(pt, margin=0.08):
                for w in walls:
                    a = w['p0']; b = w['p1']; d = b - a
                    L = np.hypot(*d)
                    if L < 1e-6:
                        continue
                    dd = d / L
                    t = np.clip((pt - a) @ dd, 0, L)
                    proj = a + dd * t
                    if np.hypot(*(pt - proj)) < margin + w['thickness'] / 2:
                        return True
                return False
            keep = np.array([not near_wall(pt) for pt in Pp])
            Pp = Pp[keep]
            if Pp.shape[0] > 30:
                rem = Pp
                for _ in range(40):
                    if rem.shape[0] < 30:
                        break
                    res = _ransac_line(rem, max(0.025, voxel * 1.5), 250, 18, rng)
                    if res is None:
                        break
                    inl, a, d = res
                    Pi = rem[inl]
                    p0, p1, width = _fit_segment(Pi, a, d)
                    length = float(np.hypot(*(p1 - p0)))
                    if length >= 0.7 and width <= 0.4:
                        pipes.append({'p0': p0, 'p1': p1, 'radius': max(0.02, min(0.2, width / 2))})
                    rem = rem[~inl]
    # objects: interior points not near floor/ceiling/walls
    objects = []
    if detect_objects:
        om = (v > floor + 0.08) & (v < ceil - 0.15)
        Po = xyz[om]
        if Po.shape[0] > 50:
            def near_any_wall(ptplan, margin=0.15):
                for w in walls:
                    a = w['p0']; b = w['p1']; d = b - a
                    L = np.hypot(*d)
                    if L < 1e-6:
                        continue
                    dd = d / L
                    t = np.clip((ptplan - a) @ dd, 0, L)
                    proj = a + dd * t
                    if np.hypot(*(ptplan - proj)) < margin + w['thickness'] / 2:
                        return True
                return False
            planP = Po[:, plan_ax]
            keep = np.array([not near_any_wall(pt) for pt in planP])
            Po = Po[keep]
            if Po.shape[0] > 50:
                vc = max(voxel * 3, 0.12)
                clusters = _cluster_voxels(Po, vc)
                room_area = floor_area
                for comp in clusters:
                    if comp.size < 50:
                        continue
                    pts = Po[comp]
                    mn = pts.min(0); mx = pts.max(0)
                    dy2 = mx[up] - mn[up]
                    sx = mx[plan_ax[0]] - mn[plan_ax[0]]; sy = mx[plan_ax[1]] - mn[plan_ax[1]]
                    fp = sx * sy; base = float(mn[up] - floor)
                    if (dy2 < 0.25 or dy2 > 2.5 or fp > room_area * 0.45 or
                            base > 0.35 or min(sx, sy) < 0.10 or comp.size < 150):
                        continue
                    objects.append({
                        'cx': float((mn[plan_ax[0]] + mx[plan_ax[0]]) / 2),
                        'cy': float((mn[plan_ax[1]] + mx[plan_ax[1]]) / 2),
                        'base': base,
                        'hx': float((mx[plan_ax[0]] - mn[plan_ax[0]]) / 2),
                        'hy': float((mx[plan_ax[1]] - mn[plan_ax[1]]) / 2),
                        'hz': float(dy2),
                        'points': int(comp.size),
                    })
    # normalize to IFC coords (X,Y plan, Z up, floor at 0)
    def to_ifc_xy(p):
        return [float(p[0] - pmin[0]), float(p[1] - pmin[1])]
    result = {
        'up_axis': int(up),
        'floor': 0.0,
        'ceil': float(height),
        'height': float(height),
        'walls': [{'p0': to_ifc_xy(w['p0']), 'p1': to_ifc_xy(w['p1']),
                   'thickness': w['thickness'], 'length': w['length']} for w in walls],
        'pipes': [{'p0': to_ifc_xy(p['p0']), 'p1': to_ifc_xy(p['p1']), 'radius': p['radius']} for p in pipes],
        'objects': [{'cx': o['cx'] - pmin[0], 'cy': o['cy'] - pmin[1], 'base': o['base'],
                     'hx': o['hx'], 'hy': o['hy'], 'hz': o['hz'], 'points': o['points']} for o in objects],
        'floor_area': floor_area,
        'footprint': [[0.0, 0.0], [float(pmax[0] - pmin[0]), float(pmax[1] - pmin[1])]],
        'stats': {'wall_count': len(walls), 'pipe_count': len(pipes), 'object_count': len(objects)},
    }
    return result
