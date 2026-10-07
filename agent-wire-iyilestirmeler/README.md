# agent-wire: olası iyileştirmeler

Hazırlanma: 2026-10-06, repo `f5ca2da` (0.18.1) üzerinde. Satır numaraları bu commit'e göre.

## Öncelik sırası

| # | Dosya | Konu | Etki | Boyut |
|---|---|---|---|---|
| 1 | [01-kilitli-json-guncelleme.md](01-kilitli-json-guncelleme.md) | Süreçler arası lost update (states, peers, cursors, config) | Okunan mesaj geri "unread" olur; sabitlenmiş anahtar kaybolabilir | ~20 satır + 1 test |
| 2 | [02-mcp-kapaliyken-ask-satiri.md](02-mcp-kapaliyken-ask-satiri.md) | MCP kapalı oturumda hook'un yine "Unread messages" basması | Kullanıcının her gün gördüğü şikâyet | Karar + birkaç satır |
| 3 | [03-syncer-kilidi.md](03-syncer-kilidi.md) | Syncer kilidi exclusive değil | Çok dar pencerede iki syncer | ~10 satır |
| 4 | [04-log-cift-kayit.md](04-log-cift-kayit.md) | Handle sweep ile syncer aynı mesajı iki kez ekleyebilir | Nadir, kozmetik | 1'in kilidiyle çözülür |
| 5 | [05-kucukler.md](05-kucukler.md) | README test sayısı, scope budama sırası, `who-updated` sabitleri | Küçük | Dakikalar |
| — | [06-effect-pocketbase.md](06-effect-pocketbase.md) | Effect / PocketBase kullanılsın mı? | Karar notu: hayır | — |

## Doğrulama

```bash
npm test                                   # 145 test, ağ yok
node repro/race-states.mjs /path/to/agent-wire   # 1. maddenin kanıtı
```

Bugünkü sonuç: `beklenen 800, kalan 328` (üç denemede 328 / 393 / 340).
1. madde düzeltildikten sonra her denemede `kalan 800` olmalı.

> Evdeki makinede `node` bir bun shim'i; orada `npm test` hiçbir şey çalıştırmıyor, `/usr/bin/node --test "test/*.test.mjs"`
> kullanılmalı. Ofiste gerçek node varsa `npm test` yeterli.

## Ofiste başlamadan

- Evdeki repoda commit'lenmemiş bir `AGENTS.md` var (bağımlılık kuralı, test komutu). Ofiste yoksa bu klasördeki
  `AGENTS.md` kopyasını repo köküne koy.
- `/code-review` her publish öncesi.
