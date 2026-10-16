/** Controlled browser audio devices with real Recording ownership and conversion. */
import { vi, type Mock } from 'vite-plus/test'
import { Recording } from '../src/client/audio.ts'

/**
 * Install per-test audio devices; callers restore globals and release acquired recordings.
 * @param options - device failures or an empty final recording.
 * @returns the recording, device controls, and resource observations.
 */
export function captureFixture(options: { empty?: boolean; recorderError?: boolean; constructError?: boolean } = {}) {
  // Named mock types keep the fixture's inferred return type portable: the
  // declarations this package emits must not reach into Vitest's own paths.
  const trackStop: Mock<() => void> = vi.fn()
  const close: Mock<() => Promise<void>> = vi.fn(async () => {})
  const disposed: Mock<() => void> = vi.fn()
  const decoding: Mock<(data: ArrayBuffer) => Promise<{ duration: number }>> = vi.fn(async (_data: ArrayBuffer) => ({ duration: 2 }))
  const rendering: Mock<() => Promise<{ getChannelData: () => Float32Array }>> = vi.fn(
    async () => ({ getChannelData: () => new Float32Array([0.5, -0.5]) }),
  )
  let failRecorder: () => void
  class Recorder {
    state = 'inactive'
    mimeType = 'audio/webm'
    ondataavailable?: (event: { data: Blob }) => void
    onstop?: () => void
    onerror?: () => void
    constructor() {
      if (options.constructError) throw new Error('recorder unavailable')
      failRecorder = () => { this.onerror!() }
    }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob() })
        if (!options.empty) this.ondataavailable?.({ data: new Blob(['final audio']) })
        if (options.recorderError) this.onerror?.()
        else this.onstop?.()
      })
    }
  }
  const offline = vi.fn(function Offline(_channels: number, _frames: number, _rate: number) {
    return { destination: {}, createBufferSource: () => ({ buffer: null, connect() {}, start() {} }), startRendering: rendering }
  })
  const track = new EventTarget()
  const audioTrack = Object.assign(track, { stop: trackStop, label: 'Fixture microphone',
    getSettings: (): MediaTrackSettings => ({ groupId: 'fixture-input' }) })
  const stream = { getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack] }
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => stream)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', Recorder)
  vi.stubGlobal('AudioContext', function Audio() { return { state: 'running', close, decodeAudioData: decoding,
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    createAnalyser: () => ({ fftSize: 256, getFloatTimeDomainData: (buffer: Float32Array) => { buffer.fill(0.25) } }),
  } })
  vi.stubGlobal('OfflineAudioContext', offline)
  return { recording: new Recording(disposed), getUserMedia, stream, track, trackStop, close, disposed, decoding, rendering, offline,
    failRecorder: () => { failRecorder() } }
}
