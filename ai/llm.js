'use strict';
/*
 * LLM verifier adapter (Phase C, C3) — Node side, built-ins only (https).
 * Escalates ambiguous checks to an LLM when configured in Settings:
 *   provider: 'openai' (apiKey, model) | 'ollama' (host, model) | 'none'
 * Fully offline: if no provider/key is configured or the request fails, returns
 * null and the caller keeps the rule-based finding.
 */
const https = require('https');
const http = require('http');
const { llmPrivacyStatus, buildLlmPayload, parseHttpUrl } = require('./privacy');

const SYSTEM = 'Ты — инженер-нормоконтролёр. Сравни элемент BIM-модели с документами. '
  + 'Верни СТРОГО JSON: {"severity":"ok|warn|err","kind":"...","text":"...","confidence":0..1}.';

function llmAvailable(settings) {
  return llmPrivacyStatus(settings).allowed;
}

function privacyStatus(settings) {
  return llmPrivacyStatus(settings);
}

function postJson(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length }, headers || {})
    }, res => {
      let buf = '';
      let bytes = 0;
      res.on('data', d => {
        bytes += d.length;
        if (bytes > 1024 * 1024) {
          req.destroy(new Error('response_too_large'));
          return;
        }
        buf += d;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('http_status_' + res.statusCode));
          return;
        }
        resolve({ status: res.statusCode, body: buf });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 60000, () => { req.destroy(new Error('timeout')); });
    req.write(data); req.end();
  });
}

async function verifyLLM(element, docText, settings) {
  const s = settings || {};
  const privacy = llmPrivacyStatus(s);
  if (!privacy.allowed) return null;
  const payload = buildLlmPayload(element, docText, s);
  try {
    if (s.llmProvider === 'openai' && s.llmApiKey) {
      const r = await postJson('https://api.openai.com/v1/chat/completions',
        { Authorization: 'Bearer ' + s.llmApiKey },
        { model: s.llmModel || 'gpt-4o-mini', response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(payload) }] });
      const j = JSON.parse(r.body);
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return content ? JSON.parse(content) : null;
    }
    if (s.llmProvider === 'ollama' && s.llmHost) {
      const host = parseHttpUrl(s.llmHost);
      if (!host) return null;
      const r = await postJson(host.href.replace(/\/$/, '') + '/api/generate', {},
        { model: s.llmModel || 'llama3.1', format: 'json', stream: false,
          prompt: SYSTEM + '\n' + JSON.stringify(payload) });
      const j = JSON.parse(r.body);
      return j.response ? JSON.parse(j.response) : null;
    }
  } catch (e) { return null; }
  return null;
}

module.exports = { llmAvailable, privacyStatus, verifyLLM, SYSTEM };
