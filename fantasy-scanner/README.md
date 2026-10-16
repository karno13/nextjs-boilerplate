# Archiwum Fantasy scanner

Hourly standard GitHub-hosted Linux scanner using a public repository. Authenticates using short-lived GitHub OIDC to a fixed, independently authenticated Sites bridge. The Fantasy Site remains private. No private collection data, snapshots, credentials, or repository write permissions. Only public catalog and parser code. Queue and price history stay in the Site database. New queues use the existing physical inventory. Vercel transport is rejected. GitHub schedules may be delayed or skipped; saved source stages resume on subsequent jobs.
