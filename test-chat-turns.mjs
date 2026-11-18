import assert from 'node:assert/strict';
import fs from 'node:fs';
const {conversation,workLabel,visibleMessages}=await import('data:text/javascript;base64,'+Buffer.from(
  fs.readFileSync(new URL('./theme/mods/madlen-chat/turns.js',import.meta.url))).toString('base64'));
const meta={turn_id:'turn',turn_status:'completed',duration_ms:464000,final_id:'final'};
const messages=[['user','u','Request'],['assistant','a','Starting'],['tool','t1','tool'],['tool','t2','tool'],
  ['assistant','b','Progress'],['tool','t3','tool'],['assistant','final','Final answer']].map(([role,id,text])=>({...meta,role,id,text}));
const done=conversation(messages,'idle');
assert.deepEqual(done.map(m=>m.role),['user','work','assistant']);
assert.equal(done[1].label,'Worked for 7m 44s');
assert.equal(done[2].text,'Final answer');
assert.deepEqual(done[1].items.map(m=>m.role),['assistant','tools','assistant','tools']);
assert.equal(done[1].items[1].items.length,2);
assert.deepEqual(visibleMessages(done,{}).map(m=>m.id),['u','work-turn','final']);
assert.deepEqual(visibleMessages(done,{'work-turn':true}).map(m=>m.id),['u','work-turn','a','tools-t1','b','tools-t3','final']);
for(const status of ['working','blocked']){
  const live=conversation(messages,status);
  assert.equal(live.some(m=>m.role==='work'),false,'live/blocked progress never collapses');
  assert.equal(live.filter(m=>m.role==='assistant').length,3);
}
for(const status of ['inProgress','interrupted']){
  assert.equal(conversation(messages.map(m=>({...m,turn_status:status})),'idle').some(m=>m.role==='work'),false);
}
assert.equal(conversation(messages.map(m=>({...m,final_id:null})),'idle').some(m=>m.role==='work'),false);
const next={turn_id:'next',turn_status:'inProgress',role:'assistant',id:'next',text:'Working'};
assert.equal(conversation([...messages,next],'working')[1].role,'work','completed historical turns still fold while the next one works');
assert.equal(conversation(messages.slice(1),'done')[0].id,done[1].id,'pagination keeps expansion IDs stable');
assert.equal(conversation([messages[0],messages.at(-1)],'idle').some(m=>m.role==='work'),false,'no empty work disclosure');
assert.equal(conversation(messages.map(({turn_id,...m})=>m),'idle').filter(m=>m.role==='tools').length,2,'legacy tool groups stay consecutive');
const midturn=[...messages.slice(0,3),{...meta,role:'user',id:'steer',text:'Human correction'},...messages.slice(3)];
assert.equal(conversation(midturn,'idle').some(m=>m.role==='work'),false,'human corrections remain visible in chronological order');
const local={id:'uncertain',role:'user',text:'Uncertain attempt',optimistic:true,state:'uncertain'};
const withLocal=conversation([local,...messages],'idle');
assert.deepEqual(withLocal.map(m=>m.id),['uncertain','u','work-turn','final'],'an old local attempt stays visible without preventing native work from folding');
assert.equal(withLocal[0],local,'local row actions retain the original outbox object');
for(const missing of [null,undefined,NaN,Infinity,-1])assert.equal(workLabel(missing),'Çalışma ayrıntıları');
assert.equal(workLabel(0),'Worked for 0s');
assert.equal(workLabel(3723000),'Worked for 1h 2m 3s');
assert.equal(messages.length,7,'grouping does not mutate the source history');
console.log('PASS: completed-turn folding, unchanged live/blocked/aborted flow, final answer, tool order, duration, pagination, legacy data and human corrections');
