/**
 * Overlay UI Manager
 * Плавающее окно подсказок с приоритетами и auto-dismiss.
 */

export class OverlayManager {
  constructor(options = {}) {
    this.containerId = options.containerId || 'ia-overlay';
    this.maxHints = options.maxHints || 5;
    this.autoHideDelay = options.autoHideDelay || 20000; // 20 сек
    this.position = options.position || 'bottom-right';

    this.hints = []; // {id, text, priority, source, timestamp, timerId}
    this._hintCounter = 0;
    this._container = null;
    this._transcriptEl = null;
    this._isMinimized = false;

    this._init();
  }

  _init() {
    // Создать контейнер если не существует
    let container = document.getElementById(this.containerId);
    if (!container) {
      container = document.createElement('div');
      container.id = this.containerId;
      document.body.appendChild(container);
    }
    this._container = container;
    this._render();
  }

  /**
   * Показать новую подсказку
   * @param {object} hint - {text, priority: 'critical'|'high'|'medium'|'low', source, query}
   */
  showHint(hint) {
    const id = ++this._hintCounter;
    const entry = {
      id,
      text: hint.text,
      priority: hint.priority || 'medium',
      source: hint.source || '',
      query: hint.query || '',
      timestamp: Date.now(),
      timerId: null,
    };

    // Добавить в начало (высший приоритет вверху)
    this.hints.unshift(entry);

    // Ограничить количество подсказок
    if (this.hints.length > this.maxHints) {
      const removed = this.hints.pop();
      if (removed.timerId) clearTimeout(removed.timerId);
    }

    // Авто-скрытие для низкоприоритетных
    if (entry.priority === 'low' || entry.priority === 'medium') {
      entry.timerId = setTimeout(() => this.removeHint(id), this.autoHideDelay);
    }

    this._renderHints();
    return id;
  }

  /**
   * Обновить строку транскрипции
   */
  updateTranscript(text, isFinal, speaker = null) {
    if (!this._transcriptEl) return;
    const speakerLabel = speaker !== null ? `<span class="ia-speaker">Спикер ${speaker + 1}:</span> ` : '';
    const className = isFinal ? 'ia-transcript-final' : 'ia-transcript-interim';
    this._transcriptEl.innerHTML = `<div class="${className}">${speakerLabel}${this._escapeHtml(text)}</div>`;
  }

  /**
   * Удалить подсказку по ID
   */
  removeHint(id) {
    const idx = this.hints.findIndex(h => h.id === id);
    if (idx === -1) return;
    if (this.hints[idx].timerId) clearTimeout(this.hints[idx].timerId);
    this.hints.splice(idx, 1);
    this._renderHints();
  }

  /**
   * Очистить все подсказки
   */
  clearAll() {
    this.hints.forEach(h => { if (h.timerId) clearTimeout(h.timerId); });
    this.hints = [];
    this._renderHints();
  }

  /**
   * Свернуть/развернуть оверлей
   */
  toggleMinimize() {
    this._isMinimized = !this._isMinimized;
    const body = this._container.querySelector('.ia-body');
    const btn = this._container.querySelector('.ia-minimize-btn');
    if (body) body.style.display = this._isMinimized ? 'none' : 'flex';
    if (btn) btn.textContent = this._isMinimized ? '▲' : '▼';
  }

  _render() {
    this._container.innerHTML = `
      <div class="ia-panel ia-pos-${this.position}">
        <div class="ia-header">
          <span class="ia-title">🎙 Interview Assistant</span>
          <div class="ia-controls">
            <span class="ia-status" id="ia-status">●</span>
            <button class="ia-minimize-btn" onclick="window.__iaOverlay.toggleMinimize()">▼</button>
            <button class="ia-close-btn" onclick="window.__iaOverlay.clearAll()">✕</button>
          </div>
        </div>
        <div class="ia-body">
          <div class="ia-transcript" id="ia-transcript">Ожидание речи...</div>
          <div class="ia-hints" id="ia-hints"></div>
        </div>
      </div>
    `;
    this._transcriptEl = document.getElementById('ia-transcript');
    window.__iaOverlay = this;
  }

  _renderHints() {
    const hintsEl = document.getElementById('ia-hints');
    if (!hintsEl) return;

    // Сортировать по приоритету
    const sorted = [...this.hints].sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.priority] || 2) - (order[b.priority] || 2);
    });

    hintsEl.innerHTML = sorted.map(hint => `
      <div class="ia-hint ia-hint-${hint.priority}" data-id="${hint.id}">
        <div class="ia-hint-header">
          <span class="ia-hint-priority ia-p-${hint.priority}">${this._priorityIcon(hint.priority)}</span>
          ${hint.query ? `<span class="ia-hint-query">${this._escapeHtml(hint.query)}</span>` : ''}
          <button class="ia-hint-close" onclick="window.__iaOverlay.removeHint(${hint.id})">×</button>
        </div>
        <div class="ia-hint-text">${this._escapeHtml(hint.text)}</div>
        ${hint.source ? `<div class="ia-hint-source">📎 ${this._escapeHtml(hint.source)}</div>` : ''}
      </div>
    `).join('');
  }

  setStatus(status) {
    // 'connected' | 'connecting' | 'disconnected' | 'processing'
    const el = document.getElementById('ia-status');
    if (!el) return;
    const colors = { connected: '#22c55e', connecting: '#f59e0b', disconnected: '#ef4444', processing: '#3b82f6' };
    el.style.color = colors[status] || '#6b7280';
    el.title = status;
  }

  _priorityIcon(priority) {
    return { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[priority] || '⚪';
  }

  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
