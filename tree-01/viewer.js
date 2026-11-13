(() => {
  'use strict';
  const D = JSON.parse(document.getElementById('viewer-data').textContent);
  const $ = id => document.getElementById(id);
  const list = value => (value || '').split(/[;,]/).map(x => x.trim()).filter(Boolean);
  const people = new Map(D.people.map(p => [p.person_id, p]));
  const claims = new Map(D.claims.map(c => [c.claim_id, c]));
  const artifacts = new Map(D.artifacts.map(a => [a.artifact_id, a]));
  const relations = new Map(D.relationships.map(r => [r.relationship_id, r]));
  const identities = new Map(D.identities.map(e => [e.claim_id, e]));
  const issues = new Map(D.questions.map(q => [q.issue_id, q]));
  const openQuestions = D.questions.filter(q => !/^(resolved|closed)/.test(q.status));
  const isParent = r => /^(parent-child|parent_child|parent)$/i.test(r.relationship_type);
  const isSpouse = r => /^(spouse|spouses|partner)$/i.test(r.relationship_type);
  const isSibling = r => /^(sibling|siblings)$/i.test(r.relationship_type);
  const isTree = p => list(p.source_artifact_ids).some(id => artifacts.get(id)?.source_type === 'user-tree');
  const isFamilyStory = p => list(p.source_artifact_ids).some(id => artifacts.get(id)?.source_type === 'family-story');
  const statusClass = status => status === 'hypothesis' ? 'hypothesis' : /corroborated/.test(status) ? 'confirmed' : /unresolved|contradicted/.test(status) ? 'question' : 'single';
  const statusText = status => ({'single-source':'Указано в одном источнике',hypothesis:'Семейная схема / гипотеза',corroborated:'Подтверждено независимыми источниками','strongly-corroborated':'Подтверждено несколькими независимыми цепочками',unresolved:'Есть вопрос — пока не установлено',contradicted:'Есть противоречащее свидетельство'}[status] || 'Статус не указан');
  const shortStatus = status => ({'single-source':'1 ист.',hypothesis:'схема ?',corroborated:'незав. ист.','strongly-corroborated':'незав. ист.',unresolved:'вопрос !',contradicted:'конфликт !'}[status] || '?');
  const relationText = r => isParent(r) ? 'Родитель → ребёнок' : isSpouse(r) ? 'Супруги' : isSibling(r) ? 'Брат / сестра' : r.relationship_type;
  const state = {mode:'tree', selectedPerson:null, selectedRelation:null, selectedIdentity:null, allowed:null, nodes:new Map(), groups:[], edges:[], scale:1, x:0, y:0, source:null, imageIndex:0, imageScale:1, imageX:0, imageY:0, lastGroup:null};
  const rootURL = new URL(D.meta.case_root_relative, location.href);

  function element(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = String(text);
    return e;
  }
  function svg(tag, attrs = {}, text) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k,v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = String(text);
    return e;
  }
  function button(text, fn, cls='') {
    const e = element('button',cls,text); e.type='button'; e.addEventListener('click',fn); return e;
  }
  function pathURL(relative, fragment='') {
    if (!relative || relative.includes(':') || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(p => p === '..' || p === '.')) throw new Error('Недопустимый локальный ресурс');
    const url = new URL(relative.split('/').map(encodeURIComponent).join('/'), rootURL);
    if (!url.href.startsWith(rootURL.href)) throw new Error('Ресурс за пределами дела');
    if (fragment) url.hash = fragment;
    return url.href;
  }
  function localLink(relative, text, fragment='') {
    const a=element('a','',text); a.href=pathURL(relative,fragment); a.target='_blank'; a.rel='noopener noreferrer'; return a;
  }
  function badge(status) { return element('span','badge '+statusClass(status),statusText(status)); }
  function heading(text) { return element('h3','',text); }
  function field(container,label,value) {
    if (!value) return;
    const dl=element('dl','field'); dl.append(element('dt','',label),element('dd','',value)); container.append(dl);
  }
  function announce(text) { $('live-status').textContent=text; }
  function personsForClaim(c) { return list(c.subject_person_ids).map(id => people.get(id)).filter(Boolean); }
  function claimsForPerson(id) { return D.claims.filter(c => list(c.subject_person_ids).includes(id)); }
  function questionsForPerson(id) {
    const claimIds=new Set(claimsForPerson(id).map(c=>c.claim_id));
    return openQuestions.filter(q => list(q.person_ids).includes(id) || list(q.claim_ids).some(c=>claimIds.has(c)));
  }
  function activate(e,fn) {
    e.setAttribute('tabindex','0'); e.setAttribute('role','button');
    e.addEventListener('click',event=>{event.stopPropagation();fn();});
    e.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();fn();}});
  }

  // Kinship components ignore possible identities. Equal-generation constraints
  // come only from recorded spouses/siblings; parentage alone defines depth.
  class UnionFind {
    constructor(ids) { this.p=new Map(ids.map(x=>[x,x])); }
    find(a) { let b=a; while(this.p.get(b)!==b)b=this.p.get(b); while(a!==b){const n=this.p.get(a);this.p.set(a,b);a=n;}return b; }
    join(a,b) { const aa=this.find(a),bb=this.find(b);if(aa!==bb)this.p.set(bb,aa); }
  }
  function makeLayout(ids, rels) {
    const components=new UnionFind(ids);
    for(const r of rels)components.join(r.person_a_id,r.person_b_id);
    const sets=new Map();
    for(const id of ids){const root=components.find(id);if(!sets.has(root))sets.set(root,[]);sets.get(root).push(id);}
    const groups=[];
    const W=246,H=164,SIB_GAP=82,UNIT_GAP=42,ROW_GAP=126,PAD=45,HEAD=92;
    const errors=[];
    for(const members of sets.values()) {
      const memberSet=new Set(members);
      const rs=rels.filter(r=>memberSet.has(r.person_a_id));
      const same=new UnionFind(members);
      for(const r of rs)if(isSpouse(r)||isSibling(r))same.join(r.person_a_id,r.person_b_id);
      const units=new Map();
      for(const id of members){const u=same.find(id);if(!units.has(u))units.set(u,{id:u,members:[],parents:new Set(),children:new Set(),rank:0,x:0});units.get(u).members.push(id);}
      for(const r of rs.filter(isParent)){
        const a=same.find(r.person_a_id),b=same.find(r.person_b_id);
        if(a===b){errors.push(r.relationship_id+': конфликт поколений');continue;}
        units.get(a).children.add(b);units.get(b).parents.add(a);
      }
      const indegree=new Map([...units].map(([id,u])=>[id,u.parents.size]));
      const queue=[...units.keys()].filter(id=>indegree.get(id)===0).sort();let visited=0;
      while(queue.length){const id=queue.shift(),u=units.get(id);visited++;for(const child of u.children){const v=units.get(child);v.rank=Math.max(v.rank,u.rank+1);indegree.set(child,indegree.get(child)-1);if(!indegree.get(child))queue.push(child);}}
      if(visited!==units.size)errors.push('Цикл родительства в группе '+members[0]);
      const rows=[];
      for(const u of units.values()){u.members.sort();u.width=u.members.length*W+(u.members.length-1)*SIB_GAP;if(!rows[u.rank])rows[u.rank]=[];rows[u.rank].push(u);}
      const rowWidth=row=>row.reduce((s,u)=>s+u.width,0)+Math.max(0,row.length-1)*UNIT_GAP;
      const arrange=()=>{for(const row of rows.filter(Boolean)){let x=0;for(const u of row){u.x=x;x+=u.width+UNIT_GAP;}}};
      arrange();
      // Several barycentre passes reduce crossings without inventing relationships.
      for(let pass=0;pass<8;pass++){
        const order=pass%2===0?rows.filter(Boolean):rows.filter(Boolean).slice().reverse();
        for(const row of order){
          const bary=u=>{const ns=[...(pass%2===0?u.parents:u.children)].map(id=>units.get(id));return ns.length?ns.reduce((s,v)=>s+v.x+v.width/2,0)/ns.length:u.x+u.width/2;};
          const orderValues=new Map(row.map(u=>[u.id,bary(u)]));
          row.sort((a,b)=>orderValues.get(a.id)-orderValues.get(b.id)||a.id.localeCompare(b.id));arrange();
        }
      }
      const inner=Math.max(W,...rows.filter(Boolean).map(rowWidth));
      const nodes=new Map();
      for(const row of rows.filter(Boolean)){
        let x=(inner-rowWidth(row))/2;
        for(const u of row){
          // A couple's individual order follows parental barycentres where known.
          u.members.sort((a,b)=>{
            const parentX=id=>{const ps=rs.filter(r=>isParent(r)&&r.person_b_id===id).map(r=>units.get(same.find(r.person_a_id)));return ps.length?ps.reduce((s,p)=>s+p.x+p.width/2,0)/ps.length:Infinity;};
            const ax=parentX(a),bx=parentX(b);return (Number.isFinite(ax)&&Number.isFinite(bx)?ax-bx:0)||a.localeCompare(b);
          });
          u.members.forEach((id,i)=>nodes.set(id,{id,x:PAD+x+i*(W+SIB_GAP),y:HEAD+u.rank*(H+ROW_GAP),w:W,h:H,rank:u.rank}));
          x+=u.width+UNIT_GAP;
        }
      }
      const containsTree=members.some(id=>isTree(people.get(id)));
      const group={id:'G-'+members.slice().sort()[0],members,rels:rs,nodes,w:inner+PAD*2,h:HEAD+rows.length*(H+ROW_GAP)-ROW_GAP+50,tree:containsTree};
      group.title=containsTree?'Семейная схема · '+(D.comparison?.artifact_id||'источник семьи'):rs.length?'Документальная группа · '+members.slice().sort()[0]:'Отдельная запись · '+members[0];
      if(!containsTree&&members.some(id=>isFamilyStory(people.get(id))))group.title='Семейная публикация · '+members.slice().sort()[0];
      group.subtitle=rs.length?`${members.length} записей · ${rs.length} связей · без объединения кандидатов`:'Родственные рёбра в реестре отсутствуют';
      groups.push(group);
    }
    groups.sort((a,b)=>b.members.length-a.members.length||a.id.localeCompare(b.id));
    // Large family gets its own horizontal band; small independent groups form a shelf below.
    const maxWidth=Math.max(1500,...groups.map(g=>g.w));let x=0,y=0,band=0;
    for(const g of groups){
      if(x&&x+g.w>maxWidth){x=0;y+=band+55;band=0;}
      g.x=x;g.y=y;
      for(const p of g.nodes.values()){p.x+=x;p.y+=y;p.group=g.id;}
      x+=g.w+45;band=Math.max(band,g.h);
      if(g.w>maxWidth*.72){x=0;y+=band+55;band=0;}
    }
    return {groups,errors};
  }

  function relevantRecords() {
    let rels=D.relationships;
    let ids=D.people.map(p=>p.person_id);
    if(state.mode==='compare'&&D.comparison?.artifact_id){
      const a=D.comparison.artifact_id;
      rels=rels.filter(r=>list(r.supporting_artifact_ids).includes(a)||list(r.claim_ids).some(id=>list(claims.get(id)?.artifact_ids).includes(a)));
      const members=new Set(rels.flatMap(r=>[r.person_a_id,r.person_b_id]));
      for(const p of D.people)if(list(p.source_artifact_ids).includes(a))members.add(p.person_id);
      ids=ids.filter(id=>members.has(id));
    }
    if(state.allowed){ids=ids.filter(id=>state.allowed.has(id));const s=new Set(ids);rels=rels.filter(r=>s.has(r.person_a_id)&&s.has(r.person_b_id));}
    return {ids,rels};
  }
  const nameMeasurer=document.createElement('canvas').getContext('2d');
  nameMeasurer.font='620 18px '+getComputedStyle(document.body).fontFamily;
  function wrapText(text,maxWidth,maxLines) {
    const measure=s=>nameMeasurer.measureText(s).width;
    const words=String(text).split(/\s+/),lines=[];let line='';
    for(const word of words){
      const candidate=line?line+' '+word:word;
      if(measure(candidate)<=maxWidth){line=candidate;continue;}
      if(line)lines.push(line);line=word;
      while(measure(line)>maxWidth){let cut=line.length;while(cut>1&&measure(line.slice(0,cut))>maxWidth)cut--;lines.push(line.slice(0,cut));line=line.slice(cut);}
    }
    if(line)lines.push(line);
    if(lines.length>maxLines){let last=lines.slice(maxLines-1).join(' ');while(last&&measure(last+'…')>maxWidth)last=last.slice(0,-1);return [...lines.slice(0,maxLines-1),last+'…'];}
    return lines;
  }
  function renderGraph() {
    const {ids,rels}=relevantRecords();const layout=makeLayout(ids,rels);state.groups=layout.groups;state.nodes=new Map();
    for(const g of state.groups)for(const [id,node]of g.nodes)state.nodes.set(id,node);
    state.edges=rels;
    const world=$('world');world.replaceChildren();
    const backgrounds=svg('g',{'data-layer':'groups'}),identityLayer=svg('g',{'data-layer':'identities'}),edgeLayer=svg('g',{'data-layer':'relationships'}),nodeLayer=svg('g',{'data-layer':'people'});
    world.append(backgrounds,identityLayer,edgeLayer,nodeLayer);
    for(const g of state.groups){
      const block=svg('g',{'data-group-id':g.id});
      block.append(svg('rect',{x:g.x,y:g.y,width:g.w,height:g.h,rx:15,class:'group-bg'}));
      block.append(svg('text',{x:g.x+30,y:g.y+32,class:'group-heading'},g.title));
      block.append(svg('text',{x:g.x+30,y:g.y+54,class:'group-subtitle'},g.subtitle));backgrounds.append(block);
    }
    if($('identity-toggle').checked&&state.mode!=='compare'){
      for(const e of D.identities){const a=state.nodes.get(e.person_a_id),b=state.nodes.get(e.person_b_id);if(!a||!b)continue;
        const ax=a.x+a.w/2,ay=a.y+a.h/2,bx=b.x+b.w/2,by=b.y+b.h/2;
        const gap=Math.max(50,Math.abs(by-ay)*.25);
        const path=`M ${ax} ${ay} C ${ax} ${ay+gap}, ${bx} ${by-gap}, ${bx} ${by}`;
        const g=svg('g',{class:'edge identity'+(state.selectedIdentity===e.claim_id?' selected':''),'data-identity-id':e.claim_id,'data-status':e.status,'aria-label':`${e.claim_id}: возможно, один человек; ${e.person_a_id} и ${e.person_b_id}`});
        g.append(svg('path',{d:path,class:'edge-line'}),svg('path',{d:path,class:'edge-hit'}));
        addLabel(g,(ax+bx)/2,(ay+by)/2,'≈ '+e.claim_id,92);
        activate(g,()=>selectIdentity(e.claim_id,true));identityLayer.append(g);
      }
    }
    for(const r of rels){
      const a=state.nodes.get(r.person_a_id),b=state.nodes.get(r.person_b_id);let path,lx,ly,label,width=86;
      if(isParent(r)){
        const parents=rels.filter(e=>isParent(e)&&e.person_b_id===r.person_b_id).sort((u,v)=>u.person_a_id.localeCompare(v.person_a_id));
        const index=parents.findIndex(e=>e.relationship_id===r.relationship_id);
        const offset=(index-(parents.length-1)/2)*73;
        const sx=a.x+a.w/2,sy=a.y+a.h,tx=b.x+b.w/2+offset,ty=b.y;
        const sameParent=rels.filter(e=>isParent(e)&&e.person_a_id===r.person_a_id).sort((u,v)=>state.nodes.get(u.person_b_id).x-state.nodes.get(v.person_b_id).x);
        const lane=sameParent.findIndex(e=>e.relationship_id===r.relationship_id);
        const mid=sy+31+lane*9+(index*5);
        path=`M ${sx} ${sy} V ${mid} H ${tx} V ${ty}`;lx=tx;ly=ty-22;label=r.relationship_id+' '+(r.status==='hypothesis'?'?':r.status==='single-source'?'¹':'!');
      } else {
        const left=a.x<b.x?a:b,right=a.x<b.x?b:a;
        if(isSibling(r)){const y=Math.min(a.y,b.y)-27;path=`M ${left.x+left.w/2} ${left.y} V ${y} H ${right.x+right.w/2} V ${right.y}`;lx=(left.x+left.w/2+right.x+right.w/2)/2;ly=y-12;label=r.relationship_id+' · брат/сестра';width=150;}
        else {const y=a.y+a.h*.52;path=`M ${left.x+left.w} ${y} H ${right.x}`;lx=(left.x+left.w+right.x)/2;ly=y-15;label=r.relationship_id;}
      }
      const g=svg('g',{class:'edge '+statusClass(r.status)+(state.selectedRelation===r.relationship_id?' selected':''),'data-rel-id':r.relationship_id,'data-status':r.status,'data-relation-type':r.relationship_type,'aria-label':`${r.relationship_id}: ${relationText(r)}; ${statusText(r.status)}`});
      g.append(svg('title',{},`${r.relationship_id} · ${relationText(r)} · ${statusText(r.status)}`),svg('path',{d:path,class:'edge-line'}),svg('path',{d:path,class:'edge-hit'}));
      if(/corroborated/.test(r.status))g.append(svg('path',{d:path,class:'edge-line',transform:'translate(3 0)'}));
      addLabel(g,lx,ly,label,width);
      if(!isParent(r)&&!isSibling(r))g.append(svg('text',{x:lx,y:ly+23,class:'edge-label'},isSpouse(r)?'супруги · '+shortStatus(r.status):relationText(r)));
      activate(g,()=>selectRelation(r.relationship_id));edgeLayer.append(g);
    }
    for(const [id,n] of state.nodes){
      const p=people.get(id),qs=questionsForPerson(id),tree=isTree(p);
      const g=svg('g',{class:'node'+(tree?' tree-node':'')+(state.selectedPerson===id?' selected':''),'data-person-id':id,'data-rank':n.rank,'data-x':n.x,'data-y':n.y,'data-group':n.group,transform:`translate(${n.x},${n.y})`,'aria-label':`${id}: ${p.preferred_label}`});
      g.append(svg('title',{},p.preferred_label),svg('rect',{width:n.w,height:n.h,class:'card'}));
      g.append(svg('text',{x:16,y:24,class:'node-id'},id));
      g.append(svg('text',{x:n.w-15,y:24,class:'node-origin','text-anchor':'end'},tree?'семейная схема':isFamilyStory(p)?'семейная публикация':'запись источника'));
      const name=p.preferred_label.replace(/\s*\([^)]*\)\s*$/,'').replace(/^\[Предположительно:\s*/i,'? ').replace(/\]/g,'');
      wrapText(name,n.w-32,3).forEach((line,i)=>g.append(svg('text',{x:16,y:51+i*21,class:'node-name'},line)));
      let y=119;
      if(p.birth_estimate){const birth='Рожд.: '+p.birth_estimate;g.append(svg('text',{x:16,y,class:'node-event'},birth.length>39?birth.slice(0,38)+'…':birth));y+=15;}
      const missing=claimsForPerson(id).some(c=>c.status==='single-source'&&/пропал|пропавш/i.test(c.claim_text));
      let last=missing?'Пропал без вести · дата смерти неизвестна':p.death_estimate?'Смерть: '+p.death_estimate:tree?'Связи — гипотезы, запись не объединена':'Отдельный кандидат на личность';
      if(last.length>43)last=last.slice(0,42)+'…';
      g.append(svg('text',{x:16,y:150,class:'node-foot'},last));
      if(qs.length)g.append(svg('text',{x:n.w-16,y:103,class:'node-warning','text-anchor':'end'},'! '+qs.length));
      activate(g,()=>selectPerson(id));nodeLayer.append(g);
    }
    $('graph').dataset.personCount=String(state.nodes.size);$('graph').dataset.relationshipCount=String(rels.length);
    $('visible-count').textContent=`На схеме ${state.nodes.size} из ${D.people.length} записей · ${rels.length} из ${D.relationships.length} связей`;
    const strip=$('group-strip');strip.replaceChildren();
    for(const g of state.groups){const b=button((g.tree?'Семейная схема':g.members[0])+' · '+g.members.length,()=>focusGroup(g.id));b.dataset.groupButton=g.id;strip.append(b);}
    if(layout.errors.length){$('graph-message').hidden=false;$('graph-message').textContent='В реестрах есть конфликт расположения поколений: '+layout.errors.join('; ')+'. Данные не исправлялись автоматически.';}
    else {$('graph-message').hidden=state.nodes.size>0;$('graph-message').textContent='В этом режиме нет записей. Снимите фокус или добавьте материалы в реестры.';}
    $('clear-focus').hidden=!state.allowed;
    applyTransform();
  }
  function addLabel(group,x,y,text,width=85) {
    group.append(svg('rect',{x:x-width/2,y:y-11,width,height:18,class:'label-bg'}),svg('text',{x,y:y+1,class:'edge-label'},text));
  }
  function applyTransform(){ $('world').setAttribute('transform',`translate(${state.x} ${state.y}) scale(${state.scale})`);$('zoom-value').textContent=Math.round(state.scale*100)+'%'; }
  function fitBox(box,maxScale=1.15) {
    if(!box)return;const rect=$('graph-viewport').getBoundingClientRect();
    state.scale=Math.max(.075,Math.min(maxScale,(rect.width-45)/Math.max(1,box.w),(rect.height-48)/Math.max(1,box.h)));
    state.x=(rect.width-box.w*state.scale)/2-box.x*state.scale;state.y=(rect.height-box.h*state.scale)/2-box.y*state.scale;applyTransform();
  }
  function boundingNodes(ids,pad=40){const ns=ids.map(id=>state.nodes.get(id)).filter(Boolean);if(!ns.length)return null;const x=Math.min(...ns.map(p=>p.x))-pad,y=Math.min(...ns.map(p=>p.y))-pad;return{x,y,w:Math.max(...ns.map(p=>p.x+p.w))+pad-x,h:Math.max(...ns.map(p=>p.y+p.h))+pad-y};}
  function fitAll(){if(state.groups.length){const x=Math.min(...state.groups.map(g=>g.x)),y=Math.min(...state.groups.map(g=>g.y));fitBox({x:x-15,y:y-15,w:Math.max(...state.groups.map(g=>g.x+g.w))-x+30,h:Math.max(...state.groups.map(g=>g.y+g.h))-y+30});}announce('Показаны все группы текущего режима');}
  function focusGroup(id){const g=state.groups.find(g=>g.id===id);if(!g)return;state.lastGroup=id;fitBox({x:g.x-12,y:g.y-12,w:g.w+24,h:g.h+24});document.querySelectorAll('[data-group-button]').forEach(b=>b.classList.toggle('active',b.dataset.groupButton===id));}
  function zoom(factor,cx,cy){const rect=$('graph-viewport').getBoundingClientRect();cx=cx??rect.width/2;cy=cy??rect.height/2;const s=Math.min(2.6,Math.max(.075,state.scale*factor));state.x=cx-(cx-state.x)*s/state.scale;state.y=cy-(cy-state.y)*s/state.scale;state.scale=s;applyTransform();}
  function centerPerson(id){const n=state.nodes.get(id);if(n)fitBox({x:n.x-65,y:n.y-60,w:n.w+130,h:n.h+120},1);}
  function markSelection(){document.querySelectorAll('[data-person-id]').forEach(e=>e.classList.toggle('selected',e.dataset.personId===state.selectedPerson));document.querySelectorAll('[data-rel-id]').forEach(e=>e.classList.toggle('selected',e.dataset.relId===state.selectedRelation));document.querySelectorAll('[data-identity-id]').forEach(e=>e.classList.toggle('selected',e.dataset.identityId===state.selectedIdentity));$('nearest').disabled=!state.selectedPerson;}

  function sourceButtons(container, ids, context='', contra=false) {
    const strip=element('div','link-buttons');
    for(const id of ids){if(!artifacts.has(id))continue;const b=button((contra?'Альтернатива · ':'')+id,()=>openSource(id,context),contra?'contra':'');b.dataset.artifactButton=id;strip.append(b);}
    if(strip.childElementCount)container.append(strip);
  }
  function personButton(id,prefix='') {return button(prefix+id+' · '+people.get(id).preferred_label,()=>selectPerson(id,true),'people-link');}
  function claimCard(c) {
    const card=element('article','claim-card '+statusClass(c.status));card.dataset.claimId=c.claim_id;
    card.append(element('span','card-id',c.claim_id+' · '),badge(c.status));
    const kindLabel=({'source-reading':'Чтение конкретного документа', 'working-preference':'Предпочтительная рабочая версия — тождество не доказано', 'source-conflict':'Необъяснённое расхождение источников', 'identity-hypothesis':'Возможно, один человек — отдельные записи кандидатов', 'source-dependency':'Происхождение и зависимость сведений', 'catalog-lead':'Архивная наводка — персональная запись ещё не прочитана', 'photo-attribution':'Атрибуция фотографии источником'})[c.claim_type];
    if(kindLabel)card.append(element('p','tiny',kindLabel));
    if(/unresolved|contradicted/.test(c.status))card.append(element('p','tiny','Предмет проверки. Следующая строка не является установленным фактом.'));
    card.append(element('p','claim-text',c.claim_text));
    if(c.rationale)card.append(element('p','tiny',c.rationale));
    sourceButtons(card,list(c.artifact_ids),c.rationale+' '+c.claim_text);
    sourceButtons(card,list(c.contradicting_artifact_ids),c.rationale,true);
    if(c.next_action){const more=element('details');more.append(element('summary','tiny','Что поможет проверить'),element('p','tiny',c.next_action));card.append(more);}
    return card;
  }
  function setDetails(label){$('inspector-label').textContent=label;const box=$('details');box.replaceChildren();box.scrollTop=0;return box;}
  function hideSource(){if(state.mode==='compare')setMode('tree',false);state.source=null;$('source-panel').hidden=true;$('close-source').hidden=true;$('workspace').classList.remove('has-source');requestAnimationFrame(()=>{if(state.selectedPerson)centerPerson(state.selectedPerson);});}
  function selectPerson(id,center=false){
    if(!people.has(id))return;
    if(state.mode==='questions'||state.mode==='sources')setMode('tree',false);
    if(!state.nodes.has(id)){state.allowed=null;if(state.mode==='compare')setMode('tree',false);renderGraph();}
    state.selectedPerson=id;state.selectedRelation=null;state.selectedIdentity=null;markSelection();
    const p=people.get(id),box=setDetails('Карточка человека · '+id);box.append(element('span','id-pill',D.meta.tree_id+'/'+id),element('h2','',p.preferred_label));
    const qs=questionsForPerson(id);
    if(qs.length)box.append(element('div','notice question',`${qs.length} открытых вопросов связаны с этой записью. Кандидат сохранён отдельно.`));
    field(box,'Имя в источниках',p.names_as_written);field(box,'Исследовательские варианты',p.normalized_name_variants);
    field(box,'Рождение — по реестру, со всеми версиями',p.birth_estimate);
    field(box,'Смерть — только если указана в реестре',p.death_estimate||'Не установлена');
    field(box,'Жизненный статус',({unknown:'Неизвестен',deceased:'Умер(ла) — по источникам, указанным в утверждениях',living:'Жив(а) — по сведениям дела'}[p.living_status]||p.living_status));
    field(box,'Места как записано',p.places);field(box,'Военная/социальная характеристика',p.occupation_or_status);field(box,'Замечания',p.notes);
    const cs=claimsForPerson(id),bio=cs.filter(c=>c.claim_type!=='relationship'&&!identities.has(c.claim_id));
    box.append(heading('События и проверяемые утверждения'));
    for(const c of bio)box.append(claimCard(c));
    if(!bio.length)box.append(element('p','muted',p._public_redacted?'Биографические сведения не опубликованы.':'Отдельных биографических утверждений пока нет; поля записи сохраняют сведения исходного дерева.'));
    const relatives=D.relationships.filter(r=>r.person_a_id===id||r.person_b_id===id);
    box.append(heading('Родственные линии · '+relatives.length));
    for(const r of relatives){const other=r.person_a_id===id?r.person_b_id:r.person_a_id;const item=element('div','relation-list-item');item.append(button(`${r.relationship_id} · ${relationText(r)}`,()=>selectRelation(r.relationship_id)),badge(r.status),personButton(other));box.append(item);}
    const same=D.identities.filter(e=>e.person_a_id===id||e.person_b_id===id);
    if(same.length){box.append(heading('Возможно, один человек · это не родство'));for(const e of same){const other=e.person_a_id===id?e.person_b_id:e.person_a_id;const b=button(`≈ ${e.claim_id} · ${other} · ${people.get(other).preferred_label}`,()=>selectIdentity(e.claim_id,true),'question-preview');b.dataset.identityButton=e.claim_id;box.append(b);}}
    if(qs.length){box.append(heading('Открытые вопросы'));for(const q of qs)box.append(questionPreview(q));}
    box.append(heading('Источники записи'));sourceButtons(box,list(p.source_artifact_ids),cs.map(c=>c.rationale+' '+c.claim_text).join(' '));
    field(box,'Почему запись оставлена отдельной',p.merge_or_split_rationale);
    if(center)centerPerson(id);announce('Выбран '+id);
  }
  function selectRelation(id){
    const r=relations.get(id);if(!r)return;
    if(state.mode==='questions'||state.mode==='sources')setMode('tree',false);
    state.selectedRelation=id;state.selectedIdentity=null;state.selectedPerson=null;markSelection();
    const box=setDetails('Карточка родственной линии · '+id);box.append(element('span','id-pill',D.meta.tree_id+'/'+id),element('h2','',relationText(r)),badge(r.status));
    box.append(personButton(r.person_a_id),personButton(r.person_b_id));
    if(r.status==='single-source')box.append(element('div','notice','В источнике указана эта родственная роль. Одной цепочки недостаточно, чтобы назвать родство доказанным независимыми источниками.'));
    field(box,'Основание оценки',r.rationale);field(box,'Характер связи','Роль передана как записано; биологическая или юридическая природа отдельно не установлена.');
    box.append(heading('Что именно сообщает источник'));
    for(const cid of list(r.claim_ids)){const c=claims.get(cid);if(c)box.append(claimCard(c));}
    const sourceContext=r.rationale+' '+list(r.claim_ids).map(cid=>claims.get(cid)?.claim_text||'').join(' ');
    sourceButtons(box,list(r.supporting_artifact_ids),sourceContext);sourceButtons(box,list(r.contradicting_artifact_ids),sourceContext,true);
    field(box,'Группы происхождения (не число независимых доказательств)',r.independence_groups);
    announce('Выбрана линия '+id);
  }
  function selectIdentity(cid,focus=false){
    const e=identities.get(cid);if(!e)return;
    if(state.mode!=='tree')setMode('tree',false);
    if(focus){state.allowed=new Set([e.person_a_id,e.person_b_id,...nearestIds(e.person_a_id),...nearestIds(e.person_b_id)]);renderGraph();fitAll();}
    state.selectedIdentity=cid;state.selectedPerson=null;state.selectedRelation=null;markSelection();
    const box=setDetails('Версия тождества · '+cid);box.append(element('span','badge identity','≈ Возможно, один человек'),element('h2','','Две записи остаются раздельными'),personButton(e.person_a_id),personButton(e.person_b_id));
    box.append(element('div','notice','Эта линия не обозначает родство, не меняет поколения и не переносит события одного кандидата другому.'));
    box.append(claimCard(claims.get(cid)));announce('Выбрана версия тождества '+cid);
  }
  function nearestIds(id){
    const result=new Set([id]);
    for(const r of D.relationships){if(r.person_a_id===id)result.add(r.person_b_id);if(r.person_b_id===id)result.add(r.person_a_id);}
    const ps=D.relationships.filter(r=>isParent(r)&&r.person_b_id===id).map(r=>r.person_a_id);
    for(const r of D.relationships)if(isParent(r)&&ps.includes(r.person_a_id))result.add(r.person_b_id);
    return result;
  }
  function questionPreview(q){const b=button(q.issue_id+' · '+q.question,()=>selectQuestion(q.issue_id),'question-preview');b.dataset.questionButton=q.issue_id;return b;}
  function selectQuestion(id){
    const q=issues.get(id);if(!q)return;setMode('tree',false);
    const ps=new Set(list(q.person_ids));for(const c of list(q.claim_ids))for(const p of list(claims.get(c)?.subject_person_ids))ps.add(p);
    state.allowed=ps.size?new Set([...ps].flatMap(p=>[...nearestIds(p)])):null;renderGraph();
    if(ps.size)fitBox(boundingNodes([...ps],90));else fitAll();
    state.selectedPerson=null;state.selectedRelation=null;state.selectedIdentity=null;markSelection();
    const box=setDetails('Открытый вопрос · '+id);box.append(element('span','badge question',id+' · открыт'),element('h2','',q.question));
    field(box,'Пакет',q.package_id);field(box,'Локаторы',q.source_locators);field(box,'Замечания',q.notes);
    for(const p of ps)if(people.has(p))box.append(personButton(p));
    for(const c of list(q.claim_ids))if(claims.has(c))box.append(claimCard(claims.get(c)));
    sourceButtons(box,list(q.artifact_ids),q.source_locators);announce('Открыт вопрос '+id);
  }

  function preferredPreview(a,context=''){
    const previews=a._view?.previews||[];
    const match=context.match(/(?:физическ[а-я ]*|с\.)\s*(\d+)/i);
    if(match){const i=previews.findIndex(p=>p.kind==='page'&&p.page===Number(match[1]));if(i>=0)return i;}
    if(a.originality==='image-of-original'&&previews.some(p=>p.kind==='page'&&p.page===2))return previews.findIndex(p=>p.kind==='page'&&p.page===2);
    return 0;
  }
  function sourceDetails(a){
    const box=setDetails('Карточка источника · '+a.artifact_id);box.append(element('span','id-pill',a.artifact_id),element('h2','',a.source_title));
    field(box,'Содержание',a.summary);field(box,'Происхождение и локатор',a.access_notes);field(box,'Архивный шифр',a.archival_reference);field(box,'Имена как записано',a.names_as_written);
    field(box,'Читаемость',({clear:'Чёткая',partial:'Частичная',poor:'Плохая',unreadable:'Не читается'}[a.legibility]||a.legibility));
    field(box,'Группа происхождения',a.independence_group);field(box,'Оценка источника',a.reliability_notes);
    const cs=D.claims.filter(c=>list(c.artifact_ids).includes(a.artifact_id)||list(c.contradicting_artifact_ids).includes(a.artifact_id));box.append(heading('Утверждения, связанные с источником · '+cs.length));for(const c of cs)box.append(claimCard(c));
  }
  function openSource(id,context='',withDetails=false){
    const a=artifacts.get(id);if(!a)return;
    if(state.mode==='questions'||state.mode==='sources')setMode('tree',false);
    if(withDetails)sourceDetails(a);
    state.source=id;$('source-panel').hidden=false;$('close-source').hidden=false;$('workspace').classList.add('has-source');
    const meta=$('source-meta');meta.replaceChildren();meta.append(element('h3','',id+' · '+a.source_title));
    if(a._view?.original)meta.append(localLink(a._view.original,'Открыть опубликованную копию · '+a._view.original_name));
    if(a._view?.public_url){const link=element('a','','Открыть публичную страницу источника (интернет)');link.href=a._view.public_url;link.target='_blank';link.rel='noopener noreferrer';meta.append(element('br'),link);}
    const available=!!a._view?.previews?.length;const loc=element('p','tiny',(a._view?.file_id||'Источник')+' · '+(!available?'Образ исключён из публичной копии':a._view?.pages?.length?'Выбранные физические страницы PDF: '+a._view.pages.join(', '):'Выбранное изображение или фрагмент'));meta.append(loc);for(const id of ['source-select','source-zoom-out','source-zoom-in','source-fit'])$(id).disabled=!available;
    if(a._view?.previews?.length&&!a._view?.locator_exact)meta.append(element('p','tiny','Точный страничный локатор не формализован: показаны доступные страницы файла.'));
    const select=$('source-select');select.replaceChildren();
    for(const [i,p]of (a._view?.previews||[]).entries()){const option=element('option','',p.label);option.value=String(i);select.append(option);}
    state.imageIndex=preferredPreview(a,context);select.value=String(state.imageIndex);loadPreview();
    if(state.mode==='compare')requestAnimationFrame(()=>focusComparisonPage());
    else requestAnimationFrame(()=>{if(state.selectedPerson)centerPerson(state.selectedPerson);else if(state.selectedRelation){const r=relations.get(state.selectedRelation);fitBox(boundingNodes([r.person_a_id,r.person_b_id],80));}});
  }
  function loadPreview(){
    const a=artifacts.get(state.source),p=a?._view?.previews[state.imageIndex];
    $('image-error').hidden=true;$('source-image').hidden=!p;
    if(!p){$('source-image').removeAttribute('src');$('source-caption').textContent=a._view.withheld_reason;return;}
    $('source-caption').textContent=a.artifact_id+' · '+p.locator+(p.kind==='crop'?' · Выбранная вырезка; полный файл может быть исключён из публичной копии.':p.kind==='transcription'?' · Это выписка, а не архивный образ.':'');
    $('source-image').alt=a.artifact_id+' · '+p.label;
    $('source-image').src=pathURL(p.path);
    const link=$('source-meta').querySelector('a');if(link&&a._view.pdf)link.href=pathURL(a._view.original,p.page?'page='+p.page:'');
    if(state.mode==='compare')focusComparisonPage();
  }
  function imageTransform(){ $('source-image').style.transform=`translate(${state.imageX}px,${state.imageY}px) scale(${state.imageScale})`; }
  function fitImage(){const im=$('source-image'),rect=$('image-viewport').getBoundingClientRect();if(!im.naturalWidth||rect.width<1||rect.height<1)return;state.imageScale=Math.min((rect.width-18)/im.naturalWidth,(rect.height-18)/im.naturalHeight);state.imageX=(rect.width-im.naturalWidth*state.imageScale)/2;state.imageY=(rect.height-im.naturalHeight*state.imageScale)/2;imageTransform();}
  function zoomImage(factor,cx,cy){const rect=$('image-viewport').getBoundingClientRect();cx=cx??rect.width/2;cy=cy??rect.height/2;const s=Math.min(7,Math.max(.03,state.imageScale*factor));state.imageX=cx-(cx-state.imageX)*s/state.imageScale;state.imageY=cy-(cy-state.imageY)*s/state.imageScale;state.imageScale=s;imageTransform();}
  function focusComparisonPage(){
    if(state.mode!=='compare')return;
    const a=artifacts.get(state.source),p=a?._view?.previews[state.imageIndex];
    const anchors=D.comparison?.page_focus?.[String(p?.page)]||[];
    const n=anchors.map(id=>state.nodes.get(id)).find(Boolean);
    if(n)focusGroup(n.group);else if(state.groups.length)focusGroup(state.groups[0].id);
  }

  function intro(){
    const box=setDetails('Проверка понимания пакета');
    box.append(element('h2','','Связи видны. Основания — рядом.'));
    const stats=element('div','intro-stats');for(const [num,label]of [[D.people.length,'записи кандидатов'],[D.relationships.length,'родственных линий'],[D.meta.counts.hypotheses,'гипотез из схемы']]){const s=element('div');s.append(element('div','intro-number',num),element('small','',label));stats.append(s);}box.append(stats);
    box.append(element('p','muted','Выберите человека, чтобы увидеть его события и версии, или линию — чтобы прочитать основание связи. Кнопка источника откроет страницу документа рядом с деревом.'));
    box.append(element('div','notice','Кандидаты остаются отдельными записями. Пунктир «≈» показывает только возможное тождество. Отсутствие родственного моста не заполнено догадками.'));
    box.append(heading('С чего начать проверку'));
    const prioritized=[...D.meta.question_priority.map(id=>issues.get(id)).filter(Boolean),...openQuestions].filter((q,i,all)=>all.findIndex(v=>v.issue_id===q.issue_id)===i).slice(0,3);
    for(const q of prioritized)box.append(questionPreview(q));
    box.append(button('Все открытые вопросы · '+openQuestions.length,()=>setMode('questions')));
    if(D.meta.warnings.length){box.append(heading('Ограничения сборки'));for(const w of D.meta.warnings)box.append(element('p','tiny',w));}
  }
  function catalog(mode){
    const area=$('catalog-area');area.replaceChildren();
    area.append(element('h2','',mode==='questions'?'Вопросы, которые остаются открытыми':'Источники и их страницы'));
    area.append(element('p','',mode==='questions'?'Нажмите на вопрос: схема покажет связанные записи, а справа появятся версии и источники.':'Все ссылки ведут к копиям внутри этого дела. Внешние адреса в тексте документов не открываются автоматически.'));
    const filter=element('input');filter.type='search';filter.placeholder=mode==='questions'?'Поиск по вопросу или ID':'Поиск по источнику, ID или шифру';filter.setAttribute('aria-label',filter.placeholder);area.append(filter);
    const grid=element('div','catalog-grid');area.append(grid);
    const render=()=>{grid.replaceChildren();const term=filter.value.toLocaleLowerCase('ru');
      const records=mode==='questions'?openQuestions:D.artifacts;
      for(const item of records){if(term&&!JSON.stringify(item).toLocaleLowerCase('ru').includes(term))continue;
        if(mode==='questions'){const q=item,c=element('article','question-card');c.dataset.questionId=q.issue_id;c.append(element('span','badge question',q.issue_id+' · открыт'),element('h3','',q.question));if(q.notes)c.append(element('p','tiny',q.notes));c.append(button('Проверить на схеме',()=>selectQuestion(q.issue_id)));grid.append(c);}
        else {const a=item,c=element('article','source-card');c.dataset.artifactId=a.artifact_id;c.append(element('span','card-id',a.artifact_id),element('h3','',a.source_title),element('p','tiny',a.archival_reference||'Архивный шифр не указан'),element('p','tiny',a.summary),button('Карточка и страницы',()=>openSource(a.artifact_id,'',true)));grid.append(c);}
      }
    };filter.addEventListener('input',render);render();
  }
  function setMode(mode,focus=true){
    state.mode=mode;state.allowed=null;
    const graphMode=mode==='tree'||mode==='compare';$('graph-area').hidden=!graphMode;$('catalog-area').hidden=graphMode;
    $('workspace').classList.toggle('compare',mode==='compare');
    document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b.dataset.mode===mode);b.setAttribute('aria-pressed',b.dataset.mode===mode?'true':'false');});
    if(!graphMode){catalog(mode);return;}
    renderGraph();
    if(mode==='compare'&&D.comparison?.artifact_id){
      const box=setDetails('Реконструкция и исходная схема');box.append(element('h2','',D.comparison.title||'Сверка семейной схемы'),element('p','muted','Слева сохранены линии семейной схемы и их статусы. Её скан исключён из открытой копии, поскольку содержит сведения о младших поколениях. Нажмите линию, чтобы увидеть доступное основание.'));
      openSource(D.comparison.artifact_id);requestAnimationFrame(()=>{fitImage();focusComparisonPage();});
    } else if(focus){if(state.groups.length)requestAnimationFrame(()=>focusGroup(state.groups[0].id));}
  }

  // Drag and wheel handlers are local and never persist edits to the research data.
  function installPanZoom(container,change,zoomFn){
    let drag=null;
    container.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('button,select,a,input'))return;drag={x:event.clientX,y:event.clientY,moved:false};});
    container.addEventListener('pointermove',event=>{if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>2){if(!drag.moved)container.setPointerCapture(event.pointerId);drag.moved=true;container.classList.add('dragging');change(dx,dy);drag.x=event.clientX;drag.y=event.clientY;}});
    const end=()=>{if(drag?.moved){container.dataset.suppressClick='1';setTimeout(()=>delete container.dataset.suppressClick,40);}drag=null;container.classList.remove('dragging');};
    container.addEventListener('pointerup',end);container.addEventListener('pointercancel',end);
    container.addEventListener('click',event=>{if(container.dataset.suppressClick){event.preventDefault();event.stopImmediatePropagation();}},true);
    container.addEventListener('wheel',event=>{event.preventDefault();const r=container.getBoundingClientRect();zoomFn(Math.exp(-event.deltaY*.0013),event.clientX-r.left,event.clientY-r.top);},{passive:false});
  }
  installPanZoom($('graph-viewport'),(dx,dy)=>{state.x+=dx;state.y+=dy;applyTransform();},zoom);
  installPanZoom($('image-viewport'),(dx,dy)=>{state.imageX+=dx;state.imageY+=dy;imageTransform();},zoomImage);
  $('graph-viewport').addEventListener('keydown',event=>{const moves={ArrowLeft:[35,0],ArrowRight:[-35,0],ArrowUp:[0,35],ArrowDown:[0,-35]};if(moves[event.key]){event.preventDefault();state.x+=moves[event.key][0];state.y+=moves[event.key][1];applyTransform();}if(event.key==='+'||event.key==='=')zoom(1.2);if(event.key==='-')zoom(1/1.2);});
  $('zoom-out').addEventListener('click',()=>zoom(1/1.25));$('zoom-in').addEventListener('click',()=>zoom(1.25));$('fit-all').addEventListener('click',()=>{if(state.mode!=='tree'&&state.mode!=='compare')setMode('tree',false);state.allowed=null;renderGraph();fitAll();});
  $('nearest').addEventListener('click',()=>{if(!state.selectedPerson)return;state.allowed=nearestIds(state.selectedPerson);renderGraph();fitAll();announce('Показаны ближайшие родственники по записанным связям; предполагаемые родители учитываются с исходным статусом.');});
  $('clear-focus').addEventListener('click',()=>{state.allowed=null;renderGraph();fitAll();});
  $('identity-toggle').addEventListener('change',renderGraph);
  $('close-source').addEventListener('click',hideSource);
  $('source-select').addEventListener('change',event=>{state.imageIndex=Number(event.target.value);loadPreview();});
  $('source-zoom-in').addEventListener('click',()=>zoomImage(1.4));$('source-zoom-out').addEventListener('click',()=>zoomImage(1/1.4));$('source-fit').addEventListener('click',fitImage);
  $('source-image').addEventListener('load',()=>{$('image-error').hidden=true;fitImage();});$('source-image').addEventListener('error',()=>{$('image-error').hidden=false;});
  document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  $('person-search').addEventListener('input',event=>{
    const term=event.target.value.trim().toLocaleLowerCase('ru').replace(/ё/g,'е'),out=$('search-results');out.replaceChildren();
    if(!term){out.hidden=true;return;}
    const matches=D.people.filter(p=>[p.person_id,p.preferred_label,p.names_as_written,p.normalized_name_variants].join(' ').toLocaleLowerCase('ru').replace(/ё/g,'е').includes(term));
    for(const p of matches.slice(0,30)){const b=button(p.person_id+' · '+p.preferred_label,()=>{out.hidden=true;event.target.value=p.person_id;selectPerson(p.person_id,true);});b.setAttribute('role','option');b.dataset.searchPerson=p.person_id;out.append(b);}
    if(!matches.length)out.append(element('p','tiny','В текущем реестре совпадений нет.'));out.hidden=false;
  });
  $('person-search').addEventListener('keydown',event=>{if(event.key==='Escape')$('search-results').hidden=true;if(event.key==='Enter'){const b=$('search-results').querySelector('button');if(b){event.preventDefault();b.click();}}});
  document.addEventListener('click',event=>{if(!event.target.closest('.search-box'))$('search-results').hidden=true;});
  $('about-button').addEventListener('click',()=>{
    const box=$('about-content');box.replaceChildren();box.className='dialog-content';
    box.append(element('p','',`Общедоступная копия tree-01. Исходная сборка: ${D.meta.build_id}.`));
    box.append(element('p','','Имена и биографические поля части родственников скрыты. Это правило публикации; оно не утверждает, что человек жив или умер. Связи, статусы и версии тождества сохранены без слияния кандидатов.'));
    box.append(element('p','','Для исправления укажите ID человека, линии, утверждения или источника и его основание. Следующая публикация готовится из нового завершённого снимка по README репозитория.'));
    const link=element('a','','Порядок обновления и сведения о версии');link.href='../README.md';box.append(link);
    $('about-dialog').showModal();
  });
  $('close-about').addEventListener('click',()=>$('about-dialog').close());
  $('case-label').textContent=D.meta.tree_id+' / семейное дело';$('page-title').textContent=D.meta.display_name+' · карта связей';
  const date=new Intl.DateTimeFormat('ru-RU',{timeZone:D.meta.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(D.meta.built_at));
  $('built-date').textContent='Данные от '+date+' · '+D.meta.timezone;$('built-date').title=D.meta.built_at+' · '+D.meta.fingerprint;
  $('package-label').textContent=D.meta.public_export.named_people+' открытых · '+D.meta.public_export.anonymised_people+' обезличены';
  $('identity-label').textContent='Возможное тождество · '+D.identities.length;
  $('questions-button').textContent='Открытые вопросы · '+openQuestions.length;$('sources-button').textContent='Источники · '+D.artifacts.length;
  $('compare-button').textContent=D.comparison?.title||'Сверка со схемой';$('compare-button').disabled=!D.comparison?.artifact_id;
  $('confirmed-count').textContent='('+D.relationships.filter(r=>/corroborated/.test(r.status)).length+')';
  $('footer-stats').textContent=`${D.people.length} записей · ${D.relationships.length} родственных линий · ${D.claims.length} утверждения`;
  let previousViewport=null;
  new ResizeObserver(()=>{
    const rect=$('graph-viewport').getBoundingClientRect();
    if(!rect.width||!rect.height)return;
    if(state.mode==='compare')focusComparisonPage();
    else if(state.selectedPerson&&state.nodes.has(state.selectedPerson)){if(state.allowed)fitAll();else centerPerson(state.selectedPerson);}
    else if(state.selectedRelation){const r=relations.get(state.selectedRelation);if(state.nodes.has(r.person_a_id)&&state.nodes.has(r.person_b_id))fitBox(boundingNodes([r.person_a_id,r.person_b_id],80));}
    else if(previousViewport){state.x+=(rect.width-previousViewport.width)/2;state.y+=(rect.height-previousViewport.height)/2;applyTransform();}
    previousViewport={width:rect.width,height:rect.height};
    if(state.source)fitImage();
  }).observe($('graph-viewport'));
  intro();renderGraph();requestAnimationFrame(()=>{if(state.groups.length)focusGroup(state.groups[0].id);});
  // Only a read-only diagnostic for local QA; no mutation or network API is exposed.
  Object.defineProperty(window,'viewerDiagnostics',{value:Object.freeze({snapshot:()=>({mode:state.mode,people:[...state.nodes.keys()],relationships:state.edges.map(r=>r.relationship_id),identities:D.identities.map(e=>e.claim_id),groups:state.groups.map(g=>({id:g.id,members:[...g.members]})),selectedPerson:state.selectedPerson,selectedRelation:state.selectedRelation,selectedIdentity:state.selectedIdentity,source:state.source,scale:state.scale,translation:[state.x,state.y],imageScale:state.imageScale})}),writable:false});
})();
