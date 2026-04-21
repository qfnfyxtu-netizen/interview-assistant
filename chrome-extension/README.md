# Chrome Extension — Zoom Interview Overlay

Браузерное расширение Chrome (Manifest V3) для реалтайм транскрипции и AI-подсказок в Zoom Web Client.

## Файлы

| Файл | Назначение |
|------|-----------|
| `manifest.json` | Конфигурация расширения MV3 |
| `background.js` | Service Worker — конфиг, tabCapture relay |
| `content.js` | Основная логика: захват аудио, WebSocket, оверлей |
| `overlay.css` | Стили тёмного минималистичного оверлея |
| `popup/` | UI настроек (API ключи, режим, TTS) |

## Захват аудио — 3 стратегии

1. **`getDisplayMedia({ preferCurrentTab })`** — захват вкладки Zoom со звуком (основной метод)
2. **`tabCapture` через background.js relay** — fallback
3. **`getUserMedia` микрофон** — last resort, только твой голос

## Установка

```
chrome://extensions → Developer mode → Load unpacked → папка chrome-extension/
```

## Зависимости

- Бэкенд: `../backend/server_zoom_proxy.py` (FastAPI + Deepgram WS proxy + Perplexity)
- Deepgram API key (STT)
- Perplexity API key (подсказки) или Claude через Anthropic

## Changelog

### v1.1 — аудио fix
- Заменён `getUserMedia` на `getDisplayMedia` с `preferCurrentTab`
- Добавлен `tabCapture` relay через background.js
- Исправлена ошибка `zcc: no permission` в Zoom Web Client
- 3-уровневый fallback для надёжности

### v1.0 — initial
- Реалтайм транскрипция через Deepgram Nova-2
- AI-подсказки через Perplexity sonar / Claude Sonnet
- Режимы: Интервью / Компас
- TTS: Web Speech API + ElevenLabs
