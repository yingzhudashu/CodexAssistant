"""专用 emulator-5580 的合成界面验收；先启动 ui-server.ts 并配置连接。"""
import json, pathlib, time
import uiautomator2 as u2
out = pathlib.Path(__file__).resolve().parents[2] / 'artifacts/acceptance'
out.mkdir(parents=True, exist_ok=True)
d = u2.connect('emulator-5580')
report = {}
def click(text):
    assert d(text=text).wait(timeout=10), text
    d(text=text).click()
def contains(text):
    assert d(textContains=text).wait(timeout=10), text
try:
    assert d.app_current()['package'] == 'site.codexassistant'
    click('连接'); click('设置')
    d(className='android.widget.EditText').set_text('synthetic UI acceptance')
    if d.info.get('currentPackageName') != 'site.codexassistant': raise AssertionError('wrong application')
    d.press('back')
    if not d(text='提交全部回答').exists: d.swipe_ext('up', scale=.4)
    click('提交全部回答')
    assert d(text='选择本次验证范围').wait_gone(timeout=10)
    report['interaction'] = True
    click('回合摘要'); contains('合成验收摘要')
    click('复制摘要'); click('刷新摘要'); contains('合成验收摘要')
    report['detail'] = True
    click('发送消息')
    d(className='android.widget.EditText').set_text('synthetic-message')
    d.press('back')
    # 标签与按钮文字相同，按钮位于后一处。
    d(text='发送消息')[-1].click()
    contains('Codex Desktop 已接受消息')
    assert d(className='android.widget.EditText').get_text() == ''
    report['sendAccepted'] = True
    d(className='android.widget.EditText').set_text('retained-draft')
    d.press('back'); click('返回任务列表'); click('移动端验收任务')
    click('发送消息')
    assert d(className='android.widget.EditText').get_text() == 'retained-draft'
    click('清空草稿')
    assert d(className='android.widget.EditText').get_text() == ''
    report['draft'] = True
    d.screenshot(str(out/'android-message.png'))
    click('返回任务列表'); click('设置'); click('外观'); click('深色')
    assert d(text='深色').right(text='已应用').wait(timeout=5)
    time.sleep(.5)  # 等待Compose重组和系统栏绘制，截图不能取上一帧。
    d.screenshot(str(out/'android-settings-dark.png'))
    click('‹  返回设置'); click('任务')
    report['completed'] = True
finally:
    (out/'android-smoke.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
