/* BIM Twin — реестр команд интерфейса.
 * Единственный источник правды для ленты (вкладки → группы → команды), палитры команд и тестов.
 * Формат команды:
 *   id      — уникальный идентификатор (для «усыновляемых» кнопок совпадает с id элемента);
 *   ico     — имя иконки Lucide из renderer/icons.js;
 *   label   — подпись (null = взять текст элемента, чтобы работал i18n);
 *   size    — 'lg' (иконка над подписью) | 'sm' (иконка слева от подписи), по умолчанию 'lg';
 *   sel     — CSS-селектор существующего элемента: он переносится в ленту вместе со слушателями;
 *   call    — путь к глобальной функции («__lxSmartSave.save»), args — аргументы; вызывается при клике;
 *   slot    — элемент создаёт другой модуль и вставляет через __lxRibbon.mount(id, el);
 *   needs   — 'cloud': команда неактивна, пока не загружено облако точек;
 *   tip     — подсказка (для «усыновляемых» без tip берётся title элемента); keys — горячая клавиша.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__lxCommands = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function I(id, ico, label, o) {
    var r = { id: id, ico: ico, label: label, size: 'lg' };
    if (o) for (var k in o) r[k] = o[k];
    return r;
  }
  function S(id, ico, label, o) { var r = I(id, ico, label, o); r.size = 'sm'; return r; }
  function G(id, label, items) { return { id: id, label: label, items: items }; }

  var OPS_T = '__lxToolsExt.ops.', OPS_S = '__lxSprintsExt.ops.', OPS_D = '__lxDrawExt.ops.';

  var TABS = [
    { id: 'project', label: 'Проект', groups: [
      G('file', 'Файл', [
        I('save', 'save', 'Сохранить', { primary: 1, call: '__lxSmartSave.save', args: [{}], keys: 'Ctrl S', tip: 'Сохранить облако и состояние проекта' }),
        S('saveAs', 'save-all', 'Сохранить как', { call: '__lxSmartSave.save', args: [{ askPath: true }], tip: 'Сохранить копию в выбранный файл' }),
        S('autosave', 'timer', 'Автосохранение', { special: 'autosave', tip: 'Клик переключает интервал: выкл → 1 → 2 → 5 → 10 мин' })
      ]),
      G('history', 'История', [
        S('btnProjectUndo', 'undo-2', 'Отменить', { sel: '#btnProjectUndo', tip: 'Отменить последнее сохранённое изменение проекта' }),
        S('btnProjectRedo', 'redo-2', 'Повторить', { sel: '#btnProjectRedo', tip: 'Повторить отменённое изменение проекта' }),
        S('drafts', 'history', 'Черновики', { call: '__lxSmartSave.openAutosaveHistory', tip: 'Версии автосохранения: просмотр и восстановление' })
      ]),
      G('proj', 'Проект', [
        I('btnNewProject', 'folder-plus', 'Новый проект', { sel: '#btnNewProject' }),
        I('btnBackup', 'database-backup', null, { sel: '#btnBackup' }),
        I('btnSettings', 'settings', null, { sel: '#btnSettings' })
      ]),
      G('team', 'Команда', [
        I('btnUsers', 'users', null, { sel: '#btnUsers' }),
        I('btnSync', 'refresh-cw', null, { sel: '#btnSync' })
      ])
    ] },

    { id: 'import', label: 'Импорт', groups: [
      G('clouds', 'Облака точек', [
        I('btnOpenCloud', 'folder-open', 'Открыть облако', { sel: '#btnOpenCloud', primary: 1, tip: 'Облако помещения или файл LAS / LAZ / E57 / PLY' }),
        I('vtStream', 'hard-drive-download', 'Потоковый LOD', { sel: '#vtStream', tip: 'Большие облака: дисковый octree и уровни детализации (LAS 0–10, PLY, PCD). Индекс до 40 млн точек' }),
        I('opPotree', 'cloud-download', 'Potree 2.0', { call: OPS_S + 'opPotree', tip: 'Открыть набор Potree 2.0 (metadata.json + octree)' })
      ]),
      G('models', 'Модели и документы', [
        I('modelInput', 'box', null, { sel: 'label[for="modelInput"]', tip: 'GLB, GLTF, OBJ, STL, PLY, LAS, E57, PTX, PCD, XYZ' }),
        I('ifcInput', 'building-2', null, { sel: 'label[for="ifcInput"]', tip: 'Импорт BIM-модели IFC' }),
        I('docInput', 'file-text', null, { sel: 'label[for="docInput"]', tip: 'PDF, DOCX, XLSX, DXF, DWG, изображения' })
      ])
    ] },

    { id: 'cloud', label: 'Облако', groups: [
      G('display', 'Отображение', [
        I('vtQuality', 'palette', 'Вид облака', { sel: '#vtQuality', needs: 'cloud', tip: 'Цвет, яркость, размер точки, EDL и фотореализм' })
      ]),
      G('clean', 'Очистка', [
        I('vtTools', 'brush-cleaning', 'Чистка', { sel: '#vtTools', menu: 1, needs: 'cloud', tip: 'Убрать шум, выбросы и «лучи», выделить мусор' }),
        I('vtEdit', 'lasso-select', 'Правка облака', { sel: '#vtEdit', needs: 'cloud', tip: 'Выделение лассо или рамкой и удаление точек' }),
        I('vtClean', 'sparkles', 'Очистить (Open3D)', { sel: '#vtClean', needs: 'cloud', tip: 'Шум, выбросы, «лучи»: Open3D, а без него быстрый NumPy-фильтр' })
      ]),
      G('process', 'Обработка', [
        I('opResample', 'grid-3x3', 'Ресэмплинг', { call: OPS_T + 'opResample', needs: 'cloud', tip: 'Понизить плотность облака (воксельная сетка)' }),
        I('opSmooth', 'waves', 'Сглаживание', { call: OPS_T + 'opSmooth', needs: 'cloud', tip: 'Сглаживание MLS: проекция на локальную плоскость' }),
        I('opFloor', 'arrow-down-to-line', 'Выровнять пол', { call: OPS_T + 'opLevel', args: ['floor', [0, 1, 0], 'Выравнивание'], needs: 'cloud', tip: 'Повернуть облако так, чтобы доминантная плоскость пола стала горизонтальной' }),
        I('opWall', 'move-vertical', 'Выровнять стену', { call: OPS_T + 'opVertical', needs: 'cloud', tip: 'Сделать выбранную стену вертикальной' }),
        I('opMerge', 'merge', 'Объединить', { call: OPS_T + 'opMerge', needs: 'cloud', tip: 'Объединить с другим облаком в одно' }),
        I('opOverlay', 'layers-2', 'Наложение', { call: OPS_T + 'opOverlay', needs: 'cloud', tip: 'Наложить второе облако поверх текущего' })
      ]),
      G('convert', 'Конвертация и геометрия', [
        I('vtConvert', 'repeat', 'Конвертация', { sel: '#vtConvert', tip: 'Окно конвертации: LAS/LAZ/E57 → PLY прямо с диска, облако → 3DGS, PLY → 3DGS' }),
        I('vtGeom', 'triangle', 'Геометрия', { sel: '#vtGeom', menu: 1, needs: 'cloud', tip: 'Отклонения скан ↔ модель, ICP-совмещение, поверхность, PDAL' })
      ]),
      G('terrain', 'Рельеф и грунт', [
        I('opDSM', 'mountain', 'DSM → GeoTIFF', { call: OPS_S + 'opDSM', needs: 'cloud', tip: 'Модель поверхности по максимуму высот' }),
        I('opDTM', 'mountain-snow', 'DTM → GeoTIFF', { call: OPS_S + 'opDTM', needs: 'cloud', tip: 'Модель рельефа только по грунту (PMF)' }),
        I('opContours', 'contour', 'Горизонтали', { call: OPS_S + 'opContours', needs: 'cloud', tip: 'Горизонтали рельефа в DXF' }),
        I('opGround', 'layers', 'Грунт PMF', { call: OPS_S + 'opGround', needs: 'cloud', tip: 'Прогрессивный морфологический фильтр: класс «грунт»' }),
        I('opGroundLAS', 'file-output', 'Классы → LAS', { call: OPS_S + 'opGroundLAS', needs: 'cloud', tip: 'LAS 1.4 с классами ASPRS: 2 — грунт, 1 — прочее' })
      ]),
      G('georef', 'Геопривязка', [
        I('opGeoref', 'map-pin', 'Геопривязка', { call: OPS_S + 'opGeoref', needs: 'cloud', tip: 'Привязка по опорным точкам GCP (Гельмерт 3D)' }),
        I('opGcpTemplate', 'file-spreadsheet', 'Шаблон GCP', { call: OPS_S + 'opGcpTemplate', tip: 'Скачать шаблон таблицы GCP (CSV)' })
      ]),
      G('perf', 'Производительность', [
        I('vtMem', 'gauge', 'Макс. память', { sel: '#vtMem', tip: 'Профиль «максимум памяти и качества»: предзагрузка облаков, больший кэш octree' })
      ])
    ] },

    { id: 'floors', label: 'Этажи', groups: [
      G('floors', 'Этажи', [
        I('floorAdd', 'layers', 'Этаж', { call: '__lxScene.addFloor', tip: 'Создать этаж по диапазону высот' }),
        I('floorIsolate', 'focus', 'Изолировать', { call: '__lxScene.isolateActive', tip: 'Показать только выбранный этаж' }),
        I('floorSlice', 'slice', 'Нарезка', { call: '__lxScene.autoSlice', needs: 'cloud', tip: 'Автонарезка облака на этажи по высоте' })
      ]),
      G('docs', 'Документация', [
        I('floorAttach', 'paperclip', 'Прикрепить', { call: '__lxScene.attachDoc', tip: 'Прикрепить документ к выбранному этажу' }),
        I('floorReport', 'clipboard-list', 'Отчёт', { call: '__lxScene.report', tip: 'Отчёт по этажу копируется в буфер обмена' })
      ]),
      G('room', 'Структура проекта', [
        I('btnBackRoom', 'arrow-left', null, { sel: '#btnBackRoom' }),
        I('btnEdit', 'square-pen', null, { sel: '#btnEdit', toggle: 1, tip: 'Режим правки дерева: добавление, переименование и удаление этажей и помещений' })
      ])
    ] },

    { id: 'measure', label: 'Измерения', groups: [
      G('mode', 'Режим', [
        I('btnMeasure', 'ruler-dimension-line', null, { sel: '#btnMeasure', toggle: 1, primary: 1, keys: 'Esc — выход' })
      ]),
      G('geo', 'Замеры', [
        I('mmDistance', 'ruler', 'Расстояние', { sel: '#mmDistance', toggle: 1 }),
        I('mmPoint', 'crosshair', 'Точка', { sel: '#mmPoint', toggle: 1 }),
        I('mmPolyline', 'polyline', 'Полилиния', { sel: '#mmPolyline', toggle: 1 }),
        I('mmAngle', 'angle', 'Угол', { sel: '#mmAngle', toggle: 1 }),
        I('mmArea', 'vector-square', 'Площадь', { sel: '#mmArea', toggle: 1 })
      ]),
      G('plane', 'Плоскости', [
        I('mmPlane', 'brick-wall', 'Плоскость', { sel: '#mmPlane', toggle: 1 }),
        I('mmDeviation', 'arrow-up-down', 'Зазор', { sel: '#mmDeviation', toggle: 1 }),
        I('mmCorner', 'cuboid', 'Ребро / угол', { sel: '#mmCorner', toggle: 1 })
      ]),
      G('snap', 'Привязка', [
        I('mmSnap', 'magnet', 'Привязка', { sel: '#mmSnap', toggle: 1 })
      ]),
      G('results', 'Результаты', [
        I('mmList', 'list', 'Список', { sel: '#mmList', toggle: 1, badge: '#mmListCount' }),
        S('mmCsv', 'file-down', 'CSV', { sel: '#mmCsv' }),
        S('mmQaReport', 'file-json', 'QA JSON', { sel: '#mmQaReport' }),
        S('mmNotion', 'notebook-text', 'Notion', { sel: '#mmNotion' })
      ]),
      G('verify', 'Сверка', [
        I('vfOpen', 'clipboard-check', 'Сверка с докум.', { call: '__lxVerify.open', args: [{}], tip: 'Сравнить измерения с требованиями из документов помещения: значения, допуски, отклонения' })
      ]),
      G('object', 'Объект', [
        I('lxObjInspectBtn', 'scan-search', 'Измерить объект', { sel: '#lxObjInspectBtn', toggle: 1, tip: 'Обведите объект на облаке: откроется окно инспектора с расстоянием, углом и площадью' })
      ])
    ] },

    { id: 'draw', label: 'Чертёж', groups: [
      G('shapes', 'Фигуры', [
        I('draw.pline', 'polyline', 'Полилиния', { slot: 1, toggle: 1, primary: 1 }),
        I('draw.line', 'slash', 'Линия', { slot: 1, toggle: 1 }),
        I('draw.rect', 'square', 'Прямоуг.', { slot: 1, toggle: 1 }),
        I('draw.circle', 'circle', 'Окружность', { slot: 1, toggle: 1 }),
        I('draw.arc', 'arc', 'Дуга', { call: OPS_D + 'doArc', tip: 'Дуга по трём точкам черновика или полилинии' }),
        I('draw.point', 'circle-dot', 'Точка', { slot: 1, toggle: 1 })
      ]),
      G('annot', 'Аннотации', [
        I('draw.dim', 'ruler-dimension-line', 'Размер', { slot: 1, toggle: 1 }),
        I('draw.text', 'type', 'Текст', { call: OPS_D + 'doText', tip: 'Текстовая аннотация' }),
        I('draw.door', 'door-open', 'Дверь', { call: OPS_D + 'doDoor', tip: 'Символ двери на последней линии' }),
        I('draw.window', 'app-window', 'Окно', { call: OPS_D + 'doWindow', tip: 'Символ окна на последней линии' })
      ]),
      G('edit', 'Правка', [
        S('draw.extend', 'arrow-right-to-line', 'Расширить', { call: OPS_D + 'doExtend', tip: 'Продлить линию до пересечения' }),
        S('draw.split', 'split', 'Разделить', { call: OPS_D + 'doSplit', tip: 'Разделить полилинию пополам' }),
        S('draw.intersect', 'x', 'Пересечение', { call: OPS_D + 'doIntersect', tip: 'Точка пересечения двух линий' }),
        S('draw.copy', 'copy', 'Копия', { call: OPS_D + 'doCopy', tip: 'Копия последней сущности со смещением' }),
        S('draw.close', 'link-2', 'Замкнуть', { slot: 1 }),
        S('draw.undo', 'undo-2', 'Отмена', { slot: 1 }),
        S('draw.clear', 'eraser', 'Очистить', { slot: 1 })
      ]),
      G('snaps', 'Привязки', [
        S('draw.snap', 'magnet', 'Привязки', { slot: 1, toggle: 1 }),
        S('draw.ortho', 'move-horizontal', 'Орто', { slot: 1, toggle: 1 }),
        S('draw.top', 'layout-panel-top', 'Вид сверху', { slot: 1, toggle: 1 }),
        { id: 'draw.proj', kind: 'select', slot: 1, size: 'lg', label: 'Проекция' }
      ]),
      G('fromcloud', 'Из облака', [
        I('draw.sect', 'scan-line', 'Сечение', { slot: 1, needs: 'cloud' }),
        I('draw.ai', 'wand-sparkles', 'AI-извлечение', { call: OPS_D + 'doAIExtract', needs: 'cloud', tip: 'RANSAC-прямые по сечению облака (слой AI)' }),
        I('opWalls', 'brick-wall', 'Стены → DXF', { call: OPS_S + 'opWalls', needs: 'cloud', tip: 'Детекция стен и план этажа в DXF' })
      ]),
      G('dxf', 'DXF', [
        I('draw.imp', 'file-up', 'Импорт', { slot: 1 }),
        { id: 'draw.frame', kind: 'select', slot: 1, size: 'lg', label: 'Система координат' },
        I('draw.dxf', 'file-down', 'Экспорт', { slot: 1, primary: 1 })
      ])
    ] },

    { id: 'bim', label: 'BIM', groups: [
      G('scan', 'Скан → BIM', [
        I('lxScan2BimBtn', 'building', 'Скан → BIM', { sel: '#lxScan2BimBtn', toggle: 1, tip: 'Распознать стены, проёмы и плиты по облаку' }),
        I('lxScan2BimAiBtn', 'boxes', 'BIM 1:1', { sel: '#lxScan2BimAiBtn', toggle: 1, tip: 'AI-построение BIM-модели 1:1 по облаку' })
      ]),
      G('object', 'Объект', [
        I('lxObjExtractBtn', 'box-select', 'Срез объекта', { sel: '#lxObjExtractBtn', toggle: 1, tip: 'Срез облака, захват объекта и сохранение его отдельной моделью' })
      ])
    ] },

    { id: 'view', label: 'Вид', groups: [
      G('camera', 'Камера', [
        I('btnReset', 'scan-eye', null, { sel: '#btnReset' })
      ]),
      G('std', 'Стандартные виды', [
        I('view.top', 'view-top', 'Сверху', { call: OPS_S + 'opView', args: ['top', 'Сверху'], tip: 'Вид сверху: орто, план' }),
        I('view.front', 'view-front', 'Спереди', { call: OPS_S + 'opView', args: ['front', 'Спереди'], tip: 'Вид спереди: орто, фасад' }),
        I('view.side', 'view-side', 'Сбоку', { call: OPS_S + 'opView', args: ['side', 'Сбоку'], tip: 'Вид сбоку: орто' }),
        I('view.iso', 'view-iso', 'Изометрия', { call: OPS_S + 'opView', args: ['iso', 'Изометрия'], tip: 'Изометрический вид' }),
        I('view.ortho', 'rotate-3d', 'Орто', { call: OPS_S + 'opOrtho', toggle: 1, tip: 'Переключить ортографическую и перспективную проекцию' }),
        I('view.xray', 'view', 'Рентген', { call: OPS_S + 'opXray', toggle: 1, tip: 'Просвечивание облака (X-Ray)' })
      ]),
      G('section', 'Сечение и видимость', [
        I('btnSection', 'square-split-vertical', null, { sel: '#btnSection', toggle: 1 }),
        I('btnIsolate', 'focus', null, { sel: '#btnIsolate', toggle: 1 }),
        I('btnLOD', 'gauge', null, { sel: '#btnLOD', toggle: 1 })
      ])
    ] },

    { id: 'tour', label: '3D-тур', groups: [
      G('scenes', 'Сцены', [
        I('tsSplatTop', 'orbit', '3DGS-тур', { sel: '#tsSplatTop', primary: 1, tip: 'Открыть .ply / .splat: ходьба по сцене, маршрут, экспорт видео с титрами и логотипом' }),
        I('tsSplatLcc2', 'folder-open', 'LCC2', { sel: '#tsSplatLcc2', tip: 'Войдите внутрь lcc2-result и нажмите «Загрузить»' }),
        I('tsMesh', 'hexagon', 'Меш', { sel: '#tsMesh', tip: 'Треугольный меш glTF / GLB / PLY. ЛКМ — осмотр, WASD — ходьба' }),
        I('tsConv3dgs', 'wand-sparkles', 'PLY → 3DGS', { sel: '#tsConv3dgs', tip: 'Превратить LiDAR-облако в 3D Gaussian Splatting' })
      ]),
      G('stations', 'Станции сканера', [
        I('vtTour', 'route', null, { sel: '#vtTour', toggle: 1, tip: 'Экскурсия по станциям сканера: импорт E57 или JSON, расстановка вручную, экспорт' })
      ]),
      G('photo', 'Фото-тур', [
        I('tsPhoto', 'camera', 'Фото-тур', { sel: '#tsPhoto', tip: 'Панорамы 360° со сканера и manifest.json со станциями — как в CoCloud, но офлайн' }),
        I('tsPhotoDemo', 'circle-play', 'Демо', { sel: '#tsPhotoDemo', tip: 'Сгенерированный фото-тур для проверки режима' })
      ])
    ] },

    { id: 'qa', label: 'Контроль', groups: [
      G('ai', 'Нейросеть', [
        I('btnAI', 'sparkles', null, { sel: '#btnAI' }),
        I('btnVerify', 'shield-check', null, { sel: '#btnVerify', primary: 1 })
      ]),
      G('compare', 'Сравнение', [
        I('btnCompare', 'columns-2', null, { sel: '#btnCompare' }),
        I('vfOpenQa', 'clipboard-check', 'Замеры и докум.', { call: '__lxVerify.open', args: [{}], tip: 'Измерения против требований из документов помещения' })
      ]),
      G('calc', 'Расчёты', [
        I('opVolume', 'cylinder', 'Объём', { call: OPS_T + 'opVolume', needs: 'cloud', tip: 'Объём над базовой плоскостью' }),
        I('opCompareVolumes', 'scale', 'Сравн. объёмов', { call: OPS_T + 'opCompareVolumes', needs: 'cloud', tip: 'Выемка и насыпь между двумя поверхностями' }),
        I('opClosedVolume', 'package', 'Закрытый объём', { call: OPS_T + 'opClosedVolume', needs: 'cloud', tip: 'Объём замкнутой области' })
      ])
    ] },

    { id: 'export', label: 'Экспорт', groups: [
      G('report', 'Отчёт', [
        I('btnExport', 'file-output', null, { sel: '#btnExport' })
      ]),
      { id: 'cloudfmt', label: 'Облако точек', dynamic: 'cloud', items: [] },
      G('cloudextra', 'Прочее', [
        I('opRCP', 'file-box', 'LAS → RCP', { call: OPS_T + 'opExportRCP', needs: 'cloud', tip: 'Autodesk ReCap RCP (нужен установленный ReCap)' }),
        I('opMesh', 'shapes', 'Mesh (OBJ)', { call: OPS_T + 'opMesh', needs: 'cloud', tip: 'Построить поверхность и сохранить OBJ' })
      ]),
      { id: 'bimfmt', label: 'BIM-модель', dynamic: 'bim', items: [] },
      G('ifc', 'IFC по облаку', [
        I('opIFC4', 'building-2', 'IFC4 BIM', { call: OPS_S + 'opIFC4', needs: 'cloud', tip: 'Scan→BIM: стены, проёмы, плиты и колонны. MEP и балки автоматически не включаются' }),
        I('opIFC', 'building', 'IFC 2×3', { call: OPS_S + 'opIFC', needs: 'cloud', tip: 'Совместимость IFC2X3: стены и колонны без проёмов и прочих объектов' })
      ])
    ] }
  ];

  var byId = Object.create(null);
  TABS.forEach(function (t) { t.groups.forEach(function (g) { (g.items || []).forEach(function (i) { i.tab = t.id; i.group = g.id; byId[i.id] = i; }); }); });

  /** Плоский список команд для палитры и тестов. */
  function all() {
    var out = [];
    TABS.forEach(function (t) { t.groups.forEach(function (g) { (g.items || []).forEach(function (i) { if (i.kind !== 'select') out.push({ item: i, tab: t, group: g }); }); }); });
    return out;
  }

  /** Форматы экспорта из __lxSmartSave.formats → команды динамических групп. */
  function formatItem(f) {
    return S('fmt.' + f.id, f.kind === 'bim' ? 'building-2' : 'file-down', f.label.replace(/\s*\(.*\)\s*$/, '') || f.id.toUpperCase(),
      { call: '__lxSmartSave.exportAs', args: [f.id], needs: f.kind === 'bim' ? 'bim' : 'cloud', tip: 'Экспорт: ' + f.label, format: f.id });
  }

  /** Простая нечёткая проверка для палитры: все слова запроса должны входить в строку. */
  function match(q, text) {
    q = String(q || '').toLowerCase().trim();
    if (!q) return true;
    text = String(text || '').toLowerCase();
    return q.split(/\s+/).every(function (w) { return text.indexOf(w) !== -1; });
  }

  return { TABS: TABS, byId: byId, all: all, formatItem: formatItem, match: match, I: I, S: S };
});
