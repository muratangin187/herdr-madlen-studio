import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const links=await import('data:text/javascript;base64,'+fs.readFileSync('theme/mods/madlen-chat/links.js').toString('base64'));
const {linkifyFiles,linkTarget}=links;
const href=path=>'madlen-file://open?path='+encodeURIComponent(path);
const path='/Users/fixture/report.html';
assert.equal(linkifyFiles(`Rapor: ${path}.`),`Rapor: [${path}](${href(path)}).`);
assert.equal(linkifyFiles(`Rapor: \`${path}\``),`Rapor: [\`${path}\`](${href(path)})`);
assert.equal(linkifyFiles('[Rapor](</tmp/Türkçe rapor (son).html:12>)'),`[Rapor](${href('/tmp/Türkçe rapor (son).html:12')})`);
assert.equal(linkifyFiles('[Rapor](/tmp/report(1).html "Başlık")'),`[Rapor](${href('/tmp/report(1).html')} "Başlık")`);
assert.equal(linkifyFiles('"/tmp/Türkçe rapor.html"'),`"[/tmp/Türkçe rapor.html](${href('/tmp/Türkçe rapor.html')})"`);
assert.equal(linkifyFiles('Dosya: ~/reports/report.html'),`Dosya: [~/reports/report.html](${href('~/reports/report.html')})`);
assert.equal(linkifyFiles('Bak (/tmp/report(1).html).'),`Bak ([/tmp/report(1).html](${href('/tmp/report(1).html')})).`);
assert.equal(linkifyFiles('`src/main.ts:12`'),`[\`src/main.ts:12\`](${href('src/main.ts:12')})`);
assert.equal(linkifyFiles('`main.ts:12:8`'),`[\`main.ts:12:8\`](${href('main.ts:12:8')})`);
assert.equal(linkifyFiles('[Kaynak](src/main.ts#L12)'),`[Kaynak](${href('src/main.ts#L12')})`);
assert.equal(linkifyFiles('[Rapor]: /tmp/report.html "Başlık"'),`[Rapor]: ${href('/tmp/report.html')} "Başlık"`);
for(const text of ['[Web](https://example.test/x/y)','https://example.test/x/y','![Resim](/tmp/image.png)',
  '```sh\ncat /tmp/report.html\n```','~~~\n/tmp/report.html\n~~~','    cat /tmp/report.html','`cat /tmp/report.html`','`1.0`','kesir 1/2']){
  assert.equal(linkifyFiles(text),text,`preserves ${text}`);
}
assert.equal(linkTarget(href('/tmp/Türkçe rapor.html')).path,'/tmp/Türkçe rapor.html');
assert.equal(linkTarget('file:///tmp/report.html').kind,'file');
assert.equal(linkifyFiles('<file:///tmp/report.html>'),`[file:///tmp/report.html](${href('file:///tmp/report.html')})`);
assert.equal(linkTarget('https://example.test').kind,'web');
for(const url of ['file://another-host/tmp/report.html','javascript:alert(1)','data:text/html,x','madlen-file://open?path=%ZZ','#heading'])assert.equal(linkTarget(url),null);

const requests=[],jobs=[],notifications=[];let active='ta';
const context={View:class{},...links,theme:()=>({}),appHome:()=>'/fixture/app',
  notify:x=>notifications.push(x),exec:(bin,args)=>new Promise((resolve,reject)=>requests.push({bin,args,resolve,reject}))};
const source=fs.readFileSync('theme/mods/madlen-chat/main.js','utf8').replace(/^import .*;\n/gm,'').replace('export default class MadlenChat','globalThis.MadlenChat=class MadlenChat');
vm.createContext(context);vm.runInContext(source,context);
const view=new context.MadlenChat();Object.assign(view,{openingLinks:new Set(),target:{terminal:'ta'},data:{session:'s'},currentTarget:()=>({terminal:active})});
const cx={notify(){},spawn(fn){const job=fn(this);jobs.push(job);return job;}};
const scope={terminal:'ta',session:'s',message:'old-message'};
view.openLink(href(path),scope,cx);view.openLink(href(path),scope,cx);
assert.equal(requests.length,1,'clicks are single-flight');
assert.equal(requests[0].args.includes('--message'),true);
assert.equal(requests[0].args.includes('old-message'),true);
assert.equal(requests[0].args.includes('open'),true);
requests[0].resolve({code:0,stdout:'{"ok":true}'});await jobs[0];assert.equal(view.linkStatus.label,'Açıldı');
active='other';view.openLink(href(path),scope,cx);assert.equal(requests.length,1,'stale message clicks cannot use a different tab');
active='ta';view.data.cached=true;view.openLink(href(path),scope,cx);assert.equal(requests.length,1,'cached history must be verified first');
view.data.cached=false;view.openLink('javascript:alert(1)',scope,cx);assert.equal(requests.length,1);
view.openLink('https://example.test',scope,cx);assert.equal(requests[1].bin,'/usr/bin/open');
requests[1].resolve({code:0});await jobs[1];

active='xps/t9';view.target={terminal:active};const remote={...scope,terminal:active};
view.openLink(href('/home/fixture/report.html'),remote,cx);
const job=jobs.at(-1);assert.equal(view.linkStatus.label,'Dosya indiriliyor…');
assert.equal(requests.at(-1).args.includes('xps/t9'),true);assert.equal(requests.at(-1).args.includes('download'),true);
active='other';const downloaded='/Users/fixture/Downloads/Herdr Çıktılar/xps/hash/report.html';
requests.at(-1).resolve({code:0,stdout:JSON.stringify({downloaded_path:downloaded,item:{kind:'html'}})});await new Promise(setImmediate);
assert.equal(requests.at(-1).bin,'/usr/bin/open');assert.deepEqual([...requests.at(-1).args],[downloaded],'download opens locally even after switching tabs');
requests.at(-1).resolve({code:0});await job;assert.equal(view.linkStatus.label,'İndirildi · Açıldı');
active=remote.terminal;view.openLink(href('/home/fixture/report.html'),remote,cx);const failed=jobs.at(-1),count=requests.length;
requests.at(-1).resolve({code:1,stdout:'{"error":"Bağlantı kesildi"}'});await failed;
assert.equal(requests.length,count,'download failure never opens a local lookalike');assert.equal(notifications.at(-1).body,'Bağlantı kesildi');
assert.equal(view.openingLinks.size,0);
view.openLink(href('/home/fixture/report.html'),remote,cx);const failedOpen=jobs.at(-1);
requests.at(-1).resolve({code:0,stdout:JSON.stringify({downloaded_path:downloaded,item:{kind:'html'}})});await new Promise(setImmediate);
requests.at(-1).resolve({code:1,stderr:'Open failed'});await failedOpen;
assert.equal(view.linkStatus.path,downloaded,'a downloaded file remains revealable after an open failure');
assert.equal(notifications.at(-1).title,'Dosya indirildi, açılamadı');
console.log('PASS: file linkification, Markdown preservation, local/web opening, exact message/session binding, remote Downloads transfer, stale clicks, deduplication and failures');
