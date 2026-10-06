import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
export const mermaidLibrary = readFileSync(join(dirname(require.resolve('mermaid/package.json')), 'dist/mermaid.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script');

export const mermaidRenderer = String.raw`
let mermaidSequence=0,mermaidQueue=Promise.resolve();
const mermaidCache=new Map();
mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:16384,maxEdges:200,
  theme:'base',look:'classic',htmlLabels:false,fontFamily:'system-ui, sans-serif',
  themeVariables:{darkMode:true,background:'#11151b',primaryColor:'#253b56',primaryTextColor:'#e5eaf0',primaryBorderColor:'#6586ad',secondaryColor:'#1c2430',tertiaryColor:'#202b39',lineColor:'#a3afbf',textColor:'#e5eaf0',edgeLabelBackground:'#161c24',actorBkg:'#253b56',actorTextColor:'#e5eaf0',actorBorder:'#6586ad',signalColor:'#a3afbf',signalTextColor:'#e5eaf0',noteBkgColor:'#303324',noteTextColor:'#e5eaf0',noteBorderColor:'#9e9b66'},
  flowchart:{htmlLabels:false,useMaxWidth:false},sequence:{useMaxWidth:false},
  secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','theme','look','themeVariables','themeCSS','htmlLabels','fontFamily','flowchart','sequence']});
function mermaidBlock(source) {
  const figure=node('figure',undefined,'mermaid-figure'),caption=node('figcaption','Mermaid','mermaid-caption'),viewport=node('div',undefined,'mermaid-viewport');viewport.tabIndex=0;viewport.setAttribute('role','region');viewport.setAttribute('aria-label','Mermaidの図');
  const zoom=node('button','原寸で表示');zoom.type='button';zoom.setAttribute('aria-pressed','false');zoom.addEventListener('click',()=>{const expanded=figure.dataset.zoom!=='true';figure.dataset.zoom=String(expanded);zoom.setAttribute('aria-pressed',String(expanded));zoom.textContent=expanded?'全体を表示':'原寸で表示';});caption.append(zoom);
  const state=node('p','図を描画しています…','muted'),details=node('details'),pre=node('pre');pre.append(node('code',source));details.append(node('summary','ソースを表示'),pre);figure.append(caption,viewport,details);viewport.append(state);
  function show(svg) {
    if(!figure.isConnected)return;
    const img=node('img');img.alt='Mermaidの図。記述内容は下のソースから確認できます。';
    const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
    img.onload=()=>URL.revokeObjectURL(url);img.onerror=()=>{URL.revokeObjectURL(url);fail();};img.src=url;viewport.replaceChildren(img);figure.dataset.rendered='true';
  }
  function fail(){if(!figure.isConnected)return;viewport.replaceChildren(node('p','図を表示できません。Mermaidの記法を確認してください。','muted'));details.open=true;figure.dataset.rendered='error';}
  requestAnimationFrame(()=>{
    mermaidQueue=mermaidQueue.catch(()=>{}).then(async()=>{
      if(!figure.isConnected)return;
      if(source.length>16384||/^\s*---/.test(source)||/%%\{/.test(source)){fail();return;}
      const cached=mermaidCache.get(source);if(cached){show(cached);return;}
      const stage=node('div',undefined,'mermaid-stage');stage.setAttribute('aria-hidden','true');figure.append(stage);
      try {
        const result=await mermaid.render('dona-mermaid-'+(++mermaidSequence),source,stage);
        if(!figure.isConnected)return;
        // SVG画像として表示し、生成されたリンク・イベントをページへ挿入しない。
        const documentSvg=new DOMParser().parseFromString(result.svg,'image/svg+xml');
        documentSvg.querySelectorAll('script,foreignObject,image,a').forEach(element=>{if(element.tagName.toLowerCase()==='a')element.replaceWith(...element.childNodes);else element.remove();});
        for(const element of documentSvg.querySelectorAll('*'))for(const attribute of [...element.attributes])if(/^on/i.test(attribute.name)||(/href$/i.test(attribute.name)&&!attribute.value.startsWith('#')))element.removeAttribute(attribute.name);
        const svg=new XMLSerializer().serializeToString(documentSvg.documentElement);
        if(mermaidCache.size>=24)mermaidCache.delete(mermaidCache.keys().next().value);mermaidCache.set(source,svg);show(svg);
      }catch{fail();}finally{stage.remove();}
    });
  });
  return figure;
}
`;
