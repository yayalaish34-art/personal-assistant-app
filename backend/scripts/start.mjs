import { execSync } from 'node:child_process';

// Production start.
//
// Migrations only run when there is a database to run them against. The app
// itself has been able to boot without one since the AI routes went stateless
// (see src/index.ts), but the start command still ran `prisma migrate deploy`
// unconditionally — so on a service with no DATABASE_URL the container died
// before it ever listened, and the deploy failed its healthcheck.

if (process.env.DATABASE_URL) {
  console.log('[start] DATABASE_URL present — applying migrations');
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
} else {
  console.log('[start] no DATABASE_URL — skipping migrations');
}

await import('../dist/index.js');
