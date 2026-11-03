@echo off
REM Scan2BIM AI server launcher for Windows (NVIDIA GPU)
REM Prereqs: Python 3.10+, NVIDIA driver + CUDA, PyTorch (cu121), Pointcept.
setlocal
cd /d %~dp0

if not exist .venv (
  echo Creating virtual environment...
  python -m venv .venv
)
call .venv\Scripts\activate.bat

echo Installing base requirements...
pip install -r requirements-cpu.txt

echo.
echo If you have not installed the GPU stack yet, run:
echo   pip install torch==2.3.1 --index-url https://download.pytorch.org/whl/cu121
echo   pip install -r requirements-gpu.txt
echo   pip install git+https://github.com/Pointcept/Pointcept.git
echo   python download_models.py
echo.

set PORT=8765
echo Starting Scan2BIM AI server on http://0.0.0.0:8765 ...
python -m uvicorn server:app --host 0.0.0.0 --port 8765
