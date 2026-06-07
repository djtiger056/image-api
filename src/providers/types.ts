export interface ImageProviderContext {
  authorization?: string;
}

export interface UnifiedImageGenerateInput {
  model?: string;
  prompt: string;
  images?: Array<string | Buffer>;
  negativePrompt?: string;
  ratio?: string;
  resolution?: string;
  duration?: number;
  responseFormat?: string;
  sampleStrength?: number;
  intelligentRatio?: boolean;
  async?: boolean;
  n?: number;
  providerOptions?: Record<string, any>;
}

export interface UnifiedImageGenerateOutput {
  created: number;
  data?: Array<{ url?: string; b64_json?: string }>;
  task_id?: string;
  status?: string;
  provider?: string;
  message?: string;
  [key: string]: any;
}

export default interface ImageProvider {
  name: string;
  supportsModel(model?: string): boolean;
  generateUnified(
    input: UnifiedImageGenerateInput,
    context: ImageProviderContext
  ): Promise<UnifiedImageGenerateOutput>;
}
