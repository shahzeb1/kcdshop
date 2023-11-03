import fs from 'fs'
import path from 'path'

export async function compileTs(filePath: string, fullPath: string) {
	const esbuild = await import('esbuild')
	return esbuild.build({
		stdin: {
			contents: await fs.promises.readFile(filePath, 'utf-8'),
			// NOTE: if the fileAppName is specified, then we're resolving to a different
			// app than the one we're serving the file from. We do this so the tests
			// can live in the solution directory, but be run against the problem
			resolveDir: fullPath,
			sourcefile: path.basename(filePath),
			loader: 'tsx',
		},
		define: {
			'process.env': JSON.stringify({ NODE_ENV: 'development' }),
		},
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'browser',
		jsx: 'automatic',
		minify: false,
		sourcemap: 'inline',
	})
}

export async function compileCss(filePath: string, cwd: string) {
	const { default: postcss } = await import('postcss')
	const { execa } = await import('execa')

	const result = await execa('postcss', [
		filePath,
		'--config',
		path.join(cwd, 'postcss.config.js'),
		'--no-map',
	])

	return result.stdout.toString()
}
