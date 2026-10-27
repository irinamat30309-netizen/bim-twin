# Scan2BIM AI Server (GPU, глубокое обучение)

## ⏩ УСТАНОВКА В ОДИН КЛИК (Windows + NVIDIA)

Дважды кликните **`install_gpu_windows.bat`** — он сам создаст `.venv`,
поставит PyTorch (CUDA 12.1), torch-scatter, spconv, Pointcept +
PointTransformerV3, скачает веса модели и запустит сервер на
`http://127.0.0.1:8765`. После этого в приложении выберите режим **"ai"**.

Требования: Python 3.10-3.11 (с галочкой "Add to PATH"), драйвер NVIDIA,
git (для Pointcept). Если веса не скачались автоматически — см. раздел о весах ниже.

Сервер, который превращает облако точек (`.ply`) в BIM-модель (IFC/OBJ)
с помощью **нейросети** на вашем **NVIDIA GPU**.

BIM-Twin отправляет облако на этот сервер → сеть PointTransformerV3
(semantic segmentation, S3DIS) классифицирует каждую точку
(стена / пол / потолок / колонна / балка / окно / дверь / мебель / прочее),
сервер строит стены, плиты, трубы, объекты и возвращает IFC.

> Почему отдельный сервер? Нейросеть CUDA требует GPU и весов на несколько ГБ
> и не может работать внутри оффлайн Electron/JS-приложения. Сервер работает на
> вашем GPU-ПК, а приложение общается с ним по HTTP.

---

## Что где работает

| Компонент | Где | GPU |
|---|---|---|
| Приложение BIM-Twin (вьюер, UI) | обычный ПК | нет |
| **ИИ-движок** (этот сервер) | ваш NVIDIA ПК | **да** |
| Геометрический fallback (встроен) | любой CPU | нет |

Если GPU/модель не готовы, сервер автоматически переключается на
детерминированный **геометрический движок** (чистый NumPy) — IFC вы получите всегда.

---

## Быстрый старт (Windows + NVIDIA)

1. Установите **Python 3.10+** и свежий **драйвер NVIDIA**.
2. Запустите **`run_windows.bat`** (создаёт venv, ставит базовые зависимости, запускает сервер).
3. Установите GPU-стек (один раз):
   ```bat
   .venv\Scripts\activate
   pip install torch==2.3.1 --index-url https://download.pytorch.org/whl/cu121
   pip install -r requirements-gpu.txt
   pip install git+https://github.com/Pointcept/Pointcept.git
   ```
4. Скачайте веса **PointTransformerV3 S3DIS** из model zoo Pointcept
   (<https://github.com/Pointcept/Pointcept#model-zoo>) и положите в `models/ptv3_s3dis.pth`.
5. Запуск: `python -m uvicorn server:app --host 0.0.0.0 --port 8765`
6. Проверка: <http://localhost:8765/health> — `gpu` и `engine_ready` должны быть `true`.

## Быстрый старт (Docker + NVIDIA Container Toolkit)

```bash
docker build -t scan2bim-ai .
docker run --gpus all -p 8765:8765 -v $PWD/models:/app/models scan2bim-ai
```

---

## Подключение BIM-Twin к серверу

В приложении: кнопка **🤖 BIM (AI)** → введите URL сервера
`http://localhost:8765` (или IP вашего GPU-ПК в локальной сети,
например `http://192.168.1.50:8765`). Откройте облако и нажмите
**Построить BIM (AI)** — облако уйдёт на сервер, вернётся IFC.
URL хранится в `localStorage['s2bAiServerUrl']`.

---

## API

### `GET /health`
```json
{ "status": "ok", "gpu": true, "checkpoint": true, "engine_ready": true }
```

### `POST /reconstruct` (multipart)
- `file`: облако `.ply`
- `mode`: `auto` (по умолч.) | `ai` | `geom`
- `name`: имя модели

Возвращает JSON: `stats`, `height`, `floor_area`, `model` (walls/slabs/pipes/objects)
и base64 `ifc_base64` / `obj_base64`.

### `POST /reconstruct/ifc`
Тот же вход, возвращает файл `.ifc` напрямую.

---

## Конвейер

1. Загрузка и прореживание облака (voxel grid).
2. **Semantic segmentation** (PointTransformerV3, GPU) → класс каждой точки (S3DIS).
3. **Стены** из точек `wall` (сетка плотности + RANSAC-линии + толщина).
4. **Плиты** из точек `floor` / `ceiling`.
5. **Трубы** — RANSAC-цилиндры у потолка.
6. **Объекты** (колонны, балки, оборудование, мебель) — воксельная кластеризация.
7. **Экспорт IFC4** (встроенный писатель или IfcOpenShell).

## Продвинуто: instance segmentation

Для разделения каждого объекта (труба/колонна/дверь отдельно) можно
подключить **Mask3D** через `dl.segment_instances()`. По умолчанию
используется semantic segmentation + кластеризация (надёжнее в настройке).

## О точности

- Классы S3DIS покрывают стены/пол/потолок/колонны/балки/окна/двери/мебель.
  Трубы/MEP не входят в S3DIS — они восстанавливаются геометрически (RANSAC).
- Давайте облака в метрах. Сервер сам определяет вертикальную ось.
- Буквальный «1в1» двойник физически невозможен из поверхностного скана
  (нет данных за поверхностями); получается чистая параметрическая BIM-аппроксимация.
