// Live workspace context. All actions use Herdr commands; no parallel state model.
import { View, div, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, settings, layout, run, updates } from "herdr";

const find = (n, id) => n?.id === id ? n : (n?.children ?? []).map(c => find(c, id)).find(Boolean);

export default class MadlenHeading extends View {
  render() {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const root = layout(), panel = find(root, 'panel');
    const prsOn = panel && !panel.hidden && find(root, 'panel-body')?.active === 'previews';
    const outputsOn = panel && !panel.hidden && find(root, 'panel-body')?.active === 'outputs';
    const chosen = root?.theme;
    const dark = typeof chosen === "string" ? chosen === "madlen-night" : Boolean(settings().dark);
    return h_flex().id("madlen-heading").size_full().min_w(0).px(4).gap(2).items_center().justify_end().bg(t.canvas)
      .child(div().id("madlen-prs").size(28).flex_none().flex().items_center().justify_center().rounded(6)
        .bg(prsOn ? t.selected : t.canvas).hover(s => s.bg(t.hover)).cursor_pointer()
        .tooltip("PR'lar").on_mouse_down("left", stop)
        .on_click(() => {
          if (prsOn) { run('layout.hide', {id:'panel'}); return; }
          run('layout.select', {stack:'panel-body', child:'previews'});
          run('layout.show', {id:'panel'});
        }).child(image("mods/madlen-nav/prs.svg").size(17)))
      .child(div().id("madlen-outputs").size(28).flex_none().flex().items_center().justify_center().rounded(6)
        .bg(outputsOn ? t.selected : t.canvas)
        .hover(s => s.bg(t.hover)).cursor_pointer().tooltip("Çıktılar").on_mouse_down("left", stop)
        .on_click(() => {
          if (outputsOn) { run('layout.hide', {id:'panel'}); return; }
          run('layout.select', {stack:'panel-body', child:'outputs'});
          run('layout.show', {id:'panel'});
        }).child(image("mods/madlen-nav/inbox.svg").size(19)))
      .child(div().id("madlen-appearance").size(28).flex_none().flex().items_center().justify_center().rounded(6)
        .hover(s => s.bg(t.hover)).cursor_pointer()
        .tooltip(dark ? "Açık temaya geç" : "Koyu temaya geç").on_mouse_down("left", stop)
        .on_click(() => run("layout.set", {layout:{...layout(), theme:dark ? "madlen-cream" : "madlen-night"}}))
        .child(image(`mods/madlen-heading/appearance-${dark ? "sun" : "moon"}.svg`).size(19)))
      .child(div().id("madlen-settings").size(28).flex_none().relative().flex().items_center().justify_center().rounded(6)
        .hover(s => s.bg(t.hover)).cursor_pointer()
        .tooltip("Ayarlar").on_mouse_down("left", stop).on_click(() => run("app.settings"))
        .child(image("mods/madlen-heading/settings-color.svg").size(19))
        .when(Boolean(updates().app.ready), el => el.child(div().absolute().top(2).right(2).size(5).rounded_full().bg(t.accent))));
  }
}
