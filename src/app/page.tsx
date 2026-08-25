import Link from "next/link";
import { ArrowRight, PiggyBank, Repeat, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/wordmark";
import { StatementPreview } from "@/components/landing/statement-preview";

// KAPSAM NOTU (yayın öncesi son-kontrol raporu, bilinçli karar — bu turda
// düzeltilmiyor): next-intl'e hiç bağlı değil, tüm metin Türkçe sabit. Aynı
// durum `/family/**` ve `/invite/[token]` için de geçerli (bkz.
// `lib/client/use-scoped-translations.ts`'in "Aile planı bu turda kapsam
// dışı" notu) — ama bu sayfa için ayrıca önemli olan: dil değiştirmenin tek
// yolu `/settings` (hesap gerektiriyor), yani bir misafir/kayıtsız ziyaretçi
// bu sayfayı hiçbir zaman İngilizce göremiyor. EN desteği bu yüzden şu an
// fiilen yalnızca dashboard/transactions/auth/settings ile sınırlı — bu
// sayfa, family modülü ve genel bir "misafir dil seçebilsin" mekanizması
// eklenmeden "tam EN desteği" iddia edilmemeli.

const PILLARS = [
  {
    icon: PiggyBank,
    title: "Bütçe hedefleri",
    description: "Her kategoriye limit koyun, aşmadan önce haberiniz olsun.",
  },
  {
    icon: Repeat,
    title: "Tekrarlayan işlemler",
    description: "Kira, abonelik gibi düzenli ödemeleri bir kez tanımlayın.",
  },
  {
    icon: Users,
    title: "Aile ile paylaşım",
    description: "Ortak bütçeyi ailenizle birlikte görün ve yönetin.",
  },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-background">
      <header className="w-full">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Wordmark size="md" />
          <nav className="flex items-center gap-1.5 sm:gap-2">
            <Button variant="ghost" nativeButton={false} render={<Link href="/login">Giriş yap</Link>} />
            <Button nativeButton={false} render={<Link href="/register">Kayıt ol</Link>} />
          </nav>
        </div>
      </header>

      <main className="flex flex-1 flex-col">
        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="bg-ledger-lines pointer-events-none absolute inset-x-0 top-0 h-full text-foreground/[0.035]"
          />
          <div className="relative mx-auto flex w-full max-w-6xl flex-col items-center gap-12 px-4 py-14 sm:px-6 sm:py-20 lg:flex-row lg:items-center lg:gap-16 lg:py-28">
            <div className="flex max-w-xl flex-col items-start gap-6 text-left">
              <h1 className="text-4xl leading-[1.08] font-semibold tracking-tight text-foreground sm:text-5xl">
                Bütçenizi tahmin etmeyin, görün.
              </h1>
              <p className="max-w-md text-lg leading-relaxed text-muted-foreground">
                Bütçem; gelirinizi, giderinizi ve bütçe hedeflerinizi tek
                ekranda toplar. Ailenizle paylaşın, tekrarlayan ödemeleri
                unutmayın.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  size="lg"
                  className="px-5"
                  nativeButton={false}
                  render={<Link href="/register">Kayıt ol</Link>}
                />
                <Button
                  variant="outline"
                  size="lg"
                  className="px-5"
                  nativeButton={false}
                  render={<Link href="/login">Giriş yap</Link>}
                />
              </div>
              {/* Misafir modu (CLAUDE.md): tamamen istemci tarafında,
                  hesap açmadan da denenebilir — bkz. lib/client/guest-store.ts.
                  Bilinçli olarak daha az vurgulu (link stili, ok ikonu):
                  asıl davet kayıt olmak, bu sadece "önce dene" kaçış kapısı. */}
              <Link
                href="/transactions"
                className="group inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Hesap oluşturmadan devam et
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>

            <div className="flex w-full max-w-sm shrink-0 justify-center lg:justify-end">
              <StatementPreview />
            </div>
          </div>
        </section>

        <section className="border-t border-border bg-card/50">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-8 px-4 py-14 sm:grid-cols-3 sm:px-6 sm:py-16">
            {PILLARS.map(({ icon: Icon, title, description }) => (
              <div key={title} className="flex flex-col gap-3">
                <span className="flex size-10 items-center justify-center rounded-lg bg-brand-soft text-brand-soft-foreground">
                  <Icon className="size-5" strokeWidth={2} />
                </span>
                <h2 className="font-medium text-foreground">{title}</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:px-6">
          <Wordmark size="sm" />
          <p>© {new Date().getFullYear()} Bütçem. Tüm hakları saklıdır.</p>
        </div>
      </footer>
    </div>
  );
}
