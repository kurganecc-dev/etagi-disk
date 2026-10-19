/* Сборка одного файла etagi-disk.html: шрифты, логотипы, стили и скрипты внутрь.
   Запуск: node build.mjs */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const read = p => readFile(new URL(p, import.meta.url), 'utf8');
const b64 = async (p, type) => `data:${type};base64,${Buffer.from(await readFile(new URL(p, import.meta.url))).toString('base64')}`;

let css = await read('./css/app.css');
for (const [file, type] of [
  ['assets/fonts/circe-Light.woff2', 'font/woff2'],
  ['assets/fonts/circe-Regular.woff2', 'font/woff2'],
  ['assets/fonts/circe-Bold.woff2', 'font/woff2'],
  ['assets/fonts/circe-Extrabold.woff2', 'font/woff2']
]) {
  css = css.replaceAll(`../${file}`, await b64(file, type));
}

const engine = (await read('./js/engine.js')).replace(/^export /gm, '');
const app = (await read('./js/app.js')).replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/engine\.js';\s*/m, '');

const styleBlock = `\n${css}\n`;
const scriptBlock = `\n/* ---- движок ---- */\n${engine}\n/* ---- интерфейс ---- */\n${app}\n`;

let html = await read('./index.html');
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '');
html = html.replace(/<link rel="stylesheet" href="css\/app\.css[^"]*">/, `<style>${styleBlock}</style>`);
html = html.replace(/<script type="module" src="js\/app\.js[^"]*"><\/script>/, `<script>${scriptBlock}</script>`);

const logoWhite = await b64('assets/logo/logo-etagi-white.png', 'image/png');
const favicon = await b64('assets/logo/favicon.png', 'image/png');
html = html.replaceAll('assets/logo/logo-etagi-white.png', logoWhite);
html = html.replaceAll('assets/logo/favicon.png', favicon);
html = html.replace(/<link rel="preload"[^>]*>\s*/, '');

/* Строгий CSP со сверкой хешей: в автономном файле иначе пришлось бы разрешать unsafe-inline. */
const sha = s => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const csp = [
  "default-src 'none'",
  `script-src ${sha(scriptBlock)}`,
  `style-src ${sha(styleBlock)}`,
  'img-src data:',
  'font-src data:',
  'connect-src https://cloud-api.yandex.net https://downloader.disk.yandex.ru https://*.storage.yandex.net https://*.yandex.net https://*.yandex.ru https://*.yandex.com',
  "base-uri 'none'"
].join('; ');
html = html.replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);

if (/src="assets|href="assets|src="js|href="css/.test(html)) {
  throw new Error('В сборке остались внешние ссылки — проверьте replace');
}
if (!html.includes('Content-Security-Policy')) {
  throw new Error('CSP не попал в сборку');
}

await writeFile(new URL('./etagi-disk.html', import.meta.url), html);
console.log('etagi-disk.html:', (Buffer.byteLength(html) / 1024).toFixed(0), 'КБ');
