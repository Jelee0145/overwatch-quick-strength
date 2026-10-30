'use strict';
// Shared cloud UI definitions; cloud-only wiring lives in web/app/.
const $ = (id) => document.getElementById(id);
let raw = OWQS_SERVICES.data.normalize({ battletag: '', matches: [] }),
  model,
  activeJob = null,
  pollTimer = null;
const status = (message, error = false) => {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
};
const options = () => ({
  limit: Number($('limit').value),
  side: $('side').value,
  strategy: $('strategy').value,
  estimate: $('estimate').checked
});

function showPersonal() {
  const report = model.personalPrediction,
    selected = report.selected;
  const number = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
  $('personalBody').innerHTML =
    `<p>对局强度预估 ${number(model.summary.mean)}，预估可信度 ${model.summary.confidencePercent}%（对局证据评分，非命中率）；可查玩家位 ${model.summary.known}/${model.summary.total}；原始可查段位按场次均值 ${number(model.summary.observedMean)}。个人预测仅使用 ${QS.esc(raw.battletag)} 的有效对局，默认展示有效游玩时长最多的职责：${selected ? QS.esc(QS.roles[selected.role]) : '暂无有效职责'}。环境基准排除本人段位和表现，不受“玩家范围”筛选影响。</p><div class="table-wrap"><table><thead><tr><th>职责</th><th>个人预测</th><th>参考范围</th><th>本人有效场次</th><th>有效样本量</th><th>本人表现均分</th><th>已查本人段位</th><th>限制 / 原因</th></tr></thead><tbody>${report.byRole.map((r) => `<tr><td>${QS.esc(QS.roles[r.role])}${r.role === report.selectedRole ? ' · 默认' : ''}</td><td>${r.mean === null ? '样本不足' : QS.esc(r.rank) + ' · ' + number(r.mean)}</td><td>${r.range ? r.range.min + '—' + r.range.max : '—'}</td><td>${r.games}/${r.availableGames}</td><td>${number(r.effectiveSamples)}</td><td>${number(r.performanceMean)}</td><td>${r.actualRank ? QS.esc(r.actualRank.rank) + (r.actualRank.status === 'previous' ? '（回退）' : '') : '—'}</td><td>${QS.esc(r.reasons.length ? r.reasons.join('；') : r.volatile ? '近期预测波动较大' : '规则参考，非真实定级')}</td></tr>`).join('')}</tbody></table></div><p>单场预测 = 独立环境基准 × [1 + 35% × 可信系数 × clamp((本人表现−60)/40, −1, 1)]；按职责、近期衰减权重稳健汇总。至少 3 场本人有效对局、有效样本量 ≥2、至少 3 名非本人独立段位锚点才显示预测段位。短局效率不扣表现分，但降低预测可信度。未返回的个人英雄使用时长未核验。</p><details><summary>逐场本人计算与排除记录</summary><div class="table-wrap"><table><thead><tr><th>职责 / 场次</th><th>本人表现</th><th>环境基准</th><th>修正</th><th>本局预测</th><th>环境质量</th><th>非本人锚点</th></tr></thead><tbody>${report.byRole.flatMap((r) => r.records.map((g) => `<tr><td>${QS.esc(QS.roles[r.role])} · ${QS.esc(g.mid.slice(0, 8))}</td><td>${number(g.performance)}</td><td>${number(g.context.base)}</td><td>${(g.ratio * 100).toFixed(1)}%</td><td>${number(g.value)}</td><td>${(g.context.quality * 100).toFixed(0)}%</td><td>${g.context.anchorNames.length}</td></tr>`)).join('')}</tbody></table></div><p>${report.excluded.length ? report.excluded.map((e) => QS.esc(e.mid.slice(0, 8) + '：' + e.reason)).join('；') : '没有排除本人记录'}。</p></details><p class="hint">预测版本 ${report.version}，未经过真实竞技段位标注校准；范围是规则参考范围，不能解读为统计置信区间。原始个人段位和直方图保持实际查询口径。</p>`;
}
function showPlayers(index) {
  timeline.detailMatch = model.matches[index];
  window.OWQS_LAST_ANALYSIS = { model, raw, index };
  queueMicrotask(() =>
    window.dispatchEvent(
      new CustomEvent('owqs:analysis-updated', { detail: { model, raw, index } })
    )
  );
  const m = model.matches[index];
  if (window.QS_REVIEW) window.QS_REVIEW.render(m, raw);
  $('chart')
    .querySelectorAll('.match-hit')
    .forEach((el) => el.setAttribute('aria-pressed', String(Number(el.dataset.match) === index)));
  $('performancePanel').hidden = true;
  const time =
    m?.duration !== null && m?.duration !== undefined
      ? ` · 时长 ${Math.floor(m.duration / 60)}:${String(Math.floor(m.duration % 60)).padStart(2, '0')}`
      : '';
  const score =
    m && m.teamScore !== null && m.opponentScore !== null
      ? ` · 比分 ${m.teamScore}:${m.opponentScore}`
      : '';
  $('matchMeta').textContent = m
    ? `本场强度 ${m.mean === null ? '—' : m.mean.toFixed(1)} · ${m.estimateSource ? '估算：' + m.estimateSource : m.mean === null ? '缺少可查段位' : '实测可查段位均值（' + m.known.length + '/' + m.players.length + '，不代表完整对局）'}${m.estimateRange ? ' · 参考范围 ' + m.estimateRange.min + '—' + m.estimateRange.max : ''}${time}${score}`
    : '';
  const estimate = m?.estimateDetails,
    aux = estimate?.auxiliary;
  $('estimateDetail').hidden = !estimate;
  const fixed = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
  $('estimateDetail').innerHTML = estimate
    ? `<div class="estimate-equation"><div><span>${estimate.unanchored ? '动态规则参考' : '段位融合参考'}</span><strong>${fixed(estimate.rankBase)}</strong><small>${estimate.rankSamples} 名独立参考 · 近期补充 ${estimate.historySamples} 名</small></div><span class="equation-sign" aria-hidden="true">+</span><div><span>战斗修正</span><strong>${aux.delta >= 0 ? '+' : ''}${fixed(aux.delta)}</strong><small>实际 ${(aux.relativeDelta * 100).toFixed(1)}% · 上限 ±35%</small></div><span class="equation-sign" aria-hidden="true">≈</span><div><span>本场融合估值</span><strong class="estimate-final">${fixed(m.mean)}</strong><small>证据评分 ${m.confidenceEvidence.percent}% · 非实测段位</small></div></div><p>${QS.esc(m.estimateSource)}；原始可查均值 ${fixed(m.observedMean)}（${m.known.length}/${m.players.length}）；本场 ${estimate.recentPlayers} 名玩家已补近期 ${estimate.recentGames} 场参考。${estimate.unanchored ? '无段位锚点：分值使用表现映射规则，不能解读为真实段位。' : ''}${aux.reason ? QS.esc(aux.reason) + '。' : ''}个人缺失段位保持 —，参考范围不是置信区间。</p><p>范围 ${m.estimateRange ? m.estimateRange.min + '—' + m.estimateRange.max : '—'} · 本场独立参考 ${estimate.rangeDetails.localSamples} 名（直接 ${estimate.rangeDetails.directSamples} / 近期 ${estimate.rangeDetails.recentSamples}）· 有效样本 ${estimate.rangeDetails.effectiveLocalSamples.toFixed(2)} · 本场段位证据 ${(estimate.rangeDetails.localQuality * 100).toFixed(0)}% · 战斗证据 ${((estimate.combatQuality || 0) * 100).toFixed(0)}%；证据多且一致则收窄，缺少依据或双方悬殊则放宽。</p><p class="combat-balance">${aux.teamScores?.length ? `我方表现 ${fixed(aux.teamScores[0].score)} / 对方表现 ${fixed(aux.teamScores[1].score)} · 差距 ${fixed(aux.teamGap)} · 均衡 ${aux.balanceFactor.toFixed(2)} · 一致性 ${aux.consistencyFactor.toFixed(2)} · 悬殊下调 ${(aux.imbalanceRatio * 100).toFixed(1)}% · ${QS.esc(aux.context)}` : QS.esc(aux.reason || '缺少双方表现数据')}</p>`
    : '';

  $('estimateDetail')
    .querySelectorAll('p')
    .forEach((node, index) => {
      if (index === 0) {
        node.textContent = [estimate?.unanchored ? '无段位参考' : '', aux?.reason || '']
          .filter(Boolean)
          .join(' · ');
        if (!node.textContent) node.remove();
      } else node.remove();
    });
  const value = (v) =>
    v === null || v === undefined ? '—' : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  $('players').innerHTML = m
    ? m.players
        .map((p, index) => {
          const hero = QS_DATA.heroes[p.hero],
            icon = window.QS_HERO_ICONS?.[p.hero];
          return `<tr><td class="${p.name === raw.battletag ? 'player-self' : ''}">${QS.esc(p.name)}</td><td><span class="team-label ${p.side === 'E' ? 'enemy' : ''}">${p.side === 'E' ? '对方' : '我方'}</span></td><td><div class="hero-cell">${icon ? `<img src="${QS.esc(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span>${QS.esc(hero?.name || '未知英雄')}<small>${QS.esc(QS.roles[p.role] || '未知职责')} · ${QS.esc(p.performance?.profileName || '通用定位')}</small></span></div></td><td>${value(p.stats.kill)} / ${value(p.stats.assist)} / ${value(p.stats.death)}</td><td>${value(p.stats.finalHit)}</td><td>${value(p.stats.heroDamage)}</td><td>${value(p.stats.cure)}</td><td>${value(p.stats.resistDamage)}</td><td>${value(p.stats.healingTaken)}</td><td>${value(p.stats.damageTaken)}</td><td class="${p.score === null ? 'muted' : 'rank-pill'}">${p.score === null ? '—' : QS.rank(p.score)}</td><td>${p.score ?? '—'}</td>${performanceCell(p, index)}</tr>`;
        })
        .join('')
    : '<tr><td colspan="13">查询后显示本局玩家、英雄与游戏数据</td></tr>';
  document
    .querySelectorAll('.hero-cell img')
    .forEach((img) => img.addEventListener('error', () => (img.hidden = true), { once: true }));
  $('players')
    .querySelectorAll('[data-performance]')
    .forEach(
      (button) =>
        (button.onclick = () => showPerformance(m.players[Number(button.dataset.performance)]))
    );
  $('gameDataStatus').textContent =
    m && (!m.hasGameData || !m.resourceDataChecked) ? '本场数据不完整' : '';
  $('gameDataStatus').classList.remove('error');
  $('retryGameData').hidden = true;
  if (m && (!m.hasGameData || !m.resourceDataChecked)) {
    $('gameDataStatus').textContent = '历史记录缺少部分游戏数据；不会自动补查';
  }
}
function performanceCell(p, index) {
  const r = p.performance;
  if (!r.grade)
    return `<td class="performance-cell"><span class="muted" title="${QS.esc(r.reason)}">待评</span><small>${QS.esc(r.reason)}</small></td>`;
  return `<td class="performance-cell"><button type="button" class="grade grade-${r.grade}" data-performance="${index}" aria-label="查看 ${QS.esc(p.name)} 的 ${r.grade} 级表现评分明细" title="${r.score} 分 · 数据覆盖 ${Math.round(r.coverage * 100)}%；点击查看指标">${r.grade}<span>${r.score.toFixed(1)}</span></button><small>整局估评</small></td>`;
}
async function showPerformance(p, embedded = false) {
  if (p.detailPending) {
    const selected = model,
      mid = model.matches[Number($('matchSelect').value)]?.mid;
    try {
      await ensurePlayerDetail(p);
    } catch (error) {
      status(error.message, true);
      return;
    }
    if (selected !== model || mid !== model.matches[Number($('matchSelect').value)]?.mid) return;
  }
  const r = p.performance,
    format = (n) =>
      n === null || n === undefined ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  $('performancePanel').innerHTML =
    `<div class="performance-head"><h3>${QS.esc(p.name)} · ${QS.esc(r.hero)} <span class="grade grade-${r.grade}">${r.grade} · ${r.score.toFixed(1)}</span></h3><button id="closePerformance" type="button">收起</button></div><p>${QS.esc(r.profileName)} · 默认标签 ${QS.esc(r.playstyle)} · ${QS.esc(r.reference)} · 数据覆盖 ${Math.round(r.coverage * 100)}% · B 为接近基准，阵亡指标反向计分。K/D 使用每 10 分钟击杀 ÷（每 10 分钟阵亡 + 1）。</p><div class="rating-groups">${r.groups.map((g) => `<span>${QS.esc(g.label)} <strong>${g.score.toFixed(1)}</strong> · ${(g.weight * 100).toFixed(0)}%${g.missing ? '（中性参考）' : ''}</span>`).join('')}</div><div class="rating-metrics"><table><thead><tr><th>指标</th><th>本局 / 10 分钟</th><th>参考 / 10 分钟</th><th>单项分</th><th>权重</th><th>参考来源</th></tr></thead><tbody>${r.metrics.map((item) => `<tr><td>${item.label}</td><td>${format(item.value)}${item.key === 'kd' ? '（比值）' : ''}</td><td>${format(item.baseline)}${item.key === 'kd' ? '（比值）' : ''}</td><td>${item.score.toFixed(1)}</td><td>${(item.weight * 100).toFixed(1)}%</td><td>${QS.esc(item.baselineSource)}</td></tr>`).join('')}</tbody></table></div><p class="rating-warning">${r.warnings.map(QS.esc).join('；')}。</p><p class="hint">基准：<a href="${QS.esc(r.source)}" target="_blank" rel="noreferrer">Counterwatch · 定位中位数参考</a>${r.matches ? ' · 页面对局数 ' + format(r.matches) : ''}${r.sourceUpdated ? ' · 页面更新 ' + QS.esc(r.sourceUpdated) : ''} · 本地快照 ${QS.esc(r.benchmarkVersion)}。基础指标取 5v5 全段位社区快照；收尾指标另用规则比例参考，非国服快速专属样本；评分版本 ${r.version}，不是段位或 MMR。</p>`;
  if (r.resource) {
    const x = r.resource,
      formatResource = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
    $('performancePanel').innerHTML +=
      `<div class="resource-rating"><h4>资源效率辅助 · 上限 ±${x.maxDelta} 分</h4><p>基础表现 ${formatResource(r.baseScore)} + 资源修正 ${x.delta >= 0 ? '+' : ''}${formatResource(x.delta)} = 最终表现 ${formatResource(r.score)}；${QS.esc(x.label)}。</p><p>受治疗 / 10 分钟 ${formatResource(x.healingTakenPer10)} · 承伤 / 10 分钟 ${formatResource(x.damageTakenPer10)} · 定位参考带 ${x.referenceRange ? formatResource(x.referenceRange.min) + '—' + formatResource(x.referenceRange.max) : '—'} · 英雄敏感度 ${formatResource(x.sensitivity)} · 证据系数 ${formatResource(x.confidence)}。</p><p>${QS.esc(x.reason || '')}；${QS.esc(x.sourceCaveat)}。${QS.esc(x.source)}。</p></div>`;
  }
  $('performancePanel').hidden = false;
  if (!embedded) $('performancePanel').scrollIntoView({ block: 'nearest' });
  $('closePerformance').onclick = () => {
    $('performancePanel').hidden = true;
  };
}
function download(blob, name) {
  const a = document.createElement('a'),
    url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function fileName(ext) {
  return (
    (raw.battletag || 'quick-strength').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') +
    '-快速强度图.' +
    ext
  );
}
