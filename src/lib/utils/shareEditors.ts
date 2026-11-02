const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export type EditorEmailProblem = 'empty' | 'invalid' | 'duplicate';

/** Client-side check of an editor email before it is sent; returns the normalised email or the problem. */
export function checkEditorEmail(input: string, existing: readonly string[]):
  { email: string } | { problem: EditorEmailProblem } {
  const email = input.trim().toLowerCase();
  if (!email) return { problem: 'empty' };
  if (!EMAIL_RE.test(email)) return { problem: 'invalid' };
  if (existing.some(e => e.toLowerCase() === email)) return { problem: 'duplicate' };
  return { email };
}
