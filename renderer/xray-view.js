
/* xray-view.js — Sprint 1 (v1091): X-Ray & Orthographic view modes.
 * window.XrayView + module.exports for tests.
 */
(function(){
'use strict';
var _mode='perspective';
var _xray=false;
var _xrayDepth=0.5;
var _listeners={};
function on(ev,fn){(_listeners[ev]=_listeners[ev]||[]).push(fn);}
function _emit(ev,d){(_listeners[ev]||[]).forEach(function(f){try{f(d);}catch(e){}});}
var PRESETS={
  top:   {eye:[0,1,0],target:[0,0,0],up:[0,0,-1],fov:60},
  front: {eye:[0,0,1],target:[0,0,0],up:[0,1,0], fov:60},
  side:  {eye:[1,0,0],target:[0,0,0],up:[0,1,0], fov:60},
  iso:   {eye:[1,1,1],target:[0,0,0],up:[0,1,0], fov:60}
};
function setMode(m){
  _mode=m;
  var v=_viewer();
  if(v&&typeof v.setCameraMode==='function') v.setCameraMode(m);
  if(PRESETS[m]&&v&&typeof v.setCamera==='function') v.setCamera(PRESETS[m]);
  _emit('mode-changed',m);
}
function getMode(){return _mode;}
function setXray(on,depth){
  _xray=!!on;
  if(depth!=null) _xrayDepth=Math.max(0,Math.min(1,depth));
  var v=_viewer();
  if(v&&typeof v.setXray==='function') v.setXray(_xray,_xrayDepth);
  _emit('xray-changed',{xray:_xray,depth:_xrayDepth});
}
function isXray(){return _xray;}
function getXrayDepth(){return _xrayDepth;}
function toggleXray(){setXray(!_xray,_xrayDepth);}
function getPresets(){return PRESETS;}
function _viewer(){return (typeof window!=='undefined')?(window.__viewer||null):null;}
var API={setMode:setMode,getMode:getMode,setXray:setXray,isXray:isXray,
  getXrayDepth:getXrayDepth,toggleXray:toggleXray,getPresets:getPresets,on:on};
if(typeof window!=='undefined') window.XrayView=API;
if(typeof module!=='undefined'&&module.exports) module.exports=API;
})();
