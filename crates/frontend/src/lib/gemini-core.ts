/**
 * gemini-core.ts
 * SDK ligero para Gemini 2.5 Flash Live API (Bidi WebSocket)
 *
 * Funcionalidades:
 * - Gestión de sesión con SessionResumption (Handles).
 * - Streaming de Audio PCM 16-bit 24kHz.
 * - Generador Asíncrono para consumo de texto y audio.
 * - Sistema de eventos tipado para Telemetría y Errores.
 */

// ============================================================================
// 1. DEFINICIÓN DE ERRORES (ERRORES ESTÁNDAR DE LIBRERÍA)
// ============================================================================

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    if (Error.captureStackTrace)
      Error.captureStackTrace(this, this.constructor);
  }
}

export class GeminiAPIError extends GeminiError {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly status?: string,
  ) {
    super(message);
  }
}

export class GeminiConnectionError extends GeminiError {
  constructor(
    message: string,
    public readonly closeCode?: number,
  ) {
    super(message);
  }
}

export class GeminiParseError extends GeminiError {
  constructor(
    message: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
  }
}

// ============================================================================
// 2. INTERFACES Y TIPOS PÚBLICOS
// ============================================================================

export enum ThinkingLevel {
  THINKING_LEVEL_UNSPECIFIED = "THINKING_LEVEL_UNSPECIFIED",
  MINIMAL = "MINIMAL",
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
}

export interface TokenUsage {
  promptTokenCount: number;
  responseTokenCount: number;
  totalTokenCount: number;
}

export interface GeminiEvents {
  usage: (metadata: TokenUsage) => void;
  turnComplete: () => void;
  error: (error: GeminiError) => void;
  sessionSaved: (handle: string) => void;
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "audio"; base64Data: string };

export interface ChatTurn {
  role: "user" | "model";
  parts: { text: string }[];
}

export interface GeminiClientConfig {
  apiKey: string;
  voiceName?: string;
  thinkingLevel?: ThinkingLevel;
}

// ============================================================================
// 3. PRIMITIVA DE AUDIO (REPRODUCTOR PCM)
// ============================================================================

export class AudioStreamPlayer {
  private audioCtx: AudioContext;
  private nextPlayTime: number = 0;
  private readonly sampleRate: number = 24000;

  constructor() {
    this.audioCtx = new (
      window.AudioContext || (window as any).webkitAudioContext
    )({
      sampleRate: this.sampleRate,
    });
  }

  public async resumeContext(): Promise<void> {
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }
  }

  public playBase64PCM(base64Data: string): void {
    try {
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++)
        bytes[i] = binaryString.charCodeAt(i);

      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++)
        float32Array[i] = int16Array[i] / 32768.0;

      const audioBuffer = this.audioCtx.createBuffer(
        1,
        float32Array.length,
        this.sampleRate,
      );
      audioBuffer.getChannelData(0).set(float32Array);

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);

      if (this.nextPlayTime < this.audioCtx.currentTime) {
        this.nextPlayTime = this.audioCtx.currentTime + 0.05;
      }

      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;
    } catch (e) {
      console.error("AudioStreamPlayer Error:", e);
    }
  }
}

// ============================================================================
// 4. CLIENTE CORE (GEMINI SDK)
// ============================================================================

export class GeminiAudioClient {
  private ws: WebSocket | null = null;
  private config: Required<GeminiClientConfig>;
  private listeners: { [K in keyof GeminiEvents]?: GeminiEvents[K][] } = {};

  private messageQueue: (StreamChunk | { type: "_internal_complete" })[] = [];
  private resolveNextMessage:
    | ((value: void | PromiseLike<void>) => void)
    | null = null;

  private resolveSetup: (() => void) | null = null;
  private rejectSetup: ((reason?: GeminiError) => void) | null = null;

  constructor(config: GeminiClientConfig) {
    this.config = {
      apiKey: config.apiKey,
      voiceName: config.voiceName || "Zephyr",
      thinkingLevel: config.thinkingLevel || ThinkingLevel.MINIMAL,
    };
  }

  // --- EVENTOS ---

  public on<K extends keyof GeminiEvents>(
    event: K,
    listener: GeminiEvents[K],
  ): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event]!.push(listener);
  }

  private emit<K extends keyof GeminiEvents>(
    event: K,
    ...args: Parameters<GeminiEvents[K]>
  ): void {
    this.listeners[event]?.forEach((cb) => (cb as any)(...args));
  }

  // --- CONEXIÓN ---

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public async connect(options?: {
    resumeHandle?: string;
    history?: ChatTurn[];
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveSetup = resolve;
      this.rejectSetup = reject;

      const wsEndpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.config.apiKey}`;

      try {
        this.ws = new WebSocket(wsEndpoint);
      } catch (e) {
        return reject(
          new GeminiConnectionError(
            "URL de WebSocket inválida o protocolo no soportado",
          ),
        );
      }

      this.ws.onopen = () => {
        this.ws?.send(JSON.stringify(this.buildSetupMessage(options)));
      };

      this.ws.onmessage = this.handleMessage.bind(this);

      this.ws.onerror = () => {
        const err = new GeminiConnectionError("Fallo de red en el WebSocket");
        if (this.rejectSetup) this.rejectSetup(err);
        this.emit("error", err);
      };

      this.ws.onclose = (event) => {
        if (this.resolveSetup) {
          const err = new GeminiConnectionError(
            "El servidor cerró la conexión antes de completar el setup",
            event.code,
          );
          if (this.rejectSetup) this.rejectSetup(err);
          this.emit("error", err);
        }
        this.ws = null;
      };
    });
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close(1000, "Cierre voluntario");
      this.ws = null;
    }
  }

  // --- COMUNICACIÓN ---

  public async *sendMessageStream(
    text: string,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    if (!this.isConnected())
      throw new GeminiConnectionError("El cliente no está conectado");

    this.ws!.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );

    while (true) {
      if (this.messageQueue.length === 0) {
        await new Promise<void>((resolve) => {
          this.resolveNextMessage = resolve;
        });
      }

      const chunk = this.messageQueue.shift()!;
      if (chunk.type === "_internal_complete") {
        this.emit("turnComplete");
        break;
      }
      yield chunk as StreamChunk;
    }
  }

  // --- PROCESAMIENTO INTERNO ---

  private async handleMessage(event: MessageEvent): Promise<void> {
    try {
      const textData =
        event.data instanceof Blob ? await event.data.text() : event.data;
      const response = JSON.parse(textData);

      // Errores de API (JSON)
      if (response.error) {
        const apiError = new GeminiAPIError(
          response.error.message,
          response.error.code,
          response.error.status,
        );
        if (this.rejectSetup) this.rejectSetup(apiError);
        this.emit("error", apiError);
        return;
      }

      // Setup exitoso
      if (response.setupComplete && this.resolveSetup) {
        this.resolveSetup();
        this.resolveSetup = null;
        this.rejectSetup = null;
      }

      // Metadata y Sesión
      if (response.sessionResumptionUpdate?.newHandle) {
        this.emit("sessionSaved", response.sessionResumptionUpdate.newHandle);
      }
      if (response.usageMetadata) {
        this.emit("usage", response.usageMetadata);
      }

      // Chunks de contenido
      if (response.serverContent) {
        const content = response.serverContent;
        if (content.outputTranscription?.text) {
          this.pushToQueue({
            type: "text",
            text: content.outputTranscription.text,
          });
        }
        if (content.modelTurn?.parts) {
          const audioPart = content.modelTurn.parts.find(
            (p: any) => p.inlineData,
          );
          if (audioPart?.inlineData) {
            this.pushToQueue({
              type: "audio",
              base64Data: audioPart.inlineData.data,
            });
          }
        }
        if (content.turnComplete) {
          this.pushToQueue({ type: "_internal_complete" });
        }
      }
    } catch (e) {
      this.emit(
        "error",
        new GeminiParseError("Fallo al parsear respuesta del servidor", e),
      );
    }
  }

  private pushToQueue(
    chunk: StreamChunk | { type: "_internal_complete" },
  ): void {
    this.messageQueue.push(chunk);
    if (this.resolveNextMessage) {
      this.resolveNextMessage();
      this.resolveNextMessage = null;
    }
  }

  private buildSetupMessage(options?: {
    resumeHandle?: string;
    history?: ChatTurn[];
  }): Record<string, any> {
    const setup: any = {
      model: "models/gemini-2.5-flash-native-audio-latest",
      generationConfig: {
        responseModalities: ["AUDIO"],
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: this.config.thinkingLevel,
        },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.config.voiceName },
          },
        },
      },
      outputAudioTranscription: {},
    };

    const payload: any = { setup };
    if (options?.resumeHandle)
      setup.sessionResumption = { handle: options.resumeHandle };
    else setup.sessionResumption = {};

    if (options?.history?.length)
      setup.historyConfig = { turns: options.history };

    return payload;
  }
}
