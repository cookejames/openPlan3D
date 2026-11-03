import { defineConfig, devices } from '@playwright/test';

// End-to-end cloud sync against the Firebase emulators. Run with `npm run test:e2e:cloud`, which
// starts the auth, firestore and storage emulators around this config.
const PORT = 4189;
export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/cloud-sync.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 },
      launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    },
  }],
  webServer: {
    // PUBLIC_* values are read at runtime ($env/dynamic/public), so the build itself needs no Firebase config.
    command: 'npm run build && node build/index.js',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(PORT),
      ORIGIN: `http://127.0.0.1:${PORT}`, PUBLIC_ENABLE_ANALYTICS: 'false',
      HANDOFF_UPLOADS_ENABLED: 'false', HANDOFF_BUCKET: '', BODY_SIZE_LIMIT: '2M',
      PUBLIC_FIREBASE_API_KEY: 'demo-api-key',
      PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-openplan3d.firebaseapp.com',
      PUBLIC_FIREBASE_PROJECT_ID: 'demo-openplan3d',
      PUBLIC_FIREBASE_STORAGE_BUCKET: 'demo-openplan3d.appspot.com',
      PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '1',
      PUBLIC_FIREBASE_APP_ID: '1:1:web:demo',
      PUBLIC_FIREBASE_USE_EMULATORS: 'true',
    },
  },
});
