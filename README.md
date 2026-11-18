# Madlen Studio for Herdr

Madlen renkleriyle açık/koyu tema, sade agent listesi ve Codex / Claude Code oturumları için Chat–Terminal görünümü.

Sekmeler, PR'lar ve Çıktılar simgeleri, tema seçimi ve ayarlar dar aralıklı tek üst satırda. Sol çubukta agent listesi ve kullanım bölümü var; agent başlıkları iki satıra kadar gösterilir. Küçük Madlen logosu ve Daralt düğmesi pencere düğmeleriyle aynı hizada. Sohbette sağa hizalı kullanıcı mesajları, açılır çalışma kayıtları ve genişliğe uyarlanan mesaj alanı bulunur. Sekme dönüşlerinde sohbet ve kaydırma konumu bellekte korunur.

## Agentına bunu yapıştır

[AGENT-INSTALL.md](AGENT-INSTALL.md) içindeki metni kopyala. Agent Herdr kurulumunu kontrol eder, paketi kurar ve sonucu doğrular.

## Kurulum

**Doğrulanan ortam:** macOS, Herdr Desktop 0.1.14, hc 0.1.19, Python 3.9+. Herdr açık olmalı; `herdr-app`, `hc` ve `python3` PATH üzerinde bulunmalı. Bu paket Herdr veya AI sağlayıcısı kurmaz; kendi hesaplarınla giriş yapmalısın. Linux/Windows için henüz doğrulanmış kurulum yok.

```sh
git clone --branch v1.0.3 --depth 1 https://github.com/muratangin187/herdr-madlen-studio.git
cd herdr-madlen-studio
python3 install.py
```

Kurulum yalnızca `madlen-*` modlarını, iki temayı ve `madlen-studio` düzenini kopyalar. Çalışan agentlara, sohbet kayıtlarına, makinelere, sekmelere veya genel ayarlara dokunmaz. Aynı adlı kişisel dosyalar varsa durur. Önceki düzene dönüş komutunu ekrana yazar.

Görünümü değiştirmeden kurmak: `python3 install.py --no-activate`.
Farklı Herdr klasörü: `python3 install.py --home /path/to/herdr-home`.

### İsteğe bağlı bileşenler

**Kullanım halkaları:** Mevcut `quota-axi` kurulumunu kullanır. Bu makinede doğrulanan sürüm 0.1.69. Kurulu değilse tema çalışır; kullanım verisi gösterilemez. Tema kurulumu sağlayıcı kimlik bilgilerini kopyalamaz veya oluşturmaz. Ayrı aracın kurulumu ve izinleri için [quota-axi](https://github.com/kunchenguid/quota-axi) belgesine bakın.

**Ayrı Çıktılar uygulaması (isteğe bağlı):** Üst çubuktaki Çıktılar simgesi, ek kurulum gerektirmeden Herdr'ın sağ panelini açar. Sürükleme ve gelişmiş HTML/JSON görüntüleme için eski ayrı macOS uygulaması da kurulabilir; `swiftc` (Xcode Command Line Tools) gerekir:

```sh
python3 install.py --with-outputs
```

Bu seçenek ayrıca `outputs-browser` modunu ve `~/.local/share/herdr-outputs/Herdr Outputs.app` uygulamasını kurar. Mevcut uyumlu Çıktılar eklentisini yedekler. Tema kurulumu sonradan başarısız olursa ayrı kurulmuş Çıktılar bileşeni kalabilir. Ayrıntılar: [Çıktılar belgesi](extras/outputs/README.md).

## Chat nasıl çalışır?

- Mevcut Codex/Claude Code terminaline bağlanır. Boş terminal sekmesinde Codex, Claude Code ve Antigravity başlatma düğmeleri görünür; seçilen agent o sekmenin mevcut klasöründe ve makinesinde yeni bir sekmede açılır. Kurulu olmayan seçenek pasiftir. Antigravity başlatıldıktan sonra Terminal görünümü açılır; onun konuşma kayıtları bu Chat uyarlayıcısına dahil değildir. Chat/Terminal geçişi, bölme düğmeleriyle aynı boyutta yazısız simgelerle yapılır; sohbet başlığında durum yazıları ve Yenile düğmesi yoktur.
- Mevcut kayıtları okur. Yeni bir Codex/Claude Code işleminde henüz kayıt yoksa hata yerine ilk mesaj ekranı görünür. İlk mesaj, terminal ve işlem kimliğiyle doğrulanıp doğrudan o terminale gönderilir; başka bir konuşma tahmin edilmez. Kayıt oluşunca aynı işleme ait geçmişe geçilir. Seçili sohbet 3 saniyede bir yenilenir; sol listede görünen diğer Codex/Claude sohbetleri de açılmaları beklenmeden tek tek hazırlanır. Arka planda çalışan agentlar 6, hazır agentlar 30 saniye aralıkla kontrol edilir; durum değişimi kontrolü öne alır. Bu token düzeyinde canlı akış değildir.
- Sohbetler bellekte ve bu bilgisayarın `data/madlen-chat/history/` klasöründe saklanır. Uygulama tekrar açıldığında yerel geçmiş önce gösterilir, güncel kayıt arka planda alınır. Önbellek makine, terminal ve işlem kimliğiyle ayrılır; yeni işlem eski geçmişi kullanmaz. Önbellek gösterilirken gönderim ve izin yanıtları güncel kayıt doğrulanana kadar bekler. Uzak aktarımlar sıkıştırılır ve yalnızca değişen mesajlar taşınır; tamamlanma bilgisi değişen eski mesajlar da güncellenir. Diskte en fazla 64 sayfa / 128 MB tutulur, 30 günden eski kayıtlar kullanılmaz. Önbellek hatası gerçek sohbet kaydını etkilemez.
- AI mesajlarında avatar yoktur; kullanıcı balonlarının iç boşluğu küçüktür. Çalışma tamamlanınca ara mesajlar ve araç grupları `Worked for 7m 44s ▸` gibi tek bir satırda katlanır; son yanıt açık kalır. Satıra tıklamak ara akışı sırasıyla gösterir. Süre sağlayıcının çalışma kaydından alınır; süre yoksa `Çalışma ayrıntıları` yazılır. Çalışan, yanıt bekleyen veya yarıda kesilen turlar katlanmaz. Tur içindeki ek kullanıcı düzeltmeleri de görünür kalır.
- Araç grubu kapalıyken işlem sayısı, durum ve son çağrının kısa özeti görünür. Açılan listede her çağrı tek satırdır; çağrıya tıklamak komut, dosya, klasör ve kısa sonuç gibi alanları gösterir. Satırdaki “Ham” düğmesi, adaptörün aldığı girdi ve çıktıyı düz metin olarak açar. Büyük JSON veya kaynak kodu varsayılan görünümde gösterilmez. Sağlayıcıdan alınan kayıtlar hâlâ alan başına 10.000 karakterle sınırlıdır; Ham görünümü bu alınan kaydı gösterir.
- Yanıt bittikten sonra shell komutu çalışmaya devam ediyorsa mesaj kutusunun üzerinde sabit bir arka plan kartı görünür. İşin adı, geçen süre ve son çıktı satırı gösterilir; satırı açınca komut ve son altı çıktı satırı okunur. Claude’da bu oturumun kayıtlı shell işi ve ona bağlı yazan alt işlem doğrulanır; başka oturumların işleri gösterilmez. Codex’te yerel komut kaydındaki çalışma durumu kullanılır. Tamamlanma/hata bildirimi geldikten sonra sonuç beş dakika görünür; en fazla iki son sonuç tutulur. Durumu doğrulanamayan veya önbellekten gelen kayıt canlı çalışıyormuş gibi gösterilmez. Claude çıktı dosyasından en fazla son 8 KB okunur, önizleme 1.800 karakterle sınırlıdır. Uzak oturumlarda kontrol işin çalıştığı makinede yapılır. Shell etkinliği mesaj sırasını veya gönderim davranışını değiştirmez.
- Chat’te Ctrl+C veya Ctrl+D, seçili Codex/Claude agentını kapatır ve aynı makine/klasördeki boş sekmede başlatma ekranına döner. Boş terminal sekmesinde tekrar basmak o sekmeyi kapatır. Önce boş sekme hazırlanır; işlem kimliği değişmişse agent kapatılmaz. Çıkış sırasında henüz gönderilmemiş sıra durdurulur. Cmd+C ile kopyalama etkilenmez.
- Claude Code oturumunda bağlam doluluğu ince bir çubukla gösterilir; üzerine gelince yüzde ve token sayıları görünür. Son yanıtın girdi tokenları, Claude Code’un yerel model kataloğundaki (`~/.claude/cache/model-catalog`) pencere boyutuna bölünür. Bu, terminal durum satırındaki `context_window.used_percentage` ile aynı hesaptır. Model katalogda yoksa yalnızca token sayısı görünür. Codex oturumlarında henüz gösterilmez.
- Uzun oturumlarda son 40 mesaj gösterilir; daha eskileri “Daha eski mesajları göster” ile 40’ar 40’ar yüklenir. Compact özeti ve slash komut çıktıları kullanıcı mesajı gibi değil, ince bir ayırıcı satır olarak görünür. Claude Code’da `!` ile çalıştırılan komut `! komut` balonu, çıktısı altında terminal kutusu olarak görünür; uzun çıktı katlanır.
- AI yanıtlarındaki dosya yolları, kod içinde yazılmış yollar ve Markdown dosya bağlantıları tıklanabilir. Yerel dosyalar varsayılan uygulamada açılır; uzak dosyalar Çıktılar paneliyle aynı akışta `~/Downloads/Herdr Çıktılar/<makine>/` altına indirilip bu bilgisayarda açılır. İndirme ve açılma durumu mesajın altında görünür. Bağlantı, tıklandığı mesaj ve oturumla doğrulanır; eski mesajlar son 50 mesaj sınırından etkilenmez. Satır numaraları dosya açılırken ayıklanır; editörde ilgili satıra atlama henüz yoktur. Uzak dosyalarda 20 MB sınırı geçerlidir; uzak klasörler indirilemez.
- Mesaj kutusu tek satırla başlar; yazdıkça en fazla dört satıra büyür, daha uzun metin kutunun içinde kaydırılır. Gönder düğmesi metnin yanında durur. Enter mesajı hemen sohbete ekleyip yazma kutusunu boşaltır; Shift+Enter yeni satır açar. Oturum doğrulaması ve gönderim arka planda sürer; bu sırada yazılan yeni taslak silinmez. Gerçek konuşma kaydı geldiğinde yerel balonla eşleşir, mesaj iki kez görünmez. Kesin gönderim hatasında balonda “Yeniden dene” ve “Taslağa al” görünür; iletimin belirsiz kaldığı bağlantı hatalarında yinelenen mesajı önlemek için Terminal'den kontrol istenir. Codex veya Claude Code çalışırken Enter mesajı Chat’in yerel sırasına ekler; balonda “Sırada” görünür. Metin, görseller ve `!` komutları mevcut çalışma bitince, sırayla ve terminal başına tek gönderimle iletilir. Sıra uygulama yenilendiğinde de korunur; iletim sırasında yenilenme olursa durum belirsiz kabul edilir ve otomatik tekrar yapılmaz. Bu yerel sıra henüz agenta iletilmediği için aynı metindeki eski bir konuşma mesajıyla eşleşmez. Onay bekleyen agentlarda taslak kutuda kalır.
- Sıradaki metnin altındaki “Şimdi yönlendir” düğmesi, o mesajı mevcut çalışmaya iletir. Codex’te [Enter ile yönlendirme](https://learn.chatgpt.com/docs/developer-commands), Claude Code’da [hemen gönder kısayolu](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works) kullanılır. Claude Code için 2.1.275 veya yenisi gerekir; sürüm işlemden önce kontrol edilir. Görseller ve `!` komutları yönlendirme yerine normal sırayı bekler. Engellenmiş veya değişmiş bir işleme yönlendirme tuşu gönderilmez.
- Yerel gönderim denemeleri oluşturuldukları zamana göre konuşmanın içine yerleşir; eski bir başarısız veya belirsiz deneme yeni yanıtların altında kalmaz. Terminalden farklı bir metin gönderilirse eski deneme otomatik olarak gönderilmiş sayılmaz. Gerek kalmayan başarısız veya belirsiz balon “Bu denemeyi kaldır” ile kaldırılabilir; gerçek konuşma kaydı korunur ve o metin tekrar gönderilmez.
- Claude ve Codex soruları sohbette ayrı kartlarda görünür; Codex’in asistan mesajına eklediği seçenekli ve serbest metin soruları da okunur. Claude bekleyen soruyu henüz kayda yazmamışsa soru ve seçenek açıklamaları canlı terminalden okunur. Aynı soru kayıtta da varsa iki kart gösterilmez. Canlı biçim okunamazsa agentın bekleme açıklaması ve Terminal’e geçiş düğmesi gösterilir; boş bir “yanıt gerekiyor” satırıyla kalmaz. Uzak sorular da gösterilir. Bekleyen kartta “Yanıt bekliyor” ve Terminal’e geçiş düğmesi bulunur. Kayıtta yanıt varsa kart “Yanıtlandı” der, seçimi gösterir ve seçenekleri katlar; ayrıntılar tekrar açılabilir. Sonraki mesajla geride kalan ama yanıtı doğrulanamayan kart “Geçmiş soru”, hata veya iptal sonucu olan kart “Tamamlanmadı” der; bunlarda yanıtlama düğmesi görünmez. Asenkron sorunun kabul bildirimi yanıt sayılmaz. Kayıtta belirli yanıtla eşleşme yoksa seçim tahmin edilmez.
- Canlı Claude sorularında tek seçimli seçeneklere tıklayarak yanıt verilebilir; yerel ve uzak oturumlar desteklenir. Göndermeden önce işlem kimliği, açık soru ve seçili seçenek tekrar doğrulanır. Yanıt iletilirken seçenekler kilitlenir; iletim belirsizse otomatik tekrar yapılmaz. Serbest metin, çoklu seçim ve Codex soru yanıtları Terminal’den verilir.
- Yerel Claude Code oturumu izin isterse sohbette bir izin kartı çıkar: ne istendiği, komut ve terminaldeki seçenekler görünür. Bir seçeneğe tıklayınca terminalde aynı izin sorusunun hâlâ açık olduğu doğrulanır, sonra o seçeneğin rakam tuşuna basılır; soru değiştiyse hiçbir tuşa basılmaz. Görsel dışındaki dosya ekleri, slash komutları ve Codex ile uzak oturumlardaki izinler Terminal’den kullanılır.
- Görseller sohbette önizlenir; tıklayınca büyür. Cmd+V veya dosya sürükleme ile ekleyin; göndermeden önce kaldırabilirsiniz. En fazla 3 görsel, görsel başına 20 MB. Görsel yapıştırma macOS Xcode Command Line Tools (`swiftc`) gerektirir; küçük yerel yardımcı ilk kullanımda derlenir. Görseller yalnızca Gönder ile mevcut agent oturumuna aktarılır.
- Önizleme kopyaları ve taslak görseller Herdr klasörünün `data/madlen-chat/` dizininde yerel tutulur. Kaynak dosyası artık bulunmayan eski ekler gösterilemez.
- Chat ana çalışma alanını kaplar; her split içinde ayrı Chat bulunmaz. Terminal’e dönünce mevcut bölmeler korunur. Chat başlığında da aynı küçük paneli büyüt/küçült ve kapat simgeleri bulunur. Herdr’a bağlı uzak makinelerde Chat desteklenir; uzak makinede Python 3.9+ gerekir. Kayıtlar o makinede okunur, metin mesajları tam makine/terminal adresine gönderilir. Uzak oturumların görsel önbelleği o makinenin `~/.cache/herdr-madlen-chat/` klasöründe tutulur. Uzak oturuma panodan görsel gönderme henüz desteklenmez.
- Codex yerel veritabanı / Claude kayıt biçimleri resmi kararlı bir entegrasyon sözleşmesi değildir; sağlayıcı güncellemeleri uyarlama gerektirebilir. Eşleşme belirsizse başka bir sohbet tahmin edilmez.

## Çıktılar paneli

Üstteki kutu simgesi, seçili Codex/Claude Code oturumunun paylaştığı dosyaları sağ panelde açar. Son 50 konuşma mesajındaki mevcut dosyalar türlerine göre gruplanır; her grupta değiştirilme tarihi en yeni olan üsttedir. Boş gruplar görünmez; hiç dosya yoksa açıklayıcı bir boş durum gösterilir. Liste açıkken 10 saniyede bir yenilenir; farklı agentların dosyaları karıştırılmaz.

Tek tık görsel, Markdown, JSON ve metin dosyalarını panel içinde önizler. Cmd+tık veya satırdaki dışa açma simgesi dosyayı varsayılan uygulamada açar; HTML, PDF ve ofis belgeleri tek tıkla da dışarı açılır. ZIP dosyası Finder'da seçilir. Başlıktaki geri oku dosya listesine döner.

Uzak oturumlar mevcut Herdr makine bağlantısı üzerinden okunur. Dışarı açılan uzak dosyalar bu bilgisayarın `~/Downloads/Herdr Çıktılar/<makine>/` klasörüne indirilir, sonra yerel uygulamada açılır. Satırda indirme, kaydetme, açılma veya hata durumu görünür; klasör simgesi indirilen dosyayı Finder'da gösterir. Aynı adlı farklı dosyalar ve sürümler ayrı klasörlerde korunur. Yalnızca panel içinde önizlenen görseller özel önbellekte kalır; kaynak dosya değiştirilmez. Aktarım ve görsel önizlemesi 20 MB, metin önizlemesi ilk 400 KB ile sınırlıdır. Uzak klasörler dış uygulamada açılamaz; içlerindeki paylaşılan dosyalar ayrı ayrı açılabilir. Ayrı `outputs-browser` kurulumu değiştirilmez.

## PR'lar paneli

**PR'lar** paneli, madlenio'daki açık PR'larını (ve "Hepsi" seçiliyken son 7 günde merge edilenleri) Linear numarasına göre kartlarda toplar. Her PR tek satırdır; reviewer'lar baş harfleriyle ve review durumlarıyla görünür. Satıra tıklayınca açılan alanda PR taslağa çevrilir veya review'a hazır yapılır, reviewer eklenir ya da çıkarılır. Kartın altında API, Teacher ve Exam preview'leri alt alta linkleriyle ve kopyala düğmesiyle durur; **Preview al ▾** seçilen PR'a `@madlen-agent deploy` yorumu yazar. PR'ın durumunu değiştiren her işlem iki tıklamayla onaylanır, panel kendiliğinden hiçbir şey göndermez. GitHub'a kendi `gh` oturumunla bağlanır ve dakikada bir yenilenir. Linear eklentisinde oturum açıksa issue başlıkları da gösterilir.

## Güncelleme ve geri dönüş

Yeni sürüm etiketini indirip aynı `install.py` dosyasını çalıştırın. Paket dosyalarını kendiniz değiştirdiyseniz kurulum durur. Değişiklikleri inceledikten sonra `--replace-modified` ile yedekleyerek güncelleyebilirsiniz. Yedekler `HERDR_APP_HOME/backups/herdr-madlen-studio/` altında tutulur.

Herdr’ın düzen seçicisinden eski düzeni seçebilir veya kurulumun yazdığı `layout.switch` komutunu kullanabilirsiniz. Önceki düzen adı `HERDR_APP_HOME/packages/herdr-madlen-studio/installation.json` içinde saklanır. Bu sürüm otomatik kaldırıcı içermez; eski düzene dönmek için dosya silmek gerekmez.

## Gizlilik ve kaynaklar

Bu repository gerçek sohbet, ekran görüntüsü, token, kullanıcı ayarı, makine adresi veya kişisel yedek içermez. Tema/Chat kodu kayıtları oturumun bulunduğu makinede okur; uzak kayıtlar mevcut Herdr makine bağlantısıyla taşınır; gönderim mevcut agent terminaline gider. Seçtiğiniz AI agentının kendi veri işleme davranışı değişmez. İsteğe bağlı quota aracı kendi sağlayıcı bağlantılarını kullanır; Çıktılar’daki HTML ve uzak görseller için kendi belgesine bakın.

Herdr’ın resmi eklentisi değildir. Madlen marka varlıkları ve üçüncü taraf bileşenler için [THIRD_PARTY.md](THIRD_PARTY.md).

## Geliştirici kontrolleri

```sh
python3 -m unittest discover -s tests
python3 -m unittest discover -s theme/mods/madlen-chat -p 'test_*.py'
node test-chat-state.cjs
node test-chat-cache.mjs
node test-chat-send.mjs
node test-chat-links.mjs
node test-chat-turns.mjs
node test-chat-questions.mjs
node test-chat-activity.mjs
node test-chat-tools.mjs
node test-chat-exit.mjs
node test-previews.mjs
node test-outputs.mjs
```

Node yalnızca arayüz durum testinde gerekir; kullanıcı kurulumu Python ile çalışır. Kurulum testleri geçici klasörlerde çalışır ve gerçek Herdr ayarlarını değiştirmez.
