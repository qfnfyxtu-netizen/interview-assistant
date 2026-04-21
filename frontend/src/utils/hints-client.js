/**
 * Hints Client
 * Отправляет текст в backend, получает подсказки от Perplexity API.
 * Дебаунсинг + дедупликация для экономии запросов.
 */

export class HintsClient {
  constructor(options = {}) {
    this.backendUrl = options.backendUrl || 'http://localhost:8000';
    this.profile = options.profile || 'general';
    this.onHint = options.onHint || (() => {});
    this.onKeywords = options.onKeywords || (() => {});
    this.onProcessing = options.onProcessing || (() => {});

    this._debounceTimer = null;
    this._debounceMs = 2000;       // Ждать 2 сек тишины перед запросом
    this._sentTexts = new Set();   // Дедупликация
    this._buffer = [];             // Буфер незапрошенных сегментов
  }

  /**
   * Обработать новый финальный транскрипт
   */
  process(text) {
    if (!text || text.trim().length < 8) return;

    this._buffer.push(text);

    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      const combined = this._buffer.join(' ');
      this._buffer = [];
      this._fetchHints(combined);
    }, this._debounceMs);
  }

  /**
   * Принудительный запрос по конкретному тексту/ключевому слову
   */
  async query(text) {
    return this._fetchHints(text, true);
  }

  async _fetchHints(text, force = false) {
    const key = text.trim().toLowerCase().slice(0, 80);
    if (!force && this._sentTexts.has(key)) return;
    this._sentTexts.add(key);

    this.onProcessing(true);
    try {
      const resp = await fetch(`${this.backendUrl}/api/hints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, profile: this.profile }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();

      // Обновить ключевые слова
      if (data.keywords?.length) {
        this.onKeywords(data.keywords);
      }

      // Показать подсказки
      if (data.hints?.length) {
        data.hints.forEach(hint => this.onHint(hint));
      }
    } catch (err) {
      console.error('[HintsClient] Error:', err);
    } finally {
      this.onProcessing(false);
    }
  }
}
