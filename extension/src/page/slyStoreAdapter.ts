export {
  createInterceptorState,
  normalizeFigure,
  normalizeTagValue,
  pushReplayEntry,
  type InterceptorRuntimeState,
  type ReplayEntry,
} from "./adapter/typesAndNormalizers";
export { ingestApiPayload } from "./adapter/networkIngest";
export { extractFromReactStore, type ReactStoreSlice } from "./adapter/reactStoreReader";
export {
  extractKonvaCanvasTransform,
  extractKonvaImageSource,
  extractKonvaStageFigures,
  type KonvaImageSource,
} from "./adapter/konvaReader";
export {
  buildPageBridgeSnapshot,
  extractResourceTimingImageUrl,
  parseUrlContextFallback,
} from "./adapter/snapshotBuilder";
