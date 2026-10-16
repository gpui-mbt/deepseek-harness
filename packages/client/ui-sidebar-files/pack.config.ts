import { clientBundle } from '../pack.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'])
