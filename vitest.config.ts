import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'eval/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // 0.8.0：阈值对齐 LIFT-0.8 验收目标（lines≥96.5 / branches≥95 / functions≥97 / statements≥96.5），
      // 并实测留安全垫（实测 100 / 96.09 / 100 / 100）。阈值与实测同步冻结，杜绝"门槛与实测脱节"重演。
      thresholds: {
        lines: 96.5,
        functions: 97,
        branches: 95,
        statements: 96.5,
      },
    },
  },
})
