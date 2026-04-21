/**
 * Deepgram WebSocket Client
 * Стриминг аудио → транскрипция с диаризацией спикеров.
 * Проксирует через локальный backend (чтобы не светить API-ключ в браузере).
 */

export class DeepgramClient {
  constructor(options = {}) {
    this.backendWsUrl = options.backendWsUrl || 'ws://localhost:8000/ws/transcribe';
    this.onTranscript = options.onTranscript || (() => {});
    this.onError = options.onError || console.error;
    this.onStatusChange = options.onStatusChange || (() => {});

    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
    this.isConnected = false;

    // Буфер для накопления аудио во время переподключения
    this._audioBuffer = [];
  }

  /**
   * Подключиться к WebSocket proxy на backend
   */
  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.onStatusChange('connecting');
    this.ws = new WebSocket(this.backendWsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.onStatusChange('connected');
      console.log('[DeepgramClient] Connected to backend WebSocket proxy');

      // Отправить накопленный буфер
      this._audioBuffer.forEach(chunk => this.send(chunk));
      this._audioBuffer = [];
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this._handleMessage(data);
      } catch (e) {
        this.onError(`[DeepgramClient] Parse error: ${e.message}`);
      }
    };

    this.ws.onerror = (err) => {
      this.onError(`[DeepgramClient] WebSocket error`);
    };

    this.ws.onclose = (event) => {
      this.isConnected = false;
      this.onStatusChange('disconnected');
      console.log(`[DeepgramClient] Closed: code=${event.code}`);

      // Автоматическое переподключение
      if (this.reconnectAttempts < this.maxReconnects) {
        const delay = Math.pow(2, this.reconnectAttempts) * 1000; // exponential backoff
        this.reconnectAttempts++;
        console.log(`[DeepgramClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
      }
    };
  }

  /**
   * Отправить аудио-чанк (Int16Array)
   */
  send(int16Array) {
    if (!this.isConnected) {
      this._audioBuffer.push(int16Array);
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(int16Array.buffer);
    }
  }

  /**
   * Закрыть соединение
   */
  close() {
    this.maxReconnects = 0; // отключить переподключение
    if (this.ws) this.ws.close();
  }

  /**
   * Обработать входящее сообщение от Deepgram (через proxy)
   */
  _handleMessage(data) {
    // Стандартный формат ответа Deepgram
    if (data.type === 'Results') {
      const channel = data.channel;
      if (!channel) return;

      const alternative = channel.alternatives?.[0];
      if (!alternative || !alternative.transcript) return;

      const isFinal = data.is_final;
      const transcript = alternative.transcript;

      // Диаризация: извлечь слова со спикерами
      const words = alternative.words || [];
      const speakerSegments = this._extractSpeakerSegments(words);

      this.onTranscript({
        transcript,
        isFinal,
        confidence: alternative.confidence || 0,
        speakers: speakerSegments,
        timestamp: data.start || 0,
        duration: data.duration || 0,
      });
    } else if (data.type === 'error') {
      this.onError(`[Deepgram] ${data.message}`);
    }
  }

  /**
   * Извлечь сегменты по спикерам из массива слов
   * Возвращает [{speaker: 0, text: "...", start: 1.2, end: 3.4}, ...]
   */
  _extractSpeakerSegments(words) {
    if (!words.length) return [];

    const segments = [];
    let current = { speaker: words[0].speaker || 0, words: [words[0].word], start: words[0].start, end: words[0].end };

    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      const speaker = w.speaker || 0;
      if (speaker === current.speaker) {
        current.words.push(w.word);
        current.end = w.end;
      } else {
        segments.push({ speaker: current.speaker, text: current.words.join(' '), start: current.start, end: current.end });
        current = { speaker, words: [w.word], start: w.start, end: w.end };
      }
    }
    segments.push({ speaker: current.speaker, text: current.words.join(' '), start: current.start, end: current.end });
    return segments;
  }
}
