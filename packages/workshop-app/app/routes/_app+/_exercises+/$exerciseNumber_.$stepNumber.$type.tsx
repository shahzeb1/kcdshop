import * as Tabs from '@radix-ui/react-tabs'
import * as Select from '@radix-ui/react-select'
import type {
	DataFunctionArgs,
	HeadersFunction,
	SerializeFrom,
	MetaFunction,
} from '@remix-run/node'
import { defer, redirect } from '@remix-run/node'
import {
	Link,
	isRouteErrorResponse,
	useLoaderData,
	useRouteError,
	useSearchParams,
	type LinkProps,
	useNavigate,
} from '@remix-run/react'
import { clsx } from 'clsx'
import * as React from 'react'
import { useMemo, useRef, useState, type PropsWithChildren } from 'react'
import { Diff } from '~/components/diff.tsx'
import { Icon } from '~/components/icons.tsx'
import {
	InBrowserBrowser,
	type InBrowserBrowserRef,
} from '~/components/in-browser-browser.tsx'
import { InBrowserTestRunner } from '~/components/in-browser-test-runner.tsx'
import TouchedFiles from '~/components/touched-files.tsx'
import { type loader as rootLoader } from '~/root.tsx'
import {
	PlaygroundChooser,
	SetAppToPlayground,
	SetPlayground,
} from '~/routes/set-playground.tsx'
import type { App, ExerciseStepApp } from '~/utils/apps.server.ts'
import {
	getAppByName,
	getAppPageRoute,
	getApps,
	getExerciseApp,
	getNextExerciseApp,
	getPrevExerciseApp,
	isExerciseStepApp,
	isPlaygroundApp,
	requireExercise,
	requireExerciseApp,
} from '~/utils/apps.server.ts'
import { getDiffCode, getDiffFiles } from '~/utils/diff.server.ts'
import { Mdx } from '~/utils/mdx.tsx'
import { cn, getErrorMessage, useAltDown, useMetaDown } from '~/utils/misc.tsx'
import {
	isAppRunning,
	isPortAvailable,
} from '~/utils/process-manager.server.ts'
import {
	combineServerTimings,
	getServerTimeHeader,
	makeTimings,
} from '~/utils/timing.server.ts'
import { EditFileOnGitHub, LaunchEditor } from '~/routes/launch-editor.tsx'
import { TestOutput } from '../../test.tsx'
import { NavChevrons } from '~/components/nav-chevrons.tsx'
import { UpdateMdxCache } from '~/routes/update-mdx-cache.tsx'

function pageTitle(
	data: SerializeFrom<typeof loader> | undefined,
	workshopTitle?: string,
) {
	const exerciseNumber =
		data?.exerciseStepApp.exerciseNumber.toString().padStart(2, '0') ?? '00'
	const stepNumber =
		data?.exerciseStepApp.stepNumber.toString().padStart(2, '0') ?? '00'
	const emoji = (
		{
			problem: '💪',
			solution: '🏁',
		} as const
	)[data?.type ?? 'problem']
	const title = data?.[data.type]?.title ?? 'N/A'
	return {
		emoji,
		stepNumber,
		title,
		exerciseNumber,
		exerciseTitle: data?.exerciseTitle ?? 'Unknown exercise',
		workshopTitle,
		type: data?.type ?? 'problem',
	}
}

export const meta: MetaFunction<typeof loader, { root: typeof rootLoader }> = ({
	data,
	matches,
}) => {
	const rootData = matches.find(m => m.id === 'root')?.data
	const { emoji, stepNumber, title, exerciseNumber, exerciseTitle } =
		pageTitle(data)
	return [
		{
			title: `${emoji} | ${stepNumber}. ${title} | ${exerciseNumber}. ${exerciseTitle} | ${
				rootData?.workshopTitle ?? 'KCD Workshop'
			}`,
		},
	]
}

export async function loader({ request, params }: DataFunctionArgs) {
	const timings = makeTimings('exerciseStepTypeLoader')
	const cacheOptions = { request, timings }
	const exerciseStepApp = await requireExerciseApp(params, cacheOptions)
	const exercise = await requireExercise(
		exerciseStepApp.exerciseNumber,
		cacheOptions,
	)
	const reqUrl = new URL(request.url)

	const pathnameParam = reqUrl.searchParams.get('pathname')
	if (pathnameParam === '' || pathnameParam === '/') {
		reqUrl.searchParams.delete('pathname')
		throw redirect(reqUrl.toString())
	}

	const problemApp = await getExerciseApp(
		{ ...params, type: 'problem' },
		cacheOptions,
	)
	const solutionApp = await getExerciseApp(
		{ ...params, type: 'solution' },
		cacheOptions,
	)

	if (!problemApp && !solutionApp) {
		throw new Response('Not found', { status: 404 })
	}

	const allAppsFull = await getApps(cacheOptions)
	const playgroundApp = allAppsFull.find(isPlaygroundApp)

	const app1Name = reqUrl.searchParams.get('app1')
	const app2Name = reqUrl.searchParams.get('app2')
	const app1 = app1Name
		? await getAppByName(app1Name)
		: playgroundApp || problemApp
	const app2 = app2Name ? await getAppByName(app2Name) : solutionApp

	function getDisplayName(a: App) {
		let displayName = `${a.title} (${a.type})`
		if (isExerciseStepApp(a)) {
			displayName = `${a.exerciseNumber}.${a.stepNumber} ${a.title} (${
				{ problem: '💪', solution: '🏁' }[a.type]
			} ${a.type})`
		} else if (isPlaygroundApp(a)) {
			const playgroundAppBasis = allAppsFull.find(
				otherApp => a.appName === otherApp.name,
			)
			if (playgroundAppBasis) {
				const basisDisplayName = getDisplayName(playgroundAppBasis)
				displayName = `🛝 Playground: ${basisDisplayName}`
			} else {
				displayName = `🛝 Playground: ${a.appName}`
			}
		}
		return displayName
	}

	function getStepId(a: ExerciseStepApp) {
		return (
			a.exerciseNumber * 1000 +
			a.stepNumber * 10 +
			(a.type === 'problem' ? 0 : 1)
		)
	}

	function getStepNameAndId(a: App) {
		if (isExerciseStepApp(a)) {
			const exerciseNumberStr = String(a.exerciseNumber).padStart(2, '0')
			const stepNumberStr = String(a.stepNumber).padStart(2, '0')

			return {
				stepName: `${exerciseNumberStr}/${stepNumberStr}.${a.type}`,
				stepId: getStepId(a),
			}
		}
		return { stepName: '', stepId: -1 }
	}

	async function getAppRunningState(a: App) {
		if (a?.dev.type !== 'script') {
			return { isRunning: false, portIsAvailable: null }
		}
		const isRunning = isAppRunning(a)
		const portIsAvailable = isRunning
			? null
			: await isPortAvailable(a.dev.portNumber)
		return { isRunning, portIsAvailable }
	}

	const allApps = allAppsFull
		.filter((a, i, ar) => ar.findIndex(b => a.name === b.name) === i)
		.map(a => ({
			displayName: getDisplayName(a),
			name: a.name,
			title: a.title,
			type: a.type,
			...getStepNameAndId(a),
		}))

	allApps.sort((a, b) => a.stepId - b.stepId)
	const exerciseId = getStepId(exerciseStepApp)
	const exerciseIndex = allApps.findIndex(step => step.stepId === exerciseId)

	const exerciseApps = allAppsFull
		.filter(isExerciseStepApp)
		.filter(app => app.exerciseNumber === exerciseStepApp.exerciseNumber)
	const isLastStep =
		exerciseApps[exerciseApps.length - 1]?.name === exerciseStepApp.name
	const isFirstStep = exerciseApps[0]?.name === exerciseStepApp.name

	const nextApp = await getNextExerciseApp(exerciseStepApp, cacheOptions)
	const prevApp = await getPrevExerciseApp(exerciseStepApp, cacheOptions)

	async function getDiffProp() {
		if (!app1 || !app2) {
			return {
				app1: app1?.name,
				app2: app2?.name,
				diffCode: null,
				diffFiles: null,
			}
		}
		const [diffCode, diffFiles] = await Promise.all([
			getDiffCode(app1, app2, cacheOptions).catch(e => {
				console.error(e)
				return null
			}),
			problemApp && solutionApp
				? getDiffFiles(problemApp, solutionApp, cacheOptions).catch(e => {
						console.error(e)
						return 'There was a problem generating the diff'
				  })
				: 'No diff available',
		])
		return {
			app1: app1.name,
			app2: app2.name,
			diffCode,
			diffFiles,
		}
	}

	return defer(
		{
			type: params.type as 'problem' | 'solution',
			exerciseStepApp,
			exerciseTitle: exercise.title,
			exerciseIndex,
			allApps,
			prevStepLink: isFirstStep
				? {
						to: `/${exerciseStepApp.exerciseNumber
							.toString()
							.padStart(2, '0')}`,
						children: `⬅️ ${exercise.title}`,
				  }
				: prevApp
				? {
						to: getAppPageRoute(prevApp),
						children: `⬅️ ${prevApp.title} (${prevApp.type})`,
				  }
				: null,
			nextStepLink: isLastStep
				? {
						to: `/${exerciseStepApp.exerciseNumber
							.toString()
							.padStart(2, '0')}/finished`,
				  }
				: nextApp
				? {
						to: getAppPageRoute(nextApp),
				  }
				: null,
			playground: playgroundApp
				? {
						type: 'playground',
						fullPath: playgroundApp.fullPath,
						dev: playgroundApp.dev,
						test: playgroundApp.test,
						title: playgroundApp.title,
						name: playgroundApp.name,
						appName: playgroundApp.appName,
						...(await getAppRunningState(playgroundApp)),
				  }
				: null,
			problem: problemApp
				? {
						type: 'problem',
						fullPath: problemApp.fullPath,
						dev: problemApp.dev,
						test: problemApp.test,
						title: problemApp.title,
						name: problemApp.name,
						...(await getAppRunningState(problemApp)),
				  }
				: null,
			solution: solutionApp
				? {
						type: 'solution',
						fullPath: solutionApp.fullPath,
						dev: solutionApp.dev,
						test: solutionApp.test,
						title: solutionApp.title,
						name: solutionApp.name,
						...(await getAppRunningState(solutionApp)),
				  }
				: null,
			diff: getDiffProp(),
		} as const,
		{
			headers: {
				'Server-Timing': getServerTimeHeader(timings),
			},
		},
	)
}

export const headers: HeadersFunction = ({ loaderHeaders, parentHeaders }) => {
	const headers = {
		'Server-Timing': combineServerTimings(loaderHeaders, parentHeaders),
	}
	return headers
}

const previewOptions = ENV.KCDSHOP_DEPLOYED
	? (['diff'] as const)
	: (['playground', 'problem', 'solution', 'tests', 'diff'] as const)
const isValidPreview = (
	s: string | null,
): s is (typeof previewOptions)[number] =>
	Boolean(s && previewOptions.includes(s as (typeof previewOptions)[number]))

const otherPreviewOptions = ['problem', 'solution', 'diff'] as const

function withParam(
	searchParams: URLSearchParams,
	key: string,
	value: string | null,
) {
	const newSearchParams = new URLSearchParams(searchParams)
	if (value === null) {
		newSearchParams.delete(key)
	} else {
		newSearchParams.set(key, value)
	}
	return newSearchParams
}

type CodeFileNotificationProps = {
	file: string
	type?: 'solution' | 'problem'
	children: React.ReactNode
} & (
	| {
			variant: 'error'
			cacheLocation?: never
			embeddedKey?: never
	  }
	| {
			variant: 'warning'
			cacheLocation: string
			embeddedKey: string
	  }
)

export default function ExercisePartRoute() {
	const data = useLoaderData<typeof loader>()
	const [searchParams] = useSearchParams()

	const preview = searchParams.get('preview')
	const activePreview = isValidPreview(preview) ? preview : previewOptions[0]
	const inBrowserBrowserRef = useRef<InBrowserBrowserRef>(null)
	const previewAppUrl = data.playground?.dev.baseUrl

	const DiffLink = useMemo(() => {
		return function DiffLink({
			app1 = 0,
			app2 = 1,
			children,
			fullPage = false,
			to,
		}: {
			app1?: string | number | null
			app2?: string | number | null
			to?: string
			fullPage?: boolean
			children?: React.ReactNode
		}) {
			if (!to && !app1 && !app2) {
				return (
					<callout-danger className="notification">
						<div className="title">DiffLink Error: invalid input</div>
					</callout-danger>
				)
			}

			function getAppName(input: typeof app1) {
				if (typeof input === 'number') {
					const stepIndex = data.exerciseIndex + input
					return data.allApps[stepIndex]?.name
				}
				if (!input) return null
				for (const { name, stepName } of data.allApps) {
					if (input === name || input === stepName) {
						return name
					}
				}
				return null
			}

			if (to) {
				const params = new URLSearchParams(to)
				app1 = params.get('app1')
				app2 = params.get('app2')
			}
			const app1Name = getAppName(app1)
			const app2Name = getAppName(app2)
			if (!app1Name || !app2Name) {
				return (
					<callout-danger className="notification">
						<div className="title">DiffLink Error: invalid input</div>
						{!app1Name && <div>app1: "{app1}" is not a valid app name</div>}
						{!app2Name && <div>app2: "{app2}" is not a valid app name</div>}
					</callout-danger>
				)
			}

			if (!to) {
				to = `app1=${app1Name}&app2=${app2Name}`
			}
			const pathToDiff = fullPage
				? `/diff?${to}`
				: `?${decodeURIComponent(
						withParam(
							new URLSearchParams(),
							'preview',
							`diff&${to}`,
						).toString(),
				  )}`

			if (!children) {
				const msg = (s: string) => s.split('__sep__')[2] ?? ''
				children = (
					<span>
						Go to Diff {fullPage ? '' : 'Preview'} from:{' '}
						<code>{msg(app1Name)}</code> to: <code>{msg(app2Name)}</code>
					</span>
				)
			}

			return <Link to={pathToDiff}>{children}</Link>
		}
	}, [data.allApps, data.exerciseIndex])

	const CodeFile = useMemo(() => {
		return function CodeFile({ file }: { file: string }) {
			return (
				<div className="border-4 border-[#ff4545] bg-[#ff454519] p-4 text-lg">
					Something went wrong compiling <b>CodeFile</b> for file: <u>{file}</u>{' '}
					to markdown
				</div>
			)
		}
	}, [])

	const CodeFileNotification = useMemo(() => {
		return function CodeFileNotification({
			file,
			type = 'problem',
			children,
			variant,
			cacheLocation,
			embeddedKey,
			...props
		}: CodeFileNotificationProps) {
			const [visibility, setVisibility] = useState('visible')
			const app = data[type]

			const handleClick = () => {
				if (visibility !== 'visible') return
				setVisibility('collapse')
				setTimeout(() => {
					setVisibility('none')
				}, 400)
			}

			const className = clsx(
				'rounded px-4 py-1 font-mono text-sm font-semibold outline-none transition duration-300 ease-in-out',
				{
					'bg-amber-300/70 hover:bg-amber-300/40 active:bg-amber-300/50':
						variant === 'warning',
					'bg-red-300/70 hover:bg-red-300/40 active:bg-red-300/50':
						variant === 'error',
				},
			)

			return (
				<div
					className={clsx('notification important h-15 relative', {
						'duration-400 !my-0 !h-0 !py-0 !opacity-0 transition-all ease-out':
							visibility !== 'visible',
						hidden: visibility === 'none',
					})}
				>
					<div className="absolute right-3 top-3 z-50 flex gap-4">
						{app ? (
							<div className={className} title={`Edit ${file}`}>
								<LaunchEditor appFile={file} appName={app.name} {...props}>
									Edit this File
								</LaunchEditor>
							</div>
						) : null}
						{app && variant === 'warning' ? (
							<div
								className={className}
								title={`Remove the warning from here and from ${file} cache file`}
							>
								<UpdateMdxCache
									handleClick={handleClick}
									cacheLocation={cacheLocation}
									embeddedKey={embeddedKey}
									appFullPath={app.fullPath}
								/>
							</div>
						) : null}
					</div>
					{children}
				</div>
			)
		}
	}, [data])

	const InlineFile = useMemo(() => {
		return function InlineFile({
			file,
			type = 'playground',
			children = <code>{file}</code>,
			...props
		}: Omit<PropsWithChildren<typeof LaunchEditor>, 'appName'> & {
			file: string
			type?: 'playground' | 'solution' | 'problem'
		}) {
			const app = data[type] || data[data.type]

			const info = (
				<div className="launch-editor-button-wrapper flex underline">
					{children}{' '}
					<svg height={24} width={24}>
						<use href={`/icons.svg#keyboard`} />
					</svg>
				</div>
			)

			return ENV.KCDSHOP_DEPLOYED && app ? (
				<div className="inline-block grow">
					<LaunchEditor appFile={file} appName={app.name} {...props}>
						{info}
					</LaunchEditor>
				</div>
			) : app ? (
				<div className="inline-block grow">
					<LaunchEditor appFile={file} appName={app.name} {...props}>
						{info}
					</LaunchEditor>
				</div>
			) : type === 'playground' ? (
				// playground does not exist yet
				<div
					className="inline-block grow cursor-not-allowed"
					title="You must 'Set to Playground' before opening a file"
				>
					{info}
				</div>
			) : (
				<>children</>
			)
		}
	}, [data])

	const LinkToApp = useMemo(() => {
		return function LinkToApp({
			to: appTo,
			children = <code>{appTo.toString()}</code>,
			...props
		}: LinkProps) {
			const to = `?${withParam(
				searchParams,
				'pathname',
				appTo.toString(),
			).toString()}`
			const href = previewAppUrl
				? previewAppUrl.slice(0, -1) + appTo.toString()
				: null
			return (
				<div className="inline-flex items-center justify-between gap-1">
					<Link
						to={to}
						{...props}
						className={cn(props.className, {
							'cursor-not-allowed': ENV.KCDSHOP_DEPLOYED,
						})}
						title={
							ENV.KCDSHOP_DEPLOYED
								? 'Cannot link to app in deployed version'
								: undefined
						}
						onClick={event => {
							if (ENV.KCDSHOP_DEPLOYED) event.preventDefault()

							props.onClick?.(event)
							inBrowserBrowserRef.current?.handleExtrnalNavigation(
								appTo.toString(),
							)
						}}
					>
						{children}
					</Link>
					{href ? (
						<a
							href={href}
							target="_blank"
							rel="noreferrer"
							className={cn('flex aspect-square items-center justify-center', {
								'cursor-not-allowed': ENV.KCDSHOP_DEPLOYED,
							})}
							title={
								ENV.KCDSHOP_DEPLOYED
									? 'Cannot link to app in deployed version'
									: 'Open in new tab'
							}
							onClick={event => {
								if (ENV.KCDSHOP_DEPLOYED) event.preventDefault()
							}}
						>
							<Icon name="ExternalLink" title="Open in new tab" />
						</a>
					) : null}
				</div>
			)
		}
	}, [searchParams, previewAppUrl])

	const titleBits = pageTitle(data)

	return (
		<div className="flex flex-grow flex-col">
			<main className="grid h-full flex-grow grid-cols-1 grid-rows-2 lg:grid-cols-2 lg:grid-rows-1">
				<div className="relative col-span-1 row-span-1 flex h-full flex-col border-r border-border">
					<h1 className="h-14 border-b pl-10 pr-5 text-sm font-medium uppercase leading-tight">
						<div className="flex h-14 flex-wrap items-center justify-between gap-x-2 py-2">
							<div className="flex items-center justify-start gap-x-2">
								<Link
									to={`/${titleBits.exerciseNumber}`}
									className="hover:underline"
								>
									{titleBits.exerciseNumber}. {titleBits.exerciseTitle}
								</Link>
								{'/'}
								<Link to="." className="hover:underline">
									{titleBits.stepNumber}. {titleBits.title}
									{' ('}
									{titleBits.emoji} {titleBits.type}
									{')'}
								</Link>
							</div>
							{data.problem &&
							data.playground?.appName !== data.problem.name ? (
								<SetAppToPlayground appName={data.problem.name} />
							) : null}
						</div>
					</h1>
					<article
						className="shadow-on-scrollbox prose h-full w-full max-w-none flex-1 space-y-6 overflow-y-auto p-10 pt-8 scrollbar-thin scrollbar-thumb-scrollbar dark:prose-invert sm:prose-lg"
						data-restore-scroll="true"
					>
						{data.exerciseStepApp.instructionsCode ? (
							<Mdx
								code={data.exerciseStepApp?.instructionsCode}
								components={{
									CodeFile,
									CodeFileNotification,
									DiffLink,
									InlineFile,
									LinkToApp,
								}}
							/>
						) : (
							<p>No instructions yet...</p>
						)}
					</article>
					<div className="flex h-16 justify-between border-b-4 border-t border-border lg:border-b-0">
						<div>
							<div className="h-full">
								<TouchedFiles />
							</div>
						</div>
						<EditFileOnGitHub
							appName={data.exerciseStepApp.name}
							relativePath={data.exerciseStepApp.relativePath}
						/>
						<NavChevrons
							prev={
								data.prevStepLink
									? {
											to: data.prevStepLink.to,
											'aria-label': 'Previous Step',
									  }
									: null
							}
							next={
								data.nextStepLink
									? {
											to: data.nextStepLink.to,
											'aria-label': 'Next Step',
									  }
									: null
							}
						/>
					</div>
				</div>
				<div className="relative col-span-1 row-span-1">
					<Tabs.Root
						className="flex flex-col"
						value={activePreview}
						// intentionally no onValueChange here because the Link will trigger the
						// change.
					>
						<div className="flex justify-between">
							<Tabs.List>
								<Tabs.Trigger
									value="playground"
									className="clip-path-button relative h-14 px-6 py-4 font-mono text-sm uppercase outline-none radix-state-active:z-10 radix-state-active:bg-foreground radix-state-active:text-background radix-state-active:hover:bg-foreground/80 radix-state-active:hover:text-background/80 radix-state-inactive:hover:bg-foreground/20 radix-state-inactive:hover:text-foreground/80 focus:bg-foreground/80 focus:text-background/80"
								>
									<Link
										preventScrollReset
										prefetch="intent"
										to={`?${withParam(searchParams, 'preview', null)}`}
									>
										playground
									</Link>
								</Tabs.Trigger>
								{data.playground?.test.type === 'none' ? null : (
									<Tabs.Trigger
										value="tests"
										className="clip-path-button relative h-14 px-6 py-4 font-mono text-sm uppercase outline-none radix-state-active:z-10 radix-state-active:bg-foreground radix-state-active:text-background radix-state-active:hover:bg-foreground/80 radix-state-active:hover:text-background/80 radix-state-inactive:hover:bg-foreground/20 radix-state-inactive:hover:text-foreground/80 focus:bg-foreground/80 focus:text-background/80"
									>
										<Link
											preventScrollReset
											prefetch="intent"
											to={`?${withParam(searchParams, 'preview', 'tests')}`}
										>
											tests
										</Link>
									</Tabs.Trigger>
								)}
							</Tabs.List>
							<OtherPreviewsSelect
								activePreview={activePreview}
								problemName={data.problem?.name}
								solutionName={data.solution?.name}
							/>
						</div>
						<div className="relative z-10 flex flex-grow flex-col overflow-y-auto border-t border-border">
							<Tabs.Content
								value="playground"
								className="flex flex-grow items-center justify-center radix-state-inactive:hidden"
							>
								<Playground
									appInfo={data.playground}
									problemAppName={data.problem?.name}
									inBrowserBrowserRef={inBrowserBrowserRef}
									allApps={data.allApps}
								/>
							</Tabs.Content>
							<Tabs.Content
								value="problem"
								className="flex flex-grow items-center justify-center radix-state-inactive:hidden"
							>
								<Preview
									appInfo={data.problem}
									inBrowserBrowserRef={inBrowserBrowserRef}
								/>
							</Tabs.Content>
							<Tabs.Content
								value="solution"
								className="flex flex-grow items-center justify-center radix-state-inactive:hidden"
							>
								<Preview
									appInfo={data.solution}
									inBrowserBrowserRef={inBrowserBrowserRef}
								/>
							</Tabs.Content>
							<Tabs.Content
								value="tests"
								className="flex flex-grow items-start justify-center overflow-hidden radix-state-inactive:hidden"
							>
								<Tests
									appInfo={data.playground}
									problemAppName={data.problem?.name}
									allApps={data.allApps}
								/>
							</Tabs.Content>
							<Tabs.Content
								value="diff"
								className="flex h-full flex-grow items-start justify-center radix-state-inactive:hidden"
							>
								<Diff diff={data.diff} allApps={data.allApps} />
							</Tabs.Content>
						</div>
					</Tabs.Root>
				</div>
			</main>
		</div>
	)
}

function Preview({
	id,
	appInfo,
	inBrowserBrowserRef,
}: {
	id?: string
	appInfo: SerializeFrom<typeof loader>['problem' | 'solution' | 'playground']
	inBrowserBrowserRef: React.RefObject<InBrowserBrowserRef>
}) {
	if (!appInfo) return <p>No app here. Sorry.</p>
	const { isRunning, dev, name, portIsAvailable, title } = appInfo

	if (dev.type === 'script') {
		return (
			<InBrowserBrowser
				ref={inBrowserBrowserRef}
				isRunning={isRunning}
				id={id ?? name}
				name={name}
				portIsAvailable={portIsAvailable}
				port={dev.portNumber}
				baseUrl={dev.baseUrl}
			/>
		)
	} else {
		return (
			<div className="relative h-full flex-grow overflow-y-auto scrollbar-thin scrollbar-thumb-scrollbar">
				<a
					href={dev.baseUrl}
					target="_blank"
					rel="noreferrer"
					className={clsx(
						'absolute bottom-5 right-5 flex items-center justify-center rounded-full bg-gray-100 p-2.5 transition hover:bg-gray-200',
					)}
				>
					<Icon name="ExternalLink" aria-hidden="true" />
					<span className="sr-only">Open in New Window</span>
				</a>
				<iframe
					title={title}
					src={dev.baseUrl}
					className="h-full w-full flex-grow bg-white p-3"
				/>
			</div>
		)
	}
}

function Playground({
	appInfo: playgroundAppInfo,
	inBrowserBrowserRef,
	problemAppName,
	allApps,
}: {
	appInfo: SerializeFrom<typeof loader>['playground']
	inBrowserBrowserRef: React.RefObject<InBrowserBrowserRef>
	problemAppName?: string
	allApps: Array<{ name: string; displayName: string }>
}) {
	return (
		<PlaygroundWindow
			appInfo={playgroundAppInfo}
			problemAppName={problemAppName}
			allApps={allApps}
		>
			<Preview
				id={playgroundAppInfo?.appName}
				appInfo={playgroundAppInfo}
				inBrowserBrowserRef={inBrowserBrowserRef}
			/>
		</PlaygroundWindow>
	)
}

function PlaygroundWindow({
	appInfo: playgroundAppInfo,
	problemAppName,
	allApps,
	children,
}: {
	appInfo: SerializeFrom<typeof loader>['playground']
	problemAppName?: string
	allApps: Array<{ name: string; displayName: string }>
	children: React.ReactNode
}) {
	const playgroundLinkedUI =
		playgroundAppInfo?.appName === problemAppName ? (
			<Icon size={28} name="Linked" title="Click to reset Playground." />
		) : (
			<Icon
				title="Playground is not set to the right app. Click to set Playground."
				size={28}
				name="Unlinked"
				className="animate-pulse text-foreground-danger"
			/>
		)
	return (
		<div className="flex h-full w-full flex-col justify-between">
			<div className="flex h-14 flex-shrink-0 items-center justify-start gap-2 border-b border-border px-3">
				<div className="display-alt-up flex">
					{problemAppName ? (
						<SetPlayground appName={problemAppName}>
							{playgroundLinkedUI}
						</SetPlayground>
					) : (
						<div className="flex">{playgroundLinkedUI}</div>
					)}
				</div>
				<div className="display-alt-down">
					{playgroundAppInfo?.appName ? (
						<SetPlayground appName={playgroundAppInfo?.appName}>
							<div className="flex h-7 w-7 items-center justify-center">
								<Icon name="Refresh" title="Reset Playground" />
							</div>
						</SetPlayground>
					) : (
						<div className="h-7 w-7" />
					)}
				</div>
				<PlaygroundChooser
					allApps={allApps}
					playgroundAppName={playgroundAppInfo?.appName}
				/>
			</div>
			<div className="flex flex-1 flex-grow items-center justify-center">
				{children}
			</div>
		</div>
	)
}

function Tests({
	appInfo: playgroundAppInfo,
	problemAppName,
	allApps,
}: {
	appInfo: SerializeFrom<typeof loader>['playground']
	problemAppName?: string
	allApps: Array<{ name: string; displayName: string }>
}) {
	const [inBrowserTestKey, setInBrowserTestKey] = useState(0)
	let testUI = <p>No tests here. Sorry.</p>
	if (playgroundAppInfo?.test.type === 'script') {
		testUI = <TestOutput name={playgroundAppInfo.name} />
	}
	if (playgroundAppInfo?.test.type === 'browser') {
		const { baseUrl } = playgroundAppInfo.test
		testUI = (
			<div
				className="flex h-full w-full flex-grow flex-col overflow-y-auto scrollbar-thin scrollbar-thumb-scrollbar"
				key={inBrowserTestKey}
			>
				{playgroundAppInfo.test.testFiles.map(testFile => {
					return (
						<div key={testFile}>
							<InBrowserTestRunner baseUrl={baseUrl} testFile={testFile} />
						</div>
					)
				})}
				<div className="px-3 py-[21px]">
					{playgroundAppInfo.type === 'solution' ? (
						<div>NOTE: these tests are running on the solution</div>
					) : null}
					<button
						onClick={() => setInBrowserTestKey(c => c + 1)}
						className="flex items-center gap-2 font-mono text-sm uppercase leading-none"
					>
						<Icon name="Refresh" aria-hidden /> Rerun All Tests
					</button>
				</div>
			</div>
		)
	}
	return (
		<PlaygroundWindow
			appInfo={playgroundAppInfo}
			problemAppName={problemAppName}
			allApps={allApps}
		>
			{testUI}
		</PlaygroundWindow>
	)
}

function OtherPreviewsSelect({
	activePreview,
	problemName,
	solutionName,
}: {
	activePreview: (typeof previewOptions)[number]
	problemName?: string
	solutionName?: string
}) {
	const [searchParams, setSearchParams] = useSearchParams()
	const altDown = useAltDown()
	const metaDown = useMetaDown()
	const navigate = useNavigate()

	// when alt is held down, the diff preview should open to the full-page diff view
	// between the problem and solution (this is more for the instructor than the student)
	function getOptionTo(option: (typeof otherPreviewOptions)[number]) {
		if (option === 'diff' && altDown) {
			return `/diff?${new URLSearchParams({
				app1: problemName ?? '',
				app2: solutionName ?? '',
			})}`
		}
		return `?${withParam(searchParams, 'preview', option)}`
	}

	return (
		<Select.Root
			value={
				otherPreviewOptions.includes(activePreview) ? activePreview : undefined
			}
			onValueChange={option => {
				if (option === 'diff' && altDown) {
					const destination = `/diff?${new URLSearchParams({
						app1: problemName ?? '',
						app2: solutionName ?? '',
					})}`
					if (metaDown) {
						window.open(destination, '_blank')
					} else {
						navigate(destination)
					}
				} else {
					setSearchParams(withParam(searchParams, 'preview', option).toString())
				}
			}}
		>
			<Select.Trigger asChild>
				<button
					className="clip-path-button relative h-14 px-6 font-mono text-sm uppercase"
					aria-label="Other Views"
				>
					<span className="flex h-14 items-center gap-1 outline-none focus:bg-foreground/80 focus:text-background/80">
						<Select.Value
							placeholder="..."
							className="inline-block w-40 text-ellipsis"
						/>
						<Select.Icon>
							<Icon name="TriangleDownSmall" />
						</Select.Icon>
					</span>
				</button>
			</Select.Trigger>
			<Select.Portal>
				<Select.Content className="z-20 max-h-[50vh] bg-black p-3 text-white lg:max-h-[70vh]">
					<Select.Viewport className="p-3">
						<Select.Group>
							<Select.Label className="px-5 pb-3 font-mono uppercase">
								Other Views
							</Select.Label>
							{otherPreviewOptions.map(option => (
								<Link
									key={option}
									id={`preview-${option}`}
									preventScrollReset
									// the prefetch="intent" is the entire reason we're wrapping
									// this in a link. That way as the user is looking through the
									// options, they get prefetching...
									prefetch="intent"
									to={getOptionTo(option)}
								>
									<Select.Item
										value={option}
										className="relative flex cursor-pointer select-none items-center rounded px-4 py-2 uppercase leading-none opacity-80 radix-disabled:text-red-500 radix-highlighted:opacity-100 radix-highlighted:outline-none radix-state-checked:opacity-100"
									>
										<Select.ItemText>{option}</Select.ItemText>
										<Select.ItemIndicator className="absolute left-0 inline-flex w-[25px] items-center justify-center">
											<Icon name="CheckSmall" />
										</Select.ItemIndicator>
									</Select.Item>
								</Link>
							))}
						</Select.Group>
					</Select.Viewport>
				</Select.Content>
			</Select.Portal>
		</Select.Root>
	)
}

export function ErrorBoundary() {
	const error = useRouteError()

	if (typeof document !== 'undefined') {
		console.error(error)
	}

	return isRouteErrorResponse(error) ? (
		error.status === 404 ? (
			<p>Sorry, we couldn't find an app here.</p>
		) : (
			<p>
				{error.status} {error.data}
			</p>
		)
	) : (
		<p>{getErrorMessage(error)}</p>
	)
}
