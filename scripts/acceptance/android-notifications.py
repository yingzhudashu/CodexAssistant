"""专用emulator-5580通知验收：使用合成任务，恢复电池/休眠设置，不操作真实设备。"""
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.request

ADB = str(pathlib.Path(os.environ['LOCALAPPDATA']) / 'Android/Sdk/platform-tools/adb.exe')
PACKAGE = 'site.codexassistant'
BASE = 'http://127.0.0.1:33241'
OUT = pathlib.Path(__file__).resolve().parents[2] / 'artifacts/acceptance/android-notifications.json'
LABELS = {'running': '进行中', 'completed': '已完成', 'needs_action': '待确认', 'failed': '失败'}

def shell(*args):
    return subprocess.check_output([ADB, '-s', 'emulator-5580', 'shell', *args], encoding='utf-8', errors='replace', timeout=15)

def api(path, data=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as result:
        return json.load(result)

def current_notifications():
    raw = shell('dumpsys', 'notification', '--noredact')
    active = re.split(r'\n  \S', raw.split('  Notification List:', 1)[1], maxsplit=1)[0]
    return [block for block in active.split('    NotificationRecord(') if 'pkg=' + PACKAGE in block]

def wait_notification(status, started, timeout=5):
    expected = f'android.title=String ({LABELS[status]} · 通知即时验收)'
    while time.monotonic() - started < timeout:
        if any('tag=notification-test ' in item and expected in item for item in current_notifications()):
            return round((time.monotonic() - started) * 1000)
        time.sleep(.1)
    raise AssertionError('Latest notification missing: ' + status)

def change(status, endpoint='/acceptance/state', timeout=5):
    started = time.monotonic()
    api(endpoint, {'status': status})
    return wait_notification(status, started, timeout)

report = {}
initial_whitelist = PACKAGE in shell('cmd', 'deviceidle', 'whitelist')
try:
    ready_deadline = time.monotonic() + 15
    while time.monotonic() < ready_deadline:
        service = shell('dumpsys', 'activity', 'services', PACKAGE)
        if ('isForeground=true' in service and 'types=0x40000000' in service and
                any('id=1001 ' in item and '已连接 ·' in item for item in current_notifications())):
            break
        time.sleep(.2)
    else:
        raise AssertionError('Persistent notification service or initial snapshot missing')
    shell('input', 'keyevent', 'KEYCODE_HOME')
    report['backgroundLatencyMs'] = []
    for index in range(12):
        status = ['needs_action', 'completed', 'failed', 'running'][index % 4]
        report['backgroundLatencyMs'].append(change(status))
        time.sleep(.35)
    assert max(report['backgroundLatencyMs']) < 2500
    report['reconnectLatencyMs'] = change('needs_action', '/acceptance/reconnect', timeout=6)
    assert report['reconnectLatencyMs'] < 5000
    for index in range(40):
        api('/acceptance/state', {'status': 'running' if index % 2 == 0 else 'completed'})
        time.sleep(.025)
    report['burstFinalLatencyMs'] = change('failed')
    assert report['burstFinalLatencyMs'] < 2500
    # 仅在隔离模拟器模拟用户授予豁免；finally恢复原配置。
    if not initial_whitelist:
        shell('cmd', 'deviceidle', 'whitelist', '+' + PACKAGE)
    shell('dumpsys', 'battery', 'unplug')
    shell('input', 'keyevent', 'KEYCODE_SLEEP')
    forced = shell('cmd', 'deviceidle', 'force-idle', 'deep')
    assert shell('cmd', 'deviceidle', 'get', 'deep').strip() == 'IDLE', forced
    report['dozeExemptLatencyMs'] = change('completed', timeout=8)
    assert report['dozeExemptLatencyMs'] < 5000
    shell('cmd', 'deviceidle', 'unforce')
    shell('input', 'keyevent', 'KEYCODE_WAKEUP')
    time.sleep(2)
    report['resumeLatencyMs'] = change('running')
    time.sleep(2)
    assert 'CodexAssistant:notification' not in shell('dumpsys', 'power').split('Wake Locks:')[-1].split('Suspend Blockers:')[0]
    report['wakeLockReleased'] = True
    report['traceDelivery'] = api('/acceptance/latency')
    assert report['traceDelivery']['count'] > 0, 'Notification delivery trace missing'
    report['connection'] = api('/acceptance/metrics')
    assert report['connection']['active'] == 1
    report['completed'] = True
finally:
    shell('cmd', 'deviceidle', 'unforce')
    shell('dumpsys', 'battery', 'reset')
    shell('input', 'keyevent', 'KEYCODE_WAKEUP')
    if not initial_whitelist:
        shell('cmd', 'deviceidle', 'whitelist', '-' + PACKAGE)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
