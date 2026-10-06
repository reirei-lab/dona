/** App Serverの差分を、安全なDOMだけで表示する。 */
export const diffRenderer = String.raw`
function fileDiff(file,key,open) {
  const box=node('details',undefined,'file-diff');box.dataset.itemDetail=key;box.open=open.has(key);
  const summary=node('summary'),moved=file.change==='update'&&file.move_path;
  summary.append(node('span',moved?'移動':({add:'追加',delete:'削除',update:'更新'})[file.change],'diff-kind'),node('span',file.path+(moved?' → '+file.move_path:''),'diff-path'));
  const counts=node('span',undefined,'diff-counts');
  if(Number.isFinite(file.additions))counts.append(node('span','+'+file.additions,'diff-added-count'));
  if(Number.isFinite(file.deletions))counts.append(node('span','−'+file.deletions,'diff-deleted-count'));
  summary.append(counts);box.append(summary);
  if(typeof file.diff!=='string'){box.append(node('p','この履歴には差分本文がありません。','diff-unavailable'));return box;}
  const render=()=>{
  const lines=file.diff.split('\n');if(lines.at(-1)==='')lines.pop();
  const rows=[];let oldLine=null,newLine=null,inHunk=false;
  for(const line of lines){
    if(file.change==='add'||file.change==='delete'){
      const added=file.change==='add';rows.push({kind:added?'add':'delete',text:line,old:added?null:rows.length+1,next:added?rows.length+1:null});continue;
    }
    const hunk=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if(hunk){oldLine=Number(hunk[1]);newLine=Number(hunk[2]);inHunk=true;rows.push({kind:'hunk',text:line});continue;}
    if(!inHunk&&/^(?:diff --git |index |--- |\+\+\+ )/.test(line))continue;
    if(line.startsWith('+'))rows.push({kind:'add',text:line.slice(1),old:null,next:newLine===null?null:newLine++});
    else if(line.startsWith('-'))rows.push({kind:'delete',text:line.slice(1),old:oldLine===null?null:oldLine++,next:null});
    else if(line.startsWith(' '))rows.push({kind:'context',text:line.slice(1),old:oldLine===null?null:oldLine++,next:newLine===null?null:newLine++});
    else rows.push({kind:'hunk',text:line});
  }
  const extension=String(file.move_path||file.path).split('.').pop().toLowerCase();
  const language=({ts:'typescript',tsx:'tsx',js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'jsx',json:'json',sh:'bash',bash:'bash',py:'python',swift:'swift',yaml:'yaml',yml:'yaml',html:'html',css:'css',sql:'sql'})[extension]||'';
  for(const side of ['old','next']){
    const selected=rows.filter(row=>row.kind!=='hunk'&&(side==='old'?row.kind!=='add':row.kind!=='delete'));
    const source=selected.map(row=>row.text).join('\n'),tokens=DonaShiki.tokens(source,language);
    if(tokens&&tokens.map(line=>line.map(token=>token.content).join('')).join('\n')===source)selected.forEach((row,index)=>{row[side+'Tokens']=tokens[index];});
  }
  const viewport=node('div',undefined,'diff-scroll');viewport.tabIndex=0;viewport.setAttribute('role','region');viewport.setAttribute('aria-label',file.path+' の差分');
  const table=node('table',undefined,'diff-table');table.setAttribute('aria-label','変更前・変更後の行番号とコード');const body=node('tbody');
  for(const row of rows){
    const tr=node('tr',undefined,'diff-row diff-'+row.kind);
    for(const field of ['old','next']){const cell=node('td',row[field]??'','diff-number');cell.setAttribute('aria-label',(field==='old'?'変更前':'変更後')+(row[field]??'行なし'));tr.append(cell);}
    tr.append(node('td',({add:'+',delete:'−',context:' '})[row.kind]||'','diff-sign'));
    const cell=node('td'),code=node('code');const tokens=row.kind==='delete'?row.oldTokens:row.nextTokens;
    if(tokens){code.dataset.highlighter='shiki';for(const token of tokens){const span=node('span',token.content,'shiki-token');if(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(token.color||''))span.classList.add('shiki-'+token.color.slice(1).toLowerCase());if(token.fontStyle&1)span.classList.add('shiki-italic');if(token.fontStyle&2)span.classList.add('shiki-bold');code.append(span);}}
    else code.textContent=row.text;
    cell.append(code);tr.append(cell);body.append(tr);
  }
  table.append(body);viewport.append(table);box.append(viewport);
  if(!rows.length)box.append(node('p','テキストの差分はありません。','diff-unavailable'));
  const raw=node('details',undefined,'diff-source');raw.append(node('summary','差分の原文'));raw.addEventListener('toggle',()=>{if(raw.open&&!raw.querySelector('pre'))raw.append(node('pre',file.diff));});box.append(raw);
  };
  let rendered=false;const ensureRendered=()=>{if(box.open&&!rendered){rendered=true;render();}};
  box.addEventListener('toggle',ensureRendered);ensureRendered();
  return box;
}
`;
