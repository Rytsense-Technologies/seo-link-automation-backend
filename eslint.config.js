import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.venv/', 'app/', 'tests/', 'alembic/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
    },
  },
];
