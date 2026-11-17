// Minimal pane controls; Chat and Terminal share the same icon-only switch.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, setShared } from "herdr";

export default class Pane extends View {
  me() { return panes().find(p => p.pane === props()?.pane); }

  button(t,id,icon,label,action,active=false) {
    const path=icon==='terminal' ? 'mods/madlen-chrome/terminal.svg' : `mods/madlen-pane/${icon}.svg`;
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(4)
      .tooltip(label).cursor_pointer().bg(active?t.selected:t.canvas).text_color(active?t.accent:t.dim)
      .hover(s=>s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
      .on_click((_e,cx)=>{cx.stop_propagation();action();})
      .child(svg(path).size(12));
  }

  render() {
    const t=theme(),p=this.me();
    if(!p)return div();
    const pane=p.pane;
    return h_flex().id(`pane-head-${pane}`).size_full().px(6).gap(2).items_center().bg(t.canvas)
      .on_click(()=>run('pane.focus',{pane}))
      .child(div().flex_1())
      .when(Boolean(p.terminal)&&['codex','claude'].some(a=>(p.app??p.program?.name??'').toLowerCase().includes(a)),el=>el
        .child(h_flex().id(`chat-toggle-${pane}`).gap(0).rounded(4)
          .child(this.button(t,`open-chat-${pane}`,'chat','Sohbet',()=>{
            setShared('madlen.chat.target',{terminal:p.terminal,pane,tab:p.tab});
            run('layout.select',{stack:'conversation-surface',child:'madlen-chat-view'});
          }))
          .child(this.button(t,`terminal-selected-${pane}`,'terminal','Terminal',()=>run('pane.focus',{pane}),true))))
      .child(this.button(t,`ph-r-${pane}`,'split-right','Sağa böl',()=>run('pane.split',{direction:'right',pane})))
      .child(this.button(t,`ph-d-${pane}`,'split-down','Alta böl',()=>run('pane.split',{direction:'down',pane})))
      .child(this.button(t,`ph-z-${pane}`,p.zoomed?'unzoom':'zoom',p.zoomed?'Bölünmüş görünüme dön':'Paneli büyüt',()=>run('pane.zoom',{pane})))
      .child(this.button(t,`ph-x-${pane}`,'close','Paneli kapat',()=>run('pane.close',{pane})));
  }
}
