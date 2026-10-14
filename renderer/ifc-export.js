
/* ifc-export.js — Sprint 6 (v1091): IFC-2x3 STEP ASCII export.
 * Generates valid ISO-10303-21 IFC2X3 from walls + floors.
 * window.IfcExport + module.exports
 */
(function(){
'use strict';
var _id=0;
function resetIds(){_id=0;}
function nid(){return ++_id;}
function guid(){
  // IFC GlobalId: 22-char base64-like
  var c='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  var s='';for(var i=0;i<22;i++) s+=c[Math.floor(Math.random()*64)];
  return s;
}
function q(s){return "'"+(String(s).replace(/'/g,"\\'"))+"'";}
function ref(id){return '#'+id;}

function makeHeader(projectName,date){
  date=date||new Date().toISOString().split('T')[0];
  return [
    'ISO-10303-21;',
    'HEADER;',
    'FILE_DESCRIPTION(('+q('ViewDefinition [CoordinationView]')+'),'+q('2;1')+');',
    'FILE_NAME('+q(projectName||'BIMTwin')+','+q(date)+',('+q('BIM Twin')+'),(),'+q('IFC2X3')+','+q('BIM Twin v1091')+','+q('')+');',
    'FILE_SCHEMA(('+q('IFC2X3')+'));',
    'ENDSEC;',
    'DATA;'
  ].join('\n');
}
function makeFooter(){return 'ENDSEC;\nEND-ISO-10303-21;';}

function exportIFC(walls,floors,opts){
  opts=opts||{};
  resetIds();
  var lines=[];
  // --- common entities ---
  var idOrg=nid(); lines.push('#'+idOrg+' = IFCORGANIZATION($,'+q('BIM Twin')+',$,$,$);');
  var idApp=nid(); lines.push('#'+idApp+' = IFCAPPLICATION(#'+idOrg+','+q('1091')+','+q('BIM Twin')+','+q('BIMTWIN')+');');
  var idPerson=nid(); lines.push('#'+idPerson+" = IFCPERSON($,"+q('User')+",$,$,$,$,$,$);");
  var idPersonOrg=nid(); lines.push('#'+idPersonOrg+' = IFCPERSONANDORGANIZATION(#'+idPerson+',#'+idOrg+',$);');
  var idOwner=nid(); lines.push('#'+idOwner+' = IFCOWNERHISTORY(#'+idPersonOrg+',#'+idApp+',$,.ADDED.,'+Math.floor(Date.now()/1000)+',$,$,0);');
  // units
  var idUA=nid(); lines.push('#'+idUA+' = IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);');
  var idUB=nid(); lines.push('#'+idUB+' = IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);');
  var idUnits=nid(); lines.push('#'+idUnits+' = IFCUNITASSIGNMENT((#'+idUA+',#'+idUB+'));');
  // geometry context
  var idDir1=nid(); lines.push('#'+idDir1+' = IFCDIRECTION((0.,0.,1.));');
  var idDir2=nid(); lines.push('#'+idDir2+' = IFCDIRECTION((1.,0.,0.));');
  var idO=nid(); lines.push('#'+idO+' = IFCCARTESIANPOINT((0.,0.,0.));');
  var idA3D=nid(); lines.push('#'+idA3D+' = IFCAXIS2PLACEMENT3D(#'+idO+',#'+idDir1+',#'+idDir2+');');
  var idCtx=nid(); lines.push('#'+idCtx+" = IFCGEOMETRICREPRESENTATIONCONTEXT($,"+q('Model')+',3,1.0E-05,#'+idA3D+',$);');
  // project / site / building
  var idProj=nid(); lines.push('#'+idProj+' = IFCPROJECT('+q(guid())+',#'+idOwner+','+q(opts.projectName||'BIMTwin Project')+',$,$,$,$,(#'+idCtx+'),#'+idUnits+');');
  var idSiteP=nid(); lines.push('#'+idSiteP+' = IFCAXIS2PLACEMENT3D(#'+idO+',$,$);');
  var idSiteLp=nid(); lines.push('#'+idSiteLp+' = IFCLOCALPLACEMENT($,#'+idSiteP+');');
  var idSite=nid(); lines.push('#'+idSite+' = IFCSITE('+q(guid())+',#'+idOwner+','+q('Site')+',$,$,#'+idSiteLp+',$,$,.ELEMENT.,$,$,$,$,$);');
  var idBldgLp=nid(); lines.push('#'+idBldgLp+' = IFCLOCALPLACEMENT(#'+idSiteLp+',$);');
  var idBldg=nid(); lines.push('#'+idBldg+' = IFCBUILDING('+q(guid())+',#'+idOwner+','+q('Building')+',$,$,#'+idBldgLp+',$,$,.ELEMENT.,$,$,$);');
  // floors / storeys
  var storeyIds=[];
  if(!floors||!floors.length) floors=[{name:'Level 0',ymin:0,ymax:3}];
  floors.forEach(function(fl){
    var idFlLp=nid(); lines.push('#'+idFlLp+' = IFCLOCALPLACEMENT(#'+idBldgLp+',$);');
    var idSt=nid(); lines.push('#'+idSt+' = IFCBUILDINGSTOREY('+q(guid())+',#'+idOwner+','+q(fl.name||'Storey')+',$,$,#'+idFlLp+',$,$,.ELEMENT.,'+fl.ymin.toFixed(4)+');');
    storeyIds.push({id:idSt,fl:fl,lpId:idFlLp});
  });
  // walls
  var wallIds=[];
  walls.forEach(function(w){
    var fl=storeyIds[0];
    var ht=(fl.fl.ymax-fl.fl.ymin)||3;
    var floorElevation=opts.floorElevation!=null?Number(opts.floorElevation):(Number(fl.fl.ymin)||0);
    // local placement at wall start
    var dx=w.b[0]-w.a[0],dz=w.b[1]-w.a[1],len=Math.sqrt(dx*dx+dz*dz)||1;
    var idWPt=nid(); lines.push('#'+idWPt+' = IFCCARTESIANPOINT(('+w.a[0].toFixed(4)+','+w.a[1].toFixed(4)+','+floorElevation.toFixed(4)+'));');
    var idWDir=nid(); lines.push('#'+idWDir+' = IFCDIRECTION(('+( dx/len).toFixed(6)+','+(dz/len).toFixed(6)+',0.));');
    var idWAx=nid(); lines.push('#'+idWAx+' = IFCAXIS2PLACEMENT3D(#'+idWPt+',$,#'+idWDir+');');
    var idWLp=nid(); lines.push('#'+idWLp+' = IFCLOCALPLACEMENT(#'+fl.lpId+',#'+idWAx+');');
    // profile
    var idRPt=nid(); lines.push('#'+idRPt+' = IFCCARTESIANPOINT((0.,0.));');
    var idRec=nid(); lines.push('#'+idRec+' = IFCRECTANGLEPROFILEDEF(.AREA.,$,IFCAXIS2PLACEMENT2D(#'+idRPt+',$),'+len.toFixed(4)+','+(opts.wallThickness||0.2).toFixed(4)+');');
    var idExtDir=nid(); lines.push('#'+idExtDir+' = IFCDIRECTION((0.,0.,1.));');
    var idExt=nid(); lines.push('#'+idExt+' = IFCEXTRUDEDAREASOLID(#'+idRec+',#'+idA3D+',#'+idExtDir+','+ht.toFixed(4)+');');
    var idShp=nid(); lines.push('#'+idShp+" = IFCSHAPEREPRESENTATION(#"+idCtx+","+q('Body')+","+q('SweptSolid')+',(#'+idExt+'));');
    var idPrdDef=nid(); lines.push('#'+idPrdDef+' = IFCPRODUCTDEFINITIONSHAPE($,$,(#'+idShp+'));');
    var idW=nid(); lines.push('#'+idW+' = IFCWALL('+q(guid())+',#'+idOwner+','+q('Wall')+',$,$,#'+idWLp+',#'+idPrdDef+',$);');
    wallIds.push({wId:idW,stId:fl.id});
  });
  // Basic vertical columns from the canonical Scan→BIM model. Coordinates are
  // IFC X/Y plan plus absolute IFC Z base elevation; the profile is an honest
  // rectangular proxy, not a fitted/parametric column family.
  var columns=Array.isArray(opts.columns)?opts.columns:[];
  columns.forEach(function(col,i){
    var cx=Number(col.cx),cy=Number(col.cy),baseZ=Number(col.baseZ);
    var width=Math.abs(Number(col.width)),depth=Math.abs(Number(col.depth)),height=Math.abs(Number(col.height));
    if(!isFinite(cx)||!isFinite(cy)||!isFinite(baseZ)||!(width>0)||!(depth>0)||!(height>0)) return;
    var idCPt=nid();lines.push('#'+idCPt+' = IFCCARTESIANPOINT(('+cx.toFixed(4)+','+cy.toFixed(4)+','+baseZ.toFixed(4)+'));');
    var idCAx=nid();lines.push('#'+idCAx+' = IFCAXIS2PLACEMENT3D(#'+idCPt+',#'+idDir1+',#'+idDir2+');');
    var idCLp=nid();lines.push('#'+idCLp+' = IFCLOCALPLACEMENT(#'+storeyIds[0].lpId+',#'+idCAx+');');
    var idCRPt=nid();lines.push('#'+idCRPt+' = IFCCARTESIANPOINT((0.,0.));');
    var idCRPos=nid();lines.push('#'+idCRPos+' = IFCAXIS2PLACEMENT2D(#'+idCRPt+',$);');
    var idCRec=nid();lines.push('#'+idCRec+' = IFCRECTANGLEPROFILEDEF(.AREA.,$,#'+idCRPos+','+width.toFixed(4)+','+depth.toFixed(4)+');');
    var idCSolid=nid();lines.push('#'+idCSolid+' = IFCEXTRUDEDAREASOLID(#'+idCRec+',#'+idA3D+',#'+idDir1+','+height.toFixed(4)+');');
    var idCShape=nid();lines.push('#'+idCShape+' = IFCSHAPEREPRESENTATION(#'+idCtx+','+q('Body')+','+q('SweptSolid')+',(#'+idCSolid+'));');
    var idCPds=nid();lines.push('#'+idCPds+' = IFCPRODUCTDEFINITIONSHAPE($,$,(#'+idCShape+'));');
    var idC=nid();lines.push('#'+idC+' = IFCCOLUMN('+q(guid())+',#'+idOwner+','+q(col.name||('Column '+(i+1)))+',$,$,#'+idCLp+',#'+idCPds+',$);');
    wallIds.push({wId:idC,stId:storeyIds[0].id});
  });
  // rel aggregates
  var idRelPS=nid(); lines.push('#'+idRelPS+' = IFCRELAGGREGATES('+q(guid())+',#'+idOwner+',$,$,#'+idProj+',(#'+idSite+'));');
  var idRelSB=nid(); lines.push('#'+idRelSB+' = IFCRELAGGREGATES('+q(guid())+',#'+idOwner+',$,$,#'+idSite+',(#'+idBldg+'));');
  storeyIds.forEach(function(s){
    var idRelBS=nid(); lines.push('#'+idRelBS+' = IFCRELAGGREGATES('+q(guid())+',#'+idOwner+',$,$,#'+idBldg+',(#'+s.id+'));');
  });
  wallIds.forEach(function(w){
    var idRelCont=nid(); lines.push('#'+idRelCont+' = IFCRELCONTAINEDINSPATIALSTRUCTURE('+q(guid())+',#'+idOwner+',$,$,(#'+w.wId+'),#'+w.stId+');');
  });
  return makeHeader(opts.projectName)+'\n'+lines.join('\n')+'\n'+makeFooter();
}
var API={exportIFC:exportIFC,resetIds:resetIds};
if(typeof window!=='undefined') window.IfcExport=API;
if(typeof module!=='undefined'&&module.exports) module.exports=API;
})();
