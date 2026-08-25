# Bütçe Takip Uygulaması — Proje Talimatları

Proje dokümanı: `butce-takip-uygulamasi-proje-dokumani.md`
Onaylı implementasyon planı: `/Users/yavuzselim/.claude/plans/` altında "Bütçe Takip Uygulaması — Detaylı Implementasyon Planı".

## Subagent Ekibi

Bu proje `.claude/agents/` altında tanımlı 9 uzman subagent ile inşa ediliyor. Bir görev geldiğinde, tek bir subagent'a otomatik devretme yerine önce şunu değerlendir: **görev hangi alan(lar)ı kapsıyor?** Görev tek bir alana giriyorsa ilgili subagent'ı çağır; birden fazla alanı kapsıyorsa (örn. "aile daveti özelliğini ekle" → şema + endpoint + UI + test) ilgili subagent'ları **aynı mesajda paralel** başlat, aralarında bağımlılık varsa (örn. frontend, backend'in ürettiği API sözleşmesine ihtiyaç duyar) önce bağımlı olanı bitir, sonra diğerini başlat.

| Subagent | Alan | Ne zaman devreye girer |
|---|---|---|
| `software-architect` | Sistem yapısı, veri modeli, teknoloji kararı | Büyük/yeni bir özellik başlamadan önce, mimari belirsizlik/çakışma varken (ekip içi hakem) |
| `backend-developer` | API/Server Action, Prisma şema, auth, sunucu tarafı yetkilendirme | Sunucu tarafı her değişiklikte |
| `frontend-developer` | UI bileşenleri, sayfalar, state, görsel/UX kalite | Arayüz her değişiklikte |
| `mobile-developer` | iOS/Android (React Native/Expo), platforma özgü davranış | Mobil özellik veya web-mobil ortak mantık kararı gerektiğinde |
| `data-science-engineer` | Veri pipeline'ı, aggregation, istatistik, tahmin | Dashboard toplamları, raporlama verisi, trend/tahmin hesaplamaları |
| `qa-engineer` | Test planı, edge-case, bug bulma | Bir özellik tamamlandığında proaktif olarak, kullanıcı istemese bile |
| `cyber-security` | Zafiyet değerlendirmesi, log/aktivite triyajı | Güvenlik incelemesi istendiğinde, hassas akış (auth/yetkilendirme/ödeme) değiştiğinde |
| `devops-engineer` | CI/CD, deploy, ortam/secret yapılandırması, cron | Deploy/altyapı/otomasyon her değişiklikte |
| `algorithm-artist` | Generatif/algoritmik görsel üretim, algoritma tasarımı | Generatif art/görselleştirme veya karmaşık algoritma tasarımı gerektiğinde |

Her subagent kendi tanımında hangi skill(ler)i (`.claude/skills/`) kullanacağını zaten biliyor ve göreve başlamadan önce onu çağırıyor — ayrıca hatırlatmana gerek yok.

## Genel kurallar

- Para tutarları her yerde `Decimal`, asla `Float`.
- Yetkilendirme her zaman sunucu tarafında kontrol edilir; UI'daki gizleme kozmetiktir.
- `lib/domain/**` katmanı framework'ten bağımsız kalır (web ve mobil arasında paylaşılır).
- **Soft-delete filtresi yalnızca top-level model çağrılarını kapsar** (Prisma Client Extension sınırlaması). `Transaction` ve `Category`'ye HER ZAMAN doğrudan `db.transaction.*` / `db.category.*` ile, `where: { userId }` / `where: { familyId }` filtresiyle erişilir — `User`, `Family`, `FamilyMember`, `RecurringTransaction` üzerinden `include`/`select` ile ASLA (nested include soft-delete filtresini atlar, silinmiş kayıtları sızdırır). Gerekçe ve tam liste: `src/lib/server/db.ts` içindeki yorum.
- **Misafir modu**: Uygulama hesap açmadan da kullanılabilir olmalı (kullanıcı isterse kayıt olur/giriş yapar, isterse anonim devam eder). Bu **tamamen istemci tarafında** (tarayıcı `localStorage`, `lib/client/guest-store.ts`) çözülür — misafir için sunucuda `User` kaydı/oturum açılmaz, sunucu tarafı auth/yetkilendirme modeli değişmez. `/dashboard` ve `/transactions` bu yüzden `src/proxy.ts`'te korumasız: sayfa, oturum var mı yok mu diye bakıp veri kaynağını (Server Action vs. yerel store) seçer. Doğası gereği hesap gerektiren sayfalar (aile planı, ayarlar, bütçe limiti — çok kullanıcılı/kalıcı senkron gerektirdiği için) korumalı kalmaya devam eder. Misafir verisi tarayıcıya bağlıdır, cihazlar arası taşınmaz; kayıt olunca yerel veriyi hesaba taşıma (migration) şimdilik kapsam dışı, ileride eklenebilir.
