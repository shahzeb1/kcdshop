/**
 * @see https://github.com/eslint/eslint/issues/3458
 * @see https://www.npmjs.com/package/@rushstack/eslint-patch
 */
require('@rushstack/eslint-patch/modern-module-resolution')

/**
 * @type {import('@types/eslint').Linter.Config}
 */
module.exports = {
	plugins: [
		'eslint-plugin-import',
		'eslint-plugin-react',
		'eslint-plugin-react-hooks',
	],
	parserOptions: {
		sourceType: 'module',
		ecmaVersion: 2023,
	},
	settings: {
		'import/resolver': {
			node: true,
		},
	},
	rules: {
		// TODO: figure out why this wasn't working eventually...
		// 'import/no-unresolved': 'error',

		'import/no-duplicates': ['warn', { 'prefer-inline': true }],
		'import/consistent-type-specifier-style': ['warn', 'prefer-inline'],
		'import/order': [
			'warn',
			{
				alphabetize: { order: 'asc', caseInsensitive: true },
				groups: [
					'builtin',
					'external',
					'internal',
					'parent',
					'sibling',
					'index',
				],
			},
		],
	},
	overrides: [
		{
			files: ['**/*.ts?(x)'],
			parser: '@typescript-eslint/parser',
			plugins: ['@typescript-eslint'],
			settings: {
				'import/resolver': {
					typescript: true,
				},
			},
			rules: {
				'import/no-unresolved': 'off', // ts(2307)
				'@typescript-eslint/consistent-type-imports': [
					'warn',
					{
						prefer: 'type-imports',
						disallowTypeAnnotations: true,
						fixStyle: 'inline-type-imports',
					},
				],
			},
		},
	],
}
