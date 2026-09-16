"""Render a self-contained project frontend specification. Run in its own directory."""
from pathlib import Path
import json, html, re

HERE=Path(__file__).resolve().parent
SPEC=json.loads((HERE/'spec.json').read_text(encoding='utf-8'))
DOC=HERE.parent
ASSET=DOC/'design-assets'/'final'
ASSET.mkdir(parents=True,exist_ok=True)
T=SPEC['tokens']; NAME=SPEC['name']
def esc(s): return html.escape(str(s),quote=True)
def wrap(s,n=30):
    # Full-width CJK and Latin width-aware line breaks.
    out=[]; line=''; w=0
    for c in str(s):
        cw=1 if ord(c)>255 else .54
        if c=='\n' or w+cw>n:
            out.append(line); line=''; w=0
            if c=='\n': continue
        line+=c; w+=cw
    if line:out.append(line)
    return out
def text(x,y,s,size=16,color=None,width=None,bold=False):
    lines=wrap(s,width) if width else str(s).split('\n')
    return ''.join(f'<text x="{x}" y="{y+i*(size+8)}" font-size="{size}" fill="{color or T["text"]}" font-weight="{600 if bold else 400}">{esc(v)}</text>' for i,v in enumerate(lines))
def rect(x,y,w,h,fill=None,r=8,stroke=None):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill or T["surface"]}" stroke="{stroke or T["border"]}"/>'
def svg(w,h,body,title):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img"><title>{esc(title)}</title><style>text{{font-family:"Microsoft YaHei","Segoe UI",sans-serif}}</style>{rect(0,0,w,h,T["bg"],0)}{body}</svg>'
def save(name,content):
    (ASSET/name).write_text(content,encoding='utf-8',newline='\n'); return 'design-assets/final/'+name
def button(x,y,label,primary=False,w=None):
    w=w or max(112, min(330,len(label)*16+32))
    return rect(x,y,w,44,T['primary'] if primary else T['surface'],8)+text(x+16,y+28,label,14,'#FFFFFF' if primary else T['text']), w
def screen_art(s,platform):
    mobile=platform=='Android'; tablet=platform=='Tablet'
    native=mobile or tablet
    auth=s.get('template')=='auth'
    hide_nav=native and s.get('hide_primary_navigation',False)
    chat=s.get('template')=='chat'
    W,H=(390,844) if mobile else (1024,768) if tablet else (1440,900)
    chrome=24 if native else 32
    a=rect(0,0,W,chrome,T['surface'],0)
    if native:a+=text(20,17,'09:41',12)+text(W-92,17,'5G   100%',11)
    else:
        a+=text(16,22,NAME+('  —  Windows' if platform=='Windows' else '  —  浏览器 / PWA'),13)
        a+=text(W-118,23,'—    □    ×',17)
    navw=0 if mobile or auth or hide_nav else 80 if tablet else 240
    content_x=16 if mobile else navw+32
    content_w=W-content_x-(16 if mobile else 32)
    if auth and not mobile:content_x=(W-480)//2;content_w=480
    if not mobile and not auth and not hide_nav:
        a+=rect(0,chrome,navw,H-chrome,T['surface'],0)
        a+=text(18,chrome+36,NAME if not tablet else SPEC['short'],17,bold=True)
        visible_row=0
        for i,v in enumerate(SPEC['nav'][:9]):
            if v in SPEC.get('admin_nav',[]) and s['role']!='仅管理员':continue
            if not native and v in SPEC.get('desktop_hidden_nav',[]):continue
            y=chrome+76+visible_row*52
            visible_row+=1
            a+=rect(12,y,navw-24,44,T['selected'] if i==s.get('nav',0) else T['surface'],8)
            a+=text(24,y+28,v if not tablet else v[:2],15)
    heading=s['id']+' '+s['title']
    if mobile:
        parts=wrap(heading,15)
        heading=parts[0]+('…' if len(parts)>1 else '')
    a+=text(content_x,chrome+38,heading,20,bold=True)
    if len(s['actions'])>2:a+=text(W-42,chrome+37,'⋯',22,T['primary'])
    a+=text(content_x,chrome+68,s['subtitle'],13,T['muted'],width=24 if mobile else 65)
    y=chrome+112
    fields=[f for f in s['fields'] if platform in f.get('platforms',s['platforms']) and f.get('baseline',True)]
    if tablet:
        list_x=16 if hide_nav else 80
        a+=rect(list_x,chrome+88,320,H-chrome-106,T['surface'],0)
        a+=text(list_x+18,chrome+124,'已选记录',15,bold=True)
        a+=rect(list_x+16,chrome+142,288,92,T['selected'],8)
        a+=text(list_x+28,chrome+173,fields[0]['value'],14,width=18)
        content_x=list_x+344;content_w=W-content_x-24
    if chat:
        cw=min(content_w,800);cx=content_x+(content_w-cw)/2
        meta=[f for f in fields if f['kind'] not in ('message','textarea')][:2]
        for f in meta:
            a+=rect(cx,y,cw,46,T['surface'],8)
            a+=text(cx+12,y+28,f['label']+'：'+f['value'],13,width=22 if mobile else 57)
            y+=58
        q=next((f['value'] for f in fields if f['kind']=='textarea'),'')
        response=next((f['value'] for f in fields if f['kind']=='message'),'')
        if response:
            a+=rect(cx,y+20,cw,164,T['surface'],12)
            a+=text(cx+16,y+52,NAME,14,T['primary'],bold=True)
            a+=text(cx+16,y+84,response,16,width=19 if mobile else 40)
        else:
            a+=text(cx+16,y+80,'草稿尚未发送',20,bold=True)
            a+=text(cx+16,y+112,'确认输入后点击发送，不生成虚假回执。',14,T['muted'],width=22 if mobile else 50)
        # Composer is part of the conversation, anchored above actions.
        a+=rect(cx,H-(246 if mobile else 206),cw,80,T['surface'],12)
        a+=text(cx+14,H-(215 if mobile else 175),q or '输入消息…',14,T['text'] if q else T['muted'],width=22 if mobile else 55)
        fields=[]
    for i,f in enumerate(fields):
        h=126 if f['kind']=='textarea' else 78
        if y+h>(H-150): break
        a+=text(content_x,y+16,f['label'],13,T['muted'])
        fill=T['selected'] if f['kind'] in ('record','status','message') else T['surface']
        a+=rect(content_x,y+26,content_w,h-30,fill,8)
        suffix='  ▾' if f['kind']=='select' else ''
        val=f.get('platform_values',{}).get(platform,f['value'])+suffix
        lines=wrap(val,22 if mobile else 63)[:2 if f['kind']=='textarea' else 1]
        if len(wrap(val,22 if mobile else 63))>len(lines): lines[-1]=lines[-1].rstrip()+'…'
        a+=text(content_x+12,y+50,'\n'.join(lines),14)
        y+=h+10
    # Main actions in canonical order. Overflow opens a labelled sheet.
    ay=min(H-(132 if mobile else 92),y+32) if auth else H-(132 if mobile else 92)
    a+=rect(content_x-2,ay-10,content_w+4,72,T['bg'],0, T['bg'])
    bx=content_x
    for i,act in enumerate(s['actions'][:2]):
        label=act['label']
        b,bw=button(bx,ay,label,i==0,w=(content_w-12)//2 if mobile else min(260,len(label)*16+32))
        if bx+bw<=W-16:a+=b
        bx+=bw+12
    if len(s['actions'])>2 and not mobile:
        a+=text(bx+8,ay+28,'更多操作 ▾',14,T['primary'])
    if mobile and not auth and not hide_nav:
        a+=rect(0,H-72,W,56,T['surface'],0)
        nav=SPEC['mobile_nav']; nw=W/len(nav)
        for i,v in enumerate(nav):a+=text(i*nw+12,H-38,v,13,T['primary'] if i==s.get('mobile_nav_index',0) else T['muted'])
        a+=rect(145,H-9,100,4,T['text'],2,T['text'])
    elif native:a+=rect(W/2-50,H-9,100,4,T['text'],2,T['text'])
    else:a+=text(content_x,H-20,'设计基线 · 合成示例 · 表单与状态以本页规则为准',12,T['muted'])
    return save(s['id']+'-'+platform.lower()+'.svg',svg(W,H,a,s['title']+' / '+platform))
def action_art(s,i,ac):
    W=1440; H=610; b=text(32,40,s['id']+f'.I{i+1:02}  '+ac['label'],23,bold=True)
    b+=text(32,70,'动作状态图 · 完成与失败是互斥分支；本地动作不等待服务端；失败不是完成后的下一步',14,T['muted'])
    local=ac.get('execution')=='local'
    states=[('操作前',ac['pre'],ac['label']),('本地更新' if local else '执行中',ac['pending'],'立即更新' if local else '处理中…'),('完成分支',ac['success'],'完成后保留结果'),('不可执行' if local else '失败分支',ac['failure'],'保留输入 / 查看原因')]
    for j,(title,body,bt) in enumerate(states):
        x=32+j*350
        b+=rect(x,110,326,440,T['surface'],12)
        b+=rect(x,110,326,50,T['selected'],12)
        b+=text(x+16,143,title,18,bold=True)
        b+=text(x+16,192,s['title'],16,bold=True,width=17)
        f=s['fields'][0]
        b+=text(x+16,228,f['label'],12,T['muted'])
        b+=rect(x+16,242,294,48,T['bg'],8)
        b+=text(x+28,272,f['value'],13,width=19)
        b+=text(x+16,323,body,15,width=18)
        bb,_=button(x+16,482,bt,j==0,w=294);b+=bb
    b+=text(32,587,'返回/关闭：'+ac['back'],13,T['muted'],width=98)
    return save(s['id']+f'-i{i+1:02}.svg',svg(W,H,b,s['title']+' · '+ac['label']))

def system_art():
    # Android IME ownership: the measured input-to-keyboard gap is exactly 8dp.
    b=text(16,28,NAME+' · Android输入法',18,bold=True)
    b+=rect(16,65,358,105,T['surface'],12)+text(32,99,'当前会话',15,bold=True)+text(32,131,'键盘开启时保持会话与草稿。',15)
    b+=rect(16,474,358,118,T['surface'],12)+text(30,505,'正在编辑的消息…',15)
    bb,_=button(264,535,'发送',True,w=94);b+=bb
    b+=text(16,454,'输入框外底边 → 键盘顶部：8dp',13,T['primary'])
    b+=rect(0,600,390,244,'#E5E7EB',0)+text(16,630,'系统键盘区域（实际外观由OS决定）',14,'#17212B')
    for row,chars in enumerate(['QWERTYUIOP','ASDFGHJKL','ZXCVBNM']):
        x=(390-len(chars)*36)/2
        for i,c in enumerate(chars):
            b+=rect(x+i*36,651+row*44,32,38,'#FFFFFF',5,'#7B8A98')+text(x+i*36+10,676+row*44,c,14,'#17212B')
    b+=rect(116,794,158,34,'#FFFFFF',5,'#7B8A98')+text(174,817,'空格',12,'#17212B')
    ime=save('system-ime.svg',svg(390,844,b,'Android键盘与输入区间距规范'))
    b=text(32,40,NAME+' · 浅色与深色组件',24,bold=True)
    for i,dark in enumerate([False,True]):
        x=32+i*620;bg='#111820' if dark else T['bg'];surface='#1B2632' if dark else '#FFFFFF';fg='#F1F5F9' if dark else T['text'];muted='#BCC8D5' if dark else T['muted']
        b+=rect(x,80,588,570,bg,12)+text(x+24,126,'深色主题' if dark else '浅色主题',22,fg,bold=True)
        b+=rect(x+24,157,540,86,surface,8)+text(x+40,188,'标题 / 正文',18,fg)+text(x+40,220,'辅助信息保持足够对比度',14,muted)
        bb,_=button(x+24,273,'主操作',True,w=180);b+=bb
        b+=rect(x+224,273,180,44,surface,8)+text(x+240,301,'禁用操作',14,muted)
        b+=rect(x+24,350,540,68,surface,8,'#B42318')+text(x+40,378,'字段校验失败',15,fg)+text(x+40,402,'请输入符合规则的值',12,muted)
        b+=text(x+24,476,'✓ 完成   ! 等待确认   × 失败',18,fg)
        b+=text(x+24,527,'状态同时使用图形与文字，不依赖颜色。',14,muted,width=33)
    theme=save('system-components.svg',svg(1280,690,b,'深浅色组件与对比度'))
    return ime,theme


def confirmation_art():
    results=[]
    for mobile in [False,True]:
        W,H=(390,844) if mobile else (1440,900)
        b=text(16,24,NAME+(' · Android' if mobile else ' · Windows'),16,bold=True)
        if not mobile:b+=text(W-118,24,'—    □    ×',17)
        b+=text(16 if mobile else 272,94,'正在编辑 · 未保存修改',20,bold=True)
        b+=rect(16 if mobile else 272,130,358 if mobile else 880,160,T['surface'],12)
        b+=f'<rect x="0" y="32" width="{W}" height="{H-32}" fill="#17212B" opacity="0.40"/>'
        dw=358 if mobile else 480; x=(W-dw)/2; y=320 if mobile else 310
        b+=rect(x,y,dw,230,T['surface'],12)
        b+=text(x+24,y+44,'放弃未保存内容？',20,bold=True)
        b+=text(x+24,y+85,'离开后，本次未保存的修改将丢失。',16,width=18 if mobile else 26)
        bw=(dw-60)/2
        bb,_=button(x+24,y+157,'继续编辑',False,w=bw);b+=bb
        b+=f'<rect x="{x+20}" y="{y+153}" width="{bw+8}" height="52" fill="none" stroke="{T["primary"]}" stroke-width="2" rx="10"/>'
        bb,_=button(x+36+bw,y+157,'放弃并离开',True,w=bw);b+=bb
        b+=text(16 if mobile else 272,H-100,'默认焦点：继续编辑',15,bold=True)
        b+=text(16 if mobile else 272,H-70,'Esc / 返回 / 遮罩：继续编辑；确认后只丢弃本表单。',14,width=24 if mobile else 65)
        results.append(save('system-confirm-'+('android' if mobile else 'windows')+'.svg',svg(W,H,b,'G14 放弃修改确认层')))
    b=text(32,44,NAME+' · 请求状态与恢复入口',24,bold=True)
    entries=[
        ('无缓存 / 正在读取','显示骨架，不显示零值或暂无记录。','等待读取'),
        ('离线 / 有缓存','保留上次同步内容；本地操作仍可用。','编辑连接'),
        ('读取失败','显示持续错误区；重试原来的只读查询。','重试读取'),
        ('写入结果未确认','保留输入；查询原资源，不能自动重发。','查询状态'),
        ('认证错误','停止重试，修改正确凭据后再连接。','编辑连接'),
        ('工作站请求繁忙','控制路由已满，本次没有转发。','稍后重试')]
    for i,(title,body,label) in enumerate(entries):
        x=32+(i%3)*460;y=90+(i//3)*340
        b+=rect(x,y,436,310,T['surface'],12)
        b+=text(x+24,y+44,title,19,bold=True,width=22)
        b+=rect(x+24,y+80,388,80,T['selected'],8)
        b+=text(x+40,y+111,body,15,width=22)
        bb,_=button(x+24,y+222,label,i in (1,2,3,4),w=200);b+=bb
    b+=text(32,820,'这是六个独立分支，不是顺序流程；后续业务状态必须来自真实回执。',16,T['muted'])
    results.append(save('system-recovery.svg',svg(1440,860,b,'G01/G02/G07 请求恢复状态')))
    return results

def render():
    ime,theme=system_art()
    confirmations=confirmation_art()
    md=[f'# {NAME} 前端设计实施规格',SPEC['intro'],
        '> 本文由 spec.json 生成，描述当前工作树。SVG为可编辑结构示意，实际验收以运行截图和测试为准。',
        SPEC.get('revision',''),
        '[图文阅读版与界面索引](frontend-design/index.html) · [结构化界面规格](frontend-design/spec.json) · [审查与验收记录](acceptance.zh-CN.md)',
        '## 1. 权威顺序与实施范围',SPEC['scope'],
        '同一交付中：交互表和字段规则 > 几何规范 > SVG 示例值。示例值是合成测试数据，不是默认业务数据。业务状态只取服务端或本地桥接回执；画面不允许推断业务成功。若未来协议改变，必须升级本文件与 spec.json；不得让开发者自行猜测一个静默替代行为。',
        '## 2. 现状证据与设计差额',SPEC['findings'],
        '## 3. 视觉、布局与组件规范',SPEC['geometry'],
        '|Token|浅色值|用途|\n|---|---|---|'+''.join(f'\n|{k}|`{v}`|{k}|' for k,v in T.items()),
        f'![深浅色组件]({theme})',f'![Android输入法与输入框间距]({ime})',SPEC['global'],*[f'![系统确认与恢复示意]({f})' for f in confirmations], '## 4. 状态、数据与权限合同',SPEC['contracts'],
        '## 5. 页面注册表', '|ID|界面|设备|来源|\n|---|---|---|---|']
    for s in SPEC['screens']:
        md.append(f'|[{s["id"]}](#{s["id"].lower()})|{s["title"]}|{", ".join(s["platforms"])}|`{s["source"]}`|')
    gallery=[]
    for s in SPEC['screens']:
        lines=[f'<a id="{s["id"].lower()}"></a>',f'## {s["id"]} · {s["title"]}',
            f'**入口与返回**：{s["entry"]}',f'**角色/设备**：{s["role"]}；{", ".join(s["platforms"])}。',
            f'**导航归属**：{s["navigation"]}',f'**布局**：{s["layout"]}',f'**数据绑定**：`{s["source"]}`。{s["binding"]}',
            '|控件（从上到下）|类型|图中示例|校验/显示合同|\n|---|---|---|---|']
        for f in s['fields']: lines.append(f'|{f["label"]}|{f["kind"]}|{f["value"]}|{f["rule"]}|')
        lines+=['**页面规则**：'+s['rules'], '**空态/加载/错误**：'+s['states']]
        figs=[]
        for p in s['platforms']:
            fn=screen_art(s,p);lines.append(f'![{s["id"]} {p} 布局]({fn})');figs.append((p,'../'+fn))
        lines.append('### 交互合同与状态图')
        for i,ac in enumerate(s['actions']):
            aid=s['id']+f'.I{i+1:02}'
            lines+=[f'**{aid} — {ac["label"]}**', '|条目|精确定义|\n|---|---|',
              f'|触发与前置|{ac["pre"]}|',f'|执行类别|{ac["execution"]}（按G13解释）|',f'|事件/调用|`{ac["binding"]}`|',
              f'|处理中|{ac["pending"]}|',f'|成功|{ac["success"]}|',f'|失败/重试|{ac["failure"]}|',
              f'|返回/取消|{ac["back"]}|', f'|验收|{ac["test"]}|']
            fn=action_art(s,i,ac);lines.append(f'![{aid} 操作前、处理中、成功与失败]({fn})')
        lines+=['### 页面验收',s['acceptance']]
        lines=[line.replace('enable|disable|reject','enable / disable / reject').replace('accepted|rejected','accepted / rejected') for line in lines]
        md+=lines
        gallery.append((s,figs,lines))
    md+=['## 6. 平台与系统级行为',SPEC['platforms'],'## 7. 发布验收门槛',SPEC['acceptance'],
        '## 8. 维护方法',
        '所有源码路径相对于项目根目录。运行 `python docs/frontend-design/render.py` 重建图文，运行 `python docs/frontend-design/validate.py` 静态校验。需要Python 3标准库，不读取历史源码哈希或过程截图。实际视觉验收使用Electron和Android专用模拟器。',
        '逐页操作与协议同步修改，不在生成文档中手工追加旧版记录。']
    full=re.sub(r'(?m)(?<=\|)\n(?:[ \t]*\n)+(?=\|)', '\n', '\n\n'.join(md))
    (DOC/'frontend-design.zh-CN.md').write_text(full+'\n',encoding='utf-8',newline='\n')
    # Full markdown rendered with a bundled zero-dependency table/image renderer.
    def mdhtml(raw):
        out=[]; table=[]; code=False
        def inline(v):
            v=esc(v)
            v=re.sub(r'`([^`]+)`',r'<code>\1</code>',v)
            v=re.sub(r'\*\*([^*]+)\*\*',r'<strong>\1</strong>',v)
            v=re.sub(r'!\[([^]]*)\]\(([^)]+)\)',lambda m:f'<a href="{esc("../"+m[2])}"><img loading="lazy" src="{esc("../"+m[2])}" alt="{m[1]}"/></a>',v)
            v=re.sub(r'\[([^]]*)\]\(([^)]+)\)',lambda m:f'<a href="{esc(m[2] if m[2].startswith(("http","#")) else "../"+m[2])}">{m[1]}</a>',v)
            return v
        def flush():
            if table:
                out.append('<div class="table"><table>')
                for i,row in enumerate(table):
                    if re.fullmatch(r'[\s|:\-]+',row):continue
                    tag='th' if i==0 else 'td'
                    out.append('<tr>'+''.join(f'<{tag}>{inline(c.strip())}</{tag}>' for c in row.strip('|').split('|'))+'</tr>')
                out.append('</table></div>');table.clear()
        for l in raw.splitlines():
            if l.startswith('|'):table.append(l);continue
            flush()
            if l.startswith('<a id='):out.append(l);continue
            if l.startswith('#'):
                n=len(l)-len(l.lstrip('#'));out.append(f'<h{n}>{inline(l[n:].strip())}</h{n}>')
            elif l.strip():out.append('<p>'+inline(l)+'</p>')
        flush();return ''.join(out)
    nav=''.join(f'<a href="#{s["id"].lower()}">{s["id"]} {s["title"]}</a>' for s in SPEC['screens'])
    css=f'body{{margin:0;background:{T["bg"]};color:{T["text"]};font:16px/1.7 "Microsoft YaHei","Segoe UI",sans-serif}}aside{{position:fixed;width:244px;top:0;bottom:0;padding:24px 16px;overflow:auto;background:{T["surface"]}}}aside a{{display:block;padding:8px;font-size:13px}}main{{margin-left:280px;padding:32px;max-width:1440px}}a{{color:{T["primary"]}}}img{{max-width:100%;max-height:900px;display:block;margin:20px auto;background:white;border:1px solid {T["border"]}}}.table{{overflow:auto}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid {T["border"]};padding:12px;vertical-align:top;min-width:110px}}h2{{margin-top:70px;border-top:2px solid {T["border"]};padding-top:24px}}code{{word-break:break-word;background:{T["selected"]};padding:2px 5px}}@media(max-width:800px){{aside{{position:static;width:auto;max-height:230px}}main{{margin:0;padding:16px}}}}'
    (HERE/'index.html').write_text(f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{NAME}</title><style>{css}</style><aside><strong>{NAME}</strong><p>当前设计 · 界面索引</p>{nav}</aside><main>{mdhtml(full)}</main></html>',encoding='utf-8',newline='\n')
    print(NAME,len(SPEC['screens']),'screens',sum(len(s['actions']) for s in SPEC['screens']),'interactions',len(list(ASSET.glob('*.svg'))),'figures')
if __name__=='__main__':render()
