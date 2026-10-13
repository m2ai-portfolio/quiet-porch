import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Playwright script: Node at top level, browser globals inside page callbacks.
    files: ['docs/delivery/browser-validation/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', document: 'readonly', innerWidth: 'readonly' },
    },
  },
);
