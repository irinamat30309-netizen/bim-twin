# Scan2BIM AI server — CUDA GPU image.
# Build:  docker build -t scan2bim-ai .
# Run:    docker run --gpus all -p 8765:8765 -v %cd%/models:/app/models scan2bim-ai
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip git build-essential && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-gpu.txt .
# PyTorch for CUDA 12.1
RUN pip3 install --no-cache-dir torch==2.3.1 --index-url https://download.pytorch.org/whl/cu121
RUN pip3 install --no-cache-dir -r requirements-gpu.txt || true
# Pointcept (semantic segmentation backbone). Ops like spconv/flash-attn may need
# to be matched to your CUDA; see README for troubleshooting.
RUN pip3 install --no-cache-dir git+https://github.com/Pointcept/Pointcept.git || true

COPY . .
EXPOSE 8765
CMD ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8765"]
