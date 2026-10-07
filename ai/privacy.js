'use strict';

const DEFAULT_DOCUMENT_CHAR_LIMIT = 6000;
const MAX_DOCUMENT_CHAR_LIMIT = 12000;

function parseHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function llmPrivacyStatus(settings) {
  const s = settings || {};
  if (s.llmProvider === 'openai') {
    if (!s.llmApiKey) return { allowed: false, remote: true, reason: 'missing_api_key', destination: 'https://api.openai.com' };
    if (s.llmRemoteConsent !== true) return { allowed: false, remote: true, reason: 'consent_required', destination: 'https://api.openai.com' };
    return { allowed: true, remote: true, reason: null, destination: 'https://api.openai.com' };
  }
  if (s.llmProvider === 'ollama') {
    const url = parseHttpUrl(s.llmHost);
    if (!url) return { allowed: false, remote: false, reason: 'invalid_host', destination: null };
    const remote = !isLoopbackHost(url.hostname);
    if (remote && s.llmRemoteConsent !== true) {
      return { allowed: false, remote: true, reason: 'consent_required', destination: url.origin };
    }
    return { allowed: true, remote, reason: null, destination: url.origin };
  }
  return { allowed: false, remote: false, reason: 'provider_disabled', destination: null };
}

function documentCharLimit(settings) {
  const requested = Number(settings && settings.llmDocumentCharLimit);
  if (!Number.isSafeInteger(requested) || requested < 0) return DEFAULT_DOCUMENT_CHAR_LIMIT;
  return Math.min(requested, MAX_DOCUMENT_CHAR_LIMIT);
}

function sanitizeElement(element) {
  const source = element && typeof element === 'object' ? element : {};
  const allowed = [
    'id', 'type', 'name', 'category', 'level', 'section', 'material',
    'width', 'height', 'length', 'thickness', 'diameter', 'area', 'volume',
    'dimensions'
  ];
  const clean = {};
  for (const key of allowed) {
    const value = source[key];
    if (value == null) continue;
    if (typeof value === 'string') clean[key] = value.slice(0, 500);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (Array.isArray(value)) clean[key] = value.slice(0, 16).map(item =>
      typeof item === 'number' && Number.isFinite(item) ? item : String(item).slice(0, 100));
    else if (typeof value === 'object') {
      const encoded = JSON.stringify(value);
      if (encoded.length <= 2000) clean[key] = value;
    }
  }
  return clean;
}

function buildLlmPayload(element, docText, settings) {
  return {
    element: sanitizeElement(element),
    documents: String(docText || '').slice(0, documentCharLimit(settings))
  };
}

module.exports = {
  DEFAULT_DOCUMENT_CHAR_LIMIT,
  MAX_DOCUMENT_CHAR_LIMIT,
  parseHttpUrl,
  isLoopbackHost,
  llmPrivacyStatus,
  documentCharLimit,
  sanitizeElement,
  buildLlmPayload
};