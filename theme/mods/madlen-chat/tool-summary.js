const compact=value=>String(value??'').replace(/\s+/g,' ').trim();
const shorten=(value,max=150)=>{const text=compact(value);return text.length>max?text.slice(0,max-1)+'…':text;};
const readable=value=>typeof value==='string'?value:JSON.stringify(value);

function argumentsOf(text){
  try{const value=typeof text==='string'?JSON.parse(text):text;return value&&typeof value==='object'?value:null;}
  catch(_e){return null;}
}

export function toolState(status){
  if(['failed','error','errored'].includes(status))return {kind:'failed',label:'Hata',glyph:'!'};
  if(['inProgress','in_progress','running','pending'].includes(status))return {kind:'working',label:'Çalışıyor',glyph:'…'};
  if(['completed','complete','success','succeeded'].includes(status))return {kind:'done',label:'Tamamlandı',glyph:'✓'};
  return {kind:'unknown',label:'Araç kaydı',glyph:'·'};
}

function resultText(value){
  const parsed=argumentsOf(value);
  if(parsed?.content?.length)return parsed.content.filter(c=>c?.type==='text').map(c=>c.text??'').join('\n');
  return typeof value==='string'?value:readable(value??'');
}

export function summarizeTool(item){
  const name=String(item.name??'Araç'),shortName=name.split(/__|\./).at(-1),lower=shortName.toLowerCase();
  const args=argumentsOf(item.text),fields=[];
  const field=(label,key,max=320)=>{
    const value=args?.[key];
    if(value!==undefined&&value!==null&&readable(value)!=='')fields.push({label,value:shorten(readable(value),max)});
  };
  field('Açıklama','description');field('Komut','cmd');field('Komut','command');
  field('Dosya','file_path');field('Dosya','path');field('Klasör','workdir');field('Klasör','cwd');
  field('Arama','pattern');field('Arama','query');field('Adres','url');field('Hedef','ref_id');field('Hedef','target');
  let label=shortName,subject='';
  if(/^(bash|exec_command|terminal komutu|shell|run_command)$/.test(lower))label='Terminal';
  else if(/^(read|read_file|file_read|view_image)$/.test(lower))label=lower==='view_image'?'Görseli aç':'Dosya oku';
  else if(/^(edit|multiedit|apply_patch|file_edit|dosya değişiklikleri)$/.test(lower))label='Dosya düzenle';
  else if(/^(write|write_file|file_write)$/.test(lower))label='Dosya yaz';
  else if(/^(grep|glob|search|websearch|web araması|search_query)$/.test(lower))label='Ara';
  else if(/^(wait|wait_agent|write_stdin|sleep)$/.test(lower))label='Bekle';
  else if(/^(exec|parallel)$/.test(lower))label='Araçlar';
  if(Array.isArray(args)){
    const paths=args.map(a=>a?.path).filter(Boolean);
    subject=paths.length?`${paths.length} dosya · ${paths.join(', ')}`:`${args.length} kayıt`;
  }else if(args?.code){
    const calls=[...String(args.code).matchAll(/\btools\.([\w]+)\s*\(/g)].map(m=>m[1]);
    subject=calls.length?`${calls.length} çağrı · ${[...new Set(calls)].join(', ')}`:'Kod çalıştırma';
    // Describe orchestration without executing or dumping its JavaScript.
    if(calls.length)fields.unshift({label:'Çağrılar',value:shorten([...new Set(calls)].join(', '),320)});
  }else{
    subject=args?.description??args?.cmd??args?.command??args?.file_path??args?.path??args?.pattern??args?.query??args?.url??args?.target??args?.cell_id??'';
    if(!subject&&args?.search_query)subject=args.search_query.map(q=>q.q??'').join(' · ');
    if(!subject&&args?.open)subject=args.open.map(q=>q.ref_id??'').join(' · ');
    if(!subject&&args)subject=Object.keys(args).filter(k=>!['timeout','timeout_ms','yield_time_ms','max_output_tokens'].includes(k)).slice(0,4).join(', ');
    if(!args)subject=String(item.text??'').split('\n').find(line=>line.trim())??'';
  }
  const output=resultText(item.output),state=toolState(item.status);
  const lines=output.split('\n').map(line=>line.trim()).filter(Boolean);
  const outcome=lines.find(line=>/^(PASS[: ]|FAIL[: ]|OK\b|FAILED\b|Error[: ]|error[: ]|Tests:|Test Suites:|Ran \d+ tests|Process exited with code|Exit code:|Script completed)/.test(line))??lines[0]??'';
  return {label,subject:shorten(readable(subject)),fields:fields.slice(0,5),
    outcome:shorten(outcome,240),state,rawInput:String(item.text??''),rawOutput:typeof item.output==='string'?item.output:readable(item.output??'')};
}

export function summarizeGroup(items){
  const states=items.map(item=>toolState(item.status));
  const state=states.find(s=>s.kind==='failed')??states.find(s=>s.kind==='working')??states.find(s=>s.kind==='unknown')??toolState('completed');
  const latest=items.at(-1),summary=latest?summarizeTool(latest):null;
  return {state,preview:summary?[summary.label,summary.subject].filter(Boolean).join(' · '):''};
}
