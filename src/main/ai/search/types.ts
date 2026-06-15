/** 单条搜索结果。 */
export interface SearchHit {
  /** 网页标题。 */
  title: string;
  /** 网页 URL。 */
  url: string;
  /** 摘要文本（来源于搜索引擎返回的 snippet 或正文片段）。 */
  snippet: string;
  /** 发布日期（ISO 8601 字符串，可选；来源未提供时省略）。 */
  publishedDate?: string;
}

/**
 * 搜索后端接口。SearchService 通过此接口与各具体后端（如 Exa MCP）交互，
 * 支持按顺序回退：第一个后端失败时依次尝试后续后端。
 */
export interface SearchBackend {
  /** 后端唯一标识，用于日志与调试。 */
  readonly id: string;
  /**
   * 执行搜索并返回命中列表。
   * 失败时抛出错误，由 SearchService 捕获并触发回退逻辑。
   */
  search(query: string, opts: { numResults?: number }): Promise<SearchHit[]>;
  /** 释放后端持有的网络连接等资源。 */
  close(): Promise<void>;
}
