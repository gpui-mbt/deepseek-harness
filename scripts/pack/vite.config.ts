/** Public `vp -C scripts/pack pack` adapter, independent of the test/lint config. */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import { createPackEntries } from '../../pack.config.ts'
import { packTargetPasses } from './targets.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig(async () => {
  const pack = []
  for (const pass of packTargetPasses(root, process.env.DSH_PACK_TARGET)) {
    pack.push(...await createPackEntries(pass))
  }
  return { pack }
})
