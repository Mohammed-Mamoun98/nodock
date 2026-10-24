export function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center bg-canvas dot-grid p-6">
      <div className="w-[360px] rounded-lg border border-line bg-surface p-8">
        <div className="mb-6 flex items-center gap-2">
          <span className="h-2 w-2 bg-lime" aria-hidden />
          <span className="font-sans text-ui-lg font-semibold">nodock</span>
        </div>

        <h1 className="mb-1.5 text-ui-lg font-medium">Sign in</h1>
        <p className="mb-6 text-ui-sm text-text-dim">
          Single-admin access. Only the GitHub account in{' '}
          <span className="font-mono text-[11px]">ADMIN_GITHUB_LOGIN</span> can open this panel.
        </p>

        <a
          href="/auth/github"
          className="flex h-9 w-full items-center justify-center gap-2 rounded-[6px] bg-lime text-ui-sm font-medium text-lime-ink transition-colors hover:bg-lime/90"
        >
          Continue with GitHub
        </a>

        <p className="mt-4 font-mono text-mono-xs leading-relaxed text-text-dim">
          Requests scopes: repo · workflow
        </p>
      </div>
    </main>
  );
}
