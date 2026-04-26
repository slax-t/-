# SLAX React + Supabase

Простой запуск проекта после перевода с Firebase на Supabase и добавления React/Vite оболочки.

## Структура

- `index.html` - вход в React (Vite)
- `src/` - React оболочка
- `app.html` - основной интерфейс SLAX
- `script.js` - логика чата/голоса и работа с Supabase
- `style.css` - стили интерфейса
- `legacy.html` - резервная копия старой версии

## Запуск

```bash
npm install
npm run dev
```

## Переменные окружения

Используется `.env`:

```env
VITE_SUPABASE_URL=https://dqhvecotzsvnzdfwozgb.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_GpEKccLRvtua6-rbIJoaaw_HHwQblRR
```

## Важно по Supabase

В `script.js` добавлен совместимый слой API, чтобы сохранить старую логику (`addDoc`, `setDoc`, `onSnapshot` и т.д.) поверх Supabase.

Для полной работы нужны таблицы:

- `app_users`
- `messages`
- `voice_sessions`
- `voice_signals`

Если схемы в Supabase ещё нет, её нужно создать (минимум поля, которые использует `script.js`).
