"""Verify a public export, optionally against its private snapshot and policy."""
import argparse, json, re
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote
from export_site import DATA_RE, sha, safe_path, extract

class Links(HTMLParser):
    def __init__(self):super().__init__();self.links=[]
    def handle_starttag(self,tag,attrs):
        for k,v in attrs:
            if k in {'href','src'} and v:self.links.append((tag,k,v))

def verify(root,snapshot=None,policy=None):
    root=root.resolve()
    manifest=json.loads((root/'site-manifest.json').read_text('utf-8'))['files']
    for rel,entry in manifest.items():
        raw=safe_path(root,rel).read_bytes()
        assert sha(raw)==entry['sha256'] and len(raw)==entry['bytes'],rel
    forbidden=[re.compile(r'(?<![A-Za-z])[A-Za-z]:[/\\]',re.I),re.compile(r'file:/|Users[/\\]|AppData|127\.0\.0\.1|localhost',re.I)]
    if policy:
        pol=json.loads(policy.read_text('utf-8-sig'))
        forbidden += [re.compile(p,re.I) for p in pol['private_text_patterns']]
    text_files=0;links=0;images=0
    for rel in manifest:
        p=safe_path(root,rel)
        if p.suffix in {'.html','.js','.css','.json'}:
            text=p.read_text('utf-8');text_files+=1
            assert not any(r.search(text) for r in forbidden),rel
            assert 'tree-02/' not in text,rel
            if p.suffix=='.html':
                parser=Links();parser.feed(text)
                for tag,key,url in parser.links:
                    parts=urlsplit(url)
                    if parts.scheme:
                        assert parts.scheme=='https'
                        # Only explicit hyperlinks may leave the site.
                        assert tag=='a' and key=='href'
                        continue
                    assert not url.startswith('/'),(rel,url)
                    local=(p.parent/unquote(parts.path)).resolve()
                    assert local.is_relative_to(root),(rel,url)
                    # Repository README is copied alongside the generated site.
                    if local.name!='README.md':assert local.exists(),(rel,url)
                    links+=1
        elif p.suffix.lower() in {'.png','.jpg','.jpeg'}:
            from PIL import Image
            with Image.open(p) as im:
                assert not im.getexif()
            with Image.open(p) as im:im.verify()
            images+=1
    page=(root/'tree-01/index.html').read_text('utf-8')
    d=json.loads(re.search(DATA_RE,page,re.S)[1])
    pids={p['person_id'] for p in d['people']};aids={a['artifact_id'] for a in d['artifacts']};cids={c['claim_id'] for c in d['claims']}
    def refs(value):return set(filter(None,re.split(r'[;,]\s*',value or '')))
    for r in d['relationships']:
        assert {r['person_a_id'],r['person_b_id']}<=pids
        assert refs(r['claim_ids'])<=cids
        assert refs(r['supporting_artifact_ids'])<=aids
    for c in d['claims']:
        assert refs(c['subject_person_ids'])<=pids and refs(c['artifact_ids'])<=aids
    for a in d['artifacts']:
        v=a['_view']
        for preview in v['previews']:
            assert safe_path(root/'tree-01',preview['path']).is_file()
        if v.get('original'):assert safe_path(root/'tree-01',v['original']).is_file()
    for table,key in [('people','person_id'),('relationships','relationship_id'),('claims','claim_id'),('artifacts','artifact_id')]:
        assert len(d[table])==len({r[key] for r in d[table]})
    if snapshot:
        frozen,_,source=extract(snapshot.resolve())
        for table,key in [('people','person_id'),('relationships','relationship_id'),('claims','claim_id'),('artifacts','artifact_id')]:
            assert [r[key] for r in d[table]]==[r[key] for r in source[table]]
        assert d['identities']==source['identities']
        for a,b in zip(d['relationships'],source['relationships']):
            assert all(a[k]==b[k] for k in b if k!='rationale')
        for a,b in zip(d['claims'],source['claims']):
            assert all(a[k]==b[k] for k in ['claim_id','subject_person_ids','claim_type','artifact_ids','status','confidence'])
        if policy:
            public=set(pol['public_person_ids'])
            for p in d['people']:
                if p['person_id'] not in public:
                    assert p['_public_redacted'] and p['preferred_label']=='Родственник · сведения скрыты'
                    assert not p['names_as_written'] and p['birth_estimate']=='Не опубликовано'
    result={'passed':True,'hashed_files':len(manifest),'text_files_scanned':text_files,'links':links,'images':images,
            'people':len(d['people']),'relationships':len(d['relationships']),'identities':len(d['identities']),
            'claims':len(d['claims']),'artifacts':len(d['artifacts']),'anonymised_people':sum(bool(p.get('_public_redacted')) for p in d['people'])}
    print(json.dumps(result,ensure_ascii=False,indent=2));return result

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--site',type=Path,required=True)
    p.add_argument('--snapshot',type=Path);p.add_argument('--policy',type=Path)
    a=p.parse_args();verify(a.site,a.snapshot,a.policy)
