/*
 * Viewer3D v0.3 — lightweight software 3D renderer (no external libraries, offline).
 * Light theme edition.
 *
 * Features:
 *   - per-type element geometry (вентшахта / оборудование / труба / дверь / кабель-канал)
 *   - floor grid, orbit + PAN (right-drag or Shift+drag) + zoom
 *   - hover highlight, click picking (Raycaster equivalent)
 *   - REAL model loading: loadGlb(arrayBuffer) parses binary glTF (.glb),
 *     loadGltf(json, buffers) renders triangle meshes. Auto-frames the model.
 */
(function () {
  const STATUS_COLOR = { err:'#e5484d', ok:'#16a34a', warn:'#d99a00', none:'#aab2bd' };
  const TYPE_BASE = {
    'вентшахта':'#7c93b8', 'оборудование':'#6b7d99',
    'труба':'#a67d63', 'дверь':'#8a79b8', 'кабель-канал':'#5fa39d'
  };

  const mul = (m, v) => [
    m[0]*v[0]+m[1]*v[1]+m[2]*v[2],
    m[3]*v[0]+m[4]*v[1]+m[5]*v[2],
    m[6]*v[0]+m[7]*v[1]+m[8]*v[2]
  ];
  const rotY = a => { const c=Math.cos(a),s=Math.sin(a); return [c,0,s, 0,1,0, -s,0,c]; };
  const rotX = a => { const c=Math.cos(a),s=Math.sin(a); return [1,0,0, 0,c,-s, 0,s,c]; };
  function shade(hex, f){
    const n=parseInt(hex.slice(1),16);
    let r=(n>>16)&255,g=(n>>8)&255,b=n&255;
    const cl=x=>Math.max(0,Math.min(255,Math.round(x*f)));
    return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
  }
  function box(cx, cy, cz, w, h, d) {
    const x0=cx-w/2,x1=cx+w/2,y0=cy-h/2,y1=cy+h/2,z0=cz-d/2,z1=cz+d/2;
    const v=[[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
    const faces=[
      {idx:[0,1,2,3],n:[0,0,-1]},{idx:[5,4,7,6],n:[0,0,1]},
      {idx:[4,0,3,7],n:[-1,0,0]},{idx:[1,5,6,2],n:[1,0,0]},
      {idx:[3,2,6,7],n:[0,1,0]},{idx:[4,5,1,0],n:[0,-1,0]}
    ];
    return { verts:v, faces };
  }

  class Viewer3D {
    constructor(canvas, onSelect) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.onSelect = onSelect || function(){};
      this.onHover = null;
      this.yaw=-0.6; this.pitch=-0.5; this.dist=14;
      this.panX=0; this.panY=0;
      this.showAI=true; this.selectedId=null; this.hoverId=null;
      this.solids=[]; this.center=[0,0,0];
      this._bindEvents(); this._resize();
      window.addEventListener('resize', () => { this._resize(); this.render(); });
    }

    setAIHighlight(on){ this.showAI=on; this.render(); }
    resetView(){ this.yaw=-0.6; this.pitch=-0.5; this.panX=0; this.panY=0; this._fit(); this.render(); }

    loadRoom(room) {
      this.room=room; this.selectedId=null; this.hoverId=null;
      const dims=room.dims||{w:Math.sqrt(room.area_m2),d:Math.sqrt(room.area_m2),h:room.height_m||3};
      const w=dims.w, d=dims.d, h=dims.h;
      this.center=[0,h/2,0];
      const solids=[];
      solids.push({ kind:'grid', w, d });
      solids.push({ kind:'shell', geom: box(0,h/2,0,w,h,d) });

      const elems=(room.elements||[]).filter(e=>e.type!=='стена');
      const n=elems.length||1;
      elems.forEach((el,i) => {
        const px=-w/2 + w*(i+1)/(n+1);
        let g;
        switch(el.type){
          case 'вентшахта':      g=box(px,h-0.6,0,0.9,0.9,d*0.8); break;
          case 'труба':          g=box(px,0.5,-d/2+0.4,0.35,0.35,d*0.85); break;
          case 'кабель-канал':   g=box(px,h-0.4,d/2-0.3,0.5,0.3,d*0.7); break;
          case 'дверь':          g=box(px,1.05,d/2-0.05,1.0,2.1,0.12); break;
          default:                g=box(px,1.0,0,1.3,2.0,1.0); // оборудование
        }
        solids.push({ kind:'element', el, geom:g });
      });
      this.solids=solids;
      this._fit();
      this.render();
    }

    // Parse binary glTF (.glb) and render it.
    loadGlb(arrayBuffer){
      const dv=new DataView(arrayBuffer);
      if(dv.getUint32(0,true)!==0x46546C67) throw new Error('Файл не является .glb');
      const total=dv.getUint32(8,true);
      let off=12, json=null, bin=null;
      while(off<total){
        const clen=dv.getUint32(off,true); const ctype=dv.getUint32(off+4,true); off+=8;
        const chunk=arrayBuffer.slice(off, off+clen); off+=clen;
        if(ctype===0x4E4F534A) json=JSON.parse(new TextDecoder('utf-8').decode(chunk));
        else if(ctype===0x004E4942) bin=new Uint8Array(chunk);
      }
      if(!json) throw new Error('В .glb нет JSON-чанка');
      this.loadGltf(json, bin?[bin]:[]);
    }

    // Render real glTF geometry (POSITION + indices) as triangle meshes.
    loadGltf(gltf, buffers) {
      const tris=[];
      const getAcc=(i)=>{
        const acc=gltf.accessors[i]; const bv=gltf.bufferViews[acc.bufferView];
        const src=buffers[bv.buffer];
        const u8 = src instanceof Uint8Array ? src : new Uint8Array(src);
        const off=(u8.byteOffset)+(bv.byteOffset||0)+(acc.byteOffset||0);
        const comp={5126:Float32Array,5123:Uint16Array,5125:Uint32Array,5121:Uint8Array}[acc.componentType];
        const num=acc.count*({SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[acc.type]);
        return new comp(u8.buffer, off, num);
      };
      for(const mesh of (gltf.meshes||[])){
        for(const prim of mesh.primitives){
          if(prim.attributes.POSITION==null) continue;
          const pos=getAcc(prim.attributes.POSITION);
          const idx=prim.indices!=null?getAcc(prim.indices):null;
          const face=(a,b,c)=>tris.push([[pos[a*3],pos[a*3+1],pos[a*3+2]],[pos[b*3],pos[b*3+1],pos[b*3+2]],[pos[c*3],pos[c*3+1],pos[c*3+2]]]);
          if(idx){ for(let i=0;i<idx.length;i+=3) face(idx[i],idx[i+1],idx[i+2]); }
          else  { for(let i=0;i<pos.length/3;i+=3) face(i,i+1,i+2); }
        }
      }
      this.room=null; this.selectedId=null; this.hoverId=null;
      this.solids=[{kind:'mesh',tris}];
      this.yaw=-0.6; this.pitch=-0.4; this.panX=0; this.panY=0;
      this._fit(); this.render();
    }

    select(id){ this.selectedId=id; this.render(); this._emit(id); }
    _emit(id){
      const s=this.solids.find(s=>s.kind==='element'&&s.el.id===id);
      this.onSelect(s?s.el:null);
    }

    _fit(){
      const mesh=this.solids.find(s=>s.kind==='mesh');
      if(mesh && mesh.tris.length){
        let mn=[Infinity,Infinity,Infinity], mx=[-Infinity,-Infinity,-Infinity];
        for(const t of mesh.tris) for(const p of t) for(let k=0;k<3;k++){ if(p[k]<mn[k])mn[k]=p[k]; if(p[k]>mx[k])mx[k]=p[k]; }
        this.center=[(mn[0]+mx[0])/2,(mn[1]+mx[1])/2,(mn[2]+mx[2])/2];
        const size=Math.max(mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2])||8;
        this.dist=size*2.2;
        return;
      }
      const b=this.room?this.room.dims:null;
      const m=b?Math.max(b.w,b.d,b.h):8;
      this.dist=m*2.4;
    }

    _project(v){
      const p=mul(rotX(this.pitch), mul(rotY(this.yaw), [v[0]-this.center[0],v[1]-this.center[1],v[2]-this.center[2]]));
      const zc=p[2]+this.dist;
      const f=this.focal/Math.max(0.1,zc);
      return { x:this.cx+this.panX+p[0]*f, y:this.cy+this.panY-p[1]*f, z:zc };
    }

    _buildFaces(){
      const out=[];
      for(const s of this.solids){
        if(s.kind==='grid'){ continue; }
        if(s.kind==='mesh'){
          for(const t of s.tris){
            const pts=t.map(v=>this._project(v));
            const depth=(pts[0].z+pts[1].z+pts[2].z)/3;
            out.push({solid:s,pts,depth,light:0.9});
          }
          continue;
        }
        const proj=s.geom.verts.map(v=>this._project(v));
        for(const face of s.geom.faces){
          const pts=face.idx.map(i=>proj[i]);
          const depth=pts.reduce((a,p)=>a+p.z,0)/pts.length;
          const nr=mul(rotX(this.pitch), mul(rotY(this.yaw), face.n));
          const light=0.62+0.40*Math.max(0, nr[1]*0.6 - nr[2]*0.3 + 0.4);
          out.push({solid:s,pts,depth,light});
        }
      }
      out.sort((a,b)=>b.depth-a.depth);
      return out;
    }

    _drawGrid(){
      const g=this.solids.find(s=>s.kind==='grid'); if(!g) return;
      const ctx=this.ctx; ctx.strokeStyle='rgba(80,110,150,0.14)'; ctx.lineWidth=1;
      const step=1, w=g.w, d=g.d;
      for(let x=-w/2;x<=w/2+0.001;x+=step){
        const a=this._project([x,0,-d/2]), b=this._project([x,0,d/2]);
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      }
      for(let z=-d/2;z<=d/2+0.001;z+=step){
        const a=this._project([-w/2,0,z]), b=this._project([w/2,0,z]);
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      }
    }

    render(){
      const ctx=this.ctx;
      ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
      if(!this.solids.length) return;
      this._drawGrid();
      for(const fc of this._buildFaces()){
        const s=fc.solid;
        ctx.beginPath();
        fc.pts.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
        ctx.closePath();
        if(s.kind==='shell'){
          ctx.fillStyle='rgba(47,107,255,0.045)';
          ctx.strokeStyle='rgba(90,115,150,0.28)'; ctx.lineWidth=1;
          ctx.fill(); ctx.stroke();
        } else if(s.kind==='mesh'){
          ctx.fillStyle=shade('#7c93b8',fc.light); ctx.fill();
          ctx.strokeStyle='rgba(30,45,70,0.18)'; ctx.stroke();
        } else {
          let base=TYPE_BASE[s.el.type]||'#6b7d99';
          if(this.showAI) base=STATUS_COLOR[s.el.ai_status]||STATUS_COLOR.none;
          ctx.fillStyle=shade(base,fc.light); ctx.fill();
          const sel=this.selectedId===s.el.id, hov=this.hoverId===s.el.id;
          ctx.strokeStyle= sel?'#2f6bff': hov?'rgba(47,107,255,0.55)':'rgba(30,45,70,0.28)';
          ctx.lineWidth= sel?2.5: hov?1.8:1;
          ctx.stroke();
        }
      }
    }

    _pick(mx,my){
      const faces=this._buildFaces().reverse();
      for(const fc of faces){
        if(fc.solid.kind!=='element') continue;
        if(this._inPoly(mx,my,fc.pts)) return fc.solid.el.id;
      }
      return null;
    }
    _inPoly(x,y,pts){
      let inside=false;
      for(let i=0,j=pts.length-1;i<pts.length;j=i++){
        const xi=pts[i].x,yi=pts[i].y,xj=pts[j].x,yj=pts[j].y;
        if(((yi>y)!==(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
      }
      return inside;
    }

    _resize(){
      const r=this.canvas.getBoundingClientRect();
      const dpr=window.devicePixelRatio||1;
      this.canvas.width=Math.max(300,r.width*dpr);
      this.canvas.height=Math.max(300,r.height*dpr);
      this.ctx.setTransform(1,0,0,1,0,0);
      this.cx=this.canvas.width/2; this.cy=this.canvas.height/2;
      this.focal=this.canvas.height*0.9;
    }

    _bindEvents(){
      let drag=false,pan=false,lx=0,ly=0,moved=0;
      const dpr=()=>window.devicePixelRatio||1;
      this.canvas.addEventListener('contextmenu',e=>e.preventDefault());
      this.canvas.addEventListener('mousedown',e=>{
        drag=true; pan=(e.button===2||e.shiftKey); lx=e.clientX; ly=e.clientY; moved=0;
      });
      window.addEventListener('mouseup',()=>{drag=false;});
      window.addEventListener('mousemove',e=>{
        if(drag){
          const dx=e.clientX-lx,dy=e.clientY-ly; lx=e.clientX; ly=e.clientY;
          moved+=Math.abs(dx)+Math.abs(dy);
          if(pan){ this.panX+=dx*dpr(); this.panY+=dy*dpr(); }
          else { this.yaw+=dx*0.01; this.pitch=Math.max(-1.4,Math.min(1.2,this.pitch+dy*0.01)); }
          this.render(); return;
        }
        const r=this.canvas.getBoundingClientRect();
        const mx=(e.clientX-r.left)*dpr(),my=(e.clientY-r.top)*dpr();
        const id=this._pick(mx,my);
        if(id!==this.hoverId){ this.hoverId=id; this.canvas.style.cursor=id?'pointer':'grab'; this.render(); if(this.onHover)this.onHover(id); }
      });
      this.canvas.addEventListener('wheel',e=>{
        e.preventDefault();
        this.dist*= (1+Math.sign(e.deltaY)*0.1);
        this.dist=Math.max(3,Math.min(400,this.dist)); this.render();
      },{passive:false});
      this.canvas.addEventListener('click',e=>{
        if(moved>6) return;
        const r=this.canvas.getBoundingClientRect();
        const mx=(e.clientX-r.left)*dpr(),my=(e.clientY-r.top)*dpr();
        this.select(this._pick(mx,my));
      });
    }
  }

  window.Viewer3D = Viewer3D;
})();
