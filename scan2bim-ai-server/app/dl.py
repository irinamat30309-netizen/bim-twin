"""Deep-learning point-cloud understanding for scan-to-BIM (GPU).

Primary model: PointTransformerV3 (Pointcept, detached standalone version that is
vendored under app/ptv3/). Semantic segmentation on S3DIS (13 classes: ceiling,
floor, wall, beam, column, window, door, table, chair, sofa, bookcase, board,
clutter).

Supported checkpoints (auto-detected from the state dict):
  * plain PTv3 (semseg-pt-v3m1-0-base / -0-rpe): standard BatchNorm/LayerNorm.
  * PPT joint-trained (semseg-pt-v3m1-1-ppt-extreme): PDNorm decoupled per
    dataset condition; this module builds the backbone with pdnorm enabled and
    feeds condition='S3DIS' at inference. Higher accuracy (75.4% mIoU).

Requires a CUDA GPU, PyTorch, spconv, torch_scatter, timm and addict plus a
pretrained checkpoint (see download_models.py). Fully defensive: on any missing
piece or mismatch it raises DLUnavailable and the server falls back to the
deterministic geometric pipeline. Every heavy import is lazy so the LITE/CPU
server keeps working without torch.
"""
import os
import re
import numpy as np

S3DIS_CLASSES = [
    'ceiling', 'floor', 'wall', 'beam', 'column', 'window', 'door',
    'table', 'chair', 'sofa', 'bookcase', 'board', 'clutter',
]
CLASS_IDX = {c: i for i, c in enumerate(S3DIS_CLASSES)}
# Backbone PDNorm decoupled-norm condition order, taken verbatim from the
# ppt-extreme config's backbone.pdnorm_conditions. The decoupled norm
# ModuleList is indexed in THIS order, so at inference we feed condition='S3DIS'
# (index 1). DO NOT reorder -- the PPT wrapper's own conditions tuple is
# different but is unused here because pdnorm_adaptive=False.
PDNORM_CONDITIONS = ('ScanNet', 'S3DIS', 'Structured3D')
NUM_CLASSES = 13

# --- PPT language-guided head (semseg-pt-v3m1-2-ppt-extreme) ---------------
# This checkpoint has NO plain Linear seg head. Instead it stores a projection
# head (backbone_out_channels=64 -> CLIP dim=512) plus a frozen CLIP text
# embedding for 36 unified categories. Per-point S3DIS logits are computed as
#   proj(feat) @ class_embedding[S3DIS_VALID_INDEX].T
# 36 unified category names (index -> name), from the config's class_name.
PPT_CLASS_NAME = (
    'wall', 'floor', 'cabinet', 'bed', 'chair', 'sofa', 'table', 'door',
    'window', 'bookshelf', 'bookcase', 'picture', 'counter', 'desk', 'shelves',
    'curtain', 'dresser', 'pillow', 'mirror', 'ceiling', 'refrigerator',
    'television', 'shower curtain', 'nightstand', 'toilet', 'sink', 'lamp',
    'bathtub', 'garbagebin', 'board', 'beam', 'column', 'clutter',
    'otherstructure', 'otherfurniture', 'otherprop',
)
# valid_index for S3DIS = 3rd entry of the config's valid_index tuple.
S3DIS_VALID_INDEX = (0, 1, 4, 5, 6, 7, 8, 10, 19, 29, 30, 31, 32)
# The PPT head emits logits in valid_index order. Map each output position back
# to the standard S3DIS_CLASSES id the rest of the pipeline expects.
PPT_TO_S3DIS = tuple(CLASS_IDX[PPT_CLASS_NAME[i]] for i in S3DIS_VALID_INDEX)


class DLUnavailable(RuntimeError):
    pass


_MODEL = None
_DEVICE = None
_PDNORM = False
_PPT_HEAD = False


def _lazy_torch():
    try:
        import torch  # noqa
    except Exception as e:  # pragma: no cover
        raise DLUnavailable(f'PyTorch not installed: {e}')
    return torch


def available():
    """True only if CUDA torch AND the vendored PTv3 stack import cleanly."""
    try:
        torch = _lazy_torch()
        if not bool(torch.cuda.is_available()):
            return False
        import spconv.pytorch  # noqa
        from .ptv3 import PointTransformerV3  # noqa (uses torch_scatter if present, else native shim)
        return True
    except Exception:
        return False


def diag():
    """Non-raising, detailed diagnostic of the whole DL/GPU stack.

    Returns a plain dict so the server can expose it at /diag and the app can
    show the exact reason the neural engine is or isn't working.
    """
    info = {
        'torch': None, 'cuda': False, 'device_name': None,
        'spconv': False, 'ptv3_import': False,
        'checkpoint': None, 'checkpoint_exists': False, 'checkpoint_size': 0,
        'load_ok': False, 'error': None, 'note': None,
    }
    try:
        ck = default_ckpt_path()
        info['checkpoint'] = ck
        info['checkpoint_exists'] = os.path.exists(ck)
        if info['checkpoint_exists']:
            info['checkpoint_size'] = int(os.path.getsize(ck))
    except Exception as e:
        info['error'] = f'checkpoint path error: {e}'
    try:
        import torch
        info['torch'] = getattr(torch, '__version__', '?')
        info['cuda'] = bool(torch.cuda.is_available())
        if info['cuda']:
            try:
                info['device_name'] = torch.cuda.get_device_name(0)
            except Exception:
                pass
    except Exception as e:
        info['error'] = f'torch import failed: {e}'
        return info
    try:
        import spconv.pytorch  # noqa
        info['spconv'] = True
    except Exception as e:
        info['error'] = f'spconv import failed: {e}'
        return info
    try:
        from .ptv3 import PointTransformerV3  # noqa
        info['ptv3_import'] = True
    except Exception as e:
        info['error'] = f'PTv3 import failed: {e}'
        return info
    if not info['checkpoint_exists']:
        info['error'] = f"checkpoint not found: {info['checkpoint']}"
        return info
    if not info['cuda']:
        info['error'] = 'CUDA GPU not available to PyTorch'
        return info
    # Best-effort scan of the checkpoint head layout so we can see how the
    # classifier is named even when auto-detection fails.
    try:
        raw = torch.load(info['checkpoint'], map_location='cpu', weights_only=False)
        st = _extract_state(raw)
        heads = []
        for k, v in st.items():
            shp = getattr(v, 'shape', None)
            if shp is None or len(shp) < 1:
                continue
            first = int(shp[0])
            lk = k.lower()
            named = ('head' in lk or 'seg' in lk or 'cls' in lk
                     or 'class' in lk or 's3dis' in lk)
            if first in (13, 20, 25) or named:
                heads.append(f'{k}{tuple(int(x) for x in shp)}')
        info['head_scan'] = heads[:40]
        info['head_count'] = len(heads)
    except Exception as e:
        info['head_scan'] = f'scan failed: {type(e).__name__}: {e}'
    try:
        load_model(info['checkpoint'])
        info['load_ok'] = True
        info['note'] = 'PTv3 model loaded OK'
    except DLUnavailable as e:
        info['error'] = f'load_model: {e}'
        return info
    except Exception as e:
        import traceback as _tb
        info['error'] = f'load_model crashed: {type(e).__name__}: {e}'
        info['error_trace'] = _tb.format_exc()[-1400:]
        return info
    # End-to-end forward self-test. This is the ONLY check that actually runs
    # the spconv / attention CUDA kernels the real build depends on. Import and
    # weight-load can all succeed while the first real convolution still fails
    # (e.g. a spconv wheel with no kernels for this GPU architecture, or an OOM).
    # Running a tiny synthetic cloud here surfaces that exact error instead of
    # silently falling back to the geometric engine on every build.
    try:
        import numpy as _np
        rng = _np.random.RandomState(0)
        pts = rng.rand(4096, 3).astype('float32')
        pts[:, 2] *= 0.08  # a mostly-flat slab so serialization/normals behave
        rgb = (rng.rand(4096, 3) * 255.0).astype('float32')
        lbl = segment(pts, rgb)
        ok = hasattr(lbl, 'shape') and int(lbl.shape[0]) == pts.shape[0]
        info['forward_ok'] = bool(ok)
        info['note'] = ('PTv3 forward self-test OK' if ok
                        else 'PTv3 forward returned an unexpected shape')
        if ok:
            uniq = sorted(set(int(x) for x in _np.asarray(lbl).ravel().tolist()))
            info['forward_classes'] = uniq[:13]
    except DLUnavailable as e:
        info['forward_ok'] = False
        info['error'] = f'forward: {e}'
    except Exception as e:
        import traceback as _tb
        info['forward_ok'] = False
        info['error'] = f'forward crashed: {type(e).__name__}: {e}'
        info['forward_trace'] = _tb.format_exc()[-1400:]
    return info


def _models_dir():
    # app/dl.py -> scan2bim-ai-server/models (absolute, cwd-independent)
    return os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'models')


def default_ckpt_path():
    """Resolve the checkpoint path (cwd-independent, forgiving of filename).

    Order: env S2B_CKPT -> models/ptv3_s3dis.pth -> models/model_best.pth ->
    any *.pth dropped into the models folder.
    """
    env = os.environ.get('S2B_CKPT')
    if env:
        return env
    mdir = _models_dir()
    for name in ('ptv3_s3dis.pth', 'model_best.pth'):
        p = os.path.join(mdir, name)
        if os.path.exists(p):
            return p
    try:
        for f in sorted(os.listdir(mdir)):
            if f.lower().endswith('.pth'):
                return os.path.join(mdir, f)
    except Exception:
        pass
    return os.path.join(mdir, 'ptv3_s3dis.pth')


def _extract_state(raw):
    state = raw
    if isinstance(raw, dict):
        for key in ('state_dict', 'model', 'model_state_dict'):
            if key in raw and isinstance(raw[key], dict):
                state = raw[key]
                break
    if not isinstance(state, dict):
        raise DLUnavailable('checkpoint is not a state dict')
    clean = {}
    for k, v in state.items():
        nk = k
        if nk.startswith('module.'):
            nk = nk[len('module.'):]
        clean[nk] = v
    return clean


def _detect_arch(state):
    """Infer (pdnorm, enable_rpe, backbone_prefix) from checkpoint keys."""
    keys = list(state.keys())
    # PDNorm decoupled norm becomes a ModuleList: '...norm.<idx>.weight'
    pdnorm = any(re.search(r'\.norm\.\d+\.(weight|bias)$', k) for k in keys)
    rpe = any(('.rpe.' in k) or ('rpe_table' in k) for k in keys)
    adaptive = any('modulation' in k for k in keys)
    # Some checkpoints prefix everything with 'backbone.'
    has_backbone_prefix = any(k.startswith('backbone.') for k in keys)
    return pdnorm, rpe, adaptive, has_backbone_prefix


def _detect_ppt_head(state):
    """Detect a PPT language-guided head in the checkpoint.

    The ppt-extreme checkpoint has no plain Linear seg head. Instead it stores
    `proj_head.weight` (Linear [clip_dim, backbone_out]) and a frozen
    `class_embedding` buffer [num_unified, clip_dim]. Returns a dict with
    (proj_in, proj_out, emb_rows, has_logit_scale, proj_wkey, proj_bkey,
    emb_key, scale_key) or None if no such head is present.
    """
    proj_wkey = proj_bkey = emb_key = scale_key = None
    proj_out = proj_in = emb_rows = None
    for k, v in state.items():
        shp = getattr(v, 'shape', None)
        if k.endswith('proj_head.weight') and shp is not None and len(shp) == 2:
            proj_wkey = k
            proj_out, proj_in = int(shp[0]), int(shp[1])
        elif k.endswith('proj_head.bias') and shp is not None:
            proj_bkey = k
        elif k.endswith('class_embedding') and shp is not None and len(shp) == 2:
            emb_key = k
            emb_rows = int(shp[0])
        elif k.endswith('logit_scale'):
            scale_key = k
    if proj_wkey is None or emb_key is None:
        return None
    # projection output dim must match the CLIP embedding dim
    emb_dim = int(getattr(state[emb_key], 'shape', (0, 0))[1])
    if proj_out != emb_dim:
        return None
    return {
        'proj_in': proj_in, 'proj_out': proj_out, 'emb_rows': emb_rows,
        'has_logit_scale': scale_key is not None,
        'proj_wkey': proj_wkey, 'proj_bkey': proj_bkey,
        'emb_key': emb_key, 'scale_key': scale_key,
    }


def _find_seg_head(state):
    """Locate the 13-class linear seg head weight, return (wkey, bkey, in_dim).

    PPT models can store several dataset heads; we pick the one that outputs
    exactly NUM_CLASSES (S3DIS). Falls back to any [13, X] linear weight.
    """
    # PPT-extreme keeps several dataset heads (ScanNet=20, S3DIS=13,
    # Structured3D=25). Accept Linear ([13, C]) or Conv1d ([13, C, 1]) weights
    # and prefer names that clearly identify the S3DIS classifier.
    candidates = []
    for k, v in state.items():
        shp = getattr(v, 'shape', None)
        if shp is None or len(shp) < 2:
            continue
        if not k.endswith('.weight'):
            continue
        out_dim, in_dim = int(shp[0]), int(shp[1])
        if out_dim != NUM_CLASSES:
            continue
        base = k[:-len('.weight')]
        bkey = base + '.bias'
        lk = k.lower()
        score = 0
        if 's3dis' in lk:
            score += 30
        if 'seg_head' in lk or 'seg_heads' in lk:
            score += 10
        if 'cls' in lk or 'class' in lk or 'head' in lk or 'classifier' in lk:
            score += 5
        if len(shp) == 2:
            score += 2  # prefer a plain Linear over a conv head
        candidates.append((score, k, bkey, in_dim))
    if not candidates:
        return None, None, None
    candidates.sort(reverse=True)
    _, wkey, bkey, in_dim = candidates[0]
    return wkey, bkey, in_dim


def _ps_for_pos_bnd(pb):
    """Invert PTv3 RPE: pos_bnd = int((4*patch_size)**(1/3)*2).

    Returns a patch_size that reproduces the checkpoint's rpe_table size,
    preferring standard values so the attention window matches training.
    """
    if pb is None:
        return 1024
    for cand in (1024, 512, 256, 128, 96, 64, 48, 32, 24, 16, 8, 4):
        try:
            if int((4 * cand) ** (1.0 / 3.0) * 2) == pb:
                return cand
        except Exception:
            pass
    for ps in range(1, 8193):
        if int((4 * ps) ** (1.0 / 3.0) * 2) == pb:
            return ps
    return 1024


def _infer_ptv3_config(state):
    """Infer PTv3 encoder/decoder dims from checkpoint tensor shapes.

    Reads channel counts (attn.qkv.weight [3C, C]), head counts and RPE window
    (attn.rpe.rpe_table [3*(2*pos_bnd+1), heads]) and block depths so the model
    we build matches the checkpoint EXACTLY. Returns None if keys are absent
    (then we fall back to the default S3DIS config).
    """
    enc = {}
    dec = {}
    for k, v in state.items():
        shp = getattr(v, 'shape', None)
        if shp is None:
            continue
        m = re.search(r'enc\.enc(\d+)\.block(\d+)\.attn\.qkv\.weight$', k)
        if m:
            d = enc.setdefault(int(m.group(1)), {})
            d['C'] = int(shp[1])
            d['depth'] = max(d.get('depth', 0), int(m.group(2)) + 1)
            continue
        m = re.search(r'enc\.enc(\d+)\.block(\d+)\.attn\.rpe\.rpe_table$', k)
        if m:
            d = enc.setdefault(int(m.group(1)), {})
            d['H'] = int(shp[1]); d['rpe0'] = int(shp[0])
            d['depth'] = max(d.get('depth', 0), int(m.group(2)) + 1)
            continue
        m = re.search(r'dec\.dec(\d+)\.block(\d+)\.attn\.qkv\.weight$', k)
        if m:
            d = dec.setdefault(int(m.group(1)), {})
            d['C'] = int(shp[1])
            d['depth'] = max(d.get('depth', 0), int(m.group(2)) + 1)
            continue
        m = re.search(r'dec\.dec(\d+)\.block(\d+)\.attn\.rpe\.rpe_table$', k)
        if m:
            d = dec.setdefault(int(m.group(1)), {})
            d['H'] = int(shp[1]); d['rpe0'] = int(shp[0])
            d['depth'] = max(d.get('depth', 0), int(m.group(2)) + 1)
            continue
    if not enc:
        return None
    enc_stages = sorted(enc.keys())
    if enc_stages != list(range(len(enc_stages))):
        return None
    for s in enc_stages:
        if 'C' not in enc[s] or 'H' not in enc[s]:
            return None
    cfg = {
        'enc_channels': tuple(enc[s]['C'] for s in enc_stages),
        'enc_num_head': tuple(enc[s]['H'] for s in enc_stages),
        'enc_depths': tuple(enc[s].get('depth', 2) for s in enc_stages),
        'enc_patch_size': tuple(
            _ps_for_pos_bnd((enc[s]['rpe0'] // 3 - 1) // 2 if enc[s].get('rpe0') else None)
            for s in enc_stages),
    }
    if dec:
        dec_stages = sorted(dec.keys())
        if dec_stages == list(range(len(dec_stages))) and len(dec_stages) == len(enc_stages) - 1:
            cfg['dec_channels'] = tuple(dec[s].get('C', 64) for s in dec_stages)
            cfg['dec_num_head'] = tuple(dec[s].get('H', 4) for s in dec_stages)
            cfg['dec_depths'] = tuple(dec[s].get('depth', 2) for s in dec_stages)
            cfg['dec_patch_size'] = tuple(
                _ps_for_pos_bnd((dec[s]['rpe0'] // 3 - 1) // 2 if dec[s].get('rpe0') else None)
                for s in dec_stages)
    return cfg


def _build_segmentor(torch, pdnorm, enable_rpe, head_in_dim, cfg=None, ppt=None):
    import torch.nn as nn
    from .ptv3 import PointTransformerV3

    cfg = cfg or {}
    backbone = PointTransformerV3(
        in_channels=6,
        order=('z', 'z-trans', 'hilbert', 'hilbert-trans'),
        stride=(2, 2, 2, 2),
        enc_depths=cfg.get('enc_depths', (2, 2, 2, 6, 2)),
        enc_channels=cfg.get('enc_channels', (32, 64, 128, 256, 512)),
        enc_num_head=cfg.get('enc_num_head', (2, 4, 8, 16, 32)),
        enc_patch_size=cfg.get('enc_patch_size', (1024, 1024, 1024, 1024, 1024)),
        dec_depths=cfg.get('dec_depths', (2, 2, 2, 2)),
        dec_channels=cfg.get('dec_channels', (64, 64, 128, 256)),
        dec_num_head=cfg.get('dec_num_head', (4, 4, 8, 16)),
        dec_patch_size=cfg.get('dec_patch_size', (1024, 1024, 1024, 1024)),
        mlp_ratio=4,
        enable_rpe=bool(enable_rpe),
        enable_flash=False,
        shuffle_orders=True,
        pdnorm_bn=bool(pdnorm),
        pdnorm_ln=bool(pdnorm),
        pdnorm_decouple=True,
        pdnorm_adaptive=False,
        pdnorm_conditions=PDNORM_CONDITIONS,
    )
    in_dim = int(head_in_dim) if head_in_dim else 64

    if ppt:
        valid_index = list(S3DIS_VALID_INDEX)

        class PPTSegmentor(nn.Module):
            """PTv3 backbone + PPT language-guided (CLIP) classifier.

            logits = (proj_head(feat) / ||.||) @ class_embedding[valid].T * s
            The per-point L2 norm and the positive logit_scale do not change the
            argmax, but we replicate the training-time forward exactly.
            """

            def __init__(self):
                super().__init__()
                self.backbone = backbone
                self.proj_head = nn.Linear(ppt['proj_in'], ppt['proj_out'])
                self.register_buffer(
                    'class_embedding',
                    torch.zeros(ppt['emb_rows'], ppt['proj_out']))
                self.register_buffer('logit_scale', torch.zeros(()))
                self.valid_index = valid_index

            def forward(self, data_dict):
                point = self.backbone(data_dict)
                feat = point.feat if hasattr(point, 'feat') else point
                feat = self.proj_head(feat)
                feat = feat / (feat.norm(dim=-1, keepdim=True) + 1e-8)
                emb = self.class_embedding[self.valid_index, :]
                sim = feat @ emb.t()
                return self.logit_scale.exp() * sim

        return PPTSegmentor()

    class Segmentor(nn.Module):
        def __init__(self):
            super().__init__()
            self.backbone = backbone
            self.seg_head = nn.Linear(in_dim, NUM_CLASSES)

        def forward(self, data_dict):
            point = self.backbone(data_dict)
            feat = point.feat if hasattr(point, 'feat') else point
            return self.seg_head(feat)

    return Segmentor()


def load_model(ckpt_path=None, device='cuda'):
    """Load the standalone PTv3 S3DIS model, auto-adapting to the checkpoint."""
    global _MODEL, _DEVICE, _PDNORM, _PPT_HEAD
    if _MODEL is not None:
        return _MODEL
    torch = _lazy_torch()
    if device == 'cuda' and not torch.cuda.is_available():
        raise DLUnavailable('CUDA GPU not available')
    ckpt_path = ckpt_path or default_ckpt_path()
    if not os.path.exists(ckpt_path):
        raise DLUnavailable(
            f'checkpoint not found: {ckpt_path} (run download_models.py)')
    # PyTorch 2.6+ defaults torch.load to weights_only=True, which rejects the
    # official Pointcept checkpoints (they pickle a `getattr` global). The file
    # comes from a trusted source (HuggingFace Pointcept), so load in full mode.
    try:
        try:
            raw = torch.load(ckpt_path, map_location='cpu', weights_only=False)
        except TypeError:
            # Older torch without the weights_only argument.
            raw = torch.load(ckpt_path, map_location='cpu')
    except Exception as e:
        raise DLUnavailable(f'failed to read checkpoint {ckpt_path}: {e}')
    state = _extract_state(raw)
    pdnorm, rpe, adaptive, has_bb_prefix = _detect_arch(state)
    if adaptive:
        raise DLUnavailable(
            'checkpoint uses adaptive PDNorm (CLIP context) which is not '
            'supported in this build; use a *-ppt-extreme or *-rpe semseg model')
    # Prefer the PPT language-guided head (ppt-extreme). Fall back to a plain
    # Linear 13-class head for the base/rpe semseg checkpoints.
    ppt = _detect_ppt_head(state)
    wkey = bkey = None
    in_dim = 64
    if ppt is None:
        wkey, bkey, in_dim = _find_seg_head(state)
    else:
        in_dim = ppt['proj_in']
    cfg = None
    try:
        cfg = _infer_ptv3_config(state)
    except Exception:
        cfg = None
    try:
        model = _build_segmentor(torch, pdnorm, rpe, in_dim, cfg, ppt)
    except Exception as e:
        raise DLUnavailable(f'PTv3 stack not installed: {e}')

    # Remap checkpoint keys onto our module namespace. Backbone weights go under
    # backbone.*; the PPT head keys (proj_head.*, class_embedding, logit_scale)
    # and the linear seg_head keys stay at the top level. Anything else (e.g.
    # embedding_table, criteria) is dropped by strict=False.
    head_names = ('seg_head', 'proj_head', 'class_embedding', 'logit_scale')
    remap = {}
    for k, v in state.items():
        nk = k
        if has_bb_prefix and nk.startswith('backbone.'):
            remap[nk] = v
        elif has_bb_prefix:
            # Non-backbone keys already at top level (head, embedding_table...).
            remap[nk] = v
        elif not nk.startswith(head_names) and \
                (wkey is None or k not in (wkey, bkey)):
            remap['backbone.' + nk] = v
        else:
            remap[nk] = v
    if ppt is None and wkey is not None:
        w = state[wkey]
        # Squeeze a Conv1d head weight ([13, C, 1]) down to Linear ([13, C]).
        try:
            if hasattr(w, 'ndim') and w.ndim == 3 and int(w.shape[2]) == 1:
                w = w[:, :, 0]
        except Exception:
            pass
        remap['seg_head.weight'] = w
        if bkey is not None and bkey in state:
            remap['seg_head.bias'] = state[bkey]

    missing, unexpected = model.load_state_dict(remap, strict=False)
    matched = len(remap) - len(unexpected)
    if matched < 50:
        raise DLUnavailable(
            f'checkpoint does not match PTv3 (only {matched} tensors matched); '
            f'wrong or invalid weights file')
    if ppt is None and wkey is None:
        raise DLUnavailable('no 13-class S3DIS segmentation head found in checkpoint')
    # Sanity-check that the PPT head tensors actually loaded.
    if ppt is not None:
        need = {'proj_head.weight', 'class_embedding'}
        if need & set(unexpected):
            raise DLUnavailable(
                'PPT head detected but proj_head/class_embedding did not load')
    model = model.to(device).eval()
    _MODEL = model
    _DEVICE = device
    _PDNORM = bool(pdnorm)
    _PPT_HEAD = ppt is not None
    print(f'[dl] PTv3 loaded: pdnorm={pdnorm} rpe={rpe} '
          f'head={"PPT(CLIP)" if ppt else "linear"} in_dim={in_dim} '
          f'matched={matched} missing={len(missing)} unexpected={len(unexpected)}')
    if ppt:
        print(f'[dl] PPT head: proj {ppt["proj_in"]}->{ppt["proj_out"]} '
              f'emb_rows={ppt["emb_rows"]} valid={len(S3DIS_VALID_INDEX)} '
              f'logit_scale={ppt["has_logit_scale"]}')
    if cfg:
        print(f'[dl] inferred config: enc_channels={cfg.get("enc_channels")} '
              f'enc_num_head={cfg.get("enc_num_head")} '
              f'enc_patch_size={cfg.get("enc_patch_size")}')
    return model


def _voxel_ids(xyz, cell):
    """Collision-free 1-D voxel ids; much cheaper than unique(axis=0)."""
    q = np.floor(np.asarray(xyz) / max(float(cell), 1e-9)).astype(np.int64)
    if q.shape[0] == 0:
        return np.zeros(0, dtype=np.int64)
    q -= q.min(axis=0)
    span = q.max(axis=0) + 1
    limit = np.iinfo(np.int64).max
    sy, sz = int(span[1]), int(span[2])
    if sy <= 0 or sz <= 0 or int(span[0]) > limit // sy // sz:
        return np.ascontiguousarray(q).view(
            np.dtype((np.void, q.dtype.itemsize * q.shape[1]))).ravel()
    return (q[:, 0] * sy + q[:, 1]) * sz + q[:, 2]


def _grid_sample(xyz, grid=0.04):
    key = _voxel_ids(xyz, grid)
    _, first, inv = np.unique(key, return_index=True, return_inverse=True)
    return first, inv


def _estimate_normals(coord, cell):
    """Vectorized coarse per-voxel PCA normals.

    The ppt-extreme model consumes feat=[color, normal]. We don't get normals
    from the scanner, so approximate them: group points into cells of size
    `cell`, fit a plane per cell via PCA, and assign the plane normal (smallest
    eigenvector of the covariance) to every point in the cell. This is enough to
    orient walls/floors/ceilings for the semantic model. Fully vectorized.
    """
    coord = np.asarray(coord, dtype=np.float64)
    n = coord.shape[0]
    if n == 0:
        return np.zeros((0, 3), dtype=np.float32)
    keys = _voxel_ids(coord, max(cell, 1e-6))
    _, inv, counts = np.unique(keys, return_inverse=True, return_counts=True)
    g = counts.shape[0]
    sums = np.zeros((g, 3), dtype=np.float64)
    np.add.at(sums, inv, coord)
    cent = sums / counts[:, None]
    d = coord - cent[inv]
    comps = np.stack([
        d[:, 0] * d[:, 0], d[:, 1] * d[:, 1], d[:, 2] * d[:, 2],
        d[:, 0] * d[:, 1], d[:, 0] * d[:, 2], d[:, 1] * d[:, 2],
    ], axis=1)
    cov = np.zeros((g, 6), dtype=np.float64)
    np.add.at(cov, inv, comps)
    cov /= np.maximum(counts[:, None], 1)
    C = np.zeros((g, 3, 3), dtype=np.float64)
    C[:, 0, 0] = cov[:, 0]; C[:, 1, 1] = cov[:, 1]; C[:, 2, 2] = cov[:, 2]
    C[:, 0, 1] = cov[:, 3]; C[:, 1, 0] = cov[:, 3]
    C[:, 0, 2] = cov[:, 4]; C[:, 2, 0] = cov[:, 4]
    C[:, 1, 2] = cov[:, 5]; C[:, 2, 1] = cov[:, 5]
    try:
        _, V = np.linalg.eigh(C)          # ascending eigenvalues
        gnrm = V[:, :, 0]                  # eigenvector of smallest eigenvalue
    except Exception:
        gnrm = np.zeros((g, 3), dtype=np.float64)
    normals = gnrm[inv]
    ln = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = normals / np.maximum(ln, 1e-8)
    return normals.astype(np.float32)


def _is_cuda_device(torch):
    """True when the loaded model lives on a CUDA device."""
    try:
        d = _DEVICE
        if isinstance(d, str):
            return 'cuda' in d
        return getattr(d, 'type', '') == 'cuda'
    except Exception:
        return False


def _cuda_free_bytes(torch):
    try:
        free, _total = torch.cuda.mem_get_info()
        return int(free)
    except Exception:
        return 0


def _auto_batch_points(torch, on_cuda, default_bp):
    """Pick a chunk size that fits the free VRAM so the same build runs on an
    8 GB laptop GPU and a 24 GB workstation card alike. The OOM ladder in
    segment() shrinks further if this estimate is still too optimistic."""
    if not on_cuda:
        return default_bp
    free = _cuda_free_bytes(torch)
    if free <= 0:
        return default_bp
    # Conservative PTv3 fp32 activation budget (~9 KB/point) at 55% of free VRAM.
    est = int((free * 0.55) / 9000.0)
    return max(40000, min(int(default_bp), est))


def segment(xyz, rgb=None, ckpt_path=None, grid=0.02, batch_points=600000):
    """Return per-point S3DIS class ids (int array aligned to input xyz)."""
    torch = _lazy_torch()
    model = load_model(ckpt_path)
    xyz = np.asarray(xyz, dtype=np.float32)
    if rgb is None:
        rgb = np.full((xyz.shape[0], 3), 128, dtype=np.float32)
    rgb = np.asarray(rgb, dtype=np.float32)
    first, inv = _grid_sample(xyz, grid)
    coord = xyz[first].astype(np.float32)
    color = (rgb[first].astype(np.float32) / 255.0)
    # Match Pointcept test transform CenterShift(apply_z=False): centre x/y on
    # their midpoint and drop z to the floor (min). This mirrors how the
    # ppt-extreme checkpoint was trained and improves segmentation accuracy.
    cmin = coord.min(0)
    cmax = coord.max(0)
    shift = np.array([(cmin[0] + cmax[0]) * 0.5,
                      (cmin[1] + cmax[1]) * 0.5,
                      cmin[2]], dtype=np.float32)
    coord_c = (coord - shift).astype(np.float32)
    if _PPT_HEAD:
        # ppt-extreme is trained with feat = [color(3), normal(3)].
        try:
            normals = _estimate_normals(coord, max(grid * 3.0, 0.06))
        except Exception:
            normals = np.zeros((coord.shape[0], 3), dtype=np.float32)
        feat = np.concatenate([color, normals], axis=1).astype(np.float32)
    else:
        # plain base/rpe semseg heads use feat = [coord(3), color(3)].
        feat = np.concatenate([coord_c, color], axis=1).astype(np.float32)
    grid_coord = np.floor((coord - coord.min(0)) / grid).astype(np.int64)
    n = coord.shape[0]
    labels = np.zeros(n, dtype=np.int64)
    on_cuda = _is_cuda_device(torch)
    bp = _auto_batch_points(torch, on_cuda, int(batch_points))
    floor_bp = 40000
    use_amp = False
    with torch.no_grad():
        s = 0
        while s < n:
            e = min(n, s + bp)
            done = False
            while not done:
                try:
                    data = dict(
                        coord=torch.from_numpy(coord_c[s:e]).to(_DEVICE),
                        grid_coord=torch.from_numpy(grid_coord[s:e]).to(_DEVICE),
                        feat=torch.from_numpy(feat[s:e]).to(_DEVICE),
                        grid_size=float(grid),
                        offset=torch.tensor([e - s], device=_DEVICE),
                    )
                    if _PDNORM:
                        data['condition'] = 'S3DIS'
                    if use_amp and on_cuda:
                        with torch.autocast(device_type='cuda',
                                            dtype=torch.float16):
                            logits = model(data)
                    else:
                        logits = model(data)
                    if isinstance(logits, dict):
                        logits = logits.get('seg_logits', logits.get('feat'))
                    labels[s:e] = logits.float().argmax(1).cpu().numpy()
                    done = True
                except RuntimeError as ex:
                    msg = str(ex).lower()
                    try:
                        torch.cuda.empty_cache()
                    except Exception:
                        pass
                    is_oom = ('out of memory' in msg) or ('cuda oom' in msg) \
                        or ('alloc' in msg and 'cuda' in msg)
                    if not is_oom:
                        raise
                    # Memory ladder so any GPU size can finish:
                    # (1) shrink the chunk, (2) retry in fp16, (3) give up.
                    if (e - s) > floor_bp:
                        bp = max(floor_bp, (e - s) // 2)
                        e = min(n, s + bp)
                        continue
                    if on_cuda and not use_amp:
                        use_amp = True
                        continue
                    raise DLUnavailable(
                        f'GPU out of memory even at {e - s} points ({ex}); '
                        f'try a coarser grid')
                finally:
                    try:
                        torch.cuda.empty_cache()
                    except Exception:
                        pass
            s = e
    if _PPT_HEAD:
        # The PPT head emits logits in valid_index order; remap to S3DIS ids.
        lut = np.asarray(PPT_TO_S3DIS, dtype=np.int64)
        labels = lut[labels]
    return labels[inv]


def segment_instances(xyz, rgb=None, ckpt_path=None):
    """Optional Mask3D instance segmentation (not configured in this build)."""
    raise DLUnavailable('Mask3D instance segmentation not configured; use segment()')
