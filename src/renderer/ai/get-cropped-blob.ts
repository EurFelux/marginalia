/** 裁剪区（react-easy-crop 的 croppedAreaPixels：源图像素坐标）。 */
export interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 头像输出最长边上限（px），控制 blob 体积。 */
export const AVATAR_OUTPUT_MAX = 512;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

/** 按裁剪区从 dataURL 出图，缩放到最长边 ≤ AVATAR_OUTPUT_MAX，返回 png 字节。 */
export async function getCroppedBlob(
  imageSrc: string,
  area: CropArea,
): Promise<Uint8Array<ArrayBuffer>> {
  const img = await loadImage(imageSrc);
  const scale = Math.min(1, AVATAR_OUTPUT_MAX / Math.max(area.width, area.height));
  const dstW = Math.max(1, Math.round(area.width * scale));
  const dstH = Math.max(1, Math.round(area.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, dstW, dstH);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("canvas toBlob returned null");
  return new Uint8Array(await blob.arrayBuffer());
}
