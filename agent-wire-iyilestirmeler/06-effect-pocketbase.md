# Effect / PocketBase kullanılsın mı?

Karar önerisi: **ikisi de hayır.**

## Effect (https://github.com/Effect-TS/effect)

- Effect tek süreç içindeki eşzamanlılığı (fiber, iptal, yeniden deneme, kaynak yönetimi) çözer. agent-wire'ın
  eşzamanlılık sorunları **süreçler arası** dosya yazımında (1, 3, 4. maddeler). Effect bunların hiçbirini kapatmaz;
  dosya kilidi yine elle yazılır.
- Süreç içindeki ihtiyaç zaten karşılanmış: `mapLimit` (`src/slack.mjs`, ~15 satır, testli), syncer'da `setTimeout`
  zinciri, üstel bekleme + jitter.
- Repo bilerek sıfır runtime bağımlılığıyla duruyor (sadece `node:` modülleri).
- `drain` her prompt'ta çalışıyor ve ~105 ms ölçülmüş. Effect yüklemesinin buna ne eklediğini ölçmedim; eklenecekse
  önce `npm run bench` ile ölç.

## PocketBase (https://pocketbase.io/)

- Ayrı bir Go sunucusu (SQLite + REST + realtime + auth). Her makinede ayakta tutulacak ikinci bir arka plan süreci
  demek: syncer'ın canlılık/kilit sorununun iki katı.
- `npm i -g` ile tek adım kurulum bozulur; platforma göre binary dağıtmak gerekir.
- Slack'in seçilme sebebi insanların okuyup müdahale edebildiği bir kayıt. PocketBase onu değiştirmez, yanına ikinci bir
  doğruluk kaynağı koyar.
- Yerel durum için gerçekten veritabanı istenirse doğal aday `node:sqlite` (Node'a gömülü, ek süreç yok). Bkz. 1. madde
  "Alternatif".

## Ne zaman yeniden düşünülür

- Effect: MCP sunucusu çok sayıda iptal edilebilir, iç içe async iş yapmaya başlarsa (ör. akış, uzun süren dosya
  transferleri, iptal).
- Bir sunucu: Slack dışında ikinci bir transport (roadmap'teki Discord) ve makineler arası paylaşılan durum gerekirse.
  O zaman bile önce Slack'in kendisi depolama olarak yeterli mi diye bakılmalı.
