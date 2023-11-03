import type { Config } from 'tailwindcss'
import url from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

throw path.join(__dirname, './index.html')
export default {
	content: [path.join(__dirname, './index.html')],
	theme: {
		extend: {},
	},
	plugins: [],
} satisfies Config
