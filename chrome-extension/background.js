/**
 * background.js — Service Worker (Manifest V3)
 * Отвечает за: хранение настроек, управление состоянием, relay сообщений
 */

const DEFAULT_CONFIG = {
  backendUrl: 'http://localhost:8000',
  deepgramKey: '',       // пользователь вводит в popup
  perplexityKey: '',     // опционально — если без бэкенда
  mode: 'interview',     // 'interview' | 'compass'
  ttsEnabled: false,
  ttsVoice: 'browser',  // 'browser' (Web Speech) | 'elevenlabs'
  overlayPosition: 'bottom-right',
  minConfidence: 0.7,
  hintDelay: 1500,       // мс после utterance_end перед запросом
  active: false,
  language: 'ru-RU',
};

// Инициализация дефолтных настроек
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('config');
  if (!stored.config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  }
  console.log('[BG] Interview Assistant installed');
});

// Relay сообщений между popup ↔ content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_CONFIG') {
    chrome.storage.local.get('config').then(data => {
      sendResponse(data.config || DEFAULT_CONFIG);
    });
    return true; // async
  }

  if (msg.type === 'SET_CONFIG') {
    chrome.storage.local.set({ config: msg.config }).then(() => {
      sendResponse({ ok: true });
      // Уведомить все активные content scripts
      chrome.tabs.query({ url: ['https://*.zoom.us/*'] }, tabs => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATED', config: msg.config })
            .catch(() => {}); // tab может быть не готов
        });
      });
    });
    return true;
  }

  if (msg.type === 'TOGGLE_ACTIVE') {
    chrome.storage.local.get('config').then(data => {
      const config = data.config || DEFAULT_CONFIG;
      config.active = !config.active;
      chrome.storage.local.set({ config }).then(() => {
        sendResponse({ active: config.active });
        // Уведомить content script
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, { type: 'CONFIG_UPDATED', config })
            .catch(() => {});
        }
      });
    });
    return true;
  }

  // Proxy: статус от content script → popup
  if (msg.type === 'STATUS_UPDATE') {
    // Store last status for popup to read
    chrome.storage.session?.set({ lastStatus: msg }).catch(() => {});
  }
});

// tabCapture relay — content script не может вызвать tabCapture напрямую
// background получает streamId и передаёт его обратно
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TAB_STREAM_ID') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab id' });
      return true;
    }
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ streamId });
      }
    });
    return true; // async
  }
});

// Keyboard shortcut Ctrl+Shift+I — toggle overlay
chrome.commands?.onCommand?.addListener(async (command) => {
  if (command === 'toggle-overlay') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' }).catch(() => {});
    }
  }
});
