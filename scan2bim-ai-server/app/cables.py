"""Hanging cable / conduit extraction as polylines (NumPy).

The old engine drew every cable as one straight stick. Real hanging wires sag
(catenary) and run in bundles. Here we find thin vertical/near-ceiling clusters
that are too thin to be pipes, then trace each as an ordered polyline so the
viewer can render the actual droop instead of a single segment.
"""
import numpy as np


def _cluster_xy(P, cell):
    """Grid-cluster plan points; return list of index arrays (4-neighbour)."""
    keys = np.floor(P / cell).astype(np.int64)
    lut = {}
    for idx, k in enumerate(map(tuple, keys)):
        lut.setdefault(k, []).append(idx)
    seen = set()
    out = []
    neigh = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)]
    for start in lut:
        if start in seen:
            continue
        stack = [start]
        seen.add(start)
        comp = []
        while stack:
            c = stack.pop()
            comp.extend(lut[c])
            for dn in neigh:
                nb = (c[0] + dn[0], c[1] + dn[1])
                if nb in lut and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        out.append(np.array(comp))
    return out


def detect_cables(xyz, up, plan_ax, floor, ceil, pmin, voxel=0.03, max_cables=50, rgb=None):
    """Return cable dicts: {polyline:[[x,y,z]...], radius, drop, kind}.

    Coordinates are IFC convention relative to pmin, Z up with floor at 0.
    """
    height = max(0.1, ceil - floor)
    v = xyz[:, up]
    P = xyz[:, plan_ax]
    # cables live below the ceiling slab but above head height mostly
    zhi = ceil - max(0.02, height * 0.01)
    zlo = floor + height * 0.35
    margin = max(0.14, voxel * 4)
    lo_plan = P.min(axis=0); hi_plan = P.max(axis=0)
    m = ((v > zlo) & (v < zhi) &
         (P[:,0] > lo_plan[0] + margin) & (P[:,0] < hi_plan[0] - margin) &
         (P[:,1] > lo_plan[1] + margin) & (P[:,1] < hi_plan[1] - margin))
    Pm, Vm = P[m], v[m]
    if Pm.shape[0] < 20:
        return []
    # Select plan cells with a tall, sparse vertical trace first. Clustering the
    # whole ceiling band merges every cable into the slab/pipe rack.
    cell = max(0.07, voxel * 2.3)
    q = np.floor((Pm - Pm.min(0)) / cell).astype(np.int64)
    keys = q[:,0] * (int(q[:,1].max()) + 1) + q[:,1]
    uniq, inv = np.unique(keys, return_inverse=True)
    selected_cells = []
    for ci in range(len(uniq)):
        vv = Vm[inv == ci]
        if vv.size < 8: continue
        spanv = float(np.quantile(vv,.95)-np.quantile(vv,.05))
        if spanv >= 0.22 and float(np.quantile(vv,.95)) > ceil-0.45:
            selected_cells.append(ci)
    if not selected_cells:
        return []
    keep = np.isin(inv, np.asarray(selected_cells))
    Ps, Vs = Pm[keep], Vm[keep]
    clusters = _cluster_xy(Ps, cell)
    cables = []
    for comp in clusters:
        if comp.size < 60:
            continue
        pts = Ps[comp]
        vs = Vs[comp]
        mn = pts.min(0); mx = pts.max(0)
        ext = mx - mn
        vspan = float(np.quantile(vs,.95)-np.quantile(vs,.05))
        if max(ext) > 0.42 or vspan < 0.22:
            continue
        # Closed planar loops are common in unfinished ceilings. Preserve the
        # loop instead of collapsing it into a vertical median line.
        pts3=np.column_stack([pts[:,0],pts[:,1],vs]); cen=np.median(pts3,axis=0)
        cov=np.cov((pts3-cen).T); val,vec=np.linalg.eigh(cov); order_e=np.argsort(val)[::-1];val=val[order_e];vec=vec[:,order_e]
        pr=(pts3-cen)@vec[:,:2]; rr=np.sqrt((pr*pr).sum(1)); rmed=float(np.median(rr)); rcv=float(np.median(np.abs(rr-rmed))/max(rmed,1e-6))
        if .04<=rmed<=.42 and val[1]/max(val[0],1e-9)>.08 and val[2]/max(val[1],1e-9)<.60 and rcv<.55:
            poly=[]
            for ang in np.linspace(0,2*np.pi,25):
                p3=cen+rmed*(vec[:,0]*np.cos(ang)+vec[:,1]*np.sin(ang))
                poly.append([float(p3[0]-pmin[0]),float(p3[1]-pmin[1]),float(p3[2]-floor)])
            cables.append({'polyline':poly,'radius':0.016,'drop':round(vspan,3),
                           'kind':'cable_loop','support_points':int(comp.size)})
            if len(cables)>=max_cables:break
            continue
        # Trace from bottom to top so lateral swing/loops are retained.
        nnodes = int(min(16, max(4, vspan / 0.10)))
        edges = np.linspace(np.quantile(vs,.03), np.quantile(vs,.97), nnodes + 1)
        poly = []
        for i in range(nnodes):
            seg = (vs >= edges[i]) & (vs <= edges[i + 1])
            if seg.sum() == 0:
                continue
            cx = float(np.median(pts[seg, 0]) - pmin[0])
            cy = float(np.median(pts[seg, 1]) - pmin[1])
            cz = float(np.median(vs[seg]) - floor)
            poly.append([cx, cy, cz])
        if len(poly) < 3:
            continue
        ztop = max(pt[2] for pt in poly)
        zbot = min(pt[2] for pt in poly)
        cables.append({
            'polyline': poly,
            'radius': 0.015,
            'drop': round(float(ztop - zbot), 3),
            'kind': 'cable',
            'support_points': int(comp.size),
        })
        if len(cables) >= max_cables:
            break
    # Thin dark cable runs attached to walls/ceilings. Fit only short continuous
    # pieces; never bridge an unsupported room.
    if rgb is not None and len(cables) < max_cables:
        C=np.asarray(rgb); bright=C.astype(np.float64).mean(1)
        if bright.size and float(np.nanmax(bright))<=1.0001: bright*=255.
        hm=(v>floor+height*.55)&(v<ceil-.08)&(bright<92)
        Ph=P[hm];Vh=v[hm]
        if Ph.shape[0]>100:
            rng=np.random.default_rng(1701);rem=np.arange(Ph.shape[0]);added=0
            for _ in range(28):
                if rem.size<30 or added>=12 or len(cables)>=max_cables:break
                Q=Ph[rem];best=None;bestn=0
                for _it in range(160):
                    ii,jj=rng.integers(0,len(Q),2)
                    if ii==jj:continue
                    a=Q[ii];d=Q[jj]-a;ln=np.hypot(*d)
                    if ln<.2:continue
                    d=d/ln;n=np.array([-d[1],d[0]]);dist=np.abs((Q-a)@n);inl=dist<max(.018,voxel*.7);cnt=int(inl.sum())
                    if cnt>bestn:bestn=cnt;best=(inl,a,d)
                if best is None or bestn<24:break
                inl,a,d=best;sub=rem[inl];Q=Ph[sub];tt=(Q-a)@d;n=np.array([-d[1],d[0]])
                rp=1.4826*np.median(np.abs((Q-a)@n-np.median((Q-a)@n)));rv=1.4826*np.median(np.abs(Vh[sub]-np.median(Vh[sub])))
                if rp<.028 and rv<.028:
                    order=np.argsort(tt);ts=tt[order];cuts=np.where(np.diff(ts)>.45)[0]+1
                    for run in np.split(order,cuts):
                        if run.size<18:continue
                        lo,hi=np.quantile(tt[run],[.03,.97]);length=float(hi-lo)
                        if length<.65:continue
                        aa=a+d*lo;bb=a+d*hi;y=float(np.median(Vh[sub[run]])-floor)
                        cables.append({'polyline':[[float(aa[0]-pmin[0]),float(aa[1]-pmin[1]),y],
                                                   [float(bb[0]-pmin[0]),float(bb[1]-pmin[1]),y]],
                                       'radius':.009,'drop':0.,'kind':'ceiling_cable','support_points':int(run.size)})
                        added+=1
                        if added>=12 or len(cables)>=max_cables:break
                rem=rem[~inl]
    return cables
