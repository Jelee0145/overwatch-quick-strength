import { Fault } from '../security.mjs';
/** Shared validation after each adapter has applied its established coercion/default rules. */
export function normalizeAnalysisOptions(options = {}) {
  const statisticsRange =
      options.statisticsRange === undefined ? 'all' : String(options.statisticsRange),
    pool = options.pool === undefined ? '' : String(options.pool);
  const side = options.side ?? 'all',
    strategy = options.strategy ?? 'legacy';
  if (!['all', '5', '10', '20'].includes(statisticsRange))
    throw new Fault('统计范围只能是 all、5、10 或 20');
  if (!['', '55', '66'].includes(pool)) throw new Fault('对局模式只能是 55、66 或留空');
  if (!['all', 'T', 'E'].includes(side)) throw new Fault('玩家范围只能是 all、T 或 E');
  if (!['legacy', 'role', 'highest'].includes(strategy)) throw new Fault('段位选取方式无效');
  if (options.estimate !== undefined && typeof options.estimate !== 'boolean')
    throw new Fault('估算选项格式错误');
  return { statisticsRange, pool, side, strategy, estimate: options.estimate !== false };
}
