'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { llmPrivacyStatus, buildLlmPayload } = require('../ai/privacy');
const {
  protectSettingsPatch,
  migrateLegacySettings,
  publicSettings,
  revealSettings
} = require('../security/secret-settings');

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from('enc:' + value),
    decryptString: value => value.toString().replace(/^enc:/, '')
  };
}

test('remote LLM providers require explicit consent while local Ollama does not', () => {
  assert.equal(llmPrivacyStatus({ llmProvider: 'openai', llmApiKey: 'k' }).reason, 'consent_required');
  assert.equal(llmPrivacyStatus({ llmProvider: 'openai', llmApiKey: 'k', llmRemoteConsent: true }).allowed, true);
  assert.equal(llmPrivacyStatus({ llmProvider: 'ollama', llmHost: 'http://127.0.0.1:11434' }).allowed, true);
  assert.equal(llmPrivacyStatus({ llmProvider: 'ollama', llmHost: 'https://ai.example.test' }).reason, 'consent_required');
  assert.equal(llmPrivacyStatus({ llmProvider: 'ollama', llmHost: 'file:///tmp/socket' }).reason, 'invalid_host');
});

test('LLM payload is bounded and excludes unrelated element fields', () => {
  const payload = buildLlmPayload(
    { id: 'e1', type: 'wall', width: 2.5, secretNotes: 'do not send', blob: 'x'.repeat(10000) },
    'd'.repeat(10000),
    { llmDocumentCharLimit: 120 }
  );
  assert.deepEqual(payload.element, { id: 'e1', type: 'wall', width: 2.5 });
  assert.equal(payload.documents.length, 120);
});

test('API keys are never persisted in plaintext and fail closed without encryption', () => {
  const safeStorage = fakeSafeStorage(true);
  const protectedPatch = protectSettingsPatch({ llmApiKey: 'top-secret', theme: 'dark' }, safeStorage);
  assert.equal(protectedPatch.llmApiKey, '');
  assert.notEqual(protectedPatch.llmApiKeyEnc, 'top-secret');
  assert.equal(revealSettings(protectedPatch, safeStorage).llmApiKey, 'top-secret');
  assert.throws(
    () => protectSettingsPatch({ llmApiKey: 'top-secret' }, fakeSafeStorage(false)),
    /secure_storage_unavailable/
  );
});

test('legacy plaintext key is migrated or dropped and public settings redact it', () => {
  const migrated = migrateLegacySettings({ llmApiKey: 'legacy' }, fakeSafeStorage(true));
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.patch.llmApiKey, '');
  assert.equal(publicSettings(migrated.settings).llmApiKeyConfigured, true);
  assert.equal(publicSettings(migrated.settings).llmApiKey, '');
  assert.equal('llmApiKeyEnc' in publicSettings(migrated.settings), false);

  const dropped = migrateLegacySettings({ llmApiKey: 'legacy' }, fakeSafeStorage(false));
  assert.equal(dropped.dropped, true);
  assert.equal(dropped.settings.llmApiKey, '');
});