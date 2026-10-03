const SV=require("../renderer/splatviewer.js");
function makeBuf(points){const buf=new Uint8Array(points.length*32);const dv=new DataView(buf.buffer);points.forEach((p,i)=>{const o=i*32;dv.setFloat32(o,p[0],true);dv.setFloat32(o+4,p[1],true);dv.setFloat32(o+8,p[2],true);});return new Float32Array(buf.buffer);}
function roomPoints(){const pts=[];for(let x=0;x<=4.0001;x+=0.1)for(let z=0;z<=4.0001;z+=0.1)pts.push([x,0,z]);for(let z=0;z<=4.0001;z+=0.1)for(let y=0.1;y<=2.5001;y+=0.1){pts.push([0,y,z]);pts.push([4,y,z]);}for(let x=0;x<=4.0001;x+=0.1)for(let y=0.1;y<=2.5001;y+=0.1){pts.push([x,y,0]);pts.push([x,y,4]);}return pts;}
const B={lo:[0,0,0],hi:[4,2.5,4],center:[2,1.25,2],radius:3};
const pts=roomPoints();const f=makeBuf(pts);
const g=SV._buildCollisionGrid(f,pts.length,B,{cell:0.2,layerH:0.5,minAbs:5,densFrac:0});
console.log("grid oy,layerH,ny,nx,nz:",g.oy,g.layerH,g.ny,g.nx,g.nz);
console.log("groundY(2,2,0.6)=",SV._groundY(g,2,2,0.6));
console.log("groundY(0.5,0.5,0.6)=",SV._groundY(g,0.5,0.5,0.6));
console.log("worldBlocked(2,2,0.8,2.0,0.25)=",SV._worldBlocked(g,2,2,0.8,2.0,0.25));
console.log("worldBlocked(0.5,0.5,0.8,2.0,0.25)=",SV._worldBlocked(g,0.5,0.5,0.8,2.0,0.25));
const st=[{pos:[0.5,0,0.5]},{pos:[2.0,0,2.0]},{pos:[3.5,0,1.0]}];
console.log("spawn=",JSON.stringify(SV._pickSpawn(st,B,g,1.6)));
console.log("spawn single [2,0,2]=",JSON.stringify(SV._pickSpawn([{pos:[2,0,2]}],B,g,1.6)));
