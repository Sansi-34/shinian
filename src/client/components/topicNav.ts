// 主题导航上下文：所有从主题打开的记录都带 from=topic&topicId&returnTo。
export type TopicNavContext = {
  fromTopic: boolean;
  topicId: string | null;
  returnTo: string | null;
};

export function readTopicNav(searchParams: URLSearchParams): TopicNavContext {
  const fromTopic = searchParams.get('from') === 'topic';
  const topicId = searchParams.get('topicId');
  const returnTo = searchParams.get('returnTo');
  return {
    fromTopic,
    topicId: topicId && topicId.trim() ? topicId : null,
    returnTo: safeTopicReturnTo(returnTo),
  };
}

/** 只接受站内路径，避免把 returnTo 变成开放重定向。 */
export function safeTopicReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

/** 给记录链接补上主题来源参数；已有参数会保留。 */
export function topicAwareHref(href: string, context: TopicNavContext): string {
  if (!context.fromTopic || !context.topicId) return href;
  const [path, query = ''] = href.split('?');
  const params = new URLSearchParams(query);
  params.set('from', 'topic');
  params.set('topicId', context.topicId);
  if (context.returnTo) params.set('returnTo', context.returnTo);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** 主题详情自己的 URL（用于 returnTo）。 */
export function topicUrl(topicId: string, search = ''): string {
  return `/topics/${encodeURIComponent(topicId)}${search ? `?${search}` : ''}`;
}
