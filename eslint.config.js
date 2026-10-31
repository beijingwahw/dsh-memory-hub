// ESLint flat config — 全量代码静态检查（含类型感知规则）
/* global URL */
// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import { fileURLToPath } from 'node:url'

// 1.1.1 修复：URL.pathname 在 Windows 上产生 "/D:/..."（驱动器相对路径），
// typescript projectService 拒绝其为 tsconfigRootDir → 全部类型感知规则静默失效。
// fileURLToPath 才是跨平台的正确转换。
const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url))

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'lib/**', 'dist/**', 'coverage/**', '*.tgz', 'package-lock.json'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // scripts/*.mjs 由 TS projectService 托管解析，补 Node 全局
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.js', '*.config.ts', 'scripts/*.mjs'],
        },
        tsconfigRootDir,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // 事件监听器以 void 显式丢弃异步执行，属有意为之
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    },
  },
  prettier,
)
