/**
 * Audio Capture Module
 * Захватывает аудио из системы через Web Audio API.
 * Поддерживает: микрофон, виртуальный кабель (loopback), tab audio.
 */

export class AudioCapture {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 16000; // Deepgram требует 16kHz
    this.bufferSize = options.bufferSize || 4096;
    this.onAudioData = options.onAudioData || (() => {});
    this.onError = options.onError || console.error;

    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.isCapturing = false;
  }

  /**
   * Перечислить доступные аудиоустройства
   */
  async listDevices() {
    await navigator.mediaDevices.getUserMedia({ audio: true }); // запросить разрешение
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput').map(d => ({
      id: d.deviceId,
      label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
    }));
  }

  /**
   * Начать захват аудио
   * @param {string|null} deviceId - ID устройства (null = по умолчанию)
   * @param {'microphone'|'loopback'|'tab'} mode - режим захвата
   */
  async start(deviceId = null, mode = 'microphone') {
    try {
      if (mode === 'tab') {
        // Захват вкладки (Chrome/Edge: getDisplayMedia с audio)
        this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: false,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            sampleRate: this.sampleRate,
          },
        });
      } else {
        // Микрофон или виртуальный кабель (loopback)
        const constraints = {
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: mode !== 'loopback',
            noiseSuppression: mode !== 'loopback',
            autoGainControl: mode !== 'loopback',
            sampleRate: this.sampleRate,
            channelCount: 1,
          },
        };
        this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      }

      this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      // ScriptProcessorNode для извлечения PCM-данных
      // (В продакшене заменить на AudioWorklet для лучшей производительности)
      this.processorNode = this.audioContext.createScriptProcessor(
        this.bufferSize,
        1, // input channels
        1  // output channels
      );

      this.processorNode.onaudioprocess = (event) => {
        if (!this.isCapturing) return;
        const inputData = event.inputBuffer.getChannelData(0);
        // Конвертировать Float32 → Int16 (LINEAR16 для Deepgram)
        const pcm16 = this._float32ToInt16(inputData);
        this.onAudioData(pcm16);
      };

      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.audioContext.destination);

      this.isCapturing = true;
      console.log(`[AudioCapture] Started in '${mode}' mode, sampleRate=${this.sampleRate}`);
      return true;
    } catch (err) {
      this.onError(`[AudioCapture] Failed to start: ${err.message}`);
      return false;
    }
  }

  /**
   * Остановить захват
   */
  stop() {
    this.isCapturing = false;
    if (this.processorNode) this.processorNode.disconnect();
    if (this.sourceNode) this.sourceNode.disconnect();
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
    console.log('[AudioCapture] Stopped');
  }

  /**
   * Конвертация Float32Array → Int16Array (LINEAR16 PCM)
   */
  _float32ToInt16(float32Array) {
    const int16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const clamped = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }
    return int16;
  }
}
