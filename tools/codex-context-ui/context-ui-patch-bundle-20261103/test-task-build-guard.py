from pathlib import Path
import unittest, tempfile, importlib.util, sys, os, time
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('guard',Path(__file__).with_name('task-build-guard.py'))
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
ROOT=Path(__file__).resolve().parent.parent/'guard-test-artifacts'
ROOT.mkdir(exist_ok=True)
class GuardTests(unittest.TestCase):
 def run_child(self, code, **changes):
  d=Path(tempfile.mkdtemp(prefix='case-',dir=ROOT))
  opts=dict(cwd=d,env=os.environ.copy(),task_root=d,log_path=d/'child.log',result_path=d/'receipt.json',rss_budget=10**8,min_available=100,max_footprint=10**8,sample_interval=.01,footprint_interval=.01,mem_reader=lambda:1000,stats_reader=lambda pid:100)
  opts.update(changes)
  result=g.run_guarded([sys.executable,'-c',code],**opts)
  self.assertIsNotNone(result['exit']);self.assertTrue((d/'receipt.json').exists())
  self.assertFalse(Path('/proc',str(result['pid'])).exists())
  return result
 def test_nonzero_exit_receipt(self):
  r=self.run_child('import time;time.sleep(.05);raise SystemExit(17)')
  self.assertEqual(r['exit'],17);self.assertIsNone(r['guardStop'])
 def test_vanished_files_are_not_fatal(self):
  d=Path(tempfile.mkdtemp(prefix='race-',dir=ROOT));p=d/'vanish';p.write_text('x')
  original=Path.lstat
  def racing(path,*a,**k):
   if path==p:raise FileNotFoundError(str(path))
   return original(path,*a,**k)
  with patch.object(Path,'lstat',racing):size,races=g.footprint(d)
  self.assertEqual(races,1);self.assertGreater(size,0)
  r=self.run_child('import time;time.sleep(.1)',footprint_reader=lambda root:(100,3))
  self.assertEqual(r['exit'],0);self.assertIsNone(r['guardStop']);self.assertGreater(r['footprintRaces'],0)
 def test_guard_captures_signal_exit(self):
  r=self.run_child('import time;time.sleep(10)',mem_reader=lambda:50)
  self.assertEqual(r['exit'],-15);self.assertIn('MemAvailable',r['guardStop'])
 def test_unexpected_scan_error_cannot_orphan_child(self):
  def denied(root):raise PermissionError('fixture denied')
  r=self.run_child('import time;time.sleep(10)',footprint_reader=denied)
  self.assertEqual(r['exit'],-15);self.assertIn('PermissionError',r['guardStop'])
 def test_slow_scan_does_not_block_memory_sampling(self):
  def slow(root):time.sleep(.1);return (100,0)
  r=self.run_child('import time;time.sleep(.2)',footprint_reader=slow)
  self.assertEqual(r['exit'],0);self.assertGreater(r['samples'],10)
 def test_rss_stop_receipt(self):
  r=self.run_child('import time;time.sleep(10)',stats_reader=lambda pid:10**9)
  self.assertEqual(r['exit'],-15);self.assertIn('RSS',r['guardStop'])
 def test_footprint_stop_receipt(self):
  r=self.run_child('import time;time.sleep(10)',footprint_reader=lambda root:(10**9,0))
  self.assertEqual(r['exit'],-15);self.assertIn('footprint threshold',r['guardStop'])
if __name__=='__main__':unittest.main()

