/* v1089: actual workspace layout, shared mode cancellation and panel lifecycle.
 * Keeps existing controls/listeners and persisted project data. No mock SDK actions.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const viewer = () => window.__viewer || window.__lxViewer;
  const visible = el => !!el && getComputedStyle(el).display !== 'none';
  let busy = false;
  function notify(text) { const e = $('toast'); if (e) { e.textContent = text; e.classList.add('show'); setTimeout(() => e.classList.remove('show'), 3000); } }
  function button(text, id, title, fn) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    if (id) b.id = id; b.title = title || text; b.setAttribute('aria-label', b.title);
    if (fn) b.addEventListener('click', fn); return b;
  }
  function click(id) { const b = $(id); if (b) b.click(); }
  function hide(id) { const e = $(id); if (e) e.style.display = 'none'; }
  function off(ids) { ids.forEach(id => { const e = $(id); if (e) { e.classList.remove('on'); e.setAttribute('aria-pressed', 'false'); } }); }
  function sync() {
    const v = viewer();
    const flags = { measure: !!(v && v.measuring), section: !!(v && v.section && v.section.on), edl: !!(v && v._edl && v._edlReady), grid: !!(v && v.lod) };
    document.querySelectorAll('#lxLtbar [data-tool]').forEach(b => {
      const on = !!flags[b.dataset.tool]; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
    });
    const grid = document.querySelector('#lxLtbar [data-tool="grid"]');
    if (grid) {
      const canLOD = !!(v && v.supportsLOD && v.supportsLOD());
      grid.disabled = !canLOD; grid.setAttribute('aria-disabled', String(!canLOD));
      grid.title = canLOD ? 'LOD — уменьшить детализацию полигональной модели' : 'LOD доступен только для полигональных моделей; облака точек пока не поддержаны';
    }
  }
  function exitTools(except) {
    const v = viewer();
    if (window.__lxDrawUI && window.__lxDrawUI.cancelSectionJob) window.__lxDrawUI.cancelSectionJob();
    window.__lxDock?.closePopover();window.__lxCloudUI?.closeMenu();
    if (except !== 'measure') {
      if (v && v.measuring && window.__bimSetMeasuring) window.__bimSetMeasuring(false);
      hide('measureBar'); hide('measureListPanel'); hide('measureReadout'); off(['btnMeasure','vtMeasure']);
    }
    if (except !== 'draw' && window.__lxDraw && window.__lxDraw.active && window.__lxDrawUI) window.__lxDrawUI.deactivate(true);
    if (except !== 'edit') { if (v && v.editSelect && v.setEditSelect) v.setEditSelect(false); hide('editBar'); off(['vtEdit']); }
    if (except !== 'walk') { if (v && v.walk && v.setWalk) v.setWalk(false); off(['vtWalk']); }
    if (except !== 'tour') { if (v && v.tour && v.setTour) v.setTour(false); hide('tourBar'); off(['vtTour']); }
    // Exiting section disables the clipping mode, without deleting the cloud.
    if (!except) {
      if (v && v.section && v.section.on && v.setSection) v.setSection(false);
      hide('sectionPanel'); hide('sectionRange'); hide('qualityBar'); hide('lxSectionControls');
      off(['btnSection','vtSection','vtQuality']);
    }
    sync();
  }
  function toolbarAction(t, el) {
    const v = viewer();
    if (t.id === 'nav') { exitTools(); return; } // navigation is not camera reset
    if (t.id === 'edl') {
      if (!v || !v.setEDL) { notify('EDL недоступен в текущем режиме'); return; }
      const on = v.setEDL(!v._edl); if (!on && v._edl) notify('EDL не поддерживается текущим графическим контекстом');
    } else if (t.id === 'xray') { notify('Рентген пока не реализован для этого вьюера'); }
    else if (t.act === 'full') {
      const p = document.fullscreenElement ? document.exitFullscreen() : document.querySelector('.stage').requestFullscreen();
      if (p && p.catch) p.catch(() => notify('Полноэкранный режим недоступен'));
    } else if (t.btn) click(t.btn);
    sync();
  }
  function projectToggle(force) {
    const on = force == null ? !root.classList.contains('lx-project-open') : !!force;
    root.classList.toggle('lx-project-open', on); if ($('lxProjectToggle')) $('lxProjectToggle').setAttribute('aria-pressed', String(on));
  }
  function propertiesToggle(force) {
    const p = $('lxPropertiesBody'); if (!p) return;
    const on = force == null ? !p.classList.contains('open') : !!force;
    root.classList.toggle('lx-docs-view',on);p.classList.toggle('open', on); $('lxPropertiesToggle').setAttribute('aria-expanded', String(on));
    $('lxPropertiesToggle').lastChild.textContent = on ? '▾' : '▸';
  }
  function closeButton(panel, fn) {
    if (!panel || panel.querySelector('.lx-panel-close')) return;
    const b = button('×', '', 'Закрыть · Esc', fn); b.className = 'lx-panel-close';
    const head=panel.querySelector('.mtoolbox-head');
    if(head) head.append(b); else {b.style.float='right';panel.prepend(b);}
  }
  function closeTopModal() {
    const modals = Array.from(document.querySelectorAll('.modal.open,.lx-modal-back')).filter(visible);
    if (!modals.length) return false;
    const m = modals.sort((a,b) => (+getComputedStyle(a).zIndex || 0) - (+getComputedStyle(b).zIndex || 0)).pop();
    if (m.id === 'formModal') click(visible($('formCancel')) ? 'formCancel' : 'formOk');
    else if (m.id === 'cmpModal') click('cmpClose');
    else { const close = m.querySelector('.modal-head .x,.lx-modal-a .btn:not(.primary)'); if (close) close.click(); else return false; }
    return true;
  }
  function menusClose() {
    let any = false; ['cleanMenu','geomMenu'].forEach(id => { const m=$(id); if(m){m.remove();any=true;} }); return any;
  }
  function escape() {
    if (closeTopModal()) return true;
    if(window.__lxDock?.closePopover(true) || window.__lxCloudUI?.closeMenu(true))return true;
    if (menusClose()) return true;
    if (root.classList.contains('lx-project-open')) { projectToggle(false); return true; }
    const v=viewer();
    if (v && v.editSelect && v.selectionCount && v.selectionCount() && v.clearSelection) { v.clearSelection(); notify('Выделение снято. Ещё Esc — выйти из правки.'); return true; }
    if ((v && (v.measuring || v.editSelect || v.walk || v.tour || (v.section && v.section.on))) || (window.__lxDraw && window.__lxDraw.active) || ['measureBar','qualityBar','sectionPanel','lxSectionControls','measureListPanel'].some(id => visible($(id)))) { exitTools(); return true; }
    return false;
  }
  function group(id, tab, label) {
    let g=$(id); if(g) return g.querySelector('.tgrow');
    g=document.createElement('div'); g.id=id; g.className='tgroup'; g.dataset.lxtab=tab;
    const row=document.createElement('div'); row.className='tgrow';
    const caption=document.createElement('div'); caption.className='tglabel'; caption.textContent=label;
    g.append(row,caption); document.querySelector('.toolbar .tbtns').append(g); return row;
  }
  function decorate(el, label, icon) {
    if (!el || el.dataset.workspaceLabel===label && el.querySelector('.lx-bic')) return;
    const svg = window.__lxRibbon && (window.__lxRibbon.ICON[icon] || window.__lxRibbon.ICON.settings) || '';
    el.replaceChildren(); const i=document.createElement('span'); i.className='lx-bic'; i.innerHTML=svg;
    const l=document.createElement('span'); l.className='lx-blabel'; l.textContent=label;
    el.append(i,l); el.classList.add('lx-bigbtn'); el.dataset.lxbig='1'; el.dataset.workspaceLabel=label;
    if(!el.title) el.title=label; el.setAttribute('aria-label',label);
  }
  function layoutRibbon() {
    if (window.__lxRibbon) window.__lxRibbon.build();
    const process = group('lxProcessTools','process','Обработка облака');
    [['vtTools','Чистка','edit'],['vtConvert','Конвертация','cloudOpen'],['vtGeom','Геометрия','section'],['vtMem','Память','lod']].forEach(([id,label,ic])=>{const b=$(id);if(b){process.append(b);decorate(b,label,ic);}});
    const tools=group('lxViewTools','tool','Отображение');
    [['vtQuality','Качество','compare'],['vtWalk','Прогулка','tour'],['vtZoomIn','Приблизить','isolate'],['vtZoomOut','Отдалить','isolate']].forEach(([id,label,ic])=>{const b=$(id);if(b){tools.append(b);decorate(b,label,ic);}});
    const app=group('lxAppTools','app','Приложение');
    if($('btnSettings')) app.append($('btnSettings'));
    if($('vtLog')) {app.append($('vtLog'));decorate($('vtLog'),'Консоль','report');}
    if($('tsMesh')) {app.append($('tsMesh'));decorate($('tsMesh'),'Меш','model');}
    const vc=$('viewCube'),st=document.querySelector('.stage'); if(vc && st) {st.append(vc);vc.hidden=true;}
    const vcg=$('vcGroup'); if(vcg) vcg.dataset.lxhidden='1';
    document.querySelectorAll('.toolbar .tgroup').forEach(g=>{
      if (!g.dataset.lxtab) g.dataset.lxtab=g.id==='vtGroup'?'process':'tool';
      const tab=document.querySelector('#lxTabs .lx-tab.active');
      g.dataset.lxhidden=g.dataset.lxtab===(tab && tab.dataset.tab || 'home')?'0':'1';
      if(g.id==='vcGroup') g.dataset.lxhidden='1';
    });
  }
  function build() {
    if (busy || !$('lxTabs') || !viewer()) return; busy=true;
    try {
      if (window.__lxToolbar) window.__lxToolbar.build();
      if (window.__lxShell) window.__lxShell.applyAll();
      if (window.__lxDrawUI) window.__lxDrawUI.buildTab();
      layoutRibbon();
      if(!$('lxProjectToggle')) {
        const quick=document.createElement('div');quick.className='lx-quick';
        quick.append(button('Проект','lxProjectToggle','Проект и помещения',()=>projectToggle()),button('Документы','lxDocsToggle','Документы и свойства объекта',()=>propertiesToggle()));
        $('lxTabs').prepend(quick); $('lxProjectToggle').setAttribute('aria-pressed','false');
      }
      const insp=document.querySelector('.inspector');
      if(insp && !$('lxPropertiesBody')) {
        const head=button('Свойства и документы','lxPropertiesToggle','Развернуть свойства и документы',()=>propertiesToggle()); head.className='lx-properties-head';head.append(document.createElement('span'));head.lastChild.textContent='▸';head.setAttribute('aria-expanded','false');
        const body=document.createElement('div');body.id='lxPropertiesBody';body.className='lx-properties-body';
        Array.from(insp.children).filter(e=>!e.matches('.lx-datahdr,#lxScene,#lxCloudProperties')).forEach(e=>body.append(e));
        const empty=document.createElement('div');empty.className='lx-properties-empty';empty.textContent='Свойства и документы доступны здесь. Для выбора помещения откройте «Проект».';
        insp.append(head,body,empty);
      }
      if(!$('measureBar')?.dataset.docked)closeButton($('measureBar'),()=>exitTools());
      closeButton($('measureListPanel'),()=>hide('measureListPanel'));
      closeButton($('qualityBar'),()=>{hide('qualityBar');off(['vtQuality']);});
      closeButton($('editBar'),()=>exitTools());
      closeButton($('tourBar'),()=>exitTools());
      if($('mmFinish')) { $('mmFinish').textContent='Завершить фигуру'; $('mmFinish').title='Завершить текущую фигуру. Esc или × — выйти из измерений.'; }
      if(!$('mmExit') && $('mmClear')) {const b=button('Выйти · Esc','mmExit','Выключить измерение',()=>exitTools());b.className='btn-sm';$('mmClear').parentNode.append(b);}
      const nav=document.querySelector('#lxLtbar [data-tool="nav"]'); if(nav){nav.title='Навигация · выйти из инструмента (Esc)';nav.setAttribute('aria-label',nav.title);}
      const grid=document.querySelector('#lxLtbar [data-tool="grid"]'); if(grid) grid.title='LOD — уменьшить детализацию';
      const xray=document.querySelector('#lxLtbar [data-tool="xray"]'); if(xray){xray.disabled=!(viewer() && viewer().setXray);xray.title='Рентген: не реализован в текущем вьюере';}
      const cube=document.querySelector('.lx-cube');
      if(cube && !cube.dataset.workspace) {
        cube.dataset.workspace='1';cube.setAttribute('role','button');cube.tabIndex=0;cube.title='Стандартные виды';cube.setAttribute('aria-label','Стандартные виды');
        // Y-up, exactly as the renderer. A face button opens real standard-view controls.
        cube.innerHTML='<svg viewBox="0 0 90 90" width="84" height="84"><g fill="none" stroke="#d6d9df" stroke-width="1.4"><path d="M24 32h43v43H24zM24 32l-9-10h43l9 10M15 22v43l9 10M58 22v10"/></g><text x="45" y="56" text-anchor="middle" fill="#729aff" font-size="9">ВИДЫ</text><path d="M15 76H78" stroke="#ec6262" stroke-width="2"/><path d="M15 76V8" stroke="#71d47c" stroke-width="2"/><path d="M15 76L7 83" stroke="#7570ff" stroke-width="2"/><g font-size="11" font-family="Arial"><text x="79" y="80" fill="#ec6262">X</text><text x="10" y="9" fill="#71d47c">Y</text><text x="0" y="88" fill="#8d88ff">Z</text></g></svg>';
        const toggle=()=>{if($('viewCube')) $('viewCube').hidden=!$('viewCube').hidden;};cube.addEventListener('click',toggle);cube.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}});
      }
      const bar=$('lxStatus'); if(bar && !$('lxLogToggle')) bar.append(button('Консоль','lxLogToggle','Показать / скрыть консоль действий',()=>click('vtLog')));
      document.querySelectorAll('#lxTabs .lx-tab').forEach(t=>{t.setAttribute('role','tab');t.tabIndex=0;t.setAttribute('aria-selected',String(t.classList.contains('active')));});
      if($('lxTabs')) $('lxTabs').setAttribute('role','tablist');
      document.querySelectorAll('#lxScene .lx-node[data-layer]').forEach(n => {
        const id=n.dataset.layer,b=n.querySelector('.lx-eye');
        if(b && !['cloud','floors'].includes(id)) {b.disabled=true;b.title='Видимость этого слоя пока не подключена';}
        const nm=n.querySelector('.lx-nm');if(nm)nm.title=nm.textContent;
      });
      const rt=document.querySelector('#lxScene .lx-root .lx-tw');if(rt)rt.textContent='';
      sync();
    } finally { busy=false; window.__lxDock?.build(); }
  }
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape') {if(escape()){e.preventDefault();e.stopImmediatePropagation();}return;}
    if(e.target && (e.target.matches('input,textarea,select') || e.target.isContentEditable)) return;
    if(e.target && e.target.matches('.lx-tab') && (e.key==='Enter'||e.key===' ')) {e.preventDefault();e.target.click();}
  },true);
  document.addEventListener('pointerdown',e=>{
    ['cleanMenu','geomMenu'].forEach(id=>{const m=$(id);const toggle=$(id==='cleanMenu'?'vtTools':'vtGeom');if(m&&!m.contains(e.target)&&!(toggle&&toggle.contains(e.target)))m.remove();});
    if(e.target && e.target.matches('.modal.open,.lx-modal-back')) closeTopModal();
    if(root.classList.contains('lx-project-open') && !e.target.closest('.sidebar,#lxProjectToggle')) projectToggle(false);
  },true);
  document.addEventListener('click',e=>{
    const b=e.target.closest('button,.lx-tab');if(!b)return;
    if(b.matches('.lx-tab')) {
      exitTools();menusClose();const obj=b.dataset.tab==='object';root.classList.toggle('lx-object-view',obj);if(obj) propertiesToggle(true);
      document.querySelectorAll('#lxTabs .lx-tab').forEach(t=>t.setAttribute('aria-selected',String(t===b)));
    }
    if(b.id==='vtQuality' && !b.classList.contains('on')) exitTools();
    if(b.id==='btnSection' && !(viewer() && viewer().section && viewer().section.on)) exitTools();
    if(b.id==='vtEdit' && !(viewer() && viewer().editSelect)) exitTools('edit');
    if(b.id==='vtWalk' && !(viewer() && viewer().walk)) exitTools('walk');
    if(b.id==='lxSectBtn') {e.preventDefault();e.stopImmediatePropagation();openSectionControls();return;}
    if(b.id==='btnSection') setTimeout(()=>{closeButton($('sectionPanel'),()=>exitTools());sync();},0);
    if(['btnMeasure','vtMeasure','qEDL','btnSection','btnLOD'].includes(b.id)) setTimeout(sync,0);
  },true);
  // A section is a raster-derived outline, not a certified wall centreline.
  function openSectionControls() {
    let panel=$('lxSectionControls');
    if(panel && visible(panel)){window.__lxDrawUI?.cancelSectionJob?.();hide('lxSectionControls');return;}
    exitTools();
    const v=viewer(),c=v&&v.getEditedCloud&&v.getEditedCloud();
    if(!v || !(v.base && v.base.some(o => o.points)) || !c || !c.pos || !c.pos.length){notify('Сначала загрузите облако точек');return;}
    if(!panel){
      panel=document.createElement('div');panel.id='lxSectionControls';
      panel.innerHTML='<div class="mtoolbox-head">Контур сечения</div>' +
        '<label class="lx-field">Плоскость среза<select id="lxSectionAxis" aria-label="Ориентация сечения"><option value="y">Горизонтальный · план (Y)</option><option value="z">Вертикальный · фасад (Z)</option><option value="x">Вертикальный · сбоку (X)</option><option value="profile">Вертикальный · наклонный профиль</option></select></label>' +
        '<button id="lxBuildSection" class="btn-sm">Построить контур</button>' +
        '<button id="lxExportSectionPoints" class="btn-sm" type="button" aria-label="Сохранить точки полосы сечения в CSV и метаданные JSON" title="Экспортирует фактические точки полосы; source coordinates используются только при валидном преобразовании">Сохранить точки полосы · CSV + JSON</button>' +
        '<button id="lxBuildProfile" class="btn-sm" style="display:none">Сформировать профиль DXF + CSV</button>' +
        '<div id="lxSectionStatus" role="status" aria-live="polite"></div>' +
        '<div id="lxSectionJob" style="display:none;gap:8px;align-items:center;margin:6px 0">' +
        '<progress id="lxSectionProgress" max="100" value="0" aria-label="Прогресс фонового расчёта сечения" style="width:100%;height:8px"></progress>' +
        '<button id="lxCancelSection" class="btn-sm" type="button" aria-label="Отменить расчёт сечения">Отменить</button></div>' +
        '<label class="lx-field" id="lxSectionLevelField"><span id="lxSectionLevelLabel">Уровень Y, м</span><input id="lxSectionLevel" type="number" step="0.01"><input id="lxSectionRange" aria-label="Положение сечения" type="range" step="0.01"></label>' +
        '<div id="lxSectionProfileControls" style="display:none">' +
        '<label class="lx-field">Азимут линии, ° (0° = +X; 90° = +Z)<input id="lxSectionAzimuth" type="number" step="0.1" value="0"></label>' +
        '<label class="lx-field">Начало станции X, м<input id="lxSectionOriginX" type="number" step="0.01"></label>' +
        '<label class="lx-field">Начало станции Z, м<input id="lxSectionOriginZ" type="number" step="0.01"></label>' +
        '<label class="lx-field">Смещение плоскости по нормали, м<input id="lxSectionOffset" type="number" step="0.01" value="0"></label>' +
        '<p style="font-size:12px;color:#afb8c8">Станция 0 задаётся началом X/Z; профиль строится по всему облаку вдоль линии. В DXF: X = станция, Y = высота. Координаты и параметры плоскости сохраняются в CSV.</p>' +
        '</div>' +
        '<label class="lx-field">Толщина полосы, м<input id="lxSectionThickness" type="number" min="0.01" max="100" step="0.01" value="0.2"></label>' +
        '<label class="lx-field">Размер ячейки, м<input id="lxSectionCell" type="number" min="0.01" max="10" step="0.01" value="0.1"></label>' +
        '<label class="lx-field">Мин. площадь контура, м²<input id="lxSectionMinArea" type="number" min="0" max="10000" step="0.01" value="0.02"></label>' +
        '<div class="lx-section-presets" aria-label="Сохранённые наборы сечений проекта">' +
        '<div class="lx-section-presets-title">Наборы сечений проекта</div>' +
        '<label class="lx-field">Название набора<input id="lxSectionPresetName" type="text" maxlength="80" autocomplete="off" placeholder="Например: Этаж 2 — фасад"></label>' +
        '<div class="lx-section-preset-row">' +
        '<select id="lxSectionPresetSelect" aria-label="Сохранённые наборы сечений"><option value="">Загрузка…</option></select>' +
        '<button id="lxApplySectionPreset" class="btn-sm" type="button" disabled>Применить</button>' +
        '<button id="lxDeleteSectionPreset" class="btn-sm" type="button" disabled aria-label="Удалить сохранённый набор">Удалить</button>' +
        '</div>' +
        '<button id="lxSaveSectionPreset" class="btn-sm" type="button" aria-label="Сохранить параметры сечения в проекте">Сохранить набор</button>' +
        '<div id="lxSectionPresetStatus" role="status" aria-live="polite"></div>' +
        '</div>' +
        '<p style="font-size:12px;color:#afb8c8">Растровый контур занятой области, не сертифицированная ось стены. Размер ячейки задаёт детализацию. Мелкие фрагменты ниже порога площади отсеиваются; поставьте 0, чтобы сохранить все.</p>';
      document.querySelector('.stage').append(panel);closeButton(panel,()=>{window.__lxDrawUI?.cancelSectionJob?.();hide('lxSectionControls');});
      const axis=$('lxSectionAxis'),level=$('lxSectionLevel'),range=$('lxSectionRange'),label=$('lxSectionLevelLabel'),status=$('lxSectionStatus');
      const axisIndex={x:0,y:1,z:2}, axisLabel={y:'Уровень Y, м',z:'Координата Z, м',x:'Координата X, м'};
      const levels={x:null,y:null,z:null};
      const levelField=$('lxSectionLevelField'),profileControls=$('lxSectionProfileControls');
      const buildSection=$('lxBuildSection'),buildProfile=$('lxBuildProfile'),exportPoints=$('lxExportSectionPoints');
      const jobPanel=$('lxSectionJob'),jobProgress=$('lxSectionProgress'),cancelSection=$('lxCancelSection');
      const presetSelect=$('lxSectionPresetSelect'),presetName=$('lxSectionPresetName');
      const applyPreset=$('lxApplySectionPreset'),deletePreset=$('lxDeleteSectionPreset'),savePreset=$('lxSaveSectionPreset');
      const presetStatus=$('lxSectionPresetStatus');
      let savedPresets=[];
      let profileInitialized=false;
      let sectionBusy=false;
      const sectionInputs=[axis,level,range,$('lxSectionThickness'),$('lxSectionCell'),$('lxSectionMinArea'),
        $('lxSectionAzimuth'),$('lxSectionOriginX'),$('lxSectionOriginZ'),$('lxSectionOffset'),
        buildSection,buildProfile,exportPoints,applyPreset];
      function setSectionBusy(value){
        sectionBusy=!!value;
        sectionInputs.forEach(input=>{if(input)input.disabled=sectionBusy;});
        jobPanel.style.display=sectionBusy?'flex':'none';
        cancelSection.disabled=false;
        if(!sectionBusy){jobProgress.value=0;syncAxis();}
      }
      function sectionProgress(update){
        const phaseLabels={
          slice:'Отбор точек полосы',profile:'Отбор точек профиля',bounds:'Расчёт границ',
          occupancy:'Построение растровой сетки',
          'trace-grid':'Поиск границ контура','trace-loops':'Сшивка контуров'
        };
        const pct=Math.max(0,Math.min(100,Number(update&&update.percent)||0));
        jobProgress.value=pct;
        status.textContent=(phaseLabels[update&&update.phase]||'Расчёт сечения')+' · '+pct+'%';
      }
      cancelSection.addEventListener('click',()=>{
        if(!sectionBusy)return;
        cancelSection.disabled=true;
        status.textContent='Отмена расчёта…';
        if(!window.__lxDrawUI?.cancelSectionJob?.()){
          status.textContent='Расчёт уже завершён.';
          cancelSection.disabled=false;
        }
      });
      function syncAxis(){
        const cur=viewer(),bb=cur&&cur.bbox,a=axis.value;
        if(a==='profile'){
          levelField.style.display='none';profileControls.style.display='block';
          buildSection.style.display='none';exportPoints.style.display='none';buildProfile.style.display='';
          if(!profileInitialized){
            const mid=(j)=>bb&&bb.mn&&bb.mx&&Number.isFinite(Number(bb.mn[j]))&&Number.isFinite(Number(bb.mx[j]))?(Number(bb.mn[j])+Number(bb.mx[j]))/2:0;
            $('lxSectionOriginX').value=mid(0).toFixed(3);
            $('lxSectionOriginZ').value=mid(2).toFixed(3);
            profileInitialized=true;
          }
          if(status&&!status.textContent)status.textContent='Профиль строится в локальной системе координат активного облака.';
          return;
        }
        levelField.style.display='';profileControls.style.display='none';
        buildSection.style.display='';exportPoints.style.display='';buildProfile.style.display='none';
        const i=axisIndex[a];
        const lo=bb&&bb.mn?Number(bb.mn[i]):NaN,hi=bb&&bb.mx?Number(bb.mx[i]):NaN;
        const valid=Number.isFinite(lo)&&Number.isFinite(hi)&&hi>=lo,span=valid?hi-lo:0;
        const step=Math.max(0.001,span/1000),inputMax=valid&&hi>lo?hi:(valid?lo+step:1);
        label.textContent=axisLabel[a]||'Координата, м';
        level.min=valid?String(lo):'0';level.max=valid?String(inputMax):'1';level.step=String(step);
        range.min=valid?String(lo):'0';range.max=valid?String(inputMax):'1';range.step=String(step);
        range.disabled=!valid||span===0;level.disabled=!valid||span===0;
        let lv=Number.isFinite(levels[a])?levels[a]:(valid?(lo+hi)/2:0);
        if(valid)lv=Math.max(lo,Math.min(hi,lv));
        levels[a]=lv;level.value=lv.toFixed(3);range.value=String(lv);
        if(status&&!valid)status.textContent='Не удалось определить границы облака.';
      }
      axis.addEventListener('change',syncAxis);
      range.addEventListener('input',()=>{const a=axis.value,lv=Number(range.value);if(!Number.isFinite(lv))return;levels[a]=lv;level.value=lv.toFixed(3);});
      level.addEventListener('change',()=>{const a=axis.value,cur=viewer(),bb=cur&&cur.bbox,i=axisIndex[a];let lv=Number(level.value);if(!Number.isFinite(lv))return;if(bb&&bb.mn&&bb.mx)lv=Math.max(bb.mn[i],Math.min(bb.mx[i],lv));levels[a]=lv;level.value=lv.toFixed(3);range.value=String(lv);});
      buildSection.addEventListener('click',async()=>{
        if(sectionBusy)return;
        const axis=axisElValue(),level=Number($('lxSectionLevel').value),thickness=Number($('lxSectionThickness').value),cell=Number($('lxSectionCell').value),minArea=Number($('lxSectionMinArea').value);
        if(!Number.isFinite(level)||!(thickness>0)||!Number.isFinite(thickness)||!(cell>=0.01)||!Number.isFinite(cell)||!(minArea>=0)||!Number.isFinite(minArea)){notify('Проверьте положение, толщину, ячейку и порог площади');return;}
        const ui=window.__lxDrawUI;if(!ui||!ui.session||!ui.sectionFromCloudAsync){notify('Фоновый модуль сечений недоступен');return;}
        const startDrawing=ui.session();if(!startDrawing){notify('Не удалось открыть чертёж');return;}
        const originalEntities=startDrawing.entities.slice();
        try {
          setSectionBusy(true);jobProgress.value=0;status.textContent='Запуск расчёта в фоне…';
          const result=await ui.sectionFromCloudAsync({axis,level,thickness,cell,minArea,onProgress:sectionProgress});
          if(result&&result.ok){
            const s=ui.session();
            const added=s.entities.slice(originalEntities.length);
            added.forEach(e=>{e.generatedBy='section-v1232';});
            s.entities=originalEntities.filter(e=>!/^section-v\d+$/.test(String(e.generatedBy||''))).concat(added);
            ui.refreshLayers();ui.draw();
            $('lxSectionStatus').textContent=result.loops+' контур(ов) · '+result.sliced+' точек · '+axis.toUpperCase()+'='+level.toFixed(3)+' м';
          }else if(result&&result.cancelled){
            $('lxSectionStatus').textContent='Расчёт отменён · чертёж не изменён';
          }else{
            const stats=result&&result.stats;
            $('lxSectionStatus').textContent=(result&&result.error)||(stats&&stats.discardedSmall?'Все контуры отсечены порогом площади. Уменьшите минимум или поставьте 0.':'Замкнутый контур не найден. Проверьте уровень, толщину и размер ячейки.');
          }
        } catch(err) {$('lxSectionStatus').textContent=err.message||'Не удалось построить сечение';}
        finally {setSectionBusy(false);}
      });
      exportPoints.addEventListener('click',()=>{
        const axis=axisElValue(),level=Number($('lxSectionLevel').value),thickness=Number($('lxSectionThickness').value);
        if(!['x','y','z'].includes(axis)||!Number.isFinite(level)||!(thickness>0)||!Number.isFinite(thickness)){
          $('lxSectionStatus').textContent='Проверьте ось, положение и положительную толщину полосы.';
          notify('Проверьте ось, положение и толщину среза');return;
        }
        const ui=window.__lxDrawUI;
        if(!ui||typeof ui.exportSectionPoints!=='function'){
          $('lxSectionStatus').textContent='Экспорт точек сечения недоступен.';
          notify('Экспорт точек сечения недоступен');return;
        }
        const result=ui.exportSectionPoints({axis,level,thickness});
        if(result&&result.ok){
          $('lxSectionStatus').textContent=result.count.toLocaleString('ru-RU')+' точек · CSV + JSON · '+
            (result.frame==='source'?'исходная система координат':'локальные координаты вьюера')+
            (result.hasCrs?' · CRS приложена':' · CRS не подтверждена');
        }else{
          $('lxSectionStatus').textContent=result&&result.error||'Не удалось экспортировать точки полосы.';
        }
      });
      buildProfile.addEventListener('click',async()=>{
        if(sectionBusy)return;
        const readNumber=(id)=>{const el=$(id);return el&&el.value.trim()!==''?Number(el.value):NaN;};
        const azimuthDeg=readNumber('lxSectionAzimuth'),originX=readNumber('lxSectionOriginX'),originZ=readNumber('lxSectionOriginZ'),offset=readNumber('lxSectionOffset');
        const thickness=readNumber('lxSectionThickness'),cell=readNumber('lxSectionCell'),minArea=readNumber('lxSectionMinArea');
        if(![azimuthDeg,originX,originZ,offset].every(Number.isFinite)||!(thickness>0)||!Number.isFinite(thickness)||!(cell>=0.01)||!Number.isFinite(cell)||!(minArea>=0)||!Number.isFinite(minArea)){notify('Проверьте азимут, начало X/Z, смещение, толщину, ячейку и порог площади');return;}
        const ui=window.__lxDrawUI;if(!ui||!ui.exportProfileDxfAsync){notify('Фоновый экспорт наклонного профиля недоступен');return;}
        try{
          setSectionBusy(true);jobProgress.value=0;status.textContent='Запуск расчёта профиля в фоне…';
          const result=await ui.exportProfileDxfAsync({
            origin:[originX,originZ],azimuthDeg,offset,thickness,cell,minArea,onProgress:sectionProgress
          });
          if(result&&result.ok){
            status.textContent=result.loops+' контур(ов) · '+result.sliced+' точек · DXF + CSV · станция/отметка · азимут '+result.stats.azimuthDeg.toFixed(2)+'°';
          }else if(result&&result.cancelled){
            status.textContent='Расчёт профиля отменён · файлы не созданы';
          }else{
            const stats=result&&result.stats;status.textContent=(result&&result.error)||'Не удалось сформировать профиль';
            if(stats&&stats.sliced)status.textContent+=' · точек '+stats.sliced;
          }
        }catch(err){status.textContent=err.message||'Не удалось сформировать профиль';}
        finally{setSectionBusy(false);}
      });
      function presetMessage(message,isError){
        if(!presetStatus)return;
        presetStatus.textContent=message||'';
        presetStatus.dataset.state=isError?'error':'ok';
      }
      function presetApi(){
        const api=window.bimAPI;
        if(!api||typeof api.listSectionPresets!=='function'||typeof api.saveSectionPreset!=='function'||typeof api.deleteSectionPreset!=='function'){
          presetMessage('Сохранение наборов доступно в настольной версии с хранилищем проекта.',true);
          return null;
        }
        return api;
      }
      function selectedPreset(){
        return savedPresets.find(p=>p.id===presetSelect.value)||null;
      }
      function updatePresetActions(){
        const has=!!selectedPreset();
        applyPreset.disabled=!has;
        deletePreset.disabled=!has;
      }
      async function refreshSectionPresets(preferredId){
        if(!presetSelect)return;
        const oldId=preferredId||presetSelect.value;
        const api=presetApi();
        if(!api){
          presetSelect.innerHTML='<option value="">Хранилище недоступно</option>';
          updatePresetActions();savePreset.disabled=true;return;
        }
        savePreset.disabled=false;presetSelect.disabled=true;
        try{
          const items=await api.listSectionPresets();
          if(!Array.isArray(items))throw new Error('Хранилище вернуло неверный список наборов');
          savedPresets=items;
          presetSelect.replaceChildren();
          const placeholder=document.createElement('option');
          placeholder.value='';
          placeholder.textContent=items.length?'— Выберите сохранённый набор —':'— В проекте пока нет наборов —';
          presetSelect.appendChild(placeholder);
          items.forEach(item=>{
            const option=document.createElement('option');
            option.value=String(item.id||'');
            option.textContent=String(item.name||'Без названия')+(item.source&&item.source.name?' · '+item.source.name:'');
            option.title=option.textContent;
            presetSelect.appendChild(option);
          });
          presetSelect.value=oldId&&items.some(item=>item.id===oldId)?oldId:'';
          presetMessage('Сохранение привязано к текущему проекту и входит в его резервную копию.');
        }catch(err){
          savedPresets=[];
          presetSelect.replaceChildren();
          const option=document.createElement('option');
          option.value='';option.textContent='Не удалось загрузить наборы';presetSelect.appendChild(option);
          presetMessage('Ошибка чтения наборов: '+(err&&err.message||String(err)),true);
        }finally{
          presetSelect.disabled=false;
          updatePresetActions();
        }
      }
      function sourceSnapshot(){
        const v=viewer(),record=v&&v._cloudRecord||{},bbox=v&&v.bbox,info=v&&v.getCloudInfo?v.getCloudInfo():null;
        const rawName=String(record.sourceName||record.name||'');
        const baseName=rawName.replace(/\\/g,'/').split('/').pop().slice(0,256);
        const rawCount=record.loadedCount!=null?record.loadedCount:(info&&info.loadedCount);
        const pointCount=Number.isSafeInteger(Number(rawCount))&&Number(rawCount)>0?Number(rawCount):null;
        const min=bbox&&bbox.mn&&bbox.mn.length>=3?Array.from(bbox.mn).slice(0,3):null;
        const max=bbox&&bbox.mx&&bbox.mx.length>=3?Array.from(bbox.mx).slice(0,3):null;
        const rawTransform=v&&v._srcXform;
        const srcXform=rawTransform&&rawTransform.t&&rawTransform.t.length>=3
          ?{axis:rawTransform.axis,t:Array.from(rawTransform.t).slice(0,3)}:null;
        let pointSampleHash='';
        try{
          const cloud=v&&v.getEditedCloud&&v.getEditedCloud(),pos=cloud&&(cloud.pos||cloud.positions);
          const count=cloud&&cloud.count!=null?Number(cloud.count):(pos?Math.floor(pos.length/3):0);
          if(pos&&Number.isSafeInteger(count)&&count>0&&count*3<=pos.length){
            let hash=2166136261;
            const add=text=>{for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}};
            const samples=Math.min(64,count);
            for(let i=0;i<samples;i++){
              const point=samples===1?0:Math.floor(i*(count-1)/(samples-1)),offset=point*3;
              for(let j=0;j<3;j++){const n=Number(pos[offset+j]);add(Number.isFinite(n)?n.toPrecision(10):'NaN');}
            }
            pointSampleHash=(hash>>>0).toString(16).padStart(8,'0');
          }
        }catch(_){}
        return {name:baseName,pointCount,pointSampleHash,bounds:min&&max?{min,max}:null,srcXform,crsCode:String(v&&v._srcEpsg||'')};
      }
      function currentPresetDraft(){
        const ax=axis.value;
        const read=(id)=>{const input=$(id);if(!input||input.value.trim()==='')return NaN;return Number(input.value);};
        const fallback=(id,value)=>{const result=read(id);return Number.isFinite(result)?result:value;};
        return {
          name:presetName.value.trim(),
          source:sourceSnapshot(),
          params:{
            axis:ax,
            level:ax==='profile'?null:read('lxSectionLevel'),
            thickness:read('lxSectionThickness'),
            cell:read('lxSectionCell'),
            minArea:read('lxSectionMinArea'),
            azimuthDeg:fallback('lxSectionAzimuth',0),
            originX:fallback('lxSectionOriginX',0),
            originZ:fallback('lxSectionOriginZ',0),
            offset:fallback('lxSectionOffset',0)
          }
        };
      }
      function sourceMismatch(saved,current){
        const a=saved||{},b=current||{},reasons=[];
        if(!a.name||!b.name||a.name.toLocaleLowerCase('ru-RU')!==b.name.toLocaleLowerCase('ru-RU'))reasons.push('имя файла');
        if(a.pointCount!=null&&b.pointCount!=null&&a.pointCount!==b.pointCount)reasons.push('количество точек');
        if(!!a.pointSampleHash!==!!b.pointSampleHash||a.pointSampleHash!==b.pointSampleHash)reasons.push('контрольная выборка точек');
        if(a.bounds&&b.bounds){
          const span=Math.max(...a.bounds.max.map((v,i)=>Math.abs(v-a.bounds.min[i])),...b.bounds.max.map((v,i)=>Math.abs(v-b.bounds.min[i])),1);
          const tol=Math.max(0.001,span*1e-7);
          for(let i=0;i<3;i++)if(Math.abs(a.bounds.min[i]-b.bounds.min[i])>tol||Math.abs(a.bounds.max[i]-b.bounds.max[i])>tol){reasons.push('границы облака');break;}
        }else if(!!a.bounds!==!!b.bounds)reasons.push('границы облака не подтверждены');
        const at=a.srcXform,bt=b.srcXform;
        if(!!at!==!!bt)reasons.push('преобразование координат');
        else if(at&&(at.axis!==bt.axis||at.t.some((v,i)=>!Number.isFinite(bt.t[i])||Math.abs(v-bt.t[i])>1e-6)))reasons.push('преобразование координат');
        return reasons;
      }
      presetSelect.addEventListener('change',()=>{
        const item=selectedPreset();
        if(item)presetName.value=item.name;
        updatePresetActions();
      });
      savePreset.addEventListener('click',async()=>{
        const api=presetApi();if(!api)return;
        const draft=currentPresetDraft();
        if(!draft.name){presetMessage('Введите название набора.',true);presetName.focus();return;}
        try{
          const key=draft.name.normalize('NFKC').toLocaleLowerCase('ru-RU');
          const old=savedPresets.find(item=>String(item.name||'').normalize('NFKC').toLocaleLowerCase('ru-RU')===key);
          if(old&&!window.confirm('Набор «'+old.name+'» уже существует в этом проекте. Обновить его текущими параметрами?'))return;
          savePreset.disabled=true;
          const result=await api.saveSectionPreset(draft);
          if(!result||!result.ok||!result.preset)throw new Error('Не удалось сохранить набор сечения');
          presetName.value=result.preset.name;
          await refreshSectionPresets(result.preset.id);
          presetMessage((result.replaced?'Набор обновлён: ':'Набор сохранён в проекте: ')+result.preset.name);
        }catch(err){presetMessage('Ошибка сохранения: '+(err&&err.message||String(err)),true);}
        finally{savePreset.disabled=false;}
      });
      applyPreset.addEventListener('click',()=>{
        const item=selectedPreset();if(!item)return;
        const mismatch=sourceMismatch(item.source,sourceSnapshot());
        if(mismatch.length&&!window.confirm('Набор был создан для другого или изменённого облака ('+mismatch.join(', ')+'). Применить только параметры сечения к текущему облаку?'))return;
        try{
          const p=item.params;
          axis.value=p.axis;
          axis.dispatchEvent(new Event('change',{bubbles:true}));
          $('lxSectionThickness').value=String(p.thickness);
          $('lxSectionCell').value=String(p.cell);
          $('lxSectionMinArea').value=String(p.minArea);
          if(p.axis==='profile'){
            $('lxSectionAzimuth').value=String(p.azimuthDeg);
            $('lxSectionOriginX').value=String(p.originX);
            $('lxSectionOriginZ').value=String(p.originZ);
            $('lxSectionOffset').value=String(p.offset);
          }else{
            $('lxSectionLevel').value=String(p.level);
            $('lxSectionLevel').dispatchEvent(new Event('change',{bubbles:true}));
          }
          const actual=p.axis==='profile'?null:Number($('lxSectionLevel').value);
          const clamped=p.axis!=='profile'&&Number.isFinite(actual)&&Math.abs(actual-p.level)>0.0005;
          presetMessage('Параметры «'+item.name+'» применены'+(clamped?' · уровень ограничен границами текущего облака':'')+'; контур не перестраивался.');
        }catch(err){presetMessage('Не удалось применить набор: '+(err&&err.message||String(err)),true);}
      });
      deletePreset.addEventListener('click',async()=>{
        const item=selectedPreset(),api=presetApi();if(!item||!api)return;
        if(!window.confirm('Удалить набор сечения «'+item.name+'» из текущего проекта?'))return;
        deletePreset.disabled=true;
        try{
          const result=await api.deleteSectionPreset(item.id);
          if(!result||!result.deleted)throw new Error('Набор уже отсутствует');
          presetName.value='';
          await refreshSectionPresets();
          presetMessage('Набор «'+item.name+'» удалён из проекта.');
        }catch(err){presetMessage('Ошибка удаления: '+(err&&err.message||String(err)),true);updatePresetActions();}
      });
      if(!panel._sectionProjectEventWired){
        panel._sectionProjectEventWired=true;
        window.addEventListener('bim-project-changed',()=>panel._refreshSectionPresets&&panel._refreshSectionPresets());
      }
      panel._refreshSectionPresets=refreshSectionPresets;
      refreshSectionPresets();
      function axisElValue(){return axis.value;}
      panel._syncSectionAxis=syncAxis;
    }
    if(panel._syncSectionAxis)panel._syncSectionAxis();
    panel.style.display='block';
  }
  window.__lxWorkspace={build,exitTools,escape,toolbarAction,sync,projectToggle,propertiesToggle,openSectionControls};
  window.addEventListener('bim-cloud-change',()=>window.__lxDrawUI?.cancelSectionJob?.());
  window.addEventListener('bim-project-changed',()=>window.__lxDrawUI?.cancelSectionJob?.());
  window.addEventListener('bim-app-ready',build);
  window.addEventListener('DOMContentLoaded',()=>setTimeout(build,160));
})();
