"""Revit-oriented IFC2X3/IFC4 STEP writer without external dependencies.

The exporter favors simple SweptSolid geometry and native IFC classes that
Revit imports reliably. IFC2X3 Coordination View is the compatibility file;
IFC4 is the richer modern/link file.
"""
import math
import time
import uuid

_IFC64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"


def _ifc_guid():
    u = uuid.uuid4()
    n = [u.time_low >> 24, u.time_low & 0xFFFFFF,
         (u.time_mid << 8) | (u.time_hi_version >> 8),
         ((u.time_hi_version & 0xFF) << 16) | (u.clock_seq_hi_variant << 8) | u.clock_seq_low,
         u.node >> 24, u.node & 0xFFFFFF]
    out = []
    for value, width in zip(n, (2, 4, 4, 4, 4, 4)):
        part = ""
        for _ in range(width):
            part = _IFC64[value % 64] + part
            value //= 64
        out.append(part)
    return "".join(out)


def _s(v):
    return str(v or "").replace("'", "''")


class _Step:
    def __init__(self):
        self.lines = []
        self.id = 0

    def add(self, value):
        self.id += 1
        self.lines.append(f"#{self.id}={value};")
        return self.id


def _identity(st):
    p = st.add("IFCCARTESIANPOINT((0.,0.,0.))")
    z = st.add("IFCDIRECTION((0.,0.,1.))")
    x = st.add("IFCDIRECTION((1.,0.,0.))")
    return st.add(f"IFCAXIS2PLACEMENT3D(#{p},#{z},#{x})")


def _local_placement(st, parent, axis):
    return st.add(f"IFCLOCALPLACEMENT(#{parent},#{axis})" if parent else f"IFCLOCALPLACEMENT($,#{axis})")


def _rectangle_profile(st, width, depth):
    p = st.add("IFCCARTESIANPOINT((0.,0.))")
    d = st.add("IFCDIRECTION((1.,0.))")
    ax = st.add(f"IFCAXIS2PLACEMENT2D(#{p},#{d})")
    return st.add(f"IFCRECTANGLEPROFILEDEF(.AREA.,$,#{ax},{width:.6f},{depth:.6f})")


def _product_shape(st, solid, ctx):
    rep = st.add(f"IFCSHAPEREPRESENTATION(#{ctx},'Body','SweptSolid',(#{solid}))")
    return st.add(f"IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}))")


def _wall_shape(st, p0, p1, thickness, height, base, ctx):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 1e-5 or height <= 0:
        return None
    ang = math.atan2(dy, dx)
    prof = _rectangle_profile(st, length, max(thickness, .01))
    loc = st.add(f"IFCCARTESIANPOINT(({(p0[0]+p1[0])/2:.6f},{(p0[1]+p1[1])/2:.6f},{base:.6f}))")
    z = st.add("IFCDIRECTION((0.,0.,1.))")
    x = st.add(f"IFCDIRECTION(({math.cos(ang):.9f},{math.sin(ang):.9f},0.))")
    ax = st.add(f"IFCAXIS2PLACEMENT3D(#{loc},#{z},#{x})")
    ext = st.add("IFCDIRECTION((0.,0.,1.))")
    solid = st.add(f"IFCEXTRUDEDAREASOLID(#{prof},#{ax},#{ext},{height:.6f})")
    return _product_shape(st, solid, ctx)


def _horizontal_shape(st, p0, p1, z, width, height, ctx, circular=False, radius=.02):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 1e-5:
        return None
    d0, d1 = dx / length, dy / length
    if circular:
        p = st.add("IFCCARTESIANPOINT((0.,0.))")
        ax2 = st.add(f"IFCAXIS2PLACEMENT2D(#{p},$)")
        prof = st.add(f"IFCCIRCLEPROFILEDEF(.AREA.,$,#{ax2},{max(radius,.003):.6f})")
    else:
        # Local X is mapped to global Z by RefDirection; local Y becomes the
        # horizontal cross-axis. Keep height vertical and width horizontal.
        prof = _rectangle_profile(st, max(height, .01), max(width, .01))
    loc = st.add(f"IFCCARTESIANPOINT(({p0[0]:.6f},{p0[1]:.6f},{z:.6f}))")
    axis = st.add(f"IFCDIRECTION(({d0:.9f},{d1:.9f},0.))")
    ref = st.add("IFCDIRECTION((0.,0.,1.))")
    ax3 = st.add(f"IFCAXIS2PLACEMENT3D(#{loc},#{axis},#{ref})")
    ext = st.add("IFCDIRECTION((0.,0.,1.))")
    solid = st.add(f"IFCEXTRUDEDAREASOLID(#{prof},#{ax3},#{ext},{length:.6f})")
    return _product_shape(st, solid, ctx)


def _box_shape(st, cx, cy, base, hx, hy, hz, ctx):
    prof = _rectangle_profile(st, max(2*hx,.01), max(2*hy,.01))
    loc = st.add(f"IFCCARTESIANPOINT(({cx:.6f},{cy:.6f},{base:.6f}))")
    z = st.add("IFCDIRECTION((0.,0.,1.))")
    x = st.add("IFCDIRECTION((1.,0.,0.))")
    ax = st.add(f"IFCAXIS2PLACEMENT3D(#{loc},#{z},#{x})")
    ext = st.add("IFCDIRECTION((0.,0.,1.))")
    solid = st.add(f"IFCEXTRUDEDAREASOLID(#{prof},#{ax},#{ext},{max(hz,.01):.6f})")
    return _product_shape(st, solid, ctx)


def _entity(st, schema, typ, oh, name, pl, pds, predefined=None, extras=""):
    base = f"'{_ifc_guid()}',#{oh},'{_s(name)}',$,$,#{pl},#{pds},$"
    if typ == "IFCWALLSTANDARDCASE":
        return st.add(f"{typ}({base}{',' + (predefined or '$') if schema == 'IFC4' else ''})")
    if typ == "IFCOPENINGELEMENT":
        return st.add(f"{typ}({base}{',.OPENING.' if schema == 'IFC4' else ''})")
    if typ == "IFCDOOR":
        # extras = overall height, overall width
        h, w = extras
        tail = f",{h:.6f},{w:.6f}"
        if schema == "IFC4":
            tail += ",.DOOR.,.NOTDEFINED.,$"
        return st.add(f"{typ}({base}{tail})")
    if typ in ("IFCPIPESEGMENT", "IFCDUCTSEGMENT", "IFCCABLECARRIERSEGMENT"):
        return st.add(f"{typ}({base},{predefined or '$'})")
    if typ == "IFCSLAB":
        return st.add(f"{typ}({base},{predefined or '.NOTDEFINED.'})")
    if typ == "IFCBUILDINGELEMENTPROXY":
        return st.add(f"{typ}({base},.NOTDEFINED.)")
    raise ValueError(typ)


def _property_set(st, oh, product, values):
    props = []
    for name, value in values.items():
        if value is None:
            continue
        if isinstance(value, (int, float)):
            nominal = f"IFCREAL({float(value):.6f})"
        else:
            nominal = f"IFCLABEL('{_s(value)}')"
        props.append(st.add(f"IFCPROPERTYSINGLEVALUE('{_s(name)}',$,{nominal},$)"))
    if not props:
        return
    ps = st.add(f"IFCPROPERTYSET('{_ifc_guid()}',#{oh},'Pset_BIMTwin',$,({','.join('#'+str(x) for x in props)}))")
    st.add(f"IFCRELDEFINESBYPROPERTIES('{_ifc_guid()}',#{oh},$,$,(#{product}),#{ps})")


def write_ifc(model, path, name="BIM Twin", schema="IFC4"):
    schema = schema.upper()
    if schema not in ("IFC4", "IFC2X3"):
        raise ValueError("schema must be IFC4 or IFC2X3")
    st = _Step()
    person = st.add("IFCPERSON($,$,'BIM Twin',$,$,$,$,$)")
    org = st.add("IFCORGANIZATION($,'BIM Twin',$,$,$)")
    po = st.add(f"IFCPERSONANDORGANIZATION(#{person},#{org},$)")
    app = st.add(f"IFCAPPLICATION(#{org},'0.9.39','BIM Twin Scan-to-BIM','BIMTWIN')")
    oh = st.add(f"IFCOWNERHISTORY(#{po},#{app},$,.ADDED.,$,$,$,{int(time.time())})")
    axis = _identity(st)
    ctx = st.add(f"IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#{axis},$)")
    length_u = st.add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)")
    area_u = st.add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)")
    vol_u = st.add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)")
    angle_u = st.add("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)")
    units = st.add(f"IFCUNITASSIGNMENT((#{length_u},#{area_u},#{vol_u},#{angle_u}))")
    project = st.add(f"IFCPROJECT('{_ifc_guid()}',#{oh},'{_s(name)}',$,$,$,$,(#{ctx}),#{units})")
    site_pl = _local_placement(st, None, axis)
    site = st.add(f"IFCSITE('{_ifc_guid()}',#{oh},'Site',$,$,#{site_pl},$,$,.ELEMENT.,$,$,$,$,$)")
    bld_pl = _local_placement(st, site_pl, axis)
    bld = st.add(f"IFCBUILDING('{_ifc_guid()}',#{oh},'Building',$,$,#{bld_pl},$,$,.ELEMENT.,$,$,$)")
    sto_pl = _local_placement(st, bld_pl, axis)
    storey = st.add(f"IFCBUILDINGSTOREY('{_ifc_guid()}',#{oh},'Level 1',$,$,#{sto_pl},$,$,.ELEMENT.,0.)")
    st.add(f"IFCRELAGGREGATES('{_ifc_guid()}',#{oh},$,$,#{project},(#{site}))")
    st.add(f"IFCRELAGGREGATES('{_ifc_guid()}',#{oh},$,$,#{site},(#{bld}))")
    st.add(f"IFCRELAGGREGATES('{_ifc_guid()}',#{oh},$,$,#{bld},(#{storey}))")
    products = []
    height = float(model.get("height", 3.0))

    for i, w in enumerate(model.get("walls", [])):
        p0, p1 = w["p0"], w["p1"]
        thick = float(w.get("thickness", .15))
        pds = _wall_shape(st, p0, p1, thick, height, 0., ctx)
        if not pds:
            continue
        pl = _local_placement(st, sto_pl, axis)
        wall = _entity(st, schema, "IFCWALLSTANDARDCASE", oh, f"Wall {i+1}", pl, pds, ".NOTDEFINED.")
        products.append(wall)
        _property_set(st, oh, wall, {"BIMTwinCategory":"Wall", "Thickness":thick,
                                    "Support":w.get("support"), "RMS":w.get("rms")})
        dx, dy = p1[0]-p0[0], p1[1]-p0[1]
        ln = math.hypot(dx,dy)
        if ln < 1e-5:
            continue
        ux, uy = dx/ln, dy/ln
        for j, op in enumerate(w.get("openings", [])):
            width = min(max(float(op.get("width", .9)), .3), ln)
            sill = max(0., float(op.get("sill", 0.)))
            head = min(height, float(op.get("head", 2.2)))
            ohgt = max(.2, head-sill)
            along = min(max(float(op.get("along", ln/2)), width/2), ln-width/2)
            cx, cy = p0[0]+ux*along, p0[1]+uy*along
            a = [cx-ux*width/2, cy-uy*width/2]
            b = [cx+ux*width/2, cy+uy*width/2]
            ods = _wall_shape(st, a, b, thick+.04, ohgt, sill, ctx)
            opl = _local_placement(st, sto_pl, axis)
            opening = _entity(st, schema, "IFCOPENINGELEMENT", oh, f"Opening {i+1}.{j+1}", opl, ods)
            st.add(f"IFCRELVOIDSELEMENT('{_ifc_guid()}',#{oh},$,$,#{wall},#{opening})")
            dds = _wall_shape(st, a, b, min(.05,thick), ohgt, sill, ctx)
            dpl = _local_placement(st, sto_pl, axis)
            door = _entity(st, schema, "IFCDOOR", oh, f"Door {i+1}.{j+1}", dpl, dds, extras=(ohgt,width))
            products.append(door)
            st.add(f"IFCRELFILLSELEMENT('{_ifc_guid()}',#{oh},$,$,#{opening},#{door})")
            _property_set(st, oh, door, {"BIMTwinCategory":"Door", "Width":width, "Height":ohgt,
                                        "DetectionSource":op.get("source")})

    fp = model.get("footprint", [[0,0],[1,1]])
    (x0,y0),(x1,y1)=fp
    floor_pds = _box_shape(st,(x0+x1)/2,(y0+y1)/2,-.15,abs(x1-x0)/2,abs(y1-y0)/2,.15,ctx)
    pl = _local_placement(st,sto_pl,axis)
    products.append(_entity(st,schema,"IFCSLAB",oh,"Floor",pl,floor_pds,".FLOOR."))
    ceil_pds = _box_shape(st,(x0+x1)/2,(y0+y1)/2,height,abs(x1-x0)/2,abs(y1-y0)/2,.15,ctx)
    pl = _local_placement(st,sto_pl,axis)
    products.append(_entity(st,schema,"IFCSLAB",oh,"Ceiling",pl,ceil_pds,".ROOF."))

    for i,p in enumerate(model.get("pipes", [])):
        pds=_horizontal_shape(st,p["p0"],p["p1"],float(p.get("y",height-.2)),0,0,ctx,True,float(p.get("radius",.03)))
        if not pds: continue
        pl=_local_placement(st,sto_pl,axis)
        if schema=="IFC4": el=_entity(st,schema,"IFCPIPESEGMENT",oh,f"Pipe {i+1}",pl,pds,".RIGIDSEGMENT.")
        else: el=_entity(st,schema,"IFCBUILDINGELEMENTPROXY",oh,f"Pipe {i+1} {p.get('dn','')}",pl,pds)
        products.append(el); _property_set(st,oh,el,{"BIMTwinCategory":"Pipe","NominalDiameter":p.get("dn"),"Radius":p.get("radius"),"Length":p.get("length")})

    for i,srv in enumerate(model.get("services", [])):
        pds=_horizontal_shape(st,srv["p0"],srv["p1"],float(srv.get("y",height-.3)),float(srv.get("width",.3)),float(srv.get("height",.2)),ctx)
        if not pds: continue
        pl=_local_placement(st,sto_pl,axis); kind=srv.get("kind","duct")
        if schema=="IFC4":
            typ="IFCCABLECARRIERSEGMENT" if kind=="cable_tray" else "IFCDUCTSEGMENT"
            pre=".CABLETRAYSEGMENT." if kind=="cable_tray" else ".RIGIDSEGMENT."
            el=_entity(st,schema,typ,oh,f"{'Cable tray' if kind=='cable_tray' else 'Duct'} {i+1}",pl,pds,pre)
        else: el=_entity(st,schema,"IFCBUILDINGELEMENTPROXY",oh,f"{'Cable tray' if kind=='cable_tray' else 'Duct'} {i+1}",pl,pds)
        products.append(el); _property_set(st,oh,el,{"BIMTwinCategory":kind,"Width":srv.get("width"),"Height":srv.get("height"),"Length":srv.get("length")})

    for i,o in enumerate(model.get("objects", [])):
        pds=_box_shape(st,float(o.get("cx",0)),float(o.get("cy",0)),float(o.get("base",0)),float(o.get("hx",.2)),float(o.get("hy",.2)),float(o.get("hz",.4)),ctx)
        pl=_local_placement(st,sto_pl,axis); el=_entity(st,schema,"IFCBUILDINGELEMENTPROXY",oh,f"Equipment {i+1}",pl,pds)
        products.append(el); _property_set(st,oh,el,{"BIMTwinCategory":o.get("kind","Equipment")})

    if products:
        st.add(f"IFCRELCONTAINEDINSPATIALSTRUCTURE('{_ifc_guid()}',#{oh},$,$,({','.join('#'+str(x) for x in products)}),#{storey})")
    mvd = "CoordinationView_V2.0" if schema=="IFC2X3" else "ReferenceView_V1.2"
    header=("ISO-10303-21;\nHEADER;\n"+f"FILE_DESCRIPTION(('ViewDefinition [{mvd}]'),'2;1');\n"+
            f"FILE_NAME('{_s(name)}','',('BIM Twin'),(''),'BIM Twin 0.9.39','BIM Twin','');\n"+
            f"FILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n")
    with open(path,"w",encoding="utf-8",newline="\n") as f:
        f.write(header+"\n".join(st.lines)+"\nENDSEC;\nEND-ISO-10303-21;\n")
    return path
