import { createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import theme from 'shiki/themes/monokai.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import json from 'shiki/langs/json.mjs';
import bash from 'shiki/langs/bash.mjs';
import python from 'shiki/langs/python.mjs';
import swift from 'shiki/langs/swift.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import html from 'shiki/langs/html.mjs';
import css from 'shiki/langs/css.mjs';
import diff from 'shiki/langs/diff.mjs';
import sql from 'shiki/langs/sql.mjs';

let highlighter: ReturnType<typeof createHighlighterCoreSync> | undefined;
/** 外部取得・HTML生成をせず、言語指定のあるコードのtokenだけを返す。 */
export function tokens(text: string, language: string) {
  if (!language || text.length > 16384 || text.split('\n').length > 500) return null;
  try {
    highlighter ??= createHighlighterCoreSync({
      themes: [theme], langs: [typescript, javascript, tsx, jsx, json, bash, python, swift, yaml, html, css, diff, sql],
      engine: createJavaScriptRegexEngine(),
    });
    if (!highlighter.getLoadedLanguages().includes(language)) return null;
    return highlighter.codeToTokens(text, { lang: language, theme: 'monokai' }).tokens;
  } catch { return null; }
}
