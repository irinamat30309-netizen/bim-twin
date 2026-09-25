/* v1090 — active cloud entry + live properties. One resident cloud, not a fake multi-cloud manager. */
(function(){'use strict';
 const $=id=>document.getElementById(id),V=()=>window.__viewer||window.__lxViewer,D=window.CloudDisplay;
 const icon=path=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'+path+'</svg>';
 const cloudIcon=icon('<path d="M5 17a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 1 1 2 9z"/><path d="M8 12h1m3 2h1m3-3h1"/>');
 const eyeIcon=icon('<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>');
 let histKey=null,hist=null,lastSource=null;
 function closeMenu(focus){const m=$('lxCloudMenu');if(!m||m.hidden)return false;m.hidden=true;$('lxCloudMore')?.setAttribute('aria-expanded','false');if(focus&&$('lxCloudMore'))$('lxCloudMore').focus();return true;}
 function select(){document.documentElement.classList.remove('lx-object-view');if(window.__lxWorkspace)window.__lxWorkspace.propertiesToggle(false);$('lxCloudProperties')?.scrollIntoView({block:'nearest'});}
 function mount(){
  const insp=document.querySelector('.inspector'),body=$('lxPropertiesBody');if(!insp||!body)return;
  const docs=$('lxDocs');if(docs&&docs.parentNode!==body)body.append(docs);
  if($('lxCloudProperties'))return;
  const panel=document.createElement('section');panel.id='lxCloudProperties';panel.setAttribute('aria-label','Свойства облака');
  panel.innerHTML=`<div class="lx-properties-head">Свойства облака <span class="lx-type-badge">POINT CLOUD</span></div>
   <div id="lxCloudEmpty" class="lx-cloud-empty">Откройте облако точек — здесь появятся имя файла и параметры отображения.</div>
   <div id="lxCloudFields" hidden>
    <div class="lx-cloud-name"><span id="cpName"></span><button id="lxCloudMore" title="Действия с облаком" aria-label="Действия с облаком" aria-expanded="false">⋯</button></div>
    <label class="lx-cp-row"><span>Размер точки</span><input id="cpSize" aria-label="Размер точки, пиксели" type="range" min="1" max="10" step=".1"><input id="cpSizeNum" aria-label="Точный размер точки, пиксели" type="number" min="1" max="10" step=".1"></label>
    <div class="lx-cp-scale"><span>1 px</span><span>10 px</span></div>
    <label class="lx-cp-row" title="0 — невидимое облако, 1 — полностью непрозрачное. Экранная маска без сортировки миллионов точек."><span>Непрозрачность</span><input id="cpOpacity" aria-label="Непрозрачность" type="range" min="0" max="1" step=".01"><input id="cpOpacityNum" aria-label="Точная непрозрачность" type="number" min="0" max="1" step=".01"></label>
    <div class="lx-cp-scale"><span>0.00</span><span>1.00</span></div>
    <label class="lx-cp-select"><span>Отображение</span><select id="cpMode"><option value="rgb">RGB</option><option value="elev">Высота</option></select></label>
    <div id="cpHeight" hidden>
     <label class="lx-cp-select"><span>Палитра</span><select id="cpPalette"><option value="rainbow">Спектр</option><option value="gray">Серая</option><option value="warm">Жёлтый → красный</option></select></label>
     <div id="cpGradient" aria-hidden="true"></div><svg id="cpHistogram" viewBox="0 0 256 68" role="img" aria-label="Распределение точек по локальной высоте Y"></svg>
     <div class="lx-height-ranges"><input id="cpMinRange" aria-label="Нижняя граница высоты" type="range" step="any"><input id="cpMaxRange" aria-label="Верхняя граница высоты" type="range" step="any"></div>
     <div class="lx-height-numbers"><label>Начало<input id="cpMin" type="number" step=".001"></label><label>Конец<input id="cpMax" type="number" step=".001"></label><button id="cpRangeReset" title="Полный диапазон высот" aria-label="Полный диапазон высот">↺</button></div>
     <label class="lx-cp-check"><input id="cpHide" type="checkbox">Скрыть точки вне диапазона</label><div id="cpHistNote" class="lx-cp-note"></div>
    </div>
    <div id="cpError" role="alert"></div>
    <dl class="lx-cloud-stats"><dt>В исходном файле</dt><dd id="cpTotal"></dd><dt>Загружено точек</dt><dd id="cpLoaded"></dd></dl>
    <div class="lx-cp-caption">Габариты загруженных точек, м</div><div id="cpDimensions"></div>
    <div class="lx-cp-note">Локальные оси · Y — высота</div><div id="cpColorNote" class="lx-cp-note"></div>
   </div>`;
  insp.insertBefore(panel,$('lxPropertiesToggle'));
  const menu=document.createElement('div');menu.id='lxCloudMenu';menu.hidden=true;menu.className='lx-cloud-menu';menu.setAttribute('aria-label','Действия с облаком');
  [['cpVisibility','Показать / скрыть',()=>V().setCloudVisible(V().cloudVisible===false)],['cpFit','Вписать в окно',()=>V().resetView()],['cpEdit','Правка точек',()=>{if(!V().editSelect)$('vtEdit')?.click();}],['cpSave','Сохранить копию PLY',()=>$('edSave')?.click()],['cpReset','Сбросить отображение',()=>{const v=V(),b=v.bbox;v.setCloudPointSize(1);v.setCloudOpacity(1);v.setColorMode('rgb');v.setCloudHideOutside(false);v.setCloudHeightRange(b.mn[1],b.mx[1]);v.setCloudPalette('rainbow');v.setBrightness(1);v.setGrade(false);v.setCloudVisible(true);}]].forEach(([id,label,fn])=>{const b=document.createElement('button');b.id=id;b.textContent=label;b.onclick=()=>{closeMenu();fn();};menu.append(b);});panel.append(menu);
  $('lxCloudMore').onclick=()=>{menu.hidden=!menu.hidden;$('lxCloudMore').setAttribute('aria-expanded',String(!menu.hidden));};
  function bindPair(slider,num,method){for(const id of [slider,num])$(id).addEventListener(id===num?'change':'input',()=>{if($(id).value===''){sync();return;}try{V()[method]($(id).value);$('cpError').textContent='';sync();}catch(e){$('cpError').textContent=e.message;}});}
  bindPair('cpSize','cpSizeNum','setCloudPointSize');bindPair('cpOpacity','cpOpacityNum','setCloudOpacity');
  $('cpMode').onchange=()=>V().setColorMode($('cpMode').value);$('cpPalette').onchange=()=>V().setCloudPalette($('cpPalette').value);$('cpHide').onchange=()=>V().setCloudHideOutside($('cpHide').checked);
  for(const id of ['cpMin','cpMax','cpMinRange','cpMaxRange'])$(id).addEventListener(id.endsWith('Range')?'input':'change',()=>{
   const v=V(),d=v.getCloudInfo().display;let a=id==='cpMinRange'?Math.min(Number($(id).value),d.max):Number($('cpMin').value),b=id==='cpMaxRange'?Math.max(Number($(id).value),d.min):Number($('cpMax').value);
   try{if($('cpMin').value===''||$('cpMax').value==='')throw new Error('Укажите обе границы диапазона');v.setCloudHeightRange(a,b);$('cpError').textContent='';sync();}catch(e){$('cpError').textContent=e.message;}
  });
  $('cpRangeReset').onclick=()=>{const b=V().bbox;V().setCloudHeightRange(b.mn[1],b.mx[1]);$('cpError').textContent='';};
 }
 function setVal(id,value){const e=$(id);if(e&&document.activeElement!==e)e.value=value;}
 function drawHist(info){const bo=V().base.find(o=>o.points),key=bo&&bo.pos;
  if(key!==histKey){histKey=key;hist=key?D.histogram(key,[info.bounds.mn[1],info.bounds.mx[1]],64,100000):null;}
  const h=hist,s=$('cpHistogram');s.replaceChildren();if(!h)return;
  const max=Math.max(1,...h.bins),palette=['rainbow','gray','warm'][info.display.palette];
  h.bins.forEach((n,i)=>{const r=document.createElementNS('http://www.w3.org/2000/svg','rect');r.setAttribute('x',i*4);r.setAttribute('y',66-n/max*62);r.setAttribute('width',3.4);r.setAttribute('height',n/max*62);r.setAttribute('fill','rgb('+D.color(i/63,palette).map(x=>Math.round(x*255)).join(',')+')');s.append(r);});
  for(const level of [info.display.min,info.display.max]){const x=256*D.normalize(level,h.min,h.max),l=document.createElementNS(s.namespaceURI,'line');l.setAttribute('x1',x);l.setAttribute('x2',x);l.setAttribute('y1',0);l.setAttribute('y2',68);l.setAttribute('stroke','#f0f2f5');l.setAttribute('stroke-width','1.5');s.append(l);}
  $('cpHistNote').textContent=h.approximate?'Гистограмма: выборка '+h.sampled.toLocaleString('ru-RU')+' точек':'Гистограмма загруженных точек';
 }
 function sync(){
  mount();if(!$('lxCloudProperties'))return;const v=V(),info=v?.getCloudInfo?.();
  const parent=document.querySelector('#lxScene [data-layer="cloud"]');let list=$('lxCloudEntries');
  if(parent&&!list){list=document.createElement('div');list.id='lxCloudEntries';parent.after(list);const tw=parent.querySelector('.lx-tw');if(tw){tw.textContent='▾';tw.setAttribute('role','button');tw.tabIndex=0;tw.title='Развернуть / свернуть облака';const toggle=()=>{list.hidden=!list.hidden;tw.textContent=list.hidden?'▸':'▾';tw.setAttribute('aria-expanded',String(!list.hidden));};tw.onclick=toggle;tw.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}};}}
  $('lxCloudEmpty').hidden=!!info;$('lxCloudFields').hidden=!info;
  if(!info){if(list)list.replaceChildren();histKey=null;lastSource=null;closeMenu();return;}
  if(info.sourceName!==lastSource){select();lastSource=info.sourceName;}
  const name=D.fileName(info.sourceName);if(list&&!$('lxCloudEntry')){
   const row=document.createElement('div');row.id='lxCloudEntry';row.className='lx-cloud-entry active';row.tabIndex=0;row.setAttribute('role','treeitem');row.setAttribute('aria-selected','true');
   row.innerHTML='<button class="lx-cloud-eye" title="Показать / скрыть облако" aria-label="Показать / скрыть облако">'+eyeIcon+'</button><span class="lx-cloud-ico">'+cloudIcon+'</span><span class="lx-cloud-filename"></span>';
   row.onclick=select;row.ondblclick=()=>{select();V().resetView();};row.oncontextmenu=e=>{e.preventDefault();select();$('lxCloudMenu').hidden=false;};row.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();select();}if(e.key==='F2'){e.preventDefault();$('lxCloudMore').click();}};
   row.querySelector('button').onclick=e=>{e.stopPropagation();V().setCloudVisible(V().cloudVisible===false);};list.append(row);
  }
  const row=$('lxCloudEntry');if(row){row.querySelector('.lx-cloud-filename').textContent=name;row.title=name;const e=row.querySelector('button');e.setAttribute('aria-pressed',String(info.visible));row.classList.toggle('invisible',!info.visible);}
  const pe=parent?.querySelector('[data-eye="cloud"]');if(pe){pe.classList.toggle('on',info.visible);pe.setAttribute('aria-pressed',String(info.visible));}
  $('cpName').textContent=name;$('cpName').title=name;const d=info.display,px=d.pointSize||Math.max(1,(v.base[0]?.pointSize||1)*v._ptSizeMul);
  setVal('cpSize',px);setVal('cpSizeNum',Number(px.toFixed(1)));setVal('cpOpacity',d.opacity);setVal('cpOpacityNum',d.opacity.toFixed(2));setVal('cpMode',d.mode);setVal('cpPalette',['rainbow','gray','warm'][d.palette]);
  $('cpHeight').hidden=d.mode!=='elev';$('cpHide').checked=d.hideOutside;
  for(const id of ['cpMinRange','cpMaxRange']){$(id).min=info.bounds.mn[1];$(id).max=info.bounds.mx[1];}
  setVal('cpMin',Number(d.min.toFixed(6)));setVal('cpMax',Number(d.max.toFixed(6)));setVal('cpMinRange',d.min);setVal('cpMaxRange',d.max);
  $('cpGradient').style.background=['linear-gradient(90deg,#000080,#0080ff,#00ff80,#ffff00,#800000)','linear-gradient(90deg,#000,#fff)','linear-gradient(90deg,#ff0,#f00)'][d.palette];
  if(d.mode==='elev')drawHist(info);if(info.streaming)$('cpHistNote').textContent='Гистограмма недоступна в потоковом режиме';$('cpEdit').disabled=info.streaming;$('cpSave').disabled=info.streaming;
  $('cpTotal').textContent=Number.isSafeInteger(info.sourceCount)?info.sourceCount.toLocaleString('ru-RU'):'Неизвестно';$('cpLoaded').textContent=info.streaming?'Потоковый режим':info.loadedCount.toLocaleString('ru-RU');
  $('cpDimensions').textContent=info.bounds.mx.map((x,i)=>'XYZ'[i]+': '+(x-info.bounds.mn[i]).toFixed(3)).join('  ·  ');
  if(window.__bimRefreshQuality)window.__bimRefreshQuality();
  $('cpColorNote').textContent=info.hasRGB?'': 'В исходнике нет RGB: используется цвет парсера. Доступна окраска по высоте.';
 }
 document.addEventListener('pointerdown',e=>{if(!e.target.closest('#lxCloudMenu,#lxCloudMore'))closeMenu();},true);
 window.__lxCloudUI={sync,closeMenu,select};['bim-cloud-change','bim-app-ready','lx-scene-built'].forEach(e=>window.addEventListener(e,sync));
 if(document.readyState!=='loading')sync();else window.addEventListener('DOMContentLoaded',()=>setTimeout(sync,200));
})();
