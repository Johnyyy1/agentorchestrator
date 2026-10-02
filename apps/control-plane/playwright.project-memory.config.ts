import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./e2e',testMatch:'project-memory.spec.ts',timeout:120000,workers:1,fullyParallel:false,
  expect:{timeout:15000},
  use:{actionTimeout:20000,baseURL:'http://127.0.0.1:3118',browserName:'chromium',viewport:{width:1440,height:1000},trace:'retain-on-failure'},
  webServer:{command:'CONTROL_PLANE_PROJECT_QA=1 npm run control-plane:dev -- --port 3118',cwd:'../..',url:'http://127.0.0.1:3118/projects',timeout:120000,reuseExistingServer:false},
});
