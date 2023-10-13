import fs from 'fs'
import path from 'path'
import { type CacheEntry } from 'cachified'
import { execa } from 'execa'
import fsExtra from 'fs-extra'
import { glob } from 'glob'
import { globby, isGitIgnored } from 'globby'
import { z } from 'zod'
import {
	appsCache,
	cachified,
	exampleAppCache,
	playgroundAppCache,
	problemAppCache,
	solutionAppCache,
} from './cache.server.ts'
import { getOptionalWatcher, getWatcher } from './change-tracker.ts'
import { compileMdx } from './compile-mdx.server.ts'
import {
	closeProcess,
	isAppRunning,
	runAppDev,
	sendAppMessage,
	waitOnApp,
} from './process-manager.server.ts'
import { singleton } from './singleton.server.ts'
import { getServerTimeHeader, type Timings } from './timing.server.ts'
import { getErrorMessage, getPkgProp } from './utils.ts'

process.env.NODE_ENV = process.env.NODE_ENV ?? 'development'

const workshopRoot = getWorkshopRoot()

const playgroundAppNameInfoPath = path.join(
	getWorkshopRoot(),
	'node_modules',
	'.cache',
	'kcdshop',
	'playground.json',
)

type Prettyify<T> = { [K in keyof T]: T[K] } & {}

type CachifiedOptions = { timings?: Timings; request?: Request }

type Exercise = {
	/** a unique identifier for the exercise */
	exerciseNumber: number
	/** used when displaying the list of files to match the list of apps in the file system (comes the name of the directory of the app) */
	dirName: string
	/** the title of the app used for display (comes from the first h1 in the README) */
	title: string
	instructionsCode?: string
	finishedCode?: string
	instructionsEpicVideoEmbeds?: Array<string>
	finishedEpicVideoEmbeds?: Array<string>
	steps: Array<
		{ stepNumber: number } & ( // it'll have both or one, but never neither
			| { problem: ProblemApp; solution: SolutionApp }
			| { problem: ProblemApp; solution?: never }
			| { problem?: never; solution: SolutionApp }
		)
	>
	problems: Array<ProblemApp>
	solutions: Array<SolutionApp>
}

type BaseApp = {
	/** a unique identifier for the app (comes from the relative path of the app directory (replacing "/" with "__sep__")) */
	name: string
	/** the title of the app used for display (comes from the package.json title prop) */
	title: string
	/** used when displaying the list of files to match the list of apps in the file system (comes the name of the directory of the app) */
	dirName: string
	fullPath: string
	relativePath: string
	instructionsCode?: string
	epicVideoEmbeds?: Array<string>
	test:
		| {
				type: 'browser'
				baseUrl: `/app/${BaseApp['name']}/test/`
				testFiles: Array<string>
		  }
		| { type: 'script'; script: string }
		| { type: 'none' }
	dev:
		| { type: 'browser'; baseUrl: `/app/${BaseApp['name']}/` }
		| {
				type: 'script'
				portNumber: number
				baseUrl: `http://localhost:${number}/`
		  }
}

export type BaseExerciseStepApp = BaseApp & {
	exerciseNumber: number
	stepNumber: number
}

export type ProblemApp = Prettyify<
	BaseExerciseStepApp & {
		type: 'problem'
		solutionName: string | null
	}
>

export type SolutionApp = Prettyify<
	BaseExerciseStepApp & {
		type: 'solution'
		problemName: string | null
	}
>

export type ExampleApp = BaseApp & { type: 'example' }

export type PlaygroundApp = BaseApp & {
	type: 'playground'
	/** the name of the app upon which the playground is based */
	appName: string
}

export type ExerciseStepApp = ProblemApp | SolutionApp

export type App = PlaygroundApp | ExampleApp | ExerciseStepApp

export function isApp(app: any): app is App {
	return (
		app &&
		typeof app === 'object' &&
		typeof app.name === 'string' &&
		typeof app.title === 'string' &&
		typeof app.dirName === 'string' &&
		typeof app.fullPath === 'string' &&
		typeof app.test === 'object' &&
		typeof app.dev === 'object' &&
		typeof app.dev.baseUrl === 'string' &&
		typeof app.type === 'string'
	)
}

export function isProblemApp(app: any): app is ProblemApp {
	return isApp(app) && app.type === 'problem'
}

export function isSolutionApp(app: any): app is SolutionApp {
	return isApp(app) && app.type === 'solution'
}

export function isFirstStepProblemApp(
	app: App,
): app is ProblemApp & { stepNumber: 1 } {
	return isProblemApp(app) && app.stepNumber === 1
}

export function isFirstStepSolutionApp(
	app: App,
): app is SolutionApp & { stepNumber: 1 } {
	return isSolutionApp(app) && app.stepNumber === 1
}

export function isPlaygroundApp(app: any): app is PlaygroundApp {
	return isApp(app) && app.type === 'playground'
}

export function isExampleApp(app: any): app is ExampleApp {
	return isApp(app) && app.type === 'example'
}

export function isExerciseStepApp(app: any): app is ExerciseStepApp {
	return isProblemApp(app) || isSolutionApp(app)
}

function exists(file: string) {
	return fs.promises.access(file, fs.constants.F_OK).then(
		() => true,
		() => false,
	)
}

export const modifiedTimes = singleton(
	'modified_times',
	() => new Map<string, number>(),
)

export function init() {
	async function handleFileChanges(
		event: string,
		filePath: string,
	): Promise<void> {
		const apps = await getApps()
		for (const app of apps) {
			if (filePath.startsWith(app.fullPath)) {
				modifiedTimes.set(app.fullPath, Date.now())
				break
			}
		}
	}
	getWatcher()?.on('all', handleFileChanges)
}

function getForceFresh(cacheEntry: CacheEntry | null | undefined) {
	if (!cacheEntry) return true
	const latestModifiedTime = Math.max(...Array.from(modifiedTimes.values()))
	if (!latestModifiedTime) return undefined
	return latestModifiedTime > cacheEntry.metadata.createdTime ? true : undefined
}

export function setModifiedTimesForDir(dir: string) {
	modifiedTimes.set(dir, Date.now())
}

export function getForceFreshForDir(
	dir: string,
	cacheEntry: CacheEntry | null | undefined,
) {
	if (!path.isAbsolute(dir)) {
		throw new Error(`Trying to get force fresh for non-absolute path: ${dir}`)
	}
	if (!cacheEntry) return true
	const modifiedTime = modifiedTimes.get(dir)
	if (!modifiedTime) return undefined
	return modifiedTime > cacheEntry.metadata.createdTime ? true : undefined
}

async function readDir(dir: string) {
	if (await exists(dir)) {
		return fs.promises.readdir(dir)
	}
	return []
}

async function compileMdxIfExists(
	filepath: string,
	{ request }: { request?: Request } = {},
) {
	filepath = filepath.replace(/\\/g, '/')
	if (await exists(filepath)) {
		const compiled = await compileMdx(filepath, { request }).catch(error => {
			console.error(`Error compiling ${filepath}:`, error)
			return null
		})
		return compiled
	}
	return null
}

function getAppDirInfo(appDir: string) {
	const regex = /^(?<stepNumber>\d+)\.(problem|solution)(\.(?<subtitle>.*))?$/
	const match = regex.exec(appDir)
	if (!match || !match.groups) {
		console.info(
			`Ignoring directory "${appDir}" which does not match regex "${regex}"`,
		)
		return null
	}
	const { stepNumber: stepNumberString, subtitle } = match.groups
	const stepNumber = Number(stepNumberString)
	if (!stepNumber || !Number.isFinite(stepNumber)) {
		throw new Error(
			`Cannot identify the stepNumber for app directory "${appDir}" with regex "${regex}"`,
		)
	}

	const type = match[2] as 'problem' | 'solution'
	return { stepNumber: stepNumber, type, subtitle }
}

function extractExerciseNumber(dir: string) {
	const regex = /^(?<number>\d+)\./
	const number = regex.exec(dir)?.groups?.number
	if (!number) {
		return null
	}
	return Number(number)
}

export async function getExercises({
	timings,
	request,
}: CachifiedOptions = {}): Promise<Array<Exercise>> {
	const apps = await getApps({ request, timings })
	const exerciseDirs = await readDir(path.join(workshopRoot, 'exercises'))
	const exercises: Array<Exercise> = []
	for (const dirName of exerciseDirs) {
		const exerciseNumber = extractExerciseNumber(dirName)
		if (!exerciseNumber) continue
		const compiledReadme = await compileMdxIfExists(
			path.join(workshopRoot, 'exercises', dirName, 'README.mdx'),
			{ request },
		)
		const compiledFinished = await compileMdxIfExists(
			path.join(workshopRoot, 'exercises', dirName, 'FINISHED.mdx'),
			{ request },
		)
		const steps: Exercise['steps'] = []
		const exerciseApps = apps
			.filter(isExerciseStepApp)
			.filter(app => app.exerciseNumber === exerciseNumber)
		for (const app of exerciseApps) {
			// @ts-ignore (editor doesn't care, but tsc does 🤷‍♂️)
			steps[app.stepNumber - 1] = {
				...steps[app.stepNumber - 1],
				[app.type]: app,
				stepNumber: app.stepNumber,
			}
		}
		exercises.push({
			exerciseNumber,
			dirName,
			instructionsCode: compiledReadme?.code,
			finishedCode: compiledFinished?.code,
			title: compiledReadme?.title ?? dirName,
			instructionsEpicVideoEmbeds: compiledReadme?.epicVideoEmbeds,
			finishedEpicVideoEmbeds: compiledFinished?.epicVideoEmbeds,
			steps,
			problems: apps
				.filter(isProblemApp)
				.filter(app => app.exerciseNumber === exerciseNumber),
			solutions: apps
				.filter(isSolutionApp)
				.filter(app => app.exerciseNumber === exerciseNumber),
		})
	}
	return exercises
}

let appCallCount = 0

export async function getApps({
	timings,
	request,
	forceFresh,
}: CachifiedOptions & { forceFresh?: boolean } = {}): Promise<Array<App>> {
	const key = 'apps'
	const apps = await cachified({
		key,
		cache: appsCache,
		timings,
		timingKey: `apps_${appCallCount++}`,
		request,
		// This entire cache is to avoid a single request getting a fresh value
		// multiple times unnecessarily (because getApps is called many times)
		ttl: 1000 * 60 * 60 * 24,
		forceFresh: forceFresh ?? getForceFresh(await appsCache.get(key)),
		getFreshValue: async () => {
			const playgroundApp = await getPlaygroundApp({ request, timings })
			const problemApps = await getProblemApps({ request, timings })
			const solutionApps = await getSolutionApps({ request, timings })
			const exampleApps = await getExampleApps({ request, timings })
			const sortedApps = [
				playgroundApp,
				...problemApps,
				...solutionApps,
				...exampleApps,
			]
				.filter(Boolean)
				.sort((a, b) => {
					if (isPlaygroundApp(a)) {
						if (isPlaygroundApp(b)) return a.name.localeCompare(b.name)
						else return 1
					}
					if (isPlaygroundApp(b)) return 1

					if (isExampleApp(a)) {
						if (isExampleApp(b)) return a.name.localeCompare(b.name)
						else return 1
					}
					if (isExampleApp(b)) return -1

					if (a.type === b.type) {
						if (a.exerciseNumber === b.exerciseNumber) {
							return a.stepNumber - b.stepNumber
						} else {
							return a.exerciseNumber - b.exerciseNumber
						}
					}

					// at this point, we know that a and b are different types...
					if (isProblemApp(a)) {
						if (a.exerciseNumber === b.exerciseNumber) {
							return a.stepNumber <= b.stepNumber ? 1 : -1
						} else {
							return a.exerciseNumber <= b.exerciseNumber ? 1 : -1
						}
					}
					if (isSolutionApp(a)) {
						if (a.exerciseNumber === b.exerciseNumber) {
							return a.stepNumber < b.stepNumber ? -1 : 1
						} else {
							return a.exerciseNumber < b.exerciseNumber ? -1 : 1
						}
					}
					console.error('unhandled sorting case', a, b)
					return 0
				})
			return sortedApps
		},
	})
	return apps
}

export function extractNumbersFromAppName(fullPath: string) {
	const regex = /(?<exerciseNumber>\d+)([^\d]*)(?<stepNumber>\d+)/g
	const { exerciseNumber, stepNumber } = regex.exec(fullPath)?.groups ?? {}
	return { exerciseNumber, stepNumber }
}

function getAppName(fullPath: string) {
	const relativePath = fullPath.replace(`${workshopRoot}${path.sep}`, '')
	return relativePath.split(path.sep).join('__sep__')
}

function getFullPathFromAppName(appName: string) {
	const relativePath = appName.replaceAll('__sep__', path.sep)
	return path.join(workshopRoot, relativePath)
}

async function findSolutionDir({
	fullPath,
}: {
	fullPath: string
}): Promise<string | null> {
	const dirName = path.basename(fullPath)
	if (dirName.includes('.problem')) {
		const info = getAppDirInfo(dirName)
		if (!info) return null
		const { stepNumber } = info
		const paddedStepNumber = stepNumber.toString().padStart(2, '0')
		const parentDir = path.dirname(fullPath)
		const siblingDirs = await fs.promises.readdir(parentDir)
		const solutionDir = siblingDirs.find(dir =>
			dir.startsWith(`${paddedStepNumber}.solution`),
		)
		if (solutionDir) {
			return path.join(parentDir, solutionDir)
		}
	} else if (fullPath.endsWith('playground')) {
		const appName = await getPlaygroundAppName()
		if (appName) {
			const solDir = await findSolutionDir({
				fullPath: getFullPathFromAppName(appName),
			})
			return solDir
		}
	}
	return null
}

async function findProblemDir({
	fullPath,
}: {
	fullPath: string
}): Promise<string | null> {
	const dirName = path.basename(fullPath)
	if (dirName.includes('.solution')) {
		const info = getAppDirInfo(dirName)
		if (!info) return null
		const { stepNumber } = info
		const paddedStepNumber = stepNumber.toString().padStart(2, '0')
		const parentDir = path.dirname(fullPath)
		const siblingDirs = await fs.promises.readdir(parentDir)
		const problemDir = siblingDirs.find(
			dir => dir.endsWith('problem') && dir.includes(paddedStepNumber),
		)
		if (problemDir) {
			return path.join(parentDir, problemDir)
		}
	} else if (fullPath.endsWith('playground')) {
		const appName = await getPlaygroundAppName()
		if (appName) {
			return findProblemDir({
				fullPath: getFullPathFromAppName(appName),
			})
		}
	}
	return null
}

async function getTestInfo({
	fullPath,
}: {
	fullPath: string
}): Promise<BaseApp['test']> {
	const testScriptName = 'test'
	const hasPkgJson = await exists(path.join(fullPath, 'package.json'))
	const testScript = hasPkgJson
		? await getPkgProp(
				fullPath,
				['kcd-workshop.scripts', testScriptName].join('.'),
				'',
		  )
		: null

	if (testScript) {
		return { type: 'script', script: testScript }
	}

	// tests are found in the corresponding solution directory
	const testAppFullPath = (await findSolutionDir({ fullPath })) ?? fullPath

	const dirList = await fs.promises.readdir(testAppFullPath)
	const testFiles = dirList.filter(item => item.includes('.test.'))
	if (testFiles.length) {
		const name = getAppName(fullPath)
		return { type: 'browser', baseUrl: `/app/${name}/test/`, testFiles }
	}

	return { type: 'none' }
}

async function getDevInfo({
	fullPath,
	portNumber,
}: {
	fullPath: string
	portNumber: number
}): Promise<BaseApp['dev']> {
	const hasPkgJson = await exists(path.join(fullPath, 'package.json'))
	const hasDevScript = hasPkgJson
		? Boolean(await getPkgProp(fullPath, ['scripts', 'dev'].join('.'), ''))
		: false

	if (hasDevScript) {
		return {
			type: 'script',
			baseUrl: `http://localhost:${portNumber}/`,
			portNumber,
		}
	}
	const name = getAppName(fullPath)
	return { type: 'browser', baseUrl: `/app/${name}/` }
}

async function getPlaygroundApp({
	timings,
	request,
}: CachifiedOptions = {}): Promise<PlaygroundApp | null> {
	const playgroundDir = path.join(workshopRoot, 'playground')
	const appName = await getPlaygroundAppName()
	const key = `playground-${appName}`
	return cachified({
		key,
		cache: playgroundAppCache,
		ttl: 1000 * 60 * 60 * 24,

		timings,
		timingKey: playgroundDir.replace(`${playgroundDir}${path.sep}`, ''),
		request,
		forceFresh: getForceFreshForDir(
			playgroundDir,
			await playgroundAppCache.get(key),
		),
		getFreshValue: async () => {
			if (!(await exists(playgroundDir))) return null
			if (!appName) return null

			const dirName = path.basename(playgroundDir)
			const name = getAppName(playgroundDir)
			const portNumber = 4000
			const [compiledReadme, test, dev] = await Promise.all([
				compileMdxIfExists(path.join(playgroundDir, 'README.mdx'), { request }),
				getTestInfo({ fullPath: playgroundDir }),
				getDevInfo({ fullPath: playgroundDir, portNumber }),
			])
			return {
				name,
				appName,
				type: 'playground',
				fullPath: playgroundDir,
				relativePath: playgroundDir.replace(
					`${getWorkshopRoot()}${path.sep}`,
					'',
				),
				title: compiledReadme?.title ?? name,
				epicVideoEmbeds: compiledReadme?.epicVideoEmbeds,
				dirName,
				instructionsCode: compiledReadme?.code,
				test,
				dev,
			} as const
		},
	}).catch(error => {
		console.error(error)
		return null
	})
}

async function getExampleAppFromPath(
	fullPath: string,
	index: number,
	request?: Request,
): Promise<ExampleApp> {
	const dirName = path.basename(fullPath)
	const compiledReadme = await compileMdxIfExists(
		path.join(fullPath, 'README.mdx'),
		{ request },
	)
	const name = getAppName(fullPath)
	const portNumber = 8000 + index
	return {
		name,
		type: 'example',
		fullPath,
		relativePath: fullPath.replace(`${getWorkshopRoot()}${path.sep}`, ''),
		title: compiledReadme?.title ?? name,
		epicVideoEmbeds: compiledReadme?.epicVideoEmbeds,
		dirName,
		instructionsCode: compiledReadme?.code,
		test: await getTestInfo({ fullPath }),
		dev: await getDevInfo({ fullPath, portNumber }),
	}
}

async function getExampleApps({
	timings,
	request,
}: CachifiedOptions = {}): Promise<Array<ExampleApp>> {
	const examplesDir = path.join(workshopRoot, 'examples')
	const exampleDirs = (
		await glob('*', { cwd: examplesDir, ignore: 'node_modules/**' })
	).map(p => path.join(examplesDir, p))

	const exampleApps: Array<ExampleApp> = []

	for (const exampleDir of exampleDirs) {
		const index = exampleDirs.indexOf(exampleDir)
		const key = `${exampleDir}-${index}`
		const exampleApp = await cachified({
			key,
			cache: exampleAppCache,
			ttl: 1000 * 60 * 60 * 24,

			timings,
			timingKey: exampleDir.replace(`${examplesDir}${path.sep}`, ''),
			request,
			forceFresh: getForceFreshForDir(
				exampleDir,
				await exampleAppCache.get(key),
			),
			getFreshValue: () =>
				getExampleAppFromPath(exampleDir, index, request).catch(error => {
					console.error(error)
					return null
				}),
		})
		if (exampleApp) exampleApps.push(exampleApp)
	}

	return exampleApps
}

async function getSolutionAppFromPath(
	fullPath: string,
	request?: Request,
): Promise<SolutionApp | null> {
	const dirName = path.basename(fullPath)
	const parentDirName = path.basename(path.dirname(fullPath))
	const exerciseNumber = extractExerciseNumber(parentDirName)
	if (!exerciseNumber) return null

	const name = getAppName(fullPath)
	const info = getAppDirInfo(dirName)
	if (!info) return null
	const { stepNumber } = info
	const portNumber = 7000 + (exerciseNumber - 1) * 10 + stepNumber
	const compiledReadme = await compileMdxIfExists(
		path.join(fullPath, 'README.mdx'),
		{ request },
	)
	const problemDir = await findProblemDir({
		fullPath,
	})
	const problemName = problemDir ? getAppName(problemDir) : null
	const [test, dev] = await Promise.all([
		getTestInfo({ fullPath }),
		getDevInfo({ fullPath, portNumber }),
	])
	return {
		name,
		title: compiledReadme?.title ?? name,
		epicVideoEmbeds: compiledReadme?.epicVideoEmbeds,
		type: 'solution',
		problemName,
		exerciseNumber,
		stepNumber,
		dirName,
		fullPath,
		relativePath: fullPath.replace(`${getWorkshopRoot()}${path.sep}`, ''),
		instructionsCode: compiledReadme?.code,
		test,
		dev,
	}
}

async function getSolutionApps({
	timings,
	request,
}: CachifiedOptions = {}): Promise<Array<SolutionApp>> {
	const exercisesDir = path.join(workshopRoot, 'exercises')
	const solutionDirs = (
		await glob('**/*solution*', {
			cwd: exercisesDir,
			ignore: 'node_modules/**',
		})
	).map(p => path.join(exercisesDir, p))
	const solutionApps: Array<SolutionApp> = []

	for (const solutionDir of solutionDirs) {
		const solutionApp = await cachified({
			key: solutionDir,
			cache: solutionAppCache,
			timings,
			timingKey: solutionDir.replace(`${exercisesDir}${path.sep}`, ''),
			request,
			ttl: 1000 * 60 * 60 * 24,

			forceFresh: getForceFreshForDir(
				solutionDir,
				await solutionAppCache.get(solutionDir),
			),
			getFreshValue: () =>
				getSolutionAppFromPath(solutionDir, request).catch(error => {
					console.error(error)
					return null
				}),
		})
		if (solutionApp) solutionApps.push(solutionApp)
	}

	return solutionApps
}

async function getProblemAppFromPath(
	fullPath: string,
	request?: Request,
): Promise<ProblemApp | null> {
	const dirName = path.basename(fullPath)
	const parentDirName = path.basename(path.dirname(fullPath))
	const exerciseNumber = extractExerciseNumber(parentDirName)
	if (!exerciseNumber) return null

	const name = getAppName(fullPath)
	const info = getAppDirInfo(dirName)
	if (!info) return null
	const { stepNumber } = info
	const portNumber = 6000 + (exerciseNumber - 1) * 10 + stepNumber
	const compiledReadme = await compileMdxIfExists(
		path.join(fullPath, 'README.mdx'),
		{ request },
	)
	const solutionDir = await findSolutionDir({
		fullPath,
	})
	const solutionName = solutionDir ? getAppName(solutionDir) : null
	const [test, dev] = await Promise.all([
		getTestInfo({ fullPath }),
		getDevInfo({ fullPath, portNumber }),
	])
	return {
		solutionName,
		name,
		title: compiledReadme?.title ?? name,
		epicVideoEmbeds: compiledReadme?.epicVideoEmbeds,
		type: 'problem',
		exerciseNumber,
		stepNumber,
		dirName,
		fullPath,
		relativePath: fullPath.replace(`${getWorkshopRoot()}${path.sep}`, ''),
		instructionsCode: compiledReadme?.code,
		test,
		dev,
	}
}

async function getProblemApps({
	timings,
	request,
}: CachifiedOptions = {}): Promise<Array<ProblemApp>> {
	const exercisesDir = path.join(workshopRoot, 'exercises')
	const problemDirs = (
		await glob('**/*problem*', {
			cwd: exercisesDir,
			ignore: 'node_modules/**',
		})
	).map(p => path.join(exercisesDir, p))
	const problemApps: Array<ProblemApp> = []
	for (const problemDir of problemDirs) {
		const problemApp = await cachified({
			key: problemDir,
			cache: problemAppCache,
			timings,
			timingKey: problemDir.replace(`${exercisesDir}${path.sep}`, ''),
			request,
			ttl: 1000 * 60 * 60 * 24,

			forceFresh: getForceFreshForDir(
				problemDir,
				await problemAppCache.get(problemDir),
			),
			getFreshValue: () =>
				getProblemAppFromPath(problemDir).catch(error => {
					console.error(error)
					return null
				}),
		})
		if (problemApp) problemApps.push(problemApp)
	}
	return problemApps
}

export async function getExercise(
	exerciseNumber: number | string,
	{ request, timings }: CachifiedOptions = {},
) {
	const exercises = await getExercises({ request, timings })
	return exercises.find(s => s.exerciseNumber === Number(exerciseNumber))
}

export async function requireExercise(
	exerciseNumber: number | string,
	{ request, timings }: CachifiedOptions = {},
) {
	const exercise = await getExercise(exerciseNumber, { request, timings })
	if (!exercise) {
		throw new Response('Not found', {
			status: 404,
			headers: { 'Server-Timing': getServerTimeHeader(timings) },
		})
	}
	return exercise
}

export async function requireExerciseApp(
	params: Parameters<typeof getExerciseApp>[0],
	{ request, timings }: CachifiedOptions = {},
) {
	const app = await getExerciseApp(params, { request, timings })
	if (!app) {
		throw new Response('Not found', { status: 404 })
	}
	return app
}

const exerciseAppParams = z.object({
	type: z.union([z.literal('problem'), z.literal('solution')]),
	exerciseNumber: z.coerce.number().finite(),
	stepNumber: z.coerce.number().finite(),
})

export async function getExerciseApp(
	params: {
		type?: string
		exerciseNumber?: string
		stepNumber?: string
	},
	{ request, timings }: CachifiedOptions = {},
) {
	const result = exerciseAppParams.safeParse(params)
	if (!result.success) {
		return null
	}
	const { type, exerciseNumber, stepNumber } = result.data

	const apps = (await getApps({ request, timings })).filter(isExerciseStepApp)
	const exerciseApp = apps.find(app => {
		if (isExampleApp(app)) return false
		return (
			app.exerciseNumber === exerciseNumber &&
			app.stepNumber === stepNumber &&
			app.type === type
		)
	})
	if (!exerciseApp) {
		return null
	}
	return exerciseApp
}

export async function getAppByName(
	name: string,
	{ request, timings }: CachifiedOptions = {},
) {
	const apps = await getApps({ request, timings })
	return apps.find(a => a.name === name)
}

export async function getNextExerciseApp(
	app: ExerciseStepApp,
	{ request, timings }: CachifiedOptions = {},
) {
	const apps = (await getApps({ request, timings })).filter(isExerciseStepApp)
	const index = apps.findIndex(a => a.name === app.name)
	if (index === -1) {
		throw new Error(`Could not find app ${app.name}`)
	}
	const nextApp = apps[index + 1]
	return nextApp ? nextApp : null
}

export async function getPrevExerciseApp(
	app: ExerciseStepApp,
	{ request, timings }: CachifiedOptions = {},
) {
	const apps = (await getApps({ request, timings })).filter(isExerciseStepApp)

	const index = apps.findIndex(a => a.name === app.name)
	if (index === -1) {
		throw new Error(`Could not find app ${app.name}`)
	}
	const prevApp = apps[index - 1]
	return prevApp ? prevApp : null
}

export function getAppPageRoute(app: ExerciseStepApp) {
	const exerciseNumber = app.exerciseNumber.toString().padStart(2, '0')
	const stepNumber = app.stepNumber.toString().padStart(2, '0')
	return `/${exerciseNumber}/${stepNumber}/${app.type}`
}

export async function setPlayground(
	srcDir: string,
	{ reset }: { reset?: boolean } = {},
) {
	const isIgnored = await isGitIgnored({ cwd: srcDir })
	const destDir = path.join(getWorkshopRoot(), 'playground')
	const playgroundFiles = path.join(destDir, '**')
	getOptionalWatcher()?.unwatch(playgroundFiles)
	const playgroundApp = await getAppByName('playground')
	const playgroundWasRunning = playgroundApp
		? isAppRunning(playgroundApp)
		: false
	if (playgroundApp && reset) {
		await closeProcess(playgroundApp.name)
		await fsExtra.remove(destDir)
	}
	const setPlaygroundTimestamp = Date.now()

	// run prepare-playground script if it exists
	const preSetPlaygroundPath = path.join(
		srcDir,
		'kcdshop',
		'pre-set-playground.js',
	)
	if (await exists(preSetPlaygroundPath)) {
		await execa('node', [preSetPlaygroundPath], {
			cwd: workshopRoot,
			stdio: 'inherit',
			env: {
				KCDSHOP_PLAYGROUND_TIMESTAMP: setPlaygroundTimestamp.toString(),
				KCDSHOP_PLAYGROUND_DEST_DIR: destDir,
				KCDSHOP_PLAYGROUND_SRC_DIR: srcDir,
				KCDSHOP_PLAYGROUND_WAS_RUNNING: playgroundWasRunning.toString(),
			} as any,
		})
	}

	const basename = path.basename(srcDir)
	// If we don't delete the destination node_modules first then copying the new
	// node_modules has issues.
	await fsExtra.remove(path.join(destDir, 'node_modules'))
	// Copy the contents of the source directory to the destination directory recursively
	await fsExtra.copy(srcDir, destDir, {
		filter: async (srcFile, destFile) => {
			if (
				srcFile.includes(`${basename}${path.sep}build`) ||
				srcFile.includes(`${basename}${path.sep}public${path.sep}build`)
			) {
				return false
			}
			if (srcFile === srcDir) return true
			// we copy node_modules even though it's .gitignored
			if (srcFile.includes('node_modules')) return true
			// make sure .env is copied whether it's .gitignored or not
			if (srcFile.endsWith('.env')) return true
			if (isIgnored(srcFile)) return false

			try {
				const isDir = (await fsExtra.stat(srcFile)).isDirectory()
				if (isDir) return true
				const destIsDir = (await fsExtra.stat(destFile)).isDirectory()
				// weird, but ok
				if (destIsDir) return true

				// it's better to check if the contents are the same before copying
				// because it avoids unnecessary writes and reduces the impact on any
				// file watchers (like the remix dev server). In practice, it's definitely
				// slower, but it's better because it doesn't cause the dev server to
				// crash as often.
				const currentContents = await fsExtra.readFile(destFile)
				const newContents = await fsExtra.readFile(srcFile)
				if (currentContents.equals(newContents)) return false

				return true
			} catch {
				// 🤷‍♂️ should probably copy it in this case
				return true
			}
		},
	})

	async function getFiles(dir: string) {
		// make globby friendly to windows
		const dirPath = dir.replace(/\\/g, '/')
		const files = await globby([`${dirPath}/**/*`, '!**/build/**/*'], {
			onlyFiles: false,
			dot: true,
		})
		return files.map(f => f.replace(dirPath, ''))
	}

	// Remove files from destDir that were in destDir before but are not in srcDir
	const srcFiles = await getFiles(srcDir)
	const destFiles = await getFiles(destDir)
	const filesToDelete = destFiles.filter(
		fileName => !srcFiles.includes(fileName),
	)

	for (const fileToDelete of filesToDelete) {
		await fsExtra.remove(path.join(destDir, fileToDelete))
	}

	const appName = getAppName(srcDir)
	await fsExtra.ensureDir(path.dirname(playgroundAppNameInfoPath))
	await fsExtra.writeJSON(playgroundAppNameInfoPath, { appName })

	const playgroundIsStillRunning = playgroundApp
		? isAppRunning(playgroundApp)
		: false
	const restartPlayground = playgroundWasRunning && !playgroundIsStillRunning

	// run postSet-playground script if it exists
	const postSetPlaygroundPath = path.join(
		srcDir,
		'kcdshop',
		'post-set-playground.js',
	)
	if (await exists(postSetPlaygroundPath)) {
		await execa('node', [postSetPlaygroundPath], {
			cwd: workshopRoot,
			stdio: 'inherit',
			env: {
				KCDSHOP_PLAYGROUND_TIMESTAMP: setPlaygroundTimestamp.toString(),
				KCDSHOP_PLAYGROUND_SRC_DIR: srcDir,
				KCDSHOP_PLAYGROUND_DEST_DIR: destDir,
				KCDSHOP_PLAYGROUND_WAS_RUNNING: playgroundWasRunning.toString(),
				KCDSHOP_PLAYGROUND_IS_STILL_RUNNING:
					playgroundIsStillRunning.toString(),
				KCDSHOP_PLAYGROUND_RESTART_PLAYGROUND: restartPlayground.toString(),
			} as any,
		})
	}

	if (playgroundApp) {
		if (playgroundWasRunning && playgroundIsStillRunning) {
			// let the playground know it was re-set
			sendAppMessage(playgroundApp, 'playground-set')
		} else if (restartPlayground) {
			await runAppDev(playgroundApp)
			await waitOnApp(playgroundApp)
		}
	}

	getOptionalWatcher()?.add(playgroundFiles)
	modifiedTimes.set(destDir, Date.now())
}

export async function getPlaygroundAppName() {
	if (!(await exists(playgroundAppNameInfoPath))) {
		return null
	}
	try {
		const jsonString = await fs.promises.readFile(
			playgroundAppNameInfoPath,
			'utf8',
		)
		const { appName } = JSON.parse(jsonString) as any
		if (typeof appName !== 'string') return null
		return appName
	} catch {
		return null
	}
}

export async function getWorkshopTitle() {
	const title = await getPkgProp<string>(workshopRoot, 'kcd-workshop.title')
	if (!title) {
		throw new Error(
			`Workshop title not found. Make sure the root of the workshop has "kcd-workshop" with a "title" property in the package.json. ${workshopRoot}`,
		)
	}
	return title
}

export async function getEpicWorkshopSlug() {
	const epicWorkshopSlug = await getPkgProp<string>(
		workshopRoot,
		'kcd-workshop.epicWorkshopSlug',
	)
	return epicWorkshopSlug || null
}

export function getWorkshopRoot() {
	return process.env.KCDSHOP_CONTEXT_CWD ?? process.cwd()
}

export async function getWorkshopInstructions({
	request,
}: { request?: Request } = {}) {
	const readmeFilepath = path.join(workshopRoot, 'exercises', 'README.mdx')
	const compiled = await compileMdx(readmeFilepath, { request }).then(
		r => ({ ...r, status: 'success' }) as const,
		e => {
			console.error(
				`There was an error compiling the workshop readme`,
				readmeFilepath,
				e,
			)
			return { status: 'error', error: getErrorMessage(e) } as const
		},
	)
	return { compiled, file: readmeFilepath, relativePath: 'exercises' } as const
}

export async function getWorkshopFinished({
	request,
}: { request?: Request } = {}) {
	const finishedFilepath = path.join(workshopRoot, 'exercises', 'FINISHED.mdx')
	const compiled = await compileMdx(finishedFilepath, { request }).then(
		r => ({ ...r, status: 'success' }) as const,
		e => {
			console.error(
				`There was an error compiling the workshop finished.mdx`,
				finishedFilepath,
				e,
			)
			return { status: 'error', error: getErrorMessage(e) } as const
		},
	)
	return {
		compiled,
		file: finishedFilepath,
		relativePath: 'exercises/finished.mdx',
	} as const
}

const exercisesPath = path.join(workshopRoot, 'exercises/')
const playgroundPath = path.join(workshopRoot, 'playground/')
export function getRelativePath(filePath: string) {
	return path
		.normalize(filePath)
		.replace(playgroundPath, `playground${path.sep}`)
		.replace(exercisesPath, '')
}
