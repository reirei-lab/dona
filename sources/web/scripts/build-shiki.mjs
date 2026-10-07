import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import theme from 'shiki/themes/monokai.mjs';

// 固定依存から単一のbrowser bundleを生成し、既存のCSP hash内に同梱する。
const result = await build({
  entryPoints: [fileURLToPath(new URL('./shiki-browser.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'DonaShiki',
  platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline',
});
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const colors = [...new Set((JSON.stringify(theme).match(/#[0-9a-f]{6}(?:[0-9a-f]{2})?/gi) || []).map(color => color.toLowerCase()))];
const styles = colors.map(color => `.shiki-token.shiki-${color.slice(1)}{color:${color}}`).join('\n')
  + '\n.shiki-italic{font-style:italic}.shiki-bold{font-weight:700}.shiki-underline{text-decoration:underline}\n';
const directory = new URL('../src/generated/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('shiki-bundle.ts', directory),
  '// 自動生成。npm run generate:shikiで再生成する。\n'
  + `export const shikiScript = ${JSON.stringify(script)};\nexport const shikiStyles = ${JSON.stringify(styles)};\n`);
