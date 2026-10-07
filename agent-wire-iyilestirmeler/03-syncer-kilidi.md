# 3. Syncer kilidi exclusive değil

## Sorun

`syncLoop` (`src/sync.mjs:97`): `syncerIsLive()` kontrolü → `beat()` ile `poll.lock` dosyasına `pid:zaman` yaz →
250 ms bekle → dosyada hâlâ kendi pid'i varsa devam et. "Son yazan kazanır."

Açık pencere: B süreci, A daha `beat()` yazmadan `syncerIsLive()` okur, ama kendi `beat()`'ini A'nın 250 ms sonraki
kontrolünden **sonra** yazarsa: A kendini sahip görüp devam eder, B de 250 ms sonra kendini sahip görüp devam eder. İki
syncer, takımın paylaştığı Slack workspace'ine iki kat istek atar. Sonrasında ikisi de birbirinin kalp atışını ezer ve
hiçbiri bırakmaz.

Pencere çok dar (B'nin okuma ile yazma arası 250 ms'den uzun sürmeli), o yüzden öncelik düşük.

## Önerilen çözüm (en küçüğü)

`beat()` yazmadan önce sahibi kontrol etsin; dosyada başka bir canlı pid varsa bu syncer kalp atışını durdurup çekilsin:

```js
// heart interval içinde: lockHolder()[0] !== String(process.pid) ise clearInterval + bir sonraki tick'i kurma
```

Böylece ikinci syncer en geç bir kalp atışı (10 sn) içinde kendini fark eder. Daha sağlamı `openSync(..., 'wx')` ile
gerçek exclusive kilit, ama takılı kilit yönetimini zaten zaman damgası yapıyor; yukarıdaki yeter.

## Kabul ölçütü

- İki `syncLoop` aynı anda çağrıldığında (test içinde `fetch` sahte), en geç bir kalp atışı sonra yalnızca biri
  çalışıyor. Test, `HEARTBEAT_MS` gerçek değerde 10 sn bekletmesin diye sabit dışarıdan verilebilir hale getirilebilir;
  getirilmeyecekse bu test atlanabilir, değişiklik küçük.
