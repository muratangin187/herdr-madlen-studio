import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, settings, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(id === "search" ? "Çalışma alanı ara" : "Kenar çubuğunu daralt / genişlet").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.section) return h_flex().size_full().px(22).items_center().bg(t.chrome).font_family("Helvetica Neue").text_size(10).font_semibold().text_color(t.dim)
      .when(!collapsed, el=>el.child(props().section));
    const root = layout(), w = window();
    // On the macOS rail leave the window buttons clear; the agents list can expand it.
    if (collapsed) return v_flex().size_full().bg(t.chrome).items_center().justify_end().pb(5)
      .when(!(w?.platform === "macos" && !w.fullscreen && root?.traffic_lights), el => el.child(this.button("sidebar-expand", "»", toggleSidebar)));
    const lightsPadding = w?.platform === "macos" && !w.fullscreen && root?.traffic_lights
      ? (root.traffic_lights[0] + 64) / settings().zoom : 14;
    return h_flex().size_full().bg(t.chrome).pl(lightsPadding).pr(10).gap(4).items_center().text_size(12)
      .child(h_flex().flex_1().items_center().child(image("mods/madlen-chrome/wordmark.svg").w(82).h(20)))

      .child(h_flex().id("sidebar-toggle").h(24).px(5).gap(3).items_center().rounded(6).font_family("Helvetica Neue").text_size(11).text_color(t.dim).cursor_pointer().hover(s=>s.bg(t.hover)).tooltip("Kenar çubuğunu daralt / genişlet").on_mouse_down("left", (_e,cx)=>cx.stop_propagation()).on_click(toggleSidebar).child(svg("mods/madlen-chrome/chevron-left.svg").size(11)).child("Daralt"));
  }
}
