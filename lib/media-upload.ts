/**
 * Client-side preparation of media uploads: resize/re-encode photos for the web
 * and enforce the upload size limit before anything is sent to the server.
 */

import { getFileExtension, getFileSize } from "@/lib/utils/file";

// Max request body accepted by the server. Keep in sync with
// `proxyClientMaxBodySize` in next.config.mjs and `client_max_body_size` in nginx.
const MAX_UPLOAD_BODY_BYTES = 25 * 1024 * 1024;

// Files are sent base64-encoded inside JSON (4 bytes per 3), plus a little overhead.
const MAX_UPLOAD_FILE_BYTES = Math.floor((MAX_UPLOAD_BODY_BYTES - 64 * 1024) * 3 / 4);

type ResizeFormat = "original" | "jpeg" | "webp";

type OptimizeResult = {
  file: File;
  // Set when the uploaded file differs from what the user picked.
  optimized?: {
    from: { width: number; height: number; size: number };
    to: { width: number; height: number; size: number };
  };
};

type ResizeOptions = {
  width: number;
  height: number;
  quality: number;
  format: ResizeFormat;
};

const DEFAULT_RESIZE: ResizeOptions = {
  width: 2400,
  height: 2400,
  quality: 85,
  format: "original",
};

// Images already within the size bounds are only re-encoded above this size.
const REENCODE_THRESHOLD_BYTES = 1.5 * 1024 * 1024;

const RESIZABLE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const LOSSY_TYPES = ["image/jpeg", "image/webp"];

const FORMAT_TYPES: Record<Exclude<ResizeFormat, "original">, string> = {
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const resolveResizeOptions = (resize: unknown): ResizeOptions | null => {
  if (resize === false) return null;
  if (resize == null || resize === true) return DEFAULT_RESIZE;
  if (typeof resize !== "object") return DEFAULT_RESIZE;
  return { ...DEFAULT_RESIZE, ...(resize as Partial<ResizeOptions>) };
};

const loadImage = async (file: File): Promise<ImageBitmap | HTMLImageElement> => {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to <img>, which also applies EXIF orientation.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new window.Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
};

const getSourceSize = (source: CanvasImageSource): { width: number; height: number } =>
  source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: (source as ImageBitmap | HTMLCanvasElement).width, height: (source as ImageBitmap | HTMLCanvasElement).height };

const drawToCanvas = (source: CanvasImageSource, width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not supported in this browser.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return canvas;
};

// Halve repeatedly before the final draw: a single large downscale aliases in
// browsers that ignore imageSmoothingQuality, and this also keeps every canvas
// well below mobile canvas size limits.
const scaleImage = (source: CanvasImageSource, width: number, height: number): HTMLCanvasElement => {
  let current = source;
  let size = getSourceSize(source);

  while (size.width / 2 >= width && size.height / 2 >= height) {
    size = { width: Math.round(size.width / 2), height: Math.round(size.height / 2) };
    current = drawToCanvas(current, size.width, size.height);
  }

  return drawToCanvas(current, width, height);
};

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

const replaceExtension = (filename: string, extension: string): string => {
  const current = getFileExtension(filename);
  const base = current ? filename.slice(0, -(current.length + 1)) : filename;
  return `${base}.${extension}`;
};

/**
 * Downscale and re-encode a photo according to the media `resize` config.
 * Returns the original file when it isn't a resizable image, doesn't need
 * work, or processing wouldn't make it smaller.
 */
const optimizeImage = async (
  file: File,
  resize: unknown,
  allowedExtensions?: string[],
): Promise<OptimizeResult> => {
  const options = resolveResizeOptions(resize);
  if (!options || !RESIZABLE_TYPES.includes(file.type)) return { file };

  let targetType = options.format === "original" ? file.type : FORMAT_TYPES[options.format];
  if (
    allowedExtensions?.length &&
    !allowedExtensions.includes(TYPE_EXTENSIONS[targetType])
  ) {
    targetType = file.type;
  }

  let image: ImageBitmap | HTMLImageElement;
  try {
    image = await loadImage(file);
  } catch {
    return { file };
  }

  try {
    const { width, height } = getSourceSize(image);
    const scale = Math.min(1, options.width / width, options.height / height);
    const needsResize = scale < 1;
    const needsReencode =
      targetType !== file.type ||
      (LOSSY_TYPES.includes(file.type) && file.size > REENCODE_THRESHOLD_BYTES);

    if (!needsResize && !needsReencode) return { file };

    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = scaleImage(image, targetWidth, targetHeight);

    const quality = Math.min(100, Math.max(1, options.quality)) / 100;
    let blob = await canvasToBlob(canvas, targetType, quality);

    // Browsers fall back to PNG for encoders they lack (e.g. WebP in older Safari).
    if (!blob || blob.type !== targetType) {
      targetType = file.type;
      blob = await canvasToBlob(canvas, targetType, quality);
    }
    if (!blob || blob.type !== targetType) return { file };
    if (!needsResize && blob.size >= file.size) return { file };

    const name = targetType === file.type
      ? file.name
      : replaceExtension(file.name, TYPE_EXTENSIONS[targetType]);

    return {
      file: new File([blob], name, { type: targetType, lastModified: file.lastModified }),
      optimized: {
        from: { width, height, size: file.size },
        to: { width: targetWidth, height: targetHeight, size: blob.size },
      },
    };
  } catch (error) {
    console.warn(`Could not optimize "${file.name}", uploading original.`, error);
    return { file };
  } finally {
    if ("close" in image) image.close();
  }
};

const assertUploadSize = (file: File, displayName: string = file.name): void => {
  if (file.size <= MAX_UPLOAD_FILE_BYTES) return;
  throw new Error(
    `"${displayName}" is ${getFileSize(file.size, 1)}, which is over the ${getFileSize(MAX_UPLOAD_FILE_BYTES, 1)} upload limit. Compress or resize it and try again.`,
  );
};

const describeOptimization = (
  originalName: string,
  result: OptimizeResult,
): string | null => {
  if (!result.optimized) return null;
  const { from, to } = result.optimized;
  const dimensions = from.width !== to.width || from.height !== to.height
    ? `${from.width}×${from.height} → ${to.width}×${to.height}, `
    : "";
  const renamed = result.file.name !== originalName ? ` and saved as ${result.file.name}` : "";
  return `Optimized ${originalName} for the web (${dimensions}${getFileSize(from.size, 1)} → ${getFileSize(to.size, 1)})${renamed}.`;
};

const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").replace(/^(.+,)/, ""));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });

/**
 * Optimize (if applicable), check the size limit and base64-encode a file
 * for the media upload API. `notice` describes any optimization for the user.
 */
const prepareMediaUpload = async (
  file: File,
  mediaConfig?: { resize?: unknown; extensions?: string[] },
): Promise<{ file: File; content: string; notice: string | null }> => {
  const result = await optimizeImage(file, mediaConfig?.resize, mediaConfig?.extensions);
  assertUploadSize(result.file, file.name);
  return {
    file: result.file,
    content: await readFileAsBase64(result.file),
    notice: describeOptimization(file.name, result),
  };
};

export {
  MAX_UPLOAD_BODY_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  optimizeImage,
  describeOptimization,
  assertUploadSize,
  prepareMediaUpload,
};
