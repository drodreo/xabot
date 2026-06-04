/**
 * i18n 资源解析模块。
 *
 * 将 x-agent 发出的 `i18n://key` 格式文本翻译为可读中文。
 * 新增 key 只需在 `resources` 表中追加一行。
 */

const resources: Record<string, string> = {
  'activity.adjusted_by_new_input': '正在调整执行方向...',
};

/**
 * 解析 i18n 资源引用。
 *
 * 若文本为 `i18n://key` 格式且命中映射表，返回翻译文本；否则原样返回。
 */
export function i18nResource(text: string): string {
  if (!text.startsWith('i18n://')) return text;
  return resources[text.slice(7)] ?? text;
}
