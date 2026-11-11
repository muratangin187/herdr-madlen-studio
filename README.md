# Madlen Studio for Herdr

Madlen renkleriyle açık/koyu tema, sade agent listesi ve Codex / Claude Code oturumları için Chat–Terminal görünümü.

Sekmeler, durum ikonları ve tema seçimi tek üst satırda. Sol çubukta çalışma alanları, agentlar, kullanım halkaları ve ayarlar var. Sohbette Madlen avatarı, sağa hizalı kullanıcı mesajları, açılır araç kayıtları ve genişliğe uyarlanan mesaj alanı bulunur. Sekme dönüşlerinde sohbet ve kaydırma konumu bellekte korunur.

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

**Çıktılar:** Dosya/görsel/Markdown/JSON/HTML görüntüleyen ayrı macOS uygulaması. Kaynakları pakette; `swiftc` (Xcode Command Line Tools) gerekir:

```sh
python3 install.py --with-outputs
```

Bu seçenek ayrıca `outputs-browser` modunu ve `~/.local/share/herdr-outputs/Herdr Outputs.app` uygulamasını kurar. Mevcut uyumlu Çıktılar eklentisini yedekler. Tema kurulumu sonradan başarısız olursa ayrı kurulmuş Çıktılar bileşeni kalabilir. Ayrıntılar: [Çıktılar belgesi](extras/outputs/README.md).

## Chat nasıl çalışır?

- Aynı Codex/Claude Code terminaline bağlanır; yeni bir AI oturumu açmaz.
- Mevcut yerel kayıtları okur. İlk açılışta oturum eşleşmesi gerekir; açılmış sohbetler bellekte tutulur. Kayıt yenilemesi 3 saniyede birdir, token düzeyinde canlı akış değildir.
- Uzun oturumlarda son 40 mesaj gösterilir; daha eskileri “Daha eski mesajları göster” ile 40’ar 40’ar yüklenir. Compact özeti ve slash komut çıktıları kullanıcı mesajı gibi değil, ince bir ayırıcı satır olarak görünür. Claude Code’da `!` ile çalıştırılan komut `! komut` balonu, çıktısı altında terminal kutusu olarak görünür; uzun çıktı katlanır.
- Enter gönderir, Shift+Enter yeni satır açar. Gönderirken hedef oturum yeniden doğrulanır. Agent çalışıyorsa veya onay bekliyorsa gönderim reddedilir; taslak korunur.
- Araç ve soru kartları geçmiş kayıt gösterimidir. İzinler, soru seçenekleri, görsel dışındaki dosya ekleri ve slash komutları Terminal’den kullanılır.
- Görseller sohbette önizlenir; tıklayınca büyür. Cmd+V veya “Görsel yapıştır” ile panodan ekleyin; göndermeden önce kaldırabilirsiniz. En fazla 3 görsel, görsel başına 20 MB. Görsel yapıştırma macOS Xcode Command Line Tools (`swiftc`) gerektirir; küçük yerel yardımcı ilk kullanımda derlenir. Görseller yalnızca Gönder ile mevcut agent oturumuna aktarılır.
- Önizleme kopyaları ve taslak görseller Herdr klasörünün `data/madlen-chat/` dizininde yerel tutulur. Kaynak dosyası artık bulunmayan eski ekler gösterilemez.
- Chat ana çalışma alanını kaplar; her split içinde ayrı Chat bulunmaz. Terminal’e dönünce mevcut bölmeler korunur. Herdr’a bağlı uzak makinelerde Chat desteklenir; uzak makinede Python 3.9+ gerekir. Kayıtlar o makinede okunur, metin mesajları tam makine/terminal adresine gönderilir. Uzak oturuma panodan görsel gönderme henüz desteklenmez.
- Codex yerel veritabanı / Claude kayıt biçimleri resmi kararlı bir entegrasyon sözleşmesi değildir; sağlayıcı güncellemeleri uyarlama gerektirebilir. Eşleşme belirsizse başka bir sohbet tahmin edilmez.

## PR'lar paneli

Sol menüdeki **PR'lar**, madlenio'daki açık PR'larını (ve "Hepsi" seçiliyken son 7 günde merge edilenleri) Linear numarasına göre gruplar. API, Teacher ve Exam PR'larında son preview'in durumu ve linki görünür; **Preview al** iki tıklamayla o PR'a `@madlen-agent deploy` yorumu yazar, kendiliğinden hiçbir şey göndermez. GitHub'a kendi `gh` oturumunla bağlanır ve dakikada bir yenilenir. Linear eklentisinde oturum açıksa issue başlıkları da gösterilir.

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
node test-previews.mjs
```

Node yalnızca arayüz durum testinde gerekir; kullanıcı kurulumu Python ile çalışır. Kurulum testleri geçici klasörlerde çalışır ve gerçek Herdr ayarlarını değiştirmez.
