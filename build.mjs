/* Сборка одного файла etagi-disk.html: шрифты, логотипы, стили и скрипты внутрь.
   Запуск: node build.mjs */
import { readFile, writeFile } from 'node:fs/promises';

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

let html = await read('./index.html');
html = html.replace(/<link rel="stylesheet" href="css\/app\.css[^"]*">/, `<style>\n${css}\n</style>`);
html = html.replace(/<script type="module" src="js\/app\.js[^"]*"><\/script>/,
  `<script>\n/* ---- движок ---- */\n${engine}\n/* ---- интерфейс ---- */\n${app}\n</script>`);

const logoWhite = await b64('assets/logo/logo-etagi-white.png', 'image/png');
const favicon = await b64('assets/logo/favicon.png', 'image/png');
html = html.replaceAll('assets/logo/logo-etagi-white.png', logoWhite);
html = html.replaceAll('assets/logo/favicon.png', favicon);
html = html.replace(/<link rel="preload"[^>]*>\s*/, '');

if (/src="assets|href="assets|src="js|href="css/.test(html)) {
  throw new Error('В сборке остались внешние ссылки — проверьте replace');
}

await writeFile(new URL('./etagi-disk.html', import.meta.url), html);
console.log('etagi-disk.html:', (Buffer.byteLength(html) / 1024).toFixed(0), 'КБ');
