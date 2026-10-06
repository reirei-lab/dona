import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// 固定した依存を同梱し、CDNや外部のスクリプト取得を必要としない。
const require = createRequire(import.meta.url);
export const markdownLibrary = readFileSync(join(dirname(require.resolve('marked/package.json')), 'lib/marked.umd.js'), 'utf8').replace(/<\/script/gi, '<\\/script');

// HTML文字列を挿入せず、許可したtokenだけをDOMへ変換する。
export const markdownRenderer = String.raw`
function highlightedCode(text,info) {
  const pre=node('pre'),code=node('code');pre.append(code);
  const language=String(info||'').trim().split(/\s+/)[0].toLowerCase();
  const tokens=DonaShiki.tokens(text,language);
  if(!tokens||tokens.map(line=>line.map(token=>token.content).join('')).join('\n')!==text){code.textContent=text;return pre;}
  pre.dataset.highlighter='shiki';pre.dataset.language=language;
  tokens.forEach((line,index)=>{
    if(index)code.append(document.createTextNode('\n'));
    for(const token of line){
      const span=node('span',token.content,'shiki-token');
      if(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(token.color||''))span.classList.add('shiki-'+token.color.slice(1).toLowerCase());
      if(token.fontStyle&1)span.classList.add('shiki-italic');if(token.fontStyle&2)span.classList.add('shiki-bold');if(token.fontStyle&4)span.classList.add('shiki-underline');
      code.append(span);
    }
  });
  return pre;
}
function markdown(text) {
  const root=node('div',undefined,'markdown');
  function append(parent,tokens,depth=0) {
    if(depth>40) {parent.append(document.createTextNode(tokens.map(t=>t.raw||t.text||'').join('')));return;}
    for(const t of tokens) {
      let element;
      switch(t.type) {
        case 'space': continue;
        case 'checkbox': element=node('input');element.type='checkbox';element.disabled=true;element.checked=t.checked;element.setAttribute('aria-label',t.checked?'完了':'未完了');break;
        case 'html': parent.append(document.createTextNode(t.raw));continue;
        case 'image': parent.append(document.createTextNode(t.text||''));continue;
        case 'text': case 'escape':
          if(t.tokens)append(parent,t.tokens,depth+1);else parent.append(document.createTextNode(t.text||''));continue;
        case 'code': element=String(t.lang||'').trim().toLowerCase()==='mermaid'?mermaidBlock(t.text):highlightedCode(t.text,t.lang);break;
        case 'codespan': element=node('code',t.text);break;
        case 'hr': element=node('hr');break;
        case 'br': element=node('br');break;
        case 'heading': element=node('h'+Math.min(6,t.depth+2));append(element,t.tokens,depth+1);break;
        case 'paragraph': case 'blockquote': case 'strong': case 'em': case 'del':
          element=node(({paragraph:'p'})[t.type]||t.type);append(element,t.tokens,depth+1);break;
        case 'link': {
          element=node('span');
          try {const url=new URL(t.href);if(['https:','http:','mailto:'].includes(url.protocol)&&!url.username&&!url.password){element=node('a');element.href=url.href;element.target='_blank';element.rel='noopener noreferrer';}}
          catch {}
          append(element,t.tokens,depth+1);break;
        }
        case 'list':
          element=node(t.ordered?'ol':'ul');if(t.ordered)element.start=t.start;
          for(const item of t.items){const li=node('li');append(li,item.tokens,depth+1);element.append(li);}break;
        case 'table': {
          element=node('div',undefined,'table-scroll');element.tabIndex=0;element.setAttribute('role','region');element.setAttribute('aria-label','メッセージのテーブル');
          const table=node('table'),head=node('thead'),body=node('tbody'),row=node('tr');
          const cell=(tag,c,index)=>{const n=node(tag);if(tag==='th')n.scope='col';if(t.align[index])n.className='align-'+t.align[index];append(n,c.tokens,depth+1);return n;};
          t.header.forEach((c,i)=>row.append(cell('th',c,i)));head.append(row);
          for(const cells of t.rows){const tr=node('tr');cells.forEach((c,i)=>tr.append(cell('td',c,i)));body.append(tr);}table.append(head,body);element.append(table);break;
        }
        default: parent.append(document.createTextNode(t.raw||t.text||''));continue;
      }
      parent.append(element);
    }
  }
  try {append(root,marked.lexer(String(text),{gfm:true,breaks:true}));}
  catch {root.replaceChildren(node('pre',text));}
  return root;
}
`;
