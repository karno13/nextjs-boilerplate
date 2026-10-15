# Archiwum 40K — GitHub Actions

The public runner uses standard Ubuntu GitHub-hosted runners in the public
`karno13/nextjs-boilerplate` repository. It runs at minute 17 each hour, for at most
45 minutes, and resumes the Site's durable queue. GitHub schedules can be delayed;
after 60 days without repository activity GitHub can disable the schedule.

No npm installation, Vercel endpoint, shared secret, collection export, private
notes, or result artifacts are needed. GitHub OIDC identifies the exact repository
ID, owner ID, workflow path, main branch, event, and run. Forks and pull requests
cannot write to the Site. Public logs show source health and progress counts only.

`runtime/scanner.mjs` contains the existing parsers and public book catalog,
generated from `lib/scanner.ts` by `scripts/build-github-scanner.mjs`. It excludes
the collection, offer snapshot, database, auth, runtime configuration and secrets.
The Site checks parser revision and validates results before saving them through
the existing scan, history, archive, queue and per-book lease code.

Publish the Site endpoint first. Then copy `run.mjs` and `runtime/scanner.mjs` to
`archiwum-scanner/` in the public repository and `archiwum-scan.yml` to
`.github/workflows/archiwum-scan.yml`. A main-branch push performs a source probe
and starts a scan; later runs are scheduled or manually triggered in Actions.
Keep the previous reader configuration until a real GitHub run saves results.
Source blocks remain source errors; they never prove that old offers disappeared.

GitHub Actions availability and free allowances are governed by GitHub's current
terms. This is a bounded scheduled data-processing job, not a continuously hosted
proxy. No larger runners, paid services or uploaded artifacts are configured.
