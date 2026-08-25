# Bütçe Takip Uygulaması — Proje Dokümanı

## 1. Proje Özeti

**Uygulama Adı (geçici):** Bütçe Takip Uygulaması

**Amaç:** Bireysel kullanıcıların ve ailelerin gelir/gider takibini yapabildiği, geçmiş verileri saklayan ve finansal içgörüler sunan bir bütçe yönetim platformu.

**Hedef Kitle:**
- Kişisel bütçesini takip etmek isteyen bireysel kullanıcılar
- Aile içi ortak bütçe yönetimi yapmak isteyen aileler (çoklu kullanıcı, tek hesap altında)

**Platform Stratejisi:**
- İlk aşama: Web uygulaması
- İkinci aşama (gelecek): Mobil uygulama (React Native / Expo ile kod paylaşımı hedefleniyor)

---

## 2. Kullanıcı Rolleri ve Yetkilendirme

### 2.1 Bireysel Hesap
- Kullanıcı kayıt olur, giriş yapar
- Kendi gelir/giderlerini tam yetkiyle yönetir (ekle/düzenle/sil)

### 2.2 Aile Planı
- Bir **ana hesap (admin/owner)** oluşturulur
- Ana hesap, diğer aile üyelerini davet edebilir (email davet linki/kod ile)
- **Aile üyesi yetkileri:**
  - Kendi gelir/gider kaydını ekleyebilir
  - Kendi eklediği kayıtları **düzenleyemez ve silemez**
  - Sadece ana hesap (owner) tüm kayıtları (kendi ve üyelerinki dahil) ekleyebilir, düzenleyebilir, silebilir
  - Üyeler ortak aile dashboard'unu görüntüleyebilir
- Ana hesap, üyeleri aile planından çıkarabilir
- Ana hesap, aile planını yönetebilir (üye ekleme/çıkarma, kategori yönetimi vb.)

### 2.3 Kimlik Doğrulama
- Email/şifre ile kayıt ve giriş
- Şifre sıfırlama akışı
- (İleri aşama) Google/Apple ile sosyal giriş
- Oturum yönetimi (JWT tabanlı veya NextAuth session)

---

## 3. Temel Özellikler (MVP)

### 3.1 Gelir/Gider Yönetimi
- Manuel gelir/gider ekleme (tutar, tarih, kategori, açıklama, para birimi)
- Kategori bazlı sınıflandırma (varsayılan kategoriler + kullanıcı özel kategori ekleyebilir)
- İşlem geçmişi listesi (filtreleme: tarih aralığı, kategori, tutar, tür — gelir/gider)
- İşlem düzenleme/silme (yetkilendirme kurallarına göre — bkz. Bölüm 2)

### 3.2 Tekrarlayan İşlemler
- Kullanıcı bir işlemi "tekrarlayan" olarak işaretleyebilir (örn. kira, maaş, abonelik)
- Tekrarlama sıklığı seçenekleri: haftalık, aylık, yıllık
- Sistem, belirlenen tarihlerde otomatik olarak yeni kayıt oluşturur
- Tekrarlayan işlemler listesi ayrı bir görünümde yönetilebilir (aktif/pasif yapma, düzenleme)

### 3.3 Finansal Dashboard
- Genel bakış: toplam gelir, toplam gider, net bakiye (seçilen dönem için)
- **Pasta grafik:** Gelir ve gider dağılımı (kategori bazlı)
- **Trend grafikleri:** Aylık ve haftalık gelir/gider değişim grafiği (çizgi/bar grafik)
- Dönem seçici (bu hafta, bu ay, bu yıl, özel tarih aralığı)
- Aile planında: bireysel üye harcamaları vs toplam aile harcaması karşılaştırması

### 3.4 Bütçe Limitleri
- Kullanıcı, kategori bazında aylık bütçe limiti belirleyebilir
- Limit aşıldığında dashboard üzerinde görsel uyarı (renk değişimi, ilerleme çubuğu vb.)
- (Gelecek aşama — bu sürümde yok) Email/push bildirim sistemi

### 3.5 Raporlama ve Dışa Aktarma
- Detaylı finansal rapor oluşturma (seçilen tarih aralığı için)
- **PDF olarak dışa aktarma**
- **Excel (.xlsx) olarak dışa aktarma**
- Rapor içeriği: özet tablo, kategori kırılımı, grafikler

### 3.6 Çoklu Dil ve Çoklu Para Birimi
- Dil desteği: Türkçe, İngilizce (altyapı ileride başka dillere kolayca genişletilebilir olmalı)
- Para birimi desteği: TRY, USD, EUR (minimum) + kullanıcı bazında varsayılan para birimi seçimi
- Kullanıcı arayüzü dil/para birimi ayarlarını profil sayfasından değiştirebilmeli

### 3.7 Veri Saklama ve Geçmiş
- Tüm gelir/gider kayıtları, kullanıcı işlemleri ve değişiklik geçmişi kalıcı olarak saklanmalı
- Veritabanı şeması, ileride eklenecek özellikler (örn. yatırım takibi, hedef belirleme, banka entegrasyonu) için genişletilebilir şekilde tasarlanmalı
- Soft-delete yaklaşımı düşünülebilir (kayıtlar tamamen silinmek yerine işaretlenir — geçmiş veri analizleri için)

---

## 4. Gelecek Aşama Özellikleri (Şimdilik Kapsam Dışı, Mimari Buna Uygun Olmalı)
- Banka/kredi kartı entegrasyonu (otomatik işlem çekme)
- Email/push bildirimleri (bütçe aşımı, tekrarlayan işlem hatırlatmaları)
- CSV/Excel ile toplu veri içe aktarma
- Mobil uygulama (React Native/Expo)
- Finansal hedef belirleme (tasarruf hedefleri vb.)
- Yatırım portföyü takibi

---

## 5. Teknik Yığın (Tech Stack)

### 5.1 Frontend
| Teknoloji | Amaç |
|---|---|
| **Next.js 14+ (App Router) + TypeScript** | Ana framework — SSR/SSG desteği, SEO avantajı, React tabanlı olduğu için ileride React Native'e geçişte kod/logic paylaşımı kolaylaşır |
| **Tailwind CSS** | Hızlı, tutarlı, responsive stil yönetimi |
| **shadcn/ui** | Hazır ve özelleştirilebilir UI bileşenleri (form, modal, tablo, dropdown vb.) |
| **Recharts** | Pasta grafik ve trend (line/bar) grafikleri için |
| **next-intl** | Çoklu dil (i18n) desteği |
| **React Hook Form + Zod** | Form yönetimi ve veri validasyonu |
| **Zustand** | Hafif global state yönetimi |

### 5.2 Backend
| Teknoloji | Amaç |
|---|---|
| **Next.js API Routes (Route Handlers)** | Backend endpoint'leri — tek repo (monorepo) kolaylığı |
| **Prisma ORM** | Type-safe veritabanı erişimi ve migration yönetimi |

> Not: Proje büyüdükçe backend'i ayrı bir **NestJS** servisine taşımak modülerlik ve ölçeklenebilirlik açısından değerlendirilebilir.

### 5.3 Veritabanı
| Teknoloji | Amaç |
|---|---|
| **PostgreSQL** | İlişkisel veri modeli — kullanıcı/aile/üye/işlem/kategori ilişkileri ve finansal veri bütünlüğü (ACID) için uygun |
| **Neon veya Supabase** | Yönetilen (managed) PostgreSQL hosting — kendi sunucu yönetmeden başlamak için |

### 5.4 Kimlik Doğrulama
| Teknoloji | Amaç |
|---|---|
| **NextAuth.js (Auth.js)** | Email/şifre girişi, oturum yönetimi, ileride sosyal giriş entegrasyonu |

### 5.5 Diğer Araçlar
| Teknoloji | Amaç |
|---|---|
| **ExcelJS** | Excel (.xlsx) dışa aktarma |
| **@react-pdf/renderer** veya **jsPDF + html2canvas** | PDF rapor oluşturma |
| **date-fns** | Tarih hesaplamaları, tekrarlayan işlem mantığı |

### 5.6 Deployment
| Teknoloji | Amaç |
|---|---|
| **Vercel** | Next.js ile native uyumlu hosting, kolay CI/CD |

### 5.7 Mobil Geçiş Stratejisi
- Business logic (hesaplamalar, API çağrıları, state yönetimi) UI katmanından mümkün olduğunca ayrıştırılmalı
- İleride **React Native / Expo** ile mobil uygulamaya geçişte bu logic'in büyük kısmı yeniden kullanılabilir olmalı

---

## 6. Veri Modeli (Taslak)

### 6.1 Ana Varlıklar (Entities)

**User**
- id, name, email, password_hash, preferred_language, preferred_currency, created_at, updated_at

**Family**
- id, name, owner_id (User referansı), created_at

**FamilyMember**
- id, family_id, user_id, role (owner / member), joined_at

**Transaction (İşlem)**
- id, user_id (kaydı oluşturan), family_id (nullable — bireysel işlemse boş), type (income / expense), amount, currency, category_id, description, date, is_recurring, recurring_frequency (nullable), created_by, created_at, updated_at, deleted_at (soft delete)

**Category**
- id, name, type (income / expense), is_default (sistem kategorisi mi, kullanıcı kategorisi mi), user_id (nullable — özel kategoriyse), family_id (nullable), icon, color

**Budget (Bütçe Limiti)**
- id, user_id veya family_id, category_id, limit_amount, period (monthly), created_at

**RecurringTransaction**
- id, base_transaction_id, frequency (weekly/monthly/yearly), next_run_date, is_active

### 6.2 İlişkiler
- Bir **User** birden fazla **Transaction**'a sahip olabilir
- Bir **Family**, bir **owner (User)** ve birden fazla **FamilyMember**'a sahiptir
- Bir **Transaction**, bir **Category**'ye bağlıdır ve opsiyonel olarak bir **Family**'ye ait olabilir
- Bir **Budget**, bir **Category** ve (User veya Family) ile ilişkilidir

---

## 7. Kullanıcı Akışları (User Flows)

### 7.1 Kayıt ve Giriş
1. Kullanıcı email/şifre ile kayıt olur
2. Email doğrulama (opsiyonel MVP sonrası)
3. Giriş yapar → Dashboard'a yönlendirilir

### 7.2 Aile Planı Oluşturma
1. Kullanıcı "Aile Planı Oluştur" seçeneğine tıklar
2. Aile adı belirler → otomatik olarak "owner" rolünü alır
3. Davet linki/kodu oluşturur ve paylaşır
4. Davet edilen kullanıcı kayıt olur/giriş yapar → daveti kabul eder → aileye "member" olarak katılır

### 7.3 İşlem Ekleme
1. Kullanıcı "Yeni İşlem Ekle" butonuna tıklar
2. Tür seçer (gelir/gider), tutar, kategori, tarih, açıklama girer
3. Tekrarlayan işlem ise sıklığı belirler
4. Kaydeder → Dashboard ve işlem listesi güncellenir

### 7.4 Dashboard Görüntüleme
1. Kullanıcı giriş yaptığında ana dashboard açılır
2. Dönem seçer (hafta/ay/yıl/özel)
3. Pasta grafik (kategori dağılımı) ve trend grafiği görüntülenir
4. Bütçe limitleri ve durumları görüntülenir

### 7.5 Rapor Alma
1. Kullanıcı "Raporlar" sayfasına gider
2. Tarih aralığı seçer
3. PDF veya Excel formatında dışa aktarır

---

## 8. Tasarım/UX Notları
- Sade, modern ve güven veren bir finansal uygulama arayüzü (fazla renk karmaşasından kaçınılmalı)
- Mobil uyumlu (responsive) tasarım — ileride mobil app geçişini kolaylaştırmak için
- Dashboard, kullanıcının ilk gördüğü ve en çok etkileşimde bulunacağı ekran olduğu için görsel hiyerarşi net olmalı
- Gelir yeşil/pozitif tonlarla, gider kırmızı/negatif tonlarla ayırt edilmeli (renk körlüğü için ikon desteği de eklenmeli)

---

## 9. Güvenlik Notları
- Şifreler hash'lenerek saklanmalı (bcrypt/argon2)
- Aile içi yetkilendirme kontrolleri backend tarafında da doğrulanmalı (frontend kontrolüne güvenilmemeli)
- Finansal veriler için HTTPS zorunlu
- Kullanıcı verileri arasında izolasyon sağlanmalı (bir kullanıcı başka bir kullanıcının/ailenin verisine erişememeli)

---

## 10. Kapsam Dışı (Bu Sürümde Yapılmayacaklar)
- Gerçek banka/kart entegrasyonu (altyapı buna uygun bırakılacak ama entegrasyon yapılmayacak)
- Push/email bildirimleri
- CSV toplu içe aktarma
- Mobil native uygulama (sadece responsive web)
