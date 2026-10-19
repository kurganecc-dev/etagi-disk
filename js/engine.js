/* Файлы с Диска — движок «Этажи».
   Публичный API Яндекс.Диска: обход вложенных папок, поштучная загрузка,
   журнал ошибок, повтор, пропуск уже скачанного. Без зависимостей.
   Работает и в браузере, и в Node (для тестов). */

export const VERSION = '1.0.0';
export const API_URL = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const HOSTS = new Set(['disk.yandex.ru', 'disk.yandex.com', 'yadi.sk']);
const PAGE = 100;
const LIST_WORKERS = 4;
const MAX_ATTEMPTS = 3;
const IDLE_MS = 20000;   // если файл молчит дольше — соединение зависло, повторяем

export class DiskError extends Error {
  constructor(message, { code = 'UNKNOWN', status = 0, retryable = false, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'DiskError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

/* ---------- форматирование ---------- */

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 100 ? 0 : 1).replace('.', ',')} ${units[i]}`;
}

export function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function filesWord(n) { return plural(n, 'файл', 'файла', 'файлов'); }
export function foldersWord(n) { return plural(n, 'папка', 'папки', 'папок'); }

/* ---------- ссылка ---------- */

export function parsePublicLink(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new DiskError('Вставьте ссылку на Яндекс Диск.', { code: 'EMPTY' });
  }
  let u;
  try { u = new URL(input.trim()); }
  catch { throw new DiskError('Это не похоже на ссылку. Скопируйте адрес из браузера целиком.', { code: 'BAD_URL' }); }

  if (u.protocol !== 'https:' || u.username || u.password || u.port) {
    throw new DiskError('Нужна обычная ссылка https://… без пароля и порта.', { code: 'BAD_URL' });
  }
  if (!HOSTS.has(u.hostname)) {
    throw new DiskError('Поддерживаются ссылки disk.yandex.ru, disk.yandex.com и yadi.sk.', { code: 'BAD_HOST' });
  }
  const m = u.pathname.match(/^\/(d|i)\/([A-Za-z0-9_-]{4,})(.*)$/);
  if (!m) {
    throw new DiskError('Это не публичная ссылка. Нужна ссылка вида https://disk.yandex.ru/d/…', { code: 'BAD_PATH' });
  }
  const kind = m[1] === 'i' ? 'file' : 'dir';
  let rest = m[3] || '';
  try { rest = decodeURIComponent(rest); }
  catch { throw new DiskError('В ссылке повреждена кодировка пути.', { code: 'BAD_PATH' }); }
  const parts = rest.split('/').map(s => s.trim()).filter(Boolean);
  if (parts.some(p => p === '.' || p === '..' || /[\\:*?"<>|]/.test(p))) {
    throw new DiskError('В ссылке недопустимый путь.', { code: 'BAD_PATH' });
  }
  return {
    publicKey: `https://disk.yandex.ru/${m[1]}/${m[2]}`,
    kind,
    path: parts.length ? '/' + parts.join('/') : '/',
    source: input.trim()
  };
}

/* ---------- запросы к API ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiURL(publicKey, path, { download = false, offset = 0 } = {}) {
  const u = new URL(API_URL + (download ? '/download' : ''));
  u.searchParams.set('public_key', publicKey);
  u.searchParams.set('path', path || '/');
  if (!download) {
    u.searchParams.set('limit', String(PAGE));
    u.searchParams.set('offset', String(offset));
    u.searchParams.set('sort', 'name');
  }
  return u.href;
}

function yandexMessage(status, body) {
  const code = body?.error || '';
  if (status === 404 || code === 'ResourceNotFound') return 'Файл или папка недоступны: ссылка закрыта, объект удалён или скрыт владельцем.';
  if (status === 403 || code === 'Forbidden') return 'Яндекс не разрешает доступ к этому объекту. Проверьте, что папка открыта по ссылке.';
  if (status === 429 || code === 'TooManyRequests') return 'Яндекс ограничил частоту запросов. Подождите и продолжите — уже скачанное не пропадёт.';
  if (status === 401) return 'Ссылка больше не публичная: владелец закрыл доступ.';
  if (status >= 500) return `Сервер Яндекса ответил ошибкой ${status}. Обычно помогает повтор позже.`;
  if (code === 'FieldValidationError') return 'Яндекс не принял параметры запроса. Проверьте ссылку.';
  return body?.message || `Яндекс ответил ошибкой ${status}.`;
}

async function requestJSON(url, { signal, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    let res;
    try {
      res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      if (attempt <= MAX_ATTEMPTS) { onRetry?.(attempt); await sleep(600 * attempt); continue; }
      throw new DiskError('Нет связи с Яндекс Диском: браузер не получил ответ. Проверьте интернет и повторите.', { code: 'NETWORK', retryable: true });
    }
    if (res.ok) {
      try { return await res.json(); }
      catch { throw new DiskError('Яндекс вернул неожиданный ответ. Возможно, ссылка ведёт не на Диск.', { code: 'BAD_JSON', status: res.status }); }
    }
    let body = null;
    try { body = await res.json(); } catch { /* тело может быть пустым */ }
    const status = res.status;
    const retryable = status === 429 || status >= 500;
    const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 0, 30);
    if (retryable && attempt <= MAX_ATTEMPTS) {
      onRetry?.(attempt, retryAfter);
      await sleep(retryAfter ? retryAfter * 1000 : 700 * attempt);
      continue;
    }
    throw new DiskError(yandexMessage(status, body), {
      code: status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'HTTP_' + status,
      status, retryable, retryAfter
    });
  }
}

export async function statResource(publicKey, path = '/', { signal } = {}) {
  const url = apiURL(publicKey, path);
  const data = await requestJSON(url, { signal });
  return normalizeResource(data);
}

function normalizeResource(it) {
  return {
    name: it.name,
    path: it.path,
    type: it.type,
    size: it.size ?? null,
    md5: it.md5 || null,
    mime: it.mime_type || null,
    modified: it.modified || null
  };
}

async function listFolder(publicKey, path, { signal, onRetry } = {}) {
  const out = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const data = await requestJSON(apiURL(publicKey, path, { offset }), { signal, onRetry });
    const embedded = data._embedded || {};
    const items = (embedded.items || []).map(normalizeResource);
    out.push(...items);
    total = embedded.total ?? out.length;
    if (!items.length) break;
    offset += items.length;
  }
  return out;
}

function relativePath(abs, root) {
  if (!root || root === '/') return abs.replace(/^\/+/, '');
  const prefix = root.replace(/\/+$/, '');
  if (abs === prefix) return '';
  return abs.startsWith(prefix + '/') ? abs.slice(prefix.length + 1) : abs.replace(/^\/+/, '');
}

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

/* Путь из Диска не должен выводить за пределы выбранной папки: ‘..’, пустые
   сегменты, управляющие символы и слишком длинные имена отбрасываем. */
export function relProblem(rel) {
  if (typeof rel !== 'string' || !rel) return 'пустой путь';
  if (rel.length > 1024) return 'слишком длинный путь';
  for (const part of rel.split('/')) {
    if (!part) return 'пустой сегмент';
    if (part === '.' || part === '..') return 'переход по ..';
    if (/[\u0000-\u001f\u007f]/.test(part)) return 'управляющие символы';
    if (part.length > 255) return 'слишком длинное имя';
  }
  return null;
}

export function assertRelPath(rel) {
  const problem = relProblem(rel);
  if (problem) {
    throw new DiskError(`Недопустимое имя файла (${problem}): ${String(rel).slice(0, 80)}`, { code: 'BAD_NAME' });
  }
  return rel;
}

/* Обход публичной папки: возвращает дерево файлов и общую статистику. */
export async function scanFolder({ publicKey, path = '/', signal, onProgress } = {}) {
  const rootRes = await statResource(publicKey, path, { signal });

  if (rootRes.type === 'file') {
    const file = { ...rootRes, rel: rootRes.name, path: rootRes.path };
    return { root: { name: rootRes.name, type: 'file', path }, files: [file], folders: 0, bytes: file.size || 0 };
  }

  const files = [];
  const invalid = [];
  let folders = 0;
  let level = [path];

  while (level.length) {
    const next = [];
    for (let i = 0; i < level.length; i += LIST_WORKERS) {
      const chunk = level.slice(i, i + LIST_WORKERS);
      await Promise.all(chunk.map(async dirPath => {
        const items = await listFolder(publicKey, dirPath, { signal });
        for (const it of items) {
          const rel = relativePath(it.path, path);
          if (!rel) continue;
          if (it.type === 'dir') {
            folders++;
            next.push(it.path);
          } else if (relProblem(rel)) {
            invalid.push(rel);
          } else {
            files.push({ ...it, rel });
          }
        }
      }));
      onProgress?.({ folders, files: files.length });
    }
    level = next;
  }

  files.sort((a, b) => collator.compare(a.rel, b.rel));
  const bytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  return {
    root: { name: rootRes.name, type: 'dir', path },
    files,
    folders,
    bytes,
    invalid: invalid.length,
    invalidNames: invalid.slice(0, 5),
    publicKey,
    source: `https://disk.yandex.ru/d/${publicKey.split('/').pop()}`
  };
}

/* Прямая ссылка на файл (живёт недолго — берём её прямо перед загрузкой). */
export async function fileHref(publicKey, path, { signal } = {}) {
  const data = await requestJSON(apiURL(publicKey, path, { download: true }), { signal });
  if (!data.href) throw new DiskError('Яндекс не выдал ссылку на файл.', { code: 'NO_HREF' });
  return data.href;
}

/* ---------- приёмники файлов ---------- */

/* Недокачанный файл никогда не должен выглядеть готовым: пишем во временный
   «*.etagi-part» и только после успешного закрытия переименовываем. */
export const PART_SUFFIX = '.etagi-part';

export class FolderSink {
  constructor(rootHandle, { overwrite = true } = {}) {
    this.kind = 'folder';
    this.root = rootHandle;
    this.name = rootHandle.name || 'выбранная папка';
    this.overwrite = overwrite;
  }

  async locate(rel, { create = false } = {}) {
    assertRelPath(rel);
    const parts = rel.split('/');
    const name = parts.pop();
    let dir = this.root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name };
  }

  /* Готовым считаем только файл, чей размер совпадает с Диском. */
  async exists(rel, item) {
    try {
      const { dir, name } = await this.locate(rel);
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      if (item?.size != null) return file.size === item.size;
      return file.size > 0;
    } catch { return false; }
  }

  async removePartial(rel) {
    try {
      const { dir, name } = await this.locate(rel);
      await dir.removeEntry(name + PART_SUFFIX);
    } catch { /* нечего убирать */ }
  }

  async write(rel, response, item) {
    const { dir, name } = await this.locate(rel, { create: true });
    const tmpName = name + PART_SUFFIX;
    try { await dir.removeEntry(tmpName); } catch { /* старый огрызок */ }

    const tmp = await dir.getFileHandle(tmpName, { create: true });
    try {
      const writable = await tmp.createWritable({ keepExistingData: false });
      if (response.body) await response.body.pipeTo(writable);
      else { await writable.write(await response.arrayBuffer()); await writable.close(); }
    } catch (err) {
      try { await dir.removeEntry(tmpName); } catch { /* уже нет */ }
      throw mapFsError(err);
    }

    await commitFile(dir, tmp, name, tmpName);
    return true;
  }

  async writeText(fileName, text) {
    const handle = await this.root.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }
}

async function commitFile(dir, handle, name, tmpName) {
  try {
    const move = typeof handle.move === 'function' ? handle.move.bind(handle) : null;
    if (move) {
      try { await move(name); return; }
      catch { /* имя занято или move не поддержан — пробуем иначе */ }
      try { await dir.removeEntry(name); await move(name); return; }
      catch { /* переходим к копированию */ }
    }
    const source = await handle.getFile();
    const target = await dir.getFileHandle(name, { create: true });
    const writable = await target.createWritable({ keepExistingData: false });
    try {
      if (source.stream) await source.stream().pipeTo(writable);
      else { await writable.write(await source.arrayBuffer()); await writable.close(); }
    } catch (err) {
      try { await dir.removeEntry(name); } catch { /* ok */ }
      throw mapFsError(err);
    }
  } catch (err) {
    // рабочий файл не создан — временный не должен остаться в папке
    try { await dir.removeEntry(tmpName); } catch { /* уже нет */ }
    throw err instanceof DiskError ? err : mapFsError(err);
  }
  try { await dir.removeEntry(tmpName); } catch { /* уже нет */ }
}

function mapFsError(err) {
  if (err?.name === 'QuotaExceededError' || err?.name === 'NotEnoughSpaceError') {
    return new DiskError('На диске закончилось место. Освободите место и повторите ошибки.', { code: 'NO_SPACE' });
  }
  if (err?.name === 'AbortError') return err;
  return new DiskError('Не удалось записать файл в выбранную папку: ' + (err?.message || 'ошибка доступа'), { code: 'FS_WRITE' });
}

export class DownloadsSink {
  constructor() {
    this.kind = 'downloads';
    this.name = 'Загрузки браузера';
    this.pending = 0;
  }
  async exists() { return false; }
  async write(rel, response) {
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    // структуру сохраняет только выбор папки; имя чистим от служебных символов
    const safe = assertRelPath(rel).split('/').join(' · ')
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').slice(0, 200) || 'файл';
    a.href = url;
    a.download = safe;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    this.pending++;
    setTimeout(() => { URL.revokeObjectURL(url); this.pending--; }, 60000);
    return true;
  }
}

/* Приёмник для тестов: считает байты и хеши, ничего не пишет на диск. */
export class CaptureSink {
  constructor(files = []) { this.kind = 'memory'; this.name = 'memory'; this.files = new Map(); this.bytes = 0; this.existing = new Set(files); }
  async exists(rel) { return this.existing.has(rel); }
  async write(rel, response) {
    const buf = new Uint8Array(await response.arrayBuffer());
    this.files.set(rel, buf);
    this.bytes += buf.byteLength;
    return true;
  }
}

/* ---------- прогон загрузки ---------- */

export class DownloadRun {
  constructor({ publicKey, files, sink, concurrency = 5, skipExisting = true, onUpdate } = {}) {
    this.publicKey = publicKey;
    this.sink = sink;
    this.concurrency = Math.max(1, Math.min(50, Number(concurrency) || 1));
    this.skipExisting = skipExisting;
    this.onUpdate = onUpdate || (() => {});
    this.phase = 'idle';
    this.paused = false;
    this.stopped = false;
    this.controller = new AbortController();
    this.resumeWaiters = [];
    this.errors = [];
    this.startedAt = null;
    this.finishedAt = null;
    this.bytesTotal = 0;
    this.items = files.map(f => ({
      rel: f.rel, path: f.path, name: f.name, size: f.size ?? null, md5: f.md5 || null,
      status: 'pending', loaded: 0, attempts: 0, error: null, code: null
    }));
    for (const it of this.items) this.bytesTotal += it.size || 0;
  }

  get counts() {
    const c = { total: this.items.length, done: 0, failed: 0, skipped: 0, active: 0, pending: 0, stopped: 0, bytesDone: 0 };
    for (const it of this.items) {
      if (it.status === 'done') { c.done++; c.bytesDone += it.size || it.loaded || 0; }
      else if (it.status === 'failed') { c.failed++; }
      else if (it.status === 'skipped') { c.skipped++; c.bytesDone += it.size || 0; }
      else if (it.status === 'active') { c.active++; c.bytesDone += it.loaded || 0; }
      else if (it.status === 'stopped') { c.stopped++; }
      else c.pending++;
    }
    return c;
  }

  snapshot() {
    return {
      phase: this.phase, paused: this.paused, stopped: this.stopped,
      counts: this.counts, bytesTotal: this.bytesTotal,
      errors: this.errors.slice(), sink: this.sink?.kind || null
    };
  }

  emit() { this.onUpdate(this.snapshot()); }

  async start() {
    if (this.phase !== 'idle') return;
    this.phase = 'running';
    this.startedAt = new Date();
    this.emit();
    const workers = Array.from({ length: this.concurrency }, () => this.worker());
    await Promise.all(workers);
    this.phase = this.stopped ? 'stopped' : this.counts.failed ? 'finished-with-errors' : 'done';
    this.finishedAt = new Date();
    this.emit();
  }

  pause() {
    if (this.phase !== 'running') return;
    this.paused = true;
    this.emit();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    const waiters = this.resumeWaiters.splice(0);
    waiters.forEach(fn => fn());
    this.emit();
  }

  stop() {
    if (this.phase !== 'running' && this.phase !== 'paused') return;
    this.stopped = true;
    this.paused = false;
    this.controller.abort();
    this.resumeWaiters.splice(0).forEach(fn => fn());
    for (const it of this.items) if (it.status === 'pending') { it.status = 'stopped'; it.error = 'Остановлено'; it.code = 'STOPPED'; }
    this.emit();
  }

  next() { return this.items.find(it => it.status === 'pending'); }

  async waitIfPaused() {
    if (!this.paused || this.stopped) return;
    await new Promise(resolve => this.resumeWaiters.push(resolve));
  }

  async worker() {
    for (;;) {
      if (this.stopped) return;
      await this.waitIfPaused();
      if (this.stopped) return;
      const item = this.next();
      if (!item) return;
      await this.fetchOne(item);
    }
  }

  async fetchOne(item) {
    item.status = 'active';
    item.loaded = 0;
    this.emit();
    try {
      if (this.skipExisting && this.sink?.exists && await this.sink.exists(item.rel, item)) {
        item.status = 'skipped';
        item.loaded = item.size || 0;
        this.emit();
        return;
      }
      await this.attempt(item);
      item.status = 'done';
      item.error = null;
      item.code = null;
    } catch (err) {
      if (this.stopped || err?.name === 'AbortError') {
        item.status = 'stopped';
        item.error = 'Остановлено';
        item.code = 'STOPPED';
      } else {
        item.status = 'failed';
        item.error = err?.message || 'Неизвестная ошибка';
        item.code = err?.code || 'UNKNOWN';
        this.errors.push({
          rel: item.rel, path: item.path, size: item.size,
          message: item.error, code: item.code, attempts: item.attempts,
          at: new Date().toISOString()
        });
      }
    }
    this.emit();
  }

  async attempt(item) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      item.attempts = attempt;
      item.loaded = 0;
      const ctrl = new AbortController();
      let stalled = false;
      let idleTimer = 0;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { stalled = true; ctrl.abort(); }, IDLE_MS);
      };
      const onStop = () => ctrl.abort();
      this.controller.signal.addEventListener('abort', onStop, { once: true });
      try {
        armIdle();
        const href = await fileHref(this.publicKey, item.path, { signal: ctrl.signal });
        let res;
        try {
          res = await fetch(href, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        } catch (err) {
          if (this.stopped || err?.name === 'AbortError') throw err;
          throw new DiskError('Браузер не смог получить файл: сервер Яндекса не разрешил чтение или пропала сеть.', { code: 'NETWORK', retryable: true });
        }
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 0, 30);
          throw new DiskError(yandexMessage(res.status, null), {
            code: res.status === 429 ? 'RATE_LIMIT' : res.status >= 500 ? 'SERVER' : 'HTTP_' + res.status,
            status: res.status, retryable, retryAfter
          });
        }
        const expected = item.size;
        let received = 0;
        const body = res.body
          ? res.body.pipeThrough(new TransformStream({
              transform: (chunk, ctrlStream) => {
                received += chunk.byteLength;
                item.loaded = received;
                armIdle();
                this.progressTick();
                ctrlStream.enqueue(chunk);
              }
            }))
          : null;
        if (!body && expected) item.loaded = expected;
        await this.sink.write(item.rel, new Response(body, { headers: res.headers }), item);
        item.loaded = received || expected || 0;
        if (expected && received && received !== expected) {
          throw new DiskError(`Пришло ${formatBytes(received)} вместо ${formatBytes(expected)}: файл скачался не полностью.`, { code: 'SIZE_MISMATCH', retryable: true });
        }
        return;
      } catch (err) {
        if (this.stopped) throw err;
        if (stalled) {
          lastError = new DiskError('Соединение с Яндексом зависло: файл не докачался. Повторите из журнала.', { code: 'STALL', retryable: true });
        } else {
          lastError = err;
        }
        if (err?.name === 'AbortError' && !stalled) throw err;
        const retryable = lastError?.retryable === true || ['NETWORK', 'SERVER', 'STALL', 'SIZE_MISMATCH'].includes(lastError?.code);
        if (!retryable || attempt === MAX_ATTEMPTS) break;
        const wait = lastError.retryAfter ? lastError.retryAfter * 1000 : 700 * attempt * attempt;
        await sleep(Math.min(wait, 20000));
      } finally {
        clearTimeout(idleTimer);
        this.controller.signal.removeEventListener('abort', onStop);
      }
    }
    throw lastError || new DiskError('Не удалось скачать файл.', { code: 'UNKNOWN' });
  }

  progressTick() {
    const now = Date.now();
    if (now - (this._lastEmit || 0) < 150) return;
    this._lastEmit = now;
    this.emit();
  }
}

/* ---------- журнал ---------- */

export function makeReport(run, meta = {}) {
  const c = run.counts;
  return {
    tool: 'Файлы с Диска · Этажи',
    version: VERSION,
    createdAt: new Date().toISOString(),
    link: meta.link || null,
    folder: meta.folder || null,
    destination: meta.destination || run.sink?.name || null,
    stats: {
      files: c.total, done: c.done, failed: c.failed, skipped: c.skipped, stopped: c.stopped,
      bytes: run.bytesTotal
    },
    errors: run.errors,
    failed: run.items.filter(it => it.status === 'failed' || it.status === 'stopped').map(it => ({
      rel: it.rel, path: it.path, size: it.size, code: it.code, message: it.error
    }))
  };
}

export function parseReport(text) {
  if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) {
    throw new DiskError('Журнал слишком большой или пустой — выберите файл отчёта «Файлов с Диска».', { code: 'BAD_REPORT' });
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new DiskError('Это не журнал «Файлов с Диска»: файл повреждён или выбран не тот JSON.', { code: 'BAD_REPORT' }); }
  if (!data || !Array.isArray(data.failed)) {
    throw new DiskError('В журнале нет списка файлов для повтора.', { code: 'BAD_REPORT' });
  }
  if (data.failed.length > 20000) {
    throw new DiskError('В журнале больше 20 000 файлов — сервис не возьмётся за такой повтор.', { code: 'BAD_REPORT' });
  }
  const link = typeof data.link === 'string' && data.link.length < 2048 ? data.link : null;
  let invalid = 0;
  const failed = data.failed
    .filter(f => f && typeof f.path === 'string' && typeof f.rel === 'string')
    .filter(f => {
      if (relProblem(f.rel)) { invalid++; return false; }
      return true;
    })
    .map(f => ({ rel: f.rel, path: f.path, size: Number.isFinite(f.size) ? f.size : null, name: f.rel.split('/').pop() }));
  return { link, folder: typeof data.folder === 'string' ? data.folder.slice(0, 200) : null, failed, invalid };
}

/* Человекочитаемый отчёт: его же сохраняем в папку рядом с файлами. */
export function reportText(report) {
  const s = report.stats || {};
  const when = report.createdAt ? new Date(report.createdAt).toLocaleString('ru-RU') : '—';
  const lines = [
    'Файлы с Диска · Этажи — отчёт о загрузке',
    `Когда: ${when}`,
    `Ссылка: ${report.link || '—'}`,
    `Папка: ${report.folder || '—'}`,
    `Куда: ${report.destination || '—'}`,
    '',
    `Всего файлов: ${s.files ?? 0}`,
    `Скачано: ${s.done ?? 0}`,
    `Пропущено (уже были): ${s.skipped ?? 0}`,
    `На месте в папке: ${(s.done ?? 0) + (s.skipped ?? 0)} из ${s.files ?? 0}`,
    `Не скачалось: ${(s.failed ?? 0) + (s.stopped ?? 0)}`,
    `Объём папки: ${formatBytes(s.bytes || 0)}`
  ];
  const failed = report.failed || [];
  if (failed.length) {
    lines.push('', 'Не скачалось:');
    for (const f of failed) {
      lines.push(`— ${f.rel}${f.size != null ? ` · ${formatBytes(f.size)}` : ''}`);
      lines.push(`    ${f.code || 'UNKNOWN'}: ${f.message || 'без описания'}`);
    }
    lines.push('', 'Откройте этот отчёт в сервисе кнопкой «Продолжить позже» — он возьмёт только эти файлы.');
  } else {
    lines.push('', 'Все файлы скачаны полностью.');
  }
  return lines.join('\n');
}
