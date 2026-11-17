import { View, div, image, svg } from 'gpui-kit';
import { h_flex, v_flex, TextView, Editor, EditorState } from 'gpui-base';
import { theme, settings, focused, spaces, panes, terminals, layout, exec, appHome, run, notify, checking } from 'herdr';
import { groups, targetOf, visible, sizeLabel, ageLabel } from './logic.js';

const target = () => targetOf(focused(), spaces().find(s => s.active), panes(), terminals());

export default class Outputs extends View {
  init(_props, cx) {
    this.items = []; this.target = null; this.session = null; this.generation = 0;
    this.loading = false; this.loaded = false; this.error = ''; this.selected = null;
    this.preview = null; this.previewError = ''; this.opening = new Map(); this.openResults = new Map(); this.folded = new Set();
    if (checking()) return;
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  clearPreview() {
    this.code?.release(); this.code = null; this.selected = null; this.preview = null; this.previewError = '';
  }

  close() { this.code?.release(); }

  current(address, generation) {
    return this.target === address && target() === address && this.generation === generation;
  }

  async request(action, address, item, session) {
    const args = [`${appHome()}/mods/madlen-outputs/files.py`, '--terminal', address, '--action', action];
    if (item) args.push('--path', item.path, '--session', session);
    const response = await exec('python3', args, {timeout:40000});
    let data;
    try { data = JSON.parse(response.stdout); } catch { throw new Error('Çıktılar okunamadı. Yenileyerek tekrar deneyin.'); }
    if (data.error || response.code !== 0) throw new Error(data.error || 'Çıktılar okunamadı.');
    return data;
  }

  refresh(cx, force = false) {
    if (checking() || !visible(layout())) return;
    const address = target();
    if (address !== this.target) {
      this.target = address; this.generation++; this.items = []; this.session = null;
      this.loaded = false; this.loading = false; this.lastRefresh = 0; this.error = ''; this.clearPreview(); this.folded.clear();
    }
    if (!address || this.loading || (!force && this.lastRefresh && Date.now() - this.lastRefresh < 10000)) return;
    this.loading = true; this.lastRefresh = Date.now();
    const generation = this.generation;
    cx.spawn(async cx => {
      try {
        const data = await this.request('scan', address);
        if (!this.current(address, generation)) return;
        if (this.session && this.session !== data.session) this.clearPreview();
        this.items = data.items; this.session = data.session; this.loaded = true; this.error = '';
        if (this.selected && !this.items.some(f => f.path === this.selected.path)) this.clearPreview();
      } catch (error) {
        if (this.current(address, generation)) {
          this.error = String(error.message ?? error); this.items = []; this.session = null; this.clearPreview();
        }
      } finally { if (this.current(address, generation)) this.loading = false; cx.notify(); }
    });
  }

  actionKey(item) { return `${this.target}:${this.session}:${item.path}`; }

  open(item, cx) {
    const address = this.target, session = this.session;
    const key = this.actionKey(item), remote = address?.includes('/');
    if (!address || address !== target() || !session || this.opening.has(key)) return;
    const machine = remote ? address.split('/')[0] : null;
    this.openResults.delete(key);
    this.opening.set(key, remote ? `${machine.toUpperCase()} üzerinden indiriliyor…` : 'Açılıyor…'); cx.notify();
    cx.spawn(async cx => {
      let downloaded;
      try {
        if (remote) {
          const data = await this.request('download', address, item, session);
          downloaded = data.downloaded_path;
          if (!downloaded) throw new Error('Dosyanın indirme konumu alınamadı.');
          this.openResults.set(key, {path:downloaded});
          this.opening.set(key, 'İndirilenler’e kaydedildi · Açılıyor…'); cx.notify();
          const result = await exec('/usr/bin/open', [...(item.kind === 'archive' ? ['-R'] : []), downloaded], {timeout:15000});
          if (result.code !== 0) throw new Error(result.stderr || 'Dosya indirildi ancak uygulamada açılamadı.');
        } else await this.request('open', address, item, session);
        this.openResults.set(key, {path:downloaded, label:remote ? 'İndirildi · Açıldı' : 'Açıldı'});
      }
      catch (error) {
        const message = String(error.message ?? error);
        this.openResults.set(key, {path:downloaded, error:true, label:message});
        notify({title:downloaded ? 'Dosya indirildi, açılamadı' : 'Dosya açılamadı', body:message, level:'error'});
      }
      finally { this.opening.delete(key); cx.notify(); }
    });
  }

  show(item, event, cx) {
    if (event?.modifiers?.platform || !item.previewable) { this.open(item, cx); return; }
    const address = this.target, session = this.session, generation = this.generation;
    if (address !== target() || !session) return;
    this.clearPreview(); this.selected = item;
    cx.spawn(async cx => {
      try {
        const data = await this.request('preview', address, item, session);
        if (!this.current(address, generation) || this.selected !== item) return;
        this.preview = data;
        if (data.text !== undefined && item.kind !== 'markdown') {
          const t = theme();
          this.code = EditorState.new({language: item.ext === 'jsonl' || item.ext === 'jsonc' ? 'json' : item.ext,
            readonly:true, value:data.text, font_family:settings().font_family, font_size:12,
            syntax:{keyword:t.ansi5, string:t.ansi2, comment:t.dim, function:t.ansi4, type:t.ansi3, number:t.ansi1, constant:t.ansi6}});
        }
      } catch (error) {
        if (this.current(address, generation) && this.selected === item) this.previewError = String(error.message ?? error);
      } finally { cx.notify(); }
    });
  }

  button(id, icon, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(label)
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { cx.stop_propagation(); action(e, cx); })
      .child(svg(`mods/madlen-outputs/${icon}.svg`).size(15));
  }

  row(item, i) {
    const t = theme(), key = this.actionKey(item), opening = this.opening.get(key), result = this.openResults.get(key);
    return h_flex().id(`output-file-${i}`).min_h(58).flex_none().px(10).py(8).gap(9).items_center().rounded(8)
      .hover(s => s.bg(t.hover)).cursor_pointer().tooltip(`${item.path}\nTıkla: önizle · Cmd+tıkla: dış uygulamada aç`)
      .on_click((e, cx) => this.show(item, e, cx))
      .child(div().w(32).h(32).flex_none().rounded(7).bg(t.selected).flex().items_center().justify_center()
        .text_size(9).font_semibold().text_color(t.accent).child(item.kind === 'folder' ? svg('mods/madlen-chrome/folder.svg').size(16) : (item.ext || 'DOSYA').toUpperCase().slice(0, 5)))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(12.5).font_medium().whitespace_normal().line_height('16px').max_h(32).overflow_hidden().child(item.name))
        .child(div().text_size(10.5).text_color(result?.error ? t.blocked : opening || result?.label ? t.accent : t.dim)
          .whitespace_normal().line_height('14px').max_h(28).overflow_hidden()
          .tooltip(result?.path || result?.label || '')
          .child(opening || result?.label || `${ageLabel(item.mtime)}${item.kind === 'folder' ? '' : ` · ${sizeLabel(item.size)}`}`)))
      .when(Boolean(result?.path), el => el.child(this.button(`output-reveal-${i}`, 'folder', `İndirilenler’de göster: ${result.path}`,
        (_e, cx) => cx.spawn(async () => {
          const r = await exec('/usr/bin/open', ['-R', result.path]);
          if (r.code !== 0) notify({title:'Klasör açılamadı', body:r.stderr || 'İndirilen dosya bulunamadı.', level:'error'});
        }))))
      .child(opening ? svg('mods/madlen-chrome/spinner.svg').size(14).flex_none().text_color(t.accent).spin(900)
        : this.button(`output-open-${i}`, 'external', 'Dış uygulamada aç', (_e, cx) => this.open(item, cx)));
  }

  render(cx) {
    if (!checking() && visible(layout()) && (this.target !== target() || (!this.loaded && !this.loading && !this.error))) this.refresh(cx, true);
    const t = theme(), selected = this.selected, grouped = groups(this.items);
    const selectedKey = selected ? this.actionKey(selected) : null;
    const selectedProgress = this.opening.get(selectedKey), selectedResult = this.openResults.get(selectedKey);
    let index = 0;
    return v_flex().id('outputs-panel').size_full().min_h(0).min_w(0).rounded(10).overflow_hidden().bg(t.background)
      .border(1).border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (this.width !== size.width) { this.width = size.width; cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(10).gap(7).items_center().border_b(1).border_color(t.border)
        .when(Boolean(selected), el => el.child(this.button('outputs-back', 'back', 'Dosyalara dön', (_e, cx) => { this.clearPreview(); cx.notify(); })))
        .child(div().font_semibold().child('Çıktılar'))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(selected?.name || (this.loading ? 'Yenileniyor…' : this.items.length ? `${this.items.length} dosya` : '')))
        .when(Boolean(selected), el => el.child(this.button('outputs-open-preview', 'external', 'Dış uygulamada aç', (_e, cx) => this.open(selected, cx))))
        .child(this.button('outputs-refresh', 'refresh', 'Yenile', (_e, cx) => this.refresh(cx, true)))
        .child(this.button('outputs-close', 'close', 'Paneli kapat', () => run('layout.hide', {id:'panel'}))))
      .when(Boolean(selected && (selectedProgress || selectedResult?.label)), el => el.child(
        h_flex().flex_none().px(12).py(8).gap(6).items_center().bg(t.selected)
          .child(div().flex_1().min_w(0).text_size(11).text_color(selectedResult?.error ? t.blocked : t.accent)
            .child(selectedProgress || selectedResult?.label))
          .when(Boolean(selectedResult?.path), el => el.child(this.button('outputs-reveal-preview', 'folder', 'İndirilenler’de göster',
            (_e, cx) => cx.spawn(async () => { await exec('/usr/bin/open', ['-R', selectedResult.path]); }))))))
      .when(!selected, el => el.child(v_flex().id('outputs-list').flex_1().min_h(0).p(7).overflow_y_scrollbar()
        .when(Boolean(this.error), el => el.child(v_flex().p(16).gap(8)
          .child(div().font_medium().child('Çıktılar yüklenemedi'))
          .child(div().text_size(12).text_color(t.muted).child(this.error))))
        .when(!this.error && !grouped.length, el => el.child(v_flex().flex_1().p(24).gap(10).items_center().justify_center().text_center()
          .child(image('mods/madlen-nav/inbox.svg').size(30))
          .child(div().font_semibold().child(this.loading ? 'Çıktılar aranıyor…' : this.target ? 'Henüz çıktı yok' : 'Bir agent seçin'))
          .child(div().text_size(12).text_color(t.muted).child(this.loading ? 'Bu oturumun paylaştığı dosyalar kontrol ediliyor.' : this.target ? 'Agent bir dosya paylaştığında burada türüne göre listelenecek.' : 'Paylaşılan dosyaları görmek için soldaki listeden bir agent seçin.'))))
        .children(grouped.map(group => v_flex().flex_none().mb(8)
          .child(h_flex().id(`outputs-group-${group.id}`).h(30).px(6).gap(6).items_center().cursor_pointer().text_color(t.muted)
            .on_click((_e, cx) => { this.folded.has(group.id) ? this.folded.delete(group.id) : this.folded.add(group.id); cx.notify(); })
            .child(svg(`mods/madlen-chrome/chevron-${this.folded.has(group.id) ? 'right' : 'down'}.svg`).size(12))
            .child(div().text_size(11).font_semibold().child(group.label))
            .child(div().text_size(10).text_color(t.dim).child(String(group.items.length))))
          .when(!this.folded.has(group.id), el => el.children(group.items.map(item => this.row(item, index++))))))))
      .when(Boolean(selected), el => el
        .when(Boolean(this.previewError), el => el.child(div().p(16).text_color(t.muted).child(this.previewError)))
        .when(!this.preview && !this.previewError, el => el.child(div().p(16).text_color(t.dim).child('Önizleme açılıyor…')))
        .when(Boolean(this.preview?.image), el => el.child(v_flex().flex_1().min_h(0).p(10).overflow_y_scrollbar()
          .child(image(this.preview.image).w(Math.max(1, Math.min((this.width ?? 340) - 22, this.preview.width)))
            .h(Math.max(1, this.preview.height * Math.min(1, ((this.width ?? 340) - 22) / this.preview.width))))))
        .when(this.preview?.text !== undefined && selected?.kind === 'markdown', el => el.child(
          TextView.markdown(`output-md-${this.generation}-${selected.path}`, this.preview.text).selectable(true).scrollable(true).flex_1().min_h(0).p(12)
            .on_link_click((url, cx) => { if (/^https?:\/\//i.test(url)) cx.spawn(async () => { await exec('/usr/bin/open', [url]); }); })))
        .when(Boolean(this.code), el => el.child(Editor.new(this.code).flex_1().min_h(0)))
        .when(Boolean(this.preview?.truncated), el => el.child(div().p(8).text_size(11).text_color(t.dim).child('Belgenin ilk bölümü gösteriliyor. Tamamını dış uygulamada açabilirsiniz.'))));
  }
}
