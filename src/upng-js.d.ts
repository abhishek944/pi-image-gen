declare module 'upng-js' {
  export type DecodedPng = {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    frames: Array<{ delay: number }>;
    tabs: Record<string, unknown>;
    data: ArrayBuffer;
  };

  const UPNG: {
    decode(buffer: ArrayBuffer): DecodedPng;
    toRGBA8(image: DecodedPng): ArrayBuffer[];
    encode(frames: ArrayBuffer[], width: number, height: number, colorCount: number, delays?: number[]): ArrayBuffer;
  };
  export default UPNG;
}
