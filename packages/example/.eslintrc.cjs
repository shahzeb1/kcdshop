/**
 * @type {import('@types/eslint').Linter.Config}
 */
module.exports = {
	extends: ['../../eslint-config/index.cjs'],
	parserOptions: {
		project: require.resolve('./tsconfig.json'),
	},
	// 🤷‍♂️ no idea why this isn't resolving properly and I don't care enough
	overrides: [
		{
			parserOptions: { project: false, program: null },
			files: ['./exercises/03.*/**/*.*', './*.*', './tests/**/*.*'],
		},
	],
}
