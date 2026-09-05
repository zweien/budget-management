import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
// eslint-config-prettier (flat-config entry): disables ESLint rules that
// would conflict with Prettier formatting. We run Prettier separately via
// lint-staged rather than embedding it as an ESLint rule.
import eslintConfigPrettier from 'eslint-config-prettier/flat';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // 自托管第三方产物(@file-viewer 预打包 bundle),不参与 lint。
    'public/**',
  ]),
  // Turn off ESLint rules that conflict with Prettier formatting.
  eslintConfigPrettier,
  {
    rules: {
      // No implicit `any` types anywhere — money/business logic must be typed.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
]);

export default eslintConfig;
