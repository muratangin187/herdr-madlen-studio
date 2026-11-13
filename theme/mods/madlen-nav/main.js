import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, theme, run, openOverlay, focused, panes, spaces, terminals, setShared, exec, appHome, notify } from "herdr";
const find = (n,id) => n?.id===id ? n : (n?.children??[]).map(c=>find(c,id)).find(Boolean);
export default class MadlenNav extends View {
  outputs(cx) {
    const f=focused(), space=spaces().find(s=>s.active);
    const target=f?.terminal??f?.agent??panes().find(p=>p.tab===space?.tabs?.find(t=>t.active)?.id&&p.terminal)?.terminal??terminals().find(t=>t.labels?.['herdr.chat']===f?.pane)?.address;
    setShared('outputs-browser.target',target??null);
    cx.spawn(async()=>{
      try {
        if(!target) throw new Error('Önce bir agent oturumu seçin.');
        const r=await exec('/usr/bin/python3',[`${appHome()}/mods/madlen-nav/outputs.py`,'--terminal',target]);
        if(r.code!==0) throw new Error(r.stderr||'Çıktılar açılamadı.');
      } catch(e) {notify({title:'Çıktılar açılamadı',body:String(e.message??e),level:'error'});}
    });
  }
  render() {
    const t=theme(), root=layout(), collapsed=(find(root,'sidebar')?.size?.px??320)<160;
    const panel=find(root,'panel'), fileOn=panel&&!panel.hidden&&find(root,'panel-body')?.active==='files', prsOn=panel&&!panel.hidden&&find(root,'panel-body')?.active==='previews';
    const row=(id,icon,label,on,action)=>h_flex().id(id).h(42).flex_none().px(collapsed?8:14).gap(12).items_center().rounded(10)
      .bg(on?t.selected:t.chrome).text_color(on?t.accent:t.muted).hover(s=>s.bg(t.hover)).cursor_pointer().tooltip(label)
      .when(collapsed,e=>e.w(44).justify_center())
      .on_click((_e,cx)=>action(cx)).child(image(`mods/madlen-nav/${icon}.svg`).size(23).flex_none())
      .when(!collapsed,e=>e.child(div().text_size(15).child(label)));
    return v_flex().size_full().px(collapsed?0:14).gap(4).bg(t.chrome).font_family('Helvetica Neue')
      .when(collapsed,e=>e.items_center())
      .child(row('nav-home','home','Çalışma atölyesi',!panel||panel.hidden,()=>{run('layout.hide',{id:'panel'});}))
      .child(row('nav-agent','chat','Yeni agent',false,()=>openOverlay({mod:'new-menu',kind:'popup',width:250,height:512})))
      .child(row('nav-files','folders','Dosyalar',fileOn,()=>{run('layout.select',{stack:'panel-body',child:'files'});run('layout.show',{id:'panel'});}))
      .child(row('nav-outputs','inbox','Çıktılar',false,cx=>this.outputs(cx)))
      .child(row('nav-prs','prs',"PR'lar",prsOn,()=>{if(prsOn){run('layout.hide',{id:'panel'});return;}run('layout.select',{stack:'panel-body',child:'previews'});run('layout.show',{id:'panel'});}));
  }
}
