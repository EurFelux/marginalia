/**
 * 注入 section iframe 的 TTS 当前段高亮样式（CSS Custom Highlight API；spec §6）。
 * 半透明暖橙：亮/暗两态均可读（同 PDF overlay 的透明度哲学），与标注五色（黄绿蓝粉紫）区分。
 */
export const TTS_IFRAME_CSS = `::highlight(tts-current) { background-color: rgba(251, 146, 60, 0.3); }`;
