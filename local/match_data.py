"""Whitelist public match fields. Account/customer tokens never leave the client."""
import math

STAT_KEYS = ('kill', 'assist', 'death', 'heroDamage', 'cure', 'resistDamage', 'finalHit', 'soloKill', 'targetCompetingTime', 'healingTaken', 'damageTaken')

def number(value):
    if value is None or isinstance(value, bool) or value == '':
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (ValueError, TypeError):
        return None

def player_data(player, side):
    return {'name': str(player.get('name', ''))[:100], 'side': side,
            'hero': str(player.get('heroGuid', ''))[:80],
            'stats': {key: number(player.get(key, player.get('soloKills') if key == 'soloKill' else None)) for key in STAT_KEYS}}

def match_data(detail):
    return {'resourceDataChecked': True, 'duration': number(detail.get('gameTimeSec')),
            'teamScore': number(detail.get('teamScore')),
            'opponentScore': number(detail.get('opponentScore')),
            'players': [player_data(p, side) for key, side in (('teammateList', 'T'), ('enemyList', 'E'))
                        for p in detail.get(key) or []]}

def merge_data(match, data):
    """Keep rank snapshots and align repeated player rows by occurrence."""
    match.update({key: data.get(key) for key in ('duration', 'teamScore', 'opponentScore', 'resourceDataChecked')})
    remaining = list(data['players'])
    for player in match['players']:
        found = next((p for p in remaining if p['name'] == player['name'] and p['side'] == player['side'] and p['hero'] == player['hero']), None)
        if found is not None:
            player['stats'] = found['stats']
            remaining.remove(found)
    match['hasGameData'] = True
