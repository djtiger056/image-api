import _ from "lodash";

import { generateImages, generateImageComposition } from "@/api/controllers/images.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import { resolveServiceAuthorization, selectSingleToken } from "@/lib/service-authorization.js";
import util from "@/lib/util.ts";
import ImageProvider, {
  ImageProviderContext,
  UnifiedImageGenerateInput,
  UnifiedImageGenerateOutput,
} from "@/providers/types.ts";

function pickJimengToken(authorization?: string): string {
  const incoming = String(authorization || '').trim();
  if (incoming) {
    const tokens = tokenSplit(incoming);
    if (tokens.length > 0) return tokens[0];
  }
  return selectSingleToken(undefined, 'jimeng');
}

export default class JimengImageProvider implements ImageProvider {
  name = "jimeng";

  supportsModel(model?: string): boolean {
    if (!model) return true;
    return !model.toLowerCase().startsWith("kling-");
  }

  async generateUnified(
    input: UnifiedImageGenerateInput,
    context: ImageProviderContext
  ): Promise<UnifiedImageGenerateOutput> {
    const token = pickJimengToken(context.authorization);
    const responseFormat = _.defaultTo(input.responseFormat, "url");

    const imageUrls = input.images && input.images.length > 0
      ? await generateImageComposition(
          input.model,
          input.prompt,
          input.images,
          {
            ratio: input.ratio,
            resolution: input.resolution,
            sampleStrength: input.sampleStrength,
            negativePrompt: input.negativePrompt,
            intelligentRatio: input.intelligentRatio,
          },
          token
        )
      : await generateImages(
          input.model,
          input.prompt,
          {
            ratio: input.ratio,
            resolution: input.resolution,
            sampleStrength: input.sampleStrength,
            negativePrompt: input.negativePrompt,
            intelligentRatio: input.intelligentRatio,
          },
          token
        );

    const data = responseFormat === "b64_json"
      ? (await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({ b64_json: b64 }))
      : imageUrls.map((url) => ({ url }));

    return {
      created: util.unixTimestamp(),
      data,
      provider: this.name,
      ...(input.images && input.images.length > 0
        ? {
            input_images: input.images.length,
            composition_type: "multi_image_synthesis",
          }
        : {}),
    };
  }
}
