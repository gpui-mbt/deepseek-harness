// Each probe owns its process so platform and filesystem instrumentation cannot leak into other tests.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const [packageRoot, targetPlatform] = process.argv.slice(2)
const requireEsbuild = createRequire(path.join(packageRoot, 'package.json'))
const nativePlatform = process.platform
const nativeBinary = requireEsbuild.resolve(
  `@esbuild/${nativePlatform}-${process.arch}/${nativePlatform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`,
)
process.env.ESBUILD_BINARY_PATH = nativeBinary
// Direct sync transport lets the instrumentation observe both API paths in this process.
if (targetPlatform !== 'native') process.env.ESBUILD_WORKER_THREADS = '0'
const esbuild = requireEsbuild('./lib/main.js')
if (targetPlatform !== 'native') Object.defineProperty(process, 'platform', { value: targetPlatform })

let writes = 0
for (const method of ['writeFile', 'writeFileSync']) {
  const original = fs[method]
  fs[method] = function (...args) {
    writes++
    return original.apply(this, args)
  }
}

async function main() {
  let count = 0
  try {
    for (const size of [1_048_575, 1_048_576, 1_048_577, 2_097_153]) {
      const tail = '*/globalThis.answer = 42;'
      const text = '/*' + 'x'.repeat(size - 2 - tail.length) + tail
      assert.equal(Buffer.byteLength(text), size)
      for (const input of [text, new Uint8Array(Buffer.from(text)), '/*日本語*/' + text]) {
        for (const sync of [false, true]) {
          const before = writes
          const options = { target: 'es2022', minify: true }
          const result = sync ? esbuild.transformSync(input, options) : await esbuild.transform(input, options)
          assert.equal(result.code, 'globalThis.answer=42;\n')
          assert.deepEqual(result.warnings, [])
          if (targetPlatform === 'win32' || (targetPlatform === 'native' && nativePlatform === 'win32')) {
            assert.equal(writes, before, `Windows ${sync ? 'sync' : 'async'} input of ${size} bytes used a temporary file`)
          } else if (targetPlatform !== 'native') {
            assert.equal(writes - before, input.length > 1024 * 1024 ? 1 : 0)
          }
          count++
        }
      }
    }
    console.log(`${count} transforms passed (${esbuild.version}, ${targetPlatform})`)
  } finally {
    await esbuild.stop()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
