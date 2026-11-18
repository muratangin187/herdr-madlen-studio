import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./theme/mods/madlen-chat/main.js',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replace('export default class MadlenChat','globalThis.MadlenChat=class MadlenChat');
const data=(terminal='ta',session='s')=>({terminal,session,kind:'codex',status:'idle',messages:[{id:'a',role:'assistant',text:'Fixture'}]});
function setup(){
  let active='a',surface='madlen-chat-view',now=100000;
  const requests=[],jobs=[],statuses={ta:'idle',tb:'working',tc:'idle'};
  const views=['a','b','c'].map(id=>({tab:id,pane:'p'+id,terminal:'t'+id,program:{name:'Codex'}}));
  const context={View:class {},Date:{now:()=>now},theme:()=>({}),layout:()=>({id:'conversation-surface',active:surface}),
    shared:()=>null,setShared(){},spaces:()=>[{active:true,tabs:[{id:active,active:true}]}],panes:()=>views,
    terminals:()=>views.map(p=>({address:p.terminal,status:statuses[p.terminal]})),appHome:()=>'/tmp',
    exec:(_bin,args)=>new Promise((resolve,reject)=>requests.push({args,resolve,reject})),run(){throw Error('No navigation during prefetch');}};
  vm.createContext(context);vm.runInContext(source,context);
  const view=new context.MadlenChat();Object.assign(view,{limits:{},raw:new Map(),reload:new Set(),anchor:null,pending:new Set(),
    cache:new Map(),positions:new Map(),drafts:{},staged:{},imageDrafts:{},outbox:[],updated:new Map(),reports:new Map(),diskLoaded:new Set(),
    input:{value:()=>'',set_value(){}},viewport:400,contentHeight:400,offset:0,follow:true,historyKey:0});
  const cx={notify(){},spawn(fn){jobs.push(fn(this));}};
  return {view,cx,requests,jobs,statuses,switchTo:id=>{active=id;view.refresh(cx);},hide:()=>{surface='main';},advance:ms=>{now+=ms;}};
}

{
  const h=setup(),{view,cx,requests,jobs}=h;view.refresh(cx);
  assert.equal(requests.length,2,'local cache read and full refresh run concurrently');
  assert.ok(requests[0].args.includes('--cached'));
  requests[0].resolve({stdout:JSON.stringify({...data(),cached:true})});await jobs[0];
  assert.equal(view.data.messages[0].text,'Fixture','disk history is visible while SSH is pending');
  view.input.value=()=> 'Do not send from a provisional cache';view.send(cx);
  assert.equal(requests.length,2,'cached history alone never authorizes a send');
  requests[1].resolve({stdout:JSON.stringify(data('ta','new-session'))});await jobs[1];
  assert.equal(view.data.session,'new-session');assert.ok(!view.data.cached);
}
{
  const {view,cx,requests,jobs}=setup();view.refresh(cx);
  requests[1].resolve({stdout:JSON.stringify(data('ta','fresh'))});await jobs[1];
  requests[0].resolve({stdout:JSON.stringify({...data('ta','stale'),cached:true})});await jobs[0];
  assert.equal(view.data.session,'fresh','late disk reads never overwrite a verified live snapshot');
}
{
  const h=setup(),{view,cx,requests,jobs}=h;view.refresh(cx);h.switchTo('b');
  requests[0].resolve({stdout:JSON.stringify({...data(),cached:true})});await jobs[0];
  assert.equal(view.data,null,'a late cache for A cannot appear in B');
  assert.ok(view.cache.has('ta'));
  requests[2].resolve({stdout:'null'});await jobs[2];
  requests[3].resolve({stdout:JSON.stringify(data('tb','B'))});await jobs[3];
  h.switchTo('a');assert.equal(view.data.session,'s','memory cache is synchronous on return');
}
{
  const h=setup(),{view,cx,requests,jobs}=h;h.hide();view.prefetch(cx);view.prefetch(cx);
  assert.equal(requests.length,2,'only one background transcript fetch at a time');
  assert.equal(requests[1].args[2],'ta','selected terminal has background priority even outside Chat');
  requests[1].resolve({stdout:JSON.stringify(data())});await jobs[1];
  assert.ok(view.cache.has('ta'),'unopened conversation is kept ready');
  assert.equal(requests[3].args[2],'tb','other visible agents warm in sequence');
  requests[3].resolve({stdout:JSON.stringify(data('tb'))});await jobs[3];
  requests[5].resolve({stdout:JSON.stringify(data('tc'))});await jobs[5];
  assert.equal(requests.length,6,'idle sessions do not create a tight fetch loop');
  view.prefetch(cx);assert.equal(requests.length,6);
  h.advance(6001);view.prefetch(cx);
  assert.equal(requests[6].args[2],'tb','working background agents refresh sooner than idle agents');
  requests[6].reject(Error('offline'));await jobs[6];
  view.prefetch(cx);assert.equal(requests.length,7,'failed remote calls are throttled too');
  h.statuses.tc='working';view.prefetch(cx);
  assert.equal(requests[7].args[2],'tc','a live status transition wakes the cache immediately');
}
{
  const h=setup(),{view,cx,requests,jobs}=h;h.hide();
  for(const terminal of ['ta','tb','tc']){h.statuses[terminal]='idle';view.reports.set(terminal,'idle');view.updated.set(terminal,100000);}
  view.cache.set('ta',{...data(),background:{jobs:[{id:'shell',status:'running'}]}});
  h.advance(6001);view.prefetch(cx);
  assert.equal(requests.length,1);assert.equal(requests[0].args[2],'ta','an idle assistant with a live shell still refreshes promptly');
  requests[0].resolve({stdout:JSON.stringify({...data(),background:{jobs:[]}})});await jobs[0];
  assert.equal(requests.length,1,'completed background work returns to the normal idle refresh interval');
}
console.log('PASS: disk-first rendering, live/disk races, session isolation, provisional-send guard, background priority, single-flight prefetch, status wakeup, error throttling and idle shell refresh');
