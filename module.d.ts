declare module "@babel/preset-env";
declare module "@babel/preset-typescript";
declare module "@babel/plugin-syntax-jsx";
declare module "@babel/plugin-syntax-typescript";
declare module "babel-preset-solid";
declare module "subset-font" {
  const subsetFont: (
    buffer: Buffer,
    text: string,
    options?: { targetFormat?: "sfnt" | "woff" | "woff2"; preserveNameIds?: any },
  ) => Promise<Buffer>;
  export default subsetFont;
}
