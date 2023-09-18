import * as React from 'react'
import { z } from 'zod'

const Messages = z.union([
	z.object({ type: z.literal('kcdshop:progress:ready') }),
	z.object({ type: z.literal('kcdshop:progress:pending') }),
	z.object({
		type: z.literal('kcdshop:progress:resolved'),
		progress: z.array(z.string()),
	}),
	z.object({
		type: z.literal('kcdshop:progress:rejected'),
		error: z.unknown(),
	}),
])

export function ProgressTracker() {
	const iframeRef = React.useRef<HTMLIFrameElement>(null)

	const [progressState, setProgressState] = React.useState<
		| { status: 'idle' }
		| { status: 'pending' }
		| { status: 'resolved'; progress: Array<string> }
		| { status: 'rejected'; error: unknown }
	>({ status: 'idle' })

	React.useEffect(() => {
		const childWindow = iframeRef.current?.contentWindow
		if (!childWindow) return

		function handleMessage(event: MessageEvent) {
			const result = Messages.safeParse(event.data)
			if (!result.success) return
			const parsed = result.data
			console.log(`PARENT RECEIVED: ${parsed.type}`)
			switch (parsed.type) {
				case 'kcdshop:progress:ready': {
					console.log(`PARENT SENDING: kcdshop:parent:get-progress`)
					childWindow!.postMessage({ type: 'kcdshop:parent:get-progress' }, '*')
					setProgressState({ status: 'idle' })
					break
				}
				case 'kcdshop:progress:pending': {
					setProgressState({ status: 'pending' })
					break
				}
				case 'kcdshop:progress:resolved': {
					setProgressState({ status: 'resolved', progress: parsed.progress })
					break
				}
				case 'kcdshop:progress:rejected': {
					setProgressState({ status: 'rejected', error: parsed.error })
					break
				}
			}
		}

		window.addEventListener('message', handleMessage)
		console.log('PARENT SENDING: kcdshop:parent:ready')
		childWindow.postMessage({ type: 'kcdshop:parent:ready' }, '*')
		return () => window.removeEventListener('message', handleMessage)
	}, [])

	React.useEffect(() => {
		console.log(progressState)
	}, [progressState.status])

	return (
		<iframe
			ref={iframeRef}
			src="http://localhost:3000/progress-iframe.html"
			hidden
		/>
	)
}
