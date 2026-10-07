# 4. Log'a aynı mesajın iki kez eklenmesi

## Sorun

`appendMessages` (`src/inbox.mjs:52`) önce mevcut anahtarlara bakıyor, sonra ekliyor. Kontrol ile ekleme arasında kilit
yok. İki süreç aynı mesajı aynı anda eklerse ikisi de "yok" görüp ikisi de yazar.

Gerçekçi tek yol: bir MCP sunucusu `inbox ref=...` ile log'da olmayan bir handle'ı Slack'te ararken (`fetchByRef`,
`src/sync.mjs:201`), syncer aynı mesajı o anda normal turunda çeker.

Kendi gönderdiğin mesaj için bu sorun yok: `recordOwnMessage` (`src/mcp.mjs:453`) yazıyor, poller kendi nickname'ini
atlıyor.

## Çözüm

1. maddedeki kilidin altına `appendMessages`'i al (`inbox.jsonl.lock`). Kilidin içinde anahtar kümesini cache'ten değil
taze oku. Ayrı iş gerekmez.

## Öncelik

Düşük: pencere küçük, sonuç bir mesajın inbox'ta iki kez görünmesi.
