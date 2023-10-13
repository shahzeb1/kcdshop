import { type Express } from 'express'
import { z } from 'zod'

const MessageSchema = z.object({ message: z.string() })

export async function handleKCDShopMessage(
	app: Express,
	cb: (message: string) => void | Promise<void>,
) {
	app.post('/__kcdshop_message__', async (req, res) => {
		const rawBody = await new Promise((resolve, reject) => {
			let acc = ''
			req.on('data', chunk => (acc += chunk.toString()))
			req.on('end', () => resolve(acc))
			req.on('error', reject)
		}).catch(() => null)
		let jsonBody: unknown = null
		try {
			jsonBody = JSON.parse(typeof rawBody === 'string' ? rawBody : 'null')
		} catch {}
		const result = MessageSchema.safeParse(jsonBody)
		if (!result.success) {
			return res
				.status(400)
				.json({ status: 'error', message: result.error.flatten() })
		}
		await cb(result.data.message)
		return res.status(200).json({ status: 'success' })
	})
}
