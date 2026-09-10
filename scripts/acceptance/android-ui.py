"""Operate only the isolated acceptance emulator through Android's UI hierarchy."""
import os, pathlib, re, subprocess, sys, xml.etree.ElementTree as ET

ADB = str(pathlib.Path(os.environ['LOCALAPPDATA']) / 'Android/Sdk/platform-tools/adb.exe')
ARTIFACT = pathlib.Path(__file__).resolve().parents[2] / 'artifacts/acceptance-2026-09-10'
def adb(*args):
    return subprocess.check_output([ADB, '-s', 'emulator-5580', *args], timeout=25)
def tree():
    adb('shell', 'uiautomator', 'dump', '/sdcard/acceptance.xml')
    return ET.fromstring(adb('shell', 'cat', '/sdcard/acceptance.xml'))
def tap(node):
    x1,y1,x2,y2=map(int,re.findall(r'\d+',node.attrib['bounds']))
    adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))

action=sys.argv[1]
if action=='dump':
    for node in tree().iter('node'):
        a=node.attrib
        if a.get('text') or a.get('content-desc') or a.get('class')=='android.widget.EditText':
            print({k:a.get(k) for k in ['text','content-desc','class','bounds','enabled','checked']})
elif action=='tap':
    label=sys.argv[2]
    candidates=[n for n in tree().iter('node') if n.get('text')==label or n.get('content-desc')==label]
    if not candidates: raise RuntimeError('Label is not visible: '+label)
    tap(candidates[-1])
elif action=='fill':
    nodes=[n for n in tree().iter('node') if n.get('class')=='android.widget.EditText']
    tap(nodes[int(sys.argv[2])])
    adb('shell','input','keycombination','KEYCODE_CTRL_LEFT','KEYCODE_A')
    adb('shell','input','text',sys.argv[3])
elif action=='screenshot':
    (ARTIFACT / (sys.argv[2]+'.png')).write_bytes(adb('exec-out','screencap','-p'))
elif action=='back': adb('shell','input','keyevent','KEYCODE_BACK')
else: raise RuntimeError('Unknown action')
