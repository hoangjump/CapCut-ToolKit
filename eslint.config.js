// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'web/dist/**', 'profiles-store/**', 'apps-script.gs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Import/biến thừa là thứ hay sót lại nhất sau mỗi lần tách file — bắt nó
      // chính là lý do chính thêm ESLint vào repo này.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // Codebase dùng `any` ở vài chỗ ranh giới API bên thứ ba — cảnh báo, không chặn.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
