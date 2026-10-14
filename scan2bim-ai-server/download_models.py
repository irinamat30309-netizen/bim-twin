"""Download the PointTransformerV3 S3DIS checkpoint used by the AI engine.

Default target: the high-accuracy PPT joint-trained S3DIS model
(s3dis-semseg-pt-v3m1-1-ppt-extreme, 75.4% mIoU) from the Pointcept HuggingFace
model zoo. Both the weights (model_best.pth) and the config (config.py) are
fetched; the config is kept for reference/QA.

Robust downloader: sends a browser User-Agent (HuggingFace returns 403 to the
default urllib agent), follows redirects, streams to a .part file with progress,
then atomically renames. Resolution order for the weights URL:
  1. env S2B_CKPT_URL
  2. models/ckpt-url.txt (first non-comment line)
  3. DEFAULT_WEIGHTS_URL below

Usage:
  python download_models.py
  S2B_CKPT_URL=https://... python download_models.py
"""
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(HERE, 'models')
DEST = os.path.join(MODELS_DIR, 'ptv3_s3dis.pth')
CONFIG_DEST = os.path.join(MODELS_DIR, 'ptv3_s3dis_config.py')
URL_FILE = os.path.join(MODELS_DIR, 'ckpt-url.txt')

_HF = 'https://huggingface.co/Pointcept/PointTransformerV3/resolve/main'
_EXP = 's3dis-semseg-pt-v3m1-1-ppt-extreme'
DEFAULT_WEIGHTS_URL = f'{_HF}/{_EXP}/model/model_best.pth'
DEFAULT_CONFIG_URL = f'{_HF}/{_EXP}/config.py'

_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
       '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 scan2bim')


def _resolve_weights_url():
    url = os.environ.get('S2B_CKPT_URL')
    if url:
        return url.strip()
    if os.path.exists(URL_FILE):
        try:
            with open(URL_FILE, encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#'):
                        return line
        except Exception:
            pass
    return DEFAULT_WEIGHTS_URL


def _download(url, dest, min_size, label):
    if os.path.exists(dest) and os.path.getsize(dest) > min_size:
        print('[OK] %s already present: %s' % (label, dest))
        return True
    tmp = dest + '.part'
    try:
        if os.path.exists(tmp):
            os.remove(tmp)
    except Exception:
        pass
    print('Downloading %s:\n  %s\n  -> %s' % (label, url, dest))
    req = urllib.request.Request(url, headers={'User-Agent': _UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            total = 0
            try:
                total = int(r.headers.get('Content-Length') or 0)
            except Exception:
                total = 0
            done = 0
            with open(tmp, 'wb') as f:
                while True:
                    chunk = r.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = done * 100 // total
                        sys.stdout.write('\r  %3d%%  %d / %d MB' % (
                            pct, done // 1048576, total // 1048576))
                        sys.stdout.flush()
            if total:
                sys.stdout.write('\n')
                sys.stdout.flush()
    except Exception as e:
        print('[ERROR] %s download failed: %s' % (label, e))
        try:
            os.remove(tmp)
        except Exception:
            pass
        return False
    size = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    if size < min_size:
        print('[ERROR] %s too small (%d bytes) - likely invalid or blocked.' % (label, size))
        try:
            os.remove(tmp)
        except Exception:
            pass
        return False
    try:
        os.replace(tmp, dest)
    except Exception as e:
        print('[ERROR] could not finalize %s: %s' % (label, e))
        return False
    print('[OK] %s done (%d bytes)' % (label, size))
    return True


def main():
    os.makedirs(MODELS_DIR, exist_ok=True)
    weights_url = _resolve_weights_url()
    cfg_url = DEFAULT_CONFIG_URL
    if weights_url != DEFAULT_WEIGHTS_URL and weights_url.endswith('model_best.pth'):
        cfg_url = weights_url.rsplit('/model/', 1)[0] + '/config.py'
    # config is best-effort and never fails the run
    _download(cfg_url, CONFIG_DEST, 200, 'config.py')
    ok = _download(weights_url, DEST, 1024 * 100, 'model weights')
    if not ok:
        print('')
        print('=== Ne udalos skachat vesa avtomaticheski ===')
        print('Skachayte fayl vruchnuyu v brauzere i polozhite v papku models:')
        print('  ' + weights_url)
        print('  -> ' + DEST)
        print('(mozhno polozhit lyuboy .pth, naprimer model_best.pth - server ego naydet)')
        sys.exit(1)


if __name__ == '__main__':
    main()
