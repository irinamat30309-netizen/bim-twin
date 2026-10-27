@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
REM ============================================================
REM  Scan2BIM AI - УСТАНОВКА GPU В ОДИН КЛИК (Windows + NVIDIA)
REM  САМ найдёт Python 3.10-3.12, поставит PyTorch (CUDA 12.8 — новые GPU RTX 50xx),
REM  Pointcept/PointTransformerV3 (без git, из zip), скачает веса и запустит сервер.
REM  Маркер done ставится ТОЛЬКО когда CUDA реально работает.
REM ============================================================

echo.
echo ==== [1/8] Поиск совместимого Python 3.10-3.12 ====
set "PYEXE="
call :trypy "py -3.12"
call :trypy "py -3.11"
call :trypy "py -3.10"
call :trypy "python"
call :trypy "python3"
if defined PYEXE goto :havepy

echo [ВНИМАНИЕ] Совместимый Python не найден (возможно, у вас 3.14 — для него нет PyTorch).
echo Пробую автоматически установить Python 3.11 через winget...
winget install -e --id Python.Python.3.11 --accept-package-agreements --accept-source-agreements --silent
call :trypy "py -3.11"
if defined PYEXE goto :havepy

echo.
echo [ОШИБКА] Нужен Python 3.10, 3.11 или 3.12.
echo Скачайте Python 3.11: https://www.python.org/downloads/release/python-3119/
echo При установке включите галочку "Add Python to PATH", затем запустите этот файл снова.
pause
exit /b 1

:havepy
echo Использую интерпретатор: %PYEXE%
%PYEXE% --version

echo.
echo ==== [2/8] Проверка видеокарты NVIDIA ====
nvidia-smi >nul 2>&1
if errorlevel 1 echo [ВНИМАНИЕ] nvidia-smi не найден — нужен драйвер NVIDIA: https://www.nvidia.com/Download/index.aspx
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>nul

echo.
echo ==== [3/8] Виртуальное окружение (.venv) ====
if not exist .venv goto :mkvenv
.venv\Scripts\python.exe -c "import sys;sys.exit(0 if (3,10)<=sys.version_info[:2]<=(3,12) else 1)" >nul 2>&1
if not errorlevel 1 goto :venvok
echo [ИНФО] Старое окружение .venv несовместимо — пересоздаю...
rmdir /s /q .venv
del /q .gpusetup.done >nul 2>&1
:mkvenv
%PYEXE% -m venv .venv
:venvok
call .venv\Scripts\activate.bat

REM Маркер есть и CUDA работает — сразу старт. Иначе (старый/ложный маркер) — переустановка.
if not exist .gpusetup.done goto :doinstall
python -c "import torch,sys;sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>&1
if not errorlevel 1 goto :startserver
echo [ИНФО] GPU ещё не активен (CUDA=False) — переустанавливаю GPU-стек...
del /q .gpusetup.done >nul 2>&1

:doinstall
python -m pip install --upgrade pip setuptools wheel

echo.
echo ==== [4/8] Базовые зависимости (FastAPI/uvicorn) ====
pip install -r requirements-cpu.txt
if errorlevel 1 goto :fail

echo.
echo ==== [5/8] PyTorch с CUDA 12.8 (для RTX 50xx / Blackwell; может занять несколько минут) ====
pip install --upgrade torch torchvision --index-url https://download.pytorch.org/whl/cu128
if errorlevel 1 goto :fail

REM Узнаём точную версию torch для torch-scatter.
set "TVER="
for /f "delims=" %%i in ('python -c "import torch;print(torch.__version__.split('+')[0])" 2^>nul') do set "TVER=%%i"
echo Установлен torch: %TVER%

echo.
echo ==== [6/8] GPU-операции (spconv, torch-scatter, timm и др.) ====
if defined TVER pip install torch-scatter -f https://data.pyg.org/whl/torch-%TVER%+cu128.html
if not defined TVER pip install torch-scatter
if errorlevel 1 echo [ПРЕДУПРЕЖДЕНИЕ] torch-scatter не установился автоматически — см. README.
pip install spconv-cu126 addict timm h5py ifcopenshell
if errorlevel 1 echo [ПРЕДУПРЕЖДЕНИЕ] часть GPU-пакетов не установилась — см. README.

echo.
echo ==== [7/8] Pointcept (опционально — только для нейро-подписи классов) ====
echo [ИНФО] Геометрия (стены, трубы, балки, оборудование) работает БЕЗ этого шага, как в FARO.
pip install pointcept >nul 2>&1
if not errorlevel 1 goto :weights
pip install https://github.com/Pointcept/Pointcept/archive/refs/heads/main.zip >nul 2>&1
if not errorlevel 1 goto :weights
echo [ИНФО] Pointcept не ставится через pip — это нормально (это фреймворк, а не пакет).
echo         Нейро-подпись классов недоступна; геометрический режим (как в FARO) работает полностью.
echo         Нужна нейросеть? См. README: нужны Pointcept + компиляция CUDA-ops + файл весов.

echo.
echo ==== [7b/8] Cloud2BIM + Mask3D (полный конвейер 1:1) ====
if not exist external mkdir external
where git >nul 2>&1
if errorlevel 1 goto :nogitclone
if not exist external\Cloud2BIM git clone --depth 1 https://github.com/VaclavNezerka/Cloud2BIM external\Cloud2BIM
if not exist external\Mask3D git clone --depth 1 https://github.com/JonasSchult/Mask3D external\Mask3D
goto :extradeps
:nogitclone
echo [ИНФО] git не найден — качаю Cloud2BIM/Mask3D архивами...
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing 'https://github.com/VaclavNezerka/Cloud2BIM/archive/refs/heads/main.zip' -OutFile external\c2b.zip; Expand-Archive -Force external\c2b.zip external}catch{}"
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing 'https://github.com/JonasSchult/Mask3D/archive/refs/heads/main.zip' -OutFile external\m3d.zip; Expand-Archive -Force external\m3d.zip external}catch{}"
:extradeps
echo [ИНФО] Доп. зависимости геометрии (shapely, scikit-image, ifcopenshell, pyransac3d, open3d)...
pip install shapely scikit-image ifcopenshell pyransac3d open3d trimesh
if exist external\Cloud2BIM\requirements.txt pip install -r external\Cloud2BIM\requirements.txt
if errorlevel 1 echo [ПРЕДУПРЕЖДЕНИЕ] часть зависимостей Cloud2BIM не установилась — см. README.
echo [ИНФО] Mask3D склонирован в external\Mask3D (опциональный уточнитель объектов; настройка — см. README).

:weights
echo.
echo ==== [8/8] Веса модели (PointTransformerV3 S3DIS) ====
if defined S2B_CKPT_URL goto :dlweights
if exist models\ptv3_s3dis.pth goto :weightsok
echo [ВНИМАНИЕ] Файл весов не найден.
echo Скачайте PointTransformerV3 S3DIS из Pointcept model zoo:
echo   https://github.com/Pointcept/Pointcept#model-zoo
echo и положите .pth в папку: %~dp0models\ptv3_s3dis.pth
echo Либо задайте:  set S2B_CKPT_URL=https://... и запустите снова.
goto :verify
:dlweights
python download_models.py
goto :verify
:weightsok
echo Веса уже на месте: models\ptv3_s3dis.pth

:verify
echo.
echo ==== Проверка CUDA в PyTorch ====
python -c "import torch;print('CUDA:',torch.cuda.is_available());print('GPU:',torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no')" 2>nul
python -c "import torch,sys;sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>&1
if errorlevel 1 goto :nocuda
REM Отметка: установка успешна и CUDA работает (второй запуск её пропустит).
echo done> .gpusetup.done
echo [OK] GPU активен.
goto :startserver
:nocuda
echo [ВНИМАНИЕ] torch.cuda.is_available() = False.
echo Причины: несовместимая сборка torch с вашей видеокартой либо старый драйвер NVIDIA.
echo Приложение продолжит работать 1:1 офлайн (стены+трубы). Маркер не ставлю — при след. запуске попробую снова.

:startserver
echo.
echo ============================================================
echo Запускаю сервер Scan2BIM AI на http://127.0.0.1:8765 ...
echo (Оставьте это окно открытым. В приложении выберите режим "ai" или "auto".)
echo ============================================================
set PORT=8765
python -m uvicorn server:app --host 0.0.0.0 --port 8765
goto :end

:fail
echo.
echo [ОШИБКА] Установка прервана. Прочтите сообщения выше и README.md.
pause
exit /b 1

REM ---------- подпрограмма: проверка интерпретатора 3.10-3.12 ----------
:trypy
if defined PYEXE goto :eof
%~1 -c "import sys;sys.exit(0 if (3,10)<=sys.version_info[:2]<=(3,12) else 1)" >nul 2>&1
if not errorlevel 1 set "PYEXE=%~1"
goto :eof

:end
endlocal
