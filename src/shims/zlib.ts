// just-bash в браузере импортирует node:zlib для gzip/tar. В тренажёре сжатие пока не нужно.
const unsupported = (): never => {
  throw new Error("gzip: сжатие в тренажёре пока не поддерживается");
};
export const gzipSync = unsupported;
export const gunzipSync = unsupported;
export const constants = { Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 };
export default { gzipSync, gunzipSync, constants };
