import json, os, shutil, time
f = '/home/zyth/SillyTavern-Launcher/SillyTavern/data/default-user/chats/凛/抖m指挥官 - 2026-07-25@17h31m26s347ms imported - Branch #1.jsonl'
bak = f + '.bak-' + time.strftime('%Y%m%d-%H%M%S')
shutil.copy2(f, bak)
print('备份:', bak, os.path.getsize(bak)//1024//1024, 'MB')

lines = open(f, encoding='utf-8', errors='replace').read().splitlines()
removed = 0
removed_chars = 0
out = []
for ln in lines:
    try:
        m = json.loads(ln)
    except Exception as e:
        out.append(ln)
        continue
    v = m.get('variables')
    if isinstance(v, list):
        for item in v:
            if isinstance(item, dict):
                pt = item.get('post_process_tags')
                if isinstance(pt, dict) and 'npc_act' in pt:
                    removed_chars += len(json.dumps(pt['npc_act'], ensure_ascii=False))
                    del pt['npc_act']
                    removed += 1
    out.append(json.dumps(m, ensure_ascii=False, separators=(',', ':')))
tmp = f + '.tmp'
with open(tmp, 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(out))
    fh.write('\n')
os.replace(tmp, f)
print('移除 npc_act:', removed, '处 | 移除字符:', removed_chars)
print('新文件大小:', os.path.getsize(f)//1024//1024, 'MB')
print('行数:', len(out))
