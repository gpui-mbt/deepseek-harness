import { staticLinked } from '../pack.client.ts'

export default staticLinked(
  import.meta.dirname,
  ['lib/types/index.js'],
)
