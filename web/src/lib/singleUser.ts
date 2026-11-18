/**
 * Individual desktop / single-user client: no login, no multi-user, no Postgres.
 * Hosted deployments keep AuthContext dual-mode when this returns false.
 */
export function isSingleUserClient(): boolean {
  if (import.meta.env.VITE_CLAW2_SINGLE_USER === "1") return true;
  if (typeof window !== "undefined" && window.claw2Desktop) return true;
  return false;
}
