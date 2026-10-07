import unittest
import numpy as np
from app import cloud2bim, pipes

def wall_points(x0,z0,x1,z1,count=2200,height=4.15,seed=1):
    r=np.random.default_rng(seed); t=r.random(count); y=r.random(count)*height
    return np.column_stack([x0+(x1-x0)*t+r.normal(0,.004,count),y,z0+(z1-z0)*t+r.normal(0,.004,count)])

class GeometryV1204Tests(unittest.TestCase):
    def test_corridor_grid(self):
        parts=[wall_points(0,0,0,28,seed=2),wall_points(3.1,0,3.1,28,seed=3)]
        for i,z in enumerate((.05,.72,4.12,10.52,23.22,27.52)): parts.append(wall_points(0,z,3.1,z,seed=10+i))
        walls=cloud2bim._corridor_walls_from_grid(np.vstack(parts),1,[0,2],0,4.15,.03)
        self.assertEqual(len(walls),8)
    def test_flat_soffit_not_pipes(self):
        r=np.random.default_rng(4); n=30000
        xyz=np.column_stack([r.uniform(.2,2.9,n),r.normal(4.9,.001,n),r.uniform(0,27.5,n)])
        self.assertEqual(pipes.detect_pipes(xyz,None,1,[0,2],1.6,5.76,[],np.array([0.,0.]),.03),[])

if __name__=='__main__': unittest.main()
