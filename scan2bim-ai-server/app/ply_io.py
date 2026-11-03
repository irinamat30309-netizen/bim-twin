"""PLY read/write for the Scan2BIM AI server. Supports binary_little_endian and ascii
with float x/y/z and optional uchar red/green/blue."""
import numpy as np


def read_ply(path):
    with open(path, 'rb') as f:
        raw = f.read()
    hdr_end = raw.find(b'end_header')
    if hdr_end < 0:
        raise ValueError('not a PLY file (no end_header)')
    header = raw[:hdr_end].decode('ascii', 'replace')
    data_start = hdr_end + len(b'end_header')
    # skip the newline(s) after end_header
    while data_start < len(raw) and raw[data_start:data_start + 1] in (b'\n', b'\r'):
        data_start += 1
    fmt = 'ascii'
    n = 0
    props = []  # list of (type, name)
    in_vertex = False
    for line in header.splitlines():
        t = line.strip().split()
        if not t:
            continue
        if t[0] == 'format':
            fmt = t[1]
        elif t[0] == 'element':
            in_vertex = (t[1] == 'vertex')
            if in_vertex:
                n = int(t[2])
        elif t[0] == 'property' and in_vertex:
            props.append((t[1], t[-1]))
    names = [p[1] for p in props]
    if fmt.startswith('binary'):
        endian = '<' if 'little' in fmt else '>'
        np_type = {'float': 'f4', 'float32': 'f4', 'double': 'f8', 'float64': 'f8',
                   'uchar': 'u1', 'uint8': 'u1', 'char': 'i1', 'int8': 'i1',
                   'ushort': 'u2', 'short': 'i2', 'uint': 'u4', 'int': 'i4', 'int32': 'i4'}
        dt = np.dtype([(nm, endian + np_type[tp]) for tp, nm in props])
        arr = np.frombuffer(raw, dtype=dt, count=n, offset=data_start)
        xyz = np.stack([arr['x'], arr['y'], arr['z']], axis=1).astype(np.float64)
        rgb = None
        if {'red', 'green', 'blue'}.issubset(names):
            rgb = np.stack([arr['red'], arr['green'], arr['blue']], axis=1).astype(np.uint8)
        return xyz, rgb
    else:
        vals = np.fromstring(raw[data_start:].decode('ascii', 'replace'), sep=' ')
        vals = vals.reshape(n, len(props))
        cols = {nm: vals[:, i] for i, (_, nm) in enumerate(props)}
        xyz = np.stack([cols['x'], cols['y'], cols['z']], axis=1).astype(np.float64)
        rgb = None
        if {'red', 'green', 'blue'}.issubset(names):
            rgb = np.stack([cols['red'], cols['green'], cols['blue']], axis=1).astype(np.uint8)
        return xyz, rgb


def write_ply(path, xyz, rgb=None):
    n = xyz.shape[0]
    with open(path, 'wb') as f:
        h = 'ply\nformat binary_little_endian 1.0\n'
        h += f'element vertex {n}\n'
        h += 'property float x\nproperty float y\nproperty float z\n'
        if rgb is not None:
            h += 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
        h += 'end_header\n'
        f.write(h.encode('ascii'))
        if rgb is not None:
            dt = np.dtype([('x', '<f4'), ('y', '<f4'), ('z', '<f4'),
                           ('r', 'u1'), ('g', 'u1'), ('b', 'u1')])
            out = np.empty(n, dtype=dt)
            out['x'], out['y'], out['z'] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
            out['r'], out['g'], out['b'] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
        else:
            out = xyz.astype('<f4')
        f.write(out.tobytes())
