/**
 * popup.js — Popup UI logic
 */
'use strict';

const DEFAULT_CONFIG = {
  backendUrl: 'http://localhost:8000',
  deepgramKey: '',
  perplexityKey: '',
  elevenLabsKey: '',
  mode: 'interview',
  ttsEnabled: false,
  ttsVoice: 'browser',
  overlayPosition: 'bottom-right',
  hintDelay: 1500,
  active: false,
};

// ── Загрузка конфига ──────────────────────────────────────────────────────────
async function loadConfig() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, config => {
      resolve(config || DEFAULT_CONFIG);
    });
  });
}

function applyConfigToUI(config) {
  document.getElementById('backendUrl').value = config.backendUrl || '';
  document.getElementById('deepgramKey').value = config.deepgramKey || '';
  document.getElementById('perplexityKey').value = config.perplexityKey || '';
  document.getElementById('elevenLabsKey').value = config.elevenLabsKey || '';
  document.getElementById('ttsEnabled').checked = !!config.ttsEnabled;
  document.getElementById('ttsVoice').value = config.ttsVoice || 'browser';
  document.getElementById('overlayPosition').value = config.overlayPosition || 'bottom-right';
  document.getElementById('hintDelay').value = config.hintDelay || 1500;

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === config.mode);
  });
}

function readConfigFromUI(currentConfig) {
  const activeModeTab = document.querySelector('.mode-tab.active');
  return {
    ...currentConfig,
    backendUrl: document.getElementById('backendUrl').value.trim().replace(/\/$/, ''),
    deepgramKey: document.getElementById('deepgramKey').value.trim(),
    perplexityKey: document.getElementById('perplexityKey').value.trim(),
    elevenLabsKey: document.getElementById('elevenLabsKey').value.trim(),
    ttsEnabled: document.getElementById('ttsEnabled').checked,
    ttsVoice: document.getElementById('ttsVoice').value,
    overlayPosition: document.getElementById('overlayPosition').value,
    hintDelay: parseInt(document.getElementById('hintDelay').value) || 1500,
    mode: activeModeTab?.dataset.mode || 'interview',
  };
}

// ── Проверка бэкенда ──────────────────────────────────────────────────────────
async function checkBackend(url) {
  const dot = document.getElementById('backend-status');
  const label = document.getElementById('backend-label');
  dot.className = 'status-dot';
  label.textContent = 'Проверка...';

  try {
    const res = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      dot.className = 'status-dot ok';
      const parts = [];
      if (data.deepgram_available) parts.push('Deepgram ✓');
      if (data.perplexity_available) parts.push('Perplexity ✓');
      if (!data.deepgram_available && !data.perplexity_available) parts.push('Claude fallback');
      label.textContent = `Бэкенд работает · ${parts.join(' · ')}`;
      return true;
    }
  } catch (e) {}

  dot.className = 'status-dot err';
  label.textContent = 'Бэкенд недоступен — запустите server.py';
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
let currentConfig = DEFAULT_CONFIG;

document.addEventListener('DOMContentLoaded', async () => {
  currentConfig = await loadConfig();
  applyConfigToUI(currentConfig);

  // Auto-check backend
  if (currentConfig.backendUrl) {
    checkBackend(currentConfig.backendUrl);
  }

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });

  // Save button
  document.getElementById('saveBtn').addEventListener('click', async () => {
    const newConfig = readConfigFromUI(currentConfig);
    currentConfig = newConfig;

    chrome.runtime.sendMessage({ type: 'SET_CONFIG', config: newConfig }, () => {
      const msg = document.getElementById('savedMsg');
      msg.style.display = 'block';
      setTimeout(() => msg.style.display = 'none', 2000);
    });

    // Also inject ElevenLabs key if provided
    if (newConfig.elevenLabsKey) {
      // Store separately for backend injection hint
      chrome.storage.local.set({ elevenLabsKey: newConfig.elevenLabsKey });
    }
  });

  // Test button
  document.getElementById('testBtn').addEventListener('click', async () => {
    const url = document.getElementById('backendUrl').value.trim().replace(/\/$/, '');
    await checkBackend(url);
  });
});
