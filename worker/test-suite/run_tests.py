import json, time, random, re, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

ENDPOINT = 'https://qiji-ai-customer-service.deerdick-tw.workers.dev/api/chat'
ORIGIN = 'https://qiji-skin.com'

data = json.load(open('questions.json', encoding='utf-8'))
singles = data['single']
multi_turns = data['multi_turn']

results = []

def call(session_id, message, history=None):
    body = {'sessionId': session_id, 'message': message}
    if history:
        body['history'] = history
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode('utf-8'),
        headers={'content-type': 'application/json', 'origin': ORIGIN, 'User-Agent': 'curl/8.5.0'},
        method='POST',
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            latency = time.time() - t0
            payload = json.loads(resp.read().decode('utf-8'))
            return {'ok': True, 'status': resp.status, 'latency': latency, **payload}
    except urllib.error.HTTPError as e:
        latency = time.time() - t0
        try:
            payload = json.loads(e.read().decode('utf-8'))
        except Exception:
            payload = {}
        return {'ok': False, 'status': e.code, 'latency': latency, 'error': str(e), **payload}
    except Exception as e:
        latency = time.time() - t0
        return {'ok': False, 'status': None, 'latency': latency, 'error': str(e)}

def run_single(idx_cat_q):
    idx, cat, q = idx_cat_q
    sid = f'autotest-{idx}-{random.randint(1000,9999)}'
    res = call(sid, q)
    res['category'] = cat
    res['question'] = q
    res['session_id'] = sid
    return res

out_f = open('results.jsonl', 'w', encoding='utf-8')

print(f'Running {len(singles)} single-turn tests...', flush=True)
with ThreadPoolExecutor(max_workers=4) as pool:
    futures = [pool.submit(run_single, (i, cat, q)) for i, (cat, q) in enumerate(singles)]
    done = 0
    for fut in as_completed(futures):
        r = fut.result()
        results.append(r)
        out_f.write(json.dumps(r, ensure_ascii=False) + '\n')
        out_f.flush()
        done += 1
        if done % 25 == 0:
            print(f'  {done}/{len(singles)} done', flush=True)

print('Running multi-turn sequences...', flush=True)
for seq_idx, seq in enumerate(multi_turns):
    sid = f'autotest-multiturn-{seq_idx}-{random.randint(1000,9999)}'
    history = []
    for turn_idx, msg in enumerate(seq):
        res = call(sid, msg, history=history)
        res['category'] = 'multi_turn'
        res['question'] = msg
        res['session_id'] = sid
        res['turn_index'] = turn_idx
        results.append(res)
        out_f.write(json.dumps(res, ensure_ascii=False) + '\n')
        out_f.flush()
        history.append({'role': 'user', 'content': msg})
        if res.get('ok'):
            history.append({'role': 'assistant', 'content': res.get('reply', ''), 'source': res.get('source')})
        time.sleep(0.3)

out_f.close()
print(f'Total requests: {len(results)}')
print('Saved to results.jsonl')
