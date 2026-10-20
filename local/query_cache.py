"""Account-scoped public game cache. No credential or customer token fields."""
import copy
import hashlib
import json
from match_data import STAT_KEYS, number


def scope(config):
    return {k: str(config[k]) for k in ('battletag', 'server', 'dts')}


def cache_path(private, config):
    key = json.dumps(scope(config), sort_keys=True, ensure_ascii=False).encode()
    return private / 'query-cache' / (hashlib.sha256(key).hexdigest() + '.json')


def clean_match(match):
    def rows(items):
        return [{'r': str(r.get('r', ''))[:20], 's': number(r.get('s')), 'n': str(r.get('n', ''))[:40],
                 'd': number(r.get('d')), 'season': str(r.get('season', ''))[:20]}
                for r in (items if isinstance(items, list) else [])[:20] if isinstance(r, dict)]
    players = []
    for p in match.get('players', [])[:30]:
        res = p.get('res') or {}
        players.append({'name': str(p.get('name', ''))[:100], 'hero': str(p.get('hero', ''))[:80],
                        'side': 'E' if p.get('side') == 'E' else 'T',
                        'stats': {k: number((p.get('stats') or {}).get(k)) for k in STAT_KEYS},
                        'res': {'rows': rows(res.get('rows')), 'previousRows': rows(res.get('previousRows')),
                                'error': bool(res.get('error')), 'previousError': bool(res.get('previousError')),
                                'sourceSeason': str(res.get('sourceSeason', ''))[:20],
                                'rankQueriedAt': str(res.get('rankQueriedAt', ''))[:80]}})
    return {'mid': str(match.get('mid', ''))[:100], 't': number(match.get('t')) or 0,
            'ret': match.get('ret') if match.get('ret') in (-1, 0, 1) else 0,
            'mapGuid': str(match.get('mapGuid', ''))[:80], 'mapName': str(match.get('mapName', ''))[:100],
            'gameMode': str(match.get('gameMode', ''))[:40],
            'hasGameData': bool(match.get('hasGameData')), 'resourceDataChecked': bool(match.get('resourceDataChecked')), 'duration': number(match.get('duration')),
            'teamScore': number(match.get('teamScore')), 'opponentScore': number(match.get('opponentScore')),
            'dataQueriedAt': str(match.get('dataQueriedAt', ''))[:80], 'players': players}


def usable(match, tag):
    return (match.get('mid') and match.get('hasGameData') and (number(match.get('duration')) or 0) > 0
            and any(p.get('name') == tag for p in match.get('players', []))
            and all(isinstance(p.get('stats'), dict) and set(STAT_KEYS).issubset(p['stats'])
                    and any(number(p['stats'][k]) is not None for k in STAT_KEYS) for p in match['players']))


def clean_history(items):
    return [{'name': str(h.get('name', ''))[:100], 'queriedAt': str(h.get('queriedAt', ''))[:80],
             'cached': bool(h.get('cached')), 'savedAt': number(h.get('savedAt')),
             'matches': [clean_match(m) for m in h.get('matches', [])[:2]]}
            for h in (items if isinstance(items, list) else [])[:12] if isinstance(h, dict)]


def clean_status(value, history=False):
    keys = ('sampledPlayers', 'playersWithGames', 'games', 'cacheHits', 'requests', 'requestBudget',
            'errors', 'maxPlayers', 'gamesPerPlayer') if history else (
            'fetchedMatches', 'reusedMatches', 'totalMatches', 'listedMatches', 'rankFetches', 'rankReuses')
    result = {k: number((value or {}).get(k)) for k in keys}
    if not history:
        result['cachedOnly'] = bool((value or {}).get('cachedOnly'))
    return result


def load(private, config):
    for path in (cache_path(private, config), private / 'latest.json'):
        try:
            value = json.loads(path.read_text(encoding='utf-8'))
            if value.get('cacheScope') == scope(config) and value.get('battletag') == config['battletag']:
                value['matches'] = [clean_match(m) for m in value.get('matches', [])[:50]]
                value['recentHistory'] = clean_history(value.get('recentHistory', []))
                if value.get('historyStatus'):
                    value['historyStatus'] = clean_status(value['historyStatus'], True)
                return value
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    return {'matches': []}


def save(private, config, result):
    old = load(private, config)
    games = {m['mid']: clean_match(m) for m in old['matches']}
    games.update({m['mid']: clean_match(m) for m in result['matches']})
    value = {k: copy.deepcopy(result[k]) for k in ('schemaVersion', 'battletag', 'source', 'queriedAt',
             'used_previous_season_fallback', 'recentHistory', 'historyStatus', 'historyQueriedAt', 'syncStatus') if k in result}
    value['matches'] = sorted(games.values(), key=lambda m: m['t'], reverse=True)[:50]
    value['cacheScope'] = scope(config)
    if value.get('historyStatus'):
        value['historyStatus'] = clean_status(value['historyStatus'], True)
    if value.get('syncStatus'):
        value['syncStatus'] = clean_status(value['syncStatus'])
    # Re-whitelist history data; never preserve authentication fields in a cache.
    value['recentHistory'] = clean_history(value.get('recentHistory', []))
    path = cache_path(private, config)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temp.replace(path)
