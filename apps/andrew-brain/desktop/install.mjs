#!/usr/bin/env node
// User-local desktop installation. Copies the app, never the personal vault.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const appRoot=fileURLToPath(new URL('../',import.meta.url));
const home=os.homedir();
const installed=path.join(home,'.local/opt/andrew-brain');
const applications=path.join(home,'.local/share/applications');
const iconDir=path.join(home,'.local/share/icons/hicolor/scalable/apps');
const id='com.ankenry.AndrewBrain';
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',...options});

run('/usr/bin/python3',['-c',"import gi; gi.require_version('Gtk','3.0'); gi.require_version('WebKit2','4.1'); from gi.repository import Gtk, WebKit2"]);
run('/usr/bin/node',['--version']);
run('npm',['run','build'],{cwd:appRoot,stdio:'inherit'});
const desktop=run('xdg-user-dir',['DESKTOP']).trim();
if(!path.isAbsolute(desktop)||desktop===home)throw new Error('Desktop directory is not configured.');
for(const folder of [installed,applications,iconDir,desktop,path.join(installed,'desktop'),path.join(installed,'node_modules')])
  await fs.mkdir(folder,{recursive:true});
for(const name of ['dist','server'])await fs.cp(path.join(appRoot,name),path.join(installed,name),{recursive:true});
await fs.copyFile(path.join(appRoot,'package.json'),path.join(installed,'package.json'));
await fs.cp(path.join(appRoot,'node_modules/yaml'),path.join(installed,'node_modules/yaml'),{recursive:true});
for(const name of ['andrew_brain.py','server.mjs','icon.svg'])
  await fs.copyFile(path.join(appRoot,'desktop',name),path.join(installed,'desktop',name));
const workspaceRoot=path.resolve(appRoot,'../..');let worktreeId=null;
try{const data=JSON.parse(run(path.join(home,'.config/orca/linux-orca-cli-shim/orca'),['worktree','current','--json'],{cwd:workspaceRoot}));if(data.ok&&data.result?.worktree?.path===workspaceRoot)worktreeId=data.result.worktree.id;}catch{}
await fs.writeFile(path.join(installed,'desktop/workspace.json'),JSON.stringify({workspaceRoot,worktreeId}),{mode:0o600});
await fs.copyFile(path.join(appRoot,'desktop/icon.svg'),path.join(iconDir,id+'.svg'));
const quote=value=>'"'+value.replace(/[\\"`$]/g,'\\$&')+'"';
const entry=['[Desktop Entry]','Version=1.0','Type=Application','Name=Andrew Brain',
  'Comment=Đọc và tìm ghi chú trong Second Brain cá nhân',
  'Exec='+quote('/usr/bin/python3')+' '+quote(path.join(installed,'desktop/andrew_brain.py')),
  'TryExec=/usr/bin/python3','Icon='+path.join(installed,'desktop/icon.svg'),
  'Terminal=false','StartupNotify=true','StartupWMClass='+id,
  'Categories=Office;Utility;','Keywords=notes;brain;knowledge;ghi chú;',''].join('\n');
const menuFile=path.join(applications,id+'.desktop');
const desktopFile=path.join(desktop,id+'.desktop');
await fs.writeFile(menuFile,entry,{mode:0o644});
run('desktop-file-validate',[menuFile]);
await fs.writeFile(desktopFile,entry,{mode:0o755});
await fs.chmod(desktopFile,0o755);
run('gio',['set',desktopFile,'metadata::trusted','true']);
run('gio',['set',desktopFile,'metadata::nautilus-icon-position','26,105']);
run('gio',['set',desktopFile,'metadata::nautilus-drop-position','26,105']);
const metadata=run('gio',['info','-a','metadata::trusted,metadata::nautilus-icon-position,metadata::nautilus-drop-position',desktopFile]);
try{run('update-desktop-database',[applications]);}catch{}
const receipt={installedAt:new Date().toISOString(),installed,desktopFile,menuFile,
  desktopPosition:'26,105',desktopMetadata:metadata,personalVaultCopied:false};
await fs.mkdir(path.join(appRoot,'.runtime'),{recursive:true,mode:0o700});
await fs.writeFile(path.join(appRoot,'.runtime/desktop-install.json'),JSON.stringify(receipt,null,2),{mode:0o600});
console.log(JSON.stringify(receipt,null,2));
