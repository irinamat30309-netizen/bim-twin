@echo off
setlocal enabledelayedexpansion
title BIM-Twin AI GPU setup
cd /d "%~dp0scan2bim-ai-server"
set "SRV=%~dp0scan2bim-ai-server"
set "VPY=%SRV%\.venv\Scripts\python.exe"
set "MARK=%SRV%\.gpusetup.done"
set "LOCK=%SRV%\.gpu-installing"

echo ============================================================
echo   BIM-Twin - avtomaticheskaya ustanovka GPU + neyroset (v1202)
echo   Stavit: PyTorch CUDA 12.8, GPU-ops, FastAPI/uvicorn, geometriyu.
echo   Nichego delat rukami ne nado. Okno mozhno svernut.
echo   Bolshaya zagruzka (~2.5 GB) - mozhet zanyat neskolko minut.
echo ============================================================
echo.

if not exist "%SRV%\server.py" (
  echo [ERROR] Server folder not found: "%SRV%"
  goto :end
)

REM Uzhe ustanovleno i CUDA rabotaet? Togda vyhodim srazu.
if exist "%MARK%" if exist "%VPY%" (
  "%VPY%" -c "import torch,sys;sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>&1
  if not errorlevel 1 (
    echo [OK] GPU uzhe ustanovlen i rabotaet - nichego delat ne nado.
    goto :end
  )
)

echo installing> "%LOCK%"

echo ==== [1/7] Poisk Python 3.10-3.12 ====
set "PYEXE="
for %%V in (3.12 3.11 3.10) do (
  if not defined PYEXE (
    py -%%V -c "import sys" >nul 2>&1 && set "PYEXE=py -%%V"
  )
)
if not defined PYEXE (
  python -c "import sys;exit(0 if (3,10)<=sys.version_info[:2]<=(3,12) else 1)" >nul 2>&1 && set "PYEXE=python"
)
if not defined PYEXE (
  echo [INFO] Sovmestimyy Python ne nayden - stavlyu Python 3.11 cherez winget...
  winget install -e --id Python.Python.3.11 --accept-package-agreements --accept-source-agreements --silent
  py -3.11 -c "import sys" >nul 2>&1 && set "PYEXE=py -3.11"
)
if not defined PYEXE (
  echo [ERROR] Nuzhen Python 3.10-3.12. Skachayte: https://www.python.org/downloads/release/python-3119/
  echo         Pri ustanovke vklyuchite "Add Python to PATH" i zapustite etot fayl snova.
  goto :end
)
echo [OK] Python: !PYEXE!
!PYEXE! --version

echo.
echo ==== [2/7] Videokarta NVIDIA ====
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>nul
if errorlevel 1 echo [WARN] nvidia-smi ne nayden - nuzhen drayver NVIDIA: https://www.nvidia.com/Download/index.aspx

echo.
echo ==== [3/7] Virtualnoe okruzhenie .venv ====
if exist "%VPY%" (
  "%VPY%" -c "import sys;sys.exit(0 if (3,10)<=sys.version_info[:2]<=(3,12) else 1)" >nul 2>&1
  if errorlevel 1 (
    echo [INFO] Staroe .venv nesovmestimo - peresozdayu...
    rmdir /s /q "%SRV%\.venv"
    del /q "%MARK%" >nul 2>&1
  )
)
if not exist "%VPY%" (
  echo [SETUP] Sozdayu .venv...
  !PYEXE! -m venv "%SRV%\.venv"
)
if not exist "%VPY%" (
  echo [ERROR] Ne udalos sozdat .venv. Smotrite soobshcheniya vyshe.
  goto :end
)
"%VPY%" -m pip install --upgrade pip setuptools wheel

echo.
echo ==== [4/7] Web-stack + geometriya (srazu vklyuchaet polnyy server) ====
"%VPY%" -m pip install fastapi "uvicorn[standard]" python-multipart
"%VPY%" -m pip install scipy scikit-image shapely
echo [INFO] Server-stack gotov. Prilozhenie samo perekluchitsya na nego (do ~15 sek).

echo.
echo ==== [5/7] PyTorch CUDA 12.8 (RTX 50xx / Blackwell) - bolshaya zagruzka ====
"%VPY%" -m pip install --upgrade torch torchvision --index-url https://download.pytorch.org/whl/cu128
if errorlevel 1 echo [WARN] torch ne ustanovilsya s pervoy popytki - proverte internet.

echo.
echo ==== [6/7] GPU-ops i neyroset PTv3 (spconv, timm, addict) ====
REM PointTransformerV3 vstroen v prilozhenie (app\ptv3) - polnyy paket Pointcept ne nuzhen.
REM Nuzhny tolko: spconv, torch-scatter, timm, addict (+ geometriya).
"%VPY%" -m pip install spconv-cu126 addict timm einops h5py ifcopenshell pyransac3d open3d trimesh
if errorlevel 1 echo [WARN] chast GPU-paketov ne ustanovilas - GPU-geometriya vsyo ravno budet rabotat.
REM torch-scatter OPTSIONALEN: PTv3 rabotaet i bez nego (vstroennaya zamena segment_csr).
REM Stavim TOLKO gotovyy wheel pod tvoyu versiyu torch (bez sborki iz ishodnika - imenno ona ranshe padala nvcc/torch).
set "TVER="
for /f "usebackq delims=" %%v in (`"%VPY%" -c "import torch;print(torch.__version__)" 2^>nul`) do set "TVER=%%v"
if defined TVER (
  echo [INFO] torch = %TVER% - probuyu gotovyy wheel torch-scatter (neobyazatelno)...
  "%VPY%" -m pip install torch-scatter --only-binary=:all: -f https://data.pyg.org/whl/torch-%TVER%.html
  if errorlevel 1 echo [INFO] Gotovogo wheel torch-scatter net - ne strashno, PTv3 rabotaet so vstroennoy zamenoy.
) else (
  echo [INFO] Propuskayu torch-scatter - PTv3 rabotaet so vstroennoy zamenoy.
)

echo.
echo ==== [7/7] Vesa neyroseti PTv3 S3DIS ppt-extreme (75.4%% mIoU) ====
if exist "%SRV%\models\ptv3_s3dis.pth" (
  echo [OK] Vesa uzhe na meste: models\ptv3_s3dis.pth
) else (
  if not defined S2B_CKPT_URL if exist "%SRV%\models\ckpt-url.txt" (
    for /f "usebackq delims=" %%u in ("%SRV%\models\ckpt-url.txt") do set "S2B_CKPT_URL=%%u"
  )
  echo [INFO] Skachivayu vesa i config PTv3 S3DIS ppt-extreme s HuggingFace...
  "%VPY%" download_models.py
  if errorlevel 1 (
    echo [WARN] Vesa ne skachalis avtomaticheski - neyroset poka vyklyuchena.
    echo        GPU-geometriya rabotaet polnostyu. Chtoby vklyuchit neyroset, sdelayte odno iz:
    echo          1^) polozhite fayl ptv3_s3dis.pth v papku: "%SRV%\models\"
    echo          2^) ILI sozdayte fayl "%SRV%\models\ckpt-url.txt" s pryamoy ssylkoy i zapustite snova.
  )
)

echo.
echo ==== Proverka CUDA ====
"%VPY%" -c "import torch;print('CUDA:',torch.cuda.is_available());print('GPU:',torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no')" 2>nul
"%VPY%" -c "import torch,sys;sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>&1
if errorlevel 1 (
  echo [WARN] CUDA = False. Prilozhenie rabotaet 1:1, no bez GPU.
  echo        Prichina: staryy drayver NVIDIA ili nesovmestimaya sborka torch.
  echo        Marker ne stavlyu - pri sleduyushchem zapuske poprobuyu snova.
) else (
  echo done> "%MARK%"
  echo [OK] GPU aktiven. Prilozhenie avtomaticheski perekluchitsya na GPU-server.
)

:end
del /q "%LOCK%" >nul 2>&1
echo.
echo ------------------------------------------------------------
echo Gotovo. Mozhno zakryt eto okno. Esli byli oshibki - prishlite ves tekst.
echo ------------------------------------------------------------
pause
endlocal
