SECONDS_PER_DAY = 24 * 60 * 60
SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY
SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY  # Approximation
SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY  # Approximation

RANK_INTERVALS = {
    "day": SECONDS_PER_DAY,
    "tri_day": 3 * SECONDS_PER_DAY,
    "week": SECONDS_PER_WEEK,
    "bi_week": 2 * SECONDS_PER_WEEK,
    "tri_week": 3 * SECONDS_PER_WEEK,
    "month": SECONDS_PER_MONTH,
    "bi_month": 2 * SECONDS_PER_MONTH,
    "quarter": 4 * SECONDS_PER_MONTH,
    "half_year": SECONDS_PER_YEAR // 2,
    "year": SECONDS_PER_YEAR,
    "abandon": 2 * SECONDS_PER_YEAR,
}

DEFAULT_INTERVAL = RANK_INTERVALS["month"]

DEFAULT_RANGE =  24 * 3600
