export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6">
      <div className="max-w-xl w-full bg-slate-900 border border-slate-800 rounded-xl p-8 shadow-2xl">
        <div className="flex items-center space-x-3 mb-4">
          <span className="inline-flex h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
          <h1 className="text-2xl font-bold tracking-tight text-white">VigilPR Backend Service</h1>
        </div>
        <p className="text-slate-400 text-sm mb-6">
          AI-powered GitHub Pull Request review and security audit bot backend pipeline.
        </p>

        <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 mb-6">
          <p className="text-xs uppercase tracking-wider text-slate-400 font-semibold mb-2">
            Active Webhook Endpoint
          </p>
          <code className="text-emerald-400 font-mono text-sm break-all">
            POST /api/webhooks/github
          </code>
        </div>

        <div className="space-y-3 text-xs text-slate-400 border-t border-slate-800 pt-4">
          <p>
            <span className="font-semibold text-slate-300">Listening For:</span>{' '}
            <code className="text-slate-200">pull_request</code> (actions:{' '}
            <code className="text-slate-200">opened</code>,{' '}
            <code className="text-slate-200">synchronize</code>)
          </p>
          <p>
            <span className="font-semibold text-slate-300">Authentication:</span> GitHub App
            Installation token via Octokit
          </p>
          <p>
            <span className="font-semibold text-slate-300">Signature:</span> HMAC-SHA256 timing-safe
            verification
          </p>
        </div>
      </div>
    </main>
  );
}
