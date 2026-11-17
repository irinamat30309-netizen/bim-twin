/*
 * ai-context.js — r169: структурированный контекст приложения для ИИ-ассистента.
 *
 * Зачем: ассистент должен отвечать «как человек, работающий с облаком» — видеть, что открыто,
 * что выделено, какой элемент распознан (auto-measure / ElementIdentify / инспектор),
 * какие измерения и проверки уже есть, открыта ли BIM-модель, что за проект и документы.
 * Модуль только читает состояние приложения (без побочных эффектов) и умеет:
 *   • build(env) → структурированный объект ai-context/1 (все поля честно null/[], если данных нет);
 *   • toPromptBlock(ctx) → компактный текстовый блок «факты сейчас в приложении» для локальной модели;
 *   • compact(ctx) → короткий JSON для передачи в запрос;
 *   • analyzeSelection(env) → классификация выделенных точек через AutoMeasure (fallback — метки классов);
 *   • elementFromAuto / elementFromIdentify / summarizeRes → нормализация результатов классификаторов.
 *
 * UMD: window.AiContext и module.exports (unit-тесты без DOM).
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AiContext = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';
  var VERSION = '169';

  var TYPE_LABEL = {
    wall: 'стена', partition: 'перегородка', floor: 'пол', ceiling: 'потолок', roof: 'крыша',
    column: 'колонна', beam: 'балка', pipe: 'труба', duct: 'воздуховод', tray: 'лоток',
    opening: 'проём', door: 'дверь', window: 'окно', furniture: 'мебель', object: 'объект',
    surface: 'поверхность', room: 'помещение', slab: 'плита', vegetation: 'растительность',
    people: 'люди', clutter: 'шум/предметы', unknown: 'не определён'
  };
  // ASPRS/classify-коды облака → тип элемента (cloud-classify.py: 2 пол, 6 стены/крыша, 5 растительность, 18 люди)
  var CLASS_LABEL = { 1: 'неклассифицировано', 2: 'пол/земля', 3: 'низкая растительность', 4: 'средняя растительность', 5: 'растительность', 6: 'стены/крыша', 7: 'шум', 9: 'вода', 18: 'люди' };
  var CLASS_TYPE = { 2: 'floor', 6: 'wall', 5: 'vegetation', 18: 'people' };

  function safe(fn, def) { try { var v = fn(); return v === undefined ? def : v; } catch (_) { return def; } }
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function round(v, d) { var n = num(v); if (n == null) return null; var k = Math.pow(10, d == null ? 3 : d); return Math.round(n * k) / k; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function basename(p) { return String(p == null ? '' : p).replace(/^.*[\\/]/, ''); }
  function bboxOf(pos, n) {
    if (!pos || !pos.length) return null;
    var mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity, cnt = 0;
    for (var i = 0; i < n; i++) {
      var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (!isFinite(x + y + z)) continue;
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      cnt++;
    }
    return cnt ? { min: [round(mnx), round(mny), round(mnz)], max: [round(mxx), round(mxy), round(mxz)], size: [round(mxx - mnx), round(mxy - mny), round(mxz - mnz)] } : null;
  }
  function viewerOf(env) {
    return safe(function () {
      var t = env && env.__pcTools;
      return (t && t.viewer && t.viewer()) || env.__viewer || env.__lxViewer || null;
    }, null);
  }
  function cloudFrom(env) {
    var t = env && env.__pcTools, v = viewerOf(env), c = null;
    c = safe(function () { return t && t.getCloud ? t.getCloud() : null; }, null);
    if (!c || !c.pos || !c.pos.length) c = safe(function () { var bo = v && v.base && v.base[0]; return bo && bo.pos && bo.pos.length ? { pos: bo.pos, col: bo.col || null, classification: bo.classification || null, count: bo.count || bo.pos.length / 3, sample: true } : null; }, null);
    if (!c || !c.pos || !c.pos.length) return { open: false };
    var rec = safe(function () { return v && v._cloudRecord || null; }, null);
    var count = num(c.count) || (c.pos.length / 3);
    var path = safe(function () { return env.__bimCurrentCloudPath || (env.__bimLastCloudPath && env.__bimLastCloudPath()) || (rec && rec.sourceName) || null; }, null);
    var bbox = safe(function () { return v && v.bbox ? { min: [round(v.bbox.mn[0]), round(v.bbox.mn[1]), round(v.bbox.mn[2])], max: [round(v.bbox.mx[0]), round(v.bbox.mx[1]), round(v.bbox.mx[2])], size: [round(v.bbox.mx[0] - v.bbox.mn[0]), round(v.bbox.mx[1] - v.bbox.mn[1]), round(v.bbox.mx[2] - v.bbox.mn[2])] } : null; }, null);
    return {
      open: true,
      name: basename(path || (rec && rec.sourceName) || 'облако'),
      path: path || null,
      points: round(count, 0),
      sourceCount: rec && num(rec.sourceCount) || null,
      loadedCount: rec && num(rec.loadedCount) || null,
      sample: !!c.sample,
      bbox: bbox,
      crs: safe(function () { return t && t.getSourceCrs ? t.getSourceCrs() : (v && v._srcCrs) || null; }, null),
      colorMode: safe(function () { return v && v._cloudColorMode || null; }, null),
      hasClassification: !!(c.classification && c.classification.length),
      spacing: safe(function () { return round(v && v.base && v.base[0] && v.base[0]._spacing, 4); }, null)
    };
  }
  function selectionOf(env) {
    var v = viewerOf(env);
    if (!v) return { active: false, count: 0 };
    var count = safe(function () { return v.selectionCount ? v.selectionCount() : (v._sel && v._sel.size) || 0; }, 0) || 0;
    if (!count) return { active: false, count: 0 };
    var cloud = cloudFrom(env), pos = null;
    try { pos = (env.__pcTools && env.__pcTools.getCloud && env.__pcTools.getCloud() || {}).pos || (v.base && v.base[0] && v.base[0].pos) || null; } catch (_) { }
    var sel = safe(function () { return v._sel && v._sel.size ? v._sel : null; }, null);
    var out = { active: true, count: round(count, 0), bbox: null, center: null, volume: null, dominantClass: null, basis: 'viewer selection' };
    if (pos && sel && count <= 400000) {
      var step = Math.max(1, Math.floor(sel.size / 40000)), k = 0;
      var ids = [];
      sel.forEach(function (i) { if ((k++ % step) === 0) ids.push(i); });
      var mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity, good = 0;
      for (var a = 0; a < ids.length; a++) {
        var i = ids[a], x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (!isFinite(x + y + z)) continue;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
        good++;
      }
      if (good) {
        out.bbox = { min: [round(mnx), round(mny), round(mnz)], max: [round(mxx), round(mxy), round(mxz)], size: [round(mxx - mnx), round(mxy - mny), round(mxz - mnz)] };
        out.center = [round((mnx + mxx) / 2), round((mny + mxy) / 2), round((mnz + mxz) / 2)];
        out.volume = round((mxx - mnx) * (mxy - mny) * (mxz - mnz), 3);
        out.basis = 'bounding box выделенных точек';
      }
    }
    // доминирующий класс точек (если облако классифицировано)
    var labels = safe(function () { return v._classificationLabels || (env.__pcTools && env.__pcTools.getCloud && env.__pcTools.getCloud() || {}).classification || null; }, null);
    if (labels && sel && labels.length) {
      var hist = {};
      var step2 = Math.max(1, Math.floor(sel.size / 5000)), k2 = 0;
      sel.forEach(function (i) { if ((k2++ % step2) === 0 && labels[i] != null) hist[labels[i]] = (hist[labels[i]] || 0) + 1; });
      var best = -1, bestN = 0;
      Object.keys(hist).forEach(function (key) { if (hist[key] > bestN) { bestN = hist[key]; best = Number(key); } });
      if (best >= 0) out.dominantClass = { code: best, label: CLASS_LABEL[best] || ('класс ' + best), type: CLASS_TYPE[best] || null };
    }
    return out;
  }
  function normDims(list) {
    return arr(list).map(function (d) {
      if (!d || typeof d !== 'object') return null;
      var value = d.value;
      if (value && typeof value === 'object') value = d.text || null;
      var numValue = typeof value === 'number' ? value : num(value);
      var text = d.text ? String(d.text) : (numValue != null ? (round(numValue, 3).toLocaleString('ru-RU', { maximumFractionDigits: 3 })) + (d.unit && d.unit !== 'м' ? ' ' + d.unit : (d.unit === 'м' ? ' м' : '')) : String(value == null ? '' : value));
      return {
        key: String(d.key || d.label || ''),
        label: String(d.label || d.key || 'размер'),
        value: numValue,
        unit: d.unit || '',
        text: text,
        ok: d.ok === true ? true : d.ok === false ? false : undefined
      };
    }).filter(Boolean);
  }
  function elementFromAuto(res) {
    if (!res || res.ok === false) return null;
    var ob = res.main !== undefined ? res.main : (arr(res.objects)[0] || null);
    if (!ob) return null;
    var type = ob.family || ob.role || ob.type || 'object';
    if (TYPE_LABEL[type] === undefined && TYPE_LABEL[ob.role] !== undefined) type = ob.role;
    return {
      type: String(type), title: String(ob.title || TYPE_LABEL[type] || 'элемент'),
      family: ob.family || null, role: ob.role || null,
      confidence: (function () { var c = ob.score != null ? ob.score : ob.confidence; if (c == null || !isFinite(Number(c))) return null; return round(Math.max(0, Math.min(1, Number(c))), 2); })(),
      center: arr(ob.center).slice(0, 3), dims: normDims(ob.dims),
      source: 'auto-measure', at: Date.now(),
      notes: arr(ob.notes).slice(0, 4), extraObjects: Math.max(0, arr(res.objects).length - 1),
      rejected: arr(res.rejected).slice(0, 3).map(function (x) { return String(x.title || x.why || ''); }).filter(Boolean)
    };
  }
  function elementFromIdentify(res) {
    if (!res || res.ok === false) return null;
    var type = res.kind || res.type || 'unknown';
    // ElementIdentify иногда возвращает generic 'object' с осмысленным title — уточняем по названию
    if ((type === 'object' || type === 'unknown' || !type) && res.title) {
      var tl = String(res.title).toLowerCase();
      var guess = ['стен', 'wall'].some(function (w) { return tl.indexOf(w) >= 0; }) ? 'wall'
        : /(пол|floor)/i.test(tl) ? 'floor' : /(потол|ceiling)/i.test(tl) ? 'ceiling'
          : /(труб|pipe)/i.test(tl) ? 'pipe' : /(балк|beam)/i.test(tl) ? 'beam'
            : /(колонн|column|столб)/i.test(tl) ? 'column' : /(двер|door)/i.test(tl) ? 'door'
              : /(окн|window)/i.test(tl) ? 'window' : /(про|opening)/i.test(tl) ? 'opening' : null;
      if (guess) type = guess;
    }
    return {
      type: String(type), title: String(res.title || TYPE_LABEL[type] || 'элемент'),
      kind: res.kind || null, confidence: res.confidence != null ? round(res.confidence, 2) : null,
      dims: normDims(res.dims), checks: arr(res.checks).slice(0, 8).map(function (c) { return { label: String(c.label || ''), ok: c.ok, text: String(c.text || c.value || '') }; }),
      queries: arr(res.queries).slice(0, 4), source: 'element-identify', at: Date.now(),
      notes: arr(res.notes).slice(0, 4), center: res.center || null
    };
  }
  function elementFromInspector(env) {
    var st = safe(function () { return env.__lxObjectInspector && env.__lxObjectInspector.state; }, null);
    var res = st && st.auto && st.auto.res;
    var el = elementFromAuto(res);
    if (el) { el.source = 'inspector-auto-measure'; el.title = el.title + ' (инспектор)'; }
    return el;
  }
  function summarizeRes(res) {
    if (!res || typeof res !== 'object') return null;
    var walls = arr(res.walls), floors = arr(res.floors), defects = arr(res.defects), openings = arr(res.openings), rooms = arr(res.rooms);
    var badWalls = walls.filter(function (w) { return w && (w.ok === false || w.okPlumb === false || w.okRail === false); }).length;
    var mep = res.mep && typeof res.mep === 'object' ? {
      beams: arr(res.mep.beams).length, pipes: arr(res.mep.pipes).length, ducts: arr(res.mep.ducts).length,
      trays: arr(res.mep.trays).length, lowest: safe(function () { return res.mep.lowest; }, null)
    } : null;
    var area = rooms.reduce(function (s, r) { return s + (num(r && r.area) || 0); }, 0);
    var checks = [];
    function add(label, ok, text) { checks.push({ label: String(label), ok: ok === true ? true : ok === false ? false : null, text: text == null ? '' : String(text) }); }
    var f = res.floor || res.plane || (floors[0] || null);
    if (f) {
      if (f.FF != null) add('Отметка чистого пола (FF)', null, num(f.FF) != null ? num(f.FF).toFixed(3) + ' м' : '');
      if (f.FL != null) add('Отметка уровня пола (FL)', null, num(f.FL) != null ? num(f.FL).toFixed(3) + ' м' : '');
      if (f.mmPerM != null) add('Ровность пола, мм/м', null, num(f.mmPerM).toFixed(2));
      if (f.area != null) add('Площадь пола', null, num(f.area).toFixed(1) + ' м²');
    }
    if (walls.length) add('Стен в контроле', null, walls.length + (badWalls ? ', вне допуска: ' + badWalls : ', все в допуске'));
    if (defects.length) add('Дефектов', null, defects.length + (defects[0] && defects[0].depth != null ? ', макс ' + round(defects[0].depth, 1) + ' мм' : ''));
    if (mep) add('Инженерные', null, 'труб ' + mep.pipes + ', балок ' + mep.beams + ', воздуховодов ' + mep.ducts);
    if (rooms.length) add('Помещений', null, rooms.length + ', площадь ' + round(area, 1) + ' м²');
    if (res.class || res.finish) add('Класс отделки', null, String(res.class || res.finish));
    return { walls: walls.length, wallsOutOfTolerance: badWalls, floors: floors.length, floor: f || null, defects: defects.length, openings: openings.length, rooms: rooms.length, roomsArea: round(area, 1), mep: mep, checks: checks, fileName: res.fileName || null };
  }
  function inspectionFrom(env) {
    var cur = safe(function () { return env.CloudInspectUI && env.CloudInspectUI.current ? env.CloudInspectUI.current() : null; }, null);
    if (!cur) return { available: false };
    var sum = summarizeRes(cur.res || {});
    return {
      available: true, fileName: cur.fileName || null, project: cur.project || null,
      dxfName: cur.dxfName || null, compare: cur.cmp || null,
      summary: sum, checks: sum ? sum.checks : []
    };
  }
  function modelFrom(env) {
    var model = safe(function () { return env.__lxScan2BIM && env.__lxScan2BIM.state && env.__lxScan2BIM.state.model; }, null);
    if (!model || model.ok === false || !(model.walls || model.slabs || model.storeys)) model = null;
    if (!model) {
      var summary = safe(function () { return env.__lxScan2BIMAI && env.__lxScan2BIMAI.getModelSummary ? env.__lxScan2BIMAI.getModelSummary() : null; }, null);
      if (summary) return Object.assign({ open: true, source: 'scan2bim-ai' }, summary);
      return { open: false };
    }
    var walls = arr(model.walls), slabs = arr(model.slabs), rooms = arr(model.rooms), storeys = arr(model.storeys);
    var byMaterial = {};
    walls.forEach(function (w) { var m = String((w && (w.material || w.type)) || 'не задан'); byMaterial[m] = (byMaterial[m] || 0) + 1; });
    return {
      open: true, source: 'scan2bim', name: safe(function () { return model.name || null; }, null),
      storeys: storeys.length || (model.storey ? 1 : 0),
      walls: walls.length, slabs: slabs.length, rooms: rooms.length,
      openings: walls.reduce(function (s, w) { return s + arr(w && w.openings).length; }, 0),
      pipes: arr(model.pipes).length, cables: arr(model.cables).length, beams: arr(model.beams).length, objects: arr(model.objects).length,
      materials: byMaterial,
      wallLength: round(walls.reduce(function (s, w) { return s + (num(w && w.length) || 0); }, 0), 1),
      area: round(rooms.reduce(function (s, r) { return s + (num(r && r.area) || 0); }, 0), 1),
      storeyHeights: storeys.map(function (s) { return { name: String(s.name || ''), height: round(s.height, 2) }; }).slice(0, 6)
    };
  }
  function projectFrom(env) {
    var snap = safe(function () { return env.BimProjectState && env.BimProjectState.snapshot ? env.BimProjectState.snapshot() : null; }, null);
    var meta = snap && snap.metadata && typeof snap.metadata === 'object' ? snap.metadata : {};
    var id = safe(function () { return env.BimProjectState && env.BimProjectState.projectId; }, null) || (snap && snap.projectId) || null;
    var name = safe(function () { return env.__bimProjectName; }, null) || meta.projectName || meta.name || (meta.project && (meta.project.name || meta.project.title)) || null;
    return { id: id || null, name: name || null, revision: snap ? safe(function () { return env.BimProjectState.revision; }, 0) : null, open: !!(id || name) };
  }
  function documentsFrom(env, snap) {
    var docs = arr(snap && snap.documents);
    var norms = { entries: 0, docs: [] };
    var st = safe(function () { return env.__aiState && env.__aiState.norms; }, null);
    if (st) { norms.entries = safe(function () { return (st.builtin && st.builtin.entries) || 0; }, 0); norms.docs = arr(st.docs).filter(function (d) { return d.status === 'ok'; }).map(function (d) { return { name: String(d.code || d.name || '').slice(0, 80), status: d.status }; }); }
    return {
      projectDocs: docs.map(function (d) { return { name: String((d && (d.name || d.title)) || 'документ').slice(0, 100), kind: d && d.kind || null, status: d && d.status || null }; }).slice(0, 12),
      norms: norms,
      count: docs.length
    };
  }
  function measurementsFrom(snap) {
    return arr(snap && snap.measurements).slice(-8).map(function (m) {
      return { label: String(m.label || m.name || m.kind || 'измерение'), value: m.value != null ? m.value : (m.total != null ? m.total : null), unit: m.unit || 'м', text: m.text ? String(m.text).slice(0, 120) : null };
    }).reverse();
  }
  function toolFrom(env) {
    var v = viewerOf(env);
    var tool = safe(function () { return (env.__lxModes && env.__lxModes.current && env.__lxModes.current()) || null; }, null);
    return {
      activeTool: safe(function () { return v && v.measuring ? 'измерение' : null; }, null) || (tool && (tool.name || tool.id)) || null,
      drawActive: safe(function () { return !!(env.__lxDraw && env.__lxDraw.active); }, false),
      pickActive: safe(function () { return !!(env.__bimPick && env.__bimPick.active); }, false),
      editMode: safe(function () { return v && v.editMode || null; }, null),
      tab: safe(function () { return (env.__lxRibbon && env.__lxRibbon.activeTab) || null; }, null)
    };
  }
  function build(env) {
    env = env || W || {};
    var snap = safe(function () { return env.BimProjectState && env.BimProjectState.snapshot ? env.BimProjectState.snapshot() : null; }, null);
    var cloud = cloudFrom(env), selection = selectionOf(env), inspection = inspectionFrom(env);
    var model = modelFrom(env), project = projectFrom(env), documents = documentsFrom(env, snap);
    var measurements = measurementsFrom(snap);
    var element = elementFromInspector(env);
    if (!element) {
      var P = safe(function () { return env.BimAssistantUI && env.BimAssistantUI._state ? env.BimAssistantUI._state() : null; }, null);
      if (P && P.picked && P.picked.res) element = elementFromIdentify(P.picked.res);
    }
    if (!element && inspection.available && arr(measurements).length) element = null;
    var caps = {
      cloud: !!(cloud && cloud.open), selection: !!(selection && selection.active), element: !!element,
      inspection: !!inspection.available, model: !!(model && model.open), documents: !!(documents.projectDocs.length || documents.norms.docs.length),
      measurements: measurements.length > 0
    };
    return {
      schema: 'ai-context/1', version: VERSION, generated: new Date().toISOString(),
      project: project, cloud: cloud, selection: selection, element: element,
      inspection: inspection, model: model, documents: documents, measurements: measurements,
      tool: toolFrom(env), checks: (inspection.checks || []).slice(0, 12),
      capabilities: caps
    };
  }
  // ------------------------------------------------------------------ текстовый блок для модели
  function toPromptBlock(ctx) {
    ctx = ctx || {};
    var L = ['СЕЙЧАС В ПРИЛОЖЕНИИ (факты — используй только их; чего нет, того не выдумывай; если данных нет — скажи «не знаю»):'];
    var c = ctx.cloud || {};
    if (c.open) {
      L.push('- облако: ' + (c.name || 'без имени') + ', ' + (c.points != null ? c.points.toLocaleString('ru-RU') + ' точек' : 'точек неизвестно') + (c.bbox ? '; габариты ' + c.bbox.size.map(function (v) { return v.toFixed(2); }).join(' × ') + ' м (bbox)' : '') + (c.crs ? '; СК: ' + String(c.crs).slice(0, 120) : ''));
    } else L.push('- облако: не открыто');
    var s = ctx.selection || {};
    if (s.active) L.push('- выделение: ' + (s.count != null ? s.count.toLocaleString('ru-RU') : '?') + ' точек' + (s.bbox ? '; габариты выделения ' + s.bbox.size.map(function (v) { return v.toFixed(2); }).join(' × ') + ' м' : '') + (s.volume != null ? '; объём bbox ' + s.volume.toFixed(2) + ' м³' : '') + (s.dominantClass ? '; класс точек: ' + s.dominantClass.label : ''));
    else L.push('- выделение: нет');
    var e = ctx.element;
    if (e) {
      var dims = (e.dims || []).slice(0, 6).map(function (d) { return d.label + ' ' + (d.text || d.value) + (d.unit && d.unit !== 'м' ? ' ' + d.unit : ''); }).join(', ');
      L.push('- распознанный элемент: ' + e.title + ' (тип ' + (TYPE_LABEL[e.type] || e.type) + ', источник ' + e.source + (e.confidence != null ? ', уверенность ' + e.confidence : '') + ')' + (dims ? '; размеры: ' + dims : ''));
      if (e.checks && e.checks.length) L.push('- нормоконтроль элемента: ' + e.checks.map(function (x) { return x.label + ' — ' + (x.ok === true ? 'норма' : x.ok === false ? 'вне нормы' : (x.text || 'нет данных')); }).join('; '));
    } else L.push('- распознанный элемент: нет (нужен щелчок «Что это?»/auto-measure)');
    var ins = ctx.inspection || {};
    if (ins.available) {
      var sm = ins.summary || {};
      L.push('- контроль геометрии: выполнен' + (ins.fileName ? ' по ' + ins.fileName : '') + (ins.dxfName ? ', сверка с ' + ins.dxfName : '') + (sm.walls != null ? '; стен ' + sm.walls + (sm.wallsOutOfTolerance ? ', вне допуска ' + sm.wallsOutOfTolerance : '') : '') + (sm.defects ? '; дефектов ' + sm.defects : '') + (sm.rooms ? '; помещений ' + sm.rooms + ' (площадь ' + sm.roomsArea + ' м²)' : '') + (sm.floor && sm.floor.mmPerM != null ? '; ровность пола ' + sm.floor.mmPerM + ' мм/м' : ''));
      if (ctx.checks && ctx.checks.length) L.push('- проверки: ' + ctx.checks.slice(0, 8).map(function (x) { return x.label + ': ' + (x.text || (x.ok === true ? 'ок' : x.ok === false ? 'не ок' : 'нет данных')); }).join('; '));
    } else L.push('- контроль геометрии: не выполнялся');
    if (ctx.model && ctx.model.open) L.push('- BIM-модель: этажей ' + (ctx.model.storeys || 0) + ', стен ' + (ctx.model.walls || 0) + ', проёмов ' + (ctx.model.openings || 0) + (ctx.model.rooms ? ', помещений ' + ctx.model.rooms : '') + (ctx.model.pipes ? ', труб ' + ctx.model.pipes : ''));
    var p = ctx.project || {};
    L.push('- проект: ' + (p.name || p.id || 'не выбран'));
    if (ctx.documents && (ctx.documents.projectDocs || []).length) L.push('- документы проекта: ' + ctx.documents.projectDocs.map(function (d) { return d.name; }).slice(0, 6).join('; '));
    if (ctx.documents && ctx.documents.norms && ctx.documents.norms.docs.length) L.push('- документы базы норм: ' + ctx.documents.norms.docs.map(function (d) { return d.name; }).slice(0, 5).join('; '));
    if (ctx.measurements && ctx.measurements.length) L.push('- сохранённые измерения: ' + ctx.measurements.slice(0, 4).map(function (m) { return m.label + ' = ' + (m.value != null ? m.value : m.text || '?') + ' ' + m.unit; }).join('; '));
    L.push('ПРАВИЛО: не подменяй отсутствующие факты догадками. Для вопросов «что это»/«какая толщина»/«сколько» используй блок выше; если поля нет — ответь «не знаю» и предложи ближайшее доступное действие.');
    return L.join('\n');
  }
  function compact(ctx) {
    ctx = ctx || {};
    var c = ctx.cloud || {}, s = ctx.selection || {}, e = ctx.element || null, ins = ctx.inspection || {};
    return {
      schema: 'ai-context/1',
      cloud: c.open ? { name: c.name, points: c.points, bbox: c.bbox && c.bbox.size, crs: c.crs ? String(c.crs).slice(0, 80) : null } : null,
      selection: s.active ? { count: s.count, bbox: s.bbox && s.bbox.size, volume: s.volume, class: s.dominantClass && s.dominantClass.label } : null,
      element: e ? { type: e.type, title: e.title, confidence: e.confidence, dims: (e.dims || []).map(function (d) { return { key: d.key, text: d.text }; }), source: e.source } : null,
      inspection: ins.available ? { file: ins.fileName, summary: ins.summary && { walls: ins.summary.walls, wallsOutOfTolerance: ins.summary.wallsOutOfTolerance, defects: ins.summary.defects, rooms: ins.summary.rooms, roomsArea: ins.summary.roomsArea }, checks: (ins.checks || []).slice(0, 6) } : null,
      model: ctx.model && ctx.model.open ? { storeys: ctx.model.storeys, walls: ctx.model.walls, openings: ctx.model.openings, rooms: ctx.model.rooms } : null,
      project: ctx.project ? { id: ctx.project.id, name: ctx.project.name } : null,
      docs: ctx.documents && (ctx.documents.projectDocs || []).length,
      caps: ctx.capabilities || null
    };
  }
  // ------------------------------------------------------------------ классификация выделения (fallback для «Что это?»)
  function selectionPoints(env) {
    var v = viewerOf(env);
    if (!v) return null;
    var sel = safe(function () { return v._sel && v._sel.size ? v._sel : null; }, null);
    if (!sel || !sel.size) return null;
    var pos = safe(function () { return (env.__pcTools && env.__pcTools.getCloud && env.__pcTools.getCloud() || {}).pos || (v.base && v.base[0] && v.base[0].pos) || null; }, null);
    if (!pos) return null;
    var n = Math.min(sel.size, 300000);
    var out = new Float32Array(n * 3), k = 0;
    sel.forEach(function (i) { if (k < n) { out[k * 3] = pos[i * 3]; out[k * 3 + 1] = pos[i * 3 + 1]; out[k * 3 + 2] = pos[i * 3 + 2]; k++; } });
    return { pos: out, count: k, total: sel.size };
  }
  function analyzeSelection(env, opts) {
    opts = opts || {};
    var sp = selectionPoints(env);
    if (!sp || !sp.count) return null;
    var AM = safe(function () { return env.AutoMeasure || null; }, null);
    if (AM && typeof AM.analyze === 'function') {
      try {
        var res = AM.analyze(sp.pos, sp.count, { finish: opts.finish || 'improved' });
        var el = elementFromAuto(res);
        if (el) {
          el.source = 'auto-measure-selection';
          el.selectionCount = sp.total;
          if (res.rejected && res.rejected.length) el.rejected = res.rejected.slice(0, 3).map(function (x) { return String(x.title || x.why || ''); }).filter(Boolean);
          if (!el.dims.length && res.info && res.info.spacing) el.notes = ['шаг точек ' + res.info.spacing + ' м'];
          return el;
        }
      } catch (_) { }
    }
    // fallback: доминирующий класс облака (если классифицировано)
    var sel = selectionOf(env);
    if (sel && sel.dominantClass) {
      return { type: sel.dominantClass.type || 'unknown', title: sel.dominantClass.label, confidence: null, dims: [], source: 'cloud-classifier', selectionCount: sp.total, rejected: [], notes: ['классификация облака: ' + sel.dominantClass.label] };
    }
    return null;
  }
  function analyzeInspector(env) {
    var el = elementFromInspector(env);
    return el || null;
  }
  return {
    version: VERSION, build: build, compact: compact, toPromptBlock: toPromptBlock,
    cloudFrom: cloudFrom, selectionOf: selectionOf, inspectionFrom: inspectionFrom, modelFrom: modelFrom,
    projectFrom: projectFrom, documentsFrom: documentsFrom, measurementsFrom: measurementsFrom,
    elementFromAuto: elementFromAuto, elementFromIdentify: elementFromIdentify, elementFromInspector: elementFromInspector,
    analyzeSelection: analyzeSelection, analyzeInspector: analyzeInspector, summarizeRes: summarizeRes,
    selectionPoints: selectionPoints, TYPE_LABEL: TYPE_LABEL, CLASS_LABEL: CLASS_LABEL, CLASS_TYPE: CLASS_TYPE,
    _bboxOf: bboxOf, _normDims: normDims, _round: round
  };
});
