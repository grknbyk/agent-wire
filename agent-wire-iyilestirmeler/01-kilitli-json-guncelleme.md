# 1. Süreçler arası lost update

## Sorun

Aynı anda birden fazla süreç `~/.agent-wire/` altındaki JSON dosyalarına yazıyor:

- her Claude oturumunun kendi MCP sunucusu (`agent-wire serve`)
- makinede tek syncer (`agent-wire sync`)
- her prompt'ta prompt hook'u (`agent-wire drain`)
- CLI komutları (`read` / `ask` / `off`, `setup`, `doctor`)

`writeJson` (`src/config.mjs:84`) geçici dosyaya yazıp rename ediyor; yani dosya **yırtılmıyor**. Ama aşağıdaki
fonksiyonların hepsi oku → değiştir → yaz yapıyor ve arada kilit yok. İki süreç aynı anda okursa sonra yazan, öbürünün
değişikliğini siler.

| Fonksiyon | Yer | Dosya | Kaybolursa |
|---|---|---|---|
| `markRead` | `src/inbox.mjs:144` | `states.json` | Okunan mesaj tekrar unread; ask satırı sayıyı geri getirir |
| `archive` | `src/inbox.mjs:150` | `states.json` | Arşivlenen mesaj geri gelir |
| `writeCursor` | `src/inbox.mjs:173` | `cursors.json` | Kanal imleci geri gider, mesajlar yeniden çekilir (ts ile tekilleşir, zararsız ama boşa iş) |
| `checkAuthorship` | `src/identity.mjs:80` | `peers.json` | **Güvenlik:** sabitlenmiş anahtar silinir; o isimle gelen sahte mesaj `new` olarak sabitlenebilir |
| `forgetPeer` | `src/identity.mjs:94` | `peers.json` | Aynı |
| `setChannelMode` | `src/config.mjs:192` | `config.json` | `agent-wire off` sessizce geri alınır |
| `patchConfig` | `src/config.mjs:98` | `config.json` | setup/doctor ile mod komutu çakışırsa biri kaybolur |

Düşük önemli, aynı desen: `src/slack.mjs:280` (`users.json`), `src/version.mjs:99,137` (`update.json`). Önbellek
dosyaları; kaybolurlarsa bir sonraki turda yeniden üretilir.

## Kanıt

`repro/race-states.mjs`: 4 süreç, her biri 200 farklı mesajı `markRead` ile işaretliyor.

```
beklenen 800, kalan 328
beklenen 800, kalan 393
beklenen 800, kalan 340
```

## Önerilen çözüm

`src/config.mjs` içine tek bir yardımcı, bağımlılık yok:

```js
// updateJson(file, fallback, mutate): kilidi al, diskten TAZE oku (readJsonCached değil),
// mutate(value) çalıştır, writeJson ile yaz, kilidi bırak. mutate'in dönüşünü geri ver.
```

Tasarım notları:

- Kilit: `openSync(`${file}.lock`, 'wx')`. `EEXIST` gelirse kısa bekle ve tekrar dene. Senkron bekleme için
  `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)`; kod tabanı senkron fs kullanıyor, async'e
  çevirmeye gerek yok.
- Takılı kilit: kilit dosyasının `mtimeMs` değeri ~2 sn'den eskiyse sahibi ölmüş say, sil ve tekrar dene. Kritik bölüm
  milisaniyeler sürüyor.
- Sonsuz döngü olmasın: ~1 sn içinde alınamazsa hata fırlat. Hook'un yarıda kalması, veriyi sessizce ezmesinden iyidir.
- Bırakma `finally` içinde `unlinkSync`.
- Kilidin içinde okuma **cache'siz** olmalı. `readJsonCached` damgası `mtimeMs:size`; aynı boyutta ve aynı mtime
  içinde iki yazma olursa eski değeri döndürebilir. Kilit içinde düz `readJson` kullan.
- Yukarıdaki tablodaki fonksiyonlar `updateJson` üzerinden yazacak şekilde değişsin. `markRead` örneği:

  ```js
  export const markRead = (items) => updateJson(paths.states, {}, (states) => {
      for (const item of items) states[storageKey(item)] = 'read';
      return prunedStates(states);
  });
  ```

- `appendMessages` (`src/inbox.mjs:52`) aynı kilidin altına girerse 4. madde de kapanır (kilit dosyası `inbox.jsonl.lock`).

## Kabul ölçütü

- `repro/race-states.mjs` her çalıştırmada `kalan 800`.
- Bunu `test/concurrency.test.mjs` içine bir test olarak taşı (alt süreçleri `process.execPath` ile başlat, geçici
  `AGENT_WIRE_HOME`). Mevcut 145 test geçmeye devam etmeli.
- `npm run bench` ile `markRead` süresine bak; kilit eklemek ölçülebilir bir fark yaratmamalı.

## Alternatif (önermiyorum, şimdilik)

`node:sqlite` + transaction: tüm durumu tek veritabanına taşır, kilidi SQLite yapar. Depolama katmanını yeniden yazmak
ve `engines` alt sınırını yükseltmek demek. Hangi Node sürümünde bayraksız ve kararlı olduğunu doğrulamadım; seçilirse
önce bak.
