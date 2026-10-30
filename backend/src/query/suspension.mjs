import { authCall } from '../actors/auth-client.mjs';

// The durable controller owns admission, session capabilities and administrator control.
export const QUERY_SUSPENDED_MESSAGE =
  '上游数据接口故障，昵称查询已暂停；历史记录与已保存结果仍可查看。恢复后会尽快重新开放。';
export const querySuspended = (env) => !!env?.QUERY_CONTROL?.suspended;

export async function resolveQuerySuspended(env) {
  if (env.QUERY_CONTROL) return querySuspended(env);
  return (await authCall(env, '/query-control')).suspended;
}
