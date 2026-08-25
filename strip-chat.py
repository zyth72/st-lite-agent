import json, os, shutil, time
f = '/home/zyth/SillyTavern-Launcher/SillyTavern/data/default-user/chats/凛/抖m指挥官 - 2026-07-25@17h31m26s347ms imported - Branch #1.jsonl'
before = os.path.getsize(f)
bak = f + '.bak-' + time.strftime('%Y%m%d-%H%M%S')
shutil.copy2(f, bak)
print('备份:', os.path.basename(bak), '| 处理前:', before // 1024 // 1024, 'MB')

lines = open(f, encoding='utf-8', errors='replace').read().splitlines()

# 1) 找最近 5 条带思维链的 assistant 消息、最近 5 条带 anima_data 的消息
reasoning_idx = [i for i, ln in enumerate(lines) if not json.loads(ln).get('is_user') and isinstance(json.loads(ln).get('extra'), dict) and 'reasoning' in json.loads(ln)['extra']]
keep = set(reasoning_idx[-5:])
print('带思维链的消息:', len(reasoning_idx), '| 保留最近:', len(keep))
anima_idx = []
for i, ln in enumerate(lines):
    try:
        m = json.loads(ln)
    except Exception:
        continue
    v = m.get('variables')
    if isinstance(v, list) and any(isinstance(item, dict) and 'anima_data' in item for item in v):
        anima_idx.append(i)
keep_anima = set(anima_idx[-5:])
print('带 anima_data 的消息:', len(anima_idx), '| 保留最近:', len(keep_anima))

removed_npcact = removed_swipe = removed_reasoning = removed_anima = 0
out = []
for i, ln in enumerate(lines):
    try:
        m = json.loads(ln)
    except Exception:
        out.append(ln)
        continue
    # npc_act
    v = m.get('variables')
    if isinstance(v, list):
        for item in v:
            if isinstance(item, dict):
                pt = item.get('post_process_tags')
                if isinstance(pt, dict) and 'npc_act' in pt:
                    del pt['npc_act']
                    removed_npcact += 1
    # swipe_info 全清
    if 'swipe_info' in m:
        del m['swipe_info']
        removed_swipe += 1
    # swipes 正文副本与 swipe_id 全清(mes 已是唯一正文)
    if 'swipes' in m:
        del m['swipes']
        removed_swipe += 1
    if 'swipe_id' in m:
        del m['swipe_id']
    # anima_data 只留最近 5 条
    if isinstance(v, list):
        for item in v:
            if isinstance(item, dict) and 'anima_data' in item:
                if i not in keep_anima:
                    del item['anima_data']
                    removed_anima += 1
    # 思维链只留最近 5 条
    ex = m.get('extra')
    if isinstance(ex, dict) and 'reasoning' in ex:
        if i not in keep:
            del ex['reasoning']
            removed_reasoning += 1
        if not ex:
            del m['extra']
    out.append(json.dumps(m, ensure_ascii=False, separators=(',', ':')))

tmp = f + '.tmp'
with open(tmp, 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(out))
    fh.write('\n')
os.replace(tmp, f)
after = os.path.getsize(f)
print('移除: npc_act', removed_npcact, '处 | swipe_info', removed_swipe, '条 | reasoning', removed_reasoning, '条 | anima_data', removed_anima, '处')
print('处理后:', after // 1024 // 1024, 'MB | 行数:', len(out), '| 瘦身:', (before - after) // 1024 // 1024, 'MB')
