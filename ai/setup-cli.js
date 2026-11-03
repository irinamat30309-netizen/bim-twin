#!/usr/bin/env node
'use strict';
/*
 * setup-cli.js — установка локальной модели ИИ-ассистента из командной строки (ревизия 34).
 * Запускается START.bat (отдельное свёрнутое окно) и установщиком Windows (в фоне, через «BIM Twin.exe» с ELECTRON_RUN_AS_NODE=1).
 *   node ai/setup-cli.js                 — скачать Ollama (если нужно), выбрать и скачать модель, создать «bim-twin-assistant»
 *   --model qwen3.5:9b                    — модель вручную;  --dir <папка> — где хранить;  --status — показать состояние
 *   --background                          — без вывода в консоль (журнал — setup.log в папке модели)
 *   --keep-server                         — не останавливать сервер модели по окончании
 * Код выхода: 0 — готово, 3 — уже ставится другим процессом (приложение или START.bat), 1 — ошибка.
 */
const L = require('./local-llm');

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
const has = (n) => process.argv.includes(n);
const quiet = has('--background');
const dir = arg('--dir') || undefined;
function out(s) { if (!quiet) process.stdout.write(s); }
function gb(b) { return (b / 1073741824).toFixed(2); }

async function main() {
  if (has('--status')) { console.log(JSON.stringify(await L.status(dir), null, 1)); return 0; }
  if (has('--hardware')) { const hw = await L.hardware({ dir }); console.log(JSON.stringify({ hw, pick: L.pickModel(hw) }, null, 1)); return 0; }
  if (L.isReady(dir) && !arg('--model') && !has('--force')) {
    const st = L.readState(dir);
    out('[BIM-Twin AI] Model is ready: ' + st.base + ' (' + st.model + ')\n');
    return 0;
  }
  out('[BIM-Twin AI] Local AI assistant setup. Folder: ' + L.paths(dir).base + '\n');
  let lastLine = '', lastPhase = '';
  const r = await L.ensure({ dir, model: arg('--model') || undefined, stopServerAfter: !has('--keep-server'), onProgress: (s) => {
    if (s.phase !== lastPhase) { lastPhase = s.phase; out('\n[BIM-Twin AI] ' + ({ check: 'Checking the PC', runtime: 'Downloading Ollama', extract: 'Unpacking Ollama', server: 'Starting local model server', model: 'Downloading model ' + (s.base || ''), create: 'Creating bim-twin-assistant', ready: 'Ready', error: 'Error' }[s.phase] || s.phase) + '\n'); }
    if ((s.phase === 'runtime' || s.phase === 'model') && s.total) {
      const line = '  ' + (s.pct || 0).toFixed(1) + ' %  ' + gb(s.done || 0) + ' / ' + gb(s.total) + ' GB';
      if (line !== lastLine) { lastLine = line; out('\r' + line + '   '); }
    }
  } });
  if (r.busy) {
    out('[BIM-Twin AI] Setup is already running in another process (pid ' + (r.holder && r.holder.pid) + '). Waiting...\n');
    if (has('--no-wait')) return 3;
    for (;;) {
      await new Promise(res => setTimeout(res, 3000));
      const st = L.readState(dir);
      if (st.phase === 'ready') { out('[BIM-Twin AI] Ready: ' + st.base + '\n'); return 0; }
      if (st.phase === 'error' && !L.lockHolder(dir)) { out('[BIM-Twin AI] Error: ' + st.error + '\n'); return 1; }
      if (!L.lockHolder(dir) && st.phase !== 'ready') return main();
      if (st.total) out('\r  ' + st.phase + ' ' + (st.pct || 0).toFixed(1) + ' %   ');
    }
  }
  if (!r.ok) { out('\n[BIM-Twin AI] Setup failed: ' + r.error + '\n  The app keeps working; the assistant answers in simple mode. Run START.bat again to retry.\n'); return 1; }
  out('\n[BIM-Twin AI] Done: ' + r.state.base + ' -> ' + r.state.model + '\n');
  return 0;
}
main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
