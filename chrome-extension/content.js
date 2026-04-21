/**
 * content.js — Content Script
 * Захват аудио → Deepgram → транскрипт → AI подсказки → оверлей
 *
 * Архитектура:
 *   AudioCapture → WebSocket(backend/ws/deepgram) → TranscriptBuffer → HintEngine → Overlay
 */

'use strict';

// ── Состояние ─────────────────────────────────────────────────────────────────
const state = {
  active: false,
  config: null,
  ws: null,
  audioCtx: null,
  processor: null,
  mediaStream: null,
  lastFinalTranscript: '',
  transcriptBuffer: '',
  hintTimer: null,
  utteranceCount: 0,
  isConnecting: false,
  silenceTimer: null,
  vuRafId: null,
  paused: false,
  autoPaused: false,   // true если пауза сработала автоматически
  analyser: null,
};

// Константы авто-паузы
const AUTO_PAUSE_SILENCE_MS = 5000; // мс тишины до паузы
const AUTO_RESUME_SIGNAL_MS = 300;  // мс звука до возобновления
const SILENCE_RMS_THRESHOLD = 0.005; // RMS ниже этого = тишина

// ── Загрузка конфига ──────────────────────────────────────────────────────────
async function loadConfig() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, config => {
      state.config = config;
      resolve(config);
    });
  });
}

// ── Инициализация оверлея ─────────────────────────────────────────────────────
function initOverlay() {
  if (document.getElementById('zia-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'zia-overlay';
  overlay.innerHTML = `
    <div id="zia-header">
      <span id="zia-logo">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/>
          <path d="M12 7v5l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <circle cx="12" cy="12" r="2" fill="currentColor"/>
        </svg>
      </span>
      <span id="zia-title">Interview AI</span>
      <div id="zia-vu-meter" title="Уровень аудио">
        <div class="zia-vu-bar"></div>
        <div class="zia-vu-bar"></div>
        <div class="zia-vu-bar"></div>
        <div class="zia-vu-bar"></div>
        <div class="zia-vu-bar"></div>
      </div>
      <div id="zia-status-dot" class="status-idle" title="Idle"></div>
      <button id="zia-pause" title="Пауза (Alt+Shift+P)" class="hidden">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <rect x="6" y="4" width="4" height="16" fill="currentColor"/>
          <rect x="14" y="4" width="4" height="16" fill="currentColor"/>
        </svg>
      </button>
      <button id="zia-toggle" title="Включить/выключить (Alt+Shift+I)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M5 3l14 9-14 9V3z" fill="currentColor"/>
        </svg>
      </button>
      <button id="zia-close" title="Скрыть">×</button>
    </div>

    <div id="zia-transcript-area">
      <div id="zia-transcript-label">ТРАНСКРИПТ</div>
      <div id="zia-transcript-text" class="placeholder">Ожидание речи собеседника...</div>
    </div>

    <div id="zia-hint-area">
      <div id="zia-hint-label">
        <span id="zia-mode-badge">КОМПАС</span>
        <button id="zia-mode-toggle" title="Переключить режим">⇄</button>
      </div>
      <div id="zia-hint-text" class="placeholder">Подсказки появятся здесь...</div>
      <div id="zia-keywords"></div>
      <button id="zia-tts-btn" title="Озвучить подсказку" class="hidden">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor"/>
          <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div id="zia-footer">
      <span id="zia-latency"></span>
      <span id="zia-utterance-count"></span>
    </div>

    <div id="zia-resize-handle"></div>
  `;

  document.body.appendChild(overlay);
  applyPosition();
  bindOverlayEvents();
  console.log('[ZIA] Overlay initialized');
}

function applyPosition() {
  const overlay = document.getElementById('zia-overlay');
  if (!overlay) return;
  const pos = state.config?.overlayPosition || 'bottom-right';
  overlay.className = `zia-pos-${pos}`;
}

// ── Drag & Drop ───────────────────────────────────────────────────────────────
function makeDraggable() {
  const overlay = document.getElementById('zia-overlay');
  const header = document.getElementById('zia-header');
  if (!overlay || !header) return;

  let startX, startY, startLeft, startTop, dragging = false;

  header.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = overlay.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    overlay.style.transition = 'none';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    overlay.style.left = `${startLeft + dx}px`;
    overlay.style.top = `${startTop + dy}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.userSelect = '';
    overlay.style.transition = '';
  });
}

// ── Привязка событий оверлея ──────────────────────────────────────────────────
function bindOverlayEvents() {
  document.getElementById('zia-toggle').addEventListener('click', toggleCapture);
  document.getElementById('zia-pause').addEventListener('click', togglePause);
  document.getElementById('zia-close').addEventListener('click', () => {
    document.getElementById('zia-overlay').classList.add('zia-hidden');
  });
  document.getElementById('zia-mode-toggle').addEventListener('click', toggleMode);
  document.getElementById('zia-tts-btn').addEventListener('click', speakCurrentHint);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.altKey && e.shiftKey && e.key === 'I') {
      e.preventDefault();
      const overlay = document.getElementById('zia-overlay');
      overlay?.classList.toggle('zia-hidden');
    }
    if (e.altKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      togglePause();
    }
  });

  makeDraggable();
}

function toggleMode() {
  if (!state.config) return;
  state.config.mode = state.config.mode === 'interview' ? 'compass' : 'interview';
  const badge = document.getElementById('zia-mode-badge');
  if (badge) badge.textContent = state.config.mode === 'interview' ? 'ИНТЕРВЬЮ' : 'КОМПАС';
  chrome.runtime.sendMessage({ type: 'SET_CONFIG', config: state.config });
}

// ── UI Update helpers ─────────────────────────────────────────────────────────
function setStatus(status) {
  const dot = document.getElementById('zia-status-dot');
  if (!dot) return;
  dot.className = `status-${status}`;
  const labels = {
    idle: 'Ожидание',
    connecting: 'Подключение...',
    listening: 'Слушаю',
    processing: 'Обработка...',
    error: 'Ошибка'
  };
  dot.title = labels[status] || status;
}

function updateTranscript(text, isFinal) {
  const el = document.getElementById('zia-transcript-text');
  if (!el) return;
  el.classList.remove('placeholder');
  el.textContent = text;
  if (isFinal) {
    el.classList.add('transcript-final');
    setTimeout(() => el.classList.remove('transcript-final'), 600);
  }
}

function showHint(data) {
  const hintEl = document.getElementById('zia-hint-text');
  const kwEl = document.getElementById('zia-keywords');
  const ttsBtn = document.getElementById('zia-tts-btn');
  if (!hintEl) return;

  hintEl.classList.remove('placeholder', 'hint-fresh');

  // Определяем текст подсказки
  let hintText = '';
  if (data.hint) {
    hintText = data.hint;
  } else if (data.compass) {
    hintText = `📍 ${data.topic || ''}\n${data.compass}`;
    if (data.risk) hintText += `\n⚠️ ${data.risk}`;
  }

  hintEl.textContent = hintText;
  void hintEl.offsetWidth; // trigger reflow для анимации
  hintEl.classList.add('hint-fresh');

  // Keywords
  const kws = data.keywords || [];
  if (kwEl) {
    kwEl.innerHTML = kws.map(k => `<span class="zia-kw">${k}</span>`).join('');
  }

  // TTS кнопка
  if (ttsBtn && state.config?.ttsEnabled) {
    ttsBtn.classList.remove('hidden');
    ttsBtn.dataset.text = hintText;
  }

  // Счётчик задержки
  if (data._latency) {
    const latEl = document.getElementById('zia-latency');
    if (latEl) latEl.textContent = `${data._latency}ms`;
  }
}

function showLoading() {
  const hintEl = document.getElementById('zia-hint-text');
  if (hintEl) {
    hintEl.classList.remove('placeholder');
    hintEl.innerHTML = '<span class="zia-loading">●●●</span>';
  }
}

// ── Захват аудио ──────────────────────────────────────────────────────────────
// Стратегия: пробуем методы по очереди
//   1. getDisplayMedia({ preferCurrentTab }) — захват вкладки со звуком (лучший вариант)
//   2. tabCapture через background.js relay
//   3. getUserMedia fallback (работает вне Zoom)
async function startAudioCapture() {
  // Стратегия 1: getDisplayMedia preferCurrentTab
  // Позволяет захватить аудио текущей вкладки (включая Zoom WebAssembly audio)
  // Требует выбора пользователем вкладки в диалоге — один раз
  try {
    updateTranscript('Выбери текущую вкладку Zoom в диалоге → нажми "Поделиться"', false);

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1, frameRate: 1 }, // минимальное видео (обязательно для диалога)
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        sampleRate: 16000,
      },
      preferCurrentTab: true, // Chrome 94+ — предлагает текущую вкладку первой
    });

    // Убедимся что есть аудиодорожка
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error('Аудио не захвачено — при выборе вкладки включи галочку "Поделиться звуком вкладки"');
    }

    // Останавливаем видео — нам нужен только звук
    stream.getVideoTracks().forEach(t => t.stop());

    // Создаём AudioContext только с аудио-треком
    const audioOnlyStream = new MediaStream(audioTracks);
    state.mediaStream = audioOnlyStream;
    state.audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = state.audioCtx.createMediaStreamSource(audioOnlyStream);

    // AnalyserNode для определения тишины и VU-метра
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    state.analyser = analyser;
    source.connect(analyser);

    state.processor = state.audioCtx.createScriptProcessor(4096, 1, 1);
    state.processor.onaudioprocess = (e) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.paused) return;
      const float32 = e.inputBuffer.getChannelData(0);
      state.ws.send(float32ToPCM16(float32));
    };

    analyser.connect(state.processor);
    state.processor.connect(state.audioCtx.destination);

    // Если пользователь остановил шеринг — автостоп
    audioTracks[0].addEventListener('ended', () => {
      console.log('[ZIA] Tab audio track ended');
      if (state.active) stopCapture();
    });

    // Запускаем VU-метр
    startVuMeter(analyser);

    updateTranscript('Захват вкладки активен. Говорите...', false);
    console.log('[ZIA] Tab audio capture started via getDisplayMedia');

    // ── Silence detection: если через 5 сек аудио всё ещё тихое → fallback ──
    state.silenceTimer = setTimeout(async () => {
      state.silenceTimer = null;
      if (!state.active) return;

      const timeDomain = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(timeDomain);
      const maxLevel = timeDomain.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      console.log('[ZIA] Silence check — max level:', maxLevel.toFixed(4));

      if (maxLevel < 0.01) {
        console.log('[ZIA] Tab audio is silent — attempting whole-screen fallback');
        updateTranscript('Вкладка тихая — выбери «Весь экран» и включи «Поделиться системным звуком»', false);

        // Останавливаем текущий стрим и аудио-граф
        if (state.processor) { state.processor.disconnect(); state.processor = null; }
        if (state.audioCtx) { await state.audioCtx.close().catch(() => {}); state.audioCtx = null; }
        if (state.mediaStream) { state.mediaStream.getTracks().forEach(t => t.stop()); state.mediaStream = null; }

        // Fallback: захват всего экрана с системным звуком
        // Без preferCurrentTab → Chrome покажет «Весь экран» / «Окно» / «Вкладка"
        // Пользователь должен выбрать «Весь экран» и включить "Поделиться системным звуком"
        try {
          const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: 1, height: 1, frameRate: 1 },
            audio: {
              channelCount: 1,
              echoCancellation: false,
              noiseSuppression: false,
              sampleRate: 16000,
            },
            // НЕТ preferCurrentTab — браузер предложит «Весь экран» первым
          });

          const screenAudio = screenStream.getAudioTracks();
          if (screenAudio.length === 0) {
            screenStream.getTracks().forEach(t => t.stop());
            updateTranscript('Системный звук не захвачен. Включи галочку «Поделиться системным звуком» при выборе экрана.', true);
            return;
          }

          // Останавливаем видео
          screenStream.getVideoTracks().forEach(t => t.stop());

          const screenAudioStream = new MediaStream(screenAudio);
          state.mediaStream = screenAudioStream;
          state.audioCtx = new AudioContext({ sampleRate: 16000 });
          const screenSource = state.audioCtx.createMediaStreamSource(screenAudioStream);

          // AnalyserNode для VU-метра (fallback)
          const screenAnalyser = state.audioCtx.createAnalyser();
          screenAnalyser.fftSize = 2048;
          state.analyser = screenAnalyser;
          screenSource.connect(screenAnalyser);

          state.processor = state.audioCtx.createScriptProcessor(4096, 1, 1);
          state.processor.onaudioprocess = (e) => {
            if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.paused) return;
            state.ws.send(float32ToPCM16(e.inputBuffer.getChannelData(0)));
          };
          screenAnalyser.connect(state.processor);
          state.processor.connect(state.audioCtx.destination);

          screenAudio[0].addEventListener('ended', () => {
            console.log('[ZIA] Screen audio track ended');
            if (state.active) stopCapture();
          });

          // Запускаем VU-метр для системного звука
          stopVuMeter(); // сбрасываем предыдущий если был
          startVuMeter(screenAnalyser);

          updateTranscript('Захват системного звука активен. Говорите...', false);
          console.log('[ZIA] Screen audio capture started (fallback)');
        } catch (fbErr) {
          console.warn('[ZIA] Screen capture fallback failed:', fbErr.message);
          if (fbErr.name !== 'NotAllowedError') {
            updateTranscript(`Ошибка захвата экрана: ${fbErr.message}`, true);
          } else {
            updateTranscript('Захват системного звука отменён. Нажми ▶ снова.', false);
          }
        }
      } else {
        console.log('[ZIA] Audio level OK — silence check passed');
      }
    }, 5000);

    return true;

  } catch (err) {
    console.warn('[ZIA] getDisplayMedia failed:', err.message);

    // Если пользователь отменил диалог — не падаем на fallback
    if (err.name === 'NotAllowedError' && err.message.includes('denied')) {
      setStatus('idle');
      updateTranscript('Захват отменён. Нажми ▶ снова и выбери вкладку.', false);
      return false;
    }

    // Если нет аудио в стриме — показываем инструкцию
    if (err.message.includes('Поделиться звуком')) {
      setStatus('error');
      updateTranscript(err.message, true);
      return false;
    }
  }

  // Стратегия 2: tabCapture через background (relay)
  try {
    updateTranscript('Пробую захват через расширение...', false);
    const streamId = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GET_TAB_STREAM_ID' }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp?.error) return reject(new Error(resp.error));
        resolve(resp?.streamId);
      });
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        }
      },
      video: false
    });

    state.mediaStream = stream;
    state.audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = state.audioCtx.createMediaStreamSource(stream);
    state.processor = state.audioCtx.createScriptProcessor(4096, 1, 1);
    state.processor.onaudioprocess = (e) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.paused) return;
      state.ws.send(float32ToPCM16(e.inputBuffer.getChannelData(0)));
    };
    source.connect(state.processor);
    state.processor.connect(state.audioCtx.destination);

    console.log('[ZIA] Tab audio via tabCapture relay');
    return true;
  } catch (err) {
    console.warn('[ZIA] tabCapture relay failed:', err.message);
  }

  // Стратегия 3: getUserMedia — работает для микрофона (не Zoom-аудио)
  try {
    updateTranscript('Захват микрофона (только твой голос)...', false);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      video: false
    });
    state.mediaStream = stream;
    state.audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = state.audioCtx.createMediaStreamSource(stream);
    state.processor = state.audioCtx.createScriptProcessor(4096, 1, 1);
    state.processor.onaudioprocess = (e) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.paused) return;
      state.ws.send(float32ToPCM16(e.inputBuffer.getChannelData(0)));
    };
    source.connect(state.processor);
    state.processor.connect(state.audioCtx.destination);
    console.log('[ZIA] Microphone capture (fallback)');
    updateTranscript('Микрофон захвачен. Говори вслух — будет транскрибироваться твоя речь.', false);
    return true;
  } catch (err) {
    console.error('[ZIA] All audio methods failed:', err);
    setStatus('error');
    updateTranscript(`Ошибка захвата аудио: ${err.message}`, true);
    return false;
  }
}

// ── VU-метр ───────────────────────────────────────────────────────────────────
// Читает данные из AnalyserNode через requestAnimationFrame и обновляет 5 баров
function startVuMeter(analyser) {
  const meter = document.getElementById('zia-vu-meter');
  if (!meter) return;
  const bars = meter.querySelectorAll('.zia-vu-bar');
  meter.classList.add('vu-active');

  const bufLen = analyser.frequencyBinCount; // fftSize / 2
  const dataArr = new Float32Array(bufLen);
  const MAX_H = 14; // px — максимальная высота бара

  // Аккумуляторы для детектии тишины / звука
  let silenceAccMs = 0;  // накопленное время тишины (ms)
  let signalAccMs = 0;   // накопленное время звука (ms)
  let lastTs = performance.now();

  function tick() {
    state.vuRafId = requestAnimationFrame(tick);

    const now = performance.now();
    const dt = now - lastTs;
    lastTs = now;

    analyser.getFloatTimeDomainData(dataArr);

    // RMS amplitude за текущий буфер
    let sum = 0;
    for (let i = 0; i < bufLen; i++) sum += dataArr[i] * dataArr[i];
    const rms = Math.sqrt(sum / bufLen);
    const isSilent = rms < SILENCE_RMS_THRESHOLD;

    // ── Авто-пауза / возобновление ──
    if (!state.paused) {
      // Считаем время тишины
      if (isSilent) {
        silenceAccMs += dt;
        signalAccMs = 0;
        if (silenceAccMs >= AUTO_PAUSE_SILENCE_MS) {
          silenceAccMs = 0;
          state.autoPaused = true;
          autoPauseCapture();
          // tick продолжает работать: rAF запущен, но VU не рисуется (см. ниже)
        }
      } else {
        silenceAccMs = 0;
      }
    } else if (state.autoPaused) {
      // Ожидаем звук для авто-возобновления
      if (!isSilent) {
        signalAccMs += dt;
        if (signalAccMs >= AUTO_RESUME_SIGNAL_MS) {
          signalAccMs = 0;
          silenceAccMs = 0;
          state.autoPaused = false;
          autoResumeCapture();
        }
      } else {
        signalAccMs = 0;
      }
    }

    // ── Отрисовка баров (VU) ──
    if (!state.paused) {
      const norm = Math.min(1, rms * 8);
      const level = Math.pow(norm, 0.5);
      bars.forEach((bar, i) => {
        const threshold = (i + 1) / bars.length;
        const active = level >= threshold;
        const h = active ? Math.round(MAX_H * (threshold + 0.05)) : 3;
        bar.style.height = h + 'px';
        bar.classList.remove('vu-low', 'vu-mid', 'vu-high');
        if (active) {
          if (i < 2)      bar.classList.add('vu-low');
          else if (i < 4) bar.classList.add('vu-mid');
          else            bar.classList.add('vu-high');
        }
      });
    }
  }

  tick();
}

function stopVuMeter() {
  if (state.vuRafId) {
    cancelAnimationFrame(state.vuRafId);
    state.vuRafId = null;
  }
  const meter = document.getElementById('zia-vu-meter');
  if (meter) {
    meter.classList.remove('vu-active');
    meter.querySelectorAll('.zia-vu-bar').forEach(b => {
      b.style.height = '3px';
      b.classList.remove('vu-low', 'vu-mid', 'vu-high');
    });
  }
}

function float32ToPCM16(float32Array) {
  const buf = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function stopAudioCapture() {
  // Останавливаем VU-метр
  stopVuMeter();

  // Отменяем silence detection timer если он ещё активен
  if (state.silenceTimer) {
    clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
  }
  if (state.processor) {
    state.processor.disconnect();
    state.processor = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }
  state.analyser = null;
  console.log('[ZIA] Audio capture stopped');
}

// ── WebSocket к бэкенду (Deepgram proxy) ─────────────────────────────────────
function connectWebSocket() {
  if (state.isConnecting) return;
  state.isConnecting = true;

  const backendUrl = state.config?.backendUrl || 'http://localhost:8000';
  const wsUrl = backendUrl.replace(/^http/, 'ws') + '/ws/deepgram';

  console.log('[ZIA] Connecting to', wsUrl);
  setStatus('connecting');

  state.ws = new WebSocket(wsUrl);
  state.ws.binaryType = 'arraybuffer';

  state.ws.onopen = () => {
    state.isConnecting = false;
    setStatus('listening');
    console.log('[ZIA] WebSocket connected');
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    } catch (e) {
      console.warn('[ZIA] WS parse error:', e);
    }
  };

  state.ws.onerror = (err) => {
    console.error('[ZIA] WebSocket error:', err);
    setStatus('error');
    updateTranscript('Ошибка подключения к серверу. Запустите бэкенд на порту 8000.', true);
    state.isConnecting = false;
  };

  state.ws.onclose = () => {
    state.isConnecting = false;
    // Переподключаемся только если активны И ещё нет открытого WS
    if (state.active && (!state.ws || state.ws.readyState === WebSocket.CLOSED)) {
      setStatus('connecting');
      setTimeout(() => {
        if (state.active) connectWebSocket();
      }, 3000);
    }
  };
}

function handleServerMessage(data) {
  if (data.type === 'transcript') {
    // Лог для отладки — виден при фильтре ZIA
    console.log(`[ZIA] transcript${data.is_final ? ' [FINAL]' : ''}:`, data.text);
    updateTranscript(data.text, data.is_final);

    if (data.is_final && data.text.trim().length > 10) {
      state.transcriptBuffer += ' ' + data.text.trim();
      state.lastFinalTranscript = data.text.trim();
    }
  }

  if (data.type === 'utterance_end') {
    // Пауза после фразы — запрашиваем подсказку
    const text = state.transcriptBuffer.trim();
    if (text.length > 15) {
      clearTimeout(state.hintTimer);
      state.hintTimer = setTimeout(() => {
        requestHint(text);
        state.transcriptBuffer = '';
        state.utteranceCount++;
        const countEl = document.getElementById('zia-utterance-count');
        if (countEl) countEl.textContent = `#${state.utteranceCount}`;
      }, state.config?.hintDelay || 1500);
    }
  }

  if (data.type === 'error') {
    setStatus('error');
    updateTranscript(`Ошибка: ${data.message}`, true);
  }
}

// ── Запрос подсказки ──────────────────────────────────────────────────────────
async function requestHint(transcript) {
  const backendUrl = state.config?.backendUrl || 'http://localhost:8000';
  const t0 = Date.now();

  setStatus('processing');
  showLoading();

  try {
    const res = await fetch(`${backendUrl}/api/hint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript,
        mode: state.config?.mode || 'interview',
        language: 'ru'
      })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    data._latency = Date.now() - t0;
    showHint(data);
    setStatus('listening');

    // Авто-TTS если включён
    if (state.config?.ttsEnabled) {
      const text = data.hint || data.compass || '';
      if (text) await speakText(text);
    }
  } catch (err) {
    console.error('[ZIA] Hint error:', err);
    setStatus('listening');
    const hintEl = document.getElementById('zia-hint-text');
    if (hintEl) hintEl.textContent = `Ошибка: ${err.message}`;
  }
}

// ── TTS ───────────────────────────────────────────────────────────────────────
async function speakText(text) {
  const voice = state.config?.ttsVoice || 'browser';

  if (voice === 'browser') {
    // Web Speech API — работает без API ключа
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'ru-RU';
    utt.rate = 1.2;
    utt.pitch = 1.0;
    // Выбрать русский голос
    const voices = window.speechSynthesis.getVoices();
    const ruVoice = voices.find(v => v.lang.startsWith('ru'));
    if (ruVoice) utt.voice = ruVoice;
    window.speechSynthesis.speak(utt);
    return;
  }

  // ElevenLabs TTS через бэкенд
  const backendUrl = state.config?.backendUrl || 'http://localhost:8000';
  try {
    const res = await fetch(`${backendUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error('TTS failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = 0.7;
    audio.onended = () => URL.revokeObjectURL(url);
    audio.play();
  } catch (err) {
    console.warn('[ZIA] TTS error, falling back to browser:', err);
    speakText(text); // рекурсия с browser voice
    state.config.ttsVoice = 'browser';
  }
}

function speakCurrentHint() {
  const btn = document.getElementById('zia-tts-btn');
  const text = btn?.dataset.text;
  if (text) speakText(text);
}

// ── Основной переключатель ────────────────────────────────────────────────────
async function toggleCapture() {
  if (!state.active) {
    await startCapture();
  } else {
    await stopCapture();
  }
}

// ── Авто-пауза / авто-возобновление ─────────────────────────────────────────
// Вызывается из startVuMeter tick(), не рвёт WS и стрим
function autoPauseCapture() {
  if (!state.active || state.paused) return;
  state.paused = true;

  // НЕ останавливаем rAF (тик должен слушать звук для авто-возобновления)
  // Только гасим визуальную часть VU-метра
  const vuMeter = document.getElementById('zia-vu-meter');
  if (vuMeter) {
    vuMeter.classList.remove('vu-active');
    vuMeter.querySelectorAll('.zia-vu-bar').forEach(b => {
      b.style.height = '3px';
      b.classList.remove('vu-low', 'vu-mid', 'vu-high');
    });
  }
  setStatus('idle');

  const overlay = document.getElementById('zia-overlay');
  overlay?.classList.add('zia-paused');

  const pauseBtn = document.getElementById('zia-pause');
  if (pauseBtn) {
    pauseBtn.classList.add('paused-active');
    pauseBtn.title = 'Возобновить (Alt+Shift+P)';
    pauseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M5 3l14 9-14 9V3z" fill="currentColor"/>
    </svg>`;
  }

  updateTranscript('⏸ Тишина — Deepgram приостановлен. Звук возобновит запись.', false);
  console.log('[ZIA] Auto-paused: silence > ' + AUTO_PAUSE_SILENCE_MS + 'ms');
}

function autoResumeCapture() {
  if (!state.active || !state.paused) return;
  state.paused = false;

  const overlay = document.getElementById('zia-overlay');
  overlay?.classList.remove('zia-paused');

  const pauseBtn = document.getElementById('zia-pause');
  if (pauseBtn) {
    pauseBtn.classList.remove('paused-active');
    pauseBtn.title = 'Пауза (Alt+Shift+P)';
    pauseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <rect x="6" y="4" width="4" height="16" fill="currentColor"/>
      <rect x="14" y="4" width="4" height="16" fill="currentColor"/>
    </svg>`;
  }

  // VU-метр уже работает (тик продолжался в фоне), только возвращаем визуал
  const vuMeter = document.getElementById('zia-vu-meter');
  if (vuMeter) vuMeter.classList.add('vu-active');

  setStatus('listening');
  updateTranscript('Звук обнаружен — запись возобновлена. Говорите...', false);
  console.log('[ZIA] Auto-resumed: signal detected');
}

// ── Пауза / Возобновление ────────────────────────────────────────────────────
// Пауза НЕ рвёт WebSocket и не останавливает MediaStream:
// просто перестаём отправлять PCM-данные в Deepgram и гасим VU-метр.
function pauseCapture() {
  if (!state.active || state.paused) return;
  state.paused = true;

  stopVuMeter();
  setStatus('idle');

  const overlay = document.getElementById('zia-overlay');
  overlay?.classList.add('zia-paused');

  const pauseBtn = document.getElementById('zia-pause');
  if (pauseBtn) {
    pauseBtn.classList.add('paused-active');
    pauseBtn.title = 'Возобновить (Alt+Shift+P)';
    pauseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M5 3l14 9-14 9V3z" fill="currentColor"/>
    </svg>`;
  }

  updateTranscript('⏸ Пауза — аудио не передаётся', false);
  console.log('[ZIA] Capture paused');
}

function resumeCapture() {
  if (!state.active || !state.paused) return;
  state.paused = false;
  state.autoPaused = false; // сбрасываем флаг авто-паузы

  const overlay = document.getElementById('zia-overlay');
  overlay?.classList.remove('zia-paused');

  const pauseBtn = document.getElementById('zia-pause');
  if (pauseBtn) {
    pauseBtn.classList.remove('paused-active');
    pauseBtn.title = 'Пауза (Alt+Shift+P)';
    pauseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <rect x="6" y="4" width="4" height="16" fill="currentColor"/>
      <rect x="14" y="4" width="4" height="16" fill="currentColor"/>
    </svg>`;
  }

  // Перезапускаем VU-метр если есть AnalyserNode
  if (state.analyser) startVuMeter(state.analyser);

  setStatus('listening');
  updateTranscript('Захват возобновлён. Говорите...', false);
  console.log('[ZIA] Capture resumed');
}

function togglePause() {
  if (!state.active) return;
  state.paused ? resumeCapture() : pauseCapture();
}

async function startCapture() {
  state.active = true;
  const toggleBtn = document.getElementById('zia-toggle');
  if (toggleBtn) {
    toggleBtn.title = 'Остановить';
    toggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <rect x="6" y="4" width="4" height="16" fill="currentColor"/>
      <rect x="14" y="4" width="4" height="16" fill="currentColor"/>
    </svg>`;
  }

  setStatus('connecting');

  const audioOk = await startAudioCapture();
  if (!audioOk) {
    state.active = false;
    return;
  }

  // Показываем кнопку паузы
  const pauseBtn = document.getElementById('zia-pause');
  if (pauseBtn) pauseBtn.classList.remove('hidden');

  connectWebSocket();
  console.log('[ZIA] Capture started');
}

async function stopCapture() {
  state.active = false;
  state.paused = false;
  state.autoPaused = false;

  // Скрываем кнопку паузы и сбрасываем состояние оверлея
  const pauseBtn = document.getElementById('zia-pause');
  if (pauseBtn) {
    pauseBtn.classList.add('hidden');
    pauseBtn.classList.remove('paused-active');
    pauseBtn.title = 'Пауза (Alt+Shift+P)';
    pauseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <rect x="6" y="4" width="4" height="16" fill="currentColor"/>
      <rect x="14" y="4" width="4" height="16" fill="currentColor"/>
    </svg>`;
  }
  document.getElementById('zia-overlay')?.classList.remove('zia-paused');

  if (state.ws) {
    try {
      state.ws.send(JSON.stringify({ type: 'CloseStream' }));
    } catch (e) {}
    setTimeout(() => {
      if (state.ws) state.ws.close();
      state.ws = null;
    }, 500);
  }

  stopAudioCapture();
  clearTimeout(state.hintTimer);
  setStatus('idle');

  const toggleBtn = document.getElementById('zia-toggle');
  if (toggleBtn) {
    toggleBtn.title = 'Запустить';
    toggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M5 3l14 9-14 9V3z" fill="currentColor"/>
    </svg>`;
  }

  console.log('[ZIA] Capture stopped');
}

// ── Сообщения от background script ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CONFIG_UPDATED') {
    state.config = msg.config;
    applyPosition();
    const modeBadge = document.getElementById('zia-mode-badge');
    if (modeBadge) {
      modeBadge.textContent = state.config.mode === 'interview' ? 'ИНТЕРВЬЮ' : 'КОМПАС';
    }
    if (msg.config.active !== state.active) {
      toggleCapture();
    }
  }
  if (msg.type === 'TOGGLE_OVERLAY') {
    document.getElementById('zia-overlay')?.classList.toggle('zia-hidden');
  }
});

// ── Точка входа ───────────────────────────────────────────────────────────────
(async function init() {
  await loadConfig();
  initOverlay();

  const badge = document.getElementById('zia-mode-badge');
  if (badge) badge.textContent = state.config?.mode === 'interview' ? 'ИНТЕРВЬЮ' : 'КОМПАС';

  console.log('[ZIA] Content script initialized', state.config);
})();
