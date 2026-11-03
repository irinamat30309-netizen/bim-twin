import os
import re
import tempfile
import unittest

from app.ifc_writer import write_ifc


MODEL = {
    'height': 3.2, 'footprint': [[0, 0], [8, 5]],
    'walls': [{'p0': [0, 0], 'p1': [8, 0], 'thickness': .2,
               'support': .95, 'rms': .012,
               'openings': [{'along': 3., 'width': .9, 'sill': 0.,
                             'head': 2.1, 'source': 'void'}]}],
    'pipes': [{'p0': [.5, 1], 'p1': [6, 1], 'y': 2.7,
               'radius': .04, 'dn': 'DN80', 'length': 5.5}],
    'services': [
        {'p0': [.5, 2], 'p1': [6, 2], 'y': 2.8, 'width': .4,
         'height': .25, 'length': 5.5, 'kind': 'duct'},
        {'p0': [.5, 3], 'p1': [6, 3], 'y': 2.9, 'width': .3,
         'height': .1, 'length': 5.5, 'kind': 'cable_tray'}],
    'objects': [{'cx': 2, 'cy': 4, 'base': 0, 'hx': .3, 'hy': .3,
                 'hz': 1.4, 'kind': 'equipment'}]
}


class RevitIfcTests(unittest.TestCase):
    def export(self, schema):
        p = tempfile.mktemp(suffix='.ifc')
        self.addCleanup(lambda: os.path.exists(p) and os.unlink(p))
        write_ifc(MODEL, p, 'BIM Twin test', schema)
        with open(p, encoding='utf-8') as f:
            return f.read()

    def validate_common(self, text):
        ids = {int(x) for x in re.findall(r'^#(\d+)=', text, re.M)}
        refs = {int(x) for x in re.findall(r'#(\d+)', text)}
        self.assertFalse(refs - ids)
        self.assertTrue(text.endswith('END-ISO-10303-21;\n'))
        # Root entities and relationships have GlobalId followed by OwnerHistory.
        # Property names and FILE_NAME are intentionally excluded.
        gids = re.findall(r"(?:IFC[A-Z0-9]+)\('([^']+)',#\d+", text)
        self.assertTrue(gids)
        self.assertTrue(all(len(g) == 22 for g in gids))
        self.assertIn('IFCUNITASSIGNMENT(', text)
        self.assertIn('IFCRELVOIDSELEMENT(', text)
        self.assertIn('IFCRELFILLSELEMENT(', text)
        self.assertIn('IFCDOOR(', text)
        self.assertIn("'Pset_BIMTwin'", text)

    def test_ifc2x3_revit_compatibility(self):
        text = self.export('IFC2X3')
        self.validate_common(text)
        self.assertIn("FILE_SCHEMA(('IFC2X3'))", text)
        self.assertIn('CoordinationView_V2.0', text)
        self.assertGreaterEqual(text.count('IFCBUILDINGELEMENTPROXY('), 4)

    def test_ifc4_native_mep(self):
        text = self.export('IFC4')
        self.validate_common(text)
        self.assertIn("FILE_SCHEMA(('IFC4'))", text)
        self.assertIn('IFCPIPESEGMENT(', text)
        self.assertIn('IFCDUCTSEGMENT(', text)
        self.assertIn('IFCCABLECARRIERSEGMENT(', text)


if __name__ == '__main__':
    unittest.main()
