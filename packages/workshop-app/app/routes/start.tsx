import { type DataFunctionArgs, json } from '@remix-run/node'
import { useFetcher } from '@remix-run/react'
import { Button } from '#app/components/button.tsx'
import { Loading } from '#app/components/loading.tsx'
import { showProgressBarField } from '#app/components/progress-bar.tsx'
import { getAppByName } from '#app/utils/apps.server.ts'
import {
	ensureUndeployed,
	invariantResponse,
	invariant,
	useAltDown,
} from '#app/utils/misc.tsx'
import {
	closeProcess,
	runAppDev,
	stopPort,
	waitOnApp,
} from '#app/utils/process-manager.server.ts'

export async function action({ request }: DataFunctionArgs) {
	ensureUndeployed()
	const formData = await request.formData()
	const intent = formData.get('intent')
	invariantResponse(typeof intent === 'string', 'intent is required')

	if (intent === 'start' || intent === 'stop' || intent === 'restart') {
		const name = formData.get('name')
		invariantResponse(typeof name === 'string', 'name is required')
		const app = await getAppByName(name)
		if (!app) {
			throw new Response('Not found', { status: 404 })
		}
		if (app.dev.type !== 'script') {
			throw new Response(`App "${name}" does not have a server`, {
				status: 400,
			})
		}

		async function startApp() {
			invariant(app, 'app must be defined')
			const result = await runAppDev(app)
			if (result.running) {
				await waitOnApp(app)
				// wait another 200ms just in case the build output for assets isn't finished
				await new Promise(resolve => setTimeout(resolve, 200))
				return json({ status: 'app-started' } as const)
			} else if (result.portNumber) {
				return json({
					status: 'app-not-started',
					error: result.status,
					port: result.portNumber,
				} as const)
			} else {
				throw new Response(
					'Tried starting a server for an app that does not have one',
					{ status: 400 },
				)
			}
		}

		async function stopApp() {
			invariant(app, 'app must be defined')
			await closeProcess(app.name)
			return json({ status: 'app-stopped' } as const)
		}

		switch (intent) {
			case 'start': {
				return startApp()
			}
			case 'stop': {
				return stopApp()
			}
			case 'restart': {
				await stopApp()
				return startApp()
			}
		}
	}

	if (intent === 'stop-port') {
		const port = formData.get('port')
		invariantResponse(typeof port === 'string', 'port is required')
		await stopPort(port)
		return json({ status: 'port-stopped' } as const)
	}
	throw new Error(`Unknown intent: ${intent}`)
}

export function AppStopper({ name }: { name: string }) {
	const fetcher = useFetcher<typeof action>()
	const inFlightIntent = fetcher.formData?.get('intent')
	const inFlightState =
		inFlightIntent === 'stop'
			? 'Stopping App'
			: inFlightIntent === 'restart'
			? 'Restarting App'
			: null
	const altDown = useAltDown()
	return (
		<fetcher.Form method="POST" action="/start">
			{showProgressBarField}
			<input type="hidden" name="name" value={name} />
			<button
				type="submit"
				name="intent"
				value={altDown ? 'restart' : 'stop'}
				className="h-full border-r px-3 py-4 font-mono text-xs uppercase leading-none"
			>
				{inFlightState ? inFlightState : altDown ? 'Restart App' : 'Stop App'}
			</button>
		</fetcher.Form>
	)
}

export function PortStopper({ port }: { port: number | string }) {
	const fetcher = useFetcher<typeof action>()

	return (
		<fetcher.Form method="POST" action="/start">
			<input type="hidden" name="port" value={port} />
			<Button varient="mono" type="submit" name="intent" value="stop-port">
				{fetcher.state === 'idle' ? 'Stop Port' : 'Stopping Port'}
			</Button>
		</fetcher.Form>
	)
}

export function AppStarter({ name }: { name: string }) {
	const fetcher = useFetcher<typeof action>()
	if (fetcher.data?.status === 'app-not-started') {
		if (fetcher.data.error === 'port-unavailable') {
			return (
				<div>
					The port is unavailable. Would you like to stop whatever is running on
					that port and try again?
					<PortStopper port={fetcher.data.port} />
				</div>
			)
		} else {
			return <div>An unknown error has happened.</div>
		}
	}
	return (
		<fetcher.Form method="POST" action="/start">
			<input type="hidden" name="name" value={name} />
			{fetcher.state === 'idle' ? (
				<Button type="submit" name="intent" value="start" varient="mono">
					Start App
				</Button>
			) : (
				<div>
					<Loading>Starting App</Loading>
				</div>
			)}
		</fetcher.Form>
	)
}
