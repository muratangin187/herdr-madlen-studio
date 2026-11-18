import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const {backgroundView,elapsedLabel}=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(new URL('./theme/mods/madlen-chat/activity.js',import.meta.url))).toString('base64'));
const job={id:'job',status:'running',title:'Yayını kontrol et',command:'fixture-check --wait',elapsed_seconds:134,output:'Connecting\nWaiting for deployment',output_age_seconds:10};
const background={jobs:[job]},active=backgroundView(background);
assert.equal(active.busy,true);assert.equal(active.show,true);assert.match(active.footer,/Yanıt hazır.*1 iş sürüyor/);
assert.equal(backgroundView({jobs:[]}).show,false);
assert.equal(backgroundView({unavailable:true}).show,true);
for(const flags of [{cached:true},{error:true}]){
  const old=backgroundView(background,flags);assert.equal(old.busy,false);assert.match(old.label,/kaydedilen durum/);
}
for(const status of ['completed','failed','unknown','stopped']){
  const state=backgroundView({jobs:[{...job,status}]});assert.equal(state.busy,false);
  assert.doesNotMatch(state.label,/iş çalışıyor/);
  if(status==='unknown')assert.match(state.footer,/doğrulanamadı/);
}
assert.equal(elapsedLabel(134),'2 dk 14 sn');assert.equal(elapsedLabel(3601),'1 sa 0 dk');assert.equal(elapsedLabel(null),'');

function element(){
  const node={nodes:[],events:{}};
  const proxy=new Proxy(node,{get(target,key){
    if(key in target)return target[key];
    if(key==='child')return value=>{node.nodes.push(value);return proxy;};
    if(key==='children')return values=>{node.nodes.push(...values);return proxy;};
    if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
    if(key==='on_click')return fn=>{node.events.click=fn;return proxy;};
    return ()=>proxy;
  }});return proxy;
}
const source=fs.readFileSync(new URL('./theme/mods/madlen-chat/main.js',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replace('export default class MadlenChat','globalThis.MadlenChat=class MadlenChat');
const context={View:class {},backgroundView,elapsedLabel,div:element,h_flex:element,v_flex:element,svg:element,settings:()=>({})};
vm.createContext(context);vm.runInContext(source,context);
const view=new context.MadlenChat();view.expanded={};view.button=(_id,label)=>element().child(label);
const text=node=>typeof node==='string'?node:(node?.nodes??[]).map(text).join('\n');
const theme={working:'#ff9900',done:'#00cc88',dim:'#888888',border:'#333333'};
let card=view.backgroundCard(active,theme);
assert.match(text(card),/Arka planda 1 iş çalışıyor/);assert.match(text(card),/2 dk 14 sn/);
assert.match(text(card),/Waiting for deployment/);assert.doesNotMatch(text(card),/fixture-check/);
card.nodes.at(-1).nodes[0].nodes[0].events.click({}, {notify(){}});
card=view.backgroundCard(active,theme);assert.match(text(card),/fixture-check --wait/);assert.match(text(card),/Son çıktı 10 sn önce/);
assert.match(text(view.backgroundCard(backgroundView({jobs:[{...job,output:''}]}),theme)),/Henüz çıktı yok/);
assert.doesNotMatch(text(view.backgroundCard(backgroundView({jobs:[{...job,output:''}]},{cached:true}),theme)),/işlem sürüyor/);
assert.ok(source.indexOf('this.backgroundCard(background,t)')>source.indexOf("id('chat-scroll-track')"),'background activity remains outside the scrolling transcript');
console.log('PASS: background activity, idle response distinction, stale/error states, bounded details, timing, quiet output and pinned placement');
