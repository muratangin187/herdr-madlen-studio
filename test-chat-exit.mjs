import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./theme/mods/madlen-chat/main.js',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replace('export default class MadlenChat','globalThis.MadlenChat=class MadlenChat');
function setup({create=true,fail=false}={}){
  const runs=[],requests=[],jobs=[],tabs=[{id:'agent-tab',active:true}];
  const views=[{tab:'agent-tab',pane:'agent-pane',terminal:'ta',cwd:'/fixture/actual-agent',program:{name:'Codex'},focused:true}];
  const space={id:'xps/space',active:true,folder:'/fixture/fallback',tabs};
  const context={View:class {},spaces:()=>[space],panes:()=>views,shared:()=>null,appHome:()=>'/tmp',
    exec:(_bin,args)=>new Promise(resolve=>requests.push({args,resolve})),
    run:(name,args)=>{
      runs.push({name,args});if(fail)throw Error('cannot create tab');
      if(name==='tab.new'&&create){tabs[0].active=false;tabs.push({id:'empty-tab',active:true});
        views.push({tab:'empty-tab',pane:'shell-pane',terminal:'tshell',cwd:args.folder,program:{key:'shell'},focused:true});}
    }};
  vm.createContext(context);vm.runInContext(source,context);
  const view=new context.MadlenChat();Object.assign(view,{target:{terminal:'ta',pane:'agent-pane',tab:'agent-tab'},
    data:{process_key:'process:verified'},exitPending:false,exitingTerminals:new Set(),exitFocus:{focus(){}},
    cache:new Map(),raw:new Map(),outbox:[{terminal:'ta',state:'queued'}],persistOutbox(){},refresh(){}});
  let stopped=0;const cx={stop_propagation(){stopped++;},notify(){},sleep:()=>Promise.resolve(),spawn(fn){jobs.push(fn(this));}};
  return {view,cx,runs,requests,jobs,stopped:()=>stopped};
}
const key={key:'c',modifiers:{control:true}};
{
  const h=setup(),{view,cx,runs,requests,jobs}=h;
  view.exitKey({key:'c',modifiers:{platform:true}},cx);view.exitKey({key:'c',modifiers:{control:true,shift:true}},cx);
  assert.equal(runs.length,0,'copy and unrelated shortcuts are untouched');
  view.exitKey(key,cx);assert.equal(runs[0].name,'tab.new');
  assert.equal(runs[0].args.folder,'/fixture/actual-agent');assert.equal(runs[0].args.space,'xps/space');
  assert.equal(requests.length,1,'only after the replacement exists can the original agent be ended');
  assert.ok(requests[0].args.includes('ta'));assert.ok(requests[0].args.includes('process:verified'));
  assert.ok(requests[0].args.includes('--exit-agent'));assert.equal(view.outbox[0].state,'failed','exit cancels the unsent queue');
  view.exitKey(key,cx);assert.equal(runs.length,1,'a second key while stopping cannot close a different tab');
  requests[0].resolve({stdout:'{"ok":true}'});await jobs[0];
  view.exitKey({key:'d',modifiers:{control:true}},cx);
  assert.equal(runs[1].name,'tab.close');assert.equal(runs[1].args.id,'empty-tab');assert.equal(runs[1].args.confirmed,true);
}
for(const options of [{create:false},{fail:true}]){
  const h=setup(options);h.view.exitKey(key,h.cx);await Promise.all(h.jobs);
  assert.equal(h.requests.length,0,'failed replacement creation never ends the agent');
  assert.ok(h.view.exitError);assert.equal(h.view.exitPending,false);
}
{
  const h=setup();h.view.data={};h.view.exitKey(key,h.cx);
  assert.equal(h.runs.length,0,'unverified process identity never closes anything');
  h.view.readOnly=true;h.view.exitKey(key,h.cx);assert.equal(h.requests.length,0);
}
console.log('PASS: Ctrl+C/D two-step exit, copy preservation, exact process/machine/cwd, replacement-before-exit, queue cancellation and failure guards');
