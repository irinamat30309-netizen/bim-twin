// Заглушка window.bimAPI для безголовых снимков интерфейса: повторяет поверхность preload.js и возвращает безопасные значения.
const path = require('path');
const { buildData } = require(path.resolve(__dirname, '..', '..', 'db', 'loadData'));
module.exports = function makeStub() {
  const data = buildData();
  const proj = { id: data.project.id, name: data.project.name, address: data.project.address, status: data.project.status };
  return `(() => {
    const data = ${JSON.stringify(data)};
    const proj = ${JSON.stringify(proj)};
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
    window.bimAPI = new Proxy({ platform: 'win32' }, { get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      if (k in defaults) return (...a) => { window.__bimCalls.push(k); return new Promise(r => setTimeout(() => r(defaults[k](...a)), 12)); };
      if (/^on[A-Z]/.test(k)) return () => () => {};
      return (...a) => { window.__bimCalls.push(k); return new Promise(r => setTimeout(() => r(null), 8)); };
    } });
  })();`;
};
