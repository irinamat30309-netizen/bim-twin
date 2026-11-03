/* Run against a loaded index.html in Chromium using agent-browser eval --stdin.
 * Uses the real renderer, real UI event handlers and deterministic point data.
 * Desktop IPC, external SDKs and production-size clouds are intentionally not mocked.
 */
(async function () {
  const $=id=>document.getElementById(id),v=window.__viewer,checks=[];
  const visible=e=>!!e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0;
  const wait=()=>new Promise(r=>setTimeout(r,80));
  const eq=(a,b,m)=>{if(a!==b)throw Error(m+': '+JSON.stringify(a)+' != '+JSON.stringify(b));};
  const ok=(a,m)=>{if(!a)throw Error(m);};
  async function check(name,fn){try{await fn();checks.push({name,pass:true});}catch(e){checks.push({name,pass:false,error:e.message});}}
  const pressEsc=()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  const tab=t=>document.querySelector('#lxTabs [data-tab="'+t+'"]').click();
  if(visible($('onboard'))) $('onbSkip').click();
  window.__lxWorkspace.build();
  await check('Real WebGL renderer',()=>{ok(v&&v.gl&&v.supportsTools,'WebGL not available');});
  await check('Reference layout: scene left, inspector under full-width ribbon',()=>{
    const s=document.querySelector('.stage').getBoundingClientRect(),t=$('lxTabs').getBoundingClientRect(),r=document.querySelector('.inspector').getBoundingClientRect();
    eq(s.left,0,'scene left');eq(t.left,0,'ribbon left');ok(Math.abs(s.top-r.top)<1,'inspector starts beside viewport');ok(s.height>innerHeight*.55,'viewport too short');
  });
  await check('Console collapsed, project drawer accessible',()=>{ok($('devConsole').classList.contains('collapsed'),'console open');eq(getComputedStyle(document.querySelector('.sidebar')).display,'none','drawer initial');$('lxProjectToggle').click();ok(visible(document.querySelector('.sidebar')),'drawer closed');pressEsc();eq(visible(document.querySelector('.sidebar')),false,'Escape drawer');});
  await check('All six ribbon tabs and full labels',()=>{
    ['home','process','tool','draw','object','app'].forEach(t=>{
      tab(t);const buttons=[...document.querySelectorAll('.toolbar .lx-bigbtn')].filter(visible);ok(buttons.length>0,'empty '+t);
      for(const b of buttons){const l=b.querySelector('.lx-blabel');if(l){ok(l.scrollHeight<=l.clientHeight+1,'clipped '+b.id+' label');ok(b.offsetHeight>=62,'button shrunk '+b.id);}}
    });
  });
  await check('Object properties and documents remain reachable',()=>{tab('object');ok($('lxPropertiesBody').classList.contains('open'),'object panel closed');ok($('tabbody'),'documents missing');$('lxPropertiesToggle').click();eq($('lxPropertiesBody').classList.contains('open'),false,'panel toggle');});
  await check('Measure opens from vertical toolbar',()=>{document.querySelector('#lxLtbar [data-tool="measure"]').click();ok(v.measuring,'not measuring');ok(visible($('measureBar')),'bar hidden');});
  await check('Measurement loupe never covers UI menus',async()=>{
    const r=$('mmAngle').getBoundingClientRect();v._ensureLoupe().wrap.style.display='block';v._hoverMeasure(r.left+5,r.top+5);await wait();eq(v._loupe.wrap.style.display,'none','loupe remained over menu');
  });
  await check('Measure modes match actual renderer',()=>{document.querySelectorAll('#measureBar [data-mm]').forEach(b=>{b.click();eq(v.measureMode,b.dataset.mm,'mode');});});
  await check('Actual measured distance 3-4-5',()=>{$('mmDistance').click();v._measureClick([0,0,0]);v._measureClick([3,4,0]);ok(v._measResult,'no result');const d=window.Measure.distance([0,0,0],[3,4,0]);eq(v._measResult.d3,5,'distance 3D');eq(v._measResult.horizontal,3,'horizontal');eq(v._measResult.vertical,4,'vertical');ok(Object.values(d).some(x=>x===5),'not 5 metres');});
  await check('Actual measured right angle',()=>{$('mmAngle').click();v._measureClick([1,0,0]);v._measureClick([0,0,0]);v._measureClick([0,0,1]);ok(Math.abs(v._measResult.deg-90)<1e-8,'not 90 degrees');});
  await check('Save measurement survives exiting mode',()=>{$('mmSave').click();const saved=$('mmList').textContent;ok(/1/.test(saved),'not saved');$('mmExit').click();eq(v.measuring,false,'mode remains');eq(visible($('measureBar')),false,'bar remains');eq($('mmList').textContent,saved,'saved result lost');});
  await check('Repeated open/close never leaves active state',()=>{for(let i=0;i<5;i++){$('btnMeasure').click();ok(v.measuring,'did not open');pressEsc();eq(v.measuring,false,'did not close');eq($('btnMeasure').classList.contains('on'),false,'stale state');eq(visible($('measureReadout')),false,'stale readout');}});
  await check('Finish figure differs from exit',()=>{$('btnMeasure').click();$('mmPolyline').click();v._measureClick([0,0,0]);v._measureClick([1,0,0]);$('mmFinish').click();ok(v.measuring,'finish must not exit');$('measureBar').querySelector('.lx-panel-close').click();eq(v.measuring,false,'close button did not exit');});
  await check('Drawing and measuring are mutually exclusive; Escape cancels draft',()=>{
    $('btnMeasure').click();const u=window.__lxDrawUI;u.setActive('line');eq(v.measuring,false,'measurement still active');ok(window.__lxDraw.active,'draw inactive');u.session().addVertex([1,0,1]);const n=u.session().count();pressEsc();eq(window.__lxDraw.active,false,'draw stuck');eq(u.session().draft,null,'draft not canceled');eq(u.session().count(),n,'Escape committed a draft');
  });
  await check('Tab change exits drawing',()=>{window.__lxDrawUI.setActive('polyline');tab('home');eq(window.__lxDraw.active,false,'draw survives leaving tab');});
  await check('Section clipping zero remains zero and exits cleanly',async()=>{
    $('btnSection').click();await wait();ok(v.section.on,'clip off');const max=$('sec_y_max');max.value='0';max.dispatchEvent(new Event('input',{bubbles:true}));eq(v.section.max[1],0,'zero upper bound becomes 100');$('sectionPanel').querySelector('.lx-panel-close').click();eq(v.section.on,false,'clip stuck');eq(visible($('sectionPanel')),false,'panel stuck');
  });
  await check('Language switching preserves ribbon icons',()=>{for(const lang of ['uk','en','ru']){window.I18N.set(lang);window.I18N.apply(document);ok($('btnMeasure').querySelector('.lx-bic svg'),'measure icon lost');ok(document.querySelector('label[for="ifcInput"] .lx-bic svg'),'upload icon lost');}});
  await check('Metadata edit toggle keeps its icon',()=>{$('btnEdit').click();ok($('btnEdit').querySelector('.lx-bic svg'),'edit icon lost');$('btnEdit').click();ok($('btnEdit').querySelector('.lx-bic svg'),'edit icon lost on exit');});
  await check('Theme button changes the renderer theme, not only an icon',()=>{const theme=v.theme;document.querySelector('.lx-tbtheme').click();ok(v.theme!==theme,'theme unchanged');document.querySelector('.lx-tbtheme').click();eq(v.theme,theme,'theme did not restore');});
  await check('Standard view control opens, changes camera, closes',()=>{document.querySelector('.lx-cube').click();ok(visible($('viewCube')),'view picker hidden');$('viewCube').querySelector('[data-view="top"]').click();document.querySelector('.lx-cube').click();eq(visible($('viewCube')),false,'view picker stuck');});
  await check('Settings modal closes on Escape',async()=>{$('btnSettings').click();await wait();ok(document.querySelector('.modal.open'),'settings did not open');pressEsc();eq(document.querySelectorAll('.modal.open').length,0,'settings remains');});
  await check('Floor modal cancels with Escape without creating a floor',()=>{$('lxAddFloorTree').click();ok(document.querySelector('.lx-modal-back'),'no modal');pressEsc();eq(document.querySelectorAll('.lx-modal-back').length,0,'floor modal remains');});
  await check('Unsupported controls disabled, not fake successes',()=>{eq(document.querySelector('#lxLtbar [data-tool="xray"]').disabled,true,'fake xray');eq(document.querySelector('[data-lxeye="lcc"]').disabled,true,'fake LCC visibility');});
  await check('Real PLY parser to WebGL cloud loader',async()=>{
    const res=await fetch('../test/fixtures/room-v1089.ply');ok(res.ok,'fixture unavailable');const buf=await res.arrayBuffer();const parsed=window.PointCloud.parsePLY(buf);ok(parsed.ok!==false,'PLY parse failed');v.loadCloud(parsed);ok(v.base[0].points,'not a point cloud');eq(v.base[0].count,4464,'point count');
  });
  await check('Cloud visibility changes actual renderer flag',()=>{const b=document.querySelector('[data-eye="cloud"]');b.click();eq(v.cloudVisible,false,'not hidden');document.querySelector('[data-eye="cloud"]').click();eq(v.cloudVisible,true,'not shown');});
  await check('Section controls connect to actual loaded cloud and replace only generated contours',()=>{
    tab('draw');$('lxSectBtn').click();ok(visible($('lxSectionControls')),'section controls unavailable');$('lxSectionLevel').value='1.5';$('lxBuildSection').click();
    const s=window.__lxDrawUI.session(),n=s.entities.filter(e=>e.generatedBy==='section-v1089').length;ok(n>=2,'expected inner/outer contours');$('lxBuildSection').click();eq(s.entities.filter(e=>e.generatedBy==='section-v1089').length,n,'duplicate contours');
    const out=window.DXFParse.parse(s.toDxf());ok(out.some(e=>e.layer==='SECTION'),'DXF section layer missing');pressEsc();eq(visible($('lxSectionControls')),false,'section panel stuck');
  });
  await check('Geometry menu closes with Escape',async()=>{$('vtGeom').click();await wait();ok($('geomMenu'),'menu not open');pressEsc();eq($('geomMenu'),null,'menu stuck');});
  await check('Cleaning menu closes outside',async()=>{$('vtTools').click();await wait();ok($('cleanMenu'),'menu not open');$('lxWinTab').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));eq($('cleanMenu'),null,'menu stuck');});
  await check('Console restores and collapses',()=>{$('lxLogToggle').click();eq($('devConsole').classList.contains('collapsed'),false,'console closed');$('dcClose').click();ok($('devConsole').classList.contains('collapsed'),'console did not collapse');});
  await check('No uncaught browser errors',()=>{const errors=[...document.querySelectorAll('.dc-error')].map(e=>e.textContent);ok(errors.length===0,errors.join('\n'));});
  window.__lxWorkspace.exitTools();tab('home');window.__lxWorkspace.build();
  const result={viewport:[innerWidth,innerHeight],passed:checks.filter(c=>c.pass).length,total:checks.length,checks};
  window.__qaV1089=result;return JSON.stringify(result);
})();
