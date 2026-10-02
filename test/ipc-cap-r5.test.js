'use strict';
// Ревизия 5: облако на 49 млн точек роняло окно на 87 % загрузки — в одном IPC-сообщении уходило ≈ 1,2 ГБ.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CFG = require('../app-config.js');
const R_ = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('в окно за один раз уходит не больше IPC_MAX_POINTS точек, но бюджет проекта остаётся 200 млн', () => {
  assert.ok(CFG.IPC_MAX_POINTS >= 10e6 && CFG.IPC_MAX_POINTS <= 30e6);
  assert.ok(CFG.IPC_MAX_POINTS * 24 < 700 * 1048576, 'pos+col одним сообщением должны укладываться в ~700 МБ');
  assert.equal(CFG.resolvePointBudget({}), 200000000);
});
test('main.js: parseCloud ограничивает чтение и сообщает об этом; журнал падений окна', () => {
  const m = R_('main.js');
  assert.ok(/Math\.min\(budgetSetting, APP_CFG\.IPC_MAX_POINTS/.test(m));
  assert.ok(/ipcLimited: true/.test(m));
  assert.ok(/render-process-gone/.test(m) && /crash\.log/.test(m));
  assert.ok(/ipcLimited/.test(R_('renderer', 'app.js')));
});
