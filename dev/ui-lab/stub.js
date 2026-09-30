// Заглушка window.bimAPI для безголовых снимков интерфейса: повторяет поверхность preload.js и возвращает безопасные значения.
const fs = require('fs');
const path = require('path');
const { buildData } = require(path.resolve(__dirname, '..', '..', 'db', 'loadData'));
// Имена методов bimAPI берём прямо из preload.js: приложение (app.js) копирует только перечисляемые свойства и по наличию
// uploadDocument решает, что оно в Electron (CAN_PERSIST). Без этого рабочая область молча остаётся в «демо»: без кнопок окна и записи.
function apiNames() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'preload.js'), 'utf8');
  const i = src.indexOf("exposeInMainWorld('bimAPI', {");
  return [...src.slice(i).matchAll(/^  ([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]).filter((n) => n !== 'platform');
}
module.exports = function makeStub() {
  const data = buildData();
  const names = process.env.LAB_DEMO ? [] : apiNames();
  const proj = { id: data.project.id, name: data.project.name, address: data.project.address, status: data.project.status };
  return `(() => {
    const data = ${JSON.stringify(data)};
    const proj = ${JSON.stringify(proj)};
    const names = ${JSON.stringify(names)};
    const defaults = {
      getData: () => data,
      getMode: () => 'json',
      listProjects: () => [proj],
      getSettings: () => ({}),
      getVersion: () => '1.2.0-rc.3',
      getPaths: () => ({ userData: '/tmp/bim' }),
      listUsers: () => [{ id: 'u1', name: 'Ирина', role: 'admin' }],
      listDiscussions: () => [],
      listSectionPresets: () => [],
      // Автосохранение: список версий отдаётся только по запросу истории (includeCleared), иначе при открытии облака всплыл бы диалог восстановления
      autosaveLoad: (p) => (p && p.includeCleared) ? { ok: true, exists: true, path: '/tmp/bim/autosave.ply', revisions: [
        { savedAt: Date.now() - 20 * 60e3, points: 296063, bytes: 4738000, sha256: 'a3f91c0d7be2451100aa', latest: true },
        { savedAt: Date.now() - 3 * 3600e3, points: 295870, bytes: 4734000, sha256: '9be2107733ad05aa11cc' }] } : { ok: true, exists: false, revisions: [] },
      autosaveCloud: () => ({ ok: true }), autosaveClear: () => ({ ok: true }),
      // Тексты документов помещения: нужны, чтобы окно «Сверка с документацией» показывало реальные требования.
      readDocument: (id) => ({ ok: true, ext: 'pdf', kind: 'pdf', text: ({
        d1: 'Схема вентиляции К-1. Стена: длина 6,0 м ± 0,05 м. Стена: высота 2,8 м ± 0,03 м.\nВоздуховод: длина 4,2 м ± 0,05 м. Вентиляционный короб: ширина 600 мм ± 10 мм.',
        d3: 'Паспорт ПУ-1. Оборудование: высота 1,9 м ± 0,02 м. Оборудование: ширина 1,2 м.',
        d3b: 'Сертификат огнестойкости. Дверь: ширина проёма 900 мм ± 10 мм. Дверь: высота 2100 мм.'
      })[id] || '' }),
      ocrDocument: () => ({ ok: false, reason: 'OCR недоступен в стенде' }),
      listProjectRevisions: () => [],
      listProjectOperations: () => [],
      getProjectState: () => null,
      loadProjectClassification: () => null,
      potreeStatus: () => ({ ok: false }), splatTransformStatus: () => ({ ok: false }), cleanStatus: () => ({ ok: false }),
      ccStatus: () => ({ ok: false }), geomStatus: () => ({ ok: false }), s2bStatus: () => ({ ok: false }), ocrStatus: () => ({ ok: false })
    };
    window.__bimCalls = [];
    const sync = { getPathForFile: () => '' };
    const fn = (k) => {
      if (k in sync) return sync[k];
      if (k in defaults) return (...a) => { window.__bimCalls.push(k); return new Promise(r => setTimeout(() => r(defaults[k](...a)), 12)); };
      if (/^on[A-Z]/.test(k)) return () => () => {};
      return (...a) => { window.__bimCalls.push(k); return new Promise(r => setTimeout(() => r(null), 8)); };
    };
    window.bimAPI = new Proxy({ platform: 'win32' }, {
      get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; return fn(k); },
      // app.js копирует API через getOwnPropertyNames: без этих ловушек виден только platform
      ownKeys(t) { return ['platform', ...names]; },
      has(t, k) { return k === 'platform' || names.includes(k); },
      getOwnPropertyDescriptor(t, k) { if (k === 'platform') return Reflect.getOwnPropertyDescriptor(t, k); return names.includes(k) ? { configurable: true, enumerable: true, writable: true, value: fn(k) } : undefined; }
    });
  })();`;
};
