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
