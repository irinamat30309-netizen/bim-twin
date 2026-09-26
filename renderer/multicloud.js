
/* multicloud.js — Sprint 0 (v1091): real multi-scan.
 * Manages multiple point clouds with independent visibility, opacity, color, name.
 * window.MultiCloud + module.exports (for tests).
 */
(function () {
  'use strict';
  var _clouds = [];
  var _activeId = null;
  var _nextId = 1;
  var LS_KEY = 'bim.multicloud.v1091';
  var _ls = (typeof localStorage !== 'undefined') ? localStorage : {
    _s:{}, getItem:function(k){return this._s[k]||null;}, setItem:function(k,v){this._s[k]=v;}, removeItem:function(k){delete this._s[k];}
  };
  var _projectStateReady = false;
  var _lastProjectStateToken = '';
  var _projectRestoreSerial = 0;
  var _suppressLoadedCloudSync = false;
  function uid(){return 'mc'+(_nextId++)+'_'+Date.now().toString(36);}
  function viewer(){return (typeof window!=='undefined')?(window.__viewer||null):null;}
  function projectKey() { var ps=typeof window!=='undefined'&&window.BimProjectState; return ps&&ps.projectId?LS_KEY+':'+ps.projectId:LS_KEY; }
  function toast(m){
    try{var el=document&&document.getElementById('toast');
    if(el){el.textContent=m;el.classList.add('show');setTimeout(function(){el.classList.remove('show');},2600);}}catch(e){}
  }
  function save(){
    var meta;
    try{
      meta=_clouds.map(function(c){
        return{id:c.id,name:c.name,path:c.path,color:c.color,visible:c.visible,opacity:c.opacity,count:c.count,
          bbox:c.bbox||null,srcXform:c.srcXform||null,crsWkt:c.crsWkt||null,classification:c.classification||null};
      });
      _ls.setItem(projectKey(), JSON.stringify({clouds:meta,activeId:_activeId}));
      if(!_projectStateReady) _ls.setItem(LS_KEY, JSON.stringify({clouds:meta,activeId:_activeId}));
    }catch(e){}
    var ps=typeof window!=='undefined'&&window.BimProjectState;
    if(_projectStateReady&&ps&&ps.update){
      var transforms=meta.filter(function(c){return c.srcXform||c.crsWkt;}).map(function(c){return{id:c.id,cloudId:c.id,srcXform:c.srcXform||null,crsWkt:c.crsWkt||null};});
      ps.update({cloudsVersion:1,clouds:meta,activeCloudId:_activeId,transforms:transforms})
        .catch(function(e){try{console.warn('[multicloud] project save failed',e);}catch(_){}});
    }
  }
  function applyMeta(d){
    if(d&&Array.isArray(d.clouds)){
      _clouds=d.clouds.map(function(m){
        return{id:m.id||uid(),name:m.name||'Облако',path:m.path||'',
          color:m.color||'#61d4ff',visible:m.visible!==false,
          opacity:m.opacity!=null?m.opacity:1.0,count:m.count||0,pts:null,bbox:m.bbox||null,
          srcXform:m.srcXform||null,crsWkt:m.crsWkt||null,classification:m.classification||null};
      });
      _activeId=d.activeId||null;
      if(!_clouds.some(function(c){return c.id===_activeId;})) _activeId=_clouds.length?_clouds[0].id:null;
    }
  }
  function load(key){
    try{var d=JSON.parse(_ls.getItem(key||projectKey()));if(d)applyMeta(d);}catch(e){}
  }
  function openActiveProjectCloud(cloud, token, serial, attempt) {
    if (!cloud || !cloud.path || typeof window === 'undefined') return;
    attempt = attempt || 0;
    var v = viewer(), api = window.bimAPI;
    if (!v || !api || typeof api.parseCloud !== 'function') {
      if (attempt < 40) setTimeout(function () { openActiveProjectCloud(cloud, token, serial, attempt + 1); }, 100);
      return;
    }
    Promise.resolve(api.parseCloud(cloud.path)).then(function (parsed) {
      var ps = window.BimProjectState;
      if (serial !== _projectRestoreSerial || !ps || token !== String(ps.projectId || '') + ':' + String(ps.revision || 0)) return;
      if (!parsed || !parsed.ok || !parsed.pos || !parsed.pos.length) {
        toast('Скан проекта не загружен: исходный файл недоступен или повреждён');
        return;
      }
      _suppressLoadedCloudSync = true;
      try { v.loadCloud(parsed, { sourceName: cloud.path }); }
      finally { _suppressLoadedCloudSync = false; }
      try { if (window.MultiCloud && window.MultiCloud.syncFromViewer) window.MultiCloud.syncFromViewer(cloud.name, cloud.path, { persist: false }); } catch (_) {}
      try {
        window.dispatchEvent(new CustomEvent('bim-project-cloud-restored', {
          detail: { projectId: ps.projectId, cloudId: cloud.id, path: cloud.path, count: parsed.pos.length / 3, meta: parsed.meta || {} }
        }));
      } catch (_) {}
      if (ps.loadClassification) {
        ps.loadClassification(cloud.id).then(function (classification) {
          if (serial !== _projectRestoreSerial || !classification || !classification.ok) return;
          v.applyClassificationLabels(classification.labels);
        }).catch(function () {});
      }
    }).catch(function (error) {
      if (serial === _projectRestoreSerial) {
        try { console.warn('[multicloud] project cloud restore failed', error); } catch (_) {}
        toast('Не удалось открыть исходное облако проекта');
      }
    });
  }
  function restoreProjectState(data, revision, allowMigration) {
    var ps = typeof window !== 'undefined' && window.BimProjectState;
    if (!ps) { _projectStateReady = true; return; }
    var token = String(ps.projectId || '') + ':' + String(revision == null ? ps.revision || 0 : revision);
    if (token === _lastProjectStateToken) return;
    _lastProjectStateToken = token;
    var serial = ++_projectRestoreSerial;
    _projectStateReady = false;
    if (data && data.cloudsVersion === 1) {
      applyMeta({ clouds: data.clouds || [], activeId: data.activeCloudId || null });
    } else if (allowMigration) {
      var scoped = _ls.getItem(projectKey());
      if (scoped) load(projectKey());
      // The synchronous legacy load is used only during one-time migration.
    } else {
      applyMeta({ clouds: [], activeId: null });
    }
    _projectStateReady = true;
    if (allowMigration && (!data || data.cloudsVersion !== 1)) save();
    if (ps.projectId) { try { _ls.removeItem(LS_KEY); } catch (_) {} }
    _rebuildScene();
    var active = byId(_activeId);
    if (!active && viewer() && viewer()._cloudRecord && viewer().clearCloud) viewer().clearCloud();
    if (active) openActiveProjectCloud(active, token, serial, 0);
  }
  function listenProjectState() {
    var ps = typeof window !== 'undefined' && window.BimProjectState;
    if (!ps || !ps.ready) { _projectStateReady = true; return; }
    ps.ready.then(function (data) { restoreProjectState(data, ps.revision, true); })
      .catch(function (e) { _projectStateReady = true; try { console.warn('[multicloud] restore failed', e); } catch (_) {} });
    window.addEventListener('bim-project-state-ready', function (ev) {
      var d = ev && ev.detail || {};
      restoreProjectState(d.state, d.revision, !!d.initial || !!d.reloaded);
    });
    window.addEventListener('bim-project-state-restored', function (ev) {
      var d = ev && ev.detail || {};
      restoreProjectState(d.state, d.revision, false);
    });
  }
  function byId(id){for(var i=0;i<_clouds.length;i++)if(_clouds[i].id===id)return _clouds[i];return null;}
  var PALETTE=['#61d4ff','#ff9944','#44ff88','#ff4488','#aaff44','#ff44dd','#44ddff','#ffdd44'];
  function _defaultColor(idx){return PALETTE[idx%PALETTE.length];}
  var _listeners={};
  function on(ev,fn){(_listeners[ev]=_listeners[ev]||[]).push(fn);}
  function _emit(ev,data){(_listeners[ev]||[]).forEach(function(fn){try{fn(data);}catch(e){}});}
  function addCloud(name,path,pts,count,bbox){
    var id=uid();
    var cloud={id:id,name:name||'Облако '+_clouds.length,path:path||'',
      color:_defaultColor(_clouds.length),visible:true,opacity:1.0,
      pts:pts||null,count:count||0,bbox:bbox||null};
    _clouds.push(cloud);_activeId=id;
    save();_emit('cloud-added',cloud);return cloud;
  }
  function removeCloud(id){
    var idx=-1;
    for(var i=0;i<_clouds.length;i++)if(_clouds[i].id===id){idx=i;break;}
    if(idx<0)return false;
    var cloud=_clouds[idx];
    _clouds.splice(idx,1);
    if(_activeId===id)_activeId=_clouds.length?_clouds[_clouds.length-1].id:null;
    try{var v=viewer();if(v&&typeof v.removeCloud==='function')v.removeCloud(id);}catch(e){}
    save();_emit('cloud-removed',cloud);return true;
  }
  function setVisible(id,on){
    var c=byId(id);if(!c)return;
    c.visible=!!on;
    try{var v=viewer();if(v&&typeof v.setCloudVisible==='function')v.setCloudVisible(on,id);}catch(e){}
    save();_emit('cloud-updated',c);
  }
  function setOpacity(id,opacity){
    var c=byId(id);if(!c)return;
    c.opacity=Math.max(0,Math.min(1,opacity));
    try{var v=viewer();if(v&&typeof v.setCloudOpacity==='function')v.setCloudOpacity(c.opacity,id);}catch(e){}
    save();_emit('cloud-updated',c);
  }
  function setColor(id,color){
    var c=byId(id);if(!c)return;
    c.color=color;
    try{var v=viewer();if(v&&typeof v.setCloudColor==='function')v.setCloudColor(color,id);}catch(e){}
    save();_emit('cloud-updated',c);
  }
  function rename(id,name){var c=byId(id);if(!c)return;c.name=name;save();_emit('cloud-updated',c);}
  function setActive(id){if(!byId(id))return;_activeId=id;save();_emit('cloud-active',byId(id));}
  function getActive(){return byId(_activeId);}
  function list(){return _clouds.slice();}
  function count(){return _clouds.length;}
  function totalPoints(){var n=0;_clouds.forEach(function(c){n+=c.count||0;});return n;}
  function combinedBbox(){
    var mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity],any=false;
    _clouds.forEach(function(c){
      if(!c.bbox)return;any=true;
      for(var i=0;i<3;i++){if(c.bbox.mn[i]<mn[i])mn[i]=c.bbox.mn[i];if(c.bbox.mx[i]>mx[i])mx[i]=c.bbox.mx[i];}
    });
    return any?{mn:mn,mx:mx}:null;
  }
  function syncFromViewer(name,path,options){
    options=options||{};
    var persist=options.persist!==false;
    var v=viewer();var cnt=0,bbox=null,srcXform=null,crsWkt=null;
    try{if(v){if(v.pointCount!=null)cnt=v.pointCount;if(v.bbox)bbox=v.bbox;
      if(v._srcXform&&v._srcXform.t)srcXform={axis:v._srcXform.axis,t:Array.prototype.slice.call(v._srcXform.t,0,3).map(Number)};
      crsWkt=v._srcCrs||null;}}catch(e){}
    for(var i=0;i<_clouds.length;i++){
      if(_clouds[i].path===path){
        _clouds[i].name=name||_clouds[i].name;_clouds[i].count=cnt;_clouds[i].bbox=bbox;
        _clouds[i].srcXform=srcXform;_clouds[i].crsWkt=crsWkt;
        _activeId=_clouds[i].id;if(persist)save();_emit('cloud-updated',_clouds[i]);return _clouds[i];
      }
    }
    if(!persist)return null;
    var c=addCloud(name,path,null,cnt,bbox);c.srcXform=srcXform;c.crsWkt=crsWkt;save();return c;
  }
  function summaryHtml(){
    if(!_clouds.length)return '<div class="mc-empty">Нет загруженных облаков</div>';
    var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":'&amp;',"<":'&lt;',">":'&gt;','"':'&quot;'}[c];});};
    var html='';
    _clouds.forEach(function(c){
      var isAct=c.id===_activeId;
      var cnt=c.count?(c.count>=1e6?(c.count/1e6).toFixed(1)+'M':(c.count>=1e3?(c.count/1e3).toFixed(0)+'K':c.count)):'';
      html+='<div class="mc-cloud'+(isAct?' mc-active':'')+'" data-mcid="'+esc(c.id)+'">';
      html+='<span class="mc-dot" style="background:'+esc(c.color)+'"></span>';
      html+='<span class="mc-name" title="'+esc(c.path)+'">'+esc(c.name)+'</span>';
      html+='<span class="mc-cnt">'+cnt+'</span>';
      html+='<button class="lx-eye'+(c.visible?' on':'')+'" data-mcvis="'+esc(c.id)+'">'+(c.visible?'👁':'🚫')+'</button>';
      html+='<button class="lx-mini" data-mcact="'+esc(c.id)+'">●</button>';
      html+='<button class="lx-mini danger" data-mcdel="'+esc(c.id)+'">✕</button>';
      html+='</div>';
    });
    return html;
  }
  function wireInspector(host){
    if(!host)return;
    var qs=function(sel){return Array.prototype.slice.call(host.querySelectorAll(sel));};
    qs('[data-mcvis]').forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();var id=b.getAttribute('data-mcvis');var c=byId(id);if(c)setVisible(id,!c.visible);_rebuildScene();});});
    qs('[data-mcact]').forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();setActive(b.getAttribute('data-mcact'));_rebuildScene();});});
    qs('[data-mcdel]').forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();removeCloud(b.getAttribute('data-mcdel'));_rebuildScene();});});
  }
  function _rebuildScene(){
    if(typeof window!=='undefined')window.dispatchEvent(new Event('mc-changed'));
    if(typeof window!=='undefined'&&window.__lxScene&&typeof window.__lxScene.rebuild==='function')window.__lxScene.rebuild();
  }
  var API={addCloud:addCloud,removeCloud:removeCloud,setVisible:setVisible,
    setOpacity:setOpacity,setColor:setColor,rename:rename,setActive:setActive,
    getActive:getActive,byId:byId,list:list,count:count,totalPoints:totalPoints,
    combinedBbox:combinedBbox,syncFromViewer:syncFromViewer,summaryHtml:summaryHtml,
    wireInspector:wireInspector,on:on,save:save,load:load};
  if(typeof window!=='undefined'){
    window.MultiCloud=API;
    try{load(LS_KEY);}catch(e){}
    listenProjectState();
    window.addEventListener('lx-cloud-loaded',function(ev){
      if(_suppressLoadedCloudSync)return;
      try{var d=ev.detail||{};API.syncFromViewer(d.name||'Облако',d.path||'');_rebuildScene();}catch(e){}
    });
  }
  if(typeof module!=='undefined'&&module.exports)module.exports=API;
})();
