'use strict';

function storageAvailable(safeStorage) {
  try {
    return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
  } catch (_) {
    return false;
  }
}

function protectSettingsPatch(patch, safeStorage) {
  const protectedPatch = Object.assign({}, patch || {});
  if (!Object.prototype.hasOwnProperty.call(protectedPatch, 'llmApiKey')) return protectedPatch;
  const secret = String(protectedPatch.llmApiKey || '');
  if (!secret) {
    protectedPatch.llmApiKey = '';
    protectedPatch.llmApiKeyEnc = '';
    return protectedPatch;
  }
  if (!storageAvailable(safeStorage)) throw new Error('secure_storage_unavailable');
  protectedPatch.llmApiKeyEnc = safeStorage.encryptString(secret).toString('base64');
  protectedPatch.llmApiKey = '';
  return protectedPatch;
}

function revealSettings(settings, safeStorage) {
  const revealed = Object.assign({}, settings || {});
  if (revealed.llmApiKeyEnc && !revealed.llmApiKey && storageAvailable(safeStorage)) {
    revealed.llmApiKey = safeStorage.decryptString(Buffer.from(revealed.llmApiKeyEnc, 'base64'));
  }
  return revealed;
}

function migrateLegacySettings(settings, safeStorage) {
  const current = Object.assign({}, settings || {});
  const legacy = String(current.llmApiKey || '');
  if (!legacy || current.llmApiKeyEnc) return { settings: current, patch: null, migrated: false, dropped: false };
  if (!storageAvailable(safeStorage)) {
    current.llmApiKey = '';
    return {
      settings: current,
      patch: { llmApiKey: '', llmApiKeyEnc: '' },
      migrated: false,
      dropped: true
    };
  }
  const llmApiKeyEnc = safeStorage.encryptString(legacy).toString('base64');
  current.llmApiKeyEnc = llmApiKeyEnc;
  return {
    settings: current,
    patch: { llmApiKey: '', llmApiKeyEnc },
    migrated: true,
    dropped: false
  };
}

function publicSettings(settings) {
  const out = Object.assign({}, settings || {});
  const configured = !!(out.llmApiKey || out.llmApiKeyEnc);
  delete out.llmApiKey;
  delete out.llmApiKeyEnc;
  out.llmApiKey = '';
  out.llmApiKeyConfigured = configured;
  return out;
}

module.exports = {
  storageAvailable,
  protectSettingsPatch,
  revealSettings,
  migrateLegacySettings,
  publicSettings
};