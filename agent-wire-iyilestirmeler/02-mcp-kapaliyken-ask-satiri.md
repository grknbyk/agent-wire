# 2. MCP kapalı oturumda yine "Unread messages" satırı

## Şikâyet

Bir oturumda MCP kapalı, ama prompt'ta yine `Unread messages : x(5), y(2)` çıkıyor.

## Neden

Satırı MCP sunucusu değil, `settings.json` içindeki `UserPromptSubmit` hook'u basıyor (`agent-wire drain`,
`bin/agent-wire.mjs:51`). Hook MCP'den bağımsız; `/mcp` ile sunucuyu kapatmak hook'u durdurmuyor. Neyin basılacağına
**mod** karar veriyor, MCP'nin açık olup olmadığı değil.

Mod çözümü `channelMode` (`src/config.mjs:150`):

1. bu oturumun kaydı (`scopes[CLAUDE_CODE_SESSION_ID]`)
2. klasörün kaydı (`scopes[cwd]`)
3. kanalın `mode` alanı
4. kanalda `active: true` varsa **`ask`**, yoksa `off` (`src/config.mjs:157`)

Oturum bir şey seçmediyse `ask` şu üç yoldan gelebiliyor:

- **Klasör kaydı:** o klasörde düz terminalde `agent-wire ask` çalıştırılmış, ya da 0.13.6 her oturum seçimini klasöre de
  yazıyordu (yorum: `src/config.mjs:188`) ve o eski kayıtlar `config.json` içinde duruyor.
- **Kanalın `mode` alanı.**
- **Modlardan önceki `active: true`:** eski kurulumlarda her kanalda var; her yeni oturum `ask` ile başlıyor. README
  ise "varsayılan off, oturum sessiz başlar" diyor. Belge ile kod burada ayrışıyor.

Olası ek sebep: `prunedScopes` (`src/config.mjs:213`) 60 kaydı geçince oturum kayıtlarını **ekleme sırasına** göre
siliyor. Uzun yaşayan bir oturumun kaydı, sonradan güncellense bile anahtar yerini korur ve önce silinir; o oturum
klasör/`active` varsayılanına düşer. Bkz. 5. madde.

Doğrulanmadı: Claude Code'un `CLAUDE_CODE_SESSION_ID` değişkenini hook'lara da verdiği (README öyle söylüyor). Vermiyorsa
hook klasör kaydına düşer, Bash tool'dan yapılan `agent-wire off` ise oturum kaydına yazar: ikisi farklı kayda bakar.
Kontrol: hook komutunu geçici olarak `env | grep CLAUDE_CODE_SESSION_ID >> ~/.cache/hook-env.txt; agent-wire drain` yap.

## Teşhis (önce bunu yap)

Sorunlu oturumda:

```
! agent-wire channels
```

Çıktı oturum kimliğini, hangi klasöre düştüğünü ve her kanalın modunu gösterir. Sonra `~/.agent-wire/config.json`
içinde `active`, `mode` ve `scopes` altındaki klasör yollarına bak (token'ı kimseyle paylaşma).

## Karar gerekiyor

Eski `active: true` ne demek olsun?

- **Öneri: `off`.** README'nin sözüyle uyumlu; yeni oturum kimse açmadıkça sessiz. Değişiklik: `src/config.mjs:157`
  satırı `return 'off';` olur ve `active` artık okunmaz. Mevcut testlerden `active` davranışını bekleyen varsa
  (`test/channels.test.mjs`) güncellenir. Kullanıcıya etkisi: eski kurulumda ask'e alışmış biri, klasörde bir kez
  `agent-wire ask` çalıştırır.
- Alternatif: bugünkü gibi `ask` kalsın, README düzeltilsin.

Klasör kayıtları için: 0.13.6'dan kalan klasör kayıtlarını tek seferlik temizleyen bir göç düşünülebilir, ama hangisinin
kullanıcının bilerek koyduğu, hangisinin 0.13.6 artığı olduğu ayırt edilemiyor. Önerim dokunmamak, `agent-wire channels`
çıktısının "falls back to <klasör>" satırını yeterli saymak.

## "MCP kapalıysa hook da sussun" mu?

Cazip ama önermiyorum: hook, MCP'nin o oturumda kapalı olduğunu güvenilir biçimde öğrenemez (Claude Code'un bunu nerede
tuttuğu belgeli bir arayüz değil, doğrulamadım). Sessizliğin tek doğru anahtarı mod: `agent-wire off`. İstenirse
`agent-wire channels` / status kartında "mod ask, ama MCP bu oturumda kapalı olabilir; susturmak için agent-wire off"
gibi bir ipucu verilebilir.

## Kabul ölçütü

- Hiçbir kaydı olmayan yeni oturumda, `active: true` olan eski bir config ile `drain` hiçbir şey basmıyor (seçilen karar
  `off` ise).
- Bunun için `test/drain.test.mjs` ya da `test/channels.test.mjs` içine bir test.
