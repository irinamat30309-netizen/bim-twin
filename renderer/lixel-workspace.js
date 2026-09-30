/* Workspace controller: the one place that knows how to leave the current tool, how Esc peels
 * layers (modal -> menu -> selection -> tool) and the section-outline panel.
 * Layout lives in ui/ (ribbon.js, chrome.js, modes.js); nothing here builds toolbars or panels
 * except the section panel below. Project data and persisted state are untouched.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const viewer = () => window.__viewer || window.__lxViewer;
  const visible = el => !!el && getComputedStyle(el).display !== 'none';
  function notify(text, opts) {
    const k = window.__lxKit;
    if (k && k.toast) { k.toast(text, opts); return; }
    const e = $('toast'); if (e) { e.textContent = text; e.classList.add('show'); setTimeout(() => e.classList.remove('show'), 3000); }
  }
  // Вопрос оператору во встроенном диалоге вместо window.confirm
  function ask(o) { const k = window.__lxKit; return k && k.ask ? k.ask(o) : Promise.resolve(false); }
  function click(id) { const b = $(id); if (b) b.click(); }
  function hide(id) { const e = $(id); if (e) e.style.display = 'none'; }
  function off(ids) { ids.forEach(id => { const e = $(id); if (e) { e.classList.remove('on'); e.setAttribute('aria-pressed', 'false'); } }); }
  function sync() { const r = window.__lxRibbon; if (r && r.sync) r.sync(); }
  function exitTools(except) {
    const v = viewer();
    if (window.__lxDrawUI && window.__lxDrawUI.cancelSectionJob) window.__lxDrawUI.cancelSectionJob();
    if (window.__lxKit && window.__lxKit.closePopover) window.__lxKit.closePopover();
    if (window.__lxCloudUI && window.__lxCloudUI.closeMenu) window.__lxCloudUI.closeMenu();
    if (except !== 'measure') {
      if (v && v.measuring && window.__bimSetMeasuring) window.__bimSetMeasuring(false);
      hide('measureBar'); hide('measureListPanel'); hide('measureReadout'); off(['btnMeasure']);
    }
    if (except !== 'draw' && window.__lxDraw && window.__lxDraw.active && window.__lxDrawUI) window.__lxDrawUI.deactivate(true);
    if (except !== 'edit') { if (v && v.editSelect && v.setEditSelect) v.setEditSelect(false); hide('editBar'); off(['vtEdit']); }
    if (except !== 'walk') { if (v && v.walk && v.setWalk) v.setWalk(false); off(['vtWalk']); }
    if (except !== 'tour') { if (v && v.tour && v.setTour) v.setTour(false); hide('tourBar'); off(['vtTour']); }
    // Exiting section disables the clipping mode, without deleting the cloud.
    if (!except) {
      if (v && v.section && v.section.on && v.setSection) v.setSection(false);
      hide('sectionPanel'); hide('sectionRange'); hide('qualityBar'); hide('lxSectionControls');
      off(['btnSection', 'vtQuality']);
    }
    sync();
  }
  function closeTopModal() {
    const modals = Array.from(document.querySelectorAll('.modal.open,.lx-modal-back,.lx-win-back')).filter(visible);
    if (!modals.length) return false;
    const m = modals.sort((a, b) => (+getComputedStyle(a).zIndex || 0) - (+getComputedStyle(b).zIndex || 0)).pop();
    if (m.id === 'formModal') click(visible($('formCancel')) ? 'formCancel' : 'formOk');
    else if (m.id === 'cmpModal') click('cmpClose');
    else { const close = m.querySelector('.modal-head .x,.lx-modal-a .btn:not(.primary),.lx-win-head .icon-btn:last-child'); if (close) close.click(); else return false; }
    return true;
  }
  function menusClose() {
    const k = window.__lxKit;
    return !!(k && k.closePopover && k.closePopover());
  }
  function drawerOpen() {
    return window.innerWidth <= 1100 && (!root.classList.contains('lx-side-closed') || !root.classList.contains('lx-insp-closed'));
  }
  function toolActive() {
    const v = viewer();
    return !!((v && (v.measuring || v.editSelect || v.walk || v.tour || (v.section && v.section.on))) ||
      (window.__lxDraw && window.__lxDraw.active) ||
      ['measureBar', 'qualityBar', 'sectionPanel', 'lxSectionControls', 'measureListPanel'].some(id => visible($(id))));
  }
  // Esc peels one layer per press: modal -> menu/popover -> drawer -> selection -> active tool.
  function escape() {
    if ($('lxPalette')) return false;
    if (closeTopModal()) return true;
    if (window.__lxKit?.closePopover(true) || window.__lxCloudUI?.closeMenu(true)) return true;
    if (drawerOpen()) {
      const c = window.__lxChrome;
      if (c && c.setSide) { c.setSide(false, false); c.setInspector(false, false); } else root.classList.add('lx-side-closed', 'lx-insp-closed');
      return true;
    }
    // Плавающая панель (Скан → BIM, правка модели): Esc закрывает её, если фокус внутри.
    const fp = [...document.querySelectorAll('.fpanel[data-esc]')].filter(visible).find(x => x.contains(document.activeElement));
    if (fp) { const x = fp.querySelector('[data-panel-close]'); if (x) { x.click(); return true; } }
    const v = viewer();
    if (v && v.editSelect && v.selectionCount && v.selectionCount() && v.clearSelection) { v.clearSelection(); notify('Выделение снято. Ещё Esc — выйти из правки.'); return true; }
    if (toolActive()) {
      if (window.__lxModes && window.__lxModes.cancelAll) window.__lxModes.cancelAll('escape'); else exitTools();
      return true;
    }
    // Ничего другого не осталось: Esc закрывает последнюю открытую плавающую панель, даже если фокус на ленте (в поле ввода — нет).
    const openPanels = [...document.querySelectorAll('.fpanel[data-esc]')].filter(visible), lastPanel = openPanels[openPanels.length - 1];
    if (lastPanel && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement && document.activeElement.tagName) || '')) {
      const x = lastPanel.querySelector('[data-panel-close]'); if (x) { x.click(); return true; }
    }
    return false;
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (escape()) { e.preventDefault(); e.stopImmediatePropagation(); } }
  }, true);
  document.addEventListener('pointerdown', e => {
    if (e.target && e.target.matches('.modal.open,.lx-modal-back')) closeTopModal();
  }, true);
  document.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const v = viewer();
    if (b.id === 'vtQuality' && !b.classList.contains('on')) exitTools();
    if (b.id === 'btnSection' && !(v && v.section && v.section.on)) exitTools();
    if (b.id === 'vtEdit' && !(v && v.editSelect)) exitTools('edit');
    if (b.id === 'vtWalk' && !(v && v.walk)) exitTools('walk');
    if (b.id === 'lxSectBtn') { e.preventDefault(); e.stopImmediatePropagation(); openSectionControls(); return; }
    if (['btnMeasure', 'qEDL', 'btnSection', 'btnLOD'].includes(b.id)) setTimeout(sync, 0);
  }, true);
  // A section is a raster-derived outline, not a certified wall centreline.
  function openSectionControls() {
    let panel=$('lxSectionControls');
    if(panel && visible(panel)){window.__lxDrawUI?.cancelSectionJob?.();hide('lxSectionControls');return;}
    exitTools();
    const v=viewer(),c=v&&v.getEditedCloud&&v.getEditedCloud();
    if(!v || !(v.base && v.base.some(o => o.points)) || !c || !c.pos || !c.pos.length){notify('Сначала загрузите облако точек');return;}
    if(!panel){
      panel=document.createElement('section');panel.id='lxSectionControls';panel.className='fpanel fp-left';panel.setAttribute('aria-label','Контур сечения');
      panel.innerHTML='<div class="fpanel-inner"><header class="fpanel-head"><span class="fpanel-ico" data-ico="scan-line"></span><h3>Контур сечения</h3><div class="fpanel-actions"><button class="icon-btn" type="button" data-close="lxSectionControls" data-ico="x" title="Закрыть" aria-label="Закрыть"></button></div></header><div class="fpanel-body lx-sec-body">' +
        '<label class="lx-field">Плоскость среза<select id="lxSectionAxis" aria-label="Ориентация сечения"><option value="y">Горизонтальный · план (Y)</option><option value="z">Вертикальный · фасад (Z)</option><option value="x">Вертикальный · сбоку (X)</option><option value="profile">Вертикальный · наклонный профиль</option></select></label>' +
        '<button id="lxBuildSection" class="btn sm">Построить контур</button>' +
        '<button id="lxExportSectionPoints" class="btn sm" type="button" aria-label="Сохранить точки полосы сечения в CSV и метаданные JSON" title="Экспортирует фактические точки полосы; source coordinates используются только при валидном преобразовании">Сохранить точки полосы · CSV + JSON</button>' +
        '<button id="lxBuildProfile" class="btn sm">Сформировать профиль DXF + CSV</button>' +
        '<div id="lxSectionStatus" role="status" aria-live="polite"></div>' +
        '<div id="lxSectionJob">' +
        '<progress id="lxSectionProgress" class="lx-sec-progress" max="100" value="0" aria-label="Прогресс фонового расчёта сечения"></progress>' +
        '<button id="lxCancelSection" class="btn sm" type="button" aria-label="Отменить расчёт сечения">Отменить</button></div>' +
        '<label class="lx-field" id="lxSectionLevelField"><span id="lxSectionLevelLabel">Уровень Y, м</span><input id="lxSectionLevel" type="number" step="0.01"><input id="lxSectionRange" aria-label="Положение сечения" type="range" step="0.01"></label>' +
        '<div id="lxSectionProfileControls">' +
        '<label class="lx-field">Азимут линии, ° (0° = +X; 90° = +Z)<input id="lxSectionAzimuth" type="number" step="0.1" value="0"></label>' +
        '<label class="lx-field">Начало станции X, м<input id="lxSectionOriginX" type="number" step="0.01"></label>' +
        '<label class="lx-field">Начало станции Z, м<input id="lxSectionOriginZ" type="number" step="0.01"></label>' +
        '<label class="lx-field">Смещение плоскости по нормали, м<input id="lxSectionOffset" type="number" step="0.01" value="0"></label>' +
        '<p class="sec-note">Станция 0 задаётся началом X/Z; профиль строится по всему облаку вдоль линии. В DXF: X = станция, Y = высота. Координаты и параметры плоскости сохраняются в CSV.</p>' +
        '</div>' +
        '<label class="lx-field">Толщина полосы, м<input id="lxSectionThickness" type="number" min="0.01" max="100" step="0.01" value="0.2"></label>' +
        '<label class="lx-field">Размер ячейки, м<input id="lxSectionCell" type="number" min="0.01" max="10" step="0.01" value="0.1"></label>' +
        '<label class="lx-field">Мин. площадь контура, м²<input id="lxSectionMinArea" type="number" min="0" max="10000" step="0.01" value="0.02"></label>' +
        '<div class="lx-section-presets" aria-label="Сохранённые наборы сечений проекта">' +
        '<div class="lx-section-presets-title">Наборы сечений проекта</div>' +
        '<label class="lx-field">Название набора<input id="lxSectionPresetName" type="text" maxlength="80" autocomplete="off" placeholder="Например: Этаж 2 — фасад"></label>' +
        '<div class="lx-section-preset-row">' +
        '<select id="lxSectionPresetSelect" aria-label="Сохранённые наборы сечений"><option value="">Загрузка…</option></select>' +
        '<button id="lxApplySectionPreset" class="btn sm" type="button" disabled>Применить</button>' +
        '<button id="lxDeleteSectionPreset" class="btn sm" type="button" disabled aria-label="Удалить сохранённый набор">Удалить</button>' +
        '</div>' +
        '<button id="lxSaveSectionPreset" class="btn sm" type="button" aria-label="Сохранить параметры сечения в проекте">Сохранить набор</button>' +
        '<div id="lxSectionPresetStatus" role="status" aria-live="polite"></div>' +
        '</div>' +
        '<p class="sec-note">Растровый контур занятой области, не сертифицированная ось стены. Размер ячейки задаёт детализацию. Мелкие фрагменты ниже порога площади отсеиваются; поставьте 0, чтобы сохранить все.</p></div></div>';
      (($('stageSideL')||document.querySelector('.stage')).append(panel));
      if(window.__lxKit&&window.__lxKit.hydrate)window.__lxKit.hydrate(panel);
      $('lxSectionJob').style.display='none';
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
          if(old&&!(await ask({title:'Набор уже существует',message:'Набор «'+old.name+'» уже существует в этом проекте. Обновить его текущими параметрами?',okLabel:'Обновить'})))return;
          savePreset.disabled=true;
          const result=await api.saveSectionPreset(draft);
          if(!result||!result.ok||!result.preset)throw new Error('Не удалось сохранить набор сечения');
          presetName.value=result.preset.name;
          await refreshSectionPresets(result.preset.id);
          presetMessage((result.replaced?'Набор обновлён: ':'Набор сохранён в проекте: ')+result.preset.name);
        }catch(err){presetMessage('Ошибка сохранения: '+(err&&err.message||String(err)),true);}
        finally{savePreset.disabled=false;}
      });
      applyPreset.addEventListener('click',async()=>{
        const item=selectedPreset();if(!item)return;
        const mismatch=sourceMismatch(item.source,sourceSnapshot());
        if(mismatch.length&&!(await ask({title:'Другое облако',message:'Набор был создан для другого или изменённого облака ('+mismatch.join(', ')+'). Применить только параметры сечения к текущему облаку?',okLabel:'Применить',danger:true})))return;
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
        if(!(await ask({title:'Удалить набор',message:'Удалить набор сечения «'+item.name+'» из текущего проекта?',okLabel:'Удалить',danger:true})))return;
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
  window.__lxWorkspace = { exitTools, escape, menusClose, sync, openSectionControls };
  window.addEventListener('bim-cloud-change', () => window.__lxDrawUI?.cancelSectionJob?.());
  window.addEventListener('bim-project-changed', () => window.__lxDrawUI?.cancelSectionJob?.());
})();
