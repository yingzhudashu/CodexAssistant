"""指定 Android 模拟器的合成界面验收；需先启动 ui-server.ts。"""
import json, pathlib, time
import os
import uiautomator2 as u2
out = pathlib.Path(__file__).resolve().parents[2] / 'artifacts/acceptance'
out.mkdir(parents=True, exist_ok=True)
SERIAL = os.environ.get('ANDROID_SERIAL')
if not SERIAL:
    raise RuntimeError('Set ANDROID_SERIAL to the dedicated acceptance emulator.')
d = u2.connect(SERIAL)
report = {}

def dismiss_system_dialog():
    """专用 AVD 启动时偶发系统 UI 对话框；等待系统恢复后再验收。"""
    if d(text='Wait').exists:
        d(text='Wait').click()
        assert d(text='Wait').wait_gone(timeout=20), 'System UI did not recover'
    if d(text='Close app').exists:
        raise AssertionError('System UI is not responding; refusing to close it automatically')
def click(text):
    target = d(text=text)
    if not target.wait(timeout=5):
        # Compose 的无障碍节点在键盘收起/滚动后可能带有不可见的尾部节点；
        # 仅在唯一包含匹配时使用文本包含，避免点击同名的错误控件。
        target = d(textContains=text)
    assert target.wait(timeout=10), text
    assert target.count == 1, f'ambiguous accessibility label: {text}'
    target.click()

def click_occurrence(text, index):
    """点击同名控件中的指定项；用于详情页的标签、标题和提交按钮同名场景。"""
    target = d(text=text)
    if not target.wait(timeout=5):
        target = d(textContains=text)
    assert target.wait(timeout=10), text
    assert target.count > index, f'missing accessibility occurrence {index}: {text}'
    target[index].click()
def contains(text):
    assert d(textContains=text).wait(timeout=10), text

def scroll_to(text):
    """只滚动详情列表寻找控件，避免把页面级 Back 误用为收起输入法。"""
    target = d(textContains=text)
    if not target.wait(timeout=2):
        scroller = d(scrollable=True)[-1]
        assert scroller.exists, f'no scroll container for {text}'
        scroller.scroll.toEnd(max_swipes=20)
    assert target.wait(timeout=10), text
def edit_connection():
    """将当前应用指向本轮 UI 合成服务；兼容首次安装和已有配置。"""
    if d(text='继续编辑').exists:
        click('继续编辑')
    if d(text='首次连接').exists:
        return
    # 已有配置时，先从任务页进入设置，再进入连接诊断编辑页。
    if d(text='任务工作台').exists:
        click('设置')
    if d(textContains='连接与诊断').exists:
        d(textContains='连接与诊断').click()
    if d(text='编辑连接').exists:
        click('编辑连接')
    assert d(text='编辑连接').wait(timeout=10) or d(text='首次连接').wait(timeout=10)
def configure_connection():
    edit_connection()
    fields = d(className='android.widget.EditText')
    assert fields.exists, 'connection form fields'
    d(className='android.widget.EditText', instance=0).set_text('http://127.0.0.1:33241')
    d(className='android.widget.EditText', instance=1).set_text('synthetic-acceptance-token')
    click('保存并连接')
    assert d(text='任务工作台').wait(timeout=15)
try:
    dismiss_system_dialog()
    assert d.app_current()['package'] == 'site.codexassistant'
    configure_connection()
    # 服务首次同步后显示合成任务；点击任务卡进入详情页。
    contains('移动端验收任务')
    click('移动端验收任务')
    # 交互请求位于执行计划页；文本输入控件可能因列表滚动暂时不可见。
    d.swipe_ext('up', scale=.4)
    fields = d(className='android.widget.EditText')
    assert fields.exists, 'interaction form field'
    d(className='android.widget.EditText', instance=0).set_text('synthetic UI acceptance')
    if d.info.get('currentPackageName') != 'site.codexassistant': raise AssertionError('wrong application')
    # Back 在 IME 未显示时会按页面返回关闭详情；只在系统确实显示 IME 时收起键盘。
    ime = d.shell('dumpsys input_method').output
    if 'mInputShown=true' in ime or 'mShowRequested=true' in ime:
        d.press('back')
        assert d(text='移动端验收任务').wait(timeout=5), 'detail page closed while hiding IME'
    scroll_to('提交全部回答')
    click('提交全部回答')
    assert d(text='选择本次验证范围').wait_gone(timeout=10)
    report['interaction'] = True
    click('回合摘要'); click('刷新摘要'); scroll_to('合成验收摘要')
    click('复制摘要'); contains('合成验收摘要')
    report['detail'] = True
    # “发送消息”同时是标签、区块标题和提交按钮，按层级顺序选中标签。
    click_occurrence('发送消息', 0)
    fields = d(className='android.widget.EditText')
    assert fields.count >= 1, 'message composer field'
    message = fields[-1]
    message.set_text('synthetic-message')
    # 消息输入框位于详情滚动区域底部；按 Compose 可访问按钮的唯一文字匹配提交。
    # 页面顶部也有“发送消息”标签；先把详情滚动到编辑器底部，
    # 否则无障碍树会命中标题而不是实际发送按钮。先收起输入法，避免按钮被键盘遮挡。
    ime = d.shell('dumpsys input_method').output
    if 'mInputShown=true' in ime or 'mShowRequested=true' in ime:
        d.press('back')
        assert d(text='返回任务列表').wait(timeout=5), 'detail page closed while hiding IME'
    d(scrollable=True)[-1].scroll.toEnd(max_swipes=20)
    send_button = d(text='发送消息')[2]
    assert send_button.exists, 'message send action'
    send_button.click()
    scroll_to('Codex Desktop 已接受消息')
    assert d(className='android.widget.EditText')[-1].get_text() == ''
    report['sendAccepted'] = True
    d(className='android.widget.EditText')[-1].set_text('retained-draft')
    click('返回任务列表'); click('移动端验收任务')
    click_occurrence('发送消息', 0)
    assert d(className='android.widget.EditText')[-1].get_text() == 'retained-draft'
    click('清空草稿')
    assert d(className='android.widget.EditText')[-1].get_text() == ''
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
