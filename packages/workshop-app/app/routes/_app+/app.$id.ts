import path from 'path'
import { type DataFunctionArgs, redirect } from '@remix-run/node'
import fsExtra from 'fs-extra'
import {
	getAppByName,
	isExerciseStepApp,
	isSolutionApp,
	isProblemApp,
	getExercise,
	getWorkshopTitle,
} from '#app/utils/apps.server.ts'
import { getBaseUrl, invariantResponse } from '#app/utils/misc.tsx'
import { getServerTimeHeader, makeTimings } from '#app/utils/timing.server.ts'

export async function loader({ request, params }: DataFunctionArgs) {
	const timings = makeTimings('app')
	const { id: appId } = params
	invariantResponse(appId, 'App id is required')
	const app = await getAppByName(appId, { request, timings })
	if (!app) {
		throw new Response(`App "${appId}" not found`, {
			status: 404,
			headers: { 'Server-Timing': getServerTimeHeader(timings) },
		})
	}
	if (app.dev.type === 'script') {
		return redirect(getBaseUrl({ request, port: app.dev.portNumber }), {
			headers: { 'Server-Timing': getServerTimeHeader(timings) },
		})
	}
	const htmlFile = path.join(app.fullPath, 'index.html')
	const hasHtml = await fsExtra.pathExists(htmlFile)
	if (hasHtml) {
		let html = (await fsExtra.readFile(htmlFile)).toString()
		if (!html.includes('<base href')) {
			// add base href to html
			const baseHref = `<base href="/app/${appId}/" />`
			if (html.includes('<head>')) {
				html = html.replace('<head>', `<head>\n\t\t${baseHref}`)
			} else if (html.includes('<html>')) {
				html = html.replace(
					'<html>',
					`<html>\n\t<head>\n\t\t${baseHref}\n\t</head>`,
				)
			}
		}
		return new Response(html, {
			headers: {
				'Content-Length': Buffer.byteLength(html).toString(),
				'Content-Type': 'text/html',
				'Server-Timing': getServerTimeHeader(timings),
			},
		})
	}
	const indexFiles = (await fsExtra.readdir(app.fullPath)).filter(
		(file: string) => file.startsWith('index.'),
	)
	const indexCss = indexFiles.find((file: string) => file.endsWith('index.css'))
	const indexJs = indexFiles.find((file: string) => file.endsWith('index.js'))
	const indexTs = indexFiles.find((file: string) => file.endsWith('index.ts'))
	const indexTsx = indexFiles.find((file: string) => file.endsWith('index.tsx'))
	const scripts = [indexJs, indexTs, indexTsx].filter(Boolean)
	if (scripts.length > 1) {
		throw new Response(
			`Only one index.(js|ts|tsx) file is allowed, found ${scripts.join(', ')}`,
			{ status: 400 },
		)
	}
	const appTitle = app?.title ?? 'N/A'
	const workshopTitle = await getWorkshopTitle()
	const title = (
		isExerciseStepApp(app)
			? [
					isProblemApp(app) ? '🏃💪' : isSolutionApp(app) ? '🏃🏁' : null,
					`${app.stepNumber.toString().padStart(2, '0')}. ${app.title}`,
					`${app.exerciseNumber.toString().padStart(2, '0')}. ${
						(await getExercise(app.exerciseNumber, { request, timings }))
							?.title ?? 'Unknown'
					}`,
					workshopTitle,
			  ]
			: ['🏃', appTitle]
	)
		.filter(Boolean)
		.join(' | ')
	const html = /* html */ `
<!DOCTYPE html>
<html>
	<head>
		<base href="${app.dev.pathname}" />
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>${title}</title>
		<link rel="stylesheet" href="/app-default.css">
		${indexCss ? `<link rel="stylesheet" href="${indexCss}">` : ''}
	</head>
	<body>
		${scripts
			.map(script => `<script type="module" src="${script}"></script>`)
			.join('\n')}
		<script type="module" src="kcd_ws.js"></script>
	</body>
</html>
`
	return new Response(html, {
		headers: {
			'Content-Length': Buffer.byteLength(html).toString(),
			'Content-Type': 'text/html',
			'Server-Timing': getServerTimeHeader(timings),
		},
	})
}
