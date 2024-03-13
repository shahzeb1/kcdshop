/**
 * @type {import('@types/eslint').Linter.Config}
 */
module.exports = {
	extends: ['../../eslint-config/index.cjs'],
	parserOptions: {
		project: require.resolve('./tsconfig.json'),
	},
}
