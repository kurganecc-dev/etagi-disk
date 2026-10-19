#!/bin/sh
# Локальный запуск «Файлов с Диска»: поднимает статический сервер и открывает Chrome.
cd "$(dirname "$0")" || exit 1
PORT=8777
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Порт $PORT уже занят — открываю существующий сервер."
else
  echo "Сервис: http://127.0.0.1:$PORT  (закройте это окно, чтобы остановить)"
  python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
fi
sleep 1
open -a "Google Chrome" "http://127.0.0.1:$PORT/index.html" 2>/dev/null || open "http://127.0.0.1:$PORT/index.html"
wait
