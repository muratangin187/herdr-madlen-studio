export function workLabel(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Çalışma ayrıntıları';
  const total=Math.floor(milliseconds/1000), hours=Math.floor(total/3600), minutes=Math.floor((total%3600)/60), seconds=total%60;
  return `Worked for ${hours ? `${hours}h ` : ''}${minutes || hours ? `${minutes}m ` : ''}${seconds}s`;
}

export function toolGroups(messages) {
  const out=[];
  for(const message of messages){
    if(message.role==='tool'){
      if(out.at(-1)?.role==='tools')out.at(-1).items.push(message);
      else out.push({id:`tools-${message.id}`,role:'tools',items:[message]});
    }else out.push(message);
  }
  return out;
}

export function questionView(message) {
  const state=message.question_state??(message.status==='failed'?'failed':message.output||message.status==='completed'?'closed':'pending');
  const pending=state==='pending',answered=state==='answered';
  const answers=message.answers??{};
  const questions=(message.questions??[]).map(q=>{
    const title=q.question??q.title??q.header??'Soru';
    const value=answers[q.id]??answers[title];
    const selected=typeof value==='string'?[value]:Array.isArray(value)?value:Array.isArray(value?.answers)?value.answers:[];
    return {...q,title,selected,options:Array.isArray(q.options)?q.options:[]};
  });
  return {state,pending,answered,questions,label:pending?'Yanıt bekliyor':answered?'Yanıtlandı':state==='failed'?'Tamamlanmadı':'Geçmiş soru'};
}

export function liveQuestionMessage(prompt,messages=[]) {
  if(!prompt||!['question','blocked'].includes(prompt.kind))return null;
  const question=prompt.question??prompt.summary??'Agent yanıtınızı bekliyor.';
  const normalize=text=>String(text??'').replace(/\s+/g,' ').trim();
  if(prompt.kind==='question'&&messages.some(m=>m.role==='question'&&m.question_state==='pending'&&
    m.questions?.some(q=>normalize(q.question??q.title)===normalize(question))))return null;
  return {id:`live-${prompt.fingerprint??'blocked'}`,role:'question',question_state:'pending',status:'inProgress',
    questions:[{question,options:prompt.options??[]}]};
}

export function conversation(messages,liveStatus) {
  const blocks=[];
  for(const message of messages){
    const last=blocks.at(-1),turn=message.optimistic?`outbox-${message.id}`:message.turn_id;
    if(last && last.id===turn)last.items.push(message);
    else blocks.push({id:turn,items:[message]});
  }
  return blocks.flatMap((block,index)=>{
    const items=block.items, meta=items.find(m=>m.turn_status==='completed' && m.final_id);
    const finalIndex=meta ? items.findIndex(m=>m.id===meta.final_id && m.role==='assistant' && m.text) : -1;
    const firstWork=items.findIndex(m=>m.role!=='user');
    const live=index===blocks.length-1 && !['idle','done'].includes(liveStatus);
    const hasHumanInside=firstWork>=0 && items.slice(firstWork).some(m=>m.role==='user');
    if(!block.id || !meta || finalIndex<0 || live || hasHumanInside)return toolGroups(items);
    const history=items.slice(firstWork,finalIndex);
    if(firstWork<0 || !history.length)return toolGroups(items);
    return [...items.slice(0,firstWork),
      {id:`work-${block.id}`,role:'work',label:workLabel(meta.duration_ms),items:toolGroups(history)},
      ...toolGroups(items.slice(finalIndex))];
  });
}

export function visibleMessages(groups,expanded) {
  return groups.flatMap(group=>{
    if(group.role==='work')return expanded[group.id]?[group,...visibleMessages(group.items,expanded)]:[group];
    if(group.role!=='tools'||!expanded[group.id])return [group];
    return [group,...group.items.flatMap(item=>{
      const key=`${group.id}:${item.id}`,row={id:`tool-row-${key}`,role:'tool-row',key,item};
      return expanded[`tool-${key}`]?[row,{...row,id:`tool-detail-${key}`,role:'tool-detail',raw:Boolean(expanded[`raw-${key}`])}]:[row];
    })];
  });
}
