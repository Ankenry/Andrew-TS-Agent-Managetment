#!/usr/bin/python3
"""Andrew Brain: a single-instance GNOME app with its own local reader."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from urllib.parse import urlsplit

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2

APP_ID = 'com.ankenry.AndrewBrain'
APP_ROOT = Path(__file__).resolve().parent.parent
SMOKE = '--smoke-test' in sys.argv


def allowed_local_uri(uri, origin):
    """Only the exact reader origin can navigate inside the application."""
    try:
        target, base = urlsplit(uri), urlsplit(origin)
        return (not target.username and not target.password and
                target.scheme == base.scheme == 'http' and
                target.hostname == base.hostname == '127.0.0.1' and
                target.port == base.port)
    except ValueError:
        return False


class ReaderProcess:
    def __init__(self, root, fixture=False):
        self.root, self.fixture = Path(root), fixture
        self.process = None

    def start(self):
        if self.process is not None:
            raise RuntimeError('Reader already started')
        env = {**os.environ, 'BRAIN_ROOT': str(self.root),
               'BRAIN_FIXTURE': '1' if self.fixture else '0'}
        # The reader uses only local Markdown. Do not forward provider secrets.
        for key in list(env):
            if any(part in key.upper() for part in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY')):
                env.pop(key)
        self.process = subprocess.Popen(
            ['/usr/bin/node', str(APP_ROOT / 'desktop/server.mjs')],
            cwd=APP_ROOT, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.process.stdout.readline()
        data = json.loads(line)
        port = data.get('port')
        if data.get('event') != 'ready' or type(port) is not int or not 0 < port < 65536:
            raise RuntimeError('Invalid reader handshake')
        return f'http://127.0.0.1:{port}'

    def stop(self):
        process, self.process = self.process, None
        if process is None:
            return
        if process.stdin:
            process.stdin.close()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        if process.stdout:
            process.stdout.close()


class BrainApplication(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID + ('.Smoke' if SMOKE else ''),
                         flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.window = self.webview = self.reader = None
        self.origin = None
        self.failed = False
        self.loaded = False
        self.result = 0
        self.shutting_down = False
        self.runtime = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'andrew-brain'

    def do_startup(self):
        Gtk.Application.do_startup(self)
        GLib.set_application_name('Andrew Brain')
        Gtk.Settings.get_default().set_property('gtk-application-prefer-dark-theme', True)
        action = Gio.SimpleAction.new('quit', None)
        action.connect('activate', lambda *_: self.quit())
        self.add_action(action)
        self.set_accels_for_action('app.quit', ['<Primary>q'])

    def do_activate(self):
        if self.window is not None:
            self.window.present()
            return
        self.window = Gtk.ApplicationWindow(application=self, title='Andrew Brain')
        self.window.set_default_size(1440, 900)
        self.window.set_size_request(860, 600)
        self.window.set_icon_from_file(str(APP_ROOT / 'desktop/icon.svg'))
        self.stack = Gtk.Stack()
        self.window.add(self.stack)
        loading = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        loading.set_halign(Gtk.Align.CENTER)
        loading.set_valign(Gtk.Align.CENTER)
        spinner = Gtk.Spinner()
        spinner.start()
        loading.pack_start(spinner, False, False, 0)
        loading.pack_start(Gtk.Label(label='Đang mở Andrew Brain…'), False, False, 0)
        self.stack.add_named(loading, 'loading')
        self.window.show_all()
        self._start_reader()
        if SMOKE:
            GLib.timeout_add_seconds(35, self._smoke_timeout)

    def _start_reader(self):
        self.failed = False
        self.loaded = False
        self.origin = None
        self.stack.set_visible_child_name('loading')
        vault = (APP_ROOT / 'tests/fixtures/vault' if SMOKE else
                 Path(os.environ.get('BRAIN_ROOT', Path.home() / 'avada-brain')))
        self.reader = ReaderProcess(vault, fixture=SMOKE)
        reader = self.reader

        def start():
            try:
                origin = reader.start()
                GLib.idle_add(self._reader_ready, reader, origin)
            except Exception:
                GLib.idle_add(self._reader_failed, reader)
        threading.Thread(target=start, daemon=True).start()
        GLib.timeout_add_seconds(15, self._startup_timeout, reader)

    def _reader_ready(self, reader, origin):
        if self.shutting_down or reader is not self.reader or self.failed:
            reader.stop()
            return False
        self.origin = origin
        manager = WebKit2.WebsiteDataManager.new_ephemeral()
        context = WebKit2.WebContext.new_with_website_data_manager(manager)
        context.set_sandbox_enabled(True)
        self.webview = WebKit2.WebView.new_with_context(context)
        settings = self.webview.get_settings()
        settings.set_enable_developer_extras(False)
        settings.set_allow_file_access_from_file_urls(False)
        settings.set_allow_universal_access_from_file_urls(False)
        settings.set_javascript_can_open_windows_automatically(False)
        self.webview.set_background_color(Gdk.RGBA(0.067, 0.094, 0.086, 1))
        self.webview.connect('decide-policy', self._navigation)
        self.webview.connect('permission-request', lambda _, request: (request.deny(), True)[1])
        self.webview.connect('load-failed', self._load_failed)
        self.webview.connect('load-changed', self._load_changed)
        context.connect('download-started', lambda _, download: download.cancel())
        previous = self.stack.get_child_by_name('reader')
        if previous:
            self.stack.remove(previous)
        self.stack.add_named(self.webview, 'reader')
        self.webview.show()
        self.webview.load_uri(origin + '/')
        self._status('starting')
        return False

    def _navigation(self, _, decision, kind):
        if kind not in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION,
                        WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            return False
        action = decision.get_navigation_action()
        uri = action.get_request().get_uri()
        if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION and allowed_local_uri(uri, self.origin):
            return False
        decision.ignore()
        if action.is_user_gesture() and urlsplit(uri).scheme in ('https', 'http'):
            Gio.AppInfo.launch_default_for_uri(uri, None)
        return True

    def _load_changed(self, _, event):
        if event == WebKit2.LoadEvent.FINISHED and not self.failed:
            self.loaded = True
            self.stack.set_visible_child_name('reader')
            self._status('ready')
            if SMOKE:
                GLib.timeout_add(1500, self._smoke_check)

    def _load_failed(self, *_):
        self._reader_failed(self.reader)
        return True

    def _startup_timeout(self, reader):
        if reader is self.reader and not self.loaded and not self.failed:
            self._reader_failed(reader)
        return False

    def _reader_failed(self, reader):
        if self.shutting_down or reader is not self.reader:
            return False
        self.failed = True
        reader.stop()
        self.origin = None
        old = self.stack.get_child_by_name('error')
        if old:
            self.stack.remove(old)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        box.set_halign(Gtk.Align.CENTER)
        box.set_valign(Gtk.Align.CENTER)
        box.pack_start(Gtk.Label(label='Chưa mở được Andrew Brain.'), False, False, 0)
        box.pack_start(Gtk.Label(label='Thử mở lại ứng dụng để kết nối với ghi chú của bạn.'), False, False, 0)
        retry = Gtk.Button(label='Thử lại')
        retry.connect('clicked', lambda *_: self._start_reader())
        box.pack_start(retry, False, False, 0)
        self.stack.add_named(box, 'error')
        box.show_all()
        self.stack.set_visible_child_name('error')
        self._status('failed')
        return False

    def _status(self, state):
        if SMOKE:
            return
        self.runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
        data = {'pid': os.getpid(), 'applicationId': APP_ID, 'state': state,
                'readerPid': self.reader.process.pid if self.reader and self.reader.process else None,
                'origin': self.origin, 'sandboxEnabled': bool(self.webview and self.webview.get_context().get_sandbox_enabled())}
        path = self.runtime / 'desktop-status.json'
        path.write_text(json.dumps(data), encoding='utf-8')
        path.chmod(0o600)

    def _smoke_check(self):
        self.smoke_thinking_seen = False
        self.smoke_submitted = False
        self.webview.evaluate_javascript("document.querySelector('.wm-agent').click()", -1, None, None, None, None, None)
        GLib.timeout_add(200, self._smoke_chat)
        return False

    def _smoke_chat(self):
        script = "JSON.stringify({connected:document.body.innerText.includes('Đã đọc được phản hồi từ phiên Codex minh họa.'),thinking:!!document.querySelector('.wm-thinking'),reply:document.body.innerText.includes('Phản hồi WebKit đã nhận thành công.'),privateLeak:document.body.innerText.includes('SECRET_')})"
        def done(view, result, *_):
            try:
                data = json.loads(view.evaluate_javascript_finish(result).to_string())
                assert not data['privateLeak']
                self.smoke_thinking_seen = self.smoke_thinking_seen or data['thinking']
                if data['reply']:
                    assert self.smoke_thinking_seen
                    self._smoke_verify()
                    return
                if data['connected'] and not self.smoke_submitted:
                    self.smoke_submitted = True
                    send = "const field=document.querySelector('#wm-native-question');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Kiểm tra hội thoại trong WebKit');field.dispatchEvent(new Event('input',{bubbles:true}));setTimeout(()=>document.querySelector('.wm-native-chat .wm-compose-bottom button').click(),100);"
                    view.evaluate_javascript(send, -1, None, None, None, None, None)
                GLib.timeout_add(200, self._smoke_chat)
            except Exception as error:
                print(json.dumps({'desktopChatSmokeError': type(error).__name__}), flush=True)
                self.result = 1
                self.quit()
        self.webview.evaluate_javascript(script, -1, None, None, None, done, None)
        return False

    def _smoke_verify(self):
        script = "JSON.stringify({title:document.title,tasks:document.querySelectorAll('.wm-task').length,agents:document.querySelectorAll('.wm-agent').length,fixture:document.body.innerText.includes('Dữ liệu minh họa'),layout:!!document.querySelector('.wm-files')&&!!document.querySelector('.wm-chat'),nativeChat:document.body.innerText.includes('Phản hồi WebKit đã nhận thành công.'),sessionControls:document.querySelectorAll('.wm-codex-controls select').length===3,renameButton:!!document.querySelector('.wm-agent-edit'),contextMeter:document.querySelector('.wm-context-meter')?.textContent.includes('12.345'),overflow:document.documentElement.scrollWidth>innerWidth})"
        def done(view, result, *_):
            try:
                data = json.loads(view.evaluate_javascript_finish(result).to_string())
                data['sandboxEnabled'] = view.get_context().get_sandbox_enabled()
                assert data['fixture'] and data['tasks'] == 1 and data['agents'] == 1 and data['layout']
                assert data['sandboxEnabled'] and not data['overflow']
                assert data['nativeChat'] and self.smoke_thinking_seen
                assert data['sessionControls'] and data['renameButton'] and data['contextMeter']
                data['thinkingSeen'] = self.smoke_thinking_seen
                print(json.dumps({'desktopSmoke': data}), flush=True)
                view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE,
                                  None, self._smoke_snapshot)
            except Exception as error:
                print(json.dumps({'desktopSmokeError': type(error).__name__, 'observed': locals().get('data', {})}), flush=True)
                self.result = 1
                self.quit()
        self.webview.evaluate_javascript(script, -1, None, None, None, done, None)
        return False

    def _smoke_snapshot(self, view, result, *_):
        try:
            surface = view.get_snapshot_finish(result)
            folder = APP_ROOT / '.runtime/desktop-smoke'
            folder.mkdir(parents=True, exist_ok=True)
            surface.write_to_png(str(folder / 'native-window.png'))
            print(json.dumps({'snapshot': str(folder / 'native-window.png')}), flush=True)
        except Exception as error:
            print(json.dumps({'snapshotError': type(error).__name__}), flush=True)
            self.result = 1
        self.quit()

    def _smoke_timeout(self):
        self.result = 1
        print(json.dumps({'desktopSmokeError': 'timeout'}), flush=True)
        self.quit()
        return False

    def do_shutdown(self):
        self.shutting_down = True
        if self.reader:
            self.reader.stop()
        if not SMOKE and self.window is not None:
            self._status('closed')
        Gtk.Application.do_shutdown(self)


if __name__ == '__main__':
    app = BrainApplication()
    code = app.run([sys.argv[0]])
    raise SystemExit(app.result or code)
