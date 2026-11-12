// @ts-check
import tseslint from 'typescript-eslint';

/**
 * 团队统一规则：只管「会出 bug 的东西」，风格交给 Prettier。
 * 加规则前先读 docs/CODING-STANDARD.md 里的「为什么」，不要凭个人喜好加。
 * 这里手写 rule 集合而不是用 recommended 预设：预设会随小版本变化，
 * 一个版本升级就可能让全组 CI 红掉。
 */
export default [
  { ignores: ['dist/**', 'node_modules/**', 'models/**', 'public/**', 'platforms/**', '**/*.d.ts'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'prefer-const': 'error',
    },
  },
  {
    /**
     * glTF / GLB 是外部弱类型格式：字段名和类型都来自对方的 JSON，
     * 逐字段声明收益低、维护成本高，这里明确豁免（不是偷懒，是有意的边界）。
     */
    files: ['src/engine/gltf.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['tools/**/*.mjs', 'scripts/**/*.mjs', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: { 'no-console': 'off', 'prefer-const': 'error', 'no-debugger': 'error' },
  },
];
