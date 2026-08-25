import "server-only";

/** `NEXTAUTH_URL` is already required config (see .env.example) and is
 * exactly "this app's own base URL" — reused here rather than introducing a
 * second env var for the same value. Falls back to localhost only so local
 * dev never crashes if it's momentarily unset; production always has it
 * (NextAuth itself depends on it). Shared by every action that embeds a
 * link (password reset, email verification) in an outbound email. */
export function resolveAppUrl(): string {
  return process.env.NEXTAUTH_URL || "http://localhost:3000";
}

/** Minimal HTML-escape for user-controlled data (`User.name`) interpolated
 * into an email's HTML body — prevents a name like `<script>...` from
 * breaking the markup or, in a mail client that renders HTML, executing.
 * Hand-rolled rather than pulling in a dependency for five character
 * replacements. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
