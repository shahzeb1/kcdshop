import * as React from 'react'
import { z } from 'zod'

const ResponseSchema = z.object({
	body: z.string(),
	headers: z.array(z.tuple([z.string(), z.string()])),
	status: z.number(),
	statusText: z.string(),
})

const RecivedMessagesSchema = z.union([
	z.object({ type: z.literal('kcdshop:epic-proxy:ready') }),
	z.object({
		type: z.literal('kcdshop:epic-proxy:resolved'),
		requestId: z.string(),
		response: ResponseSchema,
	}),
	z.object({
		type: z.literal('kcdshop:epic-proxy:rejected'),
		requestId: z.string(),
		response: ResponseSchema,
	}),
])

function createDeferred() {
	let resolve: (value?: unknown) => void, reject: (reason?: unknown) => void
	const promise = new Promise((res, rej) => {
		resolve = res
		reject = rej
	})

	// @ts-expect-error good luck figuring out this one...
	return { promise, resolve, reject }
}

let iframeEl: HTMLIFrameElement | null = null

const fetchQueue: Array<{
	input: RequestInfo | URL
	init?: RequestInit | undefined
	requestId: string
	deferred: ReturnType<typeof createDeferred>
	status: 'idle' | 'pending' | 'resolved' | 'rejected'
}> = []

function executeFetchQueue() {
	if (!iframeEl?.contentWindow) return

	for (let index = 0; index < fetchQueue.length; index++) {
		const fetchItem = fetchQueue[index]
		if (!fetchItem || fetchItem.status !== 'idle') continue
		fetchItem.status = 'pending'
		const { requestId, input, init } = fetchItem
		iframeEl.contentWindow.postMessage(
			{
				type: 'kcdshop:parent:fetch',
				requestId,
				input,
				init,
			},
			// TODO: update this to the correct URL when the proxy iframe is real
			'*',
		)
	}
}

/**
 * This makes a fetch request through the epicweb.dev proxy iframe so you can
 * make authenticated requests to the Epic Web API and they should be
 * authenticated if the user is logged into EpicWeb.dev.
 */
export function epicFetch(
	input: RequestInfo | URL,
	init?: RequestInit | undefined,
) {
	const requestId = Math.random().toString()
	const fetchItem = {
		input,
		init,
		requestId,
		deferred: createDeferred(),
		status: 'idle',
	} as const
	fetchQueue.push(fetchItem)
	executeFetchQueue()
	return fetchItem.deferred.promise as Promise<Response>
}

function initIframe(el: HTMLIFrameElement | null) {
	if (!el) {
		console.error('iframe element not found')
		return
	}
	iframeEl = el

	const childWindow = iframeEl.contentWindow
	if (!childWindow) return

	function handleMessage(event: MessageEvent) {
		if (!childWindow || event.source !== childWindow) {
			// message was not sent from the iframe
			return
		}
		if (event.data.request === 'postUri') {
			// just something the browser does 🤷‍♂️
			return
		}
		const result = RecivedMessagesSchema.safeParse(event.data)
		if (!result.success) {
			console.error(
				'invalid message received from iframe',
				event.data,
				result.error,
			)
			return
		}
		const parsed = result.data
		console.log(`PARENT RECEIVED: ${parsed.type}`)
		switch (parsed.type) {
			case 'kcdshop:epic-proxy:ready': {
				console.log(`PARENT EXECUTING FETCH QUEUE`)
				executeFetchQueue()
				break
			}
			case 'kcdshop:epic-proxy:rejected':
			case 'kcdshop:epic-proxy:resolved': {
				const fetchItem = fetchQueue.find(f => f.requestId === parsed.requestId)
				if (!fetchItem) return
				fetchItem.status =
					parsed.type === 'kcdshop:epic-proxy:resolved'
						? 'resolved'
						: 'rejected'
				const response = new Response(parsed.response.body, {
					headers: new Headers(parsed.response.headers),
					status: parsed.response.status,
					statusText: parsed.response.statusText,
				})
				fetchItem.deferred.resolve(response)
				break
			}
			default: {
				console.error(parsed)
				throw new Error(`Unhandled message`)
			}
		}
	}

	window.addEventListener('message', handleMessage)
	console.log('PARENT SENDING: kcdshop:parent:ready')
	// TODO: update this to the correct URL when the proxy iframe is real
	childWindow.postMessage({ type: 'kcdshop:parent:ready' }, '*')
}

export function ProxyIframe() {
	return (
		<iframe
			ref={el => initIframe(el)}
			// TODO: update this to the correct URL when the proxy iframe is real
			src="http://localhost:3000/proxy-iframe.html"
			title="Proxy Iframe"
			hidden
		/>
	)
}
