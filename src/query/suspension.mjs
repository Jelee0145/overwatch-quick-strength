// Whether new upstream queries are accepted. Lives in one neutral module so the actor, the API
// layer and the session endpoint all read the same switch without an import cycle.
//
// The upstream nickname search answers every client with an empty payload, including the official
// Dashen app, so a new query would spend user quota and then fail. While suspended, query creation
// returns a job-shaped record instead of an error, and the page greys the button out.
// Node also reads its durable runtime controller. QUERY_SUSPENDED remains a force-pause for
// every environment; automatic or manual runtime updates cannot override it.
export const QUERY_SUSPENDED_MESSAGE =
  '上游数据接口故障，昵称查询已暂停；历史记录与已保存结果仍可查看。恢复后会尽快重新开放。';
export const querySuspended = (env) =>
  ['true', '1'].includes(String(env?.QUERY_SUSPENDED ?? '').toLowerCase()) ||
  !!env?.QUERY_CONTROL?.suspended;
