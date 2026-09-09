"""Run from any directory. Requires Python 3, playwright, Pillow, Microsoft Edge.
Validates the design artifacts only; it does not test the product implementation.
"""
from pathlib import Path
import hashlib, json, re, xml.etree.ElementTree as ET
from datetime import date
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw
from io import BytesIO

HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
SPEC=json.loads((HERE/'spec.json').read_text(encoding='utf-8'))
MD=ROOT/'docs/frontend-design.zh-CN.md'
ASSETS=ROOT/'docs/design-assets/final'
issues=[]
def issue(kind,detail): issues.append({'kind':kind,'detail':detail})

raw=MD.read_text(encoding='utf-8')
figures=sorted(ASSETS.glob('*.svg'))
ids={s['id'] for s in SPEC['screens']}
actions=[a for s in SPEC['screens'] for a in s['actions']]
for s in SPEC['screens']:
    if not (ROOT/s['source']).is_file():issue('source missing',s['source'])
    for platform in s['platforms']:
        if not (ASSETS/f'{s["id"]}-{platform.lower()}.svg').exists():issue('layout missing',s['id']+'/'+platform)
    for a in s['actions']:
        for key in ['id','pre','pending','success','failure','back','test','binding','execution']:
            if not a.get(key):issue('action contract missing',a.get('id',s['id'])+'/'+key)
        if a['execution'] not in ['local','system','read','write']:issue('action category',a['id'])
        if a['execution']=='local' and '只有真实回执' in a['test']:issue('local waits for server',a['id'])
        af=ASSETS/(a['id'].replace('.I','-i')+'.svg')
        if not af.exists():issue('action figure missing',a['id'])
if len({a['id'] for a in actions})!=len(actions):issue('duplicate action IDs','actions')
for ref in re.findall(r'\b'+SPEC['prefix']+r'-\d\d\b',raw):
    if ref not in ids:issue('invalid page reference',ref)
for href in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)',raw):
    if href.startswith(('http','#')):continue
    if not (MD.parent/href).is_file():issue('missing link',href)
for f in figures:
    if 'design-assets/final/'+f.name not in raw:issue('unreferenced figure',f.name)
    try:ET.parse(f)
    except Exception as e:issue('svg parse',f.name+':'+str(e))
if re.search(r'\|\n\s*\n\|',raw):issue('table split by blank line','Markdown')
for block in re.findall(r'(?m)^\|[^\n]*(?:\n\|[^\n]*)*',raw):
    rows=block.splitlines()
    if len(rows)<2:issue('single row table',rows[0][:80])
    elif len({len(r.split('|')) for r in rows})!=1:issue('table width mismatch',rows[0][:80])
baseline=json.loads((HERE/'source-baseline.json').read_text(encoding='utf-8'))
for p,h in baseline['working_tree_sha256'].items():
    if not (ROOT/p).is_file() or hashlib.sha256((ROOT/p).read_bytes()).hexdigest()!=h:issue('source changed since design baseline',p)

with sync_playwright() as pw:
    browser=pw.chromium.launch(channel='msedge',headless=True)
    page=browser.new_page(viewport={'width':1440,'height':940},device_scale_factor=1)
    for f in figures:
        page.goto(f.as_uri())
        overflow=page.evaluate('''() => {const s=document.documentElement,w=s.viewBox.baseVal.width,h=s.viewBox.baseVal.height;return [...document.querySelectorAll('text')].filter(t=>{const b=t.getBBox();return b.x<0||b.y<0||b.x+b.width>w+1||b.y+b.height>h+1}).map(t=>t.textContent)}''')
        if overflow:issue('text outside viewBox',{'file':f.name,'text':overflow})
    page.goto((HERE/'index.html').as_uri())
    page.evaluate("() => document.querySelectorAll('img').forEach(i=>i.loading='eager')")
    page.wait_for_function("() => [...document.querySelectorAll('img')].every(i=>i.complete)")
    failed=page.evaluate("() => [...document.querySelectorAll('img')].filter(i=>!i.naturalWidth).map(i=>i.src)")
    if failed:issue('HTML image load',failed)
    missing_anchors=page.evaluate("() => [...document.querySelectorAll('a[href^=\"#\"]')].map(a=>a.getAttribute('href').slice(1)).filter(id=>!document.getElementById(id))")
    if missing_anchors:issue('HTML anchors missing',missing_anchors)
    one_row=page.evaluate("() => [...document.querySelectorAll('table')].filter(t=>t.rows.length<2).length")
    if one_row:issue('HTML isolated table rows',one_row)
    pics=[]
    for i in [0,2,min(5,len(SPEC['screens'])-1),len(SPEC['screens'])//2,len(SPEC['screens'])-1]:
        s=SPEC['screens'][i];pics.append(ASSETS/f'{s["id"]}-{s["platforms"][0].lower()}.svg')
    pics.extend([ASSETS/'system-confirm-android.svg',ASSETS/'system-recovery.svg',ASSETS/f'{SPEC["screens"][2]["id"]}-i01.svg'])
    collage=Image.new('RGB',(1400,2200),'#E5E7EB')
    for i,f in enumerate(pics):
        page.goto(f.as_uri());im=Image.open(BytesIO(page.locator('svg').screenshot())).convert('RGB');im.thumbnail((660,500))
        x=(i%2)*700;y=(i//2)*550
        collage.paste(im,(x+(700-im.width)//2,y+30));ImageDraw.Draw(collage).text((x+10,y+8),f.name,fill='black')
    collage.save(HERE/'review-preview.png')
    browser.close()

report={'project':SPEC['name'],'screens':len(ids),'actions':len(actions),'figures':len(figures),'issues':issues,'image_load':'passed' if not failed else 'failed','validation_date':str(date.today()),'tool':'Microsoft Edge headless; Python Playwright; XML parser','semantic_checks':['source path existence and SHA-256 baseline','page and action IDs','all registered layout/action figures exist','no unreferenced final SVG','Markdown contiguous tables and column consistency','HTML table structure and anchors','local action completion semantics'],'limits':'Static design checks and visual sampling only; product implementation, device acceptance, every API branch and pixel equivalence are not certified.'}
(HERE/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False),flush=True)
raise SystemExit(1 if issues else 0)
