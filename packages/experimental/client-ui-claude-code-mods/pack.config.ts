import { clientBundle } from '../../client/pack.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'])
