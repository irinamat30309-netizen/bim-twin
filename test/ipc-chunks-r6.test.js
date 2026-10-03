'use strict';
// Ревизия 5 ограничила облако 20 млн точек (иначе одно IPC-сообщение на ~1,4 ГБ роняло окно на 87 %).
// Ревизия 6 снимает это ограничение: крупное облако уходит в окно кусками (подробные проверки — point-share-r6.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CFG = require('../app-config.js');
const R_ = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('бюджет проекта остаётся 200 млн, лимита IPC на число точек нет, кусок < 300 МБ', () => {
  assert.equal(CFG.resolvePointBudget({}), 200000000);
  assert.equal(CFG.IPC_MAX_POINTS, undefined);
  assert.ok(CFG.IPC_CHUNK_POINTS * (12 + 12 + 4 + 1) < 300 * 1048576, 'pos+col+intensity+class одного куска');
});
test('main.js: parseCloud не режет число точек; журнал падений окна сохранён', () => {
  const m = R_('main.js');
  assert.ok(!/IPC_MAX_POINTS|ipcLimited/.test(m));
  assert.ok(/pendingClouds\.stash\(/.test(m), 'крупные облака уходят кусками');
  assert.ok(/render-process-gone/.test(m) && /crash\.log/.test(m));
  assert.ok(!/ipcLimited/.test(R_('renderer', 'app.js')));
});
