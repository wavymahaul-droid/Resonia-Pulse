// Shared-password gate. The cookie holds a SHA-256 of the password (never the password
// itself), so changing DASHBOARD_PASSWORD signs everyone out. Uses Web Crypto so it
// runs in middleware (Edge runtime) and in route handlers alike.
export const AUTH_COOKIE = "pulse_auth";
export const AUTH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function authToken(password: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`resonia-pulse:${password}`));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string comparison.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// PUBLIC_DASHBOARD=true lets anyone view the dashboard; editing themes still needs sign-in.
export function isPublicDashboard(): boolean {
  return process.env.PUBLIC_DASHBOARD?.trim().toLowerCase() === "true";
}

// True when the cookie matches DASHBOARD_PASSWORD. With no password set, nobody is signed in.
export async function isSignedIn(cookie: string | undefined): Promise<boolean> {
  const password = process.env.DASHBOARD_PASSWORD;
  return !!password && !!cookie && safeEqual(cookie, await authToken(password));
}
