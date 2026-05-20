import JimengImageProvider from "@/providers/jimeng/image-provider.ts";
import KlingImageProvider from "@/providers/kling/image-provider.ts";
import DoubaoImageProvider from "@/providers/doubao/image-provider.ts";
import XyqImageProvider from "@/providers/xyq/image-provider.ts";
import QwenImageProvider from "@/providers/qwen/image-provider.ts";
import { isKlingNativeGenerationBody, isKlingNativeMultiImageBody, isKlingModelName } from "@/providers/kling/mapper.ts";
import { isDoubaoModelName } from "@/providers/doubao/mapper.ts";
import { isXyqModelName } from "@/providers/xyq/mapper.ts";
import { isQwenImageModelName } from "@/providers/qwen/mapper.ts";
import ImageProvider from "@/providers/types.ts";

export const jimengImageProvider = new JimengImageProvider();
export const klingImageProvider = new KlingImageProvider();
export const doubaoImageProvider = new DoubaoImageProvider();
export const xyqImageProvider = new XyqImageProvider();
export const qwenImageProvider = new QwenImageProvider();

const imageProviders: ImageProvider[] = [qwenImageProvider, xyqImageProvider, doubaoImageProvider, klingImageProvider, jimengImageProvider];

export function resolveImageProvider(body: any): ImageProvider {
  const model = body?.model_name || body?.model;
  if (isQwenImageModelName(model)) {
    return qwenImageProvider;
  }
  if (isXyqModelName(model)) {
    return xyqImageProvider;
  }
  if (isDoubaoModelName(model)) {
    return doubaoImageProvider;
  }
  if (isKlingModelName(model) || isKlingNativeGenerationBody(body) || isKlingNativeMultiImageBody(body)) {
    return klingImageProvider;
  }
  return jimengImageProvider;
}

export function getImageProviders(): ImageProvider[] {
  return imageProviders;
}
