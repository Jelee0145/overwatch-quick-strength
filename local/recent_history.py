"""Bounded, non-recursive recent-game sampling. Never persist customer tokens."""
import copy
import datetime as dt
import json
import time


def supplement(config, job, result, client, cache_path, rank_rows, query_error, auth_error, cancelled,
               tokens=None, ranks=None):
    tokens, ranks = dict(tokens or {}), dict(ranks or {})
    excluded = {m['mid'] for m in result['matches']}
    candidates = []
    # Round-robin through games and teams; missing rank players have priority.
    groups = []
    for match in sorted(result['matches'], key=lambda m: m['t'], reverse=True):
        for side in ('T', 'E'):
            groups.append(sorted([p for p in match['players'] if p['side'] == side and p['name'] != result['battletag']],
                                 key=lambda p: bool(p.get('res', {}).get('rows'))))
    seen = set()
    for depth in range(5):
        for group in groups:
            if depth < len(group) and group[depth]['name'] not in seen:
                name = group[depth]['name']
                if '#' in name:
                    seen.add(name)
                    candidates.append(name)
    candidates = candidates[:12]
    try:
        cache = json.loads(cache_path.read_text(encoding='utf-8')) if cache_path.exists() else {}
    except (OSError, ValueError):
        cache = {}
    now, calls, new_ranks, hits = time.time(), 0, 0, 0
    queried_at = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat()
    histories, errors, details = [], 0, {}

    def call(path, params=None, body=None):
        nonlocal calls
        if job['cancel'].is_set():
            raise cancelled('查询已停止，原图表已保留')
        if calls >= 64:
            raise query_error('近期采样请求预算已用完')
        calls += 1
        return client.call(path, params, body)

    for index, name in enumerate(candidates):
        if job['cancel'].is_set():
            raise cancelled('查询已停止，原图表已保留')
        job['message'] = f'补充近期对局 {index + 1}/{len(candidates)} 位 · 缓存 {hits} · 请求 {calls}/64…'
        key = config['server'] + '|' + config['dts'] + '|' + name
        entry = cache.get(key)
        if entry and not any(m['mid'] in excluded for m in entry.get('matches', [])) and now - entry.get('savedAt', 0) < (21600 if entry.get('matches') else 900):
            histories.append({**copy.deepcopy(entry), 'cached': True,
                              'queriedAt': dt.datetime.fromtimestamp(entry['savedAt'], dt.timezone(dt.timedelta(hours=8))).isoformat()})
            hits += 1
            continue
        games = []
        try:
            token = tokens.get(name)
            if not token:
                account = call('/searchBnetAccount', body={'name': name, **{k: config[k] for k in ('token', 'roleId', 'dts', 'server')}})
                token = account.get('customerToken') if isinstance(account, dict) else None
            if not token:
                raise query_error('未返回可查询账号')
            recent = call('/customer/queryMatchList', {'token': token, 'gameMode': 'leisure', 'page': 1, 'season': ''})
            if isinstance(recent, dict):
                recent = recent.get('matchList', recent.get('recentMatchList'))
            if not isinstance(recent, list):
                raise query_error('近期对局结构异常')
            used = set()
            for item in sorted(recent, key=lambda m: float(m.get('beginTs') or 0), reverse=True):
                mid = item.get('matchId')
                if not mid or mid in excluded or mid in used:
                    continue
                used.add(mid)
                if mid not in details:
                    detail = call('/customer/queryMatchInfo', {'token': token, 'matchId': mid, 'season': ''})
                    if not isinstance(detail, dict) or not any(k in detail for k in ('teammateList', 'enemyList')):
                        raise query_error('近期对局详情结构异常')
                    # Import locally to keep this module independent of the server.
                    from match_data import match_data
                    data = match_data(detail)
                    raw_players = [*(detail.get('teammateList') or []), *(detail.get('enemyList') or [])]
                    for player, raw_player in zip(data['players'], raw_players):
                        ct = raw_player.get('customerToken')
                        if ct and ct not in ranks and new_ranks < 16:
                            new_ranks += 1
                            try:
                                ranks[ct] = {'rows': rank_rows(call('/customer/queryCountInfo', {'token': ct, 'gameMode': 'sport', 'season': ''}))}
                            except (auth_error, cancelled):
                                raise
                            except query_error:
                                ranks[ct] = {'rows': [], 'error': True}
                        player['res'] = copy.deepcopy(ranks.get(ct, {'rows': []}))
                    details[mid] = {'mid': str(mid), 't': item.get('beginTs', 0), 'ret': item.get('matchRet', 0),
                                    'mapGuid': str(item.get('mapGuid', '')), 'hasGameData': True, **data}
                game = details[mid]
                if any(p['name'] == name for p in game['players']):
                    games.append(copy.deepcopy(game))
                if len(games) >= 2:
                    break
                if len(used) >= 3:
                    break
        except (auth_error, cancelled):
            raise
        except query_error:
            errors += 1
        entry = {'name': name, 'matches': games, 'savedAt': now, 'queriedAt': queried_at, 'cached': False}
        histories.append(entry)
        cache[key] = copy.deepcopy(entry)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache = dict(sorted(cache.items(), key=lambda kv: kv[1].get('savedAt', 0), reverse=True)[:200])
    temp = cache_path.with_suffix('.tmp')
    temp.write_text(json.dumps(cache, ensure_ascii=False), encoding='utf-8')
    temp.replace(cache_path)
    result['recentHistory'] = histories
    result['historyQueriedAt'] = queried_at
    result['historyStatus'] = {'sampledPlayers': len(candidates), 'playersWithGames': sum(bool(h['matches']) for h in histories),
                               'games': len({m['mid'] for h in histories for m in h['matches']}), 'cacheHits': hits,
                               'requests': calls, 'requestBudget': 64, 'errors': errors, 'maxPlayers': 12, 'gamesPerPlayer': 2}
    return result
