/**
 * Shared heuristic for "does this string look like a next-intl message key
 * (e.g. `errors.unauthenticated`, `validation.transaction.amountPositive`)
 * rather than already-translated/literal text" — see CLAUDE.md's "Server
 * Action hata sözleşmesi DEĞİŞTİ" note: every Server Action result now
 * returns a KEY, not translated text, but `family/**` actions (out of scope
 * this round) still return hand-written Turkish sentences directly.
 *
 * Used by `components/auth/form-elements.tsx` (`FormAlert`/`FieldError`,
 * the primary consumer — every form-driven Server Action result flows
 * through those two) AND by any Server Component that renders a Server
 * Action's `error` string directly outside a form (e.g. `/settings`'s
 * top-level `ErrorState`) — kept here, not duplicated, so the two call
 * sites can never drift on what counts as "looks like a key".
 *
 * A key never contains a space or starts with an uppercase/Turkish letter;
 * ordinary prose reliably does, so this heuristic doesn't need a registry
 * of "which strings are keys" to stay correct.
 */
const MESSAGE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;

export function isMessageKey(message: string): boolean {
  return MESSAGE_KEY_PATTERN.test(message);
}
