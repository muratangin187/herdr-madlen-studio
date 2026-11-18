import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const turns=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(new URL('./theme/mods/madlen-chat/turns.js',import.meta.url))).toString('base64'));
const {questionView,conversation,visibleMessages,liveQuestionMessage}=turns;
const question={id:'q',role:'question',status:'inProgress',question_state:'pending',questions:[{id:'color',question:'Renk?',options:[{label:'Açık'},{label:'Koyu'}]}]};
assert.equal(questionView(question).label,'Yanıt bekliyor');
const answered={...question,question_state:'answered',answers:{'Renk?':'Koyu'}};
assert.deepEqual(questionView(answered).questions[0].selected,['Koyu']);
assert.deepEqual(questionView({...answered,answers:{color:{answers:['Açık','Koyu']}}}).questions[0].selected,['Açık','Koyu']);
assert.equal(questionView({...question,question_state:'closed'}).label,'Geçmiş soru');
assert.equal(questionView({...question,question_state:'failed'}).label,'Tamamlanmadı');
assert.deepEqual(questionView({...question,questions:[{title:'Not?',options:null}]}).questions[0].options,[]);
assert.equal(visibleMessages(conversation([{id:'u',role:'user',text:'Start'},question],'blocked'),{}).at(-1).role,'question');

// Exercise the actual native renderer and disclosure callbacks.
function element(){
  const node={nodes:[],events:{}};
  const proxy=new Proxy(node,{get(target,key){
    if(key in target)return target[key];
    if(key==='child')return value=>{node.nodes.push(value);return proxy;};
    if(key==='children')return values=>{node.nodes.push(...values);return proxy;};
    if(key==='when')return (condition,fn)=>{if(condition)fn(proxy);return proxy;};
    if(key==='on_click')return fn=>{node.events.click=fn;return proxy;};
    return ()=>proxy;
  }});
  return proxy;
}
const source=fs.readFileSync(new URL('./theme/mods/madlen-chat/main.js',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replace('export default class MadlenChat','globalThis.MadlenChat=class MadlenChat');
const context={View:class {},questionView,liveQuestionMessage,div:element,h_flex:element,v_flex:element};
vm.createContext(context);vm.runInContext(source,context);
const view=new context.MadlenChat();Object.assign(view,{viewportWidth:800,expanded:{},data:{cached:false}});
view.button=(_id,label)=>element().child(label);
const text=node=>typeof node==='string'?node:(node?.nodes??[]).map(text).join('\n');
const theme={accent:'#ff9900',done:'#008800',dim:'#888888',border:'#333333'};
let card=view.question(question,theme);
assert.match(text(card),/Yanıt bekliyor/);assert.match(text(card),/Terminalde yanıtla/);assert.match(text(card),/○  Koyu/);
card=view.question(answered,theme);
assert.match(text(card),/Yanıtlandı/);assert.match(text(card),/Yanıt: Koyu/);
assert.doesNotMatch(text(card),/Terminalde yanıtla|○  Açık/);
card.nodes[0].events.click({}, {notify(){}});
assert.match(text(view.question(answered,theme)),/●  Koyu/);
view.data.cached=true;
assert.doesNotMatch(text(view.question(question,theme)),/Terminalde yanıtla/);
assert.doesNotThrow(()=>view.question({...question,questions:[{title:'Not?',options:null},{title:'Renk?',options:['Açık','Koyu']}]},theme));
view.data={messages:[],cached:false};
const livePrompt={kind:'question',fingerprint:'fixture',question:'Testi nerede yapalım?',options:[{label:'Ayrı ortam',description:'Yeni bir örnekle çalış.'}]};
card=view.blockedPrompt(livePrompt,theme);
assert.match(text(card),/Testi nerede yapalım/);assert.match(text(card),/Ayrı ortam/);assert.match(text(card),/Yeni bir örnekle çalış/);
assert.match(text(card),/Terminalde yanıtla/);
assert.equal(liveQuestionMessage(livePrompt,[{...question,questions:[{question:'Testi nerede\nyapalım?'}]}]),null,'a recorded pending question is not duplicated');
assert.match(text(view.blockedPrompt({kind:'blocked',summary:'Bekleyen işlem için bir seçim gerekiyor.'},theme)),/Bekleyen işlem için bir seçim gerekiyor/);
console.log('PASS: question visibility, answers, compact cards, selected options, disclosure, cache guard and free-text questions');
