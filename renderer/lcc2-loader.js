/* lcc2-loader.js — v1145 (SOG means are log-encoded: invert with expm1 to recover true world coords; identity placement per USD scene) */
(function () {
  'use strict';

  var SH_C0 = 0.28209479177;

  var nodeZlib = null;
  try { nodeZlib = (window.require || require)('zlib'); } catch(e) {}

  function inflateRaw(buf) {
    if (nodeZlib) {
      try {
        var u8 = new Uint8Array(buf);
        var out = nodeZlib.inflateRawSync(Buffer.from(u8));
        return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
      } catch(e) { return Promise.reject(new Error('zlib: ' + e.message)); }
    }
    if (typeof DecompressionStream !== 'undefined') {
      var ds = new DecompressionStream('deflate-raw');
      var wr = ds.writable.getWriter();
      wr.write(new Uint8Array(buf)); wr.close();
      var rd = ds.readable.getReader(), chunks = [];
      function pump() {
        return rd.read().then(function(r) {
          if (r.done) {
            var len = chunks.reduce(function(s,c){return s+c.length;},0);
            var o = new Uint8Array(len), off = 0;
            chunks.forEach(function(c){o.set(c,off);off+=c.length;});
            return o.buffer;
          }
          chunks.push(r.value); return pump();
        });
      }
      return pump();
    }
    return Promise.reject(new Error('Нет декомпрессора (zlib / DecompressionStream)'));
  }

  async function parseZip(buffer) {
    var u8=new Uint8Array(buffer), view=new DataView(buffer), map=new Map();
    var eocd=-1;
    for (var i=u8.length-22; i>=Math.max(0,u8.length-65558); i--) {
      if (view.getUint32(i,true)===0x06054b50){eocd=i;break;}
    }
    if (eocd<0) throw new Error('ZIP: нет EOCD');
    var cdCount=view.getUint16(eocd+8,true);
    var cdOffset=view.getUint32(eocd+16,true);
    var pos=cdOffset;
    for (var e=0;e<cdCount;e++) {
      if (pos+46>u8.length) break;
      if (view.getUint32(pos,true)!==0x02014b50) break;
      var comp=view.getUint16(pos+10,true);
      var csz=view.getUint32(pos+20,true);
      var fnL=view.getUint16(pos+28,true);
      var exL=view.getUint16(pos+30,true);
      var cmL=view.getUint16(pos+32,true);
      var lfhOff=view.getUint32(pos+42,true);
      var name=new TextDecoder().decode(u8.slice(pos+46,pos+46+fnL));
      var lfhFnL=view.getUint16(lfhOff+26,true);
      var lfhExL=view.getUint16(lfhOff+28,true);
      var dataStart=lfhOff+30+lfhFnL+lfhExL;
      if (csz>0 && dataStart+csz<=u8.length) {
        var cdata=buffer.slice(dataStart,dataStart+csz);
        if (comp===0) map.set(name,cdata);
        else if (comp===8) { try { map.set(name,await inflateRaw(cdata)); } catch(e2) {} }
      }
      pos+=46+fnL+exL+cmL;
    }
    return map;
  }

  function decodeWebP(buf) {
    return new Promise(function(res,rej){
      if (!buf||buf.byteLength===0) return rej(new Error('WebP: пустой буфер'));
      var blob=new Blob([buf],{type:'image/webp'});
      var url=URL.createObjectURL(blob);
      var img=new Image();
      img.onload=function(){
        URL.revokeObjectURL(url);
        var cv=document.createElement('canvas');
        cv.width=img.naturalWidth; cv.height=img.naturalHeight;
        if(!cv.width||!cv.height) return rej(new Error('WebP: нулевой размер'));
        var ctx=cv.getContext('2d',{willReadFrequently:true});
        ctx.drawImage(img,0,0);
        res(ctx.getImageData(0,0,cv.width,cv.height).data);
      };
      img.onerror=function(){URL.revokeObjectURL(url);rej(new Error('WebP decode fail'));};
      img.src=url;
    });
  }

  /**
   * remapTilePositions — v1141: чистый помощник, вычисляет per-tile двухпроходный
   * ремап одного тайла (масштаб+сдвиг из локального диапазона тайла в его мировой bbox).
   * env.sog / тайлы без bbox (wBMin===null) → identity (координаты уже мировые).
   * Тестируется в test/lcc2-remap-v1141.test.js.
   */
  function remapTilePositions(dU, dL, mMn, mMx, start, count, wBMin, wBMax) {
    var rX=(mMx[0]-mMn[0])/65535, rY=(mMx[1]-mMn[1])/65535, rZ=(mMx[2]-mMn[2])/65535;
    if (wBMin === null || !wBMax) {
      return { scX:1, scY:1, scZ:1, offX:0, offY:0, offZ:0, rX:rX, rY:rY, rZ:rZ };
    }
    // ПРОХОД 1: реальный локальный диапазон именно этого тайла
    var lMnX=1e18, lMxX=-1e18, lMnY=1e18, lMxY=-1e18, lMnZ=1e18, lMxZ=-1e18;
    for (var i=0; i<count; i++) {
      var p=(start+i)*4;
      var lx=mMn[0]+((dU[p  ]<<8)|dL[p  ])*rX;
      var ly=mMn[1]+((dU[p+1]<<8)|dL[p+1])*rY;
      var lz=mMn[2]+((dU[p+2]<<8)|dL[p+2])*rZ;
      if(lx<lMnX)lMnX=lx; if(lx>lMxX)lMxX=lx;
      if(ly<lMnY)lMnY=ly; if(ly>lMxY)lMxY=ly;
      if(lz<lMnZ)lMnZ=lz; if(lz>lMxZ)lMxZ=lz;
    }
    var spX=lMxX-lMnX; if(spX<1e-9)spX=1e-9;
    var spY=lMxY-lMnY; if(spY<1e-9)spY=1e-9;
    var spZ=lMxZ-lMnZ; if(spZ<1e-9)spZ=1e-9;
    var scX=(wBMax[0]-wBMin[0])/spX, scY=(wBMax[1]-wBMin[1])/spY, scZ=(wBMax[2]-wBMin[2])/spZ;
    return {
      scX:scX, scY:scY, scZ:scZ,
      offX:wBMin[0]-scX*lMnX, offY:wBMin[1]-scY*lMnY, offZ:wBMin[2]-scZ*lMnZ,
      rX:rX, rY:rY, rZ:rZ
    };
  }

  /**
   * getRemapMode — v1142: режим ремапа позиций.
   * window.LCC2_REMAP_MODE: 'identity' | 'pack-global' | 'per-tile' | 'auto'
   *   identity    — means уже в мировых координатах (без рескейла)
   *   pack-global — один аффинный ремап на пак (means-диапазон → объединённый bbox) — ПО УМОЛЧАНИЮ
   *   per-tile    — отдельный ремап на каждый тайл (растягивает тайл в ячейку октри)
   *   auto        — per-tile для mixed-depth, иначе pack-global
   */
  function getRemapMode() {
    try { if (typeof window !== 'undefined' && window.LCC2_REMAP_MODE) return String(window.LCC2_REMAP_MODE); } catch(e){}
    return 'identity';
  }

  // v1145: SOG means are stored in log space (log1p, sign-preserving, at export).
  // Recover the true world coordinate with the signed inverse expm1. This is the
  // single global decode that fixes the corridor-size distortion; exported for tests.
  function logDecode(v){ return (v<0?-1:1)*Math.expm1(v<0?-v:v); }

  /**
   * computePackGlobalTransform — один аффинный ремап для всего пака:
   * means-диапазон [mMn,mMx] → объединённый мировой bbox всех тайлов пака.
   * Не искажает геометрию внутри пака (единый sc/off).
   */
  function computePackGlobalTransform(mMn, mMx, tileInfos) {
    var rX=(mMx[0]-mMn[0])/65535, rY=(mMx[1]-mMn[1])/65535, rZ=(mMx[2]-mMn[2])/65535;
    var uMnX=1e18,uMxX=-1e18,uMnY=1e18,uMxY=-1e18,uMnZ=1e18,uMxZ=-1e18, have=false;
    for (var ti=0; ti<tileInfos.length; ti++) {
      var bb=tileInfos[ti]; if(bb.wBMin===null)continue; have=true;
      if(bb.wBMin[0]<uMnX)uMnX=bb.wBMin[0]; if(bb.wBMax[0]>uMxX)uMxX=bb.wBMax[0];
      if(bb.wBMin[1]<uMnY)uMnY=bb.wBMin[1]; if(bb.wBMax[1]>uMxY)uMxY=bb.wBMax[1];
      if(bb.wBMin[2]<uMnZ)uMnZ=bb.wBMin[2]; if(bb.wBMax[2]>uMxZ)uMxZ=bb.wBMax[2];
    }
    if(!have) return { scX:1,scY:1,scZ:1,offX:0,offY:0,offZ:0, rX:rX,rY:rY,rZ:rZ, uMin:null,uMax:null };
    var spX=mMx[0]-mMn[0]; if(spX<1e-9)spX=1e-9;
    var spY=mMx[1]-mMn[1]; if(spY<1e-9)spY=1e-9;
    var spZ=mMx[2]-mMn[2]; if(spZ<1e-9)spZ=1e-9;
    var scX=(uMxX-uMnX)/spX, scY=(uMxY-uMnY)/spY, scZ=(uMxZ-uMnZ)/spZ;
    return {
      scX:scX, scY:scY, scZ:scZ,
      offX:uMnX-scX*mMn[0], offY:uMnY-scY*mMn[1], offZ:uMnZ-scZ*mMn[2],
      rX:rX, rY:rY, rZ:rZ, uMin:[uMnX,uMnY,uMnZ], uMax:[uMxX,uMxY,uMxZ]
    };
  }

  /**
   * diagPack — v1142: печатает реальные числа по паку в консоль ([LCC2-DIAG]).
   * Ключевое сравнение: decodedMin/Max (факт. диапазон декодированных means)
   * вс. worldMin/Max (объединённые bbox ячеек октри). Если они совпадают —
   * means уже мировые → нужен identity. perTileScaleMin/Max показывает разброс
   * масштабов per-tile: сильный разброс = per-tile ломает стыки.
   */
  function diagPack(meta, tileInfos, mMn, mMx, dU, dL, pg, N, mode, mixedDepth) {
    var rX=(mMx[0]-mMn[0])/65535, rY=(mMx[1]-mMn[1])/65535, rZ=(mMx[2]-mMn[2])/65535;
    var dMin=[1e18,1e18,1e18], dMax=[-1e18,-1e18,-1e18];
    var uMin=[1e18,1e18,1e18], uMax=[-1e18,-1e18,-1e18], haveBox=false;
    var scMin=[1e18,1e18,1e18], scMax=[-1e18,-1e18,-1e18];
    for (var ti=0; ti<tileInfos.length; ti++) {
      var t=tileInfos[ti]; var start=t.start; var count=(t.count!==null)?t.count:N;
      var lMnX=1e18,lMxX=-1e18,lMnY=1e18,lMxY=-1e18,lMnZ=1e18,lMxZ=-1e18;
      for (var i=0;i<count;i++){
        var p=(start+i)*4;
        var lx=mMn[0]+((dU[p]<<8)|dL[p])*rX;
        var ly=mMn[1]+((dU[p+1]<<8)|dL[p+1])*rY;
        var lz=mMn[2]+((dU[p+2]<<8)|dL[p+2])*rZ;
        lx=logDecode(lx); ly=logDecode(ly); lz=logDecode(lz);
        if(lx<lMnX)lMnX=lx;if(lx>lMxX)lMxX=lx;
        if(ly<lMnY)lMnY=ly;if(ly>lMxY)lMxY=ly;
        if(lz<lMnZ)lMnZ=lz;if(lz>lMxZ)lMxZ=lz;
      }
      if(lMnX<dMin[0])dMin[0]=lMnX; if(lMxX>dMax[0])dMax[0]=lMxX;
      if(lMnY<dMin[1])dMin[1]=lMnY; if(lMxY>dMax[1])dMax[1]=lMxY;
      if(lMnZ<dMin[2])dMin[2]=lMnZ; if(lMxZ>dMax[2])dMax[2]=lMxZ;
      if(t.wBMin){
        haveBox=true;
        if(t.wBMin[0]<uMin[0])uMin[0]=t.wBMin[0]; if(t.wBMax[0]>uMax[0])uMax[0]=t.wBMax[0];
        if(t.wBMin[1]<uMin[1])uMin[1]=t.wBMin[1]; if(t.wBMax[1]>uMax[1])uMax[1]=t.wBMax[1];
        if(t.wBMin[2]<uMin[2])uMin[2]=t.wBMin[2]; if(t.wBMax[2]>uMax[2])uMax[2]=t.wBMax[2];
        var sx=(t.wBMax[0]-t.wBMin[0])/((lMxX-lMnX)||1e-9);
        var sy=(t.wBMax[1]-t.wBMin[1])/((lMxY-lMnY)||1e-9);
        var sz=(t.wBMax[2]-t.wBMin[2])/((lMxZ-lMnZ)||1e-9);
        if(sx<scMin[0])scMin[0]=sx; if(sx>scMax[0])scMax[0]=sx;
        if(sy<scMin[1])scMin[1]=sy; if(sy>scMax[1])scMax[1]=sy;
        if(sz<scMin[2])scMin[2]=sz; if(sz>scMax[2])scMax[2]=sz;
      }
    }
    function r3(a){return a?a.map(function(v){return Math.round(v*1000)/1000;}):a;}
    var info={
      pack: meta.name||('N='+N), count:N, tiles:tileInfos.length,
      mixedDepth:mixedDepth, mode:mode,
      meansMin:r3(mMn), meansMax:r3(mMx),
      decodedMin:r3(dMin), decodedMax:r3(dMax),
      worldMin: haveBox?r3(uMin):null, worldMax: haveBox?r3(uMax):null,
      packGlobalScale: r3([pg.scX,pg.scY,pg.scZ]),
      packGlobalOff: r3([pg.offX,pg.offY,pg.offZ]),
      perTileScaleMin: haveBox?r3(scMin):null, perTileScaleMax: haveBox?r3(scMax):null,
      splatSizeMin: (function(){var c=meta.scales&&meta.scales.codebook;if(!c)return null;var mn=1e18;for(var k=0;k<c.length;k++){var e=Math.exp(c[k]);if(e<mn)mn=e;}return Math.round(mn*1e4)/1e4;})(),
      splatSizeMax: (function(){var c=meta.scales&&meta.scales.codebook;if(!c)return null;var mx=-1e18;for(var k=0;k<c.length;k++){var e=Math.exp(c[k]);if(e>mx)mx=e;}return Math.round(mx*1e4)/1e4;})()
    };
    console.log('[LCC2-DIAG]', JSON.stringify(info));
    try{ (window.__LCC2_DIAG=window.__LCC2_DIAG||[]).push(info); }catch(e){}
  }

  /**
   * Декодирует pack-файл (SOG = ZIP с WebP).
   *
   * tileInfos: [{start, count, wBMin, wBMax, depth}]
   *   depth — глубина в дереве октри (оставлено для диагностики)
   *
   * РЕМАП (v1141): универсальный per-tile двухпроходный ремап для ВСЕХ тайлов с bbox
   * (отдельный sc/off для каждого тайла, см. remapTilePositions). Тайлы без bbox
   * (env.sog, wBMin===null) → identity. Прежний pack-global ремап убран: он давал
   * сдвиг помещений до ~16 м на однородных многотайловых паках.
   */
  async function decodeSogMultiTile(arrayBuffer, tileInfos) {
    var zip = await parseZip(arrayBuffer);
    var metaRaw = zip.get('meta.json');
    if (!metaRaw || metaRaw.byteLength === 0)
      throw new Error('meta.json не найден');
    var meta = JSON.parse(new TextDecoder().decode(metaRaw));
    var N = meta.count;
    if (!N) throw new Error('pack count=0');

    var wk = ['means_l.webp','means_u.webp','sh0.webp','quats.webp','scales.webp'];
    for (var ki=0; ki<wk.length; ki++)
      if (!zip.has(wk[ki])) throw new Error('Нет ' + wk[ki]);

    var imgs = await Promise.all(wk.map(function(k){ return decodeWebP(zip.get(k)); }));
    var dL=imgs[0], dU=imgs[1], dSH=imgs[2], dQ=imgs[3], dS=imgs[4];
    var sh0cb=meta.sh0.codebook, scCb=meta.scales.codebook;
    var mMn=meta.means.mins, mMx=meta.means.maxs;
    var rX=(mMx[0]-mMn[0])/65535, rY=(mMx[1]-mMn[1])/65535, rZ=(mMx[2]-mMn[2])/65535;

    var totalN = 0;
    for (var ti=0; ti<tileInfos.length; ti++)
      totalN += (tileInfos[ti].count !== null ? tileInfos[ti].count : N);

    var out = new Uint8Array(totalN * 32);
    var outF = new Float32Array(out.buffer);
    var outIdx = 0;

    // VQ shN (опционально)
    var vqLabels = null, shCentroids = null;
    var dLab = null, dCent = null, shNcb = null;
    if (zip.has('shN_labels.webp') && zip.has('shN_centroids.webp') && meta.shN) {
      try {
        shNcb = meta.shN.codebook;
        dLab = await decodeWebP(zip.get('shN_labels.webp'));
        dCent = await decodeWebP(zip.get('shN_centroids.webp'));
        var nCent = meta.shN.count || 65536;
        shCentroids = new Float32Array(nCent * 45);
        for (var ci=0; ci<nCent; ci++) {
          for (var k=0; k<15; k++) {
            var gpix = ci*15+k;
            shCentroids[ci*45+k*3+0] = shNcb[dCent[gpix*4+0]];
            shCentroids[ci*45+k*3+1] = shNcb[dCent[gpix*4+1]];
            shCentroids[ci*45+k*3+2] = shNcb[dCent[gpix*4+2]];
          }
        }
        vqLabels = new Uint16Array(totalN);
      } catch(e) { dLab=null; shCentroids=null; vqLabels=null; }
    }

    var vqOut = 0;

    // ===== СТРАТЕГИЯ РЕМАПА (v1142: переключаемая) =====
    var envOnly = tileInfos.length === 1 && tileInfos[0].wBMin === null;
    var mode = getRemapMode();
    var pg = computePackGlobalTransform(mMn, mMx, tileInfos);

    var _ds={};
    for (var _t=0; _t<tileInfos.length; _t++)
      if (tileInfos[_t].wBMin!==null) _ds[tileInfos[_t].depth!==undefined?tileInfos[_t].depth:0]=1;
    var mixedDepth = Object.keys(_ds).length>1;

    // Диагностика (реальные числа для настройки ремапа)
    try { diagPack(meta, tileInfos, mMn, mMx, dU, dL, pg, N, mode, mixedDepth); }
    catch(e){ console.log('[LCC2-DIAG] err', e && e.message); }

    // ===== ГЛАВНЫЙ ЦИКЛ =====
    for (var ti=0; ti<tileInfos.length; ti++) {
      var tile = tileInfos[ti];
      var start = tile.start;
      var count = (tile.count !== null) ? tile.count : N;
      var wBMin = tile.wBMin;
      var wBMax = tile.wBMax;

      var scX, scY, scZ, offX, offY, offZ;
      var effMode = mode;
      if (effMode === 'auto') effMode = mixedDepth ? 'per-tile' : 'pack-global';

      if (envOnly || wBMin === null) {
        scX=1; scY=1; scZ=1; offX=0; offY=0; offZ=0;
      } else if (effMode === 'identity') {
        scX=1; scY=1; scZ=1; offX=0; offY=0; offZ=0;
      } else if (effMode === 'pack-global') {
        scX=pg.scX; scY=pg.scY; scZ=pg.scZ; offX=pg.offX; offY=pg.offY; offZ=pg.offZ;
      } else { // 'per-tile'
        var _rm = remapTilePositions(dU, dL, mMn, mMx, start, count, wBMin, wBMax);
        scX=_rm.scX; scY=_rm.scY; scZ=_rm.scZ; offX=_rm.offX; offY=_rm.offY; offZ=_rm.offZ;
      }

      // === ДЕКОДИРОВАНИЕ сплэтов ===
      for (var i=0; i<count; i++) {
        var si=start+i, p=si*4;
        var oi8=outIdx*8, ob=outIdx*32;

        var lX=mMn[0]+((dU[p  ]<<8)|dL[p  ])*rX;
        var lY=mMn[1]+((dU[p+1]<<8)|dL[p+1])*rY;
        var lZ=mMn[2]+((dU[p+2]<<8)|dL[p+2])*rZ;

        // v1145: SOG stores means in log space (log1p at export). Invert with expm1
        // to recover true world coordinates. This is the correct, global decode —
        // no per-region remap needed (USD scene places the LCC2 asset with identity).
        lX = logDecode(lX);
        lY = logDecode(lY);
        lZ = logDecode(lZ);

        var wX=lX*scX+offX;
        var wY=lY*scY+offY;
        var wZ=lZ*scZ+offZ;

        // LCC2 Z-up → viewer Y-up
        outF[oi8  ] = wX;
        outF[oi8+1] = wZ;
        outF[oi8+2] = -wY;

        // Масштабы
        // v1144: размеры (scene units) согласуем с ремапом позиций: при scX!==1 масштабируем и габариты.
        outF[oi8+3]=Math.exp(scCb[dS[p  ]])*scX;
        outF[oi8+4]=Math.exp(scCb[dS[p+1]])*scY;
        outF[oi8+5]=Math.exp(scCb[dS[p+2]])*scZ;

        // Цвет SH0
        var cr=0.5+SH_C0*sh0cb[dSH[p  ]];   if(cr<0)cr=0;if(cr>1)cr=1;
        var cg=0.5+SH_C0*sh0cb[dSH[p+1]];  if(cg<0)cg=0;if(cg>1)cg=1;
        var cbv=0.5+SH_C0*sh0cb[dSH[p+2]]; if(cbv<0)cbv=0;if(cbv>1)cbv=1;
        var la=sh0cb[dSH[p+3]]; var al=1/(1+Math.exp(-la)); if(al<0)al=0;if(al>1)al=1;
        out[ob+24]=(cr*255+.5)|0;  out[ob+25]=(cg*255+.5)|0;
        out[ob+26]=(cbv*255+.5)|0; out[ob+27]=(al*255+.5)|0;

        // Кватернионы: Z-up → Y-up
        var _xs=dQ[p  ]/127.5-1, _ys=dQ[p+1]/127.5-1,
            _zs=dQ[p+2]/127.5-1, _ws=dQ[p+3]/127.5-1;
        var _ql=Math.sqrt(_xs*_xs+_ys*_ys+_zs*_zs+_ws*_ws)||1;
        _xs/=_ql; _ys/=_ql; _zs/=_ql; _ws/=_ql;
        var _wo=(_ws+_xs)*0.7071, _xo=(_xs-_ws)*0.7071,
            _yo=(_ys+_zs)*0.7071, _zo=(_zs-_ys)*0.7071;
        out[ob+28]=Math.max(0,Math.min(255,(_wo*128+128)|0));
        out[ob+29]=Math.max(0,Math.min(255,(_xo*128+128)|0));
        out[ob+30]=Math.max(0,Math.min(255,(_yo*128+128)|0));
        out[ob+31]=Math.max(0,Math.min(255,(_zo*128+128)|0));

        if (vqLabels && dLab) vqLabels[vqOut]=dLab[si*4]*256+dLab[si*4+1];
        outIdx++; vqOut++;
      }
    }

    return {data:out, count:totalN, sh1:null,
            vqLabels:vqLabels, shCentroids:shCentroids};
  }

  /**
   * load(): собирает листовые тайлы (childNum===0),
   * записывает depth для определения mixed-depth паков.
   */
  async function load(fileList, progressCb) {
    var cb = progressCb || function(){};
    var sogMap = new Map(), lcc2Files = [];

    for (var fi=0; fi<fileList.length; fi++) {
      var f=fileList[fi], nm=f.name;
      if (nm.endsWith('.lcc2')) lcc2Files.push(f);
      else if (nm.endsWith('.sog')) sogMap.set(nm, f);
    }

    cb('Файлов: '+fileList.length+' | .lcc2: '+lcc2Files.length+' | .sog: '+sogMap.size);

    if (!lcc2Files.length) {
      var seen={}, extList=[];
      for (var xi=0; xi<Math.min(fileList.length,40); xi++) {
        var ext=fileList[xi].name.split('.').pop().toLowerCase();
        if(!seen[ext]){seen[ext]=1;extList.push('.'+ext);}
      }
      throw new Error('Файл .lcc2 не найден.\nВ папке: '+extList.join(', ')
        +'\nНужна папка с <имя>.lcc2 и data/3dgs/*.sog');
    }
    if (!sogMap.size)
      throw new Error('.lcc2 найден, но .sog нет. Проверьте папку data/3dgs/');

    cb('Чтение '+lcc2Files[0].name+'…');
    var metaJson = JSON.parse(new TextDecoder().decode(await lcc2Files[0].arrayBuffer()));
    var total = metaJson.totalSplats || 0;
    cb('ℹ️ '+(metaJson.name||'LCC2')+' · '+(total/1e6).toFixed(1)+'M · '+sogMap.size+' SOG');

    var splatFiles = (metaJson.root && metaJson.root.splatFiles) || [];

    // packName -> [{start, count, wBMin, wBMax, depth}]
    var leafByPack = {};

    // Обход дерева с отслеживанием глубины (depth)
    function collectLeaves(node, depth) {
      if (!node) return;
      var d = node.data && node.data['3dgs'];
      if (d !== undefined && node.childNum === 0) {
        var packName = splatFiles[d.name] && splatFiles[d.name].split('/').pop();
        if (packName && sogMap.has(packName)) {
          var bb = node.boundingBox;
          var wBMin = bb ? [bb.min[0], bb.min[1], bb.min[2]] : null;
          var wBMax = bb ? [bb.max[0], bb.max[1], bb.max[2]] : null;
          if (!leafByPack[packName]) leafByPack[packName] = [];
          leafByPack[packName].push({
            start: d.start, count: d.count,
            wBMin: wBMin, wBMax: wBMax,
            depth: depth   // <-- глубина в октри
          });
        }
      }
      if (node.child) {
        var keys = Object.keys(node.child);
        for (var ki=0; ki<keys.length; ki++)
          collectLeaves(node.child[keys[ki]], depth + 1);
      }
    }
    collectLeaves(metaJson.root, 0);

    var packNames = Object.keys(leafByPack);
    cb('Паков: '+packNames.length+', листовых тайлов: '
      +packNames.reduce(function(s,p){return s+leafByPack[p].length;},0));

    // Логируем mixed-depth паки для диагностики
    packNames.forEach(function(pn) {
      var tiles = leafByPack[pn];
      var depths = {};
      tiles.forEach(function(t){if(t.wBMin!==null)depths[t.depth]=1;});
      if (Object.keys(depths).length > 1)
        cb('⚠️ mixed-depth pack: ' + pn + ' (уровни: ' + Object.keys(depths).join(',') + ') → per-tile remap');
    });

    var allArrays = [], totalLoaded = 0;
    var progressInterval = setInterval(function(){
      cb('Загружено '+totalLoaded+'/'+packNames.length+' паков…');
    }, 500);

    try {
      var packResults = await Promise.all(packNames.map(async function(packName) {
        var file = sogMap.get(packName);
        var buf = await file.arrayBuffer();
        var tileInfos = leafByPack[packName];
        tileInfos.sort(function(a,b){return a.start-b.start;});
        var result = await decodeSogMultiTile(buf, tileInfos);
        totalLoaded++;
        return result;
      }));

      clearInterval(progressInterval);

      var grandTotal = packResults.reduce(function(s,r){return s+r.count;},0);
      cb('Декодировано: '+grandTotal+' сплэтов');

      var merged = new Uint8Array(grandTotal * 32);
      var offset = 0;
      var hasVq = packResults.some(function(r){return r.vqLabels !== null;});
      var mergedVq = hasVq ? new Uint16Array(grandTotal) : null;

      for (var ri=0; ri<packResults.length; ri++) {
        var r = packResults[ri];
        merged.set(r.data.subarray(0, r.count*32), offset*32);
        if (hasVq && r.vqLabels)
          mergedVq.set(r.vqLabels.subarray(0, r.count), offset);
        offset += r.count;
      }

      var shCentAll = null;
      for (var ri=0; ri<packResults.length; ri++) {
        if (packResults[ri].shCentroids) { shCentAll = packResults[ri].shCentroids; break; }
      }

      return { data:merged, count:grandTotal, sh1:null,
               vqLabels:mergedVq, shCentroids:shCentAll };

    } catch(e) {
      clearInterval(progressInterval);
      throw e;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { load: load, remapTilePositions: remapTilePositions, computePackGlobalTransform: computePackGlobalTransform, getRemapMode: getRemapMode, logDecode: logDecode };
  } else {
    window.lcc2Loader = { load: load, remapTilePositions: remapTilePositions, computePackGlobalTransform: computePackGlobalTransform, getRemapMode: getRemapMode, logDecode: logDecode };
  }

})();

/* ─── LCC2 UI ─────────────────────────────────────────── */
(function () {

  // ——— Toast: напрямую через #toast ———
  var _tt = null;
  function showMsg(msg) {
    console.log('[LCC2]', msg);
    try {
      var el = document.getElementById('toast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show','active','visible');
      el.style.cssText = 'display:block;opacity:1';
      clearTimeout(_tt);
      _tt = setTimeout(function() {
        el.classList.remove('show','active','visible');
        el.style.opacity = '0';
      }, 4000);
    } catch(e) {}
  }

  // ——— Загрузка файлов LCC2 и открытие 3DGS ———
  async function loadFromFiles(files) {
    if (!files || !files.length) {
      showMsg('LCC2: выберите папку lcc2-result');
      return;
    }
    showMsg('LCC2: читаю данные (' + files.length + ' файлов)…');
    var lbl = document.getElementById('tsSplatLcc2');
    if (lbl) { lbl.style.opacity = '0.5'; lbl.textContent = 'LCC2…'; }
    try {
      if (!window.lcc2Loader) throw new Error('window.lcc2Loader не определён');
      var result = await window.lcc2Loader.load(Array.from(files), function(msg) {
        showMsg('LCC2: ' + msg);
      });
      showMsg('LCC2: ' + result.count.toLocaleString('ru-RU') + ' сплэтов — открываю 3D…');
      if (window._bimOpenSplat) {
        await window._bimOpenSplat(result.data.buffer, 'lcc2-scene.splat');
      } else {
        showMsg('LCC2: _bimOpenSplat не найден — перезагрузите страницу');
      }
    } catch(e) {
      showMsg('LCC2 ошибка: ' + ((e && e.message) ? e.message : String(e)));
      console.error('[LCC2]', e);
    } finally {
      if (lbl) { lbl.style.opacity = '1'; lbl.textContent = 'LCC2'; }
    }
  }

  // ——— Вешаем change на lcc2FolderInput (связан через <label for="lcc2FolderInput">) ———
  function wireInput() {
    var inp = document.getElementById('lcc2FolderInput');
    if (!inp || inp.dataset.lcc2Wired) return;
    inp.dataset.lcc2Wired = '1';
    inp.addEventListener('change', function() {
      var fileArr = Array.from(inp.files || []);
      inp.value = ''; // сброс — чтобы можно выбрать ту же папку снова
      loadFromFiles(fileArr);
    });
    console.log('[LCC2] lcc2FolderInput wired OK');
  }

  function init() {
    wireInput();
    // На случай динамической загрузки DOM
    new MutationObserver(function() { wireInput(); })
      .observe(document.body, { childList: true, subtree: true });
  }

  if (typeof document === 'undefined') return; // Node / без DOM: только экспорт логики
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else
    setTimeout(init, 0);

})();
