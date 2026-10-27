import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import {
  BlockAssembler,
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vite-plus/test'
import type { ChatGptAdapterHost } from '../src/adapter-contract.ts'
import { ChatGptResponsesAdapter } from '../src/responses.ts'
import { OFFICIAL_OPENAI_MODELS, toOpenAiModelInfo, toOpenAiResolvedModelInfo } from '../src/models.ts'
import type { OfficialOpenAiModel } from '../src/models.ts'
import type { ChatGptAccountId } from '../src/types.ts'

const provider = 'chatgpt'
const firstOfficialModel = OFFICIAL_OPENAI_MODELS[0]
if (firstOfficialModel === undefined) throw new Error('official model fixture is missing')
const officialModel: OfficialOpenAiModel = firstOfficialModel
const model = toOpenAiResolvedModelInfo(provider, officialModel)

function hostFor(
  accountSignal = new AbortController().signal,
  accountId: ChatGptAccountId = 'account-test' as ChatGptAccountId,
  streamIdleTimeoutMs = 120_000,
): ChatGptAdapterHost {
  return {
    listModels: async () => [toOpenAiModelInfo(provider, officialModel)],
    resolveModel: async () => model,
    prepareCall: async () => ({
      accountId,
      accessToken: 'exchanged-access-token',
      accountSignal,
      model,
      requestTimeoutMs: 30_000,
      streamIdleTimeoutMs,
    }),
    readImage: async ref => ({ ref, data: Uint8Array.from([1, 2]) }),
  }
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider,
    model: officialModel.id,
    messages: [
      createSystemMessage('Follow the system instruction.'),
      { role: 'user', content: [{ type: 'text', text: 'Describe this image.' }] },
    ],
    system: 'One-shot system instruction.',
    tools: [{ name: 'lookup', description: 'Find a record.', parameters: { type: 'object' } }],
    ...overrides,
  }
}

function completedTextEvents(text: string): readonly unknown[] {
  const output = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  return [
    {
      type: 'response.output_item.added',
      output_index: 0,
      sequence_number: 1,
      item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
      delta: text,
    },
    { type: 'response.output_item.done', output_index: 0, sequence_number: 3, item: output },
    {
      type: 'response.completed',
      sequence_number: 4,
      response: {
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [output],
        model: officialModel.id,
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 17,
        },
      },
    },
  ]
}

function completedReasoningEvents(): readonly unknown[] {
  const reasoning = {
    id: 'rs_1',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Plan.' }],
    encrypted_content: 'opaque-encrypted-reasoning',
    status: 'completed',
  }
  const message = {
    id: 'msg_reasoning',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Answer.', annotations: [] }],
  }
  return [
    { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: reasoning },
    { type: 'response.output_item.done', output_index: 1, sequence_number: 2, item: message },
    {
      type: 'response.completed',
      sequence_number: 3,
      response: {
        id: 'resp_reasoning',
        object: 'response',
        created_at: 1,
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [reasoning, message],
        model: officialModel.id,
        usage: null,
      },
    },
  ]
}

function eventFetch(
  events: readonly unknown[],
  onRequest?: (request: Request, body: Record<string, unknown>) => void,
  requestId: string | null = 'req_123',
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const body = (await request.clone().json()) as Record<string, unknown>
    onRequest?.(request, body)
    const stream = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        ...(requestId === null ? {} : { 'x-request-id': requestId }),
      },
    })
  }
}

async function collect(adapter: ChatGptResponsesAdapter, request: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)
  return chunks
}

describe('ChatGPT Responses adapter provider metadata', () => {
  it('names the provider route ChatGPT', () => {
    expect(new ChatGptResponsesAdapter(hostFor()).providerInfo('chatgpt')).toEqual({ id: 'chatgpt', name: 'ChatGPT' })
  })

  it('fails a stalled stream when no event arrives within the idle bound', async () => {
    const encoder = new TextEncoder()
    const stalled = (): typeof fetch => async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'response.output_text.delta',
                  sequence_number: 0,
                  output_index: 0,
                  content_index: 0,
                  delta: 'partial',
                  item_id: 'item-1',
                })}\n\n`,
              ),
            )
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    const adapter = new ChatGptResponsesAdapter(hostFor(undefined, 'account-test' as ChatGptAccountId, 20), {
      fetch: stalled(),
    })
    await expect(collect(adapter, options())).rejects.toMatchObject({ code: 'STREAM_IDLE_TIMEOUT' })
  })
})

describe('ChatGPT Responses adapter', () => {
  it('sends full history with SIWC-safe request fields and maps completed stream data', async () => {
    const imageRef = {
      attachmentId: AttachmentId('image-test'),
      mediaType: 'image/png',
      bytes: 2,
      width: 1,
      height: 1,
    } as const
    let capturedBody: Record<string, unknown> | undefined
    let capturedUrl: string | undefined
    let capturedAuthorization: string | null = null
    let capturedUserAgent: string | null = null
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Hello.'), (request, body) => {
        capturedBody = body
        capturedUrl = request.url
        capturedAuthorization = request.headers.get('authorization')
        capturedUserAgent = request.headers.get('user-agent')
      }),
    })

    const chunks = await collect(
      adapter,
      options({
        messages: [
          createSystemMessage('Follow the system instruction.'),
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image.' },
              { type: 'image', attachment: imageRef },
            ],
          },
        ],
      }),
    )

    expect(capturedUrl).toBe('https://api.openai.com/v1/responses')
    expect(capturedAuthorization).toBe('Bearer exchanged-access-token')
    expect(capturedUserAgent).toContain('deepseek-harness')
    expect(capturedBody).toMatchObject({
      model: officialModel.id,
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      instructions: 'One-shot system instruction.',
    })
    expect(capturedBody).not.toHaveProperty('max_output_tokens')
    expect(capturedBody).not.toHaveProperty('temperature')
    const input = capturedBody?.input as Array<Record<string, unknown>>
    expect(input[0]).toMatchObject({ type: 'additional_tools', role: 'developer' })
    expect(input[1]).toMatchObject({ type: 'message', role: 'developer' })
    expect(input[2]).toMatchObject({ type: 'message', role: 'user' })
    expect(input[2]?.content).toContainEqual({ type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AQI=' })
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({
      block: { type: 'text', text: 'Hello.' },
    })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({
      usage: { inputTokens: 9, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 5, totalTokens: 17, reasoningTokens: 3 },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { response: { requestId: 'req_123', id: 'resp_1', model: officialModel.id } },
    })
  })

  it.each([
    ['maxTokens', { maxTokens: 10 }],
    ['temperature', { temperature: 0 }],
  ] as const)('rejects explicit %s before transport', async (_name, override) => {
    let requests = 0
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch([], () => {
        requests += 1
      }),
    })

    await expect(collect(adapter, options(override))).rejects.toMatchObject({ code: 'UNSUPPORTED_PARAMETER' })
    expect(requests).toBe(0)
  })

  it.each([
    ['session-title', 64],
    ['compaction', 65_536],
  ] as const)('omits max_output_tokens for the DSH %s auxiliary call', async (purpose, maxTokens) => {
    let capturedBody: Record<string, unknown> | undefined
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Done.'), (_request, body) => {
        capturedBody = body
      }),
    })

    await collect(adapter, options({ purpose, maxTokens }))

    expect(capturedBody).not.toHaveProperty('max_output_tokens')
  })

  it('replays the exact completed encrypted reasoning item with its assistant response', async () => {
    const bodies: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedReasoningEvents(), (_request, body) => {
        bodies.push(body)
      }),
    })
    const prior = await assistantFromResponse(adapter)

    await collect(
      adapter,
      options({
        messages: [
          createSystemMessage('Follow the system instruction.'),
          { role: 'user', content: [{ type: 'text', text: 'First question.' }] },
          prior,
          { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
        ],
      }),
    )

    const secondInput = bodies[1]?.input as Array<Record<string, unknown>>
    expect(secondInput).toContainEqual({
      id: 'rs_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Plan.' }],
      encrypted_content: 'opaque-encrypted-reasoning',
      status: 'completed',
    })
    expect(secondInput.slice(-3)).toEqual([
      {
        id: 'rs_1',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Plan.' }],
        encrypted_content: 'opaque-encrypted-reasoning',
        status: 'completed',
      },
      {
        id: 'msg_reasoning',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Answer.', annotations: [] }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
    ])
  })

  it('replays SDK-supported configuration updates in stateless history', async () => {
    const configuration = {
      id: 'cfg_1',
      type: 'configuration_update',
      reasoning: { effort: 'high' },
    }
    const message = {
      id: 'msg_configuration',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Configured.', annotations: [] }],
    }
    const events = [
      { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: configuration },
      { type: 'response.output_item.done', output_index: 1, sequence_number: 2, item: message },
      {
        type: 'response.completed',
        sequence_number: 3,
        response: {
          id: 'resp_configuration',
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          output: [configuration, message],
          model: officialModel.id,
          usage: null,
        },
      },
    ]
    const bodies: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(events, (_request, body) => {
        bodies.push(body)
      }),
    })
    const prior = await assistantFromResponse(adapter)

    await collect(
      adapter,
      options({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'First question.' }] },
          prior,
          { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
        ],
      }),
    )

    const secondInput = bodies[1]?.input as Array<Record<string, unknown>>
    expect(secondInput).toContainEqual(configuration)
  })

  it('replays streamed output items by index when the terminal response output is empty', async () => {
    const configuration = {
      id: 'cfg_streamed',
      type: 'configuration_update',
      reasoning: { effort: 'high' },
    }
    const reasoning = {
      id: 'rs_streamed',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Think.' }],
      encrypted_content: 'streamed-encrypted-reasoning',
      status: 'completed',
    }
    const message = {
      id: 'msg_streamed',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Answer.', annotations: [] }],
    }
    const functionCall = {
      id: 'fc_streamed',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_streamed',
      name: 'lookup',
      arguments: '{"term":"moon"}',
    }
    const events = [
      { type: 'response.output_item.done', output_index: 3, sequence_number: 1, item: functionCall },
      { type: 'response.output_item.done', output_index: 1, sequence_number: 2, item: reasoning },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 3, item: configuration },
      { type: 'response.output_item.done', output_index: 2, sequence_number: 4, item: message },
      {
        type: 'response.completed',
        sequence_number: 5,
        response: {
          id: 'resp_streamed',
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          output: [],
          model: officialModel.id,
          usage: null,
        },
      },
    ]
    const bodies: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(events, (_request, body) => {
        bodies.push(body)
      }),
    })
    const prior = await assistantFromResponse(adapter)

    await collect(
      adapter,
      options({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'First question.' }] },
          prior,
          { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
        ],
      }),
    )

    const secondInput = bodies[1]?.input as Array<Record<string, unknown>>
    expect(secondInput.slice(-5)).toEqual([
      configuration,
      reasoning,
      message,
      functionCall,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
    ])
  })

  it('uses terminal response output when no output_item.done events were streamed', async () => {
    const events = completedTextEvents('Terminal answer.')
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch([events[0], events[1], events[3]]),
    })

    const chunks = await collect(adapter, options())

    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      replayState: { response: { output: [{ type: 'message', role: 'assistant' }] } },
    })
  })

  it('rejects streamed output with a missing index instead of fabricating history', async () => {
    const message = {
      id: 'msg_gap',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Answer.', annotations: [] }],
    }
    const events = [
      { type: 'response.output_item.done', output_index: 1, sequence_number: 1, item: message },
      {
        type: 'response.completed',
        sequence_number: 2,
        response: {
          id: 'resp_gap',
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          output: [],
          model: officialModel.id,
          usage: null,
        },
      },
    ]
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) })

    await expect(collect(adapter, options())).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      message: 'OpenAI Responses completed output items with a missing index',
    })
  })

  it('rejects duplicate streamed output indices', async () => {
    const message = {
      id: 'msg_duplicate',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Answer.', annotations: [] }],
    }
    const events = [
      { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: message },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 2, item: message },
      {
        type: 'response.completed',
        sequence_number: 3,
        response: {
          id: 'resp_duplicate',
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          output: [],
          model: officialModel.id,
          usage: null,
        },
      },
    ]
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) })

    await expect(collect(adapter, options())).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      message: 'OpenAI Responses completed the same output item index more than once',
    })
  })

  it('reports only sanitized item type names when response history cannot be replayed', async () => {
    const output = {
      id: 'private-response-item-id',
      type: 'future_private_item',
      text: 'private response content',
      access_token: 'private-access-token',
      encrypted_content: 'private-encrypted-content',
    }
    const message = {
      id: 'msg_unsupported',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Partial answer.', annotations: [] }],
    }
    const events = [
      { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: message },
      { type: 'response.output_item.done', output_index: 1, sequence_number: 2, item: output },
      {
        type: 'response.completed',
        sequence_number: 3,
        response: {
          id: 'private-response-id',
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          output: [],
          model: officialModel.id,
          usage: null,
        },
      },
    ]
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) })

    const error: unknown = await collect(adapter, options()).catch((value: unknown) => value)
    expect(error).toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: 'OpenAI Responses output item types cannot be replayed with store:false: future_private_item',
    })
    if (!(error instanceof Error)) throw new Error('expected a replay error')
    expect(error.message).not.toContain('private-response-item-id')
    expect(error.message).not.toContain('private response content')
    expect(error.message).not.toContain('private-access-token')
    expect(error.message).not.toContain('private-encrypted-content')
    expect(error.message).not.toContain('private-response-id')
  })

  it('does not replay encrypted reasoning after the active account changes', async () => {
    let accountId = 'account-test' as ChatGptAccountId
    const baseHost = hostFor()
    const host: ChatGptAdapterHost = {
      ...baseHost,
      prepareCall: async (requestedModel, signal) => ({
        ...(await baseHost.prepareCall(requestedModel, signal)),
        accountId,
      }),
    }
    const bodies: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(host, {
      fetch: eventFetch(completedReasoningEvents(), (_request, body) => {
        bodies.push(body)
      }),
    })
    const prior = await assistantFromResponse(adapter)
    accountId = 'account-other' as ChatGptAccountId

    await collect(
      adapter,
      options({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'First question.' }] },
          prior,
          { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
        ],
      }),
    )

    expect(JSON.stringify(bodies[1]?.input)).not.toContain('opaque-encrypted-reasoning')
  })

  it('does not replay encrypted reasoning through a different provider registration route', async () => {
    const firstAdapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(completedReasoningEvents()) })
    const prior = await assistantFromResponse(firstAdapter)
    const bodies: Record<string, unknown>[] = []
    const secondAdapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Done.'), (_request, body) => {
        bodies.push(body)
      }),
    })

    await collect(
      secondAdapter,
      options({
        provider: 'chatgpt-other',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'First question.' }] },
          prior,
          { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
        ],
      }),
    )

    expect(JSON.stringify(bodies[0]?.input)).not.toContain('opaque-encrypted-reasoning')
  })

  it('keeps historical tool additions in input order', async () => {
    const baselineTool = { name: 'base_lookup', description: 'Look up a base record.', parameters: { type: 'object' } }
    const addedTool = { name: 'extra_lookup', description: 'Look up an extra record.', parameters: { type: 'object' } }
    const update = createDeveloperMessage({
      source: { kind: 'system-prompt' },
      content: [{ type: 'tool-addition', toolName: addedTool.name }],
    })
    let capturedBody: Record<string, unknown> | undefined
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Done.'), (_request, body) => {
        capturedBody = body
      }),
    })

    await collect(
      adapter,
      options({
        messages: [createSystemMessage('Context.'), { role: 'user', content: [{ type: 'text', text: 'Go.' }] }, update],
        tools: [baselineTool, addedTool],
        toolHistory: { tools: [baselineTool], updates: [{ messageId: update.id, additions: [addedTool] }] },
      }),
    )

    const input = capturedBody?.input as Array<Record<string, unknown>>
    expect(input.filter(item => item.type === 'additional_tools').map(item => item.tools)).toEqual([
      [
        {
          type: 'function',
          name: baselineTool.name,
          description: baselineTool.description,
          parameters: baselineTool.parameters,
          strict: false,
        },
      ],
      [{ type: 'function', name: addedTool.name, description: addedTool.description, parameters: addedTool.parameters, strict: false }],
    ])
    expect(input.map(item => item.type)).toEqual(['additional_tools', 'message', 'message', 'additional_tools'])
  })

  it('maps function-call argument events to a DSH tool-call block', async () => {
    const output = {
      id: 'fc_item_1',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"term":"moon"}',
    }
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { ...output, status: 'in_progress', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: output.id,
        output_index: 0,
        sequence_number: 2,
        delta: '{"term":',
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: output.id,
        output_index: 0,
        sequence_number: 3,
        delta: '"moon"}',
      },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 4, item: output },
      {
        type: 'response.completed',
        sequence_number: 5,
        response: {
          id: 'resp_tools',
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          output: [output],
          model: officialModel.id,
          usage: null,
        },
      },
    ]
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) })

    const chunks = await collect(adapter, options())
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool-call-delta',
        id: 'call_1',
        name: 'lookup',
        argumentsDelta: '',
      }),
    )
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-call-delta', argumentsDelta: '{"term":' }))
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'block-end',
        block: { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"term":"moon"}' },
      }),
    )
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('keeps the exact SIWC subscription limit code and request id', async () => {
    const failed = {
      type: 'response.failed',
      sequence_number: 1,
      response: {
        id: 'resp_failed',
        object: 'response',
        created_at: 1,
        status: 'failed',
        error: {
          code: 'subscription_sharing_usage_limit_exceeded',
          type: 'invalid_request_error',
          message: 'The subscription sharing limit was reached.',
          param: null,
        },
        incomplete_details: null,
        output: [],
        model: officialModel.id,
        usage: null,
      },
    }
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch([failed]) })

    await expect(collect(adapter, options())).rejects.toMatchObject({
      code: 'subscription_sharing_usage_limit_exceeded',
      failure: { requestId: 'req_123' },
    })
  })

  it('does not infer a subscription limit from HTTP 402 alone', async () => {
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'Account request refused', code: null } }), {
          status: 402,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_402' },
        }),
    })

    const error: unknown = await collect(adapter, options()).catch((value: unknown) => value)
    expect(error).toMatchObject({
      code: 'OPENAI_RESPONSES_ERROR',
      failure: { status: 402, requestId: 'req_402' },
    })
    expect(error).toHaveProperty('message', expect.stringContaining('Account request refused'))
  })

  it('requires response.completed for success', async () => {
    const partial = completedTextEvents('Hello.').slice(0, 3)
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(partial) })

    await expect(collect(adapter, options())).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('aborts an in-flight request when the host revokes the account grant', async () => {
    const controller = new AbortController()
    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve
    })
    const adapter = new ChatGptResponsesAdapter(hostFor(controller.signal), {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        notifyStarted?.()
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const abort = (): void => {
            reject(signal?.reason instanceof Error ? signal.reason : new Error('request aborted'))
          }
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      },
    })
    const pending = collect(adapter, options())
    await started
    controller.abort(new Error('account signed out'))

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('advertises the seven exact official model capabilities without an output-token default', () => {
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.id)).toEqual([
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.contextWindow)).toEqual(Array(7).fill(1_050_000))
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.maxOutputTokens)).toEqual(Array(7).fill(128_000))
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.inputModalities)).toEqual(Array(7).fill(['text', 'image']))
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.reasoningEfforts.map(String))).toEqual([
      ['low', 'medium', 'high', 'xhigh', 'max'],
      ['low', 'medium', 'high', 'xhigh', 'max'],
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    ])
    expect(
      OFFICIAL_OPENAI_MODELS.map(item => (item.defaultReasoningEffort === undefined ? undefined : String(item.defaultReasoningEffort))),
    ).toEqual([undefined, 'medium', 'medium', 'medium', 'medium', 'medium', 'medium'])
    expect(
      OFFICIAL_OPENAI_MODELS.map(item => {
        const resolved = toOpenAiResolvedModelInfo(provider, item)
        return resolved.reasoning?.defaultEffort === undefined ? undefined : String(resolved.reasoning.defaultEffort)
      }),
    ).toEqual([undefined, 'medium', 'medium', 'medium', 'medium', 'medium', 'medium'])
    expect(OFFICIAL_OPENAI_MODELS.every(item => !('defaultMaxTokens' in toOpenAiResolvedModelInfo(provider, item)))).toBe(true)
    expect(model.context?.contextWindow).toBe(1_050_000)
    expect(model.toolUpdate).toBe('addition-only')
    expect(model).not.toHaveProperty('defaultMaxTokens')
  })

  it('binds host catalog models to the adapter provider route', async () => {
    const adapter = new ChatGptResponsesAdapter({
      ...hostFor(),
      listModels: async () => [{ provider: 'host-placeholder', id: officialModel.id, name: officialModel.name }],
    })

    await expect(adapter.listModels(provider)).resolves.toEqual([{ provider, id: officialModel.id, name: officialModel.name }])
  })

  it('refuses exact routes without a known context cap', async () => {
    const unconfigured: LlmResolvedModelInfo = { provider, id: 'unconfigured-model', name: 'Unknown model' }
    const adapter = new ChatGptResponsesAdapter({
      ...hostFor(),
      resolveModel: async () => unconfigured,
    })

    await expect(adapter.resolveModel(provider, unconfigured.id)).rejects.toMatchObject({
      code: 'MODEL_CONTEXT_REQUIRED',
    })
  })
})

async function assistantFromResponse(adapter: ChatGptResponsesAdapter) {
  const chunks = await collect(adapter, options())
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler.message({ provider, model: officialModel.id, replayState: assembler.replayState })
}

function completedEvent(output: readonly unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'response.completed',
    sequence_number: 9,
    response: {
      id: 'resp_branch',
      object: 'response',
      created_at: 1,
      status: 'completed',
      error: null,
      incomplete_details: null,
      output,
      model: officialModel.id,
      usage: null,
      ...overrides,
    },
  }
}

describe('ChatGPT Responses request conversion', () => {
  it('converts tool results and error results into function_call_output items', async () => {
    const captured: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('ok'), (_request, body) => captured.push(body)),
    })
    await collect(
      adapter,
      options({
        tools: [],
        toolHistory: { tools: [], updates: [] },
        messages: [
          createSystemMessage('s'),
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          createToolResultMessage({ callId: 'call-1' as never, content: [{ type: 'text', text: 'result' }], isError: false }),
          createToolResultMessage({ callId: 'call-2' as never, content: [], isError: true }),
        ],
      }),
    )
    const input = captured[0]?.input as readonly Record<string, unknown>[]
    expect(input).toContainEqual({ type: 'function_call_output', call_id: 'call-1', output: 'result' })
    expect(input).toContainEqual({ type: 'function_call_output', call_id: 'call-2', output: 'Tool execution failed.' })
  })

  it('rejects a tool result that carries a tool call', async () => {
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(completedTextEvents('ok')) })
    await expect(
      collect(
        adapter,
        options({
          messages: [
            createSystemMessage('s'),
            createToolResultMessage({
              callId: 'call-1' as never,
              content: [{ type: 'tool-call', id: 'c' as never, name: 'x', arguments: '{}' }],
              isError: false,
            }),
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('converts assistant tool calls, skips tool removals, and writes an empty message body', async () => {
    const captured: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('ok'), (_request, body) => captured.push(body)),
    })
    await collect(
      adapter,
      options({
        tools: [],
        toolHistory: { tools: [], updates: [] },
        messages: [
          createSystemMessage('s'),
          createAssistantMessage({
            source: { provider: 'chatgpt', model: officialModel.id },
            content: [
              { type: 'tool-call', id: 'call-9' as never, name: 'lookup', arguments: '{"id":1}' },
              { type: 'tool-removal', toolName: 'gone' },
            ] as never,
          }),
          { role: 'user', content: [] },
        ],
      }),
    )
    const input = captured[0]?.input as readonly Record<string, unknown>[]
    expect(input).toContainEqual({ type: 'function_call', call_id: 'call-9', name: 'lookup', arguments: '{"id":1}' })
    expect(input).toContainEqual({ type: 'message', role: 'user', content: '' })
  })

  it('projects files and offloaded images to their handle text', async () => {
    const captured: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('ok'), (_request, body) => captured.push(body)),
    })
    const attachment = { attachmentId: AttachmentId('file-1'), name: 'note.txt', bytes: 10 }
    const image = {
      attachmentId: AttachmentId('image-2'),
      mediaType: 'image/png' as never,
      bytes: 4,
      width: 1,
      height: 1,
      name: 'shot.png',
    }
    await collect(
      adapter,
      options({
        messages: [
          createSystemMessage('s'),
          {
            role: 'user',
            content: [
              { type: 'file', attachment },
              { type: 'image', attachment: image, offloaded: true },
            ],
          },
        ],
      }),
    )
    const serialized = JSON.stringify(captured[0]?.input)
    expect(serialized).toContain('note.txt')
    expect(serialized).toContain('image omitted because this model accepts text only')
  })

  it('refuses unsupported generation options before contacting the provider', async () => {
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(completedTextEvents('ok')) })
    await expect(collect(adapter, options({ stop: ['END'] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_PARAMETER' })
    await expect(collect(adapter, options({ temperature: 0.5 }))).rejects.toMatchObject({ code: 'UNSUPPORTED_PARAMETER' })
    await expect(collect(adapter, options({ maxTokens: 10 }))).rejects.toMatchObject({ code: 'UNSUPPORTED_PARAMETER' })
  })

  it('rejects a reasoning effort the model does not declare or Responses cannot encode', async () => {
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(completedTextEvents('ok')) })
    await expect(collect(adapter, options({ reasoningEffort: 'none' as never }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_REASONING_EFFORT',
    })
  })

  it('rejects a prepared call with an empty token, invalid timeout, or mismatched model', async () => {
    const base = {
      accountId: 'account-test' as ChatGptAccountId,
      accessToken: 'token',
      accountSignal: new AbortController().signal,
      model,
      requestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 120_000,
      readImage: async (ref: never) => ({ ref, data: Uint8Array.from([1]) }),
    }
    const host = {
      listModels: async () => [],
      resolveModel: async () => model,
      prepareCall: async () => ({ ...base, accessToken: '' }),
      readImage: async (ref: never) => ({ ref, data: Uint8Array.from([1]) }),
    }
    await expect(new ChatGptResponsesAdapter(host).prepareCall('chatgpt', officialModel.id)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
    })
    await expect(
      new ChatGptResponsesAdapter({ ...host, prepareCall: async () => ({ ...base, requestTimeoutMs: 0 }) }).prepareCall(
        'chatgpt',
        officialModel.id,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST_TIMEOUT' })
    await expect(
      new ChatGptResponsesAdapter({
        ...host,
        prepareCall: async () => ({ ...base, model: { ...model, id: 'gpt-other' } as never }),
      }).prepareCall('chatgpt', officialModel.id),
    ).rejects.toMatchObject({ code: 'MODEL_ID_MISMATCH' })
  })
})

function messageItem(text: string): unknown {
  return { id: 'msg_b', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
}
function refusalItem(text: string): unknown {
  return { id: 'msg_r', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: text }] }
}
function reasoningItem(summary: string, content: string): unknown {
  return {
    id: 'rs_b',
    type: 'reasoning',
    status: 'completed',
    summary: [{ type: 'summary_text', text: summary }],
    content: [{ type: 'reasoning_text', text: content }],
    encrypted_content: 'encrypted',
  }
}

describe('ChatGPT Responses stream branches', () => {
  it('streams a refusal as text and replays the completed item', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { id: 'msg_r', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      },
      { type: 'response.refusal.delta', item_id: 'msg_r', output_index: 0, content_index: 0, sequence_number: 2, delta: 'I cannot.' },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 3, item: refusalItem('I cannot.') },
      completedEvent([refusalItem('I cannot.')]),
    ]
    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'I cannot.' })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  })

  it('streams reasoning summary and reasoning content deltas', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { id: 'rs_b', type: 'reasoning', status: 'in_progress', summary: [] },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_b',
        output_index: 0,
        summary_index: 0,
        sequence_number: 2,
        delta: 'Plan.',
      },
      { type: 'response.reasoning_text.delta', item_id: 'rs_b', output_index: 0, content_index: 0, sequence_number: 3, delta: 'Think.' },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 4, item: reasoningItem('Plan.', 'Think.') },
      completedEvent([reasoningItem('Plan.', 'Think.')]),
    ]
    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'Plan.' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 1, text: 'Think.' })
  })

  it('creates completed blocks when no deltas streamed', async () => {
    const events = [
      { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: messageItem('Hello.') },
      completedEvent([messageItem('Hello.')]),
    ]
    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello.' } })
  })

  it('maps failed and incomplete terminal events to provider errors', async () => {
    const failed = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          {
            type: 'response.failed',
            sequence_number: 1,
            response: { id: 'r', status: 'failed', error: { code: 'server_error', message: 'upstream' } },
          },
        ]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(failed).toMatchObject({ code: 'OPENAI_RESPONSES_ERROR' })
    const incomplete = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          {
            type: 'response.incomplete',
            sequence_number: 1,
            response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
          },
        ]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(incomplete).toMatchObject({ code: 'INCOMPLETE_RESPONSE' })
  })

  it('rejects a completed event with a non-completed status or empty output', async () => {
    const wrongStatus = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([completedEvent([messageItem('x')], { status: 'failed' })]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(wrongStatus).toMatchObject({ code: 'MALFORMED_RESPONSE' })
    const empty = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([completedEvent([])]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(empty).toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('rejects tool arguments before their function item and a completed item without an index', async () => {
    const beforeItem = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.function_call_arguments.delta', item_id: 'call_x', output_index: 0, sequence_number: 1, delta: '{}' },
          completedEvent([messageItem('x')]),
        ]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(beforeItem).toMatchObject({ code: 'MALFORMED_RESPONSE' })
    const missingIndex = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.output_item.done', sequence_number: 1, item: messageItem('x') },
          completedEvent([messageItem('x')]),
        ]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(missingIndex).toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects a non-replayable completed item and a terminal output mismatch', async () => {
    const unknownItem = { id: 'weird', type: 'future_private_item' }
    const unsupported = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: messageItem('Hello.') },
          { type: 'response.output_item.done', output_index: 1, sequence_number: 2, item: unknownItem },
          completedEvent([messageItem('Hello.'), unknownItem]),
        ]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(unsupported).toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    const mismatch = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: messageItem('Hello.') },
          completedEvent([reasoningItem('Plan.', 'Think.')]),
        ]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(mismatch).toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

describe('ChatGPT Responses preparation and late events', () => {
  it('streams through the prepared call and skips the idle watchdog when disabled', async () => {
    const adapter = new ChatGptResponsesAdapter(hostFor(undefined, 'account-test' as ChatGptAccountId, 0), {
      fetch: eventFetch(completedTextEvents('Hi.')),
    })
    const prepared = await adapter.prepareCall('chatgpt', officialModel.id)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream(options())) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  })

  it('reports an abort that lands while events are being read', async () => {
    const controller = new AbortController()
    const encoder = new TextEncoder()
    const adapter = new ChatGptResponsesAdapter(hostFor(controller.signal), {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: 'response.output_text.delta',
                    item_id: 'i',
                    output_index: 0,
                    content_index: 0,
                    sequence_number: 1,
                    delta: 'x',
                  })}\n\n`,
                ),
              )
              controller.abort(new Error('account signed out'))
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_abort' } },
        ),
    })
    await expect(collect(adapter, options())).rejects.toMatchObject({
      code: 'ABORTED',
      failure: { requestId: 'req_abort' },
    })
  })

  it('ignores late deltas for closed blocks and starts blocks that only a completed item mentions', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { id: 'msg_late', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 2, item: messageItem('Done.') },
      { type: 'response.output_text.delta', item_id: 'msg_late', output_index: 0, content_index: 0, sequence_number: 3, delta: 'late' },
      completedEvent([messageItem('Done.')]),
    ]
    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } })
  })

  it('rejects an unsupported content block and an unknown event type still completes', async () => {
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(completedTextEvents('ok')) })
    await expect(
      collect(
        adapter,
        options({
          messages: [
            createSystemMessage('s'),
            createToolResultMessage({ callId: 'call-1' as never, content: [{ type: 'tool-addition', toolName: 'x' }], isError: false }),
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    const unknownEvents = [{ type: 'response.some_future_event', sequence_number: 1 }, ...completedTextEvents('ok')]
    await expect(collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(unknownEvents) }), options())).resolves.toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'ok' },
    })
  })

  it('fails on an error event and on a terminal output length mismatch', async () => {
    const errorEvent = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([{ type: 'error', code: 'invalid_request_error', message: 'bad request' }]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(errorEvent).toMatchObject({ code: 'OPENAI_RESPONSES_ERROR' })
    const lengthMismatch = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: messageItem('Hello.') },
          completedEvent([messageItem('Hello.'), messageItem('Extra.')]),
        ]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(lengthMismatch).toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('treats an item without a usable type name as unknown and refuses it for replay', async () => {
    const unknownItem = { id: 'weird' }
    const result = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: messageItem('Hello.') },
          { type: 'response.output_item.done', output_index: 1, sequence_number: 2, item: unknownItem },
          completedEvent([messageItem('Hello.'), unknownItem]),
        ]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(result).toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('rejects a response whose completed output has no replayable items', async () => {
    const result = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          {
            type: 'response.output_text.delta',
            item_id: 'msg_none',
            output_index: 0,
            content_index: 0,
            sequence_number: 1,
            delta: 'Hello.',
          },
          completedEvent([]),
        ]),
      }),
      options(),
    ).catch((error: unknown) => error)
    expect(result).toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})

describe('ChatGPT Responses replay and usage validation', () => {
  it.each([
    ['non-object output item', ['not-an-object']],
    ['reasoning without encrypted content', [{ type: 'reasoning', id: 'rs' }]],
    ['unknown item type', [{ type: 'mystery' }]],
    ['configuration update without id', [{ type: 'configuration_update' }]],
    ['configuration update with non-object reasoning', [{ type: 'configuration_update', id: 'c', reasoning: 5 }]],
    [
      'message refusal with a non-string body',
      [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'refusal', refusal: 5 }] }],
    ],
  ])('drops replay state with a %s', async (_label, output) => {
    const captured: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('ok'), (_request, body) => captured.push(body)),
    })
    const replayState = {
      response: { adapter: 'openai-responses-v1', provider: 'chatgpt', accountId: 'account-test', model: officialModel.id, output },
    }
    await collect(
      adapter,
      options({
        messages: [
          createSystemMessage('s'),
          createAssistantMessage({
            content: [{ type: 'text', text: 'old' }],
            source: { provider: 'chatgpt', model: officialModel.id, replayState },
          }),
          { role: 'user', content: [{ type: 'text', text: 'next' }] },
        ],
      }),
    )
    expect(JSON.stringify(captured[0]?.input)).not.toContain('opaque')
  })

  it('omits usage when counters are incomplete or cached tokens exceed the input', async () => {
    const partial = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.output_text.delta', item_id: 'msg_u', output_index: 0, content_index: 0, sequence_number: 1, delta: 'x' },
          completedEvent([messageItem('x')], {
            usage: { input_tokens: 5, output_tokens: undefined, input_tokens_details: null, output_tokens_details: null, total_tokens: 5 },
          }),
        ]),
      }),
      options(),
    )
    expect(partial.some(chunk => chunk.type === 'usage')).toBe(false)
    const inconsistent = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.output_text.delta', item_id: 'msg_u', output_index: 0, content_index: 0, sequence_number: 1, delta: 'x' },
          completedEvent([messageItem('x')], {
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              total_tokens: 7,
              input_tokens_details: { cached_tokens: 4, cache_write_tokens: 4 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }),
        ]),
      }),
      options(),
    )
    expect(inconsistent.some(chunk => chunk.type === 'usage')).toBe(false)
  })
})

describe('ChatGPT Responses HTTP error mapping', () => {
  function errorFetch(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
    return async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      })
  }

  it.each([
    [401, { error: { message: 'no', code: 'invalid_api_key' } }, 'AUTH'],
    [429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }, 'RATE_LIMIT'],
    [
      400,
      { error: { message: "This model's maximum context length is 100 tokens", code: 'invalid_request_error' } },
      'CONTEXT_WINDOW_EXCEEDED',
    ],
    [400, { error: { message: 'bad', code: 'invalid_request_error' } }, 'INVALID_REQUEST'],
    [503, { error: { message: 'down', code: 'server_error' } }, 'SERVER'],
  ])('maps HTTP %s to %s', async (status, body, code) => {
    const error = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: errorFetch(status, body) }), options()).catch(
      (value: unknown) => value,
    )
    expect(error).toMatchObject({ code })
  })

  it('keeps a provider retry hint and a string error detail', async () => {
    const numeric = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: errorFetch(429, { error: { message: 'slow', code: 'rate_limit_exceeded' } }, { 'retry-after': '2' }),
      }),
      options(),
    ).catch((value: unknown) => value)
    expect(numeric).toMatchObject({ code: 'RATE_LIMIT', failure: { providerRetryAfterMs: 2_000 } })
  })
})

describe('ChatGPT Responses late and completed-only items', () => {
  it('rejects a model-declared reasoning effort that Responses cannot encode', async () => {
    const ultra = {
      ...toOpenAiResolvedModelInfo(provider, officialModel),
      reasoning: { efforts: [{ id: ReasoningEffortId('ultra'), name: 'Ultra' }], defaultEffort: ReasoningEffortId('ultra') },
    }
    const base = {
      accountId: 'account-test' as ChatGptAccountId,
      accessToken: 'token',
      accountSignal: new AbortController().signal,
      requestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 120_000,
    }
    const host = {
      ...hostFor(),
      resolveModel: async () => ultra,
      prepareCall: async () => ({ ...base, model: ultra }),
    }
    const adapter = new ChatGptResponsesAdapter(host, { fetch: eventFetch(completedTextEvents('ok')) })
    await expect(collect(adapter, options({ model: officialModel.id, reasoningEffort: 'ultra' as never }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_REASONING_EFFORT',
    })
  })

  it('ignores deltas that arrive after their block closed', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { id: 'msg_b', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      },
      { type: 'response.output_text.delta', item_id: 'msg_b', output_index: 0, content_index: 0, sequence_number: 2, delta: 'A' },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 3, item: messageItem('A') },
      { type: 'response.output_text.delta', item_id: 'msg_b', output_index: 0, content_index: 0, sequence_number: 4, delta: 'late' },
      { type: 'response.refusal.delta', item_id: 'msg_r', output_index: 1, content_index: 0, sequence_number: 5, delta: 'No.' },
      { type: 'response.output_item.done', output_index: 1, sequence_number: 6, item: refusalItem('No.') },
      { type: 'response.refusal.delta', item_id: 'msg_r', output_index: 1, content_index: 0, sequence_number: 7, delta: 'late' },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_b',
        output_index: 2,
        summary_index: 0,
        sequence_number: 8,
        delta: 'Plan.',
      },
      { type: 'response.reasoning_text.delta', item_id: 'rs_b', output_index: 2, content_index: 0, sequence_number: 9, delta: 'Think.' },
      { type: 'response.output_item.done', output_index: 2, sequence_number: 10, item: reasoningItem('Plan.', 'Think.') },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_b',
        output_index: 2,
        summary_index: 0,
        sequence_number: 11,
        delta: 'late',
      },
      { type: 'response.reasoning_text.delta', item_id: 'rs_b', output_index: 2, content_index: 0, sequence_number: 12, delta: 'late' },
      completedEvent([messageItem('A'), refusalItem('No.'), reasoningItem('Plan.', 'Think.')]),
    ]
    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'A' } })
    expect(chunks).toContainEqual({ type: 'block-end', index: 1, block: { type: 'text', text: 'No.' } })
    expect(
      chunks.some(chunk => chunk.type === 'block-end' && (chunk.block.type === 'reasoning' ? chunk.block.text.includes('late') : false)),
    ).toBe(false)
  })

  it('starts refusal and reasoning blocks that only a completed item mentions', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { id: 'msg_r2', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 2, item: refusalItem('No.') },
      {
        type: 'response.output_item.added',
        output_index: 1,
        sequence_number: 3,
        item: { id: 'rs_2', type: 'reasoning', status: 'in_progress', summary: [] },
      },
      { type: 'response.output_item.done', output_index: 1, sequence_number: 4, item: reasoningItem('Plan.', 'Think.') },
      completedEvent([refusalItem('No.'), reasoningItem('Plan.', 'Think.')]),
    ]
    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'No.' } })
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')).toBe(true)
  })

  it('retains opaque replay when an alias resolves to a provider snapshot model', async () => {
    const captured: Record<string, unknown>[] = []
    const output = [{ type: 'reasoning', id: 'rs_alias', encrypted_content: 'opaque-alias', summary: [] }, messageItem('old')]
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(
        [
          { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: output[0] },
          { type: 'response.output_item.done', output_index: 1, sequence_number: 2, item: output[1] },
          completedEvent(output, { model: `${officialModel.id}-2026-10-01` }),
        ],
        (_request, body) => captured.push(body),
      ),
    })
    const first = await collect(adapter, options())
    const finish = first.find(chunk => chunk.type === 'finish')
    if (finish?.type !== 'finish') throw new Error('missing finish')
    expect(finish.replayState).toMatchObject({ response: { model: officialModel.id, responseModel: `${officialModel.id}-2026-10-01` } })
    await collect(
      adapter,
      options({
        messages: [
          createAssistantMessage({
            content: [{ type: 'text', text: 'old' }],
            source: { provider: 'chatgpt', model: officialModel.id, replayState: finish.replayState },
          }),
          { role: 'user', content: [{ type: 'text', text: 'next' }] },
        ],
      }),
    )
    expect(JSON.stringify(captured[1]?.input)).toContain('opaque-alias')
  })

  it('replays a valid stored response instead of resending the message', async () => {
    const captured: Record<string, unknown>[] = []
    const replayState = {
      response: {
        adapter: 'openai-responses-v1',
        provider: 'chatgpt',
        accountId: 'account-test',
        model: officialModel.id,
        output: [
          { type: 'reasoning', id: 'rs_ok', encrypted_content: 'opaque-replay', summary: [] },
          { type: 'message', id: 'msg_ok', role: 'assistant', content: [{ type: 'output_text', text: 'old', annotations: [] }] },
          { type: 'configuration_update', id: 'cfg_ok', reasoning: { effort: 'low' } },
          { type: 'compaction', id: 'cmp_ok', encrypted_content: 'opaque-compaction' },
        ],
      },
    }
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('ok'), (_request, body) => captured.push(body)),
    })
    await collect(
      adapter,
      options({
        messages: [
          createSystemMessage('s'),
          createAssistantMessage({
            source: { provider: 'chatgpt', model: officialModel.id, replayState },
            content: [{ type: 'text', text: 'old' }],
          }),
          { role: 'user', content: [{ type: 'text', text: 'next' }] },
        ],
      }),
    )
    expect(JSON.stringify(captured[0]?.input)).toContain('opaque-replay')
  })
})

describe('ChatGPT Responses transport failures', () => {
  it('normalizes a thrown transport error', async () => {
    const error = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: async () => {
          throw new Error('network down')
        },
      }),
      options(),
    ).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'OPENAI_RESPONSES_ERROR' })
  })

  it('reports a string-valued failure detail from the stream', async () => {
    const error = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([{ type: 'response.failed', sequence_number: 1, response: { id: 'r', status: 'failed', error: 'oops' } }]),
      }),
      options(),
    ).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'OPENAI_RESPONSES_ERROR', message: 'oops' })
  })
})

describe('ChatGPT Responses mid-iteration cancellation', () => {
  it('reports an abort after the first streamed chunk', async () => {
    const controller = new AbortController()
    const encoder = new TextEncoder()
    const event = {
      type: 'response.output_text.delta',
      item_id: 'msg_abort',
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: 'x',
    }
    const adapter = new ChatGptResponsesAdapter(hostFor(controller.signal), {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            },
            pull(stream) {
              return new Promise<void>((_resolve, reject) => {
                if (signal?.aborted === true) {
                  stream.error(signal.reason)
                  reject(new Error('aborted'))
                  return
                }
                signal?.addEventListener(
                  'abort',
                  () => {
                    stream.error(signal.reason)
                    reject(new Error('aborted'))
                  },
                  { once: true },
                )
              })
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    await expect(
      (async () => {
        for await (const chunk of adapter.stream(options())) {
          if (chunk.type === 'text-delta') controller.abort(new Error('account signed out'))
        }
      })(),
    ).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('ChatGPT Responses reasoning and replay edge cases', () => {
  it('refuses a request whose signal was already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const adapter = new ChatGptResponsesAdapter(hostFor(controller.signal), {
      fetch: eventFetch(completedTextEvents('ok')),
    })
    await expect(collect(adapter, options({ signal: controller.signal }))).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('encodes a supported reasoning effort into the request', async () => {
    const captured: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('ok'), (_request, body) => captured.push(body)),
    })
    await collect(adapter, options({ reasoningEffort: 'low' as never }))
    expect(captured[0]?.reasoning).toEqual({ effort: 'low' })
  })

  it('drops a configuration update without an id and a message part that is not an object', async () => {
    const captured: Record<string, unknown>[] = []
    const replayState = {
      response: {
        adapter: 'openai-responses-v1',
        provider: 'chatgpt',
        accountId: 'account-test',
        model: officialModel.id,
        output: [{ type: 'configuration_update', id: 5 }],
      },
    }
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('ok'), (_request, body) => captured.push(body)),
    })
    await collect(
      adapter,
      options({
        messages: [
          createSystemMessage('s'),
          createAssistantMessage({
            source: { provider: 'chatgpt', model: officialModel.id, replayState },
            content: [{ type: 'text', text: 'old' }],
          }),
        ],
      }),
    )
    expect(JSON.stringify(captured[0]?.input)).toContain('old')
  })

  it('drops a stored message part that is not a JSON object', async () => {
    const captured: Record<string, unknown>[] = []
    const replayState = {
      response: {
        adapter: 'openai-responses-v1',
        provider: 'chatgpt',
        accountId: 'account-test',
        model: officialModel.id,
        output: [{ type: 'message', id: 'msg_x', role: 'assistant', content: ['not-an-object'] }],
      },
    }
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('ok'), (_request, body) => captured.push(body)),
    })
    await collect(
      adapter,
      options({
        messages: [
          createSystemMessage('s'),
          createAssistantMessage({
            source: { provider: 'chatgpt', model: officialModel.id, replayState },
            content: [{ type: 'text', text: 'old' }],
          }),
        ],
      }),
    )
    expect(JSON.stringify(captured[0]?.input)).toContain('old')
  })

  it('omits usage when cached-token details are absent', async () => {
    const chunks = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.output_text.delta', item_id: 'msg_c', output_index: 0, content_index: 0, sequence_number: 1, delta: 'x' },
          completedEvent([messageItem('x')], {
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              total_tokens: 7,
              input_tokens_details: { cached_tokens: undefined, cache_write_tokens: undefined },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }),
        ]),
      }),
      options(),
    )
    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
  })
})

describe('ChatGPT Responses optional request fields and wire fallbacks', () => {
  it('streams without an injected transport when no fetch option is set', async () => {
    vi.stubGlobal('fetch', eventFetch(completedTextEvents('Global.')))
    try {
      const chunks = await collect(new ChatGptResponsesAdapter(hostFor()), options())
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Global.' })
      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('omits instructions and tool declarations the caller does not supply', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Bare.'), (_request, body) => {
        capturedBody = body
      }),
    })
    const bare: GenerateOptions = {
      provider,
      model: officialModel.id,
      messages: [createSystemMessage('History instruction.'), { role: 'user', content: [{ type: 'text', text: 'Hello.' }] }],
    }

    await collect(adapter, bare)

    expect(capturedBody).not.toHaveProperty('instructions')
    const input = capturedBody?.input as Array<Record<string, unknown>>
    expect(input.some(item => item.type === 'additional_tools')).toBe(false)
    expect(input.map(item => item.role ?? item.type)).toEqual(['developer', 'user'])
  })

  it('keeps multiple tool result parts as structured output content', async () => {
    const captured: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('ok'), (_request, body) => captured.push(body)),
    })
    await collect(
      adapter,
      options({
        messages: [
          createSystemMessage('s'),
          createToolResultMessage({
            callId: 'call-parts' as never,
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' },
            ],
            isError: false,
          }),
        ],
      }),
    )
    expect(captured[0]?.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call-parts',
      output: [
        { type: 'input_text', text: 'first' },
        { type: 'input_text', text: 'second' },
      ],
    })
  })

  it('declares a current tool added after the baseline without a matching history update', async () => {
    const addedTool = { name: 'added_lookup', description: 'Added record lookup.', parameters: { type: 'object' } }
    const update = createDeveloperMessage({
      source: { kind: 'system-prompt' },
      content: [{ type: 'tool-addition', toolName: addedTool.name }],
    })
    let capturedBody: Record<string, unknown> | undefined
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Done.'), (_request, body) => {
        capturedBody = body
      }),
    })

    await collect(
      adapter,
      options({
        messages: [createSystemMessage('Context.'), update],
        tools: [addedTool],
        toolHistory: { tools: [], updates: [] },
      }),
    )

    const input = capturedBody?.input as Array<Record<string, unknown>>
    expect(input).toContainEqual({
      type: 'additional_tools',
      role: 'developer',
      tools: [
        {
          type: 'function',
          name: addedTool.name,
          description: addedTool.description,
          parameters: addedTool.parameters,
          strict: false,
        },
      ],
    })
  })

  it('skips a tool-addition block for a tool outside the current request', async () => {
    const update = createDeveloperMessage({
      source: { kind: 'system-prompt' },
      content: [{ type: 'tool-addition', toolName: 'retired_lookup' }],
    })
    let capturedBody: Record<string, unknown> | undefined
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Done.'), (_request, body) => {
        capturedBody = body
      }),
    })

    await collect(
      adapter,
      options({
        messages: [createSystemMessage('Context.'), update],
        tools: [],
        toolHistory: { tools: [], updates: [] },
      }),
    )

    const input = capturedBody?.input as Array<Record<string, unknown>>
    expect(input.some(item => item.type === 'additional_tools')).toBe(false)
  })

  it('refuses an exact route whose configured context cap is not positive', async () => {
    const adapter = new ChatGptResponsesAdapter({
      ...hostFor(),
      resolveModel: async () => ({ ...model, context: { contextWindow: 0 } }),
    })

    await expect(adapter.resolveModel(provider, officialModel.id)).rejects.toMatchObject({
      code: 'MODEL_CONTEXT_REQUIRED',
    })
  })

  it('resolves a route that does not declare addition-only tool updates', async () => {
    const { toolUpdate: _toolUpdate, ...withoutToolUpdate } = model
    const adapter = new ChatGptResponsesAdapter({
      ...hostFor(),
      resolveModel: async () => withoutToolUpdate,
    })

    const resolved = await adapter.resolveModel(provider, officialModel.id)

    expect(resolved).not.toHaveProperty('toolUpdate')
    expect(resolved.context?.contextWindow).toBe(1_050_000)
  })

  it('refuses a reasoning effort for a model that declares no reasoning levels', async () => {
    const { reasoning: _reasoning, ...withoutReasoning } = model
    const base = hostFor()
    const host: ChatGptAdapterHost = {
      ...base,
      prepareCall: async (requestedModel, signal) => ({
        ...(await base.prepareCall(requestedModel, signal)),
        model: withoutReasoning,
      }),
    }
    const adapter = new ChatGptResponsesAdapter(host, { fetch: eventFetch(completedTextEvents('ok')) })

    await expect(collect(adapter, options({ reasoningEffort: 'low' as never }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_REASONING_EFFORT',
    })
  })

  it('reports the request id when a response stalls after its headers', async () => {
    const encoder = new TextEncoder()
    const stalled = (): typeof fetch => async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'response.output_text.delta',
                  sequence_number: 0,
                  output_index: 0,
                  content_index: 0,
                  delta: 'partial',
                  item_id: 'item-idle-id',
                })}\n\n`,
              ),
            )
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_idle' },
        },
      )
    const adapter = new ChatGptResponsesAdapter(hostFor(undefined, 'account-test' as ChatGptAccountId, 20), {
      fetch: stalled(),
    })

    await expect(collect(adapter, options())).rejects.toMatchObject({
      code: 'STREAM_IDLE_TIMEOUT',
      failure: { requestId: 'req_idle' },
    })
  })

  it('omits the replay request id when the response carries no request id header', async () => {
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('No header.'), undefined, null),
    })

    const chunks = await collect(adapter, options())

    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(chunks.at(-1)).not.toHaveProperty('replayState.response.requestId')
  })

  it('maps failed and incomplete responses without provider details', async () => {
    const failed = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.failed', sequence_number: 1, response: { id: 'r', status: 'failed', error: null, incomplete_details: null } },
        ]),
      }),
      options(),
    ).catch((value: unknown) => value)
    expect(failed).toMatchObject({ code: 'OPENAI_RESPONSES_ERROR', message: 'OpenAI Responses stream failed' })

    const incomplete = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          {
            type: 'response.incomplete',
            sequence_number: 1,
            response: { id: 'r', status: 'incomplete', error: null, incomplete_details: null },
          },
        ]),
      }),
      options(),
    ).catch((value: unknown) => value)
    expect(incomplete).toMatchObject({ code: 'INCOMPLETE_RESPONSE', message: 'OpenAI Responses stream failed' })
  })

  it('reports a failure detail that is neither an object nor a string', async () => {
    const error = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([{ type: 'response.failed', sequence_number: 1, response: { id: 'r', status: 'failed', error: 7 } }]),
      }),
      options(),
    ).catch((value: unknown) => value)

    expect(error).toMatchObject({ code: 'OPENAI_RESPONSES_ERROR', message: 'OpenAI Responses stream failed' })
  })

  it('omits the request id when a failed response carries no request id header', async () => {
    const error = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch(
          [
            {
              type: 'response.failed',
              sequence_number: 1,
              response: { id: 'r', status: 'failed', error: { code: 'server_error', message: 'upstream' } },
            },
          ],
          undefined,
          null,
        ),
      }),
      options(),
    ).catch((value: unknown) => value)

    expect(error).toMatchObject({ code: 'OPENAI_RESPONSES_ERROR' })
    expect(error).not.toHaveProperty('failure.requestId')
  })

  it('ignores a retry hint that is neither numeric nor a date', async () => {
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'slow down', code: 'rate_limit_exceeded' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': 'soon' },
        }),
    })

    const error = await collect(adapter, options()).catch((value: unknown) => value)

    expect(error).toMatchObject({ code: 'RATE_LIMIT' })
    expect(error).not.toHaveProperty('failure.providerRetryAfterMs')
  })

  it('omits zero cache, cache-write, reasoning, and absent total counters', async () => {
    const chunks = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          {
            type: 'response.output_text.delta',
            item_id: 'msg_zero',
            output_index: 0,
            content_index: 0,
            sequence_number: 1,
            delta: 'x',
          },
          completedEvent([messageItem('x')], {
            usage: {
              input_tokens: 5,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: 2,
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }),
        ]),
      }),
      options(),
    )

    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 2 },
    })
  })

  it('reports replayable and unknown type names for items it cannot replay', async () => {
    const invalidMessage = { id: 'msg_invalid', type: 'message', role: 'user', content: [] }
    const invalidType = { id: 'weird', type: 'future item!' }
    const error = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: messageItem('Hello.') },
          { type: 'response.output_item.done', output_index: 1, sequence_number: 2, item: invalidMessage },
          { type: 'response.output_item.done', output_index: 2, sequence_number: 3, item: invalidType },
          completedEvent([]),
        ]),
      }),
      options(),
    ).catch((value: unknown) => value)

    expect(error).toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: 'OpenAI Responses output item types cannot be replayed with store:false: message, unknown',
    })
  })

  it('summarizes more than eight unreplayable output types', async () => {
    const types = ['future_a', 'future_b', 'future_c', 'future_d', 'future_e', 'future_f', 'future_g', 'future_h', 'future_i']
    const events = [
      { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: messageItem('Hello.') },
      ...types.map((type, index) => ({
        type: 'response.output_item.done',
        output_index: index + 1,
        sequence_number: index + 2,
        item: { id: `item_${String(index)}`, type },
      })),
      completedEvent([]),
    ]
    const error = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options()).catch(
      (value: unknown) => value,
    )

    expect(error).toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message:
        'OpenAI Responses output item types cannot be replayed with store:false: future_a, future_b, future_c, future_d, future_e, future_f, future_g, future_h, and 1 more',
    })
  })

  it('refuses to replay a completed message item without an id', async () => {
    const error = await collect(
      new ChatGptResponsesAdapter(hostFor(), {
        fetch: eventFetch([
          {
            type: 'response.output_item.done',
            output_index: 0,
            sequence_number: 1,
            item: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'No id.', annotations: [] }],
            },
          },
          completedEvent([]),
        ]),
      }),
      options(),
    ).catch((value: unknown) => value)

    expect(error).toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: 'OpenAI Responses output item types cannot be replayed with store:false: message',
    })
  })

  it('streams a function call that carries only a call id and replays its status', async () => {
    const output = {
      type: 'function_call',
      status: 'incomplete',
      call_id: 'call_only',
      name: 'lookup',
      arguments: '{"term":"moon"}',
    }
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { ...output, status: 'in_progress', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'call_only',
        output_index: 0,
        sequence_number: 2,
        delta: '{"term":"moon"}',
      },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 3, item: output },
      completedEvent([output]),
    ]

    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())

    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_only', name: 'lookup', arguments: '{"term":"moon"}' },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: { response: { output: [output] } },
    })
  })

  it('streams arguments for a function item without a call id', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { id: 'fc_without_call', type: 'function_call', status: 'in_progress', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_without_call',
        output_index: 0,
        sequence_number: 2,
        delta: '{"term":"moon"}',
      },
      completedEvent([messageItem('Fallback.')]),
    ]

    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())

    expect(chunks).toContainEqual({
      type: 'tool-call-delta',
      index: 0,
      id: '',
      argumentsDelta: '{"term":"moon"}',
    })
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-0', name: '', arguments: '{"term":"moon"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('closes a function item without arguments using an empty placeholder', async () => {
    const sparse = { id: 'fc_sparse', type: 'function_call', status: 'completed', call_id: 'call_sparse', name: 'lookup' }
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch([{ type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: sparse }, completedEvent([])]),
    })
    const chunks: StreamChunk[] = []
    const error: unknown = await (async () => {
      try {
        for await (const chunk of adapter.stream(options())) chunks.push(chunk)
      } catch (value: unknown) {
        return value
      }
    })()

    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_sparse', name: 'lookup', arguments: '' },
    })
    expect(error).toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('appends repeated deltas to one open block without restarting it', async () => {
    const textOutput = {
      id: 'msg_multi',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Hello world', annotations: [] }],
    }
    const refusalOutput = {
      id: 'msg_multi_refusal',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'refusal', refusal: 'I cannot answer.' }],
    }
    const reasoningOutput = {
      id: 'rs_multi',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'Plan then act.' }],
      content: [{ type: 'reasoning_text', text: 'Think carefully.' }],
      encrypted_content: 'encrypted',
    }
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { id: 'msg_multi', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      },
      { type: 'response.output_text.delta', item_id: 'msg_multi', output_index: 0, content_index: 0, sequence_number: 2, delta: 'Hello ' },
      { type: 'response.output_text.delta', item_id: 'msg_multi', output_index: 0, content_index: 0, sequence_number: 3, delta: 'world' },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 4, item: textOutput },
      {
        type: 'response.output_item.added',
        output_index: 1,
        sequence_number: 5,
        item: { id: 'msg_multi_refusal', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      },
      {
        type: 'response.refusal.delta',
        item_id: 'msg_multi_refusal',
        output_index: 1,
        content_index: 0,
        sequence_number: 6,
        delta: 'I cannot ',
      },
      {
        type: 'response.refusal.delta',
        item_id: 'msg_multi_refusal',
        output_index: 1,
        content_index: 0,
        sequence_number: 7,
        delta: 'answer.',
      },
      { type: 'response.output_item.done', output_index: 1, sequence_number: 8, item: refusalOutput },
      {
        type: 'response.output_item.added',
        output_index: 2,
        sequence_number: 9,
        item: { id: 'rs_multi', type: 'reasoning', status: 'in_progress', summary: [] },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_multi',
        output_index: 2,
        summary_index: 0,
        sequence_number: 10,
        delta: 'Plan ',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_multi',
        output_index: 2,
        summary_index: 0,
        sequence_number: 11,
        delta: 'then act.',
      },
      {
        type: 'response.reasoning_text.delta',
        item_id: 'rs_multi',
        output_index: 2,
        content_index: 0,
        sequence_number: 12,
        delta: 'Think ',
      },
      {
        type: 'response.reasoning_text.delta',
        item_id: 'rs_multi',
        output_index: 2,
        content_index: 0,
        sequence_number: 13,
        delta: 'carefully.',
      },
      { type: 'response.output_item.done', output_index: 2, sequence_number: 14, item: reasoningOutput },
      completedEvent([textOutput, refusalOutput, reasoningOutput]),
    ]

    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())

    expect(chunks.filter(chunk => chunk.type === 'block-start')).toHaveLength(4)
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual([
      'Hello ',
      'world',
      'I cannot ',
      'answer.',
    ])
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text)).toEqual([
      'Plan ',
      'then act.',
      'Think ',
      'carefully.',
    ])
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)).toEqual([
      { type: 'text', text: 'Hello world' },
      { type: 'text', text: 'I cannot answer.' },
      { type: 'reasoning', text: 'Plan then act.' },
      { type: 'reasoning', text: 'Think carefully.' },
    ])
  })

  it('ignores repeated done items whose blocks already closed', async () => {
    const message = (id: string, content: Record<string, unknown>) => ({
      id,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [content],
    })
    const reasoning = {
      id: 'rs_repeat',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'Plan.' }],
      content: [{ type: 'reasoning_text', text: 'Think.' }],
      encrypted_content: 'encrypted',
    }
    const call = {
      id: 'fc_repeat',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_repeat',
      name: 'lookup',
      arguments: '{"term":"moon"}',
    }
    const done = (outputIndex: number, item: unknown) => ({
      type: 'response.output_item.done',
      output_index: outputIndex,
      sequence_number: outputIndex + 1,
      item,
    })
    const events = [
      done(0, message('msg_repeat', { type: 'output_text', text: 'Answer.', annotations: [] })),
      done(1, message('msg_repeat', { type: 'output_text', text: 'Answer.', annotations: [] })),
      done(2, message('msg_repeat_refusal', { type: 'refusal', refusal: 'No.' })),
      done(3, message('msg_repeat_refusal', { type: 'refusal', refusal: 'No.' })),
      done(4, reasoning),
      done(5, reasoning),
      done(6, call),
      done(7, call),
      completedEvent([]),
    ]

    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())

    expect(chunks.filter(chunk => chunk.type === 'block-start')).toHaveLength(5)
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toHaveLength(5)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('closes a reasoning block that is still open at response completion', async () => {
    const reasoning = {
      id: 'rs_open',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'Plan.' }],
      content: [{ type: 'reasoning_text', text: '' }],
      encrypted_content: 'encrypted',
    }
    const events = [
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_open',
        output_index: 0,
        summary_index: 0,
        sequence_number: 1,
        delta: 'Plan.',
      },
      completedEvent([reasoning]),
    ]

    const chunks = await collect(new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) }), options())

    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'reasoning', text: 'Plan.' },
    })
  })

  it('normalizes a host image read failure as a provider-neutral error', async () => {
    const image = {
      attachmentId: AttachmentId('image-fail'),
      mediaType: 'image/png',
      bytes: 2,
      width: 1,
      height: 1,
    } as const
    const host: ChatGptAdapterHost = {
      ...hostFor(),
      readImage: async () => {
        throw new Error('image read failed')
      },
    }
    const adapter = new ChatGptResponsesAdapter(host, { fetch: eventFetch(completedTextEvents('unused')) })

    const error = await collect(
      adapter,
      options({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe.' },
              { type: 'image', attachment: image },
            ],
          },
        ],
      }),
    ).catch((value: unknown) => value)

    expect(error).toMatchObject({ code: 'OPENAI_RESPONSES_ERROR', message: 'image read failed' })
    expect(error).not.toHaveProperty('failure.requestId')
  })

  it('normalizes malformed stream JSON after headers with its request id', async () => {
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: async () =>
        new Response('data: {not-json}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_malformed' },
        }),
    })

    const error = await collect(adapter, options()).catch((value: unknown) => value)

    expect(error).toMatchObject({
      code: 'OPENAI_RESPONSES_ERROR',
      message: 'Error reading response: malformed server-sent event JSON.',
      failure: { requestId: 'req_malformed' },
    })
  })
})
