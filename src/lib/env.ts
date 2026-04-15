/**
 * Secret / passphrase resolution helpers.
 *
 * Rule of thumb: passwords should NEVER live in command option schemas that
 * agents can see in `--llms` or `--schema` output. They also shouldn't be
 * global state (makes testing awkward and hides dependencies).
 *
 * Instead: commands accept an optional `--password` escape hatch (for local
 * scripting), fall back to env vars, and pass the resolved password as an
 * explicit function argument into the store layer.
 */

/** Resolve the in-house wallet store master password from arg or env */
export function resolveFourmmPassword(
  explicit?: string | undefined,
): string | undefined {
  if (explicit) return explicit
  return process.env.FOURMM_PASSWORD || undefined
}
