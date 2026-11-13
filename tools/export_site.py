"""Export a reviewed public site from a frozen private checkpoint.

The private policy is deliberately kept outside the public repository. It must
explicitly approve each named person, image and document; new records default
to anonymised, new files default to excluded. No genealogy is inferred here.
"""
from __future__ import annotations
import argparse, copy, hashlib, html, json, re, stat
from pathlib import Path
from urllib.parse import urlsplit

DATA_RE = r'<script type="application/json" id="viewer-data">(.*?)</script>'
MASK = 'Сведения скрыты в публичной копии.'

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def safe_path(root, rel):
    assert rel and ':' not in rel and '\\' not in rel and not rel.startswith('/'), rel
    assert all(p not in {'.', '..'} for p in rel.split('/')), rel
    p = root / rel
    assert p.resolve().is_relative_to(root.resolve()), rel
    for node in [p, *p.parents]:
        if node.exists():
            s = node.lstat()
            assert not stat.S_ISLNK(s.st_mode) and not getattr(s,'st_file_attributes',0)&1024, node
    if p.is_file():
        assert p.stat().st_nlink == 1
    return p

def read_json(p):
    return json.loads(p.read_text('utf-8-sig'))

def ids(value):
    return set(filter(None, re.split(r'[;,]\s*', value or '')))

def safe_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).replace('&','\\u0026').replace('<','\\u003c').replace('>','\\u003e').replace('\u2028','\\u2028').replace('\u2029','\\u2029')

def extract(snapshot):
    frozen = read_json(snapshot/'snapshot-manifest.json')
    for name, entry in frozen['files'].items():
        assert sha(safe_path(snapshot,name).read_bytes()) == entry['sha256'], name
    raw = (snapshot/'viewer/index.html').read_bytes()
    assert sha(raw) == frozen['source_html_sha256']
    page = raw.decode('utf-8-sig')
    data = json.loads(re.search(DATA_RE,page,re.S)[1])
    assert data['meta']['build_id'] == frozen['source_build_id']
    return frozen,page,data

def run(snapshot, policy_path, out):
    snapshot=snapshot.resolve();out=out.resolve()
    assert not out.is_relative_to(snapshot) and not snapshot.is_relative_to(out)
    assert not out.exists() or not any(out.iterdir()), 'Use a fresh, empty output directory.'
    frozen,page,original=extract(snapshot)
    policy=read_json(policy_path)
    assert policy['source_build_id']==frozen['source_build_id'], 'Review the new snapshot before exporting.'
    assert policy['source_html_sha256']==frozen['source_html_sha256']
    data=copy.deepcopy(original)
    public=set(policy['public_person_ids'])
    all_ids={p['person_id'] for p in data['people']}
    assert public <= all_ids
    private=all_ids-public
    bad_patterns=[re.compile(p,re.I) for p in policy['private_text_patterns']]
    bad_patterns += [re.compile(r'(?:(?<![A-Za-z])[A-Za-z]:[/\\]|file:/|\\\\[A-Za-z]|Users[/\\]|AppData|localhost|127\.0\.0\.1)',re.I)]
    bad_patterns += [re.compile(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}')]

    def unsafe(value):
        return any(p.search(value or '') for p in bad_patterns)

    def clean(value):
        return MASK if unsafe(value) else value

    for p in data['people']:
        pid=p['person_id']
        if pid in private:
            keep={k:p[k] for k in ['person_id','source_artifact_ids','candidate_status']}
            p.clear();p.update(keep)
            p.update(preferred_label='Родственник · сведения скрыты', names_as_written='', normalized_name_variants='',
                     birth_estimate='Не опубликовано', death_estimate='Не опубликовано',living_status='Не опубликован',
                     places='',occupation_or_status='', notes=MASK,
                     merge_or_split_rationale='Запись сохранена отдельно. Публикация не устанавливает тождество.',_public_redacted=True)
        else:
            for k in ['notes','historical_jurisdictions','relatives_as_reported','confession_or_community_as_recorded']:
                p.pop(k,None)
            for k,v in list(p.items()):
                if isinstance(v,str):p[k]=clean(v)

    def protect(row, fields, affected):
        for k in fields:
            if k in row:row[k]=MASK if affected else clean(row[k])

    for c in data['claims']:
        affected=bool(ids(c['subject_person_ids'])&private) or bool(ids(c['artifact_ids'])&set(policy.get('private_artifact_ids',[])))
        protect(c,['claim_text','rationale'],affected)
        c.pop('next_action',None)
    for r in data['relationships']:
        protect(r,['rationale'],r['person_a_id'] in private or r['person_b_id'] in private)

    media={}
    media_info={}

    def publish_media(spec, category):
        src=spec['source'];raw=safe_path(snapshot,src).read_bytes()
        assert sha(raw)==frozen['files'][src]['sha256']
        ext=Path(src).suffix.lower()
        if 'crop' in spec:
            from PIL import Image
            import io
            im=Image.open(io.BytesIO(raw))
            box=spec['crop']
            assert len(box)==4 and 0<=box[0]<box[2]<=im.width and 0<=box[1]<box[3]<=im.height
            cropped=im.crop(box).convert('RGB');buf=io.BytesIO();cropped.save(buf,format='PNG')
            raw=buf.getvalue();ext='.png'
        else:
            from PIL import Image
            import io
            im=Image.open(io.BytesIO(raw))
            assert im.format in {'PNG','JPEG'}
            # Only files without embedded metadata were approved for byte copying.
            assert not im.getexif() and not any(k in im.info for k in ['exif','comment','XML:com.adobe.xmp']), src
        dest=f'tree-01/{category}/{sha(raw)[:20]}{ext}'
        media[dest]=raw
        info={'sha256':sha(raw),'bytes':len(raw),'source_sha256':frozen['files'][src]['sha256']}
        if 'crop' in spec:info['crop_pixels']=spec['crop']
        media_info[dest]=info
        return dest.removeprefix('tree-01/')

    preview_specs={x['source']:x for x in policy['previews']}
    doc_specs={x['source']:x for x in policy['documents']}
    for artifact_index,(a, source_a) in enumerate(zip(data['artifacts'],original['artifacts'])):
        affected=bool(ids(a['person_ids'])&private) or a['artifact_id'] in policy.get('private_artifact_ids',[])
        # Publication cards exclude correspondence, intake history, local paths,
        # unreviewed free text and original-file metadata.
        retained=['artifact_id','source_title','source_type','archival_reference','person_ids','summary',
                  'provenance_level','directness','originality','independence_group','legibility',
                  'related_claim_ids','reliability_notes','status']
        a={k:a[k] for k in retained}
        protect(a,['source_title','summary'],affected)
        if affected:a['source_title']='Источник '+a['artifact_id']+' · часть сведений скрыта'
        for k,v in list(a.items()):
            if isinstance(v,str):a[k]=clean(v)
        a.update(policy.get('artifact_overrides',{}).get(a['artifact_id'],{}))
        view=source_a.get('_view',{})
        pv=[]
        for p in view.get('previews',[]):
            if p['path'] not in preview_specs:continue
            spec=preview_specs[p['path']]
            newp={k:p[k] for k in ['kind','page','label','locator']}
            newp['path']=publish_media(spec,'assets')
            newp['locator']=spec.get('locator',re.sub(r'(?:originals|derivatives)/[^;]+','[файл локального снимка]',newp['locator']))
            newp['label']=spec.get('label',newp['label'])
            if 'crop' in spec:newp['kind']='crop'
            assert not unsafe(json.dumps(newp,ensure_ascii=False))
            pv.append(newp)
        v={'file_id':view.get('file_id',''),'pages':sorted({p['page'] for p in pv if p.get('page')}),
           'previews':pv,'locator_exact':bool(pv),'pdf':False,
           'withheld_reason':'Образ не опубликован: он не прошёл отбор для открытой версии или содержит сведения о других родственниках. Полная копия остаётся в частном деле.'}
        doc=doc_specs.get(view.get('original'))
        if doc:
            v['original']=publish_media(doc,'documents')
            v['original_name']=v['file_id']+Path(v['original']).suffix
        # Public links are explicit reviewed outbound destinations, never fetched.
        url=policy.get('public_urls',{}).get(a['artifact_id'])
        if url:
            assert urlsplit(url).scheme=='https' and not unsafe(url)
            v['public_url']=url
        a['_view']=v
        a['access_notes']=' · '.join(filter(None,[v['file_id'],a.get('archival_reference'), 'Выбраны только прошедшие проверку материалы.']))
        data['artifacts'][artifact_index]=a

    for q in data['questions']:
        affected=bool(ids(q['person_ids'])&private)
        keep={k:q[k] for k in ['issue_id','package_id','tree_id','person_ids','artifact_ids','claim_ids','question','status']}
        protect(keep,['question'],affected)
        q.clear();q.update(keep)
        if q['question']==MASK:q['question']='Вопрос '+q['issue_id']+': часть сведений скрыта в публичной копии.'
    data['packages']=[{'package_id':p['package_id']} for p in data['packages']]
    data['files']=[]
    data['meta']={k:original['meta'][k] for k in ['tree_id','display_name','built_at','timezone','fingerprint','counts','build_id','question_priority']}
    data['meta'].update(case_root_relative='./',warnings=[f'Обезличено записей: {len(private)}. Отсутствие имени не меняет исходный статус связи.',
        'Сканы семейной схемы и частные сведения о передаче материалов не опубликованы.'],public_export={'anonymised_people':len(private),'named_people':len(public)})
    assert len(data['people'])==len(original['people'])
    assert data['identities']==original['identities']
    for new,old in zip(data['relationships'],original['relationships']):
        assert all(new[k]==old[k] for k in old if k!='rationale')
    for new,old in zip(data['claims'],original['claims']):
        assert all(new[k]==old[k] for k in ['claim_id','subject_person_ids','artifact_ids','status','confidence','claim_type','contradicting_artifact_ids'])
    # Extract the actual frozen UI, not a potentially newer template.
    js=re.search(r'<script>(.*?)</script>',page,re.S)[1]
    css=re.search(r'<style>(.*?)</style>',page,re.S)[1]
    def replace_once(old,new):
        nonlocal js
        assert old in js, 'Frozen UI changed; review the adapter.'
        js=js.replace(old,new,1)
    replace_once("'Открыть исходный файл · '","'Открыть опубликованную копию · '")
    replace_once("$('image-error').hidden=!!p;", "$('image-error').hidden=true;")
    replace_once("const loc=element('p','tiny',(a._view?.file_id||'Локальный файл не зарегистрирован')+' · '+(a._view?.pages?.length?'Физические страницы PDF: '+a._view.pages.join(', '):'Изображение целиком'));meta.append(loc);",
                 "const available=!!a._view?.previews?.length;const loc=element('p','tiny',(a._view?.file_id||'Источник')+' · '+(!available?'Образ исключён из публичной копии':a._view?.pages?.length?'Выбранные физические страницы PDF: '+a._view.pages.join(', '):'Выбранное изображение или фрагмент'));meta.append(loc);for(const id of ['source-select','source-zoom-out','source-zoom-in','source-fit'])$(id).disabled=!available;")
    replace_once("if(!a._view?.locator_exact)meta.append", "if(a._view?.previews?.length&&!a._view?.locator_exact)meta.append")
    replace_once("if(!bio.length)box.append(element('p','muted','Отдельных биографических утверждений пока нет; поля записи сохраняют сведения исходного дерева.'));",
                 "if(!bio.length)box.append(element('p','muted',p._public_redacted?'Биографические сведения не опубликованы.':'Отдельных биографических утверждений пока нет; поля записи сохраняют сведения исходного дерева.'));")
    replace_once("if(!p){$('source-caption').textContent='Готового изображения нет; исходный файл не открывался автоматически.';return;}",
                 "if(!p){$('source-image').removeAttribute('src');$('source-caption').textContent=a._view.withheld_reason;return;}")
    replace_once(" · Вырезка; полное изображение доступно в списке."," · Выбранная вырезка; полный файл может быть исключён из публичной копии.")
    replace_once("Слева — все линии этого источника из реестра, справа — его исходная страница. Карандашные и обрезанные места сохранены как вопросы. Нажмите линию для её ID и основания.",
                 "Слева сохранены линии семейной схемы и их статусы. Её скан исключён из открытой копии, поскольку содержит сведения о младших поколениях. Нажмите линию, чтобы увидеть доступное основание.")
    begin=js.index("  $('about-button').addEventListener('click',()=>{")
    end=js.index("  $('close-about').addEventListener",begin)
    js=js[:begin]+"""  $('about-button').addEventListener('click',()=>{
    const box=$('about-content');box.replaceChildren();box.className='dialog-content';
    box.append(element('p','',`Общедоступная копия tree-01. Исходная сборка: ${D.meta.build_id}.`));
    box.append(element('p','','Имена и биографические поля части родственников скрыты. Это правило публикации; оно не утверждает, что человек жив или умер. Связи, статусы и версии тождества сохранены без слияния кандидатов.'));
    box.append(element('p','','Для исправления укажите ID человека, линии, утверждения или источника и его основание. Следующая публикация готовится из нового завершённого снимка по README репозитория.'));
    const link=element('a','','Порядок обновления и сведения о версии');link.href='../README.md';box.append(link);
    $('about-dialog').showModal();
  });
"""+js[end:]
    replace_once("$('package-label').textContent=D.packages.map(p=>p.package_id).join(' · ')||'Пакеты ещё не приняты';",
                 "$('package-label').textContent=D.meta.public_export.named_people+' открытых · '+D.meta.public_export.anonymised_people+' обезличены';")
    replace_once("'Сборка '+date", "'Данные от '+date")
    page=re.sub(r'<style>.*?</style>','<link rel="stylesheet" href="viewer.css">',page,count=1,flags=re.S)
    page=re.sub(r'<script>.*?</script>','<script src="viewer.js"></script>',page,count=1,flags=re.S)
    page=re.sub(DATA_RE,lambda _: '<script type="application/json" id="viewer-data">'+safe_json(data)+'</script>',page,count=1,flags=re.S)
    csp="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    page=re.sub(r'<meta http-equiv="Content-Security-Policy" content="[^"]*">',f'<meta http-equiv="Content-Security-Policy" content="{csp}">',page)
    page=page.replace('● Локальная копия','● Общедоступная копия')
    page=page.replace('<div class="brand-mark" aria-hidden="true">♧</div>','<a class="home-link" href="../" aria-label="На главную">♧<span>На главную</span></a>')
    page=page.replace('  <div class="app-nav">','  <p class="public-notice">Открытая версия: сведения о части родственников обезличены. Скан семейной схемы и частные документы исключены. <a href="../publication.json">Сведения о снимке</a></p>\n  <div class="app-nav">')
    page=page.replace('Как обновлять и исправлять','О версии и исправлениях').replace('Локальная страница дела','Общедоступная версия')
    page=page.replace('Реестры и отчёт доступны в каталоге дела.','Полные реестры и частные документы в открытый сайт не включены.')
    css+='\n.home-link{color:var(--green,#365345);text-decoration:none;display:flex;align-items:center;gap:9px;font-size:30px}.home-link span{font:12px system-ui}.public-notice{margin:0;padding:9px 25px;background:#f4eedf;color:#5a4c32;font-size:13px;line-height:1.5}.public-notice a{color:inherit}.source-caption{line-height:1.5}@media(max-width:700px){.public-notice{padding:8px 12px}.home-link span{display:none}}\n'
    release={
        'tree_id':'tree-01','display_name':'Куликов','exported_at':policy['exported_at'],
        'source_checkpoint':frozen['checkpoint'],'checkpoint_created_at':frozen['checkpoint_created_at'],
        'source_build_id':frozen['source_build_id'],'source_built_at':frozen['source_built_at'],
        'source_html_sha256':frozen['source_html_sha256'],'checkpoint_manifest_sha256':frozen['checkpoint_manifest_sha256'],
        'counts':data['meta']['counts'],'privacy':data['meta']['public_export'],
        'excluded':['Полные частные реестры, журналы, заметки и контрольные точки','Сканы семейной схемы и фотографии с неустановленными людьми','Частные сведения о передатчиках и авторах материалов','Не прошедшие проверку документы и встроенные данные','Все материалы tree-02'],
        'genealogy_changed':False,'identity_merges':False,'media':media_info}
    home=HOME.replace('@@DATE@@',html.escape(frozen['source_built_at'])).replace('@@BUILD@@',html.escape(frozen['source_build_id']))
    for token,table in [('@@PEOPLE@@','people'),('@@RELATIONSHIPS@@','relationships'),('@@IDENTITIES@@','identities')]:
        home=home.replace(token,str(len(data[table])))
    outputs={'index.html':home.encode(),'tree-01/index.html':page.encode(),'tree-01/viewer.js':js.encode(),
             'tree-01/viewer.css':css.encode(),'.nojekyll':b'',
             'publication.json':(json.dumps(release,ensure_ascii=False,indent=2)+'\n').encode(),**media}
    for name,raw in outputs.items():
        if name.endswith(('.html','.json','.js','.css')):
            assert not unsafe(raw.decode()), f'Private content or local path in {name}'
    out.mkdir(parents=True,exist_ok=True)
    for name,raw in outputs.items():
        dest=safe_path(out,name);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw)
        assert sha(dest.read_bytes())==sha(raw)
    manifest={'files':{name:{'sha256':sha(raw),'bytes':len(raw)} for name,raw in sorted(outputs.items())}}
    (out/'site-manifest.json').write_bytes((json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))
    print(json.dumps({'files':len(outputs)+1,'media':len(media),'named_people':len(public),'anonymised_people':len(private),
                      'counts':data['meta']['counts'],'source_build_id':frozen['source_build_id']},ensure_ascii=False,indent=2))

HOME='''<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="description" content="Семейная история Куликовых: карта связей, источники и открытые вопросы."><title>Семейная история · Куликов</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f6f3eb;color:#263c32;font:17px/1.7 Georgia,serif}main{max-width:1050px;margin:0 auto;padding:60px 28px}header{border-bottom:1px solid #c9cbbd;padding-bottom:36px}.eyebrow{font:12px system-ui;letter-spacing:.2em;text-transform:uppercase;color:#6c775f}h1{font-size:clamp(38px,7vw,76px);font-weight:400;line-height:1.1;max-width:750px;margin:25px 0}header p{max-width:630px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px;margin:38px 0}.card{background:#fffdf7;border:1px solid #c9cbbd;border-radius:14px;padding:30px}.card h2{font-size:33px;font-weight:400;margin:12px 0}.card p{font:15px/1.7 system-ui}.tag{font:12px system-ui;color:#71816c}.go{display:inline-block;background:#334e3e;color:white;border-radius:8px;padding:12px 20px;text-decoration:none;font:15px system-ui}.go:focus,.go:hover{background:#1f3529;outline-offset:4px}.future{background:transparent;color:#66715f}.notice{max-width:760px;font:14px/1.7 system-ui}footer{border-top:1px solid #c9cbbd;padding-top:20px;font:12px/1.8 system-ui;overflow-wrap:anywhere}a{color:inherit}</style></head>
<body><main><header><div class="eyebrow">Семейный архив · открытая версия</div><h1>Имена, связи<br>и их история.</h1><p>Карта семьи с документальными основаниями, разными версиями событий и вопросами, которые ещё остаются открытыми.</p></header>
<section class="cards" aria-label="Семейные деревья"><article class="card"><span class="tag">TREE-01 · ОПУБЛИКОВАНО</span><h2>Куликов</h2><p>Записей: @@PEOPLE@@ · родственных линий: @@RELATIONSHIPS@@ · версий тождества: @@IDENTITIES@@. Источники доступны рядом со схемой; сведения о части родственников скрыты.</p><a class="go" href="tree-01/">Открыть семейное дерево →</a></article><article class="card future"><span class="tag">ОТДЕЛЬНЫЙ РАЗДЕЛ · В БУДУЩЕМ</span><h2>Полянская</h2><p>Место для самостоятельного дерева. Его материалы ещё не опубликованы.</p></article></section>
<p class="notice">Пунктир обозначает гипотезу, а одна цепочка источников не означает независимого подтверждения. Кандидаты остаются раздельными. Обезличивание относится только к открытой версии и не меняет генеалогических выводов.</p>
<footer>Данные завершённой сборки от @@DATE@@ · <a href="publication.json">Источник снимка и состав публикации</a><br>Сборка @@BUILD@@<br><a href="https://github.com/kulikage/Kulikov_tree" rel="noopener noreferrer">Репозиторий и порядок обновления</a></footer></main></body></html>'''

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',type=Path,required=True)
    parser.add_argument('--policy',type=Path,required=True,help='Private reviewed policy outside the public repository.')
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();run(args.snapshot,args.policy,args.out)
