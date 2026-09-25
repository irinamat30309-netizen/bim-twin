/* v1090 — bottom-centre measuring dock. Reparents original controls; never clones their listeners. */
(function(){'use strict';const $=id=>document.getElementById(id),V=()=>window.__viewer||window.__lxViewer;
 const paths={mmDistance:'<path d="M4 17L19 6M3 13l4 6m9-15 5 6m-10 0 2 3"/>',mmPoint:'<circle cx="12" cy="12" r="4"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/>',mmPolyline:'<path d="m3 17 6-10 7 9 5-12"/><circle cx="3" cy="17" r="1"/><circle cx="9" cy="7" r="1"/><circle cx="16" cy="16" r="1"/>',mmAngle:'<path d="M3 5v15h18M3 20 18 5M3 12a8 8 0 0 1 6 2"/>',mmArea:'<path d="m3 8 13-4 5 14-16 2zM5 8l5 10m1-12 5 12"/>',mmSnap:'<path d="M5 4v10a7 7 0 0 0 14 0V4h-4v10a3 3 0 0 1-6 0V4zM5 8h4m6 0h4"/>',mmSave:'<path d="M5 3h12l3 3v15H4V3zM8 3v6h8V3M8 21v-8h8v8"/>',mmFinish:'<path d="m4 12 5 5L20 5"/>',mmExit:'<path d="m6 6 12 12M6 18 18 6"/>'};
 const labels={mmDistance:'Расстояние',mmPoint:'Точка',mmPolyline:'Полилиния',mmAngle:'Угол',mmArea:'Площадь',mmSnap:'Привязка',mmSave:'Сохранить измерение',mmFinish:'Завершить фигуру',mmExit:'Выйти из измерений · Esc'};
 const hints={distance:'Расстояние · укажите две точки',point:'Точка · координаты X, Y, Z',polyline:'Полилиния · точки по порядку, затем ✓',angle:'Угол · три точки, вершина — вторая',area:'Площадь · вершины контура, затем ✓',plane:'Плоскость · точка на поверхности',deviation:'Зазор · сначала плоскость, затем точка',corner:'Ребро / угол · выберите плоскости'};
 function ico(p){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';}
 function closePopover(focus){let open=false;document.querySelectorAll('#measureBar .lx-dock-pop:not([hidden])').forEach(p=>{p.hidden=true;const b=$(p.dataset.toggle);b?.setAttribute('aria-expanded','false');if(focus)b?.focus();open=true;});return open;}
 function sync(){const v=V();Object.entries(paths).forEach(([id,p])=>{const b=$(id);if(!b)return;if(!b.querySelector('svg'))b.innerHTML=ico(p);b.setAttribute('aria-label',labels[id]);b.title=labels[id];});
  document.querySelectorAll('#measureBar [data-mm]').forEach(b=>b.setAttribute('aria-pressed',String(v?.measureMode===b.dataset.mm)));
  $('mmSnap')?.setAttribute('aria-pressed',String(!!v?.measureSnap));if($('lxMeasureHint'))$('lxMeasureHint').textContent=(hints[v?.measureMode]||'Измерения')+' · Esc — выйти';
 }
 function build(){const p=$('measureBar');if(!p||!$('mmExit'))return;if(p.dataset.docked){sync();return;}p.dataset.docked='1';
  const row=document.createElement('div');row.className='lx-dock-row';row.setAttribute('role','toolbar');row.setAttribute('aria-label','Измерения');
  const hint=document.createElement('div');hint.id='lxMeasureHint';
  function move(id,parent){const b=$(id);if(b)parent.append(b);}
  ['mmDistance','mmPoint','mmPolyline','mmAngle','mmArea'].forEach(id=>move(id,row));
  const popovers=[];
  function pop(id,label,ids,path){const b=document.createElement('button');b.type='button';b.id=id+'Toggle';b.className='btn-sm';b.title=label;b.setAttribute('aria-label',label);b.setAttribute('aria-expanded','false');b.innerHTML=ico(path)+'<span class="lx-drop-arrow">▴</span>';const pop=document.createElement('div');pop.id=id;pop.className='lx-dock-pop';pop.hidden=true;pop.dataset.toggle=b.id;pop.setAttribute('aria-label',label);const head=document.createElement('div');head.className='lx-pop-title';head.textContent=label;pop.append(head);ids.forEach(x=>move(x,pop));b.onclick=()=>{const on=pop.hidden;closePopover();pop.hidden=!on;b.setAttribute('aria-expanded',String(on));};row.append(b);popovers.push(pop);}
  pop('lxMeasureGeometry','Плоскости и зазоры',['mmPlane','mmDeviation','mmCorner'],'<path d="m3 15 9-11 9 5-9 11zM12 4v16M3 15l18-6"/>');
  const sep=document.createElement('span');sep.className='lx-dock-separator';row.append(sep);
  ['mmSnap','mmSave','mmFinish'].forEach(id=>move(id,row));
  pop('lxMeasureMore','Список и экспорт',['mmList','mmCsv','mmNotion','mmClear'],'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>');move('mmExit',row);
  // All existing controls have been moved before removing obsolete headers/group wrappers.
  p.replaceChildren(hint,row,...popovers);sync();
 }
 document.addEventListener('click',e=>{if(e.target.closest('#measureBar')){if(e.target.closest('[data-mm]'))closePopover();setTimeout(sync,0);}if(e.target.closest('#btnMeasure,#vtMeasure')){closePopover();setTimeout(sync,0);}},false);
 document.addEventListener('pointerdown',e=>{if(!e.target.closest('#measureBar'))closePopover();},true);
 window.__lxDock={build,sync,closePopover};window.addEventListener('bim-app-ready',build);window.addEventListener('DOMContentLoaded',()=>setTimeout(build,220));
})();
