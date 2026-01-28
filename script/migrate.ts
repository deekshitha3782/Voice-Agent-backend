import { execSync } from 'child_process';

console.log('Running database migrations...');
try {
  execSync('node node_modules/drizzle-kit/bin.cjs push', { 
    stdio: 'inherit',
    env: process.env 
  });
  console.log('Migrations completed successfully!');
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
}
