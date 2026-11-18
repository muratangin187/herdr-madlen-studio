export function elapsedLabel(seconds) {
  if(!Number.isFinite(seconds)||seconds<0)return '';
  const value=Math.floor(seconds),hours=Math.floor(value/3600),minutes=Math.floor(value%3600/60);
  return hours?`${hours} sa ${minutes} dk`:minutes?`${minutes} dk ${value%60} sn`:`${value} sn`;
}

export function backgroundView(background,{cached=false,error=false}={}) {
  const jobs=Array.isArray(background?.jobs)?background.jobs:[],stale=Boolean(cached||error);
  const running=jobs.filter(j=>j.status==='running').length,unknown=jobs.filter(j=>j.status==='unknown').length;
  const failed=jobs.some(j=>j.status==='failed'),stopped=jobs.some(j=>j.status==='stopped');
  const unavailable=Boolean(background?.unavailable),busy=running>0&&!stale;
  const label=stale?'Arka plan · kaydedilen durum':running?`Arka planda ${running} iş çalışıyor`:unknown?'Arka plan durumu doğrulanamadı':unavailable?'Arka plan bilgisi alınamadı':failed?'Arka plan işi başarısız':stopped?'Arka plan işi durduruldu':'Arka plan işi tamamlandı';
  return {jobs,stale,running,unknown,failed,unavailable,busy,label,show:jobs.length>0||unavailable,
    detail:stale?'Güncel durum bekleniyor.':running?'Yanıt bitse de bu işler çalışmaya devam eder.':unknown||unavailable?'Terminalden güncel durumu kontrol edebilirsiniz.':failed?'Komutun hata çıktısını ayrıntılardan görebilirsiniz.':'',
    footer:stale?'Arka planın güncel durumu bekleniyor…':running?`Yanıt hazır · arka planda ${running} iş sürüyor`:unknown||unavailable?'Yanıt hazır · arka plan durumu doğrulanamadı':failed?'Yanıt hazır · arka plan işi başarısız':null};
}
