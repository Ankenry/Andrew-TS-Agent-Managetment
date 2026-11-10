"""Read only the selected live thread's configuration, never conversation text."""
import json
import pathlib
import sqlite3
import sys

source = json.load(sys.stdin)
home = pathlib.Path(source['codexHome']).resolve()
result = {}
for database in sorted(home.glob('state_*.sqlite'), reverse=True):
    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=2)
    try:
        connection.execute('PRAGMA query_only=ON')
        columns = {row[1] for row in connection.execute('PRAGMA table_info(threads)')}
        wanted = [key for key in ['cwd', 'rollout_path', 'model', 'reasoning_effort', 'approval_mode', 'sandbox_policy'] if key in columns]
        if not {'cwd', 'rollout_path'}.issubset(columns):
            continue
        row = connection.execute('SELECT ' + ','.join(wanted) + ' FROM threads WHERE id=?', (source['sessionId'],)).fetchone()
        if not row:
            continue
        data = dict(zip(wanted, row))
        if pathlib.Path(data['cwd']).resolve() != pathlib.Path(source['root']).resolve() or pathlib.Path(data['rollout_path']).resolve() != pathlib.Path(source['filename']).resolve():
            continue
        result = {key: data.get(key) for key in wanted if key not in ['cwd', 'rollout_path']}
        break
    finally:
        connection.close()
print(json.dumps(result))
