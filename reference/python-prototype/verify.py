import sqlite3,json,sys
o=sqlite3.connect(sys.argv[1]); t=sqlite3.connect(sys.argv[2])
def dump(c):
    return {tb:{str(k):v for k,v in c.execute(f"select id,value from {tb}").fetchall()} for (tb,) in c.execute("select name from sqlite_master where type='table'")}
A,B=dump(o),dump(t)
page=json.loads(B['pages']['20']); refs={v for r in page['controls'].values() for v in r.values()}
VARS={'sk_presses','sk_last','sk_iris','sk_focus',*[f'sk_enc{n}' for n in range(1,9)]}
for tb in A:
    for k in set(A[tb])|set(B[tb]):
        if A[tb].get(k)!=B[tb].get(k):
            ok=(tb=='pages' and k=='20') or (tb=='controls' and k in refs and k not in A[tb]) or (tb=='custom_variables' and k in VARS)
            if not ok: print('UNEXPECTED',tb,k)
assert all(r in B['controls'] for r in refs)
for v in B['controls'].values(): json.loads(v)
exp={(0,c) for c in range(0,11)}|{(0,16)}|{(1,c) for c in range(5,14)}|{(2,c) for c in range(4,17)}|{(3,3)}|{(3,c) for c in range(5,17)}
got={(int(r),int(c)) for r,cs in page['controls'].items() for c in cs}
print('positions match',exp==got,len(got), 'page id kept', page['id'])
def paths(o,p=''):
    s=set()
    if isinstance(o,dict):
        for k,v in o.items():
            kk='#' if k.isdigit() else k
            s.add(p+'/'+kk); s|=paths(v,p+'/'+kk)
    elif isinstance(o,list):
        for v in o: s|=paths(v,p+'[]')
    return s
ref=paths(json.loads(A['controls']['bank:EcAicmU5ReMbt07HSVKMT']))
fbref=paths(json.loads(A['controls']['bank:WH7Chi4rlLVcbpXKX0SxI'])['feedbacks'][0])
actref=set()
for v in A['controls'].values():
    d=json.loads(v)
    for st in d.get('steps',{}).values():
        for a in st['action_sets'].get('down') or []:
            if a.get('definitionId')=='custom_variable_set_value': actref|=paths(a)
bad=0
for r in sorted(refs):
    d=json.loads(B['controls'][r])
    diff={p for p in paths(d) if '/action_sets/' not in p and '/feedbacks' not in p}^{p for p in ref if '/action_sets/' not in p}
    if diff: bad+=1; print(r,'shape diff',diff)
    for st in d['steps'].values():
        for a in sum(st['action_sets'].values(),[]):
            if paths(a)-actref: bad+=1; print('action extra',paths(a)-actref)
    for f in d['feedbacks']:
        if paths(f)^fbref: bad+=1; print('feedback diff',paths(f)^fbref)
print('shape mismatches',bad)
cv=dict(B['custom_variables']); print({k:cv[k] for k in ['sk_presses','sk_last']})
