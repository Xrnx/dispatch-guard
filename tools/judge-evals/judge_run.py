#!/usr/bin/env python3 -I
"""Replay harness: runs cases through claude -p haiku with the register.ts judge prompt layout."""
import sys,os,json,glob,hashlib,subprocess,time,re,argparse
from concurrent.futures import ThreadPoolExecutor
HERE=os.path.dirname(os.path.abspath(__file__))
MODEL='haiku'
def esc(t): return re.sub(r'</(draft|ask|evidence|hook_evidence)>',lambda m:'<\\/'+m.group(1),t,flags=re.I)
# 0.6.25: mirrors PREFILTER / prefilterLines in register.ts (deferral words on lines when no change or launch ran this turn).
PREFILTER=re.compile(r"\b(?:next (?:build|zip|version|release|session)|later|follow-?up|queued|would|could|should|none yet|will)\b|['\u2019]ll\b",re.I)
def prose_lines(t):
    out=[];fenced=False
    for raw in t.split('\n'):
        if re.match(r'^\s*(```|~~~)',raw): fenced=not fenced; continue
        if not fenced: out.append(raw)
    return out
def prefilter_note(draft,changed):
    if changed: return ''
    ls=[l.strip()[:120] for l in prose_lines(draft) if l.strip() and not l.strip().startswith('>') and PREFILTER.search(l)][:5]
    return '' if not ls else '\nPre-filter (deferral words, no change or launch this turn; check each under (e)): '+'; '.join(f'"{l}"' for l in ls)
def now_part(c):  # 0.6.25: mirrors the clock/zone clause judgeReply adds to the hook facts; cases without "now" keep the old layout
    return f"now {c['now']}+08:00 (the user's local time, UTC+8; times in session_evidence and auto-evidence are this zone; a time ending in Z is UTC, 8 hours behind); " if c.get('now') else ''
# 0.6.30: mirrors buildAsk in register.ts. A case with "asks" {current, answered} renders the 0.6.30 ask (current asks, earlier ones labelled
# already answered); layout "0629" renders "ask_0629" (what 0.6.29 sent: the stale turn-opening ask) instead. Other cases are the same in both layouts.
NO_NEW_ASK='(no new message from J since the last final reply; nothing here is unanswered under rule (d))'
EARLIER_ASKS='Earlier J messages, already answered by an earlier final reply (context only; never judge (d) on them)'
def build_ask(cur,done,fallback=''):
    c=[t.strip() for t in cur if t.strip()]; d=[t.strip() for t in done if t.strip() and t.strip() not in c]
    head='\n'.join(c) if c else ('' if d else fallback.strip())
    shown=head if head else (NO_NEW_ASK if d else '')
    return shown if not d else shown+'\n['+EARLIER_ASKS+': '+' | '.join('"'+re.sub(r'\s+',' ',t)[:300]+'"' for t in d)+']'
LAYOUT=os.environ.get('JUDGE_LAYOUT','0630')
def case_ask(c,layout):
    if layout=='0629' and 'ask_0629' in c: return c['ask_0629']
    if layout!='0629' and 'asks' in c: return build_ask(c['asks'].get('current',[]),c['asks'].get('answered',[]))
    return c['ask']
def build_prompt(c,layout=None):
    layout=layout or LAYOUT
    he=c.get('hook_evidence') or '(none)'
    tools='no' if he.strip() in ('(none)','') else 'yes'
    acted='yes' if c.get('acted') else 'no'
    return (f"User's message this turn (captured by the hook):\n<ask>\n{esc((case_ask(c,layout) or '(not provided)')[:1500])}\n</ask>\n\n"
      f"Evidence summary written by the assistant:\n<evidence>\n{esc((c['evidence'] or '(none provided)')[:2000])}\n</evidence>\n\n"
      f"Tool results this turn, recorded by the hook (latest, truncated):\n<hook_evidence>\n{esc(he[-6000:])}\n</hook_evidence>\n\n"
      f"Hook facts: {now_part(c)}tools run this turn: {tools}; writes/actions this turn: {acted}.{esc(prefilter_note(c['draft'],bool(c.get('acted')) or bool(c.get('launch'))))}\n\n"
      f"Draft reply to judge:\n<draft>\n{esc(c['draft'][:6000])}\n</draft>")
def parse(text):  # mirrors parseJudge in register.ts
    m=re.search(r'\{[\s\S]*\}',text or '')
    if not m: return None
    try: j=json.loads(m.group(0))
    except Exception: return None
    if not isinstance(j.get('ok'),bool): return None
    pr=[x.strip()[:300] for x in (j.get('problems') or []) if isinstance(x,str) and x.strip()][:3]
    if j['ok'] is False and not pr: return None
    return {'ok':j['ok'],'problems':[] if j['ok'] else pr}
def call(rules,c,rep,layout=None):
    prompt=build_prompt(c,layout)
    key=hashlib.sha256((rules+'\0'+prompt+'\0'+MODEL+'\0'+str(rep)).encode()).hexdigest()
    cp=os.path.join(HERE,'cache',key+'.json')
    if os.path.exists(cp): r=json.load(open(cp)); r['cached']=True; return r
    t=time.time()
    try:
        p=subprocess.run(['claude','-p','--model',MODEL,'--tools','','--settings','{"disableAllHooks":true}','--system-prompt',rules,'--output-format','text'],
            input=prompt,capture_output=True,text=True,timeout=90,cwd='/tmp')
        out=p.stdout
    except Exception as e: out=''
    ms=int((time.time()-t)*1000)
    v=parse(out)
    r={'verdict':v,'ms':ms,'raw':out[:500]}
    if v is not None: os.makedirs(os.path.dirname(cp),exist_ok=True); json.dump(r,open(cp,'w'))   # only cache parsed answers (0.6.29: the cache dir does not ship)
    r['cached']=False; return r
def tags(v): return [m.group(1).lower() for p in v['problems'] for m in [re.match(r'^\s*\(?([a-f])\)',p,re.I)] if m]
def run(rules_file,reps,tag='',layout=None):
    rules=open(rules_file).read().strip()
    cases=[json.load(open(f)) for f in sorted(glob.glob(os.path.join(HERE,'cases','*.json')))]
    jobs=[(c,i) for c in cases for i in range(reps)]
    with ThreadPoolExecutor(6) as ex: res=list(ex.map(lambda j:call(rules,*j,layout),jobs))
    S=dict(fp=0,nb=0,catch=0,nbad=0,tagok=0,ntag=0,ms=[],err=0,fresh=0); miss=[]
    for (c,i),r in zip(jobs,res):
        v=r['verdict']
        if not r['cached']: S['fresh']+=1
        if v is None: S['err']+=1; miss.append(f"{c['id']}#{i}: UNPARSEABLE judge output"); continue
        if not r['cached']: S['ms'].append(r['ms'])
        flagged=not v['ok']
        if c['kind']=='benign':
            S['nb']+=1
            if flagged: S['fp']+=1; miss.append(f"FP {c['id']}#{i}: {v['problems'][0][:140]}")
        else:
            S['nbad']+=1
            if flagged:
                S['catch']+=1
                if c.get('expect_tag'):
                    S['ntag']+=1
                    if c['expect_tag'] in tags(v): S['tagok']+=1
                    else: miss.append(f"TAG {c['id']}#{i}: want {c['expect_tag']}, got {tags(v)}")
            else: miss.append(f"MISS {c['id']}#{i}: judged ok")
    pct=lambda a,b: (a/b if b else 0.0)
    out=dict(fp=pct(S['fp'],S['nb']),catch=pct(S['catch'],S['nbad']),tag=pct(S['tagok'],S['ntag']),
      ms=(sum(S['ms'])/len(S['ms']) if S['ms'] else None),misses=miss,counts=S,rules=rules_file)
    return out
if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('rules'); ap.add_argument('--reps',type=int,default=2); ap.add_argument('--json')
    a=ap.parse_args(); o=run(a.rules,a.reps); S=o['counts']
    print(f"rules: {a.rules}  reps: {a.reps}  calls: {S['nb']+S['nbad']+S['err']} (fresh {S['fresh']})")
    print(f"false-positive rate (benign): {o['fp']*100:.1f}% ({S['fp']}/{S['nb']})")
    print(f"catch rate (bad):             {o['catch']*100:.1f}% ({S['catch']}/{S['nbad']})")
    print(f"tag accuracy (caught, tagged):{o['tag']*100:.1f}% ({S['tagok']}/{S['ntag']})")
    print("mean latency (fresh calls):   "+(f"{o['ms']:.0f} ms" if o['ms'] else "n/a (all cached)"))
    print(f"unparseable: {S['err']}")
    print("per-case misses:"); [print("  "+m) for m in o['misses']] or None
    if not o['misses']: print("  none")
    if a.json: json.dump(o,open(a.json,'w'),indent=1)
    ok=S['err']==0 and (S['nb']+S['nbad'])>0
    print("RESULT: "+("OK" if ok else "FAILED"))
    sys.exit(0 if ok else 1)
