"""Overhead pipe extraction with estimated diameter and material (NumPy).

Strategy: take the near-ceiling band, remove points close to walls, then greedily
fit straight pipe runs with a line-RANSAC. For each run we estimate the radius
from the perpendicular spread of inliers, snap it to the nearest nominal DN, and
guess a material from the mean RGB colour. This replaces the old thin-line pipes
that rendered as flat sticks with proper cylinders that carry a diameter.

If pyransac3d is installed the caller may swap in true 3D cylinder RANSAC; this
NumPy path always works so the server never hard-depends on it.
"""
import numpy as np

# Nominal metric pipe sizes (outer diameter in millimetres).
DN = np.array([15, 20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300], dtype=np.float64)


def _material_from_rgb(rgb):
    if rgb is None or len(rgb) == 0:
        return 'unknown'
    r, g, b = [float(x) for x in np.median(np.asarray(rgb, dtype=np.float64), axis=0)]
    mx = max(r, g, b) + 1e-6
    mn = min(r, g, b)
    sat = (mx - mn) / mx
    if r > 130 and r > g * 1.4 and r > b * 1.55 and g >= b:
        return 'copper'         # distinctly warm/orange
    if mx < 70:
        return 'cast_iron'      # very dark
    if sat < 0.18:
        return 'steel' if mx > 150 else 'painted'   # low saturation metal
    if g > r and g > b:
        return 'painted'        # green painted
    return 'plastic'


def _snap_dn(diameter_mm):
    i = int(np.argmin(np.abs(DN - diameter_mm)))
    return int(DN[i])


def _size_class(dn):
    if dn <= 50:
        return 'small'
    if dn <= 150:
        return 'medium'
    return 'large'


def _ransac_line(P, thr, iters, min_inliers, rng):
    M = P.shape[0]
    if M < min_inliers:
        return None
    best_cnt, best = 0, None
    for _ in range(iters):
        i, j = rng.integers(0, M, size=2)
        if i == j:
            continue
        a = P[i]; d = P[j] - a
        L = np.hypot(*d)
        if L < 1e-6:
            continue
        d = d / L
        nrm = np.array([-d[1], d[0]])
        dist = np.abs((P - a) @ nrm)
        inl = dist < thr
        cnt = int(inl.sum())
        if cnt > best_cnt:
            best_cnt, best = cnt, (inl, a, d)
    if best is None or best_cnt < min_inliers:
        return None
    return best


def _near_wall(pt, walls, pmin, margin=0.12):
    for w in walls:
        a = np.array(w['p0']) + pmin
        b = np.array(w['p1']) + pmin
        d = b - a
        L = np.hypot(*d)
        if L < 1e-6:
            continue
        dd = d / L
        t = np.clip((pt - a) @ dd, 0, L)
        proj = a + dd * t
        if np.hypot(*(pt - proj)) < margin + w.get('thickness', 0.15) / 2:
            return True
    return False


def _persistent_cross_section_pipes(Pp, Vp, Cp, pmin, plan_ax, floor, voxel):
    """Find services that persist along the room in a compact 3-D cross-section."""
    if Pp.shape[0] < 200:
        return []
    spans = np.ptp(Pp, axis=0); long_ax = int(np.argmax(spans)); short_ax = 1 - long_ax
    cs = max(0.035, voxel * 1.2); lc = 0.20
    s, ll = Pp[:, short_ax], Pp[:, long_ax]
    s0, l0, y0 = float(s.min()), float(ll.min()), float(Vp.min())
    ns = int(np.ceil(np.ptp(s) / cs)) + 1; ny = int(np.ceil(np.ptp(Vp) / cs)) + 1
    nl = int(np.ceil(np.ptp(ll) / lc)) + 1
    qs = np.clip(((s-s0)/cs).astype(np.int64),0,ns-1)
    qy = np.clip(((Vp-y0)/cs).astype(np.int64),0,ny-1)
    ql = np.clip(((ll-l0)/lc).astype(np.int64),0,nl-1)
    ids = (qs * ny + qy) * nl + ql
    cross = np.unique(ids) // nl
    ck, cov = np.unique(cross, return_counts=True)
    min_cov = max(6, int(nl * 0.055))
    active = set(int(x) for x in ck[cov >= min_cov])
    comps = []
    while active:
        start = active.pop(); stack = [start]; comp = [start]
        while stack:
            cur = stack.pop(); x, y = divmod(cur, ny)
            for dx in (-2,-1,0,1,2):
                for dy in (-2,-1,0,1,2):
                    if dx == 0 and dy == 0: continue
                    nb = (x+dx)*ny + (y+dy)
                    if 0 <= x+dx < ns and 0 <= y+dy < ny and nb in active:
                        active.remove(nb); stack.append(nb); comp.append(nb)
        comps.append(comp)
    out = []
    point_cross = qs * ny + qy
    for comp in comps:
        q = np.array([(x//ny, x%ny) for x in comp], dtype=np.int64)
        ext = (q.max(0)-q.min(0)+1)*cs
        if max(ext) > 0.34 or min(ext) < cs or max(ext)/max(min(ext),1e-6) > 2.8:
            continue
        sel = np.isin(point_cross, np.asarray(comp, dtype=np.int64))
        if int(sel.sum()) < 60:
            continue
        center_s = float(np.median(s[sel])); center_y = float(np.median(Vp[sel]))
        radius = float(np.clip(max(ext)*0.42, 0.012, 0.14)); dmm=radius*2000; dn=_snap_dn(dmm)
        values=ll[sel]; order=np.argsort(values); values=values[order]
        cuts=np.where(np.diff(values)>.65)[0]+1
        for run in np.split(order,cuts):
            if run.size<35: continue
            lo,hi=np.quantile(ll[sel][run],[.02,.98]); length=float(hi-lo)
            if length<.8: continue
            a=np.zeros(2);b=np.zeros(2);a[short_ax]=center_s;b[short_ax]=center_s;a[long_ax]=lo;b[long_ax]=hi
            out.append({'p0':[float(a[0]-pmin[0]),float(a[1]-pmin[1])],
                        'p1':[float(b[0]-pmin[0]),float(b[1]-pmin[1])],
                        'radius':round(dn/2000.0,4),'diameter_mm':dn,'dn':'DN%d'%dn,
                        'size_class':_size_class(dn),'material':_material_from_rgb(Cp[sel] if Cp is not None else None),
                        'y':float(center_y-floor),'length':round(length,3),'support_points':int(run.size),
                        'cross_section_ratio':round(float(max(ext)/max(min(ext),1e-6)),3),'source':'persistent-cross-section'})
    return out


def detect_pipes(xyz, rgb, up, plan_ax, floor, ceil, walls, pmin, voxel=0.03):
    """Return a list of pipe dicts (plan coords relative to pmin, IFC convention)."""
    height = max(0.1, ceil - floor)
    v = xyz[:, up]
    P = xyz[:, plan_ax]
    zhi = ceil - max(0.03, height * 0.02)
    zlo = ceil - min(1.6, height * 0.45)
    pm = (v > zlo) & (v < zhi)
    Pp = P[pm]
    Vp = v[pm]
    Cp = np.asarray(rgb)[pm] if rgb is not None else None
    if Pp.shape[0] < 40:
        return []
    hb = max(24, int((zhi - zlo) / 0.015))
    hist, edges = np.histogram(Vp, bins=hb, range=(zlo, zhi))
    plane_bins = np.where(hist >= max(250, int(Pp.shape[0] * 0.025)))[0]
    if plane_bins.size:
        plane_y = (edges[plane_bins] + edges[plane_bins + 1]) * 0.5
        keep_plane = np.ones(Vp.shape[0], dtype=bool)
        for yy in plane_y:
            keep_plane &= np.abs(Vp - yy) > max(0.025, voxel * 0.8)
        Pp, Vp = Pp[keep_plane], Vp[keep_plane]
        if Cp is not None: Cp = Cp[keep_plane]
    if Pp.shape[0] < 40:
        return []
    # drop points near walls (wall tops leak into the ceiling band)
    if walls:
        keep = np.array([not _near_wall(pt, walls, np.array(pmin)) for pt in Pp])
        Pp, Vp = Pp[keep], Vp[keep]
        if Cp is not None:
            Cp = Cp[keep]
    if Pp.shape[0] < 40:
        return []
    persistent = _persistent_cross_section_pipes(Pp, Vp, Cp, np.asarray(pmin), plan_ax, floor, voxel)
    rng = np.random.default_rng(777)
    pipes = []
    idx_all = np.arange(Pp.shape[0])
    rem = idx_all
    for _ in range(60):
        if rem.shape[0] < 30:
            break
        res = _ransac_line(Pp[rem], max(0.02, voxel * 1.2), 300, 22, rng)
        if res is None:
            break
        inl, a, d = res
        sub = rem[inl]
        Pi = Pp[sub]
        t = (Pi - a) @ d
        nrm = np.array([-d[1], d[0]])
        perp = (Pi - a) @ nrm
        # robust half-thickness from MAD (1.4826*MAD ~ sigma), in-plane and vertical
        rad_plan = 1.4826 * np.median(np.abs(perp - np.median(perp)))
        vres = Vp[sub] - np.median(Vp[sub])
        rad_vert = 1.4826 * np.median(np.abs(vres))
        # a pipe is thin in BOTH directions; a rack/beam is fat -> reject
        if max(rad_plan, rad_vert) > 0.18:
            rem = rem[~inl]
            continue
        small = max(0.003, voxel * 0.10)
        ratio = max(rad_plan, rad_vert) / max(min(rad_plan, rad_vert), 1e-9)
        if min(rad_plan, rad_vert) < small or ratio > 4.0:
            rem = rem[~inl]
            continue
        radius = float(max(0.008, min(0.09, (rad_plan + rad_vert) / 2)))
        if sub.size >= 30:
            dmm = radius * 2 * 1000
            dn = _snap_dn(dmm)
            mat = _material_from_rgb(Cp[sub] if Cp is not None else None)
            y = float(np.median(Vp[sub]) - floor)
            order=np.argsort(t); ts=t[order]; cuts=np.where(np.diff(ts)>.65)[0]+1
            for run in np.split(order,cuts):
                if run.size<25: continue
                lo,hi=np.quantile(t[run],[.02,.98]); p0=a+d*lo; p1=a+d*hi
                length=float(np.hypot(*(p1-p0)))
                if length<.8: continue
                pipes.append({'p0':[float(p0[0]-pmin[0]),float(p0[1]-pmin[1])],
                    'p1':[float(p1[0]-pmin[0]),float(p1[1]-pmin[1])],
                    'radius':round(float(_snap_dn(dmm)/2000.),4),'diameter_mm':dn,
                    'dn':'DN%d'%dn,'size_class':_size_class(dn),'material':mat,'y':y,
                    'length':round(length,3),'support_points':int(run.size),
                    'cross_section_ratio':round(float(ratio),3),'source':'ransac-continuous'})
        rem = rem[~inl]
    # Prefer persistent cross-section runs and add only non-duplicate RANSAC cylinders.
    merged = list(persistent)
    for p in pipes:
        c = (np.asarray(p['p0']) + np.asarray(p['p1'])) * 0.5
        duplicate = False
        for q in merged:
            cq = (np.asarray(q['p0']) + np.asarray(q['p1'])) * 0.5
            if np.linalg.norm(c-cq) < 0.22 and abs(p['y']-q['y']) < 0.18:
                duplicate = True; break
        if not duplicate: merged.append(p)
    return sorted(merged, key=lambda p: (-p.get('length',0), p.get('y',0)))[:60]


def detect_services(xyz, rgb, up, plan_ax, floor, ceil, pmin, voxel=0.03):
    """Detect persistent rectangular ducts and cable trays in cross-section."""
    v=xyz[:,up]; P=xyz[:,plan_ax]; C=np.asarray(rgb) if rgb is not None else None
    height=max(.1,ceil-floor); mask=(v>ceil-min(1.8,height*.5))&(v<ceil-.04)
    P=P[mask]; V=v[mask]; C=C[mask] if C is not None else None
    if P.shape[0]<300:return []
    spans=np.ptp(P,axis=0); long_ax=int(np.argmax(spans)); short_ax=1-long_ax
    cs=max(.04,voxel*1.35); lc=.20; s=P[:,short_ax]; ll=P[:,long_ax]
    s0,l0,y0=float(s.min()),float(ll.min()),float(V.min());ns=int(np.ceil(np.ptp(s)/cs))+1;ny=int(np.ceil(np.ptp(V)/cs))+1;nl=int(np.ceil(np.ptp(ll)/lc))+1
    qs=np.clip(((s-s0)/cs).astype(np.int64),0,ns-1);qy=np.clip(((V-y0)/cs).astype(np.int64),0,ny-1);ql=np.clip(((ll-l0)/lc).astype(np.int64),0,nl-1)
    ids=(qs*ny+qy)*nl+ql;cross=np.unique(ids)//nl;ck,cov=np.unique(cross,return_counts=True)
    active=set(int(x) for x in ck[cov>=max(6,int(nl*.05))]);comps=[]
    while active:
        st=active.pop();stack=[st];comp=[st]
        while stack:
            cur=stack.pop();x,y=divmod(cur,ny)
            for dx in (-2,-1,0,1,2):
                for dy in (-2,-1,0,1,2):
                    nb=(x+dx)*ny+y+dy
                    if 0<=x+dx<ns and 0<=y+dy<ny and nb in active:active.remove(nb);stack.append(nb);comp.append(nb)
        comps.append(comp)
    out=[];pcross=qs*ny+qy
    for comp in comps:
        q=np.array([(x//ny,x%ny) for x in comp]);ext=(q.max(0)-q.min(0)+1)*cs;w,h=float(ext[0]),float(ext[1])
        # Pipes are handled separately; full slabs/walls are too wide/tall.
        if w<.16 or w>1.25 or h<.06 or h>.70 or (max(w,h)<=.34 and max(w,h)/max(min(w,h),1e-6)<=2.8):continue
        sel=np.isin(pcross,np.asarray(comp,dtype=np.int64))
        if int(sel.sum())<100:continue
        vals=ll[sel];order=np.argsort(vals);vals=vals[order];cuts=np.where(np.diff(vals)>.70)[0]+1
        for run in np.split(order,cuts):
            if run.size<50:continue
            lo,hi=np.quantile(ll[sel][run],[.02,.98]);length=float(hi-lo)
            if length<1.0:continue
            center_s=float(np.median(s[sel]));center_y=float(np.median(V[sel]));a=np.zeros(2);b=np.zeros(2);a[short_ax]=center_s;b[short_ax]=center_s;a[long_ax]=lo;b[long_ax]=hi
            kind='cable_tray' if h<.20 and w>h*1.4 else 'duct'
            out.append({'p0':[float(a[0]-pmin[0]),float(a[1]-pmin[1])],
                'p1':[float(b[0]-pmin[0]),float(b[1]-pmin[1])],'y':float(center_y-floor),
                'width':round(w,3),'height':round(h,3),'length':round(length,3),'kind':kind,
                'material':_material_from_rgb(C[sel] if C is not None else None),'support_points':int(run.size)})
    # Broad-line fallback recovers isolated ducts/trays whose cross-sections
    # touch neighbouring MEP and therefore merged in the occupancy component.
    rng=np.random.default_rng(991); rem=np.arange(P.shape[0])
    for _ in range(35):
        if rem.size<120:break
        fit=_ransac_line(P[rem],max(.22,voxel*7),240,150,rng)
        if fit is None:break
        inl,a,d=fit;sub=rem[inl];Pi=P[sub];tt=(Pi-a)@d;nrm=np.array([-d[1],d[0]])
        wp=2.96*np.median(np.abs((Pi-a)@nrm-np.median((Pi-a)@nrm)))
        hv=2.96*np.median(np.abs(V[sub]-np.median(V[sub])))
        if .18<=wp<=1.10 and .05<=hv<=.65:
            order=np.argsort(tt); ts=tt[order]; cuts=np.where(np.diff(ts)>.70)[0]+1
            for run in np.split(order,cuts):
                if run.size<60:continue
                lo,hi=np.quantile(tt[run],[.02,.98]);length=float(hi-lo)
                if length<1.0:continue
                p0=a+d*lo;p1=a+d*hi;kind='cable_tray' if hv<.18 and wp>hv*1.35 else 'duct'
                item={'p0':[float(p0[0]-pmin[0]),float(p0[1]-pmin[1])],
                      'p1':[float(p1[0]-pmin[0]),float(p1[1]-pmin[1])],
                      'y':float(np.median(V[sub[run]])-floor),'width':round(float(wp),3),
                      'height':round(float(hv),3),'length':round(length,3),'kind':kind,
                      'material':_material_from_rgb(C[sub[run]] if C is not None else None),
                      'support_points':int(run.size),'source':'broad-ransac-continuous'}
                center=(np.asarray(item['p0'])+np.asarray(item['p1']))*.5
                if not any(np.linalg.norm(center-(np.asarray(q['p0'])+np.asarray(q['p1']))*.5)<.35 and abs(item['y']-q['y'])<.25 for q in out):out.append(item)
        rem=rem[~inl]
    # Suppress nearly coincident boxes from multiple faces of one service.
    clean=[]
    for item in sorted(out,key=lambda x:-x['length']):
        c=(np.asarray(item['p0'])+np.asarray(item['p1']))*.5
        if any(np.linalg.norm(c-(np.asarray(q['p0'])+np.asarray(q['p1']))*.5)<.45 and abs(item['y']-q['y'])<.30 for q in clean):continue
        clean.append(item)
    return clean[:12]


def group_pipes(pipes):
    """Group pipes by (dn, material) for the UI / IFC systems."""
    groups = {}
    for p in pipes:
        key = (p['dn'], p['material'])
        g = groups.setdefault(key, {'dn': p['dn'], 'diameter_mm': p['diameter_mm'],
                                    'material': p['material'], 'size_class': p['size_class'],
                                    'count': 0, 'total_length': 0.0})
        g['count'] += 1
        g['total_length'] += p.get('length', 0.0)
    return sorted(groups.values(), key=lambda g: (-g['count'], g['dn']))
