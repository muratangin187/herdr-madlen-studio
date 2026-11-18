const FILE_PREFIX='madlen-file://open?path=';
const pathLike=text=>/^(?:\/(?!\/)|~\/|\.{1,2}\/|file:\/\/)/i.test(text)
  || (!/^[\w+.-]+:(?!\d)/.test(text)&&/^[^\s<>]+(?:\/[^\s<>]+|\.[a-zA-Z][a-zA-Z0-9]{0,9})(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)?$/.test(text));
const fileHref=path=>FILE_PREFIX+encodeURIComponent(path);

export function linkTarget(url) {
  if(/^https?:\/\//i.test(url))return {kind:'web',url};
  if(url.startsWith(FILE_PREFIX)){
    try{return {kind:'file',path:decodeURIComponent(url.slice(FILE_PREFIX.length))};}catch{return null;}
  }
  if(/^file:\/\//i.test(url)&&!/^file:\/\/(?:localhost)?\//i.test(url))return null;
  return pathLike(url)?{kind:'file',path:url}:null;
}

function destination(raw){
  const match=raw.match(/^(\s*)(?:<([^>\n]+)>|(\S+?))(\s+["'][^\n]*["'])?(\s*)$/);
  if(!match)return raw;
  const path=match[2]??match[3];
  return linkTarget(path)?.kind==='file'?`${match[1]}${fileHref(path)}${match[4]??''}${match[5]}`:raw;
}

function trimPunctuation(text){
  text=text.replace(/[.,;:!?]+$/,'');
  for(const [open,close] of [['(',')'],['[',']'],['{','}']]){
    while(text.endsWith(close)&&text.split(close).length>text.split(open).length)text=text.slice(0,-1);
  }
  return text;
}

// Protect existing links, web URLs and inline code before finding plain paths.
const TOKENS=/!?\[[^\]\n]*\]\((?:<[^>\n]*>|(?:[^()\n]|\([^()\n]*\))*)\)|(`+)[^\n]*?\1|https?:\/\/[^\s<`]+|<(?:file:\/\/(?:localhost)?\/|\/(?!\/)|~\/)[^>\n]+>|["'](?:file:\/\/|\/|~\/)[^"'\n]+["']|(?:file:\/\/(?:localhost)?\/|\/(?!\/)|~\/|\.{1,2}\/)[^\s`"<>]+/g;

function inline(text){
  return text.replace(TOKENS,(token,_ticks,offset)=>{
    const link=token.match(/^(!?\[[\s\S]*\]\()([\s\S]*)(\))$/);
    if(link)return token.startsWith('!')?token:link[1]+destination(link[2])+link[3];
    if(token.startsWith('`')){
      const ticks=token.match(/^`+/)[0],path=token.slice(ticks.length,-ticks.length).trim();
      return pathLike(path)?`[${token}](${fileHref(path)})`:token;
    }
    if(/^https?:\/\//i.test(token))return token;
    if(/^["'<]/.test(token)){
      const path=token.slice(1,-1);
      const link=`[${path.replace(/[\[\]]/g,'\\$&')}](${fileHref(path)})`;
      return token[0]==='<'?link:`${token[0]}${link}${token.at(-1)}`;
    }
    if(offset&&/[\w/:\\]/.test(text[offset-1]))return token;
    const path=trimPunctuation(token);
    return `[${path.replace(/[\[\]]/g,'\\$&')}](${fileHref(path)})${token.slice(path.length)}`;
  });
}

export function linkifyFiles(text){
  let fence=null;
  return String(text??'').split('\n').map(line=>{
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(fence){
      if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&line.slice(marker[0].length).trim()==='')fence=null;
      return line;
    }
    if(marker){fence=marker[1];return line;}
    if(/^(?: {4}|\t)/.test(line))return line;
    const reference=line.match(/^( {0,3}\[[^\]]+\]:\s*)(.*)$/);
    return reference?reference[1]+destination(reference[2]):inline(line);
  }).join('\n');
}
