import assert from 'node:assert/strict';
import fs from 'node:fs';
const moduleOf=path=>import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(new URL(path,import.meta.url))).toString('base64'));
const {summarizeTool,summarizeGroup,toolState}=await moduleOf('./theme/mods/madlen-chat/tool-summary.js');
const {visibleMessages}=await moduleOf('./theme/mods/madlen-chat/turns.js');
const command={id:'cmd',role:'tool',name:'mcp__functions__exec_command',status:'completed',
  text:JSON.stringify({cmd:'npm test',workdir:'/fixture/project',max_output_tokens:2000}),output:'Starting tests\nPASS: all checks passed\n'};
const original=JSON.stringify(command),summary=summarizeTool(command);
assert.equal(summary.label,'Terminal');assert.equal(summary.subject,'npm test');
assert.equal(summary.outcome,'PASS: all checks passed');
assert.deepEqual(summary.fields,[{label:'Komut',value:'npm test'},{label:'Klasör',value:'/fixture/project'}]);
assert.equal(summary.rawInput,command.text);assert.equal(summary.rawOutput,command.output);
assert.equal(JSON.stringify(command),original,'summarizing never changes raw data');
assert.equal(summarizeTool({name:'Read',text:'{"file_path":"/fixture/readme.md"}'}).subject,'/fixture/readme.md');
assert.equal(summarizeTool({name:'Dosya değişiklikleri',text:'[{"path":"a.ts"},{"path":"b.ts"}]'}).subject,'2 dosya · a.ts, b.ts');
const code='await tools.exec_command({cmd:"npm test"}); await tools.exec_command({cmd:"npm run build"});';
const orchestration=summarizeTool({name:'functions.exec',text:JSON.stringify({code})});
assert.equal(orchestration.subject,'2 çağrı · exec_command');
assert.ok(!orchestration.subject.includes(code),'orchestration source never becomes the default wall of text');
for(const text of ['{truncated JSON','plain command\nextra detail','```text\nraw\n```','<script>no evaluation</script>']){
  assert.equal(summarizeTool({text}).rawInput,text);
  assert.ok(summarizeTool({text}).subject.length<=150);
}
assert.ok(summarizeTool({text:'x'.repeat(10000)}).subject.endsWith('…'));
assert.equal(toolState(null).kind,'unknown');assert.equal(toolState('inProgress').kind,'working');
assert.equal(summarizeGroup([command,{...command,status:'failed'}]).state.kind,'failed');
const group={id:'tools-cmd',role:'tools',items:[command,{...command,id:'next',status:'inProgress'}]};
assert.deepEqual(visibleMessages([group],{}).map(x=>x.role),['tools']);
const open={'tools-cmd':true};
assert.deepEqual(visibleMessages([group],open).map(x=>x.role),['tools','tool-row','tool-row']);
open['tool-tools-cmd:cmd']=true;open['raw-tools-cmd:cmd']=true;
const shown=visibleMessages([group],open);
assert.deepEqual(shown.map(x=>x.role),['tools','tool-row','tool-detail','tool-row']);
assert.equal(shown[2].raw,true);assert.equal(shown[2].item,command);
const work={id:'work-turn',role:'work',items:[group]};
assert.deepEqual(visibleMessages([work],{'work-turn':true,...open}).map(x=>x.role),['work','tools','tool-row','tool-detail','tool-row']);
assert.equal(JSON.stringify(command),original);
console.log('PASS: concise tool summaries, structured details, exact raw content, truncated input, statuses and flat ordered disclosures');
