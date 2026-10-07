/* v1090 — bounded, deterministic cloud display helpers (local Y-up coordinates). */
(function(){'use strict';
 function clamp(value,min,max,fallback){value=Number(value);return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;}
 function fileName(path){return String(path||'').replace(/\\/g,'/').split('/').pop()||'Облако без имени';}
 function range(lo,hi,bounds){lo=Number(lo);hi=Number(hi);if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo>hi)throw new RangeError('Начало диапазона должно быть не больше конца');return [lo,hi];}
 function normalize(v,lo,hi){if(hi===lo)return .5;return Math.max(0,Math.min(1,(v-lo)/(hi-lo)));}
 function color(t,palette){t=clamp(t,0,1,.5);if(palette==='gray')return [t,t,t];if(palette==='warm')return [1,1-t,0];return [Math.max(0,Math.min(1,1.5-Math.abs(4*t-3))),Math.max(0,Math.min(1,1.5-Math.abs(4*t-2))),Math.max(0,Math.min(1,1.5-Math.abs(4*t-1)))];}
 function histogram(pos,bounds,binCount,maxSamples){
  binCount=Math.round(clamp(binCount||64,2,256,64));maxSamples=Math.round(clamp(maxSamples||100000,1,200000,100000));
  const n=Math.floor((pos&&pos.length||0)/3),stride=Math.max(1,Math.ceil(n/maxSamples)),bins=new Array(binCount).fill(0);
  let sampled=0;const lo=bounds[0],hi=bounds[1];
  for(let i=0;i<n;i+=stride){const h=pos[i*3+1];if(!Number.isFinite(h))continue;bins[Math.min(binCount-1,Math.floor(normalize(h,lo,hi)*binCount))]++;sampled++;}
  return {bins,sampled,total:n,approximate:stride>1,min:lo,max:hi};
 }
 const api={clamp,fileName,range,normalize,color,histogram};if(typeof module!=='undefined'&&module.exports)module.exports=api;if(typeof window!=='undefined')window.CloudDisplay=api;
})();
