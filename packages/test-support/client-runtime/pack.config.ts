import { clientLibrary } from '../../client/pack.client.ts'

export default clientLibrary(
  import.meta.dirname,
  ['lib/types/index.js'],
)
