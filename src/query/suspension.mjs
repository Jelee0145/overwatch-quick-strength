// Whether new upstream queries are accepted. Lives in one neutral module so the actor, the API
// layer and the session endpoint all read the same switch without an import cycle.
//
// The upstream nickname search answers every client with an empty payload, including the official
// Dashen app, so a new query would spend user quota and then fail. While suspended, query creation
// returns a job-shaped record instead of an error, and the page greys the button out.
// Reopening is a server config change only: set QUERY_SUSPENDED to "false" (or remove it) and
// restart the service. No redeploy is needed.
export const QUERY_SUSPENDED_MESSAGE =
  '上游数据接口故障，昵称查询已暂停；历史记录与已保存结果仍可查看。恢复后会尽快重新开放。';
export const querySuspended = (env) =>
  ['true', '1'].includes(String(env?.QUERY_SUSPENDED ?? '').toLowerCase());
