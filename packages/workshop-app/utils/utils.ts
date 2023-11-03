import { promises as dns } from 'node:dns'
import path from 'node:path'
import fsExtra from 'fs-extra'

export async function checkConnection() {
	return dns.resolve('example.com').then(
		() => true,
		() => false,
	)
}

export async function getPkgProp<Value>(
	fullPath: string,
	prop: string,
	defaultValue?: Value,
): Promise<Value> {
	let pkg: any
	try {
		pkg = fsExtra.readJsonSync(path.join(fullPath, 'package.json'))
	} catch (error) {
		throw new Error(`Could not read/parse package.json of ${fullPath}`)
	}
	const propPath = prop.split('.')
	let value = pkg
	for (const p of propPath) {
		value = value[p]
		if (value === undefined) break
	}
	if (value === undefined && defaultValue === undefined) {
		throw new Error(
			`Could not find required property ${prop} in package.json of ${fullPath}`,
		)
	}
	return value ?? defaultValue
}

export function getErrorMessage(error: unknown) {
	if (typeof error === 'string') return error
	if (
		error &&
		typeof error === 'object' &&
		'message' in error &&
		typeof error.message === 'string'
	) {
		return error.message
	}
	console.error('Unable to get error message for error', error)
	return 'Unknown Error'
}
