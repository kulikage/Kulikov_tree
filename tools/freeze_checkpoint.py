"""Copy one completed tree-01 checkpoint to a NEW private folder outside Git."""
import argparse, csv, json, re
from datetime import datetime, timezone
from pathlib import Path
from export_site import sha, safe_path, DATA_RE

def freeze(case, checkpoint, out):
    case=case.resolve();out=out.resolve()
    assert case.name=='tree-01'
    assert not out.exists() and not out.is_relative_to(case)
    # Never place a private snapshot inside ANY Git checkout.
    assert not any((p/'.git').exists() for p in [out,*out.parents])
    cp=safe_path(case,checkpoint)
    marker_raw=safe_path(cp,'manifest.json').read_bytes();marker=json.loads(marker_raw)
    assert marker['tree_id']=='tree-01' and marker.get('build_id')
    blobs={};origins={}
    def add(rel,wanted,prefer_checkpoint=True):
        if rel in blobs:
            assert sha(blobs[rel])==wanted;return
        source=safe_path(cp,rel) if prefer_checkpoint else safe_path(case,rel)
        if not source.is_file():source=safe_path(case,rel)
        raw=source.read_bytes();assert sha(raw)==wanted,rel
        blobs[rel]=raw;origins[rel]=source.relative_to(case).as_posix()
    for rel,wanted in marker['sha256'].items():add(rel,wanted)
    bm=json.loads(blobs['viewer/build-manifest.json'])
    assert bm['build_id']==marker['build_id'] and sha(blobs['viewer/index.html'])==bm['html_sha256']
    data=json.loads(re.search(DATA_RE,blobs['viewer/index.html'].decode('utf-8-sig'),re.S)[1])
    assert data['meta']['build_id']==bm['build_id']
    for key,filename in [('people','person-register.csv'),('relationships','relationship-register.csv'),
                          ('claims','claims-register.csv'),('artifacts','artifact-register.csv'),('questions','intake/review-queue.csv')]:
        rows=list(csv.DictReader(blobs[filename].decode('utf-8-sig').splitlines()))
        assert rows==[{k:v for k,v in r.items() if not k.startswith('_')} for r in data[key]],filename
    for rel,wanted in data['meta']['inputs'].items():add(rel,wanted)
    for rel,wanted in bm['image_sha256'].items():add(rel,wanted,False)
    files=list(csv.DictReader(blobs['intake/file-manifest.csv'].decode('utf-8-sig').splitlines()))
    for f in files:add(f['original_relative_path'],f['sha256'],False)
    for a in data['artifacts']:
        v=a.get('_view',{})
        if v.get('original'):assert v['original'] in blobs
        assert all(p['path'] in blobs for p in v.get('previews',[]))
    # A concurrent writer cannot silently give us mixed versions.
    for rel,raw in blobs.items():assert sha(safe_path(case,origins[rel]).read_bytes())==sha(raw),rel
    assert safe_path(cp,'manifest.json').read_bytes()==marker_raw
    out.mkdir(parents=True)
    for rel,raw in blobs.items():
        dest=safe_path(out,rel);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw)
        assert sha(dest.read_bytes())==sha(raw)
    (out/'checkpoint-manifest.json').write_bytes(marker_raw)
    record={'tree_id':'tree-01','checkpoint':checkpoint,'checkpoint_created_at':marker['created_at'],
            'source_build_id':bm['build_id'],'source_built_at':bm['built_at'],
            'captured_at':datetime.now(timezone.utc).isoformat(),'checkpoint_manifest_sha256':sha(marker_raw),
            'source_html_sha256':bm['html_sha256'],'counts':bm['counts'],'originals_verified':len(files),
            'files':{rel:{'sha256':sha(raw),'bytes':len(raw),'source':origins[rel]} for rel,raw in blobs.items()}}
    (out/'snapshot-manifest.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'files':len(blobs),'source_build_id':bm['build_id'],'originals_verified':len(files)},ensure_ascii=False))

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--case',type=Path,required=True);p.add_argument('--checkpoint',required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();freeze(a.case,a.checkpoint,a.out)
