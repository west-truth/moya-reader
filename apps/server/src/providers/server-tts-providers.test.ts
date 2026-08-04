import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceProfile } from '@noveldesk/contracts';
import { ElevenLabsTTSProvider } from './elevenlabs-tts-provider.js';
import { GeminiTTSProvider } from './gemini-tts-provider.js';
import { GeminiVertexTTSProvider } from './gemini-vertex-tts-provider.js';
import { GoogleCloudTTSProvider } from './google-cloud-tts-provider.js';
import { LocalEndpointTTSProvider } from './local-endpoint-tts-provider.js';
import { OpenAITTSProvider } from './openai-tts-provider.js';
import { createServerTTSSynthesisProvider } from './server-tts-provider-factory.js';

const voiceProfile: VoiceProfile = {
  id: 'voice_1',
  novelId: 'book_1',
  role: 'character',
  providerId: 'openai-tts',
  providerVoiceId: 'coral',
  providerModel: 'gpt-tts',
  label: 'Character voice',
  language: 'ko-KR',
  tone: 'calm',
  speed: 1.1,
  providerOptions: { instructions: 'Speak softly.' },
  isUserSelected: true,
};

describe('server TTS providers', () => {
  it('builds OpenAI speech requests without exposing secrets in the body', async () => {
    const controller = new AbortController();
    let captured: { url: string; init: RequestInit; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) };
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'x-request-id': 'req_1' },
      });
    });
    const provider = new OpenAITTSProvider({
      apiKey: 'openai-secret',
      baseUrl: 'https://openai.test/v1',
      modelId: 'gpt-4o-mini-tts',
      fetchImpl,
    });

    const result = await provider.synthesize({
      text: '안녕하세요.',
      voiceProfile,
      emotion: 'warm',
      tone: 'calm',
      speed: 1.1,
      format: 'mp3',
      providerOptions: { responseFormat: 'mp3' },
      signal: controller.signal,
    });

    expect(captured?.url).toBe('https://openai.test/v1/audio/speech');
    expect(captured?.init.headers).toMatchObject({ Authorization: 'Bearer openai-secret' });
    expect(captured?.init.signal).toBe(controller.signal);
    expect(JSON.stringify(captured?.body)).not.toContain('openai-secret');
    expect(captured?.body).toMatchObject({
      model: 'gpt-4o-mini-tts',
      input: '안녕하세요.',
      voice: 'coral',
      response_format: 'mp3',
      speed: 1.1,
    });
    expect(result.contentType).toBe('audio/mpeg');
    expect(new Uint8Array(result.audio)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('builds ElevenLabs speech requests with voice settings outside the secret body', async () => {
    let captured: { url: string; init: RequestInit; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) };
      return new Response(new Uint8Array([11, 12]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'request-id': 'xi_req_1' },
      });
    });
    const provider = new ElevenLabsTTSProvider({
      apiKey: 'eleven-secret',
      baseUrl: 'https://eleven.test',
      modelId: 'eleven_flash_v2_5',
      fetchImpl,
    });

    const result = await provider.synthesize({
      text: '안녕하세요.',
      voiceProfile: { ...voiceProfile, providerId: 'elevenlabs', providerVoiceId: 'voice-eleven-1' },
      speed: 1.05,
      format: 'mp3',
      providerOptions: { stability: 0.4, similarityBoost: 0.8, outputFormat: 'mp3_44100_128', enableLogging: false },
    });

    expect(captured?.url).toBe(
      'https://eleven.test/v1/text-to-speech/voice-eleven-1?output_format=mp3_44100_128&enable_logging=false',
    );
    expect(captured?.init.headers).toMatchObject({ 'xi-api-key': 'eleven-secret' });
    expect(JSON.stringify(captured?.body)).not.toContain('eleven-secret');
    expect(captured?.body).toMatchObject({
      text: '안녕하세요.',
      model_id: 'eleven_flash_v2_5',
      voice_settings: expect.objectContaining({
        stability: 0.4,
        similarity_boost: 0.8,
        speed: 1.05,
      }),
    });
    expect(result.contentType).toBe('audio/mpeg');
    expect(new Uint8Array(result.audio)).toEqual(new Uint8Array([11, 12]));
  });

  it('builds Gemini TTS interactions and wraps returned PCM as wav audio', async () => {
    let captured: { url: string; init: RequestInit; body: Record<string, unknown> } | undefined;
    const pcm = Buffer.from([1, 0, 2, 0]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({
          steps: [{ content: [{ type: 'audio', mime_type: 'audio/pcm', data: pcm.toString('base64') }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const provider = new GeminiTTSProvider({
      apiKey: 'gemini-secret',
      baseUrl: 'https://gemini.test',
      modelId: 'gemini-3.1-flash-tts-preview',
      fetchImpl,
    });

    const result = await provider.synthesize({
      text: '대사를 읽어줘.',
      voiceProfile: { ...voiceProfile, providerId: 'gemini-tts', providerVoiceId: 'Kore' },
      emotion: 'happy',
      tone: 'bright',
    });

    expect(captured?.url).toBe('https://gemini.test/v1beta/interactions');
    expect(captured?.init.headers).toMatchObject({ 'x-goog-api-key': 'gemini-secret' });
    expect(JSON.stringify(captured?.body)).not.toContain('gemini-secret');
    expect(captured?.body).toMatchObject({
      model: 'gemini-3.1-flash-tts-preview',
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] },
    });
    expect(String(captured?.body.input)).toContain('대사를 읽어줘.');
    expect(result.contentType).toBe('audio/wav');
    const audio = Buffer.from(result.audio);
    expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(audio.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(audio.subarray(-4)).toEqual(pcm);
  });

  it('builds Gemini Vertex TTS generateContent requests and wraps PCM as wav audio', async () => {
    const pcm = Buffer.from([3, 0, 4, 0]);
    const client = {
      generateAudio: vi.fn(async () => ({
        audio: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
        sourceContentType: 'audio/pcm',
        providerRequestId: 'vertex_tts_req_1',
      })),
    };
    const provider = new GeminiVertexTTSProvider({
      project: 'project-1',
      location: 'global',
      modelId: 'gemini-3.1-flash-tts-preview',
      client,
    });

    const result = await provider.synthesize({
      text: '조용히 읽어줘.',
      voiceProfile: {
        ...voiceProfile,
        providerId: 'gemini-vertex-tts',
        providerVoiceId: 'Kore',
        language: 'ko-KR',
        providerOptions: { languageCode: 'ko-KR' },
      },
      emotion: 'calm',
      tone: 'quiet narration',
      providerOptions: { prompt: 'Read softly' },
    });

    expect(client.generateAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gemini-3.1-flash-tts-preview',
        voice: 'Kore',
        languageCode: 'ko-KR',
        contents: expect.stringContaining('조용히 읽어줘.'),
      }),
    );
    expect(result.contentType).toBe('audio/wav');
    expect(result.providerRequestId).toBe('vertex_tts_req_1');
    expect(result.providerMetadata).toMatchObject({
      sourceContentType: 'audio/pcm',
      sampleRate: 24000,
      voice: 'Kore',
      languageCode: 'ko-KR',
    });
    const audio = Buffer.from(result.audio);
    expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(audio.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(audio.subarray(-4)).toEqual(pcm);
  });

  it('rejects empty Gemini Vertex TTS audio before writing a wav header', async () => {
    const provider = new GeminiVertexTTSProvider({
      project: 'project-1',
      location: 'global',
      modelId: 'gemini-3.1-flash-tts-preview',
      client: {
        generateAudio: vi.fn(async () => ({
          audio: new ArrayBuffer(0),
          sourceContentType: 'audio/pcm',
        })),
      },
    });

    await expect(
      provider.synthesize({
        text: 'empty audio',
        voiceProfile: { ...voiceProfile, providerId: 'gemini-vertex-tts', providerVoiceId: 'Kore' },
      }),
    ).rejects.toThrow('Gemini Vertex TTS returned no audio data');
  });

  it('builds Google Cloud TTS requests with bearer auth and base64 audio parsing', async () => {
    let captured: { url: string; init: RequestInit; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({
          audioContent: Buffer.from([21, 22, 23]).toString('base64'),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const provider = new GoogleCloudTTSProvider({
      project: 'project-1',
      location: 'us-central1',
      accessToken: 'google-token',
      modelId: 'gemini-3.1-flash-tts-preview',
      fetchImpl,
    });

    const result = await provider.synthesize({
      text: '구글 클라우드 음성.',
      voiceProfile: { ...voiceProfile, providerId: 'google-cloud-tts', providerVoiceId: 'Kore' },
      format: 'mp3',
      providerOptions: { languageCode: 'ko-KR', prompt: 'Read calmly.' },
    });

    expect(captured?.url).toBe('https://us-central1-texttospeech.googleapis.com/v1/text:synthesize');
    expect(captured?.init.headers).toMatchObject({
      Authorization: 'Bearer google-token',
      'x-goog-user-project': 'project-1',
    });
    expect(JSON.stringify(captured?.body)).not.toContain('google-token');
    expect(captured?.body).toMatchObject({
      input: { text: '구글 클라우드 음성.', prompt: 'Read calmly.' },
      voice: {
        languageCode: 'ko-KR',
        name: 'Kore',
        model_name: 'gemini-3.1-flash-tts-preview',
      },
      audioConfig: { audioEncoding: 'MP3' },
    });
    expect(result.contentType).toBe('audio/mpeg');
    expect(new Uint8Array(result.audio)).toEqual(new Uint8Array([21, 22, 23]));
  });

  it('accepts local endpoint JSON base64 and raw audio responses', async () => {
    const jsonFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            audioBase64: Buffer.from([4, 5, 6]).toString('base64'),
            contentType: 'audio/wav',
            durationMs: 120,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const jsonProvider = new LocalEndpointTTSProvider({
      endpointUrl: 'http://127.0.0.1:9010/synthesize',
      modelId: 'local-model',
      fetchImpl: jsonFetch,
    });

    const jsonResult = await jsonProvider.synthesize({ text: 'hello', voiceProfile, format: 'wav' });

    expect(jsonResult.contentType).toBe('audio/wav');
    expect(jsonResult.durationMs).toBe(120);
    expect(new Uint8Array(jsonResult.audio)).toEqual(new Uint8Array([4, 5, 6]));

    const rawFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([7, 8]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );
    const rawProvider = new LocalEndpointTTSProvider({
      endpointUrl: 'http://127.0.0.1:9010/synthesize',
      fetchImpl: rawFetch,
    });

    const rawResult = await rawProvider.synthesize({ text: 'hello', voiceProfile });

    expect(rawResult.contentType).toBe('audio/mpeg');
    expect(new Uint8Array(rawResult.audio)).toEqual(new Uint8Array([7, 8]));
  });

  it('lists local endpoint voices through the v1 voices contract', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://127.0.0.1:9010/voices');
      return new Response(
        JSON.stringify({
          voices: [
            { id: 'narrator-a', label: 'Narrator A', lang: 'ko-KR' },
            { voiceId: 'hero-b', name: 'Hero B', language: 'en-US' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const provider = new LocalEndpointTTSProvider({
      endpointUrl: 'http://127.0.0.1:9010/synthesize',
      fetchImpl,
    });

    await expect(provider.listVoices()).resolves.toEqual([
      { id: 'narrator-a', label: 'Narrator A', lang: 'ko-KR' },
      { id: 'hero-b', label: 'Hero B', lang: 'en-US' },
    ]);
  });

  it('creates configured TTS providers by id without falling back to system TTS', () => {
    expect(
      createServerTTSSynthesisProvider({
        providerId: 'openai-tts',
        env: {
          TTS_PROVIDER_ENABLED: 'openai-tts',
          TTS_OPENAI_MODEL_ID: 'gpt-tts',
          OPENAI_API_KEY: 'secret',
        },
      }).providerId,
    ).toBe('openai-tts');

    expect(
      createServerTTSSynthesisProvider({
        providerId: 'local-endpoint',
        env: {
          TTS_PROVIDER_ENABLED: 'local-endpoint',
          TTS_LOCAL_ENDPOINT_URL: 'http://127.0.0.1:9010/synthesize',
        },
      }).providerId,
    ).toBe('local-endpoint');

    expect(
      createServerTTSSynthesisProvider({
        providerId: 'elevenlabs',
        env: {
          TTS_PROVIDER_ENABLED: 'elevenlabs',
          ELEVENLABS_API_KEY: 'secret',
        },
      }).providerId,
    ).toBe('elevenlabs');

    expect(
      createServerTTSSynthesisProvider({
        providerId: 'gemini-tts',
        env: {
          TTS_PROVIDER_ENABLED: 'gemini-tts',
          GEMINI_API_KEY: 'secret',
        },
      }).providerId,
    ).toBe('gemini-tts');

    expect(
      createServerTTSSynthesisProvider({
        providerId: 'gemini-vertex-tts',
        env: {
          TTS_PROVIDER_ENABLED: 'gemini-vertex-tts',
          GOOGLE_CLOUD_PROJECT: 'project-1',
          GOOGLE_APPLICATION_CREDENTIALS: 'missing-test-credentials.json',
        },
      }).providerId,
    ).toBe('gemini-vertex-tts');

    expect(
      createServerTTSSynthesisProvider({
        providerId: 'google-cloud-tts',
        env: {
          TTS_PROVIDER_ENABLED: 'google-cloud-tts',
          TTS_GOOGLE_CLOUD_ACCESS_TOKEN: 'token',
          GOOGLE_CLOUD_PROJECT: 'project-1',
        },
      }).providerId,
    ).toBe('google-cloud-tts');

    expect(() => createServerTTSSynthesisProvider({ providerId: 'system' })).toThrow(/not available/);
    expect(() => createServerTTSSynthesisProvider({ providerId: 'unknown-provider' })).toThrow(
      /Unsupported TTS provider/,
    );
  });

  it('uses the shared credential path resolver for Google Cloud TTS providers', () => {
    const originalCwd = process.cwd();
    const tempFileName = `.tmp-google-tts-credentials-${Date.now()}.json`;
    const credentialPath = path.join(originalCwd, tempFileName);
    fs.writeFileSync(credentialPath, JSON.stringify({ project_id: 'project-from-file' }), 'utf8');
    try {
      process.chdir(path.join(originalCwd, 'apps/server'));
      const provider = createServerTTSSynthesisProvider({
        providerId: 'google-cloud-tts',
        env: {
          TTS_PROVIDER_ENABLED: 'google-cloud-tts',
          GOOGLE_APPLICATION_CREDENTIALS: tempFileName,
        },
      });

      expect((provider as unknown as { options: { credentialsPath?: string } }).options.credentialsPath).toBe(
        credentialPath,
      );
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(credentialPath, { force: true });
    }
  });
});
