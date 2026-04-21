/**
 * Main Application Entry Point
 * Связывает AudioCapture → DeepgramClient → HintsClient → OverlayManager
 */

import { AudioCapture } from './audio/capture.js';
import { DeepgramClient } from './deepgram/client.js';
import { HintsClient } from './utils/hints-client.js';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';
const BACKEND_WS  = BACKEND_URL.replace(/^http/, 'ws');

class App {
  constructor() {
    this.audio = null;
    this.deepgram = null;
    this.hints = null;

    this.transcripts = [];       // Накопленные финальные транскрипции
    this.activeKeywords = new Set();
    this.hintCards = new Map();  // id → DOM element
    this._hintCounter = 0;

    this._bindUI();
    this._loadDevices();
  }

  _bindUI() {
    document.getElementById('start-btn').addEventListener('click', () => this.start());
    document.getElementById('stop-btn').addEventListener('click', () => this.stop());
  }

  async _loadDevices() {
    try {
      const tempCapture = new AudioCapture();
      const devices = await tempCapture.listDevices();
      const sel = document.getElementById('device-select');
      sel.innerHTML = devices.map(d =>
        `<option value="${d.id}">${d.label}</option>`
      ).join('');
    } catch (e) {
      document.getElementById('device-select').innerHTML =
        '<option value="">Нет доступа к устройствам</option>';
    }
  }

  async start() {
    const deviceId = document.getElementById('device-select').value || null;
    const mode     = document.getElementById('mode-select').value;
    const profile  = document.getElementById('profile-select').value;

    // Инициализировать клиент подсказок
    this.hints = new HintsClient({
      backendUrl: BACKEND_URL,
      profile,
      onHint: (hint) => this._addHintCard(hint),
      onKeywords: (kws) => this._updateKeywords(kws),
      onProcessing: (active) => {
        document.getElementById('processing').classList.toggle('active', active);
      },
    });

    // Инициализировать Deepgram клиент
    this.deepgram = new DeepgramClient({
      backendWsUrl: `${BACKEND_WS}/ws/transcribe?profile=${profile}`,
      onTranscript: (t) => this._handleTranscript(t),
      onStatusChange: (s) => this._updateWsStatus(s),
      onError: (e) => console.error(e),
    });
    this.deepgram.connect();

    // Инициализировать захват аудио
    this.audio = new AudioCapture({
      sampleRate: 16000,
      onAudioData: (pcm16) => this.deepgram.send(pcm16),
      onError: (e) => { console.error(e); this._updateAudioStatus('error'); },
    });

    const ok = await this.audio.start(deviceId, mode);
    if (ok) {
      this._updateAudioStatus('active');
      document.getElementById('start-btn').disabled = true;
      document.getElementById('stop-btn').disabled = false;
    }
  }

  stop() {
    if (this.audio) { this.audio.stop(); this.audio = null; }
    if (this.deepgram) { this.deepgram.close(); this.deepgram = null; }
    this._updateAudioStatus('idle');
    this._updateWsStatus('disconnected');
    document.getElementById('start-btn').disabled = false;
    document.getElementById('stop-btn').disabled = true;
  }

  clearHints() {
    document.getElementById('hints-container').innerHTML =
      '<div class="empty-state"><div class="icon">💡</div>Подсказки очищены</div>';
    this.hintCards.clear();
  }

  _handleTranscript({ transcript, isFinal, speakers, confidence }) {
    const container = document.getElementById('transcript-container');

    // Убрать пустое состояние
    const empty = container.querySelector('.empty-state');
    if (empty) empty.remove();

    if (isFinal) {
      // Добавить финальную запись (по спикерам если есть диаризация)
      if (speakers && speakers.length > 1) {
        speakers.forEach(seg => {
          const entry = this._makeTranscriptEntry(seg.text, true, seg.speaker);
          container.appendChild(entry);
        });
      } else {
        container.appendChild(this._makeTranscriptEntry(transcript, true, null));
      }

      // Прокрутить вниз
      container.scrollTop = container.scrollHeight;

      // Отправить в hints engine
      this.transcripts.push(transcript);
      this.hints?.process(transcript);

      // Удалить interim-элемент если есть
      const interim = container.querySelector('.interim');
      if (interim) interim.remove();
    } else {
      // Обновить interim (предварительный)
      let interim = container.querySelector('.interim');
      if (!interim) {
        interim = document.createElement('div');
        interim.className = 'transcript-entry interim';
        container.appendChild(interim);
      }
      interim.textContent = transcript;
    }
  }

  _makeTranscriptEntry(text, isFinal, speaker) {
    const div = document.createElement('div');
    div.className = `transcript-entry ${isFinal ? 'final' : 'interim'}`;
    if (speaker !== null) {
      const label = document.createElement('div');
      label.className = `speaker-label speaker-${speaker % 4}`;
      label.textContent = `Спикер ${speaker + 1}`;
      div.appendChild(label);
    }
    const p = document.createElement('p');
    p.textContent = text;
    div.appendChild(p);
    return div;
  }

  _addHintCard({ text, priority, source, query }) {
    const id = ++this._hintCounter;
    const container = document.getElementById('hints-container');

    // Убрать пустое состояние
    const empty = container.querySelector('.empty-state');
    if (empty) empty.remove();

    const card = document.createElement('div');
    card.className = `hint-card ${priority || 'medium'}`;
    card.dataset.id = id;

    const icons = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
    card.innerHTML = `
      <div class="hint-header">
        <span>${icons[priority] || '⚪'} ${priority?.toUpperCase() || 'INFO'}</span>
        ${query ? `<span class="hint-query">${query}</span>` : ''}
        <button class="hint-close" onclick="this.closest('.hint-card').remove()">×</button>
      </div>
      <div class="hint-body">${text.replace(/\n/g, '<br>')}</div>
      ${source ? `<div class="hint-source">📎 ${source}</div>` : ''}
    `;

    // Добавить в начало
    container.insertBefore(card, container.firstChild);

    // Автоскрытие для низкоприоритетных
    if (priority === 'low' || priority === 'medium') {
      setTimeout(() => card.remove(), 25000);
    }

    this.hintCards.set(id, card);

    // Ограничить до 6 карточек
    const cards = container.querySelectorAll('.hint-card');
    if (cards.length > 6) cards[cards.length - 1].remove();
  }

  _updateKeywords(keywords) {
    const bar = document.getElementById('keywords-bar');
    // Оставить метку
    const label = bar.querySelector('span');
    bar.innerHTML = '';
    bar.appendChild(label);

    keywords.forEach(kw => {
      const chip = document.createElement('span');
      chip.className = 'keyword-chip';
      chip.textContent = kw;
      chip.title = `Кликните для поиска "${kw}"`;
      chip.onclick = () => this.hints?.query(kw);
      bar.appendChild(chip);
    });
  }

  _updateWsStatus(status) {
    const dot = document.getElementById('ws-dot');
    const label = document.getElementById('ws-status');
    const map = {
      connected: ['green', 'Подключено'],
      connecting: ['yellow', 'Подключение...'],
      disconnected: ['red', 'Отключено'],
    };
    const [color, text] = map[status] || ['red', status];
    dot.className = `status-dot ${color}`;
    label.textContent = text;
  }

  _updateAudioStatus(status) {
    const dot = document.getElementById('audio-dot');
    const label = document.getElementById('audio-status');
    const map = {
      active: ['green', 'Захват аудио'],
      idle: ['red', 'Нет аудио'],
      error: ['red', 'Ошибка'],
    };
    const [color, text] = map[status] || ['red', status];
    dot.className = `status-dot ${color}`;
    label.textContent = text;
  }
}

// Запустить приложение
window.app = new App();
