import { isPublicDashboard } from "@/lib/auth";

export const metadata = { title: "Sign in · Resonia Pulse" };

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const configured = !!process.env.DASHBOARD_PASSWORD;
  const publicMode = isPublicDashboard();
  return (
    <main className="login">
      <form className="login-card" method="post" action="/api/login">
        <h1>
          Resonia <span className="accent">Competitive Pulse</span>
        </h1>
        <p className="muted">
          {publicMode ? "Enter the team password to edit post themes." : "Enter the team password to view the dashboard."}
        </p>
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
        {error && <p className="error">That password is not right. Try again.</p>}
        {!configured && <p className="error">DASHBOARD_PASSWORD is not set on the server, so sign-in is disabled.</p>}
        <button type="submit" className="btn btn-primary">
          Sign in
        </button>
        {publicMode && (
          <a className="login-back" href="/">
            Back to the dashboard
          </a>
        )}
      </form>
    </main>
  );
}
