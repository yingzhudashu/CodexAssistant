"""Real UI/network acceptance on the dedicated emulator; requires network-recovery-server.ts."""
import json, os, pathlib, subprocess, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'artifacts/acceptance-2026-09-10/python-libs'))
import uiautomator2 as u2

ADB = str(pathlib.Path(os.environ['LOCALAPPDATA']) / 'Android/Sdk/platform-tools/adb.exe')
OUT = ROOT / 'artifacts/network-recovery'
OUT.mkdir(parents=True, exist_ok=True)
def adb(*args):
    return subprocess.check_output([ADB, '-s', 'emulator-5580', *args], timeout=25).decode().strip()
def metrics():
    with urllib.request.urlopen('http://127.0.0.1:33241/acceptance/network', timeout=2) as r:
        return json.load(r)
def until(predicate, seconds=5):
    start=time.monotonic()
    while time.monotonic()-start < seconds:
        if predicate(): return round((time.monotonic()-start)*1000)
        time.sleep(.1)
    raise AssertionError('condition timed out: '+str(metrics()))
def foreground():
    adb('shell','input','keyevent','KEYCODE_HOME')
    time.sleep(.5)
    adb('shell','am','start','-n','site.codexassistant/.MainActivity')

d=u2.connect('emulator-5580')
report={'completed':False,'foreground':[],'network':[],'limitations':['emulator only; no OEM/physical-device coverage']}
wifi=adb('shell','settings','get','global','wifi_on')
data=adb('shell','settings','get','global','mobile_data')
try:
    assert d.app_current()['package'] == 'site.codexassistant'
    baseline=metrics()
    for i in range(20):
        d.press('home');time.sleep(.5)
        before=metrics();start=time.monotonic();foreground()
        until(lambda:metrics()['active']==1 and d.app_current()['package']=='site.codexassistant')
        ms=round((time.monotonic()-start)*1000)
        assert ms<=5000,(i,ms)
        assert d.app_current()['package'] == 'site.codexassistant'
        after=metrics()
        report['foreground'].append({'iteration':i+1,'ms':ms,'active':after['active'],'connectionsDelta':after['connections']-before['connections'],'snapshotsDelta':after['snapshots']-before['snapshots']})
        print('foreground',i+1,ms,flush=True)
    for i in range(3):
        d.press('home')
        adb('shell','svc','wifi','disable');adb('shell','svc','data','disable')
        until(lambda:metrics()['active']==0,10)
        count=metrics()['snapshots'];start=time.monotonic()
        adb('shell','svc','wifi','enable')
        until(lambda:metrics()['snapshots']>count and metrics()['active']==1,10)
        ms=round((time.monotonic()-start)*1000)
        report['network'].append({'iteration':i+1,'msIncludingWifiAssociation':ms})
        foreground();assert d.app_current()['package'] == 'site.codexassistant'
        print('network',i+1,ms,flush=True)
    count=metrics()['snapshots']
    req=urllib.request.Request('http://127.0.0.1:33241/acceptance/disconnect',data=b'{}',headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req): pass
    report['serverCloseMs']=until(lambda:metrics()['snapshots']>count and metrics()['active']==1)
    assert d.app_current()['package'] == 'site.codexassistant'
    assert metrics()['writes']==baseline['writes']
    report['completed']=True;report['final']=metrics()
    d.screenshot(str(OUT/'recovered.png'))
finally:
    adb('shell','svc','wifi','enable' if wifi!='0' else 'disable')
    adb('shell','svc','data','enable' if data!='0' else 'disable')
    (OUT/'emulator-network.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False),flush=True)
