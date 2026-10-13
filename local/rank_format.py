"""Dashen ranks: named tier/division, legacy compact, and named Emerald 445-449."""
import math

BASES = {0: 500, 1: 1000, 2: 1500, 3: 2000, 8: 2500, 4: 3000, 5: 3500, 6: 4000, 7: 4500}
NAMES = {name: base for names, base in (
    (('bronze', '青铜'), 500), (('silver', '白银'), 1000),
    (('gold', '黄金'), 1500), (('platinum', 'platium', '白金', '铂金'), 2000),
    (('emerald', '翡翠'), 2500), (('diamond', '钻石'), 3000),
    (('master', '大师'), 3500), (('grandmaster', 'gm', '宗师'), 4000),
    (('champion', '英杰', '冠军'), 4500)) for name in names}

def integer(value):
    if value is None or value == '' or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return int(number) if math.isfinite(number) and number.is_integer() else None
    except (TypeError, ValueError, OverflowError):
        return None

def rank_strength(value, name='', division=None):
    """Explicit name + valid division wins; never guess an unknown encoding."""
    base = NAMES.get(str(name or '').strip().lower())
    small = integer(division)
    if base is not None and small in (1, 2, 3, 4, 5):
        return base + (5 - small) * 100
    score = integer(value)
    if score is None or score <= 0:
        return None
    if base == 2500 and 445 <= score <= 449:
        return 2500 + (score - 445) * 100
    rank_id, suffix = divmod(score, 100)
    if rank_id in BASES and 95 <= suffix <= 99:
        return BASES[rank_id] + (suffix - 95) * 100
    return None
