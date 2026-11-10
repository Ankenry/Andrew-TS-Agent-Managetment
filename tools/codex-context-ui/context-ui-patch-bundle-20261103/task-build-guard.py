"""Task-local child owner/guard. Never attaches to or terminates another process group.
Footprint scans run off the sampling path; vanished files are counted as races, not fatal.
The original Popen parent always waits and records a real return code, including guard exceptions.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import os, json, time, signal, subprocess, datetime, resource

def footprint(root):
    size = races = 0
    seen = set()
    stack = [Path(root)]
    while stack:
        p = stack.pop()
        try:
            s = p.lstat()
            key = (s.st_dev, s.st_ino)
            if key in seen:
                continue
            seen.add(key)
            size += s.st_size
            if p.is_dir() and not p.is_symlink():
                with os.scandir(p) as entries:
                    stack.extend(Path(e.path) for e in entries)
        except FileNotFoundError:
            races += 1
    return size, races

def available_memory():
    return int(next(l.split()[1] for l in Path('/proc/meminfo').read_text().splitlines()
                    if l.startswith('MemAvailable:'))) * 1024

def tree_stats(pid):
    rows = {}
    for d in Path('/proc').iterdir():
        if not d.name.isdigit():
            continue
        try:
            s = dict(l.split(':', 1) for l in (d/'status').read_text().splitlines() if ':' in l)
            rows[int(d.name)] = (int(s['PPid']), int(s.get('VmRSS', '0 kB').split()[0])*1024)
        except (OSError, ValueError):
            continue
    ids = {pid}
    while True:
        more = ids | {i for i, (parent, _) in rows.items() if parent in ids}
        if ids == more:
            break
        ids = more
    return sum(rows.get(i, (0, 0))[1] for i in ids)

def save(path, value):
    p = Path(path)
    tmp = p.with_name(p.name+'.writing')
    tmp.write_text(json.dumps(value, indent=2))
    os.replace(tmp, p)

def run_guarded(argv, *, cwd, env, task_root, log_path, result_path, rss_budget,
                min_available, max_footprint, sample_interval=.25, footprint_interval=20,
                mem_reader=available_memory, stats_reader=tree_stats, footprint_reader=footprint):
    started = datetime.datetime.now().astimezone().isoformat()
    state = dict(startedAt=started, command=argv, exit=None, guardStop=None,
                 peakTreeRssBytes=0, minMemAvailableBytes=None, footprintBytes=None,
                 footprintRaces=0, samples=0, continuousOwner=True)
    process = None
    pool = ThreadPoolExecutor(max_workers=1)
    future = None
    reason = None
    stopped = False
    def limits():
        os.nice(10)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        with open(log_path, 'x') as out:
            process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=out,
                                       stderr=subprocess.STDOUT, start_new_session=True,
                                       preexec_fn=limits)
            state['pid'] = process.pid
            last_scan = -float('inf')
            last_save = -float('inf')
            while process.poll() is None:
                rss, available = stats_reader(process.pid), mem_reader()
                state['samples'] += 1
                state['peakTreeRssBytes'] = max(state['peakTreeRssBytes'], rss)
                old = state['minMemAvailableBytes']
                state['minMemAvailableBytes'] = available if old is None else min(old, available)
                if rss > rss_budget:
                    reason = 'build tree RSS budget exceeded'
                if available < min_available:
                    reason = 'proactive MemAvailable threshold crossed'
                if future is not None and future.done():
                    size, races = future.result()  # Unexpected errors fail closed below.
                    state['footprintBytes'] = size
                    state['footprintRaces'] += races
                    future = None
                    if size > max_footprint:
                        reason = 'task footprint threshold crossed'
                now = time.monotonic()
                if future is None and now-last_scan >= footprint_interval:
                    future = pool.submit(footprint_reader, task_root)
                    last_scan = now
                if reason:
                    state['guardStop'] = reason
                    save(str(result_path)+'.observations.json', state)
                    os.killpg(process.pid, signal.SIGTERM)
                    stopped = True
                    break
                if now-last_save >= 1:
                    save(str(result_path)+'.observations.json', state)
                    last_save = now
                time.sleep(sample_interval)
    except BaseException as error:
        reason = f'guard exception: {type(error).__name__}: {error}'
        state['guardStop'] = reason
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                stopped = True
            except ProcessLookupError:
                pass
    finally:
        if process is not None:
            # Remain the parent until reaped. A thrown footprint scan cannot orphan this child.
            state['exit'] = process.wait()
        pool.shutdown(wait=True)
        if future is not None:
            try:
                size, races = future.result()
                state['footprintBytes'] = size
                state['footprintRaces'] += races
            except BaseException as error:
                if reason is None:
                    reason = f'footprint exception: {type(error).__name__}: {error}'
        state['guardStop'] = reason
        state['terminationRequested'] = stopped
        state['finishedAt'] = datetime.datetime.now().astimezone().isoformat()
        save(result_path, state)
    return state
