"""Pure-PyTorch replacement for torch_scatter.segment_csr.

torch-scatter ships as a source dist that needs the CUDA toolkit (nvcc) to build
on Windows, which routinely fails for end users. PointTransformerV3 only uses
`torch_scatter.segment_csr` (sum/mean/max pooling over contiguous CSR segments),
so this module provides a drop-in that:
  * uses the real torch_scatter if it is importable (fastest), otherwise
  * falls back to a correct native-PyTorch implementation.

This removes torch-scatter from the hard requirements; the GPU neural net (PTv3)
runs with just torch + spconv.
"""
import torch

try:  # prefer the optimized C++/CUDA implementation when available
    import torch_scatter as _ts
    _HAS_TS = True
except Exception:  # pragma: no cover - fallback path
    _ts = None
    _HAS_TS = False


def _segments_from_indptr(indptr):
    counts = (indptr[1:] - indptr[:-1]).long()
    num_seg = int(counts.numel())
    seg = torch.repeat_interleave(
        torch.arange(num_seg, device=indptr.device), counts
    )
    return seg, counts, num_seg


def segment_csr(src, indptr, reduce='sum'):
    """out[i] = reduce(src[indptr[i]:indptr[i+1]]) along dim 0.

    src: (N, ...) float tensor sorted so segments are contiguous.
    indptr: (S+1,) long tensor of segment boundaries.
    reduce: 'sum' | 'add' | 'mean' | 'max' | 'min'.
    """
    if _HAS_TS:
        return _ts.segment_csr(src, indptr, reduce=reduce)

    seg, counts, num_seg = _segments_from_indptr(indptr)
    out_shape = (num_seg,) + tuple(src.shape[1:])

    # broadcast the segment index to src's shape for scatter along dim 0
    index = seg
    for _ in range(src.dim() - 1):
        index = index.unsqueeze(-1)
    if src.dim() > 1:
        index = index.expand(src.shape)

    if reduce in ('sum', 'add', 'mean'):
        out = src.new_zeros(out_shape)
        out.scatter_add_(0, index, src)
        if reduce == 'mean':
            cnt = counts.clamp(min=1).to(src.dtype)
            cnt = cnt.view((num_seg,) + (1,) * (src.dim() - 1))
            out = out / cnt
        return out

    if reduce in ('max', 'min'):
        red = 'amax' if reduce == 'max' else 'amin'
        out = src.new_zeros(out_shape)
        out = out.scatter_reduce(0, index, src, reduce=red, include_self=False)
        return out

    raise ValueError('unsupported reduce: %s' % reduce)
