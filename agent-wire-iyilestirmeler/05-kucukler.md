# 5. Küçükler

## README'deki test sayısı

`README.md` Development bölümü: `npm test       # 86 tests, no network`. Gerçek sayı 145. Ya güncelle ya da sayıyı
tamamen kaldır (her test eklemede yeniden eskir; önerim kaldırmak: `# no network` yeter).

## `prunedScopes` ekleme sırasıyla siliyor

`src/config.mjs:213`. 60 kaydı geçince oturum kayıtlarını `Object.keys` sırasıyla, yani **ilk eklenme** sırasıyla
siliyor. `setChannelMode` var olan anahtarı güncellediğinde anahtar yerini korur. Uzun yaşayan, modu yeni değiştirilmiş
bir oturum "en eski" sayılıp silinebilir ve klasör/`active` varsayılanına düşer (2. maddeye katkı yapabilir).

Çözüm: `setChannelMode` içinde güncellemeden önce `delete scopes[scopeId()]`, sonra yeniden ata; anahtar sona geçer,
sıra "son kullanım" olur. Bir satır.

## `tools/who-updated.mjs` sabitleri

Kişi adları (`sinan`, `huso`, `hako`) ve kanal `wms-agents` koda gömülü. npm paketine girmiyor (`files` alanı), zararsız.
İstenirse kanal da argümandan alınır; şart değil.

## Bun shim (sadece ev makinesi)

`~/.local/bin/node` bun shim'i; `npm test` bun'ın yardım metnini basıp çıkıyor. Repo sorunu değil, makine sorunu.
`AGENTS.md` içinde not var.
