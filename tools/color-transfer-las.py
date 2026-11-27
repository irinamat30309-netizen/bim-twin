# -*- coding: utf-8 -*-
"""r202: transfer the Lixel reference colour onto our cloud by geometry.

Both clouds are in the same local frame (verified: XY density shift 0 m, 20 cm voxel
IoU 0.595), so a point takes the mean colour of the reference voxel it falls into.

Measured nearest-neighbour statistics (2M random our-points vs every 20th Lixel point):
  p50 2.7 cm, p90 7.8 cm; within 3 cm 54 %, 5 cm 76 %, 10 cm 93.5 %, 15 cm 97.5 %.
Hence the cascade 3 -> 6 -> 9 -> 12 -> 15 cm: the 3 cm layer preserves detail, the coarse
layers only fill points that have no reference point nearby, so coverage reaches ~96-98 %.

Coarse layers are NOT re-scanned from Lixel: they are aggregated exactly from the 3 cm
voxels (all layer sizes are multiples of 3 cm, so each coarse cell is a whole number of
3 cm cells) weighted by the 3 cm point counts. That keeps the run at two Lixel passes.

Output keeps the source header/bbox/point count; only the RGB uint16 fields change
(8-bit values stored in uint16, same layout as the source).

  python r202_color_transfer.py --ours A.las --ref B.las --dst OUT.las [--probe N]
"""
import argparse
import json
import os
import struct
import sys
import time

import numpy as np

OFF = 1 << 19
BITS = 21
MASK = (1 << BITS) - 1
CH = 5_000_000
BASE = 0.03
LAYERS = (0.03, 0.06, 0.09, 0.12, 0.15, 0.18, 0.21, 0.24)


# ---------------------------------------------------------------- LAS io
def read_head(path):
    with open(path, 'rb') as f:
        h = f.read(375)
    ver_major, ver_minor = h[24], h[25]
    off = struct.unpack_from('<I', h, 96)[0]
    fmt = h[104] & 0x3f
    rl = struct.unpack_from('<H', h, 105)[0]
    n = struct.unpack_from('<I', h, 107)[0]
    if ver_minor >= 4 and len(h) >= 375:
        n14 = struct.unpack_from('<Q', h, 247)[0]
        if n14:
            n = n14
    sx, sy, sz = struct.unpack_from('<ddd', h, 131)
    ox, oy, oz = struct.unpack_from('<ddd', h, 155)
    rgb_off = {2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30}.get(fmt)
    return dict(path=path, off=off, fmt=fmt, rl=rl, n=int(n), scale=(sx, sy, sz),
                offset=(ox, oy, oz), rgb_off=rgb_off, minor=ver_minor)


def detect_c16(H, probe=8192):
    with open(H['path'], 'rb') as f:
        f.seek(H['off'] + (H['n'] // 3) * H['rl'])
        raw = f.read(H['rl'] * probe)
    rec = np.frombuffer(raw, dtype=np.uint8).reshape(-1, H['rl'])
    o = H['rgb_off']
    u16 = rec[:, o:o + 6].copy().view('<u2').reshape(-1, 3)
    return bool(u16.max() > 255)


def iter_raw(H, start=0):
    rl, off = H['rl'], H['off']
    n = H['n'] - start
    fd = open(H['path'], 'rb')
    fd.seek(off + start * rl)
    try:
        done = 0
        while done < n:
            c = min(CH, n - done)
            buf = fd.read(c * rl)
            if len(buf) < c * rl:
                c = len(buf) // rl
                if c <= 0:
                    break
            done += c
            yield np.frombuffer(bytearray(buf), dtype=np.uint8).reshape(c, rl)
    finally:
        fd.close()


def decode(rec, H, is16):
    c = rec.shape[0]
    X = rec[:, 0:4].copy().view('<i4').ravel()
    Y = rec[:, 4:8].copy().view('<i4').ravel()
    Z = rec[:, 8:12].copy().view('<i4').ravel()
    sx, sy, sz = H['scale']
    ox, oy, oz = H['offset']
    xyz = np.empty((c, 3), np.float32)
    xyz[:, 0] = X * sx + ox
    xyz[:, 1] = Y * sy + oy
    xyz[:, 2] = Z * sz + oz
    o = H['rgb_off']
    u16 = rec[:, o:o + 6].copy().view('<u2').reshape(c, 3)
    rgb = (u16.astype(np.float32) * (1.0 / 257.0)) if is16 else u16.astype(np.float32)
    return xyz, rgb


def vox_keys(xyz, v):
    ix = np.floor(xyz[:, 0] / v).astype(np.int64) + OFF
    iy = np.floor(xyz[:, 1] / v).astype(np.int64) + OFF
    iz = np.floor(xyz[:, 2] / v).astype(np.int64) + OFF
    return (ix << (2 * BITS)) | (iy << BITS) | iz


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- table build
def build_keys(H, is16, v=BASE):
    t0 = time.time()
    acc = np.empty(0, np.int64)
    parts = []
    npts = 0
    for rec in iter_raw(H):
        xyz, _ = decode(rec, H, is16)
        npts += xyz.shape[0]
        parts.append(np.unique(vox_keys(xyz, v)))
        if len(parts) >= 20:
            acc = np.unique(np.concatenate([acc] + parts))
            parts = []
            log('[keys] %d pts, %d voxels (%.0f s)' % (npts, acc.size, time.time() - t0))
    if parts:
        acc = np.unique(np.concatenate([acc] + parts))
    log('[keys] done %d pts -> %d voxels of %.2f m (%.0f s)' % (npts, acc.size, v, time.time() - t0))
    return acc, npts


def build_means(H, is16, keys):
    t0 = time.time()
    n = keys.size
    cnt = np.zeros(n, np.int64)
    s = np.zeros((n, 3), np.float64)
    for rec in iter_raw(H):
        xyz, rgb = decode(rec, H, is16)
        k = vox_keys(xyz, BASE)
        uk, inv = np.unique(k, return_inverse=True)
        gi = np.searchsorted(keys, uk)
        cnt[gi] += np.bincount(inv, minlength=uk.size)
        for ch in range(3):
            s[gi, ch] += np.bincount(inv, weights=rgb[:, ch], minlength=uk.size)
    mean = s / np.maximum(1, cnt)[:, None]
    col = np.clip(np.rint(mean), 0, 255).astype(np.uint8)
    log('[means %.2f] voxels=%d pts/voxel=%.2f mean RGB %s (%.0f s)'
        % (BASE, n, cnt.mean(), [round(float(x), 1) for x in mean.mean(0)], time.time() - t0))
    return col.astype(np.float64), cnt


def derive_layer(K3, cnt3, col3, v, chunk=8_000_000):
    """aggregate the 3 cm voxels into a coarser cell (v must be a multiple of 3 cm)."""
    f = int(round(v / BASE))
    kk, cc, ss = [], [], []
    for i0 in range(0, K3.size, chunk):
        k = K3[i0:i0 + chunk]
        c = cnt3[i0:i0 + chunk].astype(np.float64)
        col = col3[i0:i0 + chunk]
        ix = ((k >> (2 * BITS)) & MASK) - OFF
        iy = ((k >> BITS) & MASK) - OFF
        iz = (k & MASK) - OFF
        ck = (((ix // f) + OFF) << (2 * BITS)) | (((iy // f) + OFF) << BITS) | ((iz // f) + OFF)
        uk, inv = np.unique(ck, return_inverse=True)
        kk.append(uk)
        cc.append(np.bincount(inv, weights=c, minlength=uk.size))
        ss.append(np.stack([np.bincount(inv, weights=c * col[:, ch], minlength=uk.size) for ch in range(3)], 1))
    uk = np.concatenate(kk); c = np.concatenate(cc); s = np.concatenate(ss)
    o = np.argsort(uk)
    uk, c, s = uk[o], c[o], s[o]
    mean = s / np.maximum(1, c)[:, None]
    out = np.clip(np.rint(mean), 0, 255).astype(np.uint8)
    log('[derive %.2f] cells=%d mean RGB %s' % (v, uk.size, [round(float(x), 1) for x in mean.mean(0)]))
    return uk, out


# ---------------------------------------------------------------- apply
def apply_transfer(H, is16, tables, dst, probe_only=0):
    fin = open(H['path'], 'rb')
    hdr = fin.read(H['off'])
    fout = None if probe_only else open(dst, 'wb')
    if fout:
        fout.write(hdr)
    r = H['rgb_off']
    hits = {v: 0 for v in LAYERS}
    kept = 0
    total = 0
    sums = {v: np.zeros(3, np.float64) for v in LAYERS}
    t0 = time.time()
    for rec in iter_raw(H):
        xyz, rgb = decode(rec, H, is16)
        c = xyz.shape[0]
        col = rgb.copy()
        remaining = np.arange(c)
        for v in LAYERS:
            if remaining.size == 0:
                break
            K, C = tables[v]
            if K.size == 0:
                continue
            k = vox_keys(xyz[remaining], v)
            i = np.searchsorted(K, k)
            ic = np.minimum(i, K.size - 1)
            ok = K[ic] == k
            if not np.any(ok):
                continue
            sel = remaining[ok]
            col[sel] = C[ic[ok]]
            hits[v] += int(ok.sum())
            sums[v] += col[sel].sum(0)
            remaining = remaining[~ok]
        kept += int(remaining.size)
        total += c
        if not probe_only:
            rec[:, r] = np.clip(col[:, 0], 0, 255).astype(np.uint8)
            rec[:, r + 2] = np.clip(col[:, 1], 0, 255).astype(np.uint8)
            rec[:, r + 4] = np.clip(col[:, 2], 0, 255).astype(np.uint8)
            fout.write(rec.tobytes())
        if probe_only and total >= probe_only:
            break
        if total % 100_000_000 < c:
            log('[apply] %dM pts: %s kept %d (%.0f s)'
                % (total // 1_000_000, ' '.join('%gcm:%d' % (v * 100, hits[v]) for v in LAYERS),
                   kept, time.time() - t0))
    if fout:
        fout.close()
    fin.close()
    cov = (total - kept) / max(1, total)
    res = dict(points=total, kept=kept, coverage=round(cov, 4),
               hits={('%g' % v): hits[v] for v in LAYERS},
               hit_frac={('%g' % v): round(hits[v] / max(1, total), 4) for v in LAYERS},
               layer_mean={('%g' % v): ([round(float(x), 2) for x in sums[v] / max(1, hits[v])] if hits[v] else None)
                           for v in LAYERS},
               sec=round(time.time() - t0, 1))
    log('[apply] ' + json.dumps(res))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ours', required=True)
    ap.add_argument('--ref', required=True)
    ap.add_argument('--dst', required=True)
    ap.add_argument('--probe', type=int, default=0)
    ap.add_argument('--tables', default='')
    a = ap.parse_args()
    H = read_head(a.ours)
    R = read_head(a.ref)
    o16 = detect_c16(H)
    r16 = detect_c16(R)
    log('ours: pts=%d rgb16=%s | ref: pts=%d rgb16=%s' % (H['n'], o16, R['n'], r16))
    t0 = time.time()
    if a.tables and os.path.exists(a.tables):
        z = np.load(a.tables)
        tables = {v: (z['k%g' % v], z['c%g' % v]) for v in LAYERS}
        log('tables loaded from', a.tables)
    else:
        K3, _ = build_keys(R, r16, BASE)
        col3, cnt3 = build_means(R, r16, K3)
        tables = {BASE: (K3, np.clip(np.rint(col3), 0, 255).astype(np.uint8))}
        for v in LAYERS[1:]:
            tables[v] = derive_layer(K3, cnt3, col3, v)
        if a.tables:
            np.savez(a.tables, **{'k%g' % v: tables[v][0] for v in LAYERS},
                     **{'c%g' % v: tables[v][1] for v in LAYERS})
            log('tables cached to', a.tables)
    if a.probe:
        apply_transfer(H, o16, tables, a.dst, probe_only=a.probe)
        return
    res = apply_transfer(H, o16, tables, a.dst)
    res['sec_total'] = round(time.time() - t0, 1)
    json.dump(res, open(a.dst + '.stats.json', 'w'), indent=1)
    log('total %.1f s' % (time.time() - t0))


if __name__ == '__main__':
    main()
