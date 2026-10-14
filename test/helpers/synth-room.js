// Синтетическая комната для проверки обработки облаков: 4x3x2.5 м, шум вдоль нормали, двойной слой стены X=4, труба, летящие точки.
function rngf(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};}
function gauss(r){let u=0,v=0;while(!u)u=r();while(!v)v=r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
function room(opt){
  opt=opt||{};const sp=opt.spacing||0.01,sig=opt.sigma==null?0.003:opt.sigma,dbl=opt.double==null?0.03:opt.double,seed=opt.seed||7;
  const r=rngf(seed),P=[],lab=[]; // lab: 0 стена X0, 1 стена X1 (двойной слой), 2 пол, 3 потолок, 4 труба, 5 летящая
  const W=4,D=3,H=2.5;
  function plane(kind,fn,u,v){const nu=Math.round(u/sp),nv=Math.round(v/sp);for(let i=0;i<nu;i++)for(let j=0;j<nv;j++){const a=(i+r())/nu*u,b=(j+r())/nv*v;const p=fn(a,b);P.push(p[0]+gauss(r)*sig*(p[3]||0),p[1]+gauss(r)*sig*(p[4]||0),p[2]+gauss(r)*sig*(p[5]||0));lab.push(kind);}}
  // нормали шума вдоль нормали поверхности: (nx,ny,nz) в p[3..5]
  plane(0,(a,b)=>[0,b,a,1,0,0],D,H);               // стена x=0
  plane(1,(a,b)=>{const off=r()<0.5?0:dbl;return [W+off,b,a,1,0,0];},D,H); // стена x=W двойной слой
  plane(2,(a,b)=>[a,0,b,0,1,0],W,D);               // пол y=0 (Y вверх)
  plane(3,(a,b)=>[a,H,b,0,1,0],W,D);               // потолок y=H
  plane(6,(a,b)=>[a,b,0,0,0,1],W,H);               // стена z=0
  // труба вдоль X на высоте 2.0, z=1.5, R=0.1
  const R=opt.pipeR||0.1,L=2,nl=Math.round(L/sp),nc=Math.round(2*Math.PI*R/sp);
  for(let i=0;i<nl;i++)for(let j=0;j<nc;j++){const x=1+(i+r())/nl*L,t=(j+r())/nc*2*Math.PI;const c=Math.cos(t),s=Math.sin(t);const rr=R+gauss(r)*sig;P.push(x,2.0+s*rr,1.5+c*rr);lab.push(4);}
  const nf=opt.flying==null?500:opt.flying;for(let i=0;i<nf;i++){P.push(r()*W,r()*H,r()*D);lab.push(5);}
  return {pos:Float32Array.from(P),lab:Uint8Array.from(lab),R:R,sp:sp};
}
module.exports={room,rngf,gauss};
